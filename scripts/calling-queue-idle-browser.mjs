import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url)('playwright');
const directory = path.resolve(process.argv[2]), origin = 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [], errors = [];
try {
  for (let index = 0; index < 6; index++) {
    const business = `synthetic-${index}`;
    const employee = { _id: `synthetic-person-${index}`, employeeCode: `synthetic-sales-${index}`, name: 'Synthetic Sales', role: 'Sales', status: 'Active', availabilityStatus: 'ONLINE', aliases: [] };
    const lead = { _id: 'synthetic-head', businessName: 'Synthetic First NEW Lead', phone: '+12025550121', status: 'NEW', assignedAgent: employee._id,
      assignedAgentName: employee.name, comments: [], activity: [], createdAt: new Date().toISOString() };
    let phase = 'unknown', slow = false, observed = '', statusReads = 0, queueReads = 0, reserves = 0, dispatches = 0, liveSocket;
    const context = await browser.newContext({ viewport: index % 2 ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    // Only this synthetic browser intercepts assets; the user's server and tabs remain untouched.
    await context.route(`${origin}/**`, async route => {
      const url = new URL(route.request().url());
      const requested = path.extname(url.pathname) ? path.resolve(directory, `.${url.pathname}`) : path.join(directory, 'index.html');
      assert.ok(requested.startsWith(`${directory}${path.sep}`));
      const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      const contentType = types[path.extname(requested)] || 'application/octet-stream';
      return route.fulfill({ contentType, body: await fs.readFile(requested) });
    });
    await context.addInitScript(({ employee, business }) => {
      localStorage.setItem('activeBusinessId', business);
      localStorage.setItem('authUser', JSON.stringify({ userType: 'employee', user: employee, attendanceHubSession: 'synthetic-session', business: { id: business, name: 'Synthetic Business' }, allowedBusinesses: [{ id: business, name: 'Synthetic Business' }] }));
      window.syntheticLaunches = [];
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.href.startsWith('tel:')) { window.syntheticLaunches.push(this.href); return; } return click.call(this); };
    }, { employee, business });
    await context.routeWebSocket('**/socket.io/**', socket => {
      liveSocket = socket;
      socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
      socket.onMessage(message => {
        if (typeof message === 'string' && message.startsWith('40')) socket.send('40{"sid":"synthetic"}');
        if (message === '2') socket.send('3');
      });
    });
    await context.route('**/socket.io/**', route => route.fulfill({ contentType: 'text/plain', body: '0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}' }));
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), pathname = url.pathname.slice(4), now = new Date().toISOString();
      assert.equal(request.headers()['x-business-id'], business);
      const send = data => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }, body: JSON.stringify(data) });
      if (pathname === '/call-bridge/status') { statusReads++; return send({ employeeCode: employee.employeeCode, connected: true, ready: phase === 'idle', state: phase,
        nextivaProcessDetected: true, serverTime: now, reason: phase === 'unknown' ? 'Synthetic readiness wait' : '', observedAttemptId: observed, observedLeadId: observed ? lead._id : null }); }
      if (pathname === '/call-bridge/reserve') { assert.equal(phase, 'idle'); reserves++; const body = request.postDataJSON(); assert.equal(body.leadId, lead._id); observed = body.attemptId;
        return send({ allowed: true, leadId: lead._id, normalizedPhone: lead.phone, reservationToken: observed }); }
      if (pathname === '/call-bridge/dial-start') { dispatches++; phase = 'active'; return send({ leadId: lead._id, normalizedPhone: lead.phone, serverTime: now,
        startedAt: now, dialIntentUntil: new Date(Date.now() + 30000).toISOString() }); }
      if (pathname === '/my-leads') {
        queueReads++; if (slow && url.searchParams.get('callingQueue') === 'true') await new Promise(resolve => setTimeout(resolve, 600));
        const decision = { leadId: lead._id, normalizedPhone: lead.phone, callable: true, reason: 'NEW', priority: 1 };
        return send({ leads: [lead], total: 1, page: 1, limit: 50, hasMore: false, stateOptions: [], callingQueue: { policyVersion: '2026-10-23-authoritative-queue-v7',
          scope: { employeeId: employee._id, employeeCode: employee.employeeCode, businessId: business }, version: 'synthetic-version', serverTime: now,
          nextLead: lead, nextLeadId: lead._id, nextDecision: decision, entries: [decision], callingWindow: { permitted: true }, nextEligibilityChangeAt: null } });
      }
      if (pathname === `/employees/${employee._id}`) return send(employee);
      if (pathname === '/employees') return send([employee]);
      if (pathname === `/leads/${lead._id}` || pathname === `/leads/${lead._id}/calls`) return send(lead);
      if (pathname === '/system-settings') return send({ employeeLeadMiniTabsEnabled: true });
      if (pathname.endsWith('/counts')) return send({ ALL: 1, NEW: 1 });
      if (pathname === '/leads/workspace-capabilities') return send({ employeeBulkArchive: false, phoneDeduplication: false });
      if (pathname === '/businesses' || pathname === '/auth/businesses') return send([{ id: business, name: 'Synthetic Business' }]);
      return send([]);
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/dashboard`);
    for (let attempt = 0; attempt < 60 && (!statusReads || !liveSocket); attempt++) await page.waitForTimeout(100);
    assert.ok(statusReads && queueReads && liveSocket, 'warm cached queue and connected socket are required');
    slow = true; phase = 'idle';
    liveSocket.send('42["call-dashboard:updated"]');
    const broadcast = setInterval(() => liveSocket.send('42["call-dashboard:updated"]'), 50);
    try { await page.waitForURL('**/leads?lead=synthetic-head', { timeout: 4500 }); }
    catch (error) {
      console.error(JSON.stringify({ business, phase, statusReads, queueReads, reserves, dispatches, pageErrors: errors, body: (await page.locator('body').innerText()).slice(-2500) }));
      throw error;
    }
    finally { clearInterval(broadcast); }
    await page.waitForTimeout(2500);
    assert.equal(reserves, 1); assert.equal(dispatches, 1);
    assert.deepEqual(await page.evaluate(() => window.syntheticLaunches), [`tel:${lead.phone}`]);
    await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('pageshow')); });
    await page.waitForTimeout(800);
    assert.equal(dispatches, 1, 'recovery notifications must not redial an observed active call');
    results.push({ business, viewport: page.viewportSize(), slowQueueRecovers: true, reloads: 0, mockLaunches: dispatches, queueReads });
    if (index < 2) {
      await fs.mkdir('outputs/calling-queue-idle-browser', { recursive: true });
      await page.screenshot({ path: `outputs/calling-queue-idle-browser/${index ? 'mobile' : 'desktop'}.png`, fullPage: true });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ origin, fixtureOnly: true, realTelephoneLaunches: 0, results, errors }));
} finally { await browser.close(); }
