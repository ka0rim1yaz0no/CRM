import { useMemo, useState } from "react";
import { FiCheckCircle, FiChevronLeft, FiChevronRight, FiPhoneMissed, FiSearch, FiVoicemail } from "react-icons/fi";
import type { EmployeeCallSummaryRow } from "../pages/admin/dashboard/legacyMath";
import { formatPhDateTime } from "../lib/dateTime";

export default function DashboardCallCounts({ rows, connected, missed, voicemail, leads, loading, error, retry, select, from, to }: {
    rows: EmployeeCallSummaryRow[]; connected: number; missed: number; voicemail: number; leads: number;
    loading: boolean; error: boolean; retry: () => void; select: (row: EmployeeCallSummaryRow) => void; from?: string; to?: string;
}) {
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const matching = useMemo(() => rows.filter((row) => `${row.employeeName} ${row.employeeRole} ${row.employeeTeam}`.toLowerCase().includes(search.trim().toLowerCase())), [rows, search]);
    const pages = Math.max(1, Math.ceil(matching.length / 8));
    const current = Math.min(page, pages);
    return <section className="dw-call-counts" aria-labelledby="logged-calls-title">
        <header><div><h3 id="logged-calls-title">Log Call Counts</h3><p>{from && to ? `${from} to ${to} · PH shift dates` : "Recorded call outcomes"}</p></div>
            <label className="dw-call-search"><FiSearch aria-hidden="true" /><input type="search" aria-label="Search logged call employees" placeholder="Search employees" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label>
        </header>
        <dl className="dw-call-totals">
            <div><dt><FiCheckCircle /> Connected</dt><dd>{connected.toLocaleString()}</dd></div>
            <div><dt><FiPhoneMissed /> Not connected</dt><dd>{missed.toLocaleString()}</dd></div>
            <div><dt><FiVoicemail /> Voicemail</dt><dd>{voicemail.toLocaleString()}</dd></div>
            <div><dt>Leads</dt><dd>{leads.toLocaleString()}</dd></div>
        </dl>
        {loading ? <p className="dw-call-empty" role="status">Loading call counts...</p> : error ? <p className="dw-call-empty" role="alert">Call counts could not load. <button type="button" onClick={retry}>Retry</button></p> : !matching.length ? <p className="dw-call-empty">{search ? "No employees match your search." : "No recorded call outcomes for this period."}</p> : <>
            <div className="dw-call-table"><table><thead><tr><th scope="col">Employee</th><th scope="col">Connected</th><th scope="col">Not connected</th><th scope="col">Voicemail</th><th scope="col">Leads</th><th scope="col">Last call</th></tr></thead><tbody>
                {matching.slice((current - 1) * 8, current * 8).map((row) => <tr key={row.employeeId}>
                    <th scope="row"><button type="button" className="dw-call-employee" onClick={() => select(row)}>{row.employeeName}</button><small>{[row.employeeRole, row.employeeTeam].filter(Boolean).join(" · ")}</small></th>
                    <td><button className="connected" aria-label={`Connected calls for ${row.employeeName}`} type="button" onClick={() => select(row)}>{row.totalCalls.toLocaleString()}</button></td>
                    <td><button className="missed" aria-label={`Not connected calls for ${row.employeeName}`} type="button" onClick={() => select(row)}>{row.totalNotConnectedCalls.toLocaleString()}</button></td>
                    <td><button className="voicemail" aria-label={`Voicemails for ${row.employeeName}`} type="button" onClick={() => select(row)}>{row.totalVoicemails.toLocaleString()}</button></td>
                    <td>{row.leads.length}</td><td>{row.lastCallAt ? formatPhDateTime(row.lastCallAt) : "No recorded call"}</td>
                </tr>)}
            </tbody></table></div>
            <footer><span>{matching.length} employees</span><nav aria-label="Logged call employee pages"><button type="button" title="Previous call-count page" disabled={current === 1} onClick={() => setPage(current - 1)}><FiChevronLeft /></button><span>{current} / {pages}</span><button type="button" title="Next call-count page" disabled={current === pages} onClick={() => setPage(current + 1)}><FiChevronRight /></button></nav></footer>
        </>}
    </section>;
}
