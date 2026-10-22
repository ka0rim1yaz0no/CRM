import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { preview } from 'vite';
const { chromium } = createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url)('playwright');
const origin = 'http://localhost:5173', directory = process.argv[2];
const server = await preview({ envDir: false, build: { outDir: directory }, preview: { host: 'localhost', port: 5173, strictPort: true } });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [], errors = [];
try {
  for (let i = 0; i < 6; i++) {
    const business = `synthetic-${i}`, employee = { _id: `synthetic-employee-${i}`, employeeCode: `synthetic-sales-${i}`, name: 'Synthetic Sales', role: 'Sales', status: 'Active', availabilityStatus: 'ONLINE', aliases: [] };
    const leads = [1, 2].map(n => ({ _id: `synthetic-lead-${n}`, leadName: `Synthetic Contact ${n}`, businessName: `Synthetic Called Business ${n}`, phone: `+1202555012${n}`, status: 'NEW', assignedAgent: employee._id, assignedAgentName: employee.name, comments: [], activity: [], createdAt: new Date().toISOString() }));
    let phase = 'idle', next = 0, current = null, attempt = '', reserves = 0, dispatches = 0, records = 0;
    const context = await browser.newContext({ viewport: i % 2 ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    await context.addInitScript(({ employee, business }) => {
      localStorage.setItem('activeBusinessId', business);
      localStorage.setItem('authUser', JSON.stringify({ userType: 'employee', user: employee, attendanceHubSession: 'synthetic-session', business: { id: business, name: 'Synthetic Business' }, allowedBusinesses: [{ id: business, name: 'Synthetic Business' }] }));
      window.syntheticDialed = [];
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.href.startsWith('tel:')) { window.syntheticDialed.push(this.href); return; } return click.call(this); };
    }, { employee, business });
    await context.routeWebSocket('**/socket.io/**', socket => {
      socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
      socket.onMessage(message => { if (message === '40') socket.send('40{"sid":"synthetic"}'); });
    });
    await context.route('**/socket.io/**', route => route.fulfill({ status: 200, contentType: 'text/plain', body: '0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}' }));
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname.slice(4), now = new Date().toISOString();
      const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      if (path === '/call-bridge/status') return send({ employeeCode: employee.employeeCode, connected: true, ready: phase === 'idle', state: phase,
        nextivaProcessDetected: true, serverTime: now, observedAttemptId: attempt, observedLeadId: current?._id, reason: '' });
      if (path === '/call-bridge/reserve') {
        assert.equal(phase, 'idle', 'must not reserve a second call during an active call'); reserves++;
        const body = request.postDataJSON(); attempt = body.attemptId; current = leads[next];
        return send({ allowed: true, leadId: current._id, normalizedPhone: current.phone, reservationToken: attempt, callLeaseUntil: new Date(Date.now() + 30000).toISOString() });
      }
      if (path === '/call-bridge/dial-start') {
        dispatches++; phase = 'active'; next = Math.min(1, next + 1);
        return send({ leadId: current._id, normalizedPhone: current.phone, startedAt: now, serverTime: now, dialIntentUntil: new Date(Date.now() + 30000).toISOString() });
      }
      if (/\/leads\/[^/]+\/calls$/.test(path)) { records++; return send(current); }
      if (path === '/my-leads') {
        const lead = leads[next], decision = { leadId: lead._id, normalizedPhone: lead.phone, callable: true, reason: 'NEW', priority: 1 };
        return send({ leads, total: 2, page: 1, limit: 50, hasMore: false, stateOptions: [], callingQueue: {
          policyVersion: '2026-10-23-authoritative-queue-v7', scope: { employeeId: employee._id, employeeCode: employee.employeeCode, businessId: business },
          version: `synthetic-${next}`, serverTime: now, nextLead: lead, nextLeadId: lead._id, nextDecision: decision,
          entries: [decision], callingWindow: { permitted: true }, nextEligibilityChangeAt: null } });
      }
      if (path === `/employees/${employee._id}`) return send(employee);
      if (path === '/employees') return send([employee]);
      if (path === '/system-settings') return send({ employeeLeadMiniTabsEnabled: true });
      if (path.endsWith('/counts')) return send({ ALL: 2, NEW: 2 });
      if (path === '/features') return send([]);
      if (path === '/leads/workspace-capabilities') return send({ employeeBulkArchive: false, phoneDeduplication: false });
      if (path === '/businesses' || path === '/auth/businesses') return send([{ id: business, name: 'Synthetic Business' }]);
      const lead = leads.find(item => path === `/leads/${item._id}`);
      if (lead) return send(lead);
      return send([]);
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/dashboard`);
    await page.waitForURL('**/leads?lead=synthetic-lead-1');
    await page.getByText('Synthetic Called Business 1', { exact: true }).last().waitFor();
    await page.waitForTimeout(2500);
    assert.equal(reserves, 1); assert.equal(dispatches, 1); assert.equal(records, 1, 'navigation must not cancel call confirmation/logging');
    assert.equal((await page.evaluate(() => window.syntheticDialed)).length, 1);
    await page.reload();
    await page.getByText('Synthetic Called Business 1', { exact: true }).last().waitFor();
    await page.waitForTimeout(300);
    assert.equal(dispatches, 1); assert.equal((await page.evaluate(() => window.syntheticDialed)).length, 0, 'refresh restores the lead, never redials');
    phase = 'idle';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForURL('**/leads?lead=synthetic-lead-2');
    await page.getByText('Synthetic Called Business 2', { exact: true }).last().waitFor();
    await page.waitForTimeout(2500);
    assert.equal(dispatches, 2); assert.equal(records, 2); assert.equal((await page.evaluate(() => window.syntheticDialed)).length, 1);
    results.push({ business, nextLeadShown: true, refreshNoRedial: true, confirmationsSurviveNavigation: true, viewport: page.viewportSize() });
    if (i < 2) {
      await fs.mkdir('outputs/current-call-display-browser', { recursive: true });
      await page.screenshot({ path: `outputs/current-call-display-browser/${i ? 'mobile' : 'desktop'}.png`, fullPage: true });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ origin, fixtureOnly: true, realTelephoneLaunches: 0, errors, results }));
} finally { await browser.close(); await server.httpServer.close(); }
