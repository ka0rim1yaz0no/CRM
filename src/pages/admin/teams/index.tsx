import type { FormEvent } from "react";
import { Fragment, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { FiArchive, FiCheck, FiChevronDown, FiEdit2, FiMessageCircle, FiPhone, FiPlus, FiSearch, FiUserPlus, FiUsers, FiX } from "react-icons/fi";
import AdminLayout from "../adminLayout";
import { getEmployeeSummaries } from "../../../api/employees";
import { getBranches } from "../../../api/branches";
import {
    archiveTeam,
    createTeam,
    getTeams,
    updateTeam,
    type Team,
    type TeamInput,
    type TeamStatus,
} from "../../../api/teams";
import { DataTablePagination, DataTableSortHeader } from "../../../components/admin/DataTable";
import { useClickOutside } from "../../../hooks/useClickOutside";

const teamStatuses: TeamStatus[] = ["Active", "Review", "Paused", "Archived"];
const ALL_COMPANIES = "All companies";


export default function AdminTeams() {
    const leadButtonRef = useRef<HTMLButtonElement>(null);
    const membersButtonRef = useRef<HTMLButtonElement>(null);
    const leadDropdownRef = useRef<HTMLDivElement>(null);
    const membersDropdownRef = useRef<HTMLDivElement>(null);
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const { data: teams = EMPTY_QUERY_ROWS, isLoading, isError } = useQuery({
        queryKey: ["teams"],
        queryFn: getTeams,
    });
    const { data: employees = EMPTY_QUERY_ROWS } = useQuery({
        queryKey: ["employees", "summary"],
        queryFn: getEmployeeSummaries,
    });
    const { data: branches = EMPTY_QUERY_ROWS } = useQuery({
        queryKey: ["branches"],
        queryFn: getBranches,
    });
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
    const [modalMode, setModalMode] = useState<"add" | "edit" | "members">("add");
    const [isLeadDropdownOpen, setIsLeadDropdownOpen] = useState(false);
    const [leadDropdownStyle, setLeadDropdownStyle] = useState<React.CSSProperties>({});
    const [membersDropdownStyle, setMembersDropdownStyle] = useState<React.CSSProperties>({});
    const [isMembersDropdownOpen, setIsMembersDropdownOpen] = useState(false);
    const [leadSearch, setLeadSearch] = useState("");
    const [memberSearch, setMemberSearch] = useState("");
    const [memberDepartmentFilter, setMemberDepartmentFilter] = useState("All departments");
    const [memberRoleFilter, setMemberRoleFilter] = useState("All roles");
    const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [sortBy, setSortBy] = useState("name");
    const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
    const [newTeam, setNewTeam] = useState<TeamInput>({
        name: "",
        company: ALL_COMPANIES,
        department: "General",
        lead: null,
        members: [],
        activeLeads: 0,
        status: "Active",
    });
    useClickOutside(leadDropdownRef, () => setIsLeadDropdownOpen(false), isLeadDropdownOpen, [leadButtonRef]);
    useClickOutside(membersDropdownRef, () => setIsMembersDropdownOpen(false), isMembersDropdownOpen, [membersButtonRef]);

    const activeEmployees = useMemo(() => employees.filter((employee) => employee.status !== "Archived"), [employees]);
    const companyOptions = useMemo(() => [ALL_COMPANIES, ...branches.map((branch) => branch.name)], [branches]);
    const memberDepartmentOptions = useMemo(
        () => ["All departments", ...Array.from(new Set(activeEmployees.map((employee) => employee.team || "Unassigned")))],
        [activeEmployees],
    );
    const memberRoleOptions = useMemo(
        () => ["All roles", ...Array.from(new Set(activeEmployees.map((employee) => employee.role || "Unassigned")))],
        [activeEmployees],
    );
    const activeEmployeeIds = useMemo(() => new Set(activeEmployees.map((employee) => employee._id)), [activeEmployees]);
    const employeesByTeam = useMemo(() => {
        const teamMap = new Map<string, typeof activeEmployees>();

        activeEmployees.forEach((employee) => {
            const teamName = employee.team || "Unassigned";
            teamMap.set(teamName, [...(teamMap.get(teamName) || []), employee]);
        });

        return teamMap;
    }, [activeEmployees]);
    const activeTeamMembersByTeamId = useMemo(() => {
        const membersByTeam = new Map<string, Team["members"]>();

        teams.forEach((team) => {
            const memberMap = new Map(team.members.filter((member) => activeEmployeeIds.has(member._id)).map((member) => [member._id, member]));
            (employeesByTeam.get(team.name) || []).forEach((employee) => memberMap.set(employee._id, employee));
            membersByTeam.set(team._id, Array.from(memberMap.values()));
        });

        return membersByTeam;
    }, [activeEmployeeIds, employeesByTeam, teams]);
    const getActiveTeamMembers = (team: Team) => activeTeamMembersByTeamId.get(team._id) || [];
    const teamStats = useMemo(
        () => [
            ["Teams", teams.length.toString()],
            ["Agents", teams.reduce((total, team) => total + (activeTeamMembersByTeamId.get(team._id)?.length || 0), 0).toString()],
            ["Active Leads", teams.reduce((total, team) => total + team.activeLeads, 0).toString()],
        ],
        [activeTeamMembersByTeamId, teams],
    );
    const sortedTeams = useMemo(() => [...teams].sort((first, second) => {
        const firstMembers = activeTeamMembersByTeamId.get(first._id)?.length || 0;
        const secondMembers = activeTeamMembersByTeamId.get(second._id)?.length || 0;
        const values: Record<string, [string | number, string | number]> = {
            name: [first.name, second.name],
            company: [first.company || ALL_COMPANIES, second.company || ALL_COMPANIES],
            department: [first.department || "General", second.department || "General"],
            lead: [first.lead?.name || "", second.lead?.name || ""],
            members: [firstMembers, secondMembers],
            activeLeads: [first.activeLeads, second.activeLeads],
            status: [first.status, second.status],
        };
        const [firstValue, secondValue] = values[sortBy] || values.name;
        const direction = sortDir === "asc" ? 1 : -1;

        if (typeof firstValue === "number" && typeof secondValue === "number") {
            return (firstValue - secondValue) * direction;
        }

        return String(firstValue).localeCompare(String(secondValue)) * direction;
    }), [activeTeamMembersByTeamId, sortBy, sortDir, teams]);
    const totalPages = Math.max(1, Math.ceil(sortedTeams.length / pageSize));
    const safePage = Math.min(page, totalPages);
    const paginatedTeams = useMemo(() => sortedTeams.slice((safePage - 1) * pageSize, safePage * pageSize), [pageSize, safePage, sortedTeams]);
    const selectedLead = useMemo(() => activeEmployees.find((employee) => employee._id === newTeam.lead), [activeEmployees, newTeam.lead]);
    const selectedMembers = useMemo(() => activeEmployees.filter((employee) => newTeam.members.includes(employee._id)), [activeEmployees, newTeam.members]);
    const filteredLeadOptions = useMemo(() => activeEmployees.filter((agent) =>
        agent.name.toLowerCase().includes(leadSearch.toLowerCase())
    ), [activeEmployees, leadSearch]);
    const filteredMemberOptions = useMemo(() => activeEmployees.filter((agent) => {
        const search = memberSearch.toLowerCase();
        const matchesSearch = [agent.name, agent.email, agent.employeeCode, agent.role, agent.team]
            .filter(Boolean)
            .some((value) => value.toLowerCase().includes(search));
        const matchesDepartment = memberDepartmentFilter === "All departments" || (agent.team || "Unassigned") === memberDepartmentFilter;
        const matchesRole = memberRoleFilter === "All roles" || (agent.role || "Unassigned") === memberRoleFilter;

        return matchesSearch && matchesDepartment && matchesRole;
    }), [activeEmployees, memberDepartmentFilter, memberRoleFilter, memberSearch]);

    const invalidateTeams = () => {
        queryClient.invalidateQueries({ queryKey: ["teams"] });
        queryClient.invalidateQueries({ queryKey: ["employees"] });
        queryClient.invalidateQueries({ queryKey: ["employees", "summary"] });
    };

    const createTeamMutation = useMutation({
        mutationFn: createTeam,
        onSuccess: invalidateTeams,
    });

    const updateTeamMutation = useMutation({
        mutationFn: ({ id, team }: { id: string; team: TeamInput }) => updateTeam(id, team),
        onSuccess: invalidateTeams,
    });

    const archiveTeamMutation = useMutation({
        mutationFn: archiveTeam,
        onSuccess: invalidateTeams,
    });

    const resetTeamForm = () => {
        setNewTeam({ name: "", company: ALL_COMPANIES, department: "General", lead: null, members: [], activeLeads: 0, status: "Active" });
        setEditingTeamId(null);
        setModalMode("add");
        setLeadSearch("");
        setMemberSearch("");
        setMemberDepartmentFilter("All departments");
        setMemberRoleFilter("All roles");
        setIsLeadDropdownOpen(false);
        setIsMembersDropdownOpen(false);
    };

    const closeTeamModal = () => {
        setIsAddModalOpen(false);
        resetTeamForm();
    };

    const openAddTeamModal = () => {
        resetTeamForm();
        setIsAddModalOpen(true);
    };

    const openEditTeamModal = (team: Team) => {
        setNewTeam({
            name: team.name,
            company: team.company || ALL_COMPANIES,
            department: team.department || "General",
            lead: team.lead?._id || null,
            members: team.members.map((member) => member._id),
            activeLeads: team.activeLeads,
            status: team.status,
        });
        setEditingTeamId(team._id);
        setModalMode("edit");
        setIsAddModalOpen(true);
    };

    const openMembersModal = (team: Team) => {
        setNewTeam({
            name: team.name,
            company: team.company || ALL_COMPANIES,
            department: team.department || "General",
            lead: team.lead?._id || null,
            members: team.members.map((member) => member._id),
            activeLeads: team.activeLeads,
            status: team.status,
        });
        setEditingTeamId(team._id);
        setModalMode("members");
        setMemberSearch("");
        setMemberDepartmentFilter("All departments");
        setMemberRoleFilter("All roles");
        setIsAddModalOpen(true);
    };

    const handleSaveTeam = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!newTeam.name.trim()) {
            return;
        }

        const savedTeam: TeamInput = {
            name: newTeam.name.trim(),
            company: newTeam.company || ALL_COMPANIES,
            department: newTeam.department || "General",
            lead: newTeam.lead,
            members: newTeam.members,
            activeLeads: newTeam.activeLeads,
            status: newTeam.status,
        };

        if (editingTeamId) {
            updateTeamMutation.mutate({ id: editingTeamId, team: savedTeam });
        } else {
            createTeamMutation.mutate(savedTeam);
        }
        closeTeamModal();
    };

    const toggleMember = (agentId: string) => {
        setNewTeam((team) => ({
            ...team,
            members: team.members.includes(agentId)
                ? team.members.filter((member) => member !== agentId)
                : [...team.members, agentId],
        }));
    };

    const getDropdownStyle = (button: HTMLButtonElement | null) => {
        if (!button) {
            return undefined;
        }

        const rect = button.getBoundingClientRect();

        return {
            left: rect.left,
            top: rect.bottom + 8,
            width: rect.width,
        };
    };

    const changeSort = (field: string) => {
        setSortBy((current) => {
            if (current === field) {
                setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
                return current;
            }

            setSortDir("asc");
            return field;
        });
        setPage(1);
    };

    const [previousTeamPageLimit, setPreviousTeamPageLimit] = useState<readonly unknown[] | null>(null);
    const teamPageLimitInputs = [totalPages];
    if (previousTeamPageLimit === null || teamPageLimitInputs.some((input, index) => !Object.is(input, previousTeamPageLimit[index]))) {
        setPreviousTeamPageLimit(teamPageLimitInputs);
        (() => {
            setPage((currentPage) => Math.min(currentPage, totalPages));
        })();
    }

    return (
        <AdminLayout>
            <section className="flex min-h-[calc(100vh-8.5rem)] flex-col rounded-lg border border-white/10 bg-[#090b13]/80">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
                    <div>
                        <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Admin Teams</p>
                        <h2 className="mt-1 text-xl font-semibold text-white">Teams</h2>
                    </div>

                    <div className="flex min-w-0 flex-1 flex-wrap justify-center gap-2">
                        {teamStats.map(([label, value]) => (
                            <span
                                key={label}
                                className="inline-flex h-10 min-w-[7.25rem] items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs font-semibold text-white/55"
                            >
                                <span className="uppercase tracking-[0.12em]">{label}</span>
                                <span className="text-base text-white">{value}</span>
                            </span>
                        ))}
                    </div>

                    <button
                        className="flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-[#842cff]/60"
                        type="button"
                        onClick={openAddTeamModal}
                    >
                        <FiPlus className="size-4" aria-hidden="true" />
                        Add Team
                    </button>
                </div>

                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex min-h-[18rem] flex-1 overflow-hidden border-t border-white/10">
                        <div className="content-scroll min-h-0 flex-1 overflow-auto">
                            <table className="w-full min-w-[48rem] text-left">
                                <thead className="sticky top-0 z-10 border-b border-white/10 bg-[#10131b]">
                                    <tr className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">
                                        <th className="px-5 py-3"><DataTableSortHeader field="company" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Company</DataTableSortHeader></th>
                                        <th className="px-5 py-3"><DataTableSortHeader field="department" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Department</DataTableSortHeader></th>
                                        <th className="px-5 py-3"><DataTableSortHeader field="name" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Team</DataTableSortHeader></th>
                                        <th className="px-5 py-3"><DataTableSortHeader field="lead" sortBy={sortBy} sortDir={sortDir} onSort={changeSort}>Team Lead</DataTableSortHeader></th>
                                        <th className="px-5 py-3 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/10">
                                    {isLoading && (
                                        <tr>
                                            <td className="px-5 py-8 text-center text-sm text-white/45" colSpan={5}>
                                                Loading teams...
                                            </td>
                                        </tr>
                                    )}
                                    {isError && (
                                        <tr>
                                            <td className="px-5 py-8 text-center text-sm text-red-200" colSpan={5}>
                                                Unable to load teams. Check that the backend is running.
                                            </td>
                                        </tr>
                                    )}
                                    {!isLoading && !isError && teams.length === 0 && (
                                        <tr>
                                            <td className="px-5 py-8 text-center text-sm text-white/45" colSpan={5}>
                                                No teams yet.
                                            </td>
                                        </tr>
                                    )}
                                    {paginatedTeams.map((team) => {
                                        const activeTeamMembers = getActiveTeamMembers(team);

                                        const isExpanded = expandedTeamId === team._id;

                                        return (
                                            <Fragment key={team._id}>
                                                <tr
                                                    className="cursor-pointer text-sm transition hover:bg-white/[0.04]"
                                                    onClick={() => setExpandedTeamId((current) => (current === team._id ? null : team._id))}
                                                >
                                                    <td className="px-5 py-4 text-white/65">{team.company || ALL_COMPANIES}</td>
                                                    <td className="px-5 py-4 text-white/65">{team.department || "General"}</td>
                                                    <td className="px-5 py-4">
                                                        <div className="flex items-center gap-3">
                                                            <span className="flex size-9 items-center justify-center rounded-lg bg-white/[0.06] text-white/65">
                                                                <FiUsers className="size-4" aria-hidden="true" />
                                                            </span>
                                                            <div className="min-w-0">
                                                                <span className="block font-semibold text-white">{team.name}</span>
                                                                <span className="mt-1 block text-xs text-white/35">{activeTeamMembers.length} employee{activeTeamMembers.length === 1 ? "" : "s"}</span>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-5 py-4">
                                                        <div className="flex items-center justify-between gap-3">
                                                            <span className="text-white/65">{team.lead?.name || "Unassigned"}</span>
                                                            <FiChevronDown
                                                                className={["size-4 shrink-0 text-white/35 transition duration-200 ease-out", isExpanded ? "rotate-180 text-[#b994ff]" : ""].join(" ")}
                                                                aria-hidden="true"
                                                            />
                                                        </div>
                                                    </td>
                                                    <td className="px-5 py-4" onClick={(event) => event.stopPropagation()}>
                                                        <div className="flex justify-end gap-2">
                                                            <button
                                                                className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[#842cff]/60"
                                                                type="button"
                                                                aria-label={`Message ${team.name}`}
                                                                onClick={() => navigate(`/admin/messages?team=${team._id}`)}
                                                            >
                                                                <FiMessageCircle className="size-4" aria-hidden="true" />
                                                            </button>
                                                            <button
                                                                className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[#842cff]/60"
                                                                type="button"
                                                                aria-label={`Edit ${team.name}`}
                                                                onClick={() => openEditTeamModal(team)}
                                                            >
                                                                <FiEdit2 className="size-4" aria-hidden="true" />
                                                            </button>
                                                            <button
                                                                className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[#842cff]/60 disabled:cursor-not-allowed disabled:opacity-50"
                                                                type="button"
                                                                aria-label={`Archive ${team.name}`}
                                                                disabled={archiveTeamMutation.isPending}
                                                                onClick={() => archiveTeamMutation.mutate(team._id)}
                                                            >
                                                                <FiArchive className="size-4" aria-hidden="true" />
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                                {isExpanded && (
                                                    <tr className="bg-black/20">
                                                        <td className="px-5 py-4" colSpan={5}>
                                                            <div className="accordion-panel-enter ml-14 rounded-lg border border-white/10 bg-white/[0.03] p-4">
                                                                <div className="flex flex-wrap items-center justify-between gap-3">
                                                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Employees under {team.name}</p>
                                                                    <div className="flex gap-2">
                                                                        <button
                                                                            className="flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                                                                            type="button"
                                                                            onClick={(event) => {
                                                                                event.stopPropagation();
                                                                                openMembersModal(team);
                                                                            }}
                                                                        >
                                                                            <FiUserPlus className="size-3.5" aria-hidden="true" />
                                                                            Members
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                                {activeTeamMembers.length > 0 ? (
                                                                    <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-black/20">
                                                                        <table className="w-full min-w-[36rem] text-left">
                                                                            <thead className="border-b border-white/10 bg-white/[0.03]">
                                                                                <tr className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">
                                                                                    <th className="px-4 py-3">Employee Name</th>
                                                                                    <th className="px-4 py-3">Role</th>
                                                                                    <th className="px-4 py-3">Company Email</th>
                                                                                    <th className="px-4 py-3 text-right">Actions</th>
                                                                                </tr>
                                                                            </thead>
                                                                            <tbody className="divide-y divide-white/10">
                                                                                {activeTeamMembers.map((member) => (
                                                                                    <tr key={member._id} className="text-sm text-white/65">
                                                                                        <td className="px-4 py-3 font-semibold text-white">{member.name}</td>
                                                                                        <td className="px-4 py-3">{member.role || "No role"}</td>
                                                                                        <td className="px-4 py-3">{member.email || "No email"}</td>
                                                                                        <td className="px-4 py-3">
                                                                                            <div className="flex justify-end gap-2">
                                                                                                <button
                                                                                                    className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                                                                                    type="button"
                                                                                                    aria-label={`Message ${member.name}`}
                                                                                                    onClick={() => navigate(`/admin/messages?to=${encodeURIComponent(member.email)}`)}
                                                                                                >
                                                                                                    <FiMessageCircle className="size-3.5" aria-hidden="true" />
                                                                                                </button>
                                                                                                <button
                                                                                                    className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                                                                                    type="button"
                                                                                                    aria-label={`Call ${member.name}`}
                                                                                                    onClick={() => navigate(`/admin/messages?call=${encodeURIComponent(member.email)}`)}
                                                                                                >
                                                                                                    <FiPhone className="size-3.5" aria-hidden="true" />
                                                                                                </button>
                                                                                            </div>
                                                                                        </td>
                                                                                    </tr>
                                                                                ))}
                                                                            </tbody>
                                                                        </table>
                                                                    </div>
                                                                ) : (
                                                                    <p className="mt-3 text-sm text-white/45">No employees in this team.</p>
                                                                )}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <DataTablePagination
                        totalItems={teams.length}
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

            {isAddModalOpen && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                    onPointerDown={(event) => {
                        if (event.target === event.currentTarget) {
                            closeTeamModal();
                        }
                    }}
                >
                    <form
                        className={[
                            "flex max-h-[88vh] w-full flex-col rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40",
                            modalMode === "members" ? "max-w-[42rem]" : "max-w-[32rem]",
                        ].join(" ")}
                        onSubmit={handleSaveTeam}
                        onPointerDown={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                            <div>
                                <h3 className="text-lg font-semibold text-white">
                                    {modalMode === "add" && "Add Team"}
                                    {modalMode === "edit" && "Edit Team"}
                                    {modalMode === "members" && "Add Members"}
                                </h3>
                                <p className="mt-1 text-sm text-white/45">
                                    {modalMode === "members" ? `Manage members for ${newTeam.name}.` : "Create a team for agents and lead ownership."}
                                </p>
                            </div>
                            <button
                                className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                type="button"
                                aria-label="Close add team modal"
                                onClick={closeTeamModal}
                            >
                                <FiX className="size-4" aria-hidden="true" />
                            </button>
                        </div>

                        {modalMode === "members" ? (
                            <div className="content-scroll overflow-y-auto p-5">
                                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_11rem]">
                                    <label className="flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 text-white/45">
                                        <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                                        <input
                                            className="h-full min-w-0 flex-1 bg-transparent text-sm font-semibold text-white outline-none placeholder:text-white/30"
                                            value={memberSearch}
                                            onChange={(event) => setMemberSearch(event.target.value)}
                                            placeholder="Search employee name, email, code..."
                                        />
                                    </label>
                                    <select
                                        className="h-11 rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={memberDepartmentFilter}
                                        onChange={(event) => setMemberDepartmentFilter(event.target.value)}
                                    >
                                        {memberDepartmentOptions.map((department) => (
                                            <option key={department} value={department}>{department}</option>
                                        ))}
                                    </select>
                                    <select
                                        className="h-11 rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={memberRoleFilter}
                                        onChange={(event) => setMemberRoleFilter(event.target.value)}
                                    >
                                        {memberRoleOptions.map((role) => (
                                            <option key={role} value={role}>{role}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="mt-4 flex items-center justify-between gap-3 border-b border-white/10 pb-3">
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">
                                        Employees
                                        <span className="ml-2 rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-white/60">
                                            {newTeam.members.length} selected
                                        </span>
                                    </p>
                                    <button
                                        className="h-8 rounded-md border border-white/10 bg-white/[0.05] px-3 text-xs font-semibold text-white/60 transition hover:bg-white/10 hover:text-white"
                                        type="button"
                                        onClick={() => setNewTeam((team) => ({ ...team, members: [] }))}
                                    >
                                        Clear
                                    </button>
                                </div>

                                <div className="content-scroll mt-3 max-h-[24rem] overflow-y-auto rounded-lg border border-white/10">
                                    {filteredMemberOptions.length === 0 ? (
                                        <p className="px-4 py-8 text-center text-sm text-white/45">No employees match your filters.</p>
                                    ) : (
                                        filteredMemberOptions.map((employee) => {
                                            const isSelected = newTeam.members.includes(employee._id);

                                            return (
                                                <label
                                                    key={employee._id}
                                                    className="flex cursor-pointer items-center gap-3 border-b border-white/10 px-4 py-3 last:border-b-0 transition hover:bg-white/[0.04]"
                                                >
                                                    <input
                                                        className="size-4 accent-[#842cff]"
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        onChange={() => toggleMember(employee._id)}
                                                    />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block truncate text-sm font-semibold text-white">{employee.name}</span>
                                                        <span className="mt-1 block truncate text-xs text-white/45">
                                                            {employee.team || "Unassigned"} - {employee.role || "No role"} - {employee.email}
                                                        </span>
                                                    </span>
                                                    <span className="hidden rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs font-semibold text-white/45 sm:inline-flex">
                                                        {employee.employeeCode}
                                                    </span>
                                                </label>
                                            );
                                        })
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="content-scroll grid gap-4 overflow-y-auto p-5 sm:grid-cols-2">
                                <label className="sm:col-span-2">
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Team Name</span>
                                    <input
                                        className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={newTeam.name}
                                        onChange={(event) => setNewTeam((team) => ({ ...team, name: event.target.value }))}
                                        placeholder="Operations"
                                    />
                                </label>

                                <label className="sm:col-span-2">
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Company</span>
                                    <select
                                        className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={newTeam.company || ALL_COMPANIES}
                                        onChange={(event) => setNewTeam((team) => ({ ...team, company: event.target.value }))}
                                    >
                                        {companyOptions.map((company) => (
                                            <option key={company} value={company}>{company}</option>
                                        ))}
                                    </select>
                                </label>

                                <label className="sm:col-span-2">
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Department</span>
                                    <input
                                        className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={newTeam.department || "General"}
                                        onChange={(event) => setNewTeam((team) => ({ ...team, department: event.target.value }))}
                                        placeholder="Sales"
                                    />
                                </label>

                                <div className="relative sm:col-span-2">
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Team Lead</span>
                                    <button
                                        ref={leadButtonRef}
                                        className="mt-2 flex h-11 w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 text-left text-sm font-semibold text-white outline-none transition hover:bg-white/[0.04] focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        type="button"
                                        onClick={() => {
                                            setIsMembersDropdownOpen(false);
                                            setLeadDropdownStyle(getDropdownStyle(leadButtonRef.current) ?? {});
                                            setIsLeadDropdownOpen((current) => !current);
                                        }}
                                    >
                                        <span className={selectedLead ? "text-white" : "text-white/35"}>
                                            {selectedLead?.name || "Optional"}
                                        </span>
                                        <FiChevronDown className="size-4 shrink-0 text-white/45" aria-hidden="true" />
                                    </button>

                                </div>

                                <div className="relative sm:col-span-2">
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Members</span>
                                    <button
                                        ref={membersButtonRef}
                                        className="mt-2 flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-left text-sm font-semibold text-white outline-none transition hover:bg-white/[0.04] focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        type="button"
                                        onClick={() => {
                                            setIsLeadDropdownOpen(false);
                                            setMembersDropdownStyle(getDropdownStyle(membersButtonRef.current) ?? {});
                                            setIsMembersDropdownOpen((current) => !current);
                                        }}
                                    >
                                        <span className={newTeam.members.length ? "text-white" : "text-white/35"}>
                                            {selectedMembers.length ? selectedMembers.map((member) => member.name).join(", ") : "Select members"}
                                        </span>
                                        <FiChevronDown className="size-4 shrink-0 text-white/45" aria-hidden="true" />
                                    </button>

                                </div>

                                <label className="sm:col-span-2">
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Status</span>
                                    <div className="mt-2 grid grid-cols-3 gap-2">
                                        {teamStatuses.filter((status) => status !== "Archived").map((status) => (
                                            <button
                                                key={status}
                                                className={[
                                                    "h-10 rounded-lg border px-3 text-sm font-semibold transition",
                                                    newTeam.status === status
                                                        ? "border-[#842cff] bg-[#842cff]/20 text-white"
                                                        : "border-white/10 bg-black/20 text-white/55 hover:bg-white/[0.06] hover:text-white",
                                                ].join(" ")}
                                                type="button"
                                                onClick={() => setNewTeam((team) => ({ ...team, status }))}
                                            >
                                                {status}
                                            </button>
                                        ))}
                                    </div>
                                </label>
                            </div>
                        )}

                        <div className="flex justify-end gap-3 border-t border-white/10 px-5 py-4">
                            <button
                                className="h-10 rounded-lg border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                                type="button"
                                onClick={closeTeamModal}
                            >
                                Cancel
                            </button>
                            <button
                                className="flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-[#842cff]/60"
                                type="submit"
                            >
                                <FiPlus className="size-4" aria-hidden="true" />
                                {modalMode === "add" && "Add Team"}
                                {modalMode === "edit" && "Save Team"}
                                {modalMode === "members" && "Save Members"}
                            </button>
                        </div>
                    </form>

                    {isLeadDropdownOpen && (
                        <div
                            ref={leadDropdownRef}
                            className="fixed z-[60] overflow-hidden rounded-lg border border-white/10 bg-[#11141d] shadow-2xl shadow-black/40"
                            style={leadDropdownStyle}
                        >
                            <label className="flex h-10 items-center gap-2 border-b border-white/10 px-3 text-white/45">
                                <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                                <input
                                    className="h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30"
                                    value={leadSearch}
                                    onChange={(event) => setLeadSearch(event.target.value)}
                                    placeholder="Search agents"
                                />
                            </label>
                            <div className="max-h-44 overflow-y-auto py-1">
                                <button
                                    className="flex h-10 w-full items-center px-3 text-left text-sm font-semibold text-white/55 transition hover:bg-white/[0.06] hover:text-white"
                                    type="button"
                                    onClick={() => {
                                            setNewTeam((team) => ({ ...team, lead: null }));
                                        setIsLeadDropdownOpen(false);
                                    }}
                                >
                                    No team lead
                                </button>
                                {filteredLeadOptions.map((agent) => (
                                    <button
                                        key={agent._id}
                                        className="flex h-10 w-full items-center justify-between gap-3 px-3 text-left text-sm font-semibold text-white/70 transition hover:bg-white/[0.06] hover:text-white"
                                        type="button"
                                        onClick={() => {
                                            setNewTeam((team) => ({ ...team, lead: agent._id }));
                                            setLeadSearch("");
                                            setIsLeadDropdownOpen(false);
                                        }}
                                    >
                                        {agent.name}
                                        {newTeam.lead === agent._id && <FiCheck className="size-4 text-[#b994ff]" aria-hidden="true" />}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {isMembersDropdownOpen && (
                        <div
                            ref={membersDropdownRef}
                            className="fixed z-[60] overflow-hidden rounded-lg border border-white/10 bg-[#11141d] shadow-2xl shadow-black/40"
                            style={membersDropdownStyle}
                        >
                            <label className="flex h-10 items-center gap-2 border-b border-white/10 px-3 text-white/45">
                                <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                                <input
                                    className="h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30"
                                    value={memberSearch}
                                    onChange={(event) => setMemberSearch(event.target.value)}
                                    placeholder="Search agents"
                                />
                            </label>
                            <div className="max-h-52 overflow-y-auto py-1">
                                {filteredMemberOptions.map((agent) => {
                                    const isSelected = newTeam.members.includes(agent._id);

                                    return (
                                        <button
                                            key={agent._id}
                                            className="flex h-10 w-full items-center justify-between gap-3 px-3 text-left text-sm font-semibold text-white/70 transition hover:bg-white/[0.06] hover:text-white"
                                            type="button"
                                            onClick={() => toggleMember(agent._id)}
                                        >
                                            {agent.name}
                                            <span
                                                className={[
                                                    "flex size-5 items-center justify-center rounded border",
                                                    isSelected
                                                        ? "border-[#842cff] bg-[#842cff] text-white"
                                                        : "border-white/15 text-transparent",
                                                ].join(" ")}
                                            >
                                                <FiCheck className="size-3.5" aria-hidden="true" />
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </AdminLayout>
    );
}

const EMPTY_QUERY_ROWS: [] = [];
