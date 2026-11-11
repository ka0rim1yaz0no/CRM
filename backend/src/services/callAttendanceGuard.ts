import type { ClientSession } from "mongoose";
import { attendanceIntegrityEnabled } from "../config/rolloutFlags";
import { getCurrentBusinessId } from "../config/tenancy";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { getAttendanceBusinessIdentity } from "../models/BusinessUserAccess";
import { normalizeEmployeeAvailabilityStatus } from "../models/Employee";
import { projectAttendance } from "./attendanceSessionState";
import { coachingOutSource } from "../../../shared/attendanceCoaching";

export async function attendanceAllowsCall(employee: { _id: unknown; employeeCode: string; availabilityStatus?: string }, session?: ClientSession, intent: "automatic" | "manual" = "automatic") {
    if (!attendanceIntegrityEnabled()) return normalizeEmployeeAvailabilityStatus(employee.availabilityStatus) === "ONLINE";
    const business = getCurrentBusinessId(), mapping = await getAttendanceBusinessIdentity(employee.employeeCode);
    if (mapping && !mapping.businessIds.includes(business)) return false;
    const key = mapping ? `access:${mapping.id}` : `tenant:${business}:${employee._id}`;
    const ledger = await AttendanceLedger.findById(key, null, session ? { session } : undefined)
        .select("events corrections closures revision fence lockUntil").lean();
    const now = new Date();
    if (!ledger || ledger.lockUntil && ledger.lockUntil > now) return false;
    const active = projectAttendance(ledger.events, ledger.corrections, ledger.closures).active;
    const coaching = active?.mode === "OFF THE PHONE" && active.events.at(-1)?.source === coachingOutSource;
    if (active?.mode !== "ONLINE" && !(intent === "manual" && coaching)) return false;
    if (!session) return true;
    // Share the attendance fencing document so a concurrent rest/checkout commit
    // and a dial authorization cannot both use an earlier attendance snapshot.
    const guarded = await AttendanceLedger.updateOne({ _id: key, revision: ledger.revision, fence: ledger.fence,
        $or: [{ lockUntil: null }, { lockUntil: { $lte: now } }] }, { $inc: { fence: 1 } }, { session, timestamps: false });
    return guarded.modifiedCount === 1;
}
