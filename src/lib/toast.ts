import { createContext, useContext } from "react";

type ToastTone = "success" | "error" | "info";

export type ToastInput = {
    title?: string;
    message: string;
    tone?: ToastTone;
};

export type Toast = ToastInput & {
    id: string;
    tone: ToastTone;
};

type ToastContextValue = {
    showToast: (toast: ToastInput) => void;
};

export const ToastContext = createContext<ToastContextValue | null>(null);
export const toastListeners = new Set<(toast: ToastInput) => void>();

export function emitToast(toast: ToastInput) {
    toastListeners.forEach((listener) => listener(toast));
}

export function useToast() {
    const context = useContext(ToastContext);

    if (!context) {
        return { showToast: emitToast };
    }

    return context;
}
