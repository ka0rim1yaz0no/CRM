import { api } from "../lib/api";
import type { DataCheckReport } from "../../shared/dataCheck";

export type DataCheckConfig = { enabled: boolean; navigationVisible: boolean; defaultDate?: string; serverTime?: string; businesses: Array<{ id: string; name: string }> };
export async function getDataCheckConfig(signal?: AbortSignal): Promise<DataCheckConfig> {
    const response = await api.get<DataCheckConfig>("/admin/data-check/config", { signal, timeout: 8000 });
    return response.data;
}
export async function getDataCheck(date: string, business: string, signal?: AbortSignal): Promise<DataCheckReport> {
    const response = await api.get<DataCheckReport>("/admin/data-check", { params: { date, business }, signal, timeout: 35_000 });
    return response.data;
}
