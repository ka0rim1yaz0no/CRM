import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalPhoneLeads, logicalLeadKey, normalizeLeadPhone } from "../../../shared/leadPhonePolicy";

const now = new Date("2026-10-22T17:00:00.001Z");
test("equivalent US formats override every different place/name/address identifier", () => {
    const variants = ["(214) 555-1234", "214-555-1234", "2145551234", "+1 214 555 1234", "1-214-555-1234"];
    assert.deepEqual(variants.map(normalizeLeadPhone), variants.map(() => "+12145551234"));
    const leads = variants.map((phone, index) => ({ _id: String(index), phone, googlePlaceId: `different-${index}`, providerPlaceId: `different-provider-${index}`,
        businessName: `Different business ${index}`, businessAddress: `Different address ${index}`, status: "NEW" }));
    assert.equal(canonicalPhoneLeads(leads, now).length, 1);
});
test("international country codes and full digit strings are never compared by shared suffix", () => {
    assert.equal(normalizeLeadPhone("0044 20 7946 0958"), "+442079460958");
    assert.equal(normalizeLeadPhone("+44 (20) 7946 0958"), "+442079460958");
    const leads = ["+1 202 555 0121", "+44 20 7946 0958", "+61 2 5550 0121"].map((phone, i) => ({ _id: String(i), phone }));
    assert.equal(canonicalPhoneLeads(leads).length, 3);
    assert.notEqual(logicalLeadKey({ _id: "us", phone: "+1 202 555 0121" }), logicalLeadKey({ _id: "other", phone: "+44 1202 5550121" }));
    assert.equal(normalizeLeadPhone("call 202-555-0121 or 202-555-0122"), null);
});
test("missing or unusable phone numbers keep independent records unless a reliable complete fallback agrees", () => {
    const leads = ["", "123", "not a phone", undefined].map((phone, index) => ({ _id: String(index), phone, businessName: "Same chain" }));
    assert.equal(canonicalPhoneLeads(leads).length, 4);
    assert.equal(canonicalPhoneLeads([{ _id: "a", googlePlaceId: "same" }, { _id: "b", googlePlaceId: "same" }]).length, 1);
});
test("due commitments win deterministically without changing owners, schedules or history, including millisecond boundaries", () => {
    const leads = [
        { _id: "a", status: "NEW", phone: "2145551234", assignedAgent: "owner-a", callCount: 50 },
        { _id: "c", status: "Follow up", phone: "+12145551234", assignedAgent: "owner-c", followUpAt: new Date(+now - 1) },
        { _id: "b", status: "Follow up", phone: "214-555-1234", assignedAgent: "owner-b", followUpAt: new Date(+now - 2) },
    ];
    const before = JSON.stringify(leads);
    assert.equal(canonicalPhoneLeads(leads, now)[0]._id, "b");
    assert.equal(canonicalPhoneLeads([...leads].reverse(), now)[0]._id, "b");
    assert.equal(JSON.stringify(leads), before);
});
test("scheduled future commitments and human work do not get silently replaced by empty imported copies", () => {
    const base = { phone: "+12145551234", status: "NEW" };
    assert.equal(canonicalPhoneLeads([{ ...base, _id: "empty" }, { ...base, _id: "worked", callCount: 1 }], now)[0]._id, "worked");
    assert.equal(canonicalPhoneLeads([{ ...base, _id: "empty" }, { ...base, _id: "scheduled", status: "Follow up", followUpAt: new Date(+now + 1) }], now)[0]._id, "scheduled");
});
