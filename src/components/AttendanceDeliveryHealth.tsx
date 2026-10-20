import { useQuery } from "@tanstack/react-query";
import { getAttendanceDeliveryHealth } from "../api/attendanceHub";

export default function AttendanceDeliveryHealth({ business }: { business: string }) {
    const { data, error, isPending, refetch } = useQuery({ queryKey: ["attendance-delivery-health", business],
        queryFn: () => getAttendanceDeliveryHealth(business), refetchInterval: 30_000, retry: false });
    if (data === null || (error as { response?: { status?: number } })?.response?.status === 404) return null;
    return <details className="attendance-hub-help attendance-hub-delivery-health">
        <summary>Attendance delivery{data ? ` · ${data.businesses.reduce((sum, item) => sum + item.pending, 0)} pending` : ""}</summary>
        {isPending && <p role="status">Loading delivery health...</p>}
        {error && <p role="alert">Delivery health unavailable. <button type="button" onClick={() => void refetch()}>Retry</button></p>}
        {data && <><table><thead><tr><th>Business</th><th>Pending jobs</th><th>Oldest</th><th>Last error</th></tr></thead><tbody>
            {data.businesses.map(item => <tr key={item.businessId}><td>{item.businessId}</td><td>{item.pending}</td>
                <td>{item.oldestAgeSeconds === null ? "--" : `${Math.floor(item.oldestAgeSeconds / 60)}m`}</td><td>{item.lastErrorCode || "--"}</td></tr>)}
        </tbody></table><table><thead><tr><th>Worker</th><th>Last run</th><th>Scanned</th><th>Completed</th><th>Failed</th><th>Pending</th></tr></thead><tbody>
            {data.workers.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.running ? "Running" : item.lastRunAt
                ? new Date(item.lastRunAt).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" }) : "Not run"}</td>
                <td>{item.counters.scanned}</td><td>{item.counters.closed}</td><td>{item.counters.failed}</td><td>{item.counters.deliveryPending}</td></tr>)}
        </tbody></table></>}
    </details>;
}
