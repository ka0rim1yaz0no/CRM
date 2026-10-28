import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { FiArrowDown, FiArrowUp, FiDownload, FiPause, FiPlay, FiPrinter, FiSearch, FiSettings, FiX } from "react-icons/fi";
import { getAuthUser } from "../api/authStorage";
import { getActiveBusinessId } from "../api/businessStorage";
import { getDashboardEmployee, removeHandoverNote, saveHandoverNote, saveDashboardSettings, type DashboardFilters, type DashboardSettings, type DashboardWorkspaceData } from "../api/dashboardWorkspace";
import { formatPhDateTime } from "../lib/dateTime";
import { getLeads } from "../api/leads";
import type { Employee } from "../api/employees";
import "./DashboardWorkspace.css";
import type { DashboardControls } from "../hooks/useDashboardControls";
import AvailabilityBadge from "./AvailabilityBadge";
import DeferredDashboardSection from "./DeferredDashboardSection";
import WorkspaceMobileNavigation from "./WorkspaceMobileNavigation";
import { recordedTalkTime } from "../lib/dashboardCallInsights";
const DashboardInsights = lazy(() => import("./DashboardInsights"));
export function DashboardHeader({ controls, updatedAt, busy, error, refresh, onQuickView, employees, attention = [] }: {
  controls: DashboardControls; updatedAt?: string; busy: boolean; error: boolean; refresh: () => void; onQuickView: (name: string) => void; employees: Employee[]; attention?: DashboardWorkspaceData["attention"];
}) {
  const navigate = useNavigate();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [checkedAt, setCheckedAt] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setCheckedAt(Date.now()), 15_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250); return () => window.clearTimeout(timer); }, [search]);
  const leadSearch = useQuery({ queryKey: ["dashboard-palette-leads", controls.business, debouncedSearch], queryFn: () => getLeads({ search: debouncedSearch, page: 1, limit: 8 }), enabled: palette && debouncedSearch.length >= 2, staleTime: 60_000, retry: false });
  const searchRef = useRef<HTMLInputElement>(null);
  const prefix = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (palette || help) { opener.current = document.activeElement as HTMLElement; dialogRef.current?.showModal(); if (palette) searchRef.current?.focus(); }
    else if (dialogRef.current?.open) { dialogRef.current.close(); opener.current?.focus(); }
  }, [palette, help]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const editing = event.target instanceof HTMLElement && Boolean(event.target.closest("input,textarea,select,[contenteditable=true]"));
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette((open) => !open); return; }
      if (editing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "?") { setHelp(true); return; }
      if (event.key === "/") { event.preventDefault(); setPalette(true); return; }
      if (prefix.current) { prefix.current = false; const path = ({ d: "dashboard", l: "leads", a: "attendance" } as Record<string, string>)[event.key]; if (path) navigate(`/admin/${path}`); return; }
      prefix.current = event.key === "g";
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [navigate]);
  return <>
    <header className="dw-header">
      <WorkspaceMobileNavigation />
      <div><p className="dw-eyebrow">BUSINESS OPERATIONS</p><h2>Good {new Date().getHours() < 12 ? "morning" : "day"}, {getAuthUser()?.user.name.split(" ")[0] || "Admin"}</h2>
        <p role="status">{error ? "Update failed" : controls.paused ? "Auto-refresh paused" : !controls.visible ? "Tab inactive" : busy ? "Updating" : updatedAt && checkedAt - Date.parse(updatedAt) > 90_000 ? "Stale" : "Live"}{updatedAt ? ` | ${formatPhDateTime(updatedAt)}` : " | Loading"}</p></div>
      <div className="dw-toolbar">
        <label>Period<select aria-label="Dashboard period" value={controls.filters.preset} onChange={(event) => controls.setFilter("preset", event.target.value)}>{[["today", "Today"], ["yesterday", "Yesterday"], ["this-week", "This week"], ["this-month", "This month"], ["custom", "Custom"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {controls.filters.preset === "custom" && <><label>From<input aria-label="Dashboard from" type="date" value={controls.filters.from || ""} onChange={(event) => controls.setFilter("from", event.target.value)} /></label><label>To<input aria-label="Dashboard to" type="date" value={controls.filters.to || ""} onChange={(event) => controls.setFilter("to", event.target.value)} /></label></>}
        <div className="dw-toolbar-actions"><button type="button" title={controls.paused ? "Resume dashboard refresh" : "Pause dashboard refresh (live call panel stays live)"} aria-pressed={controls.paused} onClick={() => controls.setPaused(!controls.paused)}>{controls.paused ? <FiPlay /> : <FiPause />}</button>
        <button type="button" disabled={busy} onClick={refresh}>Refresh</button><button type="button" title="Search workspace" onClick={() => setPalette(true)}><FiSearch /></button></div>
      </div>
    </header>
    <dialog ref={dialogRef} className="dw-dialog" onCancel={() => { setHelp(false); setPalette(false); }}>
      <div className="dw-title"><h3>{help ? "Keyboard shortcuts" : "Go to"}</h3><button type="button" title="Close" onClick={() => { setHelp(false); setPalette(false); }}><FiX /></button></div>
      {help ? <dl><dt>Ctrl / Cmd + K or /</dt><dd>Search</dd><dt>g then d / l / a</dt><dd>Dashboard / Leads / Attendance</dd><dt>?</dt><dd>This dialog</dd></dl> : <>
        <input ref={searchRef} autoFocus aria-label="Find a page or employee" placeholder="Page, employee name or code" value={search} onChange={(event) => setSearch(event.target.value)} />
        <nav>{["Dashboard", "Employees", "Leads", "Attendance", "Payroll", "Messages"].filter((item) => item.toLowerCase().includes(search.toLowerCase())).map((item) => <Link key={item} to={`/admin/${item.toLowerCase()}`} onClick={() => setPalette(false)}>{item}</Link>)}</nav>
        {search.trim() && <><nav aria-label="Matching employees">{employees.filter((employee) => `${employee.name} ${employee.employeeCode}`.toLowerCase().includes(search.toLowerCase())).slice(0, 8).map((employee) => <button key={employee._id} type="button" onClick={() => { onQuickView(employee.employeeCode); setPalette(false); }}>{employee.name} | {employee.employeeCode}</button>)}</nav><nav aria-label="Matching leads">{leadSearch.isFetching && <span role="status">Searching leads...</span>}{leadSearch.isError && <span role="alert">Lead search is unavailable.</span>}{leadSearch.data?.map((lead) => <Link key={lead._id} to={`/admin/leads?scope=ALL&lead=${lead._id}`} onClick={() => setPalette(false)}>{lead.businessName || lead.leadName}</Link>)}</nav></>}
        <nav aria-label="Attention shortcuts">{attention.filter((item) => item.count > 0 && item.label.toLowerCase().includes(search.toLowerCase())).map((item) => <a key={item.key} href={item.href} onClick={() => setPalette(false)}>{item.count} {item.label}</a>)}</nav>
      </>}
    </dialog>
  </>;
}
export function DashboardAttention({ data }: { data?: DashboardWorkspaceData }) {
  return <section className="dw-attention" aria-label="Needs attention"><h3>Needs attention</h3><div>{data ? data.attention.map((item) => <a key={item.key} className={`dw-attention-${item.severity}`} href={item.href}><strong>{item.count}</strong><span>{item.label}</span></a>) : <p role="status">Loading attention items...</p>}</div></section>;
}
export function DashboardKpiDetail({ data, metric, href }: { data?: DashboardWorkspaceData; metric: string; href: string }) {
  const delta = data?.deltas[metric];
  return <><Link className="dw-kpi-detail" to={href}><span>{delta === null || delta === undefined ? "No historical snapshot" : `${delta > 0 ? "+" : ""}${delta}% vs previous period`}</span><span aria-hidden="true">View &gt;</span></Link>{metric === "activityToday" && Boolean(data?.trend.length) && <svg className="dw-sparkline" role="img" aria-label="Recorded lead activity per shift day" viewBox="0 0 120 16"><polyline fill="none" stroke="currentColor" strokeWidth="2" points={data!.trend.map((row, index, rows) => `${index / Math.max(1, rows.length - 1) * 116 + 2},${14 - row.count / Math.max(1, ...rows.map((item) => item.count)) * 12}`).join(" ")} /></svg>}</>;
}
export function DashboardOperations({ data, refresh }: { data: DashboardWorkspaceData; refresh: () => void }) {
  const [slaDraft, setSlaDraft] = useState<DashboardSettings | null>(null);
  const [slaSaving, setSlaSaving] = useState(false);
  const [slaError, setSlaError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [pinned, setPinned] = useState(false);
  const [noteId, setNoteId] = useState<string | undefined>();
  const auth = getAuthUser();
  async function submitNote() { setSaving(true); setError(""); try { await saveHandoverNote({ text: note, pinned }, noteId); setNote(""); setNoteId(undefined); setPinned(false); refresh(); } catch { setError("The note was not saved. Your text is still here."); } finally { setSaving(false); } }
  return <>

    <DeferredDashboardSection><Suspense fallback={<p role="status">Loading insights...</p>}><DashboardInsights data={data} /></Suspense></DeferredDashboardSection>
    <div id="lead-aging" className="dw-aging"><div className="dw-title"><h3>Lead aging</h3><button type="button" title="SLA thresholds" disabled={slaSaving} aria-expanded={Boolean(slaDraft)} onClick={() => { setSlaDraft(slaDraft ? null : { ...data.config }); setSlaError(""); }}><FiSettings /></button></div>
      {slaDraft && <form className="dw-sla-form" onSubmit={async (event) => { event.preventDefault(); if (slaSaving) return; setSlaSaving(true); setSlaError("");
        try { await saveDashboardSettings(slaDraft); setSlaDraft(null); refresh(); } catch { setSlaError("Thresholds were not saved. Keep your values, refresh and reopen settings if another administrator changed them."); } finally { setSlaSaving(false); }
      }}><label>Untouched new lead (hours)<input required type="number" min="0" max="8760" step="1" value={Number.isFinite(slaDraft.newLeadHours) ? slaDraft.newLeadHours : ""} onChange={(event) => setSlaDraft({ ...slaDraft, newLeadHours: event.target.valueAsNumber })} /></label>
        <label>Follow-up overdue (hours)<input required type="number" min="0" max="8760" step="1" value={Number.isFinite(slaDraft.followUpHours) ? slaDraft.followUpHours : ""} onChange={(event) => setSlaDraft({ ...slaDraft, followUpHours: event.target.valueAsNumber })} /></label>
        <button type="submit" disabled={slaSaving}>{slaSaving ? "Saving..." : "Save thresholds"}</button><button type="button" disabled={slaSaving} onClick={() => setSlaDraft(null)}>Cancel</button>{slaError && <p role="alert">{slaError}</p>}</form>}
      {data.overdue.length ? <ol>{data.overdue.map((lead) => <li key={lead.id}><Link to={`/admin/leads?scope=ALL&lead=${lead.id}`}>{lead.name}</Link><span>{Math.floor(lead.hours)}h overdue</span></li>)}</ol> : <p>No leads past SLA</p>}</div>
    <section className="dw-handover">{error && <p role="alert">{error}</p>}<details open={data.notes.length > 0}><summary>Shift handover <span>{data.notes.length}</span></summary>
      <form onSubmit={(event) => { event.preventDefault(); void submitNote(); }}><label>Note<textarea required maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></label><label><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /> Pin</label><button disabled={saving || !note.trim()} type="submit">{noteId ? "Save note" : "Add note"}</button>{noteId && <button type="button" onClick={() => { setNoteId(undefined); setNote(""); }}>Cancel</button>}</form>
      {data.notes.map((item) => <article key={item._id}><p>{item.pinned && "Pinned | "}{item.text}</p><small>{item.authorName} | {formatPhDateTime(item.createdAt)}</small>{item.author === auth?.user.employeeCode && <div><button type="button" onClick={() => { setNoteId(item._id); setNote(item.text); setPinned(item.pinned); }}>Edit</button><button type="button" disabled={saving} onClick={async () => { setSaving(true); try { await removeHandoverNote(item._id); refresh(); } catch { setError("Note could not be removed."); } finally { setSaving(false); } }}>Remove</button></div>}</article>)}
    </details></section>
  </>;
}
export function DashboardQuickView({ code, filters, data, close }: { code: string; filters: DashboardFilters; data?: DashboardWorkspaceData; close: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const result = useQuery({ queryKey: ["dashboard-quick-view", getActiveBusinessId(), code, filters], queryFn: () => getDashboardEmployee(code, filters), retry: false });
  useEffect(() => { const opener = document.activeElement as HTMLElement; dialogRef.current?.showModal(); return () => opener?.focus(); }, []);
  const agent = data?.dashboard.agents.find((item) => item.employeeCode === code);
  const monthly = data?.dashboard.monthlyAgents.find((item) => item.employeeId === agent?.employeeId);
  const calls = data?.calls.filter((item) => item._id.employee === result.data?.employee._id) || [];
  return <dialog ref={dialogRef} className="dw-drawer" onCancel={close}><div className="dw-title"><h3>{result.data?.employee.name || "Employee"}</h3><button type="button" title="Close employee quick view" onClick={close}><FiX /></button></div>
    {result.isPending ? <p role="status">Loading employee...</p> : result.isError ? <p role="alert">Employee information could not load. <button type="button" onClick={() => void result.refetch()}>Retry</button></p> : result.data && <>
      <p>{result.data.employee.employeeCode} | {result.data.employee.team} | {result.data.employee.role}</p><AvailabilityBadge status={result.data.employee.availabilityStatus} />
      <dl className="dw-quick-metrics">{[["Calls", calls.reduce((total, item) => total + item.count, 0)], ["Talk time", recordedTalkTime(calls.reduce((total, item) => total + item.seconds, 0), calls.reduce((total, item) => total + item.count, 0))], ["Leads touched", monthly?.touchedLeads ?? "No data"], ["Qualified", monthly?.qualified ?? "No data"], ["Late minutes", Math.round(result.data.attendance.summary.late / 60000)], ["Over break minutes", Math.round(result.data.attendance.summary.overBreak / 60000)], ["Over lunch minutes", Math.round(result.data.attendance.summary.overLunch / 60000)], ["Under time minutes", Math.round(result.data.attendance.summary.underTime / 60000)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p>Last lead activity: {agent?.lastActivityAt ? formatPhDateTime(agent.lastActivityAt) : "No recorded activity"}</p><nav><Link to={`/admin/employees/${result.data.employee._id}`}>Employee</Link><Link to={`/admin/attendance?business=${encodeURIComponent(getActiveBusinessId())}&employee=${code}&preset=custom&from=${data?.range.from || ""}&to=${data?.range.to || ""}`}>Attendance</Link><Link to={`/admin/leads?scope=ALL&agent=${result.data.employee._id}`}>Leads</Link></nav>
    </>}
  </dialog>;
}
export function DashboardCustomize({ order, hidden, update, data }: { order: string[]; hidden: string[]; update: (order: string[], hidden: string[]) => void; data?: DashboardWorkspaceData }) {
  const [open, setOpen] = useState(false);
  function exportCsv() {
    if (!data) return;
    const quote = (value: unknown) => `"${String(value ?? "").replace(/^[=+@\-\t\r\n]/, "'$&").replace(/"/g, '""')}"`;
    const rows: unknown[][] = [
      ["Business", data.dashboard.business.name, "From", data.range.from, "To", data.range.to, "Generated", data.serverTime],
      ["Metric", "Value"], ...Object.entries(data.dashboard.summary),
      ["Attention", "Count"], ...data.attention.map((item) => [item.label, item.count]),
      ["Employee", "Calls", "Qualified", "Touched"], ...data.dashboard.monthlyAgents.map((agent) => [agent.employeeName, agent.calls, agent.qualified, agent.touchedLeads]),
      ["Attendance metric", "Value (duration metrics in milliseconds)"], ...Object.entries(data.attendance),
      ["Call shift day", "PH hour", "Employee ID", "Count", "Talk seconds"], ...data.calls.map((call) => [call._id.day, call._id.hour, call._id.employee, call.count, call.seconds]),
      ["Productivity day", "Activity", "Comments", "Touched"], ...data.trend.map((day) => [day.day, day.count, day.comments, day.touched]),
      ["SLA lead", "Hours overdue"], ...data.overdue.map((lead) => [lead.name, lead.hours]),
      ["Target metric", "Period", "Team", "Amount"], ...data.config.targets.map((target) => [target.metric, target.period, target.team, target.amount]),
      ["Handover", "Author", "Created", "Pinned"], ...data.notes.map((item) => [item.text, item.authorName, item.createdAt, item.pinned]),
    ];
    const url = URL.createObjectURL(new Blob([rows.map((row) => row.map(quote).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `dashboard-${data.range.from}-${data.range.to}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="dw-customize"><button type="button" aria-expanded={open} onClick={() => setOpen(!open)}><FiSettings /> Customize</button><button type="button" title="Export current dashboard CSV" disabled={!data} onClick={exportCsv}><FiDownload /></button><button type="button" title="Print daily summary" onClick={() => window.print()}><FiPrinter /></button>{open && <div>{order.map((name, index) => <div key={name}><label><input type="checkbox" checked={!hidden.includes(name)} onChange={(event) => update(order, event.target.checked ? hidden.filter((item) => item !== name) : [...hidden, name])} />{name}</label><button type="button" disabled={!index} title={`Move ${name} up`} onClick={() => { const next = [...order]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; update(next, hidden); }}><FiArrowUp /></button><button type="button" disabled={index === order.length - 1} title={`Move ${name} down`} onClick={() => { const next = [...order]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; update(next, hidden); }}><FiArrowDown /></button></div>)}</div>}</div>;
}
