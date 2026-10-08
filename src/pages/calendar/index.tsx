import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";
import { getAuthUser } from "../../api/authStorage";
import { getMyLeads } from "../../api/leads";
import { formatPhDate, formatPhDateTime } from "../../lib/dateTime";
import MainLayout from "../layout";

const phDateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

function phDateKey(value: Date | string) {
    return phDateKeyFormatter.format(new Date(value));
}

function monthKey(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function calendarDays(month: string) {
    const [year, monthNumber] = month.split("-").map(Number);
    const first = new Date(year, monthNumber - 1, 1);
    const start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7));

    return Array.from({ length: 42 }, (_, index) => {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        return {
            key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
            day: date.getDate(),
            inMonth: date.getMonth() === monthNumber - 1,
        };
    });
}

export default function Calendar() {
    const authUser = getAuthUser();
    const employee = authUser?.userType === "employee" ? authUser.user : null;
    const today = phDateKey(new Date());
    const [selectedDate, setSelectedDate] = useState(today);
    const [visibleMonth, setVisibleMonth] = useState(today.slice(0, 7));
    const aliases = employee ? [employee.name, ...(employee.aliases || [])] : [];
    const leadsQuery = useQuery({
        queryKey: ["employee-calendar-follow-ups", employee?._id, visibleMonth],
        queryFn: () => getMyLeads({
            employeeId: employee?._id,
            employeeNames: aliases,
            tab: "my",
            queue: "ALL",
            page: 1,
            limit: 200,
        }),
        enabled: Boolean(employee?._id),
        staleTime: 60_000,
    });
    const scheduledLeads = useMemo(
        () => (leadsQuery.data?.leads || [])
            .filter((lead) => Boolean(lead.followUpAt))
            .sort((first, second) => new Date(first.followUpAt || 0).getTime() - new Date(second.followUpAt || 0).getTime()),
        [leadsQuery.data?.leads]
    );
    const eventsByDate = useMemo(() => {
        const grouped = new Map<string, typeof scheduledLeads>();
        scheduledLeads.forEach((lead) => {
            const key = phDateKey(lead.followUpAt!);
            grouped.set(key, [...(grouped.get(key) || []), lead]);
        });
        return grouped;
    }, [scheduledLeads]);
    const selectedEvents = eventsByDate.get(selectedDate) || [];
    const days = calendarDays(visibleMonth);
    const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(
        new Date(`${visibleMonth}-01T00:00:00`)
    );
    const changeMonth = (offset: number) => {
        const [year, month] = visibleMonth.split("-").map(Number);
        const next = new Date(year, month - 1 + offset, 1);
        const nextMonth = monthKey(next);
        setVisibleMonth(nextMonth);
        setSelectedDate(`${nextMonth}-01`);
    };

    return (
        <MainLayout>
            <section className="theme-surface-bg min-h-[calc(100vh-8.5rem)] rounded-lg border border-white/10">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
                    <div>
                        <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Scheduled lead follow-ups</p>
                        <h2 className="mt-1 text-xl font-semibold text-white">Calendar</h2>
                    </div>
                    <button className="rounded-md bg-white/[0.06] px-3 py-1.5 text-sm font-semibold text-white/65 transition hover:bg-white/10 hover:text-white" type="button" onClick={() => { setVisibleMonth(today.slice(0, 7)); setSelectedDate(today); }}>
                        Today
                    </button>
                </div>

                <div className="grid gap-5 p-5 lg:grid-cols-[20rem_1fr]">
                    <aside className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                        <div className="flex items-center justify-between gap-2">
                            <button className="grid size-8 place-items-center rounded-md border border-white/10 text-white/60 hover:bg-white/10 hover:text-white" type="button" aria-label="Previous month" onClick={() => changeMonth(-1)}><FiChevronLeft aria-hidden="true" /></button>
                            <p className="text-sm font-semibold text-white">{monthLabel}</p>
                            <button className="grid size-8 place-items-center rounded-md border border-white/10 text-white/60 hover:bg-white/10 hover:text-white" type="button" aria-label="Next month" onClick={() => changeMonth(1)}><FiChevronRight aria-hidden="true" /></button>
                        </div>
                        <div className="mt-4 grid grid-cols-7 gap-1 text-center text-xs text-white/45">
                            {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
                            {days.map((date) => {
                                const eventCount = eventsByDate.get(date.key)?.length || 0;
                                return (
                                    <button key={date.key} className={["relative flex aspect-square items-center justify-center rounded-md border transition", selectedDate === date.key ? "border-[#842cff] bg-[#842cff] font-semibold text-white" : date.inMonth ? "border-transparent text-white/70 hover:bg-white/10" : "border-transparent text-white/20"].join(" ")} type="button" onClick={() => setSelectedDate(date.key)} aria-label={`${date.key}${eventCount ? `, ${eventCount} follow-ups` : ""}`}>
                                        {date.day}
                                        {eventCount > 0 && <span className="absolute bottom-1 size-1 rounded-full bg-emerald-300" aria-hidden="true" />}
                                    </button>
                                );
                            })}
                        </div>
                    </aside>

                    <div className="space-y-3">
                        <div className="mb-4">
                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Selected date</p>
                            <h3 className="mt-1 text-lg font-semibold text-white">{formatPhDate(`${selectedDate}T00:00:00+08:00`)}</h3>
                        </div>
                        {leadsQuery.isPending && Array.from({ length: 3 }, (_, index) => <div key={index} className="h-20 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />)}
                        {leadsQuery.isError && <div className="rounded-lg border border-red-400/20 bg-red-400/10 p-4 text-sm font-semibold text-red-200">Unable to load scheduled follow-ups. Please refresh and try again.</div>}
                        {!leadsQuery.isPending && !leadsQuery.isError && selectedEvents.length === 0 && (
                            <div className="rounded-lg border border-dashed border-white/10 px-5 py-10 text-center">
                                <p className="text-sm font-semibold text-white/65">No follow-ups scheduled</p>
                                <p className="mt-1 text-xs text-white/35">Follow-ups scheduled from Leads will appear here automatically.</p>
                            </div>
                        )}
                        {selectedEvents.map((lead) => (
                            <article key={lead._id} className="grid gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-4 md:grid-cols-[9rem_1fr]">
                                <p className="text-sm font-semibold text-[#b994ff]">{formatPhDateTime(lead.followUpAt!)}</p>
                                <div className="min-w-0">
                                    <h3 className="truncate font-semibold text-white">{lead.businessName || lead.leadName || "Lead follow-up"}</h3>
                                    <p className="mt-1 text-sm text-white/45">{lead.followUpNote || lead.phone || "Scheduled follow-up"}</p>
                                </div>
                            </article>
                        ))}
                    </div>
                </div>
            </section>
        </MainLayout>
    );
}
