import assert from "node:assert/strict";
import test from "node:test";
import { deliverAttendanceEvent, normalizedEventId } from "./attendanceEventSyncService";

test("one secondary failure is pending while the primary punch succeeds", async () => {
  const stored = new Map<string, Set<string>>();
  const eventId = normalizedEventId("");
  let secondaryDown = true;
  const write = async (business: string) => {
    if (business === "b" && secondaryDown) throw new Error("unavailable");
    const events = stored.get(business) || new Set<string>();
    events.add(eventId);
    stored.set(business, events);
    return eventId;
  };
  const first = await deliverAttendanceEvent("a", ["b", "c"], write, (business) => write(business));
  assert.equal(first.primary, eventId);
  assert.deepEqual(first.pendingBusinessIds, ["b"]);
  secondaryDown = false;
  const retry = await deliverAttendanceEvent("a", first.pendingBusinessIds, write, (business) => write(business));
  assert.deepEqual(retry.pendingBusinessIds, []);
  assert.equal(stored.get("a")?.size, 1);
  assert.equal(stored.get("b")?.size, 1);
  assert.equal(stored.get("c")?.size, 1);
});

test("a primary failure never reports success", async () => {
  await assert.rejects(deliverAttendanceEvent("a", ["b"], async (business) => {
    if (business === "a") throw new Error("primary unavailable");
    return business;
  }, async (business) => business), /primary unavailable/);
});
