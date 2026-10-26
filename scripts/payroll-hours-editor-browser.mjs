import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url)('playwright');
const directory = path.resolve(process.argv[2]), origin = 'https://payroll-hours-fixture.invalid';
const browser = await chromium.launch({ channel: 'msedge', headless: true }), results = [], errors = [];
try {
    for (let index = 0; index < 6; index++) {
        const business = `synthetic-hours-${index}`, employee = { _id: `synthetic-person-${index}`, employeeCode: `synthetic-code-${index}`,
            name: 'Synthetic Hours Employee', status: 'Active', role: 'Sales Agent' };
        const saved = { _id: `synthetic-payroll-${index}`, employeeId: employee.employeeCode, employeeName: employee.name, department: 'Synthetic',
            payPeriod: 'Oct 6, 2026 - Oct 20, 2026', payType: 'Semi-monthly', status: 'Pending', paidOn: '-',
            basicPay: 15000, grossPay: 15000, deductions: 50, netPay: 14950, hourlyRate: 163.04, minuteRate: 2.72, paidHoursPerDay: 8,
            workedHours: 87.64999999999999, scheduledHours: 88, attendanceDays: 11, incompleteShiftDays: 0, overtimeHours: 0 };
        let accuracy = true, writes = 0, forbiddenWrites = 0, previews = 0, staleRejected = false, conflict = false;
        const dtr = () => ({ employee: { ...employee, department: 'Synthetic' }, payPeriod: saved.payPeriod, payDate: '-', payType: saved.payType,
            storedCutoff: true, currentAttendanceReviewDays: 0, summary: { ...saved, monthlyWorkingDays: 23 }, rows: [] });
        const context = await browser.newContext({ viewport: index % 2 ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
        await context.addInitScript(({ business }) => {
            localStorage.setItem('activeBusinessId', business);
            localStorage.setItem('authUser', JSON.stringify({ userType: 'admin', user: { _id: 'synthetic-admin', employeeCode: 'synthetic-admin', name: 'Synthetic Admin', role: 'Admin' },
                sessionToken: 'synthetic-only-token', business: { id: business, name: 'Synthetic Business' }, allowedBusinesses: [{ id: business, name: 'Synthetic Business' }] }));
        }, { business });
        await context.route('**/*', route => { errors.push('Unexpected external fixture request'); return route.abort(); });
        await context.route(`${origin}/**`, async route => {
            const url = new URL(route.request().url()), file = path.extname(url.pathname) ? path.resolve(directory, '.' + url.pathname) : path.join(directory, 'index.html');
            assert.ok(file.startsWith(directory + path.sep));
            const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' };
            return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file) });
        });
        await context.routeWebSocket('**/socket.io/**', socket => {
            socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
            socket.onMessage(message => { if (typeof message === 'string' && message.startsWith('40')) socket.send('40{"sid":"synthetic"}'); });
        });
        await context.route('**/api/**', async route => {
            const request = route.request(), endpoint = new URL(request.url()).pathname.slice(4);
            const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
            assert.equal(request.headers()['x-business-id'], business);
            if (endpoint.endsWith('/worked-minutes/preview')) {
                const input = request.postDataJSON(); previews++;
                assert.equal(endpoint, `/payroll/records/${saved._id}/worked-minutes/preview`);
                assert.equal(input.workedMinutes, 4830);
                if (conflict) return send({ message: 'Synthetic saved cutoff conflict. No records changed.' }, 422);
                return send({ id: saved._id, payPeriod: saved.payPeriod, workedMinutes: input.workedMinutes, businessIds: [business], token: `synthetic-preview-${previews}`,
                    before: saved, after: { ...saved, workedHours: 80.5, deductions: 1229.44, netPay: 13770.56, deductibleMinutes: 452 } });
            }
            if (endpoint.endsWith('/worked-minutes/confirm')) {
                const input = request.postDataJSON(); assert.equal(input.workedMinutes, 4830); assert.equal(input.confirm, true);
                assert.equal(input.token, `synthetic-preview-${previews}`); assert.ok(input.reason.trim());
                if (!index && !staleRejected) { staleRejected = true; return send({ message: 'Synthetic stale preview. Preview total hours again.' }, 409); }
                writes++; Object.assign(saved, { workedHours: 80.5, workedMinutesOverride: 4830, deductions: 1229.44, netPay: 13770.56, deductibleMinutes: 452 });
                return send({ applied: true, mirrors: 1 });
            }
            if (request.method() !== 'GET') { forbiddenWrites++; return send({ message: 'Unexpected fixture write' }, 500); }
            if (endpoint.startsWith('/payroll/dtr/')) return send(dtr());
            if (endpoint === '/payroll/accuracy-config') return send({ enabled: accuracy, workedHoursEditingEnabled: accuracy });
            if (endpoint === '/payroll/records') return send([{ ...saved, _id: 'other-record', employeeId: 'other-code', employeeName: 'A Different Employee', payPeriod: 'Oct 21, 2026 - Nov 5, 2026' }, saved]);
            if (endpoint === '/payroll/stats') return send({ totalEmployees: 2, totalPayroll: 30000, totalDeductions: 100, netPayroll: 29900, paidEmployees: 0 });
            if (endpoint === '/system-settings') return send({ officialShiftStartTime: '23:00', officialShiftEndTime: '08:00', currencyCode: 'PHP', payrollBillingCycle: 'Semi-monthly' });
            if (endpoint === '/employees') return send([employee]);
            if (endpoint === '/businesses' || endpoint === '/auth/businesses') return send([{ id: business, name: 'Synthetic Business' }]);
            return send([]);
        });
        const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
        const open = async () => {
            await page.goto(origin + '/admin/payroll');
            await page.getByRole('button', { name: `Edit hours for ${employee.name}`, exact: true }).click();
            const editor = page.getByRole('dialog', { name: 'Edit total hours', exact: true }); await editor.waitFor(); return editor;
        };
        let editor = await open();
        assert.match(await editor.getByText('Saved total hours', { exact: true }).locator('..').innerText(), /87.65h/);
        assert.equal(await editor.getByLabel('Total hours for this cutoff', { exact: true }).inputValue(), '87.65');
        assert.equal(await page.getByRole('dialog', { name: 'Edit attendance', exact: true }).count(), 0);
        assert.match(await editor.innerText(), /Oct 6, 2026 - Oct 20, 2026/);
        await editor.getByLabel('Total hours for this cutoff', { exact: true }).fill('89');
        await editor.getByRole('button', { name: 'Preview changes', exact: true }).click();
        await editor.getByRole('alert').filter({ hasText: 'Enter total hours' }).waitFor(); assert.equal(previews, 0);
        await editor.getByLabel('Total hours for this cutoff', { exact: true }).fill('80.5');
        await editor.getByRole('button', { name: 'Preview changes', exact: true }).click();
        await editor.getByRole('button', { name: 'Save total hours', exact: true }).waitFor(); assert.equal(writes, 0);
        assert.equal(await editor.getByRole('button', { name: 'Save total hours', exact: true }).isEnabled(), false);
        assert.ok(await editor.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1));
        const bounds = await editor.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1);
        if (index < 2) { await fs.mkdir('outputs/payroll-total-hours-browser', { recursive: true }); await page.screenshot({ path: `outputs/payroll-total-hours-browser/${index ? 'mobile' : 'desktop'}.png`, fullPage: true }); }
        const approve = async () => {
            await editor.getByLabel('Reason', { exact: true }).fill('Synthetic reviewed total hours');
            await editor.getByRole('checkbox', { name: 'Confirm these payroll changes' }).check();
            await editor.getByRole('button', { name: 'Save total hours', exact: true }).click();
        };
        await approve();
        if (!index) {
            await editor.getByRole('alert').filter({ hasText: 'Synthetic stale preview' }).waitFor(); assert.equal(writes, 0);
            assert.equal(await editor.getByLabel('Total hours for this cutoff', { exact: true }).inputValue(), '80.5');
            await editor.getByRole('button', { name: 'Preview changes', exact: true }).click();
            await editor.getByRole('button', { name: 'Save total hours', exact: true }).waitFor(); await approve();
        }
        await editor.waitFor({ state: 'hidden' }); assert.equal(writes, 1); assert.equal(saved.grossPay, 15000); assert.equal(saved.status, 'Pending'); assert.equal(saved.paidOn, '-');
        editor = await open(); assert.equal(await editor.getByLabel('Total hours for this cutoff', { exact: true }).inputValue(), '80.5');
        assert.match(await editor.getByText('Saved total hours', { exact: true }).locator('..').innerText(), /80.5h/);
        if (index === 2) {
            await page.evaluate(() => localStorage.setItem('activeBusinessId', 'other-business'));
            await editor.getByRole('button', { name: 'Preview changes', exact: true }).click();
            await editor.getByRole('alert').filter({ hasText: 'Business changed' }).waitFor();
            await page.evaluate(value => localStorage.setItem('activeBusinessId', value), business);
        }
        if (index === 3) {
            conflict = true; await editor.getByRole('button', { name: 'Preview changes', exact: true }).click();
            await editor.getByRole('alert').filter({ hasText: 'Synthetic saved cutoff conflict' }).waitFor();
            assert.equal(writes, 1);
        }
        await editor.getByRole('button', { name: 'Close hours editor', exact: true }).click();
        if (index === 4) {
            saved.status = 'Paid'; editor = await open(); await editor.getByRole('alert').filter({ hasText: 'payroll is locked' }).waitFor();
            assert.equal(await editor.getByLabel('Total hours for this cutoff', { exact: true }).isEnabled(), false);
            assert.equal(await editor.getByRole('button', { name: 'Preview changes', exact: true }).isEnabled(), false);
            await editor.getByRole('button', { name: 'Close hours editor', exact: true }).click();
        }
        if (index === 5) {
            accuracy = false; await page.reload(); await page.getByRole('button', { name: `Edit hours for ${employee.name}`, exact: true }).click();
            await page.getByLabel('Total worked minutes for this cutoff', { exact: true }).waitFor();
            await page.getByRole('button', { name: 'Close worked minutes editor', exact: true }).click();
        }
        assert.equal(forbiddenWrites, 0);
        results.push({ business, totalHoursEditor: true, previewRequired: true, refreshVerified: true, rawAttendanceWrites: 0, payrollSaves: writes });
        await context.close();
    }
    assert.deepEqual(errors, []); console.log(JSON.stringify({ origin, fixtureOnly: true, productionWrites: 0, results, errors }));
} finally { await browser.close(); }
