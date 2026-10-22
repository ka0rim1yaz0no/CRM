import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { preview } from "vite";
const runtime = createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url);
const { chromium } = runtime("playwright");
const origin = "http://localhost:5173";
const buildDirectory = process.argv[2] || "outputs/calling-queue-review/dist";
const server = await preview({ envDir: false, build: { outDir: buildDirectory }, preview: { host: "localhost", port: 5173, strictPort: true } });
let browser;
let testPage;
const errors = [];
const output = new URL("../outputs/calling-queue-browser/", import.meta.url);
await fs.mkdir(output, { recursive: true });
try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const employee = { _id: "fake-employee", employeeCode: "fake-sales", name: "Synthetic Sales", role: "Sales Agent", team: "Sales", status: "Active", availabilityStatus: "OFFLINE", aliases: [] };
    const now = new Date().toISOString();
    const due = { _id: "fake-due", businessName: "Synthetic scheduled callback", leadName: "Synthetic Callback", status: "Follow up", assignedAgent: employee._id,
        assignedAgentName: employee.name, phone: "+12025550121", followUpAt: now, createdAt: now, comments: [], activity: [], favoriteByEmployees: [] };
    const fresh = { ...due, _id: "fake-new", businessName: "Synthetic NEW business", leadName: "Synthetic NEW", status: "NEW", followUpAt: null, phone: "+12025550122" };
    let saved = false, noteAttempts = 0, reserveRequests = 0;
    let bridgePhase = "cooldown";
    const requestedBusinesses = new Set(), queueBusinesses = [];
    await context.routeWebSocket("**/socket.io/**", socket => {
        socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
        socket.onMessage(message => { if (message === "40") socket.send('40{"sid":"synthetic"}'); });
    });
    await context.route("**/socket.io/**", route => route.fulfill({ status: 200, contentType: "text/plain", body: '0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}',
        headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" } }));
    await context.addInitScript(({ employee }) => {
        if (!localStorage.getItem("activeBusinessId")) localStorage.setItem("activeBusinessId", "fake-a");
        if (!localStorage.getItem("authUser")) localStorage.setItem("authUser", JSON.stringify({ userType: "employee", user: employee, attendanceHubSession: "fake-session", business: { id: "fake-a", name: "Synthetic A" }, allowedBusinesses: [{ id: "fake-a", name: "Synthetic A" }, { id: "fake-b", name: "Synthetic B" }] }));
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () { if (this.href.startsWith("tel:")) throw new Error("Real telephone launch forbidden in browser test"); return click.call(this); };
    }, { employee });
    await context.route("**/api/**", async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname.replace(/^\/api/, "");
        const businessId = request.headers()["x-business-id"] || "fake-a";
        requestedBusinesses.add(businessId);
        const headers = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
        const send = (data, status = 200) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(data) });
        if (request.method() === "OPTIONS") return send({});
        if (path === "/call-bridge/reserve" || path === "/call-bridge/dial-start") { reserveRequests++; return send({ message: "Calls forbidden in browser test" }, 409); }
        if (path === "/call-bridge/status") {
            const serverTime = new Date().toISOString();
            return send({ employeeCode: employee.employeeCode, connected: true, ready: false,
                state: bridgePhase === "unknown" ? "unknown" : bridgePhase === "active" ? "active" : "idle", nextivaProcessDetected: true,
                serverTime, nextCallAllowedAt: new Date(+new Date(serverTime) + 30000).toISOString(),
                waitCode: bridgePhase === "unknown" ? "CALL_END_UNCONFIRMED" : "POST_CALL_COOLDOWN", reason: "Synthetic provider confirmation pending" });
        }
        if (path.endsWith("/comments") && request.method() === "POST") {
            noteAttempts++;
            await new Promise(resolve => setTimeout(resolve, 200));
            if (noteAttempts === 1) return send({ message: "Synthetic note save failed" }, 503);
            saved = true;
            return send({ ...due, comments: [{ authorType: "employee", authorName: employee.name, body: "Synthetic note draft", createdAt: now }] });
        }
        if (path.startsWith("/my-leads") && !path.endsWith("/counts")) {
            queueBusinesses.push(businessId);
            const next = saved ? fresh : due;
            const entries = [next, saved ? due : fresh].map((lead, index) => ({ leadId: lead._id, normalizedPhone: lead.phone, callable: index === 0 || !saved,
                reason: lead._id === fresh._id ? "NEW" : saved ? "COMMENT_COOLDOWN" : "SCHEDULED_DUE", priority: index, nextEligibleAt: null }));
            return send({ leads: saved ? [fresh, due] : [due, fresh], tab: "my", page: 1, limit: 50, total: 2, stateOptions: [], hasMore: false, nextPage: null,
                callingQueue: { policyVersion: "2026-10-23-authoritative-queue-v7", scope: { employeeId: employee._id, employeeCode: employee.employeeCode, businessId }, version: saved ? "saved" : "initial",
                    serverTime: new Date().toISOString(), nextEligibilityChangeAt: null, nextLead: next, nextLeadId: next._id,
                    nextReason: saved ? "NEW" : "SCHEDULED_DUE", nextDecision: entries[0], entries, callingWindow: { permitted: false, nextStartAt: null }, waitReason: null } });
        }
        if (path === "/features") return send([]);
        if (path === "/system-settings") return send({ employeeLeadMiniTabsEnabled: true });
        if (path === `/employees/${employee._id}`) return send(employee);
        if (path === "/employees") return send([employee]);
        if (path === "/businesses" || path === "/auth/businesses") return send([{ id: "fake-a", name: "Synthetic A" }, { id: "fake-b", name: "Synthetic B" }]);
        if (path.endsWith("/counts")) return send({ NEW: saved ? 1 : 1, "Follow up": 1, ALL: 2, ContactedToday: saved ? 1 : 0 });
        if (path === "/leads/fake-due") return send(due);
        if (path === "/leads/fake-new") return send(fresh);
        return send([]);
    });
    const page = await context.newPage();
    testPage = page;
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text().slice(0,300)); });
    await page.goto(`${origin}/leads`);
    await page.waitForTimeout(2000);
    const indicator = page.getByRole("status").filter({ hasText: "Next auto-call:" });
    await indicator.getByText("Synthetic Callback", { exact: false }).waitFor();
    assert.match(await indicator.innerText(), /Scheduled follow-up due/);
    await page.getByRole("button", { name: "Favorites", exact: true }).click();
    assert.match(await indicator.innerText(), /Synthetic Callback/);
    await page.getByRole("button", { name: "Favorites", exact: true }).click();
    const note = page.getByPlaceholder("Add a note for this lead...");
    await note.fill("Synthetic note draft");
    assert.match(await indicator.innerText(), /Unsaved lead changes/);
    await page.getByRole("button", { name: "Add Note", exact: true }).click();
    assert.equal(await note.inputValue(), "Synthetic note draft", "draft must remain while the server is saving");
    await page.getByText("Synthetic note save failed", { exact: true }).first().waitFor();
    assert.equal(await note.inputValue(), "Synthetic note draft", "failed saves must preserve the draft");
    await page.getByRole("button", { name: "Add Note", exact: true }).click();
    await indicator.getByText("Synthetic NEW", { exact: false }).waitFor();
    assert.equal(await note.inputValue(), "");
    const dismissals = page.getByRole("button", { name: "Dismiss notification" });
    while (await dismissals.count()) await dismissals.first().click();
    const scrollTop = () => page.evaluate(() => { for (const element of document.querySelectorAll("*")) if (element.scrollTop) element.scrollTop = 0; window.scrollTo(0, 0); });
    await scrollTop();
    await page.screenshot({ path: new URL("desktop.png", output).pathname.replace(/^\/([A-Z]:)/, "$1"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await scrollTop();
    await indicator.waitFor();
    const bounds = await indicator.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, "next-call indicator must fit the mobile viewport");
    await page.screenshot({ path: new URL("mobile.png", output).pathname.replace(/^\/([A-Z]:)/, "$1"), fullPage: true });
    await page.evaluate(() => { localStorage.setItem("activeBusinessId", "fake-b"); window.dispatchEvent(new Event("crm:business-changed")); });
    await page.reload();
    await page.getByRole("status").filter({ hasText: "Next auto-call:" }).getByText("Synthetic NEW", { exact: false }).waitFor();
    assert.ok(requestedBusinesses.has("fake-b"));
    assert.equal(await page.evaluate(() => localStorage.getItem("activeBusinessId")), "fake-b");
    assert.equal(queueBusinesses.at(-1), "fake-b", "refresh must load the switched business's queue");
    assert.equal(await page.getByPlaceholder("Add a note for this lead...").inputValue(), "", "confirmed notes must not return as unsaved drafts after refresh");
    employee.availabilityStatus = "ONLINE";
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/settings`);
    await page.getByText(/Next call in \d+s/).first().waitFor();
    bridgePhase = "unknown";
    await page.reload();
    await page.getByText("Waiting for confirmation", { exact: true }).waitFor();
    assert.equal(await page.getByText(/Next call in \d+s/).count(), 0, "unknown provider state must not appear to be a ready countdown");
    await page.getByText("Waiting for confirmation", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: new URL("settings.png", output).pathname.replace(/^\/([A-Z]:)/, "$1"), fullPage: true });
    employee.availabilityStatus = "OFFLINE"; bridgePhase = "active";
    await page.reload();
    await page.getByText("Offline", { exact: true }).first().waitFor();
    assert.equal(reserveRequests, 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, browser: "headless Edge", origin, viewports: ["1440x1000", "390x844"], businesses: 2,
        tests: ["independent next indicator", "favorites preserve queue", "pending draft retained", "failed note retained", "saved queue advances", "mobile fit", "refresh and business scope", "Settings server cooldown", "Settings unknown confirmation", "Settings attendance offline"],
        productionAccess: false, realCalls: 0, providerDispatch: "blocked and counted", screenshots: "outputs/calling-queue-browser" }));
    await context.close();
} catch (error) {
    if (testPage) console.error(JSON.stringify({ url: testPage.url(), errors, body: (await testPage.locator("body").innerText()).slice(0, 6000) }));
    throw error;
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
