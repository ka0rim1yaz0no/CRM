import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { before, after, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const root = `admin_search_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, index) => ({ id: `search-${index}`, databaseName: `${root}_${index}` }));
Object.assign(process.env, { NODE_ENV: "test", CRM_SECURITY_LEGACY_AUTH: "true", CRM_LEAD_PHONE_DEDUP_V2: "true",
    CRM_ADMIN_ONE_CODE: "synthetic-search-admin", CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("base64"),
    DEFAULT_BUSINESS_ID: businesses[0].id, DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName,
    CONTROL_DATABASE_NAME: root + "_control", BUSINESS_DATABASES: JSON.stringify(businesses) });
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Lead } = await import("../models/Lead");
const { Employee } = await import("../models/Employee");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
let mongo: MongoMemoryReplSet, server: http.Server, origin = "", admin = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = new URL(mongo.getUri(root)); assert.equal(uri.hostname, "127.0.0.1"); assert.notEqual(uri.port, "27017");
    await mongoose.connect(uri.href);
    admin = createAdminDashboardSession("synthetic-search-admin")!; assert.ok(admin);
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => { for (const business of businesses) await runWithBusiness(business.id, async () => { await Lead.deleteMany({}); await Employee.deleteMany({}); }); });
const request = (business: string, path: string, employeeCode?: string) => fetch(origin + path, { headers: { "X-Business-Id": business,
    ...(employeeCode ? { "X-CRM-Attendance-Session": createAttendanceHubSession(employeeCode)! } : { "X-CRM-Admin-Session": admin }) } });
async function fixture(business = businesses[0]) {
    const code = "synthetic-" + crypto.randomUUID(); await setBusinessAccessForEmployeeCode(code, [business.id]);
    const employee = await runWithBusiness(business.id, () => Employee.create({ name: "Synthetic Owner", employeeCode: code, role: "Sales", status: "Active" }));
    const lead = await runWithBusiness(business.id, () => Lead.create({ businessName: "A&B (Services)", leadName: "Anne-Marie O'Neil", phone: "+1 (202) 555-0121",
        assignedAgent: employee._id, assignedAgentName: employee.name, status: "NEW", businessAddress: "Austin, TX", comments: [], activity: [] }));
    return { business, lead, employee, code };
}
test("both admin search endpoints find formatted and unformatted phone/name queries across six businesses", async () => {
    for (const business of businesses) {
        const f = await fixture(business);
        for (const search of ["12025550121", "+1 202-555-0121", "(202) 555-0121", "AnneMarieONeil", "Anne Marie O’Neil", "ABServices", "O'Neil"]) {
            for (const endpoint of ["/admin-leads/all?limit=8", "/leads?limit=8"]) {
                const response = await request(business.id, endpoint + "&search=" + encodeURIComponent(search));
                assert.equal(response.status, 200); const data = await response.json(), rows = Array.isArray(data) ? data : data.leads;
                assert.deepEqual(rows.map((row: { _id: string }) => row._id), [String(f.lead._id)], search);
                assert.equal(rows[0].phone, "+1 (202) 555-0121"); assert.equal(rows[0].leadName, "Anne-Marie O'Neil");
            }
            const counts = await request(business.id, "/admin-leads/counts?search=" + encodeURIComponent(search));
            assert.equal(counts.status, 200); assert.equal((await counts.json()).ALL, 1);
        }
    }
});
test("format-tolerant search retains status, assignment, state and pagination filters", async () => {
    const f = await fixture();
    const extra = await runWithBusiness(f.business.id, () => Lead.create({ businessName: "Other", leadName: "Anne-Marie O'Neil", phone: "+12025550122", status: "Qualified", businessAddress: "Miami, FL" }));
    const query = "search=AnneMarieONeil";
    const page = await (await request(f.business.id, `/admin-leads/all?${query}&page=1&limit=1`)).json();
    assert.equal(page.leads.length, 1); assert.equal(page.total, 2); assert.equal(page.hasMore, true);
    const second = await (await request(f.business.id, `/admin-leads/all?${query}&page=2&limit=1`)).json();
    assert.notEqual(second.leads[0]._id, page.leads[0]._id);
    const assigned = await (await request(f.business.id, `/admin-leads/all?${query}&assignedAgent=${f.employee._id}`)).json();
    assert.deepEqual(assigned.leads.map((row: { _id: string }) => row._id), [String(f.lead._id)]);
    const qualified = await (await request(f.business.id, `/admin-leads/qualified?${query}`)).json();
    assert.deepEqual(qualified.leads.map((row: { _id: string }) => row._id), [String(extra._id)]);
    const texas = await (await request(f.business.id, `/admin-leads/all?${query}&state=TX`)).json();
    assert.deepEqual(texas.leads.map((row: { _id: string }) => row._id), [String(f.lead._id)]);
});
test("regex-like input, unrelated numbers and name fragments never broaden admin results", async () => {
    const f = await fixture();
    await runWithBusiness(f.business.id, () => Lead.create({ businessName: "Alphabet", leadName: "Joanne", phone: "+12025550122", status: "NEW" }));
    for (const search of [".*", "()[]", "12025550199", "Ann", "z.*x", "x".repeat(300)]) {
        const response = await request(f.business.id, "/admin-leads/all?search=" + encodeURIComponent(search));
        assert.equal(response.status, 200); assert.equal((await response.json()).leads.length, 0, search);
    }
    const literalSeparators = await (await request(f.business.id, "/admin-leads/all?search=" + encodeURIComponent("a.*b"))).json();
    assert.deepEqual(literalSeparators.leads.map((row: { _id: string }) => row._id), [String(f.lead._id)], "punctuation is formatting, not a regex wildcard over Alphabet");
});
test("signed tenant permissions and employee search scope remain intact", async () => {
    const f = await fixture();
    const foreign = await (await request(businesses[1].id, "/admin-leads/all?search=AnneMarieONeil")).json(); assert.equal(foreign.leads.length, 0);
    assert.equal((await fetch(origin + "/admin-leads/all?search=AnneMarieONeil", { headers: { "X-Business-Id": f.business.id } })).status, 401);
    assert.equal((await request(f.business.id, "/admin-leads/all?search=AnneMarieONeil", f.code)).status, 403);
    assert.equal((await request(businesses[1].id, "/leads?search=AnneMarieONeil", f.code)).status, 403);
    const own = await (await request(f.business.id, "/leads?search=AnneMarieONeil", f.code)).json();
    assert.equal(own.length, 0, "formatting expansion is admin-only; employee listing and permissions are not widened");
});
test("searching never rewrites lead formatting, original attendance or saved payroll", async () => {
    const f = await fixture(), client = mongoose.connection.getClient(), db = client.db(f.business.databaseName);
    await db.collection("payrollrecords").insertOne({ fixture: "saved", status: "Paid", netPay: 123, paymentDate: new Date("2026-10-21") });
    await db.collection("attendances").insertOne({ fixture: "original", events: [{ source: "Time In", at: new Date("2026-10-21T15:00:00Z") }] });
    const evidence = async () => JSON.stringify(await Promise.all(["leads", "payrollrecords", "attendances"].map(name => db.collection(name).find({}).sort({ _id: 1 }).toArray())));
    const before = await evidence();
    for (const search of ["12025550121", "AnneMarieONeil", "ABServices"]) await request(f.business.id, "/admin-leads/all?search=" + search);
    assert.equal(await evidence(), before);
});

test("the Leads status dropdown filters all active statuses consistently across pages and exports", async () => {
    const statuses = ["NEW", "Follow up", "Qualified", "Ongoing Negotiation", "Completed", "Dead", "Ongoing comms"] as const;
    for (const business of businesses) {
        const f = await fixture(business), expected = new Map([["NEW", String(f.lead._id)]]);
        for (const [index, status] of [...statuses.slice(1), "Archived" as const].entries()) {
            const lead = await runWithBusiness(business.id, () => Lead.create({ businessName: "Status " + status, phone: `+12025550${200 + index}`, status,
                businessAddress: "Austin, TX", assignedAgent: f.employee._id, assignedAgentName: f.employee.name }));
            expected.set(status, String(lead._id));
        }
        const before = JSON.stringify(await runWithBusiness(business.id, () => Lead.find().sort({ _id: 1 }).lean()));
        for (const status of statuses) for (const exportFile of [false, true]) {
            const response = await request(business.id, `/admin-leads?queue=${encodeURIComponent(status)}&state=TX&assignedAgent=${f.employee._id}&export=${exportFile}`);
            assert.equal(response.status, 200);
            const page = await response.json(); assert.equal(page.total, 1);
            assert.deepEqual(page.leads.map((lead: { _id: string }) => lead._id), [expected.get(status)]);
        }
        const ids = new Set<string>();
        for (let page = 1; page <= 4; page++) {
            const result = await (await request(business.id, `/admin-leads?queue=ALL&limit=2&page=${page}`)).json();
            assert.equal(result.total, statuses.length);
            for (const lead of result.leads) { assert.ok(!ids.has(lead._id)); ids.add(lead._id); assert.notEqual(lead.status, "Archived"); }
        }
        assert.equal(ids.size, statuses.length);
        assert.equal(JSON.stringify(await runWithBusiness(business.id, () => Lead.find().sort({ _id: 1 }).lean())), before);
    }
});

test("Qualified bulk assignment and archiving retain tenant boundaries and do not rewrite status on assignment", async () => {
    for (const business of businesses) {
        const f = await fixture(business);
        await runWithBusiness(business.id, () => Lead.updateOne({ _id: f.lead._id }, { $set: { status: "Qualified" } }));
        const write = (route: string, body: unknown) => fetch(origin + route, { method: "PATCH", headers: { "X-Business-Id": business.id,
            "X-CRM-Admin-Session": admin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const assignment = await write("/leads/bulk/assign", { leadIds: [String(f.lead._id)], assignedAgent: "UNASSIGNED", assignedAgentName: "" });
        assert.equal(assignment.status, 200);
        assert.equal((await runWithBusiness(business.id, () => Lead.findById(f.lead._id).lean()))?.status, "Qualified");
        const archive = await write("/leads/bulk/archive", { leadIds: [String(f.lead._id)] }); assert.equal(archive.status, 200);
        assert.equal((await archive.json()).archivedCount, 1);
        assert.equal((await runWithBusiness(business.id, () => Lead.findById(f.lead._id).lean()))?.status, "Archived");
    }
});

test("city filtering covers the full result set, keeps streets separate and composes with status, state, counts and exports", async () => {
    for (const business of businesses) {
        const f = await fixture(business);
        await runWithBusiness(business.id, () => Lead.updateOne({ _id: f.lead._id }, { $set: { businessAddress: "100 Main St, Austin, TX 78701, USA" } }));
        for (const [index, address] of ["100 Austin St, Dallas, TX 75201", "Austin, Travis County, Texas", "200 Main St, Miami, FL 33101", "Unknown address", "Corporate Headquarters, Houston, TX 77001"].entries()) {
            await runWithBusiness(business.id, () => Lead.create({ businessName: "City fixture " + index, phone: `+12025550${300 + index}`, businessAddress: address,
                assignedAgent: f.employee._id, assignedAgentName: f.employee.name, status: index === 0 ? "Qualified" : "NEW" }));
        }
        const before = JSON.stringify(await runWithBusiness(business.id, () => Lead.find().sort({ _id: 1 }).lean()));
        const first = await (await request(business.id, "/admin-leads?queue=ALL&limit=1&state=TX")).json();
        assert.deepEqual(first.cityOptions, ["Austin", "Dallas", "Houston"], "city options must not be limited to the visible page");
        const austin = await (await request(business.id, `/admin-leads?queue=ALL&city=Austin&state=TX&assignedAgent=${f.employee._id}`)).json();
        assert.equal(austin.total, 2); assert.ok(austin.leads.every((row: { businessAddress: string }) => !row.businessAddress.includes("Austin St")));
        assert.deepEqual(austin.cityOptions, ["Austin", "Dallas", "Houston"], "choosing a city must not remove the other city options");
        const qualified = await (await request(business.id, "/admin-leads?queue=Qualified&city=Dallas&export=true")).json();
        assert.equal(qualified.total, 1); assert.equal(qualified.leads[0].status, "Qualified");
        const counts = await (await request(business.id, "/admin-leads/counts?city=Austin&state=TX")).json(); assert.equal(counts.ALL, 2);
        const all = await (await request(business.id, "/admin-leads?queue=ALL&city=ALL")).json(); assert.equal(all.total, 6);
        for (const query of [".*", "Aust", "x".repeat(101)]) {
            const empty = await (await request(business.id, "/admin-leads?city=" + encodeURIComponent(query))).json(); assert.equal(empty.total, 0);
        }
        assert.equal(JSON.stringify(await runWithBusiness(business.id, () => Lead.find().sort({ _id: 1 }).lean())), before);
    }
});


test("city choices exclude hidden duplicate-phone leads just like the admin list", async () => {
    for (const business of businesses) {
        const f = await fixture(business);
        // A raw insert represents a legacy duplicate; normal lead writes already reject it.
        await runWithBusiness(business.id, () => Lead.collection.insertOne({businessName: "Hidden duplicate fixture", phone: f.lead.phone,
            status: "NEW", businessAddress: "100 Main St, Dallas, TX 75201", comments: [], activity: [], createdAt: new Date(), updatedAt: new Date()}));
        const page = await (await request(business.id, "/admin-leads?queue=ALL")).json();
        assert.equal(page.total, 1);
        const visibleCity = page.leads[0].businessAddress.includes("Dallas") ? "Dallas" : "Austin";
        assert.deepEqual(page.cityOptions, [visibleCity]);
        const selected = await (await request(business.id, "/admin-leads?queue=ALL&city=" + visibleCity)).json();
        assert.equal(selected.total, 1);
    }
});


test("city filters accept postal codes before or after the country without matching street names", async () => {
    for (const business of businesses) {
        const f = await fixture(business);
        const addresses = ["12345 Main Street, Austin, TX, USA, 78701", "12345 Main Street, Austin, TX, 78701, United States", "12345 Main Street, Austin, TX 78701, USA", "12345 Austin Street, Dallas, TX, United States, 75201"];
        for (const [index, businessAddress] of addresses.entries()) await runWithBusiness(business.id, () => Lead.create({
            businessName: "Postal fixture " + index, phone: `+12025550${700 + index}`, businessAddress, status: "NEW", comments: [], activity: [],
        }));
        await runWithBusiness(business.id, () => Lead.create({businessName: "Unsupported address fixture", phone: "+12025550801", status: "NEW",
            businessAddress: "12345 Main Street, Unmapped City, TX, Unrecognized Region, 78701", comments: [], activity: []}));
        const before = JSON.stringify(await runWithBusiness(business.id, () => Lead.find().sort({_id: 1}).lean()));
        const page = await (await request(business.id, "/admin-leads?queue=ALL&city=Austin")).json();
        assert.equal(page.total, 4); assert.ok(page.leads.every((row: {businessAddress: string}) => !row.businessAddress.includes("Austin Street")));
        assert.deepEqual(page.cityOptions, ["Austin", "Dallas"]);
        assert.equal((await (await request(business.id, "/admin-leads?queue=ALL")).json()).total, 6);
        const dallas = await (await request(business.id, "/admin-leads?queue=ALL&city=Dallas&export=true")).json();
        assert.equal(dallas.total, 1);
        assert.equal(JSON.stringify(await runWithBusiness(business.id, () => Lead.find().sort({_id: 1}).lean())), before);
        assert.equal(String(f.lead.businessAddress), "Austin, TX");
    }
});


test("admin refresh windows and full filtered selections agree across all six businesses without writes", async () => {
    for (const business of businesses) {
        const f = await fixture(business), at = new Date("2026-11-03T12:00:00Z");
        const docs = Array.from({length: 65}, (_, index) => ({businessName: "Window fixture " + index, phone: `+1202555${String(2000 + index).padStart(4, "0")}`,
            status: index < 47 ? "Qualified" as const : "NEW" as const, category: index < 55 ? "Office" : "Law Firm", businessAddress: index < 55 ? "Austin, TX" : "Dallas, TX",
            assignedAgent: f.employee._id, assignedAgentName: f.employee.name, assignmentRevision: index, createdAt: at, updatedAt: at, comments: [], activity: []}));
        await runWithBusiness(business.id, () => Lead.collection.insertMany(docs));
        const before = JSON.stringify(await runWithBusiness(business.id, () => Lead.find().sort({_id: 1}).lean()));
        const first = await (await request(business.id, "/admin-leads?queue=ALL&limit=20")).json(); assert.equal(first.leads.length, 20);
        const window = await (await request(business.id, "/admin-leads?queue=ALL&limit=20&windowStartPage=1&windowEndPage=3")).json();
        assert.equal(window.leads.length, 60); assert.equal(window.page, 3); assert.equal(window.hasMore, true); assert.equal(new Set(window.leads.map((row: {_id: string}) => row._id)).size, 60);
        const refresh = await (await request(business.id, "/admin-leads?queue=ALL&limit=20&windowStartPage=1&windowEndPage=3")).json();
        assert.deepEqual(refresh.leads.map((row: {_id: string}) => row._id), window.leads.map((row: {_id: string}) => row._id));
        const filter = `/admin-leads?queue=Qualified&city=Austin&state=TX&category=Office&assignedAgent=${f.employee._id}`;
        const selected = await (await request(business.id, filter + "&selectionOnly=true")).json(); assert.equal(selected.total, 47); assert.equal(selected.leadIds.length, 47);
        assert.equal(Object.keys(selected.assignmentRevisions).length, 47); assert.ok(selected.leadIds.every((id: string) => Number.isSafeInteger(selected.assignmentRevisions[id])));
        assert.equal(selected.leads, undefined); assert.equal(selected.phone, undefined);
        const onePage = await (await request(business.id, filter + "&selectionOnly=true&page=99&limit=1")).json(); assert.equal(onePage.total, 47);
        const unsigned = await fetch(origin + filter + "&selectionOnly=true", {headers: {"X-Business-Id": business.id}});
        assert.ok([401, 403].includes(unsigned.status));
        const visible = await (await request(business.id, filter + "&limit=20")).json(); assert.equal(visible.leads.length, 20);
        assert.ok(visible.leads.every((row: {_id: string}) => selected.leadIds.includes(row._id)));
        for (const invalid of ["windowEndPage=501", "windowStartPage=3&windowEndPage=2", "windowEndPage=-1", "selectionOnly=true&export=true"])
            assert.equal((await request(business.id, "/admin-leads?" + invalid)).status, 400);
        assert.equal(JSON.stringify(await runWithBusiness(business.id, () => Lead.find().sort({_id: 1}).lean())), before);
        await runWithBusiness(business.id, () => Lead.updateOne({_id: selected.leadIds.at(-1)}, {$inc: {assignmentRevision: 1}}));
        const changed = JSON.stringify(await runWithBusiness(business.id, () => Lead.find().sort({_id: 1}).lean()));
        const conflict = await fetch(origin + "/leads/bulk/assign", {method: "PATCH", headers: {"X-Business-Id": business.id,
            "X-CRM-Admin-Session": admin, "Content-Type": "application/json"}, body: JSON.stringify({leadIds: selected.leadIds,
                assignedAgent: "UNASSIGNED", assignedAgentName: "", expectedAssignmentRevisions: selected.assignmentRevisions})});
        assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, "LEAD_ASSIGNMENT_CHANGED");
        assert.equal(JSON.stringify(await runWithBusiness(business.id, () => Lead.find().sort({_id: 1}).lean())), changed);
    }
});
