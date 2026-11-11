import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const apiFile = 'src/api/leads.ts', apiSource = fs.readFileSync(apiFile, 'utf8');
const apiAst = ts.createSourceFile(apiFile, apiSource, ts.ScriptTarget.Latest, true);
const helperFile = 'src/lib/adminLeadRead.ts';
const helperSource = fs.existsSync(helperFile) ? fs.readFileSync(helperFile, 'utf8') : '';

function fixture(mode) {
    const exports = {}, timers = new Map(), requests = []; let nextTimer = 0, finish;
    const window = {
        setTimeout(callback, ms) {const id = ++nextTimer; timers.set(id, {callback, ms}); return id;},
        clearTimeout(id) {timers.delete(id);},
    };
    const scope = {exports, window, AbortController, DOMException, assignmentHeaders: value => ({
        'X-Business-Id': value.businessId, 'X-CRM-Admin-Session': value.adminSession,
    }), api: {get(url, options) {
        requests.push({url, options});
        if (mode === 'hang') return new Promise(resolve => {finish = resolve;});
        if (mode === 'error') return Promise.reject(new Error('Synthetic read failed'));
        return Promise.resolve({data: {leadIds: ['synthetic'], total: 1, assignmentRevisions: {synthetic: 0}, leads: []}});
    }}};
    const functions = apiAst.statements.filter(node => ts.isFunctionDeclaration(node) &&
        ['getAdminLeads', 'getAdminLeadSelection'].includes(node.name?.text)).map(node => node.getText(apiAst)).join('\n');
    const code = ts.transpileModule(helperSource + '\n' + functions, {
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
    }).outputText;
    vm.runInNewContext(code, scope);
    return {exports, timers, requests, finish: value => finish?.(value)};
}

for (const name of ['getAdminLeads', 'getAdminLeadSelection']) {
    test(`${name} cannot stay busy forever when its transport never settles`, async () => {
        const f = fixture('hang');
        const operation = f.exports[name]({city: 'Austin'}, {businessId: 'fixture-business', adminSession: 'fixture-session'});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.requests.length, 1);
        assert.equal(f.timers.size, 1, 'admin read needs a hard deadline as well as a transport timeout');
        const rejection = assert.rejects(operation, error => error.code === 'ADMIN_LEAD_READ_TIMEOUT');
        const timer = [...f.timers.values()][0]; assert.equal(timer.ms, 15000); timer.callback();
        await rejection;
        assert.equal(f.requests[0].options.signal.aborted, true);
        assert.equal(f.requests[0].options.timeout, 15000);
        assert.equal(f.timers.size, 0);
        f.finish({data: {leadIds: ['late-result']}});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.requests.length, 1, 'a timeout must not retry or issue writes');
    });

    test(`${name} honors cancellation even when transport ignores abort`, async () => {
        const f = fixture('hang'), controller = new AbortController();
        const operation = f.exports[name]({}, {signal: controller.signal});
        await new Promise(resolve => setImmediate(resolve));
        const rejection = assert.rejects(operation, {name: 'AbortError'});
        controller.abort(); await rejection;
        assert.equal(f.timers.size, 0); assert.equal(f.requests[0].options.signal.aborted, true);
        const stopped = fixture('ok');
        await assert.rejects(stopped.exports[name]({}, {signal: controller.signal}), {name: 'AbortError'});
        assert.equal(stopped.requests.length, 0);
    });

    test(`${name} clears deadlines on success and ordinary read errors`, async () => {
        const f = fixture('ok');
        await f.exports[name]({city: 'Austin'}, {businessId: 'fixture-business', adminSession: 'fixture-session'});
        assert.equal(f.timers.size, 0); assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].options.headers['X-Business-Id'], 'fixture-business');
        assert.equal(f.requests[0].options.headers['X-CRM-Admin-Session'], 'fixture-session');
        const bad = fixture('error'); await assert.rejects(bad.exports[name]({}), /Synthetic read failed/);
        assert.equal(bad.timers.size, 0); assert.equal(bad.requests.length, 1);
    });
}

test('selection feedback stays visible outside the popup, with an accessible cancel/clear action', () => {
    const source = fs.readFileSync('src/pages/admin/leads/index.tsx', 'utf8');
    assert.match(source, /data-testid="admin-lead-selection-state"/);
    const start = source.indexOf('data-testid="admin-lead-selection-state"');
    const feedback = source.slice(start, source.indexOf('className="grid gap-2.5', start));
    assert.match(feedback, /role="status"/); assert.match(feedback, /aria-live="polite"/);
    assert.match(feedback, /Selecting leads/); assert.match(feedback, /selectedBulkCount\.toLocaleString\(\)/);
    assert.match(feedback, /Cancel lead selection/); assert.match(feedback, /Clear lead selection/);
    assert.match(source, /message: `Selected \$\{ids\.length\.toLocaleString\(\)\} leads\.`/);
    assert.doesNotMatch(source, /const isBulkSelected = selectedBulkLeadIds\.includes/);
});

function assignmentFeedback(result, assignedAgent='synthetic-target', current=true) {
    const file='src/pages/admin/leads/index.tsx',source=fs.readFileSync(file,'utf8');
    const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    let callback;
    const visit=node=>{
        if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='bulkAssignLeadsMutation'){
            const options=node.initializer.arguments[0];
            callback=options.properties.find(property=>property.name?.getText(ast)==='onSuccess').initializer;
        }
        ts.forEachChild(node,visit);
    };visit(ast);assert.ok(callback);
    const exports={},events=[],selection={cleared:false};
    const code=ts.transpileModule('exports.success='+callback.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
    vm.runInNewContext(code,{exports,assignmentScopeIsCurrent:()=>current,invalidateLeads:()=>events.push({type:'invalidate'}),
        setSelectedBulkLeadIds:ids=>{selection.cleared=ids.length===0;},setIsBulkAssignMenuOpen:()=>{},showToast:value=>events.push({type:'toast',...value})});
    exports.success(result,{assignedAgent,assignedAgentName:'Synthetic recipient'});
    return{toast:events.find(event=>event.type==='toast'),selection,events};
}

test('reassigning already-correct filtered leads reports a no-op without a refresh/retry error or losing selection',()=>{
    const result=assignmentFeedback({assignedCount:0,updatedRecordCount:0,conflictCount:0,unchangedCount:93,unchangedRecordCount:93,matchedCount:93,missingCount:0});
    assert.equal(result.toast.tone,'info');assert.match(result.toast.message,/already assigned/i);
    assert.doesNotMatch(result.toast.message,/refresh|try again/i);assert.equal(result.selection.cleared,false);
});

test('already-unassigned leads report their actual state instead of pretending a save failed',()=>{
    const result=assignmentFeedback({assignedCount:0,updatedRecordCount:0,conflictCount:0,unchangedCount:1,matchedCount:1,missingCount:0},'UNASSIGNED');
    assert.match(result.toast.message,/already unassigned/i);assert.equal(result.selection.cleared,false);
});

test('mixed assignment results count only changed groups and report unchanged and unavailable selections',()=>{
    const result=assignmentFeedback({assignedCount:2,updatedRecordCount:3,conflictCount:0,unchangedCount:4,matchedCount:6,missingCount:1});
    assert.match(result.toast.message,/Assigned 2 leads/);assert.match(result.toast.message,/4.*already/i);
    assert.match(result.toast.message,/1.*unavailable|1.*no longer/i);assert.equal(result.selection.cleared,true);
});

test('a stale selection is refreshed without claiming that absent leads are already assigned',()=>{
    const result=assignmentFeedback({assignedCount:0,updatedRecordCount:0,conflictCount:0,unchangedCount:0,matchedCount:0,missingCount:3});
    assert.match(result.toast.message,/no matching|no longer available|unavailable/i);
    assert.doesNotMatch(result.toast.message,/already assigned/i);assert.equal(result.selection.cleared,true);
    const obsolete=assignmentFeedback({assignedCount:2},'synthetic-target',false);
    assert.equal(obsolete.toast,undefined);assert.equal(obsolete.selection.cleared,false);
});
