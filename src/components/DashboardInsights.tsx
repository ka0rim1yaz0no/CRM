import type { DashboardWorkspaceData } from "../api/dashboardWorkspace";
import { dashboardHourOrder, phHourLabel, phShiftTimeLabel, recordedTalkTime } from "../lib/dashboardCallInsights";

const palette = ["#5b21b6", "#0369a1", "#047857"];
function Bars({ title, rows, hourly = false }: { title: string; rows: Array<{ label: string; value: number; detail?: string }>; hourly?: boolean }) {
  const maximum = Math.max(1, ...rows.map((row) => row.value));
  const width = Math.max(1, rows.length);
  return <div><h3>{title}</h3><svg className="dw-chart" viewBox="0 0 320 150" preserveAspectRatio={hourly ? "none" : undefined} role="group" aria-label={title}>
    {rows.map((row, index) => {
      const x = 8 + index * 304 / width;
      const height = row.value / maximum * 108;
      return <g key={row.label} tabIndex={0} role="img" aria-label={`${row.label}: ${row.value}${row.detail ? `, ${row.detail}` : ""}`}>
        <title>{`${row.label}: ${row.value}${row.detail ? `, ${row.detail}` : ""}`}</title>
        <rect x={x} y={118 - height} width={Math.max(2, 290 / width)} height={Math.max(1, height)} fill={palette[index % palette.length]} />
        {!hourly && rows.length <= 8 && <><text x={x + 145 / width} y={136} textAnchor="middle">{row.label}</text><text x={x + 145 / width} y={Math.max(10, 112 - height)} textAnchor="middle">{row.value}</text></>}
      </g>;
    })}
    <line x1="8" x2="312" y1="119" y2="119" stroke="#64748b" />
  </svg>{hourly && <div className="dw-hour-axis" data-dense={rows.length > 10} style={{ gridTemplateColumns: `repeat(${width},minmax(0,1fr))` }} aria-hidden="true">{rows.map((row, index) => <span key={row.label}>{rows.length <= 10 || index < 2 || index % 4 === 0 || index === rows.length - 1 ? row.label : ""}</span>)}</div>}
  {!rows.some((row) => row.value > 0) && <p>No recorded activity in this period.</p>}</div>;
}

export default function DashboardInsights({ data }: { data: DashboardWorkspaceData }) {
  const shiftStart = data.policy?.shiftStart || "23:00", shiftEnd = data.policy?.shiftEnd || "08:00";
  const hours = dashboardHourOrder(shiftStart, shiftEnd), shiftCalls = data.calls.filter(row => hours.includes(row._id.hour));
  const calls = shiftCalls.reduce((sum, row) => sum + row.count, 0);
  const seconds = shiftCalls.reduce((sum, row) => sum + row.seconds, 0);
  const pipeline = data.dashboard.pipeline || {
    newLeads: data.dashboard.agents.reduce((sum, row) => sum + row.newLeads, 0),
    followUps: data.dashboard.agents.reduce((sum, row) => sum + row.followUps, 0),
    qualified: data.dashboard.agents.reduce((sum, row) => sum + row.qualified, 0),
  };
  return <section className="dw-insights" aria-label="Operational insights">
    <Bars title="Lead pipeline" rows={[
      { label: "New", value: pipeline.newLeads },
      { label: "Follow up", value: pipeline.followUps },
      { label: "Qualified", value: pipeline.qualified },
    ]} />
    <div><Bars title="Calls by PH hour" hourly rows={hours.map((hour) => {
      const rows = shiftCalls.filter((row) => row._id.hour === hour);
      const count = rows.reduce((sum, row) => sum + row.count, 0);
      return { label: phHourLabel(hour), value: count, detail: recordedTalkTime(rows.reduce((sum, row) => sum + row.seconds, 0), count) };
    })} /><p>Shift {phShiftTimeLabel(shiftStart)} - {phShiftTimeLabel(shiftEnd)} PH</p><p>{calls} calls | {recordedTalkTime(seconds, calls)}</p></div>
    <Bars title="Recorded productivity activity" rows={data.trend.map((row) => ({ label: row.day.slice(5), value: row.count, detail: `${row.comments} comments, ${row.touched} leads touched` }))} />
  </section>;
}
