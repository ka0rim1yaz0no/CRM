import { Schema, Types } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type MessageDocument = {
  conversation: Types.ObjectId;
  sender: Types.ObjectId | null;
  senderName: string;
  senderType: "admin" | "employee";
  body: string;
  attachments: MessageAttachment[];
  replyTo: MessageReply | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  seenBy: string[];
};

export type MessageReply = {
  messageId: Types.ObjectId;
  senderName: string;
  body: string;
  attachmentLabel: string;
};

export type MessageAttachment = {
  name: string;
  url: string;
  mimeType: string;
  size: number;
  kind: "image" | "video" | "audio" | "file";
};

const messageAttachmentSchema = new Schema<MessageAttachment>(
  {
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 0 },
    kind: { type: String, enum: ["image", "video", "audio", "file"], required: true },
  },
  { _id: false }
);

const messageReplySchema = new Schema<MessageReply>(
  {
    messageId: { type: Schema.Types.ObjectId, required: true },
    senderName: { type: String, trim: true, required: true },
    body: { type: String, trim: true, default: "", maxlength: 500 },
    attachmentLabel: { type: String, trim: true, default: "", maxlength: 120 },
  },
  { _id: false }
);

const messageSchema = new Schema<MessageDocument>(
  {
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    sender: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
    senderName: { type: String, trim: true, default: "" },
    senderType: { type: String, enum: ["admin", "employee"], default: "employee" },
    body: { type: String, trim: true, default: "", maxlength: 10_000 },
    attachments: { type: [messageAttachmentSchema], default: [] },
    replyTo: { type: messageReplySchema, default: null },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    seenBy: { type: [String], default: [] },
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ conversation: 1, seenBy: 1, createdAt: -1 });

export const Message = tenantModel<MessageDocument>("Message", messageSchema);
