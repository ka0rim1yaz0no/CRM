import { useEffect, useMemo, useState } from "react";
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
import { MdPassword } from "react-icons/md";

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
  { label: "Employees", path: "/poc/employees", icon: FiUsers, feature: "employees" },
  { label: "Tasks", path: "/poc/tasks", icon: FiCheckSquare, feature: "tasks" },
  { label: "Credentials", path: "/poc/credentials", icon: MdPassword, feature: "credentials" },
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
    setAnnouncementSeenAt(readAnnouncementSeenAt(employeeId));
  }, [employeeId]);

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
    <aside className="theme-shell-bg fixed inset-y-0 left-0 z-10 flex w-[16rem] flex-col border-r border-white/10 text-white shadow-2xl shadow-black/20 backdrop-blur-xl">
      <div className="flex w-full items-center justify-center border-b border-white/10 px-6 py-5">
        <img
          className="theme-sidebar-logo theme-sidebar-logo-dark max-w-[12rem]"
          src="/images/logoaside.png"
          alt="CRM"
        />
        <img
          className="theme-sidebar-logo theme-sidebar-logo-light hidden max-w-[12rem]"
          src="/images/logoaside-light.png"
          alt="CRM"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-between px-3 py-5">
        <nav
          className="content-scroll min-h-0 overflow-y-auto pr-1"
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
                    className={({ isActive }) =>
                      [
                        "flex h-11 items-center gap-3 rounded-lg px-4 text-sm font-medium transition",
                        isActive
                          ? "bg-white text-[var(--shell-bg)] shadow-lg shadow-white/10"
                          : "text-white/70 hover:bg-white/10 hover:text-white",
                      ].join(" ")
                    }
                  >
                    <Icon className="size-5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {badgeCount > 0 && (
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

        <nav aria-label="Account navigation">
          <NavLink
            to="/login"
            onClick={handleLogout}
            className="flex h-11 items-center gap-3 rounded-lg px-4 text-sm font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <FiLogOut className="size-5 shrink-0" aria-hidden="true" />
            <span>Logout</span>
          </NavLink>
        </nav>
      </div>
    </aside>
  );
}
