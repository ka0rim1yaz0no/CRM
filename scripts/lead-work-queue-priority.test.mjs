import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { autoCallPhoneCandidates, shouldBlockCommentedPhone } from '../backend/src/services/leadAutoCallEligibility.ts';
import { compareCallingLeads } from '../shared/leadCallingPolicy.ts';
const now = Date.parse('2026-10-21T00:00:00Z');
class Clock extends Date { constructor(value) { super(value === undefined ? now : value); } static now() { return now; } }
test('due schedules outrank NEW; incidental activity never changes deterministic NEW order', () => {
    const rows = [
        { _id: 'new-b', status: 'NEW', createdAt: new Date(now), activity: [{ createdAt: new Date(now + 1000) }] },
        { _id: 'due', status: 'Follow up', followUpAt: new Date(now - 1) },
        { _id: 'new-a', status: 'NEW', createdAt: new Date(now) },
        { _id: 'follow-up', status: 'Follow up' },
    ];
    assert.deepEqual([...rows].sort((a, b) => compareCallingLeads(a, b, new Date(now))).map(row => row._id), ['due', 'new-a', 'new-b', 'follow-up']);
});

test('duplicate-comment lookup has a bounded query shape even for thousands of candidates', async () => {
    const file = 'backend/src/controllers/leadController.ts';
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const names = ['excludeCommentedPhoneCandidates', 'normalizePhoneDigits'];
    const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
        .map(node => node.getText(ast)).join('\n') + '\nexports.exclude = excludeCommentedPhoneCandidates;';
    const pipelines = [];
    const exports = {};
    const Lead = { find: () => { assert.fail('the queue still builds the old candidate-sized phone query'); }, aggregate: async pipeline => { pipelines.push(JSON.stringify(pipeline)); return [
        { phone: '+1 (202) 555-0122', latestCommentAt: new Date(now - 1000), hasInvalidComment: false },
        { phone: '2025550123', latestCommentAt: new Date(now - 1000), hasInvalidComment: true },
    ]; } };
    runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
        { exports, Date: Clock, Lead, autoCallPhoneCandidates, shouldBlockCommentedPhone, leadPhoneDedupEnabled: () => false,
            flexiblePhoneRegexes: value => autoCallPhoneCandidates(value).map(digits => new RegExp(digits)) });
    const small = [{ phone: '+1 (202) 555-0122' }, { phone: '2025550123' }, { phone: '2025550124' }];
    assert.deepEqual(Array.from(await exports.exclude(small, new Date(now))), [small[2]]);
    const large = [...small, ...Array.from({ length: 5000 }, (_, index) => ({ phone: `120255${String(index).padStart(5, '0')}` }))];
    await exports.exclude(large, new Date(now));
    assert.equal(pipelines.length, 2);
    assert.equal(pipelines[0], pipelines[1], 'the database query must not grow into thousands of phone regex clauses');
    assert.ok(pipelines[0].length < 2000);
});
