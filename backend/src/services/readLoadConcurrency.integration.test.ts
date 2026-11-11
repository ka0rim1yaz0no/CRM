import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { before, after, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { CALLING_QUEUE_POLICY_VERSION } from "../../../shared/leadCallingPolicy";
import type { SessionEvent } from "./attendanceSessionState";

const prefix = `read_load_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, index) => ({ id: `load-${index}`, databaseName: `${prefix}_${index}` }));
process.env.NODE_ENV = "test";
Object.assign(process.env, { BUSINESS_DATABASES: JSON.stringify(businesses), DEFAULT_BUSINESS_ID: businesses[0].id,
    DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName, CONTROL_DATABASE_NAME: `${prefix}_control`, CRM_SECURITY_LEGACY_AUTH: "true",
    CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"), CRM_ATTENDANCE_INTEGRITY: "true", CRM_ATTENDANCE_ACTIVE_SESSION: "true",
    CRM_ATTENDANCE_DURATION_MODEL: "true", CRM_ATTENDANCE_AUTO_TIMEOUT: "false", CRM_LEAD_PHONE_DEDUP_V2: "true" });
const baselineRoot = process.env.CRM_READ_LOAD_BASELINE_SOURCE;
if (baselineRoot) assert.ok(path.isAbsolute(baselineRoot), "The optional read-load baseline must be an absolute path");
const { createApp } = await import("../app");
const old = baselineRoot ? await import(pathToFileURL(path.join(baselineRoot, "backend/src/app.ts")).href) : null;
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { Lead } = await import("../models/Lead");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { setBusinessAccessForEmployeeCode, getAttendanceBusinessIdentity } = await import("../models/BusinessUserAccess");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { assignAttendanceShift } = await import("./attendanceShift");
const people: Array<{ id: string; code: string; business: typeof businesses[number]; token: string; leadIds: string[] }> = [];
const servers: http.Server[] = [], origins: string[] = [];
let mongo: MongoMemoryReplSet, forbiddenWrites = 0;

before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ args: ["--wiredTigerCacheSizeGB", "0.25"] }] });
    const uri = mongo.getUri(prefix); assert.equal(new URL(uri).hostname, "127.0.0.1");
    await mongoose.connect(uri);
    await AttendancePolicy.create({ _id: "global-attendance", revision: 1, shiftStart: "23:00", shiftEnd: "08:00", breakMinutes: 15, lunchMinutes: 60, graceMinutes: 0 });
    for (let index = 0; index < 50; index++) {
        const business = businesses[index % businesses.length], code = `synthetic-load-${index}`;
        const person = await runWithBusiness(business.id, () => Employee.create({ employeeCode: code, name: code, role: "Sales", status: "Active", availabilityStatus: "ONLINE" }));
        await setBusinessAccessForEmployeeCode(code, [business.id]);
        const identity = await getAttendanceBusinessIdentity(code); assert.ok(identity);
        const events: SessionEvent[] = [], start = Date.now() - 61 * 86400000;
        for (let day = 0; day < 60; day++) for (const [source, offset] of [["Time In", 0], ["Break Out", 3600000], ["Break In", 4500000], ["Time Out", 32400000]] as const) {
            const at = new Date(start + day * 86400000 + offset).toISOString(), sequence = events.length;
            events.push({ id: `${index}-${sequence}`, source, at, recordedAt: at, sequence, commandId: `${index}-${sequence}`,
                ...(source === "Time In" ? { shift: assignAttendanceShift(new Date(at)) } : {}) });
        }
        const at = new Date(Date.now() - 3600000).toISOString();
        events.push({ id: `${index}-active`, source: "Time In" as const, at, recordedAt: at, sequence: events.length, commandId: `${index}-active`, shift: assignAttendanceShift(new Date(at)) });
        await AttendanceLedger.create({ _id: `access:${identity.id}`, employeeCode: code, canonicalBusinessId: business.id, businessIds: [business.id],
            revision: 7, events, corrections: [], closures: [], audit: [], commands: [], jobs: [] });
        const leadIds = await runWithBusiness(business.id, async () => {
            const leads = await Lead.insertMany(Array.from({ length: 10 }, (_, item) => ({ businessName: `Synthetic ${index}-${item}`, assignedAgent: person._id, assignedAgentName: code,
                status: "NEW", phone: `+1202555${String(100 + index * 10 + item).padStart(4, "0")}`, comments: [], activity: [], createdAt: new Date(start + item) })));
            await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").insertOne({ employee: person._id, status: "Paid", netPay: 12345, paidOn: "Synthetic saved payment" });
            return leads.map(lead => String(lead._id));
        });
        people.push({ id: String(person._id), code, business, token: createAttendanceHubSession(code)!, leadIds });
    }
    for (const factory of old ? [createApp, old.createApp] : [createApp]) {
        const app = factory();
        const server = http.createServer((request, response) => {
            if (request.method !== "GET") { forbiddenWrites++; response.writeHead(403); response.end(); return; }
            app(request, response);
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
        origins.push(`http://127.0.0.1:${(server.address() as { port: number }).port}/api`);
    }
});
after(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } await mongoose.disconnect(); await mongo?.stop(); });

async function evidence() {
    const values: unknown[] = [await AttendanceLedger.find({}).sort({ _id: 1 }).lean()];
    for (const business of businesses) values.push(await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").find({}).sort({ _id: 1 }).toArray());
    return crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
async function read(origin: string, person: typeof people[number], route: string) {
    const start = performance.now(), response = await fetch(origin + route, { headers: { "X-Business-Id": person.business.id, "X-CRM-Attendance-Session": person.token }, signal: AbortSignal.timeout(30000) });
    const text = await response.text(); assert.equal(response.status, 200);
    return { body: JSON.parse(text), bytes: Buffer.byteLength(text), milliseconds: performance.now() - start };
}
const percentiles = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return { p95Ms: Math.round(sorted[Math.ceil(sorted.length * .95) - 1]), p99Ms: Math.round(sorted[Math.ceil(sorted.length * .99) - 1]) }; };

test("10/25/50 real concurrent local HTTP readers preserve canonical state and reduce status bytes without production data or writes", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date() });
    const [origin, baselineOrigin] = origins;
    const before = await evidence(), reports = [];
    for (const users of [10, 25, 50]) {
        const selected = people.slice(0, users);
        const reference = await Promise.all(selected.map(person => read(baselineOrigin ?? origin, person,
            `/employees/${person.id}/attendance/session${baselineOrigin ? "?view=status" : ""}`)));
        const status = await Promise.all(selected.map(person => read(origin, person, `/employees/${person.id}/attendance/session?view=status`)));
        for (let index = 0; index < users; index++) {
            const previous = reference[index].body, candidate = status[index].body;
            for (const key of ["state", "stateSince", "sessionId", "revision", "fingerprint", "reviewState", "allowedActions", "policyRevision", "assignedShift"])
                assert.deepEqual(candidate[key], previous[key]);
            if (!baselineOrigin) { assert.equal(previous.historyIncluded, true); assert.equal(previous.sessions.length, 61); }
            assert.equal(candidate.sessions.length, 1); assert.equal(candidate.records.length, 0); assert.equal(candidate.historyIncluded, false);
            assert.ok(status[index].bytes < reference[index].bytes * .2);
        }
        reports.push({ users, reference: percentiles(reference.map(row => row.milliseconds)), status: percentiles(status.map(row => row.milliseconds)),
            statusBytesReductionPercent: Math.round(100 * (1 - status.reduce((sum,row)=>sum+row.bytes,0) / reference.reduce((sum,row)=>sum+row.bytes,0))) });
    }
    assert.equal(await evidence(), before); assert.equal(forbiddenWrites, 0);
    console.log(JSON.stringify({ isolatedLocalHttpLoad: reports, reference: baselineOrigin ? "historical-status" : "full-session",
        businesses: 6, realCalls: 0, productionWrites: 0, originalAttendanceAndSavedPayrollUnchanged: true }));
});

test("concurrent queue reads preserve scoped selection, order, policy and refresh dependencies", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date() });
    const [origin, baselineOrigin] = origins, before = await evidence();
    const previousQueues = new Map<string, unknown>();
    const route = "/my-leads?callingQueue=true&limit=1";
    const comparable = (queue: Record<string, unknown>) => Object.fromEntries(Object.entries(queue).filter(([key]) =>
        !["serverTime", "refreshDependencies", "refreshDependenciesFingerprint", "refreshDependenciesUnchanged"].includes(key)));
    for (const users of [10, 25, 50]) {
        const results = await Promise.all(people.slice(0, users).map(async person => {
            const candidate = await read(origin, person, route), queue = candidate.body.callingQueue;
            const previous = baselineOrigin ? await read(baselineOrigin, person, route) : null;
            if (previous) assert.deepEqual(comparable(queue), comparable(previous.body.callingQueue));
            if (previousQueues.has(person.id)) assert.deepEqual(queue, previousQueues.get(person.id));
            previousQueues.set(person.id, queue);
            assert.deepEqual(queue.scope, { businessId: person.business.id, employeeId: person.id, employeeCode: person.code });
            assert.equal(queue.policyVersion, CALLING_QUEUE_POLICY_VERSION);
            assert.match(queue.version, /^[a-f0-9]{64}$/);
            assert.equal(queue.nextLeadId, person.leadIds.at(-1));
            assert.equal(queue.nextDecision?.reason, "NEW");
            assert.equal(queue.entries.length, 1);
            assert.equal(queue.entries[0].leadId, queue.nextLeadId);
            assert.equal(queue.repeatLeadId, null);
            const dependencies = queue.refreshDependencies;
            assert.equal(dependencies.version, 1);
            assert.deepEqual([...dependencies.leadIds].sort(), [...person.leadIds].sort());
            assert.equal(dependencies.phones.length, 10);
            assert.match(queue.refreshDependenciesFingerprint, /^[a-f0-9]{64}$/);
            return { baseline: previous?.milliseconds ?? null, candidate: candidate.milliseconds };
        }));
        console.log(JSON.stringify({ isolatedQueueReaders: users, unchangedSelectionAndPolicy: true,
            ...(baselineOrigin ? { baseline: percentiles(results.flatMap(row => row.baseline ?? [])) } : {}),
            candidate: percentiles(results.map(row => row.candidate)) }));
    }
    assert.equal(await evidence(), before); assert.equal(forbiddenWrites, 0);
});
