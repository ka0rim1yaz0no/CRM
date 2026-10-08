export type VoiceCallTarget = { _id: string; name: string; role?: string };

export function startEmployeeVoiceCall(target: VoiceCallTarget) {
    window.dispatchEvent(new CustomEvent<VoiceCallTarget>("crm:voice-call:start", { detail: target }));
}
