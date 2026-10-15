import assert from "node:assert/strict";
import test from "node:test";
import {
  isAutoCallDisabledForEmployee,
  isSupportedAutoCallClientVersion,
  legacyAutoCallClientVersion,
  parseAutoCallDisabledEmployeeCodes,
  requiredAutoCallClientVersion,
} from "./callProvider";

test("accepts only the current auto-call browser client", () => {
  const previous = process.env.CRM_CALL_TIMING_V2;
  try {
    process.env.CRM_CALL_TIMING_V2 = "true";
    assert.equal(isSupportedAutoCallClientVersion(requiredAutoCallClientVersion), true);
    assert.equal(isSupportedAutoCallClientVersion("2026-10-14-comment-lock-v5"), false);
    process.env.CRM_CALL_TIMING_V2 = "false";
    assert.equal(isSupportedAutoCallClientVersion("2026-10-14-comment-lock-v5"), true);
    assert.equal(isSupportedAutoCallClientVersion(requiredAutoCallClientVersion), false);
    assert.equal(isSupportedAutoCallClientVersion(legacyAutoCallClientVersion), false);
    assert.equal(isSupportedAutoCallClientVersion(undefined), false);
  } finally {
    if (previous === undefined) delete process.env.CRM_CALL_TIMING_V2;
    else process.env.CRM_CALL_TIMING_V2 = previous;
  }
});

test("parses temporary auto-call employee restrictions", () => {
  assert.deepEqual(
    [...parseAutoCallDisabledEmployeeCodes("26001018, 26001019;26001020\n26001018")],
    ["26001018", "26001019", "26001020"]
  );
});

test("checks the configured temporary auto-call restrictions", () => {
  const previousValue = process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES;
  process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES = "26001018,26001020";

  try {
    assert.equal(isAutoCallDisabledForEmployee("26001018"), true);
    assert.equal(isAutoCallDisabledForEmployee("26001019"), false);
  } finally {
    if (previousValue === undefined) {
      delete process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES;
    } else {
      process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES = previousValue;
    }
  }
});

test("supports disabling auto-call for every employee", () => {
  const previousValue = process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES;
  process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES = "*";

  try {
    assert.equal(isAutoCallDisabledForEmployee("26001018"), true);
    assert.equal(isAutoCallDisabledForEmployee("new-sales-employee"), true);
  } finally {
    if (previousValue === undefined) {
      delete process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES;
    } else {
      process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES = previousValue;
    }
  }
});
