export const CALLING_QUEUE_POLICY_VERSION = "2026-10-23-authoritative-queue-v7";
export const AUTO_CALL_COMMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type CallingPolicyLead = {
    _id?: unknown;
    status?: string;
    createdAt?: Date | string | null;
    followUpAt?: Date | string | null;
    comments?: Array<{ authorType?: string; createdAt?: Date | string | null }>;
};
export type CallingDecision = {
    callable: boolean;
    reason: "SCHEDULED_DUE" | "NEW" | "FOLLOW_UP" | "STATUS" | "INVALID_SCHEDULE" | "NOT_DUE" | "INVALID_COMMENT" | "COMMENT_COOLDOWN" | "DUPLICATE_PHONE" | "INVALID_PHONE" | "PHONE_IN_USE";
    priority: number;
    nextEligibleAt: string | null;
};
const time = (value: Date | string | null | undefined) => value ? new Date(value).getTime() : Number.NaN;

export function parseCallingSchedule(value: Date | string | null | undefined) {
    if (typeof value !== "string") return time(value);
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/);
    if (!match) return Number.NaN;
    const [, year, month, day, hour, minute, second = "0"] = match;
    const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
    if (calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() + 1 !== +month || calendar.getUTCDate() !== +day ||
        +hour > 23 || +minute > 59 || +second > 59) return Number.NaN;
    return time(value);
}

export function evaluateCallingLead(lead: CallingPolicyLead, now: Date): CallingDecision {
    const no = (reason: CallingDecision["reason"], at: number | null = null): CallingDecision => ({
        callable: false, reason, priority: 9, nextEligibleAt: at !== null && Number.isFinite(at) ? new Date(at).toISOString() : null,
    });
    if (lead.status !== "NEW" && lead.status !== "Follow up") return no("STATUS");
    const scheduled = lead.followUpAt !== null && lead.followUpAt !== undefined && String(lead.followUpAt).trim() !== "";
    const due = parseCallingSchedule(lead.followUpAt);
    if (scheduled && !Number.isFinite(due)) return no("INVALID_SCHEDULE");
    const comments = (lead.comments || []).filter(comment => comment.authorType === "employee");
    const times = comments.map(comment => time(comment.createdAt));
    if (times.some(value => !Number.isFinite(value))) return no("INVALID_COMMENT");
    const latest = times.length ? Math.max(...times) : null;
    const future = scheduled && due > +now;
    const qualifyingCallback = lead.status === "Follow up" && scheduled && (latest === null || latest < due);
    const commentUntil = latest === null || (qualifyingCallback && !future) ? 0 : latest + AUTO_CALL_COMMENT_COOLDOWN_MS;
    if (future) return no("NOT_DUE", qualifyingCallback ? due : Math.max(due, commentUntil));
    if (commentUntil > +now) return no("COMMENT_COOLDOWN", commentUntil);
    const reason = lead.status === "Follow up" && scheduled ? "SCHEDULED_DUE" : lead.status === "NEW" ? "NEW" : "FOLLOW_UP";
    return { callable: true, reason, priority: reason === "SCHEDULED_DUE" ? 0 : reason === "NEW" ? 1 : 2, nextEligibleAt: null };
}

export function compareCallingLeads(a: CallingPolicyLead, b: CallingPolicyLead, now: Date,
    first = evaluateCallingLead(a, now), second = evaluateCallingLead(b, now)) {
    if (first.priority !== second.priority) return first.priority - second.priority;
    if (first.reason === "SCHEDULED_DUE" && second.reason === "SCHEDULED_DUE") {
        const due = time(a.followUpAt) - time(b.followUpAt);
        if (due) return due;
    }
    const created = (time(b.createdAt) || 0) - (time(a.createdAt) || 0);
    return created || String(a._id || "").localeCompare(String(b._id || ""));
}

export function callingWindow(now: Date) {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "2-digit", hourCycle: "h23" }).format(now));
    const permitted = hour >= 23 || hour < 8;
    const untilStart = ((23 - hour + 24) % 24) * 3600000 - (now.getUTCMinutes() * 60000 + now.getUTCSeconds() * 1000 + now.getUTCMilliseconds());
    return { permitted, nextStartAt: permitted ? null : new Date(+now + untilStart).toISOString() };
}
