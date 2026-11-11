import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function compile(file,keep=()=>true,jsx=false){
  const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,jsx?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  return ts.transpileModule(ts.createPrinter().printFile(ts.factory.updateSourceFile(ast,ast.statements.filter(node=>!ts.isImportDeclaration(node)&&keep(node)))),
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
}
const storeCode=compile('src/lib/autoCallControl.ts');
function fixture(storage=new Map()){
  const exports={},events=new EventTarget(),window={localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events)};
  runInNewContext(storeCode,{exports,window,Event,Map,Object,JSON,Number});
  return{...exports,storage,window};
}
const scope=(businessId='synthetic-0',employeeId='synthetic-employee')=>({businessId,employeeId});

test('manual pause is shared across seven businesses but never leaks to another employee',()=>{
  const f=fixture();f.beginAutoCallPause(scope(),true);
  for(let n=0;n<7;n++)assert.equal(f.getAutoCallControl(scope('synthetic-'+n)).paused,true);
  assert.equal(f.getAutoCallControl(scope('synthetic-0','colleague')).paused,false);
  f.observeAutoCallControl(scope(),{autoCallPaused:true,autoCallUserPaused:false,manualCallHold:true,autoCallControlVersion:1},true);
  assert.equal(f.getAutoCallControl(scope()).pending,false);
  assert.equal(f.getAutoCallControl(scope()).userPaused,false);assert.equal(f.getAutoCallControl(scope()).manualHold,true);
  assert.equal(f.getAutoCallControl(scope()),f.getAutoCallControl(scope()),'external-store snapshots must remain stable');
});

test('manual pause survives refresh without leaving an abandoned pending request stuck forever',()=>{
  const f=fixture();f.beginAutoCallPause(scope());
  assert.equal(f.getAutoCallControl(scope()).pending,true);
  const refreshed=fixture(f.storage);
  assert.equal(refreshed.getAutoCallControl(scope()).paused,true);assert.equal(refreshed.getAutoCallControl(scope()).pending,false);
  refreshed.observeAutoCallControl(scope(),{autoCallPaused:true,autoCallControlVersion:1});
  assert.equal(refreshed.getAutoCallControl(scope()).version,1);
});

test('old status replies cannot unpause a pending manual takeover or overwrite a newer server version',()=>{
  const f=fixture();f.beginAutoCallPause(scope());
  f.observeAutoCallControl(scope(),{autoCallPaused:false,autoCallControlVersion:0});assert.equal(f.getAutoCallControl(scope()).paused,true);
  f.observeAutoCallControl(scope(),{autoCallPaused:true,autoCallControlVersion:3},true);
  f.observeAutoCallControl(scope(),{autoCallPaused:false,autoCallControlVersion:2});assert.equal(f.getAutoCallControl(scope()).paused,true);
  f.observeAutoCallControl(scope(),{autoCallPaused:false,autoCallControlVersion:4},true);assert.equal(f.getAutoCallControl(scope()).paused,false);
});

test('storage events synchronize another tab without adding a queue poll or dial authorization',()=>{
  const first=fixture(),second=fixture(first.storage);let notices=0;
  const unsubscribe=second.subscribeAutoCallControl(()=>notices++);
  first.observeAutoCallControl(scope(),{autoCallPaused:true,autoCallControlVersion:5},true);
  second.window.dispatchEvent(new Event('storage'));
  assert.equal(notices,1);assert.equal(second.getAutoCallControl(scope()).paused,true);
  unsubscribe();second.window.dispatchEvent(new Event('storage'));assert.equal(notices,1);
});

const mutationCode=compile('src/api/callBridge.ts',node=>ts.isFunctionDeclaration(node)&&node.name?.text==='holdAutoCallForManual');
function apiFixture({fail=false}={}){
  const store=fixture(),exports={},requests=[];
  let business='synthetic-0',auth={userType:'employee',user:{_id:'synthetic-employee',employeeCode:'synthetic-code'},attendanceHubSession:'signed-session'};
  runInNewContext(mutationCode,{exports,...store,getAuthUser:()=>auth,getActiveBusinessId:()=>business,autoCallClientHeaders:{'X-CRM-Auto-Call-Version':'synthetic'},
    readBrowserSession:()=>({employeeCode:'synthetic-code',businessId:business,sessionId:'browser-binding'}),getStoredBrowserDeviceKey:()=> 'synthetic-browser-key',
    api:{post:async(path,body,options)=>{
      requests.push({path,body,options,pausedBeforeRequest:store.getAutoCallControl(scope(business)).paused});
      if(fail)throw Error('network unavailable');
      return{data:{autoCallPaused:true,autoCallUserPaused:store.getAutoCallControl(scope(business)).userPaused,
        manualCallHold:true,autoCallControlVersion:1}};
    }}});
  return{...store,requests,call:exports.holdAutoCallForManual,switchBusiness:next=>business=next,signOut:()=>auth=null};
}
test('a temporary manual hold captures the signed lead and browser and clears only from the server end snapshot',async()=>{
  const f=apiFixture();
  await f.call('synthetic-code',{businessId:'synthetic-0',employeeSession:'signed-session',attemptId:'attempt',leadId:'lead',normalizedPhone:'+12025550100'});
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].pausedBeforeRequest,true);
  assert.equal(f.requests[0].path,'/call-bridge/manual-call-hold');assert.equal(f.requests[0].options.headers['X-CRM-Attendance-Session'],'signed-session');
  assert.equal(f.requests[0].body.attemptId,'attempt');assert.equal(f.requests[0].body.leadId,'lead');assert.equal(f.requests[0].body.browserSessionId,'browser-binding');
  assert.equal(f.getAutoCallControl(scope()).paused,true);
  f.observeAutoCallControl(scope(),{autoCallPaused:false,autoCallUserPaused:false,manualCallHold:false,autoCallControlVersion:2});
  assert.equal(f.requests.length,1);assert.equal(f.getAutoCallControl(scope()).paused,false);
});

test('temporary manual hold clears on a newer confirmed-end snapshot without clearing a pre-existing user pause',()=>{
  for(const userPaused of[false,true]){
    const f=fixture();f.observeAutoCallControl(scope(),{autoCallPaused:userPaused,autoCallUserPaused:userPaused,manualCallHold:false,autoCallControlVersion:1});
    f.beginAutoCallPause(scope(),true);
    f.observeAutoCallControl(scope(),{autoCallPaused:true,autoCallUserPaused:userPaused,manualCallHold:true,autoCallControlVersion:2},true);
    f.observeAutoCallControl(scope(),{autoCallPaused:userPaused,autoCallUserPaused:userPaused,manualCallHold:false,autoCallControlVersion:3});
    assert.equal(f.getAutoCallControl(scope()).paused,userPaused);assert.equal(f.getAutoCallControl(scope()).manualHold,false);
  }
});

test('failed pause never looks confirmed and foreign or changed sessions cannot change call mode',async()=>{
  const f=apiFixture({fail:true});
  await assert.rejects(f.call('synthetic-code',{businessId:'synthetic-0',employeeSession:'signed-session',attemptId:'attempt'}));
  assert.equal(f.getAutoCallControl(scope()).pending,false);assert.equal(f.getAutoCallControl(scope()).paused,true);
  const g=apiFixture();
  for(const [code,business,session]of[['foreign','synthetic-0','signed-session'],['synthetic-code','other','signed-session'],['synthetic-code','synthetic-0','wrong']]){
    await assert.rejects(g.call(code,{businessId:business,employeeSession:session,attemptId:'attempt'}));
  }
  assert.equal(g.requests.length,0);g.signOut();await assert.rejects(g.call('synthetic-code',{}));
});

test('automatic dispatch checks the manual takeover before work, after async reads and before native handoff',()=>{
  const code=readFileSync('src/components/EmployeeAutoCaller.tsx','utf8');
  assert.match(code,/const canContinue = \(\) => current\(\) && !getAutoCallControl\(scope\)\.paused/);
  assert.ok(code.indexOf('if (getAutoCallControl(scope).paused)')<code.indexOf('const work = callingWorkMessage(scope)'));
  assert.match(code,/window\.addEventListener\(autoCallControlChanged, workChanged\)/);
  assert.match(code,/window\.removeEventListener\(autoCallControlChanged, workChanged\)/);
  assert.match(code,/window\.clearTimeout\(timer\); window\.clearTimeout\(prepareTimer\)/);
  assert.match(code,/deadlineRequest\?\.abort\(\); cancelNative\(\)/);
  const manual=readFileSync('src/lib/nativeLeadCall.ts','utf8');
  assert.ok(manual.indexOf('beginAutoCallPause(scope)')<manual.indexOf('await activateCallBridgeForEmployee'));
  assert.ok(manual.indexOf('await activateCallBridgeForEmployee')<manual.indexOf('await holdAutoCallForManual'));
  assert.ok(manual.indexOf('await holdAutoCallForManual')<manual.indexOf('await requestNativeCall'));
});

test('temporary manual takeover does not add an employee control that can disable Auto Call indefinitely',()=>{
  const source=readFileSync('src/components/CallingStatus.tsx','utf8');
  assert.doesNotMatch(source,/setEmployeeAutoCallPaused|Resume Auto Call|Pause Auto Call/);
  const api=readFileSync('src/api/callBridge.ts','utf8');assert.doesNotMatch(api,/export async function setEmployeeAutoCallPaused/);
});
