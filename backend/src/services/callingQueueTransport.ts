import { createHash } from "node:crypto";

type RefreshQueue = { scope: { businessId: string; employeeId: string; employeeCode: string };
  refreshDependencies: { version: 1; leadIds: string[]; phones: string[] } };

// Only refresh-dependency metadata is reusable. Decisions, ordering, versions
// and the server clock are always taken from this request's fresh queue.
export function callingQueueTransport<T extends RefreshQueue>(queue: T, knownFingerprint: unknown): Omit<T, "refreshDependencies"> & {
  refreshDependencies?: T["refreshDependencies"]; refreshDependenciesFingerprint: string; refreshDependenciesUnchanged?: true;
} {
  const { refreshDependencies, ...snapshot } = queue;
  const fingerprint = createHash("sha256").update(JSON.stringify(["queue-refresh-v1", queue.scope.businessId,
    queue.scope.employeeId, queue.scope.employeeCode, refreshDependencies])).digest("hex");
  const unchanged = typeof knownFingerprint === "string" && knownFingerprint === fingerprint;
  return { ...snapshot, refreshDependenciesFingerprint: fingerprint,
    ...(unchanged ? { refreshDependenciesUnchanged: true as const } : { refreshDependencies }) };
}
