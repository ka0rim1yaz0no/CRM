import assert from "node:assert/strict";
import { test } from "node:test";
import { callingQueueTransport } from "./callingQueueTransport";

const queue = () => ({ scope: { businessId: "synthetic", employeeId: "synthetic-owner", employeeCode: "synthetic-code" },
  refreshDependencies: { version: 1 as const, leadIds: ["own", "hidden"], phones: ["+12025550100"] },
  serverTime: "2026-10-31T00:00:00Z", version: "fresh-version", nextLeadId: "own", entries: [{ leadId: "own", callable: true }] });

test("only unchanged dependency metadata is omitted; calling decisions and time remain fresh", () => {
  const original = queue(), before = JSON.stringify(original), full = callingQueueTransport(original, undefined);
  const fresh = { ...original, version: "new-fresh-version", serverTime: "2026-10-31T00:00:01Z", entries: [{ leadId: "own", callable: false }] };
  const compact = callingQueueTransport(fresh, full.refreshDependenciesFingerprint);
  assert.equal(compact.refreshDependencies, undefined); assert.equal(compact.refreshDependenciesUnchanged, true);
  assert.equal(compact.version, fresh.version); assert.equal(compact.serverTime, fresh.serverTime); assert.equal(compact.entries, fresh.entries);
  assert.equal(JSON.stringify(original), before);
});

test("tenant, owner, code, hidden candidates and shared phones are part of the dependency proof", () => {
  const original = queue(), fingerprint = callingQueueTransport(original, undefined).refreshDependenciesFingerprint;
  for (const value of [
    { ...original, scope: { ...original.scope, businessId: "different" } },
    { ...original, scope: { ...original.scope, employeeId: "different" } },
    { ...original, scope: { ...original.scope, employeeCode: "different" } },
    { ...original, refreshDependencies: { ...original.refreshDependencies, leadIds: ["own"] } },
    { ...original, refreshDependencies: { ...original.refreshDependencies, phones: ["+12025550101"] } },
  ]) {
    const result = callingQueueTransport(value, fingerprint);
    assert.notEqual(result.refreshDependenciesFingerprint, fingerprint); assert.equal(result.refreshDependencies, value.refreshDependencies);
    assert.equal(result.refreshDependenciesUnchanged, undefined);
  }
  for (const invalid of [undefined, null, {}, [fingerprint], "unknown"])
    assert.equal(callingQueueTransport(original, invalid).refreshDependencies, original.refreshDependencies);
});
