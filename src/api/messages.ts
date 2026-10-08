import { api } from "../lib/api";
import type { Employee } from "./employees";
import type { Team } from "./teams";

export type Conversation = {
    _id: string;
    type: "direct" | "team";
    title: string;
    participants: Employee[];
    includeAdmin?: boolean;
    team: Pick<Team, "_id" | "name" | "status"> | null;
    lastMessage: string;
    lastMessageAt: string | null;
};

export type Message = {
    _id: string;
    conversation: string;
    sender: Employee | null;
    senderName?: string;
    senderType?: "admin" | "employee";
    body: string;
    attachments?: MessageAttachment[];
    replyTo?: {
        messageId: string;
        senderName: string;
        body: string;
        attachmentLabel: string;
    } | null;
    editedAt?: string | null;
    deletedAt?: string | null;
    seenBy?: string[];
    createdAt: string;
};

export type MessageAttachment = {
    name: string;
    url: string;
    mimeType: string;
    size: number;
    kind: "image" | "video" | "audio" | "file";
};

export type MessageInput = {
    senderId?: string | null;
    senderName: string;
    senderType: "admin" | "employee";
    body: string;
    attachments?: MessageAttachment[];
    replyTo?: string | null;
};

export async function getConversations() {
    const response = await api.get<Conversation[]>("/messages/conversations");
    return response.data;
}

export async function getUnreadMessageNotifications() {
    const response = await api.get<Array<{ message: Message; conversation: Conversation }>>("/messages/notifications/unread");
    return response.data;
}

export async function markMessageNotificationSeen(messageId: string) {
    const response = await api.post<{ messageId: string; readerKey: string }>(`/messages/notifications/${messageId}/seen`);
    return response.data;
}

export async function createDirectConversation(participants: string[], includeAdmin = false) {
    const response = await api.post<Conversation>("/messages/conversations/direct", { participants, includeAdmin });
    return response.data;
}

export async function createTeamConversation(team: string) {
    const response = await api.post<Conversation>("/messages/conversations/team", { team });
    return response.data;
}

export async function getMessages(conversationId: string) {
    const response = await api.get<Message[]>(`/messages/conversations/${conversationId}/messages`);
    return response.data;
}

export async function sendMessage(conversationId: string, message: MessageInput) {
    const response = await api.post<Message>(`/messages/conversations/${conversationId}/messages`, message);
    return response.data;
}

export async function editMessage(conversationId: string, messageId: string, body: string) {
    const response = await api.patch<Message>(`/messages/conversations/${conversationId}/messages/${messageId}`, { body });
    return response.data;
}

export async function deleteMessage(conversationId: string, messageId: string) {
    const response = await api.delete<Message>(`/messages/conversations/${conversationId}/messages/${messageId}`);
    return response.data;
}

export async function markMessagesSeen(conversationId: string) {
    const response = await api.post<{ conversationId: string; messageIds: string[]; readerKey: string }>(`/messages/conversations/${conversationId}/seen`);
    return response.data;
}

export async function uploadMessageAttachment(conversationId: string, file: File) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Unable to read attachment."));
        reader.readAsDataURL(file);
    });
    const response = await api.post<MessageAttachment>(`/messages/conversations/${conversationId}/attachments`, {
        dataUrl,
        fileName: file.name,
    });
    return response.data;
}

export async function getMessageAttachmentBlob(url: string) {
    const response = await api.get<Blob>(url.replace(/^\/api/, ""), { responseType: "blob" });
    return response.data;
}
