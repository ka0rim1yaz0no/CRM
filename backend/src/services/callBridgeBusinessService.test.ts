import assert from "node:assert/strict";
import test from "node:test";
import { selectCallBridgeBusinessIds } from "./callBridgeBusinessService";

const configured = new Set(["business-a", "business-b", "business-c"]);
const isConfigured = (businessId: string) => configured.has(businessId);

test("uses current employee business assignments instead of stale paired businesses", () => {
  assert.deepEqual(
    selectCallBridgeBusinessIds(["business-b", "business-c"], ["business-a"], isConfigured),
    ["business-b", "business-c"],
  );
});

test("falls back to paired businesses for legacy employees without control assignments", () => {
  assert.deepEqual(
    selectCallBridgeBusinessIds([], ["business-a", "business-a", "removed-business"], isConfigured),
    ["business-a"],
  );
});
