export const AUTO_CALL_MIN_INTERVAL_MS = 30 * 1000;
export const AUTO_CALL_CHECK_INTERVAL_MS = 5 * 1000;
export const AUTO_CALL_API_TIMEOUT_MS = 10 * 1000;
export const AUTO_CALL_CONFIRM_TIMEOUT_MS = 30 * 1000;
export const AUTO_CALL_CONFIRM_POLL_MS = 2 * 1000;
export const AUTO_CALL_FAILURE_COOLDOWN_MS = 30 * 60 * 1000;
export const AUTO_CALL_COMMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const AUTO_CALL_START_HOUR_PH = 23;
export const AUTO_CALL_END_HOUR_PH = 8;

const AUTO_CALL_PENDING_COMMENT_PREFIX = "crm:employee-auto-call-pending-comment-v2";
const LEGACY_AUTO_CALL_PENDING_COMMENT_PREFIX = "crm:employee-auto-call-pending-comment";

export type AutoCallPendingComment = {
    leadId: string;
    baselineCommentMarker: string;
};

type EmployeeCommentMarkerInput = {
    _id?: string;
    authorName?: string;
    authorType?: string;
    body?: string;
    createdAt?: string;
};

type AutoCallEligibilityLead = {
    status?: string;
    followUpAt?: string | Date | null;
    comments?: EmployeeCommentMarkerInput[];
    callsByEmployee?: Array<{
        employeeName?: string;
        lastCallAt?: string | Date | null;
    }>;
};

function getPendingCommentStorageKey(employeeCode: string) {
    return `${AUTO_CALL_PENDING_COMMENT_PREFIX}:${employeeCode.trim()}`;
}

export function getAutoCallPendingComment(employeeCode: string): AutoCallPendingComment | null {
    if (typeof window === "undefined" || !employeeCode.trim()) {
        return null;
    }

    const storageKey = getPendingCommentStorageKey(employeeCode);

    try {
        window.localStorage.removeItem(`${LEGACY_AUTO_CALL_PENDING_COMMENT_PREFIX}:${employeeCode.trim()}`);
        const storedValue = JSON.parse(window.localStorage.getItem(storageKey) || "null") as Partial<AutoCallPendingComment> | null;
        const leadId = String(storedValue?.leadId || "").trim();
        const baselineCommentMarker = String(storedValue?.baselineCommentMarker || "");

        if (leadId) {
            return { leadId, baselineCommentMarker };
        }

        window.localStorage.removeItem(storageKey);
    } catch {
        try {
            window.localStorage.removeItem(storageKey);
        } catch {
            // A blocked storage read/write leaves auto-call behavior unchanged.
        }
    }

    return null;
}

export function getEmployeeCommentMarker(comments: EmployeeCommentMarkerInput[] = []) {
    const latestEmployeeComment = comments
        .filter((comment) => comment.authorType === "employee")
        .sort((first, second) => new Date(first.createdAt || 0).getTime() - new Date(second.createdAt || 0).getTime())
        .at(-1);

    if (!latestEmployeeComment) {
        return "";
    }

    return [latestEmployeeComment._id, latestEmployeeComment.createdAt, latestEmployeeComment.body]
        .map((value) => String(value || "").trim())
        .join("|");
}

export function isLeadEligibleForAutoCall(
    lead: AutoCallEligibilityLead,
    now = new Date(),
    employeeNames: string[] = []
) {
    if (lead.status !== "NEW" && lead.status !== "Follow up") {
        return false;
    }

    const followUpTime = new Date(lead.followUpAt || "").getTime();

    if (Number.isFinite(followUpTime) && followUpTime > now.getTime()) {
        return false;
    }

    const normalizedEmployeeNames = new Set(
        employeeNames.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean)
    );
    const matchingComments = (lead.comments || []).filter((comment) =>
        comment.authorType === "employee" && (
            normalizedEmployeeNames.size === 0 ||
            normalizedEmployeeNames.has(String(comment.authorName || "").trim().toLowerCase())
        )
    );
    const commentTimes = matchingComments
        .map((comment) => new Date(comment.createdAt || "").getTime())
        .filter(Number.isFinite);

    if (commentTimes.length === 0) {
        return matchingComments.length === 0;
    }

    if (matchingComments.some((comment) => !Number.isFinite(new Date(comment.createdAt || "").getTime()))) {
        return false;
    }

    const latestCommentTime = Math.max(...commentTimes);
    if (
        lead.status === "Follow up" &&
        Number.isFinite(followUpTime) &&
        followUpTime <= now.getTime() &&
        latestCommentTime < followUpTime
    ) {
        return true;
    }

    return latestCommentTime <= now.getTime() - AUTO_CALL_COMMENT_COOLDOWN_MS;
}

export function startAutoCallPendingComment(employeeCode: string, leadId: string, baselineCommentMarker = "") {
    if (typeof window === "undefined" || !employeeCode.trim() || !leadId.trim()) {
        return;
    }

    const activePendingComment = getAutoCallPendingComment(employeeCode);
    const pendingComment: AutoCallPendingComment = {
        leadId: leadId.trim(),
        baselineCommentMarker:
            activePendingComment?.leadId === leadId.trim()
                ? activePendingComment.baselineCommentMarker
                : baselineCommentMarker,
    };

    try {
        window.localStorage.setItem(getPendingCommentStorageKey(employeeCode), JSON.stringify(pendingComment));
    } catch {
        // A blocked storage write must not prevent the requested call.
    }
}

export function clearAutoCallPendingComment(employeeCode: string, leadId?: string) {
    if (typeof window === "undefined" || !employeeCode.trim()) {
        return;
    }

    const storageKey = getPendingCommentStorageKey(employeeCode);

    if (leadId) {
        const activePendingComment = getAutoCallPendingComment(employeeCode);

        if (activePendingComment && activePendingComment.leadId !== leadId) {
            return;
        }
    }

    try {
        window.localStorage.removeItem(storageKey);
    } catch {
        // A later successful comment can retry clearing the pending lead.
    }
}

export function isSalesRole(role?: string) {
    return String(role || "").trim().toLowerCase().includes("sales");
}

function getPhilippineDateParts(now = new Date()) {
    const dateParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
    }).formatToParts(now);

    return Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
}

export function isWithinAutoCallWindow(now = new Date()) {
    const currentHour = Number(getPhilippineDateParts(now).hour);
    return currentHour >= AUTO_CALL_START_HOUR_PH || currentHour < AUTO_CALL_END_HOUR_PH;
}

export function millisecondsUntilAutoCallWindowStart(now = new Date()) {
    if (isWithinAutoCallWindow(now)) {
        return 0;
    }

    const valueByPart = getPhilippineDateParts(now);
    const startAt = Date.UTC(
        Number(valueByPart.year),
        Number(valueByPart.month) - 1,
        Number(valueByPart.day),
        AUTO_CALL_START_HOUR_PH - 8
    );

    return Math.max(0, startAt - now.getTime());
}

export function millisecondsUntilNextPhilippineDay(now = new Date()) {
    const valueByPart = getPhilippineDateParts(now);
    const nextDayAt = Date.UTC(
        Number(valueByPart.year),
        Number(valueByPart.month) - 1,
        Number(valueByPart.day) + 1
    ) - (8 * 60 * 60 * 1000);

    return Math.max(0, nextDayAt - now.getTime());
}
