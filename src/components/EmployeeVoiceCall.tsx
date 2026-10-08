import { useCallback, useEffect, useRef, useState } from "react";
import { FiMic, FiMicOff, FiPhone, FiPhoneOff } from "react-icons/fi";
import { useLocation } from "react-router";
import { getAuthUser } from "../api/authStorage";
import { connectAuthenticatedSocket, socket } from "../lib/socket";

import type { VoiceCallTarget } from "../lib/voiceCall";

type VoiceCallSession = {
    callId: string;
    businessId: string;
    callerId: string;
    callerName: string;
    targetId: string;
    targetName: string;
};

type CallState = "idle" | "outgoing" | "incoming" | "connecting" | "connected" | "reconnecting" | "error";

const defaultIceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];

function configuredIceServers() {
    const turnUrl = String(import.meta.env.VITE_TURN_URL || "").trim();
    if (!turnUrl) return defaultIceServers;
    return [...defaultIceServers, {
        urls: turnUrl,
        username: String(import.meta.env.VITE_TURN_USERNAME || ""),
        credential: String(import.meta.env.VITE_TURN_CREDENTIAL || ""),
    }];
}

export default function EmployeeVoiceCall() {
    useLocation();
    const authUser = getAuthUser();
    const employee = authUser?.userType === "employee" ? authUser.user : null;
    const [callState, setCallState] = useState<CallState>("idle");
    const [session, setSession] = useState<VoiceCallSession | null>(null);
    const [target, setTarget] = useState<VoiceCallTarget | null>(null);
    const [status, setStatus] = useState("");
    const [muted, setMuted] = useState(false);
    const callStateRef = useRef<CallState>("idle");
    const sessionRef = useRef<VoiceCallSession | null>(null);
    const peerRef = useRef<RTCPeerConnection | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
    const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
    const ringTimerRef = useRef<number | null>(null);
    const callTimeoutRef = useRef<number | null>(null);

    const stopRing = useCallback(() => {
        if (ringTimerRef.current !== null) window.clearInterval(ringTimerRef.current);
        ringTimerRef.current = null;
    }, []);

    const playRingTone = useCallback((incoming: boolean) => {
        stopRing();
        const beep = () => {
            const AudioContextClass = window.AudioContext;
            if (!AudioContextClass) return;
            const context = new AudioContextClass();
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.frequency.value = incoming ? 720 : 440;
            gain.gain.setValueAtTime(0.08, context.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.22);
            oscillator.connect(gain).connect(context.destination);
            oscillator.start();
            oscillator.stop(context.currentTime + 0.24);
            oscillator.onended = () => void context.close();
        };
        beep();
        ringTimerRef.current = window.setInterval(beep, incoming ? 1600 : 2600);
    }, [stopRing]);

    const cleanUp = useCallback((nextStatus = "") => {
        stopRing();
        if (callTimeoutRef.current !== null) window.clearTimeout(callTimeoutRef.current);
        callTimeoutRef.current = null;
        peerRef.current?.close();
        peerRef.current = null;
        localStreamRef.current?.getTracks().forEach((track) => track.stop());
        localStreamRef.current = null;
        pendingCandidatesRef.current = [];
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
        setSession(null);
        sessionRef.current = null;
        setTarget(null);
        setMuted(false);
        setStatus(nextStatus);
        setCallState(nextStatus ? "error" : "idle");
        callStateRef.current = nextStatus ? "error" : "idle";
    }, [stopRing]);

    const ensureMicrophone = useCallback(async () => {
        if (localStreamRef.current) return localStreamRef.current;
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Voice calling is not supported by this browser.");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        localStreamRef.current = stream;
        return stream;
    }, []);

    const createPeer = useCallback(async (call: VoiceCallSession) => {
        if (peerRef.current) return peerRef.current;
        const stream = await ensureMicrophone();
        const peer = new RTCPeerConnection({ iceServers: configuredIceServers(), iceCandidatePoolSize: 4 });
        stream.getTracks().forEach((track) => peer.addTrack(track, stream));
        peer.onicecandidate = (event) => {
            if (event.candidate) socket.emit("voice-call:signal", { callId: call.callId, candidate: event.candidate.toJSON() });
        };
        peer.ontrack = (event) => {
            if (remoteAudioRef.current) {
                remoteAudioRef.current.srcObject = event.streams[0];
                void remoteAudioRef.current.play().catch(() => setStatus("Click the call panel to enable audio."));
            }
        };
        peer.onconnectionstatechange = () => {
            if (peer.connectionState === "connected") {
                stopRing();
                setCallState("connected");
                callStateRef.current = "connected";
                setStatus("Connected");
            } else if (peer.connectionState === "disconnected") {
                setCallState("reconnecting");
                callStateRef.current = "reconnecting";
                setStatus("Reconnecting...");
                window.setTimeout(async () => {
                    if (peer.connectionState !== "disconnected" || call.callerId !== employee?._id) return;
                    const offer = await peer.createOffer({ iceRestart: true });
                    await peer.setLocalDescription(offer);
                    socket.emit("voice-call:signal", { callId: call.callId, description: peer.localDescription });
                }, 1500);
            } else if (peer.connectionState === "failed") {
                socket.emit("voice-call:end", { callId: call.callId, reason: "connection-failed" });
                cleanUp("The call connection failed.");
            }
        };
        peerRef.current = peer;
        return peer;
    }, [cleanUp, employee?._id, ensureMicrophone, stopRing]);

    const endCall = useCallback((reason = "ended") => {
        if (session) socket.emit("voice-call:end", { callId: session.callId, reason });
        cleanUp();
    }, [cleanUp, session]);

    useEffect(() => {
        if (!employee) return;
        connectAuthenticatedSocket();

        const startCall = async (event: Event) => {
            const nextTarget = (event as CustomEvent<VoiceCallTarget>).detail;
            if (!nextTarget?._id || callStateRef.current !== "idle") return;
            const callId = crypto.randomUUID();
            const nextSession: VoiceCallSession = { callId, businessId: "", callerId: employee._id, callerName: employee.name, targetId: nextTarget._id, targetName: nextTarget.name };
            try {
                await ensureMicrophone();
                setTarget(nextTarget);
                setSession(nextSession);
                sessionRef.current = nextSession;
                setStatus(`Calling ${nextTarget.name}...`);
                setCallState("outgoing");
                callStateRef.current = "outgoing";
                playRingTone(false);
                socket.emit("voice-call:start", { callId, targetEmployeeId: nextTarget._id });
                callTimeoutRef.current = window.setTimeout(() => {
                    socket.emit("voice-call:end", { callId, reason: "no-answer" });
                    cleanUp("No answer.");
                }, 45_000);
            } catch (error) {
                cleanUp(error instanceof Error ? error.message : "Microphone access is required.");
            }
        };
        const incoming = (call: VoiceCallSession) => {
            if (callStateRef.current !== "idle") {
                socket.emit("voice-call:decline", { callId: call.callId, reason: "busy" });
                return;
            }
            setSession(call);
            sessionRef.current = call;
            setTarget({ _id: call.callerId, name: call.callerName });
            setStatus("Incoming voice call");
            setCallState("incoming");
            callStateRef.current = "incoming";
            playRingTone(true);
        };
        const accepted = async (call: VoiceCallSession) => {
            if (call.callId !== sessionRef.current?.callId) return;
            stopRing();
            setCallState("connecting");
            callStateRef.current = "connecting";
            setStatus("Connecting...");
            if (call.callerId !== employee._id) return;
            const peer = await createPeer(call);
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            socket.emit("voice-call:signal", { callId: call.callId, description: peer.localDescription });
        };
        const signal = async (payload: { callId: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) => {
            const activeSession = sessionRef.current;
            if (!activeSession || payload.callId !== activeSession.callId) return;
            const peer = await createPeer(activeSession);
            if (payload.description) {
                await peer.setRemoteDescription(payload.description);
                for (const candidate of pendingCandidatesRef.current.splice(0)) await peer.addIceCandidate(candidate);
                if (payload.description.type === "offer") {
                    const answer = await peer.createAnswer();
                    await peer.setLocalDescription(answer);
                    socket.emit("voice-call:signal", { callId: activeSession.callId, description: peer.localDescription });
                }
            } else if (payload.candidate) {
                if (peer.remoteDescription) await peer.addIceCandidate(payload.candidate);
                else pendingCandidatesRef.current.push(payload.candidate);
            }
        };
        const failed = (payload: { callId: string; message?: string; reason?: string }) => {
            if (payload.callId !== sessionRef.current?.callId) return;
            cleanUp(payload.message || (payload.reason === "busy" ? "Employee is busy." : "Call declined."));
        };
        const ended = (payload: { callId: string; reason?: string }) => {
            if (payload.callId !== sessionRef.current?.callId) return;
            cleanUp(payload.reason === "disconnected"
                ? "The other employee disconnected."
                : payload.reason === "answered-on-another-tab" ? "Answered in another CRM tab." : "");
        };

        window.addEventListener("crm:voice-call:start", startCall);
        socket.on("voice-call:incoming", incoming);
        socket.on("voice-call:accepted", accepted);
        socket.on("voice-call:signal", signal);
        socket.on("voice-call:busy", failed);
        socket.on("voice-call:unavailable", failed);
        socket.on("voice-call:declined", failed);
        socket.on("voice-call:ended", ended);
        return () => {
            window.removeEventListener("crm:voice-call:start", startCall);
            socket.off("voice-call:incoming", incoming);
            socket.off("voice-call:accepted", accepted);
            socket.off("voice-call:signal", signal);
            socket.off("voice-call:busy", failed);
            socket.off("voice-call:unavailable", failed);
            socket.off("voice-call:declined", failed);
            socket.off("voice-call:ended", ended);
        };
    }, [cleanUp, createPeer, employee, ensureMicrophone, playRingTone, stopRing]);

    const acceptCall = async () => {
        if (!session) return;
        try {
            await createPeer(session);
            setCallState("connecting");
            callStateRef.current = "connecting";
            setStatus("Connecting...");
            stopRing();
            socket.emit("voice-call:accept", { callId: session.callId });
        } catch (error) {
            socket.emit("voice-call:decline", { callId: session.callId, reason: "microphone-denied" });
            cleanUp(error instanceof Error ? error.message : "Microphone access is required.");
        }
    };

    const toggleMute = () => {
        const nextMuted = !muted;
        localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
        setMuted(nextMuted);
    };

    if (!employee || callState === "idle") return <audio ref={remoteAudioRef} autoPlay />;

    return (
        <div className="fixed bottom-5 right-5 z-[90] w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-slate-200 bg-white p-4 text-slate-950 shadow-2xl" onClick={() => void remoteAudioRef.current?.play()}>
            <audio ref={remoteAudioRef} autoPlay />
            <div className="flex items-center gap-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-full bg-[#0084ff] text-white"><FiPhone className="size-5" /></span>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{target?.name || "Employee"}</p><p className="mt-1 text-xs text-slate-500">{status}</p></div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
                {callState === "incoming" ? (
                    <>
                        <button className="h-10 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50" type="button" onClick={() => { socket.emit("voice-call:decline", { callId: session?.callId, reason: "declined" }); cleanUp(); }}>Decline</button>
                        <button className="h-10 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-white hover:bg-emerald-600" type="button" onClick={acceptCall}>Accept</button>
                    </>
                ) : (
                    <>
                        {(callState === "connected" || callState === "reconnecting") && <button className="grid size-10 place-items-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50" type="button" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}>{muted ? <FiMicOff /> : <FiMic />}</button>}
                        <button className="inline-flex h-10 items-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700" type="button" onClick={() => endCall()}><FiPhoneOff /> End</button>
                    </>
                )}
            </div>
        </div>
    );
}
