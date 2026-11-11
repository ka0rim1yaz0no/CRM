import assert from "node:assert/strict";
import { test } from "node:test";
import { Types } from "mongoose";
import { customerNameKey, customerMergeGroups, customerMergePatch, preferredCustomerLead, type CustomerLead } from "./customerLeadMerge";
const row = (fields: Partial<CustomerLead> = {}): CustomerLead => ({ _id: new Types.ObjectId(), leadName: "Synthetic Customer", businessName: "Synthetic Customer", status: "Follow up", ...fields });

test("customer identity ignores formatting and case, not different names", () => {
    assert.equal(customerNameKey("  Synthetic--CUSTOMER "), "synthetic customer");
    assert.equal(customerMergeGroups([row({ phone: "+12025550121" }), row({ email: "synthetic@example.test" })])[0]!.length, 2);
    assert.equal(customerMergeGroups([row(), row({ leadName: "Different Customer" })]).length, 2);
});
test("same customer email joins different phones while unrelated same-name emails stay separate", () => {
    assert.equal(customerMergeGroups([row({ phone: "+12025550121", email: "SYNTHETIC@example.test" }), row({ phone: "+12025550122", email: "synthetic@example.test" })])[0]!.length, 2);
    const groups = customerMergeGroups([row({ email: "one@example.test" }), row({ email: "one@example.test" }), row({ email: "two@example.test" }), row({ email: "two@example.test" }), row()]);
    assert.deepEqual(groups.map(group => group.length).sort(), [1, 2, 2]);
    assert.equal(customerMergeGroups([row({ phone: "12345" }), row({ phone: "67890" })]).length, 2);
});
test("a shared normalized phone allows alternate email without a fuzzy-name merge", () => {
    assert.equal(customerMergeGroups([row({ phone: "+1 (202) 555-0121", email: "one@example.test" }), row({ phone: "2025550121", email: "two@example.test" })])[0]!.length, 2);
    assert.equal(customerMergeGroups([row(), row({ status: "Archived" }), row({ duplicateOf: new Types.ObjectId() }), row({ leadName: "Synthetic" })])[0]!.length, 1);
});
test("merge fills missing contacts and retains order source, details, alternate contacts and existing notes", () => {
    const first = row({ phone: "+12025550121", notes: "Original work", source: "Synthetic order #1" });
    const next = row({ email: "synthetic@example.test", source: "Synthetic order #2", notes: "Two items", website: "https://example.test" });
    const patch = customerMergePatch(first, [next]);
    assert.equal(patch.email, next.email); assert.equal(patch.phone, undefined); assert.match(patch.notes!, /Original work/); assert.match(patch.notes!, /order #2/); assert.match(patch.notes!, /Two items/);
    const repeat = customerMergePatch({ ...first, ...patch }, [next]); assert.equal(repeat.notes, undefined);
    assert.match(customerMergePatch(first, [row({ phone: "+12025550122", notes: "Extra order" })]).notes!, /2025550122/);
});
test("comments, call history, favorites and exact last-call timestamps survive merging", () => {
    const employee = new Types.ObjectId(), stamp = new Date("2026-11-09T12:00:00.237Z"), later = new Date("2026-11-09T12:00:00.999Z");
    const comment = { authorName: "Synthetic", authorType: "employee" as const, body: "Original note", createdAt: stamp };
    const call = { employee, employeeName: "Synthetic", employeeRole: "Sales", employeeTeam: "Sales", calledAt: stamp, _id: new Types.ObjectId() };
    const first = row({ callCount: 1, comments: [comment], callLogs: [call], favoriteByEmployees: [employee], lastCallAt: stamp,
        callsByEmployee: [{ ...call, count: 1, lastCallAt: stamp }] });
    const second = row({ callCount: 2, comments: [{ ...comment, body: "Second note" }], favoriteByEmployees: [employee], lastCallAt: later,
        callsByEmployee: [{ ...call, count: 2, lastCallAt: later }] });
    const patch = customerMergePatch(first, [second]);
    assert.equal(patch.comments!.length, 2); assert.equal(patch.callLogs!.length, 1); assert.equal(patch.callCount, 3);
    assert.equal(patch.favoriteByEmployees!.length, 1); assert.equal(patch.lastCallAt!.getTime(), later.getTime()); assert.equal(patch.callsByEmployee![0]!.count, 3);
});
test("assignment/appointment conflicts require review and canonical preserves human work", () => {
    const a = row({ assignedAgent: new Types.ObjectId() }), b = row({ assignedAgent: new Types.ObjectId() });
    assert.throws(() => customerMergePatch(a, [b]), /conflicting assignments/);
    assert.throws(() => customerMergePatch(row({ followUpAt: new Date(1000) }), [row({ followUpAt: new Date(2000) })]), /appointments/);
    const called = row({ callCount: 1, phone: "+12025550121" }); assert.equal(preferredCustomerLead([row(), called]), called);
});
test("conflicting subdocument identities require review instead of dropping historical data", () => {
    const id = new Types.ObjectId();
    const activity = { _id: id, label: "Note", detail: "First", status: "Follow up", actorName: "Synthetic", actorType: "employee" as const, createdAt: new Date() };
    assert.throws(() => customerMergePatch(row({ activity: [activity] }), [row({ activity: [{ ...activity, detail: "Different" }] })]), /conflicting history/);
});
