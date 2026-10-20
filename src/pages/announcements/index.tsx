import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { FiExternalLink, FiFileText, FiSearch, FiX } from "react-icons/fi";
import { getAuthUser } from "../../api/authStorage";
import {
    getKnowledgeBaseEntries,
    type KnowledgeBaseDocument,
    type KnowledgeBaseEntry,
} from "../../api/knowledgeBase";
import { getLatestAnnouncementTimestamp, writeAnnouncementSeenAt } from "../../lib/announcementReadState";
import { backendOrigin } from "../../lib/backendUrl";
import { fileBusinessUrl } from "../../lib/fileBusinessUrl";
import { getPlainTextFromRichText } from "../../lib/richText";
import MainLayout from "../layout";

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

function getAnnouncementPath(entry: KnowledgeBaseEntry) {
    return `/announcements/${entry._id}`;
}

export default function Announcements() {
    const navigate = useNavigate();
    const authUser = getAuthUser();
    const employeeId = authUser?.userType === "employee" ? authUser.user._id : "";
    const [previewDocument, setPreviewDocument] = useState<KnowledgeBaseDocument | null>(null);
    const [searchTerm, setSearchTerm] = useState("");

    const { data: entries = [], isLoading, isError } = useQuery({
        queryKey: ["knowledge-base", "Article"],
        queryFn: () => getKnowledgeBaseEntries("Article"),
    });

    const announcements = useMemo(
        () => entries.filter((entry) => entry.entryType === "Article" && entry.status === "Active"),
        [entries]
    );

    useEffect(() => {
        if (isLoading || isError || !employeeId) return;

        writeAnnouncementSeenAt(employeeId, getLatestAnnouncementTimestamp(announcements));
    }, [announcements, employeeId, isError, isLoading]);

    const filteredAnnouncements = useMemo(() => {
        const query = searchTerm.trim().toLowerCase();

        if (!query) {
            return announcements;
        }

        return announcements.filter((entry) =>
            [
                entry.title,
                entry.description,
                entry.status,
                ...(entry.documents || []).map((document) => document.name),
            ]
                .join(" ")
                .toLowerCase()
                .includes(query)
        );
    }, [announcements, searchTerm]);

    return (
        <MainLayout>
            <section className="flex h-[calc(100vh-8.5rem)] min-h-[34rem] flex-col overflow-hidden">
                <div className="flex shrink-0 flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-4">
                    <div>
                        <h2 className="text-xl font-semibold text-white">Announcements</h2>
                        <p className="mt-1 text-sm text-white/45">Read the latest admin updates and company notices.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <label className="flex h-11 w-[24rem] max-w-full items-center gap-3 rounded-lg border border-white/10 bg-[#090b13]/80 px-3 text-white/45 transition focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                            <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                            <input
                                className="h-full min-w-0 flex-1 bg-transparent text-sm font-semibold text-white outline-none placeholder:text-white/35"
                                value={searchTerm}
                                onChange={(event) => setSearchTerm(event.target.value)}
                                placeholder="Search announcements"
                                type="search"
                            />
                        </label>
                        <span className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-sm font-semibold text-white/65">
                            {filteredAnnouncements.length} active
                        </span>
                    </div>
                </div>

                <div className="min-h-0 flex-1 pt-5">
                    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-[#090b13]/80">
                        <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-white/10 px-5">
                            <h3 className="text-base font-semibold text-white">Latest Announcements</h3>
                            <span className="rounded-md bg-white/[0.06] px-2 py-1 text-xs font-medium text-white/55">{filteredAnnouncements.length}</span>
                        </div>

                        <div className="content-scroll min-h-0 flex-1 overflow-auto">
                            {isLoading && <p className="p-5 text-sm text-white/45">Loading announcements...</p>}
                            {isError && <p className="p-5 text-sm text-red-200">Unable to load announcements.</p>}
                            {!isLoading && !isError && filteredAnnouncements.length === 0 && (
                                <p className="p-5 text-sm text-white/45">{searchTerm.trim() ? "No announcements match your search." : "No announcements yet."}</p>
                            )}
                            {filteredAnnouncements.length > 0 && (
                                <table className="w-full min-w-[44rem] table-fixed text-left">
                                    <thead className="sticky top-0 z-10 border-b border-white/10 bg-[#0d1018] text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-white/35">
                                        <tr>
                                            <th className="w-[40%] px-4 py-3">Announcement</th>
                                            <th className="w-[44%] px-4 py-3">Content</th>
                                            <th className="w-[8%] px-4 py-3">Docs</th>
                                            <th className="w-[8%] px-4 py-3 text-right">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-white/10">
                                        {filteredAnnouncements.map((entry) => (
                                            <tr
                                                key={entry._id}
                                                className="cursor-pointer text-sm transition odd:bg-white/[0.015] hover:bg-white/[0.05]"
                                                onClick={() => navigate(getAnnouncementPath(entry))}
                                            >
                                                <td className="px-4 py-4 align-top">
                                                    <p className="line-clamp-2 font-semibold text-white">{entry.title}</p>
                                                    <p className="mt-1 text-xs text-white/40">{entry.status}</p>
                                                </td>
                                                <td className="px-4 py-4 align-top text-white/60">
                                                    <p className="line-clamp-3 whitespace-pre-line">{getPlainTextFromRichText(entry.description)}</p>
                                                </td>
                                                <td className="px-4 py-4 align-top">
                                                    {entry.documents?.length ? (
                                                        <button
                                                            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-xs font-semibold text-white/65 transition hover:bg-white/10 hover:text-white"
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                setPreviewDocument(entry.documents[0]);
                                                            }}
                                                        >
                                                            <FiFileText className="size-3.5" aria-hidden="true" />
                                                            {entry.documents.length}
                                                        </button>
                                                    ) : (
                                                        <span className="text-white/35">0</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-4 align-top text-right">
                                                    <button
                                                        className="inline-flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white"
                                                        type="button"
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            navigate(getAnnouncementPath(entry));
                                                        }}
                                                        aria-label="Open announcement"
                                                    >
                                                        <FiExternalLink className="size-4" aria-hidden="true" />
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </section>
                </div>

                {previewDocument && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                setPreviewDocument(null);
                            }
                        }}
                    >
                        <div className="modal-panel-enter flex h-[88vh] w-full max-w-[56rem] flex-col overflow-hidden rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40">
                            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
                                <div className="min-w-0">
                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Document Preview</p>
                                    <h3 className="mt-1 truncate text-base font-semibold text-white">{previewDocument.name}</h3>
                                </div>
                                <div className="flex gap-2">
                                    <a className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white" href={getFileUrl(previewDocument.url)} target="_blank" rel="noreferrer" aria-label="Open document">
                                        <FiExternalLink className="size-4" aria-hidden="true" />
                                    </a>
                                    <button className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={() => setPreviewDocument(null)} aria-label="Close document preview">
                                        <FiX className="size-4" aria-hidden="true" />
                                    </button>
                                </div>
                            </div>
                            <div className="min-h-0 flex-1 bg-black/30 p-4">
                                {previewDocument.mimeType === "application/pdf" || previewDocument.mimeType.startsWith("text/") || previewDocument.mimeType.startsWith("image/") ? (
                                    <iframe className="h-full w-full rounded-lg border border-white/10 bg-white" src={getFileUrl(previewDocument.url)} title={previewDocument.name} />
                                ) : (
                                    <div className="flex h-full flex-col items-center justify-center rounded-lg border border-white/10 bg-white/[0.035] text-center">
                                        <FiFileText className="size-10 text-[#9b5cff]" aria-hidden="true" />
                                        <p className="mt-3 text-sm font-semibold text-white">Preview is not available for this file type.</p>
                                        <a className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg border border-[#842cff]/35 bg-[#842cff]/15 px-4 text-sm font-semibold text-[#d8c8ff] transition hover:bg-[#842cff]/25 hover:text-white" href={getFileUrl(previewDocument.url)} target="_blank" rel="noreferrer">
                                            <FiExternalLink className="size-4" aria-hidden="true" />
                                            Open Document
                                        </a>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </section>
        </MainLayout>
    );
}
