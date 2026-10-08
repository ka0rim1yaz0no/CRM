import { getConfiguredBusinesses, runWithBusiness } from "../config/tenancy";
import { Conversation } from "../models/Conversation";
import { Employee } from "../models/Employee";
import { Message, type MessageAttachment, type MessageReply } from "../models/Message";
import { emitMessageEvents } from "../socket";

type DirectMessageSnapshot = {
  senderCode: string;
  senderName: string;
  senderType: "admin" | "employee";
  body: string;
  attachments: MessageAttachment[];
  replyTo: MessageReply | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  seenBy: string[];
  createdAt: Date;
  updatedAt: Date;
};

type DirectConversationSnapshot = {
  key: string;
  includeAdmin: boolean;
  participantCodes: string[];
  title: string;
  messages: DirectMessageSnapshot[];
};

const activeSyncs = new Map<string, Promise<void>>();

function conversationKey(includeAdmin: boolean, participantCodes: string[]) {
  return `${includeAdmin ? "admin" : "direct"}:${[...participantCodes].sort().join("|")}`;
}

function messageKey(message: DirectMessageSnapshot) {
  return [
    message.createdAt.toISOString(),
    message.senderType,
    message.senderCode,
    message.senderName,
  ].join("::");
}

function mergeMessage(target: DirectMessageSnapshot, source: DirectMessageSnapshot) {
  target.seenBy = Array.from(new Set([...target.seenBy, ...source.seenBy]));
  if (source.updatedAt > target.updatedAt) {
    target.body = source.body;
    target.attachments = source.attachments;
    target.replyTo = source.replyTo;
    target.editedAt = source.editedAt;
    target.deletedAt = source.deletedAt;
    target.updatedAt = source.updatedAt;
  }
}

function messagePreview(message: DirectMessageSnapshot) {
  if (message.deletedAt) return "Message deleted";
  return message.body || (message.attachments.length === 1 ? "Sent an attachment" : `Sent ${message.attachments.length} attachments`);
}

async function readBusinessDirectMessages(businessId: string) {
  return runWithBusiness(businessId, async () => {
    const employees = await Employee.find({ status: { $ne: "Archived" } }).select("_id employeeCode").lean();
    const codeById = new Map(employees.map((employee) => [String(employee._id), employee.employeeCode]));
    const conversations = await Conversation.find({ type: "direct" }).lean();
    const snapshots: DirectConversationSnapshot[] = [];

    for (const conversation of conversations) {
      const participantCodes = conversation.participants.map((participant) => codeById.get(String(participant)) || "").filter(Boolean).sort();
      if (!participantCodes.length || participantCodes.length !== conversation.participants.length) continue;
      const messages = await Message.find({ conversation: conversation._id }).sort({ createdAt: 1 }).lean();
      snapshots.push({
        key: conversationKey(Boolean(conversation.includeAdmin), participantCodes),
        includeAdmin: Boolean(conversation.includeAdmin),
        participantCodes,
        title: conversation.title || "",
        messages: messages.map((message) => ({
          senderCode: message.sender ? codeById.get(String(message.sender)) || "" : "",
          senderName: message.senderName || "",
          senderType: message.senderType,
          body: message.body || "",
          attachments: message.attachments || [],
          replyTo: message.replyTo || null,
          editedAt: message.editedAt ? new Date(message.editedAt) : null,
          deletedAt: message.deletedAt ? new Date(message.deletedAt) : null,
          seenBy: message.seenBy || [],
          createdAt: new Date((message as unknown as { createdAt: Date }).createdAt),
          updatedAt: new Date((message as unknown as { updatedAt: Date }).updatedAt),
        })),
      });
    }

    return snapshots;
  });
}

async function performSync(targetBusinessId: string) {
  const sourceGroups = await Promise.all(
    getConfiguredBusinesses().map((business) => readBusinessDirectMessages(business.id))
  );
  const merged = new Map<string, DirectConversationSnapshot>();

  for (const snapshot of sourceGroups.flat()) {
    const current = merged.get(snapshot.key);
    if (!current) {
      merged.set(snapshot.key, { ...snapshot, messages: [...snapshot.messages] });
      continue;
    }
    const knownMessages = new Map(current.messages.map((message) => [messageKey(message), message]));
    for (const message of snapshot.messages) {
      const key = messageKey(message);
      const existing = knownMessages.get(key);
      if (!existing) {
        current.messages.push(message);
        knownMessages.set(key, message);
      } else {
        mergeMessage(existing, message);
      }
    }
  }

  await runWithBusiness(targetBusinessId, async () => {
    const employees = await Employee.find({ status: { $ne: "Archived" } }).select("_id employeeCode").lean();
    const employeeByCode = new Map(employees.map((employee) => [employee.employeeCode, employee]));

    for (const snapshot of merged.values()) {
      const participants = snapshot.participantCodes.map((code) => employeeByCode.get(code)).filter(Boolean);
      if (participants.length !== snapshot.participantCodes.length) continue;
      const participantIds = participants.map((employee) => employee!._id);
      let conversation = await Conversation.findOne({
        type: "direct",
        includeAdmin: snapshot.includeAdmin,
        participants: { $all: participantIds, $size: participantIds.length },
      });
      if (!conversation) {
        conversation = await Conversation.create({
          type: "direct",
          title: snapshot.title,
          participants: participantIds,
          includeAdmin: snapshot.includeAdmin,
        });
      }

      const existingMessages = await Message.find({ conversation: conversation._id });
      const existingByKey = new Map(existingMessages.map((message) => [messageKey({
        senderCode: message.sender ? employees.find((employee) => String(employee._id) === String(message.sender))?.employeeCode || "" : "",
        senderName: message.senderName || "",
        senderType: message.senderType,
        body: message.body || "",
        attachments: message.attachments || [],
        replyTo: message.replyTo || null,
        editedAt: message.editedAt || null,
        deletedAt: message.deletedAt || null,
        seenBy: message.seenBy || [],
        createdAt: new Date((message as unknown as { createdAt: Date }).createdAt),
        updatedAt: new Date((message as unknown as { updatedAt: Date }).updatedAt),
      }), message]));
      const missingMessages: DirectMessageSnapshot[] = [];

      for (const message of snapshot.messages) {
        const existing = existingByKey.get(messageKey(message));
        if (!existing) {
          missingMessages.push(message);
          continue;
        }
        const seenBy = Array.from(new Set([...(existing.seenBy || []), ...message.seenBy]));
        const existingUpdatedAt = new Date((existing as unknown as { updatedAt: Date }).updatedAt);
        const contentChanged = message.updatedAt > existingUpdatedAt;
        const seenChanged = seenBy.length !== (existing.seenBy || []).length;
        if (!contentChanged && !seenChanged) continue;
        if (contentChanged) {
          existing.body = message.body;
          existing.attachments = message.attachments;
          existing.replyTo = message.replyTo;
          existing.editedAt = message.editedAt;
          existing.deletedAt = message.deletedAt;
          existing.set("updatedAt", message.updatedAt);
        }
        existing.seenBy = seenBy;
        await existing.save();
      }

      if (missingMessages.length) {
        await Message.collection.insertMany(missingMessages.map((message) => ({
          conversation: conversation!._id,
          sender: message.senderCode ? employeeByCode.get(message.senderCode)?._id || null : null,
          senderName: message.senderName,
          senderType: message.senderType,
          body: message.body,
          attachments: message.attachments,
          replyTo: message.replyTo,
          editedAt: message.editedAt,
          deletedAt: message.deletedAt,
          seenBy: message.seenBy,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
          __v: 0,
        })));
      }

      const latest = [...snapshot.messages].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
      const latestPreview = latest ? messagePreview(latest) : "";
      if (latest && (!conversation.lastMessageAt || latest.createdAt.getTime() !== conversation.lastMessageAt.getTime() || conversation.lastMessage !== latestPreview)) {
        conversation.lastMessage = latestPreview;
        conversation.lastMessageAt = latest.createdAt;
        await conversation.save();
      }
    }
  });
}

export async function syncDirectMessagesToBusiness(targetBusinessId: string) {
  const existing = activeSyncs.get(targetBusinessId);
  if (existing) return existing;
  const sync = performSync(targetBusinessId).finally(() => activeSyncs.delete(targetBusinessId));
  activeSyncs.set(targetBusinessId, sync);
  return sync;
}

export async function emitMirroredDirectMessage(input: {
  sourceBusinessId: string;
  includeAdmin: boolean;
  participantCodes: string[];
  createdAt: Date;
  senderName: string;
  senderType: "admin" | "employee";
  body: string;
}) {
  const keyCodes = [...input.participantCodes].filter(Boolean).sort();
  for (const business of getConfiguredBusinesses()) {
    if (business.id === input.sourceBusinessId) continue;
    await runWithBusiness(business.id, async () => {
      const employees = await Employee.find({ employeeCode: { $in: keyCodes }, status: { $ne: "Archived" } })
        .select("_id employeeCode").lean();
      if (employees.length !== keyCodes.length) return;
      const participantIds = employees.map((employee) => employee._id);
      const conversation = await Conversation.findOne({
        type: "direct",
        includeAdmin: input.includeAdmin,
        participants: { $all: participantIds, $size: participantIds.length },
      }).populate([
        { path: "participants", select: "name role team email status employeeCode" },
        { path: "team", select: "name status" },
      ]);
      if (!conversation) return;
      const message = await Message.findOne({
        conversation: conversation._id,
        createdAt: input.createdAt,
        senderName: input.senderName,
        senderType: input.senderType,
        body: input.body,
      }).populate({ path: "sender", select: "name role team email status employeeCode" });
      if (message) emitMessageEvents(String(conversation._id), message, conversation);
    });
  }
}
