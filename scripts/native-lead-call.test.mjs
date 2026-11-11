import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const ast=ts.createSourceFile('native.ts',readFileSync('src/lib/nativeLeadCall.ts','utf8'),ts.ScriptTarget.Latest,true);
const code=ts.transpileModule(ts.createPrinter().printFile(ts.factory.updateSourceFile(ast,ast.statements.filter(n=>!ts.isImportDeclaration(n)))),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(options={}){
  let clock=0,business=options.business||'synthetic',work='',workOwner,confirmed=false,attempt='';
  const listeners=new Map(),calls={requests:[],cancels:[],releases:[],holds:[],statusModes:[],attendanceReads:[],pauses:[]},scope={employeeId:'synthetic-id',businessId:business};
  const auth={userType:'employee',user:{_id:scope.employeeId,employeeCode:'synthetic-code'},attendanceHubSession:'synthetic-session'};
  const exports={};
  runInNewContext(code,{exports,Symbol,AbortController,crypto:{randomUUID:()=> 'synthetic-attempt'},performance:{now:()=>clock},Date,
    window:{addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n),setTimeout:f=>{clock+=1000;queueMicrotask(f);}},
    getAuthUser:()=>auth,getActiveBusinessId:()=>business,callingAttendancePending:()=>!!options.pending,
    attendanceIntegrityEnabled:!!options.checkAttendance,getAttendanceStatus:async(id,businessId)=>{calls.attendanceReads.push([id,businessId]);if(options.coachingOnRead)options.away=false;},
    callingAttendanceBlock:(_code,mode)=>options.away||(options.coachingOnRead&&mode!=='manual')?'Employee not ONLINE':'',
    callingWorkMessage:(_scope,ignoredOwner)=>workOwner===ignoredOwner?'':work,
    callingAttendanceChanged:'attendance-changed',callingWorkflowChanged:'work-changed',
    setCallingWork:(_scope,owner,message)=>{if(message){work=message;workOwner=owner;}else if(workOwner===owner)work='';calls.holds.push(message);},
    observeCallingBridge(){},
    beginAutoCallPause(){},settleAutoCallPause(){},
    holdAutoCallForManual:async(code,input)=>{calls.pauses.push({code,...input});if(options.pauseFailed)throw Error('Auto Call pause failed');return{autoCallControlVersion:1,manualCallHold:true};},
    activateCallBridgeForEmployee:async()=>{if(options.switchOnActivate)business='other';},canUseCallBridgeBrowserSession:()=>!options.foreignSession,
    getCallBridgeStatus:async(_code,input)=>{calls.statusModes.push(input.mode);const waiting=options.waitForEnd&&!confirmed&&clock<30000;
      if(options.awayWhileWaiting&&clock>=2000)options.away=true;
      if(options.pendingWhileWaiting&&clock>=2000)options.pending=true;
      if(options.noteWhileWaiting&&clock>=2000){work='Unsaved lead changes';workOwner=Symbol('editor');}
      if(options.lateStatus&&clock>=2000)clock=46000;
      if(options.pagehideWhileWaiting&&clock>=2000)listeners.get('pagehide')?.();
      return {ready:!options.busy&&!waiting,nativeDialReady:!options.oldBridge,reason:options.oldBridge?'Update Bridge':options.busy?'Call active':'Previous call end pending',
        connected:true,state:clock<10000?'unknown':'idle',idleConfirmationPending:options.waitForEnd&&clock<10000,
        waitCode:options.neverConfirms?'CALL_END_UNCONFIRMED':clock<10000?'CALL_END_UNCONFIRMED':'POST_CALL_COOLDOWN',
        ...(options.neverConfirms?{ready:false,idleConfirmationPending:true}:{}),
        ...(options.retryWait?{ready:false,state:'idle',waitCode:'DIAL_RETRY_WAIT'}:{}),
        serverTime:new Date(Date.UTC(2026,9,28,17)+clock).toISOString(),nextCallAllowedAt:'2026-10-28T17:00:30.000Z',
        observedAttemptId:confirmed?'synthetic-attempt':null,observedLeadId:confirmed?'synthetic-lead':null};},
    requestNativeCall:async(_code,input)=>{calls.requests.push(input);attempt=input.attemptId;if(options.switchAfterRequest)business='other';confirmed=!options.unconfirmed;
      if(options.awayAfterQueue){options.away=true;listeners.get('attendance-changed')?.();}
      if(options.saveAfterQueue){work='Saving lead changes';workOwner=Symbol('save');listeners.get('work-changed')?.();}
      if(options.draftAfterQueue)listeners.get('work-changed')?.();
      if(options.pagehide)listeners.get('pagehide')?.();return {queued:true,attemptId:attempt,leadId:input.leadId,serverTime:'2026-10-28T17:00:00.000Z',dialIntentUntil:'2026-10-28T17:00:30.000Z'};},
    cancelNativeCall:async(_code,input)=>{calls.cancels.push(input);},releaseCallBridgeCall:async(_code,input)=>calls.releases.push(input),
  });
  return {calls,call:()=>exports.callLeadThroughBridge(scope,'synthetic-lead','+12025550100'),get clock(){return clock;}};
}
test('manual native calls capture the signed scope and wait for provider-state confirmation in six businesses',async()=>{
  for(let i=0;i<6;i++){const f=fixture({business:'synthetic-'+i});await f.call();assert.equal(f.calls.requests.length,1);assert.equal(f.calls.requests[0].manual,true);
    assert.equal(f.calls.requests[0].businessId,'synthetic-'+i);assert.equal(f.calls.releases.length,0);assert.equal(f.calls.holds.at(-1),'');assert.ok(f.calls.statusModes.every(mode=>mode==='manual'));
    assert.equal(f.calls.pauses.length,1);assert.equal(f.calls.pauses[0].attemptId,f.calls.requests[0].attemptId);assert.equal(f.calls.requests[0].manualHoldVersion,1);
    assert.equal(f.calls.pauses[0].leadId,'synthetic-lead');}
});

test('manual calls fail closed if Auto Call pause cannot be acknowledged and never implicitly resume it',async()=>{
  const failed=fixture({pauseFailed:true});await assert.rejects(failed.call(),/pause failed/);assert.equal(failed.calls.requests.length,0);
  for(const options of [{},{unconfirmed:true},{switchAfterRequest:true}]){
    const f=fixture(options);await f.call().catch(()=>undefined);assert.equal(f.calls.pauses.length,1);assert.equal(f.calls.pauses[0].attemptId,'synthetic-attempt');
  }
});
test('old Bridge, active calls, attendance holds and changed accounts never issue a manual dial',async()=>{
  for(const option of ['oldBridge','busy','away','foreignSession','switchOnActivate','retryWait']){const f=fixture({[option]:true});await assert.rejects(f.call());assert.equal(f.calls.requests.length,0,option);}
});
test('unconfirmed native handoff uses a bounded original deadline, cancels safely and never records a successful call',async()=>{
  const f=fixture({unconfirmed:true});await assert.rejects(f.call(),/not confirmed/);assert.equal(f.clock,30000);assert.equal(f.calls.releases.length,1);
  assert.equal(f.calls.cancels.length,1);assert.equal(f.calls.releases[0].reservationToken,'synthetic-attempt');
});
test('an account switch retains the original request scope for cancellation and a repeated click cannot issue another command',async()=>{
  const f=fixture({switchAfterRequest:true});await assert.rejects(f.call());assert.equal(f.calls.cancels[0].businessId,'synthetic');
  const g=fixture();const first=g.call();await assert.rejects(g.call());await first;assert.equal(g.calls.requests.length,1);
});

test('one manual click waits for confirmed call end but does not wait for the automatic deadline',async()=>{
  for(let i=0;i<6;i++){const f=fixture({business:'synthetic-'+i,waitForEnd:true});await f.call();
    assert.equal(f.calls.requests.length,1);assert.equal(f.clock,11000);assert.equal(f.calls.releases.length,0);}
});

test('a manual click refreshes stale attendance and authorizes only one request during Coaching',async()=>{
  const f=fixture({checkAttendance:true,away:true,coachingOnRead:true});await f.call();
  assert.deepEqual(f.calls.attendanceReads,[['synthetic-id','synthetic']]);assert.equal(f.calls.requests.length,1);
  const blocked=fixture({checkAttendance:true,away:true});await assert.rejects(blocked.call(),/not ONLINE/);
  assert.equal(blocked.calls.requests.length,0);
});

test('manual preflight is bounded and cancels on attendance changes or page exit without placing a call',async()=>{
  const never=fixture({neverConfirms:true});await assert.rejects(never.call(),/confirmed|confirmation/i);
  assert.equal(never.clock,45000);assert.equal(never.calls.requests.length,0);
  for(const option of ['awayWhileWaiting','pagehideWhileWaiting','pendingWhileWaiting','noteWhileWaiting','lateStatus']){const f=fixture({waitForEnd:true,[option]:true});
    await assert.rejects(f.call());assert.equal(f.calls.requests.length,0,option);}
});

test('draft notifications do not cancel manual calls, while attendance and actual-save changes abort an unconfirmed request',async()=>{
  const draft=fixture({draftAfterQueue:true});await draft.call();assert.equal(draft.calls.requests.length,1);assert.equal(draft.calls.cancels.length,0);
  for(const option of ['awayAfterQueue','saveAfterQueue']){
    const state=fixture({[option]:true});await assert.rejects(state.call(),/changed/);
    assert.equal(state.calls.requests.length,1);assert.equal(state.calls.requests[0].signal.aborted,true);
    assert.ok(state.calls.cancels.length>=1);assert.equal(state.calls.releases.length,1);
  }
});
