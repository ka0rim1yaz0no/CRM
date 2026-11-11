import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {QueryClient} from '@tanstack/react-query';

const file = 'src/pages/leads/index.tsx', text = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function execute(source, scope = {}) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText,
        {exports, AbortController, ...scope}); return exports;
}
function expression(name) {
    let result;
    const visit = node => {if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) result = node.initializer; ts.forEachChild(node, visit);};
    visit(ast); assert.ok(result, name); return scope => execute('exports.value = ' + result.getText(ast), scope).value;
}
let queryFn;
const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useQuery' && ts.isObjectLiteralExpression(node.arguments[0])) {
        const properties = node.arguments[0].properties;
        if (properties.some(prop => prop.name?.getText(ast) === 'queryKey' && prop.initializer?.getText(ast) === 'leadQueryKey'))
            queryFn = properties.find(prop => prop.name?.getText(ast) === 'queryFn')?.initializer;
    }
    ts.forEachChild(node, visit);
}; visit(ast); assert.ok(queryFn);
const helperFile = 'src/lib/employeeLeadWindow.ts';
const readEmployeeLeadWindow = fs.existsSync(helperFile) ? execute(fs.readFileSync(helperFile, 'utf8')).readEmployeeLeadWindow : null;
const rows = count => Array.from({length: count}, (_, i) => ({_id: 'synthetic-' + i, status: 'NEW'}));
const page = (count, number = 1) => ({leads: rows(count), page: number, limit: 50, total: 240, hasMore: true, nextPage: number + 1, tab: 'my'});
const callingQueueKey = ({businessId, employeeId}) => ['calling-queue', businessId, employeeId];

test('loaded employee pages survive refresh instead of being replaced by the first calling page', async () => {
    const client = new QueryClient(), key = ['leads', 'synthetic-person', 'my', 'synthetic-business'];
    client.setQueryData(key, page(150, 3));
    const signal = new AbortController().signal, seen = [];
    const read = async params => {seen.push(params); return page((params.windowEndPage || 1) * 50, params.windowEndPage || 1);};
    const scope = {queryClient: client, leadQueryKey: key, isDefaultCallingView: true, isEmployeeLeadWorkspaceView: true,
        readLeadPages: (pages, signal) => readEmployeeLeadWindow(read, {workspaceView: true}, pages, signal),
        fetchCallingQueue: async () => page(50), callingScope: {}, authUser: {}, getMyLeads: read,
        employeeId: 'synthetic-person', employeeLeadNames: [], requestedEmployeeLeadTab: 'my', LEAD_PAGE_SIZE: 50,
        effectiveLeadSearch: '', isGlobalLeadSearchActive: false, leadStateFilter: 'ALL', displayedBusinessId: 'synthetic-business'};
    const readQuery = execute('exports.value = ' + queryFn.getText(ast), scope).value;
    const result = await readQuery({signal});
    assert.equal(result.leads.length, 150, 'refresh must retain all three loaded employee pages');
    assert.equal(result.page, 3); assert.equal(seen[0].windowEndPage, 3); client.clear();
});

test('employee browsing uses a separate scoped cache from the authoritative automatic queue', () => {
    const make = (business, employee = 'synthetic-person') => expression('leadQueryKey')({useMemo: fn => fn(), employeeId: employee,
        employeeLeadNames: ['Synthetic'], requestedEmployeeLeadTab: 'my', activeTab: 'NEW', effectiveLeadSearch: '',
        isGlobalLeadSearchActive: false, leadStateFilter: 'ALL', displayedBusinessId: business, isDefaultCallingView: true, callingQueueKey});
    const first = make('synthetic-a'), second = make('synthetic-b');
    assert.equal(first[0], 'leads'); assert.equal(first.at(-1), 'synthetic-a');
    assert.notDeepEqual(first, callingQueueKey({employeeId: 'synthetic-person', businessId: 'synthetic-a'}));
    assert.notDeepEqual(first, second); assert.notDeepEqual(first, make('synthetic-a', 'another-person'));
    const client = new QueryClient(); client.setQueryData(first, page(150, 3));
    client.setQueryData(callingQueueKey({employeeId: 'synthetic-person', businessId: 'synthetic-a'}), page(50));
    assert.equal(client.getQueryData(first).leads.length, 150); client.clear();
});

test('window reads are bounded, preserve filters and remove stale rows instead of merging old results forever', async () => {
    assert.ok(readEmployeeLeadWindow);
    const seen = [], signal = new AbortController().signal;
    const result = await readEmployeeLeadWindow(async (params, usedSignal) => {
        seen.push({params, usedSignal}); return {...page(1, params.windowEndPage), leads: [{_id: 'chunk-' + params.windowStartPage}]};
    }, {employeeId: 'synthetic-person', search: 'Synthetic', state: 'TX', limit: 50, workspaceView: true}, 21, signal);
    assert.deepEqual(seen.map(row => [row.params.windowStartPage, row.params.windowEndPage]), [[1, 20], [21, 21]]);
    assert.equal(seen[0].params.state, 'TX'); assert.equal(seen[0].params.search, 'Synthetic'); assert.equal(seen[0].usedSignal, signal);
    assert.deepEqual(Array.from(result.leads, row => row._id), ['chunk-1', 'chunk-21']);
    const removed = await readEmployeeLeadWindow(async () => ({...page(1), leads: [{_id: 'fresh-only'}], hasMore: false}), {}, 3);
    assert.deepEqual(Array.from(removed.leads, row => row._id), ['fresh-only']);
});

test('aborted or failed window reads never publish partial data', async () => {
    assert.ok(readEmployeeLeadWindow);
    const controller = new AbortController();
    await assert.rejects(readEmployeeLeadWindow(async () => {controller.abort(); return page(50);}, {}, 3, controller.signal), {name: 'AbortError'});
    let reads = 0;
    await assert.rejects(readEmployeeLeadWindow(async () => {if (++reads === 2) throw Error('synthetic network failure'); return page(50);}, {}, 21), /synthetic network failure/);
});

test('a new filter intentionally starts at page one and paging refreshes are registered for cancellation', async () => {
    const client = new QueryClient(), key = ['leads', 'synthetic-person', 'new-filter', 'synthetic-business'], pages = [];
    const read = execute('exports.value = ' + queryFn.getText(ast), {queryClient: client, leadQueryKey: key,
        isEmployeeLeadWorkspaceView: true, readLeadPages: async number => {pages.push(number); return page(50, number);}}).value;
    await read({signal: new AbortController().signal}); assert.deepEqual(pages, [1]);
    const more = expression('fetchMoreLeads')({useCallback: fn => fn, employeeId: 'synthetic-person', displayedBusinessId: 'synthetic-business',
        leadPagingScope: JSON.stringify(key), leadPagingScopeRef: {current: JSON.stringify(key)}, leadFetchInFlightRef: {current: false},
        leadFetchRetryAtRef: {current: 0}, hasMoreLeads: true, queryClient: client, leadQueryKey: key, isEmployeeLeadWorkspaceView: true,
        getActiveBusinessId: () => 'synthetic-business', readLeadPages: async number => {pages.push(number); return page(number * 50, number);},
        setIsFetchingMoreLeads() {}, leadPageRef: {current: 1}, setLeadPage() {}, setHasMoreLeads() {}, showToast() {},
        performance, employeeLeadNames: [], requestedEmployeeLeadTab: 'my', effectiveLeadSearch: '', isGlobalLeadSearchActive: false,
        leadStateFilter: 'ALL', isDefaultCallingView: false, isCancelledError: () => false});
    client.setQueryData(key, page(50));
    assert.equal(await more(), true); assert.equal(client.getQueryData(key).page, 2); assert.equal(client.getQueryData(key).leads.length, 100);
    client.clear();
});
