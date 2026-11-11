export function attendanceSessionCacheKey(identity: string, businessId: string, employeeId: string) {
    return JSON.stringify([identity, businessId, employeeId]);
}

export function retainAttendanceSnapshot<T extends { revision: number; serverTime: string; receivedAt: number;
    allowances?: { breakMinutes: number; lunchMinutes: number } }>(cache: Map<string, T>, key: string,
    snapshot: T, receivedAt = Date.now()) {
    const current = cache.get(key);
    if (!current || snapshot.revision > current.revision ||
        (snapshot.revision === current.revision && snapshot.serverTime >= current.serverTime)) {
        cache.set(key, { ...current, ...snapshot, receivedAt, allowances: snapshot.allowances || current?.allowances });
    }
    return cache.get(key)!;
}
import type { AttendanceSessionSnapshot } from "../api/attendanceSession";


export function mergeAttendanceHistory(previous: AttendanceSessionSnapshot | undefined, incoming: AttendanceSessionSnapshot): AttendanceSessionSnapshot | null {
    if (incoming.historyIncluded !== false) return incoming;
    if (!previous || previous.historyIncluded === false || incoming.statusOnly || typeof previous.policyRevision !== "number" || previous.revision !== incoming.revision ||
        previous.fingerprint !== incoming.fingerprint || previous.policyRevision !== incoming.policyRevision ||
        (previous.policyFingerprint !== undefined && incoming.policyFingerprint !== undefined && previous.policyFingerprint !== incoming.policyFingerprint) ||
        (previous.policyRevision === 0 && (!previous.policyFingerprint || previous.policyFingerprint !== incoming.policyFingerprint)) ||
        !Array.isArray(incoming.changedDayKeys) || !Array.isArray(incoming.dashboardDays)) return null;
    const sessions = new Map(previous.sessions.map(session => [session.id, session]));
    if (incoming.sessions.length !== sessions.size || incoming.sessions.some(session => !sessions.has(session.id))) return null;
    const changed = new Set(incoming.changedDayKeys);
    if (changed.size !== incoming.dashboardDays.length || new Set(incoming.dashboardDays.map(day => day.dayKey)).size !== changed.size ||
        incoming.dashboardDays.some(day => !changed.has(day.dayKey) || !previous.dashboardDays?.some(old => old.dayKey === day.dayKey))) return null;
    const days = new Map((previous.dashboardDays || []).filter(day => !changed.has(day.dayKey)).map(day => [day.dayKey, day]));
    for (const day of incoming.dashboardDays) days.set(day.dayKey, day);
    return { ...previous, ...incoming, historyIncluded: true, records: previous.records, audit: previous.audit,
        sessions: incoming.sessions.map(session => ({ ...sessions.get(session.id)!, ...session,
            events: sessions.get(session.id)!.events, time: session.time ?? sessions.get(session.id)!.time })),
        dashboardDays: [...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey)) };
}
