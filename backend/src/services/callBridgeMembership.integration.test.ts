import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, after, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const root = `membership_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, index) => ({ id: `membership-${index}`, databaseName: `${root}_${index}` }));
Object.assign(process.env, { NODE_ENV: "test", DEFAULT_BUSINESS_ID: businesses[0].id, DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName,
  BUSINESS_DATABASES: JSON.stringify(businesses), CONTROL_DATABASE_NAME: root + "_control" });
const { getCallBridgeDeviceModel: Device, getCallBridgePairingModel: Pairing } = await import("../models/CallBridge");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { syncCallBridgeBusinessIds } = await import("./callBridgeBusinessService");
let mongo: MongoMemoryReplSet;
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(mongo.getUri(root)); });
after(async () => { await mongoose.disconnect(); await mongo?.stop(); });

test("unchanged membership syncs do not rewrite devices or pairings, while fresh assignments propagate immediately", async context => {
  const code = "synthetic", ids = businesses.map(row => row.id), now = new Date("2026-10-31T00:00:00Z");
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    await setBusinessAccessForEmployeeCode(code, ids);
    await Device().create({ employeeCode: code, employeeName: "Synthetic", deviceId: "synthetic", deviceName: "Synthetic", tokenHash: "synthetic-token", businessIds: ids });
    await Pairing().create({ employeeCode: code, employeeName: "Synthetic", codeHash: "synthetic-pairing", expiresAt: new Date(+now + 3600_000), businessIds: ids });
    const evidence = async () => JSON.stringify([await Device().findOne({ employeeCode: code }).lean(), await Pairing().findOne({ employeeCode: code }).lean()]);
    const before = await evidence(); context.mock.timers.setTime(+now + 10_000);
    assert.deepEqual(await syncCallBridgeBusinessIds(code, []), ids); assert.equal(await evidence(), before);
    const changed = ids.slice(1, 3); await setBusinessAccessForEmployeeCode(code, changed);
    assert.deepEqual(await syncCallBridgeBusinessIds(code, ids), changed);
    assert.deepEqual((await Device().findOne({ employeeCode: code }).lean())?.businessIds, changed);
    assert.deepEqual((await Pairing().findOne({ employeeCode: code }).lean())?.businessIds, changed);
    const synced = await evidence(); context.mock.timers.setTime(+now + 20_000);
    await syncCallBridgeBusinessIds(code, ids); assert.equal(await evidence(), synced);
  } finally { context.mock.timers.reset(); }
});
