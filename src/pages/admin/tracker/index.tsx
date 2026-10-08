import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
    FiActivity,
    FiCamera,
    FiClock,
    FiDownload,
    FiExternalLink,
    FiFilter,
    FiMonitor,
    FiPackage,
    FiRefreshCw,
    FiSearch,
    FiShield,
    FiTrash2,
    FiUser,
    FiVideo,
    FiVideoOff,
    FiX,
} from "react-icons/fi";
import AdminLayout from "../adminLayout";
import {
    browserActivityExtensionPackageUrl,
    browserActivityWebStoreUrl,
    liveViewAgentPackageUrl,
    clearBrowserActivityData,
    getBrowserActivityEvents,
    getBrowserActivityScreenshots,
} from "../../../api/browserActivity";
import type { BrowserActivityClassification, BrowserActivityEvent, BrowserActivityEventType } from "../../../api/browserActivity";
import { getEmployeeSummaries } from "../../../api/employees";
import { getSystemSettings } from "../../../api/systemSettings";
import { backendOrigin } from "../../../lib/backendUrl";
import { parsePhDateTimeInput, formatPhDateTime } from "../../../lib/dateTime";
import { connectAuthenticatedSocket, socket } from "../../../lib/socket";

const classificationFilters = ["ALL", "work", "non-work", "unknown"] as const;
const trackerRefetchIntervalMs = 10_000;
const eventTypeFilters: Array<"ALL" | BrowserActivityEventType> = [
    "ALL",
    "site_visit",
    "idle_state",
    "link_clicked",
    "form_submitted",
    "copy",
    "paste",
    "screenshot_captured",
    "manual_sync",
];
const noisyEventTypes = new Set<BrowserActivityEventType>([
    "tab_created",
    "tab_updated",
    "tab_activated",
    "tab_closed",
    "window_focus",
    "keyboard_activity",
    "mouse_activity",
    "scroll",
]);

type LiveSessionStatus = "requesting" | "connecting" | "live" | "ended" | "error";

type LiveSession = {
    requestId: string;
    employeeId: string;
    employeeName: string;
    status: LiveSessionStatus;
    message: string;
};

type LiveShareSignal = {
    requestId?: string;
    description?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
};

const rtcConfig: RTCConfiguration = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const eventTypeLabels: Record<BrowserActivityEventType, string> = {
    site_visit: "Site visit",
    tab_created: "Tab opened",
    tab_updated: "URL changed",
    tab_activated: "Tab viewed",
    tab_closed: "Tab closed",
    window_focus: "Window focus",
    idle_state: "Idle state",
    link_clicked: "Link clicked",
    form_submitted: "Form submitted",
    copy: "Copied",
    paste: "Pasted",
    keyboard_activity: "Keyboard activity",
    mouse_activity: "Mouse activity",
    scroll: "Scrolled",
    screenshot_captured: "Screenshot",
    manual_sync: "Manual sync",
};

function classificationClass(classification: BrowserActivityClassification) {
    if (classification === "work") {
        return "border-emerald-200 bg-emerald-50 text-emerald-700";
    }

    if (classification === "non-work") {
        return "border-rose-200 bg-rose-50 text-rose-700";
    }

    return "border-slate-200 bg-slate-100 text-slate-600";
}

function formatEventType(type: BrowserActivityEventType) {
    return eventTypeLabels[type] || type.replace(/_/g, " ");
}

function compactUrl(value: string) {
    if (!value) {
        return "";
    }

    try {
        const url = new URL(value);
        const path = `${url.pathname}${url.search}`.replace(/\/$/, "");
        return `${url.hostname.replace(/^www\./, "")}${path}`.slice(0, 90);
    } catch {
        return value.slice(0, 90);
    }
}

function metadataNumber(metadata: Record<string, unknown>, key: string) {
    const value = metadata[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dateMs(value?: string) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatDurationSeconds(value: number) {
    const totalSeconds = Math.max(0, Math.round(value));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }

    if (minutes > 0) {
        return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    }

    return `${seconds}s`;
}

function makeSyntheticVisit(session: {
    firstEvent: BrowserActivityEvent;
    lastEvent: BrowserActivityEvent;
    startedAtMs: number;
    endedAtMs: number;
}) {
    const durationSeconds = Math.max(0, Math.round((session.endedAtMs - session.startedAtMs) / 1000));
    const event = session.lastEvent;

    return {
        ...event,
        _id: `synthetic-site-visit-${session.firstEvent._id}-${session.lastEvent._id}`,
        eventType: "site_visit" as const,
        title: session.lastEvent.title || session.firstEvent.title || session.lastEvent.domain || "Site visit",
        occurredAt: session.firstEvent.occurredAt,
        metadata: {
            ...(session.lastEvent.metadata || {}),
            startedAt: new Date(session.startedAtMs).toISOString(),
            endedAt: new Date(session.endedAtMs).toISOString(),
            durationSeconds,
            synthesizedFromRawEvents: true,
        },
    };
}

function buildSyntheticSiteVisits(events: BrowserActivityEvent[]) {
    const sourceEvents = events
        .filter((event) => noisyEventTypes.has(event.eventType) && event.domain && event.url && dateMs(event.occurredAt) > 0)
        .sort((left, right) => dateMs(left.occurredAt) - dateMs(right.occurredAt));
    const sessions: BrowserActivityEvent[] = [];
    let current:
        | {
              key: string;
              firstEvent: BrowserActivityEvent;
              lastEvent: BrowserActivityEvent;
              startedAtMs: number;
              lastSeenAtMs: number;
          }
        | null = null;

    for (const event of sourceEvents) {
        const occurredAtMs = dateMs(event.occurredAt);
        const key = [event.employee, event.tabId ?? "tab", event.domain].join(":");

        if (!current || current.key !== key) {
            if (current && current.lastSeenAtMs > current.startedAtMs) {
                sessions.push(
                    makeSyntheticVisit({
                        firstEvent: current.firstEvent,
                        lastEvent: current.lastEvent,
                        startedAtMs: current.startedAtMs,
                        endedAtMs: Math.max(current.lastSeenAtMs, occurredAtMs),
                    })
                );
            }

            current = {
                key,
                firstEvent: event,
                lastEvent: event,
                startedAtMs: occurredAtMs,
                lastSeenAtMs: occurredAtMs,
            };
            continue;
        }

        current.lastEvent = event;
        current.lastSeenAtMs = Math.max(current.lastSeenAtMs, occurredAtMs);
    }

    if (current && current.lastSeenAtMs > current.startedAtMs) {
        sessions.push(
            makeSyntheticVisit({
                firstEvent: current.firstEvent,
                lastEvent: current.lastEvent,
                startedAtMs: current.startedAtMs,
                endedAtMs: current.lastSeenAtMs,
            })
        );
    }

    return sessions.sort((left, right) => dateMs(right.occurredAt) - dateMs(left.occurredAt));
}

function imageUrl(fileUrl: string) {
    if (/^https?:\/\//i.test(fileUrl)) {
        return fileUrl;
    }

    const normalizedFileUrl = fileUrl.startsWith("/") ? fileUrl : `/${fileUrl}`;
    const legacyScreenshotPrefix = "/uploads/browser-screenshots/";

    if (normalizedFileUrl.startsWith(legacyScreenshotPrefix)) {
        const relativePath = normalizedFileUrl
            .slice(legacyScreenshotPrefix.length)
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/");
        return `${backendOrigin}/api/browser-activity/screenshots/file/${relativePath}`;
    }

    return `${backendOrigin}${normalizedFileUrl}`;
}

function matchesSearch(event: BrowserActivityEvent, search: string) {
    const normalizedSearch = search.trim().toLowerCase();

    if (!normalizedSearch) {
        return true;
    }

    return [
        event.employeeName,
        event.eventType,
        event.title,
        event.domain,
        event.category,
        event.url,
        event.normalizedUrl,
    ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch);
}

export default function AdminTracker() {
    const [employeeFilter, setEmployeeFilter] = useState("ALL");
    const [liveEmployeeId, setLiveEmployeeId] = useState("");
    const [liveSession, setLiveSession] = useState<LiveSession | null>(null);
    const [isLiveModalOpen, setIsLiveModalOpen] = useState(false);
    const [classificationFilter, setClassificationFilter] = useState<(typeof classificationFilters)[number]>("ALL");
    const [eventTypeFilter, setEventTypeFilter] = useState<"ALL" | BrowserActivityEventType>("site_visit");
    const [categoryFilter, setCategoryFilter] = useState("");
    const [search, setSearch] = useState("");
    const [startDateTime, setStartDateTime] = useState("");
    const [endDateTime, setEndDateTime] = useState("");
    const liveVideoRef = useRef<HTMLVideoElement | null>(null);
    const livePeerRef = useRef<RTCPeerConnection | null>(null);
    const liveSessionRef = useRef<LiveSession | null>(null);
    const liveStreamRef = useRef<MediaStream | null>(null);
    const startIso = startDateTime ? parsePhDateTimeInput(startDateTime)?.toISOString() : undefined;
    const endIso = endDateTime ? parsePhDateTimeInput(endDateTime)?.toISOString() : undefined;
    const activityParams = {
        employeeId: employeeFilter === "ALL" ? undefined : employeeFilter,
        classification: classificationFilter === "ALL" ? undefined : classificationFilter,
        category: categoryFilter.trim() || undefined,
        start: startIso,
        end: endIso,
        limit: 800,
    };

    const { data: employees = [] } = useQuery({ queryKey: ["employee-summaries"], queryFn: getEmployeeSummaries });
    const { data: systemSettings } = useQuery({ queryKey: ["system-settings"], queryFn: getSystemSettings });
    const clearDataEnabled = systemSettings?.trackerClearDataEnabled !== false;
    const eventsQuery = useQuery({
        queryKey: ["browser-activity-events", activityParams],
        queryFn: () => getBrowserActivityEvents(activityParams),
        refetchInterval: trackerRefetchIntervalMs,
        refetchIntervalInBackground: true,
    });
    const screenshotsQuery = useQuery({
        queryKey: ["browser-activity-screenshots", activityParams],
        queryFn: () => getBrowserActivityScreenshots({ ...activityParams, limit: 120 }),
        refetchInterval: trackerRefetchIntervalMs,
        refetchIntervalInBackground: true,
    });
    const events = eventsQuery.data || [];
    const syntheticSiteVisits = useMemo(() => buildSyntheticSiteVisits(events), [events]);
    const eventRows = useMemo(() => {
        const siteVisits = events.filter((event) => event.eventType === "site_visit");
        const visibleRawEvents = events.filter((event) => !noisyEventTypes.has(event.eventType) && event.eventType !== "site_visit");
        return [...siteVisits, ...syntheticSiteVisits, ...visibleRawEvents].sort((left, right) => dateMs(right.occurredAt) - dateMs(left.occurredAt));
    }, [events, syntheticSiteVisits]);
    const screenshots = screenshotsQuery.data || [];
    const filteredEvents = useMemo(
        () =>
            eventRows.filter((event) => {
                if (eventTypeFilter !== "ALL" && event.eventType !== eventTypeFilter) {
                    return false;
                }

                return matchesSearch(event, search);
            }),
        [eventRows, eventTypeFilter, search]
    );
    const filteredScreenshots = useMemo(() => {
        const normalizedSearch = search.trim().toLowerCase();

        if (!normalizedSearch) {
            return screenshots;
        }

        return screenshots.filter((screenshot) =>
            [
                screenshot.employeeName,
                screenshot.title,
                screenshot.domain,
                screenshot.category,
                screenshot.url,
                screenshot.normalizedUrl,
            ]
                .join(" ")
                .toLowerCase()
                .includes(normalizedSearch)
        );
    }, [screenshots, search]);
    const summary = useMemo(() => {
        const workCount = filteredEvents.filter((event) => event.classification === "work").length;
        const nonWorkCount = filteredEvents.filter((event) => event.classification === "non-work").length;
        const activeEmployees = new Set(filteredEvents.map((event) => event.employee)).size;
        const uniqueDomains = new Set(filteredEvents.map((event) => event.domain).filter(Boolean)).size;

        return { workCount, nonWorkCount, activeEmployees, uniqueDomains };
    }, [filteredEvents]);
    const isFetching = eventsQuery.isFetching || screenshotsQuery.isFetching;
    const clearMutation = useMutation({
        mutationFn: clearBrowserActivityData,
        onSuccess: () => {
            void eventsQuery.refetch();
            void screenshotsQuery.refetch();
        },
    });

    useEffect(() => {
        liveSessionRef.current = liveSession;
    }, [liveSession]);

    const cleanupLiveView = (notify = false, reason = "admin-stopped") => {
        const session = liveSessionRef.current;
        const requestId = session?.requestId;

        if (notify && requestId) {
            socket.emit("live-share:stop", { requestId, employeeId: session?.employeeId, reason });
        }

        if (liveVideoRef.current) {
            liveVideoRef.current.srcObject = null;
        }

        liveStreamRef.current = null;
        livePeerRef.current?.close();
        livePeerRef.current = null;
    };

    const createViewerPeer = (requestId: string) => {
        const peer = new RTCPeerConnection(rtcConfig);

        peer.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("live-share:signal", {
                    requestId,
                    candidate: event.candidate.toJSON(),
                });
            }
        };
        peer.ontrack = (event) => {
            const stream = event.streams[0] || new MediaStream([event.track]);
            liveStreamRef.current = stream;

            if (liveVideoRef.current) {
                liveVideoRef.current.srcObject = stream;
                void liveVideoRef.current.play().catch(() => undefined);
            }

            setLiveSession((session) =>
                session?.requestId === requestId
                    ? { ...session, status: "live", message: "Entire-screen live share is active." }
                    : session
            );
        };
        peer.onconnectionstatechange = () => {
            if (peer.connectionState === "failed") {
                setLiveSession((session) =>
                    session?.requestId === requestId
                        ? { ...session, status: "error", message: "Live connection failed. Start a new Live View request." }
                        : session
                );
                return;
            }

            if (peer.connectionState === "disconnected") {
                setLiveSession((session) =>
                    session?.requestId === requestId
                        ? { ...session, status: "connecting", message: "Live connection is reconnecting..." }
                        : session
                );
                return;
            }

            if (["connected", "completed"].includes(peer.connectionState)) {
                setLiveSession((session) =>
                    session?.requestId === requestId
                        ? { ...session, status: "live", message: "Entire-screen live share is active." }
                        : session
                );
            }
        };

        livePeerRef.current = peer;
        return peer;
    };

    useEffect(() => {
        const registerPresence = () => {
            socket.emit("presence:register", { userType: "admin", adminName: "Admin" });
        };
        const handleAccepted = (payload: { requestId?: string }) => {
            if (payload.requestId !== liveSessionRef.current?.requestId) {
                return;
            }

            setLiveSession((session) =>
                session ? { ...session, status: "connecting", message: "Employee browser started entire-screen capture. Connecting live stream..." } : session
            );
        };
        const handleDeclined = (payload: { requestId?: string; reason?: string }) => {
            if (payload.requestId !== liveSessionRef.current?.requestId) {
                return;
            }

            cleanupLiveView(false);
            setLiveSession((session) =>
                session
                    ? {
                          ...session,
                          status: "ended",
                          message: payload.reason === "declined" ? "Employee declined the live screen share." : "Live screen share was not started.",
                      }
                    : session
            );
        };
        const handleStopped = (payload: { requestId?: string; reason?: string }) => {
            if (payload.requestId !== liveSessionRef.current?.requestId) {
                return;
            }

            cleanupLiveView(false);
            const reasonMessages: Record<string, string> = {
                "screen-share-ended": "Chrome ended the employee's screen capture.",
                "employee-stopped": "The employee stopped Live View.",
                "employee-left-crm": "The employee logged out or left the CRM session.",
                "admin-stopped": "Live View was stopped by an administrator.",
                failed: "The live connection failed.",
                closed: "The live connection was closed.",
            };
            setLiveSession((session) =>
                session
                    ? {
                          ...session,
                          status: "ended",
                          message: reasonMessages[payload.reason || ""] || "Live screen share ended.",
                      }
                    : session
            );
        };
        const handleSignal = async (payload: LiveShareSignal) => {
            const requestId = liveSessionRef.current?.requestId;

            if (!payload.requestId || payload.requestId !== requestId) {
                return;
            }

            const peer = livePeerRef.current || createViewerPeer(payload.requestId);

            if (payload.description?.type === "offer") {
                await peer.setRemoteDescription(new RTCSessionDescription(payload.description));
                const answer = await peer.createAnswer();
                await peer.setLocalDescription(answer);
                socket.emit("live-share:signal", {
                    requestId: payload.requestId,
                    description: peer.localDescription ? { type: peer.localDescription.type, sdp: peer.localDescription.sdp } : answer,
                });
                return;
            }

            if (payload.candidate) {
                await peer.addIceCandidate(new RTCIceCandidate(payload.candidate));
            }
        };
        const handleError = (payload: { requestId?: string; message?: string }) => {
            if (payload.requestId && payload.requestId !== liveSessionRef.current?.requestId) {
                return;
            }

            setLiveSession((session) => (session ? { ...session, status: "error", message: payload.message || "Live share failed." } : session));
        };

        connectAuthenticatedSocket();
        socket.on("connect", registerPresence);
        socket.on("live-share:accepted", handleAccepted);
        socket.on("live-share:declined", handleDeclined);
        socket.on("live-share:stopped", handleStopped);
        socket.on("live-share:signal", handleSignal);
        socket.on("live-share:error", handleError);
        if (socket.connected) {
            registerPresence();
        }

        return () => {
            socket.off("connect", registerPresence);
            socket.off("live-share:accepted", handleAccepted);
            socket.off("live-share:declined", handleDeclined);
            socket.off("live-share:stopped", handleStopped);
            socket.off("live-share:signal", handleSignal);
            socket.off("live-share:error", handleError);
            cleanupLiveView(true, "admin-left-tracker");
        };
    }, []);

    useEffect(() => {
        if (!isLiveModalOpen || !liveVideoRef.current || !liveStreamRef.current) {
            return;
        }

        liveVideoRef.current.srcObject = liveStreamRef.current;
        void liveVideoRef.current.play().catch(() => undefined);
    }, [isLiveModalOpen, liveSession?.status]);

    const refresh = () => {
        void eventsQuery.refetch();
        void screenshotsQuery.refetch();
    };

    const requestLiveView = () => {
        const selectedEmployee = employees.find((employee) => employee._id === liveEmployeeId);

        if (!selectedEmployee) {
            setLiveSession({
                requestId: "",
                employeeId: "",
                employeeName: "",
                status: "error",
                message: "Select one employee to request live view.",
            });
            return;
        }

        cleanupLiveView(true, "new-admin-request");
        const requestId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const nextSession: LiveSession = {
            requestId,
            employeeId: selectedEmployee._id,
            employeeName: selectedEmployee.name,
            status: "requesting",
            message: "Waiting for the employee to allow Live View...",
        };

        liveSessionRef.current = nextSession;
        setLiveSession(nextSession);
        connectAuthenticatedSocket();
        socket.emit("presence:register", { userType: "admin", adminName: "Admin" });
        socket.emit("live-share:request", {
            requestId,
            employeeId: selectedEmployee._id,
            employeeName: selectedEmployee.name,
            adminName: "Admin",
        });

        window.setTimeout(() => {
            if (liveSessionRef.current?.requestId === requestId && liveSessionRef.current.status === "requesting") {
                setLiveSession((session) =>
                    session?.requestId === requestId
                        ? { ...session, status: "error", message: "No response yet. The employee must be logged into CRM and click Allow Live View." }
                        : session
                );
            }
        }, 30_000);
    };

    const stopLiveView = () => {
        cleanupLiveView(true, "admin-stopped");
        setLiveSession((session) => (session ? { ...session, status: "ended", message: "Live screen share stopped." } : session));
    };

    const handleClearData = () => {
        if (!clearDataEnabled) return;
        const confirmed = window.confirm("Clear all tracker activity and screenshots? This cannot be undone.");
        if (!confirmed) return;
        clearMutation.mutate();
    };

    return (
        <AdminLayout>
            <section className="min-h-full space-y-4 text-slate-950">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Browser Tracker</p>
                        <h2 className="mt-1 text-2xl font-semibold text-slate-950">Employee Activity Monitor</h2>
                        <p className="mt-1 text-sm text-slate-500">Extension logs, visited URLs, tab activity, screenshots, and work/non-work categories in PH time.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700"
                            type="button"
                            onClick={() => {
                                if (employeeFilter !== "ALL" && !liveEmployeeId) {
                                    setLiveEmployeeId(employeeFilter);
                                }
                                setIsLiveModalOpen(true);
                            }}
                        >
                            <FiVideo className="size-4" aria-hidden="true" />
                            Live View
                        </button>
                        {browserActivityWebStoreUrl && (
                            <a
                                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-slate-950 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
                                href={browserActivityWebStoreUrl}
                                target="_blank"
                                rel="noreferrer"
                            >
                                <FiExternalLink className="size-4" aria-hidden="true" />
                                Install Extension
                            </a>
                        )}
                        <button
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60"
                            type="button"
                            onClick={refresh}
                            disabled={isFetching || clearMutation.isPending}
                        >
                            <FiRefreshCw className={["size-4", isFetching ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
                            Refresh
                        </button>
                        {clearDataEnabled && (
                            <button
                                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-700 shadow-sm transition hover:border-rose-300 hover:bg-rose-100 disabled:opacity-60"
                                type="button"
                                onClick={handleClearData}
                                disabled={clearMutation.isPending}
                            >
                                <FiTrash2 className="size-4" aria-hidden="true" />
                                {clearMutation.isPending ? "Clearing" : "Clear Data"}
                            </button>
                        )}
                    </div>
                </div>

                <section className="flex flex-col gap-3 rounded-lg border border-violet-100 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700">
                            <FiPackage className="size-5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-slate-950">Extension installer</h3>
                            <p className="mt-1 truncate text-xs text-slate-500">Latest package: assistly-crm-activity-tracker.zip</p>
                        </div>
                    </div>
                    <a
                        className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700"
                        href={browserActivityExtensionPackageUrl}
                        download
                    >
                        <FiDownload className="size-4" aria-hidden="true" />
                        Get Extension
                    </a>
                </section>

                <section className="flex flex-col gap-3 rounded-lg border border-emerald-100 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
                            <FiMonitor className="size-5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-slate-950">Live View Agent</h3>
                            <p className="mt-1 truncate text-xs text-slate-500">Separate managed-browser installer; Call Bridge is not changed.</p>
                        </div>
                    </div>
                    <a
                        className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                        href={liveViewAgentPackageUrl}
                        download
                    >
                        <FiDownload className="size-4" aria-hidden="true" />
                        Get Live View Agent
                    </a>
                </section>

                <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="grid gap-2 xl:grid-cols-[minmax(13rem,1.1fr)_12rem_10rem_11rem_11rem_11rem]">
                        <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-slate-400 focus-within:border-violet-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-violet-100">
                            <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                            <input
                                className="h-full min-w-0 flex-1 bg-transparent text-xs font-semibold text-slate-900 outline-none placeholder:text-slate-400"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search employee, URL, title"
                                type="search"
                            />
                        </label>
                        <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-slate-400 focus-within:border-violet-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-violet-100">
                            <FiUser className="size-4 shrink-0" aria-hidden="true" />
                            <select
                                className="h-full min-w-0 flex-1 bg-transparent text-xs font-semibold text-slate-900 outline-none"
                                value={employeeFilter}
                                onChange={(event) => setEmployeeFilter(event.target.value)}
                                aria-label="Filter by employee"
                            >
                                <option className="bg-white text-slate-900" value="ALL">All employees</option>
                                {employees.map((employee) => (
                                    <option key={employee._id} className="bg-white text-slate-900" value={employee._id}>{employee.name}</option>
                                ))}
                            </select>
                        </label>
                        <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-slate-400 focus-within:border-violet-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-violet-100">
                            <FiShield className="size-4 shrink-0" aria-hidden="true" />
                            <select
                                className="h-full min-w-0 flex-1 bg-transparent text-xs font-semibold text-slate-900 outline-none"
                                value={classificationFilter}
                                onChange={(event) => setClassificationFilter(event.target.value as (typeof classificationFilters)[number])}
                                aria-label="Filter by classification"
                            >
                                {classificationFilters.map((classification) => (
                                    <option key={classification} className="bg-white text-slate-900" value={classification}>
                                        {classification === "ALL" ? "All classes" : classification}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-slate-400 focus-within:border-violet-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-violet-100">
                            <FiActivity className="size-4 shrink-0" aria-hidden="true" />
                            <select
                                className="h-full min-w-0 flex-1 bg-transparent text-xs font-semibold text-slate-900 outline-none"
                                value={eventTypeFilter}
                                onChange={(event) => setEventTypeFilter(event.target.value as "ALL" | BrowserActivityEventType)}
                                aria-label="Filter by event type"
                            >
                                {eventTypeFilters.map((eventType) => (
                                    <option key={eventType} className="bg-white text-slate-900" value={eventType}>
                                        {eventType === "ALL" ? "All activity" : formatEventType(eventType)}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-slate-400 focus-within:border-violet-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-violet-100">
                            <FiFilter className="size-4 shrink-0" aria-hidden="true" />
                            <input
                                className="h-full min-w-0 flex-1 bg-transparent text-xs font-semibold text-slate-900 outline-none placeholder:text-slate-400"
                                value={categoryFilter}
                                onChange={(event) => setCategoryFilter(event.target.value)}
                                placeholder="Category"
                            />
                        </label>
                        <button
                            className="h-10 rounded-lg border border-slate-200 bg-slate-100 px-3 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-200"
                            type="button"
                            onClick={() => {
                                setSearch("");
                                setEmployeeFilter("ALL");
                                setClassificationFilter("ALL");
                                setEventTypeFilter("site_visit");
                                setCategoryFilter("");
                                setStartDateTime("");
                                setEndDateTime("");
                            }}
                        >
                            Clear filters
                        </button>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-[11rem_11rem_1fr]">
                        <label className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-slate-400 focus-within:border-violet-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-violet-100">
                            <FiClock className="size-4 shrink-0" aria-hidden="true" />
                            <input
                                className="h-full min-w-0 flex-1 bg-transparent text-xs font-semibold text-slate-900 outline-none"
                                value={startDateTime}
                                onChange={(event) => setStartDateTime(event.target.value)}
                                type="datetime-local"
                                aria-label="Start date and time"
                            />
                        </label>
                        <label className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-slate-400 focus-within:border-violet-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-violet-100">
                            <FiClock className="size-4 shrink-0" aria-hidden="true" />
                            <input
                                className="h-full min-w-0 flex-1 bg-transparent text-xs font-semibold text-slate-900 outline-none"
                                value={endDateTime}
                                onChange={(event) => setEndDateTime(event.target.value)}
                                type="datetime-local"
                                aria-label="End date and time"
                            />
                        </label>
                        <p className="flex min-h-10 items-center text-xs font-medium text-slate-500">PH Time. The Chrome extension sends browser-only activity outside and inside the CRM.</p>
                    </div>
                </section>

                <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                    {[
                        { label: "Events", value: filteredEvents.length, icon: FiActivity },
                        { label: "Work", value: summary.workCount, icon: FiShield },
                        { label: "Non-work", value: summary.nonWorkCount, icon: FiExternalLink },
                        { label: "Screenshots", value: filteredScreenshots.length, icon: FiCamera },
                        { label: "Active agents", value: summary.activeEmployees, icon: FiUser },
                    ].map(({ label, value, icon: Icon }) => (
                        <article key={label} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                            <div className="flex items-center justify-between gap-3">
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
                                <Icon className="size-4 text-violet-500" aria-hidden="true" />
                            </div>
                            <p className="mt-3 text-2xl font-semibold text-slate-950">{value.toLocaleString("en-US")}</p>
                        </article>
                    ))}
                </section>

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(20rem,0.8fr)]">
                    <section className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Activity Feed</p>
                                <h3 className="mt-1 text-sm font-semibold text-slate-950">Site visits and browser actions</h3>
                            </div>
                            <p className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{summary.uniqueDomains.toLocaleString("en-US")} domains</p>
                        </div>
                        <div className="content-scroll max-h-[34rem] overflow-auto">
                            <table className="min-w-[58rem] w-full table-fixed text-left text-sm">
                                <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                                    <tr>
                                        <th className="w-[9rem] px-4 py-3">PH time</th>
                                        <th className="w-[11rem] px-3 py-3">Employee</th>
                                        <th className="w-[9rem] px-3 py-3">Activity</th>
                                        <th className="w-[7rem] px-3 py-3">Duration</th>
                                        <th className="w-[8rem] px-3 py-3">Class</th>
                                        <th className="w-[9rem] px-3 py-3">Category</th>
                                        <th className="px-3 py-3">Page</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {filteredEvents.map((event) => {
                                        const url = event.url || event.normalizedUrl;
                                        const durationSeconds = metadataNumber(event.metadata, "durationSeconds");

                                        return (
                                            <tr key={event._id} className="align-top text-slate-700 transition hover:bg-violet-50/50">
                                                <td className="px-4 py-3 text-xs font-semibold text-slate-500">{formatPhDateTime(event.occurredAt)}</td>
                                                <td className="px-3 py-3">
                                                    <p className="truncate font-semibold text-slate-950">{event.employeeName}</p>
                                                    <p className="mt-1 truncate text-xs text-slate-500">{event.domain || "No domain"}</p>
                                                </td>
                                                <td className="px-3 py-3 text-xs font-semibold text-slate-600">{formatEventType(event.eventType)}</td>
                                                <td className="px-3 py-3 text-xs font-semibold text-slate-600">
                                                    {durationSeconds ? formatDurationSeconds(durationSeconds) : "-"}
                                                </td>
                                                <td className="px-3 py-3">
                                                    <span className={["inline-flex rounded-full border px-2 py-1 text-[0.68rem] font-bold uppercase tracking-[0.08em]", classificationClass(event.classification)].join(" ")}>
                                                        {event.classification}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-3 text-xs font-semibold text-slate-600">{event.category || "Unknown"}</td>
                                                <td className="px-3 py-3">
                                                    <p className="line-clamp-1 font-semibold text-slate-800">{event.title || compactUrl(url) || "Untitled page"}</p>
                                                    {url ? (
                                                        <a className="mt-1 block truncate text-xs font-medium text-violet-700 hover:text-violet-900" href={url} target="_blank" rel="noreferrer">
                                                            {compactUrl(url)}
                                                        </a>
                                                    ) : (
                                                        <p className="mt-1 text-xs text-slate-400">No URL recorded</p>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                    {filteredEvents.length === 0 && (
                                        <tr>
                                            <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={7}>
                                                {eventsQuery.isLoading ? "Loading tracked activity..." : "No tracked activity for these filters."}
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                        <div className="border-b border-slate-200 px-4 py-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Screenshots</p>
                            <h3 className="mt-1 text-sm font-semibold text-slate-950">Captured browser views</h3>
                        </div>
                        <div className="content-scroll grid max-h-[34rem] gap-3 overflow-y-auto p-3">
                            {filteredScreenshots.map((screenshot) => (
                                <article key={screenshot._id} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                                    <a className="block bg-slate-100" href={imageUrl(screenshot.fileUrl)} target="_blank" rel="noreferrer">
                                        <img className="aspect-video w-full object-cover" src={imageUrl(screenshot.fileUrl)} alt={`${screenshot.employeeName} browser screenshot`} loading="lazy" />
                                    </a>
                                    <div className="space-y-2 p-3">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="truncate text-sm font-semibold text-slate-950">{screenshot.employeeName}</p>
                                                <p className="mt-1 truncate text-xs text-slate-500">{formatPhDateTime(screenshot.capturedAt)}</p>
                                            </div>
                                            <span className={["shrink-0 rounded-full border px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em]", classificationClass(screenshot.classification)].join(" ")}>
                                                {screenshot.classification}
                                            </span>
                                        </div>
                                        <p className="line-clamp-1 text-xs font-semibold text-slate-700">{screenshot.title || screenshot.domain || "Captured page"}</p>
                                        {screenshot.url && (
                                            <a className="block truncate text-xs font-medium text-violet-700 hover:text-violet-900" href={screenshot.url} target="_blank" rel="noreferrer">
                                                {compactUrl(screenshot.url)}
                                            </a>
                                        )}
                                    </div>
                                </article>
                            ))}
                            {filteredScreenshots.length === 0 && (
                                <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
                                    {screenshotsQuery.isLoading ? "Loading screenshots..." : "No screenshots for these filters."}
                                </p>
                            )}
                        </div>
                    </section>
                </div>

                {isLiveModalOpen && (
                    <div
                        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                setIsLiveModalOpen(false);
                            }
                        }}
                    >
                        <div className="flex h-[94vh] w-[96vw] max-w-[96rem] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl shadow-slate-950/30">
                            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
                                <div className="flex min-w-0 items-start gap-3">
                                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700">
                                        <FiMonitor className="size-5" aria-hidden="true" />
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Live View</p>
                                        <h3 className="mt-1 text-lg font-semibold text-slate-950">Employee screen share</h3>
                                        <p className="mt-1 text-sm leading-6 text-slate-500">
                                            Requests an entire-screen live view from the employee CRM session. The employee must allow the request before sharing starts.
                                        </p>
                                    </div>
                                </div>
                                <button
                                    className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100"
                                    type="button"
                                    onClick={() => setIsLiveModalOpen(false)}
                                    aria-label="Close live view modal"
                                >
                                    <FiX className="size-4" aria-hidden="true" />
                                </button>
                            </div>

                            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5 xl:grid-cols-[15rem_minmax(0,1fr)]">
                                <aside className="space-y-3">
                                    <label className="block">
                                        <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Employee</span>
                                        <span className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-slate-400 focus-within:border-violet-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-violet-100">
                                            <FiUser className="size-4 shrink-0" aria-hidden="true" />
                                            <select
                                                className="h-full min-w-0 flex-1 bg-transparent text-xs font-semibold text-slate-900 outline-none"
                                                value={liveEmployeeId}
                                                onChange={(event) => setLiveEmployeeId(event.target.value)}
                                                aria-label="Select employee for live view"
                                            >
                                                <option className="bg-white text-slate-900" value="">Select employee</option>
                                                {employees
                                                    .filter((employee) => employee.status !== "Archived")
                                                    .map((employee) => (
                                                        <option key={employee._id} className="bg-white text-slate-900" value={employee._id}>
                                                            {employee.name}
                                                        </option>
                                                    ))}
                                            </select>
                                        </span>
                                    </label>

                                    <button
                                        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                                        type="button"
                                        onClick={requestLiveView}
                                        disabled={!liveEmployeeId || liveSession?.status === "requesting" || liveSession?.status === "connecting" || liveSession?.status === "live"}
                                    >
                                        <FiVideo className="size-4" aria-hidden="true" />
                                        Start Live View
                                    </button>

                                    {liveSession && ["requesting", "connecting", "live"].includes(liveSession.status) && (
                                        <button
                                            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
                                            type="button"
                                            onClick={stopLiveView}
                                        >
                                            <FiX className="size-4" aria-hidden="true" />
                                            Stop Live View
                                        </button>
                                    )}

                                    {liveSession && (
                                        <p
                                            className={[
                                                "rounded-lg border px-3 py-2 text-sm font-semibold",
                                                liveSession.status === "live"
                                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                                    : liveSession.status === "error" || liveSession.status === "ended"
                                                      ? "border-amber-200 bg-amber-50 text-amber-700"
                                                      : "border-violet-200 bg-violet-50 text-violet-700",
                                            ].join(" ")}
                                        >
                                            {liveSession.employeeName ? `${liveSession.employeeName}: ` : ""}
                                            {liveSession.message}
                                        </p>
                                    )}
                                </aside>

                                <div className="min-h-[32rem] overflow-hidden rounded-lg border border-slate-200 bg-slate-950 xl:min-h-0">
                                    {liveSession?.status === "live" || liveSession?.status === "connecting" ? (
                                        <video ref={liveVideoRef} className="aspect-video h-full min-h-[32rem] w-full bg-slate-950 object-contain xl:min-h-0" autoPlay playsInline muted />
                                    ) : (
                                        <div className="flex aspect-video h-full min-h-[32rem] flex-col items-center justify-center gap-3 bg-slate-100 p-6 text-center xl:min-h-0">
                                            <span className="flex size-12 items-center justify-center rounded-full bg-white text-slate-500 shadow-sm">
                                                <FiVideoOff className="size-5" aria-hidden="true" />
                                            </span>
                                            <p className="max-w-sm text-sm font-semibold text-slate-600">No live screen share active.</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </section>
        </AdminLayout>
    );
}
