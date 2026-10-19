import type { DashboardWorkspaceData } from "../api/dashboardWorkspace";

const palette = ["#5b21b6", "#0369a1", "#047857"];
function Bars({ title, rows }: { title: string; rows: Array<{ label: string; value: number; detail?: string }> }) {
  const maximum = Math.max(1, ...rows.map((row) => row.value));
  const width = Math.max(1, rows.length);
  return <div><h3>{title}</h3><svg className="dw-chart" viewBox="0 0 320 150" role="group" aria-label={title}>
    {rows.map((row, index) => {
      const x = 8 + index * 304 / width;
      const height = row.value / maximum * 108;
      return <g key={row.label} tabIndex={0} role="img" aria-label={`${row.label}: ${row.value}${row.detail ? `, ${row.detail}` : ""}`}>
        <title>{row.label}: {row.value}{row.detail ? `, ${row.detail}` : ""}</title>
        <rect x={x} y={118 - height} width={Math.max(2, 290 / width)} height={Math.max(1, height)} fill={palette[index % palette.length]} />
        {rows.length <= 8 && <><text x={x + 145 / width} y={136} textAnchor="middle">{row.label}</text><text x={x + 145 / width} y={Math.max(10, 112 - height)} textAnchor="middle">{row.value}</text></>}
      </g>;
    })}
    <line x1="8" x2="312" y1="119" y2="119" stroke="#64748b" />
  </svg>{!rows.some((row) => row.value > 0) && <p>No recorded activity in this period.</p>}</div>;
}

export default function DashboardInsights({ data }: { data: DashboardWorkspaceData }) {
  const calls = data.calls.reduce((sum, row) => sum + row.count, 0);
  const seconds = data.calls.reduce((sum, row) => sum + row.seconds, 0);
  return <section className="dw-insights" aria-label="Operational insights">
    <Bars title="Lead pipeline" rows={[
      { label: "New", value: data.dashboard.agents.reduce((sum, row) => sum + row.newLeads, 0) },
      { label: "Follow up", value: data.dashboard.agents.reduce((sum, row) => sum + row.followUps, 0) },
      { label: "Qualified", value: data.dashboard.agents.reduce((sum, row) => sum + row.qualified, 0) },
    ]} />
    <div><Bars title="Calls by PH hour" rows={Array.from({ length: 24 }, (_, hour) => {
      const rows = data.calls.filter((row) => row._id.hour === hour);
      return { label: `${hour}:00`, value: rows.reduce((sum, row) => sum + row.count, 0), detail: `${Math.round(rows.reduce((sum, row) => sum + row.seconds, 0) / 60)} talk minutes` };
    })} /><p>{calls} calls | {Math.round(seconds / 60)} talk minutes</p></div>
    <Bars title="Recorded productivity activity" rows={data.trend.map((row) => ({ label: row.day.slice(5), value: row.count, detail: `${row.comments} comments, ${row.touched} leads touched` }))} />
  </section>;
}
