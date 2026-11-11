import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/pages/admin/leads/index.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('admin.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(node) {
    if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), node.initializer);
    ts.forEachChild(node, visit);
}
visit(ast);
function evaluate(name, scope, hook = false) {
    const node = declarations.get(name); assert.ok(node, name);
    const value = hook ? node.arguments[0] : node;
    const result = {};
    runInNewContext(ts.transpileModule('result.value = ' + value.getText(ast) + ';', {
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
    }).outputText, {result, ...scope});
    return result.value;
}

test('the Leads filter includes every requested status and uses the same filter in its server query', () => {
    const filters = evaluate('allStatusFilters', {});
    for (const status of ['NEW', 'Follow up', 'Qualified', 'Ongoing Negotiation', 'Completed', 'Dead']) {
        assert.ok(filters.includes(status));
        const query = evaluate('leadQueryParams', {activeTab: 'NEW', leadQueueFilter: status, allStatusFilter: 'ALL', LEAD_PAGE_SIZE: 20,
            getAdminLeadApiTab: () => 'leads', usesLeadQueueFilter: () => true, debouncedLeadSearch: 'synthetic',
            effectiveDateFromFilter: '', effectiveDateToFilter: '', leadStateFilter: 'TX', leadCityFilter: 'Austin', assignedAgentFilter: 'ALL', selectedAgentName: ''}, true)();
        assert.equal(query.queue, status); assert.equal(query.tab, 'leads'); assert.equal(query.state, 'TX'); assert.equal(query.city, 'Austin');
    }
    assert.match(source, /activeTab === "NEW" \? allStatusFilters/);
    assert.match(source, /filter === "Dead" \? "Archive\/Dead"/);
});

test('Qualified exposes the active bulk menu and selection while Archived keeps its separate actions', () => {
    const rows = [{_id: 'qualified', status: 'Qualified'}, {_id: 'archived', status: 'Archived'}];
    const enabled = evaluate('canUseActiveBulkActions', {activeTab: 'Qualified'}); assert.equal(enabled, true);
    const selectable = evaluate('selectableLeadIds', {activeTab: 'Qualified', canUseActiveBulkActions: enabled, filteredLeads: rows}, true)();
    assert.deepEqual(Array.from(selectable), ['qualified']);
    assert.equal(evaluate('canUseActiveBulkActions', {activeTab: 'Archived'}), false);
    assert.match(source, /canUseActiveBulkActions \|\| activeTab === "Archived"/);
    assert.match(source, /const isBulkSelectable =\s*\(canUseActiveBulkActions &&/);
    assert.match(source, /aria-expanded=\{isBulkMenuOpen\}/);
    const inputText = declarations.get('bulkLeadSelectionInputs').getText(ast);
    for (const filter of ['leadQueueFilter', 'allStatusFilter', 'leadStateFilter', 'leadCityFilter', 'effectiveDateFromFilter', 'effectiveDateToFilter']) assert.ok(inputText.includes(filter));
    assert.ok(declarations.get('leadQueryKey').getText(ast).includes('leadCityFilter'));
    assert.match(source, /<option value="ALL">All City<\/option>/);
});

test('admin active Leads cache keeps final statuses but employee calling queues do not', async () => {
    const {applyLeadPageChange} = await import('../src/lib/leadWorkspaceCache.ts');
    for (const status of ['Qualified', 'Ongoing Negotiation', 'Completed', 'Dead']) {
        const page = {tab: 'leads', total: 1, leads: [{_id: 'test', status: 'NEW'}]};
        assert.equal(applyLeadPageChange(page, {lead: {_id: 'test', status}}).leads[0].status, status);
        assert.equal(applyLeadPageChange({...page, tab: 'my'}, {lead: {_id: 'test', status}}).leads.length, 0);
    }
});

test('bulk actions retain the captured admin business and session in their request headers', async () => {
    const text = readFileSync(new URL('../src/api/leads.ts', import.meta.url), 'utf8');
    const apiAst = ts.createSourceFile('leads.ts', text, ts.ScriptTarget.Latest, true);
    const names = ['assignmentHeaders', 'bulkArchiveLeads', 'bulkRestoreLeads', 'bulkPermanentlyDeleteArchivedLeads', 'bulkPermanentlyDeleteActiveLeads'];
    const nodes = apiAst.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
    const compiled = ts.transpileModule(nodes.map(node => node.getText(apiAst)).join('\n'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
    const exports = {}, requests = [];
    const api = {patch: async (route, body, options) => {requests.push({route, body, options});return {data: {}};},
        delete: async (route, options) => {requests.push({route, options});return {data: {}};}};
    runInNewContext(compiled, {exports, api});
    for (const name of names.slice(1)) await exports[name](['synthetic-lead'], {businessId: 'synthetic-business', adminSession: 'synthetic-session'});
    assert.equal(requests.length, 4);
    for (const row of requests) {
        assert.equal(row.options.headers['X-Business-Id'], 'synthetic-business');
        assert.equal(row.options.headers['X-CRM-Admin-Session'], 'synthetic-session');
    }
});
