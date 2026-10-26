import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url)('playwright');
const directory = path.resolve(process.argv[2]), origin = 'https://non-billable-fixture.invalid';
const output = path.resolve('outputs/non-billable-off-phone/screenshots');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [], errors = [];
try {
    for (let index = 0; index < 6; index++) {
        const business = `synthetic-off-phone-${index}`, employeeId = `synthetic-employee-${index}`;
        const employee = { _id: employeeId, employeeCode: 'synthetic-code', name: 'Synthetic Employee', role: 'Designer', status: 'Active', availabilityStatus: 'ONLINE' };
        const shift = { dayKey: '2026-10-26', start: '2026-10-26T15:00:00.000Z', end: '2026-10-27T00:00:00.000Z', resetDeadline: '2026-10-27T14:59:00.000Z' };
        let now = Date.parse(shift.start) + 3600000, revision = 1, writes = 0, capable = true, pending = false;
        let records = [{ id: 'in', commandId: 'in', source: 'Time In', at: shift.start, sequence: 0 }];
        const state = () => records.at(-1).source === 'Time Out' ? 'OFFLINE' : records.at(-1).source.endsWith('Phone Out') ? 'OFF THE PHONE' : 'ONLINE';
        const snapshot = () => ({ state: state(), stateSince: records.at(-1).at, sessionId: state() === 'OFFLINE' ? null : 'session', revision, fingerprint: `synthetic-${revision}`,
            serverTime: new Date(now).toISOString(), reviewState: 'verified', review: [], syncPending: false, records, audit: [],
            assignedShift: state() === 'OFFLINE' ? null : shift, lifecycle: state() === 'OFFLINE' ? 'manually-closed' : 'open',
            allowances: { breakMinutes: 15, lunchMinutes: 60 },
            allowedActions: state() === 'OFFLINE' ? ['Time In'] : state() === 'OFF THE PHONE' ? ['Off the Phone In', 'Time Out'] : ['Off the Phone Out', ...(capable ? ['Non-Billable Off the Phone Out'] : []), 'Time Out', 'Break Out', 'Lunch Break Out'],
            sessions: [{ id: 'session', startedAt: shift.start, endedAt: state() === 'OFFLINE' ? records.at(-1).at : null, lifecycle: state() === 'OFFLINE' ? 'manually-closed' : 'open', mode: state(), shift, events: records }],
            dashboardDays: [{ dayKey: shift.dayKey, shiftStart: shift.start, shiftEnd: shift.end, eventIds: records.map(record => record.id), breakMinutes: 15, lunchMinutes: 60, milliseconds: {}, overBreakRows: [] }],
        });
        const context = await browser.newContext({ viewport: index % 2 ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
        await context.addInitScript(({ business, employee, index }) => {
            localStorage.setItem('activeBusinessId', business);
            localStorage.setItem('authUser', JSON.stringify({ userType: 'employee', user: employee, attendanceHubSession: 'synthetic-session', business: { id: business, name: 'Synthetic Business' }, allowedBusinesses: [{ id: business, name: 'Synthetic Business' }] }));
            document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = index % 2 ? 'light-command' : 'theme-1'; }, { once: true });
        }, { business, employee, index });
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) return route.abort();
            const requested = path.extname(url.pathname) ? path.resolve(directory, `.${url.pathname}`) : path.join(directory, 'index.html');
            assert.ok(requested.startsWith(`${directory}${path.sep}`));
            const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' };
            try { return await route.fulfill({ contentType: mime[path.extname(requested)] || 'application/octet-stream', body: await fs.readFile(requested) }); }
            catch { return route.fulfill({ status: 404, body: '' }); }
        });
        await context.routeWebSocket('**/socket.io/**', socket => {
            socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
            socket.onMessage(message => { if (typeof message === 'string' && message.startsWith('40')) socket.send('40{"sid":"synthetic"}'); });
        });
        await context.route('**/api/**', async route => {
            const request = route.request(), pathname = new URL(request.url()).pathname.slice(4);
            const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
            if (pathname.endsWith('/attendance/session')) return send(snapshot());
            if (pathname.endsWith('/attendance/commands')) {
                assert.equal(request.headers()['x-business-id'], business);
                assert.equal(request.headers()['x-crm-attendance-session'], 'synthetic-session');
                const command = request.postDataJSON(); assert.equal(command.operation, 'action'); assert.equal(command.expectedRevision, revision);
                assert.ok(snapshot().allowedActions.includes(command.source)); assert.equal(pending, false, 'no simultaneous duplicate command');
                pending = true; writes++; now += 61000;
                const additions = command.source === 'Time Out' && state() === 'OFF THE PHONE' ? ['Off the Phone In', 'Time Out'] : [command.source];
                records = [...records, ...additions.map((source, offset) => ({ id: `event-${revision}-${offset}`, commandId: command.commandId, source, sequence: records.length + offset, at: new Date(now).toISOString() }))];
                revision++; pending = false; return send(snapshot());
            }
            if (pathname.endsWith('/attendance')) return send([...records].reverse().map(event => ({ ...event, _id: event.id, timeIn: event.at, employee: employeeId })));
            if (pathname === `/employees/${employeeId}`) return send({ ...employee, availabilityStatus: state() });
            if (pathname === '/system-settings') return send({ officialShiftStartTime: '23:00', officialShiftEndTime: '08:00', attendanceTimeZone: 'Asia/Manila', themeKey: index % 2 ? 'light-command' : 'theme-1' });
            if (request.method() !== 'GET') throw new Error('Unexpected fixture write');
            return send([]);
        });
        const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${origin}/attendance`);
        const button = page.getByRole('button', { name: 'Non-Billable Off the Phone', exact: true });
        await button.waitFor(); await page.waitForFunction(() => !document.querySelector('[data-attendance-action="NON_BILLABLE_OFF_PHONE"]').disabled);
        const style = await button.evaluate(element => {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d'); context.fillStyle = getComputedStyle(element).backgroundColor; context.fillRect(0, 0, 1, 1);
            return { rgb: [...context.getImageData(0, 0, 1, 1).data], height: element.getBoundingClientRect().height, fits: element.scrollWidth <= element.clientWidth + 1 };
        });
        assert.ok(style.rgb[0] > 150 && style.rgb[1] < 120 && style.rgb[2] < 120, 'the actual rendered button must be red');
        const standardHeight = await page.getByRole('button', { name: 'Off the Phone', exact: true }).evaluate(element => element.getBoundingClientRect().height);
        assert.equal(style.height, standardHeight); assert.ok(style.height >= 40); assert.equal(style.fits, true);
        await button.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, index % 2 ? 'mobile.png' : 'desktop.png'), fullPage: true });
        await button.click(); await page.getByRole('button', { name: 'End Non-Billable Off the Phone', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'End Non-Billable Off the Phone', exact: true }).evaluate(element => {
            const label = element.querySelector('span');
            return label.getBoundingClientRect().height <= element.clientHeight && element.scrollWidth <= element.clientWidth + 1;
        }), true, 'the active label must also fit the unchanged button size');
        assert.equal(records.at(-1).source, 'Non-Billable Off the Phone Out'); assert.equal(writes, 1);
        await page.reload(); await page.getByRole('button', { name: 'End Non-Billable Off the Phone', exact: true }).click();
        await button.waitFor(); assert.equal(records.at(-1).source, 'Off the Phone In'); assert.equal(writes, 2);
        await page.getByRole('button', { name: 'Off the Phone', exact: true }).click();
        await page.getByRole('button', { name: 'End off the phone', exact: true }).click();
        assert.equal(records.at(-2).source, 'Off the Phone Out', 'normal paid off-phone remains unchanged');
        await button.click();
        await page.getByRole('button', { name: 'End Non-Billable Off the Phone', exact: true }).waitFor();
        await page.getByRole('button', { name: 'OFFLINE', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm Offline', exact: true }).click();
        await page.getByRole('button', { name: 'Time in', exact: true }).waitFor();
        assert.deepEqual(records.slice(-2).map(event => event.source), ['Off the Phone In', 'Time Out']);
        capable = false; records = records.slice(0, 1); revision++; const before = writes;
        await page.reload(); await button.waitFor();
        await page.waitForFunction(() => !document.querySelector('[data-attendance-action="OFF THE PHONE"]').disabled);
        assert.equal(await button.isDisabled(), true); assert.equal(writes, before);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        results.push({ business, verified: true, refreshAndCheckout: true, legacyServiceGuard: true });
        await context.close();
    }
    assert.deepEqual(errors, []); console.log(JSON.stringify({ verified: true, businesses: results.length, results, productionWrites: 0, providerCalls: 0 }));
} finally { await browser.close(); }
