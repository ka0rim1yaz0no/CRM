type SoundDependencies = {
    context: () => AudioContext;
    storage: () => Pick<Storage, "getItem" | "setItem">;
    now?: () => number;
    exclusive?: (play: () => void) => Promise<void>;
};

const claimsKey = "crm:message-sound-claims";
const pendingLifetime = 30_000;

export function createMessageSoundPlayer(dependencies: SoundDependencies) {
    const now = dependencies.now || Date.now;
    const played = new Set<string>();
    const pending = new Map<string, number>();
    function schedule(context: AudioContext) {
        const start = context.currentTime + 0.02;
        for (const [frequency, offset, duration, peak, type] of [
            [784, 0, 0.22, 0.15, "triangle"], [1046.5, 0.14, 0.24, 0.17, "triangle"],
            [1318.5, 0.29, 0.27, 0.18, "triangle"], [1046.5, 0.5, 0.38, 0.16, "triangle"],
            [523.25, 0.5, 0.4, 0.08, "sine"],
        ] as const) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const at = start + offset;
            oscillator.type = type;
            oscillator.frequency.setValueAtTime(frequency, at);
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(peak, at + 0.025);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
            oscillator.connect(gain).connect(context.destination);
            oscillator.start(at);
            oscillator.stop(at + duration + 0.02);
        }
    }
    async function play(id: string) {
        let successful = false;
        try {
            const context = dependencies.context();
            if (context.state !== "running") await context.resume();
            if (context.state !== "running") return false;
            const claimAndPlay = () => {
                if (played.has(id) || !pending.has(id)) return;
                if (now() - pending.get(id)! > pendingLifetime) { pending.delete(id); return; }
                let claims: Array<[string, number]> = [];
                try {
                    const stored: unknown = JSON.parse(dependencies.storage().getItem(claimsKey) || "[]");
                    if (Array.isArray(stored)) claims = stored.filter((item): item is [string, number] =>
                        Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "number" && item[1] > now());
                } catch { /* Storage is optional; audio must still work when it is unavailable. */ }
                if (claims.some(([key]) => key === id)) { pending.delete(id); return; }
                schedule(context);
                played.add(id);
                if (played.size > 200) played.delete(played.values().next().value!);
                pending.delete(id);
                try { dependencies.storage().setItem(claimsKey, JSON.stringify([...claims.slice(-199), [id, now() + 3_600_000]])); } catch { /* Best-effort cross-tab deduplication. */ }
                successful = true;
            };
            if (dependencies.exclusive) await dependencies.exclusive(claimAndPlay);
            else claimAndPlay();
        } catch { /* Keep recent pending sounds for the next real user gesture. */ }
        return successful;
    }
    return {
        incoming(id: string) {
            if (!played.has(id) && !pending.has(id)) pending.set(id, now());
            if (pending.size > 20) pending.delete(pending.keys().next().value!);
            return play(id);
        },
        async unlock() {
            try {
                const context = dependencies.context();
                if (context.state !== "running") await context.resume();
                // One cue is enough for a burst received while audio was blocked.
                const latest = [...pending.entries()].at(-1);
                pending.clear();
                if (latest && now() - latest[1] <= pendingLifetime) { pending.set(...latest); await play(latest[0]); }
            } catch { /* A later gesture can retry. */ }
        },
        preview() { return this.incoming(`preview:${crypto.randomUUID()}`); },
    };
}

let context: AudioContext | null = null;
export const messageSound = createMessageSoundPlayer({
    context: () => { if (!context || context.state === "closed") context = new AudioContext(); return context; },
    storage: () => localStorage,
    exclusive: (play) => navigator.locks ? navigator.locks.request("crm-message-sound", play) : Promise.resolve().then(play),
});
