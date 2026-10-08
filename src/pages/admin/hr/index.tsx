import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { FiBriefcase, FiDownload, FiEdit2, FiFileText, FiPhone, FiPlus, FiRefreshCw, FiSearch, FiStar, FiTrash2, FiUsers, FiX } from "react-icons/fi";
import AdminLayout from "../adminLayout";
import { getEmployeesAttendance, type AttendanceQuery, type AttendanceRecord } from "../../../api/attendance";
import { deleteEmployee, getEmployees, normalizeEmployeeAvailabilityStatus, updateEmployee, type Employee, type EmployeeInput } from "../../../api/employees";
import {
    archiveApplicant,
    archiveJobPosting,
    createApplicant,
    createJobPosting,
    getApplicants,
    getJobPostings,
    permanentlyDeleteApplicant,
    permanentlyDeleteJobPosting,
    updateApplicant,
    updateApplicantStage,
    updateJobPosting,
    type Applicant,
    type ApplicantInput,
    type ApplicantStage,
    type JobPosting,
    type JobPostingInput,
    type JobStatus,
} from "../../../api/hr";
import { getSystemSettings, type SystemSettings } from "../../../api/systemSettings";
import {
    ATTENDANCE_TIME_ZONE,
    DEFAULT_ATTENDANCE_SHIFT_END,
    DEFAULT_ATTENDANCE_SHIFT_START,
    attendanceSlotShiftEnd,
    attendanceSlotShiftStart,
    attendanceSlotTimeZone,
    formatAttendanceSlotLabel,
    groupAttendanceRecordsBySlot,
    isWeekendAttendanceSlotKey,
} from "../../../lib/attendanceSlots";
import { buildOffPhoneAttendanceSessions } from "../../../lib/attendanceRecords";
import { formatCstDate, formatTimeInTimeZone } from "../../../lib/dateTime";

const tabs = ["Job Postings", "Applicants", "Employed", "Attendance", "Archived"] as const;
const jobStatuses: JobStatus[] = ["Draft", "Open", "Paused", "Closed"];
const applicantStages: ApplicantStage[] = ["Applied", "Screening", "Interview", "Offer", "Hired", "Rejected"];
const attendancePageSize = 15;

type RichJobPostingInput = JobPostingInput & {
    applyEyebrow?: string;
    summary?: string;
    level?: string;
    skills: string[];
    responsibilities: string[];
    requirements: string[];
    niceToHave: string[];
    whatYouWillBuild: string[];
};

const webDeveloperJobTemplate: RichJobPostingInput = {
    title: "Web Developer",
    department: "Engineering / Web Team",
    location: "Remote",
    employmentType: "Full-time / Project-based",
    salaryRange: "Competitive, based on experience",
    status: "Open",
    applyEyebrow: "Now applying / Engineering / Web Team",
    level: "Mid-level",
    skills: ["React", "JavaScript", "HTML", "CSS", "Responsive UI", "APIs"],
    summary: "Build and maintain responsive websites, landing pages, dashboards, and client-facing web experiences with clean code and strong attention to detail.",
    description: `Build modern web experiences for real business workflows.
As a Web Developer, you will create fast, responsive, and polished websites that help Assistly and its clients present services, capture inquiries, and support day-to-day operations. This role is ideal for someone who can combine clean code with a strong eye for modern interface design.`,
    responsibilities: [
        "Develop responsive website pages and reusable front-end components.",
        "Turn business requirements and design mockups into clean, maintainable code.",
        "Connect pages to forms, APIs, CMS content, or other business tools when needed.",
        "Test layouts across desktop, tablet, and mobile devices.",
        "Optimize page performance, accessibility, and SEO-friendly structure.",
        "Collaborate with designers, operations, and client-facing teammates.",
    ],
    requirements: [
        "Strong knowledge of HTML, CSS, JavaScript, and responsive design.",
        "Experience building with React or another modern front-end framework.",
        "Ability to write clean, organized, and reusable components.",
        "Comfort working with Git, browser dev tools, and deployment workflows.",
        "Good eye for spacing, typography, alignment, and interaction details.",
        "Clear communication and ownership from task start to delivery.",
    ],
    niceToHave: [
        "Experience with animations, micro-interactions, or 3D/web visual elements.",
        "Knowledge of WordPress, headless CMS tools, or no-code integrations.",
        "Basic understanding of backend APIs, form handling, and analytics tracking.",
    ],
    whatYouWillBuild: [
        "Build polished marketing and business websites.",
        "Translate Figma or visual references into production-ready pages.",
        "Improve speed, accessibility, and mobile experience.",
    ],
};

const emptyJob: RichJobPostingInput = {
    title: "",
    department: "",
    location: "",
    employmentType: "Full-time",
    salaryRange: "",
    description: "",
    requirements: [],
    status: "Draft",
    applyEyebrow: "",
    summary: "",
    level: "",
    skills: [],
    responsibilities: [],
    niceToHave: [],
    whatYouWillBuild: [],
};
const emptyApplicant: ApplicantInput = {
    jobPosting: null,
    name: "",
    email: "",
    phone: "",
    resumeUrl: "",
    source: "Manual",
    stage: "Applied",
    rating: 0,
};
const emptyHrDetails: HrDetailsInput = {
    personalPhone: "",
    personalEmail: "",
    personalAddress: "",
    emergencyContact: "",
    personalNotes: "",
};
const officialShiftDurationMs = 8 * 60 * 60 * 1000;

type HrDetailsInput = Pick<EmployeeInput, "personalPhone" | "personalEmail" | "personalAddress" | "emergencyContact" | "personalNotes" | "contactRelationship" | "emergencyContactNumber">;
type ArchivedDeleteTarget = {
    id: string;
    kind: "employee" | "job" | "applicant";
    name: string;
    typeLabel: string;
};

function cleanJobText(value?: string) {
    return (value || "").trim();
}

function cleanStringList(values?: unknown) {
    if (Array.isArray(values)) {
        return values.map((value) => String(value || "").trim()).filter(Boolean);
    }

    if (typeof values === "string") {
        return values.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    }

    return [];
}

function cleanSkillList(values?: unknown) {
    if (Array.isArray(values)) {
        return values.flatMap((value) => String(value || "").split(/[\n,]/)).map((value) => value.trim()).filter(Boolean);
    }

    if (typeof values === "string") {
        return values.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
    }

    return [];
}

function extractLegacySections(value: unknown, sectionNames: string[]) {
    const sections = Object.fromEntries(sectionNames.map((sectionName) => [sectionName, ""])) as Record<string, string>;
    if (typeof value !== "string") return sections;

    let activeSection = "";
    value.split(/\r?\n/).forEach((line) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;
        const matchingSection = sectionNames.find((sectionName) => sectionName.toLowerCase() === trimmedLine.toLowerCase());
        if (matchingSection) {
            activeSection = matchingSection;
            return;
        }
        if (activeSection) {
            sections[activeSection] = [sections[activeSection], trimmedLine].filter(Boolean).join("\n");
        }
    });

    return sections;
}

function parseLegacyDescriptionSections(value: unknown) {
    if (typeof value !== "string") {
        return { description: cleanJobText(String(value || "")), summary: "", applyEyebrow: "" };
    }

    const sections = extractLegacySections(value, ["Public page summary", "Apply page eyebrow"]);
    const firstSectionIndex = ["Public page summary", "Apply page eyebrow"]
        .map((sectionName) => value.toLowerCase().indexOf(sectionName.toLowerCase()))
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];

    return {
        description: cleanJobText(firstSectionIndex >= 0 ? value.slice(0, firstSectionIndex) : value),
        summary: cleanJobText(sections["Public page summary"]),
        applyEyebrow: cleanJobText(sections["Apply page eyebrow"]),
    };
}

function parseLegacyJobSections(value: unknown) {
    const sections = extractLegacySections(value, ["Responsibilities", "Requirements", "Nice to have", "What you will build", "Level", "Skills / tags"]);

    return {
        responsibilities: cleanStringList(sections.Responsibilities),
        requirements: cleanStringList(sections.Requirements),
        niceToHave: cleanStringList(sections["Nice to have"]),
        whatYouWillBuild: cleanStringList(sections["What you will build"]),
        level: cleanStringList(sections.Level),
        skills: cleanSkillList(sections["Skills / tags"]),
    };
}

function buildJobPostingPayload(form: RichJobPostingInput): JobPostingInput {
    return {
        ...form,
        title: cleanJobText(form.title),
        department: cleanJobText(form.department),
        location: cleanJobText(form.location),
        employmentType: cleanJobText(form.employmentType),
        salaryRange: cleanJobText(form.salaryRange),
        description: cleanJobText(form.description),
        summary: cleanJobText(form.summary),
        applyEyebrow: cleanJobText(form.applyEyebrow),
        level: cleanJobText(form.level),
        skills: cleanSkillList(form.skills),
        responsibilities: cleanStringList(form.responsibilities),
        requirements: cleanStringList(form.requirements),
        niceToHave: cleanStringList(form.niceToHave),
        whatYouWillBuild: cleanStringList(form.whatYouWillBuild),
    } as JobPostingInput;
}

function attendancePhTimeSettings(settings?: SystemSettings) {
    return settings ? { ...settings, attendanceTimeZone: ATTENDANCE_TIME_ZONE } : undefined;
}

const statusClass: Record<string, string> = {
    Open: "bg-emerald-400/10 text-emerald-200",
    Draft: "bg-white/[0.06] text-white/55",
    Paused: "bg-yellow-400/10 text-yellow-100/80",
    Closed: "bg-red-500/15 text-red-200",
    Applied: "bg-white/[0.06] text-white/55",
    Screening: "bg-sky-400/10 text-sky-100",
    Interview: "bg-violet-400/10 text-violet-100",
    Offer: "bg-emerald-400/10 text-emerald-200",
    Hired: "bg-emerald-500/15 text-emerald-100",
    Rejected: "bg-red-500/15 text-red-200",
    Active: "bg-emerald-400/10 text-emerald-200",
    Training: "bg-sky-400/10 text-sky-100",
    Archived: "bg-white/[0.06] text-white/55",
};

function Badge({ value }: { value: string }) {
    return (
        <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${statusClass[value] || "bg-white/[0.06] text-white/55"}`}>
            <span className="size-1.5 rounded-full bg-current" />
            {value}
        </span>
    );
}

function splitPhoneExtension(phone = "") {
    const match = phone.match(/^(.*?)\s*(?:ext\.?|extension)\s*[:.#-]?\s*(.+)$/i);
    return {
        number: (match ? match[1] : phone).trim(),
        extension: (match ? match[2] : "").trim(),
    };
}

function splitPhoneParts(phone = "") {
    const parsedPhone = splitPhoneExtension(phone);
    const digits = parsedPhone.number.replace(/\D/g, "");
    let operatorCode = "";
    let mobileNumber = "";

    if (digits.startsWith("63") && digits.length > 2) {
        operatorCode = digits.slice(2, 5);
        mobileNumber = digits.slice(5);
    } else if (digits.startsWith("1") && digits.length === 11) {
        operatorCode = digits.slice(1, 4);
        mobileNumber = digits.slice(4);
    } else if (digits.startsWith("0") && digits.length > 1) {
        operatorCode = digits.slice(1, 4);
        mobileNumber = digits.slice(4);
    } else if (digits.length > 10) {
        operatorCode = digits.slice(2, 5);
        mobileNumber = digits.slice(5);
    } else if (digits.length > 3) {
        operatorCode = digits.slice(0, 3);
        mobileNumber = digits.slice(3);
    } else {
        operatorCode = digits;
    }

    return {
        operatorCode,
        mobileNumber,
        extension: parsedPhone.extension.replace(/\D/g, ""),
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

function employeeInitials(name = "") {
    return name
        .split(" ")
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
}

function matchesEmployeeSearch(employee: Employee, searchTerm: string) {
    if (!searchTerm) return true;

    return [employee.name, employee.email, employee.phone, employee.role, employee.team, employee.employeeCode]
        .some((value) => String(value || "").toLowerCase().includes(searchTerm));
}

export default function AdminHr() {
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();
    const routeTab = searchParams.get("tab")?.toLowerCase();
    const initialTab = routeTab === "attendance" ? "Attendance" : "Job Postings";
    const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>(initialTab);
    const [search, setSearch] = useState("");
    const [jobModal, setJobModal] = useState<{ mode: "add" | "edit"; job?: JobPosting } | null>(null);
    const [applicantModal, setApplicantModal] = useState<{ mode: "add" | "edit"; applicant?: Applicant } | null>(null);
    const [hrDetailsModal, setHrDetailsModal] = useState<Employee | null>(null);
    const [jobForm, setJobForm] = useState<RichJobPostingInput>(emptyJob);
    const [applicantForm, setApplicantForm] = useState<ApplicantInput>(emptyApplicant);
    const [hrDetailsForm, setHrDetailsForm] = useState<HrDetailsInput>(emptyHrDetails);
    const [attendanceSingleDate, setAttendanceSingleDate] = useState("");
    const [attendanceDateFrom, setAttendanceDateFrom] = useState("");
    const [attendanceDateTo, setAttendanceDateTo] = useState("");
    const [attendanceEmployeeId, setAttendanceEmployeeId] = useState("");
    const [attendancePage, setAttendancePage] = useState(1);
    const [exportingAttendance, setExportingAttendance] = useState(false);
    const [archivedDeleteTarget, setArchivedDeleteTarget] = useState<ArchivedDeleteTarget | null>(null);

    const { data: jobs = [], isLoading: jobsLoading, isError: jobsError } = useQuery({
        queryKey: ["hr-jobs", search],
        queryFn: () => getJobPostings({ search }),
    });
    const { data: applicants = [], isLoading: applicantsLoading, isError: applicantsError } = useQuery({
        queryKey: ["hr-applicants", search],
        queryFn: () => getApplicants({ search }),
    });
    const { data: archivedApplicants = [], isLoading: archivedApplicantsLoading, isError: archivedApplicantsError } = useQuery({
        queryKey: ["hr-applicants-archived", search],
        queryFn: () => getApplicants({ search, archived: true }),
    });
    const { data: archivedJobs = [], isLoading: archivedJobsLoading, isError: archivedJobsError } = useQuery({
        queryKey: ["hr-jobs-archived", search],
        queryFn: () => getJobPostings({ search, archived: true }),
    });
    const { data: employees = [], isLoading: employeesLoading, isError: employeesError } = useQuery({
        queryKey: ["employees", "hr", "includeArchived"],
        queryFn: () => getEmployees({ includeArchived: true }),
    });
    const { data: systemSettings } = useQuery({
        queryKey: ["system-settings"],
        queryFn: getSystemSettings,
    });
    const refreshHr = () => {
        queryClient.invalidateQueries({ queryKey: ["hr-jobs"] });
        queryClient.invalidateQueries({ queryKey: ["hr-applicants"] });
        queryClient.invalidateQueries({ queryKey: ["hr-jobs-archived"] });
        queryClient.invalidateQueries({ queryKey: ["hr-applicants-archived"] });
        queryClient.invalidateQueries({ queryKey: ["employees"] });
        queryClient.invalidateQueries({ queryKey: ["employee-attendance"] });
    };
    const changeTab = (tab: (typeof tabs)[number]) => {
        setActiveTab(tab);
        if (tab === "Attendance") {
            setSearchParams({ tab: "attendance" });
            return;
        }
        setSearchParams({});
    };

    const createJobMutation = useMutation({ mutationFn: createJobPosting, onSuccess: () => { refreshHr(); closeJobModal(); } });
    const updateJobMutation = useMutation({
        mutationFn: ({ id, job }: { id: string; job: JobPostingInput }) => updateJobPosting(id, job),
        onSuccess: () => { refreshHr(); closeJobModal(); },
    });
    const archiveJobMutation = useMutation({ mutationFn: archiveJobPosting, onSuccess: refreshHr });
    const createApplicantMutation = useMutation({ mutationFn: createApplicant, onSuccess: () => { refreshHr(); closeApplicantModal(); } });
    const updateApplicantMutation = useMutation({
        mutationFn: ({ id, applicant }: { id: string; applicant: ApplicantInput }) => updateApplicant(id, applicant),
        onSuccess: () => { refreshHr(); closeApplicantModal(); },
    });
    const updateStageMutation = useMutation({
        mutationFn: ({ id, stage }: { id: string; stage: ApplicantStage }) => updateApplicantStage(id, stage),
        onSuccess: refreshHr,
    });
    const archiveApplicantMutation = useMutation({ mutationFn: archiveApplicant, onSuccess: refreshHr });
    const permanentlyDeleteJobMutation = useMutation({
        mutationFn: permanentlyDeleteJobPosting,
        onSuccess: () => {
            setArchivedDeleteTarget(null);
            refreshHr();
        },
    });
    const permanentlyDeleteApplicantMutation = useMutation({
        mutationFn: permanentlyDeleteApplicant,
        onSuccess: () => {
            setArchivedDeleteTarget(null);
            refreshHr();
        },
    });
    const permanentlyDeleteEmployeeMutation = useMutation({
        mutationFn: deleteEmployee,
        onSuccess: () => {
            setArchivedDeleteTarget(null);
            queryClient.invalidateQueries({ queryKey: ["employees"] });
        },
    });
    const updateEmployeeHrMutation = useMutation({
        mutationFn: ({ employee, details }: { employee: Employee; details: HrDetailsInput }) =>
            updateEmployee(employee._id, {
                name: employee.name,
                dateHired: employee.name,
                terminationDate: employee.name,
                employeeCode: employee.employeeCode,
                role: employee.role,
                team: employee.team,
                company: employee.company || "Assistly",
                email: employee.email,
                phone: employee.phone,
                personalPhone: details.personalPhone || "",
                personalEmail: details.personalEmail || "",
                personalAddress: details.personalAddress || "",
                emergencyContact: details.emergencyContact || "",
                contactRelationship: details.contactRelationship || "Father",
                emergencyContactNumber: details.emergencyContactNumber || "",
                personalNotes: details.personalNotes || "",
                bankName: employee.bankName || "",
                bankAccountName: employee.bankAccountName || "",
                bankAccountNumber: employee.bankAccountNumber || "",
                bankRoutingNumber: employee.bankRoutingNumber || "",
                salary: employee.salary || 0,
                status: employee.status,
                availabilityStatus: normalizeEmployeeAvailabilityStatus(employee.availabilityStatus),
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["employees"] });
            closeHrDetailsModal();
        },
    });
    useEffect(() => {
        if (routeTab === "attendance") {
            setActiveTab("Attendance");
        }
    }, [routeTab]);
    const stats = useMemo(
        () => [
            { label: "Open Jobs", value: jobs.filter((job) => job.status === "Open").length.toString(), icon: FiBriefcase },
            { label: "Applicants", value: applicants.filter((applicant) => applicant.stage !== "Hired").length.toString(), icon: FiUsers },
            { label: "Interviews", value: applicants.filter((applicant) => applicant.stage === "Interview").length.toString(), icon: FiFileText },
            { label: "Employed", value: employees.filter((employee) => employee.status !== "Archived").length.toString(), icon: FiStar },
        ],
        [applicants, employees, jobs]
    );
    const activeApplicants = applicants.filter((applicant) => applicant.stage !== "Hired");
    const employeeSearch = search.trim().toLowerCase();
    const visibleEmployees = employees.filter((employee) => {
        if (employee.status === "Archived") return false;
        return matchesEmployeeSearch(employee, employeeSearch);
    });
    const archivedEmployees = employees.filter((employee) => {
        if (employee.status !== "Archived") return false;
        return matchesEmployeeSearch(employee, employeeSearch);
    });
    const attendanceEmployeeOptions = useMemo(
        () =>
            employees
                .filter((employee) =>
                    ["Active", "Training"].includes(employee.status)
                )
                .sort((first, second) => first.name.localeCompare(second.name)),
        [employees]
    );
    const attendanceEmployees = useMemo(
        () =>
            attendanceEmployeeOptions
                .filter((employee) => matchesEmployeeSearch(employee, employeeSearch))
                .filter((employee) => !attendanceEmployeeId || employee._id === attendanceEmployeeId),
        [attendanceEmployeeId, attendanceEmployeeOptions, employeeSearch]
    );
    useEffect(() => {
        if (attendanceEmployeeId && !attendanceEmployeeOptions.some((employee) => employee._id === attendanceEmployeeId)) {
            setAttendanceEmployeeId("");
        }
    }, [attendanceEmployeeId, attendanceEmployeeOptions]);
    const archivedCount = archivedApplicants.length + archivedJobs.length + archivedEmployees.length;
    const isDeletingArchivedRecord = permanentlyDeleteJobMutation.isPending || permanentlyDeleteApplicantMutation.isPending || permanentlyDeleteEmployeeMutation.isPending;
    const deleteArchivedJob = (job: JobPosting) => {
        setArchivedDeleteTarget({ id: job._id, kind: "job", name: job.title || "Untitled job posting", typeLabel: "job posting" });
    };
    const deleteArchivedApplicant = (applicant: Applicant) => {
        setArchivedDeleteTarget({ id: applicant._id, kind: "applicant", name: applicant.name || "Unnamed applicant", typeLabel: "applicant" });
    };
    const deleteArchivedEmployee = (employee: Employee) => {
        setArchivedDeleteTarget({ id: employee._id, kind: "employee", name: employee.name || employee.email || employee.employeeCode || "Unnamed employee", typeLabel: "employee" });
    };
    const closeArchivedDeleteModal = () => {
        if (!isDeletingArchivedRecord) setArchivedDeleteTarget(null);
    };
    const confirmArchivedDelete = () => {
        if (!archivedDeleteTarget) return;
        if (archivedDeleteTarget.kind === "job") {
            permanentlyDeleteJobMutation.mutate(archivedDeleteTarget.id);
            return;
        }
        if (archivedDeleteTarget.kind === "applicant") {
            permanentlyDeleteApplicantMutation.mutate(archivedDeleteTarget.id);
            return;
        }
        permanentlyDeleteEmployeeMutation.mutate(archivedDeleteTarget.id);
    };
    const attendanceEmployeeIds = useMemo(
        () => attendanceEmployees.map((employee) => employee._id),
        [attendanceEmployees]
    );
    const attendanceRequestParams = useMemo(
        () => getAttendanceRequestParams(attendanceSingleDate, attendanceDateFrom, attendanceDateTo),
        [attendanceDateFrom, attendanceDateTo, attendanceSingleDate]
    );
    const attendanceQuery = useQuery({
        queryKey: ["employee-attendance", "batch", attendanceEmployeeIds, attendanceRequestParams],
        queryFn: () => getEmployeesAttendance(attendanceEmployeeIds, attendanceRequestParams),
        enabled: activeTab === "Attendance" && attendanceEmployeeIds.length > 0,
        refetchInterval: activeTab === "Attendance"
            ? attendanceRequestParams.all
                ? 120_000
                : 30_000
            : false,
        refetchOnWindowFocus: true,
    });
    const attendanceRecordsByEmployee = useMemo(() => {
        const recordsByEmployee = new Map<string, AttendanceRecord[]>();
        (attendanceQuery.data || []).forEach((record) => {
            const employeeId = String(record.employee || "");
            const records = recordsByEmployee.get(employeeId) || [];
            records.push(record);
            recordsByEmployee.set(employeeId, records);
        });
        return recordsByEmployee;
    }, [attendanceQuery.data]);
    const attendanceTableSettings = useMemo(() => attendancePhTimeSettings(systemSettings), [systemSettings]);
    const attendanceFilterDateKeys = useMemo(
        () => getAttendanceFilterDateKeys(attendanceSingleDate, attendanceDateFrom, attendanceDateTo, ATTENDANCE_TIME_ZONE),
        [attendanceDateFrom, attendanceDateTo, attendanceSingleDate]
    );
    const attendanceTableRows = useMemo(
        () =>
            attendanceEmployees.flatMap((employee) =>
                buildAttendanceRowsForFilter(
                    attendanceRecordsByEmployee.get(employee._id) || [],
                    attendanceTableSettings,
                    attendanceFilterDateKeys,
                    attendanceSingleDate,
                    attendanceDateFrom,
                    attendanceDateTo
                )
                    .map((record) => ({ ...record, employee }))
            ),
        [attendanceDateFrom, attendanceDateTo, attendanceEmployees, attendanceFilterDateKeys, attendanceRecordsByEmployee, attendanceSingleDate, attendanceTableSettings]
    );
    const attendanceTableLoading = employeesLoading || attendanceQuery.isLoading || attendanceQuery.isFetching;
    const attendanceTableError = employeesError || attendanceQuery.isError;
    const attendanceTotalPages = Math.max(1, Math.ceil(attendanceTableRows.length / attendancePageSize));
    const currentAttendancePage = Math.min(attendancePage, attendanceTotalPages);
    const pagedAttendanceRows = attendanceTableRows.slice(
        (currentAttendancePage - 1) * attendancePageSize,
        currentAttendancePage * attendancePageSize
    );
    const refreshAttendance = () => {
        queryClient.invalidateQueries({ queryKey: ["employees"] });
        queryClient.invalidateQueries({ queryKey: ["employee-attendance"] });
    };
    const openAddJob = () => {
        setJobForm({ ...emptyJob });
        setJobModal({ mode: "add" });
    };

    const openEditJob = (job: JobPosting) => {
        const richJob = job as JobPosting & Partial<RichJobPostingInput>;
        const legacySections = parseLegacyJobSections(richJob.requirements);
        const legacyDescription = parseLegacyDescriptionSections(job.description);
        const existingList = (currentValue: unknown, legacyValue: string[]) => {
            const currentItems = cleanStringList(currentValue);
            return currentItems.length ? currentItems : legacyValue;
        };
        const existingSkills = (currentValue: unknown, legacyValue: string[]) => {
            const currentItems = cleanSkillList(currentValue);
            return currentItems.length ? currentItems : legacyValue;
        };

        setJobForm({
            title: job.title,
            department: job.department,
            location: job.location,
            employmentType: job.employmentType,
            salaryRange: job.salaryRange,
            description: legacyDescription.description,
            requirements: existingList(richJob.requirements, legacySections.requirements),
            status: job.status,
            applyEyebrow: richJob.applyEyebrow || legacyDescription.applyEyebrow || "",
            summary: richJob.summary || legacyDescription.summary || "",
            level: richJob.level || (legacySections.level || [""])[0] || "",
            skills: existingSkills(richJob.skills, legacySections.skills),
            responsibilities: existingList(richJob.responsibilities, legacySections.responsibilities),
            niceToHave: existingList(richJob.niceToHave, legacySections.niceToHave),
            whatYouWillBuild: existingList(richJob.whatYouWillBuild, legacySections.whatYouWillBuild),
        });
        setJobModal({ mode: "edit", job });
    };

    const closeJobModal = () => {
        setJobModal(null);
        setJobForm({ ...emptyJob });
    };

    const openAddApplicant = () => {
        setApplicantForm(emptyApplicant);
        setApplicantModal({ mode: "add" });
    };

    const openEditApplicant = (applicant: Applicant) => {
        setApplicantForm({
            jobPosting: applicant.jobPosting?._id || null,
            name: applicant.name,
            email: applicant.email,
            phone: applicant.phone,
            resumeUrl: applicant.resumeUrl,
            source: applicant.source,
            stage: applicant.stage,
            rating: applicant.rating,
        });
        setApplicantModal({ mode: "edit", applicant });
    };

    const closeApplicantModal = () => {
        setApplicantModal(null);
        setApplicantForm(emptyApplicant);
    };

    const openHrDetailsModal = (employee: Employee) => {
        setHrDetailsModal(employee);
        setHrDetailsForm({
            personalPhone: employee.personalPhone || "",
            personalEmail: employee.personalEmail || "",
            personalAddress: employee.personalAddress || "",
            emergencyContact: employee.emergencyContact || "",
            personalNotes: employee.personalNotes || "",
        });
    };

    const closeHrDetailsModal = () => {
        setHrDetailsModal(null);
        setHrDetailsForm(emptyHrDetails);
    };

    const saveJob = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!jobForm.title.trim()) return;

        const jobPayload = buildJobPostingPayload(jobForm);

        if (jobModal?.mode === "edit" && jobModal.job) {
            updateJobMutation.mutate({ id: jobModal.job._id, job: jobPayload });
            return;
        }
        createJobMutation.mutate(jobPayload);
    };

    const saveApplicant = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!applicantForm.name.trim()) return;
        if (applicantModal?.mode === "edit" && applicantModal.applicant) {
            updateApplicantMutation.mutate({ id: applicantModal.applicant._id, applicant: applicantForm });
            return;
        }
        createApplicantMutation.mutate(applicantForm);
    };

    const saveHrDetails = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!hrDetailsModal) return;
        updateEmployeeHrMutation.mutate({ employee: hrDetailsModal, details: hrDetailsForm });
    };

    const exportAttendance = async () => {
        if (!attendanceEmployees.length || exportingAttendance) return;
        setExportingAttendance(true);
        try {
            const records = await getEmployeesAttendance(attendanceEmployeeIds, attendanceRequestParams);
            const recordsByEmployee = new Map<string, AttendanceRecord[]>();
            records.forEach((record) => {
                const employeeId = String(record.employee || "");
                const employeeRecords = recordsByEmployee.get(employeeId) || [];
                employeeRecords.push(record);
                recordsByEmployee.set(employeeId, employeeRecords);
            });
            const attendanceByEmployee = attendanceEmployees.map((employee) => ({
                employee,
                records: recordsByEmployee.get(employee._id) || [],
            }));
            const rows = attendanceByEmployee.flatMap(({ employee, records }) =>
                buildAttendanceRowsForFilter(
                    records,
                    attendanceTableSettings,
                    attendanceFilterDateKeys,
                    attendanceSingleDate,
                    attendanceDateFrom,
                    attendanceDateTo
                )
                    .map((record) => [
                        employee.name,
                        employee.team || "Unassigned",
                        employee.role || "",
                        record.date,
                        record.timeInStatus,
                        record.timeInOut,
                        record.firstBreakInOut,
                        record.lunchInOut,
                        record.secondBreakInOut,
                        record.offPhoneInOut,
                        record.offPhoneDuration,
                        formatOfficialSchedule(attendanceTableSettings),
                        record.duration,
                        record.overBreak,
                        record.overLunch,
                        record.undertime,
                        record.overtime,
                    ])
            );
            downloadCsv(
                `hr-attendance-${attendanceSingleDate || attendanceDateFrom || "all"}-${attendanceSingleDate || attendanceDateTo || "all"}.csv`,
                [["Employee", "Department", "Role", "Date (PH Time)", "Status", "Time In/Out (PH Time)", "1st Break Out/In (PH Time)", "Lunch Out/In (PH Time)", "2nd Break Out/In (PH Time)", "Off the Phone Out/In (PH Time)", "Off the Phone Duration", "Official Time", "Duration", "Over Break", "Over Lunch", "Undertime", "Overtime"], ...rows]
            );
        } finally {
            setExportingAttendance(false);
        }
    };

    return (
        <AdminLayout>
            <section className="min-h-[calc(100vh-8.5rem)]">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h2 className="text-2xl font-semibold text-white">HR</h2>
                        <p className="mt-1 text-sm text-white/50">Manage job postings, applicants, hiring stages, and recruitment notes.</p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                        <label className="flex h-11 w-[20rem] max-w-full items-center gap-3 rounded-lg border border-white/10 bg-[#090b13]/80 px-3 text-white/45 transition focus-within:border-[#842cff]">
                            <input className="h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search HR..." />
                            <FiSearch className="size-4" />
                        </label>
                        {(activeTab === "Job Postings" || activeTab === "Applicants") && (
                            <button className="flex h-11 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-5 text-sm font-semibold text-white" type="button" onClick={activeTab === "Job Postings" ? openAddJob : openAddApplicant}>
                                <FiPlus className="size-4" />
                                Add {activeTab === "Job Postings" ? "Job" : "Applicant"}
                            </button>
                        )}
                    </div>
                </div>

                <div className="mt-6 grid gap-3 md:grid-cols-4">
                    {stats.map((stat) => {
                        const Icon = stat.icon;
                        return (
                            <article key={stat.label} className="rounded-lg border border-white/10 bg-[#0c1018]/80 p-4 shadow-2xl shadow-black/10">
                                <div className="flex items-center gap-3">
                                    <span className="flex size-10 items-center justify-center rounded-lg bg-[#842cff]/18 text-[#b78cff]"><Icon className="size-5" /></span>
                                    <span>
                                        <p className="text-xs text-white/55">{stat.label}</p>
                                        <p className="mt-1 text-xl font-semibold text-white">{stat.value}</p>
                                    </span>
                                </div>
                            </article>
                        );
                    })}
                </div>

                <div className="mt-5 border-b border-white/10">
                    <div className="flex gap-3">
                        {tabs.map((tab) => (
                            <button key={tab} className={["h-12 px-4 text-sm font-semibold !text-black transition hover:!text-black", activeTab === tab ? "border-b-2 border-[#842cff] bg-[#842cff]/12" : ""].join(" ")} type="button" onClick={() => changeTab(tab)}>
                                {tab}
                            </button>
                        ))}
                    </div>
                </div>

                {activeTab === "Job Postings" ? (
                    <DataShell footer={`Showing ${jobs.length} job posting${jobs.length === 1 ? "" : "s"}`}>
                        <table className="w-full min-w-[90rem] table-fixed border-separate border-spacing-0 text-left">
                            <thead className="sticky top-0 z-10 bg-[#11151f] text-[0.74rem] font-medium text-white/65 shadow-[12px_0_0_#11151f]">
                                <tr>
                                    <th className="w-[23%] px-4 py-4">Job</th>
                                    <th className="w-[15%] px-4 py-4">Department</th>
                                    <th className="w-[17%] px-4 py-4">Location</th>
                                    <th className="w-[13%] px-4 py-4">Type</th>
                                    <th className="w-[13%] px-4 py-4">Salary</th>
                                    <th className="w-[10%] px-4 py-4">Status</th>
                                    <th className="w-[9%] px-4 py-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/10">
                                {jobsLoading && <EmptyRow colSpan={7} text="Loading job postings..." />}
                                {jobsError && <EmptyRow colSpan={7} text="Unable to load job postings." danger />}
                                {jobs.map((job) => (
                                    <tr key={job._id} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                        <td className="px-4 py-4"><p className="truncate font-semibold text-white">{job.title}</p><p className="mt-1 truncate text-xs text-white/42">{job.description || "No description"}</p></td>
                                        <td className="px-4 py-4 text-white/65">{job.department}</td>
                                        <td className="truncate px-4 py-4 text-white/65">{job.location}</td>
                                        <td className="px-4 py-4 text-white/65">{job.employmentType}</td>
                                        <td className="px-4 py-4 text-white/65">{job.salaryRange || "-"}</td>
                                        <td className="px-4 py-4"><Badge value={job.status} /></td>
                                        <td className="px-4 py-4 text-right"><RowActions onEdit={() => openEditJob(job)} onArchive={() => archiveJobMutation.mutate(job._id)} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </DataShell>
                ) : activeTab === "Archived" ? (
                    <DataShell footer={`Showing ${archivedCount} archived HR record${archivedCount === 1 ? "" : "s"}`}>
                        <table className="w-full min-w-[72rem] table-fixed border-separate border-spacing-0 text-left">
                            <thead className="sticky top-0 z-10 bg-[#11151f] text-[0.74rem] font-medium text-white/65 shadow-[12px_0_0_#11151f]">
                                <tr>
                                    <th className="w-[14%] px-4 py-4">Type</th>
                                    <th className="w-[27%] px-4 py-4">Record</th>
                                    <th className="w-[22%] px-4 py-4">Context</th>
                                    <th className="w-[14%] px-4 py-4">Status</th>
                                    <th className="w-[14%] px-4 py-4">Archived</th>
                                    <th className="w-[9%] px-4 py-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/10">
                                {(archivedApplicantsLoading || archivedJobsLoading || employeesLoading) && <EmptyRow colSpan={6} text="Loading archived records..." />}
                                {(archivedApplicantsError || archivedJobsError || employeesError) && <EmptyRow colSpan={6} text="Unable to load archived records." danger />}
                                {archivedEmployees.map((employee) => (
                                    <tr key={`employee-${employee._id}`} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                        <td className="px-4 py-4 text-white/55">Employee</td>
                                        <td className="px-4 py-4"><p className="truncate font-semibold text-white">{employee.name}</p><p className="mt-1 truncate text-xs text-white/42">{employee.email || "No email"}</p></td>
                                        <td className="truncate px-4 py-4 text-white/65">{employee.team || "Unassigned"} / {employee.role || "No role"}</td>
                                        <td className="px-4 py-4"><Badge value={employee.status} /></td>
                                        <td className="px-4 py-4 text-white/45">Employee list</td>
                                        <td className="px-4 py-4 text-right"><ArchivedDeleteButton isDeleting={isDeletingArchivedRecord} label={`Delete archived employee ${employee.name}`} onDelete={() => deleteArchivedEmployee(employee)} /></td>
                                    </tr>
                                ))}
                                {archivedJobs.map((job) => (
                                    <tr key={`job-${job._id}`} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                        <td className="px-4 py-4 text-white/55">Job Posting</td>
                                        <td className="px-4 py-4"><p className="truncate font-semibold text-white">{job.title}</p><p className="mt-1 truncate text-xs text-white/42">{job.description || "No description"}</p></td>
                                        <td className="px-4 py-4 text-white/65">{job.department || "General"}</td>
                                        <td className="px-4 py-4"><Badge value={job.status} /></td>
                                        <td className="px-4 py-4 text-white/45">{job.updatedAt ? formatCstDate(job.updatedAt) : "-"}</td>
                                        <td className="px-4 py-4 text-right"><ArchivedDeleteButton isDeleting={isDeletingArchivedRecord} label={`Delete archived job posting ${job.title}`} onDelete={() => deleteArchivedJob(job)} /></td>
                                    </tr>
                                ))}
                                {archivedApplicants.map((applicant) => (
                                    <tr key={`applicant-${applicant._id}`} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                        <td className="px-4 py-4 text-white/55">Applicant</td>
                                        <td className="px-4 py-4"><p className="truncate font-semibold text-white">{applicant.name}</p><p className="mt-1 truncate text-xs text-white/42">{applicant.email || "No email"}</p></td>
                                        <td className="truncate px-4 py-4 text-white/65">{applicant.jobPosting?.title || "No job selected"}</td>
                                        <td className="px-4 py-4"><Badge value={applicant.stage} /></td>
                                        <td className="px-4 py-4 text-white/45">{applicant.updatedAt ? formatCstDate(applicant.updatedAt) : "-"}</td>
                                        <td className="px-4 py-4 text-right"><ArchivedDeleteButton isDeleting={isDeletingArchivedRecord} label={`Delete archived applicant ${applicant.name}`} onDelete={() => deleteArchivedApplicant(applicant)} /></td>
                                    </tr>
                                ))}
                                {!archivedCount && !archivedApplicantsLoading && !archivedJobsLoading && !employeesLoading && <EmptyRow colSpan={6} text="No archived HR records yet." />}
                            </tbody>
                        </table>
                    </DataShell>
                ) : activeTab === "Employed" ? (
                    <DataShell footer={`Showing ${visibleEmployees.length} employee${visibleEmployees.length === 1 ? "" : "s"}`}>
                        <table className="w-full min-w-[72rem] table-fixed border-separate border-spacing-0 text-left">
                            <thead className="sticky top-0 z-10 bg-[#11151f] text-[0.74rem] font-medium text-white/65 shadow-[12px_0_0_#11151f]">
                                <tr>
                                    <th className="w-[20%] px-4 py-4">Employee</th>
                                    <th className="w-[18%] px-4 py-4">Personal Phone</th>
                                    <th className="w-[20%] px-4 py-4">Personal Email</th>
                                    <th className="w-[22%] px-4 py-4">Address</th>
                                    <th className="w-[12%] px-4 py-4">Status</th>
                                    <th className="w-[8%] px-4 py-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/10">
                                {employeesLoading && <EmptyRow colSpan={6} text="Loading employees..." />}
                                {employeesError && <EmptyRow colSpan={6} text="Unable to load employees." danger />}
                                {visibleEmployees.map((employee) => (
                                    <EmployeeRow key={employee._id} employee={employee} onEditHr={() => openHrDetailsModal(employee)} />
                                ))}
                                {!visibleEmployees.length && !employeesLoading && <EmptyRow colSpan={6} text="No employees yet." />}
                            </tbody>
                        </table>
                    </DataShell>
                ) : activeTab === "Attendance" ? (
                    <DataShell
                        footer={
                            <>
                                Showing {attendanceTableRows.length ? (currentAttendancePage - 1) * attendancePageSize + 1 : 0}
                                {"-"}
                                {Math.min(currentAttendancePage * attendancePageSize, attendanceTableRows.length)} of {attendanceTableRows.length}
                            </>
                        }
                        footerActions={(
                            <div className="flex flex-wrap items-center justify-end gap-2">
                                <button
                                    className="h-8 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-semibold !text-black transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                    type="button"
                                    disabled={currentAttendancePage <= 1}
                                    onClick={() => setAttendancePage((page) => Math.max(1, page - 1))}
                                >
                                    Previous
                                </button>
                                <span className="rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold !text-black">
                                    Page {currentAttendancePage} of {attendanceTotalPages}
                                </span>
                                <button
                                    className="h-8 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-semibold !text-black transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                    type="button"
                                    disabled={currentAttendancePage >= attendanceTotalPages}
                                    onClick={() => setAttendancePage((page) => Math.min(attendanceTotalPages, page + 1))}
                                >
                                    Next
                                </button>
                            </div>
                        )}
                    >
                        <div className="sticky top-0 z-20 flex w-full min-w-[68rem] flex-wrap items-end gap-3 border-b border-slate-300 bg-white px-4 py-3 shadow-sm">
                            <label className="grid min-w-[17rem] gap-1">
                                <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] !text-slate-600">Employee</span>
                                <select
                                    className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold !text-black outline-none focus:border-[#842cff]"
                                    value={attendanceEmployeeId}
                                    onChange={(event) => {
                                        setAttendanceEmployeeId(event.target.value);
                                        setAttendancePage(1);
                                    }}
                                >
                                    <option value="">All active/training employees</option>
                                    {attendanceEmployeeOptions.map((employee) => (
                                        <option key={employee._id} value={employee._id}>
                                            {employee.name}{employee.employeeCode ? ` · ${employee.employeeCode}` : ""}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="grid gap-1">
                                <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] !text-slate-600">Single date</span>
                                <input
                                    className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold !text-black outline-none focus:border-[#842cff]"
                                    type="date"
                                    value={attendanceSingleDate}
                                    onChange={(event) => {
                                        setAttendanceSingleDate(event.target.value);
                                        setAttendancePage(1);
                                        if (event.target.value) {
                                            setAttendanceDateFrom("");
                                            setAttendanceDateTo("");
                                        }
                                    }}
                                />
                            </label>
                            <label className="grid gap-1">
                                <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] !text-slate-600">From</span>
                                <input
                                    className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold !text-black outline-none focus:border-[#842cff]"
                                    type="date"
                                    value={attendanceDateFrom}
                                    onChange={(event) => {
                                        setAttendanceDateFrom(event.target.value);
                                        setAttendancePage(1);
                                        if (event.target.value) setAttendanceSingleDate("");
                                    }}
                                />
                            </label>
                            <label className="grid gap-1">
                                <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] !text-slate-600">To</span>
                                <input
                                    className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold !text-black outline-none focus:border-[#842cff]"
                                    type="date"
                                    value={attendanceDateTo}
                                    onChange={(event) => {
                                        setAttendanceDateTo(event.target.value);
                                        setAttendancePage(1);
                                        if (event.target.value) setAttendanceSingleDate("");
                                    }}
                                />
                            </label>
                            <button
                                className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold !text-black transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                                type="button"
                                onClick={refreshAttendance}
                                disabled={attendanceTableLoading}
                            >
                                <span className="inline-flex items-center gap-2">
                                    <FiRefreshCw className={attendanceTableLoading ? "size-4 animate-spin" : "size-4"} />
                                    Refresh
                                </span>
                            </button>
                            <button
                                className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold !text-black transition hover:bg-slate-50"
                                type="button"
                                onClick={() => {
                                    setAttendanceSingleDate("");
                                    setAttendanceDateFrom("");
                                    setAttendanceDateTo("");
                                    setAttendanceEmployeeId("");
                                    setAttendancePage(1);
                                }}
                            >
                                Clear
                            </button>
                            <Link
                                className="ml-auto flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold !text-black transition hover:bg-slate-50"
                                to="/admin/hr/attendance/new"
                            >
                                <FiPlus className="size-4" />
                                Add Attendance
                            </Link>
                            <button
                                className="flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold !text-black shadow-lg shadow-[#842cff]/20 disabled:opacity-60"
                                type="button"
                                onClick={exportAttendance}
                                disabled={exportingAttendance}
                            >
                                <FiDownload className="size-4" />
                                {exportingAttendance ? "Exporting..." : "Export"}
                            </button>
                        </div>
                        <table className="w-full min-w-[78rem] table-fixed border-separate border-spacing-0 text-left">
                            <thead className="sticky top-[4.05rem] z-10 bg-slate-100 text-center text-[0.7rem] font-semibold text-black shadow-[12px_0_0_#f1f5f9]">
                                <tr>
                                    <th className="w-[17%] px-2 py-2 text-left">Employee</th>
                                    <th className="w-[9%] px-2 py-2">
                                        <span>Date</span>
                                        <span className="block text-[0.64rem] font-medium leading-[0.7rem] !text-slate-600">PH Time</span>
                                    </th>
                                    <th className="w-[13%] px-2 py-2">
                                        <span>Time In/Out</span>
                                        <span className="block text-[0.64rem] font-medium leading-[0.7rem] !text-slate-600">
                                            {formatTimeRange(systemSettings?.officialShiftStartTime, systemSettings?.officialShiftEndTime, DEFAULT_ATTENDANCE_SHIFT_START, DEFAULT_ATTENDANCE_SHIFT_END)}
                                        </span>
                                    </th>
                                    <th className="w-[13%] px-2 py-2">
                                        <span>1st Break Out/In</span>
                                        <span className="block text-[0.64rem] font-medium leading-[0.7rem] !text-slate-600">
                                            {formatTimeRange(systemSettings?.officialFirstBreakStartTime, systemSettings?.officialFirstBreakEndTime, "01:00", "01:15")}
                                        </span>
                                    </th>
                                    <th className="w-[13%] px-2 py-2">
                                        <span>Lunch Out/In</span>
                                        <span className="block text-[0.64rem] font-medium leading-[0.7rem] !text-slate-600">
                                            {formatTimeRange(systemSettings?.officialLunchBreakStartTime, systemSettings?.officialLunchBreakEndTime, "03:15", "04:15")}
                                        </span>
                                    </th>
                                    <th className="w-[13%] px-2 py-2">
                                        <span>2nd Break Out/In</span>
                                        <span className="block text-[0.64rem] font-medium leading-[0.7rem] !text-slate-600">
                                            {formatTimeRange(systemSettings?.officialSecondBreakStartTime, systemSettings?.officialSecondBreakEndTime, "06:15", "06:30")}
                                        </span>
                                    </th>
                                    <th className="w-[13%] px-2 py-2">
                                        <span>Off the Phone</span>
                                        <span className="block text-[0.64rem] font-medium leading-[0.7rem] !text-slate-600">Out/In Â· Duration</span>
                                    </th>
                                    <th className="w-[8%] px-2 py-2">Duration</th>
                                    <th className="w-[8%] px-2 py-2">Overtime</th>
                                    <th className="w-[6%] px-2 py-2">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-300 bg-white">
                                {attendanceTableLoading && <EmptyRow colSpan={10} text="Loading attendance..." />}
                                {attendanceTableError && <EmptyRow colSpan={10} text="Unable to load attendance." danger />}
                                {!attendanceTableLoading && !attendanceTableError && pagedAttendanceRows.map((record) => (
                                    <tr key={`${record.employee._id}-${record.dateKey}`} className="text-center text-[0.72rem] !text-black transition hover:bg-slate-50">
                                        <td className="px-2 py-1.5 text-left">
                                            <div className="min-w-0">
                                                <p className="truncate text-[0.76rem] font-semibold !text-black">{record.employee.name}</p>
                                                <p className="truncate text-[0.62rem] !text-slate-600">{[record.employee.team || "Unassigned", record.employee.role || "-"].join(" · ")}</p>
                                            </div>
                                        </td>
                                        <td className="px-2 py-1.5 font-semibold !text-black">{record.date}</td>
                                        <td className="px-2 py-1.5 !text-black">
                                            <div className="flex flex-col items-center justify-center gap-0.5">
                                                <span className="whitespace-nowrap">{record.timeInOut}</span>
                                                <span className={`rounded-full border px-1.5 py-px text-[0.52rem] font-semibold leading-none ${timeInStatusClass(record.timeInStatus)}`}>
                                                    {record.timeInStatus}
                                                </span>
                                                {hasAttendanceAuditValue(record.undertime) && (
                                                    <AttendanceAuditPill label="Undertime" value={record.undertime} />
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-2 py-1.5 !text-black">
                                            <div className="flex flex-col items-center justify-center gap-0.5">
                                                <span className="whitespace-nowrap">{record.firstBreakInOut}</span>
                                                {hasAttendanceAuditValue(record.firstOverBreak) && (
                                                    <AttendanceAuditPill label="Over break" value={record.firstOverBreak} />
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-2 py-1.5 !text-black">
                                            <div className="flex flex-col items-center justify-center gap-0.5">
                                                <span className="whitespace-nowrap">{record.lunchInOut}</span>
                                                {hasAttendanceAuditValue(record.overLunch) && (
                                                    <AttendanceAuditPill label="Over lunch" value={record.overLunch} />
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-2 py-1.5 !text-black">
                                            <div className="flex flex-col items-center justify-center gap-0.5">
                                                <span className="whitespace-nowrap">{record.secondBreakInOut}</span>
                                                {hasAttendanceAuditValue(record.secondOverBreak) && (
                                                    <AttendanceAuditPill label="Over break" value={record.secondOverBreak} />
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-2 py-1.5 !text-black">
                                            <div className="flex flex-col items-center justify-center gap-0.5">
                                                <span className="max-w-[12rem] whitespace-normal">{record.offPhoneInOut}</span>
                                                {record.offPhoneDuration !== "-" && (
                                                    <span className="rounded-full border border-sky-200 bg-sky-50 px-1.5 py-px text-[0.52rem] font-semibold leading-none !text-sky-700">
                                                        {record.offPhoneDuration}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-2 py-1.5 !text-black">{record.duration}</td>
                                        <td className="px-2 py-1.5 !text-black">{record.overtime}</td>
                                        <td className="px-2 py-1.5">
                                            <div className="flex justify-center gap-1">
                                                {record.rawRecords.length ? (
                                                    <Link
                                                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[0.65rem] font-semibold !text-black transition hover:bg-slate-100"
                                                        to={`/admin/hr/attendance/${record.employee._id}/${record.dateKey}/edit`}
                                                    >
                                                        Edit
                                                    </Link>
                                                ) : (
                                                    <button className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[0.65rem] font-semibold !text-black opacity-50" type="button" disabled>
                                                        Edit
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                                {!attendanceTableLoading && !attendanceTableError && !attendanceTableRows.length && (
                                    <EmptyRow colSpan={10} text={attendanceEmployees.length ? "No attendance records for the selected range." : "No active employees found."} />
                                )}
                            </tbody>
                        </table>
                    </DataShell>
                ) : (
                    <DataShell footer={`Showing ${activeApplicants.length} applicant${activeApplicants.length === 1 ? "" : "s"}`}>
                        <table className="w-full min-w-[78rem] table-fixed border-separate border-spacing-0 text-left">
                            <thead className="sticky top-0 z-10 bg-[#11151f] text-[0.74rem] font-medium text-white/65 shadow-[12px_0_0_#11151f]">
                                <tr>
                                    <th className="w-[19%] px-4 py-4">Applicant</th>
                                    <th className="w-[18%] px-4 py-4">Job</th>
                                    <th className="w-[13%] px-4 py-4">Phone</th>
                                    <th className="w-[12%] px-4 py-4">Source</th>
                                    <th className="w-[13%] px-4 py-4">Stage</th>
                                    <th className="w-[10%] px-4 py-4">Rating</th>
                                    <th className="w-[8%] px-4 py-4">Resume</th>
                                    <th className="w-[7%] px-4 py-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/10">
                                {applicantsLoading && <EmptyRow colSpan={8} text="Loading applicants..." />}
                                {applicantsError && <EmptyRow colSpan={8} text="Unable to load applicants." danger />}
                                {activeApplicants.map((applicant) => (
                                    <tr key={applicant._id} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                        <td className="px-4 py-4"><p className="truncate font-semibold text-white">{applicant.name}</p><p className="mt-1 truncate text-xs text-white/42">{applicant.email || "No email"}</p></td>
                                        <td className="truncate px-4 py-4 text-white/65">{applicant.jobPosting?.title || "No job selected"}</td>
                                        <td className="px-4 py-4 text-white/65">{applicant.phone || "-"}</td>
                                        <td className="px-4 py-4 text-white/65">{applicant.source}</td>
                                        <td className="px-4 py-4">
                                            <select className="h-9 rounded-lg border border-white/10 bg-[#0d1018] px-2 text-xs font-semibold text-white outline-none" value={applicant.stage} onChange={(event) => updateStageMutation.mutate({ id: applicant._id, stage: event.target.value as ApplicantStage })}>
                                                {applicantStages.map((stage) => <option key={stage}>{stage}</option>)}
                                            </select>
                                        </td>
                                        <td className="px-4 py-4 text-white/65">{applicant.rating}/5</td>
                                        <td className="px-4 py-4">{applicant.resumeUrl ? <a className="text-[#b78cff] hover:text-white" href={applicant.resumeUrl} target="_blank" rel="noreferrer">View</a> : "-"}</td>
                                        <td className="px-4 py-4 text-right"><RowActions onEdit={() => openEditApplicant(applicant)} onArchive={() => archiveApplicantMutation.mutate(applicant._id)} /></td>
                                    </tr>
                                ))}
                                {!activeApplicants.length && !applicantsLoading && <EmptyRow colSpan={8} text="No applicants yet." />}
                            </tbody>
                        </table>
                    </DataShell>
                )}

                {jobModal && (
                    <JobModal form={jobForm} setForm={setJobForm} title={jobModal.mode === "add" ? "Add Job Posting" : "Edit Job Posting"} onClose={closeJobModal} onSubmit={saveJob} />
                )}

                {applicantModal && (
                    <ApplicantModal jobs={jobs} form={applicantForm} setForm={setApplicantForm} title={applicantModal.mode === "add" ? "Add Applicant" : "Edit Applicant"} onClose={closeApplicantModal} onSubmit={saveApplicant} />
                )}

                {hrDetailsModal && (
                    <HrDetailsModal
                        employee={hrDetailsModal}
                        form={hrDetailsForm}
                        isSaving={updateEmployeeHrMutation.isPending}
                        setForm={setHrDetailsForm}
                        onClose={closeHrDetailsModal}
                        onSubmit={saveHrDetails}
                    />
                )}

                {archivedDeleteTarget && (
                    <ArchivedDeleteConfirmModal
                        target={archivedDeleteTarget}
                        isDeleting={isDeletingArchivedRecord}
                        onCancel={closeArchivedDeleteModal}
                        onConfirm={confirmArchivedDelete}
                    />
                )}

            </section>
        </AdminLayout>
    );
}

function DataShell({ children, footer, footerActions }: { children: React.ReactNode; footer: React.ReactNode; footerActions?: React.ReactNode }) {
    return (
        <section className="mt-5 flex h-[calc(100vh-28rem)] min-h-[34rem] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-lg shadow-slate-900/10">
            <div className="content-scroll min-h-0 flex-1 overflow-auto bg-white">{children}</div>
            <div className="flex min-h-14 items-center justify-between gap-3 border-t border-slate-300 bg-white px-4 py-3">
                <p className="text-xs !text-slate-600">{footer}</p>
                <div className="flex items-center gap-2">
                    {footerActions}
                    <span className="rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-semibold !text-black">HR</span>
                </div>
            </div>
        </section>
    );
}

function RowActions({ onEdit, onArchive }: { onEdit: () => void; onArchive: () => void }) {
    return (
        <div className="flex justify-end gap-1.5">
            <button className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={onEdit}><FiEdit2 className="size-4" /></button>
            <button className="flex size-8 items-center justify-center rounded-lg border border-red-400/15 bg-red-400/10 text-red-100/60 transition hover:bg-red-400/15 hover:text-red-100" type="button" onClick={onArchive}><FiTrash2 className="size-4" /></button>
        </div>
    );
}

function ArchivedDeleteButton({ isDeleting, label, onDelete }: { isDeleting: boolean; label: string; onDelete: () => void }) {
    return (
        <button
            className="inline-flex size-8 items-center justify-center rounded-lg border border-red-400/20 bg-red-500/10 text-red-200 transition hover:border-red-300/40 hover:bg-red-500/20 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-45"
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            aria-label={label}
            title={label}
        >
            <FiTrash2 className="size-4" />
        </button>
    );
}

function ArchivedDeleteConfirmModal({
    target,
    isDeleting,
    onCancel,
    onConfirm,
}: {
    target: ArchivedDeleteTarget;
    isDeleting: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <div
            className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4 backdrop-blur-sm"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onCancel();
                }
            }}
        >
            <div
                className="modal-panel-enter w-full max-w-md rounded-lg border border-red-400/25 bg-[#0d1018] shadow-2xl shadow-black/45"
                role="dialog"
                aria-modal="true"
                aria-labelledby="archived-delete-title"
            >
                <div className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-red-400/25 bg-red-500/10 text-red-200">
                        <FiTrash2 className="size-4" />
                    </span>
                    <div>
                        <h3 id="archived-delete-title" className="text-base font-semibold text-white">
                            Delete archived {target.typeLabel}?
                        </h3>
                        <p className="mt-2 text-sm leading-6 text-white/60">
                            This will permanently delete <span className="font-semibold text-white">{target.name}</span>. This cannot be undone.
                        </p>
                    </div>
                </div>
                <div className="flex justify-end gap-2 px-5 py-4">
                    <button
                        className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/65 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                        type="button"
                        onClick={onCancel}
                        disabled={isDeleting}
                    >
                        Cancel
                    </button>
                    <button
                        className="h-10 rounded-lg border border-red-400/30 bg-red-500/15 px-4 text-sm font-semibold text-red-100 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-55"
                        type="button"
                        onClick={onConfirm}
                        disabled={isDeleting}
                    >
                        {isDeleting ? "Deleting..." : "Delete permanently"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function EmptyRow({ colSpan, text, danger = false }: { colSpan: number; text: string; danger?: boolean }) {
    return <tr><td className={`px-4 py-8 text-center text-sm ${danger ? "text-red-600" : "!text-black"}`} colSpan={colSpan}>{text}</td></tr>;
}

function isAttendanceRowWithinDateRange(record: AttendanceHistoryRow, singleDate: string, dateFrom: string, dateTo: string) {
    const recordShiftDate = record.dateKey;
    const from = singleDate || dateFrom;
    const to = singleDate || dateTo;
    if (from && recordShiftDate < from) return false;
    if (to && recordShiftDate > to) return false;
    return true;
}

type AttendanceHistoryRow = {
    dateKey: string;
    date: string;
    timeInOut: string;
    timeInStatus: AttendanceTimeInStatus;
    firstBreakInOut: string;
    lunchInOut: string;
    secondBreakInOut: string;
    offPhoneInOut: string;
    offPhoneDuration: string;
    duration: string;
    firstOverBreak: string;
    secondOverBreak: string;
    overBreak: string;
    overLunch: string;
    undertime: string;
    overtime: string;
    primaryRecord?: AttendanceRecord;
    timeInRecord?: AttendanceRecord;
    timeOutRecord?: AttendanceRecord;
    firstBreakOutRecord?: AttendanceRecord;
    firstBreakInRecord?: AttendanceRecord;
    lunchOutRecord?: AttendanceRecord;
    lunchInRecord?: AttendanceRecord;
    secondBreakOutRecord?: AttendanceRecord;
    secondBreakInRecord?: AttendanceRecord;
    rawRecords: AttendanceRecord[];
    isAbsent?: boolean;
};

type AttendanceTimeInStatus = "Early" | "On time" | "Late" | "No time in" | "Absent";

function firstAttendanceRecord(records: AttendanceRecord[], sources: AttendanceRecord["source"][]) {
    return records.find((record) => sources.includes(record.source));
}

function formatTimePair(first?: string, second?: string, timeZone = ATTENDANCE_TIME_ZONE) {
    const firstLabel = formatTimeInTimeZone(first, timeZone) || "00:00:00";
    const secondLabel = formatTimeInTimeZone(second, timeZone) || "00:00:00";
    return `${firstLabel} - ${secondLabel}`;
}

function formatDuration(milliseconds: number) {
    if (milliseconds <= 0) return "-";
    const totalMinutes = Math.round(milliseconds / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `${minutes}m`;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function elapsedBetween(start?: string, end?: string) {
    if (!start || !end) return 0;
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();
    if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime <= startTime) return 0;
    return endTime - startTime;
}

function payrollLunchDuration() {
    return 60 * 60 * 1000;
}

function scheduledDuration(start: string | undefined, end: string | undefined, defaultStart: string, defaultEnd: string) {
    const startMinutes = minutesFromTime(start || defaultStart);
    const endMinutes = minutesFromTime(end || defaultEnd);
    const durationMinutes = endMinutes >= startMinutes ? endMinutes - startMinutes : endMinutes + 1440 - startMinutes;

    return Math.max(durationMinutes, 0) * 60 * 1000;
}

function attendanceTimestamp(record?: AttendanceRecord) {
    if (!record) return 0;
    const timestamp = new Date(record.timeIn).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
}

function buildBreakPairs(records: AttendanceRecord[]) {
    const breakIns = records.filter((record) => record.source === "Break In");
    const usedBreakIns = new Set<AttendanceRecord>();
    return records
        .filter((record) => record.source === "Break Out")
        .map((breakOut) => {
            const breakOutTime = attendanceTimestamp(breakOut);
            const breakIn = breakIns.find((record) => !usedBreakIns.has(record) && attendanceTimestamp(record) >= breakOutTime);
            if (breakIn) usedBreakIns.add(breakIn);
            return { breakOut: breakOut.timeIn, breakIn: breakIn?.timeIn || "", breakOutRecord: breakOut, breakInRecord: breakIn };
        });
}

function formatScheduleTime(value = "00:00") {
    const [hourValue, minuteValue] = value.split(":").map((part) => Number(part));
    if (!Number.isFinite(hourValue) || !Number.isFinite(minuteValue)) return value;

    const period = hourValue >= 12 ? "PM" : "AM";
    const hour = hourValue % 12 || 12;
    const minute = String(minuteValue).padStart(2, "0");

    return `${hour}:${minute} ${period}`;
}

function formatTimeRange(start?: string, end?: string, defaultStart = "00:00", defaultEnd = "00:00") {
    return `${formatScheduleTime(start || defaultStart)} - ${formatScheduleTime(end || defaultEnd)}`;
}

function minutesFromTime(value = "00:00") {
    const [hours, minutes] = value.split(":").map((part) => Number(part));
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
    return hours * 60 + minutes;
}

function getTimeInStatus(timeIn: string, timeZone: string, shiftStart: string, shiftEnd: string): AttendanceTimeInStatus {
    const parts = zonedDateParts(timeIn, timeZone);
    if (!parts) return "No time in";
    const shiftStartMinutes = minutesFromTime(shiftStart);
    const shiftEndMinutes = minutesFromTime(shiftEnd);
    const isOvernightShift = shiftEndMinutes <= shiftStartMinutes;
    const normalizedMinutes = isOvernightShift && parts.minutes < shiftEndMinutes ? parts.minutes + 1440 : parts.minutes;
    const normalizedShiftStart = isOvernightShift ? shiftStartMinutes : shiftStartMinutes;
    const difference = normalizedMinutes - normalizedShiftStart;

    if (difference < 0) return "Early";
    if (difference === 0) return "On time";
    return "Late";
}

function timeInStatusClass(status: AttendanceTimeInStatus) {
    if (status === "Absent") return "border-red-200 bg-red-50 !text-red-700";
    if (status === "Late") return "border-red-200 bg-red-50 !text-red-700";
    if (status === "Early") return "border-sky-200 bg-sky-50 !text-sky-700";
    if (status === "On time") return "border-emerald-200 bg-emerald-50 !text-emerald-700";
    return "border-slate-200 bg-slate-50 !text-slate-600";
}

function hasAttendanceAuditValue(value: string) {
    return value !== "-";
}

function AttendanceAuditPill({ label, value }: { label: string; value: string }) {
    return (
        <span
            className="rounded-full border border-red-200 bg-red-50 px-1.5 py-px text-[0.52rem] font-semibold leading-none !text-red-700"
            title={`${label}: ${value}`}
        >
            {label}
        </span>
    );
}

function parseDateKeyToUtc(value: string) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const [, year, month, day] = match;
    const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(timestamp) ? null : timestamp;
}

function formatDateKeyFromUtc(timestamp: number) {
    const date = new Date(timestamp);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function currentDateKeyInTimeZone(timeZone = ATTENDANCE_TIME_ZONE) {
    const parts = zonedDateTimeParts(new Date(), timeZone);
    return parts ? `${parts.year}-${parts.month}-${parts.day}` : "";
}

function getAttendanceFilterDateKeys(singleDate: string, dateFrom: string, dateTo: string, timeZone = ATTENDANCE_TIME_ZONE) {
    const startKey = singleDate || dateFrom || dateTo;
    const endKey = singleDate || dateTo || dateFrom;
    const startTimestamp = parseDateKeyToUtc(startKey);
    const endTimestamp = parseDateKeyToUtc(endKey);

    if (startTimestamp === null || endTimestamp === null) {
        return [];
    }

    const from = Math.min(startTimestamp, endTimestamp);
    const to = Math.max(startTimestamp, endTimestamp);
    const todayKey = currentDateKeyInTimeZone(timeZone);
    const keys: string[] = [];

    for (let timestamp = from; timestamp <= to; timestamp += 24 * 60 * 60 * 1000) {
        const dateKey = formatDateKeyFromUtc(timestamp);

        if (!todayKey || dateKey <= todayKey) {
            keys.push(dateKey);
        }
    }

    return keys;
}

function getAttendanceRequestParams(
    singleDate: string,
    dateFrom: string,
    dateTo: string
): Pick<AttendanceQuery, "all" | "from" | "to"> {
    const startKey = singleDate || dateFrom;
    const endKey = singleDate || dateTo || dateFrom;

    if (!startKey || !endKey) {
        return { all: true };
    }

    const start = new Date(`${startKey}T00:00:00+08:00`);
    const end = new Date(`${endKey}T00:00:00+08:00`);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return { all: true };
    }

    return {
        from: new Date(start.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        to: new Date(end.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    };
}

function buildAbsentAttendanceRow(dateKey: string): AttendanceHistoryRow {
    return {
        dateKey,
        date: formatAttendanceSlotLabel(dateKey),
        timeInOut: "Absent",
        timeInStatus: "Absent",
        firstBreakInOut: "-",
        lunchInOut: "-",
        secondBreakInOut: "-",
        offPhoneInOut: "-",
        offPhoneDuration: "-",
        duration: "-",
        firstOverBreak: "-",
        secondOverBreak: "-",
        overBreak: "-",
        overLunch: "-",
        undertime: "-",
        overtime: "-",
        rawRecords: [],
        isAbsent: true,
    };
}

function buildAttendanceRowsForFilter(
    records: AttendanceRecord[],
    settings: SystemSettings | undefined,
    dateKeys: string[],
    singleDate: string,
    dateFrom: string,
    dateTo: string
) {
    const rows = buildAttendanceHistoryRows(records, settings)
        .filter((record) => isAttendanceRowWithinDateRange(record, singleDate, dateFrom, dateTo));

    if (!dateKeys.length) {
        return rows;
    }

    const rowsByDateKey = new Set(rows.map((row) => row.dateKey));
    const absentRows = dateKeys
        .filter((dateKey) => !rowsByDateKey.has(dateKey))
        .map(buildAbsentAttendanceRow);

    return [...rows, ...absentRows].sort((left, right) => right.dateKey.localeCompare(left.dateKey));
}

function zonedDateParts(value?: Date | string | null, timeZone = ATTENDANCE_TIME_ZONE) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0);
    return {
        year: part("year"),
        month: part("month"),
        day: part("day"),
        minutes: part("hour") * 60 + part("minute"),
    };
}

function zonedDateTimeParts(value?: Date | string | null, timeZone = ATTENDANCE_TIME_ZONE) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const valueFor = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
    return {
        year: valueFor("year"),
        month: valueFor("month"),
        day: valueFor("day"),
        hour: valueFor("hour"),
        minute: valueFor("minute"),
    };
}

function formatOfficialSchedule(settings?: SystemSettings) {
    const timeZone = attendanceSlotTimeZone(settings);
    return [
        `Time zone: ${timeZone}`,
        `In/Out: ${formatTimeRange(settings?.officialShiftStartTime, settings?.officialShiftEndTime, DEFAULT_ATTENDANCE_SHIFT_START, DEFAULT_ATTENDANCE_SHIFT_END)}`,
        `Break 1: ${formatTimeRange(settings?.officialFirstBreakStartTime, settings?.officialFirstBreakEndTime, "01:00", "01:15")}`,
        `Lunch: ${formatTimeRange(settings?.officialLunchBreakStartTime, settings?.officialLunchBreakEndTime, "03:15", "04:15")}`,
        `Break 2: ${formatTimeRange(settings?.officialSecondBreakStartTime, settings?.officialSecondBreakEndTime, "06:15", "06:30")}`,
    ].join("\n");
}

function buildAttendanceHistoryRows(records: AttendanceRecord[], settings?: SystemSettings): AttendanceHistoryRow[] {
    const timeZone = attendanceSlotTimeZone(settings);
    const shiftStart = attendanceSlotShiftStart(settings);
    const shiftEnd = attendanceSlotShiftEnd(settings);
    const groupedRecords = groupAttendanceRecordsBySlot(records, settings);

    return Object.entries(groupedRecords)
        .map(([dateKey, dayRecords]) => {
            const sortedRecords = [...dayRecords].sort((left, right) => new Date(left.timeIn).getTime() - new Date(right.timeIn).getTime());
            const timeInRecord = firstAttendanceRecord(sortedRecords, ["Login", "Time In"]);
            const timeOutRecord = [...sortedRecords].reverse().find((record) => ["Logout", "Time Out"].includes(record.source));
            const primaryRecord = timeInRecord || sortedRecords[0];
            const timeIn = timeInRecord?.timeIn || "";
            const timeOut = timeOutRecord?.timeIn || "";
            const lunchOutRecord = firstAttendanceRecord(sortedRecords, ["Lunch Break Out"]);
            const lunchInRecord = [...sortedRecords].reverse().find((record) => record.source === "Lunch Break In");
            const lunchOut = lunchOutRecord?.timeIn || "";
            const lunchIn = lunchInRecord?.timeIn || "";
            const breakPairs = buildBreakPairs(sortedRecords);
            const offPhoneSessions = buildOffPhoneAttendanceSessions(sortedRecords);
            const offPhoneDuration = offPhoneSessions.reduce((total, session) => total + session.durationMs, 0);
            const offPhoneInOut = offPhoneSessions.length
                ? offPhoneSessions
                    .map((session) => {
                        const startedAt = formatTimeInTimeZone(session.startedAt, timeZone) || "00:00:00";
                        const endedAt = session.endedAt ? formatTimeInTimeZone(session.endedAt, timeZone) || "00:00:00" : "Open";
                        return `${startedAt} - ${endedAt}`;
                    })
                    .join("; ")
                : "-";
            const lunchOutTime = lunchOut ? new Date(lunchOut).getTime() : 0;
            const lunchInTime = lunchIn ? new Date(lunchIn).getTime() : lunchOutTime;
            const firstBreak = breakPairs.find((pair) => !lunchOutTime || new Date(pair.breakOut).getTime() < lunchOutTime) || breakPairs[0];
            const secondBreak = breakPairs.find((pair) => {
                if (pair === firstBreak) return false;
                const breakOutTime = new Date(pair.breakOut).getTime();
                return lunchInTime ? breakOutTime > lunchInTime : lunchOutTime ? breakOutTime > lunchOutTime : true;
            }) || breakPairs.find((pair) => pair !== firstBreak);
            const isWeekendSlot = isWeekendAttendanceSlotKey(dateKey);
            const allowedFirstBreakDuration = scheduledDuration(settings?.officialFirstBreakStartTime, settings?.officialFirstBreakEndTime, "01:00", "01:15");
            const allowedSecondBreakDuration = scheduledDuration(settings?.officialSecondBreakStartTime, settings?.officialSecondBreakEndTime, "06:15", "06:30");
            const allowedLunchDuration = scheduledDuration(settings?.officialLunchBreakStartTime, settings?.officialLunchBreakEndTime, "03:15", "04:15") || payrollLunchDuration();
            const firstBreakDuration = elapsedBetween(firstBreak?.breakOut, firstBreak?.breakIn);
            const secondBreakDuration = elapsedBetween(secondBreak?.breakOut, secondBreak?.breakIn);
            const actualLunchDuration = elapsedBetween(lunchOut, lunchIn);
            const firstOverBreakDuration = Math.max(firstBreakDuration - allowedFirstBreakDuration, 0);
            const secondOverBreakDuration = Math.max(secondBreakDuration - allowedSecondBreakDuration, 0);
            const overBreakDuration = firstOverBreakDuration + secondOverBreakDuration;
            const overLunchDuration = Math.max(actualLunchDuration - allowedLunchDuration, 0);
            const lunchDuration = isWeekendSlot
                ? actualLunchDuration
                : actualLunchDuration > 0
                    ? Math.max(actualLunchDuration, allowedLunchDuration)
                    : allowedLunchDuration;
            const hasTimeIn = Boolean(timeIn);
            const hasTimeOut = Boolean(timeOut && elapsedBetween(timeIn, timeOut) > 0);
            const assumedRegularDuration = hasTimeIn && !hasTimeOut && !isWeekendSlot ? officialShiftDurationMs : 0;
            const rawWorkedDuration = assumedRegularDuration || Math.max(0, elapsedBetween(timeIn, timeOut) - lunchDuration - overBreakDuration);
            const workedDuration = isWeekendSlot ? rawWorkedDuration : Math.min(rawWorkedDuration, officialShiftDurationMs);
            const undertimeDuration = !isWeekendSlot && hasTimeIn ? Math.max(officialShiftDurationMs - workedDuration, 0) : 0;
            const overtimeDuration = isWeekendSlot ? rawWorkedDuration : 0;

            return {
                dateKey,
                date: formatAttendanceSlotLabel(dateKey),
                timeInOut: formatTimePair(timeIn, timeOut, timeZone),
                timeInStatus: getTimeInStatus(timeIn, timeZone, shiftStart, shiftEnd),
                firstBreakInOut: formatTimePair(firstBreak?.breakOut, firstBreak?.breakIn, timeZone),
                lunchInOut: formatTimePair(lunchOut, lunchIn, timeZone),
                secondBreakInOut: formatTimePair(secondBreak?.breakOut, secondBreak?.breakIn, timeZone),
                offPhoneInOut,
                offPhoneDuration: formatDuration(offPhoneDuration),
                duration: formatDuration(workedDuration),
                firstOverBreak: formatDuration(firstOverBreakDuration),
                secondOverBreak: formatDuration(secondOverBreakDuration),
                overBreak: formatDuration(overBreakDuration),
                overLunch: formatDuration(overLunchDuration),
                undertime: formatDuration(undertimeDuration),
                overtime: formatDuration(overtimeDuration),
                primaryRecord,
                timeInRecord,
                timeOutRecord,
                firstBreakOutRecord: firstBreak?.breakOutRecord,
                firstBreakInRecord: firstBreak?.breakInRecord,
                lunchOutRecord,
                lunchInRecord,
                secondBreakOutRecord: secondBreak?.breakOutRecord,
                secondBreakInRecord: secondBreak?.breakInRecord,
                rawRecords: sortedRecords,
            };
        })
        .sort((left, right) => right.dateKey.localeCompare(left.dateKey));
}

function csvCell(value: string | number | null | undefined) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function EmployeeRow({ employee, onEditHr }: { employee: Employee; onEditHr: () => void }) {
    return (
        <tr className="text-sm text-white/80 transition hover:bg-white/[0.035]">
            <td className="px-4 py-4">
                <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-[#842cff]/16 text-xs font-bold text-white">
                        {employee.profileImage ? (
                            <img className="size-full object-cover" src={employee.profileImage} alt={employee.name} />
                        ) : (
                            employeeInitials(employee.name)
                        )}
                    </div>
                    <div className="min-w-0">
                        <p className="truncate font-semibold text-white">{employee.name}</p>
                        <p className="mt-1 truncate text-xs text-white/42">{employee.email || "No work email"}</p>
                    </div>
                </div>
            </td>
            <td className="px-4 py-4">
                {employee.personalPhone ? (
                    <span className="inline-flex max-w-full items-center gap-2 text-white/70">
                        <FiPhone className="size-3.5 shrink-0 text-white/45" />
                        <span className="truncate">{formatPhoneForDisplay(employee.personalPhone)}</span>
                    </span>
                ) : (
                    <span className="text-white/35">-</span>
                )}
            </td>
            <td className="px-4 py-4">
                {employee.personalEmail ? (
                    <p className="truncate text-white/65">{employee.personalEmail}</p>
                ) : (
                    <span className="text-white/35">-</span>
                )}
            </td>
            <td className="px-4 py-4"><p className="truncate text-white/65">{employee.personalAddress || "-"}</p></td>
            <td className="px-4 py-4"><Badge value={employee.status} /></td>
            <td className="px-4 py-4 text-right">
                <button className="inline-flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={onEditHr} aria-label={`Edit HR details for ${employee.name}`}>
                    <FiEdit2 className="size-4" />
                </button>
            </td>
        </tr>
    );
}

function HrDetailsModal({
    employee,
    form,
    isSaving,
    setForm,
    onClose,
    onSubmit,
}: {
    employee: Employee;
    form: HrDetailsInput;
    isSaving: boolean;
    setForm: React.Dispatch<React.SetStateAction<HrDetailsInput>>;
    onClose: () => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
    return (
        <Modal
            title="Edit HR Details"
            subtitle={`Private personal details for ${employee.name}.`}
            onClose={onClose}
            onSubmit={onSubmit}
            submitLabel={isSaving ? "Saving..." : "Save Details"}
        >
            <div className="grid gap-3 sm:grid-cols-2">
                <input
                    className="h-11 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none"
                    value={form.personalPhone || ""}
                    onChange={(event) => setForm((details) => ({ ...details, personalPhone: event.target.value }))}
                    placeholder="Personal phone"
                />
                <input
                    className="h-11 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none"
                    type="email"
                    value={form.personalEmail || ""}
                    onChange={(event) => setForm((details) => ({ ...details, personalEmail: event.target.value }))}
                    placeholder="Personal email"
                />
            </div>
            <textarea
                className="min-h-24 rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-semibold text-white outline-none"
                value={form.personalAddress || ""}
                onChange={(event) => setForm((details) => ({ ...details, personalAddress: event.target.value }))}
                placeholder="Personal address"
            />
            <input
                className="h-11 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none"
                value={form.emergencyContact || ""}
                onChange={(event) => setForm((details) => ({ ...details, emergencyContact: event.target.value }))}
                placeholder="Emergency contact"
            />
            <textarea
                className="min-h-24 rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-semibold text-white outline-none"
                value={form.personalNotes || ""}
                onChange={(event) => setForm((details) => ({ ...details, personalNotes: event.target.value }))}
                placeholder="Private HR notes"
            />
        </Modal>
    );
}

function MultiValueField({
    label,
    values,
    placeholder,
    addLabel,
    onChange,
}: {
    label: string;
    values: string[];
    placeholder: string;
    addLabel: string;
    onChange: (values: string[]) => void;
}) {
    const editableValues = values.length ? values : [""];
    const inputClass = "min-h-11 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm font-semibold text-white outline-none transition focus:border-[#842cff]";

    const updateValue = (index: number, value: string) => {
        const nextValues = [...editableValues];
        nextValues[index] = value;
        onChange(nextValues);
    };

    const removeValue = (index: number) => {
        const nextValues = editableValues.filter((_, valueIndex) => valueIndex !== index);
        onChange(nextValues);
    };

    return (
        <fieldset className="grid gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between gap-3">
                <legend className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-white/45">{label}</legend>
                <span className="rounded-full border border-white/10 px-2 py-0.5 text-[0.65rem] font-semibold text-white/40">
                    {editableValues.filter((value) => value.trim()).length} item{editableValues.filter((value) => value.trim()).length === 1 ? "" : "s"}
                </span>
            </div>
            <div className="grid gap-2">
                {editableValues.map((value, index) => (
                    <div className="flex gap-2" key={`${label}-${index}`}>
                        <input
                            className={`${inputClass} min-w-0 flex-1`}
                            value={value}
                            onChange={(event) => updateValue(index, event.target.value)}
                            placeholder={index === 0 ? placeholder : `${placeholder} ${index + 1}`}
                        />
                        <button
                            className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/45 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                            type="button"
                            disabled={editableValues.length === 1 && !value.trim()}
                            onClick={() => removeValue(index)}
                            aria-label={`Remove ${label} item`}
                        >
                            <FiX className="size-4" />
                        </button>
                    </div>
                ))}
            </div>
            <button
                className="mt-1 flex h-10 items-center justify-center gap-2 rounded-lg border border-[#842cff]/40 bg-[#842cff]/10 px-3 text-xs font-bold uppercase tracking-[0.14em] text-[#d6c2ff] transition hover:bg-[#842cff]/18"
                type="button"
                onClick={() => onChange([...editableValues, ""])}
            >
                <FiPlus className="size-4" />
                {addLabel}
            </button>
        </fieldset>
    );
}

function JobModal({ title, form, setForm, onClose, onSubmit }: { title: string; form: RichJobPostingInput; setForm: React.Dispatch<React.SetStateAction<RichJobPostingInput>>; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
    const fieldClass = "h-11 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff]";
    const textAreaClass = "min-h-28 rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff]";
    const labelClass = "grid gap-1.5";
    const labelTextClass = "text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-white/45";

    return (
        <Modal title={title} subtitle="Create and publish job openings." onClose={onClose} onSubmit={onSubmit}>
            <div className="rounded-xl border border-[#842cff]/30 bg-[#842cff]/10 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <p className="text-sm font-semibold text-white">Web Developer template</p>
                        <p className="mt-1 text-xs leading-5 text-white/55">Auto-fill the posting with individual skills, responsibilities, requirements, nice-to-have items, and build items.</p>
                    </div>
                    <button
                        className="h-10 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-xs font-bold uppercase tracking-[0.14em] text-white"
                        type="button"
                        onClick={() => setForm({ ...webDeveloperJobTemplate })}
                    >
                        Use template
                    </button>
                </div>
            </div>

            <label className={labelClass}>
                <span className={labelTextClass}>Job title</span>
                <input className={fieldClass} value={form.title} onChange={(event) => setForm((job) => ({ ...job, title: event.target.value }))} placeholder="Web Developer" />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
                <label className={labelClass}>
                    <span className={labelTextClass}>Department / team</span>
                    <input className={fieldClass} value={form.department} onChange={(event) => setForm((job) => ({ ...job, department: event.target.value }))} placeholder="Engineering / Web Team" />
                </label>
                <label className={labelClass}>
                    <span className={labelTextClass}>Location</span>
                    <input className={fieldClass} value={form.location} onChange={(event) => setForm((job) => ({ ...job, location: event.target.value }))} placeholder="Remote" />
                </label>
                <label className={labelClass}>
                    <span className={labelTextClass}>Employment type</span>
                    <input className={fieldClass} value={form.employmentType} onChange={(event) => setForm((job) => ({ ...job, employmentType: event.target.value }))} placeholder="Full-time / Project-based" />
                </label>
                <label className={labelClass}>
                    <span className={labelTextClass}>Salary range</span>
                    <input className={fieldClass} value={form.salaryRange} onChange={(event) => setForm((job) => ({ ...job, salaryRange: event.target.value }))} placeholder="Competitive, based on experience" />
                </label>
                <label className={labelClass}>
                    <span className={labelTextClass}>Level</span>
                    <input className={fieldClass} value={form.level || ""} onChange={(event) => setForm((job) => ({ ...job, level: event.target.value }))} placeholder="Mid-level" />
                </label>
                <label className={labelClass}>
                    <span className={labelTextClass}>Status</span>
                    <select className="h-11 rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff]" value={form.status} onChange={(event) => setForm((job) => ({ ...job, status: event.target.value as JobStatus }))}>
                        {jobStatuses.map((status) => <option key={status}>{status}</option>)}
                    </select>
                </label>
            </div>

            <label className={labelClass}>
                <span className={labelTextClass}>Apply page eyebrow</span>
                <input className={fieldClass} value={form.applyEyebrow || ""} onChange={(event) => setForm((job) => ({ ...job, applyEyebrow: event.target.value }))} placeholder="Now applying / Engineering / Web Team" />
            </label>

            <label className={labelClass}>
                <span className={labelTextClass}>Public page summary</span>
                <textarea className={textAreaClass} value={form.summary || ""} onChange={(event) => setForm((job) => ({ ...job, summary: event.target.value }))} placeholder="Build and maintain responsive websites, landing pages, dashboards..." />
            </label>

            <label className={labelClass}>
                <span className={labelTextClass}>Job description</span>
                <textarea className="min-h-36 rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff]" value={form.description} onChange={(event) => setForm((job) => ({ ...job, description: event.target.value }))} placeholder="Build modern web experiences for real business workflows..." />
            </label>

            <MultiValueField
                label="Skills / tags"
                values={form.skills || []}
                placeholder="React"
                addLabel="Add skill or tag"
                onChange={(values) => setForm((job) => ({ ...job, skills: values }))}
            />

            <MultiValueField
                label="Responsibilities"
                values={form.responsibilities || []}
                placeholder="Develop responsive website pages and reusable front-end components."
                addLabel="Add responsibility"
                onChange={(values) => setForm((job) => ({ ...job, responsibilities: values }))}
            />

            <MultiValueField
                label="Requirements"
                values={form.requirements || []}
                placeholder="Strong knowledge of HTML, CSS, JavaScript, and responsive design."
                addLabel="Add requirement"
                onChange={(values) => setForm((job) => ({ ...job, requirements: values }))}
            />

            <MultiValueField
                label="Nice to have"
                values={form.niceToHave || []}
                placeholder="Experience with animations, micro-interactions, or 3D/web visual elements."
                addLabel="Add nice-to-have"
                onChange={(values) => setForm((job) => ({ ...job, niceToHave: values }))}
            />

            <MultiValueField
                label="What you will build"
                values={form.whatYouWillBuild || []}
                placeholder="Build polished marketing and business websites."
                addLabel="Add build item"
                onChange={(values) => setForm((job) => ({ ...job, whatYouWillBuild: values }))}
            />
        </Modal>
    );
}

function ApplicantModal({ title, jobs, form, setForm, onClose, onSubmit }: { title: string; jobs: JobPosting[]; form: ApplicantInput; setForm: React.Dispatch<React.SetStateAction<ApplicantInput>>; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
    return (
        <Modal title={title} subtitle="Add or update applicant information." onClose={onClose} onSubmit={onSubmit}>
            <input className="h-11 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none" value={form.name} onChange={(event) => setForm((applicant) => ({ ...applicant, name: event.target.value }))} placeholder="Applicant name" />
            <div className="grid gap-3 sm:grid-cols-2">
                <input className="h-11 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none" value={form.email} onChange={(event) => setForm((applicant) => ({ ...applicant, email: event.target.value }))} placeholder="Email" />
                <input className="h-11 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none" value={form.phone} onChange={(event) => setForm((applicant) => ({ ...applicant, phone: event.target.value }))} placeholder="Phone" />
                <input className="h-11 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none" value={form.source} onChange={(event) => setForm((applicant) => ({ ...applicant, source: event.target.value }))} placeholder="LinkedIn, Referral..." />
                <input className="h-11 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none" type="number" min="0" max="5" value={form.rating} onChange={(event) => setForm((applicant) => ({ ...applicant, rating: Number(event.target.value) }))} placeholder="Rating" />
            </div>
            <input className="h-11 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none" value={form.resumeUrl} onChange={(event) => setForm((applicant) => ({ ...applicant, resumeUrl: event.target.value }))} placeholder="Resume URL" />
            <select className="h-11 rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none" value={form.jobPosting || ""} onChange={(event) => setForm((applicant) => ({ ...applicant, jobPosting: event.target.value || null }))}>
                <option value="">No job selected</option>
                {jobs.map((job) => <option key={job._id} value={job._id}>{job.title}</option>)}
            </select>
            <select className="h-11 rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none" value={form.stage} onChange={(event) => setForm((applicant) => ({ ...applicant, stage: event.target.value as ApplicantStage }))}>
                {applicantStages.map((stage) => <option key={stage}>{stage}</option>)}
            </select>
        </Modal>
    );
}

function Modal({ title, subtitle, children, onClose, onSubmit, submitLabel = "Save" }: { title: string; subtitle: string; children: React.ReactNode; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; submitLabel?: string }) {
    return (
        <div
            className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <form className="modal-panel-enter flex max-h-[88vh] w-full max-w-[52rem] flex-col rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40" onSubmit={onSubmit}>
                <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                    <div>
                        <h3 className="text-base font-semibold text-white">{title}</h3>
                        <p className="mt-1 text-sm text-white/45">{subtitle}</p>
                    </div>
                    <button className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60" type="button" onClick={onClose}><FiX /></button>
                </div>
                <div className="content-scroll grid gap-4 overflow-y-auto p-5">{children}</div>
                <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                    <button className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60" type="button" onClick={onClose}>Cancel</button>
                    <button className="h-10 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white" type="submit">{submitLabel}</button>
                </div>
            </form>
        </div>
    );
}
