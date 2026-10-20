import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiArrowLeft, FiExternalLink, FiFileText, FiImage, FiSearch, FiSend } from "react-icons/fi";
import { getAuthUser } from "../../api/authStorage";
import {
    createKnowledgeBaseSuggestion,
    getKnowledgeBaseEntries,
    type KnowledgeBaseDocument,
    type KnowledgeBaseEntry,
    type KnowledgeBaseEntryType,
    type KnowledgeBaseSuggestionInput,
} from "../../api/knowledgeBase";
import { getAnnouncementTimestamp, writeAnnouncementSeenAt } from "../../lib/announcementReadState";
import { backendOrigin } from "../../lib/backendUrl";
import { fileBusinessUrl } from "../../lib/fileBusinessUrl";
import { formatStoredMultilineText } from "../../lib/textFormat";
import { isRichTextContent, sanitizeRichText } from "../../lib/richText";
import MainLayout from "../layout";

const emptySuggestion = {
    comment: "",
    title: "",
    description: "",
};

function getEntryTypeFromRoute(entryKind?: string): Extract<KnowledgeBaseEntryType, "Product" | "Article"> {
    return entryKind === "products" ? "Product" : "Article";
}

function getEntryKindLabel(entryType: KnowledgeBaseEntryType) {
    return entryType === "Product" ? "Product" : "Announcement";
}

function getFileUrl(url: string) {
    const cleanUrl = String(url || "").trim();
    const legacyDocumentPrefix = "/uploads/knowledge-base/documents/";
    const legacyPhotoPrefix = "/uploads/knowledge-base/";

    if (!cleanUrl) return "";
    if (/^(https?:|data:|blob:)/i.test(cleanUrl)) return fileBusinessUrl(cleanUrl);
    if (cleanUrl.startsWith(legacyDocumentPrefix)) {
        return fileBusinessUrl(`${backendOrigin}/api/knowledge-base/documents/file/${encodeURIComponent(cleanUrl.slice(legacyDocumentPrefix.length))}`);
    }
    if (cleanUrl.startsWith(legacyPhotoPrefix)) {
        return fileBusinessUrl(`${backendOrigin}/api/knowledge-base/photos/file/${encodeURIComponent(cleanUrl.slice(legacyPhotoPrefix.length))}`);
    }

    return fileBusinessUrl(`${backendOrigin}${cleanUrl.startsWith("/") ? cleanUrl : `/${cleanUrl}`}`);
}

function getEntryPath(entry: KnowledgeBaseEntry) {
    return entry.entryType === "Article" ? `/announcements/${entry._id}` : `/knowledge-base/products/${entry._id}`;
}

function KnowledgeBaseImage({ entry }: { entry: KnowledgeBaseEntry }) {
    const [hasError, setHasError] = useState(false);
    const imageUrl = getFileUrl(entry.photoUrls?.[0] || "");

    if (!imageUrl || hasError) {
        return (
            <div className="flex min-h-[18rem] items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-[#9b5cff]">
                <FiImage className="size-10" aria-hidden="true" />
            </div>
        );
    }

    return (
        <img
            className="max-h-[32rem] w-full rounded-lg border border-white/10 bg-white/[0.04] object-contain"
            src={imageUrl}
            alt={entry.title}
            onError={() => setHasError(true)}
        />
    );
}

function DocumentList({ documents }: { documents: KnowledgeBaseDocument[] }) {
    if (!documents.length) {
        return <p className="rounded-lg border border-white/10 bg-white/[0.035] p-4 text-sm text-white/45">No documents attached.</p>;
    }

    return (
        <div className="grid gap-2">
            {documents.map((document) => (
                <a
                    key={`${document.url}-${document.name}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.045] px-4 py-3 text-sm font-semibold text-white/75 transition hover:bg-white/10 hover:text-white"
                    href={getFileUrl(document.url)}
                    target="_blank"
                    rel="noreferrer"
                >
                    <span className="flex min-w-0 items-center gap-2">
                        <FiFileText className="size-4 shrink-0 text-[#9b5cff]" aria-hidden="true" />
                        <span className="truncate">{document.name}</span>
                    </span>
                    <FiExternalLink className="size-4 shrink-0" aria-hidden="true" />
                </a>
            ))}
        </div>
    );
}

export default function KnowledgeBaseDetail() {
    const { entryKind, entryId } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const authUser = getAuthUser();
    const employeeId = authUser?.userType === "employee" ? authUser.user._id : "";
    const queryClient = useQueryClient();
    const [suggestionForm, setSuggestionForm] = useState(emptySuggestion);
    const [notice, setNotice] = useState("");
    const [searchTerm, setSearchTerm] = useState("");
    const entryType = getEntryTypeFromRoute(entryKind);
    const backPath = entryType === "Article" || location.pathname.startsWith("/announcements") ? "/announcements" : "/knowledge-base";
    const backLabel = entryType === "Article" || location.pathname.startsWith("/announcements") ? "Back to Announcements" : "Back to Knowledge Base";

    const { data: entries = [], isLoading, isError } = useQuery({
        queryKey: ["knowledge-base", entryType],
        queryFn: () => getKnowledgeBaseEntries(entryType),
    });

    const entry = useMemo(
        () => entries.find((item) => item._id === entryId && item.entryType === entryType && item.status === "Active"),
        [entries, entryId, entryType]
    );

    useEffect(() => {
        if (!entry || entry.entryType !== "Article" || !employeeId) return;

        writeAnnouncementSeenAt(employeeId, getAnnouncementTimestamp(entry));
    }, [employeeId, entry]);

    const searchResults = useMemo(() => {
        const query = searchTerm.trim().toLowerCase();

        if (!query) {
            return [];
        }

        return entries
            .filter((item) => item.entryType === entryType && item.status === "Active")
            .filter((item) =>
                [
                    item.title,
                    item.description,
                    item.category,
                    item.scope,
                    item.question,
                    item.answer,
                    ...(item.documents || []).map((document) => document.name),
                ]
                    .join(" ")
                    .toLowerCase()
                    .includes(query)
            )
            .slice(0, 6);
    }, [entries, entryType, searchTerm]);

    const submitSuggestionMutation = useMutation({
        mutationFn: createKnowledgeBaseSuggestion,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["knowledge-base-suggestions"] });
            setSuggestionForm(emptySuggestion);
            setNotice("Suggestion sent to admin.");
        },
    });

    const submitSuggestion = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!entry) {
            return;
        }

        const employee = authUser?.userType === "employee" ? authUser.user : null;
        const suggestion: KnowledgeBaseSuggestionInput = {
            entry: entry._id,
            entryType: entry.entryType,
            comment: suggestionForm.comment,
            title: suggestionForm.title,
            category: "",
            description: suggestionForm.description,
            scope: "",
            submittedById: employee?._id || "",
            submittedByName: employee?.name || "Employee",
        };

        submitSuggestionMutation.mutate(suggestion);
    };

    return (
        <MainLayout>
            <section className="flex h-[calc(100vh-8.5rem)] min-h-[34rem] flex-col overflow-hidden">
                <div className="mb-5 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
                    <div>
                        <Link className="inline-flex items-center gap-2 text-sm font-semibold text-white/60 transition hover:text-white" to={backPath}>
                            <FiArrowLeft className="size-4" aria-hidden="true" />
                            {backLabel}
                        </Link>
                        <p className="mt-4 text-xs font-medium uppercase tracking-[0.16em] text-white/35">{getEntryKindLabel(entryType)}</p>
                        <h2 className="mt-1 text-2xl font-semibold text-white">
                            {entry?.title || (isLoading ? "Loading..." : "Entry not found")}
                        </h2>
                    </div>
                    <div className="relative w-[25rem] max-w-full">
                        <label className="flex h-11 items-center gap-3 rounded-lg border border-white/10 bg-[#090b13]/80 px-3 text-white/45 transition focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                            <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                            <input
                                className="h-full min-w-0 flex-1 bg-transparent text-sm font-semibold text-white outline-none placeholder:text-white/35"
                                value={searchTerm}
                                onChange={(event) => setSearchTerm(event.target.value)}
                                placeholder={`Search ${entryType === "Article" ? "announcements" : "products"}`}
                                type="search"
                            />
                        </label>
                        {searchTerm.trim() && (
                            <div className="absolute right-0 top-12 z-40 w-full overflow-hidden rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40">
                                {searchResults.length > 0 ? (
                                    searchResults.map((result) => (
                                        <button
                                            key={result._id}
                                            className="block w-full border-b border-white/10 px-3 py-3 text-left text-sm transition last:border-b-0 hover:bg-white/[0.06]"
                                            type="button"
                                            onClick={() => {
                                                setSearchTerm("");
                                                navigate(getEntryPath(result));
                                            }}
                                        >
                                            <span className="block truncate font-semibold text-white">{result.title || result.question}</span>
                                            <span className="mt-1 block truncate text-xs text-white/45">{getEntryKindLabel(result.entryType)}</span>
                                        </button>
                                    ))
                                ) : (
                                    <p className="px-3 py-3 text-sm text-white/45">No matches found.</p>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {isLoading && <p className="rounded-lg border border-white/10 bg-[#090b13]/80 p-5 text-sm text-white/45">Loading entry...</p>}
                {isError && <p className="rounded-lg border border-red-400/20 bg-red-500/10 p-5 text-sm text-red-100">Unable to load this entry.</p>}
                {!isLoading && !isError && !entry && (
                    <div className="rounded-lg border border-white/10 bg-[#090b13]/80 p-6">
                        <p className="text-sm font-semibold text-white">This entry is not available.</p>
                        <p className="mt-1 text-sm text-white/50">It may have been archived or moved.</p>
                    </div>
                )}

                {entry && (
                    <div className="content-scroll grid min-h-0 flex-1 gap-5 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_24rem] xl:overflow-hidden">
                        <article className="flex min-h-[28rem] flex-col overflow-hidden rounded-lg border border-white/10 bg-[#090b13]/80 shadow-xl shadow-black/10">
                            <div className="shrink-0 border-b border-white/10 p-6">
                                <span className="inline-flex rounded-md border border-[#842cff]/35 bg-[#842cff]/15 px-2.5 py-1 text-xs font-semibold text-[#d8c8ff]">
                                    {getEntryKindLabel(entry.entryType)}
                                </span>
                                <h1 className="mt-4 text-3xl font-semibold leading-tight text-white">{entry.title}</h1>
                            </div>
                            <div className="content-scroll grid min-h-0 flex-1 gap-6 overflow-y-auto p-6">
                                {entry.photoUrls?.length > 0 && <KnowledgeBaseImage entry={entry} />}
                                <section>
                                    <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-white/35">Content</h3>
                                    {isRichTextContent(entry.description) ? (
                                        <div
                                            className="knowledge-base-rich-content mt-3 text-base leading-8 text-white/75"
                                            dangerouslySetInnerHTML={{ __html: sanitizeRichText(entry.description, "No content yet.") }}
                                        />
                                    ) : (
                                        <p className="mt-3 whitespace-pre-line text-base leading-8 text-white/75">
                                            {formatStoredMultilineText(entry.description, "No content yet.")}
                                        </p>
                                    )}
                                </section>
                            </div>
                        </article>

                        <aside className="grid gap-5 self-start xl:max-h-full xl:overflow-hidden">
                            <section className="rounded-lg border border-white/10 bg-[#090b13]/80 p-5 shadow-xl shadow-black/10">
                                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-white/35">Documents</h3>
                                <div className="mt-4">
                                    <DocumentList documents={entry.documents || []} />
                                </div>
                            </section>

                            <form className="rounded-lg border border-white/10 bg-[#090b13]/80 p-5 shadow-xl shadow-black/10" onSubmit={submitSuggestion}>
                                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-white/35">Suggest Update</h3>
                                <div className="mt-4 grid gap-3">
                                    <textarea
                                        className="min-h-24 rounded-lg border border-white/10 bg-black/20 p-3 text-sm leading-6 text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={suggestionForm.comment}
                                        onChange={(event) => setSuggestionForm((form) => ({ ...form, comment: event.target.value }))}
                                        placeholder="What should admin know?"
                                    />
                                    <input
                                        className="h-11 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={suggestionForm.title}
                                        onChange={(event) => setSuggestionForm((form) => ({ ...form, title: event.target.value }))}
                                        placeholder="Suggested title"
                                    />
                                    <textarea
                                        className="min-h-28 rounded-lg border border-white/10 bg-black/20 p-3 text-sm leading-6 text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={suggestionForm.description}
                                        onChange={(event) => setSuggestionForm((form) => ({ ...form, description: event.target.value }))}
                                        placeholder="Suggested content"
                                    />
                                    {notice && <p className="rounded-lg border border-emerald-400/20 bg-emerald-500/10 p-3 text-sm font-semibold text-emerald-100">{notice}</p>}
                                    <button
                                        className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
                                        type="submit"
                                        disabled={submitSuggestionMutation.isPending}
                                    >
                                        <FiSend className="size-4" aria-hidden="true" />
                                        Send Suggestion
                                    </button>
                                </div>
                            </form>
                        </aside>
                    </div>
                )}
            </section>
        </MainLayout>
    );
}
