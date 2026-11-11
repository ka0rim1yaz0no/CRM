import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLeadPhone } from "../../../shared/leadPhonePolicy";
import { normalizeCallingPhone } from "./employeeCallingQueue";

test("queue phone correction preserves valid formatted numbers", () => {
  for (const value of ["+12025550123", "12025550123", "2025550123", "(202) 555-0123", "202-555-0123", "+1 (202) 555-0123"]) {
    assert.equal(normalizeCallingPhone(value), "+12025550123");
    assert.equal(normalizeCallingPhone(value), normalizeLeadPhone(value));
  }
});

test("queue phone correction never offers an extracted number rejected by dispatch", () => {
  for (const value of ["Call (202) 555-0123", "Office: +1 202-555-0123", "+1 202-555-0123 or +1 202-555-0144", "hello +12025550123"]) {
    assert.equal(normalizeLeadPhone(value), null);
    assert.equal(normalizeCallingPhone(value), null, "QUEUE_DISPATCH_PHONE_VALIDATION_MISMATCH");
  }
});

test("queue phone correction shares dispatch's international and invalid-input policy", () => {
  for (const value of ["00442079460018", "+44 20 7946 0018", "+1 202-555-0123 ext. 4", "", null, undefined, "invalid", "123"]) {
    assert.equal(normalizeCallingPhone(value), normalizeLeadPhone(value));
  }
});
