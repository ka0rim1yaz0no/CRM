import type { Request, Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { Employee, normalizeEmployeeAvailabilityStatus } from "../models/Employee";
import { BrowserActivityEvent, BrowserActivityScreenshot, type BrowserActivityClassification } from "../models/BrowserActivity";
import { getSystemSettings } from "./systemSettingsController";

const allowedEventTypes = new Set([
  "site_visit",
  "tab_created",
  "tab_updated",
  "tab_activated",
  "tab_closed",
  "window_focus",
  "idle_state",
  "link_clicked",
  "form_submitted",
  "copy",
  "paste",
  "keyboard_activity",
  "mouse_activity",
  "scroll",
  "screenshot_captured",
  "manual_sync",
]);
const allowedClassifications = new Set(["work", "non-work", "unknown"]);
const noisyBulkEventTypes = new Set([
  "tab_created",
  "tab_updated",
  "tab_activated",
  "tab_closed",
  "window_focus",
  "keyboard_activity",
  "mouse_activity",
  "scroll",
]);
const trackingPausedAvailabilityStatuses = new Set(["BREAK", "LUNCH"]);
const uploadRoot = path.resolve(process.cwd(), "uploads", "browser-screenshots");
const extensionPackageFileName = "assistly-crm-activity-tracker.zip";

function extensionKey() {
  return process.env.CRM_EXTENSION_KEY || "dev-crm-extension-key";
}

function isExtensionAuthorized(request: Request) {
  return String(request.header("x-crm-extension-key") || "") === extensionKey();
}

function cleanString(value: unknown, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanUrl(value: unknown) {
  const rawUrl = cleanString(value, 2000);

  try {
    const url = new URL(rawUrl);
    ["password", "token", "access_token", "refresh_token", "key", "secret", "auth", "code"].forEach((param) => {
      if (url.searchParams.has(param)) {
        url.searchParams.set(param, "[redacted]");
      }
    });
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function domainFromUrl(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function classificationValue(value: unknown): BrowserActivityClassification {
  const normalizedValue = cleanString(value, 20);
  return allowedClassifications.has(normalizedValue) ? normalizedValue as BrowserActivityClassification : "unknown";
}

function eventTypeValue(value: unknown) {
  const eventType = cleanString(value, 80);
  return allowedEventTypes.has(eventType) ? eventType : "tab_updated";
}

function dateValue(value: unknown) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function safeMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function extensionPackageCandidates() {
  return [
    path.resolve(process.cwd(), "..", "crmext", "dist", extensionPackageFileName),
    path.resolve(process.cwd(), "crmext", "dist", extensionPackageFileName),
    path.resolve(process.cwd(), "dist", extensionPackageFileName),
  ];
}

function screenshotUploadCandidates() {
  return Array.from(
    new Set([
      uploadRoot,
      path.resolve(process.cwd(), "backend", "uploads", "browser-screenshots"),
      path.resolve(process.cwd(), "..", "uploads", "browser-screenshots"),
    ])
  ).filter((candidate) => path.basename(candidate) === "browser-screenshots");
}

function isSafeScreenshotFileName(value: string) {
  return /^[a-z0-9_.-]+$/i.test(value) && !value.includes("..");
}

function screenshotApiFileUrl(dateKey: string, fileName: string) {
  return `/api/browser-activity/screenshots/file/${dateKey}/${fileName}`;
}

async function removeScreenshotUploads() {
  let deletedFolders = 0;

  for (const directory of screenshotUploadCandidates()) {
    try {
      const stat = await fs.stat(directory);
      if (stat.isDirectory()) {
        await fs.rm(directory, { recursive: true, force: true });
        deletedFolders += 1;
      }
    } catch {
      // Missing screenshot folders are already clear.
    }
  }

  return deletedFolders;
}

async function employeeFromRequest(request: Request) {
  const employeeId = cleanString(request.body?.employeeId || request.query.employeeId, 80);
  const employeeCode = cleanString(request.body?.employeeCode || request.query.employeeCode, 80);

  if (employeeId) {
    const employee = await Employee.findOne({ _id: employeeId, status: { $ne: "Archived" } });
    if (employee && (!employeeCode || employee.employeeCode === employeeCode)) return employee;
  }

  if (employeeCode) {
    return Employee.findOne({ employeeCode, status: { $ne: "Archived" } });
  }

  return null;
}

function trackingPauseState(employee: { availabilityStatus?: string }) {
  const availabilityStatus = normalizeEmployeeAvailabilityStatus(employee.availabilityStatus);
  const paused = trackingPausedAvailabilityStatuses.has(availabilityStatus);

  return {
    paused,
    availabilityStatus,
    reason: paused ? availabilityStatus : "",
    checkedAt: new Date().toISOString(),
  };
}

function respondIfTrackingPaused(employee: { availabilityStatus?: string }, response: Response) {
  const pauseState = trackingPauseState(employee);

  if (!pauseState.paused) {
    return false;
  }

  response.status(202).json({
    inserted: 0,
    skipped: true,
    ...pauseState,
  });
  return true;
}

export async function createBrowserActivityEvents(request: Request, response: Response) {
  if (!isExtensionAuthorized(request)) {
    response.status(401).json({ message: "Invalid extension key" });
    return;
  }

  const employee = await employeeFromRequest(request);
  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const events = Array.isArray(request.body.events) ? (request.body.events as Record<string, unknown>[]).slice(0, 250) : [];
  if (respondIfTrackingPaused(employee, response)) {
    return;
  }

  const documents = events.flatMap((event) => {
    const eventType = eventTypeValue(event.eventType);
    if (noisyBulkEventTypes.has(eventType)) return [];

    const url = cleanUrl(event.url);
    const normalizedUrl = cleanUrl(event.normalizedUrl || url);
    const domain = cleanString(event.domain || domainFromUrl(normalizedUrl), 180).toLowerCase();

    return [{
      employee: employee._id,
      employeeName: employee.name,
      eventType,
      url,
      normalizedUrl,
      title: cleanString(event.title, 300),
      domain,
      classification: classificationValue(event.classification),
      category: cleanString(event.category || "Unknown", 80),
      tabId: Number.isFinite(Number(event.tabId)) ? Number(event.tabId) : null,
      windowId: Number.isFinite(Number(event.windowId)) ? Number(event.windowId) : null,
      source: "extension" as const,
      occurredAt: dateValue(event.occurredAt),
      metadata: safeMetadata(event.metadata),
    }];
  });

  if (documents.length) {
    await BrowserActivityEvent.insertMany(documents, { ordered: false });
  }

  response.status(201).json({ inserted: documents.length });
}

export async function createBrowserActivityScreenshot(request: Request, response: Response) {
  if (!isExtensionAuthorized(request)) {
    response.status(401).json({ message: "Invalid extension key" });
    return;
  }

  const employee = await employeeFromRequest(request);
  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  if (respondIfTrackingPaused(employee, response)) {
    return;
  }

  const dataUrl = cleanString(request.body.dataUrl, 20_000_000);
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([a-z0-9+/=]+)$/i);

  if (!match) {
    response.status(400).json({ message: "Valid screenshot dataUrl is required" });
    return;
  }

  const [, mimeType, base64] = match;
  const capturedAt = dateValue(request.body.capturedAt);
  const dateKey = capturedAt.toISOString().slice(0, 10);
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const directory = path.join(uploadRoot, dateKey);
  const fileName = `${String(employee._id)}-${capturedAt.getTime()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
  const imageBuffer = Buffer.from(base64, "base64");

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, fileName), imageBuffer);

  const url = cleanUrl(request.body.url);
  const normalizedUrl = cleanUrl(request.body.normalizedUrl || url);
  const domain = cleanString(request.body.domain || domainFromUrl(normalizedUrl), 180).toLowerCase();
  const fileUrl = screenshotApiFileUrl(dateKey, fileName);
  const screenshot = await BrowserActivityScreenshot.create({
    employee: employee._id,
    employeeName: employee.name,
    url,
    normalizedUrl,
    title: cleanString(request.body.title, 300),
    domain,
    classification: classificationValue(request.body.classification),
    category: cleanString(request.body.category || "Unknown", 80),
    fileUrl,
    mimeType,
    data: imageBuffer,
    width: Number(request.body.width || 0) || 0,
    height: Number(request.body.height || 0) || 0,
    capturedAt,
    metadata: safeMetadata(request.body.metadata),
  });

  await BrowserActivityEvent.create({
    employee: employee._id,
    employeeName: employee.name,
    eventType: "screenshot_captured",
    url,
    normalizedUrl,
    title: cleanString(request.body.title, 300),
    domain,
    classification: classificationValue(request.body.classification),
    category: cleanString(request.body.category || "Unknown", 80),
    tabId: Number.isFinite(Number(request.body.tabId)) ? Number(request.body.tabId) : null,
    windowId: Number.isFinite(Number(request.body.windowId)) ? Number(request.body.windowId) : null,
    source: "extension",
    occurredAt: capturedAt,
    metadata: { screenshotId: screenshot._id, fileUrl: screenshot.fileUrl, ...safeMetadata(request.body.metadata) },
  });

  const screenshotResponse = screenshot.toObject() as Record<string, unknown>;
  delete screenshotResponse.data;

  response.status(201).json({ screenshot: screenshotResponse });
}

export async function getBrowserActivityTrackingStatus(request: Request, response: Response) {
  if (!isExtensionAuthorized(request)) {
    response.status(401).json({ message: "Invalid extension key" });
    return;
  }

  const employee = await employeeFromRequest(request);
  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  response.json(trackingPauseState(employee));
}

export async function serveBrowserActivityScreenshotFile(request: Request, response: Response) {
  const dateKey = cleanString(request.params.dateKey, 20);
  const fileName = cleanString(request.params.fileName, 220);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !isSafeScreenshotFileName(fileName)) {
    response.status(400).json({ message: "Invalid screenshot file path" });
    return;
  }

  for (const uploadDirectory of screenshotUploadCandidates()) {
    const root = path.resolve(uploadDirectory);
    const filePath = path.resolve(root, dateKey, fileName);

    if (!filePath.startsWith(`${root}${path.sep}`)) {
      continue;
    }

    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }

      response.sendFile(filePath);
      return;
    } catch {
      // Try the next deployment layout.
    }
  }

  const fileUrl = screenshotApiFileUrl(dateKey, fileName);
  const legacyFileUrl = `/uploads/browser-screenshots/${dateKey}/${fileName}`;
  const screenshot = await BrowserActivityScreenshot.findOne({ fileUrl: { $in: [fileUrl, legacyFileUrl] } }).select("+data");

  if (screenshot?.data && Buffer.isBuffer(screenshot.data)) {
    response.type(screenshot.mimeType || "image/jpeg");
    response.setHeader("Cache-Control", "private, max-age=3600");
    response.send(screenshot.data);
    return;
  }

  response.status(404).json({ message: "Screenshot file not found" });
}

export async function listBrowserActivityEvents(request: Request, response: Response) {
  const employeeId = cleanString(request.query.employeeId, 80);
  const classification = cleanString(request.query.classification, 20);
  const category = cleanString(request.query.category, 80);
  const start = request.query.start ? dateValue(request.query.start) : null;
  const end = request.query.end ? dateValue(request.query.end) : null;
  const limit = Math.min(Math.max(Number(request.query.limit || 200) || 200, 1), 1000);
  const filter: Record<string, unknown> = {};

  if (employeeId) filter.employee = employeeId;
  if (allowedClassifications.has(classification)) filter.classification = classification;
  if (category) filter.category = category;
  if (start || end) {
    filter.occurredAt = {
      ...(start ? { $gte: start } : {}),
      ...(end ? { $lte: end } : {}),
    };
  }

  const events = await BrowserActivityEvent.find(filter).sort({ occurredAt: -1 }).limit(limit);
  response.json(events);
}

export async function listBrowserActivityScreenshots(request: Request, response: Response) {
  const employeeId = cleanString(request.query.employeeId, 80);
  const classification = cleanString(request.query.classification, 20);
  const category = cleanString(request.query.category, 80);
  const start = request.query.start ? dateValue(request.query.start) : null;
  const end = request.query.end ? dateValue(request.query.end) : null;
  const limit = Math.min(Math.max(Number(request.query.limit || 100) || 100, 1), 500);
  const filter: Record<string, unknown> = {};

  if (employeeId) filter.employee = employeeId;
  if (allowedClassifications.has(classification)) filter.classification = classification;
  if (category) filter.category = category;
  if (start || end) {
    filter.capturedAt = {
      ...(start ? { $gte: start } : {}),
      ...(end ? { $lte: end } : {}),
    };
  }

  const screenshots = await BrowserActivityScreenshot.find(filter).sort({ capturedAt: -1 }).limit(limit);
  response.json(screenshots);
}

export async function downloadBrowserActivityExtension(_request: Request, response: Response) {
  for (const packagePath of extensionPackageCandidates()) {
    try {
      await fs.access(packagePath);
      response.download(packagePath, extensionPackageFileName);
      return;
    } catch {
      // Try the next deployment layout.
    }
  }

  response.status(404).json({
    message: "Extension package is not built yet. Run npm run extension:package, then try again.",
  });
}

export async function clearBrowserActivityData(_request: Request, response: Response) {
  const settings = await getSystemSettings();
  if (settings.trackerClearDataEnabled === false) {
    response.status(403).json({ message: "Tracker clear data is disabled in admin settings" });
    return;
  }

  const [eventsBefore, screenshotsBefore] = await Promise.all([
    BrowserActivityEvent.countDocuments(),
    BrowserActivityScreenshot.countDocuments(),
  ]);
  const [eventsResult, screenshotsResult] = await Promise.all([
    BrowserActivityEvent.deleteMany({}),
    BrowserActivityScreenshot.deleteMany({}),
  ]);
  const screenshotFoldersDeleted = await removeScreenshotUploads();

  response.json({
    eventsBefore,
    screenshotsBefore,
    eventsDeleted: eventsResult.deletedCount || 0,
    screenshotsDeleted: screenshotsResult.deletedCount || 0,
    screenshotFoldersDeleted,
  });
}
