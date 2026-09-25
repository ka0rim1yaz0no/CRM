import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "react-router";
import { FiArchive, FiBriefcase, FiCalendar, FiCamera, FiCheck, FiChevronDown, FiChevronLeft, FiChevronRight, FiClock, FiDollarSign, FiEdit2, FiEye, FiHash, FiMail, FiMessageCircle, FiPhone, FiPlus, FiSearch, FiShield, FiTag, FiTrash2, FiUserCheck, FiX } from "react-icons/fi";
import AdminLayout from "../adminLayout";
import { getBusinesses } from "../../../api/businesses";
import { getActiveBusinessId } from "../../../api/businessStorage";
import {
    archiveEmployee as archiveEmployeeRequest,
    createEmployee,
    getEmployee,
    getEmployeeSummaries,
    normalizeEmployeeAvailabilityStatus,
    updateEmployee,
    type Employee,
    type EmployeeStatus,
    type EmployeeInput,
    type ContactRelationships,
} from "../../../api/employees";
import {
    createEmployeeNotice,
    deleteEmployeeNotice,
    getEmployeeNotices,
    updateEmployeeNotice,
    type Notice,
    type NoticeInput,
    type NoticeSeverity,
} from "../../../api/notices";
import {
    approveLeaveRequest,
    commentLeaveRequest,
    getEmployeeLeaveRequests,
    rejectLeaveRequest,
    type LeaveRequest,
} from "../../../api/leaveRequests";
import { getRoles } from "../../../api/roles";
import { getEmployeeAttendance, type AttendanceRecord } from "../../../api/attendance";
import { getEmployeeTransactions } from "../../../api/employeeTransactions";
import { getSystemSettings } from "../../../api/systemSettings";
import { getLeads, updateLead, type Lead, type LeadInput } from "../../../api/leads";
import { formatCurrency } from "../../../lib/currency";
import { formatCstDate, formatPhDate, formatPhDateTime, getCurrentCstDateInput, parseCstDateInput } from "../../../lib/dateTime";
import {
    ATTENDANCE_TIME_ZONE,
    formatAttendanceSlotKey,
    formatAttendanceSlotLabel,
    groupAttendanceRecordsBySlot,
    isWeekendAttendanceSlotKey,
    isAttendanceTimeOutUndertime,
} from "../../../lib/attendanceSlots";
import { buildOffPhoneAttendanceSessions, formatAttendanceDuration } from "../../../lib/attendanceRecords";
import { socket } from "../../../lib/socket";
import { DataTablePagination } from "../../../components/admin/DataTable";
import { useToast } from "../../../components/ToastProvider";
import { roleWorkspacePath } from "../../../lib/roleAccess";

const fallbackRoles = ["Sales Agent", "Team Lead", "Manager", "Support Agent"];
const employmentStatuses: EmployeeStatus[] = ["Active", "Training", "Paused", "Archived"];
const contactRelationship: ContactRelationships[] = ["Father", "Mother", "Sibling", "Spouse", "Relative", "Friend"];
const employeeStatusFilters = ["Active", "Archived", "All"] as const;
const noticeSeverities: NoticeSeverity[] = ["Info", "Warning", "Critical"];
const todayInputValue = getCurrentCstDateInput;
const employeeCodeCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
type EmployeeRecordTab = "details" | "hr" | "leads" | "notices" | "leave" | "attendance" | "transactions";
type AttendanceCalendarDay = {
    dateKey: string;
    label: string;
    dayNumber: number;
    records: AttendanceRecord[];
    hasTimeIn: boolean;
    hasTimeOut: boolean;
    isLate: boolean;
    isUnderTime: boolean;
    status: "late-present" | "ontime-present" | "undertime" | "overtime" | "absent" | "future";
};

function splitPhoneExtension(phone = "") {
    const match = phone.match(/^(.*?)\s*(?:ext\.?|extension)\s*[:.#-]?\s*(.+)$/i);
    return {
        number: (match ? match[1] : phone).trim(),
        extension: (match ? match[2] : "").trim(),
    };
}

function digitsOnly(value = "") {
    return value.replace(/\D/g, "");
}

function compareEmployeesByCode(first: Employee, second: Employee) {
    const firstCode = String(first.employeeCode || "").trim();
    const secondCode = String(second.employeeCode || "").trim();

    if (!firstCode && !secondCode) return first.name.localeCompare(second.name);
    if (!firstCode) return 1;
    if (!secondCode) return -1;

    const codeComparison = employeeCodeCollator.compare(firstCode, secondCode);
    return codeComparison || first.name.localeCompare(second.name);
}

function availabilityBadgeClass(value?: string) {
    const status = normalizeEmployeeAvailabilityStatus(value);

    if (status === "ONLINE") return "border-emerald-300 bg-emerald-50 text-emerald-700";
    if (status === "OFF THE PHONE") return "border-sky-300 bg-sky-50 text-sky-700";
    if (status === "BREAK" || status === "LUNCH") return "border-amber-300 bg-amber-50 text-amber-700";

    return "border-slate-300 bg-white text-slate-700";
}

function availabilityDotClass(value?: string) {
    const status = normalizeEmployeeAvailabilityStatus(value);

    if (status === "ONLINE") return "bg-emerald-500";
    if (status === "OFF THE PHONE") return "bg-sky-500";
    if (status === "BREAK" || status === "LUNCH") return "bg-amber-500";

    return "bg-slate-400";
}

function splitPhoneParts(phone = "") {
    const parsedPhone = splitPhoneExtension(phone);
    const digits = digitsOnly(parsedPhone.number);
    let areaCode = "";
    let operatorCode = "";
    let mobileNumber = "";

    if (digits.startsWith("63") && digits.length > 2) {
        areaCode = "63";
        operatorCode = digits.slice(2, 5);
        mobileNumber = digits.slice(5);
    } else if (digits.startsWith("1") && digits.length === 11) {
        areaCode = "1";
        operatorCode = digits.slice(1, 4);
        mobileNumber = digits.slice(4);
    } else if (digits.startsWith("0") && digits.length > 1) {
        areaCode = "63";
        operatorCode = digits.slice(1, 4);
        mobileNumber = digits.slice(4);
    } else if (digits.length > 10) {
        areaCode = digits.slice(0, 2);
        operatorCode = digits.slice(2, 5);
        mobileNumber = digits.slice(5);
    } else if (digits.length > 3) {
        operatorCode = digits.slice(0, 3);
        mobileNumber = digits.slice(3);
    } else {
        operatorCode = digits;
    }

    return {
        areaCode,
        operatorCode,
        mobileNumber,
        extension: digitsOnly(parsedPhone.extension),
    };
}

function formatPhoneWithExtension(areaCode: string, operatorCode: string, mobileNumber: string, extension: string) {
    const cleanNumber = [areaCode, operatorCode, mobileNumber].map((part) => part.trim()).filter(Boolean).join(" ");
    const cleanExtension = extension.trim();
    if (!cleanExtension) return cleanNumber;
    return `${cleanNumber} Ext. ${cleanExtension}`;
}

function toUnassignedLeadInput(lead: Lead): LeadInput {
    return {
        leadName: lead.leadName || "",
        position: lead.position || "",
        businessName: lead.businessName || "",
        businessAddress: lead.businessAddress || "",
        email: lead.email || "",
        phone: lead.phone || "",
        website: lead.website || "",
        source: lead.source || "Manual",
        category: lead.category || "",
        status: lead.status,
        assignedAgent: null,
        assignedAgentName: "",
        assignedTeam: lead.assignedTeam?._id || null,
        googlePlaceId: lead.googlePlaceId || "",
        notes: lead.notes || "",
        followUpAt: lead.followUpAt || null,
        followUpNote: lead.followUpNote || "",
        followUpPriority: lead.followUpPriority || 0,
        aiScore: lead.aiScore || 0,
        aiScoreReason: lead.aiScoreReason || "",
        aiScoreSource: lead.aiScoreSource || "",
        aiScoredAt: lead.aiScoredAt || null,
        activityActorName: "Admin",
        activityActorType: "admin",
    };
}

function formatPhoneForDisplay(phone = "") {
    const { operatorCode, mobileNumber, extension } = splitPhoneParts(phone);
    if (!operatorCode && !mobileNumber) return phone;

    const firstMobileGroup = mobileNumber.slice(0, 3);
    const remainingMobileGroup = mobileNumber.slice(3);
    const formattedMobile = [firstMobileGroup, remainingMobileGroup].filter(Boolean).join("-");
    const formattedNumber = [`(${operatorCode})`, formattedMobile].filter(Boolean).join(" ");

    return extension ? `${formattedNumber} Ext. ${extension}` : formattedNumber;
}

function phoneTelHref(phone = "") {
    const { areaCode, operatorCode, mobileNumber } = splitPhoneParts(phone);
    const cleanNumber = [areaCode, operatorCode, mobileNumber].filter(Boolean).join("");
    return cleanNumber ? `tel:+${cleanNumber}` : `tel:${phone}`;
}

function attendanceSourceLabel(source?: AttendanceRecord["source"]) {
    if (source === "Login" || source === "Time In") return "Time In";
    if (source === "Logout" || source === "Time Out") return "Time Out";
    if (source === "Break Out") return "Break";
    if (source === "Break In") return "Back Online";
    if (source === "Lunch Break Out") return "Lunch";
    if (source === "Lunch Break In") return "Back Online";
    if (source === "Off the Phone Out") return "Off the Phone";
    if (source === "Off the Phone In") return "Back on Phone";
    return source || "Attendance";
}

function attendanceStatusTone(status: AttendanceCalendarDay["status"]) {
    if (status === "late-present") return "border-rose-300 bg-rose-50 text-rose-700";
    if (status === "ontime-present") return "border-emerald-300 bg-emerald-50 text-emerald-700";
    if (status === "undertime") return "border-amber-300 bg-amber-50 text-amber-700";
    if (status === "overtime") return "border-violet-300 bg-violet-50 text-violet-700";
    return "border-slate-300 bg-white text-slate-600";
}

function attendancePresenceLabel(status: AttendanceCalendarDay["status"]) {
    if (status === "late-present") return "Late-Present";
    if (status === "ontime-present") return "Ontime-Present";
    if (status === "undertime") return "Undertime";
    if (status === "overtime") return "Overtime";
    if (status === "future") return "";
    return "Absent";
}

function attendanceDayStatuses(day: AttendanceCalendarDay) {
    if (day.status === "future") return [];
    if (day.isLate && day.isUnderTime) return ["late-present", "undertime"] as const;
    return [day.status];
}

function leaveRequestStatusClass(status: LeaveRequest["status"]) {
    if (status === "Approved") return "border-emerald-300 bg-emerald-50 text-emerald-700";
    if (status === "Rejected") return "border-rose-300 bg-rose-50 text-rose-700";
    return "border-amber-300 bg-amber-50 text-amber-700";
}

function formatLeaveRequestDateDisplay(leaveRequest: LeaveRequest) {
    const selectedDates = Array.from(new Set((leaveRequest.selectedDates || []).map((date) => formatPhDate(date)))).filter(Boolean);

    if (selectedDates.length === 1) {
        return selectedDates[0];
    }

    if (selectedDates.length > 1) {
        return `${selectedDates.length} dates · ${selectedDates[0]} - ${selectedDates[selectedDates.length - 1]}`;
    }

    return `${formatPhDate(leaveRequest.startDate)} - ${formatPhDate(leaveRequest.endDate)}`;
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

function makeMonthDays(monthStart: Date) {
    const firstGridDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 1));
    firstGridDay.setUTCDate(firstGridDay.getUTCDate() - firstGridDay.getUTCDay());

    return Array.from({ length: 42 }, (_, index) => {
        const date = new Date(firstGridDay);
        date.setUTCDate(firstGridDay.getUTCDate() + index);
        return date;
    });
}

function dateKeyFromUtcDate(date: Date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function dateKeyToUtcDate(dateKey: string) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}

function addDaysToDateKey(dateKey: string, days: number) {
    const date = dateKeyToUtcDate(dateKey);
    date.setUTCDate(date.getUTCDate() + days);
    return dateKeyFromUtcDate(date);
}

function getPhDateKey(value?: Date | string | null) {
    if (!value) return "";
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "";

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    return `${values.year}-${values.month}-${values.day}`;
}

function getDateKeysBetween(startDateKey: string, endDateKey: string) {
    if (!startDateKey || !endDateKey) return [];
    const start = startDateKey <= endDateKey ? startDateKey : endDateKey;
    const end = startDateKey <= endDateKey ? endDateKey : startDateKey;
    const dateKeys: string[] = [];
    let cursor = start;

    while (cursor <= end) {
        dateKeys.push(cursor);
        cursor = addDaysToDateKey(cursor, 1);
    }

    return dateKeys;
}

function getLeaveRequestDateKeys(leaveRequest: LeaveRequest) {
    const selectedDateKeys = Array.from(new Set((leaveRequest.selectedDates || []).map(getPhDateKey).filter(Boolean))).sort();

    if (selectedDateKeys.length > 0) {
        return selectedDateKeys;
    }

    return getDateKeysBetween(getPhDateKey(leaveRequest.startDate), getPhDateKey(leaveRequest.endDate));
}

function getMonthLabelFromDateKey(dateKey: string) {
    const date = dateKeyToUtcDate(`${dateKey.slice(0, 7)}-01`);
    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatDateKeyLabel(dateKey: string) {
    return formatPhDate(`${dateKey}T00:00:00+08:00`);
}

function LeaveRequestCalendar({ leaveRequest }: { leaveRequest: LeaveRequest }) {
    const selectedDateKeys = getLeaveRequestDateKeys(leaveRequest);
    const selectedDateSet = new Set(selectedDateKeys);
    const monthKeys = Array.from(new Set((selectedDateKeys.length ? selectedDateKeys : [getPhDateKey(leaveRequest.startDate)]).map((dateKey) => dateKey.slice(0, 7)))).filter(Boolean);

    return (
        <div className="grid gap-3">
            {monthKeys.map((monthKey) => {
                const [year, month] = monthKey.split("-").map(Number);
                const monthDays = makeMonthDays(new Date(Date.UTC(year, month - 1, 1)));

                return (
                    <div key={monthKey} className="overflow-hidden rounded-lg border border-slate-300 bg-white">
                        <div className="border-b border-slate-300 bg-slate-50 px-3 py-2">
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Calendar</p>
                            <p className="mt-1 text-sm font-semibold text-slate-950">{getMonthLabelFromDateKey(monthKey)}</p>
                        </div>
                        <div className="grid grid-cols-7 border-b border-slate-300 bg-slate-100 text-center text-[0.62rem] font-bold uppercase tracking-[0.1em] text-slate-500">
                            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                                <span key={day} className="py-2">{day}</span>
                            ))}
                        </div>
                        <div className="grid grid-cols-7">
                            {monthDays.map((date) => {
                                const dateKey = dateKeyFromUtcDate(date);
                                const isSelected = selectedDateSet.has(dateKey);
                                const isCurrentMonth = dateKey.slice(0, 7) === monthKey;

                                return (
                                    <div
                                        key={dateKey}
                                        className={[
                                            "flex min-h-11 items-center justify-center border-b border-r border-slate-200 p-1 text-xs font-semibold",
                                            isSelected
                                                ? "bg-[#842cff] text-white"
                                                : isCurrentMonth
                                                    ? "bg-white text-slate-700"
                                                    : "bg-slate-50 text-slate-300",
                                        ].join(" ")}
                                    >
                                        <span>{date.getUTCDate()}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            })}
            {selectedDateKeys.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {selectedDateKeys.map((dateKey) => (
                        <span key={dateKey} className="rounded-md border border-[#842cff]/25 bg-[#842cff]/10 px-2.5 py-1 text-xs font-semibold text-[#5f27cd]">
                            {formatDateKeyLabel(dateKey)}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

function employeeInitials(name = "") {
    return name
        .split(" ")
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
}

type CustomDropdownProps = {
    label: string;
    value?: string;
    placeholder?: string;
    onOpen: () => void;
    buttonRef: React.RefObject<HTMLButtonElement | null>;
};

function CustomDropdown({
    label,
    value,
    placeholder = "Select",
    onOpen,
    buttonRef,
}: CustomDropdownProps) {
    return (
        <div className="relative">
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{label}</span>
            <button
                ref={buttonRef}
                className="mt-2 flex h-11 w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 text-left text-sm font-semibold text-white outline-none transition hover:bg-white/[0.04] focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                type="button"
                onClick={onOpen}
            >
                <span className={value ? "text-white" : "text-white/35"}>{value || placeholder}</span>
                <FiChevronDown className="size-4 shrink-0 text-white/45" aria-hidden="true" />
            </button>
        </div>
    );
}

export default function AdminEmployees() {
    const roleButtonRef = useRef<HTMLButtonElement>(null);
    const departmentButtonRef = useRef<HTMLButtonElement>(null);
    const statusButtonRef = useRef<HTMLButtonElement>(null);
    const statusButtonRel = useRef<HTMLButtonElement>(null);
    const phoneOperatorCodeRef = useRef<HTMLInputElement>(null);
    const phoneMobileNumberRef = useRef<HTMLInputElement>(null);
    const phoneExtensionRef = useRef<HTMLInputElement>(null);
    const profileImageInputRef = useRef<HTMLInputElement>(null);
    const dropdownMenuRef = useRef<HTMLDivElement>(null);
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const location = useLocation();
    const { employeeId } = useParams<{ employeeId?: string }>();
    const isEmployeeEditPage = Boolean(employeeId && location.pathname.endsWith("/edit"));
    const isEmployeeDetailPage = Boolean(employeeId && !isEmployeeEditPage);
    const isEmployeeRoutePage = Boolean(employeeId);
    const { showToast } = useToast();

    const { data: employees = [], isLoading, isError } = useQuery({
        queryKey: ["employees", "include-archived"],
        queryFn: () => getEmployeeSummaries({ includeArchived: true }),
    });
    const { data: roleRecords = [] } = useQuery({
        queryKey: ["roles"],
        queryFn: getRoles,
    });
    const { data: businesses = [] } = useQuery({
        queryKey: ["businesses"],
        queryFn: getBusinesses,
        staleTime: Number.POSITIVE_INFINITY,
    });
    const { data: systemSettings } = useQuery({
        queryKey: ["system-settings"],
        queryFn: getSystemSettings,
    });
    const {
        data: routedEmployee,
        isLoading: isLoadingRoutedEmployee,
        isError: isRoutedEmployeeError,
    } = useQuery({
        queryKey: ["employee", employeeId],
        queryFn: () => getEmployee(employeeId || ""),
        enabled: Boolean(employeeId),
    });
    const [modalMode, setModalMode] = useState<"add" | "edit">("add");
    const [editingEmployeeId, setEditingEmployeeId] = useState<string | null>(null);
    const [viewingEmployee, setViewingEmployee] = useState<Employee | null>(null);
    const [employeeRecordTab, setEmployeeRecordTab] = useState<EmployeeRecordTab>("details");
    const [selectedAttendanceDateKey, setSelectedAttendanceDateKey] = useState("");
    const [attendanceMonthOffset, setAttendanceMonthOffset] = useState(0);
    const [transactionDate, setTransactionDate] = useState(todayInputValue);
    const [noticeForm, setNoticeForm] = useState<NoticeInput>({
        title: "",
        message: "",
        severity: "Info",
        issuedBy: "Admin",
    });
    const [editingNoticeId, setEditingNoticeId] = useState<string | null>(null);
    const [leaveReviewNotes, setLeaveReviewNotes] = useState<Record<string, string>>({});
    const [employeeLeadSearch, setEmployeeLeadSearch] = useState("");
    const [selectedEmployeeLeadIds, setSelectedEmployeeLeadIds] = useState<string[]>([]);
    const [archiveTarget, setArchiveTarget] = useState<{ employee: Employee; id: string } | null>(null);
    const [openDropdown, setOpenDropdown] = useState<"role" | "department" | "status" | "contactRelationship" | null>(null);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [roleSearch, setRoleSearch] = useState("");
    const [employeeStatusFilter, setEmployeeStatusFilter] = useState<(typeof employeeStatusFilters)[number]>("Active");
    const [phoneOperatorCode, setPhoneOperatorCode] = useState("");
    const [phoneMobileNumber, setPhoneMobileNumber] = useState("");
    const [phoneExtension, setPhoneExtension] = useState("");
    const [profileImageChanged, setProfileImageChanged] = useState(false);
    const [newEmployee, setNewEmployee] = useState<EmployeeInput>({
        name: "",
        dateHired: "",
        employeeCode: "",
        aliases: [],
        role: "Sales Agent",
        team: "Unassigned",
        company: "Assistly",
        email: "",
        phone: "",
        profileImage: "",
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
        bankRoutingNumber: "",
        salary: 0,
        status: "Active",
        availabilityStatus: "OFFLINE",
        businessAccessIds: getActiveBusinessId() ? [getActiveBusinessId()] : [],
    });
    const { data: viewingEmployeeDetails, isFetching: isFetchingViewingEmployee } = useQuery({
        queryKey: ["employee", viewingEmployee?._id],
        queryFn: () => getEmployee(viewingEmployee?._id || ""),
        enabled: Boolean(viewingEmployee?._id),
    });

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

    const departmentOptions = Array.from(
        new Set([newEmployee.team, ...roleRecords.map((role) => role.department || "General"), "Unassigned", "General", "Sales", "Operations", "Support"].filter(Boolean))
    );

    const dropdownConfigs = {
        role: {
            value: newEmployee.role,
            options: roleRecords.length ? roleRecords.map((role) => role.name) : fallbackRoles,
            searchable: true,
            search: roleSearch,
            buttonRef: roleButtonRef,
            onSearch: setRoleSearch,
            onChange: (role: string) => {
                const matchedRole = roleRecords.find((roleRecord) => roleRecord.name === role);
                setNewEmployee((employee) => ({
                    ...employee,
                    role,
                    team: matchedRole?.department || employee.team || "Unassigned",
                }));
                setRoleSearch("");
                setOpenDropdown(null);
            },
        },
        department: {
            value: newEmployee.team,
            options: departmentOptions.length ? departmentOptions : ["General", "Sales", "Operations", "Support"],
            searchable: false,
            search: "",
            buttonRef: departmentButtonRef,
            onSearch: () => undefined,
            onChange: (department: string) => {
                setNewEmployee((employee) => ({ ...employee, team: department }));
                setOpenDropdown(null);
            },
        },
        status: {
            value: newEmployee.status,
            options: employmentStatuses,
            searchable: false,
            search: "",
            buttonRef: statusButtonRef,
            onSearch: () => undefined,
            onChange: (status: string) => {
                setNewEmployee((employee) => ({ ...employee, status: status as EmployeeStatus }));
                setOpenDropdown(null);
            },
        },
        contactRelationship: {
            value: newEmployee.contactRelationship,
            options: contactRelationship,
            searchable: false,
            search: "",
            buttonRef: statusButtonRel,
            onSearch: () => undefined,
            onChange: (status: string) => {
                setNewEmployee((employee) => ({ ...employee, contactRelationship: status as ContactRelationships }));
                setOpenDropdown(null);
            },
        },
    };

    const activeDropdown = openDropdown ? dropdownConfigs[openDropdown] : null;
    const activeDropdownOptions = activeDropdown
        ? activeDropdown.options.filter((option) => option.toLowerCase().includes(activeDropdown.search.toLowerCase()))
        : [];

    const activeEmployees = useMemo(() => employees.filter((employee) => employee.status !== "Archived"), [employees]);
    const archivedEmployees = useMemo(() => employees.filter((employee) => employee.status === "Archived"), [employees]);
    const filteredEmployees = useMemo(
        () => employees
            .filter((employee) => {
                if (employeeStatusFilter === "Archived") return employee.status === "Archived";
                if (employeeStatusFilter === "Active") return employee.status !== "Archived";
                return employee.status !== "Archived";
            })
            .sort(compareEmployeesByCode),
        [employeeStatusFilter, employees]
    );
    const money = (value = 0) => formatCurrency(value, systemSettings?.currencyCode || "USD");
    const activeDepartmentCount = useMemo(() => new Set(activeEmployees.map((employee) => employee.team).filter(Boolean)).size, [activeEmployees]);
    const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / pageSize));
    const safePage = Math.min(page, totalPages);
    const paginatedEmployees = useMemo(() => filteredEmployees.slice((safePage - 1) * pageSize, safePage * pageSize), [filteredEmployees, pageSize, safePage]);
    const employeeLeadNames = useMemo(
        () =>
            viewingEmployee
                ? Array.from(new Set([viewingEmployee.name, viewingEmployee.employeeCode, ...(viewingEmployee.aliases || [])].map((value) => value.trim()).filter(Boolean)))
                : [],
        [viewingEmployee],
    );
    const { data: employeeNotices = [] } = useQuery({
        queryKey: ["employee-notices", viewingEmployee?._id],
        queryFn: () => getEmployeeNotices(viewingEmployee?._id || ""),
        enabled: Boolean(viewingEmployee?._id && employeeRecordTab === "notices"),
    });
    const { data: employeeLeaveRequests = [], isLoading: isLoadingEmployeeLeaveRequests } = useQuery({
        queryKey: ["employee-leave-requests", viewingEmployee?._id],
        queryFn: () => getEmployeeLeaveRequests(viewingEmployee?._id || ""),
        enabled: Boolean(viewingEmployee?._id && employeeRecordTab === "leave"),
    });
    const pendingEmployeeLeaveCount = employeeLeaveRequests.filter((leaveRequest) => leaveRequest.status === "Pending").length;
    const { data: employeeLeads = [], isLoading: isLoadingEmployeeLeads } = useQuery({
        queryKey: ["employee-leads", viewingEmployee?._id, employeeLeadNames.join("|")],
        queryFn: () => getLeads({ assignedAgent: viewingEmployee?._id || "", assignedAgentNames: employeeLeadNames }),
        enabled: Boolean(viewingEmployee?._id && employeeRecordTab === "leads"),
    });
    const { data: employeeAttendance = [] } = useQuery({
        queryKey: ["employee-attendance", viewingEmployee?._id],
        queryFn: () => getEmployeeAttendance(viewingEmployee?._id || ""),
        enabled: Boolean(viewingEmployee?._id && employeeRecordTab === "attendance"),
    });
    const employeeAttendanceSettings = useMemo(
        () => ({ ...systemSettings, attendanceTimeZone: ATTENDANCE_TIME_ZONE }),
        [systemSettings],
    );
    const attendanceMonthStart = useMemo(() => {
        const currentSlotKey = formatAttendanceSlotKey(new Date(), employeeAttendanceSettings);
        const [year, month] = currentSlotKey.split("-").map(Number);
        return new Date(Date.UTC(year, month - 1 + attendanceMonthOffset, 1));
    }, [attendanceMonthOffset, employeeAttendanceSettings]);
    const attendanceCalendarDays = useMemo<AttendanceCalendarDay[]>(() => {
        const settings = employeeAttendanceSettings;
        const grouped = groupAttendanceRecordsBySlot(employeeAttendance, settings);
        const monthDays = makeMonthDays(attendanceMonthStart);
        const todayDateKey = formatAttendanceSlotKey(new Date(), settings);

        return monthDays.map((date) => {
            const dateKey = dateKeyFromUtcDate(date);
            const records = [...(grouped[dateKey] || [])].sort((first, second) => new Date(first.timeIn).getTime() - new Date(second.timeIn).getTime());
            const timeInRecord = records.find((record) => record.source === "Login" || record.source === "Time In");
            const timeOutRecord = [...records].reverse().find((record) => record.source === "Logout" || record.source === "Time Out");
            const isWeekendSlot = isWeekendAttendanceSlotKey(dateKey);
            const hasTimeIn = Boolean(timeInRecord);
            const hasTimeOut = Boolean(timeOutRecord);
            const isLate = timeInRecord?.attendanceStatus === "Late";
            const isUnderTime = Boolean(timeInRecord && timeOutRecord && isAttendanceTimeOutUndertime(timeOutRecord, settings));
            const status: AttendanceCalendarDay["status"] = timeInRecord
                ? isUnderTime
                    ? "undertime"
                    : isWeekendSlot
                    ? "overtime"
                    : isLate
                        ? "late-present"
                        : "ontime-present"
                : dateKey > todayDateKey
                    ? "future"
                    : "absent";

            return {
                dateKey,
                label: formatAttendanceSlotLabel(dateKey),
                dayNumber: date.getUTCDate(),
                records,
                hasTimeIn,
                hasTimeOut,
                isLate,
                isUnderTime,
                status,
            };
        });
    }, [attendanceMonthStart, employeeAttendance, employeeAttendanceSettings]);
    const selectedAttendanceDay = useMemo(
        () =>
            attendanceCalendarDays.find((day) => day.dateKey === selectedAttendanceDateKey) ||
            attendanceCalendarDays.find((day) => day.dateKey === formatAttendanceSlotKey(new Date(), employeeAttendanceSettings)) ||
            attendanceCalendarDays.find((day) => day.records.length > 0) ||
            attendanceCalendarDays[0],
        [attendanceCalendarDays, employeeAttendanceSettings, selectedAttendanceDateKey],
    );
    const selectedAttendanceOffPhoneSessions = useMemo(
        () => buildOffPhoneAttendanceSessions(selectedAttendanceDay?.records || []),
        [selectedAttendanceDay],
    );
    const { data: employeeTransactions = [] } = useQuery({
        queryKey: ["employee-transactions", viewingEmployee?._id, transactionDate],
        queryFn: () => getEmployeeTransactions(viewingEmployee?._id || "", transactionDate),
        enabled: Boolean(viewingEmployee?._id && employeeRecordTab === "transactions"),
    });
    const normalizedEmployeeLeadSearch = employeeLeadSearch.trim().toLowerCase();
    const filteredEmployeeLeads = employeeLeads.filter((lead) => {
        if (!normalizedEmployeeLeadSearch) return true;

        return [
            lead.leadName,
            lead.businessName,
            lead.category,
            lead.status,
            lead.source,
            lead.assignedAgentName,
            lead.assignedAgent?.name,
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(normalizedEmployeeLeadSearch);
    });
    const selectedEmployeeLeads = employeeLeads.filter((lead) => selectedEmployeeLeadIds.includes(lead._id));
    const visibleEmployeeLeadIds = filteredEmployeeLeads.map((lead) => lead._id);
    const areAllVisibleEmployeeLeadsSelected =
        visibleEmployeeLeadIds.length > 0 && visibleEmployeeLeadIds.every((leadId) => selectedEmployeeLeadIds.includes(leadId));

    const invalidateEmployees = () => {
        queryClient.invalidateQueries({ queryKey: ["employees"] });
    };

    const createEmployeeMutation = useMutation({
        mutationFn: createEmployee,
        onSuccess: (_createdEmployee, employee) => {
            invalidateEmployees();
            setEmployeeStatusFilter(employee.status === "Archived" ? "Archived" : "Active");
            closeEmployeeModal();
        },
    });

    const updateEmployeeMutation = useMutation({
        mutationFn: ({ id, employee }: { id: string; employee: EmployeeInput }) => updateEmployee(id, employee),
        onSuccess: (employee) => {
            invalidateEmployees();
            queryClient.setQueryData(["employee", employee._id], employee);
            setViewingEmployee((current) => (current?._id === employee._id ? employee : current));
        },
    });

    const unassignLeadMutation = useMutation({
        mutationFn: (lead: Lead) => updateLead(lead._id, toUnassignedLeadInput(lead)),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["employee-leads"] });
            queryClient.invalidateQueries({ queryKey: ["admin-leads"] });
            queryClient.invalidateQueries({ queryKey: ["leads"] });
            showToast({ tone: "success", message: "Lead moved to Unassigned." });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not unassign lead." });
        },
    });

    const bulkUnassignLeadsMutation = useMutation({
        mutationFn: (leads: Lead[]) => Promise.all(leads.map((lead) => updateLead(lead._id, toUnassignedLeadInput(lead)))),
        onSuccess: (_updatedLeads, leads) => {
            setSelectedEmployeeLeadIds([]);
            queryClient.invalidateQueries({ queryKey: ["employee-leads"] });
            queryClient.invalidateQueries({ queryKey: ["admin-leads"] });
            queryClient.invalidateQueries({ queryKey: ["leads"] });
            showToast({ tone: "success", message: `${leads.length} lead${leads.length === 1 ? "" : "s"} moved to Unassigned.` });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not unassign selected leads." });
        },
    });

    const archiveEmployeeMutation = useMutation({
        mutationFn: archiveEmployeeRequest,
        onSuccess: (employee) => {
            invalidateEmployees();
            queryClient.setQueryData(["employee", employee._id], employee);
            setArchiveTarget(null);
            setEmployeeStatusFilter("Archived");
            setViewingEmployee((current) => (current?._id === employee._id ? employee : current));
            showToast({ tone: "success", message: "Employee archived." });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not archive employee." });
        },
    });

    const createNoticeMutation = useMutation({
        mutationFn: ({ employeeId, notice }: { employeeId: string; notice: NoticeInput }) =>
            createEmployeeNotice(employeeId, notice),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["employee-notices", viewingEmployee?._id] });
            setNoticeForm({ title: "", message: "", severity: "Info", issuedBy: "Admin" });
            setEditingNoticeId(null);
        },
    });

    const updateNoticeMutation = useMutation({
        mutationFn: ({ employeeId, noticeId, notice }: { employeeId: string; noticeId: string; notice: NoticeInput }) =>
            updateEmployeeNotice(employeeId, noticeId, notice),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["employee-notices", viewingEmployee?._id] });
            setNoticeForm({ title: "", message: "", severity: "Info", issuedBy: "Admin" });
            setEditingNoticeId(null);
            showToast({ tone: "success", message: "Notice updated." });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not update notice." });
        },
    });

    const deleteNoticeMutation = useMutation({
        mutationFn: ({ employeeId, noticeId }: { employeeId: string; noticeId: string }) =>
            deleteEmployeeNotice(employeeId, noticeId),
        onSuccess: (_result, variables) => {
            queryClient.invalidateQueries({ queryKey: ["employee-notices", viewingEmployee?._id] });
            if (editingNoticeId === variables.noticeId) {
                setEditingNoticeId(null);
                setNoticeForm({ title: "", message: "", severity: "Info", issuedBy: "Admin" });
            }
            showToast({ tone: "success", message: "Notice deleted." });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not delete notice." });
        },
    });

    const invalidateEmployeeLeaveRequests = () => {
        queryClient.invalidateQueries({ queryKey: ["employee-leave-requests", viewingEmployee?._id] });
        queryClient.invalidateQueries({ queryKey: ["leave-requests"] });
    };

    const approveLeaveMutation = useMutation({
        mutationFn: ({ id, adminNote }: { id: string; adminNote: string }) => approveLeaveRequest(id, adminNote),
        onSuccess: (_leaveRequest, variables) => {
            setLeaveReviewNotes((notes) => ({ ...notes, [variables.id]: "" }));
            invalidateEmployeeLeaveRequests();
            showToast({ tone: "success", message: "Leave request approved." });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not approve leave request." });
        },
    });

    const commentLeaveMutation = useMutation({
        mutationFn: ({ id, adminNote }: { id: string; adminNote: string }) => commentLeaveRequest(id, adminNote),
        onSuccess: (_leaveRequest, variables) => {
            setLeaveReviewNotes((notes) => ({ ...notes, [variables.id]: "" }));
            invalidateEmployeeLeaveRequests();
            showToast({ tone: "success", message: "Comment sent to employee." });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not send comment." });
        },
    });

    const rejectLeaveMutation = useMutation({
        mutationFn: ({ id, adminNote }: { id: string; adminNote: string }) => rejectLeaveRequest(id, adminNote),
        onSuccess: (_leaveRequest, variables) => {
            setLeaveReviewNotes((notes) => ({ ...notes, [variables.id]: "" }));
            invalidateEmployeeLeaveRequests();
            showToast({ tone: "success", message: "Leave request rejected." });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not reject leave request." });
        },
    });

    const resetEmployeeForm = () => {
        setNewEmployee({
            name: "",
            dateHired: "",
            employeeCode: "",
            aliases: [],
            role: "Sales Agent",
            team: "Unassigned",
            company: "Assistly",
            email: "",
            phone: "",
            profileImage: "",
            personalPhone: "",
            personalEmail: "",
            personalAddress: "",
            emergencyContact: "",
            personalNotes: "",
            bankName: "",
            bankAccountName: "",
            bankAccountNumber: "",
            bankRoutingNumber: "",
            salary: 0,
            status: "Active",
            availabilityStatus: "OFFLINE",
            businessAccessIds: getActiveBusinessId() ? [getActiveBusinessId()] : [],
        });
        setEditingEmployeeId(null);
        setModalMode("add");
        setOpenDropdown(null);
        setRoleSearch("");
        setPhoneOperatorCode("");
        setPhoneMobileNumber("");
        setPhoneExtension("");
        setProfileImageChanged(false);
    };

    const openAddEmployeePage = () => {
        navigate(roleWorkspacePath("/admin/employees/new"));
    };

    const loadEmployeeDetails = (employee: Employee) =>
        queryClient.fetchQuery({
            queryKey: ["employee", employee._id],
            queryFn: () => getEmployee(employee._id),
            staleTime: 30_000,
        });

    const openEditEmployeePage = (employee: Employee) => {
        navigate(roleWorkspacePath(`/admin/employees/${employee._id}/edit`));
    };

    const archiveEmployee = (id: string) => {
        archiveEmployeeMutation.mutate(id);
    };

    const openArchiveConfirm = (employee: Employee) => {
        setArchiveTarget({ employee, id: employee._id });
    };

    const closeEmployeeModal = () => {
        resetEmployeeForm();
    };

    const handleSaveEmployee = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const employeePayload: EmployeeInput = {
            ...newEmployee,
            dateHired: newEmployee.dateHired,
            phone: formatPhoneWithExtension(phoneOperatorCode || phoneMobileNumber ? "63" : "", phoneOperatorCode, phoneMobileNumber, phoneExtension),
        };

        if (editingEmployeeId) {
            if (!profileImageChanged) {
                delete employeePayload.profileImage;
            }

            updateEmployeeMutation.mutate(
                { id: editingEmployeeId, employee: employeePayload },
                {
                    onSuccess: (employee) => {
                        if (isEmployeeEditPage) {
                            navigate(roleWorkspacePath(`/admin/employees/${employee._id}`));
                            return;
                        }

                        closeEmployeeModal();
                    },
                }
            );
        } else {
            createEmployeeMutation.mutate(employeePayload);
        }
    };

    const updateEmployeeForm = <Field extends keyof EmployeeInput>(field: Field, value: EmployeeInput[Field]) => {
        setNewEmployee((employee) => ({ ...employee, [field]: value }));
    };

    const toggleBusinessAccess = (businessId: string) => {
        setNewEmployee((employee) => {
            const selectedBusinessIds = new Set(employee.businessAccessIds || []);

            if (selectedBusinessIds.has(businessId)) {
                selectedBusinessIds.delete(businessId);
            } else {
                selectedBusinessIds.add(businessId);
            }

            const activeBusinessId = getActiveBusinessId();
            if (activeBusinessId) {
                selectedBusinessIds.add(activeBusinessId);
            }

            return { ...employee, businessAccessIds: Array.from(selectedBusinessIds) };
        });
    };

    console.log(newEmployee)

    const syncPhoneForm = (operatorCode: string, mobileNumber: string, extension = phoneExtension) => {
        const areaCode = operatorCode || mobileNumber ? "63" : "";
        updateEmployeeForm("phone", formatPhoneWithExtension(areaCode, operatorCode, mobileNumber, extension));
    };

    const focusNextPhoneInput = (ref: RefObject<HTMLInputElement | null>) => {
        window.requestAnimationFrame(() => {
            ref.current?.focus();
            ref.current?.setSelectionRange(ref.current.value.length, ref.current.value.length);
        });
    };

    const updatePhoneSegment = (segment: "operator" | "mobile", value: string) => {
        const digits = digitsOnly(value);
        let nextOperatorCode = phoneOperatorCode;
        let nextMobileNumber = phoneMobileNumber;

        if (segment === "operator") {
            const normalizedDigits = digits.startsWith("63") && digits.length > 3 ? digits.slice(2) : digits.startsWith("0") && digits.length > 1 ? digits.slice(1) : digits;
            nextOperatorCode = normalizedDigits.slice(0, 3);
            const overflow = normalizedDigits.slice(3);
            if (overflow) {
                nextMobileNumber = overflow;
            }
            if (normalizedDigits.length >= 3) {
                focusNextPhoneInput(phoneMobileNumberRef);
            }
        }

        if (segment === "mobile") {
            nextMobileNumber = digits;
        }

        setPhoneOperatorCode(nextOperatorCode);
        setPhoneMobileNumber(nextMobileNumber);
        syncPhoneForm(nextOperatorCode, nextMobileNumber);
    };

    const handlePhoneSegmentKeyDown = (
        event: KeyboardEvent<HTMLInputElement>,
        nextRef?: RefObject<HTMLInputElement | null>,
        previousRef?: RefObject<HTMLInputElement | null>,
    ) => {
        if (event.key === "Enter" && nextRef) {
            event.preventDefault();
            focusNextPhoneInput(nextRef);
        }

        if (event.key === "Backspace" && !event.currentTarget.value && previousRef) {
            event.preventDefault();
            focusNextPhoneInput(previousRef);
        }
    };

    const updateEmployeeStatus = async (employee: Employee, status: EmployeeStatus) => {
        const employeeDetails = await loadEmployeeDetails(employee).catch(() => null);
        if (!employeeDetails) {
            showToast({ tone: "error", message: "Could not load employee details before updating status." });
            return;
        }

        updateEmployeeMutation.mutate({
            id: employeeDetails._id,
            employee: {
                name: employeeDetails.name,
                dateHired: employeeDetails.dateHired,
                terminationDate: employeeDetails.terminationDate,
                employeeCode: employeeDetails.employeeCode,
                aliases: employeeDetails.aliases || [],
                role: employeeDetails.role,
                team: employeeDetails.team,
                company: employeeDetails.company || "Assistly",
                email: employeeDetails.email,
                phone: employeeDetails.phone,
                personalPhone: employeeDetails.personalPhone || "",
                personalEmail: employeeDetails.personalEmail || "",
                personalAddress: employeeDetails.personalAddress || "",
                emergencyContact: employeeDetails.emergencyContact || "",
                contactRelationship: employeeDetails.contactRelationship || "Father",
                emergencyContactNumber: employeeDetails.emergencyContactNumber || "",
                personalNotes: employeeDetails.personalNotes || "",
                bankName: employeeDetails.bankName || "",
                bankAccountName: employeeDetails.bankAccountName || "",
                bankAccountNumber: employeeDetails.bankAccountNumber || "",
                bankRoutingNumber: employeeDetails.bankRoutingNumber || "",
                salary: employeeDetails.salary || 0,
                status,
                availabilityStatus: normalizeEmployeeAvailabilityStatus(employeeDetails.availabilityStatus),
                businessAccessIds: employeeDetails.businessAccessIds?.length
                    ? employeeDetails.businessAccessIds
                    : getActiveBusinessId()
                        ? [getActiveBusinessId()]
                        : [],
            },
        });
    };

    const updateProfileImage = (file: File | undefined) => {
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            showToast({ tone: "error", message: "Choose a valid image file." });
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            updateEmployeeForm("profileImage", String(reader.result || ""));
            setProfileImageChanged(true);
        };
        reader.readAsDataURL(file);
    };

    const handleIssueNotice = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!viewingEmployee || !noticeForm.title.trim() || !noticeForm.message.trim()) {
            return;
        }

        if (editingNoticeId) {
            updateNoticeMutation.mutate({ employeeId: viewingEmployee._id, noticeId: editingNoticeId, notice: noticeForm });
            return;
        }

        createNoticeMutation.mutate({ employeeId: viewingEmployee._id, notice: noticeForm });
    };

    const startEditNotice = (notice: Notice) => {
        setEditingNoticeId(notice._id);
        setNoticeForm({
            title: notice.title,
            message: notice.message,
            severity: notice.severity,
            issuedBy: notice.issuedBy || "Admin",
        });
    };

    const cancelEditNotice = () => {
        setEditingNoticeId(null);
        setNoticeForm({ title: "", message: "", severity: "Info", issuedBy: "Admin" });
    };

    const toggleEmployeeLeadSelection = (leadId: string) => {
        setSelectedEmployeeLeadIds((currentIds) =>
            currentIds.includes(leadId)
                ? currentIds.filter((selectedLeadId) => selectedLeadId !== leadId)
                : [...currentIds, leadId],
        );
    };

    const toggleAllVisibleEmployeeLeads = () => {
        setSelectedEmployeeLeadIds((currentIds) => {
            if (areAllVisibleEmployeeLeadsSelected) {
                return currentIds.filter((leadId) => !visibleEmployeeLeadIds.includes(leadId));
            }

            return Array.from(new Set([...currentIds, ...visibleEmployeeLeadIds]));
        });
    };

    const unassignSelectedEmployeeLeads = () => {
        if (selectedEmployeeLeads.length === 0) return;
        bulkUnassignLeadsMutation.mutate(selectedEmployeeLeads);
    };

    const confirmDeleteNotice = (noticeId: string) => {
        if (!viewingEmployee) return;

        const shouldDelete = window.confirm("Delete this notice? This cannot be undone.");
        if (!shouldDelete) return;

        deleteNoticeMutation.mutate({
            employeeId: viewingEmployee._id,
            noticeId,
        });
    };

    const openEmployeeView = (employee: Employee) => {
        navigate(roleWorkspacePath(`/admin/employees/${employee._id}`));
    };

    useEffect(() => {
        if (!routedEmployee) return;

        if (isEmployeeDetailPage) {
            const requestedTab = new URLSearchParams(location.search).get("tab");
            setViewingEmployee(routedEmployee);
            setEmployeeRecordTab(requestedTab === "attendance" ? "attendance" : "details");
            setSelectedAttendanceDateKey("");
            setAttendanceMonthOffset(0);
            setTransactionDate(todayInputValue());
            setLeaveReviewNotes({});
            cancelEditNotice();
        }

        if (isEmployeeEditPage) {
            const parsedPhone = splitPhoneParts(routedEmployee.phone);
            const employeeDetails = { ...routedEmployee } as EmployeeInput & { _id?: string; __v?: number };
            delete employeeDetails._id;
            delete employeeDetails.__v;
            setNewEmployee({
                ...employeeDetails,
                aliases: routedEmployee.aliases || [],
                salary: routedEmployee.salary || 0,
                businessAccessIds: routedEmployee.businessAccessIds?.length
                    ? routedEmployee.businessAccessIds
                    : getActiveBusinessId()
                        ? [getActiveBusinessId()]
                        : [],
            });
            setPhoneOperatorCode(parsedPhone.operatorCode);
            setPhoneMobileNumber(parsedPhone.mobileNumber);
            setPhoneExtension(parsedPhone.extension);
            setEditingEmployeeId(routedEmployee._id);
            setProfileImageChanged(false);
            setModalMode("edit");
            setOpenDropdown(null);
        }
    }, [isEmployeeDetailPage, isEmployeeEditPage, location.search, routedEmployee]);

    useEffect(() => {
        if (!isEmployeeRoutePage || isEmployeeDetailPage) {
            setEditingEmployeeId(null);
            setOpenDropdown(null);
        }

        if (!isEmployeeRoutePage) {
            setViewingEmployee(null);
        }
    }, [isEmployeeDetailPage, isEmployeeRoutePage]);

    useEffect(() => {
        if (!viewingEmployeeDetails) return;
        setViewingEmployee((currentEmployee) =>
            currentEmployee?._id === viewingEmployeeDetails._id
                ? { ...currentEmployee, ...viewingEmployeeDetails }
                : currentEmployee,
        );
    }, [viewingEmployeeDetails]);

    useEffect(() => {
        setPage((currentPage) => Math.min(currentPage, totalPages));
    }, [totalPages]);

    useEffect(() => {
        socket.connect();

        const handleAvailabilityUpdate = (payload: { employeeId: string; availabilityStatus: Employee["availabilityStatus"] }) => {
            const availabilityStatus = normalizeEmployeeAvailabilityStatus(payload.availabilityStatus);
            queryClient.setQueryData<Employee[]>(["employees"], (currentEmployees = []) =>
                currentEmployees.map((employee) =>
                    employee._id === payload.employeeId
                        ? { ...employee, availabilityStatus }
                        : employee,
                ),
            );
            setViewingEmployee((currentEmployee) =>
                currentEmployee?._id === payload.employeeId
                    ? { ...currentEmployee, availabilityStatus }
                    : currentEmployee,
            );
        };

        socket.on("employee:availability-updated", handleAvailabilityUpdate);

        return () => {
            socket.off("employee:availability-updated", handleAvailabilityUpdate);
        };
    }, [queryClient]);

    useEffect(() => {
        setEmployeeLeadSearch("");
        setSelectedEmployeeLeadIds([]);
    }, [viewingEmployee?._id, employeeRecordTab]);

    useEffect(() => {
        const employeeLeadIds = new Set(employeeLeads.map((lead) => lead._id));
        setSelectedEmployeeLeadIds((currentIds) => {
            const nextIds = currentIds.filter((leadId) => employeeLeadIds.has(leadId));
            return nextIds.length === currentIds.length ? currentIds : nextIds;
        });
    }, [employeeLeads]);

    useEffect(() => {
        if (!openDropdown) return;

        const handleOutsideClick = (event: globalThis.MouseEvent) => {
            const target = event.target as Node | null;
            const activeButton = activeDropdown?.buttonRef.current;
            if (!target || activeButton?.contains(target) || dropdownMenuRef.current?.contains(target)) {
                return;
            }
            setOpenDropdown(null);
        };

        document.addEventListener("mousedown", handleOutsideClick);
        return () => document.removeEventListener("mousedown", handleOutsideClick);
    }, [activeDropdown, openDropdown]);

    const shouldRenderEmployeeForm = isEmployeeEditPage && editingEmployeeId === employeeId;

    return (
        <AdminLayout>
            {isEmployeeRoutePage && (isLoadingRoutedEmployee || (isEmployeeEditPage && !shouldRenderEmployeeForm && !isRoutedEmployeeError) || (isEmployeeDetailPage && !viewingEmployee && !isRoutedEmployeeError)) && (
                <section className="flex min-h-[calc(100vh-8.5rem)] items-center justify-center rounded-lg border border-slate-300 bg-white p-6 text-sm font-semibold text-slate-500">
                    Loading employee...
                </section>
            )}

            {isEmployeeRoutePage && isRoutedEmployeeError && (
                <section className="flex min-h-[calc(100vh-8.5rem)] items-center justify-center rounded-lg border border-slate-300 bg-white p-6 text-sm font-semibold text-red-600">
                    Unable to load employee.
                </section>
            )}

            {!isEmployeeRoutePage && (
                <section className="flex min-h-[calc(100vh-8.5rem)] flex-col overflow-hidden rounded-lg border border-slate-300/80 bg-slate-50 text-slate-950">
                    <div className="shrink-0 flex flex-wrap items-center justify-between gap-4 border-b border-slate-300 bg-white/45 px-5 py-4">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Admin Employees</p>
                            <h2 className="mt-1 text-xl font-semibold text-slate-950">Employees</h2>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                                {[
                                    ["Employees", activeEmployees.length.toString()],
                                    ["Active", activeEmployees.filter((employee) => employee.status === "Active").length.toString()],
                                    ["Archived", archivedEmployees.length.toString()],
                                    ["Departments", activeDepartmentCount.toString()],
                                ].map(([label, value]) => (
                                    <span
                                        key={label}
                                        className="inline-flex h-8 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-600"
                                    >
                                        <span className="uppercase tracking-[0.12em]">{label}</span>
                                        <span className="text-sm text-slate-950">{value}</span>
                                    </span>
                                ))}
                            </div>

                            <label className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-600">
                                <span className="uppercase tracking-[0.12em]">View</span>
                                <select
                                    className="bg-transparent text-sm font-semibold text-slate-950 outline-none"
                                    value={employeeStatusFilter}
                                    onChange={(event) => {
                                        setEmployeeStatusFilter(event.target.value as (typeof employeeStatusFilters)[number]);
                                        setPage(1);
                                    }}
                                >
                                    {employeeStatusFilters.map((filter) => (
                                        <option key={filter} className="bg-white text-slate-950">
                                            {filter}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            <button
                                className="admin-employees-primary-button flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold !text-white transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-[#842cff]/60"
                                style={{ color: "#ffffff" }}
                                type="button"
                                onClick={openAddEmployeePage}
                            >
                                <FiPlus className="size-4 !text-white" aria-hidden="true" />
                                <span className="!text-white">Add Employee</span>
                            </button>
                        </div>
                    </div>

                    <div className="flex min-h-0 flex-1 flex-col">
                        <div className="flex min-h-[18rem] flex-1 overflow-hidden">
                            <div className="content-scroll min-h-0 flex-1 overflow-auto">
                                <table className="w-full min-w-[66rem] text-left">
                                    <thead className="sticky top-0 z-10 border-b border-slate-300 bg-slate-100">
                                        <tr className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                                            <th className="px-5 py-3">Employee</th>
                                            <th className="px-5 py-3">Company</th>
                                            <th className="px-5 py-3">Department</th>
                                            <th className="px-5 py-3">Role</th>
                                            <th className="px-5 py-3">Code</th>
                                            <th className="px-5 py-3">Employment Status</th>
                                            <th className="px-5 py-3">Status</th>
                                            <th className="px-5 py-3 text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-300">
                                        {isLoading && (
                                            <tr>
                                                <td className="px-5 py-8 text-center text-sm text-slate-500" colSpan={8}>
                                                    Loading employees...
                                                </td>
                                            </tr>
                                        )}
                                        {isError && (
                                            <tr>
                                                <td className="px-5 py-8 text-center text-sm text-red-600" colSpan={8}>
                                                    Unable to load employees. Check that the backend is running.
                                                </td>
                                            </tr>
                                        )}
                                        {!isLoading && !isError && filteredEmployees.length === 0 && (
                                            <tr>
                                                <td className="px-5 py-8 text-center text-sm text-slate-500" colSpan={8}>
                                                    No {employeeStatusFilter === "All" ? "" : employeeStatusFilter.toLowerCase()} employees yet.
                                                </td>
                                            </tr>
                                        )}
                                        {paginatedEmployees.map((employee) => (
                                            <tr
                                                key={employee._id}
                                                className="cursor-pointer text-sm text-slate-700 transition hover:bg-white/65"
                                                onClick={() => openEmployeeView(employee)}
                                            >
                                                <td className="px-5 py-4">
                                                    <button
                                                        className="group flex min-w-0 items-center gap-3 text-left outline-none"
                                                        type="button"
                                                        onClick={() => openEmployeeView(employee)}
                                                        aria-label={`View details for ${employee.name}`}
                                                    >
                                                        <span className="flex size-9 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700">
                                                            {employee.profileImage ? (
                                                                <img className="size-full object-cover" src={employee.profileImage} alt={employee.name} />
                                                            ) : (
                                                                employeeInitials(employee.name)
                                                            )}
                                                        </span>
                                                        <span className="truncate font-semibold text-slate-950 transition group-hover:text-[#5f27cd] group-focus-visible:text-[#5f27cd]">
                                                            {employee.name}
                                                        </span>
                                                    </button>
                                                </td>
                                                <td className="px-5 py-4">{employee.company || "Assistly"}</td>
                                                <td className="px-5 py-4">{employee.team}</td>
                                                <td className="px-5 py-4">{employee.role}</td>
                                                <td className="px-5 py-4">{employee.employeeCode}</td>
                                                <td className="px-5 py-4" onClick={(event) => event.stopPropagation()}>
                                                    <select
                                                        className="h-8 rounded-md border border-[#842cff]/35 bg-[#842cff]/10 px-2 text-xs font-semibold text-[#5f27cd] outline-none transition hover:bg-[#842cff]/15 focus:border-[#9b5cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                        value={employee.status}
                                                        onChange={(event) => updateEmployeeStatus(employee, event.target.value as EmployeeStatus)}
                                                        aria-label={`Change status for ${employee.name}`}
                                                        disabled={updateEmployeeMutation.isPending}
                                                    >
                                                        {employmentStatuses.map((status) => (
                                                            <option key={status} className="bg-white text-slate-950">
                                                                {status}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </td>
                                                <td className="px-5 py-4">
                                                    <span
                                                        className={[
                                                            "inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-semibold",
                                                            availabilityBadgeClass(employee.availabilityStatus),
                                                        ].join(" ")}
                                                    >
                                                        <span
                                                            className={[
                                                                "size-2 rounded-full",
                                                                availabilityDotClass(employee.availabilityStatus),
                                                            ].join(" ")}
                                                            aria-hidden="true"
                                                        />
                                                        {normalizeEmployeeAvailabilityStatus(employee.availabilityStatus)}
                                                    </span>
                                                </td>
                                                <td className="px-5 py-4" onClick={(event) => event.stopPropagation()}>
                                                    <div className="flex justify-end gap-2">
                                                        <button
                                                            className="flex size-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-black transition hover:bg-slate-100 hover:text-black focus:outline-none focus:ring-2 focus:ring-[#842cff]/30"
                                                            type="button"
                                                            aria-label={`Edit ${employee.name}`}
                                                            onClick={() => openEditEmployeePage(employee)}
                                                        >
                                                            <FiEdit2 className="size-4 !text-black" aria-hidden="true" />
                                                        </button>
                                                        <button
                                                            className="flex size-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-black transition hover:bg-slate-100 hover:text-black focus:outline-none focus:ring-2 focus:ring-[#842cff]/30"
                                                            type="button"
                                                            aria-label={`View ${employee.name}`}
                                                            onClick={() => openEmployeeView(employee)}
                                                        >
                                                            <FiEye className="size-4 !text-black" aria-hidden="true" />
                                                        </button>
                                                        <button
                                                            className="flex size-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-black transition hover:bg-slate-100 hover:text-black focus:outline-none focus:ring-2 focus:ring-[#842cff]/30"
                                                            type="button"
                                                            aria-label={`Message ${employee.name}`}
                                                            onClick={() => navigate(`/admin/messages?to=${encodeURIComponent(employee.email)}`)}
                                                        >
                                                            <FiMessageCircle className="size-4 !text-black" aria-hidden="true" />
                                                        </button>
                                                        {employee.status !== "Archived" && (
                                                            <button
                                                                className="flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-black transition hover:border-red-300 hover:bg-red-50 hover:text-black focus:outline-none focus:ring-2 focus:ring-red-400/30 disabled:cursor-not-allowed disabled:opacity-50"
                                                                type="button"
                                                                aria-label={`Archive ${employee.name}`}
                                                                onClick={() => openArchiveConfirm(employee)}
                                                                disabled={archiveEmployeeMutation.isPending}
                                                            >
                                                                <FiArchive className="size-4 !text-black" aria-hidden="true" />
                                                                Archive
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <DataTablePagination
                            totalItems={filteredEmployees.length}
                            page={page}
                            pageSize={pageSize}
                            onPageChange={setPage}
                            onPageSizeChange={(nextPageSize) => {
                                setPageSize(nextPageSize);
                                setPage(1);
                            }}
                        />
                    </div>
                </section>
            )}

            {shouldRenderEmployeeForm && (
                <div
                    className=""
                >
                    <form
                        className="flex min-h-[calc(100vh-8.5rem)] w-full flex-col overflow-hidden rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/20"
                        onSubmit={handleSaveEmployee}
                    >
                        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                            <div>
                                <h3 className="text-base font-semibold text-white">
                                    {modalMode === "add" ? "Add Employee" : "Edit Employee"}
                                </h3>
                                <p className="mt-1 text-sm text-white/45">Create an employee profile.</p>
                            </div>
                            <button
                                className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                type="button"
                                aria-label={isEmployeeEditPage ? "Back to employee" : "Close employee form"}
                                onClick={() => {
                                    if (isEmployeeEditPage) {
                                        navigate(roleWorkspacePath(`/admin/employees/${editingEmployeeId || employeeId}`));
                                        return;
                                    }

                                    closeEmployeeModal();
                                }}
                            >
                                <FiX className="size-4" aria-hidden="true" />
                            </button>
                        </div>

                        <div className="content-scroll grid gap-4 overflow-y-auto p-5 sm:grid-cols-2">
                            <div className="sm:col-span-2 rounded-lg border border-white/10 bg-black/20 p-3">
                                <div className="flex items-center gap-3">
                                    <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#842cff]/30 bg-[#842cff]/15 text-base font-bold text-white">
                                        {newEmployee.profileImage ? (
                                            <img className="size-full object-cover" src={newEmployee.profileImage} alt={newEmployee.name || "Employee"} />
                                        ) : (
                                            employeeInitials(newEmployee.name) || "EP"
                                        )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">
                                            Profile Picture <span className="normal-case tracking-normal text-white/25">(optional)</span>
                                        </p>
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            <button
                                                className="flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-white/75 transition hover:bg-white/10 hover:text-white"
                                                type="button"
                                                onClick={() => profileImageInputRef.current?.click()}
                                            >
                                                <FiCamera className="size-3.5" aria-hidden="true" />
                                                Choose Photo
                                            </button>
                                            {newEmployee.profileImage && (
                                                <button
                                                    className="h-9 rounded-lg border border-white/10 bg-black/20 px-3 text-xs font-semibold text-white/55 transition hover:bg-white/10 hover:text-white"
                                                    type="button"
                                                    onClick={() => {
                                                        updateEmployeeForm("profileImage", "");
                                                        setProfileImageChanged(true);
                                                    }}
                                                >
                                                    Remove
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <input
                                        ref={profileImageInputRef}
                                        className="hidden"
                                        type="file"
                                        accept="image/*"
                                        onChange={(event) => {
                                            updateProfileImage(event.target.files?.[0]);
                                            event.target.value = "";
                                        }}
                                    />
                                </div>
                            </div>

                            <label className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Full Name <span className="normal-case tracking-normal text-white/25">(optional)</span></span>
                                <input
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    value={newEmployee.name}
                                    onChange={(event) => updateEmployeeForm("name", event.target.value)}
                                    placeholder="Employee name"
                                />
                            </label>

                            <div className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Date Hired</span>
                                <input
                                    type="date"
                                    value={newEmployee.dateHired || ""}
                                    onChange={(event) =>
                                        updateEmployeeForm("dateHired", event.target.value)
                                    }
                                    onClick={(e) => {
                                        const input = e.currentTarget;
                                        if (input.showPicker) {
                                            input.showPicker();
                                        }
                                    }}
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                />
                            </div>

                            <div className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Termination Date</span>
                                <input
                                    type="date"
                                    value={newEmployee.terminationDate || ""}
                                    onChange={(event) =>
                                        updateEmployeeForm("terminationDate", event.target.value)
                                    }
                                    onClick={(e) => {
                                        const input = e.currentTarget;
                                        if (input.showPicker) {
                                            input.showPicker();
                                        }
                                    }}
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                />
                            </div>

                            <CustomDropdown
                                label="Department"
                                value={newEmployee.team}
                                onOpen={() => setOpenDropdown((current) => (current === "department" ? null : "department"))}
                                buttonRef={departmentButtonRef}
                            />

                            <CustomDropdown
                                label="Role"
                                value={newEmployee.role}
                                onOpen={() => setOpenDropdown((current) => (current === "role" ? null : "role"))}
                                buttonRef={roleButtonRef}
                            />

                            <CustomDropdown
                                label="Employment Status"
                                value={newEmployee.status}
                                onOpen={() => setOpenDropdown((current) => (current === "status" ? null : "status"))}
                                buttonRef={statusButtonRef}
                            />

                            <label>
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Company</span>
                                <input
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    value={newEmployee.company || ""}
                                    onChange={(event) => updateEmployeeForm("company", event.target.value)}
                                    placeholder="Assistly"
                                />
                            </label>

                            {businesses.length > 0 && (
                                <fieldset className="sm:col-span-2 rounded-lg border border-white/10 bg-black/20 p-3">
                                    <legend className="px-1 text-xs font-medium uppercase tracking-[0.14em] text-white/35">Business Access</legend>
                                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                        {businesses.map((business) => {
                                            const isActiveBusiness = business.id === getActiveBusinessId();
                                            const isChecked = (newEmployee.businessAccessIds || []).includes(business.id);

                                            return (
                                                <label
                                                    key={business.id}
                                                    className={[
                                                        "flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2 text-sm font-semibold transition",
                                                        isChecked
                                                            ? "border-[#842cff]/45 bg-[#842cff]/15 text-white"
                                                            : "border-white/10 bg-white/[0.04] text-white/65",
                                                    ].join(" ")}
                                                >
                                                    <input
                                                        className="size-4 accent-[#842cff]"
                                                        type="checkbox"
                                                        checked={isChecked}
                                                        disabled={isActiveBusiness}
                                                        onChange={() => toggleBusinessAccess(business.id)}
                                                    />
                                                    <span className="min-w-0 flex-1 truncate">{business.name}</span>
                                                    {isActiveBusiness && <span className="text-xs text-white/35">Current</span>}
                                                </label>
                                            );
                                        })}
                                    </div>
                                </fieldset>
                            )}

                            <label className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Employee Code <span className="normal-case tracking-normal text-white/25">(optional)</span></span>
                                <input
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    value={newEmployee.employeeCode}
                                    onChange={(event) => updateEmployeeForm("employeeCode", event.target.value)}
                                    placeholder="EMP-1001"
                                />
                            </label>

                            <label className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Aliases <span className="normal-case tracking-normal text-white/25">(optional)</span></span>
                                <textarea
                                    className="mt-2 min-h-20 w-full resize-none rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    value={(newEmployee.aliases || []).join(", ")}
                                    onChange={(event) =>
                                        updateEmployeeForm(
                                            "aliases",
                                            event.target.value
                                                .split(",")
                                                .map((alias) => alias.trim())
                                                .filter(Boolean)
                                        )
                                    }
                                    placeholder="Marcus, Marc, M"
                                />
                                <p className="mt-1.5 text-xs text-white/35">Comma-separated names used in imported Assigned To columns.</p>
                            </label>

                            <label className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Email <span className="normal-case tracking-normal text-white/25">(optional)</span></span>
                                <input
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    type="email"
                                    value={newEmployee.email}
                                    onChange={(event) => updateEmployeeForm("email", event.target.value)}
                                    placeholder="employee@assistly.com"
                                />
                            </label>

                            <div className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Mobile Number <span className="normal-case tracking-normal text-white/25">(optional)</span></span>
                                <div className="mt-2 grid grid-cols-[0.9fr_1.7fr] gap-2">
                                    <label>
                                        <span className="mb-1 block text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-white/30">Operator</span>
                                        <input
                                            ref={phoneOperatorCodeRef}
                                            className="h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            inputMode="numeric"
                                            value={phoneOperatorCode}
                                            onChange={(event) => updatePhoneSegment("operator", event.target.value)}
                                            onKeyDown={(event) => handlePhoneSegmentKeyDown(event, phoneMobileNumberRef)}
                                            placeholder="960"
                                        />
                                    </label>
                                    <label>
                                        <span className="mb-1 block text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-white/30">Number</span>
                                        <input
                                            ref={phoneMobileNumberRef}
                                            className="h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            inputMode="numeric"
                                            value={phoneMobileNumber}
                                            onChange={(event) => updatePhoneSegment("mobile", event.target.value)}
                                            onKeyDown={(event) => handlePhoneSegmentKeyDown(event, phoneExtensionRef, phoneOperatorCodeRef)}
                                            placeholder="3877103"
                                        />
                                    </label>
                                </div>
                            </div>

                            <label>
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Extension <span className="normal-case tracking-normal text-white/25">(optional)</span></span>
                                <input
                                    ref={phoneExtensionRef}
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    inputMode="numeric"
                                    value={phoneExtension}
                                    onChange={(event) => {
                                        const extension = digitsOnly(event.target.value);
                                        setPhoneExtension(extension);
                                        updateEmployeeForm("phone", formatPhoneWithExtension(phoneOperatorCode || phoneMobileNumber ? "63" : "", phoneOperatorCode, phoneMobileNumber, extension));
                                    }}
                                    placeholder="1005"
                                />
                            </label>

                            <label className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Monthly Salary <span className="normal-case tracking-normal text-white/25">(optional)</span></span>
                                <input
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={newEmployee.salary}
                                    onChange={(event) => updateEmployeeForm("salary", Number(event.target.value))}
                                    placeholder="5000"
                                />
                            </label>

                            <div className="sm:col-span-2 border-t border-white/10 pt-4">
                                <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">HR Personal Info <span className="normal-case tracking-normal text-white/25">(optional)</span></p>
                            </div>

                            <label>
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Personal Phone</span>
                                <input
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    value={newEmployee.personalPhone || ""}
                                    onChange={(event) => updateEmployeeForm("personalPhone", event.target.value)}
                                    placeholder="Personal mobile"
                                />
                            </label>

                            <label>
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Personal Email</span>
                                <input
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    type="email"
                                    value={newEmployee.personalEmail || ""}
                                    onChange={(event) => updateEmployeeForm("personalEmail", event.target.value)}
                                    placeholder="personal@email.com"
                                />
                            </label>

                            <label className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Personal Address</span>
                                <textarea
                                    className="mt-2 min-h-20 w-full resize-none rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    value={newEmployee.personalAddress || ""}
                                    onChange={(event) => updateEmployeeForm("personalAddress", event.target.value)}
                                    placeholder="Home address"
                                />
                            </label>

                            <label className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Emergency Contact</span>
                                <input
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    value={newEmployee.emergencyContact || ""}
                                    onChange={(event) => updateEmployeeForm("emergencyContact", event.target.value)}
                                    placeholder="Name"
                                />
                                <CustomDropdown
                                    label=""
                                    placeholder="Relationship"
                                    value={newEmployee.contactRelationship}
                                    onOpen={() => setOpenDropdown((current) => (current === "contactRelationship" ? null : "contactRelationship"))}
                                    buttonRef={statusButtonRel}
                                />
                                <input
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    value={newEmployee.emergencyContactNumber || ""}
                                    onChange={(event) => updateEmployeeForm("emergencyContactNumber", event.target.value)}
                                    placeholder="Phone"
                                />
                            </label>

                            <label className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Personal Notes</span>
                                <textarea
                                    className="mt-2 min-h-20 w-full resize-none rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    value={newEmployee.personalNotes || ""}
                                    onChange={(event) => updateEmployeeForm("personalNotes", event.target.value)}
                                    placeholder="Private HR notes"
                                />
                            </label>
                        </div>

                        <div className="flex justify-end gap-3 border-t border-white/10 px-5 py-3.5">
                            <button
                                className="h-10 rounded-lg border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                                type="button"
                                onClick={() => {
                                    if (isEmployeeEditPage) {
                                        navigate(roleWorkspacePath(`/admin/employees/${editingEmployeeId || employeeId}`));
                                        return;
                                    }

                                    closeEmployeeModal();
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                className="admin-employees-primary-button flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold !text-white transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-[#842cff]/60"
                                style={{ color: "#ffffff" }}
                                type="submit"
                                disabled={createEmployeeMutation.isPending || updateEmployeeMutation.isPending}
                            >
                                <FiPlus className="size-4 !text-white" aria-hidden="true" />
                                <span className="!text-white">
                                    {createEmployeeMutation.isPending || updateEmployeeMutation.isPending
                                        ? "Saving..."
                                        : modalMode === "add"
                                            ? "Add Employee"
                                            : "Save Employee"}
                                </span>
                            </button>
                        </div>
                    </form>

                    {activeDropdown && (
                        <div
                            ref={dropdownMenuRef}
                            className="fixed z-[60] overflow-hidden rounded-lg border border-white/10 bg-[#11141d] shadow-2xl shadow-black/40"
                            style={getDropdownStyle(activeDropdown.buttonRef.current)}
                            onMouseDown={(event) => event.stopPropagation()}
                        >
                            {activeDropdown.searchable && (
                                <label className="flex h-10 items-center gap-2 border-b border-white/10 px-3 text-white/45">
                                    <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                                    <input
                                        className="h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30"
                                        value={activeDropdown.search}
                                        onChange={(event) => activeDropdown.onSearch(event.target.value)}
                                        placeholder="Search"
                                    />
                                </label>
                            )}
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
                </div>
            )}

            {isEmployeeDetailPage && viewingEmployee && (
                <div
                    className=""
                >
                    <section
                        className="flex min-h-[calc(100vh-8.5rem)] w-full flex-col overflow-hidden rounded-lg border border-slate-300 bg-slate-50 text-slate-950 shadow-lg shadow-slate-950/10"
                    >
                        <div className="border-b border-slate-300 bg-white/55 px-5 py-5">
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex min-w-0 items-center gap-4">
                                    <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#842cff]/35 bg-white text-lg font-bold text-slate-800">
                                        {viewingEmployee.profileImage ? (
                                            <img className="size-full object-cover" src={viewingEmployee.profileImage} alt={viewingEmployee.name} />
                                        ) : (
                                            employeeInitials(viewingEmployee.name)
                                        )}
                                    </div>
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <h3 className="truncate text-xl font-semibold text-slate-950">{viewingEmployee.name}</h3>
                                            <span className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                                                {normalizeEmployeeAvailabilityStatus(viewingEmployee.availabilityStatus)}
                                            </span>
                                            <span className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700">
                                                {viewingEmployee.status}
                                            </span>
                                        </div>
                                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
                                            <span className="font-semibold text-slate-800">{viewingEmployee.role}</span>
                                            <span>{viewingEmployee.team}</span>
                                            <span>Code {viewingEmployee.employeeCode}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                    <a
                                        className="flex size-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-black transition hover:bg-slate-100 hover:text-black"
                                        href={phoneTelHref(viewingEmployee.phone)}
                                        aria-label="Call employee"
                                    >
                                        <FiPhone className="size-4" aria-hidden="true" />
                                    </a>
                                    <a
                                        className="flex size-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-black transition hover:bg-slate-100 hover:text-black"
                                        href={`mailto:${viewingEmployee.email}`}
                                        aria-label="Email employee"
                                    >
                                        <FiMail className="size-4" aria-hidden="true" />
                                    </a>
                                    {viewingEmployee.status !== "Archived" && (
                                        <button
                                            className="flex size-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-black transition hover:border-red-300 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                                            type="button"
                                            aria-label={`Archive ${viewingEmployee.name}`}
                                            onClick={() => openArchiveConfirm(viewingEmployee)}
                                            disabled={archiveEmployeeMutation.isPending}
                                        >
                                            <FiArchive className="size-4" aria-hidden="true" />
                                        </button>
                                    )}
                                    <button
                                        className="flex size-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-black transition hover:bg-slate-100 hover:text-black"
                                        type="button"
                                        aria-label={`Edit ${viewingEmployee.name}`}
                                        onClick={() => navigate(roleWorkspacePath(`/admin/employees/${viewingEmployee._id}/edit`))}
                                    >
                                        <FiEdit2 className="size-4" aria-hidden="true" />
                                    </button>
                                    <button
                                        className="flex size-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-black transition hover:bg-slate-100 hover:text-black"
                                        type="button"
                                        aria-label={isEmployeeDetailPage ? "Back to employees" : "Close employee view"}
                                        onClick={() => {
                                            if (isEmployeeDetailPage) {
                                                setViewingEmployee(null);
                                                navigate(roleWorkspacePath("/admin/employees"));
                                                return;
                                            }

                                            setViewingEmployee(null);
                                        }}
                                    >
                                        <FiX className="size-4" aria-hidden="true" />
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="content-scroll overflow-y-auto p-5">
                            <div className="mb-5 flex items-center gap-7 border-b border-slate-300">
                                {[
                                    ["details", "Emp Details"],
                                    ["hr", "Personal Details"],
                                    ["leads", "Leads"],
                                    ["notices", "Notices"],
                                    ["leave", `Leave${pendingEmployeeLeaveCount > 0 ? ` (${pendingEmployeeLeaveCount})` : ""}`],
                                    ["attendance", "Attendance"],
                                    ["transactions", "Transactions"],
                                ].map(([tab, label]) => (
                                    <button
                                        key={tab}
                                        className={[
                                            "relative h-11 px-0 text-sm font-semibold transition after:absolute after:bottom-[-1px] after:left-0 after:h-0.5 after:w-full after:rounded-full after:transition",
                                            employeeRecordTab === tab
                                                ? "!text-black after:bg-[#842cff]"
                                                : "!text-slate-700 after:bg-transparent hover:!text-black",
                                        ].join(" ")}
                                        type="button"
                                        onClick={() => setEmployeeRecordTab(tab as EmployeeRecordTab)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                            {isFetchingViewingEmployee && (
                                <div className="mb-4 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700">
                                    Loading employee details...
                                </div>
                            )}

                            {employeeRecordTab === "details" && (
                                <section className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm shadow-slate-200/70">
                                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 bg-[#f5efff] px-4 py-3">
                                        <div className="flex items-center gap-2">
                                            <span className="flex size-8 items-center justify-center rounded-lg border border-[#842cff]/25 bg-[#842cff]/10 text-[#5f27cd]">
                                                <FiBriefcase className="size-4" aria-hidden="true" />
                                            </span>
                                            <div>
                                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Employee Details</p>
                                                <p className="mt-0.5 text-sm font-semibold text-slate-950">{viewingEmployee.company || "Assistly"} profile</p>
                                            </div>
                                        </div>
                                        <span className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700">
                                            Admin view
                                        </span>
                                    </div>
                                    <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
                                        {[
                                            { label: "Email", value: viewingEmployee.email, icon: FiMail, tone: "text-sky-600" },
                                            { label: "Phone", value: formatPhoneForDisplay(viewingEmployee.phone), icon: FiPhone, tone: "text-emerald-600" },
                                            { label: "Company", value: viewingEmployee.company || "Assistly", icon: FiBriefcase, tone: "text-[#5f27cd]" },
                                            { label: "Department", value: viewingEmployee.team, icon: FiTag, tone: "text-amber-600" },
                                            { label: "Role", value: viewingEmployee.role, icon: FiUserCheck, tone: "text-slate-700" },
                                            { label: "Employee Code", value: viewingEmployee.employeeCode, icon: FiHash, tone: "text-slate-700" },
                                            { label: "Salary", value: money(viewingEmployee.salary || 0), icon: FiDollarSign, tone: "text-emerald-600" },
                                            { label: "Aliases", value: viewingEmployee.aliases?.length ? viewingEmployee.aliases.join(", ") : "Not provided", icon: FiTag, tone: "text-slate-700" },
                                            { label: "Employment Status", value: viewingEmployee.status, icon: FiCheck, tone: "text-emerald-600" },
                                            { label: "Status", value: normalizeEmployeeAvailabilityStatus(viewingEmployee.availabilityStatus), icon: FiClock, tone: "text-slate-700" },
                                            { label: "Date Hired", value: viewingEmployee.dateHired, icon: FiCalendar, tone: "text-slate-700" },
                                            { label: "Termination Date", value: viewingEmployee.terminationDate ? viewingEmployee.terminationDate : "N/A", icon: FiCalendar, tone: "text-slate-700" },
                                        ].map(({ label, value, icon: Icon, tone }) => (
                                            <div key={label} className="group min-h-[5.35rem] rounded-lg border border-slate-300 bg-slate-50 p-3 transition hover:border-slate-400 hover:bg-white">
                                                <div className="flex items-start gap-3">
                                                    <span className={["mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white shadow-sm", tone].join(" ")}>
                                                        <Icon className="size-3.5" aria-hidden="true" />
                                                    </span>
                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</p>
                                                        <p className="mt-1.5 break-words text-sm font-semibold leading-5 text-slate-950">{value}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {employeeRecordTab === "hr" && (
                                <section className="rounded-lg border border-slate-300 bg-white p-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <FiShield className="size-4 text-[#5f27cd]" aria-hidden="true" />
                                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Personal Details</p>
                                        </div>
                                        <span className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">
                                            HR only
                                        </span>
                                    </div>
                                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                                        {[
                                            ["Personal Phone", viewingEmployee.personalPhone || "Not provided"],
                                            ["Personal Email", viewingEmployee.personalEmail || "Not provided"],
                                            [
                                                "Emergency Contact",
                                                viewingEmployee.emergencyContact
                                                    ? `${viewingEmployee.emergencyContact} (${viewingEmployee.contactRelationship || "Relationship not specified"}) - ${viewingEmployee.emergencyContactNumber || "No phone number"}`
                                                    : "Not provided",
                                            ],
                                            ["Personal Address", viewingEmployee.personalAddress || "Not provided"],
                                            ["Personal Notes", viewingEmployee.personalNotes || "Not provided"],
                                        ].map(([label, value]) => (
                                            <div
                                                key={label}
                                                className={[
                                                    "rounded-lg border border-slate-300 bg-slate-50 p-4",
                                                    label.includes("Address") || label.includes("Notes")
                                                        ? "sm:col-span-2"
                                                        : "",
                                                ].join(" ")}
                                            >
                                                <p className="text-xs italics font-semibold uppercase tracking-[0.12em] text-slate-500">
                                                    {label}
                                                </p>
                                                <p className="mt-2 whitespace-pre-wrap break-words text-sm font-semibold text-slate-950">
                                                    {value}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {employeeRecordTab === "leads" && (
                                <section className="overflow-hidden rounded-lg border border-slate-300/80 bg-slate-50 text-slate-950">
                                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 px-4 py-3">
                                        <div>
                                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Assigned Leads</p>
                                            <p className="mt-1 text-sm text-slate-600">
                                                Matches employee record and assignedAgentName aliases from the leads database.
                                            </p>
                                        </div>
                                        <span className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700">
                                            {employeeLeads.length} leads
                                        </span>
                                    </div>
                                    <div className="grid gap-2 border-b border-slate-300 bg-white px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                                        <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm text-slate-700 focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                                            <FiSearch className="size-4 shrink-0 text-slate-500" aria-hidden="true" />
                                            <input
                                                className="min-w-0 flex-1 bg-transparent font-semibold text-black outline-none placeholder:text-slate-400"
                                                value={employeeLeadSearch}
                                                onChange={(event) => setEmployeeLeadSearch(event.target.value)}
                                                placeholder="Search assigned leads"
                                            />
                                        </label>
                                        <button
                                            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 text-sm font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                                            type="button"
                                            disabled={selectedEmployeeLeads.length === 0 || bulkUnassignLeadsMutation.isPending}
                                            onClick={unassignSelectedEmployeeLeads}
                                        >
                                            <FiTrash2 className="size-4" aria-hidden="true" />
                                            Unassign selected
                                            {selectedEmployeeLeads.length > 0 && (
                                                <span className="rounded-md bg-white px-1.5 py-0.5 text-xs text-red-700">
                                                    {selectedEmployeeLeads.length}
                                                </span>
                                            )}
                                        </button>
                                    </div>

                                    <div className="content-scroll max-h-[22rem] overflow-auto">
                                        <table className="w-full min-w-[50rem] text-left">
                                            <thead className="sticky top-0 z-10 border-b border-slate-300 bg-slate-100">
                                                <tr className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                                                    <th className="w-12 px-4 py-3">
                                                        <input
                                                            className="size-4 rounded border-slate-400 accent-[#842cff]"
                                                            type="checkbox"
                                                            checked={areAllVisibleEmployeeLeadsSelected}
                                                            disabled={visibleEmployeeLeadIds.length === 0}
                                                            onChange={toggleAllVisibleEmployeeLeads}
                                                            aria-label="Select all visible leads"
                                                        />
                                                    </th>
                                                    <th className="px-4 py-3">Lead</th>
                                                    <th className="px-4 py-3">Category</th>
                                                    <th className="px-4 py-3">Assigned Name</th>
                                                    <th className="px-4 py-3">Status</th>
                                                    <th className="px-4 py-3 text-right">Action</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-300">
                                                {isLoadingEmployeeLeads && (
                                                    <tr>
                                                        <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={6}>
                                                            Loading leads...
                                                        </td>
                                                    </tr>
                                                )}
                                                {!isLoadingEmployeeLeads && employeeLeads.length === 0 && (
                                                    <tr>
                                                        <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={6}>
                                                            No leads assigned to this employee or aliases yet.
                                                        </td>
                                                    </tr>
                                                )}
                                                {!isLoadingEmployeeLeads && employeeLeads.length > 0 && filteredEmployeeLeads.length === 0 && (
                                                    <tr>
                                                        <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={6}>
                                                            No leads match this search.
                                                        </td>
                                                    </tr>
                                                )}
                                                {!isLoadingEmployeeLeads && filteredEmployeeLeads.map((lead: Lead) => (
                                                    <tr key={lead._id} className="text-sm text-slate-700">
                                                        <td className="px-4 py-3">
                                                            <input
                                                                className="size-4 rounded border-slate-400 accent-[#842cff]"
                                                                type="checkbox"
                                                                checked={selectedEmployeeLeadIds.includes(lead._id)}
                                                                onChange={() => toggleEmployeeLeadSelection(lead._id)}
                                                                aria-label={`Select ${lead.leadName || lead.businessName}`}
                                                            />
                                                        </td>
                                                        <td className="px-4 py-3">
                                                            <p className="font-semibold text-slate-950">{lead.leadName || lead.businessName}</p>
                                                            <p className="mt-1 text-xs text-slate-500">{lead.businessName}</p>
                                                        </td>
                                                        <td className="px-4 py-3">{lead.category || "Uncategorized"}</td>
                                                        <td className="px-4 py-3">{lead.assignedAgentName || lead.assignedAgent?.name || "Unassigned"}</td>
                                                        <td className="px-4 py-3">
                                                            <span className="rounded-md border border-[#842cff]/35 bg-[#842cff]/10 px-2 py-1 text-xs font-semibold text-[#5f27cd]">
                                                                {lead.status}
                                                            </span>
                                                        </td>
                                                        <td className="px-4 py-3 text-right">
                                                            <button
                                                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-2.5 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                                                                type="button"
                                                                disabled={unassignLeadMutation.isPending || bulkUnassignLeadsMutation.isPending}
                                                                onClick={() => unassignLeadMutation.mutate(lead)}
                                                            >
                                                                <FiTrash2 className="size-3.5" aria-hidden="true" />
                                                                Unassign
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </section>
                            )}

                            {employeeRecordTab === "notices" && (
                                <div className="grid gap-4 lg:grid-cols-[0.86fr_1.14fr]">
                                    <form className="rounded-lg border border-slate-300 bg-white p-4" onSubmit={handleIssueNotice}>
                                        <div>
                                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{editingNoticeId ? "Edit Notice" : "Issue Notice"}</p>
                                            <p className="mt-1 text-sm text-slate-600">
                                                {editingNoticeId ? "Update the selected admin notice." : "Attach an admin notice to this employee record."}
                                            </p>
                                        </div>
                                        <div className="mt-4 flex rounded-lg border border-slate-300 bg-slate-100 p-1">
                                            {noticeSeverities.map((severity) => (
                                                <button
                                                    key={severity}
                                                    className={[
                                                        "h-8 flex-1 rounded-md px-2 text-xs font-semibold transition",
                                                        noticeForm.severity === severity
                                                            ? "bg-white text-black shadow-sm shadow-slate-200"
                                                            : "text-slate-600 hover:text-black",
                                                    ].join(" ")}
                                                    type="button"
                                                    onClick={() => setNoticeForm((notice) => ({ ...notice, severity }))}
                                                >
                                                    {severity}
                                                </button>
                                            ))}
                                        </div>

                                        <div className="mt-3 grid gap-3">
                                            <input
                                                className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-black outline-none placeholder:text-slate-400 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                value={noticeForm.title}
                                                onChange={(event) => setNoticeForm((notice) => ({ ...notice, title: event.target.value }))}
                                                placeholder="Notice title"
                                            />
                                            <textarea
                                                className="min-h-28 resize-none rounded-lg border border-slate-300 bg-white p-3 text-sm font-semibold text-black outline-none placeholder:text-slate-400 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                value={noticeForm.message}
                                                onChange={(event) => setNoticeForm((notice) => ({ ...notice, message: event.target.value }))}
                                                placeholder="Write the notice"
                                            />
                                            <div className="flex gap-2">
                                                {editingNoticeId && (
                                                    <button
                                                        className="h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-black transition hover:bg-slate-50"
                                                        type="button"
                                                        onClick={cancelEditNotice}
                                                    >
                                                        Cancel
                                                    </button>
                                                )}
                                                <button
                                                    className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                                                    type="submit"
                                                    disabled={createNoticeMutation.isPending || updateNoticeMutation.isPending}
                                                >
                                                    {editingNoticeId ? <FiCheck className="size-4" aria-hidden="true" /> : <FiPlus className="size-4" aria-hidden="true" />}
                                                    {editingNoticeId ? "Save Changes" : "Issue Notice"}
                                                </button>
                                            </div>
                                        </div>
                                    </form>

                                    <section className="rounded-lg border border-slate-300 bg-white p-4">
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div>
                                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Notice History</p>
                                                <p className="mt-1 text-sm text-slate-600">{employeeNotices.length} records attached</p>
                                            </div>
                                            <span className="rounded-md border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">
                                                Admin view
                                            </span>
                                        </div>

                                        <div className="mt-5 space-y-4">
                                            {employeeNotices.length === 0 && (
                                                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
                                                    <p className="text-sm font-semibold text-black">No notices issued</p>
                                                    <p className="mt-1 text-sm text-slate-600">New admin notices will appear in this employee record.</p>
                                                </div>
                                            )}
                                            {employeeNotices.map((notice) => (
                                                <article key={notice._id} className="relative pl-6">
                                                    <span
                                                        className={[
                                                            "absolute left-0 top-1.5 size-2.5 rounded-full",
                                                            notice.severity === "Critical"
                                                                ? "bg-rose-400"
                                                                : notice.severity === "Warning"
                                                                    ? "bg-red-400"
                                                                    : "bg-[#8b3dff]",
                                                        ].join(" ")}
                                                        aria-hidden="true"
                                                    />
                                                    <div className="rounded-lg border border-slate-300 bg-slate-50 p-3">
                                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                                            <h4 className="text-sm font-semibold text-black">{notice.title}</h4>
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <span
                                                                    className={[
                                                                        "rounded-md px-2 py-1 text-xs font-semibold",
                                                                        notice.severity === "Critical"
                                                                            ? "bg-rose-100 text-rose-700"
                                                                            : notice.severity === "Warning"
                                                                                ? "bg-red-100 text-red-700"
                                                                                : "bg-slate-200 text-slate-700",
                                                                    ].join(" ")}
                                                                >
                                                                    {notice.severity}
                                                                </span>
                                                                <span className={["rounded-md px-2 py-1 text-xs font-semibold", notice.acknowledgedAt ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"].join(" ")}>
                                                                    {notice.acknowledgedAt ? "Acknowledged" : "Not acknowledged"}
                                                                </span>
                                                                <button
                                                                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 text-xs font-semibold text-black transition hover:bg-slate-100"
                                                                    type="button"
                                                                    onClick={() => startEditNotice(notice)}
                                                                >
                                                                    <FiEdit2 className="size-3.5" aria-hidden="true" />
                                                                    Edit
                                                                </button>
                                                                <button
                                                                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-2 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                                                                    type="button"
                                                                    disabled={deleteNoticeMutation.isPending || !viewingEmployee}
                                                                    onClick={() => confirmDeleteNotice(notice._id)}
                                                                >
                                                                    <FiTrash2 className="size-3.5" aria-hidden="true" />
                                                                    Delete
                                                                </button>
                                                            </div>
                                                        </div>
                                                        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{notice.message}</p>
                                                        <p className="mt-3 text-xs text-slate-500">
                                                            Issued by {notice.issuedBy} · {formatPhDateTime(notice.createdAt)}
                                                        </p>
                                                        {notice.acknowledgedAt && (
                                                            <p className="mt-1 text-xs font-semibold text-emerald-700">
                                                                Acknowledged {formatPhDateTime(notice.acknowledgedAt)}
                                                            </p>
                                                        )}
                                                        {(notice.replies || []).length > 0 && (
                                                            <div className="mt-3 space-y-2 rounded-lg border border-slate-300 bg-white p-3">
                                                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Employee Replies</p>
                                                                {(notice.replies || []).map((reply) => (
                                                                    <div key={reply._id || `${notice._id}-${reply.createdAt}`} className="rounded-lg bg-slate-50 p-3">
                                                                        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{reply.message}</p>
                                                                        <p className="mt-1 text-xs text-slate-500">{formatPhDateTime(reply.createdAt)}</p>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                </article>
                                            ))}
                                        </div>
                                    </section>
                                </div>
                            )}

                            {employeeRecordTab === "leave" && (
                                <section className="rounded-lg border border-slate-300 bg-white p-4">
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <span className="flex size-8 items-center justify-center rounded-lg border border-[#842cff]/25 bg-[#842cff]/10 text-[#5f27cd]">
                                                <FiCalendar className="size-4" aria-hidden="true" />
                                            </span>
                                            <div>
                                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Leave Requests</p>
                                                <p className="mt-1 text-sm text-slate-600">Review and approve employee leave forms.</p>
                                            </div>
                                        </div>
                                        <span className="rounded-md border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">
                                            {pendingEmployeeLeaveCount} pending
                                        </span>
                                    </div>

                                    <div className="mt-5 space-y-4">
                                        {isLoadingEmployeeLeaveRequests && (
                                            <div className="rounded-lg border border-slate-300 bg-slate-50 p-6 text-center text-sm font-semibold text-slate-600">
                                                Loading leave requests...
                                            </div>
                                        )}
                                        {!isLoadingEmployeeLeaveRequests && employeeLeaveRequests.length === 0 && (
                                            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
                                                <p className="text-sm font-semibold text-black">No leave requests yet</p>
                                                <p className="mt-1 text-sm text-slate-600">Employee leave forms will appear here.</p>
                                            </div>
                                        )}
                                        {employeeLeaveRequests.map((leaveRequest) => {
                                            const reviewNote = leaveReviewNotes[leaveRequest._id] || "";
                                            const leaveThread = getLeaveRequestThread(leaveRequest);
                                            const isPending = leaveRequest.status === "Pending";

                                            return (
                                                <article key={leaveRequest._id} className="rounded-lg border border-slate-300 bg-slate-50 p-4">
                                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                                        <div>
                                                            <p className="text-base font-semibold text-black">{leaveRequest.leaveType} Leave</p>
                                                            <p className="mt-1 text-sm font-semibold text-slate-700">
                                                                {formatLeaveRequestDateDisplay(leaveRequest)}
                                                            </p>
                                                            <p className="mt-1 text-xs text-slate-500">Submitted {formatPhDateTime(leaveRequest.createdAt)}</p>
                                                        </div>
                                                        <span className={`rounded-md border px-2.5 py-1 text-xs font-bold ${leaveRequestStatusClass(leaveRequest.status)}`}>
                                                            {leaveRequest.status}
                                                        </span>
                                                    </div>
                                                    <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.85fr)]">
                                                        <div className="grid content-start gap-3">
                                                            <div className="rounded-lg border border-slate-300 bg-white p-3">
                                                                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Reason</p>
                                                                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">{leaveRequest.reason}</p>
                                                            </div>
                                                            <LeaveRequestCalendar leaveRequest={leaveRequest} />
                                                        </div>

                                                        <aside className="grid content-start gap-3 rounded-lg border border-slate-300 bg-white p-3">
                                                            <div>
                                                                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Comments</p>
                                                                <p className="mt-1 text-sm text-slate-600">Questions, replies, and approval notes.</p>
                                                            </div>

                                                            {isPending ? (
                                                                <div className="mt-3 grid gap-3">
                                                                    {leaveThread.length > 0 && (
                                                                        <div className="grid gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3">
                                                                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-sky-700">Comments</p>
                                                                            {leaveThread.map((comment) => (
                                                                                <div
                                                                                    key={comment._id || `${comment.authorType}-${comment.createdAt}`}
                                                                                    className={`flex ${comment.authorType === "Employee" ? "justify-end" : "justify-start"}`}
                                                                                >
                                                                                    <div
                                                                                        className={[
                                                                                            "max-w-[78%] rounded-2xl border p-3 shadow-sm",
                                                                                            comment.authorType === "Employee"
                                                                                                ? "rounded-br-md border-[#842cff]/30 bg-[#842cff] text-white"
                                                                                                : "rounded-bl-md border-sky-100 bg-white text-slate-900",
                                                                                        ].join(" ")}
                                                                                    >
                                                                                        <div className={`flex flex-wrap items-center gap-2 ${comment.authorType === "Employee" ? "justify-end" : "justify-start"}`}>
                                                                                            <p className={comment.authorType === "Employee" ? "text-xs font-bold text-white" : "text-xs font-bold text-slate-900"}>
                                                                                                {comment.authorName || comment.authorType}
                                                                                            </p>
                                                                                            <span
                                                                                                className={[
                                                                                                    "rounded-md px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.08em]",
                                                                                                    comment.authorType === "Employee" ? "bg-white/20 !text-white" : "bg-slate-100 text-slate-500",
                                                                                                ].join(" ")}
                                                                                            >
                                                                                                {comment.authorType}
                                                                                            </span>
                                                                                        </div>
                                                                                        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{comment.message}</p>
                                                                                        <p className={comment.authorType === "Employee" ? "mt-1 text-right text-xs !text-white" : "mt-1 text-xs text-slate-500"}>
                                                                                            {formatPhDateTime(comment.createdAt)}
                                                                                        </p>
                                                                                    </div>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    )}
                                                                    <textarea
                                                                        className="min-h-20 resize-y rounded-lg border border-slate-300 bg-white p-3 text-sm font-semibold text-black outline-none placeholder:text-slate-400 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                                        value={reviewNote}
                                                                        onChange={(event) => setLeaveReviewNotes((notes) => ({ ...notes, [leaveRequest._id]: event.target.value }))}
                                                                        placeholder="Comment, question, or approval note"
                                                                    />
                                                                    <div className="flex flex-wrap justify-end gap-2">
                                                                        <button
                                                                            className="inline-flex h-9 items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 text-sm font-semibold text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                                                                            type="button"
                                                                            disabled={!reviewNote.trim() || commentLeaveMutation.isPending || rejectLeaveMutation.isPending || approveLeaveMutation.isPending}
                                                                            onClick={() => commentLeaveMutation.mutate({ id: leaveRequest._id, adminNote: reviewNote })}
                                                                        >
                                                                            Ask / Comment
                                                                        </button>
                                                                        <button
                                                                            className="inline-flex h-9 items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                                                                            type="button"
                                                                            disabled={commentLeaveMutation.isPending || rejectLeaveMutation.isPending || approveLeaveMutation.isPending}
                                                                            onClick={() => rejectLeaveMutation.mutate({ id: leaveRequest._id, adminNote: reviewNote })}
                                                                        >
                                                                            <FiX className="size-4" aria-hidden="true" />
                                                                            Reject
                                                                        </button>
                                                                        <button
                                                                            className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-500 px-3 text-sm font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
                                                                            type="button"
                                                                            disabled={commentLeaveMutation.isPending || approveLeaveMutation.isPending || rejectLeaveMutation.isPending}
                                                                            onClick={() => approveLeaveMutation.mutate({ id: leaveRequest._id, adminNote: reviewNote })}
                                                                        >
                                                                            <FiCheck className="size-4" aria-hidden="true" />
                                                                            Approve
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            ) : (
                                                                <div className="mt-3 grid gap-3">
                                                                    {leaveThread.length > 0 && (
                                                                        <div className="rounded-lg border border-slate-300 bg-white p-3">
                                                                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Comments</p>
                                                                            <div className="mt-2 grid gap-2">
                                                                                {leaveThread.map((comment) => (
                                                                                    <div
                                                                                        key={comment._id || `${comment.authorType}-${comment.createdAt}`}
                                                                                        className={`flex ${comment.authorType === "Employee" ? "justify-end" : "justify-start"}`}
                                                                                    >
                                                                                        <div
                                                                                            className={[
                                                                                                "max-w-[78%] rounded-2xl p-3 shadow-sm",
                                                                                                comment.authorType === "Employee"
                                                                                                    ? "rounded-br-md bg-[#842cff] text-white"
                                                                                                    : "rounded-bl-md bg-slate-50 text-slate-900",
                                                                                            ].join(" ")}
                                                                                        >
                                                                                            <div className={`flex flex-wrap items-center gap-2 ${comment.authorType === "Employee" ? "justify-end" : "justify-start"}`}>
                                                                                                <p className={comment.authorType === "Employee" ? "text-xs font-bold text-white" : "text-xs font-bold text-slate-900"}>
                                                                                                    {comment.authorName || comment.authorType}
                                                                                                </p>
                                                                                                <span
                                                                                                    className={[
                                                                                                        "rounded-md px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.08em]",
                                                                                                        comment.authorType === "Employee" ? "bg-white/20 !text-white" : "bg-white text-slate-500",
                                                                                                    ].join(" ")}
                                                                                                >
                                                                                                    {comment.authorType}
                                                                                                </span>
                                                                                            </div>
                                                                                            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{comment.message}</p>
                                                                                            <p className={comment.authorType === "Employee" ? "mt-1 text-right text-xs !text-white" : "mt-1 text-xs text-slate-500"}>
                                                                                                {formatPhDateTime(comment.createdAt)}
                                                                                            </p>
                                                                                        </div>
                                                                                    </div>
                                                                                ))}
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                    <div className="rounded-lg border border-slate-300 bg-white p-3">
                                                                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Admin Review</p>
                                                                        <p className="mt-2 text-sm font-semibold text-slate-900">
                                                                            {leaveRequest.reviewedBy || "Admin"} · {leaveRequest.reviewedAt ? formatPhDateTime(leaveRequest.reviewedAt) : "No review time"}
                                                                        </p>
                                                                        {leaveRequest.adminNote && (
                                                                            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{leaveRequest.adminNote}</p>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </aside>
                                                    </div>
                                                </article>
                                            );
                                        })}
                                    </div>
                                </section>
                            )}

                            {employeeRecordTab === "attendance" && (
                                <section className="rounded-lg border border-slate-300 bg-white p-4">
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div>
                                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Attendance</p>
                                            <p className="mt-1 text-sm text-slate-600">{employeeAttendance.length} attendance records grouped by PH attendance slot</p>
                                        </div>
                                        <span className="rounded-md border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">
                                            Calendar view
                                        </span>
                                    </div>

                                    <div className="mt-5 grid gap-3 sm:grid-cols-3">
                                        <div className="rounded-lg border border-slate-300 bg-slate-50 p-3">
                                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Total Records</p>
                                            <p className="mt-2 text-2xl font-semibold text-black">{employeeAttendance.length}</p>
                                        </div>
                                        <div className="rounded-lg border border-slate-300 bg-slate-50 p-3">
                                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Days Tracked</p>
                                            <p className="mt-2 text-2xl font-semibold text-black">{attendanceCalendarDays.filter((day) => day.records.length > 0).length}</p>
                                        </div>
                                        <div className="rounded-lg border border-slate-300 bg-slate-50 p-3">
                                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Latest</p>
                                            <p className="mt-2 text-sm font-semibold text-black">
                                                {employeeAttendance[0]
                                                    ? formatPhDateTime(employeeAttendance[0].timeIn)
                                                    : "No time-in yet"}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                                        <div className="overflow-hidden rounded-lg border border-slate-300 bg-slate-50">
                                            <div className="flex items-center justify-between border-b border-slate-300 bg-white px-4 py-3">
                                                <div>
                                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Calendar</p>
                                                    <p className="mt-1 text-sm font-semibold text-black">
                                                        {new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(attendanceMonthStart)}
                                                    </p>
                                                </div>
                                                <div className="flex flex-wrap items-center justify-end gap-2">
                                                    <div className="flex overflow-hidden rounded-lg border border-slate-300 bg-white">
                                                        <button
                                                            className="flex size-8 items-center justify-center text-slate-700 transition hover:bg-slate-100"
                                                            type="button"
                                                            onClick={() => {
                                                                setAttendanceMonthOffset((offset) => offset - 1);
                                                                setSelectedAttendanceDateKey("");
                                                            }}
                                                            aria-label="Previous month"
                                                        >
                                                            <FiChevronLeft className="size-4" aria-hidden="true" />
                                                        </button>
                                                        <button
                                                            className="border-x border-slate-300 px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                                                            type="button"
                                                            onClick={() => {
                                                                setAttendanceMonthOffset(0);
                                                                setSelectedAttendanceDateKey("");
                                                            }}
                                                        >
                                                            Latest
                                                        </button>
                                                        <button
                                                            className="flex size-8 items-center justify-center text-slate-700 transition hover:bg-slate-100"
                                                            type="button"
                                                            onClick={() => {
                                                                setAttendanceMonthOffset((offset) => offset + 1);
                                                                setSelectedAttendanceDateKey("");
                                                            }}
                                                            aria-label="Next month"
                                                        >
                                                            <FiChevronRight className="size-4" aria-hidden="true" />
                                                        </button>
                                                    </div>
                                                    <div className="flex flex-wrap gap-2 text-xs font-semibold">
                                                        <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-1 text-rose-700">Late-Present</span>
                                                        <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-1 text-emerald-700">Ontime-Present</span>
                                                        <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-amber-700">Undertime</span>
                                                        <span className="rounded-full border border-violet-300 bg-violet-50 px-2 py-1 text-violet-700">Overtime</span>
                                                        <span className="rounded-full border border-slate-300 bg-white px-2 py-1 text-slate-600">Absent</span>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-7 border-b border-slate-300 bg-slate-100 text-center text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">
                                                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                                                    <div key={day} className="px-2 py-2">{day}</div>
                                                ))}
                                            </div>
                                            <div className="grid grid-cols-7">
                                                {attendanceCalendarDays.map((day) => {
                                                    const isInMonth = day.dateKey.slice(0, 7) === dateKeyFromUtcDate(attendanceMonthStart).slice(0, 7);
                                                    const isSelected = selectedAttendanceDay?.dateKey === day.dateKey;

                                                    return (
                                                        <button
                                                            key={day.dateKey}
                                                            className={[
                                                                "min-h-[4.9rem] border-b border-r border-slate-200 p-2 text-left transition hover:bg-violet-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#842cff]",
                                                                isInMonth ? "bg-white" : "bg-slate-100/70",
                                                                isSelected ? "ring-2 ring-inset ring-[#842cff]" : "",
                                                            ].join(" ")}
                                                            type="button"
                                                            onClick={() => setSelectedAttendanceDateKey(day.dateKey)}
                                                        >
                                                            <div className="flex items-center justify-between">
                                                                <span className={["text-xs font-bold", isInMonth ? "text-slate-900" : "text-slate-400"].join(" ")}>{day.dayNumber}</span>
                                                            </div>
                                                            <div className="mt-2 flex flex-col gap-1">
                                                                {attendanceDayStatuses(day).map((status) => (
                                                                    <span key={status} className={`block w-full rounded-md border px-1.5 py-1 text-center text-[0.62rem] font-bold ${attendanceStatusTone(status)}`}>
                                                                        {day.isLate && day.isUnderTime && status === "late-present" ? "Late" : attendancePresenceLabel(status)}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        <aside className="rounded-lg border border-slate-300 bg-slate-50 p-4">
                                            <div className="flex items-center justify-between gap-3">
                                                <div>
                                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Selected Slot</p>
                                                    <p className="mt-1 text-base font-semibold text-black">{selectedAttendanceDay?.label || "No slot"}</p>
                                                </div>
                                                <div className="flex flex-wrap justify-end gap-2">
                                                    {selectedAttendanceDay && attendanceDayStatuses(selectedAttendanceDay).map((status) => (
                                                        <span key={status} className={`rounded-full border px-2.5 py-1 text-xs font-bold ${attendanceStatusTone(status)}`}>
                                                            {attendancePresenceLabel(status)}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>

                                            <div className="mt-4 space-y-3">
                                                {!selectedAttendanceDay?.records.length && (
                                                    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center">
                                                        <FiClock className="mx-auto size-5 text-slate-500" aria-hidden="true" />
                                                        <p className="mt-2 text-sm font-semibold text-black">No attendance yet</p>
                                                        <p className="mt-1 text-sm text-slate-600">Attendance records will appear here.</p>
                                                    </div>
                                                )}
                                                {selectedAttendanceDay?.records.map((attendance) => {
                                                    const offPhoneSession = selectedAttendanceOffPhoneSessions.find((session) =>
                                                        session.endRecord?._id === attendance._id ||
                                                        (session.isOpen && session.startRecord._id === attendance._id)
                                                    );
                                                    const isUnderTime = isAttendanceTimeOutUndertime(attendance, employeeAttendanceSettings);
                                                    const displayedAttendanceStatus = attendance.attendanceStatus || (isUnderTime ? "Undertime" : "");

                                                    return (
                                                        <article key={attendance._id} className="flex items-start gap-3 rounded-lg border border-slate-300 bg-white p-3">
                                                            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#842cff]/25 bg-[#842cff]/10 text-[#5f27cd]">
                                                                <FiClock className="size-4" aria-hidden="true" />
                                                            </div>
                                                            <div className="min-w-0 flex-1">
                                                                <div className="flex flex-wrap items-center gap-2">
                                                                    <p className="text-sm font-semibold text-black">{attendanceSourceLabel(attendance.source)}</p>
                                                                    {displayedAttendanceStatus && (
                                                                        <span className={["rounded-md px-2 py-1 text-xs font-semibold", displayedAttendanceStatus === "Late" ? "bg-red-100 text-red-700" : displayedAttendanceStatus === "Undertime" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"].join(" ")}>
                                                                            {displayedAttendanceStatus}
                                                                        </span>
                                                                    )}
                                                                    {offPhoneSession && (
                                                                        <span className="rounded-md bg-sky-100 px-2 py-1 text-xs font-semibold text-sky-700">
                                                                            {offPhoneSession.isOpen ? "Running " : "Duration "}
                                                                            {formatAttendanceDuration(offPhoneSession.durationMs)}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <p className="mt-1 text-sm text-slate-600">{formatPhDateTime(attendance.timeIn)}</p>
                                                                <p className="mt-1 text-xs font-semibold text-slate-500">{attendance.source}</p>
                                                            </div>
                                                        </article>
                                                    );
                                                })}
                                            </div>
                                        </aside>
                                    </div>
                                </section>
                            )}

                            {employeeRecordTab === "transactions" && (
                                <section className="rounded-lg border border-slate-300 bg-white p-4">
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div>
                                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Transactions</p>
                                            <p className="mt-1 text-sm text-slate-600">Activities completed during the selected shift date.</p>
                                        </div>
                                        <label className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm font-semibold text-slate-700">
                                            <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Date</span>
                                            <input
                                                className="bg-transparent text-sm font-semibold text-black outline-none [color-scheme:light]"
                                                type="date"
                                                value={transactionDate}
                                                onChange={(event) => setTransactionDate(event.target.value)}
                                            />
                                        </label>
                                    </div>

                                    <div className="mt-5 grid gap-3 sm:grid-cols-3">
                                        <div className="rounded-lg border border-slate-300 bg-slate-50 p-3">
                                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Activities</p>
                                            <p className="mt-2 text-2xl font-semibold text-black">{employeeTransactions.length}</p>
                                        </div>
                                        <div className="rounded-lg border border-slate-300 bg-slate-50 p-3 sm:col-span-2">
                                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Shift Date</p>
                                            <p className="mt-2 text-sm font-semibold text-black">
                                                {transactionDate ? formatCstDate(parseCstDateInput(transactionDate)) : "All dates"}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="mt-4 space-y-3">
                                        {employeeTransactions.length === 0 && (
                                            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
                                                <p className="text-sm font-semibold text-black">No transactions found</p>
                                                <p className="mt-1 text-sm text-slate-600">Login and employee actions will show here for the selected date.</p>
                                            </div>
                                        )}
                                        {employeeTransactions.map((transaction) => (
                                            <article key={transaction._id} className="flex items-start gap-3 rounded-lg border border-slate-300 bg-slate-50 p-3">
                                                <div className="mt-0.5 rounded-md border border-[#842cff]/25 bg-[#842cff]/10 px-2 py-1 text-xs font-semibold text-[#5f27cd]">
                                                    {transaction.category}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                                        <p className="text-sm font-semibold text-black">{transaction.title}</p>
                                                        <time className="text-xs text-slate-500">
                                                            {new Date(transaction.occurredAt).toLocaleTimeString([], {
                                                                hour: "2-digit",
                                                                minute: "2-digit",
                                                            })}
                                                        </time>
                                                    </div>
                                                    <p className="mt-1 text-sm leading-6 text-slate-700">{transaction.description}</p>
                                                </div>
                                            </article>
                                        ))}
                                    </div>
                                </section>
                            )}
                        </div>
                    </section>
                </div>
            )}

            {archiveTarget && (
                <div
                    className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                            setArchiveTarget(null);
                        }
                    }}
                >
                    <section
                        className="modal-panel-enter w-full max-w-[28rem] rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                            <div>
                                <h3 className="text-lg font-semibold text-white">Are you sure?</h3>
                                <p className="mt-1 text-sm text-white/45">This will archive the employee instead of permanently deleting.</p>
                            </div>
                            <button
                                className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                type="button"
                                aria-label="Close archive confirmation"
                                onClick={() => {
                                    setArchiveTarget(null);
                                }}
                            >
                                <FiX className="size-4" aria-hidden="true" />
                            </button>
                        </div>

                        <div className="p-5">
                            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Employee</p>
                                <p className="mt-2 text-sm font-semibold text-white">{archiveTarget.employee.name}</p>
                                <p className="mt-1 text-sm text-white/45">{archiveTarget.employee.email}</p>
                            </div>
                        </div>

                        <div className="flex justify-end gap-3 border-t border-white/10 px-5 py-4">
                            <button
                                className="h-10 rounded-lg border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                                type="button"
                                onClick={() => {
                                    setArchiveTarget(null);
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                className="flex h-10 items-center gap-2 rounded-lg border border-red-400/25 bg-red-400/15 px-4 text-sm font-semibold text-red-100 transition hover:bg-red-400/25 focus:outline-none focus:ring-2 focus:ring-red-400/40"
                                type="button"
                                onClick={() => {
                                    archiveEmployee(archiveTarget.id);
                                }}
                                disabled={archiveEmployeeMutation.isPending}
                            >
                                <FiArchive className="size-4" aria-hidden="true" />
                                {archiveEmployeeMutation.isPending ? "Archiving..." : "Archive Employee"}
                            </button>
                        </div>
                    </section>
                </div>
            )}
        </AdminLayout>
    );
}
