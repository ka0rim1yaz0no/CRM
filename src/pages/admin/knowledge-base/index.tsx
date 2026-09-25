import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import {
    FiChevronLeft,
    FiChevronRight,
    FiEdit2,
    FiExternalLink,
    FiFileText,
    FiAlertTriangle,
    FiHelpCircle,
    FiImage,
    FiMessageCircle,
    FiPlus,
    FiSave,
    FiSearch,
    FiTrash2,
    FiX,
} from "react-icons/fi";
import AdminLayout from "../adminLayout";
import {
    approveKnowledgeBaseSuggestion,
    archiveKnowledgeBaseEntry,
    createKnowledgeBaseEntry,
    getKnowledgeBaseSuggestions,
    rejectKnowledgeBaseSuggestion,
    getKnowledgeBaseEntries,
    uploadKnowledgeBaseDocument,
    uploadKnowledgeBasePhoto,
    updateKnowledgeBaseEntry,
    type KnowledgeBaseEntry,
    type KnowledgeBaseDocument,
    type KnowledgeBaseEntryType,
    type KnowledgeBaseInput,
    type KnowledgeBaseSuggestion,
} from "../../../api/knowledgeBase";
import { formatCstDateTime } from "../../../lib/dateTime";
import { backendOrigin } from "../../../lib/backendUrl";
import { formatStoredMultilineText } from "../../../lib/textFormat";
import { isRichTextContent, sanitizeRichText } from "../../../lib/richText";

const emptyProduct: KnowledgeBaseInput = {
    entryType: "Product",
    title: "",
    category: "",
    description: "",
    scope: "",
    photoUrls: [],
    documents: [],
    question: "",
    answer: "",
    status: "Active",
};

const emptyFaq: KnowledgeBaseInput = {
    ...emptyProduct,
    entryType: "FAQ",
};

const emptyArticle: KnowledgeBaseInput = {
    ...emptyProduct,
    entryType: "Article",
};

const knowledgeBaseTabs = ["Product", "Article"] as const;
const folderTabClipPath = "polygon(0 0, calc(100% - 2rem) 0, 100% 100%, 0 100%)";

function getTabFromSearchParam(value: string | null): KnowledgeBaseEntryType | null {
    const normalizedValue = String(value || "").trim().toLowerCase();

    if (normalizedValue === "products" || normalizedValue === "product") return "Product";
    if (normalizedValue === "announcements" || normalizedValue === "announcement" || normalizedValue === "article" || normalizedValue === "articles") {
        return "Article";
    }

    return null;
}

function getSearchParamForTab(tab: KnowledgeBaseEntryType) {
    return tab === "Article" ? "announcements" : "products";
}

function getTabLabel(tab: KnowledgeBaseEntryType) {
    if (tab === "Product") return "Products";
    if (tab === "Article") return "Announcements";
    return "FAQ";
}

function getEntryKindLabel(entryType: KnowledgeBaseEntryType) {
    if (entryType === "Product") return "Product";
    if (entryType === "Article") return "Announcement";
    return "FAQ";
}

function getEntryKindClass(entryType: KnowledgeBaseEntryType) {
    if (entryType === "Product") return "border-blue-200 bg-blue-50 !text-blue-700";
    if (entryType === "Article") return "border-red-200 bg-red-50 !text-red-700";
    return "border-slate-200 bg-slate-50 !text-slate-700";
}

function getFolderTabTone(tab: KnowledgeBaseEntryType) {
    if (tab === "Product") {
        return {
            labelColor: "#0852c9",
            activeFill: "#ffffff",
            inactiveFill: "#e8f1ff",
            hoverFill: "#dceaff",
            accentColor: "#2563eb",
            shadow: "0 -10px 20px rgba(37, 99, 235, 0.16)",
        };
    }

    return {
        labelColor: "#c00018",
        activeFill: "#ffffff",
        inactiveFill: "#fff0f2",
        hoverFill: "#ffe1e6",
        accentColor: "#e11d48",
        shadow: "0 -10px 20px rgba(225, 29, 72, 0.14)",
    };
}

function getPrimaryButtonClass(activeTab: KnowledgeBaseEntryType) {
    void activeTab;
    return "flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110";
}

function resizeTextareaToContent(textarea: HTMLTextAreaElement) {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
}

function entryToInput(entry: KnowledgeBaseEntry): KnowledgeBaseInput {
    return {
        entryType: entry.entryType,
        title: entry.title,
        category: entry.category || "",
        description: formatStoredMultilineText(entry.description),
        scope: formatStoredMultilineText(entry.scope),
        photoUrls: entry.photoUrls,
        documents: entry.documents || [],
        question: formatStoredMultilineText(entry.question),
        answer: formatStoredMultilineText(entry.answer),
        comments: entry.comments || [],
        status: entry.status,
    };
}

function getFileUrl(url: string) {
    const cleanUrl = String(url || "").trim();
    const legacyDocumentPrefix = "/uploads/knowledge-base/documents/";
    const legacyPhotoPrefix = "/uploads/knowledge-base/";

    if (!cleanUrl) return "";
    if (/^(https?:|data:|blob:)/i.test(cleanUrl)) return cleanUrl;
    if (cleanUrl.startsWith(legacyDocumentPrefix)) {
        return `${backendOrigin}/api/knowledge-base/documents/file/${encodeURIComponent(cleanUrl.slice(legacyDocumentPrefix.length))}`;
    }
    if (cleanUrl.startsWith(legacyPhotoPrefix)) {
        return `${backendOrigin}/api/knowledge-base/photos/file/${encodeURIComponent(cleanUrl.slice(legacyPhotoPrefix.length))}`;
    }

    return `${backendOrigin}${cleanUrl.startsWith("/") ? cleanUrl : `/${cleanUrl}`}`;
}

type KnowledgeBaseImageProps = {
    src?: string;
    alt: string;
    className: string;
    fallbackClassName: string;
    iconClassName?: string;
};

function KnowledgeBaseImage({ src = "", alt, className, fallbackClassName, iconClassName = "size-5" }: KnowledgeBaseImageProps) {
    const [hasError, setHasError] = useState(false);
    const imageUrl = getFileUrl(src);

    if (!imageUrl || hasError) {
        return (
            <span className={fallbackClassName} title="Image file is not available">
                <FiImage className={iconClassName} aria-hidden="true" />
            </span>
        );
    }

    return <img className={className} src={imageUrl} alt={alt} onError={() => setHasError(true)} />;
}

function toDisplayText(value: unknown, fallback = "") {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return toDisplayText(record.name || record.title || record.question || record.label || record._id, fallback);
    }

    return fallback;
}

export default function AdminKnowledgeBase() {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const [activeTab, setActiveTab] = useState<KnowledgeBaseEntryType>("Product");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isEntryModalOpen, setIsEntryModalOpen] = useState(false);
    const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
    const [detailEntry, setDetailEntry] = useState<KnowledgeBaseEntry | null>(null);
    const [previewDocument, setPreviewDocument] = useState<KnowledgeBaseDocument | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseEntry | null>(null);
    const [suggestionEntryFilter, setSuggestionEntryFilter] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [isSearchSuggestionsOpen, setIsSearchSuggestionsOpen] = useState(false);
    const [activeSearchSuggestionIndex, setActiveSearchSuggestionIndex] = useState(-1);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [productForm, setProductForm] = useState<KnowledgeBaseInput>(emptyProduct);
    const [faqForm, setFaqForm] = useState<KnowledgeBaseInput>(emptyFaq);
    const [articleForm, setArticleForm] = useState<KnowledgeBaseInput>(emptyArticle);

    const { data: entries = [], isLoading, isError } = useQuery({
        queryKey: ["knowledge-base"],
        queryFn: () => getKnowledgeBaseEntries(),
    });

    const { data: pendingSuggestions = [] } = useQuery({
        queryKey: ["knowledge-base-suggestions", "Pending"],
        queryFn: () => getKnowledgeBaseSuggestions({ status: "Pending" }),
    });
    const normalizedEntries = useMemo(
        () =>
            entries.map((entry) => ({
                ...entry,
                title: toDisplayText(entry.title),
                category: toDisplayText(entry.category),
                description: formatStoredMultilineText(toDisplayText(entry.description)),
                scope: formatStoredMultilineText(toDisplayText(entry.scope)),
                question: formatStoredMultilineText(toDisplayText(entry.question)),
                answer: formatStoredMultilineText(toDisplayText(entry.answer)),
                status: toDisplayText(entry.status, "Active") as KnowledgeBaseEntry["status"],
                photoUrls: (entry.photoUrls || []).map((url) => toDisplayText(url)).filter(Boolean),
                documents: (entry.documents || []).map((document) => ({
                    name: toDisplayText(document.name, "Document"),
                    url: toDisplayText(document.url),
                    mimeType: toDisplayText(document.mimeType, "application/octet-stream"),
                })),
            })),
        [entries]
    );
    const activeEntries = useMemo(
        () => normalizedEntries.filter((entry) => entry.entryType === activeTab),
        [activeTab, normalizedEntries]
    );
    const searchSuggestions = useMemo(() => {
        const query = searchTerm.trim().toLowerCase();
        if (!query) return [];

        return normalizedEntries
            .filter((entry) => entry.entryType === activeTab && entry.title.trim())
            .filter((entry) => entry.title.toLowerCase().includes(query))
            .sort((firstEntry, secondEntry) => {
                const firstTitle = firstEntry.title.toLowerCase();
                const secondTitle = secondEntry.title.toLowerCase();
                const firstStartsWithQuery = firstTitle.startsWith(query);
                const secondStartsWithQuery = secondTitle.startsWith(query);

                if (firstStartsWithQuery !== secondStartsWithQuery) {
                    return firstStartsWithQuery ? -1 : 1;
                }

                const firstWordStartsWithQuery = firstTitle.split(/\s+/).some((word) => word.startsWith(query));
                const secondWordStartsWithQuery = secondTitle.split(/\s+/).some((word) => word.startsWith(query));

                if (firstWordStartsWithQuery !== secondWordStartsWithQuery) {
                    return firstWordStartsWithQuery ? -1 : 1;
                }

                return firstEntry.title.localeCompare(secondEntry.title);
            })
            .slice(0, 6);
    }, [activeTab, normalizedEntries, searchTerm]);
    const totalPages = Math.max(1, Math.ceil(activeEntries.length / pageSize));
    const safePage = Math.min(page, totalPages);
    const pageStart = activeEntries.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
    const pageEnd = Math.min(safePage * pageSize, activeEntries.length);
    const paginatedEntries = useMemo(
        () => activeEntries.slice((safePage - 1) * pageSize, safePage * pageSize),
        [activeEntries, pageSize, safePage]
    );
    const currentForm = activeTab === "Product" ? productForm : activeTab === "Article" ? articleForm : faqForm;
    const isProductOrAnnouncement = activeTab === "Product" || activeTab === "Article";
    const detailsForm = activeTab === "Article" ? articleForm : productForm;
    const updateDetailsForm = (updater: (form: KnowledgeBaseInput) => KnowledgeBaseInput) => {
        if (activeTab === "Article") {
            setArticleForm(updater);
            return;
        }

        setProductForm(updater);
    };
    const visibleSuggestions = useMemo(
        () =>
            pendingSuggestions.filter((suggestion) => {
                if (suggestion.entryType !== activeTab) {
                    return false;
                }

                if (!suggestionEntryFilter) {
                    return true;
                }

                const entryId = typeof suggestion.entry === "string" ? suggestion.entry : suggestion.entry._id;
                return entryId === suggestionEntryFilter;
            }),
        [activeTab, pendingSuggestions, suggestionEntryFilter]
    );
    const pendingCountByEntryId = useMemo(() => {
        const counts = new Map<string, number>();

        pendingSuggestions.forEach((suggestion) => {
            const entryId = typeof suggestion.entry === "string" ? suggestion.entry : suggestion.entry._id;
            counts.set(entryId, (counts.get(entryId) || 0) + 1);
        });

        return counts;
    }, [pendingSuggestions]);

    useEffect(() => {
        setPage(1);
    }, [activeTab, pageSize]);

    useEffect(() => {
        setActiveSearchSuggestionIndex(-1);
    }, [activeTab, searchTerm]);

    useEffect(() => {
        const tabFromSearch = getTabFromSearchParam(searchParams.get("tab"));

        if (tabFromSearch && tabFromSearch !== activeTab) {
            setActiveTab(tabFromSearch);
        }
    }, [activeTab, searchParams]);

    useEffect(() => {
        setPage((currentPage) => Math.min(currentPage, totalPages));
    }, [totalPages]);

    useEffect(() => {
        const selectedId = detailEntry?._id;

        if (selectedId && activeEntries.some((entry) => entry._id === selectedId)) {
            return;
        }

        setDetailEntry(activeEntries[0] || null);
    }, [activeEntries, detailEntry?._id]);

    const invalidateKnowledge = () => queryClient.invalidateQueries({ queryKey: ["knowledge-base"] });

    const createMutation = useMutation({
        mutationFn: createKnowledgeBaseEntry,
        onSuccess: () => {
            invalidateKnowledge();
            closeModal();
        },
    });

    const updateMutation = useMutation({
        mutationFn: ({ id, entry }: { id: string; entry: KnowledgeBaseInput }) => updateKnowledgeBaseEntry(id, entry),
        onSuccess: () => {
            invalidateKnowledge();
            closeModal();
        },
    });

    const uploadPhotoMutation = useMutation({
        mutationFn: uploadKnowledgeBasePhoto,
    });

    const uploadDocumentMutation = useMutation({
        mutationFn: uploadKnowledgeBaseDocument,
        onSuccess: (document) => {
            if (activeTab === "Product") {
                setProductForm((form) => ({ ...form, documents: [...(form.documents || []), document] }));
                return;
            }

            if (activeTab === "Article") {
                setArticleForm((form) => ({ ...form, documents: [...(form.documents || []), document] }));
                return;
            }

            setFaqForm((form) => ({ ...form, documents: [...(form.documents || []), document] }));
        },
    });

    const archiveMutation = useMutation({
        mutationFn: archiveKnowledgeBaseEntry,
        onSuccess: invalidateKnowledge,
    });

    const approveSuggestionMutation = useMutation({
        mutationFn: approveKnowledgeBaseSuggestion,
        onSuccess: () => {
            invalidateKnowledge();
            queryClient.invalidateQueries({ queryKey: ["knowledge-base-suggestions"] });
        },
    });

    const rejectSuggestionMutation = useMutation({
        mutationFn: rejectKnowledgeBaseSuggestion,
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["knowledge-base-suggestions"] }),
    });

    const resetForms = () => {
        setEditingId(null);
        setProductForm(emptyProduct);
        setFaqForm(emptyFaq);
        setArticleForm(emptyArticle);
    };

    const closeModal = () => {
        setIsEntryModalOpen(false);
        resetForms();
    };

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const entry = {
            ...currentForm,
            entryType: activeTab,
            category: activeTab === "Product" || activeTab === "Article" ? "" : currentForm.category,
            scope: activeTab === "Product" || activeTab === "Article" ? "" : currentForm.scope,
            photoUrls: activeTab === "Product" || activeTab === "Article" ? currentForm.photoUrls : [],
            documents: currentForm.documents || [],
        };

        if (activeTab === "Product" && !entry.title.trim()) {
            return;
        }

        if (activeTab === "FAQ" && !entry.question.trim()) {
            return;
        }

        if (activeTab === "Article" && (!entry.title.trim() || !entry.description.trim())) {
            return;
        }

        if (editingId) {
            updateMutation.mutate({ id: editingId, entry });
            return;
        }

        createMutation.mutate(entry);
    };

    const startEdit = (entry: KnowledgeBaseEntry) => {
        if (entry.entryType === "Product") {
            navigate(`/admin/knowledge-base/products/${entry._id}/edit`);
            return;
        }

        if (entry.entryType === "Article") {
            navigate(`/admin/knowledge-base/announcements/${entry._id}/edit`);
            return;
        }

        setActiveTab(entry.entryType);
        setEditingId(entry._id);
        setIsEntryModalOpen(true);

        setFaqForm(entryToInput(entry));
    };

    const openNewEntry = (entryType = activeTab) => {
        if (entryType === "Article") {
            navigate("/admin/knowledge-base/announcements/new");
            return;
        }

        if (entryType === "Product") {
            navigate("/admin/knowledge-base/products/new");
            return;
        }

        setActiveTab(entryType);
        setEditingId(null);
        setProductForm(emptyProduct);
        setFaqForm(emptyFaq);
        setArticleForm(emptyArticle);
        setIsEntryModalOpen(true);
    };

    const switchTab = (tab: KnowledgeBaseEntryType) => {
        setActiveTab(tab);
        setIsSearchSuggestionsOpen(false);
        setActiveSearchSuggestionIndex(-1);
        setSearchParams({ tab: getSearchParamForTab(tab) }, { replace: true });
        resetForms();
    };

    const selectSearchSuggestion = (entry: KnowledgeBaseEntry) => {
        setSearchTerm(entry.title);
        setDetailEntry(entry);
        setIsSearchSuggestionsOpen(false);
        setActiveSearchSuggestionIndex(-1);
    };

    const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape") {
            setIsSearchSuggestionsOpen(false);
            setActiveSearchSuggestionIndex(-1);
            return;
        }

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (searchSuggestions.length === 0) return;

            event.preventDefault();
            setIsSearchSuggestionsOpen(true);
            setActiveSearchSuggestionIndex((currentIndex) => {
                if (event.key === "ArrowDown") {
                    return currentIndex >= searchSuggestions.length - 1 ? 0 : currentIndex + 1;
                }

                return currentIndex <= 0 ? searchSuggestions.length - 1 : currentIndex - 1;
            });
            return;
        }

        if (event.key === "Enter" && isSearchSuggestionsOpen && activeSearchSuggestionIndex >= 0) {
            const selectedEntry = searchSuggestions[activeSearchSuggestionIndex];

            if (selectedEntry) {
                event.preventDefault();
                selectSearchSuggestion(selectedEntry);
            }
        }
    };

    const openSuggestions = (entry?: KnowledgeBaseEntry) => {
        setSuggestionEntryFilter(entry?._id || null);
        setIsSuggestionsOpen(true);
    };

    const openDeletePrompt = (entry: KnowledgeBaseEntry) => {
        setDeleteTarget(entry);
    };

    const closeDeletePrompt = () => {
        setDeleteTarget(null);
    };

    const confirmDelete = () => {
        if (!deleteTarget) return;
        archiveMutation.mutate(deleteTarget._id, { onSuccess: closeDeletePrompt });
    };

    const isSaving = createMutation.isPending || updateMutation.isPending || uploadPhotoMutation.isPending || uploadDocumentMutation.isPending;


    return (
        <AdminLayout>
            <section className="min-h-[calc(100vh-8.5rem)]">
                <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-4">
                    <div>
                        <h2 className="text-xl font-semibold text-white">Knowledge Base</h2>
                        <p className="mt-1 text-sm text-white/45">Products and announcements for agents.</p>
                    </div>
                    <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
                        <div
                            className="relative w-[24rem] max-w-full"
                            onBlur={(event) => {
                                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                    setIsSearchSuggestionsOpen(false);
                                    setActiveSearchSuggestionIndex(-1);
                                }
                            }}
                        >
                            <label className="flex h-10 w-full items-center gap-2 rounded-lg border border-white/10 bg-[#090b13]/80 px-3 text-white/45 transition focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                                <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                                <input
                                    className="h-full min-w-0 flex-1 bg-transparent text-sm font-semibold text-white outline-none placeholder:text-white/35"
                                    value={searchTerm}
                                    onChange={(event) => {
                                        const nextSearchTerm = event.target.value;
                                        setSearchTerm(nextSearchTerm);
                                        setIsSearchSuggestionsOpen(Boolean(nextSearchTerm.trim()));
                                    }}
                                    onFocus={() => setIsSearchSuggestionsOpen(Boolean(searchTerm.trim()))}
                                    onKeyDown={handleSearchKeyDown}
                                    placeholder={`Search ${getTabLabel(activeTab).toLowerCase()}`}
                                    type="search"
                                    role="combobox"
                                    aria-autocomplete="list"
                                    aria-expanded={isSearchSuggestionsOpen}
                                    aria-controls="knowledge-base-search-suggestions"
                                    aria-activedescendant={
                                        activeSearchSuggestionIndex >= 0
                                            ? `knowledge-base-search-suggestion-${searchSuggestions[activeSearchSuggestionIndex]?._id}`
                                            : undefined
                                    }
                                />
                            </label>
                            {isSearchSuggestionsOpen && (
                                <div
                                    id="knowledge-base-search-suggestions"
                                    className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-50 max-h-80 overflow-y-auto rounded-lg border border-white/10 bg-[#0d1018] p-1.5 shadow-2xl shadow-black/35"
                                    role="listbox"
                                >
                                    {searchSuggestions.length > 0 ? (
                                        searchSuggestions.map((entry, index) => (
                                            <button
                                                key={entry._id}
                                                id={`knowledge-base-search-suggestion-${entry._id}`}
                                                className={[
                                                    "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left transition",
                                                    activeSearchSuggestionIndex === index
                                                        ? "bg-[#842cff]/20"
                                                        : "hover:bg-white/[0.07]",
                                                ].join(" ")}
                                                type="button"
                                                role="option"
                                                aria-selected={activeSearchSuggestionIndex === index}
                                                onMouseDown={(event) => event.preventDefault()}
                                                onClick={() => selectSearchSuggestion(entry)}
                                            >
                                                <KnowledgeBaseImage
                                                    src={entry.photoUrls[0]}
                                                    alt=""
                                                    className="size-9 shrink-0 rounded-md border border-white/10 object-cover"
                                                    fallbackClassName="flex size-9 shrink-0 items-center justify-center rounded-md border border-blue-300/30 bg-blue-500/10 text-blue-200"
                                                    iconClassName="size-4"
                                                />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block whitespace-normal break-words text-sm font-semibold leading-5 text-white">
                                                        {entry.title}
                                                    </span>
                                                    <span className="mt-0.5 block text-xs text-white/40">{entry.status}</span>
                                                </span>
                                            </button>
                                        ))
                                    ) : (
                                        <p className="px-3 py-3 text-sm text-white/45">
                                            No matching {getTabLabel(activeTab).toLowerCase()}.
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                        <button
                            className={getPrimaryButtonClass(activeTab)}
                            type="button"
                            onClick={() => openNewEntry()}
                        >
                            <FiPlus className="size-4" aria-hidden="true" />
                            Add {getEntryKindLabel(activeTab)}
                        </button>
                    </div>
                </div>

                <div className="pt-5">
                    <div className="relative flex h-14 items-end overflow-visible pl-0">
                        {knowledgeBaseTabs.map((tab) => {
                            const tone = getFolderTabTone(tab);
                            const isActive = activeTab === tab;

                            return (
                                <button
                                    key={tab}
                                    className={[
                                        "group relative -mr-8 h-12 w-56 border-0 bg-transparent p-0 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-[#842cff]/35",
                                        isActive ? "z-30 translate-y-px" : "z-10 hover:-translate-y-1",
                                    ].join(" ")}
                                    type="button"
                                    aria-pressed={isActive}
                                    onClick={() => switchTab(tab)}
                                >
                                    <span
                                        className="absolute inset-0 transition group-hover:brightness-[0.98]"
                                        style={{
                                            background: isActive ? tone.activeFill : tone.inactiveFill,
                                            clipPath: folderTabClipPath,
                                            boxShadow: isActive ? tone.shadow : "none",
                                        }}
                                        aria-hidden="true"
                                    />
                                    {!isActive && (
                                        <span
                                            className="absolute inset-0 opacity-0 transition group-hover:opacity-100"
                                            style={{
                                                background: tone.hoverFill,
                                                clipPath: folderTabClipPath,
                                            }}
                                            aria-hidden="true"
                                        />
                                    )}
                                    {isActive && (
                                        <span
                                            className="absolute bottom-0 left-0 h-1 w-[calc(100%-2rem)]"
                                            style={{ background: tone.accentColor }}
                                            aria-hidden="true"
                                        />
                                    )}
                                    <span
                                        className="relative z-10 flex h-full items-center px-6 pb-1 text-sm font-bold"
                                        style={{ color: tone.labelColor }}
                                    >
                                        {getTabLabel(tab)}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <section className="flex h-[calc(100vh-16rem)] min-h-[34rem] flex-col overflow-hidden rounded-b-lg rounded-tr-lg border border-white/10 bg-[#090b13]/80 shadow-2xl shadow-black/20">
                        <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-5 py-3">
                            <div>
                                <h3 className="text-base font-semibold text-white">{getTabLabel(activeTab)}</h3>
                                <p className="mt-1 text-xs text-white/40">
                                    {activeEntries.length > 0
                                        ? `Showing ${pageStart}-${pageEnd} of ${activeEntries.length}`
                                        : "No saved entries yet"}
                                </p>
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                                <span className="rounded-md bg-white/[0.06] px-2 py-1 text-xs font-medium text-white/55">
                                    {activeEntries.length}
                                </span>
                                <label className="flex items-center gap-2 text-xs font-semibold text-white/45">
                                    Rows
                                    <select
                                        className="h-9 rounded-lg border border-white/10 bg-black/20 px-2 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={pageSize}
                                        onChange={(event) => setPageSize(Number(event.target.value))}
                                    >
                                        {[10, 25, 50].map((size) => (
                                            <option key={size} value={size}>
                                                {size}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                        </div>

                        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden p-4 xl:grid-cols-[22rem_minmax(0,1fr)] 2xl:grid-cols-[24rem_minmax(0,1fr)]">
                            <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-black/10">
                                <div className="content-scroll min-h-0 flex-1 overflow-auto">
                                    {isLoading && <p className="p-5 text-sm text-white/45">Loading knowledge base...</p>}
                                    {isError && <p className="p-5 text-sm text-red-200">Unable to load knowledge base.</p>}
                                    {!isLoading && !isError && activeEntries.length === 0 && (
                                        <p className="p-5 text-sm text-white/45">{searchTerm.trim() ? "No entries match your search." : "No entries yet."}</p>
                                    )}
                                    {activeEntries.length > 0 && (
                                        <table
                                            className={[
                                                "w-full table-fixed border-separate border-spacing-0 text-left",
                                                "min-w-[22rem]",
                                            ].join(" ")}
                                        >
                                            <thead className="sticky top-0 z-10 border-b border-white/10 bg-[#0d1018] text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-white/35">
                                                {activeTab === "Product" ? (
                                                    <tr>
                                                        <th className="px-4 py-3">Title</th>
                                                        <th className="w-[4.5rem] px-4 py-3 text-right">Actions</th>
                                                    </tr>
                                                ) : activeTab === "Article" ? (
                                                    <tr>
                                                        <th className="px-4 py-3">Title</th>
                                                        <th className="w-[4.5rem] px-4 py-3 text-right">Actions</th>
                                                    </tr>
                                                ) : (
                                                    <tr>
                                                        <th className="w-[30%] px-4 py-3">Question</th>
                                                        <th className="w-[42%] px-4 py-3">Answer</th>
                                                        <th className="w-[8%] px-4 py-3">Docs</th>
                                                        <th className="w-[8%] px-4 py-3">Status</th>
                                                        <th className="w-[12%] px-4 py-3 text-right">Actions</th>
                                                    </tr>
                                                )}
                                            </thead>
                                            <tbody className="divide-y divide-white/10">
                                                {paginatedEntries.map((entry) =>
                                                    activeTab === "Product" ? (
                                                        <tr
                                                            key={entry._id}
                                                            className={[
                                                                "cursor-pointer text-sm transition odd:bg-white/[0.015] hover:bg-white/[0.05]",
                                                                detailEntry?._id === entry._id ? "bg-white/[0.08]" : "",
                                                            ].join(" ")}
                                                            onClick={() => setDetailEntry(entry)}
                                                        >
                                                            <td className="px-4 py-4 align-top">
                                                                <div className="flex min-w-0 items-start gap-3">
                                                                    <KnowledgeBaseImage
                                                                        src={entry.photoUrls[0]}
                                                                        alt={entry.title}
                                                                        className="size-11 shrink-0 rounded-lg border border-white/10 object-cover"
                                                                        fallbackClassName="flex size-11 shrink-0 items-center justify-center rounded-lg border border-blue-300/30 bg-blue-500/10 text-blue-200"
                                                                    />
                                                                    <span className="min-w-0 flex-1">
                                                                        <span className="block whitespace-normal break-words font-semibold leading-5 text-white">{entry.title}</span>
                                                                        <span className="mt-1 block truncate text-xs text-white/40">{entry.status}</span>
                                                                    </span>
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-4 align-top">
                                                                <div className="flex justify-end gap-2">
                                                                    <button
                                                                        className="flex size-8 items-center justify-center rounded-lg border border-red-400/20 bg-red-400/10 text-red-100/70 transition hover:bg-red-400/15 hover:text-red-100"
                                                                        type="button"
                                                                        onClick={() => openDeletePrompt(entry)}
                                                                        aria-label="Delete entry"
                                                                    >
                                                                        <FiTrash2 className="size-4" aria-hidden="true" />
                                                                    </button>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    ) : activeTab === "Article" ? (
                                                        <tr
                                                            key={entry._id}
                                                            className={[
                                                                "cursor-pointer text-sm transition odd:bg-white/[0.015] hover:bg-white/[0.05]",
                                                                detailEntry?._id === entry._id ? "bg-white/[0.08]" : "",
                                                            ].join(" ")}
                                                            onClick={() => setDetailEntry(entry)}
                                                        >
                                                            <td className="px-4 py-4 align-top">
                                                                <div className="flex min-w-0 items-start gap-3">
                                                                    <KnowledgeBaseImage
                                                                        src={entry.photoUrls[0]}
                                                                        alt={entry.title}
                                                                        className="size-11 shrink-0 rounded-lg border border-white/10 object-cover"
                                                                        fallbackClassName="flex size-11 shrink-0 items-center justify-center rounded-lg border border-blue-300/30 bg-blue-500/10 text-blue-200"
                                                                    />
                                                                    <span className="min-w-0 flex-1">
                                                                        <span className="block whitespace-normal break-words font-semibold leading-5 text-white">{entry.title}</span>
                                                                        <span className="mt-1 block truncate text-xs text-white/40">{entry.status}</span>
                                                                    </span>
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-4 align-top">
                                                                <div className="flex justify-end gap-2">
                                                                    <button
                                                                        className="flex size-8 items-center justify-center rounded-lg border border-red-400/20 bg-red-400/10 text-red-100/70 transition hover:bg-red-400/15 hover:text-red-100"
                                                                        type="button"
                                                                        onClick={() => openDeletePrompt(entry)}
                                                                        aria-label="Delete entry"
                                                                    >
                                                                        <FiTrash2 className="size-4" aria-hidden="true" />
                                                                    </button>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    ) : (
                                                        <tr key={entry._id} className="text-sm transition odd:bg-white/[0.015] hover:bg-white/[0.05]">
                                                            <td className="px-4 py-4 align-top">
                                                                <div className="flex min-w-0 items-start gap-3">
                                                                    <FiHelpCircle className="mt-0.5 size-4 shrink-0 text-[#9b5cff]" aria-hidden="true" />
                                                                    <p className="line-clamp-2 font-semibold text-white">{entry.question}</p>
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-4 align-top text-white/60">
                                                                <p className="line-clamp-3">{entry.answer || "No answer"}</p>
                                                            </td>
                                                            <td className="px-4 py-4 align-top">
                                                                {entry.documents?.length ? (
                                                                    <button
                                                                        className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-xs font-semibold text-white/65 transition hover:bg-white/10 hover:text-white"
                                                                        type="button"
                                                                        onClick={() => setPreviewDocument(entry.documents[0])}
                                                                    >
                                                                        <FiFileText className="size-3.5" aria-hidden="true" />
                                                                        {entry.documents.length}
                                                                    </button>
                                                                ) : (
                                                                    <span className="text-white/35">0</span>
                                                                )}
                                                            </td>
                                                            <td className="px-4 py-4 align-top text-white/65">{entry.status}</td>
                                                            <td className="px-4 py-4 align-top">
                                                                <div className="flex justify-end gap-2">
                                                                    <button
                                                                        className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white"
                                                                        type="button"
                                                                        onClick={() => startEdit(entry)}
                                                                        aria-label="Edit entry"
                                                                    >
                                                                        <FiEdit2 className="size-4" aria-hidden="true" />
                                                                    </button>
                                                                    <button
                                                                        className="relative flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white"
                                                                        type="button"
                                                                        onClick={() => openSuggestions(entry)}
                                                                        aria-label="View entry suggestions"
                                                                    >
                                                                        <FiMessageCircle className="size-4" aria-hidden="true" />
                                                                        {(pendingCountByEntryId.get(entry._id) || 0) > 0 && (
                                                                            <span className="absolute -right-1 -top-1 rounded-full bg-[#842cff] px-1 text-[0.6rem] font-bold text-white">
                                                                                {pendingCountByEntryId.get(entry._id)}
                                                                            </span>
                                                                        )}
                                                                    </button>
                                                                    <button
                                                                        className="flex size-8 items-center justify-center rounded-lg border border-red-400/20 bg-red-400/10 text-red-100/70 transition hover:bg-red-400/15 hover:text-red-100"
                                                                        type="button"
                                                                        onClick={() => openDeletePrompt(entry)}
                                                                        aria-label="Delete entry"
                                                                    >
                                                                        <FiTrash2 className="size-4" aria-hidden="true" />
                                                                    </button>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    )
                                                )}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                                <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-white/[0.025] px-5 py-3">
                                    <p className="text-xs font-medium text-white/45">
                                        Page {safePage} of {totalPages}
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <button
                                            className="flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                                            type="button"
                                            disabled={safePage <= 1}
                                            onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
                                        >
                                            <FiChevronLeft className="size-4" aria-hidden="true" />
                                            Previous
                                        </button>
                                        <span className="min-w-16 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-center text-sm font-semibold text-white">
                                            {safePage}
                                        </span>
                                        <button
                                            className="flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                                            type="button"
                                            disabled={safePage >= totalPages}
                                            onClick={() => setPage((currentPage) => Math.min(totalPages, currentPage + 1))}
                                        >
                                            Next
                                            <FiChevronRight className="size-4" aria-hidden="true" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <aside className="content-scroll min-h-0 overflow-y-auto rounded-lg border border-slate-300 bg-white/90 p-5 shadow-inner shadow-slate-200/60">
                                {detailEntry ? (
                                    <div className="grid gap-4">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${getEntryKindClass(detailEntry.entryType)}`}>
                                                    {getEntryKindLabel(detailEntry.entryType)}
                                                </span>
                                                <h3 className="mt-3 line-clamp-3 text-xl font-semibold leading-7 !text-slate-950">
                                                    {detailEntry.title || detailEntry.question || "Knowledge base entry"}
                                                </h3>
                                                <p className="mt-1 text-sm font-medium !text-slate-600">{detailEntry.status}</p>
                                            </div>
                                            <div className="flex shrink-0 gap-1">
                                                <button
                                                    className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white !text-slate-700 transition hover:bg-slate-100"
                                                    type="button"
                                                    onClick={() => startEdit(detailEntry)}
                                                    aria-label="Edit selected entry"
                                                >
                                                    <FiEdit2 className="size-4" aria-hidden="true" />
                                                </button>
                                                <button
                                                    className="relative flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white !text-slate-700 transition hover:bg-slate-100"
                                                    type="button"
                                                    onClick={() => openSuggestions(detailEntry)}
                                                    aria-label="View selected entry suggestions"
                                                >
                                                    <FiMessageCircle className="size-4" aria-hidden="true" />
                                                    {(pendingCountByEntryId.get(detailEntry._id) || 0) > 0 && (
                                                        <span className="absolute -right-1 -top-1 rounded-full bg-[#842cff] px-1 text-[0.6rem] font-bold text-white">
                                                            {pendingCountByEntryId.get(detailEntry._id)}
                                                        </span>
                                                    )}
                                                </button>
                                            </div>
                                        </div>

                                        {detailEntry.photoUrls.length > 0 && (
                                            <div className="grid gap-2">
                                                {detailEntry.photoUrls.slice(0, 2).map((url) => (
                                                    <KnowledgeBaseImage
                                                        key={url}
                                                        src={url}
                                                        alt={detailEntry.title || "Knowledge base image"}
                                                        className="max-h-[30rem] min-h-72 w-full rounded-lg border border-slate-300 bg-white object-contain"
                                                        fallbackClassName="flex min-h-72 w-full items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-500"
                                                        iconClassName="size-10"
                                                    />
                                                ))}
                                            </div>
                                        )}

                                        <div className="grid grid-cols-2 gap-2">
                                            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                                                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] !text-slate-500">Status</p>
                                                <p className="mt-1 text-sm font-semibold !text-slate-950">{detailEntry.status}</p>
                                            </div>
                                            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                                                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] !text-slate-500">Docs</p>
                                                <p className="mt-1 text-sm font-semibold !text-slate-950">{detailEntry.documents.length}</p>
                                            </div>
                                        </div>

                                        <div className="rounded-lg border border-slate-200 bg-white p-3">
                                            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] !text-slate-500">
                                                {detailEntry.entryType === "FAQ" ? "Question" : "Description"}
                                            </p>
                                            {detailEntry.entryType !== "FAQ" && isRichTextContent(detailEntry.description) ? (
                                                <div
                                                    className="knowledge-base-rich-content knowledge-base-rich-content-light mt-2 text-sm leading-6 !text-slate-800"
                                                    dangerouslySetInnerHTML={{ __html: sanitizeRichText(detailEntry.description, "-") }}
                                                />
                                            ) : (
                                                <p className="mt-2 whitespace-pre-line text-sm leading-6 !text-slate-800">
                                                    {detailEntry.entryType === "FAQ" ? detailEntry.question || "-" : detailEntry.description || "-"}
                                                </p>
                                            )}
                                        </div>

                                        {detailEntry.entryType === "FAQ" && (
                                            <div className="rounded-lg border border-slate-200 bg-white p-3">
                                                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] !text-slate-500">Answer</p>
                                                <p className="mt-2 whitespace-pre-line text-sm leading-6 !text-slate-800">{detailEntry.answer || "-"}</p>
                                            </div>
                                        )}

                                        {detailEntry.documents.length > 0 && (
                                            <div className="rounded-lg border border-slate-200 bg-white p-3">
                                                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] !text-slate-500">Documents</p>
                                                <div className="mt-2 grid gap-2">
                                                    {detailEntry.documents.map((document) => (
                                                        <button
                                                            key={document.url}
                                                            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm font-semibold !text-slate-700 transition hover:bg-slate-100"
                                                            type="button"
                                                            onClick={() => setPreviewDocument(document)}
                                                        >
                                                            <FiFileText className="size-4 shrink-0 text-[#842cff]" aria-hidden="true" />
                                                            <span className="truncate">{document.name}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="flex min-h-[24rem] flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-center">
                                        <FiFileText className="size-8 !text-slate-400" aria-hidden="true" />
                                        <p className="mt-3 text-sm font-semibold !text-slate-950">Select an entry</p>
                                        <p className="mt-1 text-xs leading-5 !text-slate-600">Click a row to preview details here.</p>
                                    </div>
                                )}
                            </aside>
                        </div>
                    </section>
                </div>

                {isSuggestionsOpen && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                setIsSuggestionsOpen(false);
                            }
                        }}
                    >
                        <div className="modal-panel-enter flex max-h-[88vh] w-full max-w-[48rem] flex-col rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40">
                            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">
                                        Pending Review
                                    </p>
                                    <h3 className="mt-1 text-base font-semibold text-white">
                                        {suggestionEntryFilter ? "Entry Suggestions" : "Knowledge Base Suggestions"}
                                    </h3>
                                </div>
                                <button
                                    className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white"
                                    type="button"
                                    onClick={() => setIsSuggestionsOpen(false)}
                                    aria-label="Close suggestions"
                                >
                                    <FiX className="size-4" aria-hidden="true" />
                                </button>
                            </div>
                            <div className="content-scroll min-h-0 flex-1 overflow-y-auto p-5">
                                {visibleSuggestions.length === 0 ? (
                                    <p className="rounded-lg border border-white/10 bg-white/[0.035] p-4 text-sm text-white/50">
                                        No pending suggestions for this view.
                                    </p>
                                ) : (
                                    <div className="grid gap-3">
                                        {visibleSuggestions.map((suggestion: KnowledgeBaseSuggestion) => {
                                            const entryName =
                                                typeof suggestion.entry === "string"
                                                    ? "Knowledge base entry"
                                                    : toDisplayText(suggestion.entry.title || suggestion.entry.question, "Knowledge base entry");

                                            return (
                                                <div
                                                    key={suggestion._id}
                                                    className="rounded-lg border border-white/10 bg-white/[0.035] p-4 transition hover:border-[#842cff]/40 hover:bg-white/[0.055]"
                                                >
                                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                                        <div className="min-w-0 flex-1">
                                                            <h4 className="truncate text-sm font-semibold text-white">{entryName}</h4>
                                                            <p className="mt-1 text-xs text-white/40">
                                                                From {toDisplayText(suggestion.submittedByName, "Employee")} · {formatCstDateTime(suggestion.createdAt)}
                                                            </p>
                                                            {suggestion.comment && (
                                                                <p className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3 text-sm leading-6 text-white/65">
                                                                    {toDisplayText(suggestion.comment)}
                                                                </p>
                                                            )}
                                                            <div className="mt-3 grid gap-2 text-xs text-white/55">
                                                                {activeTab === "Product" || activeTab === "Article" ? (
                                                                    <>
                                                                        {suggestion.title && <p><span className="font-semibold text-white/80">Title:</span> {toDisplayText(suggestion.title)}</p>}
                                                                        {suggestion.description && <p><span className="font-semibold text-white/80">Description:</span> {toDisplayText(suggestion.description)}</p>}
                                                                    </>
                                                                ) : (
                                                                    <>
                                                                        {suggestion.question && <p><span className="font-semibold text-white/80">Question:</span> {toDisplayText(suggestion.question)}</p>}
                                                                        {suggestion.answer && <p><span className="font-semibold text-white/80">Answer:</span> {toDisplayText(suggestion.answer)}</p>}
                                                                    </>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <div className="flex gap-2">
                                                            <button
                                                                className="h-9 rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-3 text-sm font-semibold text-emerald-100/80 transition hover:bg-emerald-400/15 hover:text-emerald-50"
                                                                type="button"
                                                                onClick={() => approveSuggestionMutation.mutate(suggestion._id)}
                                                            >
                                                                Approve
                                                            </button>
                                                            <button
                                                                className="h-9 rounded-lg border border-red-400/20 bg-red-400/10 px-3 text-sm font-semibold text-red-100/70 transition hover:bg-red-400/15 hover:text-red-100"
                                                                type="button"
                                                                onClick={() => rejectSuggestionMutation.mutate(suggestion._id)}
                                                            >
                                                                Reject
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {isEntryModalOpen && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                closeModal();
                            }
                        }}
                    >
                        <form
                            className="modal-panel-enter flex max-h-[90vh] w-full max-w-[76rem] flex-col rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40"
                            onSubmit={handleSubmit}
                            onMouseDown={(event) => event.stopPropagation()}
                        >
                            <div className="flex items-center justify-between border-b border-white/10 px-7 py-5">
                                <div>
                                    <p className="text-sm font-medium uppercase tracking-[0.14em] text-white/35">
                                        {editingId ? "Editing" : "New Entry"}
                                    </p>
                                    <h3 className="mt-1 text-xl font-semibold text-white">
                                        {activeTab === "Product" ? "Product or Service" : activeTab === "Article" ? "Announcement" : "FAQ"}
                                    </h3>
                                </div>
                                <button
                                    className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white"
                                    type="button"
                                    onClick={closeModal}
                                    aria-label="Close entry modal"
                                >
                                    <FiX className="size-4" aria-hidden="true" />
                                </button>
                            </div>

                            <div className="content-scroll min-h-0 flex-1 overflow-y-auto p-7">
                                {isProductOrAnnouncement ? (
                                    <div className="grid gap-5">
                                        <label>
                                            <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/35">Title</span>
                                            <input
                                                className="mt-2 h-12 w-full rounded-lg border border-white/10 bg-black/20 px-4 text-base font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                value={detailsForm.title}
                                                onChange={(event) => updateDetailsForm((form) => ({ ...form, title: event.target.value }))}
                                                placeholder={
                                                    activeTab === "Product"
                                                        ? "Website package, CRM setup, monthly support..."
                                                        : "Announcement headline"
                                                }
                                            />
                                        </label>
                                        <label>
                                            <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/35">Description</span>
                                            <textarea
                                                className="mt-2 min-h-56 w-full resize-none overflow-hidden rounded-lg border border-white/10 bg-black/20 p-4 text-base leading-7 text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                value={detailsForm.description}
                                                onChange={(event) => updateDetailsForm((form) => ({ ...form, description: event.target.value }))}
                                                onInput={(event) => resizeTextareaToContent(event.currentTarget)}
                                                placeholder={
                                                    activeTab === "Product"
                                                        ? "What this product does and who it is for."
                                                        : "Write the announcement or update agents should read."
                                                }
                                            />
                                        </label>
                                        <label>
                                            <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/35">Photos</span>
                                            <input
                                                className="mt-2 block w-full rounded-lg border border-white/10 bg-black/20 p-4 text-base text-white file:mr-3 file:rounded-md file:border-0 file:bg-[#842cff]/20 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-black hover:file:bg-[#842cff]/30"
                                                type="file"
                                                accept="image/*"
                                                multiple
                                                disabled={uploadPhotoMutation.isPending}
                                                onChange={(event) => {
                                                    Array.from(event.target.files || []).forEach((file) =>
                                                        uploadPhotoMutation.mutate(file, {
                                                            onSuccess: ({ url }) => {
                                                                updateDetailsForm((form) => ({ ...form, photoUrls: [...form.photoUrls, url] }));
                                                            },
                                                        })
                                                    );
                                                    event.target.value = "";
                                                }}
                                            />
                                            {uploadPhotoMutation.isPending && (
                                                <p className="mt-2 text-xs font-semibold text-[#9df6b7]">Uploading photo...</p>
                                            )}
                                        </label>
                                        {detailsForm.photoUrls.length > 0 && (
                                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                                {detailsForm.photoUrls.map((url) => (
                                                    <div key={url} className="group relative overflow-hidden rounded-lg border border-white/10">
                                                        <KnowledgeBaseImage
                                                            src={url}
                                                            alt={detailsForm.title || getEntryKindLabel(activeTab)}
                                                            className="h-28 w-full object-cover"
                                                            fallbackClassName="flex h-28 w-full items-center justify-center bg-blue-500/10 text-blue-200"
                                                        />
                                                        <button
                                                            className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md bg-black/70 text-white/70 opacity-0 transition group-hover:opacity-100"
                                                            type="button"
                                                            aria-label="Remove photo"
                                                            onClick={() =>
                                                                updateDetailsForm((form) => ({
                                                                    ...form,
                                                                    photoUrls: form.photoUrls.filter((photoUrl) => photoUrl !== url),
                                                                }))
                                                            }
                                                        >
                                                            <FiX className="size-4" aria-hidden="true" />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="grid gap-5">
                                        <label>
                                            <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/35">Question</span>
                                            <input
                                                className="mt-2 h-12 w-full rounded-lg border border-white/10 bg-black/20 px-4 text-base font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                value={faqForm.question}
                                                onChange={(event) => setFaqForm((form) => ({ ...form, question: event.target.value }))}
                                                placeholder="What is included in onboarding?"
                                            />
                                        </label>
                                        <label>
                                            <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/35">Answer</span>
                                            <textarea
                                                className="mt-2 min-h-40 w-full resize-y rounded-lg border border-white/10 bg-black/20 p-4 text-base leading-7 text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                value={faqForm.answer}
                                                onChange={(event) => setFaqForm((form) => ({ ...form, answer: event.target.value }))}
                                                placeholder="Write the approved answer agents should use."
                                            />
                                        </label>
                                    </div>
                                )}
                                <div className="mt-5 grid gap-4 border-t border-white/10 pt-5">
                                    <label>
                                        <span className="text-sm font-medium uppercase tracking-[0.14em] text-white/35">Documents</span>
                                        <input
                                            className="mt-2 block w-full rounded-lg border border-white/10 bg-black/20 p-4 text-base text-white file:mr-3 file:rounded-md file:border-0 file:bg-[#842cff]/20 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-black hover:file:bg-[#842cff]/30"
                                            type="file"
                                            multiple
                                            accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,image/*"
                                            disabled={uploadDocumentMutation.isPending}
                                            onChange={(event) => {
                                                Array.from(event.target.files || []).forEach((file) => uploadDocumentMutation.mutate(file));
                                                event.target.value = "";
                                            }}
                                        />
                                        {uploadDocumentMutation.isPending && (
                                            <p className="mt-2 text-xs font-semibold text-[#9df6b7]">Uploading document...</p>
                                        )}
                                    </label>
                                    {(currentForm.documents || []).length > 0 && (
                                        <div className="grid gap-2">
                                            {(currentForm.documents || []).map((document) => (
                                                <div
                                                    key={document.url}
                                                    className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2"
                                                >
                                                    <button
                                                        className="flex min-w-0 items-center gap-2 text-left text-sm font-semibold text-white/70 transition hover:text-white"
                                                        type="button"
                                                        onClick={() => setPreviewDocument(document)}
                                                    >
                                                        <FiFileText className="size-4 shrink-0 text-[#9b5cff]" aria-hidden="true" />
                                                        <span className="truncate">{document.name}</span>
                                                    </button>
                                                    <button
                                                        className="flex size-7 items-center justify-center rounded-md bg-black/40 text-white/50 transition hover:text-white"
                                                        type="button"
                                                        aria-label="Remove document"
                                                        onClick={() => {
                                                            if (activeTab === "Product") {
                                                                setProductForm((form) => ({
                                                                    ...form,
                                                                    documents: (form.documents || []).filter((item) => item.url !== document.url),
                                                                }));
                                                                return;
                                                            }

                                                            if (activeTab === "Article") {
                                                                setArticleForm((form) => ({
                                                                    ...form,
                                                                    documents: (form.documents || []).filter((item) => item.url !== document.url),
                                                                }));
                                                                return;
                                                            }

                                                            setFaqForm((form) => ({
                                                                ...form,
                                                                documents: (form.documents || []).filter((item) => item.url !== document.url),
                                                            }));
                                                        }}
                                                    >
                                                        <FiX className="size-4" aria-hidden="true" />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="flex justify-end gap-3 border-t border-white/10 px-7 py-4">
                                <button
                                    className="h-11 rounded-lg border border-white/10 bg-white/[0.05] px-5 text-base font-semibold text-white/60 transition hover:bg-white/10 hover:text-white"
                                    type="button"
                                    onClick={closeModal}
                                >
                                    Cancel
                                </button>
                                <button
                                    className="flex h-11 items-center justify-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-5 text-base font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                                    type="submit"
                                    disabled={isSaving}
                                >
                                    {editingId ? <FiSave className="size-4" aria-hidden="true" /> : <FiPlus className="size-4" aria-hidden="true" />}
                                    {editingId ? "Save Entry" : "Add Entry"}
                                </button>
                            </div>
                        </form>
                    </div>
                )}

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
                                    <a
                                        className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white"
                                        href={getFileUrl(previewDocument.url)}
                                        target="_blank"
                                        rel="noreferrer"
                                        aria-label="Open document"
                                    >
                                        <FiExternalLink className="size-4" aria-hidden="true" />
                                    </a>
                                    <button
                                        className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white"
                                        type="button"
                                        onClick={() => setPreviewDocument(null)}
                                        aria-label="Close document preview"
                                    >
                                        <FiX className="size-4" aria-hidden="true" />
                                    </button>
                                </div>
                            </div>
                            <div className="min-h-0 flex-1 bg-black/30 p-4">
                                {previewDocument.mimeType.startsWith("image/") ? (
                                    <KnowledgeBaseImage
                                        src={previewDocument.url}
                                        alt={previewDocument.name}
                                        className="h-full w-full rounded-lg object-contain"
                                        fallbackClassName="flex h-full w-full items-center justify-center rounded-lg border border-white/10 bg-white/[0.035] text-[#9b5cff]"
                                        iconClassName="size-10"
                                    />
                                ) : previewDocument.mimeType === "application/pdf" || previewDocument.mimeType.startsWith("text/") ? (
                                    <iframe
                                        className="h-full w-full rounded-lg border border-white/10 bg-white"
                                        src={getFileUrl(previewDocument.url)}
                                        title={previewDocument.name}
                                    />
                                ) : (
                                    <div className="flex h-full flex-col items-center justify-center rounded-lg border border-white/10 bg-white/[0.035] text-center">
                                        <FiFileText className="size-10 text-[#9b5cff]" aria-hidden="true" />
                                        <p className="mt-3 text-sm font-semibold text-white">Preview is not available for this file type.</p>
                                        <a
                                            className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg border border-[#842cff]/35 bg-[#842cff]/15 px-4 text-sm font-semibold text-[#d8c8ff] transition hover:bg-[#842cff]/25 hover:text-white"
                                            href={getFileUrl(previewDocument.url)}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            <FiExternalLink className="size-4" aria-hidden="true" />
                                            Open Document
                                        </a>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {deleteTarget && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                closeDeletePrompt();
                            }
                        }}
                    >
                        <div className="modal-panel-enter w-full max-w-[32rem] overflow-hidden rounded-lg border border-red-400/20 bg-[#0d1018] shadow-2xl shadow-red-950/30">
                            <div className="bg-[radial-gradient(circle_at_15%_20%,rgba(239,68,68,0.22),transparent_35%),linear-gradient(135deg,rgba(239,68,68,0.12),rgba(132,44,255,0.08))] px-5 py-4">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex items-start gap-3">
                                        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-red-300/20 bg-red-500/15 text-red-100">
                                            <FiAlertTriangle className="size-5" aria-hidden="true" />
                                        </span>
                                        <div>
                                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-red-100/55">Delete KB Entry</p>
                                            <h3 className="mt-1 text-lg font-semibold text-white">
                                                Are you sure?
                                            </h3>
                                            <p className="mt-1 text-sm text-red-50/60">
                                                This will remove it from active knowledge base records.
                                            </p>
                                        </div>
                                    </div>
                                    <button className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/20 text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={closeDeletePrompt} aria-label="Close delete confirmation">
                                        <FiX className="size-4" aria-hidden="true" />
                                    </button>
                                </div>
                            </div>
                            <div className="p-5">
                                <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Selected Entry</p>
                                    <p className="mt-2 text-sm font-semibold text-white">{deleteTarget.title || deleteTarget.question}</p>
                                    <p className="mt-1 text-xs text-white/45">{deleteTarget.entryType}</p>
                                </div>
                                <div className="mt-3 rounded-lg border border-yellow-300/20 bg-yellow-300/10 p-3">
                                    <p className="text-sm leading-6 text-yellow-50/75">
                                        Are you sure you want to delete {deleteTarget.title || deleteTarget.question}?
                                    </p>
                                </div>
                            </div>
                            <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                                <button className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={closeDeletePrompt}>Cancel</button>
                                <button className="h-10 rounded-lg bg-red-500 px-4 text-sm font-semibold text-white transition hover:bg-red-400 disabled:opacity-60" type="button" onClick={confirmDelete} disabled={archiveMutation.isPending}>Delete Entry</button>
                            </div>
                        </div>
                    </div>
                )}
            </section>
        </AdminLayout>
    );
}
