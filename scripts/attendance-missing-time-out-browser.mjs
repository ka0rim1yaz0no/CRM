import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { attendanceTimeOutPlan } from '../shared/attendanceTimeOut.ts';
const { chromium } = createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url)('playwright');
const directory = path.resolve(process.argv[2]), origin = 'https://attendance-fixture.invalid';
const earlier = process.argv[3] === '--early';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [], errors = [];
try {
  for (let index = 0; index < 6; index++) {
    const business = `synthetic-${index}`, employeeId = `synthetic-person-${index}`, dayKey = '2026-10-21';
    const shift = { dayKey, start: `${dayKey}T15:00:00Z`, end: '2026-10-22T00:00:00Z', resetDeadline: '2026-10-22T14:59:00Z' };
    const now = '2026-10-22T01:00:00Z', out = [null, 'Break Out', 'Lunch Break Out', 'Off the Phone Out', earlier ? 'Non-Billable Off the Phone Out' : null, null][index];
    const event = (id, source, at, sequence) => ({ id, commandId: id, source, at, sequence });
    let records = [event('in', 'Time In', shift.start, 0), ...(out ? [event('out', out, `${dayKey}T23:30:00Z`, 1)] : [])];
    if (earlier) records = [event('in','Time In',shift.start,0), ...(out ? [event('out',out,`${dayKey}T22:00:00Z`,1),
      event('return',out==='Break Out'?'Break In':out==='Lunch Break Out'?'Lunch Break In':'Off the Phone In',`${dayKey}T23:30:00Z`,2)] : [event('later','Break Out',`${dayKey}T23:30:00Z`,1)])];
    const originalRecords = structuredClone(records);
    let addedCommand, replaced = [], undoCommand;
    let revision = records.length, writes = 0, previews = 0, rejected = false;
    const closed = () => records.some(event => event.source === 'Time Out');
    const state = () => closed() ? 'OFFLINE' : records.at(-1).source === 'Break Out' ? 'BREAK' : records.at(-1).source === 'Lunch Break Out' ? 'LUNCH' : ['Off the Phone Out','Non-Billable Off the Phone Out'].includes(records.at(-1).source) ? 'OFF THE PHONE' : 'ONLINE';
    const snapshot = () => ({ revision, fingerprint: `synthetic-${revision}`, state: state(), serverTime: now, receivedAt: Date.now(), records, syncPending: false,
      timeOutOverrideEnabled: earlier, stateSince: records.at(-1).at, time: { actual: { break: 0, lunch: 0 } },
      audit: [...new Set(records.map(row=>row.commandId))].map(commandId=>({commandId,operation:commandId===addedCommand?'add-time-out':commandId===undoCommand?'undo':'action',actor:{role:commandId===addedCommand||commandId===undoCommand?'admin':'employee'}})), sessions: [{ id: 'session', startedAt: shift.start,
        endedAt: closed() ? records.at(-1).at : null, mode: state(), lifecycle: closed() ? 'manually-closed' : 'open', shift, events: records }] });
    const day = () => ({ employeeId, employeeCode: 'synthetic-code', employeeName: 'Synthetic Employee', team: 'Fixture', role: 'Test', scopeKey: 'synthetic-code',
      businessId: business, businessName: 'Synthetic Business', dayKey, shiftStart: shift.start, shiftEnd: shift.end, timeIn: shift.start,
      timeOut: closed() ? records.at(-1).at : null, status: state(), inProgress: !closed(), events: records, timeline: [], businesses: [],
      issues: closed() && index === 0 ? ['under time'] : [], review: [], note: '', noteRevisions: [], audit: [], breakMinutes: 15, lunchMinutes: 60, breakSessions: [],
      milliseconds: Object.fromEntries(['online','break','lunch','offPhone','offline','late','underTime','overBreak','overLunch','overtime'].map(key => [key, key === 'underTime' && closed() && index === 0 ? 600000 : 0])) });
    const context = await browser.newContext({ viewport: index % 2 ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    await context.addInitScript(({ business }) => {
      localStorage.setItem('activeBusinessId', business);
      localStorage.setItem('authUser', JSON.stringify({ userType: 'admin', user: { _id: 'synthetic-admin', employeeCode: 'synthetic-admin', name: 'Synthetic Admin', role: 'Admin' },
        sessionToken: 'synthetic-session', business: { id: business, name: 'Synthetic Business' }, allowedBusinesses: [{ id: business, name: 'Synthetic Business' }] }));
    }, { business });
    await context.route('**/*', route => { errors.push('Unexpected external fixture request'); return route.abort(); });
    await context.route(`${origin}/**`, async route => {
      const url = new URL(route.request().url()), requested = path.extname(url.pathname) ? path.resolve(directory, `.${url.pathname}`) : path.join(directory, 'index.html');
      assert.ok(requested.startsWith(`${directory}${path.sep}`));
      const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' };
      return route.fulfill({ contentType: mime[path.extname(requested)] || 'application/octet-stream', body: await fs.readFile(requested) });
    });
    await context.routeWebSocket('**/socket.io/**', socket => {
      socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
      socket.onMessage(message => { if (typeof message === 'string' && message.startsWith('40')) socket.send('40{"sid":"synthetic"}'); });
    });
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), pathname = url.pathname.slice(4);
      assert.equal(request.headers()['x-business-id'], business);
      const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (pathname.endsWith('/attendance/session')) return send(snapshot());
      if (pathname.endsWith('/attendance/preview')) {
        previews++; const input = request.postDataJSON();
        if (earlier) {
          assert.ok(['add-time-out','undo'].includes(input.operation));
          if(input.operation==='add-time-out'){assert.equal(input.sessionId,'session');assert.equal(input.timeOutAt,`${dayKey}T23:00:00.000Z`);assert.equal(input.changes,undefined);}
          else assert.equal(input.targetCommandId,addedCommand);
        } else {
          assert.equal(input.operation, 'correct'); assert.equal(input.changes.at(-1).source, 'Time Out');
          assert.ok(input.changes.every(change => !change.targetId && !change.remove), 'ordinary add retains original events');
        }
        assert.equal(input.expectedRevision, revision);
        if (index === 0 && !rejected) { rejected = true; return send({ code: 'STALE_REVISION', message: 'Synthetic preview changed. Review again.' }, 409); }
        return send({ before: snapshot(), after: { ...snapshot(), state: 'OFFLINE' }, targets: [], businessIds: [business], payrollImpact: 'Pending payroll recalculates; finalized payroll remains finalized.' });
      }
      if (pathname.endsWith('/attendance/commands')) {
        writes++; const input = request.postDataJSON(); assert.equal(input.expectedRevision, revision);
        if(earlier&&input.operation==='add-time-out'){
          const plan=attendanceTimeOutPlan(snapshot().sessions,input.sessionId,input.timeOutAt,now);
          replaced=records.filter(row=>plan.replaced.some(item=>item.id===row.id));
          records=records.filter(row=>!replaced.includes(row));addedCommand=input.commandId;
          for(const source of [...(plan.returnSource?[plan.returnSource]:[]),'Time Out'])records.push({...event(`added-${records.length}`,source,plan.at,records.length),commandId:input.commandId});
        } else if(earlier&&input.operation==='undo'){
          assert.equal(input.targetCommandId,addedCommand);undoCommand=input.commandId;
          records=[...records.filter(row=>row.commandId!==addedCommand),...replaced.map((row,index)=>({...row,id:'restored-'+index,commandId:input.commandId}))].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.sequence-b.sequence);
        }else records = [...records, ...input.changes.map((change, i) => ({ ...event(`added-${i}`, change.source, change.at, records.length + i), commandId: input.commandId }))];
        revision++; return send(snapshot());
      }
      if (pathname === '/attendance-hub/days') return send({ rows: [day()], total: 1, page: 1, pageSize: 25, employees: [day()], history: { today: '2026-10-22', page: 1, hasOlder: false, hasNewer: false },
        range: { from: dayKey, to: dayKey }, serverTime: now,
        summary: Object.fromEntries(['daysWorked','employeesPresent','online','break','lunch','offPhone','lateCount','late','overBreakCount','overBreak','overLunchCount','overLunch','underTimeCount','underTime','overtime','absent','needsReview','onTimeRate'].map(key => [key, 0])),
        thresholds: { breakMinutes: 15, lunchMinutes: 60, timezone: 'Asia/Manila' },
        businesses: [{ id: business, name: 'Synthetic Business' }], trend: [], facets: { teams: [], roles: [] }, reviewQueue: [] });
      if (pathname.startsWith('/attendance-hub/day/')) return send({ day: day(), serverTime: now });
      if (pathname === '/attendance-hub/delivery-health') return send({ businesses: [], workers: [], serverTime: now });
      if (pathname.includes('policy')) return send({ shiftStart: '23:00', shiftEnd: '08:00', graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, recoveryEnabled: false });
      if (pathname === '/system-settings') return send({});
      if (pathname === '/businesses' || pathname === '/auth/businesses') return send([{ id: business, name: 'Synthetic Business' }]);
      return send([]);
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    const open = async () => {
      await page.goto(`${origin}/admin/attendance?shiftView=date&shiftDate=${dayKey}`);
      await page.getByRole('table', { name: 'Employee shift records' }).getByRole('button', { name: 'Oct 21, 2026', exact: true }).click();
      await page.getByRole('button', { name: 'Edit attendance', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Edit attendance', exact: true }); await editor.waitFor(); return editor;
    };
    let editor = await open();
    await editor.getByRole('button', { name: 'Add Time Out', exact: true }).click();
    assert.equal(await editor.getByLabel('PH Time Out', { exact: true }).inputValue(), '2026-10-22T08:00');
    if (earlier) await editor.getByLabel('PH Time Out', { exact: true }).fill('2026-10-22T07:00');
    else if (index === 0) await editor.getByLabel('PH Time Out', { exact: true }).fill('2026-10-22T07:50');
    if (out) await editor.getByRole('checkbox').check();
    await editor.getByLabel('Reason', { exact: true }).fill('Synthetic reviewed missing checkout');
    await editor.getByRole('button', { name: 'Review change', exact: true }).click();
    if (index === 0) {
      await editor.getByRole('alert').filter({ hasText: 'Synthetic preview changed' }).waitFor(); assert.equal(writes, 0);
      assert.equal(await editor.getByLabel('Reason', { exact: true }).inputValue(), 'Synthetic reviewed missing checkout');
      await editor.getByRole('button', { name: 'Review change', exact: true }).click();
    }
    await editor.getByRole('alertdialog', { name: 'Confirm attendance change' }).waitFor(); assert.equal(writes, 0);
    const bounds = await editor.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1);
    if (index < 2) { await fs.mkdir('outputs/attendance-missing-time-out-browser', { recursive: true }); await page.screenshot({ path: `outputs/attendance-missing-time-out-browser/${index ? 'mobile' : 'desktop'}.png`, fullPage: true }); }
    await editor.getByRole('button', { name: 'Confirm change', exact: true }).click();
    await editor.getByText('Saved and synchronized.', { exact: true }).waitFor();
    assert.equal(writes, 1); assert.equal(await editor.getByRole('button', { name: 'Add Time Out', exact: true }).isEnabled(), false);
    await editor.getByRole('button', { name: 'Close attendance editor', exact: true }).click(); await page.reload();
    editor = await open(); assert.equal(await editor.getByRole('button', { name: 'Add Time Out', exact: true }).isEnabled(), false);
    assert.equal(records.filter(event => event.source === 'Time Out').length, 1);
    if(earlier){
      assert.ok(records.every(row=>Date.parse(row.at)<=Date.parse(`${dayKey}T23:00:00Z`)));
      await editor.getByRole('button',{name:index%2?'Undo Time Out':'Undo last action',exact:true}).click();
      await editor.getByLabel('Reason',{exact:true}).fill('Synthetic reviewed undo of earlier checkout');
      await editor.getByRole('button',{name:'Review change',exact:true}).click();
      await editor.getByRole('alertdialog',{name:'Confirm attendance change'}).waitFor();
      await editor.getByRole('button',{name:'Confirm change',exact:true}).click();
      await editor.getByText('Saved and synchronized.',{exact:true}).waitFor();assert.equal(writes,2);
      assert.deepEqual(records.map(row=>[row.source,row.at]),originalRecords.map(row=>[row.source,row.at]));
      await editor.getByRole('button',{name:'Close attendance editor',exact:true}).click();await page.reload();
      editor=await open();assert.equal(await editor.getByRole('button',{name:'Add Time Out',exact:true}).isEnabled(),true);
    }
    results.push({ business, viewport: page.viewportSize(), missingCheckoutSaved: true, refreshVerified: true, pairedRest: out, earlierCheckout:earlier,undoRestoresReplacedActions:earlier,writes, previews });
    await context.close();
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ origin, fixtureOnly: true, productionWrites: 0, results, errors }));
} finally { await browser.close(); }
