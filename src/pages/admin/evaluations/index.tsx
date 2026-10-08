import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiCheckCircle, FiEdit2, FiSearch, FiX } from "react-icons/fi";
import { getAuthUser } from "../../../api/authStorage";
import { getEmployeeSummaries } from "../../../api/employees";
import { getEvaluations, saveEvaluation, updateEvaluation, type EmployeeEvaluation, type EvaluationInput } from "../../../api/evaluations";
import { formatPhDate } from "../../../lib/dateTime";
import { getEmployeeEvaluationSchedule, type EmployeeEvaluationSchedule } from "../../../lib/employeeEvaluation";
import AdminLayout from "../adminLayout";

type EvaluationFilter = "All" | "Due soon" | "Overdue" | "Upcoming" | "Draft" | "Completed";

type EvaluationRow = EmployeeEvaluationSchedule & {
    evaluation?: EmployeeEvaluation;
};

const emptyForm: EvaluationInput = {
    status: "Draft",
    rating: null,
    strengths: "",
    improvementAreas: "",
    managerNotes: "",
    reviewedBy: "Admin",
};

function evaluationKey(employeeCode: string, milestoneMonth: number, dueDate: string | Date) {
    const key = typeof dueDate === "string" ? dueDate.slice(0, 10) : dueDate.toISOString().slice(0, 10);
    return `${employeeCode}-${milestoneMonth}-${key}`;
}

function statusLabel(row: EvaluationRow) {
    if (row.evaluation?.status === "Completed") return "Completed";
    if (row.evaluation?.status === "Draft") return "Draft";
    if (row.daysUntilDue < 0) return "Overdue";
    if (row.daysUntilDue <= 5) return row.daysUntilDue === 0 ? "Due today" : "Due soon";
    return "Upcoming";
}

function statusClass(label: string) {
    if (label === "Completed") return "border-emerald-300/30 bg-emerald-400/10 text-emerald-200";
    if (label === "Overdue") return "border-red-300/30 bg-red-400/10 text-red-200";
    if (label === "Due today" || label === "Due soon") return "border-amber-300/30 bg-amber-400/10 text-amber-100";
    if (label === "Draft") return "border-sky-300/30 bg-sky-400/10 text-sky-100";
    return "border-white/10 bg-white/[0.05] text-white/55";
}

export default function AdminEvaluations() {
    const queryClient = useQueryClient();
    const authUser = getAuthUser();
    const adminName = authUser?.user.name || "Admin";
    const [filter, setFilter] = useState<EvaluationFilter>("All");
    const [search, setSearch] = useState("");
    const [selectedRow, setSelectedRow] = useState<EvaluationRow | null>(null);
    const [form, setForm] = useState<EvaluationInput>({ ...emptyForm, reviewedBy: adminName });
    const [errorMessage, setErrorMessage] = useState("");
    const employeesQuery = useQuery({ queryKey: ["employees", "summary", "evaluations"], queryFn: getEmployeeSummaries });
    const evaluationsQuery = useQuery({ queryKey: ["evaluations"], queryFn: getEvaluations });
    const rows = useMemo(() => {
        const evaluationsByKey = new Map((evaluationsQuery.data || []).map((evaluation) => [
            evaluationKey(evaluation.employeeCode, evaluation.milestoneMonth, evaluation.dueDate),
            evaluation,
        ]));
        return getEmployeeEvaluationSchedule(employeesQuery.data || []).map((schedule) => ({
            ...schedule,
            evaluation: evaluationsByKey.get(evaluationKey(schedule.employeeCode, schedule.milestoneMonth, schedule.dueDate)),
        }));
    }, [employeesQuery.data, evaluationsQuery.data]);
    const visibleRows = useMemo(() => {
        const term = search.trim().toLowerCase();
        return rows.filter((row) => {
            const label = statusLabel(row);
            const matchesFilter = filter === "All"
                || (filter === "Due soon" && (label === "Due soon" || label === "Due today"))
                || label === filter;
            const matchesSearch = !term || `${row.employeeName} ${row.employeeCode} ${row.milestoneMonth}`.toLowerCase().includes(term);
            return matchesFilter && matchesSearch;
        });
    }, [filter, rows, search]);
    const counts = useMemo(() => ({
        overdue: rows.filter((row) => statusLabel(row) === "Overdue").length,
        dueSoon: rows.filter((row) => ["Due soon", "Due today"].includes(statusLabel(row))).length,
        completed: rows.filter((row) => statusLabel(row) === "Completed").length,
    }), [rows]);
    const saveMutation = useMutation({
        mutationFn: (status: "Draft" | "Completed") => {
            if (!selectedRow) throw new Error("Select an evaluation first.");
            const input = {
                ...form,
                status,
                employeeId: selectedRow.employeeId,
                milestoneMonth: selectedRow.milestoneMonth,
                dueDate: selectedRow.dueDate.toISOString().slice(0, 10),
            };
            return selectedRow.evaluation
                ? updateEvaluation(selectedRow.evaluation._id, input)
                : saveEvaluation(input);
        },
        onSuccess: () => {
            setSelectedRow(null);
            setErrorMessage("");
            queryClient.invalidateQueries({ queryKey: ["evaluations"] });
            queryClient.invalidateQueries({ queryKey: ["employee-recent-activity"] });
        },
        onError: (error) => setErrorMessage(error instanceof Error ? error.message : "Unable to save evaluation."),
    });
    const openEvaluation = (row: EvaluationRow) => {
        setSelectedRow(row);
        setErrorMessage("");
        setForm(row.evaluation ? {
            status: row.evaluation.status,
            rating: row.evaluation.rating,
            strengths: row.evaluation.strengths,
            improvementAreas: row.evaluation.improvementAreas,
            managerNotes: row.evaluation.managerNotes,
            reviewedBy: row.evaluation.reviewedBy || adminName,
        } : { ...emptyForm, reviewedBy: adminName });
    };
    const loading = employeesQuery.isPending || evaluationsQuery.isPending;

    return (
        <AdminLayout>
            <section className="space-y-5">
                <div className="theme-surface-bg rounded-lg border border-white/10 p-5">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">People Operations</p>
                    <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
                        <div>
                            <h2 className="text-2xl font-semibold text-white">Employee Evaluations</h2>
                            <p className="mt-1 text-sm text-white/45">Track hire-date evaluations at 1, 3, and 6 months.</p>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                            {[["Overdue", counts.overdue], ["Due soon", counts.dueSoon], ["Completed", counts.completed]].map(([label, value]) => (
                                <div key={label} className="min-w-24 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2">
                                    <p className="text-xl font-semibold text-white">{value}</p>
                                    <p className="text-xs text-white/40">{label}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="theme-surface-bg rounded-lg border border-white/10">
                    <div className="flex flex-wrap items-center gap-3 border-b border-white/10 p-4">
                        <label className="flex h-10 min-w-64 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3">
                            <FiSearch className="size-4 text-white/35" aria-hidden="true" />
                            <input className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search employee or code" />
                        </label>
                        <div className="flex flex-wrap gap-2">
                            {(["All", "Due soon", "Overdue", "Upcoming", "Draft", "Completed"] as EvaluationFilter[]).map((item) => (
                                <button key={item} className={["h-9 rounded-lg px-3 text-xs font-semibold transition", filter === item ? "bg-white text-black" : "border border-white/10 bg-white/[0.04] text-white/60 hover:bg-white/10 hover:text-white"].join(" ")} type="button" onClick={() => setFilter(item)}>{item}</button>
                            ))}
                        </div>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[780px] text-left">
                            <thead className="border-b border-white/10 text-xs uppercase tracking-[0.12em] text-white/35">
                                <tr><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Milestone</th><th className="px-4 py-3">Due date</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Rating</th><th className="px-4 py-3 text-right">Action</th></tr>
                            </thead>
                            <tbody className="divide-y divide-white/10">
                                {visibleRows.map((row) => {
                                    const label = statusLabel(row);
                                    return (
                                        <tr key={row.id} className="text-sm text-white/70 hover:bg-white/[0.025]">
                                            <td className="px-4 py-3"><p className="font-semibold text-white">{row.employeeName}</p><p className="mt-1 text-xs text-white/35">{row.employeeCode || "No employee code"}</p></td>
                                            <td className="px-4 py-3 font-semibold">{row.milestoneMonth}-month</td>
                                            <td className="px-4 py-3">{formatPhDate(row.dueDate.toISOString())}</td>
                                            <td className="px-4 py-3"><span className={`rounded-md border px-2 py-1 text-xs font-semibold ${statusClass(label)}`}>{label}</span></td>
                                            <td className="px-4 py-3">{row.evaluation?.rating ? `${row.evaluation.rating}/5` : "-"}</td>
                                            <td className="px-4 py-3 text-right"><button className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-xs font-semibold text-white/70 hover:bg-white/10 hover:text-white" type="button" onClick={() => openEvaluation(row)}><FiEdit2 aria-hidden="true" />{row.evaluation ? "Open" : "Start"}</button></td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    {loading && <p className="p-6 text-center text-sm text-white/45">Loading evaluations...</p>}
                    {!loading && visibleRows.length === 0 && <p className="p-8 text-center text-sm text-white/45">No evaluations match this view.</p>}
                </div>
            </section>

            {selectedRow && (
                <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Employee evaluation">
                    <div className="theme-modal-bg max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-white/10 shadow-2xl">
                        <div className="flex items-start justify-between gap-4 border-b border-white/10 p-5">
                            <div><p className="text-xs uppercase tracking-[0.14em] text-white/35">{selectedRow.milestoneMonth}-month evaluation</p><h3 className="mt-1 text-xl font-semibold text-white">{selectedRow.employeeName}</h3><p className="mt-1 text-sm text-white/45">Due {formatPhDate(selectedRow.dueDate.toISOString())}</p></div>
                            <button className="grid size-9 place-items-center rounded-lg border border-white/10 text-white/60 hover:bg-white/10 hover:text-white" type="button" aria-label="Close evaluation" onClick={() => setSelectedRow(null)}><FiX aria-hidden="true" /></button>
                        </div>
                        <div className="grid gap-4 p-5">
                            <label><span className="text-xs uppercase tracking-[0.12em] text-white/40">Overall rating</span><select className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#090b13] px-3 text-sm text-white outline-none" value={form.rating ?? ""} onChange={(event) => setForm((current) => ({ ...current, rating: event.target.value ? Number(event.target.value) : null }))}><option value="">Select rating</option>{[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating} - {rating === 1 ? "Needs improvement" : rating === 2 ? "Developing" : rating === 3 ? "Meets expectations" : rating === 4 ? "Exceeds expectations" : "Outstanding"}</option>)}</select></label>
                            {[["Strengths", "strengths"], ["Improvement areas", "improvementAreas"], ["Manager notes", "managerNotes"]].map(([label, key]) => <label key={key}><span className="text-xs uppercase tracking-[0.12em] text-white/40">{label}</span><textarea className="mt-2 min-h-24 w-full resize-y rounded-lg border border-white/10 bg-[#090b13] p-3 text-sm leading-6 text-white outline-none placeholder:text-white/25" value={String(form[key as keyof EvaluationInput] || "")} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
                            <label><span className="text-xs uppercase tracking-[0.12em] text-white/40">Reviewed by</span><input className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#090b13] px-3 text-sm text-white outline-none" value={form.reviewedBy} onChange={(event) => setForm((current) => ({ ...current, reviewedBy: event.target.value }))} /></label>
                            {errorMessage && <p className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">{errorMessage}</p>}
                        </div>
                        <div className="flex flex-wrap justify-end gap-2 border-t border-white/10 p-5">
                            <button className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-50" type="button" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate(selectedRow.evaluation?.status === "Completed" ? "Completed" : "Draft")}>{selectedRow.evaluation?.status === "Completed" ? "Save Changes" : "Save Draft"}</button>
                            <button className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-400 px-4 text-sm font-semibold text-black hover:bg-emerald-300 disabled:opacity-50" type="button" disabled={saveMutation.isPending || !form.rating} onClick={() => saveMutation.mutate("Completed")}><FiCheckCircle aria-hidden="true" />Complete Evaluation</button>
                        </div>
                    </div>
                </div>
            )}
        </AdminLayout>
    );
}
