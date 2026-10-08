import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiBell, FiChevronDown, FiSearch, FiX } from "react-icons/fi";
import { Link, useLocation, useNavigate } from "react-router";
import { getEmployeeBusinesses, switchEmployeeBusiness } from "../../api/auth";
import { getAuthUser, setAuthUser } from "../../api/authStorage";
import { getBusinesses } from "../../api/businesses";
import { getActiveBusinessId, setActiveBusinessId } from "../../api/businessStorage";
import { getMyLeads, type Lead } from "../../api/leads";
import { getEmployeeNotices, markEmployeeNoticeRead, markEmployeeNoticesRead } from "../../api/notices";
import { useClickOutside } from "../../hooks/useClickOutside";
import { formatPhDateTime } from "../../lib/dateTime";
import { refreshSocketBusinessContext } from "../../lib/socket";
import { emitToast } from "../../components/ToastProvider";

const pageTitles: Record<string, string> = {
    "/dashboard": "Dashboard",
    "/leads": "Leads",
    "/teams": "Teams",
    "/calendar": "Calendar",
    "/profile": "Profile",
    "/settings": "Settings",
    "/messages": "Messages",
    "/poc/employees": "Employees",
    "/poc/tasks": "Tasks",
    "/poc/credentials": "Credentials",
};

export default function Navbar() {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const title = pageTitles[pathname] ??
        (pathname.startsWith("/poc/employees/") ? "Employees" : pathname.startsWith("/poc/tasks/") ? "Tasks" : "Workspace");
    const authUser = getAuthUser();
    const [isBusinessOpen, setIsBusinessOpen] = useState(false);
    const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
    const [dismissedNoticeIds, setDismissedNoticeIds] = useState<Set<string>>(() => new Set());
    const [leadSearch, setLeadSearch] = useState("");
    const [debouncedLeadSearch, setDebouncedLeadSearch] = useState("");
    const [isLeadSearchOpen, setIsLeadSearchOpen] = useState(false);
    const leadSearchRef = useRef<HTMLFormElement>(null);
    const notificationsRef = useRef<HTMLDivElement>(null);
    const businessRef = useRef<HTMLDivElement>(null);
    const queryClient = useQueryClient();
    const employeeId = authUser?.userType === "employee" ? authUser.user._id : "";
    const employeeLeadNames = useMemo(() => {
        if (authUser?.userType !== "employee") {
            return [];
        }

        return Array.from(new Set([authUser.user.name, authUser.user.employeeCode, ...(authUser.user.aliases || [])].filter(Boolean)));
    }, [authUser]);
    const normalizedLeadSearch = debouncedLeadSearch.trim();
    const { data: leadSearchData, isFetching: isLeadSearchFetching } = useQuery({
        queryKey: ["employee-navbar-lead-search", employeeId, employeeLeadNames.join("|"), normalizedLeadSearch],
        queryFn: () =>
            getMyLeads({
                employeeId,
                employeeNames: employeeLeadNames,
                tab: "all",
                page: 1,
                limit: 8,
                search: normalizedLeadSearch,
                searchAll: true,
                includeArchived: true,
            }),
        enabled: authUser?.userType === "employee" && Boolean(employeeId) && normalizedLeadSearch.length >= 2,
        staleTime: 15_000,
    });
    const leadSearchResults = leadSearchData?.leads || [];
    const { data: notices = [] } = useQuery({
        queryKey: ["employee-notices", employeeId],
        queryFn: () => getEmployeeNotices(employeeId),
        enabled: Boolean(employeeId),
        refetchInterval: 30_000,
        staleTime: 15_000,
    });
    const visibleNotices = notices.filter((notice) => !dismissedNoticeIds.has(notice._id));
    const unreadNoticeCount = visibleNotices.filter((notice) => !notice.isRead).length;
    const unreadCount = unreadNoticeCount;
    const { data: publicBusinesses = [] } = useQuery({
        queryKey: ["businesses"],
        queryFn: getBusinesses,
        staleTime: 30_000,
    });
    const { data: refreshedAllowedBusinesses } = useQuery({
        queryKey: ["employee-business-access", authUser?.user.employeeCode],
        queryFn: () => getEmployeeBusinesses(authUser?.user.employeeCode || ""),
        enabled: authUser?.userType === "employee" && Boolean(authUser.user.employeeCode),
        refetchInterval: 30_000,
        refetchOnWindowFocus: true,
        staleTime: 15_000,
    });
    const businessNamesById = useMemo(
        () => new Map(publicBusinesses.map((business) => [business.id, business.name])),
        [publicBusinesses]
    );
    const sessionAllowedBusinesses = authUser?.allowedBusinesses?.length
        ? authUser.allowedBusinesses
        : authUser?.business
            ? [authUser.business]
            : [];
    const allowedBusinessSource = refreshedAllowedBusinesses ?? sessionAllowedBusinesses;
    const allowedBusinesses = allowedBusinessSource.map((business) => ({
        ...business,
        name: businessNamesById.get(business.id) || business.name,
    }));
    const authBusiness = authUser?.business
        ? { ...authUser.business, name: businessNamesById.get(authUser.business.id) || authUser.business.name }
        : undefined;
    const activeBusinessId = getActiveBusinessId();
    const activeBusiness =
        allowedBusinesses.find((business) => business.id === activeBusinessId) ||
        authBusiness ||
        allowedBusinesses[0];
    const employeeName = authUser?.userType === "employee" ? authUser.user.name || "Employee" : "Employee";
    const employeePosition = authUser?.userType === "employee" ? authUser.user.role || authUser.user.team || "Employee" : "Employee";
    const employeeBusinessLabel = activeBusiness?.name || "";
    const employeeAccountSubtitle = [employeePosition, employeeBusinessLabel].filter(Boolean).join(" · ");
    const employeeInitial = employeeName.charAt(0).toUpperCase() || "E";
    const markNoticeReadMutation = useMutation({
        mutationFn: (noticeId: string) => markEmployeeNoticeRead(employeeId, noticeId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["employee-notices", employeeId] }),
    });
    const markAllNoticesReadMutation = useMutation({
        mutationFn: () => markEmployeeNoticesRead(employeeId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["employee-notices", employeeId] }),
    });
    const switchBusinessMutation = useMutation({
        mutationFn: (targetBusinessId: string) => {
            if (!authUser || authUser.userType !== "employee") {
                throw new Error("Employee session is required.");
            }

            return switchEmployeeBusiness(
                authUser.user.employeeCode,
                activeBusiness?.id || activeBusinessId,
                targetBusinessId
            );
        },
        onSuccess: (nextAuthUser) => {
            const nextBusinessId = nextAuthUser.business?.id;

            if (nextBusinessId) {
                setActiveBusinessId(nextBusinessId);
            }

            setAuthUser(nextAuthUser);
            queryClient.clear();
            refreshSocketBusinessContext();
            window.location.assign("/dashboard");
        },
        onError: (error) => {
            emitToast({
                tone: "error",
                message: error instanceof Error ? error.message : "Unable to switch business.",
            });
        },
    });

    const handleBusinessChange = (businessId: string) => {
        if (businessId === activeBusiness?.id || switchBusinessMutation.isPending) {
            setIsBusinessOpen(false);
            return;
        }

        switchBusinessMutation.mutate(businessId);
    };

    const openLeadSearchResult = (lead?: Lead) => {
        const query = leadSearch.trim();

        if (!query && !lead) {
            return;
        }

        const params = new URLSearchParams();
        params.set("scope", "all");

        if (query) {
            params.set("leadSearch", query);
        }

        if (lead) {
            params.set("lead", lead._id);
        }

        setIsLeadSearchOpen(false);
        navigate(`/leads?${params.toString()}`);
    };

    const handleLeadSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        openLeadSearchResult(leadSearchResults[0]);
    };

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            setDebouncedLeadSearch(leadSearch.trim());
        }, 250);

        return () => window.clearTimeout(timeoutId);
    }, [leadSearch]);

    useEffect(() => {
        setIsLeadSearchOpen(false);
    }, [pathname]);

    useClickOutside(leadSearchRef, () => setIsLeadSearchOpen(false), isLeadSearchOpen);
    useClickOutside(notificationsRef, () => setIsNotificationsOpen(false), isNotificationsOpen);
    useClickOutside(businessRef, () => setIsBusinessOpen(false), isBusinessOpen);

    return (
        <header className="theme-header-bg z-20 border-b border-white/10 px-6 py-4 backdrop-blur-xl">
            <div className="flex min-h-12 items-center justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-white/40">Workspace</p>
                    <h1 className="mt-1 truncate text-xl font-semibold text-white">{title}</h1>
                </div>

                <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
                    <form ref={leadSearchRef} className="relative hidden w-full max-w-[22rem] md:block" onSubmit={handleLeadSearchSubmit}>
                        <label className="flex h-11 w-full items-center gap-3 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-white/50 transition focus-within:border-[var(--primary)] focus-within:bg-white/[0.08] focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--primary)_20%,transparent)]">
                            <FiSearch className="size-5 shrink-0" aria-hidden="true" />
                            <input
                                className="h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
                                type="search"
                                value={leadSearch}
                                onChange={(event) => {
                                    setLeadSearch(event.target.value);
                                    setIsLeadSearchOpen(true);
                                }}
                                onFocus={() => setIsLeadSearchOpen(true)}
                                placeholder="Search your leads"
                            />
                        </label>
                        {authUser?.userType === "employee" && isLeadSearchOpen && leadSearch.trim().length >= 2 && (
                            <div className="theme-panel-bg absolute left-0 top-[calc(100%+0.5rem)] z-40 w-full overflow-hidden rounded-lg border border-white/10 shadow-2xl shadow-black/45">
                                <div className="border-b border-white/10 px-3 py-2">
                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Lead Search</p>
                                </div>
                                <div className="content-scroll max-h-80 overflow-y-auto p-1.5">
                                    {isLeadSearchFetching && (
                                        <p className="rounded-md px-3 py-3 text-sm text-white/45">Searching leads...</p>
                                    )}
                                    {!isLeadSearchFetching && leadSearchResults.length === 0 && (
                                        <p className="rounded-md px-3 py-3 text-sm text-white/45">No matching assigned leads.</p>
                                    )}
                                    {!isLeadSearchFetching && leadSearchResults.map((lead) => (
                                        <button
                                            key={lead._id}
                                            className="block w-full rounded-md px-3 py-2.5 text-left transition hover:bg-white/[0.06]"
                                            type="button"
                                            onClick={() => openLeadSearchResult(lead)}
                                        >
                                            <span className="block truncate text-sm font-semibold text-white">
                                                {lead.leadName || lead.businessName}
                                            </span>
                                            <span className="mt-1 block truncate text-xs text-white/50">
                                                {lead.businessName} · {lead.status}
                                            </span>
                                            <span className="mt-1 block truncate text-[0.68rem] font-semibold text-white/35">
                                                {[lead.phone, lead.email].filter(Boolean).join(" · ") || "No phone or email"}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </form>

                    <div ref={notificationsRef} className="relative">
                        <button
                            className={[
                                "relative flex size-11 shrink-0 items-center justify-center rounded-lg border text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_60%,transparent)]",
                                isNotificationsOpen ? "theme-primary-border bg-white/[0.08]" : "border-white/10 bg-white/[0.06]",
                            ].join(" ")}
                            type="button"
                            aria-label="Notifications"
                            aria-expanded={isNotificationsOpen}
                            onClick={() => setIsNotificationsOpen((isOpen) => !isOpen)}
                        >
                            <FiBell className="size-5" aria-hidden="true" />
                            {unreadCount > 0 && (
                                <span className="theme-primary-solid absolute right-1.5 top-1.5 min-w-5 rounded-full px-1.5 py-0.5 text-[0.65rem] font-bold leading-none text-white">
                                    {unreadCount > 9 ? "9+" : unreadCount}
                                </span>
                            )}
                        </button>
                        {isNotificationsOpen && (
                            <div className="theme-panel-bg absolute right-0 top-[calc(100%+0.5rem)] z-40 w-80 overflow-hidden rounded-lg border border-white/10 shadow-2xl shadow-black/45">
                                <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Notifications</p>
                                        <p className="mt-1 text-sm font-semibold text-white">{unreadCount} unread</p>
                                    </div>
                                    {unreadCount > 0 && (
                                        <button
                                            className="h-8 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-xs font-semibold text-white/65 transition hover:bg-white/10 hover:text-white"
                                            type="button"
                                            onClick={() => {
                                                if (unreadNoticeCount > 0) markAllNoticesReadMutation.mutate();
                                            }}
                                        >
                                            Mark all read
                                        </button>
                                    )}
                                </div>
                                <div className="content-scroll max-h-96 overflow-y-auto p-2">
                                    {visibleNotices.length === 0 && (
                                        <p className="rounded-lg border border-white/10 bg-white/[0.035] p-4 text-sm text-white/45">No notifications yet.</p>
                                    )}
                                    {visibleNotices.map((notice) => (
                                        <div key={notice._id} className="relative mb-2">
                                        <Link
                                            className={[
                                                "block w-full rounded-lg border p-3 pr-11 text-left transition",
                                                notice.isRead
                                                    ? "border-white/10 bg-white/[0.025] text-white/55 hover:bg-white/[0.05]"
                                                    : "theme-primary-border theme-primary-soft-bg text-white hover:bg-white/[0.08]",
                                            ].join(" ")}
                                            to={notice.href || `/profile?tab=notices&notice=${notice._id}`}
                                            onClick={() => {
                                                if (!notice.isRead) markNoticeReadMutation.mutate(notice._id);
                                                setDismissedNoticeIds((current) => new Set(current).add(notice._id));
                                                setIsNotificationsOpen(false);
                                            }}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <p className="line-clamp-1 text-sm font-semibold">{notice.title}</p>
                                                {!notice.isRead && <span className="mt-1 size-2 shrink-0 rounded-full bg-[var(--primary-soft)]" />}
                                            </div>
                                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/55">{notice.message}</p>
                                            <p className="mt-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-white/35">
                                                {notice.severity} · {formatPhDateTime(notice.createdAt)}
                                            </p>
                                        </Link>
                                        <button
                                            className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md text-white/45 transition hover:bg-white/10 hover:text-white"
                                            type="button"
                                            aria-label="Dismiss notification"
                                            onClick={() => setDismissedNoticeIds((current) => new Set(current).add(notice._id))}
                                        >
                                            <FiX className="size-4" aria-hidden="true" />
                                        </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {authUser?.userType === "employee" && activeBusiness && (
                        <div ref={businessRef} className="relative">
                            <button
                                className={[
                                    "flex h-11 shrink-0 items-center gap-3 rounded-lg border py-1.5 pl-1.5 pr-3 text-left transition focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_60%,transparent)]",
                                    isBusinessOpen
                                        ? "theme-primary-border bg-white/[0.08]"
                                        : "border-white/10 bg-white/[0.06] hover:bg-white/10",
                                ].join(" ")}
                                type="button"
                                aria-haspopup="menu"
                                aria-expanded={isBusinessOpen}
                                onClick={() => {
                                    if (allowedBusinesses.length > 1) {
                                        setIsBusinessOpen((isOpen) => !isOpen);
                                    }
                                }}
                            >
                                <span className="theme-primary-bg flex size-8 items-center justify-center rounded-md text-sm font-semibold text-white">
                                    {employeeInitial}
                                </span>
                                <span className="hidden min-w-0 sm:block">
                                    <span className="block max-w-44 truncate text-sm font-semibold text-white">{employeeName}</span>
                                    <span className="block max-w-44 truncate text-xs text-white/45">{employeeAccountSubtitle}</span>
                                </span>
                                {allowedBusinesses.length > 1 && (
                                    <FiChevronDown
                                        className={["hidden size-4 text-white/45 transition sm:block", isBusinessOpen ? "rotate-180" : ""].join(" ")}
                                        aria-hidden="true"
                                    />
                                )}
                            </button>

                            {allowedBusinesses.length > 1 && isBusinessOpen && (
                                <div className="theme-panel-bg absolute right-0 top-[calc(100%+0.5rem)] z-30 w-56 overflow-hidden rounded-lg border border-white/10 p-1 shadow-2xl shadow-black/40">
                                    <div className="border-b border-white/10 px-3 py-2">
                                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Switch Department</p>
                                        <p className="mt-1 truncate text-sm font-semibold text-white">{employeeName}</p>
                                        <p className="mt-0.5 truncate text-xs text-white/45">{employeePosition}</p>
                                    </div>
                                    <div className="py-1">
                                        {allowedBusinesses.map((business) => {
                                            const isActive = business.id === activeBusiness?.id;

                                            return (
                                                <button
                                                    key={business.id}
                                                    className={[
                                                        "flex h-10 w-full items-center justify-between rounded-md px-3 text-left text-sm font-semibold transition",
                                                        isActive
                                                            ? "theme-primary-soft-bg theme-primary-text"
                                                            : "text-white/65 hover:bg-white/[0.06] hover:text-white",
                                                    ].join(" ")}
                                                    type="button"
                                                    role="menuitem"
                                                    disabled={switchBusinessMutation.isPending}
                                                    onClick={() => handleBusinessChange(business.id)}
                                                >
                                                    <span className="min-w-0 truncate">{business.name}</span>
                                                    {isActive && <span className="size-2 rounded-full bg-[var(--primary)]" />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}
