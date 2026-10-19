import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiAlertTriangle, FiArchive, FiChevronLeft, FiChevronRight, FiDownload, FiEye, FiFile, FiGrid, FiImage, FiList, FiPlayCircle, FiPlus, FiSearch, FiX } from "react-icons/fi";
import AdminLayout from "../adminLayout";
import { archiveMediaAsset, getMediaAssets, uploadMediaAsset, type MediaAsset } from "../../../api/media";
import { getEmployees } from "../../../api/employees";
import { backendOrigin } from "../../../lib/backendUrl";
import { formatCstDate } from "../../../lib/dateTime";
import { mediaAssetUrl } from "../../../lib/mediaAssetUrl";
import { getActiveBusinessId } from "../../../api/businessStorage";

function getMediaUrl(url: string) {
    const origin = import.meta.env.VITE_API_URL === "/api" ? "" : backendOrigin;
    return mediaAssetUrl(url, origin, getActiveBusinessId());
}

function toDisplayText(value: unknown, fallback = "") {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);

    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return toDisplayText(record.name || record.title || record.label || record.value || record._id, fallback);
    }

    return fallback;
}

function toAssetType(value: unknown, mimeType = ""): MediaAsset["assetType"] {
    const type = toDisplayText(value);

    if (type === "Image" || type === "Video") {
        return type;
    }

    return mimeType.startsWith("video/") ? "Video" : "Image";
}

function toAssetSize(value: unknown) {
    const size = Number(value);
    return Number.isFinite(size) && size > 0 ? Math.round(size) : 0;
}

function normalizeAsset(asset: MediaAsset): MediaAsset {
    const mimeType = toDisplayText(asset.mimeType, "application/octet-stream");

    return {
        ...asset,
        _id: toDisplayText(asset._id),
        name: toDisplayText(asset.name, "Media asset"),
        url: toDisplayText(asset.url),
        mimeType,
        assetType: toAssetType(asset.assetType, mimeType),
        role: toDisplayText(asset.role, "All roles"),
        size: toAssetSize(asset.size),
        isArchived: Boolean(asset.isArchived),
        createdAt: toDisplayText(asset.createdAt),
    };
}

function formatBytes(value: number) {
    const bytes = toAssetSize(value);

    if (!bytes) return "0 KB";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export default function AdminMedia() {
    const queryClient = useQueryClient();
    const [search, setSearch] = useState("");
    const [activeType, setActiveType] = useState<"All" | "Image" | "Video">("All");
    const [activeRole, setActiveRole] = useState("All");
    const [viewMode, setViewMode] = useState<"Thumbnail" | "Table">("Thumbnail");
    const [uploadRole, setUploadRole] = useState("");
    const [previewAsset, setPreviewAsset] = useState<MediaAsset | null>(null);
    const [pendingArchive, setPendingArchive] = useState<MediaAsset | null>(null);

    const { data: assets = [], isLoading, isError } = useQuery({
        queryKey: ["media"],
        queryFn: getMediaAssets,
    });
    const { data: employees = [] } = useQuery({
        queryKey: ["employees", "media-role-options"],
        queryFn: getEmployees,
    });
    const normalizedAssets = useMemo(() => assets.map(normalizeAsset), [assets]);
    const roleOptions = useMemo(
        () =>
            Array.from(
                new Set([
                    ...employees.filter((employee) => employee.status !== "Archived").map((employee) => toDisplayText(employee.role)),
                    ...normalizedAssets.map((asset) => asset.role),
                ])
            ).filter((role) => Boolean(role) && role !== "All roles").sort(),
        [employees, normalizedAssets]
    );

    const uploadMutation = useMutation({
        mutationFn: uploadMediaAsset,
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["media"] }),
    });

    const archiveMutation = useMutation({
        mutationFn: archiveMediaAsset,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["media"] });
            setPendingArchive(null);
        },
    });

    const filteredAssets = useMemo(() => {
        const normalizedSearch = search.trim().toLowerCase();

        return normalizedAssets.filter((asset) => {
            const matchesType = activeType === "All" || asset.assetType === activeType;
            const matchesRole = activeRole === "All" || asset.role === activeRole;
            const matchesSearch =
                !normalizedSearch ||
                asset.name.toLowerCase().includes(normalizedSearch) ||
                (asset.role || "").toLowerCase().includes(normalizedSearch);
            return matchesType && matchesRole && matchesSearch;
        });
    }, [activeRole, activeType, normalizedAssets, search]);

    const imageCount = normalizedAssets.filter((asset) => asset.assetType === "Image").length;
    const videoCount = normalizedAssets.filter((asset) => asset.assetType === "Video").length;
    const previewIndex = previewAsset ? filteredAssets.findIndex((asset) => asset._id === previewAsset._id) : -1;
    const canPreviewPrevious = previewIndex > 0;
    const canPreviewNext = previewIndex >= 0 && previewIndex < filteredAssets.length - 1;
    const statCards = [
        { label: "Assets", value: normalizedAssets.length.toString(), meta: "Uploaded files", icon: FiFile },
        { label: "Images", value: imageCount.toString(), meta: "Photos and graphics", icon: FiImage },
        { label: "Videos", value: videoCount.toString(), meta: "Video assets", icon: FiPlayCircle },
    ];

    return (
        <AdminLayout>
            <section className="min-h-[calc(100vh-8.5rem)]">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-4">
                    <div>
                        <h2 className="text-2xl font-semibold text-slate-950">Media</h2>
                        <p className="mt-1 text-sm text-slate-600">Upload, preview, and manage images and videos.</p>
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                        <label>
                            <span className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-slate-600">Employee Role</span>
                            <select
                                className="h-11 min-w-[13rem] rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-950 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20 [&>option]:bg-white [&>option]:text-slate-950"
                                value={uploadRole}
                                onChange={(event) => setUploadRole(event.target.value)}
                            >
                                <option className="bg-white text-slate-950" value="">Select role</option>
                                <option className="bg-white text-slate-950" value="All roles">All roles</option>
                                {roleOptions.map((role) => (
                                    <option className="bg-white text-slate-950" key={role} value={role}>
                                        {role}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label
                            className={[
                                "flex h-11 items-center gap-2 rounded-lg px-5 text-sm font-semibold transition",
                                uploadRole && !uploadMutation.isPending
                                    ? "cursor-pointer bg-[linear-gradient(135deg,#842cff,#4a0ebd)] text-white hover:brightness-110"
                                    : "cursor-not-allowed bg-slate-200 text-slate-500",
                            ].join(" ")}
                        >
                            <FiPlus className="size-4" aria-hidden="true" />
                            Upload Media
                            <input
                                className="hidden"
                                type="file"
                                accept="image/*,video/mp4,video/webm,video/ogg,video/quicktime"
                                multiple
                                disabled={uploadMutation.isPending || !uploadRole}
                                onChange={(event) => {
                                    Array.from(event.target.files || []).forEach((file) => uploadMutation.mutate({ file, role: uploadRole }));
                                    event.target.value = "";
                                }}
                            />
                        </label>
                    </div>
                </div>

                <div className="mt-4 grid gap-2.5 md:grid-cols-3">
                    {statCards.map(({ label, value, meta, icon: Icon }) => (
                        <article key={label} className="rounded-lg border border-slate-300 bg-white px-4 py-3 shadow-xl shadow-slate-900/10">
                            <div className="flex items-center gap-3">
                                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-[#5f27cd]">
                                    <Icon className="size-4.5" aria-hidden="true" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[0.72rem] font-semibold uppercase tracking-[0.1em] text-slate-600">{label}</span>
                                    <span className="mt-1 flex items-baseline gap-2">
                                        <span className="text-lg font-semibold text-slate-950">{value}</span>
                                        <span className="truncate text-xs text-slate-500">{meta}</span>
                                    </span>
                                </span>
                            </div>
                        </article>
                    ))}
                </div>

                <section className="mt-4 flex max-h-[calc(100vh-22rem)] min-h-[18rem] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl shadow-slate-900/10">
                    <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-slate-300 px-5 py-3">
                        <div>
                            <h3 className="text-base font-semibold text-slate-950">Media Library</h3>
                            <p className="mt-1 text-xs text-slate-500">Showing {filteredAssets.length} of {normalizedAssets.length} records</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <label className="flex h-10 min-w-[16rem] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-slate-500 transition focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                                <input
                                    className="h-full min-w-0 flex-1 bg-transparent text-sm text-slate-950 outline-none placeholder:text-slate-400"
                                    placeholder="Search media"
                                    type="search"
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                />
                                <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                            </label>
                            <select
                                className="h-10 min-w-[11rem] rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-950 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20 [&>option]:bg-white [&>option]:text-slate-950"
                                value={activeRole}
                                onChange={(event) => setActiveRole(event.target.value)}
                            >
                                <option className="bg-white text-slate-950" value="All">All roles</option>
                                {roleOptions.map((role) => (
                                    <option className="bg-white text-slate-950" key={role} value={role}>
                                        {role}
                                    </option>
                                ))}
                            </select>
                            {(["All", "Image", "Video"] as const).map((type) => (
                                <button
                                    key={type}
                                    className={[
                                        "h-10 rounded-lg border px-3 text-sm font-semibold transition",
                                        activeType === type
                                            ? "border-[#842cff] bg-[#842cff]/10 text-[#5f27cd]"
                                            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-950",
                                    ].join(" ")}
                                    type="button"
                                    onClick={() => setActiveType(type)}
                                >
                                    {type}
                                </button>
                            ))}
                            <div className="flex h-10 overflow-hidden rounded-lg border border-slate-300 bg-slate-100">
                                {(["Thumbnail", "Table"] as const).map((mode) => {
                                    const Icon = mode === "Thumbnail" ? FiGrid : FiList;
                                    return (
                                        <button
                                            key={mode}
                                            className={[
                                                "flex h-full items-center gap-2 px-3 text-sm font-semibold transition",
                                                viewMode === mode
                                                    ? "bg-[#842cff]/20 text-[#5f27cd]"
                                                    : "text-slate-600 hover:bg-white hover:text-slate-950",
                                            ].join(" ")}
                                            type="button"
                                            onClick={() => setViewMode(mode)}
                                            aria-label={`${mode} view`}
                                        >
                                            <Icon className="size-4" aria-hidden="true" />
                                            <span className="hidden xl:inline">{mode}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    <div className="content-scroll min-h-0 flex-1 overflow-auto p-4">
                        {uploadMutation.isPending && <p className="mb-3 text-sm font-semibold text-emerald-700">Uploading media...</p>}
                        {uploadMutation.isError && <p role="alert" className="mb-3 text-sm font-semibold text-rose-700">{uploadMutation.error.message || "Media upload failed. Please try again."}</p>}
                        {isLoading && <p className="text-sm text-slate-600">Loading media...</p>}
                        {isError && <p className="text-sm text-red-700">Unable to load media.</p>}
                        {!isLoading && !isError && filteredAssets.length === 0 && (
                            <p className="rounded-lg border border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">No media assets yet.</p>
                        )}
                        {filteredAssets.length > 0 && viewMode === "Thumbnail" && (
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
                                {filteredAssets.map((asset) => (
                                    <article key={asset._id} className="overflow-hidden rounded-lg border border-slate-300 bg-slate-50">
                                        <div className="group relative h-24 w-full bg-slate-200 sm:h-20">
                                            <button className="block size-full" type="button" onClick={() => setPreviewAsset(asset)} aria-label={`Preview ${asset.name}`}>
                                            {asset.assetType === "Image" ? (
                                                <img className="size-full object-cover" src={getMediaUrl(asset.url)} alt={asset.name} />
                                            ) : (
                                                <video className="size-full object-cover" src={getMediaUrl(asset.url)} muted />
                                            )}
                                            </button>
                                            <div className="pointer-events-none absolute inset-0 bg-black/0 transition group-hover:bg-black/35" />
                                            <a
                                                className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-lg border border-white/15 bg-black/70 text-white opacity-0 shadow-lg shadow-black/30 transition hover:bg-[#842cff] group-hover:opacity-100"
                                                href={getMediaUrl(asset.url)}
                                                download={asset.name}
                                                aria-label={`Download ${asset.name}`}
                                                onClick={(event) => event.stopPropagation()}
                                            >
                                                <FiDownload className="size-4" aria-hidden="true" />
                                            </a>
                                        </div>
                                        <div className="p-3">
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-semibold text-slate-950">{asset.name}</p>
                                                    <p className="mt-1 text-xs text-slate-500">{asset.assetType} · {formatBytes(asset.size)}</p>
                                                    <p className="mt-1 truncate text-xs font-semibold text-slate-700">{asset.role || "All roles"}</p>
                                                </div>
                                                <span className="rounded-md bg-violet-100 px-2 py-1 text-xs font-semibold text-[#5f27cd]">{asset.assetType}</span>
                                            </div>
                                            <div className="mt-3 flex justify-end gap-2">
                                                <button
                                                    className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-100 hover:text-slate-950"
                                                    type="button"
                                                    onClick={() => setPreviewAsset(asset)}
                                                    aria-label="View media"
                                                >
                                                    <FiEye className="size-4" aria-hidden="true" />
                                                </button>
                                                <button
                                                    className="flex size-8 items-center justify-center rounded-lg border border-rose-300 bg-rose-50 text-rose-700 transition hover:border-rose-400 hover:bg-rose-100 hover:text-rose-800"
                                                    type="button"
                                                    onClick={() => setPendingArchive(asset)}
                                                    aria-label="Archive media"
                                                >
                                                    <FiArchive className="size-4" aria-hidden="true" />
                                                </button>
                                            </div>
                                        </div>
                                    </article>
                                ))}
                            </div>
                        )}
                        {filteredAssets.length > 0 && viewMode === "Table" && (
                            <table className="w-full min-w-[58rem] table-fixed border-separate border-spacing-0 text-left">
                                <thead className="sticky top-0 z-10 bg-slate-100 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-slate-600">
                                    <tr>
                                        <th className="w-[34%] px-4 py-3">Media</th>
                                        <th className="w-[16%] px-4 py-3">Role</th>
                                        <th className="w-[12%] px-4 py-3">Type</th>
                                        <th className="w-[12%] px-4 py-3">Size</th>
                                        <th className="w-[14%] px-4 py-3">Uploaded</th>
                                        <th className="w-[12%] px-4 py-3 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-200">
                                    {filteredAssets.map((asset) => (
                                        <tr key={asset._id} className="text-sm text-slate-700 transition odd:bg-slate-50 hover:bg-slate-100">
                                            <td className="px-4 py-3">
                                                <div className="flex min-w-0 items-center gap-3">
                                                    <button
                                                        className="size-12 shrink-0 overflow-hidden rounded-lg border border-slate-300 bg-slate-200"
                                                        type="button"
                                                        onClick={() => setPreviewAsset(asset)}
                                                        aria-label={`Preview ${asset.name}`}
                                                    >
                                                        {asset.assetType === "Image" ? (
                                                            <img className="size-full object-cover" src={getMediaUrl(asset.url)} alt={asset.name} />
                                                        ) : (
                                                            <video className="size-full object-cover" src={getMediaUrl(asset.url)} muted />
                                                        )}
                                                    </button>
                                                    <span className="min-w-0">
                                                        <span className="block truncate font-semibold text-slate-950">{asset.name}</span>
                                                        <span className="mt-1 block truncate text-xs text-slate-500">{asset.mimeType}</span>
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="truncate px-4 py-3 font-semibold text-slate-700">{asset.role || "All roles"}</td>
                                            <td className="px-4 py-3">{asset.assetType}</td>
                                            <td className="px-4 py-3">{formatBytes(asset.size)}</td>
                                            <td className="px-4 py-3 text-slate-500">
                                                {asset.createdAt ? formatCstDate(asset.createdAt) : "-"}
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex justify-end gap-2">
                                                    <a
                                                        className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-100 hover:text-slate-950"
                                                        href={getMediaUrl(asset.url)}
                                                        download={asset.name}
                                                        aria-label="Download media"
                                                    >
                                                        <FiDownload className="size-4" aria-hidden="true" />
                                                    </a>
                                                    <button
                                                        className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-100 hover:text-slate-950"
                                                        type="button"
                                                        onClick={() => setPreviewAsset(asset)}
                                                        aria-label="View media"
                                                    >
                                                        <FiEye className="size-4" aria-hidden="true" />
                                                    </button>
                                                    <button
                                                        className="flex size-8 items-center justify-center rounded-lg border border-rose-300 bg-rose-50 text-rose-700 transition hover:border-rose-400 hover:bg-rose-100 hover:text-rose-800"
                                                        type="button"
                                                        onClick={() => setPendingArchive(asset)}
                                                        aria-label="Archive media"
                                                    >
                                                        <FiArchive className="size-4" aria-hidden="true" />
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </section>

                {previewAsset && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                setPreviewAsset(null);
                            }
                        }}
                    >
                        <div className="modal-panel-enter flex max-h-[88vh] w-full max-w-[60rem] flex-col overflow-hidden rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40">
                            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                                <div className="min-w-0">
                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{previewAsset.assetType} Preview</p>
                                    <h3 className="mt-1 truncate text-base font-semibold text-white">{previewAsset.name}</h3>
                                    <p className="mt-1 truncate text-xs font-semibold text-[#d8c8ff]">{previewAsset.role || "All roles"}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <a
                                        className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white"
                                        href={getMediaUrl(previewAsset.url)}
                                        download={previewAsset.name}
                                        aria-label="Download media"
                                    >
                                        <FiDownload className="size-4" aria-hidden="true" />
                                    </a>
                                    <button className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={() => setPreviewAsset(null)} aria-label="Close preview">
                                        <FiX className="size-4" aria-hidden="true" />
                                    </button>
                                </div>
                            </div>
                            <div className="relative min-h-0 flex-1 bg-black/30 p-4">
                                <button
                                    className="absolute left-6 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white/70 shadow-xl shadow-black/40 transition hover:bg-[#842cff] hover:text-white disabled:cursor-not-allowed disabled:opacity-25 disabled:hover:bg-black/65"
                                    type="button"
                                    disabled={!canPreviewPrevious}
                                    onClick={() => {
                                        if (canPreviewPrevious) setPreviewAsset(filteredAssets[previewIndex - 1]);
                                    }}
                                    aria-label="Previous media"
                                >
                                    <FiChevronLeft className="size-5" aria-hidden="true" />
                                </button>
                                {previewAsset.assetType === "Image" ? (
                                    <img className="max-h-[70vh] w-full rounded-lg object-contain" src={getMediaUrl(previewAsset.url)} alt={previewAsset.name} />
                                ) : (
                                    <video className="max-h-[70vh] w-full rounded-lg" src={getMediaUrl(previewAsset.url)} controls />
                                )}
                                <button
                                    className="absolute right-6 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white/70 shadow-xl shadow-black/40 transition hover:bg-[#842cff] hover:text-white disabled:cursor-not-allowed disabled:opacity-25 disabled:hover:bg-black/65"
                                    type="button"
                                    disabled={!canPreviewNext}
                                    onClick={() => {
                                        if (canPreviewNext) setPreviewAsset(filteredAssets[previewIndex + 1]);
                                    }}
                                    aria-label="Next media"
                                >
                                    <FiChevronRight className="size-5" aria-hidden="true" />
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {pendingArchive && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                setPendingArchive(null);
                            }
                        }}
                    >
                        <div className="modal-panel-enter w-full max-w-[30rem] overflow-hidden rounded-lg border border-red-300/20 bg-[#101018] shadow-2xl shadow-red-950/30">
                            <div className="border-b border-red-300/15 bg-[linear-gradient(135deg,rgba(239,68,68,0.16),rgba(132,44,255,0.12))] px-5 py-4">
                                <div className="flex items-start gap-3">
                                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-red-400/15 text-red-200">
                                        <FiAlertTriangle className="size-5" aria-hidden="true" />
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-100/55">
                                            Confirm archive
                                        </p>
                                        <h3 className="mt-1 text-lg font-semibold text-white">
                                            Are you sure?
                                        </h3>
                                    </div>
                                </div>
                            </div>
                            <div className="px-5 py-4">
                                <p className="text-sm leading-6 text-white/62">
                                    Are you sure you want to archive "{pendingArchive.name}"?
                                </p>
                                <div className="mt-4 rounded-lg border border-white/10 bg-black/24 p-3">
                                    <p className="truncate text-sm font-semibold text-white">{pendingArchive.name}</p>
                                    <p className="mt-1 text-xs text-white/42">{pendingArchive.assetType} · {formatBytes(pendingArchive.size)} · {pendingArchive.role || "All roles"}</p>
                                </div>
                            </div>
                            <div className="flex flex-wrap justify-end gap-2 border-t border-white/10 px-5 py-4">
                                <button
                                    className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                                    type="button"
                                    onClick={() => {
                                        setPendingArchive(null);
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    className="h-10 rounded-lg border border-red-300/25 bg-red-500/18 px-4 text-sm font-semibold text-red-100 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                                    type="button"
                                    disabled={archiveMutation.isPending}
                                    onClick={() => archiveMutation.mutate(pendingArchive._id)}
                                >
                                    {archiveMutation.isPending ? "Archiving..." : "Archive media"}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </section>
        </AdminLayout>
    );
}
