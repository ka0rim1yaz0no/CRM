import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { applyLeadPageChange, isLeadWorkspaceQuery, latestLead, synchronizeLeadWorkspace } from '../src/lib/leadWorkspaceCache.ts';
import { refreshAttendanceWorkspace } from '../src/lib/employeeWorkspaceCache.ts';
import fs from 'node:fs/promises';

const lead = (id, status = 'NEW', updatedAt = '2026-10-23T00:00:00Z') => ({ _id: id, status, updatedAt, assignmentRevision: 1 });
const page = (leads, tab = 'my') => ({ leads, tab, total: leads.length, page: 1, limit: 50, hasMore: false,
    callingQueue: { version: 'server-version', nextLeadId: leads[0]?._id, nextLead: leads[0], nextDecision: { callable: true }, nextReason: 'NEW',
        entries: leads.map(item => ({ leadId: item._id, callable: true, reason: 'NEW' })) } });

test('confirmed Dead and other final statuses leave active queues immediately, never choose a replacement in the browser', () => {
    for (const status of ['Dead','Archived','Qualified','Completed','Ongoing Negotiation']) {
        const current = page([lead('first'),lead('second')]);
        const next = applyLeadPageChange(current,{lead:lead('first',status,'2026-10-23T00:01:00Z')});
        assert.deepEqual(next.leads.map(item => item._id),['second']);
        assert.equal(next.total,1); assert.equal(next.callingQueue.nextLeadId,null);
        assert.equal(next.callingQueue.nextLead,null); assert.equal(next.callingQueue.version,'');
        assert.equal(next.callingQueue.waitReason,'REFRESHING_QUEUE'); assert.equal(current.leads.length,2);
        assert.equal(applyLeadPageChange(page([lead('first')],'dead'),{lead:lead('first','Dead')}).leads[0].status,'Dead');
    }
});

test('a stale socket event cannot restore a newer saved status or assignment', () => {
    const saved = lead('first','Dead','2026-10-23T00:02:00Z');
    assert.equal(latestLead(saved,lead('first')),saved);
    const assigned = {...lead('first'),assignmentRevision:3};
    assert.equal(latestLead(assigned,{...lead('first'),assignmentRevision:2,updatedAt:'2026-10-24T00:00:00Z'}),assigned);
    assert.equal(applyLeadPageChange(page([saved],'dead'),{lead:lead('first')}).leads[0].status,'Dead');
});

test('six businesses keep updates, detail caches and counts scoped; obsolete reads cannot reinsert Dead leads', async () => {
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    try {
        for (let i=0;i<6;i++) {
            const business = `synthetic-${i}`, key = ['calling-queue',business,'employee'];
            client.setQueryData(key,page([lead('first'),lead('second')]));
            client.setQueryData(['leads','employee','names','my','NEW','','',false,'ALL',business],page([lead('first')]));
            client.setQueryData(['admin-leads',business,'leads'],page([lead('first')],'leads'));
        }
        for (let i=0;i<6;i++) {
            const business = `synthetic-${i}`, key = ['calling-queue',business,'employee'];
            let finish;
            const stale = client.fetchQuery({queryKey:key,queryFn:()=>new Promise(resolve=>{finish=resolve;})}).catch(()=>undefined);
            await synchronizeLeadWorkspace(client,business,{lead:lead('first','Dead','2026-10-23T00:01:00Z')},{businessId:business,employeeId:'employee',belongsHere:true});
            finish(page([lead('first')])); await stale;
            assert.deepEqual(client.getQueryData(key).leads.map(item=>item._id),['second']);
            assert.equal(client.getQueryData(['lead',business,'first']).status,'Dead');
            assert.equal(client.getQueryData(['admin-leads',business,'leads']).leads[0].status,'NEW','employee updates do not copy employee-scoped data into admin caches');
            if(i<5) assert.equal(client.getQueryData(['calling-queue',`synthetic-${i+1}`,'employee']).leads[0].status,'NEW');
        }
    } finally {client.clear();}
});

test('reassignment/deletion remove rows without silently inserting leads into filtered pages', () => {
    assert.equal(applyLeadPageChange(page([lead('first')]),{lead:lead('first')},false).leads.length,0);
    assert.equal(applyLeadPageChange(page([lead('first')]),{leadIds:['first']}).leads.length,0);
    assert.equal(applyLeadPageChange(page([lead('first')]),{lead:lead('another')}).leads.length,1);
    assert.equal(isLeadWorkspaceQuery(['calling-queue','a','employee'],'b','employee'),false);
    assert.equal(isLeadWorkspaceQuery(['leads','other','a'],'a','employee'),false);
    assert.equal(isLeadWorkspaceQuery(['admin-leads','a'],'a'),true);
});

test('attendance saves invalidate deductions and both dashboard presentations, without copying tenant payloads',async()=>{
    const keys=[]; await refreshAttendanceWorkspace({invalidateQueries:({queryKey})=>{keys.push(queryKey[0]);return Promise.resolve();}});
    for(const key of ['attendance-session','attendance-hub','payroll','payroll-dtr','admin-call-dashboard','admin-dashboard-attendance-records','agent-lead-dashboard']) assert.ok(keys.includes(key),key);
});

test('WhatsApp is removed from both lead screens, not from unrelated team tools',async()=>{
    for(const name of ['src/pages/leads/index.tsx','src/pages/admin/leads/index.tsx']) assert.doesNotMatch(await fs.readFile(name,'utf8'),/FaWhatsapp|wa\.me|WhatsApp lead/);
});
