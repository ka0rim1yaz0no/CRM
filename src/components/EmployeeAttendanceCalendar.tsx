import { useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { FiCalendar, FiChevronLeft, FiChevronRight, FiClock, FiRefreshCw } from "react-icons/fi";
import { getAuthUser } from "../api/authStorage";
import { getActiveBusinessId } from "../api/businessStorage";
import { getEmployeeProfileAttendance, getEmployeeProfileAttendanceCalendar, type EmployeeAttendanceCalendarStatus } from "../api/employeeProfileAttendance";
import type { AttendanceSessionSnapshot } from "../api/attendanceSession";
import { attendanceCalendarCells, moveAttendanceCalendarMonth, profileAttendanceDay, profileAttendanceAbsent } from "../lib/profileAttendanceCalendar";
import { attendanceEventPresentation } from "../lib/attendancePresentation";
import { formatAttendanceDuration } from "../lib/attendanceRecords";
import { formatPhDate, formatPhDateTime, formatPhTime } from "../lib/dateTime";
import { profileDayKey } from "../lib/profilePresentation";
import "./employeeAttendanceCalendar.css";

function subscribe(listener: () => void) {
    const events = ["crm:auth-changed", "crm:business-changed", "storage"];
    for (const event of events) window.addEventListener(event, listener);
    return () => { for (const event of events) window.removeEventListener(event, listener); };
}
function identityKey() {
    const auth = getAuthUser();
    return JSON.stringify([getActiveBusinessId(), auth?.userType === "employee" ? auth.user._id : ""]);
}

export function AttendanceCalendarView({ snapshot, calendar, month, selectedDay, onMonth, onSelect }: {
    snapshot: AttendanceSessionSnapshot; calendar?: EmployeeAttendanceCalendarStatus; month: string; selectedDay: string; onMonth: (value: string) => void; onSelect: (value: string) => void;
}) {
    const day = profileAttendanceDay(snapshot, selectedDay);
    const selectedAbsent = profileAttendanceAbsent(snapshot, selectedDay, calendar);
    const dateLabel = (key: string) => new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
    const stamp = (value: string) => `${formatPhDate(value)} ${formatPhTime(value)}`;
    const badges = (entry: ReturnType<typeof profileAttendanceDay>, absent = false) => {
        if (absent && !entry?.events.length) return [{ label: "Absent", compact: "Absent", tone: "absent" }];
        if (!entry) return [];
        const result: Array<{ label: string; compact: string; tone: string }> = [];
        if (entry.timeIn) result.push((entry.milliseconds.late || 0) > 0
            ? { label: "Late-Present", compact: "Late", tone: "late" }
            : { label: "Ontime-Present", compact: "On time", tone: "ontime" });
        if ((entry.milliseconds.underTime || 0) > 0) result.push({ label: "Undertime", compact: "Under", tone: "undertime" });
        if (entry.status === "In progress") result.push({ label: "In progress", compact: "Active", tone: "active" });
        if (entry.status === "Needs review") result.push({ label: "Needs review", compact: "Review", tone: "review" });
        if (!result.length) result.push({ label: "Recorded", compact: "Record", tone: "neutral" });
        return result;
    };
    const latest = snapshot.records.reduce<string | null>((value, event) => !value || Date.parse(event.at) > Date.parse(value) ? event.at : value, null);
    const badge = (item: ReturnType<typeof badges>[number]) => <span key={item.tone} className="employee-attendance-badge" data-tone={item.tone}>
        <span className="employee-attendance-badge-full">{item.label}</span><span className="employee-attendance-badge-compact" aria-hidden="true">{item.compact}</span>
    </span>;
    return <>
        <dl className="employee-attendance-summary">
            <div><dt>Total Records</dt><dd>{snapshot.records.length}</dd></div>
            <div><dt>Days Tracked</dt><dd>{snapshot.dashboardDays?.filter(entry => entry.eventIds.length > 0).length || 0}</dd></div>
            <div><dt>Latest</dt><dd>{latest ? formatPhDateTime(latest) : "No time-in yet"}</dd></div>
        </dl>
        <div className="employee-attendance-layout">
        <section className="employee-attendance-calendar-panel" aria-label="Attendance calendar">
        <div className="employee-attendance-toolbar">
            <div><h3>Calendar</h3><p>{new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" })}</p></div>
            <div className="employee-attendance-month-controls">
                <button type="button" title="Previous month" aria-label="Previous attendance month" onClick={() => onMonth(moveAttendanceCalendarMonth(month, -1))}><FiChevronLeft aria-hidden="true" /></button>
                <input type="month" aria-label="Attendance calendar month" min="1900-01" max="9999-12" value={month} onChange={event => { if (event.target.validity.valid && /^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) onMonth(event.target.value); }} />
                <button type="button" title="Next month" aria-label="Next attendance month" onClick={() => onMonth(moveAttendanceCalendarMonth(month, 1))}><FiChevronRight aria-hidden="true" /></button>
            <button type="button" title="Current shift" aria-label="Show current attendance shift" onClick={() => { const key = snapshot.currentShiftDay || profileDayKey(snapshot.serverTime); onMonth(key.slice(0, 7)); onSelect(key); }}><FiCalendar aria-hidden="true" /></button>
            </div>
        </div>
        <div className="employee-attendance-legend" aria-label="Attendance status legend">
            {([{ label: "Late-Present", tone: "late" }, { label: "Ontime-Present", tone: "ontime" }, { label: "Undertime", tone: "undertime" }, { label: "Absent", tone: "absent" }] as const).map(item => <span className="employee-attendance-badge" data-tone={item.tone} key={item.tone}>{item.label}</span>)}
        </div>
        <div className="employee-attendance-calendar">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(label => <div className="employee-attendance-weekday" key={label}>{label}</div>)}
            {attendanceCalendarCells(month).map((key, index) => {
                if (!key) return <div className="employee-attendance-blank" key={`blank-${index}`} aria-hidden="true" />;
                const entry = profileAttendanceDay(snapshot, key), time = entry ? entry.milliseconds.online : 0;
                const absent = profileAttendanceAbsent(snapshot, key, calendar), status = absent ? "Absent" : entry?.status || "No records";
                return <button type="button" key={key} aria-pressed={key === selectedDay} aria-current={key === profileDayKey(snapshot.serverTime) ? "date" : undefined}
                    data-status={absent ? "Absent" : entry?.status || "none"} className="employee-attendance-date" title={`${dateLabel(key)}: ${status}`}
                    aria-label={`${dateLabel(key)}, ${status}${entry ? `, ${formatAttendanceDuration(time)} worked` : ""}`} onClick={() => onSelect(key)}>
                    <span className="employee-attendance-day-number">{Number(key.slice(-2))}</span>
                    <span className="employee-attendance-date-badges">{badges(entry, absent).map(badge)}</span>
                </button>;
            })}
        </div>
        </section>
        <section className="employee-attendance-day" aria-label="Selected attendance shift">
            <header><div><h3>Selected Slot</h3><p>{dateLabel(selectedDay)}</p></div><div className="employee-attendance-selected-badges">{badges(day, selectedAbsent).map(badge)}</div></header>
            {day ? <>
                <p className="employee-attendance-shift">Shift: {formatPhDateTime(day.shiftStart)} - {formatPhDateTime(day.shiftEnd)}</p>
                <dl className="employee-attendance-slots">
                    <div><dt>Time In</dt><dd>{day.timeIn ? stamp(day.timeIn) : "Not recorded"}</dd></div>
                    <div><dt>Time Out</dt><dd>{day.timeOut ? stamp(day.timeOut) : "Not recorded"}</dd></div>
                    {([["Worked", "online"], ["Break", "break"], ["Lunch", "lunch"], ["Off the Phone", "offPhone"], ["Late", "late"], ["Undertime", "underTime"]] as const).map(([label, field]) =>
                        <div key={field}><dt>{label}</dt><dd>{formatAttendanceDuration(day.milliseconds[field] || 0)}</dd></div>)}
                    {day.coachingMs !== undefined && <div><dt>Coaching</dt><dd>{formatAttendanceDuration(day.coachingMs)}</dd></div>}
                </dl>
                <div className="employee-attendance-events" role="group" aria-label="Attendance slots">
                    {day.events.map(event => <article key={event.id} className="employee-attendance-event">
                        <span className="employee-attendance-event-icon"><FiClock aria-hidden="true" /></span>
                        <div><h4>{event.source === "Time In" || event.source === "Login" ? "Time In" : event.source === "Time Out" || event.source === "Logout" ? "Time Out" : attendanceEventPresentation(event.source).label}</h4>
                            <time dateTime={event.at} title={stamp(event.at)}>{stamp(event.at)}</time>
                            {event.autoTimeOut && <span className="employee-attendance-automatic">Automatic</span>}
                        </div>
                    </article>)}
                </div>
            </> : <div className="employee-attendance-empty"><FiClock aria-hidden="true" /><p>{selectedAbsent ? "No Time In recorded for this completed shift." : "No attendance recorded for this shift."}</p></div>}
        </section>
        </div>
    </>;
}

function AttendanceCalendarLedger({ employeeId, businessId }: { employeeId: string; businessId: string }) {
    const [chosenMonth, setMonth] = useState(""), [chosenDay, setDay] = useState("");
    const query = useQuery({ queryKey: ["employee-profile-attendance", businessId, employeeId],
        queryFn: ({ signal }) => getEmployeeProfileAttendance(employeeId, businessId, signal), enabled: Boolean(employeeId && businessId),
        staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: "always", refetchInterval: 30000 });
    const snapshot = query.data, defaultKey = snapshot?.currentShiftDay || profileDayKey(snapshot?.serverTime || new Date());
    const month = chosenMonth || defaultKey.slice(0, 7);
    const selectedDay = chosenDay.startsWith(month) ? chosenDay : defaultKey.startsWith(month) ? defaultKey : `${month}-01`;
    const calendarEnabled = snapshot?.profileCalendarEnabled === true;
    const calendarQuery = useQuery({ queryKey: ["employee-profile-attendance", businessId, employeeId, "calendar", month, snapshot?.revision],
        queryFn: ({ signal }) => getEmployeeProfileAttendanceCalendar(employeeId, businessId, month, signal), enabled: calendarEnabled,
        staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: "always", refetchInterval: calendarEnabled ? 30000 : false });
    return <section className="employee-attendance" aria-label="My attendance" aria-busy={query.isFetching}>
        <header className="employee-attendance-heading"><div><h2>Attendance</h2><p>Asia/Manila{snapshot && ` / Updated ${formatPhTime(snapshot.serverTime)}`}</p></div>
            <button type="button" title="Refresh attendance" aria-label="Refresh my attendance" disabled={query.isFetching || calendarEnabled && calendarQuery.isFetching} onClick={() => { void query.refetch(); if (calendarEnabled) void calendarQuery.refetch(); }}><FiRefreshCw aria-hidden="true" /></button></header>
        {query.isError && <p className="employee-attendance-error" role="alert">{snapshot
            ? `Attendance could not refresh. Showing records last confirmed ${formatPhDateTime(snapshot.serverTime)} PH time. Try Refresh again.`
            : "Attendance could not load. Try Refresh again."}</p>}
        {query.isPending && <p role="status">Loading attendance...</p>}
        {calendarEnabled && calendarQuery.isError && <p className="employee-attendance-error" role="alert">Absence status could not refresh. Attendance records remain available.</p>}
        {snapshot && <AttendanceCalendarView snapshot={snapshot} calendar={calendarEnabled && !calendarQuery.isError ? calendarQuery.data : undefined} month={month} selectedDay={selectedDay} onMonth={setMonth} onSelect={setDay} />}
    </section>;
}

export default function EmployeeAttendanceCalendar() {
    const identity = useSyncExternalStore(subscribe, identityKey, identityKey);
    const [businessId, employeeId] = JSON.parse(identity) as [string, string];
    return employeeId && businessId ? <AttendanceCalendarLedger key={identity} employeeId={employeeId} businessId={businessId} /> : <p>Sign in to view your attendance.</p>;
}
