import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import {runInNewContext} from 'node:vm';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import ts from 'typescript';
const require=createRequire(import.meta.url),read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8'),compile=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,shared={};
for(const file of ['payrollPresentation','payrollEarnings','payrollSavedRates']){const exports={};runInNewContext(compile(read('shared/'+file+'.ts')),{exports});Object.assign(shared,exports);}
const display={};runInNewContext(compile(read('src/lib/payrollDeductionPresentation.ts')),{exports:display,require:()=>shared});
const fixture=()=>({employeeName:'Synthetic payroll review',employeeId:'synthetic-only',department:'Synthetic',payType:'Semi-monthly',payPeriod:'Oct 21, 2026 - Nov 5, 2026',paidOn:'Nov 10, 2026',status:'Pending',
 calculationVersion:'earned-minute-capped-v1',basicPay:15000,monthlyBasicPay:30000,grossPay:14347.83,deductions:5.43,netPay:14342.40,minuteRate:30000/23/8/60,hourlyRate:30000/23/8,paidHoursPerDay:8,workingDays:23,attendanceDays:11,absentDays:1,workedHours:88-2/60,scheduledHours:96,
 lateMinutes:0,earlyTimeOutMinutes:0,absenceMinutes:480,excessBreakMinutes:2,excessLunchMinutes:0,nonBillableOffPhoneMinutes:0,deductibleMinutes:2,incompleteShiftDays:0,overtimeHours:0,overtimeApproved:false});
test('screenshot regression: Total Deductions is the actual 5.43 while earned gross and net remain unchanged',()=>{
 const value=fixture(),before=JSON.stringify(value),total=display.payrollDeductionDisplayTotal(value);assert.equal(total,5.43);assert.equal(shared.payrollDeductionDisplayRows(value).find(row=>row.label==='Absence').informationalAmount,1304.35);assert.equal(Math.round((value.grossPay-total)*100),Math.round(value.netPay*100));assert.equal(JSON.stringify(value),before);
});
test('actual charged categories are included once and informational amounts do not increase the total',()=>{
 const value={...fixture(),lateMinutes:3,earlyTimeOutMinutes:7,absenceMinutes:480,excessBreakMinutes:2,excessLunchMinutes:5,nonBillableOffPhoneMinutes:11,deductions:48.91};
 const rows=shared.payrollDeductionDisplayRows(value),charged=rows.reduce((sum,row)=>sum+Math.round((row.amount??0)*100),0);assert.equal(new Set(rows.map(row=>row.label)).size,rows.length);assert.equal(display.payrollDeductionDisplayTotal(value),48.91);assert.equal(charged,4891);assert.ok(rows.some(row=>row.informationalAmount>0));
});
test('Pending, Paid and Completed statements show the same recorded net without mutating any financial field',()=>{
 for(const status of ['Pending','Paid','Completed']){const value={...fixture(),status},before=JSON.stringify(value);for(let refresh=0;refresh<2;refresh++){assert.equal(display.payrollDeductionDisplayTotal(value),5.43);assert.equal(value.netPay,14342.40);}assert.equal(JSON.stringify(value),before);}
});
test('fixed salary and saved cash-only rows retain their totals without adding an excluded-time adjustment',()=>{
 for(const deductions of [0,0.01,5.43,15000]){const value={...fixture(),calculationVersion:'fixed-half-month-salary-v1',deductions};assert.equal(display.payrollDeductionDisplayTotal(value),deductions);}
});
test('actual deductions do not depend on reference rates and invalid saved money never invents a total',()=>{
 for(const changes of [{minuteRate:null,hourlyRate:null},{absenceMinutes:1.5}])assert.equal(display.payrollDeductionDisplayTotal({...fixture(),...changes}),5.43);
 for(const deductions of [NaN,Infinity,-1,null,Number.MAX_SAFE_INTEGER])assert.equal(display.payrollDeductionDisplayTotal({...fixture(),deductions}),null);
 assert.equal(Object.is(display.payrollDeductionDisplayTotal({...fixture(),deductions:-0}),0),true);
});
function extract(file,names,exportCode){const content=read(file),ast=ts.createSourceFile(file,content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),selected=new Set(names),nodes=ast.statements.filter(node=>node.name&&selected.has(node.name.text)||ts.isVariableStatement(node)&&node.declarationList.declarations.some(item=>selected.has(item.name.getText(ast)))),exports={};runInNewContext(compile(nodes.map(node=>node.getText(ast)).join('\n')+'\n'+exportCode),{require,exports,...shared,...display});return exports;}
const payslip=extract('src/pages/admin/payroll/index.tsx',['numberWordsUnderTwenty','numberWordsTens','monthNames','numberToWords','formatHoursMinutes','formatDays','countWeekdays','clampCalendarDay','workingDaysForPayPeriod','PayslipDocument','payslipAmountInWords','payslipDeductionRows'],'exports.document=PayslipDocument;');
const profile=extract('src/components/EmployeePayments.tsx',['PaymentDetails','calendarDate','quantity'],'exports.document=PaymentDetails;'),money=value=>'PHP '+value.toFixed(2);
test('actual payslip renders actual deductions only without extra rows or changing earned net',()=>{
 const value=fixture(),before=JSON.stringify(value),html=renderToStaticMarkup(React.createElement(payslip.document,{record:value,money}));for(const text of ['PHP 1304.35','PHP 5.43','PHP 14347.83','PHP 14342.40','Already excluded from earned pay'])assert.ok(html.includes(text),text);for(const text of ['PHP 1309.78','Cutoff salary limit','Already reflected in earned gross','Additional cash deductions','Net pay reconciliation'])assert.ok(!html.includes(text),text);assert.equal(JSON.stringify(value),before);
 assert.match(html,/Total Deductions<\/td><td[^>]*>PHP 5\.43<\/td>/);assert.ok(!html.includes('Applied to net pay'));
});
test('actual Profile Payments shows actual deductions and unchanged net across seven synthetic business views',()=>{
 for(let business=0;business<7;business++){const value=fixture(),before=JSON.stringify(value),html=renderToStaticMarkup(React.createElement(profile.document,{item:value,money}));for(const text of ['PHP 1304.35','PHP 5.43','PHP 14342.40','Already excluded from earned pay'])assert.ok(html.includes(text),text);for(const text of ['PHP 1309.78','Cutoff salary limit','Already reflected in earned gross','Additional cash deductions','Net pay reconciliation'])assert.ok(!html.includes(text),text);assert.match(html,/<dt>Total deductions<\/dt><dd>PHP 5\.43<\/dd>/);assert.equal(JSON.stringify(value),before);}
});
test('DTR, payroll computation and payslip header all use the same display-only helper',()=>{
 for(const file of ['src/pages/admin/payroll/index.tsx','src/components/EmployeePayments.tsx','src/pages/admin/payrollCompute/index.tsx']){const text=read(file);assert.ok(text.includes('lib/payrollDeductionPresentation'));for(const label of ['Already reflected in earned gross','Additional cash deductions','Net pay reconciliation','Cutoff salary limit'])assert.ok(!text.includes(label),label);}
 assert.ok(!/api\.|\.post\(|\.put\(|\.patch\(|fetch\(/.test(read('src/lib/payrollDeductionPresentation.ts')));
});
test('collapsed Profile summary keeps its existing labels and uses the complete display-only total',()=>{
 const text=read('src/components/EmployeePayments.tsx');assert.ok(text.includes('<small>Deductions</small>'));assert.ok(text.includes('const total = payrollDeductionDisplayTotal(item)'));assert.ok(text.includes('<dt>Total deductions</dt>'));assert.ok(!text.includes('Cash deductions'));
});
test('all calculation versions show the actual recorded deduction, not informational reference values',()=>{
 for(const calculationVersion of [undefined,'duration-payroll-v1','earned-hours-v1','earned-hours-late-rest-v1','earned-hours-all-deductions-v1','fixed-half-month-salary-v1','earned-minute-capped-v1']){const value={...fixture(),calculationVersion},before=JSON.stringify(value);assert.equal(display.payrollDeductionDisplayTotal(value),5.43);assert.equal(JSON.stringify(value),before);}
});
test('zero earned pay with informational absence retains zero actual deductions and net',()=>{
 const value={...fixture(),grossPay:0,deductions:0,netPay:0,absenceMinutes:5760,absentDays:12,workedHours:0};const before=JSON.stringify(value);assert.equal(display.payrollDeductionDisplayTotal(value),0);for(const [document,props] of [[payslip.document,{record:value,money}],[profile.document,{item:value,money}]]){const html=renderToStaticMarkup(React.createElement(document,props));assert.ok(html.includes('PHP 0.00'));assert.ok(!html.includes('Already reflected in earned gross'));}assert.equal(JSON.stringify(value),before);
});
