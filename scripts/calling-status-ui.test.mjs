import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import * as display from '../src/lib/callingDisplay.ts';
globalThis.window=new EventTarget();
const require=createRequire(import.meta.url),at=Date.parse('2026-10-30T17:00:00.237Z');
const source=ts.transpileModule(readFileSync('src/components/CallingStatus.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function fixture(offset=0,options={}){
    const scope={employeeId:'synthetic',businessId:'display-ui-'+Math.random()};let clock=1000+offset,currentScope=scope.businessId,pendingRead;
    const auth={userType:'employee',user:{_id:scope.employeeId,employeeCode:'synthetic-code'},attendanceHubSession:'synthetic-session'};
    const body={state:'idle',connected:true,ready:offset>=30000,nativeDialReady:true,lastCallEndedAt:new Date(at).toISOString(),serverTime:new Date(at+offset).toISOString(),clientReceivedAtMonotonic:clock,...options.bridge};
    display.resetCallingDisplay(scope);display.observeCallingBridge(scope,body);
    const exported={};
    runInNewContext(source,{exports:exported,performance:{now:()=>clock},Date,require:name=>{
        if(name==='@tanstack/react-query')return{useQuery:input=>{pendingRead=input.queryFn;return{isError:!!options.error};}};
        if(name==='../api/authStorage')return{getAuthUser:()=>auth};
        if(name==='../api/businessStorage')return{getActiveBusinessId:()=>currentScope};
        if(name==='../api/callBridge')return{getCallBridgeStatus:async()=>{await options.onRead?.();return body;}};
        if(name==='../lib/callingDisplay')return display;
        return require(name);
    }});
    const render=()=>renderToStaticMarkup(React.createElement(exported.default,{scope,hold:options.hold,queueError:options.queueError}));
    return{scope,render,advance:ms=>{clock+=ms;},read:()=>pendingRead(),switchBusiness:()=>{currentScope='another';}};
}
test('employee calling UI has only Call Waiting / On Call without an employee countdown',()=>{
    for(const offset of [0,19999,20000,29999,30000,120000]){
        const f=fixture(offset),html=f.render();assert.match(html,/>Call Waiting<\/span>/);assert.doesNotMatch(html,/Post-call wait remaining|00:\d\d/);
        assert.doesNotMatch(html,/Checking|Preparing|Reserving|READY|ONLINE|Dial requested/i);
    }
    const active=fixture(5000,{bridge:{state:'active'}}).render();assert.match(active,/>On Call<\/span>/);assert.doesNotMatch(active,/Post-call wait remaining/);
});
test('stale active evidence cannot leave On Call visible forever, and actionable failures are separate warnings',()=>{
    const f=fixture(0,{bridge:{state:'active'}});f.advance(20001);const html=f.render();assert.match(html,/>Call Waiting<\/span>/);assert.doesNotMatch(html,/>On Call</);assert.match(html,/Live call status unavailable/);
    const held=fixture(0,{hold:'Unsaved lead changes'}).render();assert.match(held,/>Call Waiting<\/span>/);assert.match(held,/role="alert"/);assert.match(held,/Unsaved lead changes/);
});
test('display observation remains read-only and ignores a late response after a business switch',async()=>{
    let release;const wait=new Promise(resolve=>{release=resolve;});
    const f=fixture(0,{onRead:()=>wait});f.render();const before=display.callingDisplay(f.scope),pending=f.read();f.switchBusiness();release();await pending;
    assert.equal(display.callingDisplay(f.scope),before);
});
