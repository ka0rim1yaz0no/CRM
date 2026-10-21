import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptReviewedLegacyAttendance } from "./localLegacyAttendanceAdoption";

const identity = { key: "tenant:fake:employee", code: "fake-employee", businessIds: ["fake"], canonicalBusinessId: "fake", employeeId: "fake" };
test("reviewed adoption rejects missing, stale and future attestations before opening any database session", async () => {
  for (const backup of [
    { id: "fake", createdAt: new Date().toISOString(), fingerprints: {} },
    { id: "fake", createdAt: new Date(Date.now() - 86_401_000).toISOString(), fingerprints: { [identity.key]: "a".repeat(64) } },
    { id: "fake", createdAt: new Date(Date.now() + 60_000).toISOString(), fingerprints: { [identity.key]: "a".repeat(64) } },
  ]) await assert.rejects(adoptReviewedLegacyAttendance(identity, backup, "production-reviewed-adoption"), /current verified review fingerprint/);
});
