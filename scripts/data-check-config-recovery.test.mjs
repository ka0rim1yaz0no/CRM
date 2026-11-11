import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../src/api/dataCheck.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('config.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const code=ts.transpileModule(ts.createPrinter().printFile(ts.factory.updateSourceFile(ast,ast.statements.filter(node=>!ts.isImportDeclaration(node)))),{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(responses){
    const calls=[],timers=[],exported={};let business='synthetic-a';
    runInNewContext(code,{exports:exported,DOMException,api:{get:async(path,options)=>{
        calls.push({path,options});const item=responses.shift();if(item instanceof Error)throw item;return {data:item};}},
        getActiveBusinessId:()=>business,setTimeout:callback=>{timers.push(callback);return timers.length;},clearTimeout:id=>{timers[id-1]=null;}});
    return {api:exported,calls,switchBusiness:()=>{business='synthetic-b';},retry:()=>{for(const callback of timers.splice(0))callback?.();}};
}
const failure=status=>Object.assign(new Error('Synthetic failure'),{response:{status}});
test('one transient 503 recovers in the captured business without changing data',async()=>{
    const config={enabled:true,navigationVisible:true,businesses:[]},state=fixture([failure(503),config]);
    const pending=state.api.getDataCheckConfig();await new Promise(setImmediate);state.switchBusiness();state.retry();
    assert.equal(await pending,config);assert.equal(state.calls.length,2);
    assert.ok(state.calls.every(call=>call.path==='/admin/data-check/config'&&call.options.headers['X-Business-Id']==='synthetic-a'));
});
test('persistent 503 retries once; authorization failures never retry',async()=>{
    const state=fixture([failure(503),failure(503)]),pending=state.api.getDataCheckConfig();
    await new Promise(setImmediate);state.retry();await assert.rejects(pending);assert.equal(state.calls.length,2);
    for(const status of [401,403,404,500]){const denied=fixture([failure(status)]);await assert.rejects(denied.api.getDataCheckConfig());assert.equal(denied.calls.length,1);}
});
test('logout or scope cancellation prevents a queued retry',async()=>{
    const controller=new AbortController(),state=fixture([failure(503),{enabled:true}]),pending=state.api.getDataCheckConfig(controller.signal);
    await new Promise(setImmediate);controller.abort();state.retry();await assert.rejects(pending,{name:'AbortError'});assert.equal(state.calls.length,1);
});
