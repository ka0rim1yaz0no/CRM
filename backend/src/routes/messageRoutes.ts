import { Router } from "express";
import {
  createDirectConversation,
  createMessage,
  createTeamConversation,
  deleteMessage,
  listConversations,
  listMessages,
  listUnreadMessageNotifications,
  markMessageNotificationSeen,
  markMessagesSeen,
  serveMessageAttachment,
  uploadMessageAttachment,
  updateMessage,
} from "../controllers/messageController";

export const messageRouter = Router();

messageRouter.get("/conversations", listConversations);
messageRouter.get("/notifications/unread", listUnreadMessageNotifications);
messageRouter.post("/notifications/:messageId/seen", markMessageNotificationSeen);
messageRouter.post("/conversations/direct", createDirectConversation);
messageRouter.post("/conversations/team", createTeamConversation);
messageRouter.get("/conversations/:conversationId/messages", listMessages);
messageRouter.post("/conversations/:conversationId/messages", createMessage);
messageRouter.post("/conversations/:conversationId/seen", markMessagesSeen);
messageRouter.patch("/conversations/:conversationId/messages/:messageId", updateMessage);
messageRouter.delete("/conversations/:conversationId/messages/:messageId", deleteMessage);
messageRouter.post("/conversations/:conversationId/attachments", uploadMessageAttachment);
messageRouter.get("/attachments/:fileName", serveMessageAttachment);
