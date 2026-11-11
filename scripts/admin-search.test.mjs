import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {parsePhoneNumberFromString} from 'libphonenumber-js';
const header = 'src/pages/admin/adminLayout/index.tsx';
const palette = 'src/components/DashboardWorkspace.tsx';
const phoneDigits = '12025550123';
const formattedPhone = '+1 202-555-0123';
const parenthesizedPhone = '+1 (202) 555-0123';
function module(file, imports = {}) {
    const exports = {};
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
    vm.runInNewContext(source, {exports, require: name => imports[name] || {}}); return exports;
}
const helpers = module('shared/workspaceSearch.ts');
const {normalizeLeadPhone} = module('shared/leadPhonePolicy.ts', {'libphonenumber-js': {
    parsePhoneNumberFromString: (value, options) => parsePhoneNumberFromString(value, JSON.parse(JSON.stringify(options))),
}});
function expression(file, name, property) {
    const text = fs.readFileSync(file, 'utf8'), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let found;
    const visit = node => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) {
            found = property ? node.initializer.arguments[0].properties.find(item => item.name?.getText(ast) === property)?.initializer
                : ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
        }
        ts.forEachChild(node, visit);
    };
    visit(ast); assert.ok(found, name);
    return scope => {
        const exports = {};
        vm.runInNewContext(ts.transpileModule('exports.value = ' + found.getText(ast), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText,
            {exports, ...helpers, normalizeLeadPhone, debouncedAdminSearch: scope.normalizedAdminSearch, ...scope}); return exports.value;
    };
}
test('phone punctuation and name separators compare equally without rewriting stored values', () => {
    for (const query of [phoneDigits, parenthesizedPhone, '1 202 555 0123']) {
        assert.equal(helpers.sameFormattedSearchValue(formattedPhone, query), true);
    }
    for (const query of ['AnneMarieONeil', 'Anne Marie O’Neil', 'ANNE-MARIE O.NEIL']) {
        assert.equal(helpers.sameFormattedSearchValue("Anne-Marie O'Neil", query), true);
    }
    assert.equal(helpers.sameFormattedSearchValue('12025550124', phoneDigits), false);
    for (const input of ['', ' ', '()+-', '.*', '\\']) assert.equal(helpers.sameFormattedSearchValue('', input), false);
    assert.equal(helpers.includesFormattedSearchValue('Anne-Marie', 'anne mar'), true);
});
test('bounded name patterns match punctuation, Unicode names and word boundaries, never regex injection', () => {
    for (const [query, value] of [['AnneMarieONeil', "Anne-Marie O'Neil"], ['O’Neil', "O'Neil"], ['ABServices', 'A&B (Services)'], ['王 小明', '王-小明']]) {
        assert.equal(helpers.formattingInsensitiveNameRegex(query).test(value), true);
    }
    assert.equal(helpers.formattingInsensitiveNameRegex('Ann').test('Joanne'), false);
    assert.equal(helpers.formattingInsensitiveNameRegex('a.*b').test('alphabet'), false);
    assert.equal(helpers.formattingInsensitiveNameRegex('.*'), null);
    assert.equal(helpers.formattingInsensitiveNameRegex('a'.repeat(257)), null);
});
test('the actual header keeps formatted phone/name matches and retains literal email matching', () => {
    const lead = {_id: 'fixture', businessName: 'Synthetic Business', leadName: "Anne-Marie O'Neil", phone: formattedPhone, email: 'a.b@example.test'};
    for (const normalizedAdminSearch of [phoneDigits, '2025550123', '(202) 555-0123', 'AnneMarieONeil']) {
        const result = expression(header, 'matchingLeads')({normalizedAdminSearch, adminLeadSearchData: {leads: [lead]}})();
        assert.equal(result.length, 1); assert.equal(result[0].phone, lead.phone);
    }
    assert.equal(expression(header, 'matchingLeads')({normalizedAdminSearch: 'ab@example.test', adminLeadSearchData: {leads: [lead]}})().length, 0);
    const employee = {name: "Anne-Marie O'Neil", employeeCode: 'SYN-001', email: 'employee@example.test'};
    assert.equal(expression(header, 'matchingEmployees')({normalizedAdminSearch: 'AnneMarieONeil', evaluationEmployees: [employee]})().length, 1);
});
const baselineSource = process.env.CRM_ADMIN_SEARCH_BASELINE_SOURCE;
test('the optional historical header reproduces the original formatting bug', {skip: baselineSource ? false : 'no historical source supplied'}, () => {
    const old = path.join(baselineSource, header);
    const lead = {_id: 'fixture', businessName: 'Synthetic', phone: formattedPhone};
    assert.equal(expression(old, 'matchingLeads')({normalizedAdminSearch: phoneDigits, adminLeadSearchData: {leads: [lead]}})().length, 0);
});
test('Enter opens one normalized match but never stale or ambiguous results', () => {
    for (const kind of ['unique', 'ambiguous', 'stale']) {
        let opened = false; const routes = [];
        const leads = [{_id: 'one', phone: formattedPhone}, ...(kind === 'ambiguous' ? [{_id: 'two', phone: parenthesizedPhone}] : [])];
        const submit = expression(header, 'submitAdminSearch')({adminSearch: phoneDigits, normalizedAdminSearch: phoneDigits,
            isAdminLeadSearchFetching: kind === 'stale', matchingEmployees: [], matchingLeads: leads,
            setIsAdminSearchOpen: value => {opened = value;}, setAdminSearch() {}, setDebouncedAdminSearch() {},
            navigate: value => routes.push(value), roleWorkspacePath: value => value, authUser: {userType: 'admin'}});
        submit({preventDefault() {}});
        assert.equal(routes.length, kind === 'unique' ? 1 : 0);
        if (kind !== 'unique') assert.equal(opened, true);
    }
});
test('admin search query keys and adapters keep captured business/session scope', async () => {
    let request;
    const read = expression(header, '{ data: adminLeadSearchData, isFetching: isAdminLeadSearchFetching }', 'queryFn')({
        adminSearchBusinessId: 'fixture-a', normalizedAdminSearch: phoneDigits, authUser: {userType: 'admin', sessionToken: 'fixture-signed'},
        getAdminLeads: async (...args) => {request = args;},
    });
    await read(); assert.equal(request[1].businessId, 'fixture-a'); assert.equal(request[1].adminSession, 'fixture-signed');
    const text = fs.readFileSync(header, 'utf8');
    assert.match(text, /\["admin-header-lead-search", adminSearchBusinessId, normalizedAdminSearch\]/);
    const adapters = module('src/api/leads.ts', {'../lib/api': {api: {get: async (...args) => {request = args; return {data: []};}}}});
    await adapters.getLeads({search: phoneDigits}, {businessId: 'fixture-b', adminSession: 'fixture-other-signed'});
    assert.equal(request[1].headers['X-Business-Id'], 'fixture-b'); assert.equal(request[1].headers['X-CRM-Admin-Session'], 'fixture-other-signed');
    await adapters.getLeads(); assert.deepEqual(JSON.parse(JSON.stringify(request[1].headers)), {});
});
test('workspace palette uses normalized employee matching and preserves the stored phone display', () => {
    const source = fs.readFileSync(palette, 'utf8');
    assert.match(source, /includesFormattedSearchValue\(value, search\)/);
    assert.match(source, /businessId: controls\.business/);
    assert.match(source, /\{lead\.phone\}/);
});
