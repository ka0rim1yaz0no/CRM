import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { getBusinessById, getCurrentBusinessId, getDefaultBusiness, runWithBusiness } from "./config/tenancy";
import { Conversation } from "./models/Conversation";
import { Message } from "./models/Message";

let socketServer: Server | null = null;

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

  socketServer?.to(conversationRoom(businessId, conversationId)).emit("message:new", message);
  socketServer?.to(businessRoom(businessId)).emit("message:notification", {
    message,
    conversation,
  });
  socketServer?.to(businessRoom(businessId)).emit("conversation:updated", { conversationId });
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

  io.on("connection", (socket) => {
    const business = resolveSocketBusiness(socket);
    socket.data.businessId = business.id;
    socket.join(businessRoom(business.id));

    const runForSocketBusiness = <T>(callback: () => T) => runWithBusiness(socket.data.businessId, callback);

    socket.on(
      "presence:register",
      (payload: { userType?: "admin" | "employee"; employeeId?: string; employeeName?: string; adminName?: string } = {}) => {
        if (payload.userType === "admin") {
          socket.join(`business:${socket.data.businessId}:admins`);
          return;
        }

        if (payload.userType === "employee" && payload.employeeId) {
          socket.join(employeeRoom(socket.data.businessId, payload.employeeId));
        }
      }
    );

    socket.on("conversation:join", (conversationId: string) => {
      socket.join(conversationRoom(socket.data.businessId, conversationId));
    });

    socket.on(
      "live-share:request",
      (payload: { requestId?: string; employeeId?: string; employeeName?: string; adminName?: string } = {}) => {
        const requestId = String(payload.requestId || "").trim();
        const employeeId = String(payload.employeeId || "").trim();

        if (!requestId || !employeeId) {
          socket.emit("live-share:error", { requestId, message: "Employee and request id are required." });
          return;
        }

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

    socket.on("live-share:accept", (payload: { requestId?: string } = {}) => {
      const requestId = String(payload.requestId || "").trim();
      if (!requestId) return;

      socket.join(liveShareRoom(socket.data.businessId, requestId));
      socket.to(liveShareRoom(socket.data.businessId, requestId)).emit("live-share:accepted", {
        requestId,
        acceptedAt: new Date().toISOString(),
      });
    });

    socket.on("live-share:decline", (payload: { requestId?: string; reason?: string } = {}) => {
      const requestId = String(payload.requestId || "").trim();
      if (!requestId) return;

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

    socket.on("live-share:stop", (payload: { requestId?: string; employeeId?: string; reason?: string } = {}) => {
      const requestId = String(payload.requestId || "").trim();
      if (!requestId) return;

      const employeeId = String(payload.employeeId || "").trim();
      const stopPayload = {
        requestId,
        reason: String(payload.reason || "stopped").trim(),
      };

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

export function emitLeadChanged(payload: {
  action: string;
  lead?: unknown;
  leadIds?: string[];
  assignedAgentId?: string | null;
}) {
  socketServer?.to(businessRoom(getCurrentBusinessId())).emit("lead:changed", payload);
}
