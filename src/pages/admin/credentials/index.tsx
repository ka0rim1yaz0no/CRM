import { Fragment, type FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    FiCopy,
    FiChevronDown,
    FiEdit2,
    FiEye,
    FiEyeOff,
    FiFilter,
    FiGlobe,
    FiLock,
    FiPlus,
    FiSearch,
    FiTrash2,
    FiAlertTriangle,
    FiX,
} from "react-icons/fi";
import type { IconType } from "react-icons";
import AdminLayout from "../adminLayout";
import {
    archiveCredential as archiveCredentialRequest,
    createCredential,
    getCredentials,
    updateCredential,
    type Credential as SavedCredential,
} from "../../../api/credentials";
import {
    DataTablePagination,
    DataTableSortHeader,
    type SortDirection,
} from "../../../components/admin/DataTable";
import { getBranches } from "../../../api/branches";
import { getBusinesses } from "../../../api/businesses";
import { getTeams } from "../../../api/teams";
import { useClickOutside } from "../../../hooks/useClickOutside";

const ALL_COMPANIES = "All companies";
const SHARED_COMPANY_VALUE = "All branches";
const ALL_TEAMS = "All teams";

const emptyCredential = {
    accountName: "",
    username: "",
    password: "",
    platform: "",
    company: "",
    team: ALL_TEAMS,
};

function toDisplayText(value: unknown, fallback = "") {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);

    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return toDisplayText(record.name || record.title || record.label || record.value || record._id, fallback);
    }

    return fallback;
}

function normalizeCredential(credential: SavedCredential): SavedCredential {
    const status = toDisplayText(credential.status, "Active");

    return {
        ...credential,
        _id: toDisplayText(credential._id),
        accountName: toDisplayText(credential.accountName),
        username: toDisplayText(credential.username),
        password: toDisplayText(credential.password),
        platform: toDisplayText(credential.platform, "Credential"),
        company: toDisplayText(credential.company, SHARED_COMPANY_VALUE),
        team: toDisplayText(credential.team, ALL_TEAMS),
        status: (status === "Review" || status === "Archived" ? status : "Active") as SavedCredential["status"],
    };
}

function FilterDropdown({
    label,
    value,
    options,
    isOpen,
    onToggle,
    onClose,
    onSelect,
}: {
    label: string;
    value: string;
    options: string[];
    isOpen: boolean;
    onToggle: () => void;
    onClose: () => void;
    onSelect: (value: string) => void;
}) {
    const dropdownRef = useRef<HTMLDivElement>(null);
    useClickOutside(dropdownRef, onClose, isOpen);

    return (
        <div ref={dropdownRef} className="relative">
            <button
                className={[
                    "flex h-10 min-w-[14rem] items-center justify-between gap-3 rounded-lg border bg-black/20 px-3 text-sm font-semibold transition",
                    isOpen
                        ? "border-[#842cff] text-white ring-2 ring-[#842cff]/20"
                        : "border-white/10 text-white/70 hover:bg-white/[0.04] hover:text-white",
                ].join(" ")}
                type="button"
                onClick={onToggle}
                aria-expanded={isOpen}
            >
                <span className="flex min-w-0 items-center gap-3">
                    <span className="text-white/40">{label}</span>
                    <span className="truncate">{value}</span>
                </span>
                <FiChevronDown
                    className={["size-4 shrink-0 text-white/40 transition", isOpen ? "rotate-180" : ""].join(" ")}
                    aria-hidden="true"
                />
            </button>
            {isOpen && (
                <div className="absolute right-0 top-12 z-30 w-full overflow-hidden rounded-lg border border-white/10 bg-[#0d1018] py-1 shadow-2xl shadow-black/40">
                    {options.map((option) => (
                        <button
                            key={option}
                            className={[
                                "flex h-10 w-full items-center justify-between px-3 text-left text-sm font-semibold transition",
                                value === option ? "bg-[#842cff] text-white" : "text-white/65 hover:bg-white/[0.06] hover:text-white",
                            ].join(" ")}
                            type="button"
                            onClick={() => onSelect(option)}
                        >
                            <span className="truncate">{option}</span>
                            {value === option && <span className="size-1.5 rounded-full bg-white" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

type CredentialStat = {
    label: string;
    value: string;
    meta: string;
    icon: IconType;
};

type CredentialSortField = "platform" | "accountName" | "username" | "password" | "team";

export default function Credentials() {
    const queryClient = useQueryClient();
    const [search, setSearch] = useState("");
    const [branchFilter, setBranchFilter] = useState(ALL_COMPANIES);
    const [teamFilter, setTeamFilter] = useState(ALL_TEAMS);
    const [toolFilter, setToolFilter] = useState("All tools");
    const [isBranchDropdownOpen, setIsBranchDropdownOpen] = useState(false);
    const [isTeamDropdownOpen, setIsTeamDropdownOpen] = useState(false);
    const [isToolDropdownOpen, setIsToolDropdownOpen] = useState(false);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [editingCredential, setEditingCredential] = useState<SavedCredential | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<SavedCredential | null>(null);
    const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(new Set());
    const [isFormPasswordVisible, setIsFormPasswordVisible] = useState(true);
    const [credentialForm, setCredentialForm] = useState(emptyCredential);
    const [sortBy, setSortBy] = useState<CredentialSortField>("platform");
    const [sortDir, setSortDir] = useState<SortDirection>("asc");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);

    const { data: credentials = [], isLoading, isError } = useQuery({
        queryKey: ["credentials"],
        queryFn: getCredentials,
    });
    const { data: businesses = [] } = useQuery({
        queryKey: ["businesses"],
        queryFn: getBusinesses,
    });
    const { data: branches = [] } = useQuery({
        queryKey: ["branches"],
        queryFn: getBranches,
    });
    const { data: teams = [] } = useQuery({
        queryKey: ["teams"],
        queryFn: getTeams,
    });

    const createCredentialMutation = useMutation({
        mutationFn: createCredential,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["credentials"] });
            closeModal();
        },
    });

    const archiveCredentialMutation = useMutation({
        mutationFn: archiveCredentialRequest,
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["credentials"] }),
    });
    const updateCredentialMutation = useMutation({
        mutationFn: ({ id, credential }: { id: string; credential: typeof emptyCredential }) => updateCredential(id, { ...credential, status: "Active" }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["credentials"] });
            closeModal();
        },
    });

    const normalizedCredentials = useMemo(() => credentials.map(normalizeCredential), [credentials]);

    const filteredCredentials = useMemo(() => {
        const normalizedSearch = search.trim().toLowerCase();

        return normalizedCredentials.filter((credential) => {
            const credentialTeam = credential.team || ALL_TEAMS;
            const matchesBranch = branchFilter === ALL_COMPANIES || credential.company === branchFilter || credential.company === SHARED_COMPANY_VALUE;
            const matchesTeam = teamFilter === ALL_TEAMS || credentialTeam === teamFilter || credentialTeam === ALL_TEAMS;
            const matchesTool =
                toolFilter === "All tools" ||
                credential.platform.trim().toLowerCase() === toolFilter.trim().toLowerCase();
            const matchesSearch =
                !normalizedSearch ||
                [credential.accountName, credential.username, credential.platform, credential.company, credentialTeam, credential._id]
                    .join(" ")
                    .toLowerCase()
                    .includes(normalizedSearch);

            return matchesBranch && matchesTeam && matchesTool && matchesSearch;
        });
    }, [branchFilter, normalizedCredentials, search, teamFilter, toolFilter]);

    const branchOptions = useMemo(
        () => [
            ALL_COMPANIES,
            ...Array.from(
                new Set([
                    ...businesses.map((business) => toDisplayText(business.name)),
                    ...branches.map((branch) => toDisplayText(branch.name)),
                    ...normalizedCredentials.map((credential) => credential.company),
                ])
            )
                .filter((company) => company && company !== SHARED_COMPANY_VALUE)
                .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
        ],
        [branches, businesses, normalizedCredentials]
    );
    const expandedCredentials = useMemo(
        () =>
            filteredCredentials.map((credential) => ({
                groupBranch: credential.company || SHARED_COMPANY_VALUE,
                credential,
                displayBranch: credential.company || SHARED_COMPANY_VALUE,
            })),
        [filteredCredentials]
    );

    const sortedCredentials = useMemo(() => {
        const direction = sortDir === "asc" ? 1 : -1;

        return [...expandedCredentials].sort((first, second) => {
            const branchCompare = first.groupBranch.localeCompare(second.groupBranch);
            if (branchCompare) return branchCompare;

            const firstValue = first.credential[sortBy] || "";
            const secondValue = second.credential[sortBy] || "";

            return firstValue.localeCompare(secondValue) * direction;
        });
    }, [expandedCredentials, sortBy, sortDir]);

    const totalPages = Math.max(1, Math.ceil(sortedCredentials.length / pageSize));
    const safePage = Math.min(page, totalPages);
    const paginatedCredentials = sortedCredentials.slice((safePage - 1) * pageSize, safePage * pageSize);
    const groupedCredentials = paginatedCredentials.reduce<Array<{ branch: string; credentials: typeof paginatedCredentials }>>((groups, item) => {
        const existingGroup = groups.find((group) => group.branch === item.groupBranch);

        if (existingGroup) {
            existingGroup.credentials.push(item);
        } else {
            groups.push({ branch: item.groupBranch, credentials: [item] });
        }

        return groups;
    }, []);
    const toolOptions = useMemo(
        () => [
            "All tools",
            ...Array.from(
                new Set(normalizedCredentials.map((credential) => toDisplayText(credential.platform).trim()))
            )
                .filter((tool) => Boolean(tool) && tool !== "All tools")
                .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
        ],
        [normalizedCredentials]
    );
    const teamOptions = useMemo(
        () => [ALL_TEAMS, ...Array.from(new Set([...teams.map((team) => toDisplayText(team.name)), ...normalizedCredentials.map((credential) => credential.team || ALL_TEAMS)]))
            .filter((team) => team && team !== ALL_TEAMS)
            .sort()],
        [normalizedCredentials, teams]
    );

    const credentialStats: CredentialStat[] = [
        { label: "Total Credentials", value: normalizedCredentials.length.toString(), meta: "Stored access records", icon: FiLock },
        {
            label: "Active",
            value: normalizedCredentials.filter((credential) => credential.status === "Active").length.toString(),
            meta: "Ready to use",
            icon: FiGlobe,
        },
        {
            label: "Needs Review",
            value: normalizedCredentials.filter((credential) => credential.status === "Review").length.toString(),
            meta: "Check access soon",
            icon: FiEye,
        },
    ];

    const closeModal = () => {
        setIsAddModalOpen(false);
        setEditingCredential(null);
        setCredentialForm(emptyCredential);
        setIsFormPasswordVisible(true);
    };

    const openEditModal = (credential: SavedCredential) => {
        setEditingCredential(credential);
        setCredentialForm({
            accountName: credential.accountName || "",
            username: credential.username,
            password: credential.password,
            platform: credential.platform,
            company: credential.company === SHARED_COMPANY_VALUE ? ALL_COMPANIES : credential.company,
            team: credential.team || ALL_TEAMS,
        });
        setIsFormPasswordVisible(true);
        setIsAddModalOpen(true);
    };

    const changeSort = (field: string) => {
        const nextField = field as CredentialSortField;

        if (sortBy === nextField) {
            setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
            return;
        }

        setSortBy(nextField);
        setSortDir("asc");
    };

    const addCredential = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!credentialForm.username.trim() || !credentialForm.password.trim() || !credentialForm.platform.trim()) {
            return;
        }

        const selectedCompany =
            credentialForm.company && credentialForm.company !== ALL_COMPANIES
                ? credentialForm.company
                : SHARED_COMPANY_VALUE;

        const payload = {
            ...credentialForm,
            company: selectedCompany,
            team: credentialForm.team || ALL_TEAMS,
        };
        if (editingCredential) {
            updateCredentialMutation.mutate({ id: editingCredential._id, credential: payload });
            return;
        }

        createCredentialMutation.mutate(payload);
    };

    const togglePassword = (id: string) => {
        setVisiblePasswords((current) => {
            const next = new Set(current);

            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }

            return next;
        });
    };

    const openDeletePrompt = (credential: SavedCredential) => {
        setDeleteTarget(credential);
    };

    const closeDeletePrompt = () => {
        setDeleteTarget(null);
    };

    const confirmDelete = () => {
        if (!deleteTarget) {
            return;
        }

        archiveCredentialMutation.mutate(deleteTarget._id, { onSuccess: closeDeletePrompt });
    };

    useEffect(() => {
        setPage(1);
    }, [branchFilter, search, teamFilter, toolFilter]);

    useEffect(() => {
        setPage((currentPage) => Math.min(currentPage, totalPages));
    }, [totalPages]);

    useEffect(() => {
        if (toolFilter !== "All tools" && !toolOptions.includes(toolFilter)) {
            setToolFilter("All tools");
        }
    }, [toolFilter, toolOptions]);

    useEffect(() => {
        if (branchFilter !== ALL_COMPANIES && !branchOptions.includes(branchFilter)) {
            setBranchFilter(ALL_COMPANIES);
        }
    }, [branchFilter, branchOptions]);

    useEffect(() => {
        if (teamFilter !== ALL_TEAMS && !teamOptions.includes(teamFilter)) {
            setTeamFilter(ALL_TEAMS);
        }
    }, [teamFilter, teamOptions]);

    return (
        <AdminLayout>
            <section className="min-h-[calc(100vh-8.5rem)]">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h2 className="text-2xl font-semibold text-white">Credentials</h2>
                        <p className="mt-1 text-sm text-white/50">Manage saved usernames, passwords, platforms, companies, and teams.</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        <label className="flex h-11 w-[20rem] max-w-full items-center gap-3 rounded-lg border border-white/10 bg-[#090b13]/80 px-3 text-white/45 transition focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                            <input
                                className="h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
                                placeholder="Search credentials..."
                                type="search"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                            />
                            <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                        </label>
                        <button
                            className="flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-[#090b13]/80 px-4 text-sm font-semibold text-white/75 transition hover:bg-white/10 disabled:cursor-default disabled:opacity-50"
                            type="button"
                            disabled={branchFilter === ALL_COMPANIES && teamFilter === ALL_TEAMS && toolFilter === "All tools" && !search}
                            onClick={() => {
                                setBranchFilter(ALL_COMPANIES);
                                setTeamFilter(ALL_TEAMS);
                                setToolFilter("All tools");
                                setSearch("");
                            }}
                            title="Clear all credential filters"
                        >
                            <FiFilter className="size-4" aria-hidden="true" />
                            Clear filters
                        </button>
                        <button
                            className="flex h-11 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-5 text-sm font-semibold text-white transition hover:brightness-110"
                            type="button"
                            onClick={() => setIsAddModalOpen(true)}
                        >
                            <FiPlus className="size-4" aria-hidden="true" />
                            Add Credential
                        </button>
                    </div>
                </div>

                <div className="mt-7 grid gap-3 md:grid-cols-3">
                    {credentialStats.map((stat) => {
                        const Icon = stat.icon;

                        return (
                        <article key={stat.label} className="rounded-lg border border-white/10 bg-[#0c1018]/80 p-5 shadow-2xl shadow-black/10">
                            <div className="flex items-start gap-4">
                                <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-[#842cff]/18 text-[#b78cff]">
                                    <Icon className="size-6" aria-hidden="true" />
                                </span>
                                <span>
                                    <span className="block text-xs font-medium text-white/75">{stat.label}</span>
                                    <span className="mt-2 block text-xl font-semibold text-white">{stat.value}</span>
                                    <span className="mt-1 block text-xs text-white/45">{stat.meta}</span>
                                </span>
                            </div>
                        </article>
                        );
                    })}
                </div>

                <section className="mt-5 flex h-[calc(100vh-24rem)] min-h-[34rem] flex-col overflow-hidden rounded-lg border border-white/10 bg-[#090b13]/80 shadow-2xl shadow-black/20">
                    <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
                        <div>
                            <h3 className="text-base font-semibold text-white">Saved Credentials</h3>
                            <p className="mt-1 text-xs text-white/40">Showing {filteredCredentials.length} of {normalizedCredentials.length} records</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <FilterDropdown
                                label="Company"
                                value={branchFilter}
                                options={branchOptions}
                                isOpen={isBranchDropdownOpen}
                                onToggle={() => {
                                    setIsBranchDropdownOpen((isOpen) => !isOpen);
                                    setIsTeamDropdownOpen(false);
                                    setIsToolDropdownOpen(false);
                                }}
                                onClose={() => setIsBranchDropdownOpen(false)}
                                onSelect={(company) => {
                                    setBranchFilter(company);
                                    setIsBranchDropdownOpen(false);
                                }}
                            />
                            <FilterDropdown
                                label="Team"
                                value={teamFilter}
                                options={teamOptions}
                                isOpen={isTeamDropdownOpen}
                                onToggle={() => {
                                    setIsTeamDropdownOpen((isOpen) => !isOpen);
                                    setIsBranchDropdownOpen(false);
                                    setIsToolDropdownOpen(false);
                                }}
                                onClose={() => setIsTeamDropdownOpen(false)}
                                onSelect={(team) => {
                                    setTeamFilter(team);
                                    setIsTeamDropdownOpen(false);
                                }}
                            />
                            <FilterDropdown
                                label="Tool"
                                value={toolFilter}
                                options={toolOptions}
                                isOpen={isToolDropdownOpen}
                                onToggle={() => {
                                    setIsToolDropdownOpen((isOpen) => !isOpen);
                                    setIsBranchDropdownOpen(false);
                                    setIsTeamDropdownOpen(false);
                                }}
                                onClose={() => setIsToolDropdownOpen(false)}
                                onSelect={(tool) => {
                                    setToolFilter(tool);
                                    setIsToolDropdownOpen(false);
                                }}
                            />
                        </div>
                    </div>

                    <div className="content-scroll min-h-0 flex-1 overflow-auto bg-[linear-gradient(to_bottom,#11151f_0,#11151f_3rem,transparent_3rem)] [scrollbar-gutter:stable]">
                        <table className="w-full min-w-[66rem] table-fixed border-separate border-spacing-0 text-left">
                            <thead className="sticky top-0 z-10 bg-[#11151f] text-[0.74rem] font-medium text-white/65 shadow-[12px_0_0_#11151f]">
                                <tr>
                                    <th className="w-[4%] px-3 py-3">
                                        <input className="size-4 rounded border-white/20 bg-transparent accent-[#842cff]" type="checkbox" aria-label="Select all credentials" />
                                    </th>
                                    <th className="w-[22%] px-3 py-3"><DataTableSortHeader field="platform" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Platform</DataTableSortHeader></th>
                                    <th className="w-[18%] px-3 py-3"><DataTableSortHeader field="accountName" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Account User</DataTableSortHeader></th>
                                    <th className="w-[16%] px-3 py-3"><DataTableSortHeader field="team" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Team</DataTableSortHeader></th>
                                    <th className="w-[20%] px-3 py-3"><DataTableSortHeader field="username" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Username</DataTableSortHeader></th>
                                    <th className="w-[20%] px-3 py-3"><DataTableSortHeader field="password" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Password</DataTableSortHeader></th>
                                    <th className="w-[6%] px-3 py-3 text-center">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/10">
                                {isLoading && (
                                    <tr>
                                        <td className="px-4 py-5 text-sm text-white/45" colSpan={7}>Loading credentials...</td>
                                    </tr>
                                )}
                                {isError && (
                                    <tr>
                                        <td className="px-4 py-5 text-sm text-red-200" colSpan={7}>Unable to load credentials.</td>
                                    </tr>
                                )}
                                {groupedCredentials.map((group) => (
                                    <Fragment key={group.branch}>
                                        <tr className="bg-[#0d111a] text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-white/38">
                                            <td className="px-3 py-3" colSpan={7}>
                                                <div className="flex items-center gap-3">
                                                    <span className="h-px flex-1 bg-white/10" />
                                                    <span>{group.branch}</span>
                                                    <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[0.62rem] text-white/45">
                                                        {group.credentials.length} credential{group.credentials.length === 1 ? "" : "s"}
                                                    </span>
                                                    <span className="h-px flex-1 bg-white/10" />
                                                </div>
                                            </td>
                                        </tr>
                                        {group.credentials.map(({ credential, displayBranch }) => {
                                            const isPasswordVisible = visiblePasswords.has(credential._id);

                                            return (
                                                <tr key={`${displayBranch}-${credential._id}`} className="text-sm text-white/80 transition hover:bg-white/[0.035]">
                                                    <td className="px-3 py-2.5">
                                                        <input className="size-4 rounded border-white/20 bg-transparent accent-[#842cff]" type="checkbox" aria-label={`Select ${credential.platform}`} />
                                                    </td>
                                                    <td className="px-3 py-2.5">
                                                        <div className="flex min-w-0 items-center gap-3">
                                                            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#842cff]/18 text-[#b78cff]">
                                                                <FiGlobe className="size-4" aria-hidden="true" />
                                                            </span>
                                                            <span className="min-w-0">
                                                                <span className="block truncate font-semibold text-white">{credential.platform}</span>
                                                                <span className="mt-0.5 block truncate text-xs text-white/45">{displayBranch}</span>
                                                            </span>
                                                        </div>
                                                    </td>
                                                    <td className="px-3 py-2.5 text-white/75">{credential.accountName || "-"}</td>
                                                    <td className="px-3 py-2.5 text-white/65">{credential.team || ALL_TEAMS}</td>
                                                    <td className="px-3 py-2.5 text-white/75">{credential.username}</td>
                                                    <td className="px-3 py-2.5">
                                                        <div className="flex items-center gap-2">
                                                            <span className="min-w-0 truncate font-mono text-white/75">
                                                                {isPasswordVisible ? credential.password : "••••••••••••"}
                                                            </span>
                                                            <button
                                                                className="flex size-7 shrink-0 items-center justify-center rounded-md text-white/50 transition hover:bg-white/10 hover:text-white"
                                                                type="button"
                                                                onClick={() => togglePassword(credential._id)}
                                                                aria-label={isPasswordVisible ? "Hide password" : "Show password"}
                                                            >
                                                                {isPasswordVisible ? <FiEyeOff className="size-4" /> : <FiEye className="size-4" />}
                                                            </button>
                                                            <button
                                                                className="flex size-7 shrink-0 items-center justify-center rounded-md text-white/50 transition hover:bg-white/10 hover:text-white"
                                                                type="button"
                                                                aria-label="Copy password"
                                                                onClick={() => navigator.clipboard?.writeText(credential.password)}
                                                            >
                                                                <FiCopy className="size-4" aria-hidden="true" />
                                                            </button>
                                                        </div>
                                                    </td>
                                                    <td className="px-3 py-2.5 text-center">
                                                        <div className="flex justify-center gap-0.5">
                                                            <button
                                                                className="inline-flex size-7 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white"
                                                                type="button"
                                                                aria-label={`Edit ${credential.platform}`}
                                                                onClick={() => openEditModal(credential)}
                                                            >
                                                                <FiEdit2 className="size-4" aria-hidden="true" />
                                                            </button>
                                                            <button
                                                                className="inline-flex size-7 items-center justify-center rounded-lg text-red-100/60 transition hover:bg-red-400/10 hover:text-red-100"
                                                                type="button"
                                                                aria-label={`Archive ${credential.platform}`}
                                                                onClick={() => openDeletePrompt(credential)}
                                                            >
                                                                <FiTrash2 className="size-4" aria-hidden="true" />
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </Fragment>
                                ))}
                                {!isLoading && !isError && groupedCredentials.length === 0 && (
                                    <tr>
                                        <td className="px-4 py-8 text-center text-sm text-white/45" colSpan={7}>No credentials found.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>

                    <DataTablePagination
                        totalItems={sortedCredentials.length}
                        page={page}
                        pageSize={pageSize}
                        onPageChange={setPage}
                        onPageSizeChange={(nextPageSize) => {
                            setPageSize(nextPageSize);
                            setPage(1);
                        }}
                    />
                </section>

                {isAddModalOpen && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                closeModal();
                            }
                        }}
                    >
                        <form className="modal-panel-enter w-full max-w-[34rem] rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40" onSubmit={addCredential}>
                            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{editingCredential ? "Edit Credential" : "New Credential"}</p>
                                    <h3 className="mt-1 text-base font-semibold text-white">{editingCredential ? "Update Credential" : "Add Credential"}</h3>
                                </div>
                                <button className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={closeModal} aria-label="Close add credential modal">
                                    <FiX className="size-4" aria-hidden="true" />
                                </button>
                            </div>
                            <div className="grid gap-4 p-5">
                                <label>
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Website or Platform</span>
                                    <input
                                        list="credential-tool-categories"
                                        className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={credentialForm.platform}
                                        onChange={(event) => setCredentialForm((form) => ({ ...form, platform: event.target.value }))}
                                        placeholder="Google Workspace, Stripe, CRM..."
                                    />
                                    <datalist id="credential-tool-categories">
                                        {toolOptions
                                            .filter((tool) => tool !== "All tools")
                                            .map((tool) => (
                                                <option key={tool} value={tool} />
                                            ))}
                                    </datalist>
                                </label>
                                <label>
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Account User Name</span>
                                    <input className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20" value={credentialForm.accountName} onChange={(event) => setCredentialForm((form) => ({ ...form, accountName: event.target.value }))} placeholder="Owner or user of this account" />
                                </label>
                                <label>
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Username</span>
                                    <input className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20" value={credentialForm.username} onChange={(event) => setCredentialForm((form) => ({ ...form, username: event.target.value }))} placeholder="username or email" />
                                </label>
                                <label>
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Password</span>
                                    <div className="mt-2 flex h-11 items-center rounded-lg border border-white/10 bg-black/20 transition focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                                        <input
                                            className="h-full min-w-0 flex-1 bg-transparent px-3 text-sm font-semibold text-white outline-none placeholder:text-white/30"
                                            type={isFormPasswordVisible ? "text" : "password"}
                                            value={credentialForm.password}
                                            onChange={(event) => setCredentialForm((form) => ({ ...form, password: event.target.value }))}
                                            placeholder="password"
                                        />
                                        <button
                                            className="mr-2 flex size-8 shrink-0 items-center justify-center rounded-md text-white/50 transition hover:bg-white/10 hover:text-white"
                                            type="button"
                                            onClick={() => setIsFormPasswordVisible((isVisible) => !isVisible)}
                                            aria-label={isFormPasswordVisible ? "Hide password" : "Show password"}
                                        >
                                            {isFormPasswordVisible ? <FiEyeOff className="size-4" /> : <FiEye className="size-4" />}
                                        </button>
                                    </div>
                                </label>
                                <label>
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Company</span>
                                    <select className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20" value={credentialForm.company || ALL_COMPANIES} onChange={(event) => setCredentialForm((form) => ({ ...form, company: event.target.value }))}>
                                        {branchOptions.map((company) => (
                                            <option key={company} value={company}>{company}</option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Team</span>
                                    <select className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20" value={credentialForm.team || ALL_TEAMS} onChange={(event) => setCredentialForm((form) => ({ ...form, team: event.target.value }))}>
                                        {teamOptions.map((team) => (
                                            <option key={team} value={team}>{team}</option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                            <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                                <button className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={closeModal}>
                                    Cancel
                                </button>
                                <button className="flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60" type="submit" disabled={createCredentialMutation.isPending || updateCredentialMutation.isPending}>
                                    <FiPlus className="size-4" aria-hidden="true" />
                                    {editingCredential ? "Save Credential" : "Add Credential"}
                                </button>
                            </div>
                        </form>
                    </div>
                )}

                {deleteTarget && (
                    <div
                        className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) {
                                closeDeletePrompt();
                            }
                        }}
                    >
                        <div className="modal-panel-enter w-full max-w-[32rem] overflow-hidden rounded-lg border border-red-400/20 bg-[#0d1018] shadow-2xl shadow-red-950/30">
                            <div className="bg-[radial-gradient(circle_at_15%_20%,rgba(239,68,68,0.22),transparent_35%),linear-gradient(135deg,rgba(239,68,68,0.12),rgba(132,44,255,0.08))] px-5 py-4">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex items-start gap-3">
                                        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-red-300/20 bg-red-500/15 text-red-100">
                                            <FiAlertTriangle className="size-5" aria-hidden="true" />
                                        </span>
                                        <div>
                                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-red-100/55">
                                                Delete Credential
                                            </p>
                                            <h3 className="mt-1 text-lg font-semibold text-white">
                                                Are you sure?
                                            </h3>
                                            <p className="mt-1 text-sm text-red-50/60">
                                                This action removes the credential from active records.
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/20 text-white/60 transition hover:bg-white/10 hover:text-white"
                                        type="button"
                                        onClick={closeDeletePrompt}
                                        aria-label="Close delete confirmation"
                                    >
                                        <FiX className="size-4" aria-hidden="true" />
                                    </button>
                                </div>
                            </div>
                            <div className="p-5">
                                <div className="grid gap-3 rounded-lg border border-white/10 bg-white/[0.035] p-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Platform</span>
                                        <span className="text-sm font-semibold text-white">{deleteTarget.platform}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Account User</span>
                                        <span className="truncate text-sm text-white/70">{deleteTarget.accountName || "-"}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Username</span>
                                        <span className="truncate text-sm text-white/70">{deleteTarget.username}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Company</span>
                                        <span className="text-sm text-white/70">{deleteTarget.company === SHARED_COMPANY_VALUE ? ALL_COMPANIES : deleteTarget.company}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Team</span>
                                        <span className="text-sm text-white/70">{deleteTarget.team || ALL_TEAMS}</span>
                                    </div>
                                </div>
                                <div className="mt-3 rounded-lg border border-yellow-300/20 bg-yellow-300/10 p-3">
                                    <p className="text-sm leading-6 text-yellow-50/75">
                                        Are you sure you want to delete this credential?
                                    </p>
                                </div>
                            </div>
                            <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                                <button
                                    className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white"
                                    type="button"
                                    onClick={closeDeletePrompt}
                                >
                                    Cancel
                                </button>
                                <button
                                    className="h-10 rounded-lg bg-red-500 px-4 text-sm font-semibold text-white transition hover:bg-red-400 disabled:opacity-60"
                                    type="button"
                                    onClick={confirmDelete}
                                    disabled={archiveCredentialMutation.isPending}
                                >
                                    Delete Credential
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </section>
        </AdminLayout>
    );
}
