import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await fs.readFile('src/lib/payrollFormatting.ts', 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { formatPayrollHours } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

test('payroll hours hide floating-point noise without modifying the saved value', () => {
    const hours = 87.64999999999999;
    assert.equal(formatPayrollHours(hours), '87.65h');
    assert.equal(hours, 87.64999999999999);
    assert.equal(formatPayrollHours(8), '8h');
    assert.equal(formatPayrollHours(0.01), '0.01h');
    assert.equal(formatPayrollHours(0), '0h');
});

test('missing hours retain zero while invalid values are not presented as valid hours', () => {
    assert.equal(formatPayrollHours(null), '0h');
    assert.equal(formatPayrollHours(undefined), '0h');
    for (const value of [NaN, Infinity, -Infinity]) assert.equal(formatPayrollHours(value), '--');
});
