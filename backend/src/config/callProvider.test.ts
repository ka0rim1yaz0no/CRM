import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentBusinessId } from "./tenancy";
import {
  isAutoCallDisabledForEmployee,
  isAutoCallDisabledForBusiness,
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
    assert.equal(isSupportedAutoCallClientVersion("2026-10-14-comment-lock-v5"), false);
    assert.equal(isSupportedAutoCallClientVersion(requiredAutoCallClientVersion), true);
    assert.equal(isSupportedAutoCallClientVersion(legacyAutoCallClientVersion), false);
    assert.equal(isSupportedAutoCallClientVersion(undefined), false);
  } finally {
    if (previous === undefined) delete process.env.CRM_CALL_TIMING_V2;
    else process.env.CRM_CALL_TIMING_V2 = previous;
  }
});

test("business restrictions match stable workspace IDs without affecting other businesses", () => {
  const previous = process.env.AUTO_CALL_DISABLED_BUSINESS_IDS;
  try {
    process.env.AUTO_CALL_DISABLED_BUSINESS_IDS = "business-a, business-b";
    for (const id of ["business-a", " business-b "]) assert.equal(isAutoCallDisabledForBusiness(id), true);
    for (const id of ["business-c", "business-aa", "", undefined]) assert.equal(isAutoCallDisabledForBusiness(id), false);
  } finally {
    if (previous === undefined) delete process.env.AUTO_CALL_DISABLED_BUSINESS_IDS;
    else process.env.AUTO_CALL_DISABLED_BUSINESS_IDS = previous;
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

test("employee restrictions can be scoped to the current business without blocking colleagues", () => {
  const employeeCodes = process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES;
  const businessIds = process.env.AUTO_CALL_DISABLED_BUSINESS_IDS;
  try {
    process.env.AUTO_CALL_DISABLED_BUSINESS_IDS = "";
    const business = getCurrentBusinessId();
    process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES = `${business}:synthetic-target,foreign-business:synthetic-other`;
    assert.equal(isAutoCallDisabledForEmployee("synthetic-target"), true);
    assert.equal(isAutoCallDisabledForEmployee("synthetic-other"), false);
    assert.equal(isAutoCallDisabledForEmployee("synthetic-colleague"), false);
    assert.equal(isAutoCallDisabledForEmployee(""), false);
    process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES = "synthetic-target";
    assert.equal(isAutoCallDisabledForEmployee("synthetic-target"), true, "unscoped legacy restrictions remain global");
  } finally {
    if (employeeCodes === undefined) delete process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES;
    else process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES = employeeCodes;
    if (businessIds === undefined) delete process.env.AUTO_CALL_DISABLED_BUSINESS_IDS;
    else process.env.AUTO_CALL_DISABLED_BUSINESS_IDS = businessIds;
  }
});
