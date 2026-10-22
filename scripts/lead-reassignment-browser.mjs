import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { preview } from "vite";
const runtime = createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url);
const { chromium } = runtime("playwright");
const origin = "http://localhost:5173";
const server = await preview({ envDir: false, build: { outDir: process.argv[2] || "outputs/reassignment-review/dist" }, preview: { host: "localhost", port: 5173, strictPort: true } });
const output = new URL("../outputs/lead-reassignment-browser/", import.meta.url);
await fs.mkdir(output, { recursive: true });
let browser, lastPage;
const errors = [], results = [];
try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    for (const role of ["employee", "admin"]) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const owner = business => ({ _id: `owner-${business}`, employeeCode: "synthetic-owner", name: "Synthetic Owner", role: "Sales", team: "Sales", status: "Active", availabilityStatus: "OFFLINE", aliases: [] });
        const target = business => ({ ...owner(business), _id: `recipient-${business}`, employeeCode: "synthetic-recipient", name: `Synthetic Training ${business}`, status: "Training" });
        const records = new Map(), requests = [], notes = new Map();
        let noteAttempts = 0, reserveAttempts = 0;
        const record = business => {
            if (!records.has(business)) records.set(business, { _id: `lead-${business}`, businessName: `Synthetic Lead ${business}`, leadName: `Synthetic Lead ${business}`, status: "NEW", assignedAgent: owner(business), assignedAgentName: owner(business).name,
                assignmentRevision: 0, phone: "+12025550121", followUpAt: null, followUpNote: "", notes: "", createdAt: new Date().toISOString(), comments: [], activity: [], favoriteByEmployees: [] });
            return records.get(business);
        };
        await context.addInitScript(({ role, employee }) => {
            const businesses = [{ id: "fake-a", name: "Synthetic A" }, { id: "fake-b", name: "Synthetic B" }];
            if (!localStorage.getItem("activeBusinessId")) localStorage.setItem("activeBusinessId", "fake-a");
            if (!localStorage.getItem("authUser")) localStorage.setItem("authUser", JSON.stringify(role === "employee"
                ? { userType: role, user: employee, attendanceHubSession: "synthetic-signed-session", business: businesses[0], allowedBusinesses: businesses }
                : { userType: role, user: { id: "synthetic-admin", employeeCode: "synthetic-admin", name: "Synthetic Admin", role: "Admin" }, access: "full", sessionToken: "synthetic-admin-session", business: businesses[0], allowedBusinesses: businesses }));
            HTMLAnchorElement.prototype.click = function () { if (this.href.startsWith("tel:")) throw new Error("Telephone launch forbidden in reassignment test"); };
        }, { role, employee: owner("fake-a") });
        await context.routeWebSocket("**/socket.io/**", socket => {
            socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
            socket.onMessage(message => { if (message === "40") socket.send('40{"sid":"synthetic"}'); });
        });
        await context.route("**/socket.io/**", route => route.fulfill({ status: 200, contentType: "text/plain", body: '0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}', headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" } }));
        await context.route("**/api/**", async route => {
            const req = route.request(), url = new URL(req.url()), path = url.pathname.replace(/^\/api/, ""), business = req.headers()["x-business-id"] || "fake-a";
            const row = record(business);
            const send = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data), headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" } });
            if (path === "/call-bridge/reserve" || path === "/call-bridge/dial-start") { reserveAttempts++; return send({ message: "Calls forbidden" }, 409); }
            if (path.endsWith("/comments") && req.method() === "POST") {
                noteAttempts++;
                await new Promise(resolve => setTimeout(resolve, 200));
                if (noteAttempts === 1 && role === "employee") return send({ message: "Synthetic note save failed" }, 503);
                const input = req.postDataJSON(); notes.set(business, input.body);
                row.comments.push({ body: input.body, authorType: role, authorName: "Synthetic Owner", createdAt: new Date().toISOString() });
                return send(row);
            }
            if (path.endsWith("/assign") && req.method() === "PATCH") {
                const body = req.postDataJSON(); requests.push({ business, body });
                assert.equal(body.assignedAgent, target(business)._id);
                assert.equal(body.expectedAssignmentRevision, row.assignmentRevision);
                row.assignedAgent = target(business); row.assignedAgentName = target(business).name; row.assignmentRevision++;
                return send(row);
            }
            if (path === "/employees") return send(url.searchParams.get("leadRecipients") === "true" ? [owner(business), target(business)] : [owner(business), target(business), { ...target(business), _id: `paused-${business}`, name: "Synthetic Paused", status: "Paused" }]);
            if (path === `/employees/${owner(business)._id}`) return send(owner(business));
            if (path === "/features") return send([]);
            if (path === "/system-settings") return send({ employeeLeadMiniTabsEnabled: true, adminLeadMiniTabsEnabled: true });
            if (path === "/auth/businesses" || path === "/businesses") return send([{ id: "fake-a", name: "Synthetic A" }, { id: "fake-b", name: "Synthetic B" }]);
            if (path.includes("counts")) return send({ NEW: 1, ALL: 1, "Follow up": 0 });
            if (path.startsWith("/my-leads") || path.startsWith("/admin-leads")) {
                const rows = role === "employee" && row.assignedAgent._id !== owner(business)._id ? [] : [row];
                return send({ leads: rows, page: 1, limit: 50, total: rows.length, hasMore: false, nextPage: null, stateOptions: [], tab: "my", callingQueue: { scope: { businessId: business, employeeId: owner(business)._id },
                    policyVersion: "2026-10-23-authoritative-queue-v7", serverTime: new Date().toISOString(), nextLead: rows[0] || null, nextLeadId: rows[0]?._id || null,
                    entries: [], callingWindow: { permitted: false }, nextReason: "NEW", version: `synthetic-${business}-${row.assignmentRevision}` } });
            }
            if (path.startsWith("/leads/lead-")) return send(row);
            return send([]);
        });
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        lastPage = page;
        page.on("pageerror", error => errors.push(error.message));
        for (const business of ["fake-a", "fake-b"]) {
            if (business === "fake-a") await page.goto(`${origin}/${role === "admin" ? "admin/" : ""}leads`);
            await page.evaluate(({ business, role, employee }) => {
                localStorage.setItem("activeBusinessId", business);
                const auth = JSON.parse(localStorage.getItem("authUser"));
                if (role === "employee") auth.user = employee;
                auth.business = { id: business, name: business }; localStorage.setItem("authUser", JSON.stringify(auth));
                window.dispatchEvent(new Event("crm:business-changed"));
                window.dispatchEvent(new Event("crm:auth-changed"));
            }, { business, role, employee: owner(business) });
            await page.getByText(`Synthetic Lead ${business}`, { exact: true }).first().waitFor();
            if (business === "fake-b") await page.setViewportSize({ width: 390, height: 844 });
            if (role === "employee") {
                const recipient = page.locator("select").filter({ has: page.getByRole("option", { name: `Synthetic Training ${business} - Sales`, exact: true }) });
                assert.equal(await recipient.count(), 1);
                assert.equal(await recipient.getByRole("option", { name: /Paused/ }).count(), 0);
                await recipient.selectOption(target(business)._id);
                const note = page.getByPlaceholder("Add a note for this lead...");
                await note.fill(`Synthetic preserved note ${business}`);
                await page.getByRole("button", { name: "Re Assign", exact: true }).click();
                const confirm = page.getByRole("button", { name: "Confirm Re Assign", exact: true });
                const bounds = await page.locator("section").filter({ has: page.getByRole("heading", { name: "Confirm Re Assign", exact: true }) }).boundingBox();
                assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width, "confirmation stays inside its viewport");
                await confirm.click();
                if (business === "fake-a") {
                    await page.getByText("Synthetic note save failed", { exact: true }).waitFor();
                    assert.equal(await note.inputValue(), `Synthetic preserved note ${business}`);
                    assert.equal(requests.length, 0, "failed required note cannot transfer a lead");
                    await confirm.click();
                }
                await page.getByText(`Lead reassigned to Synthetic Training ${business}.`, { exact: true }).waitFor();
                assert.equal(notes.get(business), `Synthetic preserved note ${business}`);
                await page.reload();
                await page.waitForTimeout(600);
                assert.equal(await page.getByRole("button", { name: "Re Assign", exact: true }).count(), 0);
            } else {
                await page.getByRole("button", { name: "Edit lead assignment", exact: true }).click();
                const recipient = page.locator("select").filter({ has: page.getByRole("option", { name: "Select Sales employee", exact: true }) });
                assert.equal(await recipient.getByRole("option", { name: /Paused/ }).count(), 0);
                await recipient.selectOption(target(business)._id);
                await page.getByRole("button", { name: "Save assignment", exact: true }).click();
                await page.getByText(`Lead assigned to Synthetic Training ${business}.`, { exact: true }).waitFor();
                await page.reload();
                await page.locator("p").filter({ hasText: new RegExp(`^Synthetic Training ${business}$`) }).first().waitFor();
            }
            results.push({ role, business, viewport: page.viewportSize(), assignments: requests.filter(r => r.business === business).length, refreshVerified: true });
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({ path: new URL(`${role}-desktop.png`, output).pathname.replace(/^\/([A-Z]:)/, "$1"), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: new URL(`${role}-mobile.png`, output).pathname.replace(/^\/([A-Z]:)/, "$1"), fullPage: true });
        assert.equal(reserveAttempts, 0); assert.equal(requests.length, 2);
        await context.close();
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(new URL("results.json", output), JSON.stringify({ origin, fixtureOnly: true, realCalls: 0, errors, results }, null, 2));
    console.log(JSON.stringify({ origin, fixtureOnly: true, realCalls: 0, errors, results }));
} catch (error) {
    if (lastPage && !lastPage.isClosed()) {
        await lastPage.screenshot({ path: new URL("failure.png", output).pathname.replace(/^\/([A-Z]:)/, "$1"), fullPage: true });
        console.error(JSON.stringify({ url: lastPage.url(), errors, body: (await lastPage.locator("body").innerText()).slice(0, 4500) }));
    }
    throw error;
} finally { await browser?.close(); await server.httpServer.close(); }
