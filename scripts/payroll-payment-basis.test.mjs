import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../src/api/payroll.ts',import.meta.url),'utf8'),exports={},requests=[];
runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
 {exports,require:name=>{assert.equal(name,'../lib/api');return {api:{get:async(url,options)=>{requests.push({url,options});return{data:[]};}}};}});
test('saved payroll requests bind their business and cancellation signal explicitly',async()=>{
 requests.length=0;const controller=new AbortController();
 for(const businessId of ['synthetic-a','synthetic-b']){
  await exports.getPayrollRecords({payPeriod:'synthetic-period',basis:'saved'},{businessId,signal:controller.signal});
  await exports.getPayrollStats('synthetic-period',{businessId,signal:controller.signal,basis:'saved'});
  for(const request of requests.slice(-2)){assert.equal(request.options.headers['X-Business-Id'],businessId);assert.equal(request.options.signal,controller.signal);assert.equal(request.options.params.basis,'saved');}
 }
 controller.abort();assert.ok(requests.every(request=>request.options.signal.aborted));
});
test('saved payslip reads and DTR estimates are distinct request bases',async()=>{
 requests.length=0;
 for(const basis of ['saved','estimate','payment']){await exports.getPayrollDtr('synthetic-employee','synthetic-period',{businessId:'synthetic-business',basis});const request=requests.at(-1);
  assert.equal(request.options.params.basis,basis);assert.equal(request.options.headers['X-Business-Id'],'synthetic-business');}
});
test('business currency settings and cutoff requests retain explicit business identity',async()=>{
 const settingsExports={},seen=[],settingsSource=readFileSync(new URL('../src/api/systemSettings.ts',import.meta.url),'utf8');
 runInNewContext(ts.transpileModule(settingsSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
  {exports:settingsExports,require:name=>{if(name==='./authStorage')return {getAuthUser:()=>null};assert.equal(name,'../lib/api');return {api:{get:async(url,options)=>{seen.push({url,options});return{data:{currencyCode:'PHP'}};}}};}});
 const signal=new AbortController().signal;
 await settingsExports.getSystemSettings({businessId:'synthetic-company',signal});
 assert.equal(seen[0].options.headers['X-Business-Id'],'synthetic-company');assert.equal(seen[0].options.signal,signal);
 await exports.getPayrollCutoffs({businessId:'synthetic-company',signal});assert.equal(requests.at(-1).options.headers['X-Business-Id'],'synthetic-company');
});
test('business switches cannot reuse another business payslip or DTR query key',()=>{
 const page=readFileSync(new URL('../src/pages/admin/payroll/index.tsx',import.meta.url),'utf8');
 for(const key of ['payroll-dtr','payroll-payslip-dtr'])assert.ok(page.includes('queryKey: ["'+key+'", businessId,'),key+' must include business identity');
 assert.ok(page.includes('basis: accuracyConfig?.enabled ? "payment" : undefined'),'Payslip output must follow current-draft versus restored saved payment policy.');
 assert.ok(page.includes('getPayrollRecords(recordQueryParams, { businessId, signal })'),'Row reads must bind the requested business.');
 assert.ok(page.includes('refetchOnMount: "always"'),'Returning to a business must refetch status.');
 assert.ok(/setPaymentTarget\(\{[^\n]*record: employee, businessId \}\)/.test(page),'Payment actions must retain the displayed row business, not borrow a later global selection.');
 assert.ok(page.includes('title={!accuracyConfig ? "Loading payment settings"'),'Payment actions must wait for their settings.');
 assert.ok(page.includes('queryKey: ["system-settings", businessId]'),'Currency and cutoff settings must belong to the selected business.');
 assert.ok(page.includes('getPayrollCutoffs({ businessId, signal })'),'Cutoff reads must bind the selected business.');
});
