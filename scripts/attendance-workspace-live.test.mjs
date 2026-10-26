import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, ''),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function fixture(employeeId) {
    const handlers = new Map(), visibility = new Map(), timers = new Map(), calls = [];
    let next = 0, blocked;
    const client = { invalidateQueries: query => { calls.push(query.queryKey[0]); return blocked || Promise.resolve(); },
        setQueryData: () => { throw Error('CROSS_BUSINESS_PAYLOAD_COPY'); } };
    const cache = {};
    runInNewContext(compile('../src/lib/employeeWorkspaceCache.ts'), { exports: cache });
    const exports = {};
    runInNewContext(compile('../src/lib/attendanceWorkspaceLive.ts'), { exports, refreshAttendanceWorkspace: cache.refreshAttendanceWorkspace,
        setTimeout: callback => { timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id) });
    const socket = { on: (name, fn) => handlers.set(name, fn), off: (name, fn) => { if (handlers.get(name) === fn) handlers.delete(name); } };
    const page = { visibilityState: 'visible', addEventListener: (name, fn) => visibility.set(name, fn), removeEventListener: name => visibility.delete(name) };
    const stop = exports.registerAttendanceWorkspaceRefresh(client, socket, page, employeeId);
    return { calls, timers, handlers, visibility, page, stop, block: promise => { blocked = promise; },
        emit: (name, payload) => handlers.get(name)?.(payload), flush: async () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } await new Promise(resolve => setImmediate(resolve)); } };
}
const required = ['attendance-session', 'employee-attendance', 'attendance-hub', 'attendance-hub-day', 'attendance-hub-live',
    'payroll-records', 'payroll-stats', 'payroll-dtr', 'payroll-payslip-dtr', 'employee-payments',
    'admin-dashboard-attendance-records', 'admin-call-dashboard', 'agent-lead-dashboard', 'dashboard-quick-view', 'employees'];

test('attendance events refresh all connected attendance/payroll/payment/dashboard queries in every business', async () => {
    for (let business = 0; business < 6; business++) {
        const f = fixture(); f.emit('employee:availability-updated'); await f.flush();
        for (const key of required) assert.ok(f.calls.includes(key), 'Missing connected query: ' + key);
        assert.equal(f.calls.some(key => ['lead-call-session', 'lead-call-queue', 'auto-call'].includes(key)), false);
        f.stop();
    }
});
test('reconnect and returning to the tab refresh missed changes without browser reload', async () => {
    const f = fixture();
    f.page.visibilityState = 'hidden'; f.emit('employee:availability-updated'); assert.equal(f.timers.size, 0);
    f.page.visibilityState = 'visible'; f.visibility.get('visibilitychange')(); await f.flush();
    assert.ok(f.calls.includes('employee-payments'));
    f.calls.length = 0; f.emit('connect'); await f.flush(); assert.ok(f.calls.includes('payroll-dtr')); f.stop();
});
test('burst events are coalesced and an event during a refresh gets a follow-up read', async () => {
    const f = fixture(); let release; f.block(new Promise(resolve => { release = resolve; }));
    for (let i = 0; i < 20; i++) f.emit('employee:availability-updated');
    assert.equal(f.timers.size, 1); await f.flush();
    const initial = f.calls.length; f.emit('employee:availability-updated'); assert.equal(f.timers.size, 0);
    release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.timers.size, 1);
    f.block(null); await f.flush(); assert.equal(f.calls.length, initial * 2); f.stop();
});
test('unmount removes listeners and cancels delayed or in-flight follow-up refresh', async () => {
    const f = fixture(); f.emit('connect'); f.stop(); await f.flush();
    assert.equal(f.calls.length, 0); assert.equal(f.handlers.size, 0); assert.equal(f.visibility.size, 0);
    const pending = fixture(); let release; pending.block(new Promise(resolve => { release = resolve; }));
    pending.emit('connect'); await pending.flush(); pending.emit('employee:availability-updated'); pending.stop();
    release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(pending.timers.size, 0);
});
test('employee views ignore another employee while admin views refresh for all authorized business updates', async () => {
    const employee = fixture('synthetic-own');
    employee.emit('employee:availability-updated', { employeeId: 'synthetic-other' }); await employee.flush(); assert.equal(employee.calls.length, 0);
    employee.emit('employee:availability-updated', { employeeId: 'synthetic-own' }); await employee.flush(); assert.ok(employee.calls.includes('employee-payments')); employee.stop();
    const admin = fixture(); admin.emit('employee:availability-updated', { employeeId: 'synthetic-other' }); await admin.flush(); assert.ok(admin.calls.includes('payroll-records')); admin.stop();
});
