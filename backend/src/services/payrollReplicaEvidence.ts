type EvidenceEvent = { eventId?: string; source: string; timeIn: Date; dayKey: string };
type ReplicaEvent = { eventId?: string; source: string; timeIn: Date };

// Synchronization retains the complete effective history, including reviewed
// legacy events that the session projection does not use for time accounting.
export function payrollReplicaMismatchDays(expected: EvidenceEvent[], copies: ReplicaEvent[], keys: string[], fallbackDay: (at: Date) => string) {
    const days = new Set(keys), expectedByDay = new Map<string, string[]>(), copiesByDay = new Map<string, string[]>();
    const eventDays = new Map(expected.filter(event => event.eventId).map(event => [event.eventId!, event.dayKey]));
    const token = (event: ReplicaEvent) => JSON.stringify([event.source, event.timeIn.toISOString()]);
    for (const event of expected) if (days.has(event.dayKey)) {
        const group = expectedByDay.get(event.dayKey) || []; group.push(token(event)); expectedByDay.set(event.dayKey, group);
    }
    for (const event of copies) {
        const key = event.eventId && eventDays.get(event.eventId) || fallbackDay(event.timeIn);
        if (!days.has(key)) continue;
        const group = copiesByDay.get(key) || []; group.push(token(event)); copiesByDay.set(key, group);
    }
    return keys.filter(key => JSON.stringify((expectedByDay.get(key) || []).sort()) !== JSON.stringify((copiesByDay.get(key) || []).sort()));
}
