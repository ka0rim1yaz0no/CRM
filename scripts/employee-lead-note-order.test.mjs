import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const file='backend/src/controllers/leadController.ts',source=fs.readFileSync(file,'utf8');
const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),handler=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='listMyLeads');
assert.ok(handler);let comparator;
const visit=node=>{if(ts.isCallExpression(node)&&node.expression.getText(ast)==='sortedCandidates.sort')comparator=node.arguments[0];ts.forEachChild(node,visit);};visit(handler);assert.ok(comparator);
const execute=text=>{const exports={};vm.runInNewContext(ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date});return exports;};
const policy=execute(fs.readFileSync('shared/leadCallingPolicy.ts','utf8')),display=execute('exports.compare='+comparator.getText(ast)).compare;
const now=new Date('2026-11-06T17:00:00.237Z');
const lead=(id,status='Follow up',created=1000)=>({_id:id,status,createdAt:new Date(+now-created),comments:[]});
const order=rows=>rows.slice().sort((a,b)=>policy.compareCallingLeads(a,b,now)).sort(display);
const ids=rows=>rows.map(row=>row._id);

test('saved follow-up falls below untouched follow-ups even when its creation date is newer',()=>{
 const saved={...lead('saved', 'Follow up',1000),comments:[{authorType:'employee',createdAt:now}]},untouched=lead('untouched','Follow up',5000);
 assert.deepEqual(ids(order([saved,untouched])),['untouched','saved']);
});
test('genuine NEW leads stay newest-first while saved work drops below remaining untouched leads',()=>{
 const saved={...lead('saved','Follow up',1),comments:[{authorType:'employee',createdAt:now}]};
 assert.deepEqual(ids(order([saved,lead('new-older','NEW',5000),lead('follow-up','Follow up',4000),lead('new-latest','NEW',2000)])),
  ['new-latest','new-older','follow-up','saved']);
});
test('an unsaved draft does not cool or move an untouched lead and sorting never changes the records',()=>{
 const rows=[{...lead('draft','Follow up',1000),draft:'Synthetic unsaved text'},lead('older','Follow up',2000)],before=JSON.stringify(rows);
 assert.deepEqual(ids(order(rows)),['draft','older']);assert.equal(JSON.stringify(rows),before);
});
test('existing callback priority and the note cooldown expiry remain unchanged within follow-ups',()=>{
 const due={...lead('due','Follow up',10000),followUpAt:new Date(+now-1000)},regular=lead('regular','Follow up',5000),
  held={...lead('held','Follow up',1),comments:[{authorType:'employee',createdAt:now}]};
 assert.deepEqual(ids(order([held,regular,due])),['due','regular','held']);
 const expired={...lead('expired','Follow up',100),comments:[{authorType:'employee',createdAt:new Date(+now-policy.AUTO_CALL_COMMENT_COOLDOWN_MS)}]};
 assert.equal(policy.evaluateCallingLead(expired,now).callable,true);assert.deepEqual(ids(order([regular,expired,due])),['due','expired','regular']);
});
test('saved outcome metadata uses the same protected work priority without changing the automatic queue policy',()=>{
 const tagged={...lead('tagged','Follow up',1),lastCallOutcomeAt:now};
 assert.deepEqual(ids(order([tagged,lead('untouched','Follow up',1000)])),['untouched','tagged']);
 assert.ok(handler.getText(ast).includes('lastCallOutcomeAt'),'display candidates must include the existing saved-outcome clock');
});
test('empty and single-record workspaces remain valid',()=>{
 assert.deepEqual(order([]),[]);assert.deepEqual(ids(order([lead('only')])),['only']);
});
