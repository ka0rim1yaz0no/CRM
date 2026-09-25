import type { ElementType, ReactNode } from "react";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, useLocation } from "react-router";
import { getBusinesses } from "../../../api/businesses";
import { getActiveBusinessId, setActiveBusinessId } from "../../../api/businessStorage";
import { clearAuthUser, getAuthUser, setAuthUser } from "../../../api/authStorage";
import type { FeatureKey } from "../../../api/features";
import { getLeaveRequests } from "../../../api/leaveRequests";
import { getRecentNotices } from "../../../api/notices";
import { useFeatureFlags } from "../../../hooks/useFeatureFlags";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { useMessageNotifications } from "../../../hooks/useMessageNotifications";
import { formatPhDate, formatPhDateTime } from "../../../lib/dateTime";
import { refreshSocketBusinessContext } from "../../../lib/socket";
import {
    FiBarChart2,
    FiBell,
    FiBookOpen,
    FiChevronDown,
    FiCheckSquare,
    FiImage,
    FiFileText,
    FiLogOut,
    FiMessageCircle,
    FiMonitor,
    FiPieChart,
    FiSearch,
    FiSettings,
    FiShield,
    FiTarget,
    FiUserPlus,
    FiUsers,
} from "react-icons/fi";
import { FaRegMoneyBillAlt } from "react-icons/fa";
import { MdPassword } from "react-icons/md";
import { isPocOperationsPath, isPocOperationsUser, roleWorkspacePath } from "../../../lib/roleAccess";
import MainLayout from "../../layout";

type Props = {
    children: ReactNode;
};

type AdminNavItem = {
    label: string;
    path: string;
    icon: ElementType;
    feature: FeatureKey;
};

type AdminNavSection = {
    title: string;
    items: AdminNavItem[];
};

const adminNavSections: AdminNavSection[] = [
    {
        title: "Overview",
        items: [
            { label: "Dashboard", path: "/admin/dashboard", icon: FiBarChart2, feature: "dashboard" },
            { label: "Reports", path: "/admin/reports", icon: FiPieChart, feature: "tracking" },
            { label: "Tracker", path: "/admin/tracker", icon: FiMonitor, feature: "tracking" },
        ],
    },
    {
        title: "Operations",
        items: [
            { label: "Teams", path: "/admin/teams", icon: FiUsers, feature: "teams" },
            { label: "Employees", path: "/admin/employees", icon: FiUserPlus, feature: "employees" },
            { label: "Leads", path: "/admin/leads", icon: FiTarget, feature: "leads" },
            { label: "Tasks", path: "/admin/tasks", icon: FiCheckSquare, feature: "tasks" },
        ],
    },
    {
        title: "Workspace",
        items: [
            { label: "HR", path: "/admin/hr", icon: FiFileText, feature: "hr" },
            { label: "Knowledge Base", path: "/admin/knowledge-base", icon: FiBookOpen, feature: "knowledge-base" },
            { label: "Media", path: "/admin/media", icon: FiImage, feature: "media" },
            { label: "Messages", path: "/admin/messages", icon: FiMessageCircle, feature: "messages" },
        ],
    },
    {
        title: "Admin",
        items: [
            { label: "Payroll", path: "/admin/payroll", icon: FaRegMoneyBillAlt, feature: "payroll" },
            { label: "Credentials", path: "/admin/credentials", icon: MdPassword, feature: "credentials" },
            { label: "Settings", path: "/admin/settings", icon: FiSettings, feature: "settings" },
        ],
    },
];

export default function AdminLayout({ children }: Props) {
    const [isScrolling, setIsScrolling] = useState(false);
    const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
    const [isBusinessOpen, setIsBusinessOpen] = useState(false);
    const { pathname } = useLocation();
    const scrollTimer = useRef<number | undefined>(undefined);
    const notificationsRef = useRef<HTMLDivElement>(null);
    const businessRef = useRef<HTMLDivElement>(null);
    const queryClient = useQueryClient();
    const authUser = getAuthUser();
    const isPocOperations = isPocOperationsUser(authUser);
    const { isEnabled } = useFeatureFlags();
    const { messageNotifications, unreadMessageCount, markMessageRead, markAllMessagesRead } = useMessageNotifications();
    const { data: businesses = [] } = useQuery({
        queryKey: ["businesses"],
        queryFn: getBusinesses,
        staleTime: Number.POSITIVE_INFINITY,
    });
    const { data: notices = [] } = useQuery({
        queryKey: ["recent-notices"],
        queryFn: getRecentNotices,
        enabled: isNotificationsOpen,
        staleTime: 60_000,
    });
    const { data: pendingLeaveRequests = [] } = useQuery({
        queryKey: ["leave-requests", "Pending", "admin-notifications"],
        queryFn: () => getLeaveRequests({ status: "Pending" }),
        refetchInterval: 30_000,
        staleTime: 10_000,
    });
    const visibleNavSections = adminNavSections
        .map((section) => ({
            ...section,
            items: section.items.map((item) => ({ ...item, path: roleWorkspacePath(item.path, authUser) })).filter((item) =>
                isEnabled(item.feature, "admin") && (!isPocOperations || isPocOperationsPath(item.path))
            ),
        }))
        .filter((section) => section.items.length > 0);
    const visibleNavItems = visibleNavSections.flatMap((section) => section.items);
    const currentPageTitle =
        [...visibleNavItems]
            .sort((first, second) => second.path.length - first.path.length)
            .find((item) => pathname === item.path || pathname.startsWith(`${item.path}/`))?.label || "Admin";
    const notificationCount = notices.length + pendingLeaveRequests.length + unreadMessageCount;
    const businessNamesById = new Map(businesses.map((business) => [business.id, business.name]));
    const accessibleBusinesses = authUser?.userType === "admin"
        ? businesses
        : authUser?.allowedBusinesses?.length
        ? authUser.allowedBusinesses.map((business) => ({
            ...business,
            name: businessNamesById.get(business.id) || business.name,
            isDefault: businesses.find((publicBusiness) => publicBusiness.id === business.id)?.isDefault || false,
        }))
        : businesses;
    const activeBusinessId = getActiveBusinessId();
    const activeBusiness =
        accessibleBusinesses.find((business) => business.id === activeBusinessId) ||
        accessibleBusinesses.find((business) => business.isDefault) ||
        accessibleBusinesses[0];
    const activeBusinessName = activeBusiness?.name || "Business";
    const activeBusinessInitial = activeBusinessName.charAt(0).toUpperCase() || "B";
    const accountName = authUser?.user.name || "User";
    const accountPosition = authUser?.user.role || (authUser?.userType === "employee" ? authUser.user.team : "Admin") || "Team member";
    const accountInitial = accountName.charAt(0).toUpperCase() || "U";

    const handleScroll = () => {
        setIsScrolling(true);
        window.clearTimeout(scrollTimer.current);
        scrollTimer.current = window.setTimeout(() => setIsScrolling(false), 700);
    };
    useClickOutside(notificationsRef, () => setIsNotificationsOpen(false), isNotificationsOpen);
    useClickOutside(businessRef, () => setIsBusinessOpen(false), isBusinessOpen);

    const handleBusinessSwitch = (businessId: string) => {
        const nextBusiness = accessibleBusinesses.find((business) => business.id === businessId);

        if (!nextBusiness || nextBusiness.id === activeBusiness?.id) {
            setIsBusinessOpen(false);
            return;
        }

        setActiveBusinessId(nextBusiness.id);

        if (authUser?.userType === "admin") {
            setAuthUser({ ...authUser, business: { id: nextBusiness.id, name: nextBusiness.name } });
        }

        queryClient.clear();
        refreshSocketBusinessContext();
        setIsBusinessOpen(false);
        window.location.reload();
    };

    if (isPocOperations) {
        return <MainLayout>{children}</MainLayout>;
    }

    return (
        <div className="theme-app-bg h-screen overflow-hidden text-white">
            <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_8%_14%,color-mix(in_srgb,var(--primary)_20%,transparent),transparent_28%),radial-gradient(circle_at_98%_0%,color-mix(in_srgb,var(--secondary)_12%,transparent),transparent_25%),linear-gradient(135deg,rgba(255,255,255,0.035),transparent_26%)]" />
            <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(180deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-20" />

            <aside className="theme-shell-bg fixed inset-y-0 left-0 z-10 flex w-[13.5rem] flex-col border-r border-white/10 text-white shadow-2xl shadow-black/20 backdrop-blur-xl 2xl:w-[16rem]">
                <div className="flex w-full items-center justify-center border-b border-white/10 px-4 py-4 2xl:px-6 2xl:py-5">
                    <img className="theme-sidebar-logo theme-sidebar-logo-dark max-w-[9.75rem] 2xl:max-w-[12rem]" src="/images/logoaside.png" alt="Assistly" />
                    <img className="theme-sidebar-logo theme-sidebar-logo-light hidden max-w-[9.75rem] 2xl:max-w-[12rem]" src="/images/logoaside-light.png" alt="Assistly" />
                </div>

                <div className="flex min-h-0 flex-1 flex-col px-2.5 py-4 2xl:px-3 2xl:py-5">
                    <nav className="admin-sidebar-nav-command content-scroll min-h-0 flex-1 overflow-y-auto pr-1" aria-label="Admin navigation">
                        <div className="flex flex-col gap-5">
                            {visibleNavSections.map((section) => (
                                <div key={section.title}>
                                    <div className="admin-sidebar-section-title mb-2 flex items-center gap-2 px-3 text-xs font-semibold uppercase tracking-[0.16em] text-white/35 2xl:px-4">
                                        {section.title === "Admin" && <FiShield className="size-4" aria-hidden="true" />}
                                        <span>{section.title}</span>
                                    </div>
                                    <ul className="flex flex-col gap-1">
                                        {section.items.map(({ label, path, icon: Icon }) => (
                                            <li key={label}>
                                                <NavLink
                                                    to={path}
                                                    className={({ isActive }) =>
                                                        [
                                                            "admin-sidebar-link flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition 2xl:h-11 2xl:gap-3 2xl:px-4",
                                                            isActive
                                                                ? "bg-white text-[#070910] shadow-lg shadow-white/10"
                                                                : "text-white/70 hover:bg-white/10 hover:text-white",
                                                        ].join(" ")
                                                    }
                                                >
                                                    <span className="admin-sidebar-icon flex shrink-0 items-center justify-center">
                                                        <Icon className="size-5" aria-hidden="true" />
                                                    </span>
                                                    <span className="min-w-0 truncate">{label}</span>
                                                </NavLink>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                        </div>
                    </nav>

                    <nav className="admin-sidebar-nav-legacy content-scroll min-h-0 flex-1 overflow-y-auto pr-1" aria-label="Admin navigation">
                        <div className="mb-3 flex items-center gap-2 px-3 text-xs font-semibold uppercase tracking-[0.16em] text-white/35 2xl:px-4">
                            <FiShield className="size-4" aria-hidden="true" />
                            Admin
                        </div>
                        <ul className="flex flex-col gap-1">
                            {visibleNavItems.map(({ label, path, icon: Icon }) => (
                                <li key={label}>
                                    <NavLink
                                        to={path}
                                        className={({ isActive }) =>
                                            [
                                                "flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition 2xl:h-11 2xl:gap-3 2xl:px-4",
                                                isActive
                                                    ? "bg-white text-[#070910] shadow-lg shadow-white/10"
                                                    : "text-white/70 hover:bg-white/10 hover:text-white",
                                            ].join(" ")
                                        }
                                    >
                                        <Icon className="size-5 shrink-0" aria-hidden="true" />
                                        <span className="min-w-0 truncate">{label}</span>
                                    </NavLink>
                                </li>
                            ))}
                        </ul>
                    </nav>

                    <nav className="admin-sidebar-account-command mt-4 shrink-0 border-t border-white/10 pt-4" aria-label="Admin account navigation">
                        <div className="admin-sidebar-profile mb-3 flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.04] p-2.5">
                            <span className="theme-primary-bg flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white">
                                {accountInitial}
                            </span>
                            <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-white">{accountName}</p>
                                <p className="truncate text-xs text-white/45">{isPocOperations ? "POC Operations" : accountPosition}</p>
                            </div>
                        </div>
                        <NavLink
                            to="/login"
                            onClick={clearAuthUser}
                            className="admin-sidebar-logout flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-white/70 transition hover:bg-white/10 hover:text-white 2xl:h-11 2xl:gap-3 2xl:px-4"
                        >
                            <FiLogOut className="size-5 shrink-0" aria-hidden="true" />
                            <span>Logout</span>
                        </NavLink>
                    </nav>

                    <nav className="admin-sidebar-account-legacy mt-4 shrink-0 border-t border-white/10 pt-4" aria-label="Admin account navigation">
                        <NavLink
                            to="/login"
                            onClick={clearAuthUser}
                            className="flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-white/70 transition hover:bg-white/10 hover:text-white 2xl:h-11 2xl:gap-3 2xl:px-4"
                        >
                            <FiLogOut className="size-5 shrink-0" aria-hidden="true" />
                            <span>Logout</span>
                        </NavLink>
                    </nav>
                </div>
            </aside>

            <main className="relative flex h-screen flex-col pl-[13.5rem] 2xl:pl-[16rem]">
                <header className="theme-header-bg z-20 border-b border-white/10 px-4 py-3 backdrop-blur-xl 2xl:px-6 2xl:py-4">
                    <div className="flex min-h-11 items-center justify-between gap-3 2xl:min-h-12 2xl:gap-4">
                        <div className="min-w-0">
                            <p className="text-xs font-medium uppercase tracking-[0.18em] text-white/40">{isPocOperations ? "Operations Workspace" : "Admin Workspace"}</p>
                            <h1 className="mt-1 truncate text-xl font-semibold text-white">{currentPageTitle}</h1>
                        </div>

                        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 2xl:gap-3">
                            <label className="hidden h-10 w-full max-w-[18rem] items-center gap-3 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-white/50 transition focus-within:border-[#842cff] focus-within:bg-white/[0.08] focus-within:ring-2 focus-within:ring-[#842cff]/20 lg:flex 2xl:h-11 2xl:max-w-[22rem]">
                                <FiSearch className="size-5 shrink-0" aria-hidden="true" />
                                <input
                                    className="h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
                                    type="search"
                                    placeholder="Search agents or leads"
                                />
                            </label>

                            <div ref={notificationsRef} className="relative">
                                <button
                                    className={[
                                        "relative flex size-10 shrink-0 items-center justify-center rounded-lg border text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[#842cff]/60 2xl:size-11",
                                        isNotificationsOpen ? "border-[#842cff]/70 bg-white/[0.08]" : "border-white/10 bg-white/[0.06]",
                                    ].join(" ")}
                                    type="button"
                                    aria-label="Notifications"
                                    aria-expanded={isNotificationsOpen}
                                    onClick={() => setIsNotificationsOpen((isOpen) => !isOpen)}
                                >
                                    <FiBell className="size-5" aria-hidden="true" />
                                    {notificationCount > 0 && <span className="absolute right-2.5 top-2.5 size-2 rounded-full bg-[#842cff]" />}
                                </button>
                                {isNotificationsOpen && (
                                    <div className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-80 overflow-hidden rounded-lg border border-white/10 bg-[#11141d] shadow-2xl shadow-black/45">
                                        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                                            <div>
                                                <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Notifications</p>
                                                <p className="mt-1 text-sm font-semibold text-white">{notificationCount} latest records</p>
                                            </div>
                                            {unreadMessageCount > 0 && (
                                                <button
                                                    className="h-8 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-xs font-semibold text-white/65 transition hover:bg-white/10 hover:text-white"
                                                    type="button"
                                                    onClick={markAllMessagesRead}
                                                >
                                                    Read messages
                                                </button>
                                            )}
                                        </div>
                                        <div className="content-scroll max-h-96 overflow-y-auto p-2">
                                            {messageNotifications.length === 0 && pendingLeaveRequests.length === 0 && notices.length === 0 && (
                                                <p className="rounded-lg border border-white/10 bg-white/[0.035] p-4 text-sm text-white/45">No notifications yet.</p>
                                            )}
                                            {messageNotifications.map((notification) => (
                                                <Link
                                                    key={notification.id}
                                                    className={[
                                                        "mb-2 block rounded-lg border p-3 text-left transition",
                                                        notification.isRead
                                                            ? "border-white/10 bg-white/[0.025] text-white/55 hover:bg-white/[0.055]"
                                                            : "border-[#842cff]/45 bg-[#842cff]/15 text-white hover:bg-[#842cff]/20",
                                                    ].join(" ")}
                                                    to={notification.href}
                                                    onClick={() => {
                                                        markMessageRead(notification.id);
                                                        setIsNotificationsOpen(false);
                                                    }}
                                                >
                                                    <div className="flex items-start justify-between gap-3">
                                                        <p className="line-clamp-1 text-sm font-semibold">Message from {notification.senderName}</p>
                                                        {!notification.isRead && <span className="mt-1 size-2 shrink-0 rounded-full bg-[#842cff]" />}
                                                    </div>
                                                    <p className="mt-1 line-clamp-1 text-xs font-semibold text-white/60">{notification.title}</p>
                                                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/55">{notification.body}</p>
                                                    <p className="mt-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-white/35">
                                                        Message · {formatPhDateTime(notification.createdAt)}
                                                    </p>
                                                </Link>
                                            ))}
                                            {pendingLeaveRequests.map((leaveRequest) => {
                                                const employee = typeof leaveRequest.employee === "string" ? null : leaveRequest.employee;
                                                const employeeName = employee?.name || "Employee";

                                                return (
                                                    <Link
                                                        key={leaveRequest._id}
                                                        className="mb-2 block rounded-lg border border-amber-300/35 bg-amber-300/10 p-3 text-left transition hover:bg-amber-300/15"
                                                        to={roleWorkspacePath("/admin/employees", authUser)}
                                                        onClick={() => setIsNotificationsOpen(false)}
                                                    >
                                                        <div className="flex items-start justify-between gap-3">
                                                            <p className="line-clamp-1 text-sm font-semibold text-white">Leave request from {employeeName}</p>
                                                            <span className="rounded-md bg-amber-100 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.1em] text-amber-700">
                                                                Pending
                                                            </span>
                                                        </div>
                                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/60">
                                                            {leaveRequest.leaveType} leave · {formatPhDate(leaveRequest.startDate)} - {formatPhDate(leaveRequest.endDate)}
                                                        </p>
                                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/55">{leaveRequest.reason}</p>
                                                        <p className="mt-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-white/35">
                                                            Leave · {formatPhDateTime(leaveRequest.createdAt)}
                                                        </p>
                                                    </Link>
                                                );
                                            })}
                                            {notices.map((notice) => {
                                                const employeeName = typeof notice.employee === "string" ? "Employee" : notice.employee.name;

                                                return (
                                                    <Link
                                                        key={notice._id}
                                                        className="block rounded-lg border border-white/10 bg-white/[0.025] p-3 text-left transition hover:bg-white/[0.055]"
                                                        to={roleWorkspacePath("/admin/employees", authUser)}
                                                        onClick={() => setIsNotificationsOpen(false)}
                                                    >
                                                        <div className="flex items-start justify-between gap-3">
                                                            <p className="line-clamp-1 text-sm font-semibold text-white">{notice.title}</p>
                                                            <span
                                                                className={[
                                                                    "rounded-md px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.1em]",
                                                                    notice.severity === "Critical"
                                                                        ? "bg-red-700 text-white"
                                                                        : notice.severity === "Warning"
                                                                          ? "bg-red-100 text-red-700"
                                                                          : "bg-[#842cff]/15 text-[#d8c8ff]",
                                                                ].join(" ")}
                                                            >
                                                                {notice.severity}
                                                            </span>
                                                        </div>
                                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/55">{notice.message}</p>
                                                        <p className="mt-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-white/35">
                                                            {employeeName} · {formatPhDateTime(notice.createdAt)}
                                                        </p>
                                                    </Link>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>

                            <Link
                                className="relative flex size-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[#842cff]/60 2xl:size-11"
                                to="/admin/messages"
                                aria-label="Messages"
                                onClick={markAllMessagesRead}
                            >
                                <FiMessageCircle className="size-5" aria-hidden="true" />
                                {unreadMessageCount > 0 && (
                                    <span className="absolute right-1 top-1 min-w-5 rounded-full bg-[#842cff] px-1.5 py-0.5 text-[0.65rem] font-bold leading-none text-white">
                                        {unreadMessageCount > 9 ? "9+" : unreadMessageCount}
                                    </span>
                                )}
                            </Link>

                            <div ref={businessRef} className="relative">
                                <button
                                    className={[
                                        "flex h-10 shrink-0 items-center gap-2 rounded-lg border py-1 pl-1 pr-2.5 text-left transition focus:outline-none focus:ring-2 focus:ring-[#842cff]/60 2xl:h-11 2xl:gap-3 2xl:py-1.5 2xl:pl-1.5 2xl:pr-3",
                                        isBusinessOpen ? "border-[#842cff]/70 bg-white/[0.08]" : "border-white/10 bg-white/[0.06] hover:bg-white/10",
                                    ].join(" ")}
                                    type="button"
                                    aria-haspopup="menu"
                                    aria-expanded={isBusinessOpen}
                                    onClick={() => setIsBusinessOpen((isOpen) => !isOpen)}
                                >
                                    <span className="theme-primary-bg flex size-8 items-center justify-center rounded-md text-sm font-semibold text-white">
                                        {activeBusinessInitial}
                                    </span>
                                    <span className="hidden min-w-0 sm:block">
                                        <span className="block max-w-32 truncate text-sm font-semibold text-white">{activeBusinessName}</span>
                                        <span className="block max-w-32 truncate text-xs text-white/45">{accountPosition}</span>
                                    </span>
                                    <FiChevronDown
                                        className={["hidden size-4 text-white/45 transition sm:block", isBusinessOpen ? "rotate-180" : ""].join(" ")}
                                        aria-hidden="true"
                                    />
                                </button>

                                {isBusinessOpen && (
                                    <div className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-64 overflow-hidden rounded-lg border border-white/10 bg-[#11141d] p-1 shadow-2xl shadow-black/45">
                                        <div className="border-b border-white/10 px-3 py-2">
                                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Switch Business</p>
                                            <div className="mt-2 flex min-w-0 items-center gap-2.5">
                                                <span className="theme-primary-bg flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white">
                                                    {accountInitial}
                                                </span>
                                                <span className="min-w-0">
                                                    <span className="block truncate text-sm font-semibold text-white">{accountName}</span>
                                                    <span className="mt-0.5 block truncate text-xs text-white/45">{accountPosition}</span>
                                                </span>
                                            </div>
                                            <p className="mt-2 truncate text-xs text-white/45">
                                                Current business: <span className="font-semibold text-white/75">{activeBusinessName}</span>
                                            </p>
                                        </div>
                                        <div className="py-1">
                                            {accessibleBusinesses.map((business) => {
                                                const isActive = business.id === activeBusiness?.id;

                                                return (
                                                    <button
                                                        key={business.id}
                                                        className={[
                                                            "flex h-10 w-full items-center justify-between rounded-md px-3 text-left text-sm font-semibold transition",
                                                            isActive ? "bg-[#842cff]/15 text-[#d8c8ff]" : "text-white/65 hover:bg-white/[0.06] hover:text-white",
                                                        ].join(" ")}
                                                        type="button"
                                                        role="menuitem"
                                                        onClick={() => handleBusinessSwitch(business.id)}
                                                    >
                                                        <span className="min-w-0 truncate">{business.name}</span>
                                                        {isActive && <span className="size-2 rounded-full bg-[#842cff]" />}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </header>

                <div
                    className={[
                        "content-scroll min-h-0 flex-1 overflow-y-auto p-4 2xl:p-6",
                        isScrolling ? "is-scrolling" : "",
                    ].join(" ")}
                    onScroll={handleScroll}
                >
                    {children}
                </div>
            </main>
        </div>
    );
}
