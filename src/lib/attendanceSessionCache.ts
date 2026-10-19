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
