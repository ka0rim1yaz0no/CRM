import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FiMonitor } from "react-icons/fi";
import { useLocation } from "react-router";
import { getAuthUser } from "../api/authStorage";
import { connectAuthenticatedSocket, socket } from "../lib/socket";

type LiveShareRequest = { requestId: string; employeeId?: string; employeeName?: string; adminName?: string; requestedAt?: string };
type LiveShareSignal = { requestId?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
type LiveShareContextValue = {
    status: string;
    activeRequestId: string;
    pendingRequest: LiveShareRequest | null;
    startLiveShare: (request: LiveShareRequest) => Promise<void>;
    declineLiveShare: () => void;
    stopLiveShare: () => void;
};

const LiveShareContext = createContext<LiveShareContextValue | null>(null);
const rtcConfig: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function liveViewFavicon(color: string, lit: boolean) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return "";

    context.clearRect(0, 0, 64, 64);
    context.beginPath();
    context.arc(32, 32, lit ? 25 : 18, 0, Math.PI * 2);
    context.fillStyle = lit ? color : "#334155";
    if (lit) {
        context.shadowColor = color;
        context.shadowBlur = 16;
    }
    context.fill();
    context.shadowBlur = 0;
    context.lineWidth = 5;
    context.strokeStyle = "#ffffff";
    context.stroke();

    return canvas.toDataURL("image/png");
}

type EntireScreenDisplayMediaOptions = DisplayMediaStreamOptions & {
    monitorTypeSurfaces?: "include" | "exclude";
    preferCurrentTab?: boolean;
    selfBrowserSurface?: "include" | "exclude";
    surfaceSwitching?: "include" | "exclude";
    systemAudio?: "include" | "exclude";
    video: MediaTrackConstraints & {
        cursor?: "always" | "motion" | "never";
        displaySurface?: "monitor" | "window" | "browser";
        logicalSurface?: boolean;
    };
};

const entireScreenCaptureOptions: EntireScreenDisplayMediaOptions = {
    video: {
        displaySurface: "monitor",
        logicalSurface: true,
        cursor: "always",
        frameRate: { ideal: 15, max: 24 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
    },
    audio: false,
    monitorTypeSurfaces: "include",
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    systemAudio: "exclude",
};

export function EmployeeLiveShareProvider({ children }: { children: ReactNode }) {
    useLocation();
    const authUser = getAuthUser();
    const employee = authUser?.userType === "employee" ? authUser.user : null;
    const [status, setStatus] = useState("");
    const [activeRequestId, setActiveRequestId] = useState("");
    const [pendingRequest, setPendingRequest] = useState<LiveShareRequest | null>(null);
    const peerRef = useRef<RTCPeerConnection | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const requestIdRef = useRef("");
    const audioContextRef = useRef<AudioContext | null>(null);
    const alertsPreparedRef = useRef(false);

    const ensureAudioContext = useCallback(() => {
        const AudioContextConstructor = window.AudioContext ||
            (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextConstructor) return null;

        audioContextRef.current ||= new AudioContextConstructor();
        if (audioContextRef.current.state === "suspended") {
            void audioContextRef.current.resume().catch(() => undefined);
        }
        return audioContextRef.current;
    }, []);

    const playRequestChime = useCallback(() => {
        const context = ensureAudioContext();
        if (!context || context.state === "suspended") return;

        [0, 0.22, 0.44].forEach((delay, index) => {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const startsAt = context.currentTime + delay;
            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(index === 1 ? 880 : 660, startsAt);
            gain.gain.setValueAtTime(0.0001, startsAt);
            gain.gain.exponentialRampToValueAtTime(0.16, startsAt + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.16);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start(startsAt);
            oscillator.stop(startsAt + 0.18);
        });
    }, [ensureAudioContext]);

    const cleanupLiveShare = useCallback((notify = false, reason = "employee-stopped") => {
        const requestId = requestIdRef.current;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        peerRef.current?.close();
        peerRef.current = null;
        requestIdRef.current = "";
        setActiveRequestId("");

        if (notify && requestId) socket.emit("live-share:stop", { requestId, reason });
    }, []);

    const stopLiveShare = useCallback(() => {
        cleanupLiveShare(true, "employee-stopped");
        setStatus("");
    }, [cleanupLiveShare]);

    const declineLiveShare = useCallback(() => {
        if (pendingRequest?.requestId) {
            socket.emit("live-share:decline", { requestId: pendingRequest.requestId, reason: "declined" });
        }
        setPendingRequest(null);
        setStatus("");
    }, [pendingRequest]);

    const startLiveShare = useCallback(async (request: LiveShareRequest) => {
        if (!request.requestId) return;
        const requestId = request.requestId;

        try {
            cleanupLiveShare(true, "new-request");
            setStatus("Starting entire-screen live share...");
            const stream = await navigator.mediaDevices.getDisplayMedia(entireScreenCaptureOptions);
            const peer = new RTCPeerConnection(rtcConfig);

            requestIdRef.current = requestId;
            setActiveRequestId(requestId);
            streamRef.current = stream;
            peerRef.current = peer;

            peer.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit("live-share:signal", { requestId, candidate: event.candidate.toJSON() });
                }
            };
            peer.onconnectionstatechange = () => {
                if (["failed", "closed"].includes(peer.connectionState)) {
                    cleanupLiveShare(true, peer.connectionState);
                    setStatus("");
                    return;
                }

                if (peer.connectionState === "disconnected") {
                    setStatus("Live connection is reconnecting...");
                    return;
                }

                if (["connected", "completed"].includes(peer.connectionState)) {
                    setStatus("Entire-screen live share is active.");
                }
            };

            stream.getTracks().forEach((track) => {
                track.onended = () => {
                    cleanupLiveShare(true, "screen-share-ended");
                    setStatus("");
                };
                peer.addTrack(track, stream);
            });

            socket.emit("live-share:accept", { requestId });
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            socket.emit("live-share:signal", {
                requestId,
                description: peer.localDescription ? { type: peer.localDescription.type, sdp: peer.localDescription.sdp } : offer,
            });
            setPendingRequest(null);
            setStatus("Entire-screen live share is active.");
        } catch (error) {
            cleanupLiveShare(false);
            socket.emit("live-share:decline", {
                requestId,
                reason: error instanceof Error ? error.message : "permission-denied",
            });
            setPendingRequest(null);
            setStatus("");
        }
    }, [cleanupLiveShare]);

    useEffect(() => {
        if (!employee?._id) return;

        const prepareLiveViewAlerts = () => {
            if (alertsPreparedRef.current) return;
            alertsPreparedRef.current = true;
            ensureAudioContext();

            if ("Notification" in window && Notification.permission === "default") {
                void Notification.requestPermission().catch(() => undefined);
            }
        };
        window.addEventListener("pointerdown", prepareLiveViewAlerts, { passive: true });
        window.addEventListener("keydown", prepareLiveViewAlerts);

        return () => {
            window.removeEventListener("pointerdown", prepareLiveViewAlerts);
            window.removeEventListener("keydown", prepareLiveViewAlerts);
        };
    }, [employee?._id, ensureAudioContext]);

    useEffect(() => {
        if (!pendingRequest?.requestId) return;

        playRequestChime();
        const chimeTimer = window.setInterval(playRequestChime, 5_000);
        window.focus();

        let notification: Notification | null = null;
        if ("Notification" in window && Notification.permission === "granted") {
            notification = new Notification("Live View request", {
                body: `${pendingRequest.adminName || "An administrator"} requested Live View. Open the CRM to respond.`,
                icon: "/images/logoaside.png",
                requireInteraction: true,
                tag: `live-view-${pendingRequest.requestId}`,
            });
            notification.onclick = () => {
                window.focus();
                notification?.close();
            };
        }

        return () => {
            window.clearInterval(chimeTimer);
            notification?.close();
        };
    }, [pendingRequest?.adminName, pendingRequest?.requestId, playRequestChime]);

    useEffect(() => {
        const isPending = Boolean(pendingRequest?.requestId);
        const isActive = Boolean(activeRequestId);
        if (!isPending && !isActive) return;

        const originalTitle = document.title;
        let favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
        const createdFavicon = !favicon;
        if (!favicon) {
            favicon = document.createElement("link");
            favicon.rel = "icon";
            document.head.appendChild(favicon);
        }
        const originalFavicon = favicon.href;
        const alertColor = isPending ? "#ef4444" : "#22c55e";
        const alertTitle = isPending ? "LIVE VIEW REQUEST" : "LIVE VIEW ACTIVE";
        let lit = false;

        const updateTabAlert = () => {
            lit = !lit;
            document.title = lit ? `● ${alertTitle}` : originalTitle;
            const nextFavicon = liveViewFavicon(alertColor, lit);
            if (nextFavicon && favicon) favicon.href = nextFavicon;
        };

        updateTabAlert();
        const tabAlertTimer = window.setInterval(updateTabAlert, 650);

        return () => {
            window.clearInterval(tabAlertTimer);
            document.title = originalTitle;
            if (createdFavicon) favicon?.remove();
            else if (favicon) favicon.href = originalFavicon;
        };
    }, [activeRequestId, pendingRequest?.requestId]);

    useEffect(() => {
        if (!employee?._id) {
            cleanupLiveShare(true, "employee-left-crm");
            setPendingRequest(null);
            setStatus("");
            return;
        }

        const registerPresence = () => {
            socket.emit("presence:register", { userType: "employee", employeeId: employee._id, employeeName: employee.name });
        };
        const handleRequested = (payload: LiveShareRequest) => {
            if (payload.employeeId && payload.employeeId !== employee._id) return;
            setPendingRequest(payload);
            setStatus(`${payload.adminName || "An administrator"} requested Live View.`);
        };
        const handleSignal = async (payload: LiveShareSignal) => {
            if (!payload.requestId || payload.requestId !== requestIdRef.current || !peerRef.current) return;
            if (payload.description?.type === "answer") {
                await peerRef.current.setRemoteDescription(new RTCSessionDescription(payload.description));
                return;
            }
            if (payload.candidate) await peerRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
        };
        const handleStopped = (payload: { requestId?: string }) => {
            const currentRequestId = requestIdRef.current;
            if (payload.requestId && payload.requestId !== currentRequestId) return;
            cleanupLiveShare(false);
            setPendingRequest(null);
            setStatus("");
        };

        connectAuthenticatedSocket();
        socket.on("connect", registerPresence);
        socket.on("live-share:requested", handleRequested);
        socket.on("live-share:signal", handleSignal);
        socket.on("live-share:stopped", handleStopped);
        if (socket.connected) registerPresence();

        return () => {
            socket.off("connect", registerPresence);
            socket.off("live-share:requested", handleRequested);
            socket.off("live-share:signal", handleSignal);
            socket.off("live-share:stopped", handleStopped);
            cleanupLiveShare(true, "employee-left-crm");
        };
    }, [cleanupLiveShare, employee?._id, employee?.name]);

    const value = useMemo(() => ({
        status,
        activeRequestId,
        pendingRequest,
        startLiveShare,
        declineLiveShare,
        stopLiveShare,
    }), [activeRequestId, declineLiveShare, pendingRequest, startLiveShare, status, stopLiveShare]);

    return <LiveShareContext.Provider value={value}>{children}</LiveShareContext.Provider>;
}

export default function EmployeeLiveShare() {
    const location = useLocation();
    const liveShare = useContext(LiveShareContext);
    if (!liveShare) return null;

    const { status, activeRequestId, pendingRequest, startLiveShare, declineLiveShare, stopLiveShare } = liveShare;
    const isActive = Boolean(status && activeRequestId);
    const isPending = Boolean(pendingRequest?.requestId);
    if (location.pathname !== "/dashboard" && !isActive && !isPending) return null;

    if (isPending && pendingRequest) {
        return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="live-view-request-title">
                <div className="w-full max-w-md rounded-lg border border-violet-200 bg-white p-6 text-slate-900 shadow-2xl shadow-slate-950/35">
                    <span className="flex size-11 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
                        <FiMonitor className="size-5" aria-hidden="true" />
                    </span>
                    <h2 id="live-view-request-title" className="mt-4 text-xl font-semibold">Live View request</h2>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                        {pendingRequest.adminName || "An administrator"} is requesting permission to view your screen.
                    </p>
                    <div className="mt-6 flex items-center justify-end gap-2">
                        <button className="rounded-md px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-100" type="button" onClick={declineLiveShare}>
                            Decline
                        </button>
                        <button className="rounded-md bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-800" type="button" onClick={() => void startLiveShare(pendingRequest)} autoFocus>
                            Allow Live View
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="mb-4 flex w-full items-center gap-3 rounded-lg border border-violet-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
                <FiMonitor className="size-4" aria-hidden="true" />
            </span>
            <p className="min-w-0 flex-1 font-semibold">
                {isActive || isPending ? status : "Company Live View monitoring enabled."}
            </p>
            {isActive && (
                <button className="rounded-md px-2 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-50" type="button" onClick={stopLiveShare}>
                    Stop
                </button>
            )}
        </div>
    );
}
