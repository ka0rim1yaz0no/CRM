import type { getMyLeads, MyLeadsPage } from "../api/leads";

type Params = Parameters<typeof getMyLeads>[0];
type ReadPage = (params: Params, signal?: AbortSignal) => Promise<MyLeadsPage>;
const WINDOW_PAGES = 20;

export async function readEmployeeLeadWindow(read: ReadPage, params: Params, pages: number, signal?: AbortSignal) {
    const lastPage = Math.max(1, Math.floor(Number.isFinite(pages) ? pages : 1));
    let combined: MyLeadsPage | undefined;
    for (let first = 1; first <= lastPage; first += WINDOW_PAGES) {
        signal?.throwIfAborted();
        const result = await read({...params, workspaceView: true, page: 1, windowStartPage: first,
            windowEndPage: Math.min(first + WINDOW_PAGES - 1, lastPage)}, signal);
        signal?.throwIfAborted();
        combined = {...result, leads: [...new Map([...(combined?.leads || []), ...result.leads].map(lead => [lead._id, lead])).values()]};
        if (!result.hasMore) break;
    }
    return combined!;
}
