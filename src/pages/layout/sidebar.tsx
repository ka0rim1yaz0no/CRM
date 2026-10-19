import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { NavLink } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  FiBarChart2,
  FiBell,
  FiBookOpen,
  FiCalendar,
  FiCheckSquare,
  FiClock,
  FiLogOut,
  FiMessageCircle,
  FiSettings,
  FiTarget,
  FiUsers,
  FiUser,
} from "react-icons/fi";
import type { FeatureKey } from "../../api/features";
import { logoutEmployee } from "../../api/auth";
import { clearAuthUser, getAuthUser } from "../../api/authStorage";
import { getKnowledgeBaseEntries } from "../../api/knowledgeBase";
import { getTasks } from "../../api/tasks";
import { useFeatureFlags } from "../../hooks/useFeatureFlags";
import { useMessageNotifications } from "../../hooks/useMessageNotifications";
import {
  ANNOUNCEMENT_SEEN_EVENT,
  getAnnouncementTimestamp,
  readAnnouncementSeenAt,
} from "../../lib/announcementReadState";
import { isPocOperationsUser } from "../../lib/roleAccess";
import "../../components/WorkspaceSidebar.css";

const navItems = [
  {
    label: "Dashboard",
    path: "/dashboard",
    icon: FiBarChart2,
    feature: "dashboard",
  },
  { label: "Leads", path: "/leads", icon: FiTarget, feature: "leads" },
  { label: "Tasks", path: "/tasks", icon: FiCheckSquare, feature: "tasks" },
  {
    label: "Knowledge Base",
    path: "/knowledge-base",
    icon: FiBookOpen,
    feature: "knowledge-base",
  },
  {
    label: "Announcements",
    path: "/announcements",
    icon: FiBell,
    feature: "knowledge-base",
  },
  { label: "Teams", path: "/teams", icon: FiUsers, feature: "teams" },
  { label: "Messages", path: "/messages", icon: FiMessageCircle, feature: "messages" },
  {
    label: "Calendar",
    path: "/calendar",
    icon: FiCalendar,
    feature: "calendar",
  },
  {
    label: "Attendance",
    path: "/attendance",
    icon: FiClock,
    feature: "attendance",
  },
  { label: "Profile", path: "/profile", icon: FiUser, feature: "profile" },
  {
    label: "Settings",
    path: "/settings",
    icon: FiSettings,
    feature: "settings",
  },
];

const outsideSalesNavPaths = new Set(["/dashboard", "/leads", "/tasks"]);

const pocOperationsNavItems = [
  { label: "Tasks", path: "/poc/tasks", icon: FiCheckSquare, feature: "tasks" },
];

function isOutsideSalesEmployee(authUser: ReturnType<typeof getAuthUser>) {
  if (authUser?.userType !== "employee") return false;

  const role = (authUser.user.role || "").toLowerCase();
  const team = (authUser.user.team || "").toLowerCase();

  return (
    (role.includes("outside") && role.includes("sales")) ||
    (team.includes("outside") && team.includes("sales"))
  );
}

export default function SideBar() {
  const { isEnabled } = useFeatureFlags();
  const authUser = getAuthUser();
  const { unreadMessageCount } = useMessageNotifications();
  const employeeId = authUser?.userType === "employee" ? authUser.user._id : "";
  const isOutsideSalesUser = isOutsideSalesEmployee(authUser);
  const isPocOperations = isPocOperationsUser(authUser);
  const announcementsEnabled =
    !isOutsideSalesUser &&
    isEnabled("knowledge-base" as FeatureKey, "employee");
  const tasksEnabled = isEnabled("tasks" as FeatureKey, "employee");
  const employeeNavItems = navItems.filter(
    (item) =>
      isEnabled(item.feature as FeatureKey, "employee") &&
      (!isOutsideSalesUser || outsideSalesNavPaths.has(item.path)) &&
      (!isPocOperations || (item.path !== "/tasks" && item.path !== "/settings")),
  );
  const visibleNavItems = isPocOperations
    ? [
        ...employeeNavItems,
        ...pocOperationsNavItems.filter((item) => isEnabled(item.feature as FeatureKey, "admin")),
        ...navItems.filter((item) => item.path === "/settings" && isEnabled(item.feature as FeatureKey, "employee")),
      ]
    : employeeNavItems;
  const [announcementSeenAt, setAnnouncementSeenAt] = useState(() =>
    readAnnouncementSeenAt(employeeId),
  );
  const [isCollapsed, setIsCollapsed] = useState(() => window.localStorage.getItem("crm:sidebar-collapsed") === "true");
  const { data: announcementEntries = [] } = useQuery({
    queryKey: ["knowledge-base", "Article"],
    queryFn: () => getKnowledgeBaseEntries("Article"),
    enabled: Boolean(employeeId) && announcementsEnabled,
    staleTime: 60_000,
  });

  const { data: taskEntries = [] } = useQuery({
    queryKey: ["tasks", employeeId, "sidebar-count"],
    queryFn: () => getTasks({ assignedTo: employeeId }),
    enabled: Boolean(employeeId) && tasksEnabled,
    staleTime: 60_000,
  });

  useEffect(() => {
    const syncSidebar = () => setIsCollapsed(window.localStorage.getItem("crm:sidebar-collapsed") === "true");
    window.addEventListener("crm:sidebar-toggle", syncSidebar);
    return () => window.removeEventListener("crm:sidebar-toggle", syncSidebar);
  }, []);

  const [previousAnnouncementIdentity, setPreviousAnnouncementIdentity] = useState<readonly unknown[] | null>(null);
    const announcementIdentityInputs = [employeeId];
    if (previousAnnouncementIdentity === null || announcementIdentityInputs.some((input, index) => !Object.is(input, previousAnnouncementIdentity[index]))) {
        setPreviousAnnouncementIdentity(announcementIdentityInputs);
        (() => {
        setAnnouncementSeenAt(readAnnouncementSeenAt(employeeId));
      })();
    }

  useEffect(() => {
    if (!employeeId || typeof window === "undefined") return undefined;

    const syncSeenAt = () => {
      setAnnouncementSeenAt(readAnnouncementSeenAt(employeeId));
    };

    window.addEventListener(ANNOUNCEMENT_SEEN_EVENT, syncSeenAt);
    window.addEventListener("storage", syncSeenAt);

    return () => {
      window.removeEventListener(ANNOUNCEMENT_SEEN_EVENT, syncSeenAt);
      window.removeEventListener("storage", syncSeenAt);
    };
  }, [employeeId]);

  const newAnnouncementCount = useMemo(
    () =>
      announcementEntries.filter(
        (entry) =>
          entry.entryType === "Article" &&
          entry.status === "Active" &&
          getAnnouncementTimestamp(entry) > announcementSeenAt,
      ).length,
    [announcementEntries, announcementSeenAt],
  );
  const openTaskCount = useMemo(
    () => taskEntries.filter((task) => task.status !== "Done").length,
    [taskEntries],
  );

  const handleLogout = () => {
    clearAuthUser();

    if (authUser?.userType === "employee") {
      logoutEmployee(authUser.user._id).catch(() => undefined);
    }
  };

  return (
    <aside className={["workspace-sidebar theme-shell-bg fixed inset-y-0 left-0 z-10 flex flex-col border-r border-white/10 text-white shadow-2xl shadow-black/20 backdrop-blur-xl transition-[width] duration-200", isCollapsed ? "w-[5rem]" : "w-[16rem]"].join(" ")}>
      <div className={["workspace-sidebar-brand flex w-full items-center border-b border-white/10 py-5", isCollapsed ? "justify-center px-2" : "justify-center px-6"].join(" ")}>
        {isCollapsed ? (
          <div className="h-10 w-10 overflow-hidden" aria-label="Assistly">
            <img className="theme-sidebar-logo theme-sidebar-logo-dark h-auto w-[9.75rem] max-w-none" src="/images/logoaside.png" alt="" />
            <img className="theme-sidebar-logo theme-sidebar-logo-light hidden h-auto w-[9.75rem] max-w-none" src="/images/logoaside-light.png" alt="" />
          </div>
        ) : (
          <>
            <img className="theme-sidebar-logo theme-sidebar-logo-dark max-w-[12rem]" src="/images/logoaside.png" alt="Assistly" />
            <img className="theme-sidebar-logo theme-sidebar-logo-light hidden max-w-[12rem]" src="/images/logoaside-light.png" alt="Assistly" />
          </>
        )}
      </div>

      <div className={["workspace-sidebar-body flex min-h-0 flex-1 flex-col justify-between py-5", isCollapsed ? "px-2" : "px-3"].join(" ")}>
        <nav
          className="workspace-sidebar-flat-nav content-scroll min-h-0 overflow-y-auto pr-1"
          style={{ "--sidebar-item-count": visibleNavItems.length } as CSSProperties}
          aria-label="Main navigation"
        >
          <ul className="flex flex-col gap-1">
            {visibleNavItems.map(({ label, path, icon: Icon }) => {
              const badgeCount =
                label === "Announcements"
                  ? newAnnouncementCount
                  : label === "Tasks"
                    ? openTaskCount
                    : label === "Messages"
                      ? unreadMessageCount
                    : 0;

              return (
                <li key={label}>
                  <NavLink
                    to={path}
                    title={label}
                    aria-label={label}
                    className={({ isActive }) =>
                      [
                        "admin-sidebar-link flex h-11 items-center gap-3 rounded-lg text-sm font-medium transition",
                        isCollapsed ? "justify-center px-2" : "px-4",
                        isActive
                          ? "bg-white text-[var(--shell-bg)] shadow-lg shadow-white/10"
                          : "text-white/70 hover:bg-white/10 hover:text-white",
                      ].join(" ")
                    }
                  >
                    <span className="admin-sidebar-icon flex shrink-0 items-center justify-center">
                      <Icon className="size-5 shrink-0" aria-hidden="true" />
                    </span>
                    {!isCollapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
                    {!isCollapsed && badgeCount > 0 && (
                      <span className="ml-auto inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-[#6d35f5] px-1.5 py-0.5 text-[0.68rem] font-bold leading-none text-white shadow-sm shadow-[#6d35f5]/30">
                        {badgeCount > 99 ? "99+" : badgeCount}
                      </span>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>

        <nav className="workspace-sidebar-account" aria-label="Account navigation">
          <NavLink
            to="/login"
            onClick={handleLogout}
            className={["flex h-11 items-center gap-3 rounded-lg text-sm font-medium text-white/70 transition hover:bg-white/10 hover:text-white", isCollapsed ? "justify-center px-2" : "px-4"].join(" ")}
          >
            <FiLogOut className="size-5 shrink-0" aria-hidden="true" />
            {!isCollapsed && <span>Logout</span>}
          </NavLink>
        </nav>
      </div>
    </aside>
  );
}
