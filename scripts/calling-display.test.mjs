import assert from 'node:assert/strict';
import test from 'node:test';
import {callingDisplay,resetCallingDisplay,observeCallingBridge,postCallRemainingMs,setCallingDisplayIssue} from '../src/lib/callingDisplay.ts';
import {setCallingProgress} from '../src/lib/callingWorkflow.ts';
globalThis.window=new EventTarget();
const at=Date.parse('2026-10-30T17:00:00.237Z');
function bridge(offset,extra={}){return{state:'idle',connected:true,ready:offset>=30000,nativeDialReady:true,lastCallEndedAt:new Date(at).toISOString(),
    nextCallAllowedAt:new Date(at+30000).toISOString(),serverTime:new Date(at+offset).toISOString(),clientReceivedAtMonotonic:1000+offset,...extra};}
test('only a confirmed call end anchors the 30 seconds, and retry/Ready/queue phases never restart them in six businesses',()=>{
    for(let business=0;business<6;business++){
        const scope={employeeId:'synthetic',businessId:'two-state-'+business};resetCallingDisplay(scope);
        assert.equal(postCallRemainingMs(callingDisplay(scope),1000),null);
        observeCallingBridge(scope,bridge(0));assert.equal(postCallRemainingMs(callingDisplay(scope),1000),30000);
        const unchanged=callingDisplay(scope);
        for(const message of ['Checking attendance','Checking calling queue','Reserving next call','Confirming dial permission']){
            setCallingProgress(scope,message);assert.equal(callingDisplay(scope),unchanged);
        }
        assert.equal(postCallRemainingMs(callingDisplay(scope),30999),1);assert.equal(postCallRemainingMs(callingDisplay(scope),31000),0);
        observeCallingBridge(scope,bridge(30000,{state:'calling',nextCallAllowedAt:new Date(at+60000).toISOString()}));
        assert.equal(callingDisplay(scope).status,'CALL WAITING');assert.equal(postCallRemainingMs(callingDisplay(scope),31000),0);
        observeCallingBridge(scope,bridge(45000,{state:'idle',nextCallAllowedAt:new Date(at+75000).toISOString()}));
        assert.equal(postCallRemainingMs(callingDisplay(scope),46000),0);
    }
});
test('On Call requires current Bridge evidence and an older response cannot resurrect a finished call',()=>{
    const scope={employeeId:'synthetic',businessId:'ordering'};resetCallingDisplay(scope);
    observeCallingBridge(scope,bridge(0,{state:'active'}));assert.equal(callingDisplay(scope).status,'ON CALL');
    observeCallingBridge(scope,bridge(5000,{lastCallEndedAt:new Date(at+5000).toISOString()}));assert.equal(callingDisplay(scope).status,'CALL WAITING');
    observeCallingBridge(scope,bridge(1000,{state:'active'}));assert.equal(callingDisplay(scope).status,'CALL WAITING');
    observeCallingBridge(scope,bridge(6000,{state:'unknown',reason:'Bridge confirmation unavailable'}));
    assert.equal(callingDisplay(scope).status,'CALL WAITING');assert.match(callingDisplay(scope).bridgeIssue,/unavailable/);
});
test('refresh, missing dates, disconnected audio and different accounts cannot create a new countdown or leak another scope',()=>{
    const a={employeeId:'synthetic-a',businessId:'a'},b={employeeId:'synthetic-a',businessId:'b'};resetCallingDisplay(a);resetCallingDisplay(b);
    observeCallingBridge(a,bridge(0,{state:'active',connected:false,lastCallEndedAt:null}));assert.equal(callingDisplay(a).status,'CALL WAITING');
    assert.equal(postCallRemainingMs(callingDisplay(a),1000),null);assert.equal(callingDisplay(b).serverTime,0);
    setCallingDisplayIssue(a,'Calling connection unavailable');assert.equal(callingDisplay(b).requestIssue,'');
    resetCallingDisplay(a);assert.equal(callingDisplay(a).serverTime,0);
    observeCallingBridge(a,bridge(20000));assert.equal(postCallRemainingMs(callingDisplay(a),21000),10000);
    observeCallingBridge(a,bridge(21000,{serverTime:'invalid'}));assert.equal(postCallRemainingMs(callingDisplay(a),22000),9000);
});
