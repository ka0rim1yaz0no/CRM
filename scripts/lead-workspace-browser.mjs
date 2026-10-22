import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { preview } from 'vite';
const { chromium } = createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url)('playwright');
const origin = 'http://localhost:5173';
const server = await preview({ envDir: false, build: { outDir: process.argv[2] }, preview: { host: 'localhost', port: 5173, strictPort: true } });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
let lastPage;
const errors = [], results = [];
try {
  await fs.mkdir('outputs/lead-workspace-browser', { recursive: true });
  for (const role of ['employee', 'admin']) {
    for (let i = 0; i < 6; i++) {
      const business = `synthetic-${i}`, employee = { _id: 'synthetic-owner', employeeCode: 'synthetic-owner-code', name: 'Synthetic Employee', role: 'Sales', team: 'Sales', status: 'Active', availabilityStatus: 'OFFLINE', aliases: [] };
      const context = await browser.newContext({ viewport: i % 2 ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
      await context.addInitScript(({ role, business, employee }) => {
        localStorage.setItem('activeBusinessId', business);
        localStorage.setItem('authUser', JSON.stringify({ userType: role, user: role === 'admin' ? { _id: 'synthetic-admin', name: 'Synthetic Admin', role: 'Admin' } : employee,
          attendanceHubSession: 'synthetic-session', sessionToken: 'synthetic-admin-session', business: { id: business, name: 'Synthetic Business' }, allowedBusinesses: [{ id: business, name: 'Synthetic Business' }] }));
        HTMLAnchorElement.prototype.click = function () { if (this.href.startsWith('tel:')) throw new Error('Real telephone forbidden'); };
      }, { role, business, employee });
      let archived = false, archiveRequests = 0, failNote = true;
      const lead = { _id: 'synthetic-lead', leadName: 'Synthetic Contact', businessName: 'Synthetic Business Lead', phone: '+12025550121', assignedAgent: employee._id, assignedAgentName: employee.name, status: 'NEW', assignmentRevision: 0, comments: [], activity: [], createdAt: new Date().toISOString() };
      const milliseconds = Object.fromEntries(['online','break','lunch','offPhone','offline','late','underTime','overBreak','overLunch','overtime'].map(name => [name, name === 'online' ? 3600000 : 0]));
      const day = { dayKey: '2026-10-22', shiftStart: '2026-10-22T15:00:00Z', shiftEnd: '2026-10-23T00:00:00Z', timeIn: '2026-10-22T15:00:00Z', timeOut: '2026-10-22T16:00:00Z',
        employeeCode: employee.employeeCode, employeeId: employee._id, employeeName: employee.name, scopeKey: employee.employeeCode, team: 'Sales', role: 'Sales', businessId: business, businessName: 'Synthetic Business',
        status: 'OFFLINE', inProgress: false, excused: false, absent: false, mismatch: false, issues: ['UNDER TIME'], review: [], note: 'Synthetic retained note', leave: null,
        graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, breakSessions: [], noteRevisions: [], audit: [], milliseconds, events: [{ id: 'synthetic-in', source: 'Time In', at: '2026-10-22T15:00:00Z' }], timeline: [], businesses: [] };
      await context.routeWebSocket('**/socket.io/**', socket => { socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}'); socket.onMessage(message => { if (message === '40') socket.send('40{"sid":"synthetic"}'); }); });
      await context.route('**/socket.io/**', route => route.fulfill({ contentType: 'text/plain', body: '0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}' }));
      await context.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), path = url.pathname.slice(4);
        const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
        if (path === '/attendance-hub/days') return send({ rows: [day], total: 2, page: 1, pageSize: 25, employees: [day, { ...day, scopeKey: 'synthetic-empty', employeeName: 'Synthetic No Record', employeeCode: 'synthetic-empty' }],
          history: { page: 1, hasOlder: true, hasNewer: false, today: '2026-10-23' }, range: { from: '2026-10-22', to: '2026-10-22' }, serverTime: new Date().toISOString(),
          summary: Object.fromEntries(['daysWorked','employeesPresent','online','break','lunch','offPhone','lateCount','late','overBreakCount','overBreak','overLunchCount','overLunch','underTimeCount','underTime','overtime','absent','needsReview','onTimeRate'].map(key => [key, key === 'daysWorked' ? 1 : 0])),
          thresholds: { breakMinutes: 15, lunchMinutes: 60, timezone: 'Asia/Manila' }, businesses: [{ id: business, name: 'Synthetic Business' }], trend: [], facets: { teams: ['Sales'], roles: ['Sales'] }, reviewQueue: [] });
        if (path.startsWith('/attendance-hub/day/')) return send({ day, serverTime: new Date().toISOString() });
        if (path === '/attendance-hub/delivery-health') return send({ businesses: [], workers: [], serverTime: new Date().toISOString() });
        if (path === '/leads/workspace-capabilities') return send({ employeeBulkArchive: true, phoneDeduplication: true });
        if (path === '/leads/employee/bulk/archive') { archiveRequests++; assert.deepEqual(req.postDataJSON().leadIds, [lead._id]); archived = true; return send({ archivedCount: 1, archivedIds: [lead._id], conflictIds: [], busyIds: [], alreadyArchivedCount: 0, selectedCount: 1, preservedOtherOwnerCount: 0 }); }
        if (path.endsWith('/comments') && req.method() === 'POST') {
          if (failNote) { failNote = false; return send({ message: 'Synthetic note failure' }, 503); }
          lead.comments = [{ authorType: 'employee', authorName: employee.name, body: 'Synthetic draft', createdAt: new Date().toISOString() }]; return send(lead);
        }
        if (path === '/my-leads') return send({ leads: archived ? [] : [lead], total: archived ? 0 : 1, page: 1, hasMore: false, stateOptions: [], callingQueue: {
          scope: { employeeId: employee._id, businessId: business }, version: 'synthetic', serverTime: new Date().toISOString(), nextLead: archived ? null : lead, nextLeadId: archived ? null : lead._id,
          entries: [], callingWindow: { permitted: false } } });
        if (path === `/leads/${lead._id}`) return send(lead);
        if (path === `/employees/${employee._id}`) return send(employee);
        if (path === '/employees') return send([employee]);
        if (path === '/system-settings') return send({ employeeLeadMiniTabsEnabled: true });
        if (path.endsWith('/counts')) return send({ ALL: archived ? 0 : 1, NEW: archived ? 0 : 1 });
        if (path === '/businesses' || path === '/auth/businesses') return send([{ id: business, name: 'Synthetic Business' }]);
        if (path.includes('policy')) return send({ shiftStart: '23:00', shiftEnd: '08:00', graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, recoveryEnabled: false, recoveryTime: '08:05' });
        return send([]);
      });
      const page = lastPage = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
      if (role === 'employee') {
        await page.goto(`${origin}/leads`);
        await page.getByRole('checkbox', { name: 'Select visible leads (up to 100)' }).check();
        await page.getByPlaceholder('Add a note for this lead...').fill('Synthetic draft');
        await page.getByRole('button', { name: 'Archive Selected', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm Archive', exact: true }).click();
        await page.getByText('Synthetic note failure', { exact: true }).waitFor();
        assert.equal(archiveRequests, 0); assert.equal(await page.getByPlaceholder('Add a note for this lead...').inputValue(), 'Synthetic draft');
        await page.getByRole('button', { name: 'Confirm Archive', exact: true }).click();
        await page.getByText('1 lead records archived.', { exact: true }).waitFor();
        assert.equal(archiveRequests, 1); await page.reload();
        await page.getByText('0 selected', { exact: true }).waitFor(); assert.equal(await page.getByRole('checkbox', { name: 'Select Synthetic Contact', exact: true }).count(), 0);
      } else {
        await page.goto(`${origin}/admin/attendance`);
        const table = page.getByRole('table', { name: 'Employee shift records', exact: true });
        await table.getByRole('columnheader', { name: 'Employee', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: /Expand all|Collapse all/ }).count(), 0);
        await table.getByText('Synthetic Employee', { exact: true }).waitFor();
        await table.getByText('Synthetic No Record', { exact: true }).waitFor();
        await table.getByText('No shift record for this date', { exact: false }).waitFor();
        await page.getByRole('button', { name: 'Compact', exact: true }).click();
        await page.getByRole('combobox', { name: 'Shift date view' }).selectOption('all');
        await page.getByRole('button', { name: 'Older shifts', exact: true }).waitFor();
        await page.getByRole('combobox', { name: 'Shift date view' }).selectOption('date');
        await page.getByRole('textbox', { name: 'Specific shift date' }).count();
        await page.getByRole('button', { name: 'Reset to Today', exact: true }).click();
        await page.reload(); await table.getByRole('columnheader', { name: 'Employee', exact: true }).waitFor();
        if (i < 2) await page.screenshot({ path: `outputs/lead-workspace-browser/admin-${i ? 'mobile' : 'desktop'}.png`, fullPage: true });
      }
      results.push({ role, business, refreshVerified: true, viewport: page.viewportSize() }); await context.close();
    }
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ fixtureOnly: true, origin, results, errors }));
} catch (error) {
  if (lastPage && !lastPage.isClosed()) console.error(JSON.stringify({ url: lastPage.url(), errors, body: (await lastPage.locator('body').innerText()).slice(0, 4000) }));
  throw error;
} finally { await browser.close(); await server.httpServer.close(); }
