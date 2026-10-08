import type { Request, Response } from "express";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { getConfiguredBusinesses } from "../config/tenancy";
import { findConfiguredAdmin } from "../config/adminUsers";
import { Conversation } from "../models/Conversation";
import { Employee } from "../models/Employee";
import { Message, type MessageAttachment } from "../models/Message";
import { Team } from "../models/Team";
import { emitMessageEvents, emitMessageMutationEvent, emitMessagesRefresh } from "../socket";
import { emitMirroredDirectMessage, syncDirectMessagesToBusiness } from "../services/directMessageSyncService";

const messageUploadRoot = path.resolve(process.cwd(), "uploads", "messages");
const maxAttachmentBytes = 50 * 1024 * 1024;
const maxAttachmentsPerMessage = 6;
const allowedMimeTypes = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/ogg", "video/quicktime",
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/webm",
  "application/pdf", "text/plain", "text/csv",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const populateConversation = [
  { path: "participants", select: "name role team email status employeeCode" },
  { path: "team", select: "name status" },
];
const populateMessageSender = { path: "sender", select: "name role team email status employeeCode" };

type MessageActor = {
  type: "admin" | "employee";
  employeeId: string | null;
  name: string;
  key: string;
};

function toText(value: unknown, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

async function resolveActor(request: Request): Promise<MessageActor | null> {
  const userType = toText(request.header("x-crm-user-type")).toLowerCase();
  const userCode = toText(request.header("x-crm-user-code"));

  if (userType === "admin") {
    const admin = findConfiguredAdmin(userCode);
    return admin ? { type: "admin", employeeId: null, name: toText(request.header("x-crm-user-name"), admin.name), key: `admin:${admin.employeeCode}` } : null;
  }

  if (userType === "employee" && userCode) {
    const employee = await Employee.findOne({ employeeCode: userCode, status: { $ne: "Archived" } })
      .select("_id name").lean();
    return employee ? { type: "employee", employeeId: String(employee._id), name: employee.name, key: `employee:${userCode}` } : null;
  }

  return null;
}

function actorCanAccessConversation(actor: MessageActor, conversation: { includeAdmin?: boolean; type?: string; participants?: unknown[] }) {
  if (actor.type === "admin") return Boolean(conversation.includeAdmin) || conversation.type === "team";
  return (conversation.participants || []).some((participant) => String(participant) === actor.employeeId);
}

function teamParticipantIds(team: { members: unknown[]; lead?: unknown }) {
  return Array.from(new Set([...(team.members || []).map(String), ...(team.lead ? [String(team.lead)] : [])]));
}

async function requireActor(request: Request, response: Response) {
  const actor = await resolveActor(request);
  if (!actor) response.status(401).json({ message: "Authenticated CRM user is required." });
  return actor;
}

async function requireConversation(request: Request, response: Response, actor: MessageActor) {
  const conversation = await Conversation.findById(toText(request.params.conversationId));
  if (!conversation) {
    response.status(404).json({ message: "Conversation not found." });
    return null;
  }
  if (!actorCanAccessConversation(actor, conversation)) {
    response.status(403).json({ message: "You do not have access to this conversation." });
    return null;
  }
  return conversation;
}

function attachmentKind(mimeType: string): MessageAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function safeFileName(value: unknown) {
  return toText(value, "attachment").slice(0, 180).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function isSafeStoredFileName(value: string) {
  return /^[a-z0-9_.-]+$/i.test(value) && !value.includes("..");
}

function normalizeAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxAttachmentsPerMessage).flatMap((raw) => {
    const attachment = raw as Partial<MessageAttachment>;
    const url = toText(attachment.url);
    const mimeType = toText(attachment.mimeType);
    const size = Number(attachment.size);
    if (!url.startsWith("/api/messages/attachments/") || !allowedMimeTypes.has(mimeType) || !Number.isFinite(size) || size < 1 || size > maxAttachmentBytes) return [];
    return [{ name: safeFileName(attachment.name), url, mimeType, size, kind: attachmentKind(mimeType) }];
  });
}

function actorOwnsMessage(actor: MessageActor, message: { sender?: unknown; senderType?: string }) {
  return actor.type === "admin"
    ? message.senderType === "admin"
    : Boolean(actor.employeeId) && String(message.sender || "") === actor.employeeId;
}

function attachmentSummary(attachments: MessageAttachment[]) {
  if (!attachments.length) return "";
  if (attachments.length > 1) return `${attachments.length} attachments`;
  return attachments[0].kind === "file" ? attachments[0].name : attachments[0].kind;
}

async function updateConversationPreview(conversationId: string) {
  const latest = await Message.findOne({ conversation: conversationId }).sort({ createdAt: -1 }).lean();
  const lastMessage = !latest
    ? ""
    : latest.deletedAt
      ? "Message deleted"
      : latest.body || (latest.attachments.length === 1 ? `Sent ${latest.attachments[0].kind === "file" ? "a file" : `an ${latest.attachments[0].kind}`}` : `Sent ${latest.attachments.length} attachments`);
  await Conversation.findByIdAndUpdate(conversationId, { lastMessage, lastMessageAt: latest ? (latest as unknown as { createdAt: Date }).createdAt : null });
}

async function syncDirectConversationMutation(conversationType: string) {
  if (conversationType !== "direct") return;
  const businessIds = getConfiguredBusinesses().map((business) => business.id);
  const results = await Promise.allSettled(businessIds.map((businessId) => syncDirectMessagesToBusiness(businessId)));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error("Direct message synchronization failed", { businessId: businessIds[index], error: result.reason });
    }
  });
  emitMessagesRefresh(businessIds);
}

export async function listConversations(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor) return;
  const conversations = await (actor.type === "admin"
    ? Conversation.find({ $or: [{ includeAdmin: true }, { type: "team" as const }] })
    : Conversation.find({ participants: actor.employeeId }))
    .populate(populateConversation)
    .sort({ lastMessageAt: -1, updatedAt: -1 });
  response.json(conversations);
}

export async function createDirectConversation(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor) return;
  const rawParticipants: unknown[] = Array.isArray(request.body.participants) ? request.body.participants : [];
  const participants = Array.from(new Set(rawParticipants.map((value) => toText(value)).filter(Boolean)));
  const includeAdmin = actor.type === "admin" || Boolean(request.body.includeAdmin);

  if (actor.type === "employee" && !includeAdmin && !participants.includes(actor.employeeId || "")) participants.push(actor.employeeId || "");
  const requiredCount = includeAdmin ? 1 : 2;
  if (participants.length < requiredCount || participants.length > 2) {
    response.status(400).json({ message: includeAdmin ? "One employee participant is required." : "Two employee participants are required." });
    return;
  }
  const validParticipantCount = await Employee.countDocuments({ _id: { $in: participants }, status: { $ne: "Archived" } });
  if (validParticipantCount !== participants.length) {
    response.status(400).json({ message: "One or more participants are unavailable." });
    return;
  }

  const existingConversation = await Conversation.findOne({ type: "direct", participants: { $all: participants, $size: participants.length }, includeAdmin }).populate(populateConversation);
  if (existingConversation) return void response.json(existingConversation);

  const conversation = await Conversation.create({ type: "direct", title: includeAdmin ? "Admin" : "", participants, includeAdmin });
  response.status(201).json(await Conversation.findById(conversation.id).populate(populateConversation));
}

export async function createTeamConversation(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor) return;
  const teamId = toText(request.body.team);
  if (!teamId) return void response.status(400).json({ message: "team is required" });
  const existingConversation = await Conversation.findOne({ type: "team", team: teamId }).populate(populateConversation);
  if (existingConversation) {
    const team = await Team.findById(teamId).lean();
    if (!team || team.status === "Archived") return void response.status(404).json({ message: "Team not found" });
    const participants = teamParticipantIds(team);
    existingConversation.participants = participants.map((participant) => new Types.ObjectId(participant));
    existingConversation.title = team.name;
    existingConversation.includeAdmin = true;
    await existingConversation.save();
    if (!actorCanAccessConversation(actor, existingConversation)) return void response.status(403).json({ message: "You are not a member of this team." });
    return void response.json(await Conversation.findById(existingConversation.id).populate(populateConversation));
  }
  const team = await Team.findById(teamId);
  if (!team) return void response.status(404).json({ message: "Team not found" });
  const participants = teamParticipantIds(team);
  if (actor.type === "employee" && !participants.includes(actor.employeeId || "")) {
    return void response.status(403).json({ message: "You are not a member of this team." });
  }
  const conversation = await Conversation.create({ type: "team", title: team.name, team: team.id, participants, includeAdmin: true });
  response.status(201).json(await Conversation.findById(conversation.id).populate(populateConversation));
}

export async function listMessages(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor || !await requireConversation(request, response, actor)) return;
  const messages = await Message.find({ conversation: request.params.conversationId }).populate(populateMessageSender).sort({ createdAt: 1 });
  response.json(messages);
}

export async function listUnreadMessageNotifications(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor) return;
  const conversations = await (actor.type === "admin"
    ? Conversation.find({ $or: [{ includeAdmin: true }, { type: "team" as const }] }).select("_id")
    : Conversation.find({ participants: actor.employeeId }).select("_id"))
    .lean();
  const conversationIds = conversations.map((conversation) => conversation._id);
  if (!conversationIds.length) return void response.json([]);
  const messages = await Message.find({
    conversation: { $in: conversationIds },
    deletedAt: null,
    ...(actor.type === "admin" ? { senderType: { $ne: "admin" } } : { sender: { $ne: actor.employeeId } }),
    seenBy: { $ne: actor.key },
  })
    .sort({ createdAt: -1 })
    .limit(30)
    .populate(populateMessageSender)
    .populate({ path: "conversation", populate: populateConversation });
  response.json(messages.map((message) => {
    const populatedConversation = message.conversation as unknown as { _id: Types.ObjectId };
    return {
      message: { ...message.toObject(), conversation: String(populatedConversation._id) },
      conversation: populatedConversation,
    };
  }));
}

export async function markMessageNotificationSeen(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor) return;
  const messageId = toText(request.params.messageId);
  if (!Types.ObjectId.isValid(messageId)) return void response.status(400).json({ message: "Invalid message id." });
  const message = await Message.findById(messageId);
  if (!message) return void response.status(404).json({ message: "Message not found." });
  const conversation = await Conversation.findById(message.conversation);
  if (!conversation || !actorCanAccessConversation(actor, conversation)) {
    return void response.status(403).json({ message: "You do not have access to this notification." });
  }
  if (!message.seenBy.includes(actor.key)) {
    message.seenBy.push(actor.key);
    await message.save();
    emitMessageMutationEvent(String(conversation.id), "message:seen", {
      conversationId: String(conversation.id),
      messageIds: [String(message.id)],
      readerKey: actor.key,
      seenAt: new Date().toISOString(),
    });
    await syncDirectConversationMutation(conversation.type);
  }
  response.json({ messageId: String(message.id), readerKey: actor.key });
}

export async function uploadMessageAttachment(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor || !await requireConversation(request, response, actor)) return;
  const dataUrl = String(request.body.dataUrl || "");
  const match = dataUrl.match(/^data:([^;,]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match || !allowedMimeTypes.has(match[1])) return void response.status(400).json({ message: "Unsupported attachment type." });
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length || bytes.length > maxAttachmentBytes) return void response.status(413).json({ message: "Attachments must be 50 MB or smaller." });
  const originalName = safeFileName(request.body.fileName);
  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}-${originalName}`;
  await mkdir(messageUploadRoot, { recursive: true });
  await writeFile(path.join(messageUploadRoot, fileName), bytes, { flag: "wx" });
  response.status(201).json({ name: originalName, url: `/api/messages/attachments/${fileName}`, mimeType: match[1], size: bytes.length, kind: attachmentKind(match[1]) });
}

export async function serveMessageAttachment(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor) return;
  const fileName = toText(request.params.fileName).slice(0, 260);
  if (!isSafeStoredFileName(fileName)) return void response.status(400).json({ message: "Invalid attachment path." });
  const url = `/api/messages/attachments/${fileName}`;
  const message = await Message.findOne({ "attachments.url": url }).select("conversation attachments").lean();
  if (!message) return void response.status(404).json({ message: "Attachment not found." });
  const conversation = await Conversation.findById(message.conversation).lean();
  if (!conversation || !actorCanAccessConversation(actor, conversation)) return void response.status(403).json({ message: "You do not have access to this attachment." });
  const filePath = path.resolve(messageUploadRoot, fileName);
  if (!filePath.startsWith(`${messageUploadRoot}${path.sep}`)) return void response.status(400).json({ message: "Invalid attachment path." });
  try {
    if (!(await stat(filePath)).isFile()) throw new Error("not a file");
    response.setHeader("Cache-Control", "private, max-age=3600");
    response.sendFile(filePath);
  } catch {
    response.status(404).json({ message: "Attachment file is unavailable." });
  }
}

export async function createMessage(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor) return;
  const conversation = await requireConversation(request, response, actor);
  if (!conversation) return;
  const body = toText(request.body.body).slice(0, 10_000);
  const attachments = normalizeAttachments(request.body.attachments);
  if (!body && !attachments.length) return void response.status(400).json({ message: "Add a message or attachment." });

  let replyTo = null;
  const replyToId = toText(request.body.replyTo);
  if (replyToId && Types.ObjectId.isValid(replyToId)) {
    const repliedMessage = await Message.findOne({ _id: replyToId, conversation: conversation.id }).lean();
    if (!repliedMessage) return void response.status(400).json({ message: "The message you are replying to is unavailable." });
    replyTo = {
      messageId: repliedMessage._id,
      senderName: repliedMessage.senderName || (repliedMessage.senderType === "admin" ? "Admin" : "Employee"),
      body: repliedMessage.deletedAt ? "Message deleted" : (repliedMessage.body || "").slice(0, 500),
      attachmentLabel: repliedMessage.deletedAt ? "" : attachmentSummary(repliedMessage.attachments || []),
    };
  }

  const message = await Message.create({ conversation: conversation.id, sender: actor.employeeId, senderName: actor.name, senderType: actor.type, body, attachments, replyTo });
  const populatedMessage = await Message.findById(message.id).populate(populateMessageSender);
  const lastMessage = body || (attachments.length === 1 ? `Sent ${attachments[0].kind === "file" ? "a file" : `an ${attachments[0].kind}`}` : `Sent ${attachments.length} attachments`);
  await Conversation.findByIdAndUpdate(conversation.id, { lastMessage, lastMessageAt: new Date() });
  const populatedConversation = await Conversation.findById(conversation.id).populate(populateConversation);
  emitMessageEvents(String(conversation.id), populatedMessage, populatedConversation);
  response.status(201).json(populatedMessage);

  if (conversation.type === "direct") {
    const businessIds = getConfiguredBusinesses().map((business) => business.id);
    const participantCodes = ((populatedConversation?.participants || []) as unknown as Array<{ employeeCode?: string }>)
      .map((participant) => String(participant.employeeCode || "").trim())
      .filter(Boolean);
    const replicationInput = {
      sourceBusinessId: request.business?.id || "",
      includeAdmin: Boolean(conversation.includeAdmin),
      participantCodes,
      createdAt: new Date((populatedMessage as unknown as { createdAt: Date }).createdAt),
      senderName: actor.name,
      senderType: actor.type,
      body,
    } as const;

    void (async () => {
      const syncResults = await Promise.allSettled(businessIds.map((businessId) => syncDirectMessagesToBusiness(businessId)));
      syncResults.forEach((result, index) => {
        if (result.status === "rejected") {
          console.error("New direct message synchronization failed", { businessId: businessIds[index], error: result.reason });
        }
      });
      try {
        await emitMirroredDirectMessage(replicationInput);
      } catch (error) {
        console.error("Mirrored direct message delivery failed", { conversationId: String(conversation.id), error });
      }
      emitMessagesRefresh(businessIds);
    })().catch((error) => {
      console.error("Direct message background replication failed", { conversationId: String(conversation.id), error });
    });
  }
}

export async function updateMessage(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor) return;
  const conversation = await requireConversation(request, response, actor);
  if (!conversation) return;
  const messageId = toText(request.params.messageId);
  if (!Types.ObjectId.isValid(messageId)) return void response.status(400).json({ message: "Invalid message id." });
  const message = await Message.findOne({ _id: messageId, conversation: conversation.id });
  if (!message) return void response.status(404).json({ message: "Message not found." });
  if (!actorOwnsMessage(actor, message)) return void response.status(403).json({ message: "You can only edit your own messages." });
  if (message.deletedAt) return void response.status(409).json({ message: "Deleted messages cannot be edited." });
  const body = toText(request.body.body).slice(0, 10_000);
  if (!body && !message.attachments.length) return void response.status(400).json({ message: "A message cannot be empty." });
  message.body = body;
  message.editedAt = new Date();
  await message.save();
  await updateConversationPreview(String(conversation.id));
  const populatedMessage = await Message.findById(message.id).populate(populateMessageSender);
  emitMessageMutationEvent(String(conversation.id), "message:updated", populatedMessage);
  await syncDirectConversationMutation(conversation.type);
  response.json(populatedMessage);
}

export async function deleteMessage(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor) return;
  const conversation = await requireConversation(request, response, actor);
  if (!conversation) return;
  const messageId = toText(request.params.messageId);
  if (!Types.ObjectId.isValid(messageId)) return void response.status(400).json({ message: "Invalid message id." });
  const message = await Message.findOne({ _id: messageId, conversation: conversation.id });
  if (!message) return void response.status(404).json({ message: "Message not found." });
  if (!actorOwnsMessage(actor, message)) return void response.status(403).json({ message: "You can only delete your own messages." });
  if (!message.deletedAt) {
    message.body = "";
    message.attachments = [];
    message.deletedAt = new Date();
    await message.save();
    await updateConversationPreview(String(conversation.id));
  }
  const populatedMessage = await Message.findById(message.id).populate(populateMessageSender);
  emitMessageMutationEvent(String(conversation.id), "message:deleted", populatedMessage);
  await syncDirectConversationMutation(conversation.type);
  response.json(populatedMessage);
}

export async function markMessagesSeen(request: Request, response: Response) {
  const actor = await requireActor(request, response);
  if (!actor) return;
  const conversation = await requireConversation(request, response, actor);
  if (!conversation) return;
  const unseenMessages = await Message.find({
    conversation: conversation.id,
    ...(actor.type === "admin" ? { senderType: { $ne: "admin" } } : { sender: { $ne: actor.employeeId } }),
    seenBy: { $ne: actor.key },
  }).select("_id").lean();
  const messageIds = unseenMessages.map((message) => String(message._id));
  if (messageIds.length) {
    await Message.updateMany({ _id: { $in: messageIds } }, { $addToSet: { seenBy: actor.key } });
    emitMessageMutationEvent(String(conversation.id), "message:seen", {
      conversationId: String(conversation.id),
      messageIds,
      readerKey: actor.key,
      seenAt: new Date().toISOString(),
    });
    await syncDirectConversationMutation(conversation.type);
  }
  response.json({ conversationId: String(conversation.id), messageIds, readerKey: actor.key });
}
