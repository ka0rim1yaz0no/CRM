import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { FiMail, FiMessageCircle, FiPhone, FiUsers } from "react-icons/fi";
import { FaWhatsapp } from "react-icons/fa";
import { Link } from "react-router";
import MainLayout from "../layout";
import { getAuthUser } from "../../api/authStorage";
import { getEmployeeSummaries } from "../../api/employees";
import { getTeams } from "../../api/teams";

export default function Teams() {
    const authUser = getAuthUser();
    const { data: employees = [] } = useQuery({
        queryKey: ["employees", "summary"],
        queryFn: getEmployeeSummaries,
    });
    const { data: teams = [] } = useQuery({
        queryKey: ["teams"],
        queryFn: getTeams,
    });

    const currentEmployee = useMemo(
        () => authUser?.userType === "employee"
            ? employees.find((employee) => employee._id === authUser.user._id) || authUser.user
            : employees[0] || null,
        [authUser, employees],
    );
    const currentTeam = useMemo(
        () => teams.find((team) => team.members.some((member) => member._id === currentEmployee?._id) || team.lead?._id === currentEmployee?._id)
            || teams.find((team) => team.name === currentEmployee?.team)
            || null,
        [currentEmployee?._id, currentEmployee?.team, teams]
    );
    const teammates = useMemo(
        () => {
            if (currentTeam) {
                const members = [...currentTeam.members, ...(currentTeam.lead ? [currentTeam.lead] : [])];
                return Array.from(new Map(members.map((employee) => [employee._id, employee])).values())
                    .filter((employee) => employee.status !== "Archived" && employee._id !== currentEmployee?._id);
            }
            return employees.filter((employee) => employee.status !== "Archived" && employee._id !== currentEmployee?._id && employee.team === currentEmployee?.team);
        },
        [currentEmployee?._id, currentEmployee?.team, currentTeam, employees],
    );

    return (
        <MainLayout>
            <section className="min-h-[calc(100vh-8.5rem)]">
                <div className="rounded-lg border border-white/10 bg-[#090b13]/80">
                    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
                        <div>
                            <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Current Team</p>
                            <h2 className="mt-1 text-xl font-semibold text-white">{currentTeam?.name || currentEmployee?.team || "Unassigned"}</h2>
                            <p className="mt-1 text-sm text-white/45">
                                {currentEmployee?.name || "Employee"} - {currentEmployee?.role || "No role"}
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-md bg-white/[0.06] px-3 py-1.5 text-sm font-semibold text-white/65">
                                {teammates.length} fellow agents
                            </span>
                            {currentTeam && (
                                <Link
                                    className="flex h-10 items-center gap-2 rounded-lg border border-[#842cff]/35 bg-[#842cff]/15 px-3 text-sm font-semibold text-[#d8c6ff] transition hover:bg-[#842cff]/25"
                                    to={`/messages?team=${currentTeam._id}`}
                                >
                                    <FiUsers className="size-4" aria-hidden="true" />
                                    Message Team
                                </Link>
                            )}
                        </div>
                    </div>

                    <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
                        {teammates.length === 0 && (
                            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-6 text-sm font-semibold text-white/45">
                                No teammates assigned yet.
                            </div>
                        )}
                        {teammates.map((agent) => {
                            const whatsappPhone = agent.phone.replace(/\D/g, "");

                            return (
                                <article
                                    key={agent._id}
                                    className="rounded-lg border border-white/10 bg-white/[0.04] p-4 transition hover:border-white/20 hover:bg-white/[0.06]"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <h3 className="truncate text-base font-semibold text-white">{agent.name}</h3>
                                            <p className="mt-1 text-sm text-white/45">{agent.role}</p>
                                        </div>
                                        <span className="shrink-0 rounded-md border border-[#842cff]/35 bg-[#842cff]/10 px-2 py-1 text-xs font-semibold text-[#b994ff]">
                                            {agent.status}
                                        </span>
                                    </div>

                                    <div className="mt-4 space-y-2 text-sm">
                                        <a className="flex items-center gap-2 truncate text-white/65 transition hover:text-white" href={`mailto:${agent.email}`}>
                                            <FiMail className="size-3.5 shrink-0" aria-hidden="true" />
                                            {agent.email}
                                        </a>
                                        <a className="flex items-center gap-2 text-white/65 transition hover:text-white" href={`tel:${agent.phone}`}>
                                            <FiPhone className="size-3.5 shrink-0" aria-hidden="true" />
                                            {agent.phone}
                                        </a>
                                    </div>

                                    <div className="mt-4 flex items-center gap-2">
                                        <Link
                                            className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[#842cff]/60"
                                            to={`/messages?to=${encodeURIComponent(agent.email)}`}
                                        >
                                            <FiMessageCircle className="size-4" aria-hidden="true" />
                                            Direct Message
                                        </Link>
                                        <a
                                            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#25d366]/30 bg-[#25d366]/10 text-[#7cf0a4] transition hover:bg-[#25d366]/20 focus:outline-none focus:ring-2 focus:ring-[#25d366]/50"
                                            href={`https://wa.me/${whatsappPhone}`}
                                            aria-label={`WhatsApp ${agent.name}`}
                                        >
                                            <FaWhatsapp className="size-4" aria-hidden="true" />
                                        </a>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                </div>
            </section>
        </MainLayout>
    );
}
