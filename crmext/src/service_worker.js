const SETTINGS_KEY = "crmActivitySettings";
const QUEUE_KEY = "crmActivityQueue";
const RECENT_KEY = "crmActivityRecent";
const CURRENT_VISIT_KEY = "crmActivityCurrentVisit";
const TRACKING_PAUSE_KEY = "crmActivityTrackingPause";
const FLUSH_ALARM = "crm_activity_flush";
const SCREENSHOT_ALARM = "crm_activity_screenshot";
const MIN_VISIT_DURATION_MS = 5_000;
const SCREENSHOT_CAPTURE_COOLDOWN_MS = 3 * 60_000;
const TRACKING_PAUSE_REFRESH_MS = 60_000;
const IMMEDIATE_FLUSH_EVENT_TYPES = new Set(["site_visit", "screenshot_captured", "manual_sync", "link_clicked", "form_submitted"]);
const PAUSED_AVAILABILITY_STATUSES = new Set(["BREAK", "LUNCH"]);
let lastScreenshotAttemptAt = 0;

const DEFAULT_SETTINGS = {
  apiBaseUrl: "https://crm.assistly123.com/api",
  extensionKey: "dev-crm-extension-key",
  employeeId: "",
  employeeName: "",
  employeeCode: "",
  trackingEnabled: true,
  screenshotsEnabled: true,
  screenshotIntervalMinutes: 3,
  captureNonWorkOnly: true,
  workDomains: ["crm.assistly123.com", "assistly123.com", "localhost", "127.0.0.1"],
  ignoreDomains: []
};
const MANAGED_SETTINGS = {
  trackingEnabled: true,
  screenshotsEnabled: true,
  captureNonWorkOnly: true,
  screenshotIntervalMinutes: 3
};
const CRM_WEB_URL_PATTERNS = [
  "http://localhost:5173/*",
  "http://127.0.0.1:5173/*",
  "https://crm.assistly123.com/*",
  "https://*.assistly123.com/*"
];

const WORK_CATEGORIES = [
  { category: "CRM", domains: ["crm.assistly123.com", "assistly123.com", "localhost", "127.0.0.1"] },
  { category: "Email", domains: ["mail.google.com", "outlook.office.com", "outlook.live.com"] },
  { category: "Productivity", domains: ["docs.google.com", "sheets.google.com", "drive.google.com", "office.com", "notion.so", "slack.com", "teams.microsoft.com"] },
  { category: "Development", domains: ["github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com", "developer.mozilla.org"] },
  { category: "Research", domains: ["google.com", "bing.com", "duckduckgo.com", "wikipedia.org"] }
];

const NON_WORK_CATEGORIES = [
  { category: "Social Media", domains: ["facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "reddit.com"] },
  { category: "Streaming", domains: ["youtube.com", "netflix.com", "hulu.com", "disneyplus.com", "twitch.tv", "spotify.com"] },
  { category: "Shopping", domains: ["amazon.com", "ebay.com", "shopee.ph", "lazada.com.ph", "zalora.com.ph"] },
  { category: "Gaming", domains: ["steampowered.com", "roblox.com", "epicgames.com", "miniclip.com"] },
  { category: "Gambling", domains: ["bet365.com", "draftkings.com", "fanduel.com"] },
  { category: "News", domains: ["cnn.com", "bbc.com", "nytimes.com", "inquirer.net", "philstar.com"] }
];

const tabCache = new Map();

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(value) {
  return new Promise((resolve) => chrome.storage.local.set(value, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function queryTabs(queryInfo) {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, (tabs) => resolve(tabs || [])));
}

function readCrmAuthFromTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: readCrmAuthUserFromPage
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(results?.[0]?.result || {});
      }
    );
  });
}

async function getSettings() {
  const result = await storageGet(SETTINGS_KEY);
  const storedSettings = result[SETTINGS_KEY] || {};
  const settings = normalizeSettings(storedSettings);
  if (JSON.stringify(settings) !== JSON.stringify(storedSettings)) {
    await storageSet({ [SETTINGS_KEY]: settings });
    await configureAlarms(settings);
    await updateBadge(settings);
  }
  return settings;
}

async function saveSettings(settings) {
  const nextSettings = normalizeSettings(settings);
  await storageSet({ [SETTINGS_KEY]: nextSettings });
  await configureAlarms(nextSettings);
  await updateBadge(nextSettings);
  return nextSettings;
}

function normalizeSettings(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    ...MANAGED_SETTINGS,
    workDomains: normalizeDomainList(settings.workDomains || DEFAULT_SETTINGS.workDomains),
    ignoreDomains: normalizeDomainList(settings.ignoreDomains || [])
  };
}

function defaultTrackingPauseState() {
  return {
    paused: false,
    reason: "",
    availabilityStatus: "",
    checkedAt: "",
    message: ""
  };
}

function normalizeAvailabilityStatus(value) {
  const status = String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (status === "ONLINE") return "ONLINE";
  if (status === "OFFLINE") return "OFFLINE";
  if (status === "BREAK" || status === "ON BREAK") return "BREAK";
  if (status === "LUNCH" || status === "LUNCH BREAK") return "LUNCH";
  if (status === "OFF THE PHONE" || status === "IDLE" || status === "COACHING") return "OFF THE PHONE";
  return "";
}

async function getTrackingPauseState() {
  const result = await storageGet(TRACKING_PAUSE_KEY);
  return {
    ...defaultTrackingPauseState(),
    ...(result[TRACKING_PAUSE_KEY] || {})
  };
}

async function setTrackingPauseState(state) {
  const nextState = {
    ...defaultTrackingPauseState(),
    ...state,
    checkedAt: state?.checkedAt || new Date().toISOString()
  };
  await storageSet({ [TRACKING_PAUSE_KEY]: nextState });
  return nextState;
}

async function refreshTrackingPauseState(settings = null) {
  const resolvedSettings = settings || await getSettings();

  if (!resolvedSettings.employeeId || !resolvedSettings.employeeCode || !resolvedSettings.apiBaseUrl || !resolvedSettings.extensionKey) {
    return setTrackingPauseState(defaultTrackingPauseState());
  }

  const params = new URLSearchParams({
    employeeId: resolvedSettings.employeeId,
    employeeCode: resolvedSettings.employeeCode
  });
  const response = await fetch(`${resolvedSettings.apiBaseUrl.replace(/\/$/, "")}/browser-activity/tracking-status?${params.toString()}`, {
    headers: { "X-CRM-Extension-Key": resolvedSettings.extensionKey },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Tracking status check failed: ${response.status}`);
  }

  const status = await response.json();
  const availabilityStatus = normalizeAvailabilityStatus(status.availabilityStatus);
  const paused = Boolean(status.paused || PAUSED_AVAILABILITY_STATUSES.has(availabilityStatus));
  const pauseState = await setTrackingPauseState({
    paused,
    reason: status.reason || "",
    availabilityStatus,
    checkedAt: status.checkedAt || new Date().toISOString(),
    message: paused ? `Tracking paused: ${status.reason || availabilityStatus || "break"}` : ""
  });

  if (pauseState.paused) {
    await clearCurrentVisit();
  }

  await updateBadge(resolvedSettings);
  return pauseState;
}

async function isTrackingPaused(settings = null) {
  const currentState = await getTrackingPauseState();
  const checkedAtMs = currentState.checkedAt ? new Date(currentState.checkedAt).getTime() : 0;
  const isFresh = checkedAtMs > 0 && Date.now() - checkedAtMs < TRACKING_PAUSE_REFRESH_MS;

  if (isFresh) {
    return currentState.paused;
  }

  try {
    const refreshedState = await refreshTrackingPauseState(settings);
    return refreshedState.paused;
  } catch {
    return currentState.paused;
  }
}

function normalizeDomainList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  }

  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function domainMatches(domain, pattern) {
  const normalizedDomain = String(domain || "").replace(/^www\./, "").toLowerCase();
  const normalizedPattern = String(pattern || "").replace(/^www\./, "").toLowerCase();
  return normalizedDomain === normalizedPattern || normalizedDomain.endsWith(`.${normalizedPattern}`);
}

function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    ["password", "token", "access_token", "refresh_token", "key", "secret", "auth", "code"].forEach((param) => {
      if (url.searchParams.has(param)) url.searchParams.set(param, "[redacted]");
    });
    return url.toString();
  } catch {
    return String(rawUrl || "").slice(0, 2000);
  }
}

function domainFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isTrackableUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || "");
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isIpAddress(hostname) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(hostname || ""));
}

function isCrmAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || "");
    const hostname = url.hostname.toLowerCase();
    const isLocalCrm = (hostname === "localhost" || hostname === "127.0.0.1") && url.port === "5173";
    const isAssistlyCrm = hostname === "crm.assistly123.com" || hostname.endsWith(".assistly123.com");
    return (url.protocol === "http:" || url.protocol === "https:") && (isLocalCrm || isAssistlyCrm);
  } catch {
    return false;
  }
}

function inferApiBaseUrl(pageUrl, fallback = DEFAULT_SETTINGS.apiBaseUrl) {
  try {
    const url = new URL(pageUrl || "");
    const hostname = url.hostname.toLowerCase();

    if (hostname === "localhost" || hostname === "127.0.0.1" || isIpAddress(hostname)) {
      return `${url.protocol}//${hostname}:4000/api`;
    }

    if (hostname === "crm.assistly123.com" || hostname.endsWith(".assistly123.com")) {
      return "https://crm.assistly123.com/api";
    }

    return `${url.origin}/api`;
  } catch {
    return fallback;
  }
}

function categoryFromKnownLists(domain, lists) {
  return lists.find((item) => item.domains.some((pattern) => domainMatches(domain, pattern)));
}

function categorizeUrl(rawUrl, settings) {
  const normalizedUrl = redactUrl(rawUrl);
  const domain = domainFromUrl(normalizedUrl);

  if (!domain) {
    return { normalizedUrl, domain, classification: "unknown", category: "Browser/System" };
  }

  if ((settings.ignoreDomains || []).some((pattern) => domainMatches(domain, pattern))) {
    return { normalizedUrl, domain, classification: "unknown", category: "Ignored" };
  }

  if ((settings.workDomains || []).some((pattern) => domainMatches(domain, pattern))) {
    return { normalizedUrl, domain, classification: "work", category: "Work" };
  }

  const workCategory = categoryFromKnownLists(domain, WORK_CATEGORIES);
  if (workCategory) {
    return { normalizedUrl, domain, classification: "work", category: workCategory.category };
  }

  const nonWorkCategory = categoryFromKnownLists(domain, NON_WORK_CATEGORIES);
  if (nonWorkCategory) {
    return { normalizedUrl, domain, classification: "non-work", category: nonWorkCategory.category };
  }

  return { normalizedUrl, domain, classification: "unknown", category: "Uncategorized" };
}

function scrubMetadata(metadata = {}) {
  const safeMetadata = {};
  Object.entries(metadata || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string") {
      safeMetadata[key] = key.toLowerCase().includes("url") || key.toLowerCase().includes("href") ? redactUrl(value).slice(0, 2000) : value.slice(0, 500);
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      safeMetadata[key] = value;
    }
  });
  return safeMetadata;
}

async function getQueue() {
  const result = await storageGet(QUEUE_KEY);
  return Array.isArray(result[QUEUE_KEY]) ? result[QUEUE_KEY] : [];
}

async function setQueue(queue) {
  await storageSet({ [QUEUE_KEY]: queue.slice(-1000) });
}

async function getRecent() {
  const result = await storageGet(RECENT_KEY);
  return Array.isArray(result[RECENT_KEY]) ? result[RECENT_KEY] : [];
}

async function addRecent(event) {
  const recent = await getRecent();
  await storageSet({ [RECENT_KEY]: [event, ...recent].slice(0, 80) });
}

async function getCurrentVisit() {
  const result = await storageGet(CURRENT_VISIT_KEY);
  return result[CURRENT_VISIT_KEY] || null;
}

async function setCurrentVisit(visit) {
  await storageSet({ [CURRENT_VISIT_KEY]: visit });
}

async function clearCurrentVisit() {
  await storageRemove(CURRENT_VISIT_KEY);
}

function visitFromTab(tab, reason) {
  const snapshot = tabSnapshot(tab);
  if (!snapshot.tabId || !isTrackableUrl(snapshot.url)) return null;

  const startedAt = new Date();
  const normalizedUrl = redactUrl(snapshot.url);

  return {
    tabId: snapshot.tabId,
    windowId: snapshot.windowId,
    url: normalizedUrl,
    title: snapshot.title || "",
    domain: domainFromUrl(normalizedUrl),
    startedAt: startedAt.toISOString(),
    startedAtMs: startedAt.getTime(),
    lastSeenAt: startedAt.toISOString(),
    startReason: reason,
    metadata: snapshot.metadata || {}
  };
}

function isSameVisit(left, right) {
  return Boolean(left && right && left.tabId === right.tabId && left.domain && left.domain === right.domain);
}

async function endCurrentVisit(reason = "ended") {
  const visit = await getCurrentVisit();
  if (!visit) return null;

  await clearCurrentVisit();

  const endedAt = new Date();
  const startedAtMs = Number(visit.startedAtMs || new Date(visit.startedAt).getTime());
  const durationMs = Math.max(0, endedAt.getTime() - startedAtMs);

  if (durationMs < MIN_VISIT_DURATION_MS) {
    return null;
  }

  return logEvent({
    eventType: "site_visit",
    url: visit.url,
    title: visit.title || visit.domain || "Site visit",
    tabId: visit.tabId,
    windowId: visit.windowId,
    occurredAt: visit.startedAt,
    metadata: {
      startedAt: visit.startedAt,
      endedAt: endedAt.toISOString(),
      durationSeconds: Math.round(durationMs / 1000),
      durationMs,
      endReason: reason,
      startReason: visit.startReason || "",
      domain: visit.domain || "",
      lastSeenAt: visit.lastSeenAt || visit.startedAt
    }
  });
}

async function startOrUpdateVisit(tab, reason = "active_tab") {
  if (await isTrackingPaused()) {
    await clearCurrentVisit();
    return null;
  }

  const nextVisit = visitFromTab(tab, reason);

  if (!nextVisit) {
    await endCurrentVisit("non_trackable_tab");
    return null;
  }

  const currentVisit = await getCurrentVisit();
  if (isSameVisit(currentVisit, nextVisit)) {
    await setCurrentVisit({
      ...currentVisit,
      url: nextVisit.url,
      title: nextVisit.title || currentVisit.title,
      windowId: nextVisit.windowId,
      lastSeenAt: new Date().toISOString(),
      metadata: { ...(currentVisit.metadata || {}), ...(nextVisit.metadata || {}) }
    });
    return currentVisit;
  }

  await endCurrentVisit(reason);
  await setCurrentVisit(nextVisit);
  await maybeCaptureScreenshotForVisit(tab, "visit_started");
  return nextVisit;
}

async function startVisitFromActiveTab(reason = "active_tab") {
  const tab = await currentActiveTab();
  return startOrUpdateVisit(tab, reason);
}

async function logEvent(event) {
  const settings = await getSettings();
  if (!settings.trackingEnabled || !settings.employeeId || !settings.employeeCode) return null;
  if (await isTrackingPaused(settings)) return null;

  const url = redactUrl(event.url || "");
  const category = categorizeUrl(url, settings);
  if (category.category === "Ignored") return null;

  const activityEvent = {
    eventType: event.eventType || "tab_updated",
    url,
    normalizedUrl: category.normalizedUrl,
    title: String(event.title || "").slice(0, 300),
    domain: category.domain,
    classification: category.classification,
    category: category.category,
    tabId: Number.isFinite(Number(event.tabId)) ? Number(event.tabId) : null,
    windowId: Number.isFinite(Number(event.windowId)) ? Number(event.windowId) : null,
    occurredAt: event.occurredAt || new Date().toISOString(),
    metadata: scrubMetadata(event.metadata || {})
  };

  const queue = await getQueue();
  const nextQueue = [...queue, activityEvent];
  await setQueue(nextQueue);
  await addRecent(activityEvent);
  await updateBadge(settings);

  if (IMMEDIATE_FLUSH_EVENT_TYPES.has(activityEvent.eventType) || nextQueue.length >= 20) {
    await flushEvents().catch(() => undefined);
  }

  return activityEvent;
}

async function flushEvents() {
  const settings = await getSettings();
  const queue = await getQueue();
  if (!queue.length || !settings.employeeId || !settings.employeeCode || !settings.apiBaseUrl || !settings.extensionKey) {
    return { inserted: 0, queued: queue.length };
  }

  const pauseState = await refreshTrackingPauseState(settings).catch(() => getTrackingPauseState());
  if (pauseState.paused) {
    return { inserted: 0, queued: queue.length, paused: true, reason: pauseState.reason };
  }

  const batch = queue.slice(0, 100);
  const response = await fetch(`${settings.apiBaseUrl.replace(/\/$/, "")}/browser-activity/events/bulk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CRM-Extension-Key": settings.extensionKey
    },
    body: JSON.stringify({
      employeeId: settings.employeeId,
      employeeCode: settings.employeeCode,
      events: batch
    })
  });

  if (!response.ok) {
    throw new Error(`Activity sync failed: ${response.status}`);
  }

  const result = await response.json();
  if (result?.paused) {
    await setTrackingPauseState({
      paused: true,
      reason: result.reason || "",
      availabilityStatus: normalizeAvailabilityStatus(result.availabilityStatus),
      checkedAt: result.checkedAt || new Date().toISOString(),
      message: `Tracking paused: ${result.reason || result.availabilityStatus || "break"}`
    });
    await updateBadge(settings);
    return { ...result, queued: queue.length };
  }

  await setQueue(queue.slice(batch.length));
  await updateBadge(settings);
  return result;
}

async function currentActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => resolve(tabs?.[0] || null));
  });
}

function captureVisibleTab(windowId, options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, options, (dataUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(dataUrl);
    });
  });
}

async function maybeCaptureScreenshotForVisit(tab, reason = "visit_started") {
  const settings = await getSettings();
  const now = Date.now();

  if (!settings.trackingEnabled || !settings.screenshotsEnabled || !settings.employeeId || !settings.employeeCode) {
    return { captured: false, reason: "disabled" };
  }

  if (await isTrackingPaused(settings)) {
    return { captured: false, reason: "tracking-paused" };
  }

  if (now - lastScreenshotAttemptAt < SCREENSHOT_CAPTURE_COOLDOWN_MS) {
    return { captured: false, reason: "cooldown" };
  }

  if (!tab || !isTrackableUrl(tab.url)) {
    return { captured: false, reason: "no-trackable-tab" };
  }

  const category = categorizeUrl(tab.url, settings);
  if (category.category === "Ignored" || (settings.captureNonWorkOnly && category.classification !== "non-work")) {
    return { captured: false, reason: "filtered" };
  }

  lastScreenshotAttemptAt = now;
  return captureScreenshot(reason);
}

async function captureScreenshot(reason = "scheduled") {
  const settings = await getSettings();
  if (!settings.trackingEnabled || !settings.screenshotsEnabled || !settings.employeeId || !settings.employeeCode) {
    return { captured: false, reason: "disabled" };
  }

  if (await isTrackingPaused(settings)) {
    return { captured: false, reason: "tracking-paused" };
  }

  const tab = await currentActiveTab();
  if (!tab || !isTrackableUrl(tab.url)) {
    return { captured: false, reason: "no-trackable-tab" };
  }

  const category = categorizeUrl(tab.url, settings);
  if (category.category === "Ignored" || (settings.captureNonWorkOnly && category.classification !== "non-work")) {
    return { captured: false, reason: "filtered" };
  }

  const dataUrl = await captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
  const capturedAt = new Date().toISOString();
  const response = await fetch(`${settings.apiBaseUrl.replace(/\/$/, "")}/browser-activity/screenshots`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CRM-Extension-Key": settings.extensionKey
    },
    body: JSON.stringify({
      employeeId: settings.employeeId,
      employeeCode: settings.employeeCode,
      dataUrl,
      url: tab.url,
      normalizedUrl: category.normalizedUrl,
      title: tab.title || "",
      domain: category.domain,
      classification: category.classification,
      category: category.category,
      tabId: tab.id,
      windowId: tab.windowId,
      capturedAt,
      metadata: { reason }
    })
  });

  if (!response.ok) {
    throw new Error(`Screenshot upload failed: ${response.status}`);
  }

  const uploadResult = await response.json().catch(() => ({}));
  if (uploadResult?.paused) {
    await setTrackingPauseState({
      paused: true,
      reason: uploadResult.reason || "",
      availabilityStatus: normalizeAvailabilityStatus(uploadResult.availabilityStatus),
      checkedAt: uploadResult.checkedAt || new Date().toISOString(),
      message: `Tracking paused: ${uploadResult.reason || uploadResult.availabilityStatus || "break"}`
    });
    await updateBadge(settings);
    return { captured: false, reason: "tracking-paused" };
  }

  await logEvent({
    eventType: "screenshot_captured",
    url: tab.url,
    title: tab.title || "",
    tabId: tab.id,
    windowId: tab.windowId,
    occurredAt: capturedAt,
    metadata: { reason }
  });

  return { captured: true };
}

async function configureAlarms(settings = null) {
  const resolvedSettings = settings || await getSettings();
  chrome.alarms.clear(FLUSH_ALARM);
  chrome.alarms.clear(SCREENSHOT_ALARM);
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });

  if (resolvedSettings.trackingEnabled && resolvedSettings.screenshotsEnabled) {
    chrome.alarms.create(SCREENSHOT_ALARM, {
      periodInMinutes: Math.max(3, Math.min(Number(resolvedSettings.screenshotIntervalMinutes || 3), 60))
    });
  }
}

async function updateBadge(settings = null) {
  const resolvedSettings = settings || await getSettings();
  const queue = await getQueue();
  const pauseState = await getTrackingPauseState();

  if (resolvedSettings.trackingEnabled && pauseState.paused) {
    chrome.action.setBadgeText({ text: pauseState.availabilityStatus === "LUNCH" ? "LUN" : "BRK" });
    chrome.action.setBadgeBackgroundColor({ color: "#f97316" });
    return;
  }

  chrome.action.setBadgeText({ text: resolvedSettings.trackingEnabled ? (queue.length ? String(Math.min(queue.length, 99)) : "ON") : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: resolvedSettings.trackingEnabled ? "#0084ff" : "#64748b" });
}

async function loginWithEmployeeCode({ apiBaseUrl, employeeCode, extensionKey }) {
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employeeCode })
  });

  if (!response.ok) {
    throw new Error("Invalid employee code");
  }

  const auth = await response.json();
  if (auth.userType !== "employee" || !auth.user?._id) {
    throw new Error("Only employee accounts can use this tracker");
  }

  const settings = await saveSettings({
    ...(await getSettings()),
    apiBaseUrl,
    extensionKey,
    employeeCode,
    employeeId: auth.user._id,
    employeeName: auth.user.name,
    trackingEnabled: true
  });

  await logEvent({
    eventType: "manual_sync",
    url: apiBaseUrl,
    title: "Extension connected",
    metadata: { employeeName: auth.user.name }
  });
  await refreshTrackingPauseState(settings).catch(() => undefined);
  await flushEvents().catch(() => undefined);

  return settings;
}

async function autoConnectFromCrmSession({ authUser, pageUrl }) {
  if (!authUser || authUser.userType !== "employee" || !authUser.user?._id || !authUser.user?.employeeCode) {
    return { connected: false, reason: "no-employee-session" };
  }

  const currentSettings = await getSettings();
  const inferredApiBaseUrl = inferApiBaseUrl(pageUrl, currentSettings.apiBaseUrl);
  const isSavedLocalhostApi = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/api\/?$/i.test(currentSettings.apiBaseUrl || "");
  const apiBaseUrl = currentSettings.apiBaseUrl && currentSettings.apiBaseUrl !== DEFAULT_SETTINGS.apiBaseUrl && !isSavedLocalhostApi
    ? currentSettings.apiBaseUrl
    : inferredApiBaseUrl;
  const extensionKey = currentSettings.extensionKey || DEFAULT_SETTINGS.extensionKey;

  if (
    currentSettings.trackingEnabled &&
    currentSettings.employeeId === authUser.user._id &&
    currentSettings.employeeCode === authUser.user.employeeCode
  ) {
    await refreshTrackingPauseState(currentSettings).catch(() => undefined);
    return { connected: true, settings: currentSettings, alreadyConnected: true };
  }

  const settings = await saveSettings({
    ...currentSettings,
    apiBaseUrl,
    extensionKey,
    employeeId: authUser.user._id,
    employeeName: authUser.user.name || "Employee",
    employeeCode: authUser.user.employeeCode,
    trackingEnabled: true
  });

  await logEvent({
    eventType: "manual_sync",
    url: pageUrl || apiBaseUrl,
    title: "Extension auto-connected",
    metadata: { employeeName: settings.employeeName, source: "crm-session" }
  });
  await refreshTrackingPauseState(settings).catch(() => undefined);
  await flushEvents().catch(() => undefined);
  await startVisitFromActiveTab("auto_connected").catch(() => undefined);

  return { connected: true, settings };
}

function readCrmAuthUserFromPage() {
  try {
    const rawUser = window.localStorage.getItem("authUser");
    return {
      pageUrl: window.location.href,
      authUser: rawUser ? JSON.parse(rawUser) : null
    };
  } catch {
    return {
      pageUrl: window.location.href,
      authUser: null
    };
  }
}

async function tryAutoConnectFromTab(tab) {
  if (!tab?.id || !isCrmAppUrl(tab.url)) {
    return { connected: false, reason: "not-crm-tab" };
  }

  const result = await readCrmAuthFromTab(tab.id);
  return autoConnectFromCrmSession(result);
}

async function tryAutoConnectFromOpenCrmTabs() {
  const tabsById = new Map();

  for (const url of CRM_WEB_URL_PATTERNS) {
    const tabs = await queryTabs({ url });
    tabs.forEach((tab) => tabsById.set(tab.id, tab));
  }

  const tabs = Array.from(tabsById.values()).sort((left, right) => Number(right.active) - Number(left.active));

  for (const tab of tabs) {
    try {
      const result = await tryAutoConnectFromTab(tab);
      if (result.connected) return result;
    } catch {
      // Existing tabs may need a refresh before Chrome allows injection.
    }
  }

  return { connected: false, reason: "no-logged-in-crm-tab" };
}

function tabSnapshot(tab) {
  if (!tab) return {};
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || tab.pendingUrl || "",
    title: tab.title || "",
    metadata: {
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      audible: Boolean(tab.audible),
      muted: Boolean(tab.mutedInfo?.muted),
      status: tab.status || ""
    }
  };
}

chrome.runtime.onInstalled.addListener(() => {
  void configureAlarms();
  void updateBadge();
  void tryAutoConnectFromOpenCrmTabs().then(() => startVisitFromActiveTab("installed")).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void configureAlarms();
  void updateBadge();
  void tryAutoConnectFromOpenCrmTabs().then(() => startVisitFromActiveTab("startup")).catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) {
    void flushEvents().catch(() => undefined);
  }

  if (alarm.name === SCREENSHOT_ALARM) {
    void captureScreenshot("scheduled").catch(() => undefined);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  tabCache.set(tab.id, tabSnapshot(tab));
  if (tab.active) {
    void startOrUpdateVisit(tab, "tab_created").catch(() => undefined);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const snapshot = tabSnapshot(tab);
  tabCache.set(tabId, snapshot);

  if (changeInfo.status === "complete" && isCrmAppUrl(tab.url)) {
    void tryAutoConnectFromTab(tab).catch(() => undefined);
  }

  if (tab.active && (changeInfo.url || changeInfo.title || changeInfo.status === "complete")) {
    void startOrUpdateVisit(tab, changeInfo.url ? "url_changed" : "tab_updated").catch(() => undefined);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    const snapshot = tabSnapshot(tab);
    tabCache.set(activeInfo.tabId, snapshot);
    void startOrUpdateVisit(tab, "tab_activated").catch(() => undefined);
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  tabCache.delete(tabId);
  void getCurrentVisit().then((visit) => {
    if (visit?.tabId === tabId) {
      return endCurrentVisit(removeInfo.isWindowClosing ? "window_closed" : "tab_closed");
    }
    return null;
  }).catch(() => undefined);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    void endCurrentVisit("browser_unfocused").catch(() => undefined);
    return;
  }

  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    const tab = tabs?.[0];
    void startOrUpdateVisit(tab, "browser_focused").catch(() => undefined);
  });
});

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => {
  if (state === "active") {
    void startVisitFromActiveTab("idle_active").catch(() => undefined);
    return;
  }

  void endCurrentVisit(`idle_${state}`).catch(() => undefined);
  void currentActiveTab().then((tab) =>
    logEvent({
      eventType: "idle_state",
      ...tabSnapshot(tab),
      metadata: { idleState: state }
    })
  ).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (message?.type === "activity-event") {
      const event = message.event || {};
      const senderTab = sender.tab ? tabSnapshot(sender.tab) : {};
      const logged = await logEvent({
        ...senderTab,
        ...event,
        metadata: { ...(senderTab.metadata || {}), ...(event.metadata || {}) }
      });
      sendResponse({ ok: true, logged });
      return;
    }

    if (message?.type === "get-status") {
      const settings = await getSettings();
      const trackingPause = await refreshTrackingPauseState(settings).catch(() => getTrackingPauseState());
      const queue = await getQueue();
      const recent = await getRecent();
      sendResponse({ ok: true, settings, queueCount: queue.length, recent, trackingPause });
      return;
    }

    if (message?.type === "save-settings") {
      const settings = await saveSettings({ ...(await getSettings()), ...(message.settings || {}) });
      const trackingPause = await refreshTrackingPauseState(settings).catch(() => getTrackingPauseState());
      sendResponse({ ok: true, settings, trackingPause });
      return;
    }

    if (message?.type === "login") {
      sendResponse({ ok: false, message: "Manual connection is disabled. Open CRM while logged in to auto-connect." });
      return;
    }

    if (message?.type === "auto-connect-from-crm") {
      sendResponse({ ok: true, result: await autoConnectFromCrmSession(message) });
      return;
    }

    if (message?.type === "try-auto-connect") {
      sendResponse({ ok: true, result: await tryAutoConnectFromOpenCrmTabs() });
      return;
    }

    if (message?.type === "logout") {
      sendResponse({ ok: false, message: "Logout is disabled by company policy." });
      return;
    }

    if (message?.type === "flush") {
      sendResponse({ ok: true, result: await flushEvents() });
      return;
    }

    if (message?.type === "capture-screenshot") {
      sendResponse({ ok: true, result: await captureScreenshot("manual") });
      return;
    }

    sendResponse({ ok: false, message: "Unknown message" });
  })().catch((error) => sendResponse({ ok: false, message: error.message || String(error) }));

  return true;
});
