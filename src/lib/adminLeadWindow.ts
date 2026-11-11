import type {AdminLeadsPage, getAdminLeads} from "../api/leads";

type Params = Parameters<typeof getAdminLeads>[0];
type ReadPage = (params: Params, signal?: AbortSignal) => Promise<AdminLeadsPage>;
export const ADMIN_LEAD_WINDOW_PAGES = 500;

export async function readAdminLeadWindow(read: ReadPage, params: Params, pages: number, signal?: AbortSignal) {
    const lastPage = Math.max(1, Math.floor(Number.isFinite(pages) ? pages : 1));
    let combined: AdminLeadsPage | undefined;
    for (let first = 1; first <= lastPage; first += ADMIN_LEAD_WINDOW_PAGES) {
        signal?.throwIfAborted();
        const result = await read({...params, page: 1, windowStartPage: first,
            windowEndPage: Math.min(first + ADMIN_LEAD_WINDOW_PAGES - 1, lastPage)}, signal);
        signal?.throwIfAborted();
        combined = {...result, leads: [...new Map([...(combined?.leads || []), ...result.leads].map(lead => [lead._id, lead])).values()]};
        if (!result.hasMore) break;
    }
    return combined!;
}
