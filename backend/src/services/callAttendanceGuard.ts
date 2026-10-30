import type { ClientSession } from "mongoose";
import { attendanceIntegrityEnabled } from "../config/rolloutFlags";
import { getCurrentBusinessId } from "../config/tenancy";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { getAttendanceBusinessIdentity } from "../models/BusinessUserAccess";
import { normalizeEmployeeAvailabilityStatus } from "../models/Employee";
import { projectAttendance } from "./attendanceSessionState";

export async function attendanceAllowsCall(employee: { _id: unknown; employeeCode: string; availabilityStatus?: string }, session?: ClientSession) {
    if (!attendanceIntegrityEnabled()) return normalizeEmployeeAvailabilityStatus(employee.availabilityStatus) === "ONLINE";
    const business = getCurrentBusinessId(), mapping = await getAttendanceBusinessIdentity(employee.employeeCode);
    if (mapping && !mapping.businessIds.includes(business)) return false;
    const key = mapping ? `access:${mapping.id}` : `tenant:${business}:${employee._id}`;
    const ledger = await AttendanceLedger.findById(key, null, session ? { session } : undefined).lean();
    const now = new Date();
    if (!ledger || ledger.lockUntil && ledger.lockUntil > now ||
        projectAttendance(ledger.events, ledger.corrections, ledger.closures).active?.mode !== "ONLINE") return false;
    if (!session) return true;
    // Share the attendance fencing document so a concurrent rest/checkout commit
    // and a dial authorization cannot both use an earlier ONLINE snapshot.
    const guarded = await AttendanceLedger.updateOne({ _id: key, revision: ledger.revision, fence: ledger.fence,
        $or: [{ lockUntil: null }, { lockUntil: { $lte: now } }] }, { $inc: { fence: 1 } }, { session, timestamps: false });
    return guarded.modifiedCount === 1;
}
