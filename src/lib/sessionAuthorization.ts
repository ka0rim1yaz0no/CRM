import type { AuthUser } from "../api/authStorage";

type ApiFailure = { response?: { status?: number; data?: { code?: string; message?: string } };
    config?: { url?: string; headers?: unknown } };

function header(headers: unknown, name: string) {
    if (!headers || typeof headers !== "object") return "";
    const getter = (headers as { get?: (name: string) => unknown }).get;
    const value = typeof getter === "function" ? getter.call(headers, name)
        : Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    return typeof value === "string" ? value : "";
}

export function shouldExpireCrmSession(error: unknown, auth: AuthUser | null) {
    const failure = error as ApiFailure | undefined;
    if (!auth || failure?.response?.status !== 401 || /(?:^|\/)auth\/login(?:[?#]|$)/.test(failure.config?.url || "")) return false;
    const body = failure.response.data;
    // Older servers use the same messages; unrelated integration/login errors are not session expiry.
    if (body?.code !== "CRM_SESSION_REQUIRED" && !["Sign in again. A signed CRM session is required.", "A signed CRM session is required."]
        .includes(body?.message || "")) return false;
    const token = auth.userType === "admin" && auth.sessionToken ? auth.sessionToken : auth.attendanceHubSession;
    const tokenHeader = auth.userType === "admin" && auth.sessionToken ? "X-CRM-Admin-Session" : "X-CRM-Attendance-Session";
    const sentCode = header(failure.config?.headers, "X-CRM-User-Code");
    if (sentCode && sentCode !== auth.user.employeeCode) return false;
    if (token) return header(failure.config?.headers, tokenHeader) === token;
    return sentCode === auth.user.employeeCode && !header(failure.config?.headers, "X-CRM-Admin-Session") && !header(failure.config?.headers, "X-CRM-Attendance-Session");
}

export function retryAuthorizedQuery(failureCount: number, error: unknown) {
    const status = (error as ApiFailure | undefined)?.response?.status;
    return status !== 401 && status !== 403 && failureCount < 1;
}
