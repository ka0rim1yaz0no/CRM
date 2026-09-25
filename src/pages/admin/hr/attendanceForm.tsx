import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { FiArrowLeft, FiCalendar, FiCheck, FiChevronDown, FiClock, FiSave, FiUser, FiUsers } from "react-icons/fi";
import AdminLayout from "../adminLayout";
import { createEmployeeAttendance, getEmployeeAttendance, updateEmployeeAttendance, type AttendanceInput, type AttendanceRecord } from "../../../api/attendance";
import { getEmployees } from "../../../api/employees";
import { getSystemSettings, type SystemSettings } from "../../../api/systemSettings";
import {
    ATTENDANCE_TIME_ZONE,
    attendanceSlotShiftEnd,
    attendanceSlotShiftStart,
    attendanceSlotTimeZone,
    formatAttendanceSlotKey,
    formatAttendanceSlotLabel,
    groupAttendanceRecordsBySlot,
    isWeekendAttendanceSlotKey,
} from "../../../lib/attendanceSlots";
import { buildOffPhoneAttendanceSessions } from "../../../lib/attendanceRecords";
import { formatTimeInTimeZone } from "../../../lib/dateTime";

const emptyAttendanceShiftForm: AttendanceShiftForm = {
    timeIn: "",
    timeOut: "",
    firstBreakOut: "",
    firstBreakIn: "",
    lunchOut: "",
    lunchIn: "",
    secondBreakOut: "",
    secondBreakIn: "",
};

const attendanceFields: Array<{ label: string; field: keyof AttendanceShiftForm }> = [
    { label: "Time In", field: "timeIn" },
    { label: "Time Out", field: "timeOut" },
    { label: "1st Break Out", field: "firstBreakOut" },
    { label: "1st Break In", field: "firstBreakIn" },
    { label: "Lunch Out", field: "lunchOut" },
    { label: "Lunch In", field: "lunchIn" },
    { label: "2nd Break Out", field: "secondBreakOut" },
    { label: "2nd Break In", field: "secondBreakIn" },
];

const attendanceRecordKeyByField: Record<
    keyof AttendanceShiftForm,
    keyof Pick<
        AttendanceHistoryRow,
        "timeInRecord" | "timeOutRecord" | "firstBreakOutRecord" | "firstBreakInRecord" | "lunchOutRecord" | "lunchInRecord" | "secondBreakOutRecord" | "secondBreakInRecord"
    >
> = {
    timeIn: "timeInRecord",
    timeOut: "timeOutRecord",
    firstBreakOut: "firstBreakOutRecord",
    firstBreakIn: "firstBreakInRecord",
    lunchOut: "lunchOutRecord",
    lunchIn: "lunchInRecord",
    secondBreakOut: "secondBreakOutRecord",
    secondBreakIn: "secondBreakInRecord",
};

const attendanceSources: Record<keyof AttendanceShiftForm, AttendanceRecord["source"]> = {
    timeIn: "Time In",
    timeOut: "Time Out",
    firstBreakOut: "Break Out",
    firstBreakIn: "Break In",
    lunchOut: "Lunch Break Out",
    lunchIn: "Lunch Break In",
    secondBreakOut: "Break Out",
    secondBreakIn: "Break In",
};

type AttendanceShiftForm = {
    timeIn: string;
    timeOut: string;
    firstBreakOut: string;
    firstBreakIn: string;
    lunchOut: string;
    lunchIn: string;
    secondBreakOut: string;
    secondBreakIn: string;
};

type AttendanceHistoryRow = {
    dateKey: string;
    date: string;
    timeInOut: string;
    timeInStatus: AttendanceTimeInStatus;
    firstBreakInOut: string;
    lunchInOut: string;
    secondBreakInOut: string;
    offPhoneInOut: string;
    offPhoneDuration: string;
    duration: string;
    overtime: string;
    primaryRecord?: AttendanceRecord;
    timeInRecord?: AttendanceRecord;
    timeOutRecord?: AttendanceRecord;
    firstBreakOutRecord?: AttendanceRecord;
    firstBreakInRecord?: AttendanceRecord;
    lunchOutRecord?: AttendanceRecord;
    lunchInRecord?: AttendanceRecord;
    secondBreakOutRecord?: AttendanceRecord;
    secondBreakInRecord?: AttendanceRecord;
    rawRecords: AttendanceRecord[];
};

type AttendanceTimeInStatus = "Early" | "On time" | "Late" | "No time in";

export default function AdminAttendanceForm() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { employeeId: routeEmployeeId = "", dateKey = "" } = useParams<{ employeeId?: string; dateKey?: string }>();
    const [searchParams] = useSearchParams();
    const isEditing = Boolean(routeEmployeeId && dateKey);
    const [selectedEmployeeId, setSelectedEmployeeId] = useState(routeEmployeeId || searchParams.get("employeeId") || "");
    const [attendanceShiftForm, setAttendanceShiftForm] = useState<AttendanceShiftForm>(emptyAttendanceShiftForm);
    const [formError, setFormError] = useState("");
    const [isEmployeePickerOpen, setIsEmployeePickerOpen] = useState(false);
    const employeePickerRef = useRef<HTMLDivElement | null>(null);

    const { data: employees = [], isLoading: areEmployeesLoading } = useQuery({
        queryKey: ["employees"],
        queryFn: getEmployees,
    });
    const { data: systemSettings } = useQuery({
        queryKey: ["system-settings"],
        queryFn: getSystemSettings,
    });
    const attendanceSettings = useMemo(() => attendancePhTimeSettings(systemSettings), [systemSettings]);
    const activeEmployees = useMemo(() => employees.filter((employee) => employee.status !== "Archived"), [employees]);
    const selectedEmployee = useMemo(
        () => activeEmployees.find((employee) => employee._id === selectedEmployeeId) || employees.find((employee) => employee._id === selectedEmployeeId),
        [activeEmployees, employees, selectedEmployeeId]
    );
    const { data: employeeAttendance = [], isLoading: isAttendanceLoading } = useQuery({
        queryKey: ["employee-attendance", selectedEmployeeId],
        queryFn: () => getEmployeeAttendance(selectedEmployeeId),
        enabled: Boolean(selectedEmployeeId),
    });
    const attendanceRows = useMemo(
        () => buildAttendanceHistoryRows(employeeAttendance, attendanceSettings),
        [attendanceSettings, employeeAttendance]
    );
    const editingRow = useMemo(
        () => (dateKey ? attendanceRows.find((row) => row.dateKey === dateKey) : undefined),
        [attendanceRows, dateKey]
    );

    const saveAttendanceMutation = useMutation({
        mutationFn: async () => {
            const employeeId = routeEmployeeId || selectedEmployeeId;
            if (!employeeId) throw new Error("Select an employee before saving attendance.");

            const filledEntries = attendanceFields.filter(({ field }) => attendanceShiftForm[field].trim());
            if (!filledEntries.length) throw new Error("Add at least one attendance time.");

            const parsedEntries = filledEntries.map(({ field }) => {
                const parsed = parseDateTimeInputInTimeZone(attendanceShiftForm[field], ATTENDANCE_TIME_ZONE);
                if (!parsed) return null;
                const slotKey = formatAttendanceSlotKey(parsed, attendanceSettings);
                return { field, source: attendanceSources[field], parsed, slotKey };
            });

            if (parsedEntries.some((entry) => !entry)) {
                throw new Error("Check the date and time values before saving.");
            }

            const validEntries = parsedEntries.filter(Boolean) as Array<{ field: keyof AttendanceShiftForm; source: AttendanceRecord["source"]; parsed: Date; slotKey: string }>;
            const rowsBySlot = new Map(attendanceRows.map((row) => [row.dateKey, row]));
            const formSlotKey = validEntries.find((entry) => entry.field === "timeIn")?.slotKey || validEntries[0]?.slotKey || "";
            const updates = validEntries.map(({ field, source, parsed, slotKey }) => {
                const existingRecord = isEditing
                    ? editingRow?.[attendanceRecordKeyByField[field]]
                    : rowsBySlot.get(formSlotKey || slotKey)?.[attendanceRecordKeyByField[field]];
                const attendance: AttendanceInput = { source, timeIn: parsed.toISOString() };

                return existingRecord
                    ? updateEmployeeAttendance(employeeId, existingRecord._id, attendance)
                    : createEmployeeAttendance(employeeId, attendance);
            });

            await Promise.all(updates);
        },
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["employee-attendance"] });
            navigate("/admin/hr?tab=attendance");
        },
        onError: (error) => {
            setFormError(error instanceof Error ? error.message : "Unable to save attendance.");
        },
    });

    useEffect(() => {
        if (routeEmployeeId) {
            setSelectedEmployeeId(routeEmployeeId);
        }
    }, [routeEmployeeId]);

    useEffect(() => {
        setFormError("");
    }, [attendanceShiftForm, selectedEmployeeId]);

    useEffect(() => {
        if (!isEmployeePickerOpen) return;

        const handlePointerDown = (event: MouseEvent) => {
            if (!employeePickerRef.current?.contains(event.target as Node)) {
                setIsEmployeePickerOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setIsEmployeePickerOpen(false);
            }
        };

        document.addEventListener("mousedown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("mousedown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [isEmployeePickerOpen]);

    useEffect(() => {
        if (!isEditing) {
            setAttendanceShiftForm(emptyAttendanceShiftForm);
            return;
        }
        if (!editingRow) return;

        setAttendanceShiftForm({
            timeIn: formatDateTimeInputInTimeZone(editingRow.timeInRecord?.timeIn),
            timeOut: formatDateTimeInputInTimeZone(editingRow.timeOutRecord?.timeIn),
            firstBreakOut: formatDateTimeInputInTimeZone(editingRow.firstBreakOutRecord?.timeIn),
            firstBreakIn: formatDateTimeInputInTimeZone(editingRow.firstBreakInRecord?.timeIn),
            lunchOut: formatDateTimeInputInTimeZone(editingRow.lunchOutRecord?.timeIn),
            lunchIn: formatDateTimeInputInTimeZone(editingRow.lunchInRecord?.timeIn),
            secondBreakOut: formatDateTimeInputInTimeZone(editingRow.secondBreakOutRecord?.timeIn),
            secondBreakIn: formatDateTimeInputInTimeZone(editingRow.secondBreakInRecord?.timeIn),
        });
    }, [editingRow, isEditing]);

    const latestRow = attendanceRows[0];
    const visibleRows = attendanceRows.slice(0, 12);
    const formTitle = isEditing ? "Edit Attendance" : "Add Attendance";
    const canSave = Boolean((routeEmployeeId || selectedEmployeeId) && (!isEditing || editingRow));

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setFormError("");
        saveAttendanceMutation.mutate();
    };

    return (
        <AdminLayout>
            <section className="min-h-[calc(100vh-8.5rem)]">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-violet-200 bg-white px-5 py-4 shadow-xl shadow-violet-950/10">
                    <div>
                        <Link className="inline-flex items-center gap-2 text-sm font-semibold !text-slate-600 transition hover:!text-slate-950" to="/admin/hr?tab=attendance">
                            <FiArrowLeft className="size-4" aria-hidden="true" />
                            Back to attendance
                        </Link>
                        <h2 className="mt-3 text-2xl font-semibold !text-slate-950">{formTitle}</h2>
                        <p className="mt-1 text-sm !text-slate-600">Manual attendance entries use PH attendance slots.</p>
                    </div>
                    <Link className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold !text-slate-700 transition hover:bg-slate-50 hover:!text-slate-950" to="/admin/hr?tab=attendance">
                        Cancel
                    </Link>
                </div>

                <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(30rem,1.05fr)_minmax(0,0.95fr)]">
                    <section className="order-2 overflow-hidden rounded-lg border border-violet-200 bg-white shadow-xl shadow-violet-950/10">
                        <div className="border-b border-slate-200 bg-violet-50 px-5 py-4">
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.16em] !text-violet-600">Employee Attendance</p>
                                    <h3 className="mt-1 text-lg font-semibold !text-slate-950">{selectedEmployee?.name || "No employee selected"}</h3>
                                </div>
                                <span className="rounded-full border border-violet-200 bg-white px-3 py-1 text-xs font-bold !text-violet-700">{attendanceRows.length} slots</span>
                            </div>
                            {selectedEmployee && (
                                <p className="mt-2 text-sm !text-slate-600">
                                    {[selectedEmployee.team || "Unassigned", selectedEmployee.role || "-", selectedEmployee.employeeCode].filter(Boolean).join(" · ")}
                                </p>
                            )}
                        </div>

                        <div className="grid gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
                            <SummaryTile label="Latest Slot" value={latestRow?.date || "-"} icon={FiCalendar} />
                            <SummaryTile label="Status" value={latestRow?.timeInStatus || "-"} icon={FiCheck} />
                            <SummaryTile label="Duration" value={latestRow?.duration || "-"} icon={FiClock} />
                        </div>

                        <div className="content-scroll max-h-[34rem] overflow-y-auto p-4">
                            {!selectedEmployeeId && (
                                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-sm font-semibold !text-slate-500">
                                    No employee selected.
                                </div>
                            )}
                            {selectedEmployeeId && isAttendanceLoading && (
                                <div className="rounded-lg border border-slate-200 bg-slate-50 p-5 text-sm font-semibold !text-slate-500">Loading attendance...</div>
                            )}
                            {selectedEmployeeId && !isAttendanceLoading && !visibleRows.length && (
                                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-sm font-semibold !text-slate-500">No attendance records yet.</div>
                            )}
                            <div className="grid gap-3">
                                {visibleRows.map((row) => (
                                    <article key={row.dateKey} className={["rounded-lg border bg-white p-4 shadow-sm", row.dateKey === dateKey ? "border-violet-300 ring-2 ring-violet-100" : "border-slate-200"].join(" ")}>
                                        <div className="flex flex-wrap items-start justify-between gap-2">
                                            <div>
                                                <p className="text-sm font-semibold !text-slate-950">{row.date}</p>
                                                <p className="mt-1 text-xs !text-slate-500">{row.rawRecords.length} attendance record{row.rawRecords.length === 1 ? "" : "s"}</p>
                                            </div>
                                            <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${timeInStatusClass(row.timeInStatus)}`}>{row.timeInStatus}</span>
                                        </div>
                                        <div className="mt-3 grid gap-2 text-xs !text-slate-600 sm:grid-cols-2">
                                            <AttendancePair label="Time" value={row.timeInOut} />
                                            <AttendancePair label="Break 1" value={row.firstBreakInOut} />
                                            <AttendancePair label="Lunch" value={row.lunchInOut} />
                                            <AttendancePair label="Break 2" value={row.secondBreakInOut} />
                                            <AttendancePair label="Off the Phone" value={row.offPhoneInOut} />
                                        </div>
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold !text-slate-700">Duration {row.duration}</span>
                                            <span className="rounded-md bg-violet-50 px-2.5 py-1 text-xs font-semibold !text-violet-700">OT {row.overtime}</span>
                                            {row.offPhoneDuration !== "-" && (
                                                <span className="rounded-md bg-sky-50 px-2.5 py-1 text-xs font-semibold !text-sky-700">Off Phone {row.offPhoneDuration}</span>
                                            )}
                                        </div>
                                    </article>
                                ))}
                            </div>
                        </div>
                    </section>

                    <form className="order-1 overflow-hidden rounded-lg border border-violet-200 bg-white shadow-xl shadow-violet-950/10" onSubmit={handleSubmit}>
                        <div className="border-b border-slate-200 px-5 py-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] !text-violet-600">Attendance</p>
                            <h3 className="mt-1 text-lg font-semibold !text-slate-950">{formTitle}</h3>
                        </div>

                        <div className="grid gap-5 p-5">
                            <label>
                                <span className="text-xs font-semibold uppercase tracking-[0.14em] !text-slate-500">Employee</span>
                                <div ref={employeePickerRef} className="relative mt-2">
                                    <button
                                        className="flex h-12 w-full items-center gap-3 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm font-semibold !text-slate-950 outline-none transition hover:border-violet-300 hover:bg-violet-50/40 focus:border-violet-500 focus:ring-2 focus:ring-violet-200 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:!text-slate-500"
                                        type="button"
                                        aria-expanded={isEmployeePickerOpen}
                                        aria-haspopup="listbox"
                                        disabled={isEditing || areEmployeesLoading}
                                        onClick={() => setIsEmployeePickerOpen((current) => !current)}
                                    >
                                        <FiUser className="size-4 shrink-0 !text-violet-600" aria-hidden="true" />
                                        <span className="min-w-0 flex-1 truncate">{areEmployeesLoading ? "Loading employees..." : selectedEmployee?.name || "Select employee"}</span>
                                        <FiChevronDown className={["size-4 shrink-0 !text-slate-500 transition", isEmployeePickerOpen ? "rotate-180" : ""].join(" ")} aria-hidden="true" />
                                    </button>

                                    {isEmployeePickerOpen && (
                                        <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-30 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl shadow-slate-950/20 ring-1 ring-violet-200/60">
                                            <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
                                                <p className="text-xs font-bold uppercase tracking-[0.14em] !text-slate-500">Select employee</p>
                                            </div>
                                            <div className="max-h-64 overflow-y-auto p-1 [scrollbar-color:#8b5cf6_#f1f5f9] [scrollbar-width:thin]" role="listbox">
                                                {activeEmployees.map((employee) => {
                                                    const isSelected = employee._id === selectedEmployeeId;

                                                    return (
                                                        <button
                                                            key={employee._id}
                                                            className={[
                                                                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition",
                                                                isSelected ? "bg-violet-600 !text-white shadow-sm shadow-violet-500/20" : "!text-slate-700 hover:bg-violet-50 hover:!text-slate-950",
                                                            ].join(" ")}
                                                            type="button"
                                                            role="option"
                                                            aria-selected={isSelected}
                                                            onClick={() => {
                                                                setSelectedEmployeeId(employee._id);
                                                                setIsEmployeePickerOpen(false);
                                                            }}
                                                        >
                                                            <span className={["flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold", isSelected ? "bg-white/20 !text-white" : "bg-violet-100 !text-violet-700"].join(" ")}>
                                                                {employeeInitials(employee.name)}
                                                            </span>
                                                            <span className="min-w-0 flex-1">
                                                                <span className="block truncate font-semibold">{employee.name}</span>
                                                                <span className={["mt-0.5 block truncate text-xs", isSelected ? "!text-violet-100" : "!text-slate-500"].join(" ")}>
                                                                    {[employee.team || "Unassigned", employee.role || "-", employee.employeeCode].filter(Boolean).join(" · ")}
                                                                </span>
                                                            </span>
                                                            {isSelected && <FiCheck className="size-4 shrink-0 !text-white" aria-hidden="true" />}
                                                        </button>
                                                    );
                                                })}
                                                {!activeEmployees.length && (
                                                    <p className="px-3 py-3 text-sm font-semibold !text-slate-500">No employees available.</p>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </label>

                            <div className="grid gap-4 md:grid-cols-2">
                                {attendanceFields.map(({ label, field }) => (
                                    <label key={field}>
                                        <span className="text-xs font-semibold uppercase tracking-[0.14em] !text-slate-500">{label}</span>
                                        <input
                                            className="mt-2 h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold !text-slate-950 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-200"
                                            type="datetime-local"
                                            value={attendanceShiftForm[field]}
                                            onChange={(event) => setAttendanceShiftForm((form) => ({ ...form, [field]: event.target.value }))}
                                        />
                                    </label>
                                ))}
                            </div>

                            {formError && (
                                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{formError}</p>
                            )}

                            {isEditing && selectedEmployeeId && !isAttendanceLoading && !editingRow && (
                                <p className="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm font-semibold text-yellow-800">Attendance record not found for this date.</p>
                            )}
                        </div>

                        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-4">
                            <Link className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold !text-slate-700 transition hover:bg-slate-50" to="/admin/hr?tab=attendance">
                                Cancel
                            </Link>
                            <button
                                className="inline-flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold !text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                                type="submit"
                                disabled={!canSave || saveAttendanceMutation.isPending}
                            >
                                <FiSave className="size-4" aria-hidden="true" />
                                {saveAttendanceMutation.isPending ? "Saving..." : isEditing ? "Save Attendance" : "Add Attendance"}
                            </button>
                        </div>
                    </form>
                </div>
            </section>
        </AdminLayout>
    );
}

function SummaryTile({ label, value, icon: Icon }: { label: string; value: string; icon: typeof FiUsers }) {
    return (
        <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-lg bg-violet-100 !text-violet-700">
                    <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                    <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] !text-slate-500">{label}</p>
                    <p className="mt-1 truncate text-sm font-semibold !text-slate-950">{value}</p>
                </span>
            </div>
        </article>
    );
}

function AttendancePair({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.12em] !text-slate-500">{label}</p>
            <p className="mt-1 whitespace-nowrap text-xs font-semibold !text-slate-800">{value}</p>
        </div>
    );
}

function employeeInitials(name = "") {
    return name
        .split(" ")
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
}

function attendancePhTimeSettings(settings?: SystemSettings) {
    return settings ? { ...settings, attendanceTimeZone: ATTENDANCE_TIME_ZONE } : undefined;
}

function firstAttendanceRecord(records: AttendanceRecord[], sources: AttendanceRecord["source"][]) {
    return records.find((record) => sources.includes(record.source));
}

function formatTimePair(first?: string, second?: string, timeZone = ATTENDANCE_TIME_ZONE) {
    const firstLabel = formatTimeInTimeZone(first, timeZone) || "00:00:00";
    const secondLabel = formatTimeInTimeZone(second, timeZone) || "00:00:00";
    return `${firstLabel} - ${secondLabel}`;
}

function formatDuration(milliseconds: number) {
    if (milliseconds <= 0) return "-";
    const totalMinutes = Math.round(milliseconds / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `${minutes}m`;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function elapsedBetween(start?: string, end?: string) {
    if (!start || !end) return 0;
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();
    if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime <= startTime) return 0;
    return endTime - startTime;
}

function payrollLunchDuration() {
    return 60 * 60 * 1000;
}

function attendanceTimestamp(record?: AttendanceRecord) {
    if (!record) return 0;
    const timestamp = new Date(record.timeIn).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
}

function buildBreakPairs(records: AttendanceRecord[]) {
    const breakIns = records.filter((record) => record.source === "Break In");
    const usedBreakIns = new Set<AttendanceRecord>();
    return records
        .filter((record) => record.source === "Break Out")
        .map((breakOut) => {
            const breakOutTime = attendanceTimestamp(breakOut);
            const breakIn = breakIns.find((record) => !usedBreakIns.has(record) && attendanceTimestamp(record) >= breakOutTime);
            if (breakIn) usedBreakIns.add(breakIn);
            return { breakOut: breakOut.timeIn, breakIn: breakIn?.timeIn || "", breakOutRecord: breakOut, breakInRecord: breakIn };
        });
}

function minutesFromTime(value = "00:00") {
    const [hours, minutes] = value.split(":").map((part) => Number(part));
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
    return hours * 60 + minutes;
}

function getTimeInStatus(timeIn: string, timeZone: string, shiftStart: string, shiftEnd: string): AttendanceTimeInStatus {
    const parts = zonedDateParts(timeIn, timeZone);
    if (!parts) return "No time in";
    const shiftStartMinutes = minutesFromTime(shiftStart);
    const shiftEndMinutes = minutesFromTime(shiftEnd);
    const isOvernightShift = shiftEndMinutes <= shiftStartMinutes;
    const normalizedMinutes = isOvernightShift && parts.minutes < shiftEndMinutes ? parts.minutes + 1440 : parts.minutes;
    const difference = normalizedMinutes - shiftStartMinutes;

    if (difference < 0) return "Early";
    if (difference === 0) return "On time";
    return "Late";
}

function timeInStatusClass(status: AttendanceTimeInStatus) {
    if (status === "Late") return "border-red-200 bg-red-50 !text-red-700";
    if (status === "Early") return "border-sky-200 bg-sky-50 !text-sky-700";
    if (status === "On time") return "border-emerald-200 bg-emerald-50 !text-emerald-700";
    return "border-slate-200 bg-slate-50 !text-slate-600";
}

function zonedDateParts(value?: Date | string | null, timeZone = ATTENDANCE_TIME_ZONE) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0);
    return {
        year: part("year"),
        month: part("month"),
        day: part("day"),
        minutes: part("hour") * 60 + part("minute"),
    };
}

function zonedDateTimeParts(value?: Date | string | null, timeZone = ATTENDANCE_TIME_ZONE) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const valueFor = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
    return {
        year: valueFor("year"),
        month: valueFor("month"),
        day: valueFor("day"),
        hour: valueFor("hour"),
        minute: valueFor("minute"),
    };
}

function formatDateTimeInputInTimeZone(value?: Date | string | null, timeZone = ATTENDANCE_TIME_ZONE) {
    const parts = zonedDateTimeParts(value, timeZone);
    if (!parts) return "";
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function parseDateTimeInputInTimeZone(value: string, timeZone = ATTENDANCE_TIME_ZONE) {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, yearValue, monthValue, dayValue, hourValue, minuteValue] = match;
    const year = Number(yearValue);
    const month = Number(monthValue);
    const day = Number(dayValue);
    const hour = Number(hourValue);
    const minute = Number(minuteValue);
    let utcTime = Date.UTC(year, month - 1, day, hour, minute);

    for (let index = 0; index < 3; index += 1) {
        const actual = zonedDateTimeParts(new Date(utcTime), timeZone);
        if (!actual) return null;
        const actualTime = Date.UTC(Number(actual.year), Number(actual.month) - 1, Number(actual.day), Number(actual.hour), Number(actual.minute));
        const desiredTime = Date.UTC(year, month - 1, day, hour, minute);
        utcTime += desiredTime - actualTime;
    }

    const parsedDate = new Date(utcTime);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function buildAttendanceHistoryRows(records: AttendanceRecord[], settings?: SystemSettings): AttendanceHistoryRow[] {
    const timeZone = attendanceSlotTimeZone(settings);
    const shiftStart = attendanceSlotShiftStart(settings);
    const shiftEnd = attendanceSlotShiftEnd(settings);
    const groupedRecords = groupAttendanceRecordsBySlot(records, settings);

    return Object.entries(groupedRecords)
        .map(([dateKey, dayRecords]) => {
            const sortedRecords = [...dayRecords].sort((left, right) => new Date(left.timeIn).getTime() - new Date(right.timeIn).getTime());
            const timeInRecord = firstAttendanceRecord(sortedRecords, ["Login", "Time In"]);
            const timeOutRecord = [...sortedRecords].reverse().find((record) => ["Logout", "Time Out"].includes(record.source));
            const primaryRecord = timeInRecord || sortedRecords[0];
            const timeIn = timeInRecord?.timeIn || "";
            const timeOut = timeOutRecord?.timeIn || "";
            const lunchOutRecord = firstAttendanceRecord(sortedRecords, ["Lunch Break Out"]);
            const lunchInRecord = [...sortedRecords].reverse().find((record) => record.source === "Lunch Break In");
            const lunchOut = lunchOutRecord?.timeIn || "";
            const lunchIn = lunchInRecord?.timeIn || "";
            const breakPairs = buildBreakPairs(sortedRecords);
            const offPhoneSessions = buildOffPhoneAttendanceSessions(sortedRecords);
            const offPhoneDuration = offPhoneSessions.reduce((total, session) => total + session.durationMs, 0);
            const offPhoneInOut = offPhoneSessions.length
                ? offPhoneSessions
                    .map((session) => {
                        const startedAt = formatTimeInTimeZone(session.startedAt, timeZone) || "00:00:00";
                        const endedAt = session.endedAt ? formatTimeInTimeZone(session.endedAt, timeZone) || "00:00:00" : "Open";
                        return `${startedAt} - ${endedAt}`;
                    })
                    .join("; ")
                : "-";
            const lunchOutTime = lunchOut ? new Date(lunchOut).getTime() : 0;
            const lunchInTime = lunchIn ? new Date(lunchIn).getTime() : lunchOutTime;
            const firstBreak = breakPairs.find((pair) => !lunchOutTime || new Date(pair.breakOut).getTime() < lunchOutTime) || breakPairs[0];
            const secondBreak = breakPairs.find((pair) => {
                if (pair === firstBreak) return false;
                const breakOutTime = new Date(pair.breakOut).getTime();
                return lunchInTime ? breakOutTime > lunchInTime : lunchOutTime ? breakOutTime > lunchOutTime : true;
            }) || breakPairs.find((pair) => pair !== firstBreak);
            const isWeekendSlot = isWeekendAttendanceSlotKey(dateKey);
            const lunchDuration = isWeekendSlot ? elapsedBetween(lunchOut, lunchIn) : payrollLunchDuration();
            const hasTimeIn = Boolean(timeIn);
            const hasTimeOut = Boolean(timeOut && elapsedBetween(timeIn, timeOut) > 0);
            const assumedRegularDuration = hasTimeIn && !hasTimeOut && !isWeekendSlot ? 8 * 60 * 60 * 1000 : 0;
            const rawWorkedDuration = assumedRegularDuration || Math.max(0, elapsedBetween(timeIn, timeOut) - lunchDuration);
            const workedDuration = isWeekendSlot ? rawWorkedDuration : Math.min(rawWorkedDuration, 8 * 60 * 60 * 1000);
            const overtimeDuration = isWeekendSlot ? rawWorkedDuration : 0;

            return {
                dateKey,
                date: formatAttendanceSlotLabel(dateKey),
                timeInOut: formatTimePair(timeIn, timeOut, timeZone),
                timeInStatus: getTimeInStatus(timeIn, timeZone, shiftStart, shiftEnd),
                firstBreakInOut: formatTimePair(firstBreak?.breakOut, firstBreak?.breakIn, timeZone),
                lunchInOut: formatTimePair(lunchOut, lunchIn, timeZone),
                secondBreakInOut: formatTimePair(secondBreak?.breakOut, secondBreak?.breakIn, timeZone),
                offPhoneInOut,
                offPhoneDuration: formatDuration(offPhoneDuration),
                duration: formatDuration(workedDuration),
                overtime: formatDuration(overtimeDuration),
                primaryRecord,
                timeInRecord,
                timeOutRecord,
                firstBreakOutRecord: firstBreak?.breakOutRecord,
                firstBreakInRecord: firstBreak?.breakInRecord,
                lunchOutRecord,
                lunchInRecord,
                secondBreakOutRecord: secondBreak?.breakOutRecord,
                secondBreakInRecord: secondBreak?.breakInRecord,
                rawRecords: sortedRecords,
            };
        })
        .sort((left, right) => right.dateKey.localeCompare(left.dateKey));
}
