import mongoose from "mongoose";
import { getBusinessById, runWithBusiness } from "../config/tenancy";
import { employeeCallingQueue, hydrateCallingQueue, type CallingEmployee } from "./employeeCallingQueue";

export async function prepareDeadlineQueue(employee: CallingEmployee, business: string, deadline: number) {
    const configured = getBusinessById(business); if (!configured) throw Error("CALL_PREPARATION_BUSINESS_UNAVAILABLE");
    const stream = mongoose.connection.getClient().db(configured.databaseName).collection("leads").watch([], {maxAwaitTimeMS: 1});
    let failed = false; stream.on("error", () => { failed = true; });
    const changed = async () => {
        let dirty = false;
        for (let count = 0; count < 1000; count++) {
            if (failed) throw Error("CALL_PREPARATION_UNVERIFIED");
            const event = await stream.tryNext(); if (!event) return dirty;
            const fields = event.operationType === "update" ? Object.keys(event.updateDescription.updatedFields || {}) : [];
            if (event.operationType !== "update" || event.updateDescription.removedFields?.length || fields.some(field => field !== "callingDispatchRevision")) dirty = true;
        }
        throw Error("CALL_PREPARATION_BUSY");
    };
    try {
        await changed();
        const load = () => runWithBusiness(business, async () => {
            const queue = await employeeCallingQueue(employee, business, new Date(Math.max(deadline, Date.now())), true);
            return {queue, page: await hydrateCallingQueue(queue, 1, 1)};
        });
        let current = await load();
        return {
            get queue() { return current.queue; },
            get lead() { return current.page.nextLead; },
            async refresh(force = false) {
                const due = current.queue.nextEligibilityChangeAt && Date.parse(current.queue.nextEligibilityChangeAt) <= Date.now();
                if (force || await changed() || due) { current = await load(); return true; }
                return false;
            },
            close: () => stream.close().catch(() => undefined),
        };
    } catch (error) { await stream.close().catch(() => undefined); throw error; }
}
