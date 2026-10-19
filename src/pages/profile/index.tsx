import { Fragment, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { FiBell, FiBriefcase, FiCalendar, FiCamera, FiCheck, FiCheckCircle, FiChevronDown, FiChevronLeft, FiChevronRight, FiClock, FiEdit2, FiMail, FiMapPin, FiPhone, FiRefreshCw, FiSave, FiShield, FiTrendingUp, FiX } from "react-icons/fi";
import { getAuthUser, setAuthUser as setStoredAuthUser } from "../../api/authStorage";
import { getEmployee, updateEmployeeProfile, type ContactRelationships, type EmployeeProfileInput } from "../../api/employees";
import { getEmployeeRecentActivity } from "../../api/employeeTransactions";
import {
    createEmployeeLeaveRequest,
    getEmployeeLeaveRequests,
    leaveRequestTypes,
    replyToEmployeeLeaveRequest,
    updateEmployeeLeaveRequest,
    type LeaveRequest,
    type LeaveRequestInput,
} from "../../api/leaveRequests";
import { acknowledgeEmployeeNotice, getEmployeeNotices, markEmployeeNoticeRead, markEmployeeNoticesRead, replyToEmployeeNotice } from "../../api/notices";
import { formatPhDate, formatPhDateTime } from "../../lib/dateTime";
import MainLayout from "../layout";
import { profileUpgradeEnabled } from "../../lib/workspaceRollout";
import { profileCompleteness, profileActivityDay, tenureLabel } from "../../lib/profilePresentation";
import { BankAccountInput, ProfileContactActions, ProfileFieldGroup, ProfileMobileNavigation } from "../../components/ProfileEnhancements";
import AvailabilityBadge from "../../components/AvailabilityBadge";
import MetricValue from "../../components/MetricValue";
import "./profileUpgrade.css";

const emptyProfileForm: EmployeeProfileInput = {
    personalPhone: "",
    personalEmail: "",
    personalAddress: "",
    emergencyContact: "",
    contactRelationship: "Father",
    emergencyContactNumber: "",
    personalNotes: "",
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
    profileImage: "",
};

function profileFormFromEmployee(employee?: Partial<EmployeeProfileInput> | null): EmployeeProfileInput {
    return {
        personalPhone: employee?.personalPhone || "",
        personalEmail: employee?.personalEmail || "",
        personalAddress: employee?.personalAddress || "",
        emergencyContact: employee?.emergencyContact || "",
        contactRelationship: employee?.contactRelationship || "Father",
        emergencyContactNumber: employee?.emergencyContactNumber || "",
        personalNotes: employee?.personalNotes || "",
        bankName: employee?.bankName || "",
        bankAccountName: employee?.bankAccountName || "",
        bankAccountNumber: employee?.bankAccountNumber || "",
        profileImage: employee?.profileImage || "",
    };
}

function getCurrentPhDateInput() {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    return `${values.year}-${values.month}-${values.day}`;
}

function getPhDateInput(value: string) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return getCurrentPhDateInput();
    }

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    return `${values.year}-${values.month}-${values.day}`;
}

function parseDateKey(dateKey: string) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}

function toDateKey(date: Date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function addDays(dateKey: string, days: number) {
    const date = parseDateKey(dateKey);
    date.setUTCDate(date.getUTCDate() + days);
    return toDateKey(date);
}

function normalizeSelectedDateKeys(dateKeys: string[]) {
    return Array.from(new Set(dateKeys.filter((dateKey) => /^\d{4}-\d{2}-\d{2}$/.test(dateKey)))).sort((first, second) =>
        first.localeCompare(second)
    );
}

function getDateKeysBetween(startDate: string, endDate: string) {
    if (!startDate || !endDate) return [];
    const start = startDate <= endDate ? startDate : endDate;
    const end = startDate <= endDate ? endDate : startDate;
    const dateKeys: string[] = [];
    let cursor = start;

    while (cursor <= end) {
        dateKeys.push(cursor);
        cursor = addDays(cursor, 1);
    }

    return dateKeys;
}

function getLeaveRequestSelectedDateKeys(leaveRequest: LeaveRequest) {
    const explicitDates = normalizeSelectedDateKeys((leaveRequest.selectedDates || []).map(getPhDateInput));

    if (explicitDates.length > 0) {
        return explicitDates;
    }

    return getDateKeysBetween(getPhDateInput(leaveRequest.startDate), getPhDateInput(leaveRequest.endDate));
}

function formatLeaveRequestDates(leaveRequest: LeaveRequest) {
    const selectedDates = getLeaveRequestSelectedDateKeys(leaveRequest);

    if (selectedDates.length === 0) {
        return `${formatPhDate(leaveRequest.startDate)} - ${formatPhDate(leaveRequest.endDate)}`;
    }

    if (selectedDates.length === 1) {
        return formatDateKey(selectedDates[0]);
    }

    return `${selectedDates.length} dates · ${formatDateKey(selectedDates[0])} - ${formatDateKey(selectedDates[selectedDates.length - 1])}`;
}

function getCalendarDays(monthKey: string) {
    const [year, month] = monthKey.split("-").map(Number);
    const firstDay = new Date(Date.UTC(year, month - 1, 1));
    const gridStart = new Date(firstDay);
    gridStart.setUTCDate(firstDay.getUTCDate() - firstDay.getUTCDay());

    return Array.from({ length: 42 }, (_, index) => {
        const date = new Date(gridStart);
        date.setUTCDate(gridStart.getUTCDate() + index);
        return {
            dateKey: toDateKey(date),
            day: date.getUTCDate(),
            isCurrentMonth: date.getUTCMonth() === month - 1,
        };
    });
}

function getMonthLabel(monthKey: string) {
    const [year, month] = monthKey.split("-").map(Number);

    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(Date.UTC(year, month - 1, 1))
    );
}

function shiftMonth(monthKey: string, offset: number) {
    const [year, month] = monthKey.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1 + offset, 1));
    return toDateKey(date).slice(0, 7);
}

function formatDateKey(dateKey: string) {
    return formatPhDate(`${dateKey}T00:00:00+08:00`);
}

function leaveStatusClass(status: string) {
    if (status === "Approved") return "border-emerald-300 bg-emerald-50 text-emerald-700";
    if (status === "Rejected") return "border-rose-300 bg-rose-50 text-rose-700";
    return "border-amber-300 bg-amber-50 text-amber-700";
}

function getLeaveRequestThread(leaveRequest: LeaveRequest) {
    const comments = [...(leaveRequest.comments || [])].sort(
        (first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime()
    );

    if (leaveRequest.status === "Pending" && leaveRequest.adminNote) {
        const hasSameComment = comments.some((comment) => comment.authorType === "Admin" && comment.message === leaveRequest.adminNote);

        if (!hasSameComment) {
            return [
                {
                    _id: `${leaveRequest._id}-legacy-admin-note`,
                    authorType: "Admin" as const,
                    authorName: leaveRequest.reviewedBy || "Admin",
                    message: leaveRequest.adminNote,
                    createdAt: leaveRequest.reviewedAt || leaveRequest.updatedAt || leaveRequest.createdAt,
                },
                ...comments,
            ];
        }
    }

    return comments;
}

const emptyLeaveForm: LeaveRequestInput = {
    leaveType: "Vacation",
    startDate: getCurrentPhDateInput(),
    endDate: getCurrentPhDateInput(),
    selectedDates: [getCurrentPhDateInput()],
    reason: "",
};

type CustomDropdownProps = {
    buttonRef: React.RefObject<HTMLButtonElement | null>;
    label: string;
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    onOpen: () => void;
};

function CustomDropdown({
    label,
    value,
    placeholder = "Select",
    disabled = false,
    onOpen,
    buttonRef,
}: CustomDropdownProps) {
    return (
        <div className="relative">
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{label}</span>
            <button
                ref={buttonRef}
                className={[
                    "flex h-11 w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 text-left text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20",
                    disabled ? "cursor-not-allowed opacity-60" : "hover:bg-white/[0.04]",
                ].join(" ")}
                type="button"
                disabled={disabled}
                onClick={onOpen}
            >
                <span className={value ? "text-white" : "text-white/35"}>{value || placeholder}</span>
                <FiChevronDown className="size-4 shrink-0 text-white/45" aria-hidden="true" />
            </button>
        </div>
    );
}

export default function Profile() {
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();
    const [authUser, setAuthUser] = useState(() => getAuthUser());
    const employee = authUser?.userType === "employee" ? authUser.user : null;
    const employeeId = employee?._id || "";
    const [activeProfileTab, setActiveProfileTab] = useState<"overview" | "notices" | "leave">("overview");
    const [profileForm, setProfileForm] = useState<EmployeeProfileInput>(emptyProfileForm);
    const [isProfileEditing, setIsProfileEditing] = useState(false);
    const [profileSuccessMessage, setProfileSuccessMessage] = useState("");
    const [profileErrorMessage, setProfileErrorMessage] = useState("");
    const [leaveForm, setLeaveForm] = useState<LeaveRequestInput>(emptyLeaveForm);
    const [selectedLeaveDates, setSelectedLeaveDates] = useState<string[]>(() => [getCurrentPhDateInput()]);
    const [leaveCalendarMonth, setLeaveCalendarMonth] = useState(() => getCurrentPhDateInput().slice(0, 7));
    const [editingLeaveRequestId, setEditingLeaveRequestId] = useState("");
    const [noticeReplies, setNoticeReplies] = useState<Record<string, string>>({});
    const [leaveReplies, setLeaveReplies] = useState<Record<string, string>>({});
    const [openDropdown, setOpenDropdown] = useState<"contactRelationship" | null>(null);
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
    const statusButtonRel = useRef<HTMLButtonElement>(null);
    const dropdownMenuRef = useRef<HTMLDivElement>(null);
    const profileImageInputRef = useRef<HTMLInputElement>(null);
    const profileDetailsRef = useRef<HTMLElement>(null);
    const selectProfileTab = (tab: "overview" | "notices" | "leave") => {
        setActiveProfileTab(tab);
        setSearchParams((previous) => { const next = new URLSearchParams(previous); next.set("tab", tab); if (tab !== "notices") next.delete("notice"); return next; });
    };
    const requestedProfileTab = searchParams.get("tab");
    const highlightedNoticeId = searchParams.get("notice") || "";
    const { data: employeeProfile, isPending: profileLoading, isError: profileLoadError } = useQuery({
        queryKey: ["employee-profile", employeeId],
        queryFn: () => getEmployee(employeeId),
        enabled: Boolean(employeeId),
    });
    const currentEmployee = employeeProfile || employee;
    useEffect(() => {
        if (!isProfileEditing || JSON.stringify(profileForm) === JSON.stringify(profileFormFromEmployee(currentEmployee))) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [isProfileEditing, profileForm, currentEmployee]);
    const recentActivityQuery = useInfiniteQuery({
        queryKey: ["employee-recent-activity", employeeId],
        queryFn: ({ pageParam }) => getEmployeeRecentActivity(employeeId, pageParam, 10),
        initialPageParam: 0,
        getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
        enabled: Boolean(employeeId && activeProfileTab === "overview"),
        staleTime: 60_000,
    });
    const recentActivities = recentActivityQuery.data?.pages.flatMap((page) => page.items) || [];
    const profileMetrics = recentActivityQuery.data?.pages[0]?.metrics;
    const profileStats = [
        ["Active Leads", profileMetrics?.activeLeads ?? "-", "Currently assigned"],
        ["Closed Deals", profileMetrics?.closedDeals ?? "-", "Completed leads"],
        ["Call Attempts", profileMetrics?.callAttempts ?? "-", "Recorded calls"],
    ];
    const name = currentEmployee?.name || authUser?.user.name || "Admin";
    const role = currentEmployee?.role || "Not provided";
    const team = currentEmployee?.team || "Not provided";
    const email = currentEmployee?.email || "Not provided";
    const phone = currentEmployee?.phone || "Not provided";
    const employeeCode = currentEmployee?.employeeCode || "Not assigned";
    const employmentStatus = currentEmployee?.status || "Not provided";
    const profileImageValue = currentEmployee?.profileImage || "";
    const initials = name
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
    const noticesQueryKey = ["employee-notices", employeeId];
    const { data: notices = EMPTY_QUERY_ROWS, isLoading: noticesLoading, isError: noticesError } = useQuery({
        queryKey: noticesQueryKey,
        queryFn: () => getEmployeeNotices(employeeId),
        enabled: Boolean(employeeId),
    });
    const leaveRequestsQueryKey = ["employee-leave-requests", employeeId];
    const { data: leaveRequests = EMPTY_QUERY_ROWS, isLoading: leaveRequestsLoading, isError: leaveRequestsError } = useQuery({
        queryKey: leaveRequestsQueryKey,
        queryFn: () => getEmployeeLeaveRequests(employeeId),
        enabled: Boolean(employeeId),
    });
    const unreadNoticeCount = notices.filter((notice) => !notice.isRead).length;
    const pendingLeaveCount = leaveRequests.filter((leaveRequest) => leaveRequest.status === "Pending").length;
    const markNoticeReadMutation = useMutation({
        mutationFn: (noticeId: string) => markEmployeeNoticeRead(employeeId, noticeId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: noticesQueryKey }),
    });
    const markAllNoticesReadMutation = useMutation({
        mutationFn: () => markEmployeeNoticesRead(employeeId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: noticesQueryKey }),
    });
    const acknowledgeNoticeMutation = useMutation({
        mutationFn: (noticeId: string) => acknowledgeEmployeeNotice(employeeId, noticeId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: noticesQueryKey }),
    });
    const replyNoticeMutation = useMutation({
        mutationFn: ({ noticeId, message }: { noticeId: string; message: string }) => replyToEmployeeNotice(employeeId, noticeId, message),
        onSuccess: (_notice, variables) => {
            setNoticeReplies((current) => ({ ...current, [variables.noticeId]: "" }));
            queryClient.invalidateQueries({ queryKey: noticesQueryKey });
        },
    });
    const updateProfileMutation = useMutation({
        mutationFn: (payload: EmployeeProfileInput) => updateEmployeeProfile(employeeId, payload),
        onSuccess: (response) => {
            const updatedEmployee = response.employee;
            queryClient.setQueryData(["employee-profile", employeeId], updatedEmployee);
            queryClient.setQueryData(["employee", employeeId], updatedEmployee);
            queryClient.setQueryData(["employee-summary", employeeId], updatedEmployee);
            queryClient.invalidateQueries({ queryKey: ["employees"] });
            queryClient.invalidateQueries({ queryKey: ["employees", "summary"] });
            queryClient.invalidateQueries({ queryKey: ["employee-dashboard-profile", employeeId] });
            if (authUser?.userType === "employee") {
                const updatedAuthUser = { ...authUser, user: { ...authUser.user, ...updatedEmployee } };
                setStoredAuthUser(updatedAuthUser);
                setAuthUser(updatedAuthUser);
            }
            setProfileSuccessMessage(response.message);
            setProfileErrorMessage("");
            setIsProfileEditing(false);
            setOpenDropdown(null);
        },
        onError: () => setProfileErrorMessage("Unable to save profile details. Please try again."),
    });
    const createLeaveRequestMutation = useMutation({
        mutationFn: () => createEmployeeLeaveRequest(employeeId, { ...leaveForm, selectedDates: selectedLeaveDates }),
        onSuccess: () => {
            const today = getCurrentPhDateInput();
            setLeaveForm({ ...emptyLeaveForm, startDate: today, endDate: today, selectedDates: [today] });
            setSelectedLeaveDates([today]);
            setLeaveCalendarMonth(today.slice(0, 7));
            queryClient.invalidateQueries({ queryKey: leaveRequestsQueryKey });
        },
    });
    const updateLeaveRequestMutation = useMutation({
        mutationFn: () => updateEmployeeLeaveRequest(employeeId, editingLeaveRequestId, { ...leaveForm, selectedDates: selectedLeaveDates }),
        onSuccess: () => {
            const today = getCurrentPhDateInput();
            setEditingLeaveRequestId("");
            setLeaveForm({ ...emptyLeaveForm, startDate: today, endDate: today, selectedDates: [today] });
            setSelectedLeaveDates([today]);
            setLeaveCalendarMonth(today.slice(0, 7));
            queryClient.invalidateQueries({ queryKey: leaveRequestsQueryKey });
        },
    });
    const replyLeaveRequestMutation = useMutation({
        mutationFn: ({ requestId, message }: { requestId: string; message: string }) =>
            replyToEmployeeLeaveRequest(employeeId, requestId, message, name),
        onSuccess: (_leaveRequest, variables) => {
            setLeaveReplies((current) => ({ ...current, [variables.requestId]: "" }));
            queryClient.invalidateQueries({ queryKey: leaveRequestsQueryKey });
        },
    });

    const [previousProfileDraft, setPreviousProfileDraft] = useState<readonly unknown[] | null>(null);
    const profileDraftInputs = [currentEmployee, isProfileEditing];
    if (previousProfileDraft === null || profileDraftInputs.some((input, index) => !Object.is(input, previousProfileDraft[index]))) {
        setPreviousProfileDraft(profileDraftInputs);
        (() => {
            if (!currentEmployee || isProfileEditing) {
                return;
            }

            setProfileForm(profileFormFromEmployee(currentEmployee));
        })();
    }

    const [previousProfileRoute, setPreviousProfileRoute] = useState<readonly unknown[] | null>(null);
    const profileRouteInputs = [requestedProfileTab];
    if (previousProfileRoute === null || profileRouteInputs.some((input, index) => !Object.is(input, previousProfileRoute[index]))) {
        setPreviousProfileRoute(profileRouteInputs);
        (() => {
            if (requestedProfileTab === "notices" || requestedProfileTab === "leave" || requestedProfileTab === "overview") {
                setActiveProfileTab(requestedProfileTab);
            } else {
                setActiveProfileTab("overview");
            }
        })();
    }

    useEffect(() => {
        if (activeProfileTab !== "notices" || !highlightedNoticeId) {
            return;
        }

        const timer = window.setTimeout(() => {
            document.getElementById(`notice-${highlightedNoticeId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 100);

        return () => window.clearTimeout(timer);
    }, [activeProfileTab, highlightedNoticeId, notices.length]);

    const updateProfileForm = <Field extends keyof EmployeeProfileInput>(field: Field, value: EmployeeProfileInput[Field]) => {
        if (!isProfileEditing) {
            return;
        }

        setProfileSuccessMessage("");
        setProfileForm((form) => ({ ...form, [field]: value }));
    };

    const resetProfileForm = () => {
        if (!currentEmployee) {
            return;
        }

        setProfileForm(profileFormFromEmployee(currentEmployee));
    };

    const updateProfileImage = (file: File | undefined) => {
        if (!file) return;
        if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
            setProfileErrorMessage("Choose a JPG, PNG, WebP, or GIF image.");
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            setProfileErrorMessage("Profile pictures must be 2 MB or smaller.");
            return;
        }

        const reader = new FileReader();
        reader.onerror = () => setProfileErrorMessage("Unable to read the selected image.");
        reader.onload = () => {
            const profileImage = String(reader.result || "");
            if (!profileImage) return;
            setProfileErrorMessage("");
            setProfileForm((current) => ({ ...current, profileImage }));
            updateProfileMutation.mutate({ ...profileFormFromEmployee(currentEmployee), profileImage });
        };
        reader.readAsDataURL(file);
    };

    const updateNoticeReply = (noticeId: string, value: string) => {
        setNoticeReplies((current) => ({ ...current, [noticeId]: value }));
    };

    const updateLeaveForm = <Field extends keyof LeaveRequestInput>(field: Field, value: LeaveRequestInput[Field]) => {
        setLeaveForm((form) => ({ ...form, [field]: value }));
    };

    const updateLeaveReply = (requestId: string, value: string) => {
        setLeaveReplies((current) => ({ ...current, [requestId]: value }));
    };

    const applySelectedLeaveDates = (dateKeys: string[]) => {
        const normalizedDateKeys = normalizeSelectedDateKeys(dateKeys);
        const firstDate = normalizedDateKeys[0] || "";
        const lastDate = normalizedDateKeys[normalizedDateKeys.length - 1] || "";

        setSelectedLeaveDates(normalizedDateKeys);
        setLeaveForm((form) => ({
            ...form,
            startDate: firstDate,
            endDate: lastDate,
            selectedDates: normalizedDateKeys,
        }));

        if (firstDate) {
            setLeaveCalendarMonth(firstDate.slice(0, 7));
        }
    };

    const toggleLeaveDate = (dateKey: string) => {
        applySelectedLeaveDates(
            selectedLeaveDates.includes(dateKey)
                ? selectedLeaveDates.filter((selectedDate) => selectedDate !== dateKey)
                : [...selectedLeaveDates, dateKey]
        );
    };

    const resetLeaveForm = () => {
        const today = getCurrentPhDateInput();

        setLeaveForm({ ...emptyLeaveForm, startDate: today, endDate: today, selectedDates: [today] });
        setSelectedLeaveDates([today]);
        setLeaveCalendarMonth(today.slice(0, 7));
    };

    const submitLeaveRequest = () => {
        if (!employeeId || selectedLeaveDates.length === 0 || !leaveForm.reason.trim()) {
            return;
        }

        if (editingLeaveRequestId) {
            updateLeaveRequestMutation.mutate();
            return;
        }

        createLeaveRequestMutation.mutate();
    };

    const startEditLeaveRequest = (leaveRequest: LeaveRequest) => {
        if (leaveRequest.status !== "Pending") {
            return;
        }

        setEditingLeaveRequestId(leaveRequest._id);
        const leaveDateKeys = getLeaveRequestSelectedDateKeys(leaveRequest);
        setLeaveForm({
            leaveType: leaveRequest.leaveType,
            startDate: leaveDateKeys[0] || getPhDateInput(leaveRequest.startDate),
            endDate: leaveDateKeys[leaveDateKeys.length - 1] || getPhDateInput(leaveRequest.endDate),
            selectedDates: leaveDateKeys,
            reason: leaveRequest.reason,
        });
        setSelectedLeaveDates(leaveDateKeys);
        setLeaveCalendarMonth((leaveDateKeys[0] || getPhDateInput(leaveRequest.startDate)).slice(0, 7));
    };

    const cancelLeaveEdit = () => {
        setEditingLeaveRequestId("");
        resetLeaveForm();
    };

    const inputClass = "h-10 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/25 focus:border-[#842cff]/60 focus:bg-white/[0.07] disabled:cursor-not-allowed disabled:bg-white/[0.025] disabled:text-white/55";
    const textareaClass = "min-h-24 w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-white/25 focus:border-[#842cff]/60 focus:bg-white/[0.07] disabled:cursor-not-allowed disabled:bg-white/[0.025] disabled:text-white/55";
    const isProfileFormDisabled = !isProfileEditing || updateProfileMutation.isPending;
    const leaveCalendarDays = getCalendarDays(leaveCalendarMonth);
    const selectedLeaveDateSet = new Set(selectedLeaveDates);
    const selectedLeaveSummary =
        selectedLeaveDates.length === 0
            ? "No dates selected"
            : selectedLeaveDates.length === 1
                ? formatDateKey(selectedLeaveDates[0])
                : `${selectedLeaveDates.length} dates selected · ${formatDateKey(selectedLeaveDates[0])} - ${formatDateKey(selectedLeaveDates[selectedLeaveDates.length - 1])}`;

    const contactRelationship: ContactRelationships[] = ["Father", "Mother", "Sibling", "Spouse", "Relative", "Friend"];

    const dropdownConfigs = {
        contactRelationship: {
            value: profileForm.contactRelationship,
            options: contactRelationship,
            searchable: false,
            search: "",
            onSearch: () => undefined,
            onChange: (status: string) => {
                setProfileForm((employee) => ({ ...employee, contactRelationship: status as ContactRelationships }));
                setOpenDropdown(null);
            },
        },
    };
    const activeDropdown = openDropdown ? dropdownConfigs[openDropdown] : null;
    const activeDropdownOptions = activeDropdown
        ? activeDropdown.options.filter((option) => option.toLowerCase().includes(activeDropdown.search.toLowerCase()))
        : [];

    useEffect(() => {
        if (!openDropdown) return;

        const handleOutsideClick = (event: globalThis.MouseEvent) => {
            const target = event.target as Node | null;
            const activeButton = { contactRelationship: statusButtonRel }[openDropdown].current;
            if (!target || activeButton?.contains(target) || dropdownMenuRef.current?.contains(target)) {
                return;
            }
            setOpenDropdown(null);
        };

        document.addEventListener("mousedown", handleOutsideClick);
        return () => document.removeEventListener("mousedown", handleOutsideClick);
    }, [openDropdown]);


    const getDropdownStyle = (button: HTMLButtonElement | null) => {
        if (!button) {
            return undefined;
        }

        const rect = button.getBoundingClientRect();
        const menuHeight = 220;
        const spaceBelow = window.innerHeight - rect.bottom;
        const shouldOpenAbove = spaceBelow < menuHeight && rect.top > menuHeight;

        return {
            left: rect.left,
            top: shouldOpenAbove ? rect.top - menuHeight - 8 : rect.bottom + 8,
            width: rect.width,
        };
    };

    return (
        <MainLayout>
            <section className={`min-h-[calc(100vh-8.5rem)] space-y-5 ${profileUpgradeEnabled ? "profile-v2" : ""}`} aria-busy={profileUpgradeEnabled && profileLoading}>
                {profileUpgradeEnabled && <ProfileMobileNavigation />}
                {profileUpgradeEnabled && profileLoadError && <p role="alert">Profile could not refresh. Previously loaded information remains visible.</p>}
                <div className="profile-hero theme-surface-bg overflow-hidden rounded-lg border border-white/10">
                    <div className="profile-banner h-36 border-b border-white/10 bg-[radial-gradient(circle_at_18%_10%,rgba(132,44,255,0.36),transparent_28%),linear-gradient(135deg,rgba(255,255,255,0.08),transparent_45%)]" />
                    <div className="px-5 pb-5">
                        <div className="-mt-14 flex flex-wrap items-end justify-between gap-4">
                            <div className="flex min-w-0 items-end gap-4">
                                <div className="relative">
                                    <div className="profile-avatar grid size-28 place-items-center overflow-hidden rounded-lg border-4 border-[#090b13] bg-[linear-gradient(135deg,#842cff,#4a0ebd)] text-3xl font-semibold text-white shadow-2xl shadow-black/30">
                                        {profileImageValue ? (
                                            <img className="size-full object-cover" src={profileImageValue} alt={name} />
                                        ) : (
                                            initials
                                        )}
                                    </div>
                                    {employeeId && (
                                        <>
                                            <button
                                                className="absolute -bottom-2 -right-2 grid size-10 place-items-center rounded-full border-2 border-[#090b13] bg-white text-black shadow-lg transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
                                                type="button"
                                                title={isProfileEditing ? "Save or cancel personal details before changing your picture" : "Change profile picture"}
                                                aria-label="Change profile picture"
                                                disabled={updateProfileMutation.isPending || isProfileEditing || profileLoading || profileLoadError}
                                                onClick={() => profileImageInputRef.current?.click()}
                                            >
                                                <FiCamera className="size-4" aria-hidden="true" />
                                            </button>
                                            <input
                                                ref={profileImageInputRef}
                                                className="hidden"
                                                type="file"
                                                accept="image/jpeg,image/png,image/webp,image/gif"
                                                onChange={(event) => {
                                                    updateProfileImage(event.target.files?.[0]);
                                                    event.currentTarget.value = "";
                                                }}
                                            />
                                        </>
                                    )}
                                </div>

                                <div className="min-w-0 pb-1">
                                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Agent Profile</p>
                                    <h2 className="mt-1 truncate text-2xl font-semibold text-white">{name}</h2>
                                    {profileUpgradeEnabled && tenureLabel(currentEmployee?.dateHired) && <p className="profile-tenure">{tenureLabel(currentEmployee?.dateHired)} with the team</p>}
                                    {profileUpgradeEnabled && currentEmployee?.availabilityStatus && <AvailabilityBadge status={currentEmployee.availabilityStatus} />}
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {[role, team, employmentStatus, `${unreadNoticeCount} unread notice${unreadNoticeCount === 1 ? "" : "s"}`].map((label) => (
                                            <span key={label} className="rounded-md border border-white/10 bg-white/[0.06] px-3 py-1 text-xs font-semibold text-white/65">
                                                {label}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>

                <div className="profile-tabs theme-surface-bg flex flex-wrap gap-2 rounded-lg border border-white/10 p-2" role={profileUpgradeEnabled ? "tablist" : undefined} aria-label={profileUpgradeEnabled ? "Profile sections" : undefined}>
                    {[
                        ["overview", "Overview"],
                        ["leave", `Leave${pendingLeaveCount > 0 ? ` (${pendingLeaveCount})` : ""}`],
                        ["notices", `Notices${unreadNoticeCount > 0 ? ` (${unreadNoticeCount})` : ""}`],
                    ].map(([tab, label]) => (
                        <button
                            key={tab}
                            id={profileUpgradeEnabled ? `profile-tab-${tab}` : undefined}
                            role={profileUpgradeEnabled ? "tab" : undefined}
                            aria-selected={profileUpgradeEnabled ? activeProfileTab === tab : undefined}
                            aria-controls={profileUpgradeEnabled ? `profile-panel-${tab}` : undefined}
                            tabIndex={profileUpgradeEnabled ? activeProfileTab === tab ? 0 : -1 : undefined}
                            className={[
                                "h-10 rounded-lg px-4 text-sm font-semibold transition",
                                activeProfileTab === tab
                                    ? "bg-white text-black"
                                    : "text-white/60 hover:bg-white/[0.06] hover:text-white",
                            ].join(" ")}
                            type="button"
                            onClick={() => selectProfileTab(tab as "overview" | "leave" | "notices")}
                            onKeyDown={(event) => {
                                if (!profileUpgradeEnabled || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                                event.preventDefault(); const tabs = ["overview", "leave", "notices"] as const; const index = tabs.indexOf(activeProfileTab);
                                const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
                                selectProfileTab(tabs[next]); document.getElementById(`profile-tab-${tabs[next]}`)?.focus();
                            }}
                        >
                            {profileUpgradeEnabled && (tab === "overview" ? <FiBriefcase aria-hidden="true" /> : tab === "leave" ? <FiCalendar aria-hidden="true" /> : <FiBell aria-hidden="true" />)}
                            {label}
                        </button>
                    ))}
                </div>

                <div role={profileUpgradeEnabled ? "tabpanel" : undefined} id={profileUpgradeEnabled ? `profile-panel-${activeProfileTab}` : undefined} aria-labelledby={profileUpgradeEnabled ? `profile-tab-${activeProfileTab}` : undefined}>
                {activeProfileTab === "overview" ? (
                    <div className="profile-overview grid gap-5 xl:grid-cols-[22rem_1fr]">
                        <aside className="space-y-5">
                            <section className="theme-surface-bg rounded-lg border border-white/10 p-5">
                                <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Contact</p>
                                <div className="mt-4 space-y-3">
                                    {[
                                        [FiMail, "Email", profileUpgradeEnabled && email === "Not provided" ? currentEmployee?.personalEmail || email : email],
                                        [FiPhone, "Phone", profileUpgradeEnabled && phone === "Not provided" ? currentEmployee?.personalPhone || phone : phone],
                                        [FiMapPin, "Address", currentEmployee?.personalAddress || "Not provided"],
                                    ].map(([Icon, label, value]) => {
                                        const ContactIcon = Icon as typeof FiMail;
                                        return (
                                            <div key={label as string} className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-3">
                                                <ContactIcon className="mt-0.5 size-4 shrink-0 text-[#b994ff]" aria-hidden="true" />
                                                <div className="min-w-0">
                                                    <p className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">{label as string}</p>
                                                    <p className="mt-1 break-words text-sm font-semibold text-white/75">{profileUpgradeEnabled && value === "Not provided" ? "" : value as string}</p>
                                                    {profileUpgradeEnabled && <ProfileContactActions value={value as string} label={label as string} edit={() => { setIsProfileEditing(true); window.requestAnimationFrame(() => { document.getElementById("profile-personal-details")?.scrollIntoView({ block: "start" }); document.getElementById(label === "Email" ? "personal-email" : label === "Phone" ? "personal-phone" : "personal-address")?.focus(); }); }} />}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </section>

                            <section className="theme-surface-bg rounded-lg border border-white/10 p-5">
                                <div className="flex items-center justify-between gap-3">
                                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Profile Summary</p>
                                    <FiShield className="size-4 text-[#b994ff]" aria-hidden="true" />
                                </div>
                                <div className="mt-4 grid gap-3">
                                    {[
                                        ["Employee Code", employeeCode],
                                        ["Department", team],
                                        ["Position", role],
                                        ["Status", employmentStatus],
                                    ].map(([label, value]) => (
                                        <div key={label} className="profile-summary-row flex items-center justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2">
                                            <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">{label}</span>
                                            <span className="truncate text-right text-sm font-semibold text-white/75">{value}</span>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        </aside>

                        <div className="space-y-5">
                            <div className="profile-stats grid gap-3 md:grid-cols-3" aria-busy={recentActivityQuery.isPending}>
                                {profileStats.map(([label, value, detail]) => (
                                    <article key={label} className="theme-surface-bg rounded-lg border border-white/10 p-4">
                                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{label}</p>
                                        {profileUpgradeEnabled && <FiTrendingUp className="profile-stat-icon" aria-hidden="true" />}
                                        <div className="mt-3 flex items-end justify-between gap-3">
                                            <p className="text-2xl font-semibold text-white">{profileUpgradeEnabled ? recentActivityQuery.isPending ? <span className="profile-stat-loading" aria-label="Loading metric">...</span> : value === "-" ? <span className="text-sm">No data yet</span> : <MetricValue value={Number(value)} /> : value}</p>
                                            <span className="text-right text-xs font-semibold text-white/35">{detail}</span>
                                        </div>
                                    </article>
                                ))}
                            </div>

                            <section ref={profileDetailsRef} id="profile-personal-details" className="profile-form theme-surface-bg rounded-lg border border-white/10 p-5">
                                <div className={`flex flex-wrap items-center justify-between gap-3 ${profileUpgradeEnabled && isProfileEditing ? "profile-save-bar" : ""}`}>
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Personal Details</p>
                                        <p className="mt-1 text-sm text-white/45">Only personal contact fields can be edited.</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {!isProfileEditing ? (
                                            <button
                                                className="inline-flex h-9 items-center gap-2 rounded-lg bg-white px-3 text-xs font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
                                                type="button"
                                                disabled={!employeeId || profileLoading || profileLoadError}
                                                onClick={() => {
                                                    setProfileSuccessMessage("");
                                                    setIsProfileEditing(true);
                                                }}
                                            >
                                                <FiEdit2 className="size-4" aria-hidden="true" />
                                                Edit
                                            </button>
                                        ) : (
                                            <>
                                                <button
                                                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                                                    type="button"
                                                    disabled={updateProfileMutation.isPending}
                                                    onClick={() => {
                                                        resetProfileForm();
                                                        setIsProfileEditing(false);
                                                        setProfileSuccessMessage("");
                                                        setOpenDropdown(null);
                                                    }}
                                                >
                                                    <FiX className="size-4" aria-hidden="true" />
                                                    Cancel
                                                </button>
                                                <button
                                                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-white px-3 text-xs font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
                                                    type="button"
                                                    disabled={!employeeId || updateProfileMutation.isPending}
                                                    onClick={() => {
                                                        const invalid = profileDetailsRef.current?.querySelector<HTMLInputElement>("input:invalid");
                                                        if (invalid) { invalid.reportValidity(); invalid.focus(); return; }
                                                        updateProfileMutation.mutate(profileForm);
                                                    }}
                                                >
                                                    <FiSave className="size-4" aria-hidden="true" />
                                                    {updateProfileMutation.isPending ? "Saving..." : "Save"}
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                                {profileUpgradeEnabled && <div className="profile-completeness"><span>Personal details {profileCompleteness(profileForm).percent}%</span><progress aria-label="Personal detail completeness" max="100" value={profileCompleteness(profileForm).percent} /><span>{profileCompleteness(profileForm).filled}/{profileCompleteness(profileForm).total}</span></div>}
                                {profileUpgradeEnabled && isProfileEditing && <p className="profile-unsaved" role="status">{JSON.stringify(profileForm) === JSON.stringify(profileFormFromEmployee(currentEmployee)) ? "Editing personal details" : "Unsaved changes"}</p>}

                                {profileSuccessMessage && (
                                    <div role={profileUpgradeEnabled ? "status" : undefined} className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-300/25 bg-emerald-300/10 px-3 py-2 text-sm font-semibold text-emerald-200">
                                        <FiCheckCircle className="size-4 shrink-0" aria-hidden="true" />
                                        <span>{profileSuccessMessage}</span>
                                    </div>
                                )}
                                {profileErrorMessage && (
                                    <div role={profileUpgradeEnabled ? "alert" : undefined} className="mt-4 rounded-lg border border-rose-300/25 bg-rose-300/10 px-3 py-2 text-sm font-semibold text-rose-200">
                                        {profileErrorMessage}
                                    </div>
                                )}

                                <div className="mt-5 grid gap-4 md:grid-cols-2">
                                    <ProfileFieldGroup enabled={profileUpgradeEnabled} title="Contact">
                                    <label className="space-y-2">
                                        <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Personal Phone</span>
                                        <input id="personal-phone" className={inputClass} disabled={isProfileFormDisabled} value={profileForm.personalPhone || ""} onChange={(event) => updateProfileForm("personalPhone", event.target.value)} />
                                    </label>
                                    <label className="space-y-2">
                                        <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Personal Email</span>
                                        <input id="personal-email" className={inputClass} disabled={isProfileFormDisabled} type="email" value={profileForm.personalEmail || ""} onChange={(event) => updateProfileForm("personalEmail", event.target.value)} />
                                    </label>
                                    </ProfileFieldGroup>
                                    <ProfileFieldGroup enabled={profileUpgradeEnabled} title="Emergency">
                                    <label className="space-y-2 col-span-2">
                                        <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Emergency Contact</span>
                                        <input
                                            className={inputClass}
                                            aria-label="Emergency contact name"
                                            disabled={isProfileFormDisabled}
                                            value={profileForm.emergencyContact || ""}
                                            onChange={(event) => updateProfileForm("emergencyContact", event.target.value)}
                                            placeholder="Name"
                                        />
                                        <CustomDropdown
                                            label=""
                                            placeholder="Relationship"
                                            value={profileForm.contactRelationship}
                                            disabled={isProfileFormDisabled}
                                            onOpen={() => {
                                                setDropdownStyle(getDropdownStyle(statusButtonRel.current) ?? {});
                                                setOpenDropdown((current) => (current === "contactRelationship" ? null : "contactRelationship"));
                                            }}
                                            buttonRef={statusButtonRel}
                                        />
                                        <input
                                            className={inputClass}
                                            aria-label="Emergency contact phone"
                                            disabled={isProfileFormDisabled}
                                            value={profileForm.emergencyContactNumber || ""}
                                            onChange={(event) => updateProfileForm("emergencyContactNumber", event.target.value)}
                                            placeholder="Phone"
                                        />
                                    </label>
                                    </ProfileFieldGroup>
                                    <ProfileFieldGroup enabled={profileUpgradeEnabled} title="Address and notes">
                                    <label className="space-y-2 md:col-span-2">
                                        <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Personal Address</span>
                                        <textarea id="personal-address" className={textareaClass} disabled={isProfileFormDisabled} value={profileForm.personalAddress || ""} onChange={(event) => updateProfileForm("personalAddress", event.target.value)} />
                                    </label>
                                    <label className="space-y-2 md:col-span-2">
                                        <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Personal Notes</span>
                                        <textarea className={textareaClass} disabled={isProfileFormDisabled} value={profileForm.personalNotes || ""} onChange={(event) => updateProfileForm("personalNotes", event.target.value)} />
                                    </label>
                                    </ProfileFieldGroup>
                                    {!profileUpgradeEnabled && <div className="border-t border-white/10 pt-4 md:col-span-2">
                                        <p className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Bank Details</p>
                                    </div>}
                                    <ProfileFieldGroup enabled={profileUpgradeEnabled} title="Bank details">
                                    <label className="space-y-2">
                                        <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Bank Name</span>
                                        <input className={inputClass} disabled={isProfileFormDisabled} value={profileForm.bankName || ""} onChange={(event) => updateProfileForm("bankName", event.target.value)} autoComplete="organization" />
                                    </label>
                                    <label className="space-y-2">
                                        <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Account Name</span>
                                        <input className={inputClass} disabled={isProfileFormDisabled} value={profileForm.bankAccountName || ""} onChange={(event) => updateProfileForm("bankAccountName", event.target.value)} autoComplete="name" />
                                    </label>
                                    <label className="space-y-2">
                                        <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Account Number</span>
                                        {profileUpgradeEnabled ? <BankAccountInput className={inputClass} disabled={isProfileFormDisabled} value={profileForm.bankAccountNumber || ""} onChange={(value) => updateProfileForm("bankAccountNumber", value)} /> : <input className={inputClass} disabled={isProfileFormDisabled} value={profileForm.bankAccountNumber || ""} onChange={(event) => updateProfileForm("bankAccountNumber", event.target.value)} inputMode="numeric" autoComplete="off" />}
                                    </label>
                                    </ProfileFieldGroup>
                                </div>
                                {isProfileEditing && activeDropdown && (
                                    <div
                                        ref={dropdownMenuRef}
                                        className="theme-panel-bg fixed z-[60] overflow-hidden rounded-lg border border-white/10 shadow-2xl shadow-black/40"
                                        style={dropdownStyle}
                                        onMouseDown={(event) => event.stopPropagation()}
                                    >
                                        <div className="max-h-44 overflow-y-auto py-1">
                                            {activeDropdownOptions.map((option) => (
                                                <button
                                                    key={option}
                                                    className="flex h-10 w-full items-center justify-between gap-3 px-3 text-left text-sm font-semibold text-white/70 transition hover:bg-white/[0.06] hover:text-white"
                                                    type="button"
                                                    onClick={() => activeDropdown.onChange(option)}
                                                >
                                                    {option}
                                                    {activeDropdown.value === option && (
                                                        <FiCheck className="size-4 text-[#b994ff]" aria-hidden="true" />
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </section>

                            <section className="theme-surface-bg rounded-lg border border-white/10 p-5">
                                <div className="flex items-center gap-2">
                                    <FiBriefcase className="size-4 text-[#b994ff]" aria-hidden="true" />
                                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Work Information</p>
                                </div>
                                <div className="mt-5 grid gap-3 md:grid-cols-2">
                                    {[
                                        ["Employee Code", employeeCode],
                                        ["Department", team],
                                        ["Position", role],
                                        ["Status", employmentStatus],
                                        ["Company", currentEmployee?.company || "Not provided"],
                                        ["Date Hired", currentEmployee?.dateHired ? formatPhDate(currentEmployee.dateHired) : "Not provided"],
                                    ].filter(([label]) => !profileUpgradeEnabled || ["Company", "Date Hired"].includes(label)).map(([label, value]) => (
                                        <div key={label} className="flex items-center justify-between gap-4 border-b border-white/10 pb-3 last:border-b-0 md:even:border-b-0">
                                            <span className="text-sm text-white/45">{label}</span>
                                            <span className="text-right text-sm font-semibold text-white">{value}</span>
                                        </div>
                                    ))}
                                    {profileUpgradeEnabled && <><div><span className="text-sm text-white/45">Tenure</span><p className="text-sm font-semibold text-white">{tenureLabel(currentEmployee?.dateHired) || "Date hired not available"}</p></div><details className="profile-identity-details profile-work-details"><summary>Identity details</summary><div>{[["Employee Code", employeeCode], ["Department", team], ["Position", role], ["Status", employmentStatus]].map(([label, value]) => <p key={label}><span className="text-sm text-white/45">{label}</span><br /><strong>{value}</strong></p>)}</div></details></>}
                                </div>
                            </section>

                            <section className="theme-surface-bg rounded-lg border border-white/10 p-5">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-2">
                                        <FiTrendingUp className="size-4 text-[#b994ff]" aria-hidden="true" />
                                        <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Recent Activity</p>
                                    </div>
                                    <button
                                        className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/50 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                                        type="button"
                                        disabled={recentActivityQuery.isFetching}
                                        onClick={() => recentActivityQuery.refetch()}
                                        aria-label="Refresh recent activity"
                                        title="Refresh"
                                    >
                                        <FiRefreshCw className={["size-3.5", recentActivityQuery.isFetching ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
                                    </button>
                                </div>
                                <div className="mt-4 space-y-3">
                                    {recentActivityQuery.isPending && Array.from({ length: 3 }, (_, index) => (
                                        <div key={index} className="h-[4.4rem] animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />
                                    ))}
                                    {!recentActivityQuery.isPending && recentActivities.length === 0 && (!profileUpgradeEnabled || !recentActivityQuery.isError) && (
                                        <div className="rounded-lg border border-dashed border-white/10 px-4 py-7 text-center">
                                            <p className="text-sm font-semibold text-white/65">No recent activity</p>
                                            <p className="mt-1 text-xs text-white/35">Attendance, notices, and leave updates will appear here.</p>
                                        </div>
                                    )}
                                    {profileUpgradeEnabled && recentActivityQuery.isError && <p role="alert">Recent activity could not load. Use refresh to try again.</p>}
                                    {recentActivities.map((activity, index) => (
                                        <Fragment key={activity._id}>{profileUpgradeEnabled && (index === 0 || profileActivityDay(activity.occurredAt) !== profileActivityDay(recentActivities[index - 1].occurredAt)) && <h3 className="profile-activity-day">{profileActivityDay(activity.occurredAt)}</h3>}
                                        <article className="profile-activity-row flex min-h-[4.4rem] items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-3">
                                            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#842cff]/25 bg-[#842cff]/10 text-[#c9a7ff]">
                                                {profileUpgradeEnabled && activity.category === "Notice" ? <FiBell className="size-4" aria-hidden="true" /> : profileUpgradeEnabled && activity.category === "Lead" ? <FiTrendingUp className="size-4" aria-hidden="true" /> : <FiClock className="size-4" aria-hidden="true" />}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-semibold text-white">{activity.title}</p>
                                                <p className="mt-1 line-clamp-1 text-xs text-white/40">{activity.description}</p>
                                            </div>
                                            <span className="shrink-0 text-right text-xs text-white/35">{formatPhDateTime(activity.occurredAt)}</span>
                                        </article></Fragment>
                                    ))}
                                    {recentActivityQuery.hasNextPage && (
                                        <button
                                            className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.04] text-xs font-semibold text-white/60 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-50"
                                            type="button"
                                            disabled={recentActivityQuery.isFetchingNextPage}
                                            onClick={() => recentActivityQuery.fetchNextPage()}
                                        >
                                            {recentActivityQuery.isFetchingNextPage ? "Loading..." : "Load more"}
                                        </button>
                                    )}
                                </div>
                            </section>

                            <section className="theme-surface-bg rounded-lg border border-white/10 p-5">
                                <div className="flex items-center gap-2">
                                    <FiShield className="size-4 text-[#b994ff]" aria-hidden="true" />
                                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Account Security</p>
                                </div>
                                <div className="mt-4 grid gap-3 md:grid-cols-2">
                                    {["Employee code login enabled", "Work details managed by admin"].map((item) => (
                                        <div key={item} className="profile-security-row rounded-lg border border-white/10 bg-white/[0.04] p-3 text-sm font-semibold text-white/70">
                                            {profileUpgradeEnabled && <FiShield aria-hidden="true" />}
                                            {item}
                                        </div>
                                    ))}
                                </div>
                            </section>
                        </div>
                    </div>
                ) : activeProfileTab === "leave" ? (
                    <div className="grid gap-5 xl:grid-cols-[0.92fr_1.08fr]">
                        <section className="theme-surface-bg rounded-lg border border-white/10 p-5">
                            <div className="flex items-center gap-2">
                                <FiCalendar className="size-4 text-[#b994ff]" aria-hidden="true" />
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Leave Form</p>
                                    <p className="mt-1 text-sm text-white/45">
                                        {editingLeaveRequestId ? "Edit pending leave dates in PH time." : "Submit leave dates in PH time."}
                                    </p>
                                </div>
                            </div>

                            <div className="mt-5 grid gap-4">
                                <label className="space-y-2">
                                    <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Leave Type</span>
                                    <select
                                        className={inputClass}
                                        value={leaveForm.leaveType}
                                        onChange={(event) => updateLeaveForm("leaveType", event.target.value as LeaveRequestInput["leaveType"])}
                                    >
                                        {leaveRequestTypes.map((leaveType) => (
                                            <option key={leaveType} value={leaveType}>{leaveType}</option>
                                        ))}
                                    </select>
                                </label>
                                <div className="rounded-lg border border-white/10 bg-white/[0.035] p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div>
                                            <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Leave Dates</span>
                                            <p className="mt-1 text-sm font-semibold text-white/75">{selectedLeaveSummary}</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                                type="button"
                                                aria-label="Previous month"
                                                onClick={() => setLeaveCalendarMonth((month) => shiftMonth(month, -1))}
                                            >
                                                <FiChevronLeft className="size-4" aria-hidden="true" />
                                            </button>
                                            <p className="min-w-36 text-center text-sm font-semibold text-white">{getMonthLabel(leaveCalendarMonth)}</p>
                                            <button
                                                className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                                type="button"
                                                aria-label="Next month"
                                                onClick={() => setLeaveCalendarMonth((month) => shiftMonth(month, 1))}
                                            >
                                                <FiChevronRight className="size-4" aria-hidden="true" />
                                            </button>
                                        </div>
                                    </div>
                                    <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-white/35">
                                        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                                            <span key={day}>{day}</span>
                                        ))}
                                    </div>
                                    <div className="profile-calendar mt-2 grid grid-cols-7 gap-1">
                                        {leaveCalendarDays.map((day) => {
                                            const isSelected = selectedLeaveDateSet.has(day.dateKey);

                                            return (
                                                <button
                                                    key={day.dateKey}
                                                    className={[
                                                        "flex aspect-square min-h-10 items-center justify-center rounded-lg border text-sm font-semibold transition",
                                                        isSelected
                                                            ? "border-[#842cff] bg-[#842cff] text-white shadow-lg shadow-[#842cff]/20"
                                                            : day.isCurrentMonth
                                                                ? "border-white/10 bg-white/[0.045] text-white/80 hover:border-[#842cff]/50 hover:bg-[#842cff]/15 hover:text-white"
                                                                : "border-transparent bg-transparent text-white/20 hover:bg-white/[0.035]",
                                                    ].join(" ")}
                                                    type="button"
                                                    aria-pressed={isSelected}
                                                    aria-label={profileUpgradeEnabled ? day.dateKey : undefined}
                                                    aria-current={profileUpgradeEnabled && day.dateKey === getCurrentPhDateInput() ? "date" : undefined}
                                                    data-weekend={profileUpgradeEnabled && [0, 6].includes(new Date(`${day.dateKey}T00:00:00Z`).getUTCDay())}
                                                    onClick={() => toggleLeaveDate(day.dateKey)}
                                                    onKeyDown={(event) => {
                                                        if (!profileUpgradeEnabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                                                        event.preventDefault();
                                                        const amount = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key];
                                                        const index = leaveCalendarDays.findIndex((item) => item.dateKey === day.dateKey); const next = leaveCalendarDays[index + amount];
                                                        if (next) event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`button[aria-label="${next.dateKey}"]`)?.focus();
                                                    }}
                                                >
                                                    {day.day}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    {selectedLeaveDates.length > 0 && (
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            {selectedLeaveDates.map((dateKey) => (
                                                <button
                                                    key={dateKey}
                                                    className="rounded-md border border-[#842cff]/35 bg-[#842cff]/15 px-2.5 py-1 text-xs font-semibold text-[#d6c2ff] transition hover:bg-[#842cff]/25 hover:text-white"
                                                    type="button"
                                                    onClick={() => toggleLeaveDate(dateKey)}
                                                    title="Remove selected date"
                                                >
                                                    {formatDateKey(dateKey)} ×
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <label className="space-y-2">
                                    <span className="text-xs font-medium uppercase tracking-[0.12em] text-white/35">Reason</span>
                                    <textarea
                                        className="min-h-36 w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-white/25 focus:border-[#842cff]/60 focus:bg-white/[0.07]"
                                        value={leaveForm.reason}
                                        onChange={(event) => updateLeaveForm("reason", event.target.value)}
                                        placeholder="Reason for leave"
                                    />
                                </label>
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
                                        type="button"
                                        disabled={
                                            !employeeId ||
                                            selectedLeaveDates.length === 0 ||
                                            !leaveForm.reason.trim() ||
                                            createLeaveRequestMutation.isPending ||
                                            updateLeaveRequestMutation.isPending
                                        }
                                        onClick={submitLeaveRequest}
                                    >
                                        {editingLeaveRequestId ? <FiSave className="size-4" aria-hidden="true" /> : <FiCalendar className="size-4" aria-hidden="true" />}
                                        {updateLeaveRequestMutation.isPending
                                            ? "Saving..."
                                            : createLeaveRequestMutation.isPending
                                                ? "Submitting..."
                                                : editingLeaveRequestId
                                                    ? "Save Leave Request"
                                                    : "Submit Leave Request"}
                                    </button>
                                    {editingLeaveRequestId && (
                                        <button
                                            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                                            type="button"
                                            onClick={cancelLeaveEdit}
                                            disabled={updateLeaveRequestMutation.isPending}
                                        >
                                            <FiX className="size-4" aria-hidden="true" />
                                            Cancel
                                        </button>
                                    )}
                                </div>
                            </div>
                        </section>

                        <section className="theme-surface-bg rounded-lg border border-white/10 p-5">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Leave Requests</p>
                                    <p className="mt-1 text-sm text-white/45">Admin approval status and history.</p>
                                </div>
                                <span className="rounded-md border border-white/10 bg-white/[0.06] px-3 py-1 text-xs font-semibold text-white/65">
                                    {leaveRequests.length} total
                                </span>
                            </div>

                            <div className="mt-5 max-h-[calc(100vh-19rem)] min-h-72 space-y-3 overflow-y-auto pr-2">
                                {profileUpgradeEnabled && leaveRequestsError && <p role="alert">Leave requests could not load. Please refresh this page.</p>}
                                {leaveRequestsLoading && (
                                    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4 text-sm text-white/55">Loading leave requests...</div>
                                )}
                                {!leaveRequestsLoading && leaveRequests.length === 0 && (!profileUpgradeEnabled || !leaveRequestsError) && (
                                    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                        <p className="text-sm font-semibold text-white">No leave requests yet</p>
                                        <p className="mt-1 text-sm text-white/45">Submitted leave forms will appear here.</p>
                                    </div>
                                )}
                                {leaveRequests.map((leaveRequest) => {
                                    const leaveThread = getLeaveRequestThread(leaveRequest);
                                    const replyDraft = leaveReplies[leaveRequest._id] || "";
                                    const isPending = leaveRequest.status === "Pending";

                                    return (
                                        <article
                                            key={leaveRequest._id}
                                            data-status={profileUpgradeEnabled ? leaveRequest.status : undefined}
                                            className={[
                                                "profile-leave-request rounded-lg border border-white/10 bg-white/[0.04] p-4",
                                                editingLeaveRequestId === leaveRequest._id ? "ring-2 ring-[#842cff]/50" : "",
                                            ].join(" ")}
                                        >
                                            <div className="flex flex-wrap items-start justify-between gap-3">
                                                <div>
                                                    <p className="text-sm font-semibold text-white">{leaveRequest.leaveType} Leave</p>
                                                    <p className="mt-1 text-xs text-white/45">
                                                        {formatLeaveRequestDates(leaveRequest)}
                                                    </p>
                                                </div>
                                                <span className={`rounded-md border px-2 py-1 text-xs font-bold ${leaveStatusClass(leaveRequest.status)}`}>
                                                    {leaveRequest.status}
                                                </span>
                                            </div>
                                            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-white/65">{leaveRequest.reason}</p>
                                            {leaveThread.length > 0 && (
                                                <div className="mt-3 grid gap-2 rounded-lg border border-white/10 bg-black/20 p-3">
                                                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-white/35">Conversation</p>
                                                    {leaveThread.map((comment) => (
                                                        <div
                                                            key={comment._id || `${comment.authorType}-${comment.createdAt}`}
                                                            className={`flex ${comment.authorType === "Employee" ? "justify-end" : "justify-start"}`}
                                                        >
                                                            <div
                                                                className={[
                                                                    "max-w-[78%] rounded-2xl border p-3 shadow-sm",
                                                                    comment.authorType === "Employee"
                                                                        ? "rounded-br-md border-[#842cff]/40 bg-[#842cff] text-white"
                                                                        : "rounded-bl-md border-sky-300/20 bg-sky-400/10 text-white",
                                                                ].join(" ")}
                                                            >
                                                                <div className={`flex flex-wrap items-center gap-2 ${comment.authorType === "Employee" ? "justify-end" : "justify-start"}`}>
                                                                    <p className="text-xs font-bold text-white">{comment.authorName || comment.authorType}</p>
                                                                    <span className="rounded-md bg-white/20 px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.08em] !text-white">
                                                                        {comment.authorType}
                                                                    </span>
                                                                </div>
                                                                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 !text-white">{comment.message}</p>
                                                                <p className={comment.authorType === "Employee" ? "mt-1 text-right text-xs !text-white" : "mt-1 text-xs text-white/50"}>
                                                                    {formatPhDateTime(comment.createdAt)}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                            {isPending && (
                                                <div className="mt-3 grid gap-2">
                                                    <textarea
                                                        className="min-h-20 w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-white/25 focus:border-[#842cff]/60 focus:bg-white/[0.07]"
                                                        value={replyDraft}
                                                        onChange={(event) => updateLeaveReply(leaveRequest._id, event.target.value)}
                                                        placeholder="Reply to admin"
                                                    />
                                                    <div className="flex flex-wrap justify-end gap-2">
                                                        <button
                                                            className="inline-flex h-8 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                                                            type="button"
                                                            onClick={() => startEditLeaveRequest(leaveRequest)}
                                                        >
                                                            <FiEdit2 className="size-3.5" aria-hidden="true" />
                                                            Edit
                                                        </button>
                                                        <button
                                                            className="inline-flex h-8 items-center rounded-lg bg-white px-3 text-xs font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
                                                            type="button"
                                                            disabled={!replyDraft.trim() || replyLeaveRequestMutation.isPending}
                                                            onClick={() => replyLeaveRequestMutation.mutate({ requestId: leaveRequest._id, message: replyDraft })}
                                                        >
                                                            Send Reply
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                                                <p className="text-xs text-white/35">
                                                    Submitted {formatPhDateTime(leaveRequest.createdAt)}
                                                    {leaveRequest.updatedAt !== leaveRequest.createdAt ? ` · Updated ${formatPhDateTime(leaveRequest.updatedAt)}` : ""}
                                                    {leaveRequest.reviewedAt ? ` · Reviewed ${formatPhDateTime(leaveRequest.reviewedAt)}` : ""}
                                                </p>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        </section>
                    </div>
                ) : (
                    <section className="theme-surface-bg rounded-lg border border-white/10 p-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                                <FiBell className="size-4 text-[#b994ff]" aria-hidden="true" />
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Notices</p>
                                    <p className="mt-1 text-sm text-white/45">Admin-issued notices for {name}</p>
                                </div>
                            </div>
                            <button
                                className="h-9 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-white/65 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                                type="button"
                                disabled={!employeeId || unreadNoticeCount === 0 || markAllNoticesReadMutation.isPending}
                                onClick={() => markAllNoticesReadMutation.mutate()}
                            >
                                Mark all read
                            </button>
                        </div>

                        <div className="mt-5 max-h-[calc(100vh-19rem)] min-h-72 space-y-3 overflow-y-auto pr-2">
                            {noticesLoading && (
                                <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4 text-sm text-white/55">Loading notices...</div>
                            )}
                            {profileUpgradeEnabled && noticesError && <p role="alert">Notices could not load. Please refresh this page.</p>}
                            {!noticesLoading && notices.length === 0 && (!profileUpgradeEnabled || !noticesError) && (
                                <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                    <p className="text-sm font-semibold text-white">No notices issued</p>
                                    <p className="mt-1 text-sm text-white/45">Admin notices will appear here.</p>
                                </div>
                            )}
                            {notices.map((notice) => {
                                const isHighlightedNotice = highlightedNoticeId === notice._id;

                                return (
                                    <article
                                        key={notice._id}
                                        id={`notice-${notice._id}`}
                                        data-severity={profileUpgradeEnabled ? notice.severity : undefined}
                                        data-unread={profileUpgradeEnabled && !notice.isRead}
                                        className={[
                                            "profile-notice rounded-lg border bg-white/[0.04] p-4 transition",
                                            isHighlightedNotice
                                                ? "border-[#842cff] ring-2 ring-[#842cff]/35"
                                                : "border-white/10",
                                        ].join(" ")}
                                    >
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <p className="break-words text-sm font-semibold text-white">{notice.title}</p>
                                                    <span className={["rounded-md px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em]", notice.severity === "Critical" ? "bg-red-700 text-white" : notice.severity === "Warning" ? "bg-red-100 text-red-700" : "bg-sky-500/15 text-sky-200"].join(" ")}>
                                                        {notice.severity}
                                                    </span>
                                                    {!notice.isRead && <span className="rounded-md bg-[#842cff]/20 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-[#c9adff]">New</span>}
                                                    {notice.acknowledgedAt && <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-emerald-200">Acknowledged</span>}
                                                </div>
                                                <p className="mt-1 text-xs text-white/40">Issued by {notice.issuedBy} · {formatPhDateTime(notice.createdAt)}</p>
                                                {notice.acknowledgedAt && (
                                                    <p className="mt-1 text-xs text-emerald-200/70">Acknowledged {formatPhDateTime(notice.acknowledgedAt)}</p>
                                                )}
                                            </div>
                                            <div className="flex flex-wrap gap-2">
                                                {!notice.acknowledgedAt && (
                                                    <button
                                                        className="h-8 rounded-lg bg-emerald-400 px-3 text-xs font-semibold text-black transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
                                                        type="button"
                                                        disabled={acknowledgeNoticeMutation.isPending}
                                                        onClick={() => acknowledgeNoticeMutation.mutate(notice._id)}
                                                    >
                                                        Acknowledge
                                                    </button>
                                                )}
                                                {!notice.isRead && (
                                                    <button
                                                        className="h-8 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-white/65 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                                                        type="button"
                                                        disabled={markNoticeReadMutation.isPending}
                                                        onClick={() => markNoticeReadMutation.mutate(notice._id)}
                                                    >
                                                        Mark read
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-white/65">{notice.message}</p>
                                        {(notice.replies || []).length > 0 && (
                                            <div className="mt-4 space-y-2 rounded-lg border border-[#c8c3d3] bg-white/45 p-3">
                                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">Replies</p>
                                                {(notice.replies || []).map((reply) => (
                                                    <div key={reply._id || `${notice._id}-${reply.createdAt}`} className="rounded-lg border border-[#d8d3e2] bg-white/65 p-3">
                                                        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-900">{reply.message}</p>
                                                        <p className="mt-1 text-xs text-slate-500">{formatPhDateTime(reply.createdAt)}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        <div className="mt-4 grid gap-2">
                                            <textarea
                                                className={textareaClass}
                                                placeholder="Reply to this notice"
                                                value={noticeReplies[notice._id] || ""}
                                                onChange={(event) => updateNoticeReply(notice._id, event.target.value)}
                                            />
                                            <div className="flex justify-end">
                                                <button
                                                    className="h-9 rounded-lg bg-white px-3 text-xs font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
                                                    type="button"
                                                    disabled={replyNoticeMutation.isPending || !(noticeReplies[notice._id] || "").trim()}
                                                    onClick={() => replyNoticeMutation.mutate({ noticeId: notice._id, message: noticeReplies[notice._id] || "" })}
                                                >
                                                    Send reply
                                                </button>
                                            </div>
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    </section>
                )}
                </div>
            </section>
        </MainLayout>
    );
}

const EMPTY_QUERY_ROWS: [] = [];
