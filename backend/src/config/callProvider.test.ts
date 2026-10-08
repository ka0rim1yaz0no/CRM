import assert from "node:assert/strict";
import test from "node:test";
import {
  isAutoCallDisabledForEmployee,
  isSupportedAutoCallClientVersion,
  legacyAutoCallClientVersion,
  parseAutoCallDisabledEmployeeCodes,
  requiredAutoCallClientVersion,
} from "./callProvider";

test("accepts the current and controlled legacy auto-call browser clients", () => {
  assert.equal(isSupportedAutoCallClientVersion(requiredAutoCallClientVersion), true);
  assert.equal(isSupportedAutoCallClientVersion(legacyAutoCallClientVersion), true);
  assert.equal(isSupportedAutoCallClientVersion("2026-10-02-single-launch-v2"), false);
  assert.equal(isSupportedAutoCallClientVersion("2026-10-02-single-launch-v1"), false);
  assert.equal(isSupportedAutoCallClientVersion(undefined), false);
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
