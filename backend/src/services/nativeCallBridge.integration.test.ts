import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { before, after, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { Request } from "express";

const root = `native_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 7 }, (_, i) => ({ id: `native-${i}`, databaseName: `${root}_${i}` }));
const now = new Date("2026-10-28T17:00:00Z");
Object.assign(process.env, { NODE_ENV: "test", CRM_SECURITY_LEGACY_AUTH: "true", CRM_CALL_TIMING_V2: "true", CRM_LEAD_PHONE_DEDUP_V2: "true", CRM_ATTENDANCE_INTEGRITY: "true",
  CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("base64"), DEFAULT_BUSINESS_ID: businesses[0].id,
  DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName, CONTROL_DATABASE_NAME: `${root}_control`, BUSINESS_DATABASES: JSON.stringify(businesses) });
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { Lead } = await import("../models/Lead");
const { AttendanceLedger } = await import("../models/AttendanceLedger");
const { setBusinessAccessForEmployeeCode, getAttendanceBusinessIdentity } = await import("../models/BusinessUserAccess");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { getCallBridgeDeviceModel: Device, getCallBridgeScheduleModel: Schedule } = await import("../models/CallBridge");
const { LeadPhoneSlot } = await import("./leadPhoneDispatch");
const { CALLING_QUEUE_POLICY_VERSION } = await import("../../../shared/leadCallingPolicy");
const { nativeSecretHash } = await import("./nativeCallBridge");
const { employeeCallingQueue } = await import("./employeeCallingQueue");
const { securityRequestKey } = await import("../middleware/securityHardening");
let mongo: MongoMemoryReplSet, server: http.Server, base = "";
let phoneNumber = 200;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{args: ["--wiredTigerCacheSizeGB", "0.25"]}] }); await mongoose.connect(mongo.getUri(root), {monitorCommands: true});
  await Schedule().createIndexes();
  server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  for (const business of businesses) await runWithBusiness(business.id, async () => { await Lead.deleteMany({}); await Employee.deleteMany({}); await LeadPhoneSlot.deleteMany({}); });
  await Device().deleteMany({}); await Schedule().deleteMany({}); await AttendanceLedger.deleteMany({});
  global.gc?.();
});
async function fixture(business = businesses[0]) {
  const code = `synthetic-${crypto.randomUUID()}`, token = crypto.randomUUID(), key = crypto.randomUUID(), binding = crypto.randomUUID();
  await setBusinessAccessForEmployeeCode(code, businesses.map(row => row.id));
  const employee = await runWithBusiness(business.id, () => Employee.create({ employeeCode: code, name: "Synthetic", role: "Sales", status: "Active", availabilityStatus: "ONLINE" }));
  const identity = await getAttendanceBusinessIdentity(code), ledgerKey = `access:${identity!.id}`;
  const at = new Date(+now - 3600000).toISOString();
  await AttendanceLedger.create({ _id: ledgerKey, employeeCode: code, businessIds: businesses.map(row => row.id), canonicalBusinessId: business.id,
    revision: 1, events: [{ id: "in", source: "Time In", at, recordedAt: at, sequence: 1, commandId: "fixture" }] });
  const lead = await runWithBusiness(business.id, () => Lead.create({ businessName: "Synthetic", phone: `+1202555${String(phoneNumber++).padStart(4, "0")}`, status: "NEW", assignedAgent: employee._id, assignedAgentName: employee.name }));
  await Device().create({ employeeCode: code, employeeName: "Synthetic", deviceId: code, deviceName: "Synthetic", tokenHash: nativeSecretHash(token),
    state: "idle", nextivaProcessDetected: true, audioSessionActive: false, bridgeVersion: "0.5.0", nativeDialProtocol: 1,
    accountSwitchingEnabled: true, browserDeviceKeyHash: nativeSecretHash(key), browserSessionId: binding,
    businessIds: businesses.map(row => row.id), lastSeenAt: now, lastStateChangedAt: now, lastIdleAt: now });
  const attempt = crypto.randomUUID();
  const headers = { "Content-Type": "application/json", "X-Business-Id": business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(code)!, "X-CRM-Auto-Call-Version": CALLING_QUEUE_POLICY_VERSION };
  const body = { employeeCode: code, attemptId: attempt, leadId: String(lead._id), normalizedPhone: lead.phone,
    browserDeviceKey: key, browserSessionId: binding, manual: true };
  const request = (extra = {}, overrideHeaders = {}) => fetch(`${base}/call-bridge/native-dial`, { method: "POST", headers: { ...headers, ...overrideHeaders }, body: JSON.stringify({ ...body, ...extra }) });
  const claim = (secret: string = token, extra = {}) => fetch(`${base}/call-bridge/native-dial/claim`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Business-Id": businesses[0].id, Authorization: `Bearer ${secret}` }, body: JSON.stringify({ deviceId: code, ...extra }) });
  const saved = { employee: employee._id, status: "Paid", netPay: 12345, paymentDate: new Date("2026-10-21T00:00:00Z") };
  await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").insertOne(saved);
  const evidence = async () => JSON.stringify({ payroll: await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").findOne({ employee: employee._id }),
    attendance: (await AttendanceLedger.findById(ledgerKey).lean())?.events });
  return { code, business, employee, lead, attempt, token, binding, key, ledgerKey, request, claim, evidence };
}

function automaticRequest(f: Awaited<ReturnType<typeof fixture>>, route: string, body: Record<string, unknown>) {
  return fetch(`${base}/call-bridge/${route}`, {method: "POST", headers: {"Content-Type": "application/json",
    "X-Business-Id": f.business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)!,
    "X-CRM-Auto-Call-Version": CALLING_QUEUE_POLICY_VERSION}, body: JSON.stringify({employeeCode: f.code, ...body})});
}

test("queue phone correction skips an incompatible head and hands off once at fifteen seconds in every business", async context => {
  context.mock.timers.enable({apis: ["Date"], now});
  try { for (const business of businesses) {
    context.mock.timers.setTime(+now);
    const f = await fixture(business), saved = await f.evidence();
    const malformed = await runWithBusiness(business.id, () => Lead.create({businessName: "Synthetic incompatible phone",
      phone: `Call ${f.lead.phone}`, status: "NEW", assignedAgent: f.employee._id, assignedAgentName: f.employee.name,
      createdAt: new Date(+now + 1)}));
    const original = JSON.stringify(await runWithBusiness(business.id, () => Lead.findById(malformed._id).lean()));
    let queue = await runWithBusiness(business.id, () => employeeCallingQueue(f.employee, business.id, now, true));
    assert.equal(queue.entries.find(row => row.leadId === String(malformed._id))?.reason, "INVALID_PHONE");
    assert.equal(queue.nextLeadId, String(f.lead._id));
    queue = await runWithBusiness(business.id, () => employeeCallingQueue(f.employee, business.id, now, true));
    assert.equal(queue.nextLeadId, String(f.lead._id), "REFRESH_MUST_NOT_RESTORE_INCOMPATIBLE_QUEUE_HEAD");
    await Schedule().create({employeeCode: f.code, lastCallEndedAt: new Date(+now - 15000), nextCallAllowedAt: now});
    const body = {leadId: String(f.lead._id), attemptId: f.attempt, queueVersion: queue.version, normalizedPhone: f.lead.phone};
    context.mock.timers.setTime(+now - 1);
    assert.equal((await automaticRequest(f, "reserve", body)).status, 409, "NO_AUTHORIZATION_AT_14999_MS");
    context.mock.timers.setTime(+now);
    const reserve = await automaticRequest(f, "reserve", body); assert.equal(reserve.status, 200);
    const reservation = await reserve.json(); assert.equal(reservation.allowed, true);
    const dispatch = await automaticRequest(f, "dial-start", {leadId: body.leadId, reservationToken: reservation.reservationToken});
    assert.equal(dispatch.status, 200); assert.equal((await dispatch.json()).leadId, body.leadId);
    assert.equal((await f.request({manual: false})).status, 200);
    const claim = await f.claim(); assert.equal(claim.status, 200); assert.equal((await claim.json()).phone, f.lead.phone);
    assert.equal((await f.claim()).status, 204, "COMMAND_MUST_NOT_REPLAY");
    assert.equal(await f.evidence(), saved);
    assert.equal(JSON.stringify(await runWithBusiness(business.id, () => Lead.findById(malformed._id).lean())), original);
  }} finally {context.mock.timers.reset();}
});

test("queue phone correction preserves deadline authorization and native claims in every business", async context => {
  context.mock.timers.enable({apis: ["Date"], now});
  try { for (const business of businesses) {
    context.mock.timers.setTime(+now);
    const f = await fixture(business), saved = await f.evidence();
    await runWithBusiness(business.id, () => Lead.create({businessName: "Synthetic incompatible phone", phone: `Office: ${f.lead.phone}`,
      status: "NEW", assignedAgent: f.employee._id, assignedAgentName: f.employee.name, createdAt: new Date(+now + 1)}));
    await Schedule().create({employeeCode: f.code, lastCallEndedAt: new Date(+now - 15000), nextCallAllowedAt: now});
    const response = await automaticRequest(f, "dial-at-deadline", {attemptId: f.attempt, notBefore: now.toISOString(),
      browserDeviceKey: f.key, browserSessionId: f.binding});
    const grant = await response.json(); assert.equal(response.status, 200, JSON.stringify(grant));
    assert.equal(grant.leadId, String(f.lead._id)); assert.equal(grant.startedAt, now.toISOString());
    assert.equal((await f.request({manual: false})).status, 200);
    assert.equal((await f.claim()).status, 200); assert.equal((await f.claim()).status, 204);
    assert.equal(await f.evidence(), saved);
  }} finally {context.mock.timers.reset();}
});

test("queue phone correction rejects malformed manual preparation before creating a hold in every business", async context => {
  context.mock.timers.enable({apis: ["Date"], now});
  try { for (const business of businesses) {
    const f = await fixture(business), saved = await f.evidence();
    await runWithBusiness(business.id, () => Lead.updateOne({_id: f.lead._id}, {$set: {phone: `Call ${f.lead.phone}`}}));
    const response = await controlRequest(f, true);
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "CALL_LEAD_NOT_ELIGIBLE");
    assert.equal(await Schedule().countDocuments({employeeCode: f.code}), 0);
    assert.equal((await f.claim()).status, 204);
    const queue = await runWithBusiness(business.id, () => employeeCallingQueue(f.employee, business.id, now, true));
    assert.equal(queue.nextLeadId, null); assert.equal(queue.entries[0].reason, "INVALID_PHONE");
    assert.equal(await f.evidence(), saved);
  }} finally {context.mock.timers.reset();}
});

// Seed an automatic grant directly; a real manual request now deliberately pauses automation.
async function seedAutomaticGrant(f: Awaited<ReturnType<typeof fixture>>) {
  await Schedule().create({ employeeCode: f.code, reservedAttemptId: f.attempt, reservedBusinessId: f.business.id,
    reservedLeadId: String(f.lead._id), reservedPhone: f.lead.phone, reservationTokenHash: nativeSecretHash(f.attempt),
    lastReservedAt: now, lastDialStartedAt: now, callLeaseUntil: new Date(+now + 45000), dialIntentUntil: new Date(+now + 30000),
    nextCallAllowedAt: new Date(+now + 30000) });
  await runWithBusiness(f.business.id, () => LeadPhoneSlot.create({ _id: f.lead.phone, employeeCode: f.code,
    attemptId: f.attempt, reservedAt: now, consumedAt: now }));
}

function controlRequest(f: Awaited<ReturnType<typeof fixture>>, paused: boolean, options: {
  operationId?: string; expectedVersion?: number; employeeCode?: string; session?: string; business?: string; manualTakeover?: boolean;
  leadId?: string; phone?: string; browserSessionId?: string;
} = {}) {
  return fetch(`${base}/call-bridge/manual-call-hold`, { method: "POST", headers: { "Content-Type": "application/json",
    "X-Business-Id": options.business || f.business.id, "X-CRM-Attendance-Session": options.session ?? createAttendanceHubSession(f.code)!,
    "X-CRM-Auto-Call-Version": CALLING_QUEUE_POLICY_VERSION }, body: JSON.stringify({ employeeCode: options.employeeCode || f.code,
    paused, attemptId: options.operationId || f.attempt, leadId: options.leadId || String(f.lead._id), normalizedPhone: options.phone || f.lead.phone,
    browserDeviceKey: f.key, browserSessionId: options.browserSessionId || f.binding, expectedVersion: options.expectedVersion, manualTakeover: options.manualTakeover ?? true }) });
}

function cancelHold(f: Awaited<ReturnType<typeof fixture>>, attemptId = f.attempt) {
  return fetch(`${base}/call-bridge/native-dial/cancel`, {method: "POST", headers: {"Content-Type": "application/json",
    "X-Business-Id": f.business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)!},
    body: JSON.stringify({employeeCode: f.code, attemptId, leadId: String(f.lead._id)})});
}

function controlStatus(f: Awaited<ReturnType<typeof fixture>>, manual = false, business = f.business.id) {
  return fetch(`${base}/call-bridge/status?employeeCode=${f.code}${manual ? "&mode=manual" : ""}`, { headers: {
    "X-Business-Id": business, "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)!, "X-CRM-Native-Dial": "1",
    "X-CRM-Bridge-Browser-Key": f.key, "X-CRM-Bridge-Browser-Session": f.binding } });
}

test("manual requests persist an automatic-call pause in all seven businesses without pausing manual handoff", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try { for (const business of businesses) {
    const f = await fixture(business), saved = await f.evidence();
    const manual = await f.request(); assert.equal(manual.status, 200);
    const state = await (await controlStatus(f)).json();
    assert.equal(state.autoCallPaused, true); assert.equal(state.autoCallControlVersion, 1);
    assert.equal(state.autoCallUserPaused, false); assert.equal(state.manualCallHold, true);
    assert.equal(state.waitCode, "AUTO_CALL_PAUSED"); assert.equal(state.ready, false); assert.equal(state.deadlineDispatchEnabled, false);
    assert.equal((await f.request()).status, 200, "retrying the same manual attempt is idempotent");
    assert.equal((await (await controlStatus(f)).json()).autoCallControlVersion, 1);
    assert.equal((await f.request({ manual: false, attemptId: crypto.randomUUID() })).status, 409);
    assert.deepEqual((await Promise.all([f.claim(), f.claim()])).map(row => row.status).sort(), [200, 204]);
    assert.equal((await (await controlStatus(f)).json()).autoCallPaused, true, "confirmation does not resume Auto Call");
    assert.equal(await f.evidence(), saved);
  } } finally { context.mock.timers.reset(); }
});

test("manual takeover survives fresh status reads in another business and leaves colleagues enabled", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture(), colleague = await fixture();
    for (const business of businesses.slice(1)) await runWithBusiness(business.id, () => Employee.create({ employeeCode: f.code,
      name: "Synthetic", role: "Sales", status: "Active", availabilityStatus: "ONLINE" }));
    const response = await f.request(); assert.equal(response.status, 200);
    for (const business of businesses) {
      const read = await controlStatus(f, false, business.id); assert.equal(read.status, 200);
      assert.equal((await read.json()).autoCallPaused, true);
    }
    const other = await (await controlStatus(colleague)).json(); assert.equal(other.autoCallPaused, false);
    assert.equal((await Schedule().findOne({ employeeCode: colleague.code }).lean())?.autoCallPaused, undefined);
  } finally { context.mock.timers.reset(); }
});

test("a paused employee can queue one manual call but every automatic authorization route remains blocked", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try { for (const business of businesses) {
    const f = await fixture(business), saved = await f.evidence();
    assert.equal((await controlRequest(f, true)).status, 200);
    const status = await (await controlStatus(f, true)).json(); assert.equal(status.autoCallPaused, true); assert.equal(status.ready, true);
    const headers = { "Content-Type": "application/json", "X-Business-Id": business.id,
      "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)!, "X-CRM-Auto-Call-Version": CALLING_QUEUE_POLICY_VERSION };
    for (const route of ["reserve", "dial-start", "dial-at-deadline", "verify-deadline-launch"]) {
      const result = await fetch(`${base}/call-bridge/${route}`, { method: "POST", headers, body: JSON.stringify({
        employeeCode: f.code, attemptId: f.attempt, reservationToken: f.attempt, leadId: String(f.lead._id),
        normalizedPhone: f.lead.phone, notBefore: new Date(+now + 15000).toISOString(), browserDeviceKey: f.key, browserSessionId: f.binding }) });
      assert.equal(result.status, 409, route); assert.equal((await result.json()).code, "AUTO_CALL_PAUSED", route);
    }
    assert.equal((await f.request({manual: false})).status, 409);
    assert.equal((await f.request()).status, 200); assert.equal((await f.claim()).status, 200); assert.equal((await f.claim()).status, 204);
    assert.equal(await f.evidence(), saved);
  } } finally { context.mock.timers.reset(); }
});

test("a temporary manual hold fences an already queued auto command and cancellation cannot replay its old grant", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture(), saved = await f.evidence(); await seedAutomaticGrant(f);
    assert.equal((await f.request({manual: false})).status, 200);
    const manualId = crypto.randomUUID(); assert.equal((await controlRequest(f, true, {operationId: manualId})).status, 200);
    const blocked = await f.claim(); assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, "AUTO_CALL_PAUSED");
    assert.equal((await Schedule().findOne({ employeeCode: f.code }).lean())?.nativeClaimedAt, null);
    assert.equal((await cancelHold(f, manualId)).status, 204);
    assert.equal((await (await controlStatus(f)).json()).autoCallPaused, false);
    assert.equal((await f.claim()).status, 204, "an old automatic grant is not revived after manual cancellation");
    assert.equal((await f.request({manual: false})).status, 409);
    assert.equal(await f.evidence(), saved);
  } finally { context.mock.timers.reset(); }
});

test("temporary holds are idempotent, old cancellation cannot clear a newer click, and permanent controls are rejected", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture(), operationId = crypto.randomUUID();
    const first = await (await controlRequest(f, true, { operationId })).json();
    const repeated = await (await controlRequest(f, true, { operationId })).json();
    assert.equal(repeated.autoCallControlVersion, first.autoCallControlVersion);
    const newer = await (await controlRequest(f, true)).json(); assert.ok(newer.autoCallControlVersion > first.autoCallControlVersion);
    assert.equal((await cancelHold(f, operationId)).status, 204);
    assert.equal((await (await controlStatus(f)).json()).manualCallHold, true);
    assert.equal((await controlRequest(f, false, {expectedVersion: newer.autoCallControlVersion})).status, 400);
    assert.equal((await controlRequest(f, true, {manualTakeover: false})).status, 400);
  } finally { context.mock.timers.reset(); }
});

test("changing call mode never releases a claimed or active call and rejects unsigned or foreign controls", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture(), saved = await f.evidence(); await seedAutomaticGrant(f);
    assert.equal((await f.request({manual: false})).status, 200); assert.equal((await f.claim()).status, 200);
    await Device().updateOne({ employeeCode: f.code }, { $set: { state: "active", audioSessionActive: true } });
    const original = await Schedule().findOne({ employeeCode: f.code }).lean();
    assert.equal((await controlRequest(f, true)).status, 200);
    const paused = await Schedule().findOne({ employeeCode: f.code }).lean();
    for (const key of ["nativeClaimedAt", "dialIntentUntil", "callLeaseUntil", "lastDialStartedAt", "reservedAttemptId"] as const) assert.deepEqual(paused?.[key], original?.[key]);
    assert.equal((await f.request({attemptId: crypto.randomUUID()})).status, 409);
    assert.ok([401, 403].includes((await controlRequest(f, true, { session: "" })).status));
    assert.equal((await controlRequest(f, true, { employeeCode: "foreign" })).status, 403);
    assert.equal(await f.evidence(), saved);
  } finally { context.mock.timers.reset(); }
});

test("a confirmed manual end releases only its temporary hold and allows the next normal automatic grant", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture(), saved = await f.evidence();
    assert.equal((await f.request()).status, 200); assert.equal((await f.claim()).status, 200);
    const heartbeat = (state: "active" | "idle") => fetch(`${base}/call-bridge/heartbeat`, { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${f.token}` }, body: JSON.stringify({state,
      audioSessionActive: state === "active", nextivaProcessDetected: true, bridgeVersion: "0.5.0", nativeDialProtocol: 1}) });
    assert.equal((await heartbeat("active")).status, 200);
    context.mock.timers.setTime(+now + 5000); assert.equal((await heartbeat("idle")).status, 200);
    context.mock.timers.setTime(+now + 13000); assert.equal((await heartbeat("idle")).status, 200);
    context.mock.timers.setTime(+now + 35000); assert.equal((await heartbeat("idle")).status, 200);
    const automatic = await (await controlStatus(f)).json();
    assert.equal(automatic.autoCallPaused, false); assert.equal(automatic.manualCallHold, false); assert.equal(automatic.ready, true);
    const queue = await runWithBusiness(f.business.id, () => employeeCallingQueue(f.employee, f.business.id));
    const attemptId = crypto.randomUUID(), body = { employeeCode: f.code, attemptId, leadId: String(f.lead._id),
      normalizedPhone: f.lead.phone, queueVersion: queue.version, reservationToken: attemptId };
    const headers = { "Content-Type": "application/json", "X-Business-Id": f.business.id,
      "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)!, "X-CRM-Auto-Call-Version": CALLING_QUEUE_POLICY_VERSION };
    const reserve = await fetch(`${base}/call-bridge/reserve`, {method: "POST", headers, body: JSON.stringify(body)});
    assert.equal(reserve.status, 200, JSON.stringify(await reserve.json()));
    const started = await fetch(`${base}/call-bridge/dial-start`, {method: "POST", headers, body: JSON.stringify(body)});
    assert.equal(started.status, 200, JSON.stringify(await started.json()));
    assert.equal((await f.request({ attemptId, manual: false })).status, 200);
    assert.equal((await f.claim()).status, 200); assert.equal((await f.claim()).status, 204);
    assert.equal(await f.evidence(), saved);
  } finally { context.mock.timers.reset(); }
});

test("a manual call that began with Auto Call paused does not enable it when that call ends", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture(), saved = await f.evidence();
    await Schedule().create({employeeCode: f.code, autoCallPaused: true});
    assert.equal((await f.request()).status, 200); assert.equal((await f.claim()).status, 200);
    const heartbeat = (state: "active" | "idle") => fetch(`${base}/call-bridge/heartbeat`, { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${f.token}` }, body: JSON.stringify({ state,
      audioSessionActive: state === "active", nextivaProcessDetected: true, bridgeVersion: "0.5.0", nativeDialProtocol: 1 }) });
    assert.equal((await heartbeat("active")).status, 200);
    context.mock.timers.setTime(+now + 5000); assert.equal((await heartbeat("idle")).status, 200);
    context.mock.timers.setTime(+now + 13000); assert.equal((await heartbeat("idle")).status, 200);
    const status = await (await controlStatus(f)).json();
    assert.equal(status.manualCallHold, false); assert.equal(status.autoCallUserPaused, true); assert.equal(status.autoCallPaused, true);
    assert.equal(await f.evidence(), saved);
  } finally { context.mock.timers.reset(); }
});

test("a cancelled unclaimed manual request releases its hold but never clears a claimed command early", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try { for (const claimed of [false, true]) {
    const f = await fixture(), saved = await f.evidence(); assert.equal((await f.request()).status, 200);
    if (claimed) assert.equal((await f.claim()).status, 200);
    const cancel = await fetch(`${base}/call-bridge/native-dial/cancel`, { method: "POST", headers: { "Content-Type": "application/json",
      "X-Business-Id": f.business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)! },
      body: JSON.stringify({ employeeCode: f.code, attemptId: f.attempt, leadId: String(f.lead._id) }) });
    assert.equal(cancel.status, 204);
    assert.equal((await (await controlStatus(f)).json()).manualCallHold, claimed);
    if (!claimed) assert.equal((await f.claim()).status, 204);
    assert.equal(await f.evidence(), saved);
  } } finally { context.mock.timers.reset(); }
});

test("failed manual handoffs wait for expired authorization and fresh continuous idle, not an Unknown bridge", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture(), saved = await f.evidence(); assert.equal((await f.request()).status, 200); assert.equal((await f.claim()).status, 200);
    const heartbeat = (state: "idle" | "unknown") => fetch(`${base}/call-bridge/heartbeat`, {method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${f.token}`}, body: JSON.stringify({state,
      audioSessionActive: false, nextivaProcessDetected: state === "idle", bridgeVersion: "0.5.0", nativeDialProtocol: 1})});
    context.mock.timers.setTime(+now + 46000); assert.equal((await heartbeat("unknown")).status, 200);
    assert.equal((await (await controlStatus(f)).json()).manualCallHold, true);
    context.mock.timers.setTime(+now + 50000); assert.equal((await heartbeat("idle")).status, 200);
    assert.equal((await (await controlStatus(f)).json()).manualCallHold, true);
    context.mock.timers.setTime(+now + 58000); assert.equal((await heartbeat("idle")).status, 200);
    const status = await (await controlStatus(f)).json(); assert.equal(status.manualCallHold, false); assert.equal(status.autoCallPaused, false);
    assert.ok(!status.observedAttemptId, "an expired handoff must not be reported as a confirmed physical call");
    assert.equal(await f.evidence(), saved);
  } finally { context.mock.timers.reset(); }
});

test("an older call ending cannot release a newer manual click hold", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture(); assert.equal((await f.request()).status, 200); assert.equal((await f.claim()).status, 200);
    const heartbeat = (state: "active" | "idle") => fetch(`${base}/call-bridge/heartbeat`, {method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${f.token}`}, body: JSON.stringify({state,
      audioSessionActive: state === "active", nextivaProcessDetected: true, bridgeVersion: "0.5.0", nativeDialProtocol: 1})});
    assert.equal((await heartbeat("active")).status, 200);
    const newer = crypto.randomUUID(); assert.equal((await controlRequest(f, true, {manualTakeover: true, operationId: newer})).status, 200);
    context.mock.timers.setTime(+now + 5000); assert.equal((await heartbeat("idle")).status, 200);
    context.mock.timers.setTime(+now + 13000); assert.equal((await heartbeat("idle")).status, 200);
    assert.equal((await Schedule().findOne({employeeCode: f.code}).lean())?.manualCallHoldId, newer);
    assert.equal((await (await controlStatus(f)).json()).manualCallHold, true);
  } finally { context.mock.timers.reset(); }
});

test("temporary hold preparation validates its lead, phone and browser without reading lead history or granting a call", async context => {
  context.mock.timers.enable({apis: ["Date"], now});
  try {
    const f = await fixture(), saved = await f.evidence();
    for (const options of [{leadId: String(new mongoose.Types.ObjectId())}, {phone: "+12025550199"}, {browserSessionId: "another-long-browser-session"}]) {
      assert.equal((await controlRequest(f, true, options)).status, 409);
      assert.ok(!(await Schedule().findOne({employeeCode: f.code}).lean())?.manualCallHoldId);
    }
    assert.equal((await controlRequest(f, true)).status, 200);
    const held = await Schedule().findOne({employeeCode: f.code}).lean();
    assert.equal(held?.manualCallHoldId, f.attempt); assert.equal(held?.lastDialStartedAt, null); assert.equal(held?.dialIntentUntil, null);
    assert.equal((await f.claim()).status, 204); assert.equal(await f.evidence(), saved);
  } finally { context.mock.timers.reset(); }
});

test("cancellation before queueing cannot be revived by a late hold reply or a retry with the same attempt", async context => {
  context.mock.timers.enable({apis: ["Date"], now});
  try {
    const f = await fixture(); assert.equal((await controlRequest(f, true)).status, 200);
    assert.equal((await cancelHold(f)).status, 204);
    assert.equal((await (await controlStatus(f)).json()).manualCallHold, false);
    const retry = await controlRequest(f, true); assert.equal(retry.status, 409); assert.equal((await retry.json()).code, "NATIVE_ATTEMPT_CANCELLED");
    assert.equal((await f.request()).status, 409); assert.equal((await f.claim()).status, 204);
  } finally { context.mock.timers.reset(); }
});

test("refreshed manual callers echo their hold receipt and claim exactly once in every business", async context => {
  context.mock.timers.enable({apis: ["Date"], now});
  try {for (const business of businesses) {
    const f = await fixture(business), saved = await f.evidence();
    const response = await controlRequest(f, true); assert.equal(response.status, 200);
    const held = await response.json(); assert.equal(held.manualCallHold, true);
    assert.equal((await f.request({manualHoldVersion: held.autoCallControlVersion})).status, 200);
    assert.equal((await f.request({manualHoldVersion: held.autoCallControlVersion})).status, 200);
    assert.deepEqual((await Promise.all([f.claim(), f.claim()])).map(row=>row.status).sort(), [200,204]);
    assert.equal(await f.evidence(), saved);
  }} finally {context.mock.timers.reset();}
});

test("an old manual hold receipt cannot be revived after later clicks and cancellations", async context => {
  context.mock.timers.enable({apis: ["Date"], now});
  try {
    const f = await fixture(), first = await (await controlRequest(f, true)).json();
    assert.equal((await cancelHold(f)).status, 204);
    const newerId = crypto.randomUUID(); assert.equal((await controlRequest(f, true, {operationId: newerId})).status, 200);
    assert.equal((await cancelHold(f, newerId)).status, 204);
    const before = await Schedule().findOne({employeeCode: f.code}).lean();
    assert.equal((await f.request({manualHoldVersion: first.autoCallControlVersion})).status, 409);
    const after = await Schedule().findOne({employeeCode: f.code}).lean();
    assert.equal(after?.manualCallHoldId, ""); assert.equal(after?.autoCallControlVersion, before?.autoCallControlVersion);
    assert.equal(after?.lastDialStartedAt, null); assert.equal((await f.claim()).status, 204);
    for(const manualHoldVersion of [-1,1.2,"invalid"])assert.equal((await f.request({manualHoldVersion})).status,400);
  } finally {context.mock.timers.reset();}
});

test("a cancelled manual click racing with an already-active auto call releases its hold when that existing call ends", async context => {
  context.mock.timers.enable({apis: ["Date"], now});
  try {
    const f = await fixture(), saved = await f.evidence(); await seedAutomaticGrant(f);
    assert.equal((await f.request({manual: false})).status, 200); assert.equal((await f.claim()).status, 200);
    const heartbeat = (state: "active" | "idle") => fetch(`${base}/call-bridge/heartbeat`, {method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${f.token}`}, body: JSON.stringify({state,
      audioSessionActive: state === "active", nextivaProcessDetected: true, bridgeVersion: "0.5.0", nativeDialProtocol: 1})});
    assert.equal((await heartbeat("active")).status, 200);
    const manualId = crypto.randomUUID(); assert.equal((await controlRequest(f, true, {operationId: manualId})).status, 200);
    assert.equal((await cancelHold(f, manualId)).status, 204);
    assert.equal((await (await controlStatus(f)).json()).manualCallHold, true);
    context.mock.timers.setTime(+now + 5000); assert.equal((await heartbeat("idle")).status, 200);
    context.mock.timers.setTime(+now + 13000); assert.equal((await heartbeat("idle")).status, 200);
    assert.equal((await (await controlStatus(f)).json()).manualCallHold, false);
    assert.equal(await f.evidence(), saved);
  } finally { context.mock.timers.reset(); }
});

test("a deadline already preparing cannot authorize after a temporary manual hold changes its control version", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture(), saved = await f.evidence(), deadline = new Date(+now + 500);
    await Schedule().create({ employeeCode: f.code, lastCallEndedAt: new Date(+deadline - 15000), nextCallAllowedAt: deadline });
    let originalRead!: () => void;
    const read = new Promise<void>(resolve => { originalRead = resolve; });
    let requestId = -1;
    const started = (event: {requestId: number; commandName: string; command: {find?: string; filter?: {employeeCode?: string}}}) => {
      if (requestId < 0 && event.commandName === "find" && event.command.find === "callbridgeschedules" && event.command.filter?.employeeCode === f.code) requestId = event.requestId;
    };
    const succeeded = (event: {requestId: number}) => { if (event.requestId === requestId) originalRead(); };
    const client = mongoose.connection.getClient(); client.on("commandStarted", started); client.on("commandSucceeded", succeeded);
    const prepared = fetch(`${base}/call-bridge/dial-at-deadline`, { method: "POST", headers: {
      "Content-Type": "application/json", "X-Business-Id": f.business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)!,
      "X-CRM-Auto-Call-Version": CALLING_QUEUE_POLICY_VERSION }, body: JSON.stringify({ employeeCode: f.code, attemptId: f.attempt,
      notBefore: deadline, browserDeviceKey: f.key, browserSessionId: f.binding }) });
    try {
      await Promise.race([read, new Promise((_, reject) => setTimeout(() => reject(Error("ORIGINAL_DEADLINE_NOT_READ")), 5000).unref())]);
      assert.equal((await controlRequest(f, true)).status, 200);
      assert.equal((await cancelHold(f)).status, 204);
      context.mock.timers.setTime(+deadline);
      const result = await prepared; assert.equal(result.status, 409);
      assert.equal((await Schedule().findOne({employeeCode: f.code}).lean())?.lastDialStartedAt, null);
      assert.equal(await f.evidence(), saved);
    } finally { client.off("commandStarted", started); client.off("commandSucceeded", succeeded); }
  } finally { context.mock.timers.reset(); }
});

test("six businesses hand signed manual commands to exactly one bound native device without changing payroll or punches", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try { for (const business of businesses) {
    const f = await fixture(business), before = await f.evidence();
    const response = await f.request(), body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.queued, true); assert.equal(body.claimed, false);
    assert.equal((await f.request()).status, 200, "a lost browser reply reuses the original command");
    const claims = await Promise.all([f.claim(), f.claim(), f.claim()]);
    assert.deepEqual(claims.map(row => row.status).sort(), [200, 204, 204]);
    const command = await claims.find(row => row.status === 200)!.json();
    assert.equal(command.phone, f.lead.phone); assert.equal(command.attemptId, f.attempt); assert.equal(command.validForMs, 1500);
    assert.equal((await f.claim()).status, 204, "response loss cannot replay the OS handoff");
    assert.equal(await f.evidence(), before);
  } } finally { context.mock.timers.reset(); }
});

test("native automatic handoff revalidates an already consumed phone grant instead of taking a second lease", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture();
    await seedAutomaticGrant(f);
    const before = await Schedule().findOne({ employeeCode: f.code }).lean();
    assert.equal((await f.request({ manual: false })).status, 200);
    const after = await Schedule().findOne({ employeeCode: f.code }).lean();
    assert.deepEqual(after?.lastDialStartedAt, before?.lastDialStartedAt); assert.deepEqual(after?.nextCallAllowedAt, before?.nextCallAllowedAt);
    assert.equal((await f.claim()).status, 200); assert.equal((await f.claim()).status, 204);
  } finally { context.mock.timers.reset(); }
});

test("manual redial waits for real idle confirmation but skips the automatic delay in six businesses", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try { for (const business of businesses) {
    context.mock.timers.setTime(+now);
    const f = await fixture(business), before = await f.evidence();
    const previousDial = new Date(+now - 61_000);
    await Schedule().create({ employeeCode: f.code, lastCallStartedAt: new Date(+now - 60_000), lastDialStartedAt: previousDial, lastReservedAt: previousDial });
    await runWithBusiness(business.id, () => LeadPhoneSlot.create({ _id: f.lead.phone, employeeCode: f.code, attemptId: "previous-call",
      reservedAt: previousDial, consumedAt: previousDial }));
    const heartbeat = async () => { const response = await fetch(`${base}/call-bridge/heartbeat`, { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${f.token}` }, body: JSON.stringify({ state: "idle", audioSessionActive: false,
        nextivaProcessDetected: true, bridgeVersion: "0.5.0", nativeDialProtocol: 1 }) }); assert.equal(response.status, 200); };
    const status = async () => (await fetch(`${base}/call-bridge/status?employeeCode=${f.code}&mode=manual`, { headers: {
      "X-Business-Id": business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)! } })).json();
    await heartbeat();
    let state = await status(); assert.equal(state.waitCode, "CALL_END_UNCONFIRMED"); assert.equal(state.idleConfirmationPending, true);
    assert.equal((await f.request()).status, 409, "waiting permission is not dial authorization");
    context.mock.timers.setTime(+now + 8000); await heartbeat();
    state = await status(); assert.equal(state.waitCode, "POST_CALL_COOLDOWN"); assert.equal(state.idleConfirmationPending, false);
    assert.equal(Date.parse(state.nextCallAllowedAt), +now + 15_000);
    assert.equal(state.ready, false, "automatic callers still see the post-call delay");
    assert.equal((await f.request()).status, 200); assert.equal((await f.claim()).status, 200); assert.equal((await f.claim()).status, 204);
    assert.equal(await f.evidence(), before);
  } } finally { context.mock.timers.reset(); }
});

test("Off the Phone, breaks, checkout, account changes, unknown bridges and changed leads cancel a queued handoff", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try { for (const scenario of ["nonbillable", "off-phone", "break", "lunch", "checkout", "browser", "owner", "phone", "comment", "active", "unknown", "expired", "revoked", "business"]) {
    const f = await fixture(); assert.equal((await f.request()).status, 200, scenario);
    const sources: Record<string, string> = { nonbillable: "Non-Billable Off the Phone Out", "off-phone": "Off the Phone Out", break: "Break Out", lunch: "Lunch Break Out", checkout: "Time Out" };
    if (sources[scenario]) await AttendanceLedger.updateOne({ _id: f.ledgerKey }, { $push: { events: { id: "away", source: sources[scenario], at: new Date(+now + 1).toISOString(), recordedAt: now.toISOString(), sequence: 2, commandId: "fixture" } } });
    if (scenario === "browser") await Device().updateOne({ employeeCode: f.code }, { $set: { browserSessionId: crypto.randomUUID() } });
    if (scenario === "active" || scenario === "unknown") await Device().updateOne({ employeeCode: f.code }, { $set: { state: scenario, audioSessionActive: scenario === "active" } });
    if (scenario === "owner") await runWithBusiness(f.business.id, () => Lead.updateOne({ _id: f.lead._id }, { $set: { assignedAgent: new mongoose.Types.ObjectId() } }));
    if (scenario === "phone") await runWithBusiness(f.business.id, () => Lead.updateOne({ _id: f.lead._id }, { $set: { phone: "+12025550123" } }));
    if (scenario === "comment") await runWithBusiness(f.business.id, () => Lead.updateOne({ _id: f.lead._id }, { $push: { comments: { body: "Synthetic", authorName: f.employee.name, authorType: "employee", createdAt: now } } }));
    if (scenario === "expired") await Schedule().updateOne({ employeeCode: f.code }, { $set: { dialIntentUntil: now } });
    if (scenario === "revoked") await Device().deleteOne({ employeeCode: f.code });
    if (scenario === "business") await setBusinessAccessForEmployeeCode(f.code, [businesses[1].id]);
    const before = await f.evidence(), response = await f.claim();
    assert.ok([204, 403, 409].includes(response.status), `${scenario}: ${response.status}`);
    assert.equal((await Schedule().findOne({ employeeCode: f.code }).lean())?.nativeClaimedAt, null, scenario);
    assert.equal(await f.evidence(), before);
    await Device().deleteMany({ employeeCode: f.code });
    await runWithBusiness(f.business.id, () => LeadPhoneSlot.deleteMany({}));
  } } finally { context.mock.timers.reset(); }
});

test("signed Coaching calls claim once in every business while queued Auto Call is blocked", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  const startCoaching = async (key: string) => AttendanceLedger.updateOne({ _id: key }, { $push: { events: {
    id: "coaching", source: "Coaching Out", at: new Date(+now - 1000).toISOString(), recordedAt: now.toISOString(), sequence: 2, commandId: "fixture",
  } } });
  try { for (const business of businesses) {
    const manual = await fixture(business); await startCoaching(manual.ledgerKey);
    const before = await manual.evidence();
    assert.equal((await manual.request()).status, 200);
    assert.deepEqual((await Promise.all([manual.claim(), manual.claim()])).map(row => row.status).sort(), [200, 204]);
    assert.equal(await manual.evidence(), before);
    const auto = await fixture(business);
    await seedAutomaticGrant(auto);
    assert.equal((await auto.request({ manual: false })).status, 200);
    await startCoaching(auto.ledgerKey);
    const blocked = await auto.claim(); assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "CALL_ATTENDANCE_CHANGED");
    assert.equal((await Schedule().findOne({ employeeCode: auto.code }).lean())?.nativeClaimedAt, null);
  } } finally { context.mock.timers.reset(); }
});

test("unsigned, foreign-device, old Bridge and unresolved dial retries never authorize manual calls", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture();
    assert.equal((await f.request({}, { "X-CRM-Attendance-Session": "" })).status, 401);
    assert.equal((await f.request({ employeeCode: "foreign" })).status, 403);
    assert.equal((await f.claim("wrong")).status, 403);
    assert.equal((await f.request({ browserSessionId: "another-long-browser-session" })).status, 409);
    await Device().updateOne({ employeeCode: f.code }, { $set: { bridgeVersion: "0.4.2", nativeDialProtocol: 0 } });
    assert.equal((await f.request()).status, 409);
    await Device().updateOne({ employeeCode: f.code }, { $set: { bridgeVersion: "0.5.0", nativeDialProtocol: 1 } });
    await Schedule().create({ employeeCode: f.code, lastDialStartedAt: new Date(+now - 29_999), nextCallAllowedAt: new Date(+now + 1) });
    assert.equal((await f.request()).status, 409, "an unconfirmed dial retry is not a confirmed post-call wait");
    context.mock.timers.setTime(+now + 1);
    assert.equal((await f.request()).status, 200, "the expired retry delay does not stack another cooldown");
  } finally { context.mock.timers.reset(); }
});

test("a uniquely owned case-variant legacy lead shown in the queue is readable and dialable, while ambiguous names remain blocked", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try { for (const business of businesses) {
    const f = await fixture(business);
    await runWithBusiness(business.id, () => Lead.updateOne({ _id: f.lead._id }, { $set: { assignedAgent: null, assignedAgentName: "SYNTHETIC" } }));
    const queue = await runWithBusiness(business.id, () => employeeCallingQueue(f.employee, business.id));
    assert.equal(queue.nextLeadId, String(f.lead._id));
    const headers = { "X-Business-Id": business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)! };
    assert.equal((await fetch(`${base}/leads/${f.lead._id}`, { headers })).status, 200, "a queue-owned case variant must not fail with 403");
    assert.equal((await f.request()).status, 200);
    await runWithBusiness(business.id, () => Employee.create({ employeeCode: `other-${crypto.randomUUID()}`, name: "Synthetic", role: "Sales", status: "Active" }));
    assert.equal((await fetch(`${base}/leads/${f.lead._id}`, { headers })).status, 403);
    assert.equal((await f.claim()).status, 204, "ambiguous ownership must invalidate the handoff");
  } } finally { context.mock.timers.reset(); }
});

test("refresh cancellation consumes only the original pending native command and cannot cancel a claimed call", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture(); assert.equal((await f.request()).status, 200);
    const before = await f.evidence(), grant = await Schedule().findOne({ employeeCode: f.code }).lean();
    const cancel = () => fetch(`${base}/call-bridge/native-dial/cancel`, { method: "POST", headers: {
      "Content-Type": "application/json", "X-Business-Id": f.business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)! },
      body: JSON.stringify({ employeeCode: f.code, leadId: String(f.lead._id), attemptId: f.attempt }) });
    assert.equal((await cancel()).status, 204); assert.equal((await f.claim()).status, 204);
    assert.equal((await f.request()).status, 409, "cancellation must not requeue on replay");
    assert.deepEqual((await Schedule().findOne({ employeeCode: f.code }).lean())?.lastDialStartedAt, grant?.lastDialStartedAt);
    assert.equal(await f.evidence(), before);
    const second = await fixture(businesses[1]); assert.equal((await second.request()).status, 200); assert.equal((await second.claim()).status, 200);
    const response = await fetch(`${base}/call-bridge/native-dial/cancel`, { method: "POST", headers: {
      "Content-Type": "application/json", "X-Business-Id": second.business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(second.code)! },
      body: JSON.stringify({ employeeCode: second.code, leadId: String(second.lead._id), attemptId: second.attempt }) });
    assert.equal(response.status, 204);
    assert.equal((await Schedule().findOne({ employeeCode: second.code }).lean())?.nativeCancelledAt, null);
  } finally { context.mock.timers.reset(); }
});

test("native readiness is bound to the browser, and verified Bridge credentials have separate rate buckets without exempting invalid tokens", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture();
    const headers = { "X-Business-Id": f.business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)!,
      "X-CRM-Native-Dial": "1", "X-CRM-Bridge-Browser-Key": f.key, "X-CRM-Bridge-Browser-Session": f.binding };
    let body = await (await fetch(`${base}/call-bridge/status?employeeCode=${f.code}`, { headers })).json();
    assert.equal(body.nativeDialReady, true);
    body = await (await fetch(`${base}/call-bridge/status?employeeCode=${f.code}`, { headers: { ...headers, "X-CRM-Bridge-Browser-Session": "another-browser-session" } })).json();
    assert.equal(body.nativeDialReady, false); assert.equal(body.ready, false); assert.equal(body.deadlineDispatchEnabled, false);
    const key = (token: string, path = "/call-bridge/native-dial/claim") => securityRequestKey({ method: "POST", path, ip: "198.51.100.8",
      header: (name: string) => name === "authorization" ? `Bearer ${token}` : undefined } as unknown as Request);
    assert.equal(await key(f.token), `bridge:${nativeSecretHash(f.token)}`);
    assert.equal(await key("invalid-but-long-enough-for-the-fixture"), await key("another-invalid-but-long-enough-token"));
    assert.notEqual(await key(f.token), await key(f.token, "/other-route"));
    await Device().deleteOne({ employeeCode: f.code });
    assert.equal(await key(f.token), await key("invalid-but-long-enough-for-the-fixture"));
  } finally { context.mock.timers.reset(); }
});

test("explicit manual calls accept existing notes, saved outcomes, future callbacks and non-archived statuses in six businesses", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try { for (const business of businesses) for (const scenario of ["comment", "outcome", "future", "qualified"]) {
    const f = await fixture(business), before = await f.evidence();
    const changes = scenario === "comment" ? { comments: [{ body: "Synthetic saved note", authorName: f.employee.name, authorType: "employee", createdAt: now }] }
      : scenario === "outcome" ? { lastCallOutcomeAt: now }
      : scenario === "future" ? { status: "Follow up", followUpAt: new Date(+now + 3600000) } : { status: "Qualified" };
    await runWithBusiness(business.id, () => Lead.updateOne({ _id: f.lead._id }, { $set: changes }));
    assert.equal((await f.request({ manual: false })).status, 409, scenario + " must remain blocked for automatic dialing");
    const response = await f.request(); assert.equal(response.status, 200, scenario + ": " + JSON.stringify(await response.json()));
    assert.equal((await f.claim()).status, 200); assert.equal((await f.claim()).status, 204);
    assert.equal(await f.evidence(), before);
  } } finally { context.mock.timers.reset(); }
});

test("a saved tag after manual queueing cancels that old intent, and a retry cannot change its manual mode", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const f = await fixture(); assert.equal((await f.request()).status, 200);
    assert.equal((await f.request({ manual: false })).status, 409);
    await runWithBusiness(f.business.id, () => Lead.updateOne({ _id: f.lead._id }, { $set: { lastCallOutcomeAt: now } }));
    assert.equal((await f.claim()).status, 409);
    assert.equal((await Schedule().findOne({ employeeCode: f.code }).lean())?.nativeClaimedAt, null);
  } finally { context.mock.timers.reset(); }
});

test("a signed manual call works while auto-call is paused, including a duplicate record's saved outcome", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  const previous = process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES;
  try { for (const business of businesses) {
    const f = await fixture(business), saved = await f.evidence();
    process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES = f.code;
    await runWithBusiness(f.business.id, () => Lead.collection.insertOne({ businessName: "Synthetic duplicate", phone: f.lead.phone,
      status: "Archived", lastCallOutcomeAt: now }));
    const statusUrl = `${base}/call-bridge/status?employeeCode=${f.code}`;
    const headers = { "X-Business-Id": f.business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)! };
    const automatic = await (await fetch(statusUrl, { headers })).json();
    assert.equal(automatic.ready, false);
    const manual = await (await fetch(`${statusUrl}&mode=manual`, { headers })).json();
    assert.equal(manual.ready, true);
    assert.ok([401, 403].includes((await fetch(`${statusUrl}&mode=manual`)).status));
    assert.equal((await f.request({ manual: false })).status, 409);
    assert.equal((await f.request()).status, 200);
    assert.equal((await f.claim()).status, 200);
    assert.equal((await f.claim()).status, 204);
    assert.equal(await f.evidence(), saved);
  } } finally {
    if (previous === undefined) delete process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES;
    else process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES = previous;
    context.mock.timers.reset();
  }
});


test("business Auto Call restrictions follow business switches and preserve signed manual handoffs", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  const previous = process.env.AUTO_CALL_DISABLED_BUSINESS_IDS;
  const { isAutoCallDisabledForEmployee } = await import("../config/callProvider");
  try {
    process.env.AUTO_CALL_DISABLED_BUSINESS_IDS = businesses.slice(0, 2).map(row => row.id).join(",");
    for (const [index, business] of businesses.entries()) {
      const f = await fixture(business), before = await f.evidence();
      assert.equal(await runWithBusiness(business.id, () => isAutoCallDisabledForEmployee(f.code)), index < 2);
      assert.equal(await runWithBusiness(businesses[2].id, () => isAutoCallDisabledForEmployee(f.code)), false);
      const headers = { "X-Business-Id": business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)! };
      const status = await (await fetch(`${base}/call-bridge/status?employeeCode=${f.code}`, { headers })).json();
      assert.equal(status.autoCallDisabled === true, index < 2);
      assert.equal((await f.request()).status, 200, "manual calls remain available while Auto Call is disabled");
      assert.equal((await f.claim()).status, 200); assert.equal((await f.claim()).status, 204);
      const grant = await fixture(business);
      await seedAutomaticGrant(grant);
      const automatic = await grant.request({ manual: false });
      assert.equal(automatic.status, index < 2 ? 409 : 200);
      if (index < 2) {
        assert.equal((await automatic.json()).code, "CALLING_NOT_AVAILABLE");
        assert.equal((await grant.claim()).status, 204);
      } else {
        assert.equal((await grant.claim()).status, 200); assert.equal((await grant.claim()).status, 204);
      }
      assert.equal(await f.evidence(), before);
    }
    const f = await fixture();
    delete process.env.AUTO_CALL_DISABLED_BUSINESS_IDS;
    await seedAutomaticGrant(f);
    assert.equal((await f.request({ manual: false })).status, 200);
    process.env.AUTO_CALL_DISABLED_BUSINESS_IDS = f.business.id;
    const blocked = await f.claim(); assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "CALLING_NOT_AVAILABLE");
    assert.equal((await Schedule().findOne({ employeeCode: f.code }).lean())?.nativeClaimedAt, null);
  } finally {
    if (previous === undefined) delete process.env.AUTO_CALL_DISABLED_BUSINESS_IDS;
    else process.env.AUTO_CALL_DISABLED_BUSINESS_IDS = previous;
    context.mock.timers.reset();
  }
});


test("one scoped employee is blocked automatically while colleagues and other businesses remain enabled and manual calls still work", async context => {
  const employeeCodes = process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES, businessIds = process.env.AUTO_CALL_DISABLED_BUSINESS_IDS;
  const { isAutoCallDisabledForEmployee } = await import("../config/callProvider");
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    process.env.AUTO_CALL_DISABLED_BUSINESS_IDS = "";
    for (const [index, business] of businesses.entries()) {
      const target = await fixture(business), other = await fixture(business), before = await target.evidence();
      process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES = `${business.id}:${target.code}`;
      assert.equal(await runWithBusiness(business.id, () => isAutoCallDisabledForEmployee(target.code)), true);
      assert.equal(await runWithBusiness(business.id, () => isAutoCallDisabledForEmployee(other.code)), false);
      assert.equal(await runWithBusiness(businesses[(index + 1) % businesses.length].id, () => isAutoCallDisabledForEmployee(target.code)), false);
      const headers = { "X-Business-Id": business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(target.code)! };
      const status = await (await fetch(`${base}/call-bridge/status?employeeCode=${target.code}`, { headers })).json();
      assert.equal(status.autoCallDisabled, true);
      const blocked = await target.request({ manual: false });
      assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, "CALLING_NOT_AVAILABLE");
      assert.equal((await target.request()).status, 200); assert.equal((await target.claim()).status, 200);
      await seedAutomaticGrant(other);
      assert.equal((await other.request({ manual: false })).status, 200); assert.equal((await other.claim()).status, 200);
      assert.equal(await target.evidence(), before);
    }
  } finally {
    if (employeeCodes === undefined) delete process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES; else process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES = employeeCodes;
    if (businessIds === undefined) delete process.env.AUTO_CALL_DISABLED_BUSINESS_IDS; else process.env.AUTO_CALL_DISABLED_BUSINESS_IDS = businessIds;
    context.mock.timers.reset();
  }
});

test("manual handoff uses one projected transaction snapshot without reading call history", async context => {
  context.mock.timers.enable({apis: ["Date"], now});
  const reads: Array<Record<string, unknown> | undefined> = [];
  let watched = "";
  const monitor = (event: {commandName: string; command: {find?: string; filter?: {_id?: unknown}; autocommit?: boolean; projection?: Record<string, unknown>}}) => {
    if (event.commandName === "find" && event.command.find === "leads" && event.command.autocommit === false && String(event.command.filter?._id) === watched) reads.push(event.command.projection);
  };
  mongoose.connection.getClient().on("commandStarted", monitor);
  try {for (const business of businesses) {
    const f = await fixture(business), saved = await f.evidence(); watched = String(f.lead._id); reads.length = 0;
    const queued = await f.request(); assert.equal(queued.status, 200);
    assert.equal(reads.length, 1, "DUPLICATE_DISPATCH_LEAD_READ");
    assert.ok(reads[0], "DISPATCH_SNAPSHOT_MUST_NOT_READ_HISTORY");
    const fields = Object.keys(reads[0]!);
    for (const field of ["assignedAgent", "assignedAgentName", "assignmentRevision", "status", "phone", "followUpAt", "lastCallOutcomeAt", "comments"]) assert.ok(fields.includes(field), field);
    assert.ok(!fields.includes("activity") && !fields.includes("callLogs"));
    reads.length = 0; const claimed = await f.claim(); assert.equal(claimed.status, 200);
    assert.equal(reads.length, 1, "DUPLICATE_CLAIM_LEAD_READ"); assert.ok(reads[0]);
    assert.equal((await f.claim()).status, 204); assert.equal(await f.evidence(), saved);
  }} finally {mongoose.connection.getClient().off("commandStarted", monitor); context.mock.timers.reset();}
});

test("claim uses one transactional attendance check and retains its canonical dispatch fence", async context => {
  context.mock.timers.enable({apis: ["Date"], now});
  const reads: boolean[] = [], fences: boolean[] = [], employeeReads: boolean[] = []; let watched = "", watchedCode = "";
  const monitor = (event: {commandName: string; command: {find?: string; update?: string; filter?: {_id?: unknown; employeeCode?: string}; autocommit?: boolean;
    updates?: Array<{q?: {_id?: unknown}; u?: {$inc?: {fence?: number}}}>}}) => {
    if (event.commandName === "find" && event.command.find === "attendanceledgers" && event.command.filter?._id === watched) reads.push(event.command.autocommit === false);
    if (event.commandName === "find" && event.command.find === "employees" && event.command.filter?.employeeCode === watchedCode) employeeReads.push(event.command.autocommit === false);
    if (event.commandName === "update" && event.command.update === "attendanceledgers" &&
      event.command.updates?.some(row => row.q?._id === watched && row.u?.$inc?.fence === 1)) fences.push(event.command.autocommit === false);
  };
  mongoose.connection.getClient().on("commandStarted", monitor);
  try {for (const business of businesses) {
    const f = await fixture(business); assert.equal((await f.request()).status, 200);
    watched = f.ledgerKey; watchedCode = f.code; reads.length = 0; fences.length = 0; employeeReads.length = 0;
    assert.equal((await f.claim()).status, 200);
    assert.deepEqual(reads, [true], "DUPLICATE_CANONICAL_ATTENDANCE_CLAIM_READ"); assert.deepEqual(fences, [true]);
    assert.deepEqual(employeeReads, [false, true], "DUPLICATE_EMPLOYEE_AUTHORIZATION_READ");
    reads.length = 0; fences.length = 0; employeeReads.length = 0; assert.equal((await f.claim()).status, 204);
    assert.equal(reads.length, 0); assert.equal(fences.length, 0); assert.equal(employeeReads.length, 0);
  }} finally {mongoose.connection.getClient().off("commandStarted", monitor); context.mock.timers.reset();}
});

test("twenty simultaneous paused-auto manual calls retain protocol-1 freshness across three rounds", async context => {
  context.mock.timers.enable({apis: ["Date"], now});
  const oldDisabled = process.env.AUTO_CALL_DISABLED_BUSINESS_IDS;
  try {
    const {freemem} = await import("node:os");
    global.gc?.();
    const checkCapacity = () => assert.ok(freemem() >= 192 * 1048576, "SAFE_MANUAL_FIXTURE_MEMORY_RESERVE_REACHED");
    const people: Array<Awaited<ReturnType<typeof fixture>>> = [];
    for (let index = 0; index < 20; index++) {
      checkCapacity();
      const f = await fixture(businesses[index % businesses.length]); people.push(f);
      if (index % 2) await AttendanceLedger.updateOne({_id: f.ledgerKey}, {$push: {events: {id: "coaching", source: "Coaching Out",
        at: new Date(+now - 1000).toISOString(), recordedAt: now.toISOString(), sequence: 2, commandId: "fixture"}}});
      await runWithBusiness(f.business.id, () => Lead.collection.updateOne({_id: f.lead._id}, {$set: {
        activity: Array.from({length: 1000}, () => ({label: "Synthetic history", detail: "Synthetic record only. ".repeat(8), status: "Done", actorType: "employee", actorName: "Synthetic", createdAt: now})),
        callLogs: Array.from({length: 1000}, () => ({employee: f.employee._id, employeeName: "Synthetic", employeeRole: "Sales", employeeTeam: "Synthetic", calledAt: now})),
      }}));
    }
    process.env.AUTO_CALL_DISABLED_BUSINESS_IDS = businesses.map(business => business.id).join(",");
    const saved = await Promise.all(people.map(person => person.evidence()));
    const rounds: Array<{callers: number; claimedOnce: number; maximumClaimMs: number; maximumAllowedBudgetMs: number}> = [];
    const bridgeCommands: Array<{attemptId: string; phone: string; validForMs: number; simulatedClaimMs: number}> = [];
    for (let round = 0; round < 3; round++) {
      global.gc?.();
      checkCapacity();
      const at = new Date(+now + round * 60000); context.mock.timers.setTime(+at);
      await Schedule().deleteMany({});
      for (const business of businesses) await runWithBusiness(business.id, () => LeadPhoneSlot.deleteMany({}));
      await Device().updateMany({}, {$set: {state: "idle", audioSessionActive: false, lastSeenAt: at, lastIdleAt: at, inactiveSince: null}});
      const attempts: string[] = people.map(() => crypto.randomUUID());
      const queued = await Promise.all(people.map((person, index) => person.request({attemptId: attempts[index]})));
      assert.ok(queued.every(response => response.status === 200), "SIMULTANEOUS_MANUAL_QUEUE_FAILED");
      const queueBodies = await Promise.all(queued.map(response => response.json()));
      assert.ok(queueBodies.every((body, index) => body.queued === true && body.attemptId === attempts[index] &&
        body.leadId === String(people[index].lead._id)), "SIMULTANEOUS_MANUAL_TARGET_CHANGED");
      const claimTimes: number[] = [];
      const results = await Promise.allSettled(people.map(async (person, index) => {
        checkCapacity();
        const started = performance.now();
        const response = await fetch(`${base}/call-bridge/native-dial/claim`, {method: "POST", signal: AbortSignal.timeout(3000), headers: {
          "Content-Type": "application/json", "X-Business-Id": person.business.id, Authorization: `Bearer ${person.token}`}, body: JSON.stringify({deviceId: person.code})});
        assert.equal(response.status, 200); const command = await response.json();
        const requestMs = Math.ceil(performance.now() - started);
        claimTimes.push(requestMs);
        assert.equal(command.attemptId, attempts[index]); assert.equal(command.phone, person.lead.phone);
        assert.ok(requestMs + 100 < command.validForMs, `LEGACY_BRIDGE_FRESHNESS_BUDGET_EXHAUSTED: ${requestMs} + 100 >= ${command.validForMs}`);
        assert.equal((await person.claim()).status, 204, "A command must never replay");
        bridgeCommands.push({attemptId: command.attemptId, phone: "+12025550100", validForMs: command.validForMs, simulatedClaimMs: requestMs});
        return requestMs;
      }));
      const rejected = results.filter(row => row.status === "rejected");
      context.diagnostic(JSON.stringify({kind: "manual-claim-round", round, callers: people.length, measured: claimTimes.length,
        maximumClaimMs: Math.max(0, ...claimTimes), failedClaims: rejected.length,
        nonBudgetFailures: rejected.filter(row => !String(row.reason?.message || row.reason).startsWith("LEGACY_BRIDGE_FRESHNESS_BUDGET_EXHAUSTED")).length}));
      const claims = results.map(row => { if (row.status === "rejected") throw row.reason; return row.value; });
      for (const [index, person] of people.entries()) {
        const headers = {"X-Business-Id": person.business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(person.code)!};
        const path: string = `${base}/call-bridge/status?mode=manual&employeeCode=${encodeURIComponent(person.code)}`;
        const before: {observedAttemptId?: string | null} = await (await fetch(path, {headers})).json();
        assert.notEqual(before.observedAttemptId, attempts[index], "A claim alone must not confirm a call start");
        const heartbeat: Awaited<ReturnType<typeof fetch>> = await fetch(`${base}/call-bridge/heartbeat`, {method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${person.token}`},
          body: JSON.stringify({state: "active", audioSessionActive: true, nextivaProcessDetected: true, bridgeVersion: "0.5.0", nativeDialProtocol: 1})});
        assert.equal(heartbeat.status, 200); await heartbeat.json();
        const observed: {observedAttemptId?: string | null; observedLeadId?: string | null} = await (await fetch(path, {headers})).json();
        assert.equal(observed.observedAttemptId, attempts[index]); assert.equal(observed.observedLeadId, String(person.lead._id));
      }
      for (const response of await Promise.all(people.map(person => person.request({manual: false})))) {
        assert.equal(response.status, 409); assert.equal((await response.json()).code, "CALLING_NOT_AVAILABLE", "AUTO_CALL_MUST_STAY_DISABLED");
      }
      assert.deepEqual(await Promise.all(people.map(person => person.evidence())), saved);
      rounds.push({callers: 20, claimedOnce: 20, maximumClaimMs: Math.max(...claims), maximumAllowedBudgetMs: 1500});
    }
    const reportPath = process.env.MANUAL_HANDOFF_STRESS_REPORT;
    if (reportPath) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(reportPath, JSON.stringify({businesses: businesses.length, rounds,
        coachingCallers: 10, autoCallStayedDisabled: true, payrollAndOriginalAttendanceUnchanged: true, bridgeCommands,
        simulatedOnly: true, physicalNextivaLaunchMeasured: false, productionWrites: 0, realCalls: 0}));
    }
  } finally {
    if (oldDisabled === undefined) delete process.env.AUTO_CALL_DISABLED_BUSINESS_IDS; else process.env.AUTO_CALL_DISABLED_BUSINESS_IDS = oldDisabled;
    context.mock.timers.reset();
  }
});
