import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import { isAxiosError } from "axios";
import { Link, useNavigate } from "react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiActivity, FiBarChart2, FiCalendar, FiCheckCircle, FiChevronDown, FiChevronLeft, FiChevronRight, FiClock, FiDownload, FiMessageSquare, FiPhoneCall, FiRefreshCw, FiSearch, FiTarget, FiTrendingUp, FiUserCheck, FiUsers } from "react-icons/fi";
import AdminLayout from "../adminLayout";
import CallDashboardPanel from "../../../components/CallDashboardPanel";
import { getBusinesses } from "../../../api/businesses";
import { getActiveBusinessId } from "../../../api/businessStorage";
import { getEmployeeSummaries, normalizeEmployeeAvailabilityStatus } from "../../../api/employees";
import { getEmployeeAttendance, getEmployeesAttendance } from "../../../api/attendance";
import { getAgentLeadDashboard, getLead, getLeadCallSummary, type AgentLeadActivity, type AgentLeadMonthlyRow } from "../../../api/leads";
import { formatPhDateTime } from "../../../lib/dateTime";
import { socket } from "../../../lib/socket";
import { getAuthUser } from "../../../api/authStorage";
import { dashboardWorkspaceEnabled } from "../../../lib/workspaceRollout";
import { getDashboardWorkspace, type DashboardWorkspaceData } from "../../../api/dashboardWorkspace";
import { DashboardHeader, DashboardAttention, DashboardKpiDetail, DashboardOperations, DashboardQuickView, DashboardCustomize } from "../../../components/DashboardWorkspace";
import DashboardMetric from "../../../components/MetricValue";
import AvailabilityBadge from "../../../components/AvailabilityBadge";
import DashboardEmployeeName, { EmployeeQuickViewProvider } from "../../../components/DashboardEmployeeName";
import { dashboardSectionNames, useDashboardControls } from "../../../hooks/useDashboardControls";
import { uniqueDashboardRows } from "../../../../shared/dashboardIdentity";
import { dashboardSectionView, dashboardViews, dashboardViewLabels } from "../../../../shared/dashboardLayout";
import DashboardCallCounts from "../../../components/DashboardCallCounts";
const AttendanceHub = lazy(() => import("../../../components/AttendanceHub"));
import { KpiCard, EmptyPanel, AgentProgressRow, MonthlyAgentRow, QualifiedLeadsModal, EmployeeLeadCallsModal, ActivityItem, LeadHistoryModal, AttendancePanel } from "./legacySections";
import { agentRowsPerPage, monthlyRowsPerPage, type CallCountRange, formatNumber, getMonthInputValue, formatMonthLabel, formatDateInputValue, formatTimeInputValue, getMonthlyDashboardDateRange, formatDateRangeLabel, formatSingleDateLabel, downloadCsv, getPaginationNumbers, availabilityClass, availabilityDotClass, availabilitySortRank, isArchivedEmployee, buildOnlineStatusRows, mergeAgentProgressRows, mergeAgentMonthlyRows, getLeadHistory, getShiftStartDateFromTimestamp, getShiftEndDate, getCurrentShiftDateValue, getAttendanceQueryRange, type EmployeeCallSummaryRow, getCallSummaryFilterRange } from "./legacyMath";

export default function AdminDashboard() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const workspaceControls = useDashboardControls(dashboardWorkspaceEnabled);
    const [quickCode, setQuickCode] = useState("");
    const [customization, setCustomization] = useState<{ order: string[]; hidden: string[] }>(() => {
        try { const saved = JSON.parse(localStorage.getItem(`dashboard-sections:${getAuthUser()?.user.employeeCode}`) || "null");
            if (saved && Array.isArray(saved.order) && Array.isArray(saved.hidden)) return { order: [...saved.order.filter((name: string) => dashboardSectionNames.includes(name)), ...dashboardSectionNames.filter((name) => !saved.order.includes(name))], hidden: saved.hidden.filter((name: string) => dashboardSectionNames.includes(name)) }; } catch { /* Ignore damaged presentation preferences. */ }
        return { order: dashboardSectionNames, hidden: ["Employee Attendance"] };
    });
    const sectionProps = (name: string) => dashboardWorkspaceEnabled ? { "data-dashboard-section": name,
        "data-hidden": name === "Employee Attendance" || customization.hidden.includes(name) || dashboardSectionView(name) !== workspaceControls.view,
        style: { "--dashboard-section-order": 20 + customization.order.indexOf(name) } as CSSProperties } : {};
    const [selectedActivity, setSelectedActivity] = useState<AgentLeadActivity | null>(null);
    const [qualifiedLeadRow, setQualifiedLeadRow] = useState<AgentLeadMonthlyRow | null>(null);
    const [selectedMonth, setSelectedMonth] = useState(() => getMonthInputValue(new Date()));
    const [isMonthMenuOpen, setIsMonthMenuOpen] = useState(false);
    const [callCountRange, setCallCountRange] = useState<CallCountRange>("day");
    const [selectedCallDate, setSelectedCallDate] = useState(() => formatDateInputValue(new Date()));
    const [selectedCallEmployeeId, setSelectedCallEmployeeId] = useState("all");
    const [selectedAttendanceEmployeeId, setSelectedAttendanceEmployeeId] = useState("");
    const [selectedAttendanceDepartment, setSelectedAttendanceDepartment] = useState("all");
    const [attendanceEmployeeSearch, setAttendanceEmployeeSearch] = useState("");
    const [isAttendanceEmployeeMenuOpen, setIsAttendanceEmployeeMenuOpen] = useState(false);
    const [, setIsAttendanceSelectionCleared] = useState(false);
    const [attendanceSelectedShiftDate, setAttendanceSelectedShiftDate] = useState(() => getCurrentShiftDateValue());
    const [attendanceDateFrom, setAttendanceDateFrom] = useState("");
    const [attendanceDateTo, setAttendanceDateTo] = useState("");
    const [agentPage, setAgentPage] = useState(1);
    const [monthlyPage, setMonthlyPage] = useState(1);
    const legacyMonthlyRange = useMemo(() => getMonthlyDashboardDateRange(selectedMonth), [selectedMonth]);
    const selectedMonthlyRange = dashboardWorkspaceEnabled && workspaceControls.filters.preset === "custom" && workspaceControls.filters.from && workspaceControls.filters.to ? { dateFrom: workspaceControls.filters.from, dateTo: workspaceControls.filters.to } : legacyMonthlyRange;
    const { data, isLoading, isError, error: dashboardError, refetch, isFetching } = useQuery({
        queryKey: dashboardWorkspaceEnabled ? ["agent-lead-dashboard", workspaceControls.business, workspaceControls.filters] : ["agent-lead-dashboard", selectedMonth, selectedMonthlyRange.dateFrom, selectedMonthlyRange.dateTo, selectedCallDate],
        queryFn: () => dashboardWorkspaceEnabled ? getDashboardWorkspace(workspaceControls.filters, workspaceControls.business) : getAgentLeadDashboard({ month: selectedMonth, dateFrom: selectedMonthlyRange.dateFrom, dateTo: selectedMonthlyRange.dateTo, callDate: selectedCallDate }),
        refetchInterval: dashboardWorkspaceEnabled ? (workspaceControls.refreshing ? 60_000 : false) : 15_000,
        placeholderData: dashboardWorkspaceEnabled ? (previous) => previous?.business.id === workspaceControls.business ? previous : undefined : undefined,
        refetchOnWindowFocus: !dashboardWorkspaceEnabled || workspaceControls.refreshing,
        enabled: workspaceControls.ready,
    });
    const workspace = data && "workspace" in data ? data.workspace as DashboardWorkspaceData : undefined;
    const monthlyRangeLabel = formatDateRangeLabel(workspace?.range.from || selectedMonthlyRange.dateFrom, workspace?.range.to || selectedMonthlyRange.dateTo);
    const businessesQuery = useQuery({
        queryKey: ["businesses"],
        queryFn: getBusinesses,
        staleTime: 60_000,
    });
    const activeBusinessId = getActiveBusinessId() || data?.business?.id || "";
    const activeBusinessName = businessesQuery.data?.find((business) => business.id === activeBusinessId)?.name
        || data?.business?.name
        || "Current business";
    useEffect(() => {
        let refreshTimeoutId: number | undefined;

        const refreshLeadProgress = () => {
            if (dashboardWorkspaceEnabled && !workspaceControls.refreshing) return;
            window.clearTimeout(refreshTimeoutId);
            refreshTimeoutId = window.setTimeout(() => {
                void refetch();
                void queryClient.invalidateQueries({ queryKey: ["lead-call-summary", "admin"] });
            }, 750);
        };

        socket.on("lead:changed", refreshLeadProgress);
        socket.on("lead-call-stat:updated", refreshLeadProgress);

        return () => {
            window.clearTimeout(refreshTimeoutId);
            socket.off("lead:changed", refreshLeadProgress);
            socket.off("lead-call-stat:updated", refreshLeadProgress);
        };
    }, [queryClient, refetch, workspaceControls.refreshing]);
    const employeesQuery = useQuery({
        queryKey: ["employees", "summary", "dashboard-online-status", getActiveBusinessId()],
        queryFn: getEmployeeSummaries,
        refetchInterval: dashboardWorkspaceEnabled ? (workspaceControls.refreshing ? 60_000 : false) : 15_000,
        refetchOnWindowFocus: !dashboardWorkspaceEnabled || workspaceControls.refreshing,
    });
    const attendanceEmployeeOptions = useMemo(() => {
        return (employeesQuery.data || [])
            .filter((employee) => !isArchivedEmployee(employee))
            .sort((first, second) => (first.name || first.employeeCode || "").localeCompare(second.name || second.employeeCode || ""));
    }, [employeesQuery.data]);
    const attendanceDepartmentOptions = useMemo(() => {
        return Array.from(
            new Set(attendanceEmployeeOptions.map((employee) => employee.team?.trim() || "Unassigned"))
        ).sort((first, second) => first.localeCompare(second));
    }, [attendanceEmployeeOptions]);
    const departmentFilteredAttendanceEmployeeOptions = useMemo(() => {
        if (selectedAttendanceDepartment === "all") {
            return attendanceEmployeeOptions;
        }

        return attendanceEmployeeOptions.filter((employee) => (employee.team?.trim() || "Unassigned") === selectedAttendanceDepartment);
    }, [attendanceEmployeeOptions, selectedAttendanceDepartment]);
    const selectedAttendanceEmployee = departmentFilteredAttendanceEmployeeOptions.find((employee) => employee._id === selectedAttendanceEmployeeId) || null;
    const effectiveAttendanceEmployeeId = selectedAttendanceEmployee?._id || "";
    const selectedAttendanceEmployeeLabel = selectedAttendanceEmployee?.name || selectedAttendanceEmployee?.employeeCode || "Select employee";
    const filteredAttendanceEmployeeOptions = useMemo(() => {
        const searchValue = attendanceEmployeeSearch.trim().toLowerCase();

        if (!searchValue) {
            return departmentFilteredAttendanceEmployeeOptions;
        }

        return departmentFilteredAttendanceEmployeeOptions.filter((employee) => {
            const searchableText = [
                employee.name,
                employee.employeeCode,
                employee.role,
                employee.team,
                ...(employee.aliases || []),
            ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();

            return searchableText.includes(searchValue);
        });
    }, [departmentFilteredAttendanceEmployeeOptions, attendanceEmployeeSearch]);
    const attendanceQueryRange = useMemo(
        () => dashboardWorkspaceEnabled && workspace ? getAttendanceQueryRange("", workspace.range.from, workspace.range.to) : getAttendanceQueryRange(attendanceSelectedShiftDate, attendanceDateFrom, attendanceDateTo),
        [workspace, attendanceSelectedShiftDate, attendanceDateFrom, attendanceDateTo]
    );
    const attendanceRecordsQuery = useQuery({
        queryKey: ["admin-dashboard-attendance-records", getActiveBusinessId(), effectiveAttendanceEmployeeId, attendanceQueryRange.from, attendanceQueryRange.to],
        queryFn: () => getEmployeeAttendance(effectiveAttendanceEmployeeId, { limit: 300, ...attendanceQueryRange }),
        enabled: Boolean(effectiveAttendanceEmployeeId) && !dashboardWorkspaceEnabled,
        refetchInterval: dashboardWorkspaceEnabled ? (workspaceControls.refreshing ? 60_000 : false) : 15_000,
        refetchOnWindowFocus: !dashboardWorkspaceEnabled || workspaceControls.refreshing,
    });
    const allAttendanceEmployeeIds = useMemo(
        () => departmentFilteredAttendanceEmployeeOptions.map((employee) => employee._id),
        [departmentFilteredAttendanceEmployeeOptions]
    );
    const allAttendanceQuery = useQuery({
        queryKey: ["admin-dashboard-attendance-records", getActiveBusinessId(), "all", allAttendanceEmployeeIds, attendanceQueryRange.from, attendanceQueryRange.to],
        queryFn: () => getEmployeesAttendance(allAttendanceEmployeeIds, attendanceQueryRange),
        enabled: !effectiveAttendanceEmployeeId && allAttendanceEmployeeIds.length > 0 && !dashboardWorkspaceEnabled,
        refetchInterval: dashboardWorkspaceEnabled ? (workspaceControls.refreshing ? 60_000 : false) : 30_000,
        refetchOnWindowFocus: !dashboardWorkspaceEnabled || workspaceControls.refreshing,
    });
    useEffect(() => {
        let pending: number | undefined;
        const refreshAttendance = () => {
            if (dashboardWorkspaceEnabled && !workspaceControls.refreshing) return;
            window.clearTimeout(pending);
            pending = window.setTimeout(() => {
                void queryClient.invalidateQueries({ queryKey: ["admin-dashboard-attendance-records"] }, { cancelRefetch: false });
                void queryClient.invalidateQueries({ queryKey: ["employees", "summary", "dashboard-online-status"] }, { cancelRefetch: false });
            }, 750);
        };

        socket.on("employee:availability-updated", refreshAttendance);
        socket.on("call-dashboard:updated", refreshAttendance);

        return () => {
            window.clearTimeout(pending);
            socket.off("employee:availability-updated", refreshAttendance);
            socket.off("call-dashboard:updated", refreshAttendance);
        };
    }, [queryClient, workspaceControls.refreshing]);
    const selectedLeadId = selectedActivity?.leadId || "";
    const leadHistoryQuery = useQuery({
        queryKey: ["dashboard-lead-history", selectedLeadId],
        queryFn: () => getLead(selectedLeadId),
        enabled: Boolean(selectedLeadId),
    });
    const agents = useMemo(
        () => (dashboardWorkspaceEnabled ? uniqueDashboardRows(data?.agents || [], (row) => row.employeeCode || "") : mergeAgentProgressRows(data?.agents || [])).map((row) => ({ ...row, businessId: activeBusinessId, businessName: activeBusinessName })),
        [activeBusinessId, activeBusinessName, data?.agents]
    );
    const monthlyAgents = useMemo(
        () => {
            const codes = new Map(data?.agents.map((agent) => [agent.employeeId, agent.employeeCode]));
            return (dashboardWorkspaceEnabled ? uniqueDashboardRows(data?.monthlyAgents || [], (row) => codes.get(row.employeeId) || "") : mergeAgentMonthlyRows(data?.monthlyAgents || [])).map((row) => ({ ...row, businessId: activeBusinessId, businessName: activeBusinessName }));
        },
        [activeBusinessId, activeBusinessName, data?.monthlyAgents, data?.agents]
    );
    const summary = data?.summary;
    const totalAgentPages = Math.max(Math.ceil(agents.length / agentRowsPerPage), 1);
    const currentAgentPage = Math.min(agentPage, totalAgentPages);
    const visibleAgents = useMemo(() => {
        const startIndex = (currentAgentPage - 1) * agentRowsPerPage;

        return agents.slice(startIndex, startIndex + agentRowsPerPage);
    }, [agents, currentAgentPage]);
    const agentPageNumbers = getPaginationNumbers(currentAgentPage, totalAgentPages);
    const agentPageStart = agents.length === 0 ? 0 : (currentAgentPage - 1) * agentRowsPerPage + 1;
    const agentPageEnd = Math.min(currentAgentPage * agentRowsPerPage, agents.length);
    const totalMonthlyPages = Math.max(Math.ceil(monthlyAgents.length / monthlyRowsPerPage), 1);
    const currentMonthlyPage = Math.min(monthlyPage, totalMonthlyPages);
    const visibleMonthlyAgents = useMemo(() => {
        const startIndex = (currentMonthlyPage - 1) * monthlyRowsPerPage;

        return monthlyAgents.slice(startIndex, startIndex + monthlyRowsPerPage);
    }, [monthlyAgents, currentMonthlyPage]);
    const monthlyPageNumbers = getPaginationNumbers(currentMonthlyPage, totalMonthlyPages);
    const monthlyPageStart = monthlyAgents.length === 0 ? 0 : (currentMonthlyPage - 1) * monthlyRowsPerPage + 1;
    const monthlyPageEnd = Math.min(currentMonthlyPage * monthlyRowsPerPage, monthlyAgents.length);
    const topAgents = agents.slice(0, 5);
    const onlineStatusAgents = useMemo(() => {
        if (employeesQuery.data) {
            return buildOnlineStatusRows(employeesQuery.data, agents, activeBusinessName);
        }

        return [...agents].sort((first, second) => {
            const rankDifference = availabilitySortRank(first.availabilityStatus) - availabilitySortRank(second.availabilityStatus);

            if (rankDifference !== 0) return rankDifference;

            return first.employeeName.localeCompare(second.employeeName);
        });
    }, [activeBusinessName, agents, employeesQuery.data]);
    const availableAgentCount = onlineStatusAgents.filter(
        (agent) => normalizeEmployeeAvailabilityStatus(agent.availabilityStatus) !== "OFFLINE"
    ).length;
    const leadHistory = useMemo(() => getLeadHistory(leadHistoryQuery.data), [leadHistoryQuery.data]);
    const pipelineTotals = useMemo(() => {
        return agents.reduce(
            (totals, agent) => ({
                total: totals.total + agent.newLeads + agent.followUps + agent.qualified + agent.dead,
                newLeads: totals.newLeads + agent.newLeads,
                followUps: totals.followUps + agent.followUps,
                qualified: totals.qualified + agent.qualified,
                dead: totals.dead + agent.dead,
            }),
            { total: 0, newLeads: 0, followUps: 0, qualified: 0, dead: 0 }
        );
    }, [agents]);
    const pipelineBars = [
        { label: "NEW", value: pipelineTotals.newLeads, color: "bg-slate-400" },
        { label: "FOLLOW UP", value: pipelineTotals.followUps, color: "bg-violet-500" },
        { label: "QUALIFIED", value: pipelineTotals.qualified, color: "bg-emerald-500" },
        { label: "ARCHIVE/DEAD", value: pipelineTotals.dead, color: "bg-red-400" },
    ];
    const maxPipelineValue = Math.max(...pipelineBars.map((item) => item.value), 1);
    const monthlyTotals = useMemo(() => {
        return monthlyAgents.reduce(
            (totals, row) => ({
                leadsAdded: totals.leadsAdded + row.leadsAdded,
                calls: totals.calls + (row.calls || 0),
                comments: totals.comments + row.comments,
                touchedLeads: totals.touchedLeads + row.touchedLeads,
                productivityScore: totals.productivityScore + row.productivityScore,
            }),
            { leadsAdded: 0, calls: 0, comments: 0, touchedLeads: 0, productivityScore: 0 }
        );
    }, [monthlyAgents]);
    const dailyCallCount = summary?.callsToday ?? agents.reduce((total, agent) => total + (agent.callsToday || 0), 0);
    const callEmployeeOptions = useMemo(() => {
        const optionsById = new Map<string, { id: string; name: string }>();
        const addOption = (id?: string, name?: string) => {
            const normalizedId = String(id || "").trim();
            const normalizedName = String(name || "").trim();

            if (!normalizedId || !normalizedName || optionsById.has(normalizedId)) return;

            optionsById.set(normalizedId, { id: normalizedId, name: normalizedName });
        };

        agents.forEach((agent) => addOption(agent.employeeId, agent.employeeName));
        monthlyAgents.forEach((agent) => addOption(agent.employeeId, agent.employeeName));

        return Array.from(optionsById.values()).sort((first, second) => first.name.localeCompare(second.name));
    }, [agents, monthlyAgents]);
    const selectedDailyCallCount = selectedCallEmployeeId === "all"
        ? dailyCallCount
        : agents.find((agent) => agent.employeeId === selectedCallEmployeeId)?.callsToday || 0;
    const selectedMonthlyCallCount = selectedCallEmployeeId === "all"
        ? monthlyTotals.calls
        : monthlyAgents.find((agent) => agent.employeeId === selectedCallEmployeeId)?.calls || 0;
    const selectedCallCount = dashboardWorkspaceEnabled ? selectedMonthlyCallCount : callCountRange === "day" ? selectedDailyCallCount : selectedMonthlyCallCount;
    const selectedCallEmployeeName = selectedCallEmployeeId === "all"
        ? "All employees"
        : callEmployeeOptions.find((employee) => employee.id === selectedCallEmployeeId)?.name || "Selected employee";
    const selectedCallHelper = !dashboardWorkspaceEnabled && callCountRange === "day"
        ? `${selectedCallEmployeeName} · calls logged ${formatSingleDateLabel(selectedCallDate)}`
        : `${selectedCallEmployeeName} · calls logged ${monthlyRangeLabel}`;
    const monthOptions = useMemo(() => {
        return Array.from(new Set([selectedMonth, data?.selectedMonth || "", ...(data?.monthOptions || [])]))
            .filter(Boolean)
            .sort((first, second) => second.localeCompare(first));
    }, [data?.monthOptions, data?.selectedMonth, selectedMonth]);
    const handleExportMonthlyData = () => {
        const rows = [
            ["Date Range", "Agent", "Role", "Team", "Added", "Follow Up", "Calls", "Qualified", "Archive/Dead", "Comments", "Touched", "Score", "Last Activity"],
            ...monthlyAgents.map((row) => [
                monthlyRangeLabel,
                row.employeeName,
                row.role,
                row.team,
                row.leadsAdded,
                row.followUps,
                row.calls || 0,
                row.qualified,
                row.archiveDead,
                row.comments,
                row.touchedLeads,
                row.productivityScore,
                row.lastActivityAt ? formatPhDateTime(row.lastActivityAt) : "",
            ]),
            [
                monthlyRangeLabel,
                "Total",
                "",
                "",
                monthlyTotals.leadsAdded,
                "",
                monthlyTotals.calls,
                "",
                "",
                monthlyTotals.comments,
                monthlyTotals.touchedLeads,
                monthlyTotals.productivityScore,
                "",
            ],
        ];

        downloadCsv(`agent-monthly-data-${workspace?.range.from || selectedMonthlyRange.dateFrom}-to-${workspace?.range.to || selectedMonthlyRange.dateTo}.csv`, rows);
    };


    const [selectedCallEmployeeRow, setSelectedCallEmployeeRow] =
        useState<EmployeeCallSummaryRow | null>(null);

    const [callFilterDateFrom, setCallFilterDateFrom] = useState("");
    const [callFilterTimeFrom, setCallFilterTimeFrom] = useState("23:00");
    const [callFilterDateTo, setCallFilterDateTo] = useState("");
    const [callFilterTimeTo, setCallFilterTimeTo] = useState("08:00");
    const callSummaryFilterRange = useMemo(
        () => getCallSummaryFilterRange(
            callFilterDateFrom,
            callFilterTimeFrom,
            callFilterDateTo,
            callFilterTimeTo
        ),
        [callFilterDateFrom, callFilterTimeFrom, callFilterDateTo, callFilterTimeTo]
    );

    const leadCallStatsQuery = useQuery({
        queryKey: ["lead-call-summary", "admin", getActiveBusinessId(), dashboardWorkspaceEnabled ? workspace?.range : callFilterDateFrom, callFilterTimeFrom, callFilterDateTo, callFilterTimeTo],
        queryFn: () => getLeadCallSummary(dashboardWorkspaceEnabled && workspace ? { from: workspace.range.fromTime, to: workspace.range.toTime } : callSummaryFilterRange),
        enabled: !dashboardWorkspaceEnabled || Boolean(workspace && workspaceControls.ready),
        placeholderData: keepPreviousData,
        refetchInterval: dashboardWorkspaceEnabled ? (workspaceControls.refreshing ? 60_000 : false) : 15_000,
        refetchOnWindowFocus: !dashboardWorkspaceEnabled || workspaceControls.refreshing,
    });

    const selectedAttendanceRecords = attendanceRecordsQuery.data || [];
    const allAttendanceGroups = useMemo(
        () =>
            departmentFilteredAttendanceEmployeeOptions.map((employee) => ({
                employee,
                attendance: (allAttendanceQuery.data || []).filter((record) => String(record.employee) === employee._id),
            })),
        [allAttendanceQuery.data, departmentFilteredAttendanceEmployeeOptions]
    );
    const isAllAttendanceLoading = !effectiveAttendanceEmployeeId && allAttendanceQuery.isLoading;
    const openEmployeeAttendance = (employeeId: string) => {
        navigate(`/admin/employees/${encodeURIComponent(employeeId)}?tab=attendance`);
    };

    const employeeCallRows = useMemo(() => {
        return (leadCallStatsQuery.data || []).map((row) => ({
            ...row,
            crmBusinessId: activeBusinessId,
            crmBusinessName: activeBusinessName,
            leads: row.leads.map((lead) => ({ ...lead, callLogs: [] })),
        }));
    }, [activeBusinessId, activeBusinessName, leadCallStatsQuery.data]);

    const totalCallLeadCount = useMemo(
        () => new Set(employeeCallRows.flatMap((row) => row.leads.map((lead) => lead.leadId))).size,
        [employeeCallRows]
    );

    const totalLoggedLeadCalls = useMemo(() => {
        return employeeCallRows.reduce((total, item) => total + item.totalCalls, 0);
    }, [employeeCallRows]);

    const totalNotConnectedCalls = useMemo(() => {
        return employeeCallRows.reduce(
            (total, item) => total + item.totalNotConnectedCalls,
            0
        );
    }, [employeeCallRows]);

    const totalVoicemails = useMemo(() => {
        return employeeCallRows.reduce(
            (total, item) => total + item.totalVoicemails,
            0
        );
    }, [employeeCallRows]);

    const clearCallFilters = () => {
        setCallFilterDateFrom("");
        setCallFilterTimeFrom("");
        setCallFilterDateTo("");
        setCallFilterTimeTo("");
    };

    // const totalCallAttempts = useMemo(() => {
    //     return totalLoggedLeadCalls + totalNotConnectedCalls;
    // }, [totalLoggedLeadCalls, totalNotConnectedCalls]);

    // const clearCallFilters = () => {
    //     setCallFilterDateFrom("");
    //     setCallFilterDateTo("");
    // };

    // const applyTodayCallFilter = () => {
    //     const today = formatDateInputValue(new Date());

    //     setCallFilterDateFrom(today);
    //     setCallFilterDateTo(today);
    // };

    // const applyThisMonthCallFilter = () => {
    //     const today = new Date();
    //     const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

    //     setCallFilterDateFrom(formatDateInputValue(firstDay));
    //     setCallFilterDateTo(formatDateInputValue(today));
    // };

    if (dashboardWorkspaceEnabled && !workspaceControls.ready) return <AdminLayout><p role="status">Switching business...</p></AdminLayout>;
    return (
        <AdminLayout>
            <EmployeeQuickViewProvider open={dashboardWorkspaceEnabled ? (id, name) => {
                const employee = (employeesQuery.data || []).find((item) => item._id === id || item.employeeCode === id);
                const matches = (employeesQuery.data || []).filter((item) => item.name === name);
                const code = employee?.employeeCode || (matches.length === 1 ? matches[0].employeeCode : "");
                if (code) setQuickCode(code);
            } : undefined}>
            <section data-workspace-tab={workspaceControls.view} onClickCapture={(event) => {
                if (!dashboardWorkspaceEnabled || !(event.target instanceof Element)) return;
                const anchor = event.target.closest("a");
                if (!anchor) return;
                const url = new URL(anchor.href, window.location.href);
                if (url.pathname !== window.location.pathname) return;
                const view = url.hash === "#lead-aging" ? "insights" : ["#dashboard-monthly-data", "#agent-calls"].includes(url.hash) ? "performance" : null;
                if (view) { event.preventDefault(); workspaceControls.setFilter("view", view); }
            }} className={`admin-dashboard-page min-h-full ${dashboardWorkspaceEnabled ? "dv2-page" : "space-y-5"}`}>
                {dashboardWorkspaceEnabled ? <DashboardHeader controls={workspaceControls} employees={employeesQuery.data || []} attention={workspace?.attention} updatedAt={data?.generatedAt} busy={isFetching} error={isError} refresh={() => void refetch()} onQuickView={(search) => { const employee = (employeesQuery.data || []).find((item) => item.employeeCode === search); if (employee) setQuickCode(employee.employeeCode); }} /> : <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/45">Admin Dashboard</p>
                        <h2 className="mt-1 text-2xl font-semibold text-white">Agent Lead Progress</h2>
                        <p className="mt-1 text-sm text-white/55">Live lead workload, movement, and productivity using PH time for today.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-white/55">
                            Updated {data?.generatedAt ? formatPhDateTime(data.generatedAt) : "loading"}
                        </span>
                        <button
                            className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white px-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-100 disabled:opacity-60"
                            type="button"
                            onClick={() => void refetch()}
                            disabled={isFetching}
                        >
                            <FiRefreshCw className={["size-4", isFetching ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
                            Refresh
                        </button>
                    </div>
                </div>}

                <div className="dashboard-summary-grid grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <KpiCard label="Active Agents" value={dashboardWorkspaceEnabled ? <DashboardMetric value={summary?.totalActiveAgents} /> : formatNumber(summary?.totalActiveAgents)} helper={`${formatNumber(summary?.onlineAgents)} online or available now`} icon={FiUsers} accent="green" detail={dashboardWorkspaceEnabled && <DashboardKpiDetail data={workspace} metric="totalActiveAgents" href="/admin/employees" />} />
                    <KpiCard label="Open Leads" value={dashboardWorkspaceEnabled ? <DashboardMetric value={summary?.totalOpenLeads} /> : formatNumber(summary?.totalOpenLeads)} helper={`${formatNumber(summary?.unassignedLeads)} still unassigned`} icon={FiTarget} accent="blue" detail={dashboardWorkspaceEnabled && <DashboardKpiDetail data={workspace} metric="totalOpenLeads" href="/admin/leads?scope=ALL" />} />
                    <KpiCard label="Due Follow-ups" value={dashboardWorkspaceEnabled ? <DashboardMetric value={summary?.dueFollowUps} /> : formatNumber(summary?.dueFollowUps)} helper={`${formatNumber(summary?.touchedLeadsToday)} leads touched today`} icon={FiClock} accent="orange" detail={dashboardWorkspaceEnabled && <DashboardKpiDetail data={workspace} metric="dueFollowUps" href="/admin/leads?scope=Follow%20up" />} />
                    <KpiCard label="Productivity Today" value={dashboardWorkspaceEnabled ? <DashboardMetric value={summary?.activityToday} /> : formatNumber(summary?.activityToday)} helper={`${formatNumber(summary?.commentsToday)} employee comments logged`} icon={FiTrendingUp} accent="purple" detail={dashboardWorkspaceEnabled && <DashboardKpiDetail data={workspace} metric="activityToday" href={`${location.pathname}${location.search}#dashboard-monthly-data`} />} />
                </div>

                <CallDashboardPanel businessId={activeBusinessId} businessName={activeBusinessName} />
                {dashboardWorkspaceEnabled && <DashboardAttention data={workspace} />}
                {dashboardWorkspaceEnabled && <div className="dw-view-bar"><div role="tablist" aria-label="Dashboard views">{dashboardViews.map((view) => <button key={view} id={`dashboard-tab-${view}`} role="tab" type="button" aria-selected={workspaceControls.view === view} aria-controls={`dashboard-view-${view}`} onClick={() => workspaceControls.setFilter("view", view)}
                    onKeyDown={(event) => { const index = dashboardViews.indexOf(view); const next = event.key === "ArrowRight" ? (index + 1) % dashboardViews.length : event.key === "ArrowLeft" ? (index + dashboardViews.length - 1) % dashboardViews.length : event.key === "Home" ? 0 : event.key === "End" ? dashboardViews.length - 1 : -1;
                        if (next >= 0) { event.preventDefault(); workspaceControls.setFilter("view", dashboardViews[next]); document.getElementById(`dashboard-tab-${dashboardViews[next]}`)?.focus(); } }} tabIndex={workspaceControls.view === view ? 0 : -1}>{dashboardViewLabels[view]}</button>)}</div></div>}
                {dashboardWorkspaceEnabled && workspaceControls.view === "calls" && <div role="tabpanel" id="dashboard-view-calls" aria-labelledby="dashboard-tab-calls">
                    <DashboardCallCounts key={activeBusinessId} rows={employeeCallRows} connected={totalLoggedLeadCalls} missed={totalNotConnectedCalls} voicemail={totalVoicemails} leads={totalCallLeadCount}
                        loading={leadCallStatsQuery.isLoading && !leadCallStatsQuery.data} error={leadCallStatsQuery.isError} retry={() => void leadCallStatsQuery.refetch()} select={setSelectedCallEmployeeRow} from={workspace?.range.from} to={workspace?.range.to} />
                </div>}
                {dashboardWorkspaceEnabled && workspaceControls.view === "attendance" && <div role="tabpanel" id="dashboard-view-attendance" aria-labelledby="dashboard-tab-attendance"><Suspense fallback={<p role="status">Loading attendance...</p>}><AttendanceHub key={activeBusinessId} admin embedded /></Suspense></div>}
                {dashboardWorkspaceEnabled && workspace && workspaceControls.view === "insights" && <div role="tabpanel" id="dashboard-view-insights" aria-labelledby="dashboard-tab-insights"><DashboardOperations key={activeBusinessId} data={workspace} refresh={() => void refetch()} /></div>}
                {dashboardWorkspaceEnabled && <DashboardCustomize order={customization.order} hidden={customization.hidden} data={workspace} update={(order, hidden) => { setCustomization({ order, hidden }); localStorage.setItem(`dashboard-sections:${getAuthUser()?.user.employeeCode}`, JSON.stringify({ order, hidden })); }} />}

                {isError && (
                    <section className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
                        <p className="font-semibold">Dashboard data could not load.</p>
                        <p className="mt-1 text-sm">{dashboardWorkspaceEnabled ? (isAxiosError<{ message: string }>(dashboardError) ? dashboardError.response?.data.message : "") || "Check the selected period and retry. Previously loaded data remains visible." : "Please refresh after the backend is running."}</p>
                    </section>
                )}

                <div style={{ display: "contents" }} role={dashboardWorkspaceEnabled && ["people", "performance", "activity"].includes(workspaceControls.view) ? "tabpanel" : undefined}
                    id={dashboardWorkspaceEnabled && ["people", "performance", "activity"].includes(workspaceControls.view) ? `dashboard-view-${workspaceControls.view}` : undefined}
                    aria-labelledby={dashboardWorkspaceEnabled ? `dashboard-tab-${workspaceControls.view}` : undefined}>
                <div className="legacy-dashboard-grid grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem] 2xl:grid-cols-[minmax(0,1fr)_20rem]">
                    <section {...sectionProps("Agent Productivity")} className="dashboard-panel-accent dashboard-accent-green overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-lg shadow-slate-950/10">
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 bg-slate-50 px-4 py-4">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Agent Productivity</p>
                                <h3 className="mt-1 text-base font-semibold">Lead progress by agent</h3>
                            </div>
                            <Link className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#842cff] px-3 text-sm font-semibold text-white transition hover:brightness-110" to="/admin/leads">
                                <FiTarget className="size-4" aria-hidden="true" />
                                Manage Leads
                            </Link>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[50rem] table-fixed border-separate border-spacing-0">
                                <colgroup>
                                    <col className="w-[35%]" />
                                    <col className="w-[9%]" />
                                    <col className="w-[8%]" />
                                    <col className="w-[13%]" />
                                    <col className="w-[9%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[14%]" />
                                </colgroup>
                                <thead className="bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
                                    <tr>
                                        <th className="px-3 py-3 text-left font-semibold">Agent</th>
                                        <th className="px-3 py-3 text-center font-semibold">Total</th>
                                        <th className="px-3 py-3 text-center font-semibold">NEW</th>
                                        <th className="px-3 py-3 text-center font-semibold">FOLLOW UP</th>
                                        <th className="px-3 py-3 text-center font-semibold">CALLS</th>
                                        <th className="px-3 py-3 text-center font-semibold">QUALIFIED</th>
                                        <th className="px-3 py-3 text-center font-semibold">ARCHIVE/DEAD</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-200">
                                    {isLoading && (
                                        <tr>
                                            <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={7}>Loading agent metrics...</td>
                                        </tr>
                                    )}
                                    {!isLoading && agents.length === 0 && (
                                        <tr>
                                            <td className="px-4 py-8" colSpan={7}>
                                                <EmptyPanel title="No agent lead data yet" message="Agents will appear here after they have lead assignments or lead activity." />
                                            </td>
                                        </tr>
                                    )}
                                    {visibleAgents.map((agent) => <AgentProgressRow key={agent.employeeId} agent={agent} />)}
                                    {!isLoading && visibleAgents.length > 0 && visibleAgents.length < agentRowsPerPage && Array.from({ length: agentRowsPerPage - visibleAgents.length }).map((_, index) => (
                                        <tr key={`agent-placeholder-${index}`} aria-hidden="true" className="pointer-events-none">
                                            <td className="h-[4.5rem] px-3 py-0" colSpan={7} />
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {!isLoading && agents.length > 0 && (
                            <div className="flex flex-col gap-3 border-t border-slate-300 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                                <p className="text-xs font-semibold text-slate-500">
                                    Showing {agentPageStart} to {agentPageEnd} of {formatNumber(agents.length)} agents
                                </p>
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
                                        onClick={() => setAgentPage((page) => Math.max(page - 1, 1))}
                                        disabled={currentAgentPage === 1}
                                        aria-label="Previous agent page"
                                    >
                                        <FiChevronLeft className="size-4" aria-hidden="true" />
                                    </button>
                                    {agentPageNumbers.map((page, index) => {
                                        const previousPage = agentPageNumbers[index - 1];
                                        const hasGap = previousPage && page - previousPage > 1;

                                        return (
                                            <span key={page} className="flex items-center gap-1">
                                                {hasGap && <span className="px-1 text-xs font-semibold text-slate-400">...</span>}
                                                <button
                                                    type="button"
                                                    className={[
                                                        "flex size-8 items-center justify-center rounded-lg border text-sm font-semibold transition",
                                                        currentAgentPage === page
                                                            ? "border-[#842cff] bg-[#842cff] text-white"
                                                            : "border-slate-300 bg-white text-slate-600 hover:border-[#842cff] hover:text-[#6426d9]",
                                                    ].join(" ")}
                                                    onClick={() => setAgentPage(page)}
                                                    aria-label={`Agent page ${page}`}
                                                    aria-current={currentAgentPage === page ? "page" : undefined}
                                                >
                                                    {page}
                                                </button>
                                            </span>
                                        );
                                    })}
                                    <button
                                        type="button"
                                        className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
                                        onClick={() => setAgentPage((page) => Math.min(page + 1, totalAgentPages))}
                                        disabled={currentAgentPage === totalAgentPages}
                                        aria-label="Next agent page"
                                    >
                                        <FiChevronRight className="size-4" aria-hidden="true" />
                                    </button>
                                </div>
                            </div>
                        )}
                        </section><section id="dashboard-monthly-data" {...sectionProps("Monthly Data")} className="dashboard-panel-accent dashboard-accent-indigo border-t border-slate-300 bg-slate-50/80 px-4 py-4">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Monthly Data</p>
                                    <h3 className="mt-1 text-base font-semibold text-slate-900">Agent activity for {monthlyRangeLabel}</h3>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-600">
                                        {formatNumber(monthlyTotals.touchedLeads)} touched · {formatNumber(monthlyTotals.calls)} calls · {formatNumber(monthlyTotals.comments)} comments
                                    </span>
                                    <button
                                        type="button"
                                        className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-55"
                                        onClick={handleExportMonthlyData}
                                        disabled={monthlyAgents.length === 0}
                                    >
                                        <FiDownload className="size-4" aria-hidden="true" />
                                        Export
                                    </button>
                                    <div data-global-picker={dashboardWorkspaceEnabled}
                                        className="relative"
                                        onBlur={(event) => {
                                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                                setIsMonthMenuOpen(false);
                                            }
                                        }}
                                    >
                                        <button
                                            type="button"
                                            className="flex h-10 min-w-[12rem] items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm font-semibold text-slate-800 shadow-sm transition hover:border-[#842cff] focus:outline-none focus:ring-2 focus:ring-[#842cff]/30"
                                            onClick={() => setIsMonthMenuOpen((isOpen) => !isOpen)}
                                            aria-haspopup="menu"
                                            aria-expanded={isMonthMenuOpen}
                                        >
                                            <span className="flex min-w-0 items-center gap-2">
                                                <FiCalendar className="size-4 shrink-0 text-[#842cff]" aria-hidden="true" />
                                                <span className="truncate">{formatMonthLabel(selectedMonth)}</span>
                                            </span>
                                            <FiChevronDown className={["size-4 shrink-0 text-slate-500 transition", isMonthMenuOpen ? "rotate-180" : ""].join(" ")} aria-hidden="true" />
                                        </button>
                                        {isMonthMenuOpen && (
                                            <div className="absolute right-0 z-20 mt-2 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-300 bg-white p-1 text-sm shadow-xl shadow-slate-950/15" role="menu">
                                                {monthOptions.map((month) => {
                                                    const isSelected = month === selectedMonth;

                                                    return (
                                                        <button
                                                            key={month}
                                                            type="button"
                                                            className={[
                                                                "flex w-full items-center justify-between rounded-md px-3 py-2 text-left font-semibold transition",
                                                                isSelected ? "bg-[#842cff] text-white" : "text-slate-700 hover:bg-violet-50 hover:text-[#6426d9]",
                                                            ].join(" ")}
                                                            onClick={() => {
                                                                setSelectedMonth(month);
                                                                setMonthlyPage(1);
                                                                setIsMonthMenuOpen(false);
                                                            }}
                                                            role="menuitemradio"
                                                            aria-checked={isSelected}
                                                        >
                                                            <span>{formatMonthLabel(month)}</span>
                                                            {isSelected && <span className="text-xs text-white/80">Selected</span>}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <div className="mt-4 overflow-x-auto rounded-lg border border-slate-300 bg-white">
                                <table className="w-full min-w-0 table-fixed border-separate border-spacing-0">
                                    <colgroup>
                                        <col className="w-[28%]" />
                                        <col className="w-[9%]" />
                                        <col className="w-[10%]" />
                                        <col className="w-[8%]" />
                                        <col className="w-[10%]" />
                                        <col className="w-[12%]" />
                                        <col className="w-[9%]" />
                                        <col className="w-[8%]" />
                                        <col className="w-[6%]" />
                                    </colgroup>
                                    <thead className="bg-white text-[0.62rem] uppercase tracking-[0.08em] text-slate-500">
                                        <tr>
                                            <th className="px-2 py-3 text-left font-semibold">Agent</th>
                                            <th className="px-2 py-3 text-center font-semibold">Added</th>
                                            <th className="px-2 py-3 text-center font-semibold">Follow Up</th>
                                            <th className="px-2 py-3 text-center font-semibold">Calls</th>
                                            <th className="px-2 py-3 text-center font-semibold">Qualified</th>
                                            <th className="px-2 py-3 text-center font-semibold">Archive/Dead</th>
                                            <th className="px-2 py-3 text-center font-semibold">Comments</th>
                                            <th className="px-2 py-3 text-center font-semibold">Touched</th>
                                            <th className="px-2 py-3 text-center font-semibold">Score</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-200">
                                        {isLoading && (
                                            <tr>
                                                <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={9}>Loading monthly metrics...</td>
                                            </tr>
                                        )}
                                        {!isLoading && monthlyAgents.length === 0 && (
                                            <tr>
                                                <td className="px-4 py-8" colSpan={9}>
                                                    <EmptyPanel title="No monthly data yet" message="Choose another month or wait for lead activity to appear here." />
                                                </td>
                                            </tr>
                                        )}
                                        {visibleMonthlyAgents.map((row) => (
                                            <MonthlyAgentRow key={row.employeeId} row={row} onQualifiedClick={setQualifiedLeadRow} />
                                        ))}
                                        {!isLoading && visibleMonthlyAgents.length > 0 && visibleMonthlyAgents.length < monthlyRowsPerPage && Array.from({ length: monthlyRowsPerPage - visibleMonthlyAgents.length }).map((_, index) => (
                                            <tr key={`monthly-placeholder-${index}`} aria-hidden="true" className="pointer-events-none">
                                                <td className="h-[4.5rem] px-3 py-0" colSpan={9} />
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                {!isLoading && monthlyAgents.length > 0 && (
                                    <div className="flex flex-col gap-3 border-t border-slate-300 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="text-xs font-semibold text-slate-500">
                                            Showing {monthlyPageStart} to {monthlyPageEnd} of {formatNumber(monthlyAgents.length)} monthly rows
                                        </p>
                                        <div className="flex items-center gap-1">
                                            <button
                                                type="button"
                                                className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
                                                onClick={() => setMonthlyPage((page) => Math.max(page - 1, 1))}
                                                disabled={currentMonthlyPage === 1}
                                                aria-label="Previous monthly data page"
                                            >
                                                <FiChevronLeft className="size-4" aria-hidden="true" />
                                            </button>
                                            {monthlyPageNumbers.map((page, index) => {
                                                const previousPage = monthlyPageNumbers[index - 1];
                                                const hasGap = previousPage && page - previousPage > 1;

                                                return (
                                                    <span key={page} className="flex items-center gap-1">
                                                        {hasGap && <span className="px-1 text-xs font-semibold text-slate-400">...</span>}
                                                        <button
                                                            type="button"
                                                            className={[
                                                                "flex size-8 items-center justify-center rounded-lg border text-sm font-semibold transition",
                                                                currentMonthlyPage === page
                                                                    ? "border-[#842cff] bg-[#842cff] text-white"
                                                                    : "border-slate-300 bg-white text-slate-600 hover:border-[#842cff] hover:text-[#6426d9]",
                                                            ].join(" ")}
                                                            onClick={() => setMonthlyPage(page)}
                                                            aria-label={`Monthly data page ${page}`}
                                                            aria-current={currentMonthlyPage === page ? "page" : undefined}
                                                        >
                                                            {page}
                                                        </button>
                                                    </span>
                                                );
                                            })}
                                            <button
                                                type="button"
                                                className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
                                                onClick={() => setMonthlyPage((page) => Math.min(page + 1, totalMonthlyPages))}
                                                disabled={currentMonthlyPage === totalMonthlyPages}
                                                aria-label="Next monthly data page"
                                            >
                                                <FiChevronRight className="size-4" aria-hidden="true" />
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        {!dashboardWorkspaceEnabled && <>{/* Call logger */}
                        <div className="flex flex-wrap items-center justify-between gap-3 border-t-6 border-slate-300 bg-slate-50 px-4 py-4">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                                    Log Call Counts
                                </p>

                                <h3 className="mt-1 text-base font-semibold text-slate-900">
                                    {leadCallStatsQuery.isLoading && !leadCallStatsQuery.data
                                        ? "Loading call data"
                                        : `${formatNumber(totalLoggedLeadCalls)} connected calls`}
                                </h3>

                                <p className="mt-1 text-xs font-semibold text-rose-600">
                                    {formatNumber(totalNotConnectedCalls)} not connected
                                </p>

                                <p className="mt-1 text-xs font-semibold text-blue-600">
                                    {formatNumber(totalVoicemails)} voicemails
                                </p>
                            </div>

                            <div data-global-picker={dashboardWorkspaceEnabled} className="flex flex-wrap items-center gap-3">
                                <label className="flex flex-col gap-1">
                                    <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
                                        From
                                    </span>

                                    <div className="flex gap-2">
                                        <input
                                            type="date"
                                            className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            value={callFilterDateFrom}
                                            onChange={(event) => setCallFilterDateFrom(event.target.value)}
                                        />

                                        <input
                                            type="time"
                                            className="h-9 w-28 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            value={callFilterTimeFrom}
                                            onChange={(event) => setCallFilterTimeFrom(event.target.value)}
                                        />
                                    </div>
                                </label>

                                <label className="flex flex-col gap-1">
                                    <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
                                        To
                                    </span>

                                    <div className="flex gap-2">
                                        <input
                                            type="date"
                                            className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            value={callFilterDateTo}
                                            onChange={(event) => setCallFilterDateTo(event.target.value)}
                                        />

                                        <input
                                            type="time"
                                            className="h-9 w-28 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            value={callFilterTimeTo}
                                            onChange={(event) => setCallFilterTimeTo(event.target.value)}
                                        />
                                    </div>
                                </label>
                                <button
                                    type="button"
                                    className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9]"
                                    onClick={() => {
                                        const shiftStart = getShiftStartDateFromTimestamp(new Date().toISOString());
                                        const shiftEnd = getShiftEndDate(shiftStart);

                                        setCallFilterDateFrom(formatDateInputValue(shiftStart));
                                        setCallFilterTimeFrom(formatTimeInputValue(shiftStart));
                                        setCallFilterDateTo(formatDateInputValue(shiftEnd));
                                        setCallFilterTimeTo(formatTimeInputValue(shiftEnd));
                                    }}
                                >
                                    Today
                                </button>
                                <button
                                    type="button"
                                    className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9]"
                                    onClick={() => {
                                        const today = new Date();
                                        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

                                        setCallFilterDateFrom(formatDateInputValue(firstDay));
                                        setCallFilterTimeFrom("00:00");
                                        setCallFilterDateTo(formatDateInputValue(today));
                                        setCallFilterTimeTo(formatTimeInputValue(today));
                                    }}
                                >
                                    This Month
                                </button>

                                <button
                                    type="button"
                                    className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-50"
                                    onClick={clearCallFilters}
                                    disabled={
                                        !callFilterDateFrom &&
                                        !callFilterTimeFrom &&
                                        !callFilterDateTo &&
                                        !callFilterTimeTo
                                    }
                                >
                                    Clear
                                </button>

                                <span className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
                                    {formatNumber(totalCallLeadCount)} lead
                                    {totalCallLeadCount === 1 ? "" : "s"}
                                </span>

                                <Link
                                    className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-[#842cff] px-3 text-sm font-semibold text-white transition hover:brightness-110"
                                    to="/admin/leads"
                                >
                                    <FiTarget className="size-4" aria-hidden="true" />
                                    Manage Leads
                                </Link>
                            </div>
                        </div>
                        <div className="flex w-full flex-col p-4 pt-0">
                            {leadCallStatsQuery.isLoading && !leadCallStatsQuery.data ? (
                                <div className="mt-4">
                                    <EmptyPanel
                                        title="Loading call counts"
                                        message="Getting logged calls from the call stats table."
                                    />
                                </div>
                            ) : employeeCallRows.length === 0 ? (
                                <div className="mt-4">
                                    <EmptyPanel
                                        title="No logged calls yet"
                                        message="Once an employee logs a call outcome, the lead call data will appear here."
                                    />
                                </div>
                            ) : (
                                <div className="mt-4 overflow-x-auto rounded-lg border border-slate-300 bg-white">
                                    <table className="w-full min-w-[54rem] table-fixed border-separate border-spacing-0">
                                        <colgroup>
                                            <col className="w-[25%]" />
                                            <col className="w-[12%]" />
                                            <col className="w-[15%]" />
                                            <col className="w-[14%]" />
                                            <col className="w-[12%]" />
                                            <col className="w-[22%]" />
                                        </colgroup>

                                        <thead className="bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
                                            <tr>
                                                <th className="px-3 py-3 text-left font-semibold">Employee</th>
                                                <th className="px-3 py-3 text-center font-semibold">Connected</th>
                                                <th className="px-3 py-3 text-center font-semibold">Not Connected</th>
                                                <th className="px-3 py-3 text-center font-semibold">Voicemails</th>
                                                <th className="px-3 py-3 text-center font-semibold">Leads</th>
                                                <th className="px-3 py-3 text-left font-semibold">Last Call</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-200">
                                            {employeeCallRows.map((row) => (
                                                <tr
                                                    key={row.employeeId}
                                                    className="text-sm text-slate-700 transition hover:bg-emerald-50/60"
                                                >
                                                    <td className="px-3 py-3">
                                                        <p className="truncate font-semibold text-slate-800">
                                                            {row.employeeName || "No employee"}
                                                        </p>

                                                        {(row.employeeRole || row.employeeTeam || row.crmBusinessName) && (
                                                            <p className="mt-0.5 truncate text-xs text-slate-500">
                                                                {[row.employeeRole, row.employeeTeam, row.crmBusinessName]
                                                                    .filter(Boolean)
                                                                    .join(" · ")}
                                                            </p>
                                                        )}
                                                    </td>
                                                    <td className="px-3 py-3 text-center font-semibold text-slate-950">
                                                        <button
                                                            type="button"
                                                            className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                                                            onClick={() => setSelectedCallEmployeeRow(row)}
                                                        >
                                                            {formatNumber(row.totalCalls)}
                                                        </button>
                                                    </td>
                                                    <td className="px-3 py-3 text-center font-semibold text-rose-600">
                                                        <button
                                                            type="button"
                                                            className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                                                            onClick={() => setSelectedCallEmployeeRow(row)}
                                                        >
                                                            {formatNumber(row.totalNotConnectedCalls)}
                                                        </button>
                                                    </td>

                                                    <td className="px-3 py-3 text-center font-semibold text-blue-600">
                                                        <button
                                                            type="button"
                                                            className="inline-flex h-8 items-center justify-center rounded-md border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 transition hover:border-blue-400 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-300"
                                                            onClick={() => setSelectedCallEmployeeRow(row)}
                                                        >
                                                            {formatNumber(row.totalVoicemails)}
                                                        </button>
                                                    </td>
                                                    <td className="px-3 py-3 text-center font-semibold text-slate-950">
                                                        {formatNumber(row.leads.length)}
                                                    </td>
                                                    <td className="px-3 py-3 text-sm text-slate-600">
                                                        {row.lastCallAt ? formatPhDateTime(row.lastCallAt) : "No date"}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                        </>}</section><section {...sectionProps("Employee Attendance")} className={dashboardWorkspaceEnabled ? "bg-white p-4" : "hidden"} aria-hidden={!dashboardWorkspaceEnabled}>
                            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-slate-300 bg-white p-4 sm:flex-row sm:items-end sm:justify-between">
                                <div>
                                    <p className="text-xl font-semibold uppercase tracking-[0.14em] text-slate-800">Employee Attendance</p>
                                    <p className="mt-1 text-xs text-slate-500">Choose an employee to view 11PM to 8AM shift rows, late, undertime, and over-break details.</p>
                                </div>

                                <div className="grid w-full gap-3 sm:w-[42rem] sm:grid-cols-[13rem_minmax(0,1fr)]">
                                    <label className="min-w-0">
                                        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">Department</span>
                                        <select
                                            className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition hover:border-[#842cff] focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20 disabled:cursor-not-allowed disabled:opacity-60"
                                            value={selectedAttendanceDepartment}
                                            onChange={(event) => {
                                                setSelectedAttendanceDepartment(event.target.value);
                                                setSelectedAttendanceEmployeeId("");
                                                setIsAttendanceSelectionCleared(true);
                                                setAttendanceEmployeeSearch("");
                                                setIsAttendanceEmployeeMenuOpen(false);
                                            }}
                                            disabled={attendanceEmployeeOptions.length === 0}
                                        >
                                            <option value="all">All departments</option>
                                            {attendanceDepartmentOptions.map((department) => (
                                                <option key={department} value={department}>
                                                    {department}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <div className="min-w-0">
                                    <div
                                        className="relative"
                                        onBlur={(event) => {
                                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                                setIsAttendanceEmployeeMenuOpen(false);
                                            }
                                        }}
                                    >
                                        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">Employee</span>
                                        <div className="mt-1 flex gap-2">
                                            <button
                                                type="button"
                                                className="flex h-10 min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm font-semibold text-slate-800 outline-none transition hover:border-[#842cff] focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                onClick={() => setIsAttendanceEmployeeMenuOpen((isOpen) => !isOpen)}
                                                disabled={departmentFilteredAttendanceEmployeeOptions.length === 0}
                                                aria-haspopup="listbox"
                                                aria-expanded={isAttendanceEmployeeMenuOpen}
                                            >
                                                <span className="truncate">{departmentFilteredAttendanceEmployeeOptions.length === 0 ? "No employees found" : selectedAttendanceEmployeeLabel}</span>
                                                <FiChevronDown className={["size-4 shrink-0 text-slate-500 transition", isAttendanceEmployeeMenuOpen ? "rotate-180" : ""].join(" ")} aria-hidden="true" />
                                            </button>
                                            <button
                                                type="button"
                                                className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                                                onClick={() => {
                                                    setSelectedAttendanceEmployeeId("");
                                                    setIsAttendanceSelectionCleared(true);
                                                    setAttendanceEmployeeSearch("");
                                                    setIsAttendanceEmployeeMenuOpen(false);
                                                }}
                                                disabled={!effectiveAttendanceEmployeeId && !attendanceEmployeeSearch}
                                            >
                                                Clear
                                            </button>
                                        </div>

                                        {isAttendanceEmployeeMenuOpen && (
                                            <div className="absolute right-0 z-30 mt-2 w-full overflow-hidden rounded-lg border border-slate-300 bg-white shadow-xl shadow-slate-950/15">
                                                <div className="border-b border-slate-200 bg-slate-50 p-2">
                                                    <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                                                        <FiSearch className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
                                                        <input
                                                            type="search"
                                                            className="h-10 min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-800 outline-none placeholder:text-slate-400"
                                                            placeholder="Search employee name or code"
                                                            value={attendanceEmployeeSearch}
                                                            onChange={(event) => setAttendanceEmployeeSearch(event.target.value)}
                                                            autoFocus
                                                        />
                                                    </div>
                                                </div>
                                                <div className="content-scroll max-h-72 overflow-y-auto p-1" role="listbox">
                                                    {filteredAttendanceEmployeeOptions.length === 0 ? (
                                                        <p className="px-3 py-4 text-center text-sm font-semibold text-slate-500">No matching employee found.</p>
                                                    ) : (
                                                        filteredAttendanceEmployeeOptions.map((employee) => {
                                                            const isSelected = employee._id === effectiveAttendanceEmployeeId;

                                                            return (
                                                                <button
                                                                    key={employee._id}
                                                                    type="button"
                                                                    className={[
                                                                        "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition",
                                                                        isSelected ? "bg-[#842cff] text-white" : "text-slate-700 hover:bg-violet-50 hover:text-[#6426d9]",
                                                                    ].join(" ")}
                                                                    onMouseDown={(event) => event.preventDefault()}
                                                                    onClick={() => {
                                                                        setSelectedAttendanceEmployeeId(employee._id);
                                                                        setIsAttendanceSelectionCleared(false);
                                                                        setAttendanceEmployeeSearch("");
                                                                        setIsAttendanceEmployeeMenuOpen(false);
                                                                    }}
                                                                    role="option"
                                                                    aria-selected={isSelected}
                                                                >
                                                                    <span className="min-w-0">
                                                                        <span className="block truncate font-semibold">{employee.name || employee.employeeCode || "Employee"}</span>
                                                                        <span className={["mt-0.5 block truncate text-xs", isSelected ? "text-white/75" : "text-slate-500"].join(" ")}>{employee.role || "Employee"} · {employee.team || "Unassigned"}</span>
                                                                    </span>
                                                                    {isSelected && <FiCheckCircle className="size-4 shrink-0" aria-hidden="true" />}
                                                                </button>
                                                            );
                                                        })
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    </div>
                                </div>
                            </div>

                            {employeesQuery.isLoading || attendanceRecordsQuery.isLoading || isAllAttendanceLoading ? (
                                <EmptyPanel title="Loading attendance" message="Getting employee attendance records for the selected employee." />
                            ) : selectedAttendanceEmployee ? (
                                <AttendancePanel employee={selectedAttendanceEmployee} attendance={selectedAttendanceRecords} selectedAttendanceDate={attendanceSelectedShiftDate} attendanceDateFrom={attendanceDateFrom} attendanceDateTo={attendanceDateTo} onSelectedAttendanceDateChange={setAttendanceSelectedShiftDate} onAttendanceDateFromChange={setAttendanceDateFrom} onAttendanceDateToChange={setAttendanceDateTo} />
                            ) : (
                                <AttendancePanel employee={null} attendance={[]} attendanceGroups={allAttendanceGroups} selectedAttendanceDate={attendanceSelectedShiftDate} attendanceDateFrom={attendanceDateFrom} attendanceDateTo={attendanceDateTo} onSelectedAttendanceDateChange={setAttendanceSelectedShiftDate} onAttendanceDateFromChange={setAttendanceDateFrom} onAttendanceDateToChange={setAttendanceDateTo} />
                            )}
                    </section>

                    <div className="space-y-4">
                        <section {...sectionProps("Lead Status")} className="dashboard-panel-accent dashboard-accent-blue rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Lead Status</p>
                                    <h3 className="mt-1 text-base font-semibold">Current total: {formatNumber(pipelineTotals.total)}</h3>
                                </div>
                                <FiBarChart2 className="size-5 text-[#842cff]" aria-hidden="true" />
                            </div>
                            <div className="mt-4 space-y-3">
                                {pipelineBars.map((item) => (
                                    <div key={item.label}>
                                        <div className="flex justify-between gap-3 text-sm">
                                            <span className="font-semibold text-slate-700">{item.label}</span>
                                            <span className="text-slate-500">{formatNumber(item.value)}</span>
                                        </div>
                                        <div className="mt-2 h-2 rounded-full bg-slate-200">
                                            <div className={`h-full rounded-full ${item.color}`} style={{ width: `${Math.max((item.value / maxPipelineValue) * 100, item.value > 0 ? 5 : 0)}%` }} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>

                        <section {...sectionProps("Online Status")} className="dashboard-panel-accent dashboard-accent-teal rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Online Status</p>
                                    <h3 className="mt-1 text-base font-semibold">{formatNumber(availableAgentCount)} available now</h3>
                                </div>
                                <FiActivity className="size-5 text-emerald-500" aria-hidden="true" />
                            </div>
                            <div className="content-scroll mt-4 max-h-[19rem] space-y-3 overflow-y-auto pr-1">
                                {onlineStatusAgents.length === 0 && <EmptyPanel title="No employees yet" message="Employee availability will show here once employees are added." />}
                                {onlineStatusAgents.map((agent) => (
                                    <div key={agent.employeeId} className="rounded-lg border border-slate-300 bg-slate-50 p-3">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex min-w-0 items-start gap-2">
                                                {!dashboardWorkspaceEnabled && <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${availabilityDotClass(agent.availabilityStatus)}`} />}
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-semibold text-slate-950"><DashboardEmployeeName id={agent.employeeId} name={agent.employeeName} /></p>
                                                    <p className="mt-1 truncate text-xs text-slate-500">{[agent.role, agent.team, agent.businessName].filter(Boolean).join(" · ")}</p>
                                                    <p className="mt-1 text-xs text-slate-500">{formatNumber(agent.assignedLeads)} active leads</p>
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                className={dashboardWorkspaceEnabled ? "shrink-0 focus:outline-none focus:ring-2 focus:ring-violet-500" : `shrink-0 rounded-md border px-2 py-1 text-xs font-semibold transition hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-[#842cff]/30 ${availabilityClass(agent.availabilityStatus)}`}
                                                onClick={() => openEmployeeAttendance(agent.employeeId)}
                                                aria-label={`View ${agent.employeeName}'s attendance`}
                                                title="View employee attendance"
                                            >
                                                {dashboardWorkspaceEnabled ? <AvailabilityBadge status={agent.availabilityStatus} /> : normalizeEmployeeAvailabilityStatus(agent.availabilityStatus)}
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>

                        <section id="agent-calls" {...sectionProps("Agent Calls")} className="dashboard-panel-accent dashboard-accent-teal rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Agent Calls</p>
                                    <h3 className="mt-2 text-2xl font-semibold">{formatNumber(selectedCallCount)}</h3>
                                    <p className="mt-1 text-sm leading-5 text-slate-600">{selectedCallHelper}</p>
                                </div>
                                <span className="dashboard-accent-icon flex size-10 shrink-0 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-[#10ac84]">
                                    <FiPhoneCall className="size-5" aria-hidden="true" />
                                </span>
                            </div>
                            <div className="mt-4 space-y-2">
                                <label className="block text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-employee">
                                    Employee
                                </label>
                                <div className="relative">
                                    <select
                                        id="agent-call-employee"
                                        className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-9 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
                                        value={selectedCallEmployeeId}
                                        onChange={(event) => setSelectedCallEmployeeId(event.target.value)}
                                    >
                                        <option value="all">All employees</option>
                                        {callEmployeeOptions.map((employee) => (
                                            <option key={employee.id} value={employee.id}>
                                                {employee.name}
                                            </option>
                                        ))}
                                    </select>
                                    <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                                </div>

                                <div data-global-picker={dashboardWorkspaceEnabled}>
                                <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-range">
                                    Period
                                </label>
                                <div className="relative">
                                    <select
                                        id="agent-call-range"
                                        className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-9 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
                                        value={callCountRange}
                                        onChange={(event) => setCallCountRange(event.target.value as CallCountRange)}
                                    >
                                        <option value="day">Day</option>
                                        <option value="month">Month</option>
                                    </select>
                                    <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                                </div>

                                {callCountRange === "day" ? (
                                    <>
                                        <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-date">
                                            Date
                                        </label>
                                        <input
                                            id="agent-call-date"
                                            className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
                                            type="date"
                                            value={selectedCallDate}
                                            onChange={(event) => setSelectedCallDate(event.target.value)}
                                        />
                                    </>
                                ) : (
                                    <>
                                        <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-month">
                                            Month
                                        </label>
                                        <input
                                            id="agent-call-month"
                                            className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
                                            type="month"
                                            value={selectedMonth}
                                            onChange={(event) => {
                                                setSelectedMonth(event.target.value);
                                                setMonthlyPage(1);
                                                setIsMonthMenuOpen(false);
                                            }}
                                        />
                                    </>
                                )}
                                </div>
                            </div>
                        </section>
                    </div>
                </div>

                <div className="legacy-dashboard-grid grid gap-5 xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
                    <section {...sectionProps("Top Agents")} className="dashboard-panel-accent dashboard-accent-purple rounded-lg border border-slate-300 bg-white p-4 text-slate-950 shadow-lg shadow-slate-950/10">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Top Agents</p>
                                <h3 className="mt-1 text-base font-semibold">Today by productivity score</h3>
                            </div>
                            <FiUserCheck className="size-5 text-[#842cff]" aria-hidden="true" />
                        </div>
                        <div className="mt-4 space-y-3">
                            {topAgents.length === 0 && <EmptyPanel title="No activity today" message="Lead touches and comments will rank agents here." />}
                            {topAgents.map((agent, index) => {
                                const maxScore = Math.max(topAgents[0]?.productivityScore || 1, 1);
                                return (
                                    <div key={agent.employeeId} className="grid grid-cols-[2rem_minmax(0,1fr)_3rem] items-center gap-3">
                                        <span className="text-xs font-semibold text-slate-400">#{index + 1}</span>
                                        <div className="min-w-0">
                                            <div className="flex justify-between gap-3">
                                                <p className="truncate text-sm font-semibold text-slate-950"><DashboardEmployeeName id={agent.employeeId} name={agent.employeeName} /></p>
                                                <p className="text-sm font-semibold text-slate-600">{formatNumber(agent.productivityScore)}</p>
                                            </div>
                                            <div className="mt-2 h-2 rounded-full bg-slate-200">
                                                <div className="h-full rounded-full bg-[#842cff]" style={{ width: `${Math.max((agent.productivityScore / maxScore) * 100, 5)}%` }} />
                                            </div>
                                        </div>
                                        <span className="text-right text-xs text-slate-400">pts</span>
                                    </div>
                                );
                            })}
                        </div>
                    </section>

                    <section {...sectionProps("Recent Lead Activity")} className="dashboard-panel-accent dashboard-accent-indigo rounded-lg border border-slate-300 bg-white p-4 text-slate-950 shadow-lg shadow-slate-950/10">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Recent Lead Activity</p>
                                <h3 className="mt-1 text-base font-semibold">Latest employee actions</h3>
                            </div>
                            <div className="flex items-center gap-2 text-slate-500">
                                <FiMessageSquare className="size-5" aria-hidden="true" />
                                <FiActivity className="size-5" aria-hidden="true" />
                                <FiCheckCircle className="size-5" aria-hidden="true" />
                            </div>
                        </div>
                        <div className="mt-4 grid gap-3 lg:grid-cols-2">
                            {(data?.recentActivity || []).length === 0 && <EmptyPanel title="No recent lead actions" message="Employee comments, status updates, and scheduled follow-ups will appear here." />}
                            {(data?.recentActivity || []).map((item) => <ActivityItem key={item.id} item={item} onOpen={setSelectedActivity} />)}
                        </div>
                    </section>
                </div>
                </div>
            </section>

            {selectedActivity && (
                <LeadHistoryModal
                    activity={selectedActivity}
                    lead={leadHistoryQuery.data}
                    history={leadHistory}
                    isLoading={leadHistoryQuery.isLoading || leadHistoryQuery.isFetching}
                    isError={leadHistoryQuery.isError}
                    onClose={() => setSelectedActivity(null)}
                />
            )}
            {dashboardWorkspaceEnabled && quickCode && <DashboardQuickView code={quickCode} filters={workspaceControls.filters} data={workspace} close={() => setQuickCode("")} />}
            {qualifiedLeadRow && (
                <QualifiedLeadsModal row={qualifiedLeadRow} onClose={() => setQualifiedLeadRow(null)} />
            )}

            {selectedCallEmployeeRow && (
                <EmployeeLeadCallsModal
                    row={selectedCallEmployeeRow}
                    onClose={() => setSelectedCallEmployeeRow(null)}
                />
            )}
            </EmployeeQuickViewProvider>
        </AdminLayout>
    );
}
