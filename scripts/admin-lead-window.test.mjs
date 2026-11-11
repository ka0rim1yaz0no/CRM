import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const pageFile = 'src/pages/admin/leads/index.tsx', page = fs.readFileSync(pageFile, 'utf8');
const ast = ts.createSourceFile(pageFile, page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const plain = value => JSON.parse(JSON.stringify(value));
function execute(text, scope = {}) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(text, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText,
        {exports, AbortController, ...scope}); return exports;
}
const {readAdminLeadWindow} = execute(fs.readFileSync('src/lib/adminLeadWindow.ts', 'utf8'));
function expression(name) {
    let found;
    const visit = node => {if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer; ts.forEachChild(node, visit);};
    visit(ast); assert.ok(found, name); return scope => execute('exports.value = ' + found.getText(ast), scope).value;
}
let queryFn;
const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useQuery' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const props = node.arguments[0].properties;
        if (props.some(prop => prop.name?.getText(ast) === 'queryKey' && prop.initializer?.getText(ast) === 'leadQueryKey'))
            queryFn = props.find(prop => prop.name?.getText(ast) === 'queryFn')?.initializer;
    }
    ts.forEachChild(node, visit);
}; visit(ast); assert.ok(queryFn);

test('background refresh preserves the loaded window instead of replacing it with twenty rows', async () => {
    const seen = [], controller = new AbortController();
    const read = async (params, signal) => {seen.push({params, signal}); return {page: params.windowEndPage, limit: 20, total: 100, hasMore: true,
        leads: Array.from({length: params.windowEndPage * 20}, (_, index) => ({_id: 'lead-' + index}))};};
    const make = current => execute('exports.value = ' + queryFn.getText(ast), {readAdminLeadWindow, getAdminLeads: read, leadQueryParams: {page: 1, limit: 20, city: 'Austin'},
        leadQueryIdentityRef: {current}, leadQueryIdentity: 'current-filter', leadPageRef: {current: 3}, leadQueryKey: ['admin-leads', 'fixture'],
        queryClient: {getQueryData: () => ({page: 3})}}).value;
    const result = await make('current-filter')({signal: controller.signal});
    assert.equal(result.leads.length, 60); assert.equal(result.page, 3); assert.equal(seen[0].params.windowEndPage, 3); assert.equal(seen[0].signal, controller.signal);
    assert.equal((await make('previous-filter')({signal: controller.signal})).leads.length, 20, 'new filters intentionally start at page one');
});

test('large refresh windows are bounded and aborted refreshes cannot publish partial pages', async () => {
    const seen = [];
    const result = await readAdminLeadWindow(async params => {seen.push(plain(params)); return {page: params.windowEndPage, total: 10020, limit: 20,
        hasMore: params.windowEndPage < 501, leads: [{_id: 'chunk-' + params.windowStartPage}]};}, {city: 'Austin'}, 501);
    assert.deepEqual(seen.map(row => [row.windowStartPage, row.windowEndPage]), [[1, 500], [501, 501]]); assert.equal(result.page, 501);
    const controller = new AbortController();
    await assert.rejects(readAdminLeadWindow(async () => {controller.abort(); return {leads: [], page: 1, hasMore: true};}, {}, 2, controller.signal), {name: 'AbortError'});
});

function selectionScope(overrides = {}) {
    const state = {ids: [], revisions: {}, snapshot: null, pending: false, requests: [], toasts: []};
    const scope = {isSelectingAllLeads: false, areAllFilteredLeadsSelected: false, bulkSelectionScope: 'filter-a', activeCategoryTab: 'Office',
        leadQueryParams: {city: 'Austin', state: 'TX', queue: 'Qualified', assignedAgent: 'fixture-employee', dateFrom: '2026-11-01'},
        assignmentContext: {businessId: 'fixture-business', adminSession: 'synthetic-admin-session'},
        selectionRequestRef: {current: null}, selectionScopeRef: {current: 'filter-a'}, assignmentScopeIsCurrent: () => true,
        setSelectedBulkLeadIds: value => {state.ids = value;}, setSelectedBulkLeadRevisions: value => {state.revisions = value;},
        setAllFilteredSelection: value => {state.snapshot = value;}, setIsSelectingAllLeads: value => {state.pending = value;},
        showToast: value => state.toasts.push(value), getRequestErrorMessage: (_error, fallback) => fallback,
        getAdminLeadSelection: async (params, context) => {state.requests.push({params, context}); const leadIds = Array.from({length: 120}, (_, index) => 'fixture-' + index);
            return {leadIds, total: leadIds.length, assignmentRevisions: Object.fromEntries(leadIds.map((id, index) => [id, index]))};}, ...overrides};
    return {state, scope};
}
test('Select All snapshots every filtered ID and assignment revision, including unloaded leads', async () => {
    const {state, scope} = selectionScope(); await expression('toggleAllFilteredLeads')(scope)();
    assert.equal(state.ids.length, 120); assert.equal(state.revisions['fixture-119'], 119); assert.equal(state.snapshot.total, 120); assert.equal(state.pending, false);
    assert.deepEqual(plain(state.requests[0].params), {...scope.leadQueryParams, category: 'Office'});
    assert.equal(state.requests[0].context.businessId, scope.assignmentContext.businessId); assert.equal(state.requests[0].context.adminSession, scope.assignmentContext.adminSession);
    assert.equal(state.requests[0].context.signal.aborted, false); assert.equal(state.toasts.length, 1);
    assert.equal(state.toasts[0].tone, 'success'); assert.match(state.toasts[0].message, /120/);
});
test('Clear selection clears unloaded IDs, and stale filter or business results cannot select leads', async () => {
    const cleared = selectionScope({areAllFilteredLeadsSelected: true});
    cleared.scope.clearBulkLeadSelection = expression('clearBulkLeadSelection')(cleared.scope);
    await expression('toggleAllFilteredLeads')(cleared.scope)();
    assert.deepEqual(plain(cleared.state.ids), []); assert.equal(cleared.state.snapshot, null); assert.equal(cleared.state.requests.length, 0);
    for (const changed of ['filter', 'business']) {
        let release; const pending = new Promise(resolve => {release = resolve;});
        const current = selectionScope({getAdminLeadSelection: () => pending});
        const operation = expression('toggleAllFilteredLeads')(current.scope)();
        if (changed === 'filter') current.scope.selectionScopeRef.current = 'another-filter';
        else current.scope.assignmentScopeIsCurrent = () => false;
        // The evaluated closure captured the original function; use a mutable scope signal for business changes instead.
        if (changed === 'business') current.scope.selectionRequestRef.current.abort();
        release({leadIds: ['foreign'], total: 1, assignmentRevisions: {foreign: 0}}); await operation;
        assert.equal(current.state.ids.length, 0); assert.equal(current.state.snapshot, null);
    }
    assert.match(page, /input\.leadIds\.map\(id => \[id, selectedBulkLeadRevisions\[id\]/);
    assert.doesNotMatch(page.slice(page.indexOf('const invalidateLeads'), page.indexOf('const [previousLeadRoute')), /leadPageRef\.current = 1/);
});

test('visible Cancel releases a pending selection immediately and rejects its late result', async () => {
    let finish;
    const pending = new Promise(resolve => {finish = resolve;});
    const current = selectionScope({getAdminLeadSelection: () => pending});
    const operation = expression('toggleAllFilteredLeads')(current.scope)();
    const controller = current.scope.selectionRequestRef.current;
    assert.equal(current.state.pending, true);
    expression('clearBulkLeadSelection')(current.scope)();
    assert.equal(controller.signal.aborted, true); assert.equal(current.state.pending, false);
    finish({leadIds: ['late'], total: 1, assignmentRevisions: {late: 0}}); await operation;
    assert.deepEqual(plain(current.state.ids), []); assert.deepEqual(plain(current.state.toasts), []);
});
