import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';
import ts from 'typescript';

const baseline = process.env.CRM_DEADLINE_BASELINE_SOURCE;
const file = 'backend/src/controllers/leadController.ts';
const before = baseline ? await fs.readFile(path.join(baseline, file), 'utf8') : null;
const after = await fs.readFile(file, 'utf8');
function readers(source, rows = [], onYield = () => {}) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const names = new Set(['usStateAliases', 'usStateCodes', 'usStateNamePatterns', 'usStateNamesByCode',
        'normalizeLeadValue', 'escapeRegex', 'normalizeLeadState', 'extractLeadStateFromAddress', 'getLeadStateOptions']);
    const statements = tree.statements.filter(node => ts.isFunctionDeclaration(node) ? names.has(node.name?.text) :
        ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.has(item.name.getText(tree))));
    const code = ts.transpileModule(statements.map(node => node.getText(tree)).join('\n') +
        '\nexports.read=extractLeadStateFromAddress;exports.options=getLeadStateOptions;exports.states=usStateAliases;',
    {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
    const exports = {};
    runInNewContext(code, {exports, Lead: {find() {return {select() {return this;}, lean() {return this;},
        async limit(value) {assert.equal(value, 20000); return rows.slice(0, value).map(businessAddress => ({businessAddress}));}};}},
        yieldToEventLoop: async () => {onYield(); await yieldToEventLoop();}});
    return exports;
}

test('compiled state patterns retain exact legacy parsing for names, abbreviations, malformed and unknown addresses', () => {
    const old = before ? readers(before) : null, next = readers(after);
    const samples = [
        ...['', null, undefined, 0, 'Synthetic address', '123 Unknown Road', 'xTexasx'].map(value => [value, '']),
        ['NYC, new york', 'NY'], ['West Virginia', 'WV'], ['North Carolina', 'NC'], ['CA 90210-1234, USA', 'CA'],
        ['New York, NY', 'NY'], ['west virginia washington', 'VA'], ['unknown new   york', 'NY'],
    ];
    const states = Object.entries(old?.states ?? next.states);
    assert.equal(new Set(states.map(([, code]) => code)).size, 50);
    for (const [name, code] of states) {
        for (const value of [name, name.toUpperCase(), code, code.toLowerCase(),
            `123 First Street, City, ${code} 12345, USA`, `123 First Street, ${name} 12345`, `City, ${name}, USA`]) samples.push([value, code]);
        samples.push([`123 First Street ${name} 12345`, code === 'WV' ? 'VA' : code]);
    }
    for (const [value, expected] of samples) {
        assert.equal(next.read(value), expected, String(value));
        if (old) assert.equal(old.read(value), expected, String(value));
    }
});

test('20,000-row state totals and sorting are identical and deadline callbacks get event-loop turns during the read', async () => {
    const seeds = ['123 Unknown Road', '123 First Street, CA 90210', 'City, New York', 'City, west virginia', 'CA 90210-1234, USA'];
    const rows = Array.from({length: 24000}, (_, index) => seeds[index % seeds.length]);
    let yields = 0, finished = false, deadlineBeforeCompletion = false;
    const next = readers(after, rows, () => {yields++;});
    const expected = [
        {code: 'CA', name: 'California', count: 8000},
        {code: 'NY', name: 'New York', count: 4000},
        {code: 'WV', name: 'West Virginia', count: 4000},
    ];
    if (before) assert.deepEqual(JSON.parse(JSON.stringify(await readers(before, rows).options({}))), expected);
    const pending = next.options({}).then(result => {finished = true; return result;});
    const deadline = yieldToEventLoop().then(() => {deadlineBeforeCompletion = !finished;});
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), expected); await deadline;
    assert.ok(yields >= 150); assert.equal(deadlineBeforeCompletion, true);
});

async function sortReader() {
    const file = 'backend/src/services/employeeCallingQueue.ts', source = await fs.readFile(file, 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const statements = tree.statements.filter(node => ts.isFunctionDeclaration(node) ? node.name?.text === 'sortCallingCandidates' :
        ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(tree) === 'pendingReadSort'));
    assert.equal(statements.length, 2);
    const code = ts.transpileModule(statements.map(node => node.getText(tree)).join('\n') + '\nexports.sort=sortCallingCandidates;',
        {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
    const exports = {}; runInNewContext(code, {exports, yieldToEventLoop}); return exports.sort;
}

test('20 queued read sorts retain native sorting and allow deadline I/O between jobs', async () => {
    const sort = await sortReader(), order = [], seen = new Set(); let ioBeforeSecond = false;
    await Promise.all(Array.from({length: 20}, async (_, index) => {
        const rows = [{value: 3}, {value: 1}, {value: 2}];
        await sort(rows, (first, second) => {
            if (!seen.has(index)) {seen.add(index); order.push(index);
                if (!index) void yieldToEventLoop().then(() => {ioBeforeSecond = order.length === 1;});
            }
            return first.value - second.value;
        });
        assert.deepEqual(rows.map(row => row.value), [1, 2, 3]);
    }));
    assert.deepEqual(order, Array.from({length: 20}, (_, index) => index)); assert.equal(ioBeforeSecond, true);
});

test('one failed read sort cannot strand later queue refreshes', async () => {
    const sort = await sortReader();
    await assert.rejects(sort([2, 1], () => {throw Error('SYNTHETIC_SORT_FAILURE');}), /SYNTHETIC_SORT_FAILURE/);
    const next = [3, 2, 1]; await sort(next, (first, second) => first - second); assert.deepEqual(next, [1, 2, 3]);
});
