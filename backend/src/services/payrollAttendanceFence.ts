import mongoose, { type ClientSession } from "mongoose";
import { PayrollAttendanceFence } from "../models/PayrollAttendanceFence";

export type PayrollAttendanceScope = { businessId: string; employeeCode: string };
export const payrollAttendanceFenceKeys = (scopes: PayrollAttendanceScope[]) => [...new Set(scopes.map(scope => JSON.stringify([scope.businessId, scope.employeeCode])))].sort();

export async function lockPayrollAttendance(scopes: PayrollAttendanceScope[], session: ClientSession) {
  if (!session.inTransaction()) throw new Error("Payroll attendance coordination requires an active transaction");
  // All writers take the same ordered document locks; Mongo rolls them back with the business writes.
  for (const key of payrollAttendanceFenceKeys(scopes)) {
    await PayrollAttendanceFence.updateOne({ _id: key }, { $inc: { version: 1 } }, { session, upsert: true });
  }
}

export async function attendancePayrollTransaction<T>(write: (session: ClientSession) => Promise<T>, session?: ClientSession): Promise<T> {
  if (session) {
    if (!session.inTransaction()) throw new Error("Attendance requires an active transaction");
    return write(session);
  }
  const owned = await mongoose.startSession();
  try {
    return await owned.withTransaction(() => write(owned), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally { await owned.endSession(); }
}
