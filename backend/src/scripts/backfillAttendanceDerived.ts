import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mongo } from "mongoose";
import type { AttendanceLedgerDocument, AttendancePolicyDocument } from "../models/AttendanceLedger";
import type { AttendanceDocument } from "../models/Attendance";
import { attendanceDerivedBackfillWindow, summarizeAttendanceDerivedBackfill, type AttendanceBackfillEmployee } from "../services/attendanceDerivedBackfill";

export function parseAttendanceDerivedBackfillArguments(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: {
    "dry-run": { type: "boolean" }, uri: { type: "string" }, "ledger-database": { type: "string" },
    business: { type: "string", multiple: true }, "as-of": { type: "string" },
  } });
  if (!values["dry-run"] || !values.uri || !values["ledger-database"] || !values.business?.length) {
    throw new Error("Explicit --dry-run, --uri, --ledger-database and --business id=database are required. Apply is not supported.");
  }
  const businesses = values.business.map((value) => {
    const index = value.indexOf("=");
    if (index <= 0 || index === value.length - 1) throw new Error("Each business must be id=database.");
    return { id: value.slice(0, index), database: value.slice(index + 1) };
  });
  if (new Set(businesses.map((business) => business.id)).size !== businesses.length) throw new Error("Duplicate business identifiers are not allowed.");
  const now = values["as-of"] ? new Date(values["as-of"]) : new Date();
  attendanceDerivedBackfillWindow(now);
  return { uri: values.uri, ledgerDatabase: values["ledger-database"], businesses, now };
}

export async function backfillAttendanceDerivedDryRun(args: string[]) {
  const options = parseAttendanceDerivedBackfillArguments(args);
  // Raw read-only driver calls avoid model auto-index/auto-create side effects.
  const client = new mongo.MongoClient(options.uri);
  try {
    await client.connect();
    const canonical = client.db(options.ledgerDatabase);
    const policy = await canonical.collection<AttendancePolicyDocument>("attendancepolicies").findOne({ _id: "global-attendance" });
    if (!policy) throw new Error("The canonical attendance policy must exist before a dry-run.");
    const window = attendanceDerivedBackfillWindow(options.now);
    const reports = [];
    for (const business of options.businesses) {
      const database = client.db(business.database);
      const employees: AttendanceBackfillEmployee[] = [];
      for await (const employee of database.collection<{ employeeCode: string }>("employees").find({ status: { $ne: "Archived" } }, { projection: { employeeCode: 1 } })) {
        const records = await database.collection<AttendanceDocument>("attendances").find({ employee: employee._id,
          isArchived: { $ne: true }, isEffective: { $ne: false }, timeIn: { $gte: window.contextStart, $lte: options.now } },
        { projection: { eventId: 1, source: 1, timeIn: 1, derived: 1 } }).toArray();
        const ledger = await canonical.collection<AttendanceLedgerDocument>("attendanceledgers").findOne({ employeeCode: employee.employeeCode, businessIds: business.id });
        if (records.length || ledger) employees.push({ records: records.map((record) => ({ ...record, id: String(record._id) })), ledger: ledger || undefined });
      }
      reports.push(summarizeAttendanceDerivedBackfill(business.id, employees, policy, options.now));
    }
    return { dryRun: true, writes: 0, days: 60, businesses: reports };
  } finally { await client.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await backfillAttendanceDerivedDryRun(process.argv.slice(2)))); }
  catch { console.error("Attendance derived dry-run failed. No writes were requested. Verify explicit arguments and read-only database access."); process.exitCode = 1; }
}
