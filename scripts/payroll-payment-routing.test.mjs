import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import ts from 'typescript';
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const source=readFileSync(new URL('../src/api/payrollPayment.ts',import.meta.url),'utf8'),periods={};
runInNewContext(compile(readFileSync(new URL('../shared/payrollPeriod.ts',import.meta.url),'utf8')),{exports:periods});
const businesses=Array.from({length:6},(_,i)=>'synthetic-'+i),period='Oct 21, 2026 - Nov 5, 2026';
function fixture(view=businesses[3],owner=businesses[0]){
 let business=view,auth={userType:'admin',sessionToken:'synthetic-admin-session',user:{employeeCode:'synthetic-admin'},allowedBusinesses:businesses.map(id=>({id,name:id}))};
 const records=new Map(businesses.map(id=>[id,[{_id:'record-'+id,employeeId:'synthetic-employee',payPeriod:period,payrollOwnerBusinessId:owner,grossPay:1000,deductions:20,netPay:980,status:'Pending'}]])),calls=[],exports={};
 let hook=()=>{},canApply=true,warnings=[],responseOverride=value=>value;
 const api={async get(url,config){calls.push({method:'get',url,config});await hook('get',config);return{data:records.get(config.headers['X-Business-Id'])};},
  async post(url,body,config){calls.push({method:'post',url,body,config});await hook(url.endsWith('/preview')?'preview':'confirm',config);if(url.endsWith('/confirm'))return{data:{applied:true}};
   const id=url.split('/')[3],rows=businesses.map(id=>({businessId:id,businessName:id,grossPay:1000,deductions:20,netPay:980,status:'Pending',paidOn:'-',savedCopies:1,currentAttendanceReviewDays:0}));
   return{data:responseOverride({id,payPeriod:period,paid:body.paid,paidOn:'Oct 28, 2026',token:'synthetic-preview',businessIds:businesses,canApply,blockers:canApply?[]:['Synthetic financial conflict'],warnings,rows})};}};
 const modules={'../lib/api':{api},'./authStorage':{getAuthUser:()=>auth},'./businessStorage':{getActiveBusinessId:()=>business},'../../shared/payrollPeriod':periods};
 runInNewContext(compile(source),{exports,require:name=>{assert.ok(modules[name],name);return modules[name];}});
 return{prepare:(record=structuredClone(records.get(view)[0]))=>exports.preparePayrollPayment(record,true,view),records,calls,auth:()=>auth,
  setAuth:value=>auth=value,setBusiness:value=>business=value,onRequest:fn=>hook=fn,setCanApply:value=>canApply=value,setWarnings:value=>warnings=value,override:fn=>responseOverride=fn};
}
test('all six views resolve the matching owner ID without switching the visible business or writing a preview',async()=>{
 for(const view of businesses){const f=fixture(view),before=JSON.stringify([...f.records]),context=await f.prepare();
  assert.equal(context.preview.id,'record-'+businesses[0]);assert.equal(context.paymentBusinessId,businesses[0]);assert.equal(context.paymentBusinessName,businesses[0]);assert.equal(context.isCurrent(),true);
  assert.equal(f.calls.filter(call=>call.method==='get').length,view===businesses[0]?1:2);assert.equal(f.calls.at(-1).url,'/payroll/records/record-'+businesses[0]+'/payment-status/preview');
  for(const call of f.calls){assert.equal(call.config.headers['X-CRM-Admin-Session'],'synthetic-admin-session');assert.equal(call.config.headers['X-CRM-Attendance-Session'],'');assert.equal(call.config.headers['Cache-Control'],'no-store');}
  assert.equal(JSON.stringify([...f.records]),before);
 }
});

test('earned projections compare saved amounts across all six businesses despite live earnings advancing',async()=>{
 for(const view of businesses){
  const f=fixture(view),shown=structuredClone(f.records.get(view)[0]);
  for(const rows of f.records.values())for(const row of rows){
   row.earnedToDate=true;row.savedAmounts={grossPay:1000,deductions:20,netPay:980};
   row.grossPay=600;row.deductions=100;row.netPay=500;
  }
  Object.assign(shown,{earnedToDate:true,savedAmounts:{grossPay:1000,deductions:20,netPay:980},grossPay:590,deductions:100,netPay:490});
  f.onRequest(stage=>{if(stage==='get')for(const rows of f.records.values())for(const row of rows){row.grossPay++;row.netPay++;}});
  f.setCanApply(false);
  const before=JSON.stringify([...f.records]),context=await f.prepare(shown);
  assert.equal(context.paymentBusinessId,businesses[0]);assert.equal(context.preview.rows.find(row=>row.businessId===view).netPay,980);
  assert.equal(context.preview.canApply,false);assert.deepEqual(Array.from(context.preview.blockers),['Synthetic financial conflict']);
  await assert.rejects(context.confirm('Synthetic reason',true));
  assert.ok(!f.calls.some(call=>call.url.endsWith('/confirm')));
  assert.notEqual(JSON.stringify([...f.records]),before);
 }
});

test('missing, invalid, changed or raced saved amounts remain blocked for earned projections',async()=>{
 for(const view of businesses)for(const change of [
  f=>{delete f.records.get(view)[0].savedAmounts;},
  f=>{f.records.get(view)[0].savedAmounts.netPay=NaN;},
  f=>{f.records.get(view)[0].savedAmounts.deductions=-1;},
  f=>{f.records.get(view)[0].savedAmounts.netPay=979;},
  f=>{f.records.get(businesses[0])[0].savedAmounts.netPay=979;},
  f=>{f.override(p=>({...p,rows:p.rows.map(row=>row.businessId===view?{...row,netPay:979}:row)}));},
 ]){
  const f=fixture(view);
  for(const rows of f.records.values())for(const row of rows)Object.assign(row,{earnedToDate:true,
   savedAmounts:{grossPay:1000,deductions:20,netPay:980},grossPay:600,deductions:100,netPay:500});
  const shown=structuredClone(f.records.get(view)[0]);change(f);
  await assert.rejects(f.prepare(shown));assert.ok(!f.calls.some(call=>call.url.endsWith('/confirm')));
 }
});

test('legacy and paid views do not trust unrelated savedAmounts metadata',async()=>{
 for(const earnedToDate of [undefined,false]){
  const f=fixture(),shown=structuredClone(f.records.get(businesses[3])[0]);
  Object.assign(shown,{earnedToDate,savedAmounts:{grossPay:1000,deductions:20,netPay:980},netPay:979});
  await assert.rejects(f.prepare(shown),/changed/);assert.equal(f.calls.filter(call=>call.method==='post').length,0);
 }
});
test('explicit confirmation uses the owner ID, owner tenant and pinned session, preserving the preview token and reason',async()=>{
 const f=fixture(),context=await f.prepare();await context.confirm(' Synthetic reviewed settlement ',false);const request=f.calls.at(-1);
 assert.equal(request.url,'/payroll/records/record-'+businesses[0]+'/payment-status/confirm');assert.equal(request.config.headers['X-Business-Id'],businesses[0]);
 assert.equal(request.body.token,'synthetic-preview');assert.equal(request.body.confirm,true);assert.equal(request.body.reason,'Synthetic reviewed settlement');assert.equal(request.body.paid,true);
});
test('records without saved ownership continue to use their current tenant, not an inferred owner',async()=>{
 const f=fixture();delete f.records.get(businesses[3])[0].payrollOwnerBusinessId;const context=await f.prepare();assert.equal(context.paymentBusinessId,businesses[3]);assert.equal(context.preview.id,'record-'+businesses[3]);
});
test('different saved amounts, owner changes, missing owners and ambiguous owner cutoffs stop before a payment preview',async()=>{
 for(const change of [f=>f.records.get(businesses[0])[0].netPay=979,f=>f.records.get(businesses[0])[0].payrollOwnerBusinessId=businesses[2],
  f=>f.records.set(businesses[0],[]),f=>f.records.get(businesses[0]).push({...f.records.get(businesses[0])[0],_id:'duplicate'}),
  f=>f.records.get(businesses[0])[0].employeeId='another',f=>f.records.get(businesses[0])[0].payPeriod='Oct 6, 2026 - Oct 20, 2026']){
  const f=fixture();change(f);await assert.rejects(f.prepare());assert.equal(f.calls.filter(call=>call.method==='post').length,0);
 }
 const f=fixture(),stale={...f.records.get(businesses[3])[0],netPay:981};await assert.rejects(f.prepare(stale),/changed/);
});
test('unsigned, employee, tracker and inaccessible owning-business contexts never gain a payment capability',async()=>{
 for(const change of [f=>f.setAuth(null),f=>f.setAuth({...f.auth(),sessionToken:''}),f=>f.setAuth({...f.auth(),userType:'employee'}),f=>f.setAuth({...f.auth(),access:'tracker'})]){
  const f=fixture();change(f);await assert.rejects(f.prepare());assert.equal(f.calls.length,0);
 }
 const f=fixture();f.setAuth({...f.auth(),allowedBusinesses:[{id:businesses[3]}]});await assert.rejects(f.prepare(),/access/);assert.equal(f.calls.length,1);
});
test('tenant or signed-session changes during any read discard the result before further requests',async()=>{
 for(const stage of ['get','preview'])for(const change of [f=>f.setBusiness(businesses[2]),f=>f.setAuth(null),f=>f.setAuth({...f.auth(),sessionToken:'next-session'})]){
  const f=fixture();f.onRequest(at=>{if(at===stage)change(f);});await assert.rejects(f.prepare(),/Payment session changed/);assert.ok(!f.calls.some(call=>call.url.endsWith('/confirm')));
 }
});
test('session, tenant and account changes after preview prevent confirmation instead of inheriting a new login',async()=>{
 for(const change of [f=>f.setBusiness(businesses[2]),f=>f.setAuth(null),f=>f.setAuth({...f.auth(),sessionToken:'next'}),f=>f.setAuth({...f.auth(),user:{employeeCode:'another'}})]){
  const f=fixture(),context=await f.prepare();change(f);await assert.rejects(context.confirm('Synthetic reason',true),/Payment session changed/);assert.ok(!f.calls.some(call=>call.url.endsWith('/confirm')));
 }
});
test('wrong IDs, cutoff dates, paid direction, business membership and raced amounts cannot be confirmed',async()=>{
 for(const change of [p=>({...p,id:'other'}),p=>({...p,payPeriod:'Oct 6, 2026 - Oct 20, 2026'}),p=>({...p,paid:false}),p=>({...p,businessIds:[businesses[0]]}),
  p=>({...p,rows:p.rows.map(row=>row.businessId===businesses[3]?{...row,netPay:979}:row)})]){
  const f=fixture();f.override(change);await assert.rejects(f.prepare());assert.ok(!f.calls.some(call=>call.url.endsWith('/confirm')));
 }
});
test('backend blockers and unacknowledged attendance warnings remain effective',async()=>{
 const f=fixture();f.setCanApply(false);const blocked=await f.prepare();await assert.rejects(blocked.confirm('Synthetic reason',true));
 const g=fixture();g.setWarnings(['Synthetic attendance history']);const warned=await g.prepare();await assert.rejects(warned.confirm('Synthetic reason',false));await warned.confirm('Synthetic reason',true);
});
test('concurrent or repeated confirmation issues at most one status request and requires a new preview afterward',async()=>{
 const f=fixture(),context=await f.prepare();const results=await Promise.allSettled([context.confirm('Synthetic reason',true),context.confirm('Synthetic reason',true)]);
 assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(f.calls.filter(call=>call.url.endsWith('/confirm')).length,1);await assert.rejects(context.confirm('Synthetic repeat',true));
});
test('the dialog retains explicit confirmation and routes through its prepared owner context without weakening backend ownership',()=>{
 const dialog=readFileSync(new URL('../src/components/admin/PayrollPaymentDialog.tsx',import.meta.url),'utf8'),backend=readFileSync(new URL('../backend/src/services/payrollPaymentStatusService.ts',import.meta.url),'utf8');
 assert.match(dialog,/!confirmed/);assert.match(dialog,/context!\.confirm/);assert.match(dialog,/Owning business/);assert.match(dialog,/validScope\(\)/);assert.match(backend,/source\.payrollOwnerBusinessId !== getCurrentBusinessId\(\)/);
});
