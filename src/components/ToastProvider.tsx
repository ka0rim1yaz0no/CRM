import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FiAlertCircle, FiCheckCircle, FiInfo, FiX } from "react-icons/fi";
import { ToastContext, toastListeners, type Toast, type ToastInput } from "../lib/toast";

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const dismissToast = useCallback((id: string) => {
        setToasts((currentToasts) => currentToasts.filter((toast) => toast.id !== id));
    }, []);

    const showToast = useCallback((toast: ToastInput) => {
        const nextToast: Toast = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            tone: toast.tone || "info",
            title: toast.title,
            message: toast.message,
        };

        setToasts((currentToasts) => {
            const isDuplicate = currentToasts.some(
                (currentToast) => currentToast.message === nextToast.message && currentToast.tone === nextToast.tone
            );
            if (isDuplicate) return currentToasts;
            return [...currentToasts.slice(-3), nextToast];
        });
    }, []);

    useEffect(() => {
        toastListeners.add(showToast);
        return () => {
            toastListeners.delete(showToast);
        };
    }, [showToast]);

    useEffect(() => {
        if (!toasts.length) return undefined;

        const oldestToast = toasts[0];
        const timeoutId = window.setTimeout(() => dismissToast(oldestToast.id), 3200);
        return () => window.clearTimeout(timeoutId);
    }, [dismissToast, toasts]);

    const value = useMemo(() => ({ showToast }), [showToast]);

    return (
        <ToastContext.Provider value={value}>
            {children}
            <div className="pointer-events-none fixed right-4 top-4 z-[9999] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
                {toasts.map((toast) => {
                    const isSuccess = toast.tone === "success";
                    const isError = toast.tone === "error";
                    const Icon = isSuccess ? FiCheckCircle : isError ? FiAlertCircle : FiInfo;

                    return (
                        <div
                            key={toast.id}
                            className={[
                                "theme-toast pointer-events-auto flex items-start gap-3 rounded-lg border px-3.5 py-3 shadow-2xl shadow-black/35 backdrop-blur-xl",
                                isSuccess ? "theme-toast-success" : isError ? "theme-toast-error" : "theme-toast-info",
                            ].join(" ")}
                            role="status"
                        >
                            <span
                                className="theme-toast-icon mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border"
                                aria-hidden="true"
                            >
                                <Icon className="size-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                {toast.title && <p className="text-sm font-semibold text-current">{toast.title}</p>}
                                <p className="text-sm font-medium leading-5 text-current/90">{toast.message}</p>
                            </div>
                            <button
                                className="flex size-7 shrink-0 items-center justify-center rounded-md text-current/55 transition hover:bg-white/10 hover:text-current"
                                type="button"
                                onClick={() => dismissToast(toast.id)}
                                aria-label="Dismiss notification"
                            >
                                <FiX className="size-4" />
                            </button>
                        </div>
                    );
                })}
            </div>
        </ToastContext.Provider>
    );
}
