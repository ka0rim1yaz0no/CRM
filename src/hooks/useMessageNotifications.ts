import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthUser } from "../api/authStorage";
import { getConversations, getUnreadMessageNotifications, markMessageNotificationSeen, markMessagesSeen, type Conversation, type Message } from "../api/messages";
import { connectAuthenticatedSocket, socket } from "../lib/socket";

type MessageNotificationPayload = {
    message: Message;
    conversation: Conversation | null;
};

const MESSAGE_NOTIFICATIONS_CHANGED_EVENT = "crm:message-notifications-changed";
const soundedMessageIds = new Set<string>();
let messageAudioContext: AudioContext | null = null;

function getMessageAudioContext() {
    messageAudioContext ??= new AudioContext();
    return messageAudioContext;
}

function claimMessageSound(messageId: string) {
    const key = `crm:message-sound:${messageId}`;
    const now = Date.now();
    const claimedAt = Number(localStorage.getItem(key) || 0);
    if (now - claimedAt < 15_000) return false;
    localStorage.setItem(key, String(now));
    return true;
}

function playIncomingMessageSound(messageId: string) {
    if (soundedMessageIds.has(messageId)) return;
    try {
        const context = getMessageAudioContext();
        const playTone = (
            frequency: number,
            start: number,
            duration = 0.24,
            peakVolume = 0.16,
            type: OscillatorType = "sine",
        ) => {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = type;
            oscillator.frequency.setValueAtTime(frequency, start);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(peakVolume, start + 0.025);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
            oscillator.connect(gain).connect(context.destination);
            oscillator.start(start);
            oscillator.stop(start + duration + 0.02);
        };
        const play = () => {
            if (!claimMessageSound(messageId)) return;
            soundedMessageIds.add(messageId);
            if (soundedMessageIds.size > 200) soundedMessageIds.delete(soundedMessageIds.values().next().value || "");
            const start = context.currentTime + 0.02;
            playTone(784, start, 0.22, 0.15, "triangle");
            playTone(1046.5, start + 0.14, 0.24, 0.17, "triangle");
            playTone(1318.5, start + 0.29, 0.27, 0.18, "triangle");
            playTone(1046.5, start + 0.5, 0.38, 0.16, "triangle");
            playTone(523.25, start + 0.5, 0.4, 0.08, "sine");
        };
        if (context.state === "running") play();
        else void context.resume().then(play).catch(() => undefined);
    } catch {
        // Browsers may block sound until the user has interacted with the CRM tab.
    }
}

export type MessageNotification = {
    id: string;
    conversationId: string;
    title: string;
    body: string;
    senderName: string;
    createdAt: string;
    href: string;
    isRead: boolean;
    conversationKey?: string;
};

function conversationIdentity(conversation: Conversation | null) {
    if (!conversation) return "";
    if (conversation.type === "team") return `team:${conversation.team?._id || conversation._id}`;
    return `${conversation.includeAdmin ? "admin" : "direct"}:${conversation.participants.map((participant) => participant.employeeCode).filter(Boolean).sort().join("|")}`;
}

function getConversationTitle(conversation: Conversation | null, currentUserId: string) {
    if (!conversation) return "New message";
    if (conversation.type === "team") return conversation.team?.name || conversation.title || "Team chat";
    if (conversation.includeAdmin) return currentUserId === "admin" ? conversation.participants[0]?.name || "Employee" : "Admin";
    return conversation.participants.find((participant) => participant._id !== currentUserId)?.name || conversation.title || "Direct message";
}

function isRelevantConversation(conversation: Conversation | null, currentUserId: string, isAdmin: boolean) {
    if (!conversation) return false;
    if (isAdmin) return Boolean(conversation.includeAdmin) || conversation.type === "team";
    return conversation.participants.some((participant) => participant._id === currentUserId);
}

function isOwnMessage(message: Message, currentUserId: string, isAdmin: boolean) {
    if (isAdmin) return message.senderType === "admin";
    return message.sender?._id === currentUserId;
}

function readStoredNotifications(storageKey: string) {
    try {
        return JSON.parse(localStorage.getItem(storageKey) || "[]") as MessageNotification[];
    } catch {
        localStorage.removeItem(storageKey);
        return [];
    }
}

function notificationsMatch(left: MessageNotification[], right: MessageNotification[]) {
    return left.length === right.length && left.every((item, index) => {
        const other = right[index];
        return item.id === other.id && item.conversationId === other.conversationId && item.title === other.title &&
            item.body === other.body && item.senderName === other.senderName && item.createdAt === other.createdAt &&
            item.isRead === other.isRead && item.conversationKey === other.conversationKey;
    });
}

function messageHref(isAdmin: boolean, conversationId: string) {
    const basePath = isAdmin ? "/admin/messages" : "/messages";
    return conversationId ? `${basePath}?conversation=${encodeURIComponent(conversationId)}` : basePath;
}

export function useMessageNotifications() {
    const authUser = getAuthUser();
    const isAdmin = authUser?.userType === "admin";
    const currentUserId = authUser?.userType === "employee" ? authUser.user._id : isAdmin ? "admin" : "";
    const storageKey = `messageNotifications:${isAdmin ? "admin" : authUser?.user.employeeCode || "guest"}`;
    const legacyStorageKey = `messageNotifications:${currentUserId || "guest"}`;
    const [instanceId] = useState(() => crypto.randomUUID());
    const queryClient = useQueryClient();
    const [localNotifications, setNotifications] = useState<MessageNotification[]>(() => {
        const stored = readStoredNotifications(storageKey);
        return stored.length ? stored : readStoredNotifications(legacyStorageKey);
    });
    const { data: conversations = [] } = useQuery({
        queryKey: ["conversations"],
        queryFn: getConversations,
        enabled: Boolean(currentUserId),
        staleTime: 30_000,
    });
    const { data: serverNotifications = [], isSuccess: serverNotificationsLoaded } = useQuery({
        queryKey: ["message-notifications", storageKey],
        queryFn: getUnreadMessageNotifications,
        enabled: Boolean(currentUserId),
        staleTime: 10_000,
        refetchInterval: 30_000,
        refetchOnWindowFocus: true,
    });

    const toNotification = useCallback((message: Message, conversation: Conversation | null): MessageNotification => ({
        id: message._id,
        conversationId: typeof message.conversation === "string" ? message.conversation : "",
        title: getConversationTitle(conversation, currentUserId),
        body: message.body,
        senderName: message.sender?.name || message.senderName || (message.senderType === "admin" ? "Admin" : "Employee"),
        createdAt: message.createdAt,
        href: messageHref(Boolean(isAdmin), typeof message.conversation === "string" ? message.conversation : ""),
        isRead: false,
        conversationKey: conversationIdentity(conversation),
    }), [currentUserId, isAdmin]);

    useEffect(() => {
        const unlockAudio = () => {
            try {
                const context = getMessageAudioContext();
                if (context.state !== "running") void context.resume().catch(() => undefined);
            } catch {
                // Audio support is optional; unread badges continue to work.
            }
        };
        window.addEventListener("pointerdown", unlockAudio, { once: true });
        window.addEventListener("keydown", unlockAudio, { once: true });
        return () => {
            window.removeEventListener("pointerdown", unlockAudio);
            window.removeEventListener("keydown", unlockAudio);
        };
    }, []);

    const notifications = useMemo(() => {
        if (!serverNotificationsLoaded) return localNotifications;
        const serverItems = serverNotifications.map((payload) => toNotification(payload.message, payload.conversation));
        const serverIds = new Set(serverItems.map((item) => item.id));
        const serverIdentities = new Set(serverItems.map((item) => `${item.conversationKey}|${item.createdAt}|${item.senderName}`));
        const next = localNotifications.map((item) => ({
            ...item,
            isRead: item.isRead || (!serverIds.has(item.id) && !serverIdentities.has(`${item.conversationKey}|${item.createdAt}|${item.senderName}`)),
        }));
        for (const notification of serverItems) {
            const existingIndex = next.findIndex((item) => item.id === notification.id || (
                item.conversationKey === notification.conversationKey &&
                item.createdAt === notification.createdAt &&
                item.senderName === notification.senderName
            ));
            if (existingIndex >= 0) next[existingIndex] = { ...notification, isRead: next[existingIndex].isRead };
            else next.push(notification);
        }
        const sorted = next.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 30);
        return notificationsMatch(localNotifications, sorted) ? localNotifications : sorted;
    }, [localNotifications, serverNotifications, serverNotificationsLoaded, toNotification]);

    useEffect(() => {
        const syncNotifications = (event: Event) => {
            const detail = (event as CustomEvent<{ storageKey: string; notifications: MessageNotification[]; sourceId: string }>).detail;
            if (detail?.storageKey === storageKey && detail.sourceId !== instanceId) setNotifications(detail.notifications);
        };
        window.addEventListener(MESSAGE_NOTIFICATIONS_CHANGED_EVENT, syncNotifications);
        return () => window.removeEventListener(MESSAGE_NOTIFICATIONS_CHANGED_EVENT, syncNotifications);
    }, [instanceId, storageKey]);

    useEffect(() => {
        localStorage.setItem(storageKey, JSON.stringify(notifications.slice(0, 30)));
    }, [notifications, storageKey]);

    useEffect(() => {
        if (!currentUserId) return;

        connectAuthenticatedSocket();

        const handleMessageNotification = ({ message, conversation }: MessageNotificationPayload) => {
            void queryClient.invalidateQueries({ queryKey: ["conversations"] });

            const resolvedConversation = conversation || conversations.find((item) => item._id === message.conversation) || null;
            if (isOwnMessage(message, currentUserId, Boolean(isAdmin)) || !isRelevantConversation(resolvedConversation, currentUserId, Boolean(isAdmin))) {
                return;
            }

            playIncomingMessageSound(message._id);

            if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
                new Notification(getConversationTitle(resolvedConversation, currentUserId), {
                    body: message.body || "New attachment",
                    tag: `crm-message-${message._id}`,
                });
            }

            const notification = toNotification(message, resolvedConversation);

            setNotifications((current) => [
                notification,
                ...current.filter((item) =>
                    item.id !== notification.id && !(
                        item.conversationKey === notification.conversationKey &&
                        item.createdAt === notification.createdAt &&
                        item.senderName === notification.senderName &&
                        item.body === notification.body
                    )
                ),
            ].slice(0, 30));
        };

        socket.on("message:notification", handleMessageNotification);

        return () => {
            socket.off("message:notification", handleMessageNotification);
        };
    }, [conversations, currentUserId, isAdmin, queryClient, toNotification]);

    const unreadCount = useMemo(() => notifications.filter((notification) => !notification.isRead).length, [notifications]);

    const updateNotifications = useCallback((updater: (current: MessageNotification[]) => MessageNotification[]) => {
        setNotifications((current) => {
            const next = updater(current);
            if (next === current) return current;
            window.dispatchEvent(new CustomEvent(MESSAGE_NOTIFICATIONS_CHANGED_EVENT, { detail: { storageKey, notifications: next, sourceId: instanceId } }));
            return next;
        });
    }, [instanceId, storageKey]);

    const removeCachedUnread = useCallback((matches: (payload: MessageNotificationPayload) => boolean) => {
        queryClient.setQueriesData<MessageNotificationPayload[]>({ queryKey: ["message-notifications"] }, (current) =>
            current ? current.filter((payload) => !matches(payload)) : current
        );
    }, [queryClient]);

    const markRead = (id: string) => {
        updateNotifications((current) => current.map((notification) => (notification.id === id ? { ...notification, isRead: true } : notification)));
        removeCachedUnread((payload) => payload.message._id === id);
        void markMessageNotificationSeen(id).then(() => queryClient.invalidateQueries({ queryKey: ["message-notifications"] }));
    };

    const markAllRead = () => {
        updateNotifications((current) => current.map((notification) => ({ ...notification, isRead: true })));
        removeCachedUnread(() => true);
        const conversationIds = Array.from(new Set(notifications.filter((notification) => !notification.isRead).map((notification) => notification.conversationId).filter(Boolean)));
        void Promise.allSettled(conversationIds.map(markMessagesSeen)).then(() => queryClient.invalidateQueries({ queryKey: ["message-notifications"] }));
    };

    const dismissMessageNotification = (id: string) => {
        updateNotifications((current) => current.filter((notification) => notification.id !== id));
        removeCachedUnread((payload) => payload.message._id === id);
        void markMessageNotificationSeen(id).then(() => queryClient.invalidateQueries({ queryKey: ["message-notifications"] }));
    };

    const markConversationMessagesRead = useCallback((conversationId: string) => {
        const selectedKey = conversationIdentity(conversations.find((conversation) => conversation._id === conversationId) || null);
        updateNotifications((current) => {
            if (!current.some((notification) => (notification.conversationId === conversationId || (selectedKey && notification.conversationKey === selectedKey)) && !notification.isRead)) return current;
            return current.map((notification) =>
                notification.conversationId === conversationId || (selectedKey && notification.conversationKey === selectedKey) ? { ...notification, isRead: true } : notification
            );
        });
        removeCachedUnread((payload) => {
            const payloadConversationId = payload.message.conversation;
            const payloadKey = conversationIdentity(payload.conversation);
            return payloadConversationId === conversationId || Boolean(selectedKey && payloadKey === selectedKey);
        });
    }, [conversations, removeCachedUnread, updateNotifications]);

    const messageNotifications = useMemo(
        () =>
            notifications.map((notification) => {
                const currentConversation = notification.conversationKey
                    ? conversations.find((conversation) => conversationIdentity(conversation) === notification.conversationKey)
                    : undefined;
                const conversationId = currentConversation?._id || notification.conversationId;
                return { ...notification, conversationId, href: messageHref(Boolean(isAdmin), conversationId) };
            }),
        [conversations, isAdmin, notifications]
    );

    return {
        messageNotifications,
        unreadMessageCount: unreadCount,
        markMessageRead: markRead,
        markAllMessagesRead: markAllRead,
        dismissMessageNotification,
        markConversationMessagesRead,
    };
}
