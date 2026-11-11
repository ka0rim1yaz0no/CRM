import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import ts from 'typescript';
const load=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8'),modules={};
for(const[name,file]of [['period','shared/payrollPeriod.ts'],['presentation','src/lib/payrollDtrPresentation.ts']]){
 const exports={};runInNewContext(ts.transpileModule(load(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:()=>modules.period});modules[name]=exports;
}
const fixture=()=>({storedCutoff:true,payPeriod:'Oct 21, 2026 - Nov 5, 2026',summary:{workedHours:8,grossPay:1000,deductions:1,netPay:999},
 attendanceComparison:{asOf:'2026-11-11T00:00:00Z',referenceOnly:true,basis:'dated-earned-minutes',fromDate:'2026-10-21',toDate:'2026-11-05',
  summary:{calculationVersion:'earned-minute-capped-v1',workedHours:7,earnedGrossHours:8,grossPay:800,deductions:100,netPay:700,deductibleMinutes:60}},rows:[]});
test('dated historical detail uses actual hours and deductions but never replaces saved payment amounts',()=>{
 const dtr=fixture(),before=JSON.stringify(dtr),shown=modules.presentation.payrollDtrPresentation(dtr);assert.equal(shown.datedReference,true);assert.equal(shown.summary,dtr.attendanceComparison.summary);assert.equal(shown.paymentSummary,dtr.summary);assert.equal(shown.paymentSummary.netPay,999);assert.equal(JSON.stringify(dtr),before);
});
test('current and other historical cutoffs retain their existing basis and cannot inherit the dated preview',()=>{
 for(const period of ['Nov 6, 2026 - Nov 20, 2026','Oct 6, 2026 - Oct 20, 2026']){const dtr=fixture();dtr.payPeriod=period;const shown=modules.presentation.payrollDtrPresentation(dtr);assert.equal(shown.datedReference,false);assert.equal(shown.summary,dtr.summary);}
});
test('missing, mismatched or invalid reference evidence never silently changes DTR totals',()=>{
 for(const change of [dtr=>delete dtr.attendanceComparison,dtr=>delete dtr.attendanceComparison.referenceOnly,dtr=>dtr.attendanceComparison.toDate='2026-11-06',dtr=>dtr.attendanceComparison.summary.netPay=NaN,dtr=>dtr.attendanceComparison.summary.calculationVersion='fixed-half-month-salary-v1',dtr=>dtr.storedCutoff=false]){const dtr=fixture();change(dtr);assert.equal(Boolean(modules.presentation.payrollDtrPresentation(dtr).datedReference),false);assert.equal(modules.presentation.payrollDtrPresentation(dtr).summary,dtr.summary);}
});
test('admin DTR uses dated detail while payment, payslip and the saved comparison still use saved amounts',()=>{
 const page=load('src/pages/admin/payroll/index.tsx');assert.ok(page.includes('payrollDtrPresentation(employeeDtr)'));assert.ok(page.includes('payrollDeductionDisplayRows(dtrBreakdown.summary)'));assert.ok(page.includes('money(dtrBreakdown.paymentSummary.netPay)'));assert.ok(page.includes('basis: "payment"'));assert.ok(page.includes('Saved cutoff</th>'));assert.ok(page.includes('Restored amounts and payment status are unchanged.'));
 const comparison=page.slice(page.indexOf('aria-label="Saved cutoff attendance comparison"'),page.indexOf('aria-label="Attendance comparison unavailable"'));assert.ok(!/<button|onClick=|mutate\(/.test(comparison));
});
