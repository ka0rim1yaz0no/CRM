import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthUser } from "../api/authStorage";
import { getConversations, getUnreadMessageNotifications, markMessageNotificationSeen, markMessagesSeen, type Conversation, type Message } from "../api/messages";
import { connectAuthenticatedSocket, socket } from "../lib/socket";
import { messageSound } from "../lib/messageSound";

type MessageNotificationPayload = {
    message: Message;
    conversation: Conversation | null;
};

const MESSAGE_NOTIFICATIONS_CHANGED_EVENT = "crm:message-notifications-changed";

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

function soundIdentity(message: Message, conversation: Conversation | null) {
    return `${conversationIdentity(conversation)}:${message.createdAt}:${message.senderType}:${message.sender?.employeeCode || message.senderName || ""}`;
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
    const knownSounds = useRef({ identity: storageKey, initialized: false, keys: new Set<string>() });
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
            void messageSound.unlock();
        };
        window.addEventListener("pointerdown", unlockAudio);
        window.addEventListener("keydown", unlockAudio);
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
        try { localStorage.setItem(storageKey, JSON.stringify(notifications.slice(0, 30))); } catch { /* Server unread state remains authoritative when storage is unavailable. */ }
    }, [notifications, storageKey]);

    useEffect(() => {
        if (!serverNotificationsLoaded) return;
        if (knownSounds.current.identity !== storageKey) knownSounds.current = { identity: storageKey, initialized: false, keys: new Set() };
        const known = knownSounds.current;
        for (const { message, conversation } of serverNotifications) {
            const key = soundIdentity(message, conversation);
            if (known.initialized && !known.keys.has(key) && !message.deletedAt &&
                !isOwnMessage(message, currentUserId, Boolean(isAdmin)) && isRelevantConversation(conversation, currentUserId, Boolean(isAdmin))) {
                void messageSound.incoming(key);
            }
            known.keys.add(key);
        }
        known.initialized = true;
        while (known.keys.size > 200) known.keys.delete(known.keys.values().next().value!);
    }, [serverNotifications, serverNotificationsLoaded, storageKey, currentUserId, isAdmin]);

    useEffect(() => {
        if (!currentUserId) return;

        connectAuthenticatedSocket();

        const handleMessageNotification = ({ message, conversation }: MessageNotificationPayload) => {
            void queryClient.invalidateQueries({ queryKey: ["conversations"] });

            const resolvedConversation = conversation || conversations.find((item) => item._id === message.conversation) || null;
            if (isOwnMessage(message, currentUserId, Boolean(isAdmin)) || !isRelevantConversation(resolvedConversation, currentUserId, Boolean(isAdmin))) {
                return;
            }

            if (!message.deletedAt) void messageSound.incoming(soundIdentity(message, resolvedConversation));

            if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
                try { new Notification(getConversationTitle(resolvedConversation, currentUserId), {
                    body: message.body || "New attachment",
                    tag: `crm-message-${message._id}`,
                }); } catch { /* A browser notification failure must not discard unread messages. */ }
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
        const refreshUnread = () => { void queryClient.invalidateQueries({ queryKey: ["message-notifications"] }); };
        socket.on("connect", refreshUnread);

        return () => {
            socket.off("message:notification", handleMessageNotification);
            socket.off("connect", refreshUnread);
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
