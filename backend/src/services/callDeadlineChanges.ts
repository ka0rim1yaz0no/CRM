type LeadChange = { operationType: string; updateDescription?: { updatedFields?: Record<string, unknown>; removedFields?: string[] } };
type LeadChanges = { tryNext(): Promise<LeadChange | null>; on(event: "error", listener: () => void): unknown; close(): Promise<unknown> };
type Feed = { stream: LeadChanges; users: number; revision: number; failed: boolean; checking?: Promise<number> };

export function deadlineChangeFeeds(open: (business: string) => LeadChanges) {
    const feeds = new Map<string, Feed>();
    return {
        acquire(business: string) {
            let feed = feeds.get(business);
            if (!feed) {
                feed = { stream: open(business), users: 0, revision: 0, failed: false };
                const created = feed;
                created.stream.on("error", () => { created.failed = true; });
                feeds.set(business, feed);
            }
            const current = feed;
            current.users++;
            let closed = false;
            return {
                async poll() {
                    if (closed || current.failed) throw Error("CALL_PREPARATION_UNVERIFIED");
                    // Share only an unfinished cursor read. Every plan retains its
                    // own revision and must poll again before authorization.
                    current.checking ??= (async () => {
                        for (let count = 0; count < 1000; count++) {
                            if (current.failed) throw Error("CALL_PREPARATION_UNVERIFIED");
                            const event = await current.stream.tryNext();
                            if (current.failed) throw Error("CALL_PREPARATION_UNVERIFIED");
                            if (!event) return current.revision;
                            const fields = event.operationType === "update" ? Object.keys(event.updateDescription?.updatedFields || {}) : [];
                            if (event.operationType !== "update" || event.updateDescription?.removedFields?.length ||
                                fields.some(field => field !== "callingDispatchRevision")) current.revision++;
                        }
                        throw Error("CALL_PREPARATION_BUSY");
                    })().catch(error => { current.failed = true; throw error; }).finally(() => { current.checking = undefined; });
                    const revision = await current.checking;
                    if (closed || current.failed) throw Error("CALL_PREPARATION_UNVERIFIED");
                    return revision;
                },
                async close() {
                    if (closed) return;
                    closed = true;
                    if (--current.users) return;
                    if (feeds.get(business) === current) feeds.delete(business);
                    await current.stream.close().catch(() => undefined);
                },
            };
        },
    };
}
