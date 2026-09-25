import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiArrowLeft, FiBriefcase, FiCheckCircle, FiClock, FiMessageSquare, FiSend, FiTag, FiUser } from "react-icons/fi";
import AdminLayout from "../adminLayout";
import { getAuthUser } from "../../../api/authStorage";
import { addTaskComment, getTask, updateTaskStatus, type TaskPriority, type TaskStatus } from "../../../api/tasks";
import { formatCstDateTime, formatPhDateTime } from "../../../lib/dateTime";
import { roleWorkspacePath } from "../../../lib/roleAccess";

const statuses: TaskStatus[] = ["Todo", "In Progress", "Done", "Blocked"];

const suggestedComments = [
    "Please provide an update on this task.",
    "Reviewed. Please continue and mark this done when complete.",
    "Blocked noted. Please share what support is needed.",
    "Please prioritize this today.",
    "Great work. This is confirmed.",
];

const priorityClass: Record<TaskPriority, string> = {
    Low: "border-slate-300 bg-slate-50 text-slate-600",
    Medium: "border-sky-200 bg-sky-50 text-sky-700",
    High: "border-amber-200 bg-amber-50 text-amber-700",
    Urgent: "border-red-200 bg-red-50 text-red-700",
};

const statusClass: Record<TaskStatus, string> = {
    Todo: "border-slate-300 bg-slate-50 text-slate-700",
    "In Progress": "border-blue-200 bg-blue-50 text-blue-700",
    Done: "border-emerald-200 bg-emerald-50 text-emerald-700",
    Blocked: "border-red-200 bg-red-50 text-red-700",
};

export default function AdminTaskDetail() {
    const { taskId = "" } = useParams();
    const queryClient = useQueryClient();
    const authUser = getAuthUser();
    const adminName = authUser?.userType === "admin" ? authUser.user.name || "Admin" : "Admin";
    const [commentDraft, setCommentDraft] = useState("");

    const { data: task, isLoading, isError } = useQuery({
        queryKey: ["tasks", taskId],
        queryFn: () => getTask(taskId),
        enabled: Boolean(taskId),
    });

    const comments = useMemo(
        () => [...(task?.comments || [])].sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime()),
        [task?.comments]
    );

    const updateStatusMutation = useMutation({
        mutationFn: (status: TaskStatus) => updateTaskStatus(taskId, status),
        onSuccess: (updatedTask) => {
            queryClient.setQueryData(["tasks", taskId], updatedTask);
            queryClient.invalidateQueries({ queryKey: ["tasks"] });
        },
    });

    const addCommentMutation = useMutation({
        mutationFn: (body: string) => addTaskComment(taskId, { body, authorName: adminName, authorType: "admin" }),
        onSuccess: (updatedTask) => {
            setCommentDraft("");
            queryClient.setQueryData(["tasks", taskId], updatedTask);
            queryClient.invalidateQueries({ queryKey: ["tasks"] });
        },
    });

    const submitComment = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const body = commentDraft.trim();

        if (!body || addCommentMutation.isPending) {
            return;
        }

        addCommentMutation.mutate(body);
    };

    const applySuggestedComment = (comment: string) => {
        setCommentDraft(comment);
    };

    return (
        <AdminLayout>
            <section className="min-h-[calc(100vh-8.5rem)] space-y-5 text-slate-950">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 pb-4">
                    <div>
                        <Link
                            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-slate-950"
                            to={roleWorkspacePath("/admin/tasks")}
                        >
                            <FiArrowLeft className="size-4" aria-hidden="true" />
                            Back to tasks
                        </Link>
                        <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Task Details</p>
                        <h2 className="mt-1 text-2xl font-semibold text-slate-950">{task?.title || (isLoading ? "Loading..." : "Task not found")}</h2>
                    </div>
                    {task && (
                        <span className={`rounded-lg border px-3 py-2 text-sm font-semibold ${priorityClass[task.priority]}`}>
                            {task.priority}
                        </span>
                    )}
                </div>

                {isLoading && <p className="rounded-lg border border-slate-300 bg-white p-5 text-sm font-semibold text-slate-500">Loading task...</p>}
                {isError && <p className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm font-semibold text-red-700">Unable to load this task.</p>}
                {!isLoading && !task && !isError && (
                    <div className="rounded-lg border border-slate-300 bg-white p-6">
                        <p className="text-sm font-semibold text-slate-950">This task is not available.</p>
                        <p className="mt-1 text-sm text-slate-500">It may have been archived or removed.</p>
                    </div>
                )}

                {task && (
                    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_28rem]">
                        <article className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-lg shadow-slate-950/10">
                            <div className="border-b border-slate-300 p-5">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${statusClass[task.status]}`}>
                                        {task.status}
                                    </span>
                                    {task.dueAt && (
                                        <span className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600">
                                            <FiClock className="size-3" aria-hidden="true" />
                                            {formatCstDateTime(task.dueAt)}
                                        </span>
                                    )}
                                </div>
                                <h1 className="mt-4 text-3xl font-semibold leading-tight text-slate-950">{task.title}</h1>
                                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{task.description || "No description provided."}</p>
                            </div>

                            <div className="grid gap-4 p-5 md:grid-cols-3">
                                <section className="rounded-lg border border-slate-300 bg-slate-50 p-4">
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Assigned To</p>
                                    <p className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-slate-950">
                                        <FiUser className="size-4 text-[#842cff]" aria-hidden="true" />
                                        {task.assignedTo?.name || "Unassigned"}
                                    </p>
                                </section>
                                <section className="rounded-lg border border-slate-300 bg-slate-50 p-4">
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Related Lead</p>
                                    <p className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-slate-950">
                                        <FiBriefcase className="size-4 text-[#842cff]" aria-hidden="true" />
                                        {task.relatedLead?.businessName || task.relatedLead?.leadName || "None"}
                                    </p>
                                </section>
                                <section className="rounded-lg border border-slate-300 bg-slate-50 p-4">
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Created</p>
                                    <p className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-slate-950">
                                        <FiTag className="size-4 text-[#842cff]" aria-hidden="true" />
                                        {task.createdAt ? formatPhDateTime(task.createdAt) : "-"}
                                    </p>
                                </section>
                            </div>

                            <div className="border-t border-slate-300 p-5">
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Update Status</p>
                                <div className="mt-3 grid gap-2 sm:grid-cols-4">
                                    {statuses.map((status) => (
                                        <button
                                            key={status}
                                            className={[
                                                "h-10 rounded-lg border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-70",
                                                task.status === status
                                                    ? "border-[#842cff] bg-[#842cff]/15 text-[#4a0ebd]"
                                                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-950",
                                            ].join(" ")}
                                            type="button"
                                            disabled={task.status === status || updateStatusMutation.isPending}
                                            onClick={() => updateStatusMutation.mutate(status)}
                                        >
                                            {status === "Done" && <FiCheckCircle className="mr-1 inline size-3" aria-hidden="true" />}
                                            {status}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </article>

                        <aside className="grid gap-5 self-start">
                            <section className="rounded-lg border border-slate-300 bg-white p-5 shadow-lg shadow-slate-950/10">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Suggested Comments</p>
                                        <h3 className="mt-1 text-base font-semibold text-slate-950">Quick admin replies</h3>
                                    </div>
                                    <FiMessageSquare className="size-5 text-[#842cff]" aria-hidden="true" />
                                </div>

                                <div className="mt-4 grid gap-2">
                                    {suggestedComments.map((comment) => (
                                        <button
                                            key={comment}
                                            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-left text-sm font-semibold leading-5 text-slate-700 transition hover:border-[#842cff]/50 hover:bg-[#842cff]/10 hover:text-slate-950"
                                            type="button"
                                            onClick={() => applySuggestedComment(comment)}
                                        >
                                            {comment}
                                        </button>
                                    ))}
                                </div>

                                <form className="mt-4 grid gap-3" onSubmit={submitComment}>
                                    <textarea
                                        className="min-h-28 rounded-lg border border-slate-300 bg-white p-3 text-sm leading-6 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={commentDraft}
                                        onChange={(event) => setCommentDraft(event.target.value)}
                                        placeholder="Add a comment for this task..."
                                    />
                                    <button
                                        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
                                        type="submit"
                                        disabled={addCommentMutation.isPending || !commentDraft.trim()}
                                    >
                                        <FiSend className="size-4" aria-hidden="true" />
                                        {addCommentMutation.isPending ? "Saving..." : "Add Comment"}
                                    </button>
                                </form>
                            </section>

                            <section className="content-scroll max-h-[28rem] overflow-auto rounded-lg border border-slate-300 bg-white p-4 shadow-lg shadow-slate-950/10">
                                <div className="mb-3">
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Comments</p>
                                    <h3 className="mt-1 text-base font-semibold text-slate-950">{comments.length} task notes</h3>
                                </div>
                                <div className="grid gap-3">
                                    {comments.length > 0 ? (
                                        comments.map((comment) => (
                                            <article key={comment._id || `${comment.createdAt}-${comment.body}`} className="rounded-lg border border-slate-300 bg-slate-50 p-3">
                                                <div className="flex items-start justify-between gap-3">
                                                    <p className="text-sm font-semibold text-slate-950">{comment.authorName || "Admin"}</p>
                                                    <p className="shrink-0 text-xs text-slate-500">{comment.createdAt ? formatPhDateTime(comment.createdAt) : ""}</p>
                                                </div>
                                                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">{comment.body}</p>
                                            </article>
                                        ))
                                    ) : (
                                        <p className="rounded-lg border border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">No comments yet.</p>
                                    )}
                                </div>
                            </section>
                        </aside>
                    </div>
                )}
            </section>
        </AdminLayout>
    );
}
