import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import mongoose from "mongoose";
import { getCallBridgeScheduleModel } from "../models/CallBridge";
import { acquireCallBridgeLease } from "./callBridgeReservation";

const testUri = process.env.CRM_INTEGRATION_MONGO_URI;

test("one of two first-use tabs acquires the Mongo lease and cooldown is enforced", {
  skip: !testUri,
}, async () => {
  const url = new URL(testUri!);
  assert.equal(url.protocol, "mongodb:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "27099");
  assert.match(url.pathname, /^\/crm_integration_[a-z0-9_]+$/);

  const controlName = `crm_integration_control_${crypto.randomUUID().replaceAll("-", "")}`;
  process.env.CONTROL_DATABASE_NAME = controlName;
  let connected = false;
  try {
    await mongoose.connect(testUri!, { serverSelectionTimeoutMS: 3000 });
    connected = true;
    const Schedule = getCallBridgeScheduleModel();
    await Schedule.createIndexes();

    const now = new Date("2026-10-15T12:00:00.000Z");
    const base = {
      employeeCode: "TEST-EMPLOYEE",
      now,
      leaseUntil: new Date(now.getTime() + 20_000),
      reservationTokenHash: "test-token",
      businessId: "test-business",
      leadId: "test-lead",
      timingV2: true,
    };
    const attempts = [crypto.randomUUID(), crypto.randomUUID()];
    const results = await Promise.all(attempts.map((attemptId) => acquireCallBridgeLease({ ...base, attemptId })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await Schedule.countDocuments({ employeeCode: base.employeeCode }), 1);
    const winner = results.find(Boolean);
    assert.equal(winner?.reservedAttemptId, attempts[results.indexOf(winner!)]);

    await Schedule.updateOne({ employeeCode: base.employeeCode }, {
      $set: { callLeaseUntil: now, nextCallAllowedAt: new Date(now.getTime() + 30_000) },
    });
    const early = await acquireCallBridgeLease({ ...base, now: new Date(now.getTime() + 29_999),
      attemptId: crypto.randomUUID() });
    assert.equal(early, null);
    const onTime = await acquireCallBridgeLease({ ...base, now: new Date(now.getTime() + 30_000),
      attemptId: crypto.randomUUID() });
    assert.ok(onTime);
  } finally {
    if (connected) {
      await mongoose.connection.useDb(controlName, { useCache: true }).dropDatabase();
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }
});
