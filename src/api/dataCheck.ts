import { api } from "../lib/api";
import { getActiveBusinessId } from "./businessStorage";
import type { DataCheckReport } from "../../shared/dataCheck";

export type DataCheckConfig = { enabled: boolean; navigationVisible: boolean; defaultDate?: string; serverTime?: string; businesses: Array<{ id: string; name: string }> };
export async function getDataCheckConfig(signal?: AbortSignal): Promise<DataCheckConfig> {
    const businessId = getActiveBusinessId();
    for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
            const response = await api.get<DataCheckConfig>("/admin/data-check/config", { signal, timeout: 8000,
                headers: businessId ? { "X-Business-Id": businessId } : undefined });
            return response.data;
        } catch (error) {
            if (attempt || signal?.aborted || (error as {response?: {status?: number}}).response?.status !== 503) throw error;
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 500);
                const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new DOMException("Request cancelled", "AbortError")); };
                signal?.addEventListener("abort", cancel, {once: true});
                if (signal?.aborted) cancel();
            });
        }
    }
}
export async function getDataCheck(date: string, business: string, signal?: AbortSignal): Promise<DataCheckReport> {
    const response = await api.get<DataCheckReport>("/admin/data-check", { params: { date, business }, signal, timeout: 35_000 });
    return response.data;
}
