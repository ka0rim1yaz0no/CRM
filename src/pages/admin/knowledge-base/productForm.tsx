import type { FormEvent } from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { FiArrowLeft, FiImage, FiPlus, FiSave, FiTrash2 } from "react-icons/fi";
import { CKEditor } from "@ckeditor/ckeditor5-react";
import "ckeditor5/ckeditor5.css";
import AdminLayout from "../adminLayout";
import {
    createKnowledgeBaseEntry,
    getKnowledgeBaseEntries,
    updateKnowledgeBaseEntry,
    uploadKnowledgeBasePhoto,
    type KnowledgeBaseEntry,
    type KnowledgeBaseInput,
} from "../../../api/knowledgeBase";
import { useToast } from "../../../lib/toast";
import { getPlainTextFromRichText } from "../../../lib/richText";
import { ClassicEditor, createKnowledgeBaseEditorConfig, normalizeKnowledgeBaseRichTextImages } from "./richTextEditor";
import { backendOrigin } from "../../../lib/backendUrl";
import { fileBusinessUrl } from "../../../lib/fileBusinessUrl";

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

function entryToInput(entry: KnowledgeBaseEntry): KnowledgeBaseInput {
    return {
        entryType: "Product",
        title: entry.title || "",
        category: "",
        description: entry.description || "",
        scope: "",
        photoUrls: entry.photoUrls || [],
        documents: entry.documents || [],
        question: "",
        answer: "",
        comments: entry.comments || [],
        status: entry.status || "Active",
    };
}

type KnowledgeBaseImageProps = {
    src?: string;
    alt: string;
    className: string;
    fallbackClassName: string;
    iconClassName?: string;
};

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


const editorConfig = createKnowledgeBaseEditorConfig("What this product does and who it is for.");

export default function AdminProductForm() {
    const navigate = useNavigate();
    const { entryId } = useParams();
    const queryClient = useQueryClient();
    const { showToast } = useToast();
    const [form, setForm] = useState<KnowledgeBaseInput>(emptyProduct);
    const [initialEditorData, setInitialEditorData] = useState("");
    const [loadedEntryId, setLoadedEntryId] = useState<string | null>(null);
    const [isPreparingImages, setIsPreparingImages] = useState(false);
    const isEditing = Boolean(entryId);

    const { data: entries = [], isLoading: isLoadingEntries } = useQuery({
        queryKey: ["knowledge-base"],
        queryFn: () => getKnowledgeBaseEntries(),
        enabled: isEditing,
    });
    const editEntry = entries.find((entry) => entry._id === entryId);

    const [previousProductDraft, setPreviousProductDraft] = useState<readonly unknown[] | null>(null);
    const productDraftInputs = [editEntry, isEditing, loadedEntryId];
    if (previousProductDraft === null || productDraftInputs.some((input, index) => !Object.is(input, previousProductDraft[index]))) {
        setPreviousProductDraft(productDraftInputs);
        (() => {
            if (!isEditing) {
                setInitialEditorData("");
                setLoadedEntryId(null);
                return;
            }

            if (!editEntry || loadedEntryId === editEntry._id) {
                return;
            }

            const nextForm = entryToInput(editEntry);
            setForm(nextForm);
            setInitialEditorData(nextForm.description);
            setLoadedEntryId(editEntry._id);
        })();
    }

    const createMutation = useMutation({
        mutationFn: createKnowledgeBaseEntry,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["knowledge-base"] });
            showToast({ tone: "success", message: "Product added." });
            navigate("/admin/knowledge-base?tab=products");
        },
        onError: () => showToast({ tone: "error", message: "Could not add product." }),
    });

    const updateMutation = useMutation({
        mutationFn: ({ id, entry }: { id: string; entry: KnowledgeBaseInput }) => updateKnowledgeBaseEntry(id, entry),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["knowledge-base"] });
            showToast({ tone: "success", message: "Product updated." });
            navigate("/admin/knowledge-base?tab=products");
        },
        onError: () => showToast({ tone: "error", message: "Could not update product." }),
    });

    const uploadPhotoMutation = useMutation({
        mutationFn: uploadKnowledgeBasePhoto,
    });

    const isSaving = createMutation.isPending || updateMutation.isPending || isPreparingImages || uploadPhotoMutation.isPending;

    const updateField = <K extends keyof KnowledgeBaseInput>(
        field: K,
        value: KnowledgeBaseInput[K]
    ) => {
        setForm((currentForm) => ({
            ...currentForm,
            [field]: value,
        }));
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!form.title.trim() || !getPlainTextFromRichText(form.description).trim()) {
            showToast({ tone: "error", message: "Title and description are required." });
            return;
        }

        setIsPreparingImages(true);

        let description = form.description;

        try {
            description = await normalizeKnowledgeBaseRichTextImages(form.description);
            setForm((currentForm) => ({ ...currentForm, description }));
        } catch {
            showToast({ tone: "error", message: "Could not upload an editor image. Please try again." });
            setIsPreparingImages(false);
            return;
        }

        const entry: KnowledgeBaseInput = {
            ...form,
            description,
            entryType: "Product",
            category: "",
            scope: "",
            question: "",
            answer: "",
        };

        if (isEditing && entryId) {
            updateMutation.mutate({ id: entryId, entry });
            setIsPreparingImages(false);
            return;
        }

        createMutation.mutate(entry);
        setIsPreparingImages(false);
    };

    if (isEditing && isLoadingEntries) {
        return (
            <AdminLayout>
                <section className="min-h-[calc(100vh-8.5rem)] rounded-lg border border-slate-300 bg-white p-6 text-sm font-semibold text-slate-600">
                    Loading product...
                </section>
            </AdminLayout>
        );
    }

    if (isEditing && (!editEntry || editEntry.entryType !== "Product")) {
        return (
            <AdminLayout>
                <section className="min-h-[calc(100vh-8.5rem)] space-y-4 text-slate-950">
                    <Link
                        className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-slate-950"
                        to="/admin/knowledge-base?tab=products"
                    >
                        <FiArrowLeft className="size-4" aria-hidden="true" />
                        Back to products
                    </Link>
                    <div className="rounded-lg border border-slate-300 bg-white p-6 text-sm font-semibold text-slate-600">
                        Product not found.
                    </div>
                </section>
            </AdminLayout>
        );
    }

    return (
        <AdminLayout>
            <section className="min-h-[calc(100vh-8.5rem)] space-y-4 text-slate-950">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 pb-4">
                    <div>
                        <Link
                            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-slate-950"
                            to="/admin/knowledge-base?tab=products"
                        >
                            <FiArrowLeft className="size-4" aria-hidden="true" />
                            Back to products
                        </Link>
                        <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Knowledge Base</p>
                        <h2 className="mt-1 text-2xl font-semibold text-slate-950">{isEditing ? "Edit Product" : "Add Product"}</h2>
                        <p className="mt-1 text-sm text-slate-600">
                            {isEditing ? "Update this product or service entry for agents." : "Create a product or service entry for agents to reference."}
                        </p>
                    </div>
                    <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700">
                        Product
                    </div>
                </div>

                <form
                    className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-lg shadow-slate-950/10"
                    onSubmit={handleSubmit}
                >
                    <div className="grid gap-6 p-6 2xl:p-7">
                        <label>
                            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Title</span>
                            <input
                                className="mt-2 h-12 w-full rounded-lg border border-slate-300 bg-white px-4 text-base font-semibold text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                                value={form.title}
                                onChange={(event) => updateField("title", event.target.value)}
                                placeholder="Product or service name"
                            />
                        </label>

                        <div>
                            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Description</span>
                            <div className="knowledge-base-product-editor mt-2 overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 transition focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-100">
                                <CKEditor
                                    key={isEditing ? loadedEntryId || "loading-product" : "new-product"}
                                    editor={ClassicEditor}
                                    config={editorConfig}
                                    data={initialEditorData}
                                    onChange={(_event, editor) => updateField("description", editor.getData())}
                                />
                            </div>
                        </div>
                        <div>
                            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                Photos
                            </span>

                            <input
                                className="mt-2 block w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-violet-100 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-violet-700 hover:file:bg-violet-200"
                                type="file"
                                accept="image/*"
                                multiple
                                disabled={uploadPhotoMutation.isPending}
                                onChange={(event) => {
                                    Array.from(event.target.files || []).forEach((file) =>
                                        uploadPhotoMutation.mutate(file, {
                                            onSuccess: ({ url }) => {
                                                setForm((currentForm) => ({
                                                    ...currentForm,
                                                    photoUrls: [...currentForm.photoUrls, url],
                                                }));
                                            },
                                            onError: () => {
                                                showToast({
                                                    tone: "error",
                                                    message: "Could not upload photo.",
                                                });
                                            },
                                        })
                                    );

                                    event.target.value = "";
                                }}
                            />

                            {uploadPhotoMutation.isPending && (
                                <p className="mt-2 text-sm font-medium text-violet-600">
                                    Uploading photo...
                                </p>
                            )}

                            {form.photoUrls.length > 0 && (
                                <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
                                    {form.photoUrls.map((url, index) => (
                                        <div
                                            key={`${url}-${index}`}
                                            className="relative overflow-hidden rounded-lg border border-slate-300 bg-slate-50"
                                        >
                                            <KnowledgeBaseImage
                                                src={url}
                                                alt={`Product photo ${index + 1}`}
                                                className="max-h-[30rem] min-h-72 w-full rounded-lg border border-slate-300 bg-white object-contain"
                                                fallbackClassName="flex min-h-72 w-full items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-500"
                                                iconClassName="size-10"
                                            />
                                            <button
                                                className="flex absolute right-2 top-2 size-8 items-center justify-center rounded-lg bg-red-300 text-red-100 transition hover:bg-red-400 hover:text-red-100"
                                                type="button"
                                                onClick={() =>
                                                    setForm((currentForm) => ({
                                                        ...currentForm,
                                                        photoUrls: currentForm.photoUrls.filter(
                                                            (_, photoIndex) => photoIndex !== index
                                                        ),
                                                    }))
                                                }
                                                aria-label="Delete entry"
                                            >
                                                <FiTrash2 className="size-4" aria-hidden="true" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex flex-wrap justify-end gap-3 border-t border-slate-300 bg-slate-50 px-6 py-4">
                        <Link
                            className="inline-flex h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-5 text-base font-semibold text-slate-700 transition hover:bg-slate-100 hover:text-slate-950"
                            to="/admin/knowledge-base?tab=products"
                        >
                            Cancel
                        </Link>
                        <button
                            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-5 text-base font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                            type="submit"
                            disabled={isSaving}
                        >
                            {isEditing || createMutation.isPending || updateMutation.isPending || isPreparingImages ? <FiSave className="size-4" aria-hidden="true" /> : <FiPlus className="size-4" aria-hidden="true" />}
                            {isPreparingImages ? "Preparing images..." : createMutation.isPending || updateMutation.isPending ? "Saving..." : isEditing ? "Save Product" : "Add Entry"}
                        </button>
                    </div>
                </form>
            </section>
        </AdminLayout>
    );
}
