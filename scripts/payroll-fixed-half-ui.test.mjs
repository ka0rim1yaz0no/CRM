import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

const require=createRequire(import.meta.url),read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const transpile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const shared={};
for(const name of ['payrollPresentation','payrollEarnings','payrollSavedRates']){
 const exported={};runInNewContext(transpile(read('shared/'+name+'.ts')),{exports:exported});Object.assign(shared,exported);
}
const display={};runInNewContext(transpile(read('src/lib/payrollDeductionPresentation.ts')),{exports:display,require:()=>shared});Object.assign(shared,display);
function extract(file,names,exportCode){
 const source=read(file),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),selected=new Set(names);
 const declarations=ast.statements.filter(node=>node.name&&selected.has(node.name.text)||ts.isVariableStatement(node)&&node.declarationList.declarations.some(item=>selected.has(item.name.getText(ast))));
 const exports={};runInNewContext(transpile(declarations.map(node=>node.getText(ast)).join('\n')+'\n'+exportCode),{require,exports,...shared});return exports;
}
const payments=extract('src/components/EmployeePayments.tsx',['PaymentDetails','calendarDate','quantity'],'exports.details=PaymentDetails;');
const payslip=extract('src/pages/admin/payroll/index.tsx',['numberWordsUnderTwenty','numberWordsTens','monthNames','numberToWords','formatHoursMinutes','formatDays',
 'countWeekdays','clampCalendarDay','workingDaysForPayPeriod','PayslipDocument','payslipAmountInWords','payslipDeductionRows'],'exports.document=PayslipDocument;');
const value={employeeName:'Synthetic Payroll',employeeId:'synthetic-fixed',department:'Synthetic',status:'Pending',payType:'Semi-monthly',
 payPeriod:'Oct 21, 2026 - Nov 5, 2026',paidOn:null,scheduledPayDate:null,calculationVersion:'fixed-half-month-salary-v1',cutoffEstimate:true,
 earningsAsOf:'2026-11-10T02:00:00Z',basicPay:500,monthlyBasicPay:1000,grossPay:500,deductions:10,netPay:490,hourlyRate:1000/23/8,
 minuteRate:1000/23/8/60,paidHoursPerDay:8,workingDays:23,scheduledHours:96,workedHours:95,lateMinutes:5,earlyTimeOutMinutes:10,
 absenceMinutes:0,excessBreakMinutes:2,excessLunchMinutes:3,nonBillableOffPhoneMinutes:5,attendanceDays:12,absentDays:0,overtimeHours:0,deductibleMinutes:25,incompleteShiftDays:0};
const money=number=>'PHP '+number.toFixed(2);
test('Profile Payments renders the same fixed base, one deduction total and unchanged net as the server',()=>{
 const before=JSON.stringify(value),html=renderToStaticMarkup(React.createElement(payments.details,{item:value,money}));
 for(const text of ['Basic pay (cutoff)','PHP 500.00','Total deductions','PHP 10.00','PHP 490.00','Estimated cutoff net pay'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('Applied to net pay'));assert.ok(!html.includes('Additional earnings'));assert.equal(JSON.stringify(value),before);
});
test('fixed-half payslips remain provisional while estimates, with no overtime or duplicate applied-deduction row',()=>{
 const before=JSON.stringify(value),html=renderToStaticMarkup(React.createElement(payslip.document,{record:value,money}));
 for(const text of ['Provisional Payslip','Estimated as of','PHP 500.00','PHP 10.00','PHP 490.00','Undertime (10 min)'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('Applied to net pay'));assert.equal(JSON.stringify(value),before);
 const saved={...value,cutoffEstimate:undefined,status:'Paid'};const frozen=renderToStaticMarkup(React.createElement(payslip.document,{record:saved,money}));
 assert.ok(!frozen.includes('Provisional Payslip'));assert.ok(frozen.includes('PHP 490.00'));
});
test('all fixed-half displayed deductions are actual charges, and cents reconcile even when net is capped at zero',()=>{
 for(const deductions of [0,0.01,10,500])for(const workedMinutesOverride of [null,96*60-25]){
  const record={...value,deductions,workedMinutesOverride},before=JSON.stringify(record),rows=shared.payrollDeductionDisplayRows(record);
  assert.ok(rows.every(row=>row.amount!==null));assert.ok(rows.every(row=>!/coaching/i.test(row.label)));
  assert.equal(rows.reduce((sum,row)=>sum+Math.round(row.amount*100),0),Math.round(deductions*100));
  assert.equal(shared.payrollDeductionDisplayTotal(record),deductions);assert.equal(JSON.stringify(record),before);
 }
});
test('admin saved payment rows refresh while estimate flags still block overtime approval',()=>{
 const source=read('src/pages/admin/payroll/index.tsx');
 assert.match(source,/refetchInterval: activeTab === "Employee Payroll" \? 30_000 : false/);
 assert.match(source,/refetchIntervalInBackground: false/);
 assert.match(source,/cutoffEstimate: payslipDtr\.summary\.cutoffEstimate/);
 assert.match(source,/employeeDtr && !employeeDtr\.summary\.cutoffEstimate/);
 assert.match(source,/if \(employeeDtr\.summary\.cutoffEstimate\) return/);
});
