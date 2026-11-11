import mongoose from "mongoose";
import { getBusinessById, runWithBusiness } from "../config/tenancy";
import { employeeCallingQueue, hydrateCallingQueue, type CallingEmployee } from "./employeeCallingQueue";
import { deadlineChangeFeeds } from "./callDeadlineChanges";
import { callReadPriority } from "./callReadPriority";

const changes = deadlineChangeFeeds(database => mongoose.connection.getClient().db(database).collection("leads").watch([], { maxAwaitTimeMS: 1 }));

export async function prepareDeadlineQueue(employee: CallingEmployee, business: string, deadline: number) {
    const configured = getBusinessById(business); if (!configured) throw Error("CALL_PREPARATION_BUSINESS_UNAVAILABLE");
    const priority = callReadPriority.reserve(deadline);
    const feed = changes.acquire(configured.databaseName);
    try {
        let revision = await feed.poll();
        const load = () => runWithBusiness(business, async () => {
            const queue = await employeeCallingQueue(employee, business, new Date(Math.max(deadline, Date.now())), true);
            return {queue, page: await hydrateCallingQueue(queue, 1, 1)};
        });
        let current = await load();
        return {
            get queue() { return current.queue; },
            get lead() { return current.page.nextLead; },
            async refresh(force = false) {
                const observed = await feed.poll();
                const due = current.queue.nextEligibilityChangeAt && Date.parse(current.queue.nextEligibilityChangeAt) <= Date.now();
                if (force || observed !== revision || due) { current = await load(); revision = observed; return true; }
                return false;
            },
            close: async () => { priority.close(); await feed.close(); },
        };
    } catch (error) { priority.close(); await feed.close(); throw error; }
}
