import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import mongoose from "mongoose";
import { runWithBusiness } from "../config/tenancy";
import { Employee } from "../models/Employee";
import { getEmployeeAvailabilitySyncModel } from "../models/EmployeeAvailabilitySync";
import { retryPendingEmployeeAvailability, syncEmployeeAvailabilityAcrossBusinesses } from "./employeeAvailabilityService";

const testUri = process.env.CRM_INTEGRATION_MONGO_URI;

test("availability fans out and a pending business replays the latest revision", {
  skip: !testUri,
}, async () => {
  const url = new URL(testUri!);
  assert.equal(url.protocol, "mongodb:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "27099");
  assert.match(url.pathname, /^\/crm_integration_[a-z0-9_]+$/);

  const suffix = crypto.randomUUID().replaceAll("-", "");
  const controlName = `crm_integration_control_${suffix}`;
  const businesses = ["test-a", "test-b"].map((id) => ({ id, name: id,
    databaseName: `crm_integration_${id.replace("-", "_")}_${suffix}` }));
  process.env.CONTROL_DATABASE_NAME = controlName;
  process.env.BUSINESS_DATABASES = JSON.stringify(businesses);
  process.env.DEFAULT_BUSINESS_ID = "test-a";
  process.env.CRM_ATTENDANCE_V2 = "true";
  let connected = false;
  try {
    await mongoose.connect(testUri!, { serverSelectionTimeoutMS: 3000 });
    connected = true;
    for (const business of businesses) {
      await runWithBusiness(business.id, async () => {
        await Employee.create({ employeeCode: "TEST-EMPLOYEE", name: "Test Employee" });
      });
    }

    const updated = await syncEmployeeAvailabilityAcrossBusinesses("TEST-EMPLOYEE", "ONLINE", "manual-time-in");
    assert.equal(updated.length, 2);
    const Outbox = getEmployeeAvailabilitySyncModel();
    const first = await Outbox.findOne({ employeeCode: "TEST-EMPLOYEE" }).lean();
    assert.equal(first?.revision, 1);
    assert.deepEqual(first?.pendingBusinessIds, []);

    await syncEmployeeAvailabilityAcrossBusinesses("TEST-EMPLOYEE", "LUNCH", "manual-lunch-out");
    const latest = await Outbox.findOne({ employeeCode: "TEST-EMPLOYEE" }).lean();
    assert.equal(latest?.revision, 2);
    await runWithBusiness("test-b", () => Employee.updateOne({ employeeCode: "TEST-EMPLOYEE" },
      { $set: { availabilityStatus: "ONLINE", availabilityRevision: 1 } }));
    await Outbox.updateOne({ employeeCode: "TEST-EMPLOYEE", revision: 2 },
      { $set: { pendingBusinessIds: ["test-b"] } });

    assert.equal(await retryPendingEmployeeAvailability(), 1);
    const recovered = await runWithBusiness("test-b", () => Employee.findOne({ employeeCode: "TEST-EMPLOYEE" }).lean());
    assert.equal(recovered?.availabilityStatus, "LUNCH");
    assert.equal(recovered?.availabilityRevision, 2);
    assert.deepEqual((await Outbox.findOne({ employeeCode: "TEST-EMPLOYEE" }).lean())?.pendingBusinessIds, []);

    await Promise.all([
      syncEmployeeAvailabilityAcrossBusinesses("TEST-EMPLOYEE", "BREAK", "manual-break-out"),
      syncEmployeeAvailabilityAcrossBusinesses("TEST-EMPLOYEE", "ONLINE", "manual-break-in"),
    ]);
    const finalChange = await Outbox.findOne({ employeeCode: "TEST-EMPLOYEE" }).lean();
    assert.equal(finalChange?.revision, 4);
    assert.deepEqual(finalChange?.pendingBusinessIds, []);
    for (const business of businesses) {
      const finalEmployee = await runWithBusiness(business.id,
        () => Employee.findOne({ employeeCode: "TEST-EMPLOYEE" }).lean());
      assert.equal(finalEmployee?.availabilityStatus, finalChange?.availabilityStatus);
      assert.equal(finalEmployee?.availabilityRevision, finalChange?.revision);
    }
  } finally {
    if (connected) {
      for (const business of businesses) {
        await mongoose.connection.useDb(business.databaseName, { useCache: true }).dropDatabase();
      }
      await mongoose.connection.useDb(controlName, { useCache: true }).dropDatabase();
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }
});
