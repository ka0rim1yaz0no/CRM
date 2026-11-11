import type { MyLeadsPage } from "../api/leads";
import type { CallingScope } from "./callingWorkflow";

function sameScope(scope: CallingScope, page: MyLeadsPage | undefined) {
    return page?.callingQueue?.scope.employeeId === scope.employeeId && page.callingQueue.scope.businessId === scope.businessId;
}

export function knownCallingQueueDependencies(scope: CallingScope, previous: MyLeadsPage | undefined) {
    const queue = previous?.callingQueue, dependencies = queue?.refreshDependencies;
    return sameScope(scope, previous) && dependencies?.version === 1 && Array.isArray(dependencies.leadIds) && Array.isArray(dependencies.phones) &&
        typeof queue?.refreshDependenciesFingerprint === "string" && /^[a-f0-9]{64}$/.test(queue.refreshDependenciesFingerprint)
        ? queue.refreshDependenciesFingerprint : undefined;
}

export function restoreCallingQueueDependencies(scope: CallingScope, previous: MyLeadsPage | undefined, page: MyLeadsPage) {
    const queue = page.callingQueue;
    if (!sameScope(scope, page)) throw new Error("The calling queue does not match this employee and business. Refresh the CRM.");
    if (!queue?.refreshDependenciesUnchanged) return page;
    const known = knownCallingQueueDependencies(scope, previous);
    if (!known || queue.refreshDependenciesFingerprint !== known || queue.refreshDependencies !== undefined) {
        throw new Error("Calling queue refresh metadata could not be confirmed. Refresh the CRM.");
    }
    return { ...page, callingQueue: { ...queue, refreshDependencies: previous!.callingQueue!.refreshDependencies } };
}
