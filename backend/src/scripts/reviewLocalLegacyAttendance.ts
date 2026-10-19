import mongoose from "mongoose";
import { localReviewBusinesses } from "../localReviewConfig";

const info = await fetch("http://127.0.0.1:4101/__local/review-info").then((response) => response.json()) as { isolatedCopy?: boolean };
if (info.isolatedCopy !== true) throw new Error("Only the isolated local review is supported.");
await mongoose.connect("mongodb://127.0.0.1:27119/crm", { autoIndex: false, autoCreate: false });
try {
  const db = mongoose.connection.getClient();
  const profiles = await db.db("crm_control").collection<{ businessId?: string; name?: string; databaseName?: string }>("businessprofiles").find({}, { projection: { businessId: 1, name: 1, databaseName: 1 } }).toArray();
  const available = (await db.db("admin").admin().listDatabases({ nameOnly: true })).databases.map((item) => item.name);
  const businesses = localReviewBusinesses(profiles, available);
  Object.assign(process.env, { NODE_ENV: "development", BUSINESS_DATABASES: JSON.stringify(businesses),
    DEFAULT_BUSINESS_ID: businesses[0].id, DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName,
    CONTROL_DATABASE_NAME: "crm_control", CRM_ATTENDANCE_INTEGRITY: "true", CRM_ATTENDANCE_RECOVERY_CUTOFF: "false" });
  const { runWithBusiness } = await import("../config/tenancy");
  const { Employee } = await import("../models/Employee");
  const { resolveAttendanceIdentity, readAttendanceLedger, attendanceSnapshot } = await import("../services/attendanceLedgerService");
  const { previewLegacyAttendanceMigration } = await import("../services/attendanceMigrationPreview");
  const { prepareLegacyAttendanceAdoption } = await import("../services/legacyAttendanceAdoptionPlan");
  const { attendancePolicy } = await import("../services/attendanceLedgerService");
  const seen = new Set<string>();
  const apiSignatures = new Map<string, string>();
  const byBusiness: Array<{ businessId: string; employees: number; ready: number; blocked: number; apiVerified: number }> = [];
  const beforeAudit = await db.db("crm").collection("attendanceledgers").find({}).toArray();
  const report = { businesses: businesses.length, identities: 0, alreadyAdopted: 0, noHistory: 0,
    legacy: 0, timelineIssues: 0, mismatches: 0, duplicateHistories: 0, missingReplicas: 0, openLegacySessions: 0,
    safelyAdoptable: 0, manualControlsReady: 0, historicalWarnings: 0,
    issuesAfterExactDeduplication: {} as Record<string, number>, issues: {} as Record<string, number> };
  for (const business of businesses) await runWithBusiness(business.id, async () => {
    const businessReport = { businessId: business.id, employees: 0, ready: 0, blocked: 0, apiVerified: 0 };
    byBusiness.push(businessReport);
    const employees = await Employee.find({ status: { $ne: "Archived" } }).select("_id employeeCode").lean();
    for (const employee of employees) {
      const identity = await resolveAttendanceIdentity(String(employee._id), { role: "admin", code: "local-review" });
      const ledger = await readAttendanceLedger(identity);
      const confirmed = attendanceSnapshot(ledger);
      businessReport.employees++;
      if (confirmed.reviewState === "verified") businessReport.ready++; else businessReport.blocked++;
      if (process.argv.includes("--verify-api")) {
        const login = await fetch("http://127.0.0.1:4101/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Business-Id": business.id }, body: JSON.stringify({ employeeCode: employee.employeeCode }) });
        if (!login.ok) throw new Error("Local employee sign-in verification failed.");
        const auth = await login.json() as { attendanceHubSession?: string };
        if (!auth.attendanceHubSession) throw new Error("Signed employee attendance session was not issued.");
        const read = await fetch(`http://127.0.0.1:4101/api/employees/${employee._id}/attendance/session`, {
          headers: { "X-Business-Id": business.id, "X-CRM-Attendance-Session": auth.attendanceHubSession },
        });
        if (!read.ok) throw new Error("Local attendance session verification failed.");
        const actual = await read.json() as { state: string; revision: number; reviewState: string; records: unknown[] };
        if (actual.reviewState !== "verified" || actual.state !== confirmed.state || actual.revision !== confirmed.revision) throw new Error("Local attendance API is not ready for manual actions.");
        const signature = JSON.stringify([actual.state, actual.revision, actual.records]);
        if (apiSignatures.has(identity.key) && apiSignatures.get(identity.key) !== signature) throw new Error("Business attendance API responses differ.");
        apiSignatures.set(identity.key, signature); businessReport.apiVerified++;
      }
      if (seen.has(identity.key)) continue;
      seen.add(identity.key); report.identities++;
      if (confirmed.reviewState === "verified") report.manualControlsReady++;
      if (confirmed.historyReviewRequired) report.historicalWarnings++;
      if (!ledger.migrationRequired) { if (ledger.events.length) report.alreadyAdopted++; else report.noHistory++; continue; }
      report.legacy++;
      const snapshot = attendanceSnapshot(ledger);
      if (snapshot.sessionId) report.openLegacySessions++;
      const preview = await previewLegacyAttendanceMigration(identity);
      const policy = await attendancePolicy(identity.canonicalBusinessId);
      const plan = prepareLegacyAttendanceAdoption(identity.key, preview.businesses.map((item) => ({ businessId: item.businessId,
        employeeId: item.missingEmployee ? null : "present", records: item.events.map((row) => ({ ...row, eventId: row.eventId || undefined,
          createdAt: row.at })) })), policy);
      if (plan.ready) report.safelyAdoptable++;
      for (const issue of new Set(plan.timelineIssues.map((item) => item.message))) report.issuesAfterExactDeduplication[issue] = (report.issuesAfterExactDeduplication[issue] || 0) + 1;
      if (preview.crossBusinessMismatch) report.mismatches++;
      if (preview.businesses.some((item) => item.duplicateKeys.length)) report.duplicateHistories++;
      if (preview.businesses.some((item) => item.missingEmployee)) report.missingReplicas++;
      if (preview.businesses.some((item) => item.issues.length)) report.timelineIssues++;
      for (const issue of new Set(preview.businesses.flatMap((item) => item.issues))) report.issues[issue] = (report.issues[issue] || 0) + 1;
    }
  });
  const afterAudit = await db.db("crm").collection("attendanceledgers").find({}).toArray();
  if (JSON.stringify(beforeAudit) !== JSON.stringify(afterAudit)) throw new Error("Attendance changed during the read-only audit; retry verification.");
  process.stdout.write(`${JSON.stringify({ readOnly: true, attendanceUnchanged: true, ...report, byBusiness }, null, 2)}\n`);
} finally { await mongoose.disconnect(); }
