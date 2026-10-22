import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const root = `heartbeat_signal_${crypto.randomUUID().replaceAll("-", "")}`;
process.env.NODE_ENV = "test";
process.env.CRM_CALL_TIMING_V2 = "true";
process.env.CRM_CALL_DASHBOARD_V2 = "true";
process.env.DEFAULT_BUSINESS_ID = "synthetic-heartbeat";
process.env.DEFAULT_BUSINESS_DATABASE = root;
process.env.CONTROL_DATABASE_NAME = `${root}_control`;
process.env.BUSINESS_DATABASES = JSON.stringify([{ id: "synthetic-heartbeat", databaseName: root }]);
const { createApp } = await import("../app");
const { getCallBridgeDeviceModel, getCallBridgeScheduleModel } = await import("../models/CallBridge");
const { acquireCallBridgeLease } = await import("./callBridgeReservation");
let mongo: MongoMemoryReplSet;
let server: http.Server;
let base = "";
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(root));
  server = http.createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });

async function activeFixture(code: string, now: Date) {
  const token = crypto.randomBytes(24).toString("hex");
  await getCallBridgeDeviceModel().create({ employeeCode: code, employeeName: "Synthetic employee", deviceId: code,
    deviceName: "Synthetic device", tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    businessIds: ["synthetic-heartbeat"], state: "active", audioSessionActive: true, nextivaProcessDetected: true,
    bridgeVersion: "0.4.1", lastSeenAt: now, lastStateChangedAt: new Date(+now - 10000), lastIdleAt: new Date(+now - 20000) });
  await getCallBridgeScheduleModel().create({ employeeCode: code, lastCallStartedAt: new Date(+now - 10000), lastDialStartedAt: new Date(+now - 11000) });
  return async (state: string, audioSessionActive: boolean, nextivaProcessDetected = true) => {
    const response = await fetch(`${base}/api/call-bridge/heartbeat`, { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${token}`,
    }, body: JSON.stringify({ state, audioSessionActive, nextivaProcessDetected, bridgeVersion: "0.4.1" }) });
    assert.equal(response.status, 200);
    return { device: await getCallBridgeDeviceModel().findOne({ employeeCode: code }).lean(),
      schedule: await getCallBridgeScheduleModel().findOne({ employeeCode: code }).lean() };
  };
}

test("raw idle audio starts one confirmation window even if the old bridge still reports active", async context => {
  const now = new Date("2026-10-21T19:00:00Z");
  const heartbeat = await activeFixture("synthetic-idle-signal", now);
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const first = await heartbeat("active", false);
    assert.equal(first.schedule?.lastCallEndedAt, null, "an unconfirmed audio transition must not fabricate a confirmed call end");
    assert.equal(first.device?.inactiveSince?.toISOString(), now.toISOString());
    assert.equal(first.device?.audioSessionActive, false);
    context.mock.timers.setTime(+now + 7999);
    assert.equal((await heartbeat("idle", false)).schedule?.lastCallEndedAt, null);
    context.mock.timers.setTime(+now + 8000);
    const confirmed = await heartbeat("idle", false);
    assert.equal(confirmed.schedule?.lastCallEndedAt?.toISOString(), now.toISOString());
    assert.equal(confirmed.schedule?.nextCallAllowedAt?.getTime(), +now + 30000, "confirmation must not add time to the 30-second deadline");
    const lease = { employeeCode: "synthetic-idle-signal", leaseUntil: new Date(+now + 75000), reservationTokenHash: "synthetic-token-hash",
      businessId: "synthetic-heartbeat", leadId: "synthetic-lead", timingV2: true };
    assert.equal(await acquireCallBridgeLease({ ...lease, now: new Date(+now + 29999), attemptId: crypto.randomUUID() }), null);
    const competing = await Promise.all(["synthetic-heartbeat", "synthetic-other"].map(businessId => acquireCallBridgeLease({
      ...lease, businessId, now: new Date(+now + 30000), attemptId: crypto.randomUUID(),
    })));
    assert.equal(competing.filter(Boolean).length, 1, "only one tab/business may dial at the shared 30-second deadline");
  } finally { context.mock.timers.reset(); }
});

test("audio recovery cancels pending end confirmation and unknown detection never ends a call", async context => {
  const now = new Date("2026-10-21T20:00:00Z");
  const heartbeat = await activeFixture("synthetic-audio-recovery", now);
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    await heartbeat("active", false);
    context.mock.timers.setTime(+now + 2000);
    const recovered = await heartbeat("active", true);
    assert.equal(recovered.device?.inactiveSince, null);
    assert.equal(recovered.schedule?.lastCallEndedAt, null);
    assert.equal(recovered.schedule?.lastCallStartedAt?.getTime(), +now - 10000);
    context.mock.timers.setTime(+now + 12000);
    const unknown = await heartbeat("unknown", false);
    assert.equal(unknown.device?.state, "unknown");
    assert.equal(unknown.schedule?.lastCallEndedAt, null);
  } finally { context.mock.timers.reset(); }
});

test("a disappearing Nextiva process is unknown, not a confirmed completed call", async context => {
  const now = new Date("2026-10-21T20:00:00Z");
  const heartbeat = await activeFixture("synthetic-disconnected-process", now);
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    for (const elapsed of [0, 8000, 30000]) {
      context.mock.timers.setTime(+now + elapsed);
      const state = await heartbeat("idle", false, false);
      assert.equal(state.schedule?.lastCallEndedAt, null);
      assert.equal(state.schedule?.nextCallAllowedAt, null);
      assert.equal(state.device?.state, "unknown");
    }
  } finally { context.mock.timers.reset(); }
});

test("the atomic lease cannot erase a call whose end has not been confirmed", async () => {
  const now = new Date("2026-10-21T20:00:00Z");
  await activeFixture("synthetic-lease-active-race", now);
  const lease = await acquireCallBridgeLease({ employeeCode: "synthetic-lease-active-race", now,
    leaseUntil: new Date(+now + 45000), reservationTokenHash: "synthetic-token", attemptId: crypto.randomUUID(),
    businessId: "synthetic-heartbeat", leadId: "synthetic-lead", timingV2: true });
  assert.equal(lease, null);
  assert.equal((await getCallBridgeScheduleModel().findOne({ employeeCode: "synthetic-lease-active-race" }))?.lastCallStartedAt?.getTime(), +now - 10000);
});
