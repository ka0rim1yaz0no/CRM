import { normalizeEmployeeAvailabilityStatus } from "../api/employees";
import "./AvailabilityBadge.css";
export default function AvailabilityBadge({ status }: { status?: string }) {
  const normalized = status ? normalizeEmployeeAvailabilityStatus(status) : "UNKNOWN";
  return <span className={`availability-badge availability-${normalized.toLowerCase().replaceAll(" ", "-")}`}><span aria-hidden="true" />{normalized}</span>;
}
