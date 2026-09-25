import { useEffect, useRef, useState } from "react";
import { FiMonitor } from "react-icons/fi";
import { getAuthUser } from "../api/authStorage";
import { socket } from "../lib/socket";

type LiveShareRequest = {
    requestId: string;
    employeeId?: string;
    employeeName?: string;
    adminName?: string;
    requestedAt?: string;
};

type LiveShareSignal = {
    requestId?: string;
    description?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
};

const rtcConfig: RTCConfiguration = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

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

export default function EmployeeLiveShare() {
    const [status, setStatus] = useState("");
    const [activeRequestId, setActiveRequestId] = useState("");
    const peerRef = useRef<RTCPeerConnection | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const requestIdRef = useRef("");

    const cleanupLiveShare = (notify = false, reason = "employee-stopped") => {
        const requestId = requestIdRef.current;

        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        peerRef.current?.close();
        peerRef.current = null;
        requestIdRef.current = "";
        setActiveRequestId("");

        if (notify && requestId) {
            socket.emit("live-share:stop", { requestId, reason });
        }
    };

    const stopLiveShare = () => {
        cleanupLiveShare(true, "employee-stopped");
        setStatus("");
    };

    const startLiveShare = async (request: LiveShareRequest) => {
        if (!request.requestId) {
            return;
        }

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
                    socket.emit("live-share:signal", {
                        requestId,
                        candidate: event.candidate.toJSON(),
                    });
                }
            };
            peer.onconnectionstatechange = () => {
                if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
                    cleanupLiveShare(true, peer.connectionState);
                    setStatus("");
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

            setStatus("Entire-screen live share is active.");
        } catch (error) {
            cleanupLiveShare(false);
            socket.emit("live-share:decline", {
                requestId,
                reason: error instanceof Error ? error.message : "permission-denied",
            });
            setStatus("");
        }
    };

    useEffect(() => {
        const authUser = getAuthUser();
        const employee = authUser?.userType === "employee" ? authUser.user : null;

        if (!employee?._id) {
            return;
        }

        const registerPresence = () => {
            socket.emit("presence:register", {
                userType: "employee",
                employeeId: employee._id,
                employeeName: employee.name,
            });
        };
        const handleRequested = (payload: LiveShareRequest) => {
            if (payload.employeeId && payload.employeeId !== employee._id) {
                return;
            }

            void startLiveShare(payload);
        };
        const handleSignal = async (payload: LiveShareSignal) => {
            if (!payload.requestId || payload.requestId !== requestIdRef.current || !peerRef.current) {
                return;
            }

            if (payload.description?.type === "answer") {
                await peerRef.current.setRemoteDescription(new RTCSessionDescription(payload.description));
                return;
            }

            if (payload.candidate) {
                await peerRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
            }
        };
        const handleStopped = (payload: { requestId?: string }) => {
            const currentRequestId = requestIdRef.current;

            if (payload.requestId && payload.requestId !== currentRequestId) {
                return;
            }

            cleanupLiveShare(false);
            setStatus("");
        };

        socket.connect();
        socket.on("connect", registerPresence);
        socket.on("live-share:requested", handleRequested);
        socket.on("live-share:signal", handleSignal);
        socket.on("live-share:stopped", handleStopped);
        if (socket.connected) {
            registerPresence();
        }

        return () => {
            socket.off("connect", registerPresence);
            socket.off("live-share:requested", handleRequested);
            socket.off("live-share:signal", handleSignal);
            socket.off("live-share:stopped", handleStopped);
            cleanupLiveShare(true, "employee-left-crm");
        };
    }, []);

    return (
        <>
            {status && activeRequestId && (
                <div className="fixed bottom-4 right-4 z-[60] flex max-w-sm items-center gap-3 rounded-lg border border-violet-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-xl shadow-slate-950/15">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
                        <FiMonitor className="size-4" aria-hidden="true" />
                    </span>
                    <p className="min-w-0 flex-1 font-semibold">{status}</p>
                    <button className="rounded-md px-2 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-50" type="button" onClick={stopLiveShare}>
                        Stop
                    </button>
                </div>
            )}
        </>
    );
}
