import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { LeadStatus } from "../models/Lead";

const prefix = `comments_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, index) => `comment-${index}`);
Object.assign(process.env, { NODE_ENV: "test", CRM_SECURITY_LEGACY_AUTH: "true", CRM_LEAD_PHONE_DEDUP_V2: "true",
    CRM_ADMIN_ONE_CODE: "synthetic-comment-admin", CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"),
    DEFAULT_BUSINESS_ID: businesses[0], DEFAULT_BUSINESS_DATABASE: `${prefix}_0`, CONTROL_DATABASE_NAME: `${prefix}_control`,
    BUSINESS_DATABASES: JSON.stringify(businesses.map((id, index) => ({ id, databaseName: `${prefix}_${index}` }))) });
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Lead } = await import("../models/Lead");
const { Employee } = await import("../models/Employee");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
let mongo: MongoMemoryReplSet, server: http.Server, base = "", admin = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    assert.equal(new URL(mongo.getUri(prefix)).hostname, "127.0.0.1");
    await mongoose.connect(mongo.getUri(prefix));
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    admin = createAdminDashboardSession("synthetic-comment-admin")!;
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });

async function fixture(index: number, suffix = String(index)) {
    const business = businesses[index], code = `synthetic-owner-${suffix}`;
    await setBusinessAccessForEmployeeCode(code, businesses);
    return runWithBusiness(business, async () => {
        const owner = await Employee.create({ employeeCode: code, name: "Synthetic Comment Owner", role: "Sales", status: "Active" });
        const other = await Employee.create({ employeeCode: `synthetic-other-${suffix}`, name: "Synthetic Other", role: "Sales", status: "Active" });
        await setBusinessAccessForEmployeeCode(other.employeeCode, [business]);
        const create = (status: LeadStatus = "NEW", extra = {}) => Lead.create({ businessName: "Synthetic Comment Lead", status, assignedAgent: owner._id,
            assignedAgentName: owner.name, ...extra });
        const request = async (route: string, body?: unknown, token = createAttendanceHubSession(code)!, method?: string, target = business) => {
            const response = await fetch(base + route, { method: method || (body === undefined ? "GET" : "POST"),
                headers: { "Content-Type": "application/json", "X-Business-Id": target,
                    [token === admin ? "X-CRM-Admin-Session" : "X-CRM-Attendance-Session"]: token },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            return { status: response.status, data: await response.json() };
        };
        return { business, owner, other, create, request };
    });
}

for (let index = 0; index < businesses.length; index++) test(`lead comments save, reload, edit and remain tenant-scoped in synthetic business ${index + 1}`, async () => {
    const f = await fixture(index);
    const lead = await runWithBusiness(f.business, () => f.create());
    const endpoint = `/leads/${lead._id}/comments`, body = "Synthetic first line\n<script>not executable</script> second line";
    assert.equal((await f.request(endpoint, { body: "   " })).status, 400);
    assert.equal((await f.request(endpoint, { body }, "")).status, 401);
    assert.equal((await f.request(endpoint, { body }, createAttendanceHubSession(f.other.employeeCode)!)).status, 403);
    const saved = await f.request(endpoint, { body: `  ${body}  `, authorName: "Forged Admin", authorType: "admin" });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.comments.length, 1); assert.equal(saved.data.comments[0].body, body);
    assert.equal(saved.data.comments[0].authorName, f.owner.name); assert.equal(saved.data.comments[0].authorType, "employee");
    assert.equal(saved.data.status, "Follow up"); assert.equal(String(saved.data.assignedAgent._id), String(f.owner._id));
    assert.equal(saved.data.activity.filter((row: { label: string }) => row.label === "Status changed").length, 1);
    const id = saved.data.comments[0]._id, at = saved.data.comments[0].createdAt;
    for (let refresh = 0; refresh < 2; refresh++) {
        const current = await f.request(`/leads/${lead._id}`);
        assert.equal(current.status, 200); assert.equal(current.data.comments[0]._id, id); assert.equal(current.data.comments[0].body, body);
        const adminView = await f.request(`/leads/${lead._id}`, undefined, admin);
        assert.deepEqual(adminView.data.comments, current.data.comments);
    }
    const edited = await f.request(`${endpoint}/${id}`, { body: "Synthetic edited note" }, admin, "PATCH");
    assert.equal(edited.status, 200); assert.equal(edited.data.comments.length, 1); assert.equal(edited.data.comments[0].body, "Synthetic edited note");
    assert.equal(edited.data.comments[0].createdAt, at); assert.equal(edited.data.comments[0].authorName, f.owner.name);
    assert.equal((await f.request(`/leads/${lead._id}`)).data.comments[0].body, "Synthetic edited note");
    const anotherBusiness = businesses[(index + 1) % businesses.length];
    assert.equal((await f.request(endpoint, { body: "Must not cross tenants" }, admin, "POST", anotherBusiness)).status, 404);
    assert.equal((await f.request(`/leads/${lead._id}`)).data.comments.length, 1);
});

test("concurrent administrator and employee comments are both retained without duplicate NEW status transitions", async () => {
    const f = await fixture(0, "concurrent"), lead = await runWithBusiness(businesses[0], () => f.create());
    const endpoint = `/leads/${lead._id}/comments`;
    const saved = await Promise.all([f.request(endpoint, { body: "Synthetic employee note" }),
        f.request(endpoint, { body: "Synthetic administrator note", authorType: "admin", authorName: "Synthetic Admin" }, admin)]);
    assert.deepEqual(saved.map(row => row.status), [200, 200]);
    const fresh = (await f.request(`/leads/${lead._id}`)).data;
    assert.deepEqual(fresh.comments.map((row: { body: string }) => row.body).sort(), ["Synthetic administrator note", "Synthetic employee note"]);
    assert.equal(fresh.activity.filter((row: { label: string }) => row.label === "Status changed").length, 1);
    assert.equal(fresh.activity.filter((row: { label: string }) => row.label === "Comment added").length, 2);
    assert.equal(fresh.status, "Follow up");
});

test("comments retain follow-up schedules and cannot revive Dead or Qualified leads", async () => {
    const f = await fixture(1, "status"), followUpAt = new Date("2026-11-01T16:00:00Z");
    for (const status of ["Follow up", "Dead", "Qualified"] as const) {
        const lead = await runWithBusiness(f.business, () => f.create(status, { followUpAt, followUpNote: "Synthetic callback details", callCount: 3 }));
        const saved = await f.request(`/leads/${lead._id}/comments`, { body: "Synthetic status-preserving note" });
        assert.equal(saved.status, 200); assert.equal(saved.data.status, status);
        assert.equal(saved.data.followUpAt, followUpAt.toISOString()); assert.equal(saved.data.callCount, 3);
        assert.equal(saved.data.followUpNote, "Synthetic callback details");
    }
});
