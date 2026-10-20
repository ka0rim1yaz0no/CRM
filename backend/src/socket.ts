import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { findConfiguredAdmin, isTrackerOnlyAdminCode } from "./config/adminUsers";
import { getBusinessById, getCurrentBusinessId, getDefaultBusiness, runWithBusiness } from "./config/tenancy";
import { Conversation } from "./models/Conversation";
import { Employee } from "./models/Employee";
import { LiveViewAudit } from "./models/LiveViewAudit";
import { Message } from "./models/Message";
import { securityLegacyAuthEnabled } from "./config/rolloutFlags";
import { signedCrmIdentity, signedEmployeeInBusiness } from "./middleware/legacyAuthentication";

let socketServer: Server | null = null;

type VoiceCallSession = {
  callId: string;
  businessId: string;
  callerId: string;
  callerType: "admin" | "employee";
  callerName: string;
  targetId: string;
  targetType: "admin" | "employee";
  targetName: string;
  callerSocketId: string;
  targetSocketId: string;
};

const voiceCalls = new Map<string, VoiceCallSession>();
const employeeVoiceCalls = new Map<string, string>();

function voicePartyKey(businessId: string, partyType: "admin" | "employee", partyId: string) {
  return `${businessId}:${partyType}:${partyId}`;
}

function clearVoiceCall(callId: string) {
  const call = voiceCalls.get(callId);
  if (!call) return null;
  voiceCalls.delete(callId);
  employeeVoiceCalls.delete(voicePartyKey(call.businessId, call.callerType, call.callerId));
  employeeVoiceCalls.delete(voicePartyKey(call.businessId, call.targetType, call.targetId));
  return call;
}

const defaultClientOrigins = ["http://localhost:5173", "https://crm.assistly123.com"];
const clientOrigins = Array.from(
  new Set([
    ...defaultClientOrigins,
    ...(process.env.CLIENT_ORIGIN || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ])
);

function isAllowedDevOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && url.port === "5173";
  } catch {
    return false;
  }
}

function businessRoom(businessId: string) {
  return `business:${businessId}`;
}

function conversationRoom(businessId: string, conversationId: string) {
  return `business:${businessId}:conversation:${conversationId}`;
}

function employeeRoom(businessId: string, employeeId: string) {
  return `business:${businessId}:employee:${employeeId}`;
}

function partyRoom(businessId: string, partyType: "admin" | "employee", partyId: string) {
  return partyType === "admin" ? `business:${businessId}:admins` : employeeRoom(businessId, partyId);
}

function socketParty(socket: Socket) {
  return {
    type: socket.data.authUserType as "admin" | "employee",
    id: socket.data.authUserType === "admin" ? "admin" : String(socket.data.authEmployeeId || ""),
  };
}

function liveShareRoom(businessId: string, requestId: string) {
  return `business:${businessId}:live-share:${requestId}`;
}

function resolveSocketBusiness(socket: Socket) {
  const businessId = String(socket.handshake.auth?.businessId || socket.handshake.query?.businessId || "").trim();
  return businessId ? getBusinessById(businessId) : getDefaultBusiness();
}

export function emitMessageEvents(conversationId: string, message: unknown, conversation: unknown) {
  const businessId = getCurrentBusinessId();
  const conversationPayload = (conversation || {}) as {
    includeAdmin?: boolean;
    type?: string;
    participants?: Array<{ _id?: unknown } | string>;
  };
  const participantIds = (conversationPayload.participants || [])
    .map((participant) => typeof participant === "string" ? participant : String(participant?._id || ""))
    .filter(Boolean);

  socketServer?.to(conversationRoom(businessId, conversationId)).emit("message:new", message);
  const notificationPayload = { message, conversation };
  participantIds.forEach((employeeId) => {
    socketServer?.to(employeeRoom(businessId, employeeId)).emit("message:notification", notificationPayload);
    socketServer?.to(employeeRoom(businessId, employeeId)).emit("conversation:updated", { conversationId });
  });
  if (conversationPayload.includeAdmin || conversationPayload.type === "team") {
    socketServer?.to(`business:${businessId}:admins`).emit("message:notification", notificationPayload);
    socketServer?.to(`business:${businessId}:admins`).emit("conversation:updated", { conversationId });
  }
}

export function emitMessageMutationEvent(conversationId: string, event: "message:updated" | "message:deleted" | "message:seen", message: unknown) {
  const businessId = getCurrentBusinessId();
  socketServer?.to(conversationRoom(businessId, conversationId)).emit(event, message);
  socketServer?.to(businessRoom(businessId)).emit("conversation:updated", { conversationId });
}

export function emitMessagesRefresh(businessIds: string[]) {
  for (const businessId of new Set(businessIds.filter(Boolean))) {
    socketServer?.to(businessRoom(businessId)).emit("conversation:updated", { conversationId: "" });
  }
}

export function createSocketServer(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        if (!origin || clientOrigins.includes(origin) || isAllowedDevOrigin(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`Socket CORS blocked origin: ${origin}`));
      },
      methods: ["GET", "POST"],
    },
  });

  socketServer = io;

  io.use(async (socket, next) => {
    try {
    const business = resolveSocketBusiness(socket);
    let userType = String(socket.handshake.auth?.userType || "").trim().toLowerCase();
    let userCode = String(socket.handshake.auth?.userCode || "").trim();

    if (!business) {
      return next(new Error("Unknown socket business."));
    }
    if (securityLegacyAuthEnabled()) {
      const identity = signedCrmIdentity(socket.handshake.auth?.adminSession, socket.handshake.auth?.attendanceSession);
      if (!identity) return next(new Error("Signed CRM socket session required."));
      userType = identity.type; userCode = identity.code; socket.data.verifiedAccess = identity.access;
      if (identity.type === "employee" && !await runWithBusiness(business.id, () => signedEmployeeInBusiness(identity.code, business.id))) return next(new Error("Socket business access denied."));
    }

    if (userType === "admin") {
      const admin = findConfiguredAdmin(userCode);
      if (!admin) return next(new Error("Unauthorized socket administrator."));
      socket.data.authUserType = "admin";
      socket.data.authUserCode = admin.employeeCode;
      socket.data.authUserName = admin.name;
      return next();
    }

    if (userType === "employee" && userCode) {
      const employee = await runWithBusiness(business.id, () =>
        Employee.findOne({ employeeCode: userCode, status: { $ne: "Archived" } }).select("_id name employeeCode").lean()
      );
      if (!employee) return next(new Error("Unauthorized socket employee."));
      socket.data.authUserType = "employee";
      socket.data.authUserCode = employee.employeeCode;
      socket.data.authUserName = employee.name;
      socket.data.authEmployeeId = String(employee._id);
      return next();
    }

    next(new Error("Authenticated CRM session required."));
    } catch { next(new Error("Socket authentication is temporarily unavailable.")); }
  });

  io.on("connection", (socket) => {
    const business = resolveSocketBusiness(socket);
    if (!business) {
      socket.disconnect(true);
      return;
    }
    socket.data.businessId = business.id;
    const tracker = securityLegacyAuthEnabled() && socket.data.verifiedAccess === "tracker";
    if (!tracker) socket.join(businessRoom(business.id));
    if (socket.data.authUserType === "admin" && !tracker) {
      socket.join(`business:${business.id}:admins`);
    } else if (socket.data.authUserType === "employee" && socket.data.authEmployeeId) {
      socket.join(employeeRoom(business.id, socket.data.authEmployeeId));
    }

    const runForSocketBusiness = <T>(callback: () => T) => runWithBusiness(socket.data.businessId, callback);
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let membershipTimer: ReturnType<typeof setInterval> | undefined;
    let verifying = false;
    const verifyCurrentAccess = async () => {
      const identity = signedCrmIdentity(socket.handshake.auth?.adminSession, socket.handshake.auth?.attendanceSession);
      if (!identity) return false;
      if (identity.type !== "employee") return true;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        return Boolean(await Promise.race([runForSocketBusiness(() => signedEmployeeInBusiness(identity.code, socket.data.businessId)),
          new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), 3500); })]));
      } finally { clearTimeout(deadline); }
    };
    if (securityLegacyAuthEnabled()) {
      const identity = signedCrmIdentity(socket.handshake.auth?.adminSession, socket.handshake.auth?.attendanceSession);
      if (!identity) { socket.disconnect(true); return; }
      expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(1, identity.expiresAt - Date.now()));
      expiryTimer.unref();
      if (identity.type === "employee") {
        membershipTimer = setInterval(() => {
          if (verifying || !securityLegacyAuthEnabled()) return;
          verifying = true;
          void verifyCurrentAccess().then(allowed => { if (!allowed) socket.disconnect(true); }, () => socket.disconnect(true)).finally(() => { verifying = false; });
        }, 30_000);
        membershipTimer.unref();
      }
    }

    socket.use(async ([event], next) => {
      if (!securityLegacyAuthEnabled()) return next();
      try { if (!await verifyCurrentAccess()) { socket.disconnect(true); return next(new Error("CRM session expired or business access changed.")); } }
      catch { socket.disconnect(true); return next(new Error("CRM access could not be verified.")); }
      if (tracker && !["presence:register", "live-share:request", "live-share:stop", "live-share:signal"].includes(event)) return next(new Error("Tracker socket action denied."));
      next();
    });

    socket.on(
      "presence:register",
      () => {
        if (socket.data.authUserType === "admin") {
          if (!tracker) socket.join(`business:${socket.data.businessId}:admins`);
          return;
        }

        if (socket.data.authUserType === "employee" && socket.data.authEmployeeId) {
          socket.join(employeeRoom(socket.data.businessId, socket.data.authEmployeeId));
        }
      }
    );

    socket.on("conversation:join", async (conversationId: string) => {
      const normalizedConversationId = String(conversationId || "").trim();
      if (!normalizedConversationId) return;
      const conversation = await runForSocketBusiness(() => Conversation.findById(normalizedConversationId).select("participants includeAdmin type").lean());
      const canJoin = socket.data.authUserType === "admin"
        ? Boolean(conversation?.includeAdmin) || conversation?.type === "team"
        : Boolean(conversation?.participants.some((participant) => String(participant) === socket.data.authEmployeeId));
      if (canJoin) socket.join(conversationRoom(socket.data.businessId, normalizedConversationId));
    });

    socket.on("voice-call:start", async (payload: { callId?: string; targetUserId?: string; targetEmployeeId?: string; targetUserType?: "admin" | "employee" } = {}) => {
      if (socket.data.authUserType !== "employee" && socket.data.authUserType !== "admin") return;
      const callId = String(payload.callId || "").trim();
      const targetId = String(payload.targetUserId || payload.targetEmployeeId || "").trim();
      const caller = socketParty(socket);
      const targetType = payload.targetUserType === "admin" ? "admin" : "employee";
      if (!callId || !targetId || (caller.type === targetType && caller.id === targetId)) return;

      const callerKey = voicePartyKey(socket.data.businessId, caller.type, caller.id);
      const targetKey = voicePartyKey(socket.data.businessId, targetType, targetId);
      if (employeeVoiceCalls.has(callerKey) || employeeVoiceCalls.has(targetKey)) {
        socket.emit("voice-call:busy", { callId, message: "This employee is already on another call." });
        return;
      }

      const target = targetType === "employee"
        ? await runForSocketBusiness(() => Employee.findOne({ _id: targetId, status: { $ne: "Archived" } }).select("_id name").lean())
        : { _id: "admin", name: findConfiguredAdmin(String(socket.data.authUserCode || ""))?.name || "Admin" };
      if (!target || !io.sockets.adapter.rooms.get(partyRoom(socket.data.businessId, targetType, targetId))?.size) {
        socket.emit("voice-call:unavailable", { callId, message: "This user is not connected to the CRM." });
        return;
      }

      const call: VoiceCallSession = {
        callId,
        businessId: socket.data.businessId,
        callerId: caller.id,
        callerType: caller.type,
        callerName: String(socket.data.authUserName || "Employee"),
        targetId,
        targetType,
        targetName: target.name,
        callerSocketId: socket.id,
        targetSocketId: "",
      };
      voiceCalls.set(callId, call);
      employeeVoiceCalls.set(callerKey, callId);
      employeeVoiceCalls.set(targetKey, callId);
      io.to(partyRoom(call.businessId, targetType, targetId)).emit("voice-call:incoming", call);
      socket.emit("voice-call:ringing", call);
    });

    socket.on("voice-call:accept", (payload: { callId?: string } = {}) => {
      const call = voiceCalls.get(String(payload.callId || ""));
      const party = socketParty(socket);
      if (!call || party.type !== call.targetType || party.id !== call.targetId) return;
      if (call.targetSocketId && call.targetSocketId !== socket.id) {
        socket.emit("voice-call:ended", { callId: call.callId, reason: "answered-on-another-tab" });
        return;
      }
      call.targetSocketId = socket.id;
      socket.to(partyRoom(call.businessId, call.targetType, call.targetId)).emit("voice-call:ended", { callId: call.callId, reason: "answered-on-another-tab" });
      io.to(call.callerSocketId).emit("voice-call:accepted", call);
      io.to(call.targetSocketId).emit("voice-call:accepted", call);
    });

    socket.on("voice-call:decline", (payload: { callId?: string; reason?: string } = {}) => {
      const call = voiceCalls.get(String(payload.callId || ""));
      const party = socketParty(socket);
      if (!call || party.type !== call.targetType || party.id !== call.targetId) return;
      clearVoiceCall(call.callId);
      io.to(partyRoom(call.businessId, call.callerType, call.callerId)).emit("voice-call:declined", { callId: call.callId, reason: String(payload.reason || "declined") });
      io.to(partyRoom(call.businessId, call.targetType, call.targetId)).emit("voice-call:ended", { callId: call.callId, reason: "declined" });
    });

    socket.on("voice-call:signal", (payload: { callId?: string; description?: unknown; candidate?: unknown } = {}) => {
      const call = voiceCalls.get(String(payload.callId || ""));
      const party = socketParty(socket);
      if (!call || !((party.type === call.callerType && party.id === call.callerId) || (party.type === call.targetType && party.id === call.targetId))) return;
      if (socket.id !== call.callerSocketId && socket.id !== call.targetSocketId) return;
      const recipientSocketId = socket.id === call.callerSocketId ? call.targetSocketId : call.callerSocketId;
      if (!recipientSocketId) return;
      io.to(recipientSocketId).emit("voice-call:signal", {
        callId: call.callId,
        description: payload.description,
        candidate: payload.candidate,
      });
    });

    socket.on("voice-call:end", (payload: { callId?: string; reason?: string } = {}) => {
      const call = voiceCalls.get(String(payload.callId || ""));
      const party = socketParty(socket);
      if (!call || !((party.type === call.callerType && party.id === call.callerId) || (party.type === call.targetType && party.id === call.targetId))) return;
      clearVoiceCall(call.callId);
      io.to(call.callerSocketId).emit("voice-call:ended", { callId: call.callId, reason: String(payload.reason || "ended") });
      if (call.targetSocketId) io.to(call.targetSocketId).emit("voice-call:ended", { callId: call.callId, reason: String(payload.reason || "ended") });
    });

    socket.on(
      "live-share:request",
      async (payload: { requestId?: string; employeeId?: string; employeeName?: string; adminName?: string } = {}) => {
        const requestId = String(payload.requestId || "").trim();
        const employeeId = String(payload.employeeId || "").trim();

        if (socket.data.authUserType !== "admin") {
          socket.emit("live-share:error", { requestId, message: "Only an authenticated administrator can request Live View." });
          return;
        }

        if (!requestId || !employeeId) {
          socket.emit("live-share:error", { requestId, message: "Employee and request id are required." });
          return;
        }

        if (isTrackerOnlyAdminCode(String(socket.data.authUserCode || ""))) {
          const isInternalEmployee = await runForSocketBusiness(() => Employee.exists({
            _id: employeeId,
            team: /^internal$/i,
            status: { $ne: "Archived" },
          }));
          if (!isInternalEmployee) {
            socket.emit("live-share:error", { requestId, message: "This administrator can only view Internal employees." });
            return;
          }
        }

        await runForSocketBusiness(() => LiveViewAudit.findOneAndUpdate(
          { requestId },
          {
            $setOnInsert: {
              requestId,
              employeeId,
              employeeName: String(payload.employeeName || "Employee").trim(),
              adminCode: socket.data.authUserCode,
              adminName: socket.data.authUserName,
              status: "requested",
              requestedAt: new Date(),
            },
          },
          { upsert: true }
        ));

        socket.join(liveShareRoom(socket.data.businessId, requestId));
        socket.to(employeeRoom(socket.data.businessId, employeeId)).emit("live-share:requested", {
          requestId,
          employeeId,
          employeeName: String(payload.employeeName || "Employee").trim(),
          adminName: String(payload.adminName || "Admin").trim(),
          requestedAt: new Date().toISOString(),
        });
      }
    );

    socket.on("live-share:accept", async (payload: { requestId?: string } = {}) => {
      const requestId = String(payload.requestId || "").trim();
      if (!requestId || socket.data.authUserType !== "employee") return;

      await runForSocketBusiness(() => LiveViewAudit.findOneAndUpdate(
        { requestId, employeeId: socket.data.authEmployeeId },
        { $set: { status: "active", startedAt: new Date(), reason: "" } }
      ));

      socket.join(liveShareRoom(socket.data.businessId, requestId));
      socket.to(liveShareRoom(socket.data.businessId, requestId)).emit("live-share:accepted", {
        requestId,
        acceptedAt: new Date().toISOString(),
      });
    });

    socket.on("live-share:decline", async (payload: { requestId?: string; reason?: string } = {}) => {
      const requestId = String(payload.requestId || "").trim();
      if (!requestId || socket.data.authUserType !== "employee") return;

      await runForSocketBusiness(() => LiveViewAudit.findOneAndUpdate(
        { requestId, employeeId: socket.data.authEmployeeId },
        { $set: { status: "declined", endedAt: new Date(), reason: String(payload.reason || "declined").trim() } }
      ));

      socket.to(liveShareRoom(socket.data.businessId, requestId)).emit("live-share:declined", {
        requestId,
        reason: String(payload.reason || "declined").trim(),
      });
    });

    socket.on(
      "live-share:signal",
      (payload: { requestId?: string; description?: unknown; candidate?: unknown } = {}) => {
      const requestId = String(payload.requestId || "").trim();
      if (!requestId) return;

        socket.to(liveShareRoom(socket.data.businessId, requestId)).emit("live-share:signal", {
          requestId,
          description: payload.description,
          candidate: payload.candidate,
        });
      }
    );

    socket.on("live-share:stop", async (payload: { requestId?: string; employeeId?: string; reason?: string } = {}) => {
      const requestId = String(payload.requestId || "").trim();
      if (!requestId) return;

      const employeeId = String(payload.employeeId || "").trim();
      const stopPayload = {
        requestId,
        reason: String(payload.reason || "stopped").trim(),
      };

      await runForSocketBusiness(() => LiveViewAudit.findOneAndUpdate(
        { requestId },
        { $set: { status: "ended", endedAt: new Date(), reason: stopPayload.reason } }
      ));

      io.to(liveShareRoom(socket.data.businessId, requestId)).emit("live-share:stopped", stopPayload);

      if (employeeId) {
        io.to(employeeRoom(socket.data.businessId, employeeId)).emit("live-share:stopped", stopPayload);
      }
    });

    socket.on(
      "message:send",
      async (payload: { conversationId: string; senderId?: string | null; senderName?: string; senderType?: "admin" | "employee"; body: string }) => {
        await runForSocketBusiness(async () => {
          const senderType = payload.senderType === "admin" ? "admin" : "employee";
          const senderName = String(payload.senderName || (senderType === "admin" ? "Admin" : "Employee")).trim();

          if (!payload.conversationId || (senderType === "employee" && !payload.senderId) || !payload.body?.trim()) {
            return;
          }

          const message = await Message.create({
            conversation: payload.conversationId,
            sender: senderType === "employee" ? payload.senderId : null,
            senderName,
            senderType,
            body: payload.body,
          });

          const populatedMessage = await Message.findById(message.id).populate({
            path: "sender",
            select: "name role team email status",
          });

          await Conversation.findByIdAndUpdate(payload.conversationId, {
            lastMessage: payload.body,
            lastMessageAt: new Date(),
          });
          const populatedConversation = await Conversation.findById(payload.conversationId)
            .populate({ path: "participants", select: "name role team email status" })
            .populate({ path: "team", select: "name status" });

          emitMessageEvents(payload.conversationId, populatedMessage, populatedConversation);
        });
      }
    );

    socket.on("disconnect", () => {
      clearTimeout(expiryTimer); clearInterval(membershipTimer);
      const party = socketParty(socket);
      const callId = employeeVoiceCalls.get(voicePartyKey(socket.data.businessId, party.type, party.id));
      if (!callId) return;
      const activeCall = voiceCalls.get(callId);
      if (!activeCall || (socket.id !== activeCall.callerSocketId && socket.id !== activeCall.targetSocketId)) return;
      const call = clearVoiceCall(callId);
      if (!call) return;
      const recipientSocketId = socket.id === call.callerSocketId ? call.targetSocketId : call.callerSocketId;
      if (recipientSocketId) io.to(recipientSocketId).emit("voice-call:ended", { callId, reason: "disconnected" });
    });
  });

  return io;
}

export function emitEmployeeAvailabilityUpdated(payload: {
  employeeId: string;
  availabilityStatus: string;
}, businessEmployees?: Array<{ businessId: string; employeeId: string }>) {
  if (!businessEmployees?.length) {
    socketServer?.to(businessRoom(getCurrentBusinessId())).emit("employee:availability-updated", payload);
    return;
  }

  businessEmployees.forEach(({ businessId, employeeId }) => {
    socketServer?.to(businessRoom(businessId)).emit("employee:availability-updated", {
      ...payload,
      employeeId,
    });
  });
}

export function emitCallDashboardUpdated(businessIds: string[]) {
  for (const businessId of new Set(businessIds.filter(Boolean))) {
    socketServer?.to(businessRoom(businessId)).emit("call-dashboard:updated");
  }
}

export function emitLeadCallStatUpdated(businessId: string, payload: {
  leadId: string;
  employeeId: string;
  outcome: "connected" | "not_connected" | "voicemail";
}) {
  socketServer?.to(businessRoom(businessId)).emit("lead-call-stat:updated", payload);
}

export function emitLeadChanged(payload: {
  action: string;
  lead?: unknown;
  leadIds?: string[];
  assignedAgentId?: string | null;
}) {
  socketServer?.to(businessRoom(getCurrentBusinessId())).emit("lead:changed", payload);
}
