import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";

type Clock = { now: () => number; monotonic: () => number; pause: (ms: number) => Promise<unknown>;
    expire: (callback: () => void, ms: number) => () => void };
const defaultClock: Clock = { now: () => Date.now(), monotonic: () => performance.now(), pause,
    expire(callback, ms) { const timer = setTimeout(callback, ms); timer.unref?.(); return () => clearTimeout(timer); } };

export function createCallReadPriority(options: Partial<Clock> = {}) {
    const clock = { ...defaultClock, ...options }, entries = new Map<symbol, { deadline: number; until: number; cancel: () => void }>();
    const remove = (key: symbol) => { entries.get(key)?.cancel(); entries.delete(key); };
    return {
        reserve(deadline: number) {
            if (!Number.isFinite(deadline)) throw Error("INVALID_CALL_PRIORITY_DEADLINE");
            const key = Symbol(), until = deadline + 2500, entry = { deadline, until, cancel: () => {} };
            entries.set(key, entry);
            entry.cancel = clock.expire(() => remove(key), Math.max(0, until - clock.now()));
            let closed = false;
            return { close() {
                if (closed) return; closed = true;
                if (clock.now() < deadline || clock.now() >= until) remove(key);
            } };
        },
        async waitForReadBudget() {
            const started = clock.monotonic(); let waited = false;
            while (clock.monotonic() - started < 3000) {
                const now = clock.now(); let until = now;
                for (const [key, entry] of entries) {
                    if (entry.until <= now) { remove(key); continue; }
                    if (now >= entry.deadline - 750) until = Math.max(until, entry.until);
                }
                if (until <= now) break;
                waited = true;
                await clock.pause(Math.min(25, until - now, 3000 - (clock.monotonic() - started)));
            }
            return waited;
        },
        pendingCount: () => entries.size,
    };
}

// This affects only heavy display reads, never attendance actions or dial guards.
export const callReadPriority = createCallReadPriority();
