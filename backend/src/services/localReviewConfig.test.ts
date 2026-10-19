import assert from "node:assert/strict";
import test from "node:test";
import { isReviewBlockedPath, localReviewBusinesses, localReviewRestoreUri, reviewCollections, reviewControlCollections } from "../localReviewConfig";

test("review restore preserves namespaces and cannot target the original or a remote database", () => {
  const uri = "mongodb://127.0.0.1:27119/crm?replicaSet=testset";
  const restored = new URL(localReviewRestoreUri(uri));
  assert.equal(restored.pathname, "/");
  assert.equal(restored.searchParams.get("replicaSet"), "testset");
  assert.equal(new URL(uri).pathname, "/crm");
  for (const invalid of ["mongodb://127.0.0.1:27017/crm", "mongodb://example.invalid:27119/crm", "mongodb+srv://127.0.0.1:27119/crm", "mongodb://user:password@127.0.0.1:27119/crm"]) assert.throws(() => localReviewRestoreUri(invalid));
});

test("local review resolves every verified business, including newly added explicit mappings", () => {
  const result = localReviewBusinesses([
    { businessId: "business-a", name: "Synthetic A" }, { businessId: "business-b", name: "Synthetic B" },
    { businessId: "new-business", databaseName: "crm_d", name: "Synthetic D" },
  ], ["crm", "crm_b", "crm_d"]);
  assert.deepEqual(result.map((item) => item.databaseName), ["crm", "crm_b", "crm_d"]);
  assert.throws(() => localReviewBusinesses([{ businessId: "unknown" }], ["crm"]));
  assert.throws(() => localReviewBusinesses([{ businessId: "business-a", databaseName: "admin" }], ["admin"]));
  assert.throws(() => localReviewBusinesses([{ businessId: "business-b" }], ["crm"]));
});
test("local review excludes secrets, device tokens, uploads and external integration actions", () => {
  const copied = [...reviewCollections, ...reviewControlCollections] as string[];
  for (const excluded of ["credentials", "users", "messages", "mediaassets", "browseractivityevents", "browseractivityscreenshots", "callbridgedevices", "callbridgepairings", "callbridgeattempts", "calllogs"]) assert.equal(copied.includes(excluded), false);
  for (const url of ["/uploads/photo.png", "/api/integrations/nextiva", "/api/call-bridge/reserve", "/api/browser-activity", "/api/media"]) assert.equal(isReviewBlockedPath(url), true);
  for (const url of ["/api/call-dashboard", "/api/dashboard-workspace/summary", "/api/attendance-hub/days", "/api/auth/login"]) assert.equal(isReviewBlockedPath(url), false);
});

test("an isolated upload directory permits local Media tests without enabling external integrations", () => {
  for (const url of ["/uploads/fake.png", "/api/media", "/api/media/file/fake.png"]) assert.equal(isReviewBlockedPath(url, true), false);
  for (const url of ["/api/integrations/nextiva", "/api/call-bridge/reserve", "/api/browser-activity"]) assert.equal(isReviewBlockedPath(url, true), true);
});
