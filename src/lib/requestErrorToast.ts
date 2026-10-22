import { emitToast } from "./toast";

const reportedErrors = new WeakSet<object>();

export function reportRequestError(error: unknown, fallback: string) {
    if (error && typeof error === "object") {
        if (reportedErrors.has(error)) return;
        reportedErrors.add(error);
    }
    const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
    emitToast({ tone: "error", message: typeof message === "string" && message.trim() ? message : fallback });
}

export function reportSessionExpiry(error: object) {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
    emitToast({ tone: "error", message: "Your session has expired. Sign in again to continue." });
}
