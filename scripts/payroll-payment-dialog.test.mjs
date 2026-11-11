import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../src/components/admin/PayrollPaymentDialog.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('dialog.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='PayrollPaymentDialog');
const declaration=component.body.statements.flatMap(node=>ts.isVariableStatement(node)?Array.from(node.declarationList.declarations):[]).find(node=>node.name.getText(ast)==='save');
assert.ok(declaration);
function fixture({canApply=true,fail=false,neverRefresh=false,scope=true,paid=true,warnings=[],acknowledged=true,savedAmounts=null,unavailable=false}={}){
 const record={_id:'synthetic-payroll',employeeId:'synthetic-employee',payPeriod:'Oct 21, 2026 - Nov 5, 2026',status:'Pending',paidOn:'-',grossPay:500,deductions:20,netPay:480,cutoffEstimate:true,earnedToDate:undefined,earningsUnavailable:unavailable};
 let cached=[structuredClone(record),{...record,_id:'unrelated',employeeId:'another'}],closed=0,confirmedRequests=0,error='',stale=false;
 const busy=[],saving={current:false},mounted={current:true},preview={canApply,warnings,paidOn:paid?'Nov 10, 2026':'-',rows:[{businessId:'synthetic-view',...(savedAmounts||record)}]};
 const context={async confirm(){confirmedRequests++;if(fail)throw Error('Synthetic refused confirmation');return{applied:true};}};
 const queryClient={setQueriesData(filter,update){assert.deepEqual(Array.from(filter.queryKey),['payroll-records','synthetic-view']);cached=update(cached);},
  invalidateQueries(){return neverRefresh?new Promise(()=>{}):Promise.resolve();}};
 const exports={};runInNewContext(ts.transpileModule('exports.save = '+declaration.initializer.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
  {exports,record,preview,paid,context,queryClient,businessId:'synthetic-view',confirmed:true,acknowledged,reason:'Synthetic reviewed status',
   saving,mounted,stale,validScope:()=>scope,setBusy:value=>busy.push(value),setError:value=>error=value,setStale:value=>stale=value,
   setConfirmed:()=>{},setAcknowledged:()=>{},errorText:failure=>failure.message,onClose:()=>closed++});
 return{save:exports.save,before:record,cached:()=>cached,closed:()=>closed,requests:()=>confirmedRequests,error:()=>error,stale:()=>stale,busy};
}
test('successful status confirmation closes even when background refresh never resolves',async()=>{
 const f=fixture({neverRefresh:true});let handle;
 try{await Promise.race([f.save(),new Promise((resolve,reject)=>{handle=setTimeout(()=>reject(Error('Dialog waited on background refresh')),100);})]);}
 finally{clearTimeout(handle);}
 assert.equal(f.closed(),1);assert.equal(f.requests(),1);assert.equal(f.cached()[0].status,'Paid');
 for(const key of ['grossPay','deductions','netPay'])assert.equal(f.cached()[0][key],f.before[key]);
 assert.equal(f.cached()[0].paidOn,'Nov 10, 2026');assert.equal(f.cached()[0].cutoffEstimate,undefined);assert.equal(f.cached()[1].status,'Pending');
});
test('refused confirmation never changes the displayed status or amounts',async()=>{
 const f=fixture({fail:true});await f.save();assert.equal(f.closed(),0);assert.equal(f.cached()[0].status,'Pending');
 assert.match(f.error(),/refused/);assert.equal(f.stale(),true);assert.equal(f.busy.at(-1),false);
});
test('backend blockers cannot be bypassed through the payment dialog',async()=>{
 const f=fixture({canApply:false});await f.save();assert.equal(f.closed(),0);assert.equal(f.requests(),0);assert.equal(f.cached()[0].status,'Pending');
});
test('business changes during confirmation do not update another context',async()=>{
 const f=fixture({scope:false});await f.save();assert.equal(f.requests(),0);assert.equal(f.closed(),0);assert.equal(f.cached()[0].status,'Pending');
});
test('repeat clicks send one status request and do not alter amounts when setting unpaid',async()=>{
 const f=fixture({paid:false});await Promise.all([f.save(),f.save()]);assert.equal(f.requests(),1);assert.equal(f.closed(),1);
 assert.equal(f.cached()[0].status,'Pending');assert.equal(f.cached()[0].paidOn,'-');assert.equal(f.cached()[0].netPay,480);
});

test('successful saved payment immediately displays the saved money, not the previous projected estimate',async()=>{
 const f=fixture({savedAmounts:{grossPay:400,deductions:10,netPay:390},unavailable:true});await f.save();
 assert.equal(f.closed(),1);assert.equal(f.cached()[0].grossPay,400);assert.equal(f.cached()[0].deductions,10);assert.equal(f.cached()[0].netPay,390);
 assert.equal(f.cached()[0].earningsUnavailable,undefined);
});

test('genuine saved-attendance history warnings still require acknowledgement without forcing recomputation',async()=>{
 const warnings=['Saved attendance history needs attention; approve only saved amounts.'];
 const held=fixture({warnings,acknowledged:false});await held.save();assert.equal(held.requests(),0);
 const approved=fixture({warnings,acknowledged:true});await approved.save();assert.equal(approved.requests(),1);assert.equal(approved.closed(),1);
});

test('payment confirmation has no forced cutoff-recompute shortcut and clearly approves saved amounts',()=>{
 assert.doesNotMatch(source,/Review cutoff calculation|onReviewCalculation/);
 assert.match(source,/reviewed the warnings and approve the saved payroll amounts/i);
});
