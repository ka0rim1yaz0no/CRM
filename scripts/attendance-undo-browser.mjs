import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { preview } from 'vite';
const { chromium } = createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url)('playwright');
const origin = 'http://localhost:5173';
const server = await preview({ envDir: false, build: { outDir: process.argv[2] }, preview: { host: 'localhost', port: 5173, strictPort: true } });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [], errors = []; let lastPage;
try {
  await fs.mkdir('outputs/attendance-undo-browser', { recursive: true });
  for (let i = 0; i < 6; i++) {
    const business = `synthetic-${i}`, person = { _id: 'synthetic-employee', employeeCode: 'synthetic-code', name: 'Synthetic Employee', team: 'Fixture', role: 'Test' };
    const shift = { dayKey: '2026-10-22', start: '2026-10-22T15:00:00Z', end: '2026-10-23T00:00:00Z', resetDeadline: '2026-10-23T14:59:00Z' };
    const now = '2026-10-22T18:31:00Z';
    const event = (id, source, at, sequence) => ({ id, commandId: id, source, at, sequence });
    const originals = [event('old-in','Time In','2026-10-21T15:00:00Z',0), event('old-out','Time Out','2026-10-22T00:00:00Z',1),
      event('in','Time In','2026-10-22T15:00:00Z',2), event('out','Break Out','2026-10-22T18:00:00Z',3), event('back','Break In','2026-10-22T18:15:00Z',4)];
    let records = [...originals], revision = 5, commands = 0, previews = [], rejectOnce = i === 0;
    const milliseconds = Object.fromEntries(['online','break','lunch','offPhone','offline','late','underTime','overBreak','overLunch','overtime'].map(key => [key, key === 'break' ? 900000 : 0]));
    const audit = originals.map(e => ({ commandId: e.commandId, operation: 'action', actor: { role: 'employee', code: person.employeeCode } }));
    const snapshot = (items = records) => ({ revision, fingerprint: `synthetic-${revision}`, state: items.at(-1)?.source === 'Break Out' ? 'BREAK' : 'ONLINE', stateSince: items.at(-1)?.at,
      records: items, audit, serverTime: now, syncPending: false, time: { actual: { break: 900000, lunch: 0 } },
      sessions: [{ id: 'old', lifecycle: 'manually-closed', shift: { ...shift, dayKey: '2026-10-21', resetDeadline: '2026-10-22T14:59:00Z' }, events: items.filter(e => e.id.startsWith('old')) },
        { id: 'current', lifecycle: 'open', shift, events: items.filter(e => !e.id.startsWith('old')) }] });
    const day = key => ({ ...person, employeeId: person._id, employeeName: person.name, scopeKey: person.employeeCode, businessId: business, businessName: 'Synthetic Business', dayKey: key,
      shiftStart: shift.start, shiftEnd: shift.end, timeIn: shift.start, timeOut: null, status: 'ONLINE', inProgress: true, excused: false, absent: false, mismatch: false, issues: [], review: [], note: '', leave: null,
      graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, breakSessions: [], noteRevisions: [], audit: [], milliseconds,
      events: records.filter(e => key === '2026-10-21' ? e.id.startsWith('old') : !e.id.startsWith('old')), timeline: [], businesses: [] });
    const context = await browser.newContext({ viewport: i % 2 ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    await context.addInitScript(({ business }) => { localStorage.setItem('activeBusinessId', business); localStorage.setItem('authUser', JSON.stringify({ userType: 'admin', user: { _id: 'synthetic-admin', name: 'Synthetic Admin', role: 'Admin' }, sessionToken: 'synthetic-token', business: { id: business, name: 'Synthetic Business' }, allowedBusinesses: [{ id: business, name: 'Synthetic Business' }] })); }, { business });
    await context.routeWebSocket('**/socket.io/**', socket => { socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}'); socket.onMessage(message => { if (message === '40') socket.send('40{"sid":"synthetic"}'); }); });
    await context.route('**/socket.io/**', route => route.fulfill({ contentType: 'text/plain', body: '0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}' }));
    await context.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url()), path = url.pathname.slice(4);
      const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (path.endsWith('/attendance/session')) return send(snapshot());
      if (path.endsWith('/attendance/preview')) {
        const input = req.postDataJSON(); previews.push(input);
        assert.ok(input.targetCommandId || input.changes?.every(change=>change.targetId && change.remove), 'Undo must always freeze explicit selected-shift targets');
        const targets = records.filter(e => input.targetCommandId ? e.commandId === input.targetCommandId : input.changes.some(change=>change.targetId===e.id));
        if (rejectOnce) { rejectOnce = false; return send({ code: 'INVALID_TIMELINE', message: 'The resulting timeline is invalid.', details: [{ message: 'Synthetic dependency requires a reviewed correction.' }] }, 422); }
        return send({ revision, before: snapshot(), after: snapshot(records.filter(e => !targets.includes(e))), payrollImpact: 'Synthetic payroll preview', businessIds: [business], targets: targets.map(e => e.id) });
      }
      if (path.endsWith('/attendance/commands')) {
        const input = req.postDataJSON(); records = records.filter(e => input.targetCommandId ? e.commandId !== input.targetCommandId : !input.changes.some(change=>change.targetId===e.id)); revision++; commands++;
        audit.push({ commandId: input.commandId, operation: 'undo', actor: { role: 'admin', code: 'synthetic-admin' } }); return send(snapshot());
      }
      if (path === '/attendance-hub/days') {
        const key = url.searchParams.get('shiftDate') || '2026-10-22';
        return send({ rows: [day(key)], total: 1, page: 1, pageSize: 25, employees: [day(key)], history: { today: '2026-10-23', page: 1, hasOlder: false, hasNewer: false }, range: { from: key, to: key }, serverTime: now,
          summary: Object.fromEntries(['daysWorked','employeesPresent','online','break','lunch','offPhone','lateCount','late','overBreakCount','overBreak','overLunchCount','overLunch','underTimeCount','underTime','overtime','absent','needsReview','onTimeRate'].map(key => [key,0])),
          thresholds: { breakMinutes: 15, lunchMinutes: 60, timezone: 'Asia/Manila' }, businesses: [{ id: business, name: 'Synthetic Business' }], trend: [], facets: { teams: [], roles: [] }, reviewQueue: [] });
      }
      if (path.startsWith('/attendance-hub/day/')) return send({ day: day(decodeURIComponent(path.split('/').at(-1))), serverTime: now });
      if (path === '/attendance-hub/delivery-health') return send({ businesses: [], workers: [], serverTime: now });
      if (path.includes('policy')) return send({ shiftStart: '23:00', shiftEnd: '08:00', graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, recoveryEnabled: false, recoveryTime: '22:59' });
      if (path === '/businesses' || path === '/auth/businesses') return send([{ id: business, name: 'Synthetic Business' }]);
      if (path === '/system-settings') return send({});
      return send([]);
    });
    const page = lastPage = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    const openEditor = async date => {
      await page.goto(`${origin}/admin/attendance?shiftView=date&shiftDate=${date}`);
      await page.getByRole('table',{name:'Employee shift records',exact:true}).getByRole('button',{name: date.endsWith('21') ? 'Oct 21, 2026' : 'Oct 22, 2026',exact:true}).click();
      await page.getByRole('button',{name:'Edit attendance',exact:true}).click();
      const editor = page.getByRole('dialog',{name:'Edit attendance',exact:true}); await editor.waitFor(); return editor;
    };
    let editor = await openEditor('2026-10-22');
    assert.equal(await editor.getByRole('button',{name:'Undo Break Out',exact:true}).isEnabled(), true);
    await editor.getByRole('button',{name:'Undo last action',exact:true}).click();
    await editor.getByLabel('Reason',{exact:true}).fill('Synthetic reviewed accidental button');
    await editor.getByRole('button',{name:'Review change',exact:true}).click();
    if (i === 0) {
      await editor.getByRole('alert').filter({hasText:'Synthetic dependency requires a reviewed correction.'}).waitFor();
      assert.equal(commands, 0); assert.equal(await editor.getByLabel('Reason',{exact:true}).inputValue(), 'Synthetic reviewed accidental button');
      assert.equal(await editor.getByRole('button',{name:'Confirm change',exact:true}).count(),0);
      await editor.getByRole('button',{name:'Review change',exact:true}).click();
    }
    await editor.getByRole('button',{name:'Confirm change',exact:true}).click();
    await editor.getByText('Saved and synchronized.',{exact:true}).waitFor(); assert.equal(previews.at(-1).targetCommandId,'back');
    const rowUndo = editor.getByRole('button',{name:'Undo Break Out',exact:true}); await rowUndo.waitFor();
    await rowUndo.click(); await editor.getByLabel('Reason',{exact:true}).fill('Synthetic second reviewed undo');
    await editor.getByRole('button',{name:'Review change',exact:true}).click(); await editor.getByRole('button',{name:'Confirm change',exact:true}).click();
    await editor.getByText('Saved and synchronized.',{exact:true}).waitFor(); assert.equal(previews.at(-1).targetCommandId,'out'); assert.equal(commands,2);
    await editor.getByRole('button',{name:'Close attendance editor',exact:true}).click(); await page.reload();
    editor = await openEditor('2026-10-22'); assert.equal(await editor.getByRole('button',{name:'Undo Break In',exact:true}).count(),0);
    const bounds = await editor.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1);
    if (i < 2) await page.screenshot({path:`outputs/attendance-undo-browser/${i ? 'mobile' : 'desktop'}.png`,fullPage:true});
    await editor.getByRole('button',{name:'Close attendance editor',exact:true}).click();
    editor = await openEditor('2026-10-21');
    assert.equal(await editor.getByRole('button',{name:'Undo last action',exact:true}).isEnabled(),false);
    assert.equal(await editor.getByRole('button',{name:'Undo Time Out',exact:true}).isEnabled(),false); assert.equal(commands,2);
    assert.ok(previews.every(input => ['back','out'].includes(input.targetCommandId)));
    await editor.getByRole('button',{name:'Close attendance editor',exact:true}).click();
    const later = [event('pair-out','Break Out','2026-10-22T16:00:00Z',5),event('pair-back','Break In','2026-10-22T16:16:01Z',6),
      event('lunch-out','Lunch Break Out','2026-10-22T17:00:00Z',7),event('lunch-back','Lunch Break In','2026-10-22T18:01:00Z',8),event('checkout','Time Out','2026-10-22T18:30:00Z',9)];
    records.push(...later); revision+=later.length;
    for(const item of later) audit.push({commandId:item.commandId,operation:'action',actor:{role:'employee',code:person.employeeCode}});
    editor = await openEditor('2026-10-22');
    await editor.getByRole('button',{name:'Undo Break Out',exact:true}).click();
    await editor.getByLabel('Reason',{exact:true}).fill('Synthetic earlier paired rest undo');
    await editor.getByRole('button',{name:'Review change',exact:true}).click();
    await editor.getByText(/Unrelated newer actions stay unchanged/).waitFor();
    assert.deepEqual(previews.at(-1).changes,[{targetId:'pair-out',remove:true},{targetId:'pair-back',remove:true}]);
    if(i<2) await page.screenshot({path:`outputs/attendance-undo-browser/paired-${i?'mobile':'desktop'}.png`,fullPage:true});
    await editor.getByRole('button',{name:'Confirm change',exact:true}).click();
    await editor.getByText('Saved and synchronized.',{exact:true}).waitFor();
    assert.ok(records.some(item=>item.id==='checkout')&&records.some(item=>item.id==='lunch-back'));
    assert.ok(!records.some(item=>item.id==='pair-out'||item.id==='pair-back'));
    await editor.getByRole('button',{name:'Close attendance editor',exact:true}).click(); await page.reload();
    editor=await openEditor('2026-10-22');
    assert.equal(await editor.getByRole('button',{name:'Undo Break Out',exact:true}).count(),0);
    assert.equal(await editor.getByRole('button',{name:'Undo Time Out',exact:true}).count(),1);
    results.push({business,lastActionUndo:true,rowUndo:true,earlierPairUndo:true,newerActionsPreserved:true,refreshVerified:true,olderCheckoutProtected:true,viewport:page.viewportSize()}); await context.close();
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({origin,fixtureOnly:true,productionWrites:0,results,errors}));
} catch (error) {
  if (lastPage && !lastPage.isClosed()) { await lastPage.screenshot({path:'outputs/attendance-undo-browser/failure.png',fullPage:true}); console.error(JSON.stringify({url:lastPage.url(),errors,body:(await lastPage.locator('body').innerText()).slice(0,5000)})); }
  throw error;
} finally {await browser.close();await server.httpServer.close();}
