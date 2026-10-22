import assert from "node:assert/strict";
import test from "node:test";
import { isLeadEligibleForAutoCall } from "../backend/src/services/leadAutoCallEligibility.ts";

test("a nonempty invalid schedule must not silently become callable", () => {
    assert.equal(isLeadEligibleForAutoCall({ status: "NEW", followUpAt: "invalid-schedule", comments: [] }, new Date("2026-10-23T00:00:00Z")), false);
});
