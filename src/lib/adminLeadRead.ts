export const ADMIN_LEAD_READ_TIMEOUT_MS = 15000;

export async function readAdminLeadRequest<T>(read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    let timer: number | undefined;
    let cancel: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        cancel = () => {
            reject(signal?.reason || new DOMException("Leads request cancelled.", "AbortError"));
            controller.abort(signal?.reason);
        };
        signal?.addEventListener("abort", cancel, {once: true});
        timer = window.setTimeout(() => {
            reject(Object.assign(new Error("Leads request timed out. Please try again."), {code: "ADMIN_LEAD_READ_TIMEOUT"}));
            controller.abort();
        }, ADMIN_LEAD_READ_TIMEOUT_MS);
    });
    // A stalled transport must not leave selection or pagination busy indefinitely.
    const request = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return read(controller.signal);
    });
    try {return await Promise.race([request, deadline]);}
    finally {
        window.clearTimeout(timer);
        if (cancel) signal?.removeEventListener("abort", cancel);
    }
}
