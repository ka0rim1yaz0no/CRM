import { getPaginationItems } from "../../lib/pagination";
import type { ReactNode } from "react";
import { FiArrowDown, FiArrowUp, FiChevronLeft, FiChevronRight } from "react-icons/fi";

export type SortDirection = "asc" | "desc";

export function DataTableSortHeader({
    children,
    field,
    sortBy,
    sortDir,
    onSort,
}: {
    children: ReactNode;
    field: string;
    sortBy: string;
    sortDir: SortDirection;
    onSort: (field: string) => void;
}) {
    const isActive = sortBy === field;

    return (
        <button
            className={[
                "inline-flex h-8 items-center gap-2 rounded-md px-2 text-left transition",
                isActive ? "theme-primary-soft-bg text-white" : "text-white/60 hover:bg-white/[0.05] hover:text-white",
            ].join(" ")}
            type="button"
            onClick={() => onSort(field)}
        >
            <span
                className={[
                    "flex size-5 shrink-0 items-center justify-center rounded border transition",
                    isActive ? "theme-primary-border theme-primary-soft-bg theme-primary-text" : "border-white/10 bg-white/[0.03] text-white/30",
                ].join(" ")}
                aria-hidden="true"
            >
                {isActive && sortDir === "desc" ? <FiArrowDown className="size-3" /> : <FiArrowUp className="size-3" />}
            </span>
            {children}
        </button>
    );
}

export function DataTablePagination({
    totalItems,
    page,
    pageSize,
    onPageChange,
    onPageSizeChange,
}: {
    totalItems: number;
    page: number;
    pageSize: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (pageSize: number) => void;
}) {
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const safePage = Math.min(page, totalPages);
    const pageStart = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
    const pageEnd = Math.min(safePage * pageSize, totalItems);
    const paginationItems = getPaginationItems(safePage, totalPages);

    return (
        <div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-3">
            <p className="text-xs text-white/45">
                {totalItems > 0 ? `Showing ${pageStart}-${pageEnd} of ${totalItems}` : "Showing 0 of 0"}
            </p>
            <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-xs font-semibold text-white/45">
                    Rows
                    <select
                        className="theme-modal-bg h-9 rounded-lg border border-white/10 px-2 text-sm font-semibold text-white outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)]"
                        value={pageSize}
                        onChange={(event) => onPageSizeChange(Number(event.target.value))}
                    >
                        {[10, 25, 50].map((size) => (
                            <option key={size} value={size}>
                                {size}
                            </option>
                        ))}
                    </select>
                </label>
                <button
                    className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    type="button"
                    disabled={safePage <= 1}
                    onClick={() => onPageChange(Math.max(1, safePage - 1))}
                    aria-label="Previous page"
                >
                    <FiChevronLeft className="size-4" aria-hidden="true" />
                </button>
                <div className="flex items-center gap-1">
                    {paginationItems.map((item, index) =>
                        item === "..." ? (
                            <span key={`ellipsis-${index}`} className="flex h-9 min-w-8 items-center justify-center text-xs font-semibold text-white/35">
                                ...
                            </span>
                        ) : (
                            <button
                                key={item}
                                className={[
                                    "flex h-9 min-w-9 items-center justify-center rounded-lg border px-2 text-xs font-semibold transition",
                                    item === safePage
                                        ? "theme-primary-border theme-primary-soft-bg text-white"
                                        : "border-white/10 bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white",
                                ].join(" ")}
                                type="button"
                                onClick={() => onPageChange(item)}
                                aria-label={`Page ${item}`}
                                aria-current={item === safePage ? "page" : undefined}
                            >
                                {item}
                            </button>
                        )
                    )}
                </div>
                <button
                    className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    type="button"
                    disabled={safePage >= totalPages}
                    onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
                    aria-label="Next page"
                >
                    <FiChevronRight className="size-4" aria-hidden="true" />
                </button>
            </div>
        </div>
    );
}
