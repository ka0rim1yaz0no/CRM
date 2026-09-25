// import { useMemo, useState } from "react";
// import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// import { FiClock, FiCoffee, FiLogIn, FiLogOut, FiPhoneOff, FiPower, FiRefreshCw } from "react-icons/fi";
// import { breakInEmployee, breakOutEmployee, getEmployeeAttendance, lunchBreakInEmployee, lunchBreakOutEmployee, reportEmployeeActivity, timeInEmployee, timeOutEmployee, type AttendanceRecord } from "../../api/attendance";
// import { getAuthUser } from "../../api/authStorage";
// import { getEmployee, normalizeEmployeeAvailabilityStatus, type Employee, type EmployeeAvailabilityStatus } from "../../api/employees";
// import { getSystemSettings } from "../../api/systemSettings";
// import {
//     ATTENDANCE_TIME_ZONE,
//     attendanceSlotTimeZone,
//     formatAttendanceSlotKey,
//     formatAttendanceSlotLabel,
//     groupAttendanceRecordsBySlot,
//     isAttendanceTimeInSource,
// } from "../../lib/attendanceSlots";
// import { formatDateInTimeZone, formatTimeInTimeZone } from "../../lib/dateTime";
// import MainLayout from "../layout";

// const attendanceQueryKey = (employeeId?: string) => ["employee-attendance", employeeId];

// function formatAttendanceDateTime(value?: Date | string | null, timeZone = "Asia/Manila") {
//     const date = formatDateInTimeZone(value, timeZone);
//     const time = formatTimeInTimeZone(value, timeZone);
//     const formatted = [date, time].filter(Boolean).join(", ");
//     return formatted ? `${formatted} PH Time` : "";
// }

// const statusOrder: EmployeeAvailabilityStatus[] = ["ONLINE", "OFFLINE", "LUNCH", "BREAK", "OFF THE PHONE"];

// const statusLabels: Record<EmployeeAvailabilityStatus, string> = {
//     ONLINE: "ONLINE",
//     OFFLINE: "OFFLINE",
//     LUNCH: "LUNCH",
//     BREAK: "Break",
//     "OFF THE PHONE": "Off the Phone",
// };

// const statusButtonStyles: Record<EmployeeAvailabilityStatus, string> = {
//     ONLINE: "border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-700",
//     OFFLINE: "border-rose-500 bg-rose-600 text-white hover:bg-rose-700",
//     LUNCH: "border-orange-500 bg-orange-500 text-white hover:bg-orange-600",
//     BREAK: "border-amber-500 bg-amber-500 text-white hover:bg-amber-600",
//     "OFF THE PHONE": "border-sky-500 bg-sky-600 text-white hover:bg-sky-700",
// };

// const statusIcon: Record<EmployeeAvailabilityStatus, typeof FiLogIn> = {
//     ONLINE: FiLogIn,
//     OFFLINE: FiPower,
//     LUNCH: FiCoffee,
//     BREAK: FiCoffee,
//     "OFF THE PHONE": FiPhoneOff,
// };

// export default function AttendancePage() {
//     const authUser = getAuthUser();
//     const employee = authUser?.userType === "employee" ? authUser.user : null;
//     const employeeId = employee?._id || "";
//     const queryClient = useQueryClient();
//     const [message, setMessage] = useState("");
//     const [showOfflineConfirm, setShowOfflineConfirm] = useState(false);

//     const { data: attendance = [], isLoading, isFetching } = useQuery({
//         queryKey: attendanceQueryKey(employeeId),
//         queryFn: () => getEmployeeAttendance(employeeId),
//         enabled: Boolean(employeeId),
//     });
//     const { data: systemSettings } = useQuery({
//         queryKey: ["system-settings"],
//         queryFn: getSystemSettings,
//     });
//     const { data: employeeProfile } = useQuery({
//         queryKey: ["employee", employeeId],
//         queryFn: () => getEmployee(employeeId),
//         enabled: Boolean(employeeId),
//     });

//     const currentEmployee = employeeProfile || employee;
//     const currentStatus = normalizeEmployeeAvailabilityStatus(currentEmployee?.availabilityStatus);

//     const attendanceSettings = useMemo(() => ({ ...systemSettings, attendanceTimeZone: ATTENDANCE_TIME_ZONE }), [systemSettings]);
//     const attendanceTimeZone = attendanceSlotTimeZone(attendanceSettings);
//     const recordsBySlot = useMemo(() => groupAttendanceRecordsBySlot(attendance, attendanceSettings), [attendance, attendanceSettings]);
//     const latestTimeInRecord = attendance.find((record) => isAttendanceTimeInSource(record.source));
//     const latestSlotKey = latestTimeInRecord ? formatAttendanceSlotKey(latestTimeInRecord.timeIn, attendanceSettings) : "";
//     const nowSlotKey = formatAttendanceSlotKey(new Date(), attendanceSettings);
//     const latestSlotRecords = latestSlotKey ? [...(recordsBySlot[latestSlotKey] || [])].sort((left, right) => new Date(right.timeIn).getTime() - new Date(left.timeIn).getTime()) : [];
//     const latestSlotHasTimeOut = latestSlotRecords.some((record) => record.source === "Logout" || record.source === "Time Out");
//     const actionSlotKey = latestSlotKey && !latestSlotHasTimeOut ? latestSlotKey : nowSlotKey;
//     const displaySlotKey = latestSlotKey || nowSlotKey;
//     const actionSlotRecords = [...(recordsBySlot[actionSlotKey] || [])].sort((left, right) => new Date(right.timeIn).getTime() - new Date(left.timeIn).getTime());
//     const slotRecords = [...(recordsBySlot[displaySlotKey] || [])].sort((left, right) => new Date(right.timeIn).getTime() - new Date(left.timeIn).getTime());
//     const slotLabel = formatAttendanceSlotLabel(displaySlotKey);
//     const latestRecord = slotRecords[0] || attendance[0];
//     const latestSource = slotRecords[0]?.source;
//     const hasTimeIn = actionSlotRecords.some((record) => isAttendanceTimeInSource(record.source));
//     const hasTimeOut = actionSlotRecords.some((record) => record.source === "Logout" || record.source === "Time Out");
//     const hasLunchOut = actionSlotRecords.some((record) => record.source === "Lunch Break Out");
//     const hasLunchIn = actionSlotRecords.some((record) => record.source === "Lunch Break In");
//     const breakOutCount = actionSlotRecords.filter((record) => record.source === "Break Out").length;
//     const breakInCount = actionSlotRecords.filter((record) => record.source === "Break In").length;
//     const latestBreakOutRecord = actionSlotRecords.find((record) => record.source === "Break Out");
//     const latestBreakOutTime = latestBreakOutRecord ? new Date(latestBreakOutRecord.timeIn).getTime() : 0;
//     const hasBreakGapElapsed = !latestBreakOutTime || Date.now() - latestBreakOutTime >= 30 * 60 * 1000;
//     const isOnBreak = currentStatus === "BREAK" || latestSource === "Break Out";
//     const isOnLunchBreak = currentStatus === "LUNCH" || latestSource === "Lunch Break Out";
//     const canTimeIn = !hasTimeIn;
//     const canTimeOut = hasTimeIn && !hasTimeOut && currentStatus !== "BREAK" && currentStatus !== "LUNCH";
//     const canBreakOut = hasTimeIn && !hasTimeOut && currentStatus === "ONLINE" && breakOutCount === breakInCount && breakOutCount < 2 && hasBreakGapElapsed;
//     const canBreakIn = isOnBreak && breakInCount < breakOutCount;
//     const canLunchBreakOut = hasTimeIn && !hasTimeOut && !hasLunchOut && currentStatus === "ONLINE";
//     const canLunchBreakIn = isOnLunchBreak && !hasLunchIn;
//     const canSetOnline = currentStatus === "OFFLINE"
//         ? canTimeIn
//         : currentStatus === "LUNCH"
//           ? canLunchBreakIn
//           : currentStatus === "BREAK"
//             ? canBreakIn
//             : currentStatus === "OFF THE PHONE" && hasTimeIn && !hasTimeOut;
//     const canSetOffline = currentStatus !== "OFFLINE" && canTimeOut;
//     const canSetLunch = canLunchBreakOut;
//     const canSetBreak = canBreakOut;
//     const canSetOffPhone = currentStatus === "ONLINE" && hasTimeIn && !hasTimeOut;
//     const updateEmployeeStatusCache = (availabilityStatus: EmployeeAvailabilityStatus) => {
//         queryClient.setQueryData<Employee | undefined>(["employee", employeeId], (current) =>
//             current ? { ...current, availabilityStatus } : employee ? { ...employee, availabilityStatus } : current
//         );
//     };

//     const updateAttendanceCache = (record: AttendanceRecord, availabilityStatus: EmployeeAvailabilityStatus) => {
//         queryClient.setQueryData<AttendanceRecord[]>(attendanceQueryKey(employeeId), (current = []) => [record, ...current]);
//         updateEmployeeStatusCache(availabilityStatus);
//     };

//     const timeInMutation = useMutation({
//         mutationFn: () => timeInEmployee(employeeId),
//         onSuccess: (record) => {
//             updateAttendanceCache(record, "ONLINE");
//             setMessage("Status changed to ONLINE.");
//         },
//         onError: () => setMessage("Unable to change status to ONLINE. Please try again."),
//     });

//     const timeOutMutation = useMutation({
//         mutationFn: () => timeOutEmployee(employeeId),
//         onSuccess: (record) => {
//             updateAttendanceCache(record, "OFFLINE");
//             setShowOfflineConfirm(false);
//             setMessage("Status changed to OFFLINE.");
//         },
//         onError: () => {
//             setShowOfflineConfirm(false);
//             setMessage("Unable to change status to OFFLINE. Please try again.");
//         },
//     });

//     const breakOutMutation = useMutation({
//         mutationFn: () => breakOutEmployee(employeeId),
//         onSuccess: (record) => {
//             updateAttendanceCache(record, "BREAK");
//             setMessage("Status changed to Break.");
//         },
//         onError: () => setMessage("Unable to change status to Break. Please try again."),
//     });

//     const breakInMutation = useMutation({
//         mutationFn: () => breakInEmployee(employeeId),
//         onSuccess: (record) => {
//             updateAttendanceCache(record, "ONLINE");
//             setMessage("Status changed to ONLINE.");
//         },
//         onError: () => setMessage("Unable to change status to ONLINE. Please try again."),
//     });

//     const lunchBreakOutMutation = useMutation({
//         mutationFn: () => lunchBreakOutEmployee(employeeId),
//         onSuccess: (record) => {
//             updateAttendanceCache(record, "LUNCH");
//             setMessage("Status changed to LUNCH.");
//         },
//         onError: () => setMessage("Unable to change status to LUNCH. Please try again."),
//     });

//     const lunchBreakInMutation = useMutation({
//         mutationFn: () => lunchBreakInEmployee(employeeId),
//         onSuccess: (record) => {
//             updateAttendanceCache(record, "ONLINE");
//             setMessage("Status changed to ONLINE.");
//         },
//         onError: () => setMessage("Unable to change status to ONLINE. Please try again."),
//     });

//     const activityStatusMutation = useMutation({
//         mutationFn: (status: Extract<EmployeeAvailabilityStatus, "ONLINE" | "OFF THE PHONE">) =>
//             reportEmployeeActivity(employeeId, status === "OFF THE PHONE" ? "idle" : "active", {
//                 reason: status === "OFF THE PHONE" ? "manual-off-the-phone" : "manual-online",
//             }),
//         onSuccess: (result) => {
//             const availabilityStatus = normalizeEmployeeAvailabilityStatus(result.availabilityStatus);
//             updateEmployeeStatusCache(availabilityStatus);
//             setMessage(`Status changed to ${statusLabels[availabilityStatus]}.`);
//         },
//         onError: () => setMessage("Unable to change status. Please try again."),
//     });

//     const isSaving =
//         timeInMutation.isPending ||
//         timeOutMutation.isPending ||
//         breakOutMutation.isPending ||
//         breakInMutation.isPending ||
//         lunchBreakOutMutation.isPending ||
//         lunchBreakInMutation.isPending ||
//         activityStatusMutation.isPending;

//     const sourceLabel = (source?: AttendanceRecord["source"]) => {
//         if (source === "Login" || source === "Time In" || source === "Break In" || source === "Lunch Break In") return statusLabels.ONLINE;
//         if (source === "Logout" || source === "Time Out") return statusLabels.OFFLINE;
//         if (source === "Break Out") return statusLabels.BREAK;
//         if (source === "Lunch Break Out") return statusLabels.LUNCH;
//         return "No attendance yet";
//     };

//     const statusDisabled = (status: EmployeeAvailabilityStatus) => {
//         if (!employeeId || isSaving || status === currentStatus) return true;
//         if (status === "ONLINE") return !canSetOnline;
//         if (status === "OFFLINE") return !canSetOffline;
//         if (status === "LUNCH") return !canSetLunch;
//         if (status === "BREAK") return !canSetBreak;
//         if (status === "OFF THE PHONE") return !canSetOffPhone;
//         return true;
//     };

//     const handleStatusChange = (status: EmployeeAvailabilityStatus) => {
//         setMessage("");

//         if (status === "ONLINE") {
//             if (currentStatus === "OFFLINE") {
//                 timeInMutation.mutate();
//                 return;
//             }
//             if (currentStatus === "LUNCH") {
//                 lunchBreakInMutation.mutate();
//                 return;
//             }
//             if (currentStatus === "BREAK") {
//                 breakInMutation.mutate();
//                 return;
//             }
//             if (currentStatus === "OFF THE PHONE") {
//                 activityStatusMutation.mutate("ONLINE");
//             }
//             return;
//         }

//         if (status === "OFFLINE") {
//             setShowOfflineConfirm(true);
//             return;
//         }

//         if (status === "LUNCH") {
//             lunchBreakOutMutation.mutate();
//             return;
//         }

//         if (status === "BREAK") {
//             breakOutMutation.mutate();
//             return;
//         }

//         if (status === "OFF THE PHONE") {
//             activityStatusMutation.mutate("OFF THE PHONE");
//         }
//     };

//     return (
//         <MainLayout>
//             <section className="mx-auto flex w-full max-w-6xl flex-col gap-5 text-slate-950">
//                 <header className="rounded-xl border border-[#b79cff] bg-[#550fdf12] p-6 shadow-sm">
//                     <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Employee Workspace</p>
//                     <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
//                         <div>
//                             <h1 className="text-2xl font-semibold text-slate-950">Attendance</h1>
//                             <p className="mt-1 text-sm text-slate-600">Set the current work status for {currentEmployee?.name || "employee"}.</p>
//                         </div>
//                         <button
//                             type="button"
//                             onClick={() => queryClient.invalidateQueries({ queryKey: attendanceQueryKey(employeeId) })}
//                             className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#9b8ab8] bg-white px-4 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-[#f4efff]"
//                         >
//                             <FiRefreshCw className={isFetching ? "animate-spin" : ""} />
//                             Refresh
//                         </button>
//                     </div>
//                 </header>

//                 <div className="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
//                     <section className="rounded-xl border border-[#b79cff] bg-[#f100ff30] p-5 shadow-sm">
//                         <div className="flex items-center gap-3">
//                             <div className="flex size-11 items-center justify-center rounded-xl bg-[#5f27cd] text-white">
//                                 <FiClock className="size-5" />
//                             </div>
//                             <div>
//                                 <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Current Status</p>
//                                 <p className="text-xl font-semibold text-slate-950">{statusLabels[currentStatus]}</p>
//                             </div>
//                         </div>

//                         <div className="mt-5 rounded-lg border border-[#b7a7d3] bg-[#e8def6] p-4">
//                             <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Latest activity</p>
//                             <p className="mt-2 text-sm font-semibold text-slate-950">
//                                 {sourceLabel(latestRecord?.source)}
//                             </p>
//                             <p className="mt-1 text-sm text-slate-700">{latestRecord ? formatAttendanceDateTime(latestRecord.timeIn, attendanceTimeZone) : "Click ONLINE to start your attendance slot."}</p>
//                         </div>

//                         {message && (
//                             <p className="mt-4 rounded-lg border border-[#7ccfbf] bg-[#c8f7ef] px-3 py-2 text-sm font-medium text-slate-950">{message}</p>
//                         )}

//                         <p className="mt-5 rounded-lg border border-[#b7a7d3] bg-white/60 px-3 py-2 text-xs font-semibold text-slate-700">
//                             Use ONLINE to time in or return from LUNCH, Break, or Off the Phone. Use OFFLINE to time out.
//                         </p>

//                         <div className="mt-3 grid gap-3 sm:grid-cols-2">
//                             {statusOrder.map((status) => {
//                                 const Icon = statusIcon[status];
//                                 const isActive = status === currentStatus;
//                                 const disabled = statusDisabled(status);

//                                 return (
//                                     <button
//                                         key={status}
//                                         type="button"
//                                         disabled={disabled}
//                                         onClick={() => handleStatusChange(status)}
//                                         className={[
//                                             "inline-flex h-12 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold shadow-lg transition disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none",
//                                             isActive ? "ring-2 ring-slate-950/20 ring-offset-2" : "",
//                                             statusButtonStyles[status],
//                                         ].join(" ")}
//                                     >
//                                         <Icon />
//                                         {isSaving && !disabled ? "Saving..." : statusLabels[status]}
//                                     </button>
//                                 );
//                             })}
//                         </div>
//                     </section>

//                     <section className="rounded-xl border border-[#8fbfff] bg-[#dce9fb] p-5 shadow-sm">
//                         <div className="flex flex-wrap items-center justify-between gap-3">
//                             <div>
//                                 <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Attendance Slot</p>
//                                 <h2 className="text-xl font-semibold text-slate-950">{slotLabel || "Current slot"} · {slotRecords.length} record{slotRecords.length === 1 ? "" : "s"}</h2>
//                             </div>
//                             <div className="flex flex-wrap justify-end gap-2">
//                                 <p className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700">PH Time</p>
//                                 <p className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700">{attendance.length} total</p>
//                             </div>
//                         </div>

//                         <div className="content-scroll mt-4 max-h-[28rem] space-y-3 overflow-y-auto pr-1">
//                             {isLoading && <p className="rounded-lg border border-[#b7a7d3] bg-white/70 p-4 text-sm text-slate-700">Loading attendance...</p>}
//                             {!isLoading && attendance.length === 0 && (
//                                 <p className="rounded-lg border border-[#b7a7d3] bg-white/70 p-4 text-sm text-slate-700">No attendance records yet.</p>
//                             )}
//                             {!isLoading && attendance.length > 0 && slotRecords.length === 0 && (
//                                 <p className="rounded-lg border border-[#b7a7d3] bg-white/70 p-4 text-sm text-slate-700">No records in this attendance slot yet.</p>
//                             )}
//                             {slotRecords.map((record) => (
//                                 <article key={record._id} className="flex items-center justify-between gap-4 rounded-lg border border-[#9bbde8] bg-white/75 p-4 shadow-sm">
//                                     <div className="flex items-center gap-3">
//                                         <span
//                                             className={[
//                                                 "flex size-9 items-center justify-center rounded-lg text-white",
//                                                 record.source === "Login" || record.source === "Time In" || record.source === "Break In" || record.source === "Lunch Break In"
//                                                     ? "bg-[#10ac84]"
//                                                     : record.source === "Break Out" || record.source === "Lunch Break Out"
//                                                         ? "bg-[#f59e0b]"
//                                                       : "bg-[#ee5253]",
//                                             ].join(" ")}
//                                         >
//                                             {record.source === "Break Out" || record.source === "Lunch Break Out" ? <FiCoffee /> : record.source === "Logout" || record.source === "Time Out" ? <FiLogOut /> : <FiLogIn />}
//                                         </span>
//                                         <div>
//                                             <p className="text-sm font-semibold text-slate-950">{sourceLabel(record.source)}</p>
//                                             <p className="text-xs text-slate-600">{formatAttendanceDateTime(record.timeIn, attendanceTimeZone)}</p>
//                                         </div>
//                                     </div>
//                                     <div className="flex flex-wrap justify-end gap-2">
//                                         {record.attendanceStatus && (
//                                             <span className={["rounded-full px-3 py-1 text-xs font-semibold", record.attendanceStatus === "Late" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"].join(" ")}>
//                                                 {record.attendanceStatus}
//                                             </span>
//                                         )}
//                                         <span className="rounded-full bg-[#f4efff] px-3 py-1 text-xs font-semibold text-slate-700">{slotLabel || formatDateInTimeZone(record.timeIn, attendanceTimeZone)}</span>
//                                     </div>
//                                 </article>
//                             ))}
//                         </div>
//                     </section>
//                 </div>
//             </section>

//             {showOfflineConfirm && (
//                 <div
//                     className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
//                     role="presentation"
//                     onMouseDown={(event) => {
//                         if (event.target === event.currentTarget && !timeOutMutation.isPending) {
//                             setShowOfflineConfirm(false);
//                         }
//                     }}
//                 >
//                     <section
//                         className="w-full max-w-md overflow-hidden rounded-xl border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
//                         role="dialog"
//                         aria-modal="true"
//                         aria-labelledby="offline-confirm-title"
//                     >
//                         <div className="border-b border-slate-200 px-5 py-4">
//                             <div className="flex items-start gap-3">
//                                 <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
//                                     <FiPower className="size-5" aria-hidden="true" />
//                                 </span>
//                                 <div>
//                                     <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Confirm status change</p>
//                                     <h2 id="offline-confirm-title" className="mt-1 text-lg font-semibold text-slate-950">Go offline?</h2>
//                                     <p className="mt-2 text-sm leading-6 text-slate-600">
//                                         This will time you out and set your current status to OFFLINE.
//                                     </p>
//                                 </div>
//                             </div>
//                         </div>
//                         <div className="flex flex-col-reverse gap-2 bg-slate-50 px-5 py-4 sm:flex-row sm:justify-end">
//                             <button
//                                 type="button"
//                                 className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
//                                 onClick={() => setShowOfflineConfirm(false)}
//                                 disabled={timeOutMutation.isPending}
//                             >
//                                 Cancel
//                             </button>
//                             <button
//                                 type="button"
//                                 className="inline-flex h-10 items-center justify-center rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
//                                 onClick={() => timeOutMutation.mutate()}
//                                 disabled={timeOutMutation.isPending}
//                             >
//                                 {timeOutMutation.isPending ? "Saving..." : "Confirm Offline"}
//                             </button>
//                         </div>
//                     </section>
//                 </div>
//             )}
//         </MainLayout>
//     );
// }

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiClock, FiCoffee, FiLogIn, FiLogOut, FiPhoneOff, FiPower, FiRefreshCw } from "react-icons/fi";
import { breakInEmployee, breakOutEmployee, getEmployeeAttendance, lunchBreakInEmployee, lunchBreakOutEmployee, reportEmployeeActivity, timeInEmployee, timeOutEmployee, type AttendanceRecord } from "../../api/attendance";
import { getAuthUser } from "../../api/authStorage";
import { getEmployeeSummary, normalizeEmployeeAvailabilityStatus, type Employee, type EmployeeAvailabilityStatus } from "../../api/employees";
import { getSystemSettings } from "../../api/systemSettings";
import {
    ATTENDANCE_TIME_ZONE,
    attendanceSlotTimeZone,
    formatAttendanceSlotKey,
    formatAttendanceSlotLabel,
    groupAttendanceRecordsBySlot,
    isAttendanceTimeInSource,
    isAttendanceTimeOutUndertime,
} from "../../lib/attendanceSlots";
import { buildOffPhoneAttendanceSessions, formatAttendanceDuration } from "../../lib/attendanceRecords";
import { formatDateInTimeZone, formatTimeInTimeZone } from "../../lib/dateTime";
import MainLayout from "../layout";

const attendanceQueryKey = (employeeId?: string) => ["employee-attendance", employeeId];
const REGULAR_BREAK_LIMIT_MS = 15 * 60 * 1000;
const LUNCH_BREAK_LIMIT_MS = 60 * 60 * 1000;


function formatAttendanceDateTime(value?: Date | string | null, timeZone = "Asia/Manila") {
    const date = formatDateInTimeZone(value, timeZone);
    const time = formatTimeInTimeZone(value, timeZone);
    const formatted = [date, time].filter(Boolean).join(", ");
    return formatted ? `${formatted} PH Time` : "";
}

function formatBreakTimer(milliseconds: number) {
    const safeMilliseconds = Math.max(0, milliseconds);
    const totalSeconds = Math.floor(safeMilliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function getRecordTime(record?: AttendanceRecord | null) {
    return record?.timeIn ? new Date(record.timeIn).getTime() : 0;
}

function getEmployeeStatusTime(employee?: Employee | null) {
    const employeeWithTimestamps = employee as (Employee & {
        availabilityStatusUpdatedAt?: Date | string | null;
        statusUpdatedAt?: Date | string | null;
        lastActivityAt?: Date | string | null;
        updatedAt?: Date | string | null;
    }) | null | undefined;

    const statusTime =
        employeeWithTimestamps?.availabilityStatusUpdatedAt ||
        employeeWithTimestamps?.statusUpdatedAt ||
        employeeWithTimestamps?.lastActivityAt ||
        employeeWithTimestamps?.updatedAt;

    return statusTime ? new Date(statusTime).getTime() : 0;
}

function isBreakSource(source?: AttendanceRecord["source"]) {
    return source === "Break Out" || source === "Break In" || source === "Lunch Break Out" || source === "Lunch Break In";
}

function getBreakLimitMs(source?: AttendanceRecord["source"]) {
    if (source === "Lunch Break Out" || source === "Lunch Break In") return LUNCH_BREAK_LIMIT_MS;
    if (source === "Break Out" || source === "Break In") return REGULAR_BREAK_LIMIT_MS;
    return 0;
}

const statusOrder: EmployeeAvailabilityStatus[] = ["ONLINE", "OFFLINE", "LUNCH", "BREAK", "OFF THE PHONE"];

const statusLabels: Record<EmployeeAvailabilityStatus, string> = {
    ONLINE: "ONLINE",
    OFFLINE: "OFFLINE",
    LUNCH: "LUNCH",
    BREAK: "Break",
    "OFF THE PHONE": "Off the Phone",
};

const statusButtonStyles: Record<EmployeeAvailabilityStatus, string> = {
    ONLINE: "border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-700",
    OFFLINE: "border-rose-500 bg-rose-600 text-white hover:bg-rose-700",
    LUNCH: "border-orange-500 bg-orange-500 text-white hover:bg-orange-600",
    BREAK: "border-amber-500 bg-amber-500 text-white hover:bg-amber-600",
    "OFF THE PHONE": "border-sky-500 bg-sky-600 text-white hover:bg-sky-700",
};

const statusIcon: Record<EmployeeAvailabilityStatus, typeof FiLogIn> = {
    ONLINE: FiLogIn,
    OFFLINE: FiPower,
    LUNCH: FiCoffee,
    BREAK: FiCoffee,
    "OFF THE PHONE": FiPhoneOff,
};

export default function AttendancePage() {
    const authUser = getAuthUser();
    const employee = authUser?.userType === "employee" ? authUser.user : null;
    const employeeId = employee?._id || "";
    const queryClient = useQueryClient();
    const [message, setMessage] = useState("");
    const [showOfflineConfirm, setShowOfflineConfirm] = useState(false);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [manualOffPhoneStartedAt, setManualOffPhoneStartedAt] = useState<number | null>(null);

    useEffect(() => {
        const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    const { data: attendance = [], isLoading, isFetching } = useQuery({
        queryKey: attendanceQueryKey(employeeId),
        queryFn: () => getEmployeeAttendance(employeeId),
        enabled: Boolean(employeeId),
    });
    const { data: systemSettings } = useQuery({
        queryKey: ["system-settings"],
        queryFn: getSystemSettings,
    });
    const { data: employeeProfile } = useQuery({
        queryKey: ["employee", employeeId],
        queryFn: () => getEmployeeSummary(employeeId),
        enabled: Boolean(employeeId),
    });

    const currentEmployee = employeeProfile || employee;
    const employeeAvailabilityStatus = normalizeEmployeeAvailabilityStatus(currentEmployee?.availabilityStatus);

    const attendanceSettings = useMemo(() => ({ ...systemSettings, attendanceTimeZone: ATTENDANCE_TIME_ZONE }), [systemSettings]);
    const attendanceTimeZone = attendanceSlotTimeZone(attendanceSettings);
    const recordsBySlot = useMemo(() => groupAttendanceRecordsBySlot(attendance, attendanceSettings), [attendance, attendanceSettings]);
    const latestTimeInRecord = attendance.find((record) => isAttendanceTimeInSource(record.source));
    const latestSlotKey = latestTimeInRecord ? formatAttendanceSlotKey(latestTimeInRecord.timeIn, attendanceSettings) : "";
    const nowSlotKey = formatAttendanceSlotKey(new Date(), attendanceSettings);
    const latestSlotRecords = latestSlotKey ? [...(recordsBySlot[latestSlotKey] || [])].sort((left, right) => new Date(right.timeIn).getTime() - new Date(left.timeIn).getTime()) : [];
    const latestSlotTimeIn = latestSlotRecords.find((record) => isAttendanceTimeInSource(record.source));
    const latestSlotTimeOut = latestSlotRecords.find((record) => record.source === "Logout" || record.source === "Time Out");
    const latestSlotHasOpenAttendance = Boolean(
        latestSlotTimeIn && (!latestSlotTimeOut || getRecordTime(latestSlotTimeIn) > getRecordTime(latestSlotTimeOut))
    );
    const actionSlotKey = latestSlotKey && latestSlotHasOpenAttendance ? latestSlotKey : nowSlotKey;
    const displaySlotKey = latestSlotKey || nowSlotKey;
    const actionSlotRecords = [...(recordsBySlot[actionSlotKey] || [])].sort((left, right) => new Date(right.timeIn).getTime() - new Date(left.timeIn).getTime());
    const slotRecords = [...(recordsBySlot[displaySlotKey] || [])].sort((left, right) => new Date(right.timeIn).getTime() - new Date(left.timeIn).getTime());
    const slotLabel = formatAttendanceSlotLabel(displaySlotKey);
    const latestRecord = slotRecords[0] || attendance[0];
    const actionTimeIn = actionSlotRecords.find((record) => isAttendanceTimeInSource(record.source));
    const actionTimeOut = actionSlotRecords.find((record) => record.source === "Logout" || record.source === "Time Out");
    const hasOpenAttendanceSlot = Boolean(
        actionTimeIn && (!actionTimeOut || getRecordTime(actionTimeIn) > getRecordTime(actionTimeOut))
    );
    const activeCycleStartedAt = hasOpenAttendanceSlot ? getRecordTime(actionTimeIn) : 0;
    const activeCycleRecords = activeCycleStartedAt
        ? actionSlotRecords.filter((record) => getRecordTime(record) >= activeCycleStartedAt)
        : [];
    const latestActionSource = activeCycleRecords[0]?.source;
    const hasLunchOut = activeCycleRecords.some((record) => record.source === "Lunch Break Out");
    const hasLunchIn = activeCycleRecords.some((record) => record.source === "Lunch Break In");
    const breakOutCount = activeCycleRecords.filter((record) => record.source === "Break Out").length;
    const breakInCount = activeCycleRecords.filter((record) => record.source === "Break In").length;
    const latestBreakOutRecord = activeCycleRecords.find((record) => record.source === "Break Out");
    const latestBreakOutTime = latestBreakOutRecord ? new Date(latestBreakOutRecord.timeIn).getTime() : 0;
    const hasBreakGapElapsed = !latestBreakOutTime || Date.now() - latestBreakOutTime >= 30 * 60 * 1000;
    const latestActionStatus: EmployeeAvailabilityStatus =
        latestActionSource === "Break Out"
            ? "BREAK"
            : latestActionSource === "Lunch Break Out"
                ? "LUNCH"
                : latestActionSource === "Off the Phone Out"
                    ? "OFF THE PHONE"
                    : latestActionSource === "Logout" || latestActionSource === "Time Out"
                        ? "OFFLINE"
                        : "ONLINE";
    const currentStatus: EmployeeAvailabilityStatus = hasOpenAttendanceSlot
        ? employeeAvailabilityStatus === "OFF THE PHONE"
            ? "OFF THE PHONE"
            : latestActionStatus
        : "OFFLINE";
    const isOnBreak = currentStatus === "BREAK" || latestActionSource === "Break Out";
    const isOnLunchBreak = currentStatus === "LUNCH" || latestActionSource === "Lunch Break Out";
    const activeBreakOutRecord = isOnBreak ? activeCycleRecords.find((record) => record.source === "Break Out") : null;
    const activeLunchOutRecord = isOnLunchBreak ? activeCycleRecords.find((record) => record.source === "Lunch Break Out") : null;
    const activeBreakRecord = activeBreakOutRecord || activeLunchOutRecord;
    const activeBreakLimitMs = getBreakLimitMs(activeBreakRecord?.source);
    const activeBreakLabel = activeBreakOutRecord ? "Break timer · 15 minutes" : activeLunchOutRecord ? "Lunch timer · 1 hour" : "";
    const activeBreakStartedAt = getRecordTime(activeBreakRecord);
    const activeBreakElapsedMs = activeBreakStartedAt ? nowMs - activeBreakStartedAt : 0;
    const activeBreakRemainingMs = activeBreakLimitMs ? activeBreakLimitMs - activeBreakElapsedMs : 0;
    const isActiveBreakOvertime = activeBreakLimitMs > 0 && activeBreakElapsedMs > activeBreakLimitMs;
    const offPhoneSessions = buildOffPhoneAttendanceSessions(slotRecords, nowMs);
    const activeOffPhoneSession = offPhoneSessions.find((session) => session.isOpen) || null;
    const activeOffPhoneStartedAt = currentStatus === "OFF THE PHONE"
        ? getRecordTime(activeOffPhoneSession?.startRecord) || manualOffPhoneStartedAt || getEmployeeStatusTime(currentEmployee) || getRecordTime(latestRecord)
        : 0;
    const activeOffPhoneElapsedMs = activeOffPhoneStartedAt ? nowMs - activeOffPhoneStartedAt : 0;
    const slotRecordsChronological = [...slotRecords].sort((left, right) => getRecordTime(left) - getRecordTime(right));

    const getBreakDurationMs = (record: AttendanceRecord) => {
        if (record.source === "Break Out" || record.source === "Lunch Break Out") {
            if (activeBreakRecord?._id === record._id) {
                return nowMs - getRecordTime(record);
            }

            return null;
        }

        if (record.source !== "Break In" && record.source !== "Lunch Break In") {
            return null;
        }

        const matchingOutSource = record.source === "Break In" ? "Break Out" : "Lunch Break Out";
        const recordTime = getRecordTime(record);
        const matchingOutRecord = [...slotRecordsChronological]
            .reverse()
            .find((slotRecord) => slotRecord.source === matchingOutSource && getRecordTime(slotRecord) <= recordTime);

        return matchingOutRecord ? recordTime - getRecordTime(matchingOutRecord) : null;
    };
    const canTimeIn = !hasOpenAttendanceSlot;
    const canTimeOut = hasOpenAttendanceSlot && currentStatus !== "BREAK" && currentStatus !== "LUNCH";
    const canBreakOut = hasOpenAttendanceSlot && currentStatus === "ONLINE" && breakOutCount === breakInCount && breakOutCount < 2 && hasBreakGapElapsed;
    const canBreakIn = isOnBreak && breakInCount < breakOutCount;
    const canLunchBreakOut = hasOpenAttendanceSlot && !hasLunchOut && currentStatus === "ONLINE";
    const canLunchBreakIn = isOnLunchBreak && !hasLunchIn;
    const canSetOnline = currentStatus === "OFFLINE"
        ? canTimeIn
        : currentStatus === "LUNCH"
            ? canLunchBreakIn
            : currentStatus === "BREAK"
                ? canBreakIn
                : currentStatus === "OFF THE PHONE" && hasOpenAttendanceSlot;
    const canSetOffline = currentStatus !== "OFFLINE" && canTimeOut;
    const canSetLunch = canLunchBreakOut;
    const canSetBreak = canBreakOut;
    const canSetOffPhone = currentStatus === "ONLINE" && hasOpenAttendanceSlot;
    const updateEmployeeStatusCache = (availabilityStatus: EmployeeAvailabilityStatus) => {
        queryClient.setQueryData<Employee | undefined>(["employee", employeeId], (current) =>
            current ? { ...current, availabilityStatus } : employee ? { ...employee, availabilityStatus } : current
        );
    };

    const updateAttendanceCache = (record: AttendanceRecord, availabilityStatus: EmployeeAvailabilityStatus) => {
        queryClient.setQueryData<AttendanceRecord[]>(attendanceQueryKey(employeeId), (current = []) => [record, ...current]);
        updateEmployeeStatusCache(availabilityStatus);
    };

    const timeInMutation = useMutation({
        mutationFn: () => timeInEmployee(employeeId),
        onSuccess: (record) => {
            updateAttendanceCache(record, "ONLINE");
            setMessage("Status changed to ONLINE.");
        },
        onError: () => setMessage("Unable to change status to ONLINE. Please try again."),
    });

    const timeOutMutation = useMutation({
        mutationFn: () => timeOutEmployee(employeeId),
        onSuccess: (record) => {
            updateAttendanceCache(record, "OFFLINE");
            queryClient.invalidateQueries({ queryKey: attendanceQueryKey(employeeId) });
            setShowOfflineConfirm(false);
            setMessage("Status changed to OFFLINE.");
        },
        onError: () => {
            setShowOfflineConfirm(false);
            setMessage("Unable to change status to OFFLINE. Please try again.");
        },
    });

    const breakOutMutation = useMutation({
        mutationFn: () => breakOutEmployee(employeeId),
        onSuccess: (record) => {
            updateAttendanceCache(record, "BREAK");
            setMessage("Status changed to Break.");
        },
        onError: () => setMessage("Unable to change status to Break. Please try again."),
    });

    const breakInMutation = useMutation({
        mutationFn: () => breakInEmployee(employeeId),
        onSuccess: (record) => {
            updateAttendanceCache(record, "ONLINE");
            setMessage("Status changed to ONLINE.");
        },
        onError: () => setMessage("Unable to change status to ONLINE. Please try again."),
    });

    const lunchBreakOutMutation = useMutation({
        mutationFn: () => lunchBreakOutEmployee(employeeId),
        onSuccess: (record) => {
            updateAttendanceCache(record, "LUNCH");
            setMessage("Status changed to LUNCH.");
        },
        onError: () => setMessage("Unable to change status to LUNCH. Please try again."),
    });

    const lunchBreakInMutation = useMutation({
        mutationFn: () => lunchBreakInEmployee(employeeId),
        onSuccess: (record) => {
            updateAttendanceCache(record, "ONLINE");
            setMessage("Status changed to ONLINE.");
        },
        onError: () => setMessage("Unable to change status to ONLINE. Please try again."),
    });

    const activityStatusMutation = useMutation({
        mutationFn: (status: Extract<EmployeeAvailabilityStatus, "ONLINE" | "OFF THE PHONE">) =>
            reportEmployeeActivity(employeeId, status === "OFF THE PHONE" ? "idle" : "active", {
                reason: status === "OFF THE PHONE" ? "manual-off-the-phone" : "manual-online",
            }),
        onSuccess: (result, status) => {
            const availabilityStatus = normalizeEmployeeAvailabilityStatus(result.availabilityStatus);
            updateEmployeeStatusCache(availabilityStatus);
            if (result.attendanceRecords?.length) {
                queryClient.setQueryData<AttendanceRecord[]>(attendanceQueryKey(employeeId), (current = []) => [
                    ...result.attendanceRecords!,
                    ...current,
                ]);
            }
            queryClient.invalidateQueries({ queryKey: attendanceQueryKey(employeeId) });
            setManualOffPhoneStartedAt(status === "OFF THE PHONE" ? Date.now() : null);
            setMessage(`Status changed to ${statusLabels[availabilityStatus]}.`);
        },
        onError: () => setMessage("Unable to change status. Please try again."),
    });

    const isSaving =
        timeInMutation.isPending ||
        timeOutMutation.isPending ||
        breakOutMutation.isPending ||
        breakInMutation.isPending ||
        lunchBreakOutMutation.isPending ||
        lunchBreakInMutation.isPending ||
        activityStatusMutation.isPending;

    const sourceLabel = (source?: AttendanceRecord["source"]) => {
        if (source === "Login" || source === "Time In" || source === "Break In" || source === "Lunch Break In" || source === "Off the Phone In") return statusLabels.ONLINE;
        if (source === "Logout" || source === "Time Out") return statusLabels.OFFLINE;
        if (source === "Break Out") return statusLabels.BREAK;
        if (source === "Lunch Break Out") return statusLabels.LUNCH;
        if (source === "Off the Phone Out") return statusLabels["OFF THE PHONE"];
        return "No attendance yet";
    };

    const statusDisabled = (status: EmployeeAvailabilityStatus) => {
        if (!employeeId || isSaving || status === currentStatus) return true;
        if (status === "ONLINE") return !canSetOnline;
        if (status === "OFFLINE") return !canSetOffline;
        if (status === "LUNCH") return !canSetLunch;
        if (status === "BREAK") return !canSetBreak;
        if (status === "OFF THE PHONE") return !canSetOffPhone;
        return true;
    };

    const handleStatusChange = (status: EmployeeAvailabilityStatus) => {
        setMessage("");

        if (status === "ONLINE") {
            if (currentStatus === "OFFLINE") {
                timeInMutation.mutate();
                return;
            }
            if (currentStatus === "LUNCH") {
                lunchBreakInMutation.mutate();
                return;
            }
            if (currentStatus === "BREAK") {
                breakInMutation.mutate();
                return;
            }
            if (currentStatus === "OFF THE PHONE") {
                activityStatusMutation.mutate("ONLINE");
            }
            return;
        }

        if (status === "OFFLINE") {
            setShowOfflineConfirm(true);
            return;
        }

        if (status === "LUNCH") {
            lunchBreakOutMutation.mutate();
            return;
        }

        if (status === "BREAK") {
            breakOutMutation.mutate();
            return;
        }

        if (status === "OFF THE PHONE") {
            activityStatusMutation.mutate("OFF THE PHONE");
        }
    };

    return (
        <MainLayout>
            <section className="mx-auto flex w-full max-w-6xl flex-col gap-5 text-slate-950">
                <header className="rounded-xl border border-[#b79cff] bg-[#550fdf12] p-6 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Employee Workspace</p>
                    <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
                        <div>
                            <h1 className="text-2xl font-semibold text-slate-950">Attendance</h1>
                            <p className="mt-1 text-sm text-slate-600">Set the current work status for {currentEmployee?.name || "employee"}.</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => queryClient.invalidateQueries({ queryKey: attendanceQueryKey(employeeId) })}
                            className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#9b8ab8] bg-white px-4 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-[#f4efff]"
                        >
                            <FiRefreshCw className={isFetching ? "animate-spin" : ""} />
                            Refresh
                        </button>
                    </div>
                </header>

                <div className="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
                    <section className="rounded-xl border border-[#b79cff] bg-[#f100ff30] p-5 shadow-sm">
                        <div className="flex items-center gap-3">
                            <div className="flex size-11 items-center justify-center rounded-xl bg-[#5f27cd] text-white">
                                <FiClock className="size-5" />
                            </div>
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Current Status</p>
                                <p className="text-xl font-semibold text-slate-950">{statusLabels[currentStatus]}</p>
                            </div>
                        </div>

                        <div className="mt-5 rounded-lg border border-[#b7a7d3] bg-[#e8def6] p-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Latest activity</p>
                            <p className="mt-2 text-sm font-semibold text-slate-950">
                                {sourceLabel(latestRecord?.source)}
                            </p>
                            <p className="mt-1 text-sm text-slate-700">{latestRecord ? formatAttendanceDateTime(latestRecord.timeIn, attendanceTimeZone) : "Click ONLINE to start your attendance slot."}</p>
                        </div>

                        {activeBreakRecord && (
                            <div
                                className={[
                                    "mt-4 rounded-lg border p-4",
                                    isActiveBreakOvertime ? "border-rose-300 bg-rose-50" : "border-amber-300 bg-amber-50",
                                ].join(" ")}
                            >
                                <p className={["text-xs font-semibold uppercase tracking-[0.16em]", isActiveBreakOvertime ? "text-rose-700" : "text-amber-700"].join(" ")}>
                                    {activeBreakLabel}
                                </p>
                                <p className="mt-2 font-mono text-3xl font-bold text-slate-950">
                                    {isActiveBreakOvertime ? `Overtime ${formatBreakTimer(Math.abs(activeBreakRemainingMs))}` : formatBreakTimer(activeBreakRemainingMs)}
                                </p>
                                <p className="mt-1 text-xs text-slate-700">
                                    Elapsed {formatBreakTimer(activeBreakElapsedMs)} · Started {formatAttendanceDateTime(activeBreakRecord.timeIn, attendanceTimeZone)}
                                </p>
                            </div>
                        )}

                        {currentStatus === "OFF THE PHONE" && activeOffPhoneStartedAt > 0 && (
                            <div className="mt-4 rounded-lg border border-sky-300 bg-sky-50 p-4">
                                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">
                                    Off the Phone timer · no time limit
                                </p>
                                <p className="mt-2 font-mono text-3xl font-bold text-slate-950">
                                    {formatBreakTimer(activeOffPhoneElapsedMs)}
                                </p>
                                <p className="mt-1 text-xs text-slate-700">
                                    Elapsed · Started {formatAttendanceDateTime(new Date(activeOffPhoneStartedAt), attendanceTimeZone)}
                                </p>
                            </div>
                        )}

                        {message && (
                            <p className="mt-4 rounded-lg border border-[#7ccfbf] bg-[#c8f7ef] px-3 py-2 text-sm font-medium text-slate-950">{message}</p>
                        )}

                        <p className="mt-5 rounded-lg border border-[#b7a7d3] bg-white/60 px-3 py-2 text-xs font-semibold text-slate-700">
                            Use ONLINE to time in or return from LUNCH, Break, or Off the Phone. Break is limited to 15 minutes. Lunch is limited to 1 hour. Off the Phone has no time limit.
                        </p>

                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            {statusOrder.map((status) => {
                                const Icon = statusIcon[status];
                                const isActive = status === currentStatus;
                                const disabled = statusDisabled(status);

                                return (
                                    <button
                                        key={status}
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => handleStatusChange(status)}
                                        className={[
                                            "inline-flex h-12 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold shadow-lg transition disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none",
                                            isActive ? "ring-2 ring-slate-950/20 ring-offset-2" : "",
                                            statusButtonStyles[status],
                                        ].join(" ")}
                                    >
                                        <Icon />
                                        {isSaving && !disabled ? "Saving..." : statusLabels[status]}
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    <section className="rounded-xl border border-[#8fbfff] bg-[#dce9fb] p-5 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Attendance Slot</p>
                                <h2 className="text-xl font-semibold text-slate-950">{slotLabel || "Current slot"} · {slotRecords.length} record{slotRecords.length === 1 ? "" : "s"}</h2>
                            </div>
                            <div className="flex flex-wrap justify-end gap-2">
                                <p className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700">PH Time</p>
                                <p className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700">{attendance.length} total</p>
                            </div>
                        </div>

                        <div className="content-scroll mt-4 max-h-[28rem] space-y-3 overflow-y-auto pr-1">
                            {isLoading && <p className="rounded-lg border border-[#b7a7d3] bg-white/70 p-4 text-sm text-slate-700">Loading attendance...</p>}
                            {!isLoading && attendance.length === 0 && (
                                <p className="rounded-lg border border-[#b7a7d3] bg-white/70 p-4 text-sm text-slate-700">No attendance records yet.</p>
                            )}
                            {!isLoading && attendance.length > 0 && slotRecords.length === 0 && (
                                <p className="rounded-lg border border-[#b7a7d3] bg-white/70 p-4 text-sm text-slate-700">No records in this attendance slot yet.</p>
                            )}
                            {slotRecords.map((record) => {
                                const breakDurationMs = getBreakDurationMs(record);
                                const breakLimitMs = getBreakLimitMs(record.source);
                                const breakRemainingMs = typeof breakDurationMs === "number" ? breakLimitMs - breakDurationMs : 0;
                                const isBreakOvertime = breakLimitMs > 0 && typeof breakDurationMs === "number" && breakDurationMs > breakLimitMs;
                                const offPhoneSession = offPhoneSessions.find((session) =>
                                    session.endRecord?._id === record._id || (session.isOpen && session.startRecord._id === record._id)
                                );
                                const isUnderTime = isAttendanceTimeOutUndertime(record, attendanceSettings);
                                const displayedAttendanceStatus = record.attendanceStatus || (isUnderTime ? "Undertime" : "");

                                return (
                                    <article key={record._id} className="flex items-center justify-between gap-4 rounded-lg border border-[#9bbde8] bg-white/75 p-4 shadow-sm">
                                        <div className="flex items-center gap-3">
                                            <span
                                                className={[
                                                    "flex size-9 items-center justify-center rounded-lg text-white",
                                                    record.source === "Off the Phone Out"
                                                        ? "bg-sky-600"
                                                        : record.source === "Login" || record.source === "Time In" || record.source === "Break In" || record.source === "Lunch Break In" || record.source === "Off the Phone In"
                                                        ? "bg-[#10ac84]"
                                                        : record.source === "Break Out" || record.source === "Lunch Break Out"
                                                            ? "bg-[#f59e0b]"
                                                            : "bg-[#ee5253]",
                                                ].join(" ")}
                                            >
                                                {record.source === "Off the Phone Out"
                                                    ? <FiPhoneOff />
                                                    : record.source === "Break Out" || record.source === "Lunch Break Out"
                                                        ? <FiCoffee />
                                                        : record.source === "Logout" || record.source === "Time Out"
                                                            ? <FiLogOut />
                                                            : <FiLogIn />}
                                            </span>
                                            <div>
                                                <p className="text-sm font-semibold text-slate-950">{sourceLabel(record.source)}</p>
                                                <p className="text-xs text-slate-600">{formatAttendanceDateTime(record.timeIn, attendanceTimeZone)}</p>
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap justify-end gap-2">
                                            {typeof breakDurationMs === "number" && isBreakSource(record.source) && (
                                                <span
                                                    className={[
                                                        "rounded-full px-3 py-1 font-mono text-xs font-semibold",
                                                        isBreakOvertime ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800",
                                                    ].join(" ")}
                                                >
                                                    {record.source === "Break Out" || record.source === "Lunch Break Out"
                                                        ? isBreakOvertime
                                                            ? `Overtime ${formatBreakTimer(Math.abs(breakRemainingMs))}`
                                                            : `Remaining ${formatBreakTimer(breakRemainingMs)}`
                                                        : `Duration ${formatBreakTimer(breakDurationMs)}`}
                                                </span>
                                            )}
                                            {offPhoneSession && (
                                                <span className="rounded-full bg-sky-100 px-3 py-1 font-mono text-xs font-semibold text-sky-700">
                                                    {offPhoneSession.isOpen ? "Running " : "Duration "}
                                                    {formatAttendanceDuration(offPhoneSession.durationMs)}
                                                </span>
                                            )}
                                            {displayedAttendanceStatus && (
                                                <span className={["rounded-full px-3 py-1 text-xs font-semibold", displayedAttendanceStatus === "Late" ? "bg-red-100 text-red-700" : displayedAttendanceStatus === "Undertime" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"].join(" ")}>
                                                    {displayedAttendanceStatus}
                                                </span>
                                            )}
                                            <span className="rounded-full bg-[#f4efff] px-3 py-1 text-xs font-semibold text-slate-700">{slotLabel || formatDateInTimeZone(record.timeIn, attendanceTimeZone)}</span>
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    </section>
                </div>
            </section>

            {showOfflineConfirm && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
                    role="presentation"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget && !timeOutMutation.isPending) {
                            setShowOfflineConfirm(false);
                        }
                    }}
                >
                    <section
                        className="w-full max-w-md overflow-hidden rounded-xl border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="offline-confirm-title"
                    >
                        <div className="border-b border-slate-200 px-5 py-4">
                            <div className="flex items-start gap-3">
                                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
                                    <FiPower className="size-5" aria-hidden="true" />
                                </span>
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Confirm status change</p>
                                    <h2 id="offline-confirm-title" className="mt-1 text-lg font-semibold text-slate-950">Go offline?</h2>
                                    <p className="mt-2 text-sm leading-6 text-slate-600">
                                        This will time you out and set your current status to OFFLINE.
                                    </p>
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-col-reverse gap-2 bg-slate-50 px-5 py-4 sm:flex-row sm:justify-end">
                            <button
                                type="button"
                                className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                                onClick={() => setShowOfflineConfirm(false)}
                                disabled={timeOutMutation.isPending}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="inline-flex h-10 items-center justify-center rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
                                onClick={() => timeOutMutation.mutate()}
                                disabled={timeOutMutation.isPending}
                            >
                                {timeOutMutation.isPending ? "Saving..." : "Confirm Offline"}
                            </button>
                        </div>
                    </section>
                </div>
            )}
        </MainLayout>
    );
}
