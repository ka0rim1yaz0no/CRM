import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { findConfiguredAdmin } from "./config/adminUsers";
import { getBusinessById, getCurrentBusinessId, getDefaultBusiness, runWithBusiness } from "./config/tenancy";
import { Conversation } from "./models/Conversation";
import { Employee } from "./models/Employee";
import { LiveViewAudit } from "./models/LiveViewAudit";
import { Message } from "./models/Message";

let socketServer: Server | null = null;

type VoiceCallSession = {
  callId: string;
  businessId: string;
  callerId: string;
  callerName: string;
  targetId: string;
  targetName: string;
  callerSocketId: string;
  targetSocketId: string;
};

const voiceCalls = new Map<string, VoiceCallSession>();
const employeeVoiceCalls = new Map<string, string>();

function voiceEmployeeKey(businessId: string, employeeId: string) {
  return `${businessId}:${employeeId}`;
}

function clearVoiceCall(callId: string) {
  const call = voiceCalls.get(callId);
  if (!call) return null;
  voiceCalls.delete(callId);
  employeeVoiceCalls.delete(voiceEmployeeKey(call.businessId, call.callerId));
  employeeVoiceCalls.delete(voiceEmployeeKey(call.businessId, call.targetId));
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

function liveShareRoom(businessId: string, requestId: string) {
  return `business:${businessId}:live-share:${requestId}`;
}

function resolveSocketBusiness(socket: Socket) {
  const businessId = String(socket.handshake.auth?.businessId || socket.handshake.query?.businessId || "").trim();
  return getBusinessById(businessId) || getDefaultBusiness();
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
    const business = resolveSocketBusiness(socket);
    const userType = String(socket.handshake.auth?.userType || "").trim().toLowerCase();
    const userCode = String(socket.handshake.auth?.userCode || "").trim();

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
  });

  io.on("connection", (socket) => {
    const business = resolveSocketBusiness(socket);
    socket.data.businessId = business.id;
    socket.join(businessRoom(business.id));
    if (socket.data.authUserType === "admin") {
      socket.join(`business:${business.id}:admins`);
    } else if (socket.data.authUserType === "employee" && socket.data.authEmployeeId) {
      socket.join(employeeRoom(business.id, socket.data.authEmployeeId));
    }

    const runForSocketBusiness = <T>(callback: () => T) => runWithBusiness(socket.data.businessId, callback);

    socket.on(
      "presence:register",
      (_payload: { userType?: "admin" | "employee"; employeeId?: string; employeeName?: string; adminName?: string } = {}) => {
        if (socket.data.authUserType === "admin") {
          socket.join(`business:${socket.data.businessId}:admins`);
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

    socket.on("voice-call:start", async (payload: { callId?: string; targetEmployeeId?: string } = {}) => {
      if (socket.data.authUserType !== "employee" || !socket.data.authEmployeeId) return;
      const callId = String(payload.callId || "").trim();
      const targetId = String(payload.targetEmployeeId || "").trim();
      const callerId = String(socket.data.authEmployeeId);
      if (!callId || !targetId || callerId === targetId) return;

      const callerKey = voiceEmployeeKey(socket.data.businessId, callerId);
      const targetKey = voiceEmployeeKey(socket.data.businessId, targetId);
      if (employeeVoiceCalls.has(callerKey) || employeeVoiceCalls.has(targetKey)) {
        socket.emit("voice-call:busy", { callId, message: "This employee is already on another call." });
        return;
      }

      const target = await runForSocketBusiness(() => Employee.findOne({ _id: targetId, status: { $ne: "Archived" } }).select("_id name").lean());
      if (!target) {
        socket.emit("voice-call:unavailable", { callId, message: "This employee is unavailable." });
        return;
      }
      if (!io.sockets.adapter.rooms.get(employeeRoom(socket.data.businessId, targetId))?.size) {
        socket.emit("voice-call:unavailable", { callId, message: "This employee is not connected to the CRM." });
        return;
      }

      const call: VoiceCallSession = {
        callId,
        businessId: socket.data.businessId,
        callerId,
        callerName: String(socket.data.authUserName || "Employee"),
        targetId,
        targetName: target.name,
        callerSocketId: socket.id,
        targetSocketId: "",
      };
      voiceCalls.set(callId, call);
      employeeVoiceCalls.set(callerKey, callId);
      employeeVoiceCalls.set(targetKey, callId);
      io.to(employeeRoom(call.businessId, targetId)).emit("voice-call:incoming", call);
      socket.emit("voice-call:ringing", call);
    });

    socket.on("voice-call:accept", (payload: { callId?: string } = {}) => {
      const call = voiceCalls.get(String(payload.callId || ""));
      if (!call || socket.data.authUserType !== "employee" || socket.data.authEmployeeId !== call.targetId) return;
      if (call.targetSocketId && call.targetSocketId !== socket.id) {
        socket.emit("voice-call:ended", { callId: call.callId, reason: "answered-on-another-tab" });
        return;
      }
      call.targetSocketId = socket.id;
      socket.to(employeeRoom(call.businessId, call.targetId)).emit("voice-call:ended", { callId: call.callId, reason: "answered-on-another-tab" });
      io.to(call.callerSocketId).emit("voice-call:accepted", call);
      io.to(call.targetSocketId).emit("voice-call:accepted", call);
    });

    socket.on("voice-call:decline", (payload: { callId?: string; reason?: string } = {}) => {
      const call = voiceCalls.get(String(payload.callId || ""));
      if (!call || socket.data.authUserType !== "employee" || socket.data.authEmployeeId !== call.targetId) return;
      clearVoiceCall(call.callId);
      io.to(employeeRoom(call.businessId, call.callerId)).emit("voice-call:declined", { callId: call.callId, reason: String(payload.reason || "declined") });
      io.to(employeeRoom(call.businessId, call.targetId)).emit("voice-call:ended", { callId: call.callId, reason: "declined" });
    });

    socket.on("voice-call:signal", (payload: { callId?: string; description?: unknown; candidate?: unknown } = {}) => {
      const call = voiceCalls.get(String(payload.callId || ""));
      const employeeId = String(socket.data.authEmployeeId || "");
      if (!call || socket.data.authUserType !== "employee" || (employeeId !== call.callerId && employeeId !== call.targetId)) return;
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
      const employeeId = String(socket.data.authEmployeeId || "");
      if (!call || (employeeId !== call.callerId && employeeId !== call.targetId)) return;
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
      const employeeId = String(socket.data.authEmployeeId || "");
      const callId = employeeVoiceCalls.get(voiceEmployeeKey(socket.data.businessId, employeeId));
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
