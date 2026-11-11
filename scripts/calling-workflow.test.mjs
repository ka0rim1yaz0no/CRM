import assert from "node:assert/strict";
import test from "node:test";
import { callingWorkMessage, setCallingWork, setCallingDraft, callingDraftMessage, trackCallingSave, setLeadNoteDraft, getLeadNoteDraft, clearSavedLeadNoteDraft } from "../src/lib/callingWorkflow.ts";
globalThis.window = new EventTarget();
const scope = { employeeId: "synthetic-person", businessId: "synthetic-a" };
const other = { employeeId: "synthetic-person", businessId: "synthetic-b" };
test("pending saves survive an editor unmount and only their own completion releases the scope", async () => {
    let resolveFirst, rejectSecond;
    const first = new Promise(resolve => { resolveFirst = resolve; });
    const second = new Promise((_resolve, reject) => { rejectSecond = reject; });
    const owner = Symbol("editor");
    setCallingWork(scope, owner, "Unsaved lead changes");
    trackCallingSave(scope, first); trackCallingSave(scope, second);
    setCallingWork(scope, owner, "");
    assert.equal(callingWorkMessage(scope), "Saving lead changes");
    assert.equal(callingWorkMessage(other), "");
    resolveFirst(); await first; await Promise.resolve();
    assert.equal(callingWorkMessage(scope), "Saving lead changes");
    rejectSecond(new Error("Synthetic failure")); await second.catch(() => undefined); await Promise.resolve();
    assert.equal(callingWorkMessage(scope), "");
});
test("failed or late saves cannot erase a different business's note or a newer draft", () => {
    const lead = { _id: "synthetic-lead" };
    setLeadNoteDraft(scope, lead, "original"); setLeadNoteDraft(other, lead, "other business");
    setLeadNoteDraft(scope, lead, "newer draft");
    clearSavedLeadNoteDraft(scope, lead._id, "original");
    assert.equal(getLeadNoteDraft(scope).body, "newer draft");
    assert.equal(getLeadNoteDraft(other).body, "other business");
    clearSavedLeadNoteDraft(scope, lead._id, "newer draft");
    assert.equal(getLeadNoteDraft(scope), null);
    assert.equal(getLeadNoteDraft(other).body, "other business");
});

test("ignoring a manual attempt's own hold never ignores another editor or pending save", async () => {
    const manual=Symbol("manual"),editor=Symbol("editor");
    setCallingWork(scope,manual,"Waiting for previous call confirmation");
    assert.equal(callingWorkMessage(scope,manual),"");assert.equal(callingWorkMessage(scope),"Waiting for previous call confirmation");
    setCallingWork(scope,editor,"Unsaved lead changes");assert.equal(callingWorkMessage(scope,manual),"Unsaved lead changes");
    setCallingWork(scope,manual,"");assert.equal(callingWorkMessage(scope),"Unsaved lead changes");
    let finish;const save=new Promise(resolve=>{finish=resolve;});trackCallingSave(scope,save);
    assert.equal(callingWorkMessage(scope,editor),"Saving lead changes");finish();await save;await Promise.resolve();setCallingWork(scope,editor,"");
});

test("drafts and confirmation dialogs protect the editor without blocking automatic or manual dialing", () => {
    for(let index=0;index<6;index++){
        const view={employeeId:'draft-person',businessId:'draft-business-'+index},editor=Symbol(),manual=Symbol();
        setCallingDraft(view,editor,'Unsaved lead changes');assert.equal(callingWorkMessage(view),'');assert.equal(callingDraftMessage(view),'Unsaved lead changes');
        setCallingWork(view,manual,'Waiting for manual call confirmation');setCallingDraft(view,editor,'');
        assert.equal(callingWorkMessage(view),'Waiting for manual call confirmation');assert.equal(callingWorkMessage(view,manual),'');
        setCallingWork(view,manual,'');assert.equal(callingWorkMessage(view),'');
    }
});

test("overlapping owners cannot overwrite or release another manual operation or save", () => {
    const view={employeeId:'overlap',businessId:'overlap'},manual=Symbol(),editor=Symbol();
    setCallingWork(view,manual,'Waiting for manual call confirmation');setCallingWork(view,editor,'Saving lead changes');
    setCallingWork(view,editor,'');assert.equal(callingWorkMessage(view),'Waiting for manual call confirmation');
    setCallingWork(view,editor,'Saving lead changes');setCallingWork(view,manual,'');assert.equal(callingWorkMessage(view),'Saving lead changes');
    setCallingWork(view,editor,'');
});

test("notes on different leads survive route changes and clearing or saving only affects the matching draft",()=>{
    const view={employeeId:'drafts',businessId:'drafts'},one={_id:'one'},two={_id:'two'};
    setLeadNoteDraft(view,one,'first');setLeadNoteDraft(view,two,'second');
    assert.equal(getLeadNoteDraft(view,one._id).body,'first');assert.equal(getLeadNoteDraft(view,two._id).body,'second');
    clearSavedLeadNoteDraft(view,one._id,'first');assert.equal(getLeadNoteDraft(view,one._id),null);
    assert.equal(getLeadNoteDraft(view,two._id).body,'second');setLeadNoteDraft(view,two,'');assert.equal(getLeadNoteDraft(view),null);
});
