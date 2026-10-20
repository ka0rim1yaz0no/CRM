import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { getCallBridgeScheduleModel } from "../models/CallBridge";
import { acquireCallBridgeLease } from "./callBridgeReservation";

let mongo: MongoMemoryReplSet;
const database = `autocall_view_${crypto.randomUUID().replaceAll("-", "")}`;
before(async () => {
  process.env.CONTROL_DATABASE_NAME = `${database}_control`;
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = mongo.getUri(database);
  assert.equal(new URL(uri).hostname, "127.0.0.1");
  await mongoose.connect(uri);
  await getCallBridgeScheduleModel().createIndexes();
});
after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
const now = new Date("2026-10-21T00:00:00Z");
const input = (code: string, businessId: string, at = now) => ({ employeeCode: code, businessId, leadId: `fake-${businessId}`,
  now: at, leaseUntil: new Date(+at + 20_000), reservationTokenHash: crypto.randomUUID(), attemptId: crypto.randomUUID(), timingV2: true });

test("displayed queue: two tabs or businesses cannot simultaneously reserve one employee", async () => {
  for (const businesses of [["fake-a", "fake-a"], ["fake-a", "fake-b"]]) {
    const code = `fake-${crypto.randomUUID()}`;
    const results = await Promise.all(businesses.map(business => acquireCallBridgeLease(input(code, business))));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await getCallBridgeScheduleModel().countDocuments({ employeeCode: code }), 1);
    const stored = await getCallBridgeScheduleModel().findOne({ employeeCode: code }).lean();
    assert.equal(stored!.reservedAttemptId, results.find(Boolean)!.reservedAttemptId);
  }
});

test("displayed queue: 29,999ms is rejected and exactly 30,000ms allows only one winner", async () => {
  const code = "fake-cooldown";
  await getCallBridgeScheduleModel().create({ employeeCode: code, callLeaseUntil: now, nextCallAllowedAt: new Date(+now + 30_000) });
  assert.equal(await acquireCallBridgeLease(input(code, "fake-a", new Date(+now + 29_999))), null);
  const atDeadline = new Date(+now + 30_000);
  const results = await Promise.all(["fake-a", "fake-b"].map(business => acquireCallBridgeLease(input(code, business, atDeadline))));
  assert.equal(results.filter(Boolean).length, 1);
  await getCallBridgeScheduleModel().updateOne({ employeeCode: code }, { $set: { callLeaseUntil: atDeadline,
    nextCallAllowedAt: atDeadline, dialIntentUntil: new Date(+atDeadline + 30_000) } });
  assert.equal(await acquireCallBridgeLease(input(code, "fake-a", new Date(+atDeadline + 29_999))), null,
    "an outstanding dial intent must still prevent a second call even if the reservation lease is released");
});
