import { Types } from "mongoose";
import type { Server, Socket } from "socket.io";
import { isTrackerOnlyAdminCode } from "../config/adminUsers";
import { runWithBusiness } from "../config/tenancy";
import { Employee } from "../models/Employee";
import { LiveViewAudit, type LiveViewAuditDocument } from "../models/LiveViewAudit";

export const liveViewRequestLifetimeMs = 30_000;
type Payload = { requestId?: unknown; employeeId?: unknown; reason?: unknown; description?: unknown; candidate?: unknown };
type Reply = (value: { ok: boolean; message?: string }) => void;
type Rooms = { employeeRoom: (business: string, employee: string) => string; liveShareRoom: (business: string, request: string) => string };

export function registerLiveViewDelivery(io: Server, socket: Socket, rooms: Rooms) {
    const business = String(socket.data.businessId), employeeId = String(socket.data.authEmployeeId || "");
    const employee = socket.data.authUserType === "employee", admin = socket.data.authUserType === "admin";
    const inBusiness = <T>(read: () => T) => runWithBusiness(business, read);
    const id = (payload: Payload) => /^[A-Za-z0-9:._-]{1,160}$/.test(String(payload.requestId || "").trim()) ? String(payload.requestId).trim() : "";
    const room = (requestId: string) => rooms.liveShareRoom(business, requestId);
    const fail = (requestId: string, message: string, reply?: Reply) => {
        reply?.({ok:false,message}); socket.emit("live-share:error",{requestId,message});
    };
    const adminPresent = (audit: Pick<LiveViewAuditDocument,"requestId"|"adminCode">) =>
        [...(io.sockets.adapter.rooms.get(room(audit.requestId)) || [])].some(key => {
            const client = io.sockets.sockets.get(key);
            return client?.data.authUserType === "admin" && client.data.authUserCode === audit.adminCode;
        });
    const payloadFor = (audit: LiveViewAuditDocument) => ({requestId:audit.requestId,employeeId:audit.employeeId,
        employeeCode:String(socket.data.authUserCode || ""),businessId:business,employeeName:audit.employeeName,
        adminName:audit.adminName,requestedAt:audit.requestedAt.toISOString(),expiresAt:new Date(+audit.requestedAt+liveViewRequestLifetimeMs).toISOString(),
        remainingMs:Math.max(0,+audit.requestedAt+liveViewRequestLifetimeMs-Date.now())});
    const ownAudit = (requestId: string) => inBusiness(() => LiveViewAudit.findOne({requestId,
        ...(employee ? {employeeId} : {adminCode:socket.data.authUserCode})}).lean());
    const on = (event: string, handle: (payload: Payload, reply?: Reply) => Promise<void>) => {
        socket.on(event,(input: unknown, callback?: unknown) => {
            const payload = input && typeof input === "object" ? input as Payload : {};
            const reply = typeof callback === "function" ? callback as Reply : undefined;
            void handle(payload,reply).catch(() => fail(id(payload),"Live View could not be verified. Please try again.",reply));
        });
    };

    const sendIdentity = () => socket.emit("presence:identity",{businessId:business,employeeId,employeeCode:socket.data.authUserCode});
    if (employee) {
        sendIdentity();
        socket.on("presence:register", sendIdentity);
    }

    on("live-share:request",async(payload,reply) => {
        const requestId = id(payload), targetId = String(payload.employeeId || "").trim();
        if (!admin) { fail(requestId,"Only an authenticated administrator can request Live View.",reply); return; }
        if (!requestId || !Types.ObjectId.isValid(targetId)) { fail(requestId,"Employee and request id are required.",reply); return; }
        const target = await inBusiness(() => Employee.findOne({_id:targetId,status:{$ne:"Archived"}}).select("_id name team employeeCode").lean());
        if (!target) { fail(requestId,"This employee is unavailable in the selected business.",reply); return; }
        if (isTrackerOnlyAdminCode(String(socket.data.authUserCode || "")) && !/^internal$/i.test(String(target.team || ""))) {
            fail(requestId,"This administrator can only view Internal employees.",reply); return;
        }
        const existing = await inBusiness(() => LiveViewAudit.findOne({requestId}).lean());
        if (existing && (existing.adminCode !== socket.data.authUserCode || existing.employeeId !== targetId)) {
            fail(requestId,"This Live View request belongs to another session.",reply); return;
        }
        if (existing && (existing.status !== "requested" && existing.status !== "active" ||
            existing.status === "requested" && +existing.requestedAt <= Date.now()-liveViewRequestLifetimeMs)) {
            fail(requestId,"This Live View request has expired or ended. Start a new request.",reply); return;
        }
        const audit = existing || await inBusiness(() => LiveViewAudit.findOneAndUpdate({requestId,
            adminCode:socket.data.authUserCode,employeeId:targetId},{$setOnInsert:{requestId,employeeId:targetId,
            employeeName:target.name,adminCode:socket.data.authUserCode,adminName:socket.data.authUserName,
            status:"requested",requestedAt:new Date()}},{upsert:true,returnDocument:"after"}).lean());
        if (!audit) { fail(requestId,"This Live View request could not be verified.",reply); return; }
        await socket.join(room(requestId));
        if (audit.status === "requested") {
            io.to(rooms.employeeRoom(business,targetId)).emit("live-share:requested",{...payloadFor(audit),employeeCode:target.employeeCode});
            socket.emit("live-share:delivery",{requestId,state:io.sockets.adapter.rooms.get(rooms.employeeRoom(business,targetId))?.size ? "sent" : "offline"});
        }
        reply?.({ok:true});
    });

    on("live-share:pending",async(_payload,reply) => {
        if (!employee || !employeeId) { reply?.({ok:false}); return; }
        const pending = await inBusiness(() => LiveViewAudit.findOne({employeeId,status:"requested",
            requestedAt:{$gt:new Date(Date.now()-liveViewRequestLifetimeMs)}}).sort({requestedAt:-1}).lean());
        if (pending && adminPresent(pending)) socket.emit("live-share:requested",payloadFor(pending));
        reply?.({ok:true});
    });

    on("live-share:received",async(payload,reply) => {
        const requestId = id(payload); if (!employee || !requestId) { reply?.({ok:false}); return; }
        const audit = await ownAudit(requestId);
        if (!audit || audit.status !== "requested" || +audit.requestedAt <= Date.now()-liveViewRequestLifetimeMs || !adminPresent(audit)) {
            reply?.({ok:false}); return;
        }
        io.to(room(requestId)).emit("live-share:delivery",{requestId,state:"received"}); reply?.({ok:true});
    });

    on("live-share:accept",async(payload,reply) => {
        const requestId = id(payload); if (!employee || !requestId) { reply?.({ok:false}); return; }
        const audit = await ownAudit(requestId);
        if (!audit || !adminPresent(audit)) { fail(requestId,"The administrator is no longer waiting for this request.",reply); return; }
        if (audit.status === "active" && socket.rooms.has(room(requestId))) { reply?.({ok:true}); return; }
        const accepted = await inBusiness(() => LiveViewAudit.findOneAndUpdate({requestId,employeeId,status:"requested",
            requestedAt:{$gt:new Date(Date.now()-liveViewRequestLifetimeMs)}},{$set:{status:"active",startedAt:new Date(),reason:""}},{returnDocument:"after"}).lean());
        if (!accepted) { fail(requestId,"This Live View request has expired or is already handled.",reply); return; }
        await socket.join(room(requestId));
        socket.to(room(requestId)).emit("live-share:accepted",{requestId,acceptedAt:new Date().toISOString()}); reply?.({ok:true});
    });

    on("live-share:decline",async(payload,reply) => {
        const requestId = id(payload); if (!employee || !requestId) { reply?.({ok:false}); return; }
        const declined = await inBusiness(() => LiveViewAudit.findOneAndUpdate({requestId,employeeId,status:"requested"},
            {$set:{status:"declined",endedAt:new Date(),reason:String(payload.reason || "declined").slice(0,500)}},{returnDocument:"after"}).lean());
        if (!declined) { reply?.({ok:false}); return; }
        io.to(room(requestId)).emit("live-share:declined",{requestId,reason:declined.reason});
        io.in(room(requestId)).socketsLeave(room(requestId)); reply?.({ok:true});
    });

    on("live-share:signal",async(payload) => {
        const requestId = id(payload); if (!requestId || !socket.rooms.has(room(requestId))) return;
        socket.to(room(requestId)).emit("live-share:signal",{requestId,description:payload.description,candidate:payload.candidate});
    });

    on("live-share:stop",async(payload,reply) => {
        const requestId = id(payload); if (!requestId || !admin && !employee) { reply?.({ok:false}); return; }
        const audit = await ownAudit(requestId); if (!audit) { reply?.({ok:false}); return; }
        const reason = String(payload.reason || "stopped").slice(0,500);
        await inBusiness(() => LiveViewAudit.updateOne({requestId},{$set:{status:"ended",endedAt:new Date(),reason}}));
        io.to(room(requestId)).emit("live-share:stopped",{requestId,reason});
        io.to(rooms.employeeRoom(business,audit.employeeId)).emit("live-share:stopped",{requestId,reason});
        io.in(room(requestId)).socketsLeave(room(requestId)); reply?.({ok:true});
    });
}
