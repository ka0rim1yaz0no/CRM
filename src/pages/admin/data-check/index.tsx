import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { FiCheckCircle, FiAlertTriangle, FiHelpCircle, FiPlay, FiCopy, FiDownload, FiLoader } from "react-icons/fi";
import AdminLayout from "../adminLayout";
import { getDataCheck, getDataCheckConfig } from "../../../api/dataCheck";
import { getActiveBusinessId } from "../../../api/businessStorage";
import { getAuthUser } from "../../../api/authStorage";
import { dataCheckCsv, dataCheckText, type DataCheckReport, type DataCheckRow, type DataCheckSection } from "../../../../shared/dataCheck";
import "./dataCheck.css";

const sections: DataCheckSection[] = ["Attendance", "Calls", "Leads", "Consistency"];
function value(input: number | string | null) { return input === null ? "Not available" : typeof input === "number" ? input.toLocaleString("en-PH", { maximumFractionDigits: 6 }) : input; }
function Result({ row, businessName }: { row: DataCheckRow; businessName: string }) {
    const Icon = row.status === "match" ? FiCheckCircle : row.status === "mismatch" ? FiAlertTriangle : FiHelpCircle;
    return <tr>
        <th scope="row"><details><summary><span className="data-check-business">{businessName}</span>{row.label}</summary>
            <div className="data-check-detail"><p>{row.explanation}</p><p className="data-check-proof">{row.proof}</p>
                {row.samples.length > 0 && <ul>{row.samples.map((sample, index) => <li key={`${sample.recordId}-${index}`}><span>{sample.employeeCode || "Record"}</span> <time>{sample.timestamp || "No timestamp"}</time><code>{sample.recordId}</code></li>)}</ul>}
            </div></details></th>
        <td data-label="Dashboard / expected">{value(row.dashboardValue)}</td>
        <td data-label="Recomputed">{value(row.recomputedValue)}</td>
        <td data-label="Difference">{row.difference === null ? "--" : value(row.difference)}</td>
        <td data-label="Status"><span className={`data-check-badge ${row.status}`}><Icon aria-hidden="true" />{row.status === "cannot-verify" ? "Cannot verify" : row.status === "match" ? "Match" : row.warningOnly ? "Stale" : "Mismatch"}</span></td>
    </tr>;
}
function ReportActions({ report }: { report: DataCheckReport | undefined }) {
    const [message, setMessage] = useState("");
    const copy = async () => { if (!report) return; try { await navigator.clipboard.writeText(dataCheckText(report)); setMessage("Report copied."); } catch { setMessage("Unable to copy report."); } };
    const download = () => {
        if (!report) return;
        const url = URL.createObjectURL(new Blob([dataCheckCsv(report)], { type: "text/csv;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = `data-check-${report.date}-${report.business}.csv`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return <div className="data-check-actions"><button type="button" onClick={copy} disabled={!report}><FiCopy aria-hidden="true" />Copy report</button>
        <button type="button" onClick={download} disabled={!report}><FiDownload aria-hidden="true" />Download mismatches CSV</button><span role="status">{message}</span></div>;
}
export default function DataCheck() {
    const [params, setParams] = useSearchParams();
    const activeBusiness = getActiveBusinessId();
    const actor = getAuthUser();
    const fullAdmin = actor?.userType === "admin" && actor.access !== "tracker";
    const config = useQuery({ queryKey: ["data-check-config", activeBusiness], queryFn: ({ signal }) => getDataCheckConfig(signal), enabled: fullAdmin, staleTime: 60_000, retry: false });
    const date = params.get("date") || config.data?.defaultDate || "";
    const business = params.get("business") || activeBusiness;
    const [onlyProblems, setOnlyProblems] = useState(false);
    const [run, setRun] = useState<{ date: string; business: string; revision: number; scope: string } | null>(null);
    const result = useQuery({ queryKey: ["data-check-report", actor?.user.employeeCode, run], queryFn: ({ signal }) => getDataCheck(run!.date, run!.business, signal), enabled: Boolean(run && run.scope === activeBusiness && config.data?.enabled && fullAdmin), retry: false, gcTime: 60_000 });
    const report = run?.scope === activeBusiness ? result.data : undefined;
    const change = (key: string, next: string) => { const copy = new URLSearchParams(params); copy.set(key, next); setParams(copy); };
    const businessName = report?.business === "all" ? "All businesses" : config.data?.businesses.find(item => item.id === report?.business)?.name;
    return <AdminLayout><main className="data-check-page">
        <header className="data-check-heading"><div><h1>Data Check</h1><p>{businessName || "Business records"}{report ? ` · ${report.date} · Asia/Manila` : ""}</p></div><ReportActions report={report} /></header>
        {config.isError && <div role="alert" className="data-check-error">Data Check is unavailable. Sign in again or retry the local service.</div>}
        {config.data && !config.data.enabled && <div role="status" className="data-check-empty">Data Check is disabled.</div>}
        {!fullAdmin && <div role="alert">A full administrator session is required.</div>}
        <form className="data-check-filters" onSubmit={event => { event.preventDefault(); setRun({ date, business, revision: (run?.revision || 0) + 1, scope: activeBusiness }); }}>
            <label>Shift date<input type="date" required value={date} onChange={event => change("date", event.target.value)} min="2000-01-01" /></label>
            <label>Business<select value={business} onChange={event => change("business", event.target.value)}><option value="all">All businesses</option>{config.data?.businesses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <button className="data-check-run" type="submit" disabled={!date || !config.data?.enabled || result.isFetching || !fullAdmin}>{result.isFetching ? <FiLoader className="data-check-spin" aria-hidden="true" /> : <FiPlay aria-hidden="true" />}{result.isFetching ? "Checking" : "Run check"}</button>
            <label className="data-check-toggle"><input type="checkbox" checked={onlyProblems} onChange={event => setOnlyProblems(event.target.checked)} />Show only problems</label>
        </form>
        {result.isError && <div role="alert" className="data-check-error">The check could not be completed. No records were changed. Retry after checking your session and local service.</div>}
        {report && <section className={`data-check-verdict ${report.verdict.toLowerCase()}`} aria-label="Overall verdict"><strong>{report.verdict}</strong><div className="data-check-counts"><span>{report.counts.match} match</span><span>{report.counts.mismatch} mismatch</span><span>{report.counts["cannot-verify"]} cannot verify</span></div><time dateTime={report.generatedAt}>{new Date(report.generatedAt).toLocaleString("en-PH", { timeZone: "Asia/Manila" })} PH{report.cached ? " · Cached" : ""}</time></section>}
        {!report && !result.isFetching && !result.isError && <div className="data-check-empty">No report run.</div>}
        {sections.map(section => {
            const rows = report?.checks.filter(row => row.section === section && (!onlyProblems || row.status !== "match")) || [];
            return <section className="data-check-section" key={section} aria-labelledby={`data-check-${section}`} aria-busy={result.isFetching}>
                <h2 id={`data-check-${section}`}>{section}<span>{result.isFetching ? "Checking" : rows.length}</span></h2>
                {result.isFetching ? <div className="data-check-skeleton" role="status" aria-label={`Checking ${section}`}><span /><span /><span /></div> : report && rows.length ? <table><caption className="sr-only">{section} checks for {report.date}</caption><thead><tr><th scope="col">Check</th><th scope="col">Dashboard / expected</th><th scope="col">Recomputed</th><th scope="col">Difference</th><th scope="col">Status</th></tr></thead><tbody>{rows.map(row => <Result row={row} businessName={report.businesses.find(item => item.id === row.business)?.name || row.business} key={row.id} />)}</tbody></table> : report ? <p className="data-check-empty">{onlyProblems ? "No problems in this section." : "No checks returned."}</p> : null}
            </section>;
        })}
        {report && <footer className="data-check-footnote">{report.boundaryProof}</footer>}
    </main></AdminLayout>;
}
