import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url)('playwright');
const directory = path.resolve(process.argv[2]), origin = 'https://payments-fixture.invalid';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [], errors = [], forbiddenActions = [];
try {
    for (let index = 0; index < 6; index++) {
        const business = `payment-fixture-${index}`, employeeId = `synthetic-payment-person-${index}`, theme = index % 2 ? 'light-command' : 'theme-1';
        const employee = { _id: employeeId, name: 'Synthetic Payment Employee', employeeCode: 'synthetic-payment-code', role: 'Designer', team: 'Fixture', status: 'Active', availabilityStatus: 'OFFLINE' };
        const item = { id: `synthetic-pay-${index}`, payPeriod: 'Oct 6, 2026 - Oct 20, 2026', cutoffStart: '2026-10-06', cutoffEnd: '2026-10-20',
            payType: 'Semi-monthly', department: 'Fixture', grossPay: 15000, basicPay: 15000, deductions: 48.91, netPay: 14951.09,
            lateMinutes: 1, excessBreakMinutes: 6, nonBillableOffPhoneMinutes: 11, excessLunchMinutes: 0, earlyTimeOutMinutes: 0, absenceMinutes: 0, deductibleMinutes: 18,
            monthlySalary: null, hourlyRate: null, minuteRate: 30000 / 23 / 8 / 60, paidHoursPerDay: null, workingDays: 23, attendanceDays: 11, absentDays: 0,
            workedHours: 87.7, scheduledHours: 88, overtimeHours: 0, overtimeApproved: false, incompleteShiftDays: 0,
            status: 'Pending', paidOn: null, scheduledPayDate: '2026-10-25', updatedAt: '2026-10-23T13:00:00Z' };
        let paid = false, reads = 0, empty = false, setupPending = false, fail = false, zeroRate = false;
        const context = await browser.newContext({ viewport: index % 2 ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
        await context.addInitScript(({ business, employee, theme }) => {
            localStorage.setItem('activeBusinessId', business);
            localStorage.setItem('authUser', JSON.stringify({ userType: 'employee', user: employee, attendanceHubSession: 'synthetic-payment-session',
                business: { id: business, name: 'Synthetic Business' }, allowedBusinesses: [{ id: business, name: 'Synthetic Business' }] }));
            document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = theme; }, { once: true });
        }, { business, employee, theme });
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) return route.abort();
            const requested = path.extname(url.pathname) ? path.resolve(directory, `.${url.pathname}`) : path.join(directory, 'index.html');
            assert.ok(requested.startsWith(`${directory}${path.sep}`));
            const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
            try { return await route.fulfill({ contentType: mime[path.extname(requested)] || 'application/octet-stream', body: await fs.readFile(requested) }); }
            catch { return route.fulfill({ status: 404, body: '' }); }
        });
        let transport;
        await context.routeWebSocket('**/socket.io/**', socket => {
            transport = socket;
            socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
            socket.onMessage(message => { if (typeof message === 'string' && message.startsWith('40')) socket.send('40{"sid":"synthetic"}'); });
        });
        await context.route('**/api/**', async route => {
            const request = route.request(), url = new URL(request.url()), pathname = url.pathname.slice(4);
            const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
            if (/\/payroll|\/attendance\/commands|\/call-bridge\/(activate|reserve|dial-start)/.test(pathname) && request.method() !== 'GET') forbiddenActions.push(pathname);
            if (pathname === `/employees/${employeeId}/payments`) {
                reads++; assert.equal(request.method(), 'GET'); assert.equal(request.headers()['x-business-id'], business);
                assert.equal(request.headers()['x-crm-attendance-session'], 'synthetic-payment-session');
                if (fail) return send({ message: 'Synthetic failed refresh' }, 503);
                const view = url.searchParams.get('view') || 'current';
                let items = [{ ...item, ...(paid ? { status: 'Paid', paidOn: 'Oct 25, 2026' } : {}),
                    ...(zeroRate ? { basicPay: 0, grossPay: 0, deductions: 0, netPay: 0, minuteRate: 0, deductibleMinutes: 0,
                        lateMinutes: 0, excessBreakMinutes: 0, nonBillableOffPhoneMinutes: 0, workedHours: 0 } : {}) },
                    { ...item, id: 'future', payPeriod: 'Oct 21, 2026 - Nov 5, 2026', cutoffStart: '2026-10-21', cutoffEnd: '2026-11-05' },
                    { ...item, id: 'monthly', payPeriod: 'Oct 6, 2026 - Nov 5, 2026', cutoffEnd: '2026-11-05' },
                    { ...item, id: 'old', payPeriod: 'Sep 21, 2026 - Oct 5, 2026', cutoffStart: '2026-09-21', cutoffEnd: '2026-10-05' }];
                if (index % 2) items = items.filter(value => value.id !== 'monthly' && value.id !== 'old' && (view === 'history' || value.id !== 'future'));
                if (empty || setupPending) items = [];
                return send({ business: { id: business, name: 'Synthetic Business' }, currencyCode: 'PHP', currentPayPeriod: item.payPeriod,
                    historyFrom: '2026-10-06', initialPayPeriod: item.payPeriod, setupPending, items,
                    ...(index % 2 ? { view } : {}), total: items.length, page: 1, pageSize: 20, reviewCount: 0, asOf: new Date().toISOString() });
            }
            if (pathname === `/employees/${employeeId}`) return send(employee);
            if (pathname.endsWith('/recent-activity')) return send({ items: [], hasMore: false, nextOffset: null, metrics: null });
            if (pathname.endsWith('/attendance/session')) return send({ state: 'OFFLINE', sessions: [], records: [], revision: 0, serverTime: new Date().toISOString(), syncPending: false });
            if (pathname === '/system-settings') return send({ themeKey: theme, currencyCode: 'PHP' });
            if (pathname === '/businesses' || pathname === '/auth/businesses') return send([{ id: business, name: 'Synthetic Business' }]);
            if (pathname === '/messages/conversations') return send([]);
            return send([]);
        });
        const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${origin}/profile?tab=payments`);
        const tab = page.getByRole('tab', { name: 'Payments', exact: true });
        await tab.waitFor(); assert.equal(await tab.getAttribute('aria-selected'), 'true');
        const tabs = await page.getByRole('tablist', { name: 'Profile sections' }).getByRole('tab').allTextContents();
        assert.deepEqual(tabs, ['Overview', 'Leave', 'Notices', 'Payments']);
        const ledger = page.getByRole('region', { name: 'Payments', exact: true });
        await ledger.getByText('Pending', { exact: true }).waitFor();
        assert.equal(await ledger.locator('summary').count(), 1, 'default must show only Oct 6-20');
        await ledger.getByRole('combobox', { name: 'Payment cutoff view' }).selectOption('history');
        await ledger.getByText('Oct 21, 2026 - Nov 5, 2026', { exact: true }).waitFor();
        assert.equal(await ledger.locator('summary').count(), 2, 'history must exclude old and overlapping monthly records');
        await ledger.getByRole('combobox', { name: 'Payment cutoff view' }).selectOption('current');
        await ledger.getByText('Oct 21, 2026 - Nov 5, 2026', { exact: true }).waitFor({ state: 'hidden' });
        await ledger.locator('summary').click();
        await ledger.getByRole('heading', { name: 'Deductions', exact: true }).waitFor();
        await ledger.getByText('Non-billable Off the Phone', { exact: false }).waitFor();
        for (const label of ['Basic pay (monthly)', 'Hourly rate', 'Paid hours / day']) await ledger.getByText(label, { exact: true }).waitFor();
        assert.equal(await ledger.getByText('Not recorded', { exact: true }).count(), 0, 'complete saved pay inputs must yield calculated rates');
        const amounts = await ledger.locator('section[aria-label="Deductions"] dd').allTextContents();
        const parse = value => Number(value.replace(/[^\d.]/g, ''));
        assert.equal(amounts.slice(0, -1).reduce((sum, value) => sum + Math.round(parse(value) * 100), 0), 4891);
        assert.equal(parse(amounts.at(-1)), 48.91);
        await page.waitForTimeout(400);
        const beforeLiveRead = reads;
        item.workedHours = 87.65;
        assert.ok(transport, 'the signed employee socket should be connected');
        transport.send('42' + JSON.stringify(['employee:availability-updated', { employeeId, availabilityStatus: 'OFFLINE' }]));
        const attendance = ledger.getByRole('region', { name: 'Attendance', exact: true });
        await attendance.getByText('87.65h', { exact: true }).waitFor({ timeout: 3000 });
        assert.ok(reads > beforeLiveRead, 'an external attendance correction must refresh Payments without a click');
        assert.equal(await ledger.getByText('Pending', { exact: true }).count(), 1);
        assert.equal(parse((await ledger.locator('section[aria-label="Deductions"] dd').allTextContents()).at(-1)), 48.91);
        paid = true; await ledger.getByRole('button', { name: 'Refresh payments', exact: true }).click();
        await ledger.getByText('Paid', { exact: true }).waitFor();
        await page.reload(); await ledger.getByText('Paid', { exact: true }).waitFor();
        await ledger.locator('summary').click(); await ledger.getByText('Oct 25, 2026', { exact: true }).first().waitFor();
        await tab.focus(); await page.keyboard.press('ArrowLeft'); assert.equal(await page.getByRole('tab', { name: 'Notices', exact: true }).getAttribute('aria-selected'), 'true');
        await page.keyboard.press('End'); assert.equal(await tab.getAttribute('aria-selected'), 'true');
        await ledger.locator('summary').click();
        const overflow = await ledger.evaluate(element => [...element.querySelectorAll('summary,section,dd,button')].filter(node => node.scrollWidth > node.clientWidth + 2).map(node => node.tagName));
        assert.deepEqual(overflow, [], 'payment text must fit without horizontal clipping');
        const bodyWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
        assert.ok(bodyWidth.scroll <= bodyWidth.width + 1, JSON.stringify(bodyWidth));
        const layout = await ledger.boundingBox(); assert.ok(layout.x >= 0 && layout.x + layout.width <= page.viewportSize().width + 1);
        if (index < 2) { await fs.mkdir('outputs/employee-payments-browser', { recursive: true }); await ledger.scrollIntoViewIfNeeded(); await page.screenshot({ path: `outputs/employee-payments-browser/${index ? 'mobile-light' : 'desktop-dark'}.png`, fullPage: true }); }
        zeroRate = true; await ledger.getByRole('button', { name: 'Refresh payments', exact: true }).click();
        const rateValue = label => ledger.locator('.employee-payment-meta > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd');
        await rateValue('Hourly rate').filter({ hasText: /0\.00/ }).waitFor();
        assert.equal(await rateValue('Paid hours / day').innerText(), 'Not recorded');
        await page.reload(); await ledger.getByText('Paid', { exact: true }).waitFor(); await ledger.locator('summary').click();
        assert.match(await rateValue('Hourly rate').innerText(), /0\.00/);
        assert.equal(await rateValue('Paid hours / day').innerText(), 'Not recorded');
        zeroRate = false; await ledger.getByRole('button', { name: 'Refresh payments', exact: true }).click();
        await rateValue('Paid hours / day').filter({ hasText: '8h' }).waitFor();
        if (index === 0) {
            fail = true; await ledger.getByRole('button', { name: 'Refresh payments', exact: true }).click(); await ledger.getByRole('alert').waitFor();
            assert.equal(await ledger.getByText('Paid', { exact: true }).count(), 1); fail = false;
            empty = true; await ledger.getByRole('button', { name: 'Refresh payments', exact: true }).click(); await ledger.getByText('Payroll not yet released.', { exact: true }).waitFor();
            setupPending = true; await ledger.getByRole('button', { name: 'Refresh payments', exact: true }).click(); await ledger.getByText('Payment history is being prepared.', { exact: true }).waitFor();
        }
        assert.ok(reads >= 3); results.push({ business, theme, viewport: page.viewportSize(), liveAttendanceRefresh: true, refreshVerified: true, deductionsReconciled: true, tabNavigation: true });
        await context.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(forbiddenActions, []);
    console.log(JSON.stringify({ origin, fixtureOnly: true, productionWrites: 0, results, errors }));
} finally { await browser.close(); }
