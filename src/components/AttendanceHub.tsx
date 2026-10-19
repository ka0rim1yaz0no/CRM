import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { FiAlertCircle, FiChevronDown, FiDownload, FiFilter, FiHelpCircle, FiMenu, FiPrinter, FiRefreshCw, FiX } from "react-icons/fi";
import { getAuthUser } from "../api/authStorage";
import { downloadAttendanceHubCsv, getAttendanceHubDay, getAttendanceHubDays, getAttendanceHubLive,
    type HubDay, type HubBreakSession, type HubFilters, type HubResponse } from "../api/attendanceHub";
import { socket } from "../lib/socket";
import "./AttendanceHub.css";
import AttendanceCorrections from "./AttendanceCorrections";
import AttendanceEditDialog from "./AttendanceEditDialog";
import AttendanceDayNoteForm from "./AttendanceDayNoteForm";
import AttendancePolicyEditor from "./AttendancePolicyEditor";
import { getActiveBusinessId } from "../api/businessStorage";
import { attendanceHubFilters, attendanceHubFilterChange } from "../lib/attendanceHubState";
import { manilaCalendarDate, type ShiftView } from "../../shared/attendanceView";
import { attendanceBreakAllowanceLabel, attendanceBreaksPerShift, attendanceIssueLabel } from "../lib/attendanceHubLabels";

const presets = [
    ["today", "Today"], ["yesterday", "Yesterday"], ["this-week", "This week"], ["last-week", "Last week"],
    ["this-month", "This month"], ["last-month", "Last month"], ["last-7-days", "Last 7 days"],
    ["last-30-days", "Last 30 days"], ["custom", "Custom range"],
];
const columns = ["shift", "timeIn", "timeOut", "worked", "firstBreak", "secondBreak", "break", "lunch", "offPhone", "late", "underTime", "overtime", "issues", "notes"] as const;
type Column = typeof columns[number];
const columnLabels: Record<Column, string> = { shift: "Shift", timeIn: "Time In", timeOut: "Time Out", worked: "Worked",
    firstBreak: "1st Break", secondBreak: "2nd Break", break: "Total Breaks", lunch: "Lunch", offPhone: "Off phone", late: "Late", underTime: "Undertime", overtime: "OT", issues: "Status", notes: "Notes" };
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
const breakTimeFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", second: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
const duration = (ms: number) => `${numberFormat.format(Math.round(Math.max(0, ms) / 60_000))}m`;
const clock = (ms: number) => {
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
};
const localTime = (value: string | null | undefined) => value ? timeFormat.format(new Date(value)) : "--";
const detailTime = (value: string) => dateTimeFormat.format(new Date(value));
const labelDay = (key: string) => dateFormat.format(new Date(`${key}T12:00:00+08:00`));

function BreakRecord({ entry, label, available = true }: { entry?: HubBreakSession; label: string; available?: boolean }) {
    if (!available) return <span className="attendance-hub-break-record">Detail unavailable</span>;
    if (!entry) return <span className="attendance-hub-break-record">--<small>Not taken</small></span>;
    return <span className="attendance-hub-break-record" aria-label={label}>
        <span><time dateTime={entry.startedAt} title={detailTime(entry.startedAt)}>{breakTimeFormat.format(new Date(entry.startedAt))}</time>
            {" - "}{entry.endedAt ? <time dateTime={entry.endedAt} title={detailTime(entry.endedAt)}>{breakTimeFormat.format(new Date(entry.endedAt))}</time> : "Not returned"}</span>
        <small>Duration {clock(entry.durationMs)}{entry.isOpen ? " · Open" : ""}</small>
    </span>;
}

function issueClass(issue: string) {
    if (issue === "EXCUSED") return "attendance-hub-badge good";
    if (issue === "OPEN SESSION" || issue === "ABSENT") return "attendance-hub-badge warning";
    return "attendance-hub-badge alert";
}
function errorText(error: unknown) {
    return (error as { response?: { data?: { message?: string } } })?.response?.data?.message || (error instanceof Error ? error.message : "Attendance could not be loaded. Try again.");
}
function kpis(summary: HubResponse["summary"], admin: boolean) {
    const items = [
        { label: "Days worked", value: summary.daysWorked, issue: "worked" },
        { label: "Online", value: duration(summary.online), issue: "online" },
        { label: "Breaks", value: duration(summary.break), issue: "break" },
        { label: "Lunch", value: duration(summary.lunch), issue: "lunch" },
        { label: "Off phone", value: duration(summary.offPhone), issue: "off-phone" },
        { label: "Late", value: `${summary.lateCount} / ${duration(summary.late)}`, issue: "late" },
        { label: "Over break", value: `${summary.overBreakCount} / ${duration(summary.overBreak)}`, issue: "over-break" },
        { label: "Over lunch", value: `${summary.overLunchCount} / ${duration(summary.overLunch)}`, issue: "over-lunch" },
        { label: "Under time", value: `${summary.underTimeCount} / ${duration(summary.underTime)}`, issue: "under-time" },
        { label: "Overtime", value: duration(summary.overtime), issue: "overtime" },
        { label: "Absent", value: summary.absent, issue: "absent" },
        { label: "Needs review", value: summary.needsReview, issue: "needs-review" },
    ];
    return admin ? [...items, { label: "Employees present", value: summary.employeesPresent, issue: "worked" },
        { label: "On-time rate", value: `${summary.onTimeRate}%`, issue: "on-time" }] : items;
}

function LivePanel({ actions, message }: { actions: ReactNode; message?: string }) {
    const auth = getAuthUser();
    const business = auth?.business?.id;
    const queryClient = useQueryClient();
    const { data, dataUpdatedAt, isPending, error } = useQuery({ queryKey: ["attendance-hub-live", business],
        queryFn: () => getAttendanceHubLive(business), refetchInterval: 30_000, refetchOnWindowFocus: true });
    const [now, setNow] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        const resync = () => { setNow(Date.now()); void queryClient.invalidateQueries({ queryKey: ["attendance-hub-live"] }); };
        document.addEventListener("visibilitychange", resync);
        window.addEventListener("focus", resync);
        return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", resync); window.removeEventListener("focus", resync); };
    }, [queryClient]);
    const drift = data ? new Date(data.serverTime).getTime() - dataUpdatedAt : 0;
    const serverNow = now + drift;
    const elapsed = data?.since ? serverNow - new Date(data.since).getTime() : 0;
    const status = data?.status || "OFFLINE";
    const worked = data?.day?.milliseconds.online || 0;
    const breakUsed = data?.day?.milliseconds.break || 0;
    const lunchUsed = data?.day?.milliseconds.lunch || 0;
    return <section className="attendance-hub-live" aria-label="Live attendance">
        <div className="attendance-hub-live-head"><div><p className="attendance-hub-eyebrow">Current shift</p>
            <h2>Live attendance</h2></div><span className={`attendance-hub-state ${status.toLowerCase().replaceAll(" ", "-")}`}>{isPending ? "Loading" : status}</span></div>
        {error && <p className="attendance-hub-error">{errorText(error)}</p>}
        <div className="attendance-hub-live-grid">
            <div><span>Status timer</span><strong className="attendance-hub-timer">{data?.since ? clock(elapsed) : "00:00:00"}</strong></div>
            <div><span>Shift</span><strong>{data ? `${localTime(data.shiftStart)} - ${localTime(data.shiftEnd)}` : "--"}</strong></div>
            <div><span>Worked</span><strong>{duration(worked)}</strong></div>
            <div className="break"><span>Break</span><strong>{duration(breakUsed)} / {data?.thresholds.breakMinutes || 15}m</strong></div>
            <div className="lunch"><span>Lunch</span><strong>{duration(lunchUsed)} / {data?.thresholds.lunchMinutes || 60}m</strong></div>
        </div>
        {(status === "BREAK" || status === "LUNCH") && data?.since && <p className="attendance-hub-overdue">
            {elapsed > (status === "BREAK" ? 15 : 60) * 60_000 ? "Over allowance" : "Timer running"} - {clock(elapsed)}
        </p>}
        {message && <p className="attendance-hub-message">{message}</p>}
        <div className="attendance-hub-actions">{actions}</div>
    </section>;
}

function DayDrawer({ selected, onClose, admin }: { selected: { dayKey: string; employeeCode: string; businessId?: string } | null; onClose: () => void; admin: boolean }) {
    const [editing, setEditing] = useState(false);
    const drawerRef = useRef<HTMLElement>(null);
    useEffect(() => {
        if (!selected || editing) return;
        const previous = document.activeElement as HTMLElement | null;
        const drawer = drawerRef.current;
        drawer?.querySelector<HTMLButtonElement>("button")?.focus();
        const keyboard = (event: KeyboardEvent) => {
            if (event.key === "Escape") { event.preventDefault(); onClose(); }
            if (event.key !== "Tab" || !drawer) return;
            const focusable = [...drawer.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary')].filter((element) => element.offsetParent !== null);
            const first = focusable[0]; const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        };
        document.addEventListener("keydown", keyboard);
        return () => { document.removeEventListener("keydown", keyboard); if (previous?.isConnected) previous.focus(); };
    }, [selected, onClose, editing]);
    const { data: day, isPending, error } = useQuery({ queryKey: ["attendance-hub-day", selected?.businessId, selected?.dayKey, selected?.employeeCode],
        queryFn: () => getAttendanceHubDay(selected!.dayKey, selected!.employeeCode, selected?.businessId), enabled: Boolean(selected),
        refetchInterval: 30_000, refetchOnWindowFocus: true });
    if (!selected) return null;
    const timeline = day?.events ? [...day.events].sort((a, b) => a.at.localeCompare(b.at)) : [];
    return <div className="attendance-hub-drawer-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <aside ref={drawerRef} className="attendance-hub-drawer" role="dialog" aria-modal="true" aria-label="Attendance day detail">
            <header><div><p className="attendance-hub-eyebrow">Shift detail</p><h2>{day?.employeeName || selected.employeeCode}</h2>
                <span>{labelDay(selected.dayKey)}</span></div><button type="button" title="Close" aria-label="Close detail" onClick={onClose}><FiX /></button></header>
            {isPending && <p className="attendance-hub-empty">Loading shift...</p>}
            {error && <p className="attendance-hub-error">{errorText(error)}</p>}
            {day && <div className="attendance-hub-drawer-body">
                <div className="attendance-hub-drawer-actions">{admin && <button type="button" onClick={() => setEditing(true)}>Edit attendance</button>}
                    <button type="button" onClick={() => window.print()}><FiPrinter /> Print</button></div>
                <p><strong>{day.businessName}</strong> · {localTime(day.shiftStart)} - {localTime(day.shiftEnd)}</p>
                <div className="attendance-hub-badges">{day.issues.map((issue) => <span key={issue} className={issueClass(issue)}>{attendanceIssueLabel(issue)}</span>)}
                    {day.mismatch && <span className="attendance-hub-badge warning">CROSS-BUSINESS MISMATCH</span>}</div>
                <h3>Timeline</h3>
                <div className="attendance-hub-timeline" aria-label="Time allocation">
                    {(day.timeline || []).map((interval, index) => <div key={`${interval.start}:${index}`} className={interval.bucket}
                        style={{ flexGrow: Date.parse(interval.end) - Date.parse(interval.start) }} title={`${interval.bucket}: ${localTime(interval.start)} - ${localTime(interval.end)}`} />)}
                </div>
                <div className="attendance-hub-legend">Online · Break · Lunch · Off phone · Offline</div>
                <h3>Breaks</h3>
                {day.breakSessions?.length ? <dl className="attendance-hub-breakdown">{day.breakSessions.map((entry, index) => <div key={`${entry.startedAt}:${index}`}>
                    <dt>Break {index + 1} · {day.breakMinutes}m allowance</dt><dd><BreakRecord entry={entry} label={`Break ${index + 1}`} /></dd>
                </div>)}</dl> : <p>{day.breakSessions ? "No recorded breaks." : "Break detail unavailable."}</p>}
                <table><thead><tr><th>Event</th><th>PH time</th><th>Source</th></tr></thead><tbody>
                    {timeline.map((event) => <tr key={event.id}><td>{event.source}</td><td>{detailTime(event.at)}</td><td>Attendance</td></tr>)}
                </tbody></table>
                <h3>Calculation</h3>
                <dl className="attendance-hub-breakdown">
                    <div><dt>Worked</dt><dd>{duration(day.milliseconds.online)}</dd></div>
                    <div><dt>Late after {day.graceMinutes}m grace</dt><dd>{duration(day.milliseconds.late)}</dd></div>
                    <div><dt>Breaks / over · {attendanceBreakAllowanceLabel(day.breakMinutes)}</dt><dd>{duration(day.milliseconds.break)} / {duration(day.milliseconds.overBreak)}</dd></div>
                    <div><dt>Lunch / over {day.lunchMinutes}m</dt><dd>{duration(day.milliseconds.lunch)} / {duration(day.milliseconds.overLunch)}</dd></div>
                    <div><dt>Off phone</dt><dd>{duration(day.milliseconds.offPhone)}</dd></div>
                    <div><dt>Under / overtime</dt><dd>{duration(day.milliseconds.underTime)} / {duration(day.milliseconds.overtime)}</dd></div>
                </dl>
                {day.review.length > 0 && <><h3>Needs review</h3><ul>{day.review.map((item) => <li key={item}>{item}</li>)}</ul></>}
                {day.businesses.length > 1 && <><h3>Businesses</h3>{day.businesses.map((business) => <p key={business.businessId}>
                    {business.businessName}: {business.status}, {duration(business.milliseconds.online)} worked</p>)}</>}
                {day.leave && <p>Approved leave: {day.leave}</p>}
                {admin && <AttendanceCorrections employeeId={day.employeeId} businessId={day.businessId} dayKey={day.dayKey} />}
                {admin && <AttendanceDayNoteForm key={`${day.businessId}:${day.employeeCode}:${day.dayKey}`} day={day} />}
                {day.noteRevisions.length > 0 && <><h3>Note history</h3>{day.noteRevisions.map((note, index) => <p key={`${note.at}-${index}`}>
                    {detailTime(note.at)} · {note.by} · {note.reason} {note.excused ? "(excused)" : ""}</p>)}</>}
                {day.audit.length > 0 && <><h3>Admin edit audit</h3>{day.audit.map((entry) => <p key={entry._id}>
                    {detailTime(entry.occurredAt)} · {entry.description}</p>)}</>}
            </div>}
        </aside>
        {editing && day && <AttendanceEditDialog employeeId={day.employeeId} businessId={day.businessId} dayKey={day.dayKey} onClose={() => setEditing(false)} />}
    </div>;
}

function DayRow({ day, visible, dense, open }: { day: HubDay; visible: Set<Column>; dense: boolean; open: (day: HubDay) => void }) {
    const value: Record<Column, ReactNode> = {
        shift: `${localTime(day.shiftStart)} - ${localTime(day.shiftEnd)}`, timeIn: localTime(day.timeIn), timeOut: localTime(day.timeOut),
        worked: duration(day.milliseconds.online), break: <div><span>{duration(day.milliseconds.break)} used / +{duration(day.milliseconds.overBreak)} over</span><small>{attendanceBreakAllowanceLabel(day.breakMinutes)}</small></div>,
        firstBreak: <BreakRecord entry={day.breakSessions?.[0]} label="1st break" available={Boolean(day.breakSessions)} />,
        secondBreak: <><BreakRecord entry={day.breakSessions?.[1]} label="2nd break" available={Boolean(day.breakSessions)} />
            {day.breakSessions?.length > 2 && <small>{day.breakSessions.length - 2} additional break(s) in shift detail</small>}</>,
        lunch: `${duration(day.milliseconds.lunch)} / ${day.lunchMinutes}m per lunch / +${duration(day.milliseconds.overLunch)}`,
        offPhone: duration(day.milliseconds.offPhone), late: duration(day.milliseconds.late), underTime: duration(day.milliseconds.underTime),
        overtime: duration(day.milliseconds.overtime), issues: <div className="attendance-hub-badges">{day.issues.map((issue) => <span key={issue} className={issueClass(issue)}>{attendanceIssueLabel(issue)}</span>)}
            {day.mismatch && <span className="attendance-hub-badge warning">MISMATCH</span>}</div>,
        notes: <span className="attendance-hub-note-preview" title={day.note}>{day.note || "--"}</span>,
    };
    return <><tr className={dense ? "dense" : ""}>
        <th scope="row"><button type="button" className="attendance-hub-day-link" onClick={() => open(day)}>{labelDay(day.dayKey)}</button>
            {day.note && <small title={day.note}>Note</small>}</th>
        {columns.filter((column) => visible.has(column)).map((column) => <td key={column}>{value[column]}</td>)}
    </tr><tr className="attendance-hub-mobile-row"><td><button type="button" onClick={() => open(day)}><strong>{labelDay(day.dayKey)}</strong>
        <span>{day.status} · {duration(day.milliseconds.online)} worked</span>
        <span>1st Break · {day.breakMinutes}m allowance<BreakRecord entry={day.breakSessions?.[0]} label="1st break" available={Boolean(day.breakSessions)} /></span>
        <span>2nd Break · {day.breakMinutes}m allowance<BreakRecord entry={day.breakSessions?.[1]} label="2nd break" available={Boolean(day.breakSessions)} /></span>
        {day.breakSessions?.length > 2 && <span>{day.breakSessions.length - 2} additional break(s) in shift detail</span>}
        <span>{day.issues.map(attendanceIssueLabel).join(" · ") || "No issues"}</span>{day.note && <span>{day.note}</span>}</button></td></tr></>;
}

export default function AttendanceHub({ admin = false, actions, message, embedded = false }: { admin?: boolean; actions?: ReactNode; message?: string; embedded?: boolean }) {
    const client = useQueryClient();
    const [routeParams, setRouteParams] = useSearchParams();
    const params = useMemo(() => embedded ? new URLSearchParams(Array.from(routeParams).filter(([key]) => key.startsWith("att_")).map(([key, value]) => [key.slice(4), value])) : routeParams, [embedded, routeParams]);
    const setParams = (next: URLSearchParams) => setRouteParams((current) => {
        if (!embedded) return next;
        const merged = new URLSearchParams(current);
        Array.from(merged.keys()).filter((key) => key.startsWith("att_")).forEach((key) => merged.delete(key));
        next.forEach((value, key) => merged.set(`att_${key}`, value));
        return merged;
    });
    const [selected, setSelected] = useState<{ dayKey: string; employeeCode: string; businessId?: string } | null>(null);
    const closeDay = useCallback(() => setSelected(null), []);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [navOpen, setNavOpen] = useState(false);
    const [dense, setDense] = useState(false);
    const [visible, setVisible] = useState<Set<Column>>(() => new Set(columns.filter((column) => column !== "break")));
    const [exporting, setExporting] = useState(false);
    const [exportError, setExportError] = useState("");
    const activeBusiness = getActiveBusinessId();
    const filters: HubFilters = useMemo(() => ({ ...attendanceHubFilters(params),
        business: activeBusiness,
        ...(admin && (params.has("shiftView") || !params.has("preset")) ? {
            shiftView: (params.get("shiftView") || "today") as ShiftView, shiftDate: params.get("shiftDate") || undefined,
            historyPage: Number(params.get("historyPage") || 1),
        } : {}),
    }), [params, admin, activeBusiness]);
    const [debouncedEmployee, setDebouncedEmployee] = useState(filters.employee);
    useEffect(() => { const timer = window.setTimeout(() => setDebouncedEmployee(filters.employee), 250); return () => window.clearTimeout(timer); }, [filters.employee]);
    const queryFilters = useMemo(() => ({ ...filters, employee: debouncedEmployee }), [filters, debouncedEmployee]);
    const { data, dataUpdatedAt, error, isPending, isFetching, isPlaceholderData, refetch } = useQuery({ queryKey: ["attendance-hub", getAuthUser()?.user.employeeCode, activeBusiness, queryFilters],
        queryFn: () => getAttendanceHubDays(queryFilters), placeholderData: (previous, query) => query?.queryKey[2] === activeBusiness ? previous : undefined,
        refetchOnWindowFocus: true, refetchInterval: 30_000, staleTime: 10_000 });
    const clock = useRef<{ server: number; received: number } | null>(null);
    useEffect(() => { if (data && !isPlaceholderData) clock.current = { server: Date.parse(data.serverTime), received: performance.now() }; }, [data, dataUpdatedAt, isPlaceholderData]);
    useEffect(() => {
        let previousDay = "";
        const checkDay = () => {
            if (!clock.current) return;
            const day = manilaCalendarDate(new Date(clock.current.server + performance.now() - clock.current.received));
            if (previousDay && day !== previousDay && filters.shiftView === "today") void client.invalidateQueries({ queryKey: ["attendance-hub"] });
            previousDay = day;
        };
        checkDay();
        const timer = window.setInterval(checkDay, 1000);
        return () => window.clearInterval(timer);
    }, [client, filters.shiftView]);
    const setShiftView = (view: ShiftView, date?: string) => {
        const next = new URLSearchParams(params);
        ["preset", "from", "to", "page", "historyPage"].forEach((key) => next.delete(key));
        next.set("shiftView", view);
        if (view === "date") next.set("shiftDate", date || data?.range.to || data?.history?.today || manilaCalendarDate(new Date()));
        else next.delete("shiftDate");
        if (view === "all") { next.set("sort", "date"); next.set("direction", "desc"); }
        setParams(next);
    };
    const setFilter = (key: string, value: string) => setParams(attendanceHubFilterChange(params, key, value));
    useEffect(() => {
        let pending: number | undefined;
        let running = false;
        let dirty = false;
        let disposed = false;
        const refresh = () => {
            dirty = true;
            if (disposed || running || pending !== undefined) return;
            pending = window.setTimeout(async () => {
                pending = undefined; running = true; dirty = false;
                await Promise.allSettled([
                    client.invalidateQueries({ queryKey: ["attendance-hub"] }, { cancelRefetch: false }),
                    client.invalidateQueries({ queryKey: ["attendance-hub-day"] }, { cancelRefetch: false }),
                ]);
                running = false;
                if (dirty && !disposed) refresh();
            }, 250);
        };
        socket.on("employee:availability-updated", refresh);
        socket.on("connect", refresh);
        socket.connect();
        document.addEventListener("visibilitychange", refresh);
        return () => { socket.off("employee:availability-updated", refresh); socket.off("connect", refresh);
            document.removeEventListener("visibilitychange", refresh); disposed = true; window.clearTimeout(pending); };
    }, [client]);
    useEffect(() => {
        const root = document.querySelector(".theme-app-bg");
        root?.classList.toggle("attendance-hub-nav-open", navOpen);
        return () => root?.classList.remove("attendance-hub-nav-open");
    }, [navOpen]);
    const groups = useMemo(() => {
        const map = new Map<string, HubDay[]>();
        for (const row of isPlaceholderData ? [] : data?.rows || []) { const group = map.get(row.scopeKey) || []; group.push(row); map.set(row.scopeKey, group); }
        return (data?.employees || Array.from(map.values()).map((days) => days[0])).map((employee) => ({ employee, days: map.get(employee.scopeKey) || [] }));
    }, [data?.rows, data?.employees, isPlaceholderData]);
    const availableTeams = data?.facets.teams || [];
    const availableRoles = data?.facets.roles || [];
    const showDay = (day: HubDay) => setSelected({ dayKey: day.dayKey, employeeCode: day.employeeCode, businessId: day.businessId });
    const metrics = data ? kpis(data.summary, admin) : [];
    const maxTrend = Math.max(1, ...(data?.trend || []).map((item) => item.online));
    const setSort = (sort: string) => { const next = new URLSearchParams(params); next.set("sort", sort);
        next.set("direction", filters.sort === sort && filters.direction === "asc" ? "desc" : "asc"); next.delete("page"); setParams(next); };
    const Root = embedded ? "section" : "main";
    return <Root className={`attendance-hub${embedded ? " attendance-hub-embedded" : ""}`}>
        {admin && !embedded && <AttendancePolicyEditor />}
        <header className="attendance-hub-header"><button className="attendance-hub-menu" type="button" aria-label={navOpen ? "Close navigation" : "Open navigation"}
            onClick={() => setNavOpen(!navOpen)}><FiMenu /></button><div><p className="attendance-hub-eyebrow">Attendance · Asia/Manila</p>
            <h1>Attendance</h1><p>{admin ? "Employees and shift-day records" : "Your shifts and time records"}</p></div>
            <div className="attendance-hub-header-actions"><details className="attendance-hub-help"><summary title="How this is calculated"><FiHelpCircle /> Calculations</summary>
                <p>Overnight events belong to the shift start day. Online excludes break, lunch, and off-phone. Late starts after the configured grace period. Break allowance: {attendanceBreakAllowanceLabel(data?.thresholds.breakMinutes ?? 15)}; excess is measured separately for each break. Lunch is {data?.thresholds.lunchMinutes ?? 60} minutes per lunch. Undertime is measured after a completed early Time Out and the scheduled shift end. Open sessions are never closed automatically.</p></details>
                <button type="button" title="Refresh" onClick={() => void refetch()}><FiRefreshCw /> Refresh</button>
                <button type="button" title="Export CSV" disabled={!data || isFetching || Boolean(error) || exporting || debouncedEmployee !== filters.employee}
                    onClick={async () => { setExporting(true); setExportError(""); try { await downloadAttendanceHubCsv(queryFilters); } catch (failure) { setExportError(errorText(failure)); } finally { setExporting(false); } }}><FiDownload /> {exporting ? "Exporting..." : "CSV"}</button></div>
        </header>
        {!admin && <LivePanel actions={actions} message={message} />}
        <section className="attendance-hub-filters" aria-label="Attendance filters">
            {!admin && <label>Period<select value={filters.preset} onChange={(event) => setFilter("preset", event.target.value)}>
                {presets.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            }
            {!admin && filters.preset === "custom" && <><label>From<input type="date" value={filters.from || ""} onChange={(event) => setFilter("from", event.target.value)} /></label>
                <label>To<input type="date" value={filters.to || ""} onChange={(event) => setFilter("to", event.target.value)} /></label></>}
            {admin && <><label>Employee<input type="search" value={filters.employee || ""} onChange={(event) => setFilter("employee", event.target.value)} placeholder="Name or code" /></label>
                <label>Team<select value={filters.team || ""} onChange={(event) => setFilter("team", event.target.value)}><option value="">All teams</option>{availableTeams.map((team) => <option key={team}>{team}</option>)}</select></label>
                <label>Role<select value={filters.role || ""} onChange={(event) => setFilter("role", event.target.value)}><option value="">All roles</option>{availableRoles.map((role) => <option key={role}>{role}</option>)}</select></label></>}
            <label>Issue<select value={filters.issue || ""} onChange={(event) => setFilter("issue", event.target.value)}><option value="">All shifts</option>
                {["late", "over-break", "over-lunch", "over-rest", "under-time", "absent", "open-session", "excused", "needs-review", "mismatch"].map((issue) => <option key={issue} value={issue}>{issue === "over-rest" ? "over break or lunch" : issue.replaceAll("-", " ")}</option>)}</select></label>
            {(filters.issue || filters.employee || filters.team || filters.role) && <button type="button" title="Clear detail filters" onClick={() => {
                const next = new URLSearchParams(params); ["issue", "employee", "team", "role", "page"].forEach((key) => next.delete(key)); setParams(next);
            }}><FiX /> Clear</button>}
        </section>
        {exportError && <p className="attendance-hub-error" role="alert">{exportError}</p>}
        {isPending && <div className="attendance-hub-skeleton" aria-label="Loading attendance" />}
        {error && <div className="attendance-hub-error" role="alert"><FiAlertCircle /> {errorText(error)} <button type="button" onClick={() => void refetch()}>Retry</button>
            {admin && <button type="button" onClick={() => setShiftView("today")}>Reset to Today</button>}</div>}
        {data && <>
            <div className="attendance-hub-range">{data.range.from} to {data.range.to} · shift days {isFetching && <span>Updating...</span>}</div>
            <section className="attendance-hub-kpis" aria-label="Attendance summary">{metrics.map((metric) => <button key={metric.label} type="button"
                className={filters.issue === metric.issue ? "selected" : ""} onClick={() => setFilter("issue", filters.issue === metric.issue ? "" : metric.issue)}>
                <span>{metric.label}</span><strong>{metric.value}</strong></button>)}</section>
            {admin && <div className="attendance-hub-ranking"><strong>Issue ranking</strong>
                {[["Late", data.summary.lateCount], ["Over break", data.summary.overBreakCount], ["Over lunch", data.summary.overLunchCount],
                    ["Under time", data.summary.underTimeCount], ["Needs review", data.summary.needsReview]]
                    .sort((a, b) => Number(b[1]) - Number(a[1])).map(([label, count]) => <span key={label}>{label}: {count}</span>)}</div>}
            <section className="attendance-hub-list" aria-label="Shift days">
                <div className="attendance-hub-list-head"><div><p className="attendance-hub-eyebrow">Shift records</p><h2>{admin ? "Employees" : "Shift days"}</h2>
                    <span>{data.total} {admin ? "employees" : "days"}</span></div><div className="attendance-hub-list-tools">
                    {admin && <><label className="attendance-hub-shift-view">Shift date<select aria-label="Shift date view" value={filters.shiftView || "all"} onChange={(event) => setShiftView(event.target.value as ShiftView)}>
                        <option value="today">Today</option><option value="date">Specific Date</option><option value="all">All Shifts</option></select></label>
                        {filters.shiftView === "date" && <input aria-label="Specific shift date" type="date" max={data.history?.today || manilaCalendarDate(new Date())} value={filters.shiftDate || ""} onChange={(event) => setShiftView("date", event.target.value)} />}
                        <button type="button" onClick={() => setShiftView("today")} disabled={filters.shiftView === "today"}>Reset to Today</button></>}
                    {admin && <button type="button" disabled={!groups.length || isPlaceholderData} aria-expanded={groups.length > 0 && groups.every(({ employee }) => expanded.has(employee.scopeKey))}
                        aria-controls={groups.map(({ employee }) => `attendance-days-${encodeURIComponent(employee.scopeKey)}`).join(" ")}
                        aria-label={groups.length > 0 && groups.every(({ employee }) => expanded.has(employee.scopeKey)) ? "Collapse all employees on this page" : "Expand all employees on this page"}
                        onClick={() => setExpanded((current) => groups.every(({ employee }) => current.has(employee.scopeKey)) ? new Set() : new Set(groups.map(({ employee }) => employee.scopeKey)))}>
                        {groups.length > 0 && groups.every(({ employee }) => expanded.has(employee.scopeKey)) ? "Collapse all" : groups.some(({ employee }) => expanded.has(employee.scopeKey)) ? "Expand all (mixed)" : "Expand all"}</button>}
                    <button type="button" onClick={() => setDense(!dense)}>{dense ? "Comfortable" : "Compact"}</button>
                    <details><summary><FiFilter /> Columns</summary><div>{columns.map((column) => <label key={column}>
                        <input type="checkbox" checked={visible.has(column)} onChange={() => setVisible((current) => {
                            const next = new Set(current); if (next.has(column)) next.delete(column); else next.add(column); return next;
                        })} /> {columnLabels[column]}</label>)}</div></details></div></div>
                {admin && <p className="attendance-hub-record-range">{filters.shiftView === "today" ? "Current shift" : filters.shiftView === "date" ? "Shift date" : filters.shiftView === "all" ? "All Shifts · historical window" : "Linked date range"}: {data.range.from}{data.range.to !== data.range.from ? ` to ${data.range.to}` : ""} · Asia/Manila{filters.shiftView === "today" && data.history?.today && data.history.today !== data.range.from ? ` · Calendar date: ${data.history.today}` : ""}{isPlaceholderData ? " · Updating..." : ""}</p>}
                {!groups.length && <p className="attendance-hub-empty">No shift records match these filters.</p>}
                {groups.map(({ employee, days }) => <div key={employee.scopeKey} className="attendance-hub-employee-group">
                    {admin && <button type="button" className="attendance-hub-group-toggle" aria-expanded={expanded.has(employee.scopeKey)} aria-controls={`attendance-days-${encodeURIComponent(employee.scopeKey)}`}
                        onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(employee.scopeKey)) next.delete(employee.scopeKey); else next.add(employee.scopeKey); return next; })}>
                        <strong>{employee.employeeName}</strong><span>{employee.employeeCode} · {employee.team} · {days.length} days · {duration(days.reduce((sum, day) => sum + day.milliseconds.online, 0))} worked · {days.reduce((sum, day) => sum + day.issues.length, 0)} issues</span><FiChevronDown /></button>}
                    <div id={`attendance-days-${encodeURIComponent(employee.scopeKey)}`} hidden={admin && !expanded.has(employee.scopeKey)}>{(!admin || expanded.has(employee.scopeKey)) && <div className="attendance-hub-table-scroll">
                        {isPlaceholderData ? <p className="attendance-hub-empty" role="status">Loading selected shifts...</p> : (!days.length || (filters.shiftView !== "all" && days.every((day) => !day.events.length))) ? <p className="attendance-hub-empty">No shift record for this date {days.flatMap((day) => day.issues).map((issue) => <span className={issueClass(issue)} key={issue}>{attendanceIssueLabel(issue)}</span>)}</p> : <table><thead><tr><th scope="col">
                        <button type="button" onClick={() => setSort("date")}>Date</button></th>
                        {columns.filter((column) => visible.has(column)).map((column) => <th scope="col" key={column} aria-sort={filters.sort === column ? filters.direction === "asc" ? "ascending" : "descending" : "none"}>
                            {column === "notes" ? columnLabels[column] : <button type="button" onClick={() => setSort(column)}>{columnLabels[column]}{(column === "firstBreak" || column === "secondBreak") && ` (${data.thresholds.breakMinutes}m)`}</button>}</th>)}</tr></thead><tbody>
                        {days.map((day) => <DayRow key={`${day.employeeCode}:${day.dayKey}`} day={day} visible={visible} dense={dense} open={showDay} />)}
                    </tbody></table>}</div>}</div></div>)}
                {filters.shiftView === "all" && data.history && <nav className="attendance-hub-pagination" aria-label="Shift history windows">
                    <button type="button" disabled={!data.history.hasNewer || isFetching} onClick={() => setFilter("historyPage", String(data.history!.page - 1))}>Newer shifts</button>
                    <span>{data.range.from} to {data.range.to}</span>
                    <button type="button" disabled={!data.history.hasOlder || isFetching} onClick={() => setFilter("historyPage", String(data.history!.page + 1))}>Older shifts</button>
                </nav>}
                {data.total > data.pageSize && <nav className="attendance-hub-pagination" aria-label="Attendance pages">
                    <button type="button" disabled={data.page <= 1} onClick={() => setFilter("page", String(data.page - 1))}>Previous</button>
                    <span>Page {data.page} of {Math.ceil(data.total / data.pageSize)}</span>
                    <button type="button" disabled={data.page * data.pageSize >= data.total} onClick={() => setFilter("page", String(data.page + 1))}>Next</button></nav>}
            </section>
            <section className="attendance-hub-bottom"><div><h2>Trends</h2><p>Worked hours by shift day</p>
                <div className="attendance-hub-chart">{data.trend.map((item) => <div key={item.dayKey} title={`${item.dayKey}: ${duration(item.online)} worked, ${duration(item.late)} late`}>
                    <span style={{ height: `${Math.max(4, item.online / maxTrend * 100)}%` }} /></div>)}</div>
                <div className="attendance-hub-chart-label">{data.range.from} <span>{data.range.to}</span></div>
                <div className="attendance-hub-mini-trends">{(["late", "break", "lunch"] as const).map((field) => {
                    const total = data.trend.reduce((sum, item) => sum + item[field], 0);
                    const allowance = field === "break" ? data.trend.reduce((sum, item) => sum + item.people * data.thresholds.breakMinutes * attendanceBreaksPerShift * 60_000, 0) :
                        field === "lunch" ? data.trend.reduce((sum, item) => sum + item.people * data.thresholds.lunchMinutes * 60_000, 0) : 0;
                    return <div key={field}><span>{field === "break" ? "Break / scheduled budget (2 per shift)" : field === "lunch" ? "Lunch / scheduled budget (1 per shift)" : "Late minutes"}</span>
                        <strong>{duration(total)}{field !== "late" ? ` / ${duration(allowance)}` : ""}</strong>
                        <div><span style={{ width: `${Math.min(100, allowance ? total / allowance * 100 : total ? 100 : 0)}%` }} /></div></div>;
                })}</div></div>
                <div><h2>Needs review</h2>{data.reviewQueue.slice(0, 8).map((item) =>
                    <button key={`${item.employeeCode}:${item.dayKey}`} type="button" onClick={() => setSelected({ dayKey: item.dayKey, employeeCode: item.employeeCode })}>
                        {item.employeeName} · {item.dayKey} · {item.reason}</button>)}
                    {!data.reviewQueue.length && <p>No review items in this range.</p>}
                    {data.reviewQueue.length > 8 && <button type="button" onClick={() => setFilter("issue", "needs-review")}>View review queue</button>}</div></section>
        </>}
        <DayDrawer key={selected ? `${selected.businessId}:${selected.employeeCode}:${selected.dayKey}` : "closed"} selected={selected} onClose={closeDay} admin={admin} />
    </Root>;
}
