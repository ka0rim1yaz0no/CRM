import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router";
import { FiCheck, FiChevronLeft, FiChevronRight, FiCornerUpLeft, FiDownload, FiEdit2, FiFile, FiHash, FiMessageCircle, FiPaperclip, FiPhone, FiPlus, FiSearch, FiSend, FiTrash2, FiUsers, FiX } from "react-icons/fi";
import MainLayout from "../layout";
import AdminLayout from "../admin/adminLayout";
import {
    createDirectConversation,
    createTeamConversation,
    deleteMessage,
    editMessage,
    getConversations,
    getMessages,
    getMessageAttachmentBlob,
    markMessagesSeen,
    sendMessage,
    uploadMessageAttachment,
    type Conversation,
    type Message,
    type MessageAttachment,
} from "../../api/messages";
import { getEmployees } from "../../api/employees";
import { createTeam as createEmployeeTeam, getTeams, updateTeam as updateEmployeeTeam, type Team, type TeamInput } from "../../api/teams";
import { getAuthUser } from "../../api/authStorage";
import { connectAuthenticatedSocket, socket } from "../../lib/socket";
import { formatPhDate, formatPhDateTime, formatPhTime } from "../../lib/dateTime";
import { useMessageNotifications } from "../../hooks/useMessageNotifications";
import { startEmployeeVoiceCall } from "../../lib/voiceCall";

const ADMIN_USER = {
    _id: "admin",
    name: "Admin",
    email: "admin@assistly.com",
    role: "Admin",
    team: "Admin",
};

function appendMessageIfNew(current: Message[] = [], message: Message) {
    if (current.some((item) => item._id === message._id)) {
        return current;
    }

    return [...current, message];
}

function replaceMessage(current: Message[] = [], message: Message) {
    return current.map((item) => item._id === message._id ? message : item);
}

function getInitials(value: string) {
    const words = value.trim().split(/\s+/).filter(Boolean);

    if (words.length === 0) {
        return "?";
    }

    return words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join("");
}

const acceptedMessageFileTypes = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/ogg,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,application/pdf,text/plain,text/csv,.doc,.docx,.xls,.xlsx";
const maxMessageAttachmentBytes = 50 * 1024 * 1024;
const maxMessageAttachments = 6;

type DraftConversation = {
    type: "direct" | "team";
    targetId: string;
    title: string;
    subtitle: string;
    includeAdmin?: boolean;
};

type TeamEditorState = {
    team: Team | null;
    name: string;
    members: string[];
};

function formatFileSize(size: number) {
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function MessageAttachmentView({ attachment, isMine }: { attachment: MessageAttachment; isMine: boolean }) {
    const { data: blob } = useQuery({
        queryKey: ["message-attachment", attachment.url],
        queryFn: () => getMessageAttachmentBlob(attachment.url),
        staleTime: Number.POSITIVE_INFINITY,
    });
    const [objectUrl, setObjectUrl] = useState("");

    useEffect(() => {
        if (!blob) return;
        const nextUrl = URL.createObjectURL(blob);
        setObjectUrl(nextUrl);
        return () => URL.revokeObjectURL(nextUrl);
    }, [blob]);

    if (attachment.kind === "image") {
        return objectUrl ? (
            <a href={objectUrl} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl">
                <img className="max-h-80 w-full object-contain" src={objectUrl} alt={attachment.name} />
            </a>
        ) : <div className="h-32 w-52 animate-pulse rounded-xl bg-slate-200/70" />;
    }
    if (attachment.kind === "video") {
        return objectUrl ? <video className="max-h-80 w-full rounded-xl bg-black" src={objectUrl} controls preload="metadata" /> : <div className="h-36 w-60 animate-pulse rounded-xl bg-slate-200/70" />;
    }
    if (attachment.kind === "audio") {
        return objectUrl ? <audio className="max-w-full" src={objectUrl} controls preload="metadata" /> : <div className="h-12 w-60 animate-pulse rounded-xl bg-slate-200/70" />;
    }
    return (
        <a
            className={["flex min-w-52 items-center gap-3 rounded-xl border p-3", isMine ? "border-white/25 bg-white/10 text-white" : "border-slate-200 bg-slate-50 text-slate-800"].join(" ")}
            href={objectUrl || undefined}
            download={attachment.name}
        >
            <FiFile className="size-5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{attachment.name}</span>
                <span className="mt-0.5 block text-[0.68rem] opacity-65">{formatFileSize(attachment.size)}</span>
            </span>
            <FiDownload className="size-4 shrink-0" aria-hidden="true" />
        </a>
    );
}

export default function Messages() {
    const queryClient = useQueryClient();
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const authUser = getAuthUser();
    const isAdminRoute = location.pathname.startsWith("/admin");
    const { messageNotifications, markConversationMessagesRead } = useMessageNotifications();
    const { data: conversations = [] } = useQuery({
        queryKey: ["conversations"],
        queryFn: getConversations,
    });
    const { data: employees = [] } = useQuery({
        queryKey: ["employees"],
        queryFn: getEmployees,
    });
    const { data: teams = [] } = useQuery({
        queryKey: ["teams"],
        queryFn: getTeams,
    });
    const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
    const [draftConversation, setDraftConversation] = useState<DraftConversation | null>(null);
    const [messageText, setMessageText] = useState("");
    const [messageFiles, setMessageFiles] = useState<File[]>([]);
    const [editingMessage, setEditingMessage] = useState<Message | null>(null);
    const [replyingTo, setReplyingTo] = useState<Message | null>(null);
    const [attachmentError, setAttachmentError] = useState("");
    const [messageActionError, setMessageActionError] = useState("");
    const [search, setSearch] = useState("");
    const [directorySearch, setDirectorySearch] = useState("");
    const [mode, setMode] = useState<"direct" | "team">("direct");
    const [pendingDirectTarget, setPendingDirectTarget] = useState(searchParams.get("to") || searchParams.get("call") || "");
    const [pendingCallTarget, setPendingCallTarget] = useState(searchParams.get("call") || "");
    const [pendingTeamTarget, setPendingTeamTarget] = useState(searchParams.get("team") || "");
    const [isDirectoryOpen, setIsDirectoryOpen] = useState(false);
    const [teamEditor, setTeamEditor] = useState<TeamEditorState | null>(null);
    const [teamMemberSearch, setTeamMemberSearch] = useState("");
    const [teamEditorError, setTeamEditorError] = useState("");
    const messagesScrollRef = useRef<HTMLDivElement>(null);
    const shouldFollowMessagesRef = useRef(true);
    const directorySearchRef = useRef<HTMLInputElement>(null);
    const attachmentInputRef = useRef<HTMLInputElement>(null);
    const lastSeenRequestRef = useRef("");

    const currentUser = authUser?.userType === "employee" ? authUser.user : ADMIN_USER;
    const currentReaderKey = `${isAdminRoute ? "admin" : "employee"}:${authUser?.user.employeeCode || ""}`;
    const accessibleTeams = useMemo(
        () => teams.filter((team) => {
            if (isAdminRoute) return true;
            return team.lead?._id === currentUser._id || team.members.some((member) => member._id === currentUser._id);
        }),
        [currentUser._id, isAdminRoute, teams]
    );
    const visibleConversations = useMemo(
        () =>
            conversations.filter((conversation) =>
                Boolean(conversation.lastMessageAt) &&
                (isAdminRoute
                    ? Boolean(conversation.includeAdmin) || conversation.type === "team"
                    : conversation.participants.some((participant) => participant._id === currentUser._id))
            ),
        [conversations, currentUser._id, isAdminRoute]
    );
    const selectedConversation = draftConversation
        ? null
        : visibleConversations.find((conversation) => conversation._id === selectedConversationId) || visibleConversations[0] || null;
    const { data: messages = [] } = useQuery({
        queryKey: ["messages", selectedConversation?._id],
        queryFn: () => getMessages(selectedConversation?._id || ""),
        enabled: Boolean(selectedConversation?._id),
    });

    const createDirectMutation = useMutation({
        mutationFn: ({ participants, includeAdmin }: { participants: string[]; includeAdmin?: boolean }) => createDirectConversation(participants, includeAdmin),
        onSuccess: (conversation) => {
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
            setSelectedConversationId(conversation._id);
            setPendingDirectTarget("");
            setPendingCallTarget("");
            setSearchParams({}, { replace: true });
        },
    });

    const createTeamMutation = useMutation({
        mutationFn: createTeamConversation,
        onSuccess: (conversation) => {
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
            setSelectedConversationId(conversation._id);
            setPendingTeamTarget("");
            setSearchParams({}, { replace: true });
        },
    });
    const saveEmployeeTeamMutation = useMutation({
        mutationFn: ({ id, input }: { id?: string; input: TeamInput }) =>
            id ? updateEmployeeTeam(id, input) : createEmployeeTeam(input),
        onSuccess: async (team) => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["teams"] }),
                queryClient.invalidateQueries({ queryKey: ["conversations"] }),
                queryClient.invalidateQueries({ queryKey: ["employees"] }),
            ]);
            setTeamEditor(null);
            setTeamMemberSearch("");
            setTeamEditorError("");
            setMode("team");
            setDirectorySearch("");
            setIsDirectoryOpen(true);
            setPendingTeamTarget(team._id);
        },
        onError: (error: { response?: { data?: { message?: string } } }) => {
            setTeamEditorError(error.response?.data?.message || "Unable to save the team.");
        },
    });
    const sendMessageMutation = useMutation({
        mutationFn: async ({ conversationId, draft, body, files }: { conversationId?: string; draft?: DraftConversation | null; body: string; files: File[] }) => {
            let targetConversationId = conversationId;
            if (!targetConversationId && draft) {
                const conversation = draft.type === "team"
                    ? await createTeamConversation(draft.targetId)
                    : await createDirectConversation(
                        draft.includeAdmin ? [draft.targetId] : [currentUser._id, draft.targetId],
                        Boolean(draft.includeAdmin)
                    );
                targetConversationId = conversation._id;
            }
            if (!targetConversationId) throw new Error("Select a conversation before sending.");
            const attachments = await Promise.all(files.map((file) => uploadMessageAttachment(targetConversationId, file)));
            const message = await sendMessage(targetConversationId, {
                senderId: isAdminRoute ? null : currentUser._id,
                senderName: currentUser.name,
                senderType: isAdminRoute ? "admin" : "employee",
                body,
                attachments,
                replyTo: replyingTo?._id || null,
            });
            return { message, conversationId: targetConversationId };
        },
        onSuccess: ({ message, conversationId }) => {
            queryClient.setQueryData<Message[]>(["messages", message.conversation], (current = []) => appendMessageIfNew(current, message));
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
            setSelectedConversationId(conversationId);
            setDraftConversation(null);
            setMessageText("");
            setMessageFiles([]);
            setReplyingTo(null);
            setAttachmentError("");
            if (attachmentInputRef.current) attachmentInputRef.current.value = "";
        },
    });
    const editMessageMutation = useMutation({
        mutationFn: ({ conversationId, messageId, body }: { conversationId: string; messageId: string; body: string }) => editMessage(conversationId, messageId, body),
        onSuccess: (message) => {
            queryClient.setQueryData<Message[]>(["messages", message.conversation], (current = []) => replaceMessage(current, message));
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
            setEditingMessage(null);
            setMessageText("");
            setMessageActionError("");
        },
        onError: (error: { response?: { data?: { message?: string } } }) => setMessageActionError(error.response?.data?.message || "Unable to edit the message."),
    });
    const deleteMessageMutation = useMutation({
        mutationFn: ({ conversationId, messageId }: { conversationId: string; messageId: string }) => deleteMessage(conversationId, messageId),
        onSuccess: (message) => {
            queryClient.setQueryData<Message[]>(["messages", message.conversation], (current = []) => replaceMessage(current, message));
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
            if (editingMessage?._id === message._id) {
                setEditingMessage(null);
                setMessageText("");
            }
            if (replyingTo?._id === message._id) setReplyingTo(message);
            setMessageActionError("");
        },
        onError: (error: { response?: { data?: { message?: string } } }) => setMessageActionError(error.response?.data?.message || "Unable to delete the message."),
    });

    useEffect(() => {
        connectAuthenticatedSocket();

        const handleNewMessage = (message: Message) => {
            queryClient.setQueryData<Message[]>(["messages", message.conversation], (current = []) => appendMessageIfNew(current, message));
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
        };

        const handleConversationUpdated = (payload?: { conversationId?: string }) => {
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
            if (!payload?.conversationId) queryClient.invalidateQueries({ queryKey: ["messages"] });
        };

        const handleMessageNotification = ({ message }: { message: Message }) => {
            queryClient.setQueryData<Message[]>(["messages", message.conversation], (current = []) => appendMessageIfNew(current, message));
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
        };

        const handleMessageMutation = (message: Message) => {
            queryClient.setQueryData<Message[]>(["messages", message.conversation], (current = []) => replaceMessage(current, message));
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
        };
        const handleMessagesSeen = (payload: { conversationId: string; messageIds: string[]; readerKey: string }) => {
            const seenIds = new Set(payload.messageIds);
            queryClient.setQueryData<Message[]>(["messages", payload.conversationId], (current = []) => current.map((message) => seenIds.has(message._id)
                ? { ...message, seenBy: Array.from(new Set([...(message.seenBy || []), payload.readerKey])) }
                : message));
        };

        socket.on("message:new", handleNewMessage);
        socket.on("message:notification", handleMessageNotification);
        socket.on("message:updated", handleMessageMutation);
        socket.on("message:deleted", handleMessageMutation);
        socket.on("message:seen", handleMessagesSeen);
        socket.on("conversation:updated", handleConversationUpdated);

        return () => {
            socket.off("message:new", handleNewMessage);
            socket.off("message:notification", handleMessageNotification);
            socket.off("message:updated", handleMessageMutation);
            socket.off("message:deleted", handleMessageMutation);
            socket.off("message:seen", handleMessagesSeen);
            socket.off("conversation:updated", handleConversationUpdated);
        };
    }, [queryClient]);

    useEffect(() => {
        const conversationId = selectedConversation?._id;
        if (!conversationId) return;

        const joinConversation = () => socket.emit("conversation:join", conversationId);
        socket.on("connect", joinConversation);
        connectAuthenticatedSocket();
        if (socket.connected) joinConversation();

        return () => {
            socket.off("connect", joinConversation);
        };
    }, [selectedConversation?._id]);

    useEffect(() => {
        if (draftConversation || selectedConversationId || visibleConversations.length === 0) return;
        setSelectedConversationId(visibleConversations[0]._id);
    }, [draftConversation, selectedConversationId, visibleConversations]);

    useLayoutEffect(() => {
        const conversationId = selectedConversation?._id;
        if (!conversationId) return;
        if (messageNotifications.some((notification) => notification.conversationId === conversationId && !notification.isRead)) {
            markConversationMessagesRead(conversationId);
        }
    }, [markConversationMessagesRead, messageNotifications, selectedConversation?._id]);

    useEffect(() => {
        const markVisibleMessagesSeen = () => {
            const conversationId = selectedConversation?._id;
            if (!conversationId || !messages.length || document.visibilityState !== "visible") return;
            const unreadIds = messages.filter((message) => {
                const senderId = message.sender?._id || (message.senderType === "admin" ? "admin" : "");
                return senderId !== currentUser._id && !(message.seenBy || []).includes(currentReaderKey);
            }).map((message) => message._id);
            if (!unreadIds.length) return;
            const requestKey = `${conversationId}:${unreadIds.join(",")}`;
            if (lastSeenRequestRef.current === requestKey) return;
            lastSeenRequestRef.current = requestKey;
            void markMessagesSeen(conversationId).then((result) => {
            const seenIds = new Set(result.messageIds);
            queryClient.setQueryData<Message[]>(["messages", conversationId], (current = []) => current.map((message) => seenIds.has(message._id)
                ? { ...message, seenBy: Array.from(new Set([...(message.seenBy || []), result.readerKey])) }
                : message));
            }).catch(() => { lastSeenRequestRef.current = ""; });
        };
        markVisibleMessagesSeen();
        document.addEventListener("visibilitychange", markVisibleMessagesSeen);
        return () => document.removeEventListener("visibilitychange", markVisibleMessagesSeen);
    }, [currentReaderKey, currentUser._id, messages, queryClient, selectedConversation?._id]);

    useEffect(() => {
        const targetConversationId = searchParams.get("conversation") || "";
        if (!targetConversationId) {
            return;
        }

        const targetConversation = visibleConversations.find((conversation) => conversation._id === targetConversationId);
        if (!targetConversation) {
            return;
        }

        setSelectedConversationId(targetConversation._id);
        setMode(targetConversation.type === "team" ? "team" : "direct");
        setSearch("");

        const nextSearchParams = new URLSearchParams(searchParams);
        nextSearchParams.delete("conversation");
        setSearchParams(nextSearchParams, { replace: true });
    }, [searchParams, setSearchParams, visibleConversations]);

    useEffect(() => {
        const targetEmail = searchParams.get("to") || searchParams.get("call") || "";
        const callEmail = searchParams.get("call") || "";
        const teamId = searchParams.get("team") || "";
        if (targetEmail !== pendingDirectTarget) {
            setPendingDirectTarget(targetEmail);
        }
        if (callEmail !== pendingCallTarget) {
            setPendingCallTarget(callEmail);
        }
        if (teamId !== pendingTeamTarget) {
            setPendingTeamTarget(teamId);
        }
    }, [pendingCallTarget, pendingDirectTarget, pendingTeamTarget, searchParams]);

    useEffect(() => {
        if (!pendingDirectTarget || !currentUser || createDirectMutation.isPending) {
            return;
        }

        const targetEmployee = employees.find(
            (employee) => employee.email.toLowerCase() === pendingDirectTarget.toLowerCase()
        );

        if (!targetEmployee || (!isAdminRoute && targetEmployee._id === currentUser._id)) {
            return;
        }

        if (pendingCallTarget && targetEmployee.email.toLowerCase() === pendingCallTarget.toLowerCase()) {
            startEmployeeVoiceCall({ _id: targetEmployee._id, name: targetEmployee.name, role: targetEmployee.role });
        }

        const existingConversation = conversations.find((conversation) =>
            Boolean(conversation.lastMessageAt) &&
            (isAdminRoute
                ? conversation.type === "direct" && Boolean(conversation.includeAdmin) && conversation.participants.some((participant) => participant._id === targetEmployee._id)
                : conversation.type === "direct" &&
                  conversation.participants.some((participant) => participant._id === currentUser._id) &&
                  conversation.participants.some((participant) => participant._id === targetEmployee._id))
        );

        if (existingConversation) {
            setDraftConversation(null);
            setSelectedConversationId(existingConversation._id);
            setPendingDirectTarget("");
            setPendingCallTarget("");
            setSearchParams({}, { replace: true });
            return;
        }

        setSelectedConversationId(null);
        setDraftConversation({
            type: "direct",
            targetId: targetEmployee._id,
            title: targetEmployee.name,
            subtitle: isAdminRoute ? "Admin direct message" : "Direct message",
            includeAdmin: isAdminRoute,
        });
        setPendingDirectTarget("");
        setPendingCallTarget("");
        setSearchParams({}, { replace: true });
    }, [
        conversations,
        createDirectMutation,
        employees,
        isAdminRoute,
        pendingCallTarget,
        pendingDirectTarget,
        setSearchParams,
    ]);

    useEffect(() => {
        if (!pendingTeamTarget || createTeamMutation.isPending) {
            return;
        }

        const existingConversation = conversations.find(
            (conversation) => Boolean(conversation.lastMessageAt) && conversation.type === "team" && conversation.team?._id === pendingTeamTarget
        );

        if (existingConversation) {
            setDraftConversation(null);
            setSelectedConversationId(existingConversation._id);
            setPendingTeamTarget("");
            setSearchParams({}, { replace: true });
            return;
        }

        const targetTeam = accessibleTeams.find((team) => team._id === pendingTeamTarget);
        if (!targetTeam) return;
        setSelectedConversationId(null);
        setDraftConversation({ type: "team", targetId: targetTeam._id, title: targetTeam.name, subtitle: "Team conversation" });
        setPendingTeamTarget("");
        setSearchParams({}, { replace: true });
    }, [accessibleTeams, conversations, createTeamMutation, pendingTeamTarget, setSearchParams]);

    const activeEmployees = useMemo(
        () => employees.filter((employee) => employee.status !== "Archived"),
        [employees]
    );
    const directorySearchText = directorySearch.trim().toLowerCase();
    const directContacts = useMemo(
        () =>
            activeEmployees.filter((employee) => {
                if (!isAdminRoute && employee._id === currentUser._id) {
                    return false;
                }

                if (!directorySearchText) {
                    return true;
                }

                return [employee.name, employee.role, employee.team, employee.email, employee.employeeCode]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase()
                    .includes(directorySearchText);
            }),
        [activeEmployees, currentUser._id, directorySearchText, isAdminRoute]
    );
    const filteredTeams = useMemo(
        () =>
            accessibleTeams.filter((team) => {
                if (!directorySearchText) {
                    return true;
                }

                return [team.name, team.status]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase()
                    .includes(directorySearchText);
            }),
        [accessibleTeams, directorySearchText]
    );
    const filteredTeamMembers = useMemo(() => {
        const searchText = teamMemberSearch.trim().toLowerCase();
        if (!searchText) return activeEmployees;
        return activeEmployees.filter((employee) =>
            [employee.name, employee.email, employee.employeeCode, employee.role, employee.team]
                .filter(Boolean)
                .join(" ")
                .toLowerCase()
                .includes(searchText)
        );
    }, [activeEmployees, teamMemberSearch]);
    const selectedTitle = draftConversation?.title || (selectedConversation ? getConversationTitle(selectedConversation, currentUser._id) : "Select a conversation");
    const selectedSubtitle = draftConversation?.subtitle || (selectedConversation
        ? selectedConversation.type === "team"
            ? `${selectedConversation.participants.length} member${selectedConversation.participants.length === 1 ? "" : "s"}`
            : selectedConversation.includeAdmin
              ? "Admin direct message"
              : "Direct message"
        : "Choose a thread or start a new one");

    const filteredConversations = useMemo(
        () =>
            visibleConversations.filter((conversation) => {
                const title = getConversationTitle(conversation, currentUser?._id || "");
                return title.toLowerCase().includes(search.toLowerCase());
            }),
        [currentUser?._id, search, visibleConversations]
    );

    const startDirectConversation = (employeeId: string) => {
        if (!currentUser || (!isAdminRoute && employeeId === currentUser._id)) {
            return;
        }

        const existingConversation = conversations.find((conversation) =>
            Boolean(conversation.lastMessageAt) &&
            conversation.type === "direct" &&
            Boolean(conversation.includeAdmin) === isAdminRoute &&
            conversation.participants.some((participant) => participant._id === employeeId)
        );
        if (existingConversation) {
            setDraftConversation(null);
            setSelectedConversationId(existingConversation._id);
            return;
        }
        const employee = employees.find((item) => item._id === employeeId);
        if (!employee) return;
        setSelectedConversationId(null);
        setDraftConversation({ type: "direct", targetId: employeeId, title: employee.name, subtitle: isAdminRoute ? "Admin direct message" : "Direct message", includeAdmin: isAdminRoute });
    };

    const startAdminConversation = () => {
        if (!authUser || authUser.userType !== "employee") {
            return;
        }

        const existingConversation = conversations.find((conversation) => Boolean(conversation.lastMessageAt) && conversation.type === "direct" && Boolean(conversation.includeAdmin));
        if (existingConversation) {
            setDraftConversation(null);
            setSelectedConversationId(existingConversation._id);
            return;
        }
        setSelectedConversationId(null);
        setDraftConversation({ type: "direct", targetId: authUser.user._id, title: "Admin", subtitle: "Admin direct message", includeAdmin: true });
    };

    const startTeamConversation = (teamId: string) => {
        if (!accessibleTeams.some((team) => team._id === teamId)) return;
        const existingConversation = conversations.find((conversation) => Boolean(conversation.lastMessageAt) && conversation.type === "team" && conversation.team?._id === teamId);
        if (existingConversation) {
            setDraftConversation(null);
            setSelectedConversationId(existingConversation._id);
            return;
        }
        const team = accessibleTeams.find((item) => item._id === teamId);
        if (!team) return;
        setSelectedConversationId(null);
        setDraftConversation({ type: "team", targetId: teamId, title: team.name, subtitle: "Team conversation" });
    };

    useEffect(() => {
        shouldFollowMessagesRef.current = true;
        const frame = window.requestAnimationFrame(() => {
            const container = messagesScrollRef.current;
            if (container) container.scrollTop = container.scrollHeight;
        });
        return () => window.cancelAnimationFrame(frame);
    }, [selectedConversation?._id]);

    useEffect(() => {
        if (!shouldFollowMessagesRef.current) return;
        const frame = window.requestAnimationFrame(() => {
            const container = messagesScrollRef.current;
            if (container) container.scrollTop = container.scrollHeight;
        });
        return () => window.cancelAnimationFrame(frame);
    }, [messages.length]);

    const sendCurrentMessage = () => {
        const body = messageText.trim();

        if (editingMessage && selectedConversation) {
            if (!body || editMessageMutation.isPending) return;
            editMessageMutation.mutate({ conversationId: selectedConversation._id, messageId: editingMessage._id, body });
            return;
        }

        if ((!selectedConversation && !draftConversation) || !currentUser || (!body && messageFiles.length === 0) || sendMessageMutation.isPending) {
            return;
        }

        sendMessageMutation.mutate({ conversationId: selectedConversation?._id, draft: draftConversation, body, files: messageFiles });
    };

    const startEditingMessage = (message: Message) => {
        setMessageActionError("");
        setEditingMessage(message);
        setReplyingTo(null);
        setMessageFiles([]);
        setMessageText(message.body);
    };

    const startReplyingToMessage = (message: Message) => {
        setMessageActionError("");
        setReplyingTo(message);
        setEditingMessage(null);
        setMessageText("");
    };

    const removeMessage = (message: Message) => {
        if (!selectedConversation || deleteMessageMutation.isPending) return;
        if (!window.confirm("Delete this message? This cannot be undone.")) return;
        deleteMessageMutation.mutate({ conversationId: selectedConversation._id, messageId: message._id });
    };

    const selectMessageFiles = (files: File[]) => {
        setAttachmentError("");
        const availableSlots = maxMessageAttachments - messageFiles.length;
        const accepted = files.slice(0, Math.max(0, availableSlots)).filter((file) => {
            if (file.size > maxMessageAttachmentBytes) {
                setAttachmentError(`${file.name} is larger than 50 MB.`);
                return false;
            }
            return true;
        });
        if (files.length > availableSlots) setAttachmentError(`You can attach up to ${maxMessageAttachments} files per message.`);
        setMessageFiles((current) => [...current, ...accepted]);
    };

    const handleSendMessage = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        sendCurrentMessage();
    };

    const handleMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }

        event.preventDefault();
        sendCurrentMessage();
    };

    const openTeamEditor = (team: Team | null = null) => {
        setTeamEditor({ team, name: team?.name || "", members: team?.members.map((member) => member._id) || [] });
        setTeamMemberSearch("");
        setTeamEditorError("");
    };

    const saveTeam = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!teamEditor) return;
        const name = teamEditor.name.trim();
        if (!name) {
            setTeamEditorError("Enter a team name.");
            return;
        }
        const duplicate = teams.some((team) => team._id !== teamEditor.team?._id && team.name.trim().toLowerCase() === name.toLowerCase());
        if (duplicate) {
            setTeamEditorError("A team with this name already exists.");
            return;
        }

        const existing = teamEditor.team;
        saveEmployeeTeamMutation.mutate({
            id: existing?._id,
            input: {
                name,
                company: existing?.company || "All companies",
                department: existing?.department || "General",
                lead: existing?.lead?._id || null,
                members: teamEditor.members,
                activeLeads: existing?.activeLeads || 0,
                status: existing?.status || "Active",
            },
        });
    };

    const Layout = isAdminRoute ? AdminLayout : MainLayout;

    return (
        <Layout>
            <section
                className={[
                    "grid h-[calc(100dvh-8.5rem)] min-h-[32rem] max-h-[calc(100dvh-8.5rem)] overflow-hidden rounded-lg border border-slate-200 bg-[#f4f6f8] text-slate-950 shadow-[0_12px_32px_rgba(15,23,42,0.08)] lg:grid-cols-[22rem_minmax(0,1fr)]",
                ].join(" ")}
            >
                <aside className="flex min-h-0 flex-col border-r border-slate-200 bg-white">
                    <div className="border-b border-slate-200 bg-[#fbfcfe] p-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <h2 className="text-xl font-bold text-slate-950">Messages</h2>
                                <p className="mt-1 text-xs font-medium text-slate-500">{visibleConversations.length} active thread{visibleConversations.length === 1 ? "" : "s"}</p>
                            </div>
                            <button className="flex size-9 items-center justify-center rounded-lg border border-[#0084ff]/15 bg-[#e7f3ff] text-[#0084ff] transition hover:border-[#0084ff]/25 hover:bg-[#dceeff]" type="button" aria-label={isDirectoryOpen ? "Close new chat" : "Start new chat"} title={isDirectoryOpen ? "Close" : "New chat"} onClick={() => setIsDirectoryOpen((open) => !open)}>
                                {isDirectoryOpen ? <FiX className="size-5" aria-hidden="true" /> : <FiPlus className="size-5" aria-hidden="true" />}
                            </button>
                        </div>
                        <label className="mt-4 flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-slate-500 transition focus-within:border-[#0084ff]/40 focus-within:ring-2 focus-within:ring-[#0084ff]/10">
                            <FiSearch className="size-4" aria-hidden="true" />
                            <input
                                className="h-full min-w-0 flex-1 bg-transparent text-sm text-slate-950 outline-none placeholder:text-slate-400"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search"
                            />
                        </label>
                    </div>

                    {isDirectoryOpen && (
                        <div className="border-b border-slate-200 bg-[#f7f8fa] p-3">
                            <div className="flex rounded-lg bg-slate-200/70 p-1">
                                {(["direct", "team"] as const).map((option) => (
                                    <button key={option} className={["h-8 flex-1 rounded-md text-xs font-semibold capitalize transition", mode === option ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:bg-white/70"].join(" ")} type="button" onClick={() => setMode(option)}>{option}</button>
                                ))}
                            </div>
                            <label className="mt-2 flex h-9 items-center gap-2 rounded-lg bg-white px-3 text-slate-500 ring-1 ring-slate-200 focus-within:ring-2 focus-within:ring-[#0084ff]/20">
                                <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                                <input ref={directorySearchRef} className="h-full min-w-0 flex-1 bg-transparent text-sm text-slate-950 outline-none placeholder:text-slate-400" value={directorySearch} onChange={(event) => setDirectorySearch(event.target.value)} placeholder={mode === "direct" ? "Choose an employee" : "Choose a team"} type="search" autoFocus />
                            </label>
                            {mode === "team" && isAdminRoute && (
                                <button className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[#0084ff] text-xs font-semibold text-white transition hover:bg-[#0073df]" type="button" onClick={() => openTeamEditor()}>
                                    <FiPlus className="size-4" aria-hidden="true" />
                                    Create team
                                </button>
                            )}
                            <div className="content-scroll mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
                                {mode === "direct" && !isAdminRoute && (!directorySearchText || "admin support operations".includes(directorySearchText)) && (
                                    <button className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white" type="button" onClick={() => { startAdminConversation(); setIsDirectoryOpen(false); }}>
                                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white">A</span>
                                        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-950">Admin</span><span className="block truncate text-xs text-slate-500">Support and operations</span></span>
                                    </button>
                                )}
                                {mode === "direct" && directContacts.map((employee) => (
                                    <button key={employee._id} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white" type="button" onClick={() => { startDirectConversation(employee._id); setIsDirectoryOpen(false); }}>
                                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#0084ff] text-xs font-bold text-white">{getInitials(employee.name)}</span>
                                        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-950">{employee.name}</span><span className="block truncate text-xs text-slate-500">{employee.role}{employee.team ? ` · ${employee.team}` : ""}</span></span>
                                    </button>
                                ))}
                                {mode === "team" && filteredTeams.map((team) => (
                                    <div key={team._id} className="flex items-center gap-1 rounded-lg transition hover:bg-white">
                                        <button className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left" type="button" onClick={() => { startTeamConversation(team._id); setIsDirectoryOpen(false); }}>
                                            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-700"><FiUsers className="size-4" /></span>
                                            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-950">{team.name}</span><span className="block truncate text-xs text-slate-500">{team.members.length} members</span></span>
                                        </button>
                                        {isAdminRoute && (
                                            <button className="mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-[#0084ff]" type="button" onClick={() => openTeamEditor(team)} aria-label={`Manage ${team.name} members`} title="Manage members">
                                                <FiEdit2 className="size-4" aria-hidden="true" />
                                            </button>
                                        )}
                                    </div>
                                ))}
                                {((mode === "direct" && directContacts.length === 0) || (mode === "team" && filteredTeams.length === 0)) && <p className="p-3 text-sm text-slate-500">No matches found.</p>}
                            </div>
                        </div>
                    )}

                    <div className="content-scroll min-h-0 flex-1 overflow-y-auto p-2.5">
                        {filteredConversations.length === 0 && (
                            <div className="m-2 rounded-2xl border border-dashed border-slate-200 bg-[#f7f8fa] p-4 text-sm text-slate-500">
                                No conversations match your search.
                            </div>
                        )}
                        {filteredConversations.map((conversation) => {
                            const isActive = selectedConversation?._id === conversation._id;
                            const title = getConversationTitle(conversation, currentUser._id);
                            const unreadForConversation = messageNotifications.filter((notification) => !notification.isRead && notification.conversationId === conversation._id).length;
                            const ConversationIcon = conversation.type === "team" ? FiUsers : conversation.includeAdmin ? FiMessageCircle : FiHash;
                            return (
                                <button
                                    key={conversation._id}
                                    className={[
                                        "mb-1 flex min-h-[4.75rem] w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition",
                                        isActive
                                            ? "border-[#0084ff]/20 bg-[#e7f3ff] shadow-sm"
                                            : "border-transparent hover:border-slate-200 hover:bg-[#f7f9fb]",
                                    ].join(" ")}
                                    type="button"
                                    onClick={() => {
                                        setDraftConversation(null);
                                        setSelectedConversationId(conversation._id);
                                        markConversationMessagesRead(conversation._id);
                                    }}
                                >
                                    <span className={["flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-bold", conversation.type === "team" ? "bg-slate-200 text-slate-700" : "bg-[#0084ff] text-white"].join(" ")}>
                                        {conversation.type === "team" ? <ConversationIcon className="size-4" /> : getInitials(title)}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-start justify-between gap-2">
                                            <span className={["block truncate text-sm text-slate-950", unreadForConversation > 0 ? "font-bold" : "font-semibold"].join(" ")}>{title}</span>
                                            <span className="flex shrink-0 items-center gap-1.5">
                                                {unreadForConversation > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-[#0084ff] px-1.5 py-0.5 text-[0.62rem] font-bold text-white">{unreadForConversation > 99 ? "99+" : unreadForConversation}</span>}
                                                {conversation.lastMessageAt && <span className="text-[0.65rem] text-slate-400">{formatPhDateTime(conversation.lastMessageAt).replace(", 2026", "")}</span>}
                                            </span>
                                        </span>
                                        <span className="mt-1 block truncate text-xs text-slate-500">
                                            {conversation.lastMessage || "No messages yet"}
                                        </span>
                                        <span className="mt-1.5 inline-flex rounded bg-slate-100 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase text-slate-500">
                                            {conversation.type === "team" ? "Team" : conversation.includeAdmin ? "Admin" : "Direct"}
                                        </span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </aside>

                <main className="flex min-h-0 flex-col overflow-hidden bg-white">
                    <header className="flex min-h-[4.75rem] items-center justify-between border-b border-slate-200 bg-white px-5 shadow-[0_1px_0_rgba(15,23,42,0.02)]">
                        <div className="flex min-w-0 items-center gap-3">
                            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[#0084ff] text-sm font-bold text-white shadow-sm shadow-[#0084ff]/20">
                                {(draftConversation?.type || selectedConversation?.type) === "team" ? <FiUsers className="size-4" /> : getInitials(selectedTitle)}
                            </span>
                            <div className="min-w-0">
                                <h3 className="truncate text-base font-bold text-slate-950">{selectedTitle}</h3>
                                <p className="mt-1 inline-flex rounded bg-slate-100 px-2 py-0.5 text-[0.65rem] font-semibold text-slate-500">{selectedSubtitle}</p>
                            </div>
                        </div>
                        {selectedConversation && selectedConversation.type === "direct" && !isAdminRoute && (
                            <button
                                className="flex h-9 items-center gap-2 rounded-full bg-[#e7f3ff] px-3 text-xs font-semibold text-[#0084ff] transition hover:bg-[#dceeff]"
                                type="button"
                                onClick={() => {
                                    const target = selectedConversation.participants.find((participant) => participant._id !== currentUser._id);
                                    if (target) startEmployeeVoiceCall({ _id: target._id, name: target.name, role: target.role });
                                }}
                            >
                                <FiPhone className="size-4" aria-hidden="true" />
                                Call
                            </button>
                        )}
                    </header>

                    <div
                        ref={messagesScrollRef}
                        className="content-scroll flex-1 overflow-y-auto bg-[#f4f6f8] px-5 py-5 sm:px-7"
                        onScroll={(event) => {
                            const target = event.currentTarget;
                            shouldFollowMessagesRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 96;
                        }}
                    >
                        {!selectedConversation && !draftConversation && (
                            <div className="grid h-full place-items-center">
                                <div className="max-w-sm text-center">
                                    <span className="mx-auto grid size-12 place-items-center rounded-lg border border-[#0084ff]/15 bg-[#e7f3ff] text-[#0084ff]"><FiMessageCircle className="size-6" aria-hidden="true" /></span>
                                    <p className="mt-3 text-sm font-semibold text-slate-950">Select a conversation</p>
                                    <p className="mt-1 text-sm text-slate-500">Use the plus button in Chats to start a direct or team conversation.</p>
                                </div>
                            </div>
                        )}
                        {messages.map((message, messageIndex) => {
                            const senderId = message.sender?._id || (message.senderType === "admin" ? "admin" : "");
                            const senderName = message.sender?.name || message.senderName || (message.senderType === "admin" ? "Admin" : "Employee");
                            const isMine = senderId === currentUser?._id;
                            const previousMessage = messages[messageIndex - 1];
                            const showDate = !previousMessage || formatPhDate(previousMessage.createdAt) !== formatPhDate(message.createdAt);

                            return (
                                <div key={message._id} className="py-1.5">
                                    {showDate && (
                                        <div className="my-4 flex items-center gap-3" aria-label={formatPhDate(message.createdAt)}>
                                            <span className="h-px flex-1 bg-slate-200" />
                                            <span className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[0.65rem] font-semibold text-slate-500 shadow-sm">{formatPhDate(message.createdAt)}</span>
                                            <span className="h-px flex-1 bg-slate-200" />
                                        </div>
                                    )}
                                    <div className={["flex items-end gap-2", isMine ? "justify-end" : "justify-start"].join(" ")}>
                                    {!isMine && (
                                        <span className="mb-5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-[0.68rem] font-bold text-slate-700 shadow-sm">
                                            {getInitials(senderName)}
                                        </span>
                                    )}
                                    <div className={["flex max-w-[min(34rem,78%)] flex-col", isMine ? "items-end" : "items-start"].join(" ")}>
                                        {!isMine && <p className="mb-1 ml-2 text-[0.68rem] font-semibold text-slate-500">{senderName}</p>}
                                        <div className="group flex items-center gap-1.5">
                                            {isMine && !message.deletedAt && (
                                                <div className="flex opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                                                    <button className="grid size-7 place-items-center rounded-full text-slate-400 hover:bg-white hover:text-[#0084ff]" type="button" aria-label="Edit message" title="Edit" onClick={() => startEditingMessage(message)}><FiEdit2 className="size-3.5" aria-hidden="true" /></button>
                                                    <button className="grid size-7 place-items-center rounded-full text-slate-400 hover:bg-white hover:text-red-600" type="button" aria-label="Delete message" title="Delete" onClick={() => removeMessage(message)}><FiTrash2 className="size-3.5" aria-hidden="true" /></button>
                                                </div>
                                            )}
                                            <div className={["rounded-xl px-3.5 py-2.5 shadow-sm", message.deletedAt ? "border border-slate-200 bg-slate-100 text-slate-500 italic" : isMine ? "rounded-br-sm bg-[#0084ff] !text-white shadow-[#0084ff]/15" : "rounded-bl-sm border border-slate-200 bg-white text-slate-950"].join(" ")}>
                                            {message.replyTo && !message.deletedAt && (
                                                <div className={["mb-2 rounded-lg border-l-2 px-2.5 py-2 text-xs", isMine ? "border-white/70 bg-white/10" : "border-[#0084ff] bg-slate-50"].join(" ")}>
                                                    <p className="font-semibold opacity-85">{message.replyTo.senderName}</p>
                                                    <p className="mt-0.5 max-w-72 truncate opacity-70">{message.replyTo.body || message.replyTo.attachmentLabel || "Message"}</p>
                                                </div>
                                            )}
                                            {message.attachments && message.attachments.length > 0 && !message.deletedAt && (
                                                <div className="space-y-2">
                                                    {message.attachments.map((attachment) => (
                                                        <MessageAttachmentView key={attachment.url} attachment={attachment} isMine={isMine} />
                                                    ))}
                                                </div>
                                            )}
                                            {message.deletedAt ? <p className="px-1 text-sm">Message deleted</p> : message.body && <p className={["whitespace-pre-wrap break-words px-1 text-sm leading-6", message.attachments?.length ? "mt-2" : ""].join(" ")}>{message.body}</p>}
                                            </div>
                                            {!message.deletedAt && (
                                                <button className="grid size-7 place-items-center rounded-full text-slate-400 opacity-0 transition hover:bg-white hover:text-[#0084ff] group-hover:opacity-100 group-focus-within:opacity-100" type="button" aria-label="Reply to message" title="Reply" onClick={() => startReplyingToMessage(message)}><FiCornerUpLeft className="size-3.5" aria-hidden="true" /></button>
                                            )}
                                        </div>
                                        <p className="mt-1 px-1 text-[0.68rem] font-medium text-slate-400">{formatPhTime(message.createdAt)}{message.editedAt && !message.deletedAt ? " · Edited" : ""}{isMine && (message.seenBy?.length || 0) > 0 ? " · Seen" : ""}</p>
                                    </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    <form className="border-t border-slate-200 bg-[#fbfcfe] px-5 py-3.5" onSubmit={handleSendMessage}>
                        {(replyingTo || editingMessage) && (
                            <div className="mb-2 flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm">
                                <span className="h-9 w-1 rounded-full bg-[#0084ff]" />
                                <div className="min-w-0 flex-1">
                                    <p className="text-xs font-semibold text-[#0084ff]">{editingMessage ? "Editing message" : `Replying to ${replyingTo?.sender?.name || replyingTo?.senderName || "message"}`}</p>
                                    <p className="mt-0.5 truncate text-xs text-slate-500">{(editingMessage || replyingTo)?.deletedAt ? "Message deleted" : (editingMessage || replyingTo)?.body || "Attachment"}</p>
                                </div>
                                <button className="grid size-7 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700" type="button" aria-label="Cancel" onClick={() => { setEditingMessage(null); setReplyingTo(null); setMessageText(""); }}><FiX className="size-4" aria-hidden="true" /></button>
                            </div>
                        )}
                        {messageFiles.length > 0 && (
                            <div className="mb-2 flex flex-wrap gap-2 px-2">
                                {messageFiles.map((file, index) => (
                                    <span key={`${file.name}-${file.lastModified}-${index}`} className="inline-flex max-w-56 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
                                        <FiFile className="size-4 shrink-0 text-[#0084ff]" aria-hidden="true" />
                                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                                        <button
                                            className="flex size-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                                            type="button"
                                            aria-label={`Remove ${file.name}`}
                                            onClick={() => setMessageFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}
                                        >
                                            <FiX className="size-3.5" aria-hidden="true" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                        {attachmentError && <p className="mb-2 px-2 text-xs font-semibold text-red-600">{attachmentError}</p>}
                        {messageActionError && <p className="mb-2 px-2 text-xs font-semibold text-red-600">{messageActionError}</p>}
                        <div className="flex items-end gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm transition focus-within:border-[#0084ff]/40 focus-within:ring-2 focus-within:ring-[#0084ff]/10">
                        <input
                            ref={attachmentInputRef}
                            className="sr-only"
                            type="file"
                            accept={acceptedMessageFileTypes}
                            multiple
                            onChange={(event) => selectMessageFiles(Array.from(event.target.files || []))}
                            disabled={Boolean(editingMessage) || (!selectedConversation && !draftConversation) || sendMessageMutation.isPending}
                        />
                        <button
                            className="flex size-10 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-white hover:text-[#0084ff] disabled:cursor-not-allowed disabled:text-slate-300"
                            type="button"
                            aria-label="Attach files"
                            title="Attach files"
                            disabled={Boolean(editingMessage) || (!selectedConversation && !draftConversation) || sendMessageMutation.isPending || messageFiles.length >= maxMessageAttachments}
                            onClick={() => attachmentInputRef.current?.click()}
                        >
                            <FiPaperclip className="size-5" aria-hidden="true" />
                        </button>
                        <textarea
                            className="max-h-28 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-6 text-slate-950 outline-none placeholder:text-slate-400"
                            value={messageText}
                            onChange={(event) => setMessageText(event.target.value)}
                            onKeyDown={handleMessageKeyDown}
                            placeholder={editingMessage ? "Edit message" : replyingTo ? "Write a reply" : "Write a message"}
                            rows={1}
                            disabled={(!selectedConversation && !draftConversation) || sendMessageMutation.isPending || editMessageMutation.isPending}
                        />
                        <button
                            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#0084ff] text-white transition hover:bg-[#0073df] disabled:cursor-not-allowed disabled:bg-slate-300"
                            type="submit"
                            aria-label={editingMessage ? "Save edited message" : "Send message"}
                            disabled={(!selectedConversation && !draftConversation) || (!messageText.trim() && (Boolean(editingMessage) || messageFiles.length === 0)) || sendMessageMutation.isPending || editMessageMutation.isPending}
                        >
                            {editingMessage ? <FiCheck className="size-5" aria-hidden="true" /> : <FiSend className="size-5" aria-hidden="true" />}
                        </button>
                        </div>
                        {(sendMessageMutation.isPending || editMessageMutation.isPending) && <p className="mt-2 px-2 text-xs font-semibold text-[#0084ff]">{editingMessage ? "Saving changes..." : "Sending message..."}</p>}
                    </form>
                </main>

                {false && <aside className="hidden">
                    {!isDirectoryOpen ? (
                        <div className="flex flex-col items-center gap-3">
                            <button
                                className="flex size-10 items-center justify-center rounded-full bg-[#f0f2f5] text-slate-700 transition hover:bg-[#e4e6eb]"
                                type="button"
                                aria-label="Expand contact panel"
                                title="Expand"
                                onClick={() => setIsDirectoryOpen(true)}
                            >
                                {isAdminRoute ? <FiChevronLeft className="size-4" aria-hidden="true" /> : <FiChevronRight className="size-4" aria-hidden="true" />}
                            </button>
                            <span className="flex size-10 items-center justify-center rounded-full bg-[#e7f3ff] text-[#0084ff]">
                                {mode === "team" ? <FiUsers className="size-4" aria-hidden="true" /> : <FiMessageCircle className="size-4" aria-hidden="true" />}
                            </span>
                            <span className="rotate-90 whitespace-nowrap pt-6 text-xs font-semibold text-slate-500">
                                People
                            </span>
                        </div>
                    ) : (
                        <>
                            <div className="mb-4 flex items-center justify-between gap-3">
                                <div>
                                    <h3 className="text-lg font-bold text-slate-950">People</h3>
                                    <p className="mt-0.5 text-xs text-slate-500">{mode === "direct" ? `${directContacts.length} employees` : `${filteredTeams.length} teams`}</p>
                                </div>
                                <button
                                    className="flex size-9 items-center justify-center rounded-full bg-[#f0f2f5] text-slate-700 transition hover:bg-[#e4e6eb]"
                                    type="button"
                                    aria-label="Collapse contact panel"
                                    title="Collapse"
                                    onClick={() => setIsDirectoryOpen(false)}
                                >
                                    {isAdminRoute ? <FiChevronRight className="size-4" aria-hidden="true" /> : <FiChevronLeft className="size-4" aria-hidden="true" />}
                                </button>
                            </div>

                            <div className="flex rounded-full bg-[#f0f2f5] p-1">
                                {(["direct", "team"] as const).map((option) => (
                                    <button
                                        key={option}
                                        className={[
                                            "h-9 flex-1 rounded-full text-sm font-semibold capitalize transition",
                                            mode === option ? "bg-white text-slate-950 shadow-sm" : "text-slate-700 hover:bg-white/70",
                                        ].join(" ")}
                                        type="button"
                                        onClick={() => setMode(option)}
                                    >
                                        {option}
                                    </button>
                                ))}
                            </div>

                            <div className="mt-3 flex gap-2">
                                <label className="flex h-10 min-w-0 flex-1 items-center rounded-full bg-[#f0f2f5] px-3 focus-within:ring-2 focus-within:ring-[#0084ff]/20">
                                    <FiSearch className="mr-2 size-4 shrink-0 text-slate-400" aria-hidden="true" />
                                    <input
                                        ref={directorySearchRef}
                                        className="h-full min-w-0 flex-1 bg-transparent text-sm text-slate-950 outline-none placeholder:text-slate-400"
                                        value={directorySearch}
                                        onChange={(event) => setDirectorySearch(event.target.value)}
                                        placeholder={mode === "direct" ? "Search employees" : "Search teams"}
                                        type="search"
                                    />
                                </label>
                                <button
                                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#e7f3ff] text-[#0084ff] transition hover:bg-[#dceeff]"
                                    type="button"
                                    aria-label={mode === "direct" ? "Search employees" : "Search teams"}
                                    onClick={() => directorySearchRef.current?.focus()}
                                >
                                    <FiSearch className="size-4" aria-hidden="true" />
                                </button>
                            </div>

                            <div className="content-scroll mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto">
                                {mode === "direct" && !isAdminRoute && (!directorySearchText || "admin support operations".includes(directorySearchText)) && (
                                    <button
                                        className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-[#f0f2f5]"
                                        type="button"
                                        onClick={startAdminConversation}
                                    >
                                        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-bold text-white">A</span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-semibold text-slate-950">Admin</span>
                                            <span className="mt-0.5 block truncate text-xs text-slate-500">Support and operations</span>
                                        </span>
                                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#e7f3ff] text-[#0084ff]">
                                            <FiPlus className="size-4" aria-hidden="true" />
                                        </span>
                                    </button>
                                )}
                                {mode === "direct" &&
                                    directContacts
                                        .map((employee) => (
                                            <button
                                                key={employee._id}
                                                className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-[#f0f2f5]"
                                                type="button"
                                                onClick={() => startDirectConversation(employee._id)}
                                            >
                                                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#0084ff] text-sm font-bold text-white">
                                                    {getInitials(employee.name)}
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm font-semibold text-slate-950">{employee.name}</span>
                                                    <span className="mt-0.5 block truncate text-xs text-slate-500">{employee.role}{employee.team ? ` · ${employee.team}` : ""}</span>
                                                </span>
                                                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#e7f3ff] text-[#0084ff]">
                                                    <FiPlus className="size-4" aria-hidden="true" />
                                                </span>
                                            </button>
                                        ))}
                                {mode === "direct" && directContacts.length === 0 && (isAdminRoute || directorySearchText) && (
                                    <p className="rounded-2xl border border-dashed border-slate-200 bg-[#f7f8fa] p-4 text-sm text-slate-500">
                                        No employees match your search.
                                    </p>
                                )}

                                {mode === "team" &&
                                    filteredTeams.map((team) => (
                                        <button
                                            key={team._id}
                                            className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-[#f0f2f5]"
                                            type="button"
                                            onClick={() => startTeamConversation(team._id)}
                                        >
                                            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-700">
                                                <FiUsers className="size-4" aria-hidden="true" />
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm font-semibold text-slate-950">{team.name}</span>
                                                <span className="mt-0.5 block truncate text-xs text-slate-500">{team.members.length} members</span>
                                            </span>
                                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#e7f3ff] text-[#0084ff]">
                                                <FiPlus className="size-4" aria-hidden="true" />
                                            </span>
                                        </button>
                                    ))}
                                {mode === "team" && filteredTeams.length === 0 && (
                                    <p className="rounded-2xl border border-dashed border-slate-200 bg-[#f7f8fa] p-4 text-sm text-slate-500">
                                        No teams match your search.
                                    </p>
                                )}
                            </div>
                        </>
                    )}
                </aside>}
            </section>

            {isAdminRoute && teamEditor && (
                <div className="fixed inset-0 z-[80] grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saveEmployeeTeamMutation.isPending) setTeamEditor(null); }}>
                    <form className="flex max-h-[min(42rem,90vh)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl" onSubmit={saveTeam}>
                        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                            <div>
                                <h3 className="text-lg font-semibold text-slate-950">{teamEditor.team ? "Manage team" : "Create team"}</h3>
                                <p className="mt-1 text-sm text-slate-500">Choose the employees who can access this team conversation.</p>
                            </div>
                            <button className="flex size-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900" type="button" onClick={() => setTeamEditor(null)} disabled={saveEmployeeTeamMutation.isPending} aria-label="Close team editor">
                                <FiX className="size-5" aria-hidden="true" />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto p-5">
                            <label className="block">
                                <span className="text-xs font-semibold uppercase text-slate-500">Team name</span>
                                <input className="mt-2 h-11 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-950 outline-none transition focus:border-[#0084ff] focus:ring-2 focus:ring-[#0084ff]/15" value={teamEditor.name} onChange={(event) => { setTeamEditor((current) => current ? { ...current, name: event.target.value } : current); setTeamEditorError(""); }} placeholder="Enter team name" autoFocus />
                            </label>
                            <label className="mt-4 flex h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 text-slate-500 focus-within:border-[#0084ff] focus-within:ring-2 focus-within:ring-[#0084ff]/15">
                                <FiSearch className="size-4" aria-hidden="true" />
                                <input className="h-full min-w-0 flex-1 bg-transparent text-sm text-slate-950 outline-none" value={teamMemberSearch} onChange={(event) => setTeamMemberSearch(event.target.value)} placeholder="Search employees" />
                                <span className="text-xs font-semibold text-slate-400">{teamEditor.members.length} selected</span>
                            </label>
                            <div className="content-scroll mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200">
                                {filteredTeamMembers.map((employee) => {
                                    const selected = teamEditor.members.includes(employee._id);
                                    return (
                                        <button key={employee._id} className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-3 text-left last:border-b-0 hover:bg-slate-50" type="button" onClick={() => setTeamEditor((current) => current ? { ...current, members: selected ? current.members.filter((id) => id !== employee._id) : [...current.members, employee._id] } : current)}>
                                            <span className={["grid size-5 shrink-0 place-items-center rounded border", selected ? "border-[#0084ff] bg-[#0084ff] text-white" : "border-slate-300 bg-white"].join(" ")}>{selected && <FiCheck className="size-3.5" />}</span>
                                            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{employee.name}</span><span className="block truncate text-xs text-slate-500">{employee.role} · {employee.employeeCode} · {employee.team || "Unassigned"}</span></span>
                                        </button>
                                    );
                                })}
                                {filteredTeamMembers.length === 0 && <p className="p-6 text-center text-sm text-slate-500">No employees found.</p>}
                            </div>
                            {teamEditorError && <p className="mt-3 text-sm font-semibold text-red-600">{teamEditorError}</p>}
                        </div>
                        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
                            <button className="h-10 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50" type="button" onClick={() => setTeamEditor(null)} disabled={saveEmployeeTeamMutation.isPending}>Cancel</button>
                            <button className="h-10 rounded-lg bg-[#0084ff] px-5 text-sm font-semibold text-white transition hover:bg-[#0073df] disabled:cursor-wait disabled:bg-slate-300" type="submit" disabled={saveEmployeeTeamMutation.isPending}>{saveEmployeeTeamMutation.isPending ? "Saving..." : teamEditor.team ? "Save members" : "Create team"}</button>
                        </div>
                    </form>
                </div>
            )}
        </Layout>
    );
}

function getConversationTitle(conversation: Conversation, currentUserId: string) {
    if (conversation.type === "team") {
        return conversation.team?.name || conversation.title || "Team chat";
    }

    if (conversation.includeAdmin) {
        if (currentUserId === "admin") {
            return conversation.participants[0]?.name || conversation.title || "Employee";
        }

        return "Admin";
    }

    const otherParticipant = conversation.participants.find((participant) => participant._id !== currentUserId);
    return otherParticipant?.name || conversation.title || "Direct message";
}
