import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const presentation={},earnings={};
for(const[name,exports]of [['payrollPresentation',presentation],['payrollEarnings',earnings]])runInNewContext(ts.transpileModule(read('shared/'+name+'.ts'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports});
test('earned-minute current payroll is recognized without changing historical calculation versions',()=>{
 assert.equal(earnings.isEarnedPayrollVersion('earned-minute-capped-v1'),true);assert.equal(earnings.isFixedHalfSalaryVersion('earned-minute-capped-v1'),false);assert.equal(earnings.isFixedHalfSalaryVersion('fixed-half-month-salary-v1'),true);
});
test('current deduction totals reconcile to cash deductions, with unearned time clearly separate',()=>{
 const record={calculationVersion:'earned-minute-capped-v1',minuteRate:1,deductions:7,lateMinutes:10,earlyTimeOutMinutes:30,absenceMinutes:480,excessBreakMinutes:1,excessLunchMinutes:1,nonBillableOffPhoneMinutes:5};
 assert.equal(presentation.payrollDeductionDisplayTotal(record),7);assert.equal(presentation.payrollDeductionRows(record).reduce((sum,row)=>sum+row.amount,0),7);
 for(const label of ['Late','Undertime','Absence']){const row=presentation.payrollDeductionDisplayRows(record).find(item=>item.label===label);assert.equal(row.amount,null);assert.equal(row.note,'Already excluded from earned pay');}
});
test('DTR uses the payment basis and presents restored attendance calculations in a separate read-only section',()=>{
 const page=read('src/pages/admin/payroll/index.tsx');assert.ok(page.includes('dtrRecord?.payPeriod, "payment"'));assert.ok(page.includes('basis: "payment" }'));
 assert.ok(page.includes('aria-label="Saved cutoff attendance comparison"'));assert.ok(page.includes('Saved cutoff</th>'));assert.ok(page.includes('Attendance calculation</th>'));assert.ok(page.includes('Restored amounts and payment status are unchanged.'));
 assert.ok(page.includes('query.state.data?.summary.currentCutoffDraft ? 30_000 : false'));assert.ok(page.includes('refetchIntervalInBackground: false'));
 const comparison=page.slice(page.indexOf('aria-label="Saved cutoff attendance comparison"'),page.indexOf('aria-label="Attendance comparison unavailable"'));assert.ok(!/<button|onClick=|mutate\(/.test(comparison));
});
