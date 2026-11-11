type Confirmation = { revision: number; serverTime: string; state: string };
type AttendanceSnapshot = Confirmation & { stateSince?: string | null; coachingBilling?: { active: { startedAt: string } | null } | null };
type Hold = { id: string; until: number };
type Gate = { generation: string; pending: Hold[]; confirmed?: Confirmation & { coaching?: boolean }; verified: boolean };
const memory = new Map<string, Gate>();
const unpersisted = new Set<string>();
const prefix = "crm:calling-attendance:v1:";
export const callingAttendanceChanged = "crm:calling-attendance-changed";

function read(code: string): Gate {
    let value = memory.get(code);
    try {
        const stored = unpersisted.has(code) ? null : JSON.parse(window.localStorage.getItem(prefix + code) || "null") as Gate | null;
        if (stored && typeof stored.generation === "string" && Array.isArray(stored.pending) &&
            (!value || value.generation !== stored.generation || !value.confirmed || !stored.confirmed ||
                value.confirmed.revision < stored.confirmed.revision || value.confirmed.serverTime < stored.confirmed.serverTime)) value = stored;
    } catch { /* The in-memory hold still protects this tab when storage is unavailable. */ }
    return value ? { ...value, pending: [...value.pending], confirmed: value.confirmed ? { ...value.confirmed } : undefined }
        : { generation: "", pending: [], verified: true };
}
const signature = (value: Gate) => JSON.stringify([value.generation, value.pending, value.verified, value.confirmed?.revision, value.confirmed?.state, value.confirmed?.coaching]);
function write(code: string, value: Gate) {
    const changed = signature(read(code)) !== signature(value);
    memory.set(code, value);
    if (changed) {
        try { window.localStorage.setItem(prefix + code, JSON.stringify(value)); unpersisted.delete(code); }
        catch { unpersisted.add(code); }
        window.dispatchEvent(new Event(callingAttendanceChanged));
    }
}
function confirm(value: Gate, snapshot: AttendanceSnapshot) {
    if (!value.confirmed || snapshot.revision > value.confirmed.revision ||
        snapshot.revision === value.confirmed.revision && snapshot.serverTime >= value.confirmed.serverTime) {
        const coaching = snapshot.state === "OFF THE PHONE" && Boolean(snapshot.stateSince) &&
            snapshot.coachingBilling?.active?.startedAt === snapshot.stateSince;
        value.confirmed = { revision: snapshot.revision, serverTime: snapshot.serverTime, state: snapshot.state, coaching };
        value.verified = true;
    }
}
export const callingAttendanceGeneration = (code: string) => read(code).generation;
export function observeCallingAttendance(code: string, snapshot: AttendanceSnapshot, generation: string) {
    const value = read(code);
    if (value.generation !== generation) return;
    value.pending = value.pending.filter(hold => hold.until > Date.now());
    confirm(value, snapshot); write(code, value);
}
export function beginCallingAttendanceUpdate(code: string) {
    const id = crypto.randomUUID(), value = read(code);
    value.generation = id;
    value.pending = [...value.pending.filter(hold => hold.until > Date.now()), { id, until: Date.now() + 60000 }];
    write(code, value);
    return (snapshot?: AttendanceSnapshot) => {
        const current = read(code);
        current.generation = crypto.randomUUID();
        current.pending = current.pending.filter(hold => hold.id !== id && hold.until > Date.now());
        if (snapshot) confirm(current, snapshot); else current.verified = false;
        write(code, current);
    };
}
export function callingAttendancePending(code: string) {
    return read(code).pending.some(hold => hold.until > Date.now());
}
export function callingAttendanceBlock(code: string, intent: "automatic" | "manual" = "automatic") {
    const value = read(code);
    if (value.pending.some(hold => hold.until > Date.now())) return "Saving attendance";
    if (!value.verified || value.pending.length) return "Checking attendance";
    if (!value.confirmed || value.confirmed.state === "ONLINE") return "";
    if (value.confirmed.state === "OFF THE PHONE" && value.confirmed.coaching === true) {
        return intent === "manual" ? "" : "Auto Call paused during Coaching";
    }
    return intent === "manual" ? "Manual calling requires Online or Coaching attendance" : "Employee not ONLINE";
}
