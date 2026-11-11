import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
function compile(relative,dependencies={}){
 const source=readFileSync(new URL(relative,import.meta.url),'utf8'),exports={};
 runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
  {exports,require:name=>{assert.ok(name in dependencies);return dependencies[name];}});
 return exports;
}
const validation=compile('../shared/payrollPaymentStatus.ts');
const {payrollSavedTableRows}=compile('../src/lib/payrollSavedDisplay.ts',{'../../shared/payrollPaymentStatus':validation});
const fixture=(extra={})=>({_id:'synthetic',employeeId:'synthetic-person',status:'Pending',paidOn:'-',payPeriod:'Oct 21, 2026 - Nov 5, 2026',
 grossPay:500,deductions:20,netPay:480,cutoffEstimate:true,savedAmounts:{grossPay:400,deductions:10,netPay:390},...extra});
const rows=records=>payrollSavedTableRows(records,'employeeId','asc');
test('Pending, Paid, unpaid and refreshed projections display identical saved net pay',()=>{
 const pending=fixture(),paid=fixture({status:'Paid',grossPay:400,deductions:10,netPay:390,cutoffEstimate:undefined,savedAmounts:undefined});
 const unpaid=fixture({grossPay:530,deductions:30,netPay:500});
 assert.deepEqual(Array.from(rows([pending,paid,unpaid]),row=>row.netPay),[390,390,390]);
});
test('a changing estimate never replaces stored payout values',()=>{
 const current=fixture(),next=fixture({grossPay:800,deductions:50,netPay:750});
 for(const key of ['grossPay','deductions','netPay'])assert.equal(rows([current])[0][key],rows([next])[0][key]);
});
test('saved zero net pay is not replaced by a positive estimate',()=>{
 assert.equal(rows([fixture({savedAmounts:{grossPay:400,deductions:400,netPay:0}})])[0].netPay,0);
});
test('unavailable earnings estimates do not hide a valid saved amount',()=>{
 const source=fixture({savedAmounts:undefined,earningsUnavailable:true}),value=rows([source])[0];
 assert.equal(value.netPay,480);assert.equal(value.earningsUnavailable,undefined);assert.equal(value.savedAmounts.netPay,480);
});
test('invalid saved amounts are not silently replaced by a valid estimate',()=>{
 for(const savedAmounts of [{grossPay:400,deductions:10,netPay:999},{grossPay:NaN,deductions:0,netPay:0},{grossPay:400,deductions:-1,netPay:401}]){
  assert.equal(rows([fixture({savedAmounts})])[0].earningsUnavailable,true);
 }
});
test('a projection without a verified saved snapshot is not presented as saved pay',()=>{
 assert.equal(rows([fixture({savedAmounts:undefined})])[0].earningsUnavailable,true);
});
test('source data and saved status, dates, identity and history are preserved',()=>{
 const source=fixture({requiresReview:true,calculationAudit:[{reason:'Synthetic'}]}),before=structuredClone(source),value=rows([source])[0];
 assert.deepEqual(source,before);for(const key of ['_id','employeeId','status','paidOn','payPeriod','requiresReview','calculationAudit'])assert.deepEqual(value[key],source[key]);
 assert.equal(source.netPay,480);assert.equal(value.netPay,390);
});
test('numeric sorting follows saved displayed values rather than estimates',()=>{
 const source=[fixture({_id:'a',netPay:1000,grossPay:1020,savedAmounts:{grossPay:200,deductions:0,netPay:200}}),fixture({_id:'b',netPay:100,grossPay:120,savedAmounts:{grossPay:300,deductions:0,netPay:300}})];
 assert.deepEqual(Array.from(payrollSavedTableRows(source,'netPay','asc'),row=>row._id),['a','b']);
 assert.deepEqual(Array.from(payrollSavedTableRows(source,'netPay','desc'),row=>row._id),['b','a']);
});
test('all seven business views use the same saved basis',()=>{
 for(let business=0;business<7;business++)assert.equal(rows([fixture({_id:'synthetic-business-'+business})])[0].netPay,390);
});
test('payroll page wires saved display before rendering, exports and payment actions',()=>{
 const page=readFileSync(new URL('../src/pages/admin/payroll/index.tsx',import.meta.url),'utf8');
 assert.ok(/payrollSavedTableRows\(payrollRecords, sortBy, sortDir\)/.test(page),'Table must use saved amounts before rendering.');
 assert.ok(page.includes('liveCutoffView ? "Net Pay" : "Saved Net Pay"'),'Only the current live cutoff can stop using the saved net label.');
 assert.ok(!/money\(employee\.netPay\).*<small/.test(page),'Saved net must not be captioned as an estimate.');
 assert.ok(/getPayrollDtr\(dtrRecord/.test(page),'DTR calculation read must remain unchanged.');
});

test('new current drafts display their live hours and money without substituting restored saved amounts',()=>{
 const source=fixture({payPeriod:'Nov 6, 2026 - Nov 20, 2026',currentCutoffDraft:true,workedHours:31.5,grossPay:500,deductions:20,netPay:480}),before=structuredClone(source),value=rows([source])[0];
 assert.equal(value.netPay,480);assert.equal(value.deductions,20);assert.equal(value.workedHours,31.5);assert.deepEqual(source,before);
});

test('an unavailable current calculation stays unavailable instead of appearing to be a valid saved draft',()=>{
 const value=rows([fixture({currentCutoffDraft:true,earningsUnavailable:true,earningsUnavailableReason:'Synthetic current attendance review'})])[0];
 assert.equal(value.earningsUnavailable,true);assert.equal(value.earningsUnavailableReason,'Synthetic current attendance review');
});
