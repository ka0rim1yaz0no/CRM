import type { QueryClient } from "@tanstack/react-query";
import { getAuthUser } from "../api/authStorage";

export function registerSessionInvalidation(client: Pick<QueryClient, "cancelQueries" | "clear">, disconnect: () => void) {
    let hadSession = Boolean(getAuthUser());
    const changed = () => {
        const hasSession = Boolean(getAuthUser());
        if (hadSession && !hasSession) {
            void client.cancelQueries().catch(() => undefined);
            client.clear();
            disconnect();
        }
        hadSession = hasSession;
    };
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === "authUser") changed(); };
    window.addEventListener("crm:auth-changed", changed);
    window.addEventListener("storage", storage);
    return () => {
        window.removeEventListener("crm:auth-changed", changed);
        window.removeEventListener("storage", storage);
    };
}
