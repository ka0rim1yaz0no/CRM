import type { Request, Response } from "express";
import { dataCheckEnabled, dataCheckNavigationEnabled } from "../config/rolloutFlags";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { getConfiguredBusinesses } from "../config/tenancy";
import { attendancePolicy } from "../services/attendanceLedgerService";
import { lastCompletedShift, validCheckDate } from "../services/dataCheckMath";
import { runDataCheck } from "../services/dataCheckService";
import type { DataCheckReport } from "../../../shared/dataCheck";

const cache = new Map<string, { until: number; promise: Promise<DataCheckReport> }>();
export function clearDataCheckCache() { cache.clear(); }
async function readPolicy(business?: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([attendancePolicy(business), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Policy read timed out")), 3000); })]); }
  finally { clearTimeout(timer); }
}
export async function dataCheckConfig(_request: Request, response: Response) {
  if (!dataCheckEnabled()) { response.set("Cache-Control", "no-store").json({ enabled: false, navigationVisible: false, businesses: [] }); return; }
  let policy;
  try { policy = await readPolicy(); } catch { response.status(503).json({ message: "Attendance policy is unavailable. No records were changed." }); return; }
  response.set("Cache-Control", "no-store").json({ enabled: true, navigationVisible: dataCheckNavigationEnabled(), defaultDate: lastCompletedShift(policy), serverTime: new Date().toISOString(), businesses: getConfiguredBusinesses().map(({ id, name }) => ({ id, name })) });
}
export async function getDataCheck(request: Request, response: Response) {
  if (!dataCheckEnabled()) { response.status(404).json({ message: "Data Check is disabled." }); return; }
  const actor = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
  if (!actor) { response.status(403).json({ message: "A verified administrator session is required." }); return; }
  if (Object.keys(request.query).some(key => !["date", "business"].includes(key))) {
    response.status(400).json({ message: "Only a single date and business may be selected." }); return;
  }
  const business = request.query.business === undefined ? request.business?.id : request.query.business;
  if (typeof business !== "string" || !getConfiguredBusinesses().some(item => item.id === business || business === "all")) {
    response.status(400).json({ message: "Choose an available business." }); return;
  }
  let policy;
  try { policy = await readPolicy(business === "all" ? request.business?.id : business); } catch { response.status(503).json({ message: "Attendance policy is unavailable. No records were changed." }); return; }
  const date = request.query.date === undefined ? lastCompletedShift(policy) : request.query.date;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (!validCheckDate(date) || date < "2000-01-01" || date > today || typeof business !== "string" || !getConfiguredBusinesses().some(item => item.id === business || business === "all")) {
    response.status(400).json({ message: "Choose a valid shift date (not in the future) and an available business." }); return;
  }
  const key = `${date}:${business}:${getConfiguredBusinesses().map(item => item.id).join(",")}`;
  const existing = cache.get(key);
  const cached = Boolean(existing && existing.until > Date.now());
  let entry = cached ? existing! : null;
  if (!entry) {
    if (cache.size >= 50) cache.delete(cache.keys().next().value!);
    entry = { until: Date.now() + 60_000, promise: runDataCheck(request, date, business) };
    cache.set(key, entry);
  }
  // Audit identity is the configured administrator slot name, never a login code or response data.
  console.info("Data Check requested", { actor: actor.name, business, date, cached });
  try {
    const report = await entry.promise;
    response.set("Cache-Control", "private, no-store").json({ ...structuredClone(report), cached });
  } catch {
    if (cache.get(key) === entry) cache.delete(key);
    response.status(503).json({ message: "Data Check could not verify the sources within the local read budget. No records were changed." });
  }
}
