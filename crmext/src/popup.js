const elements = {
  statusPill: document.querySelector("#statusPill"),
  employeeName: document.querySelector("#employeeName"),
  connectionStatus: document.querySelector("#connectionStatus"),
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  trackingEnabled: document.querySelector("#trackingEnabled"),
  screenshotsEnabled: document.querySelector("#screenshotsEnabled"),
  captureNonWorkOnly: document.querySelector("#captureNonWorkOnly"),
  screenshotIntervalMinutes: document.querySelector("#screenshotIntervalMinutes"),
  workDomains: document.querySelector("#workDomains"),
  ignoreDomains: document.querySelector("#ignoreDomains"),
  queueCount: document.querySelector("#queueCount"),
  recentList: document.querySelector("#recentList"),
  lastUpdated: document.querySelector("#lastUpdated"),
  message: document.querySelector("#message"),
};

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function setMessage(value, isError = false) {
  elements.message.textContent = value || "";
  elements.message.style.color = isError ? "#b91c1c" : "#475569";
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatList(value) {
  return Array.isArray(value) && value.length ? value.join(", ") : "-";
}

function renderRecent(recent) {
  elements.recentList.innerHTML = "";
  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "recent-item";
    empty.innerHTML = "<span>No recent browser activity yet.</span>";
    elements.recentList.append(empty);
    return;
  }

  recent.slice(0, 12).forEach((event) => {
    const item = document.createElement("article");
    item.className = "recent-item";
    const classification = String(event.classification || "unknown");
    item.innerHTML = `
      <strong>${event.eventType || "activity"} · ${event.category || "Unknown"}</strong>
      <span>${event.domain || "browser"} · ${formatTime(event.occurredAt)}</span>
      <span>${event.title || event.normalizedUrl || event.url || ""}</span>
      <span class="classification ${classification}">${classification}</span>
    `;
    elements.recentList.append(item);
  });
}

function applySettings(settings, queueCount = 0, recent = [], trackingPause = {}) {
  const connected = Boolean(settings.employeeId);
  const paused = Boolean(trackingPause.paused);
  elements.statusPill.textContent = paused ? "Paused" : connected ? "Tracking" : "Auto";
  elements.statusPill.className = `pill ${paused ? "paused" : connected ? "on" : "auto"}`;
  elements.employeeName.textContent = settings.employeeName || "Waiting for CRM login";
  elements.connectionStatus.textContent = paused ? trackingPause.reason || trackingPause.availabilityStatus || "Break" : connected ? "Connected automatically" : "Open CRM while logged in";
  elements.apiBaseUrl.textContent = settings.apiBaseUrl || "-";
  elements.trackingEnabled.textContent = paused ? "Paused" : "Locked on";
  elements.screenshotsEnabled.textContent = paused ? "Paused" : "Locked on";
  elements.captureNonWorkOnly.textContent = settings.captureNonWorkOnly ? "Non-work only" : "All sites";
  elements.screenshotIntervalMinutes.textContent = `${settings.screenshotIntervalMinutes || 3} min`;
  elements.workDomains.textContent = formatList(settings.workDomains);
  elements.ignoreDomains.textContent = formatList(settings.ignoreDomains);
  elements.queueCount.textContent = String(queueCount);
  elements.lastUpdated.textContent = formatTime(new Date().toISOString());
  renderRecent(recent);
}

async function refresh(options = {}) {
  const response = await sendMessage({ type: "get-status" });
  if (!response?.ok) throw new Error(response?.message || "Unable to load extension status");

  if (options.tryAutoConnect !== false && !response.settings?.employeeId) {
    const autoResponse = await sendMessage({ type: "try-auto-connect" });
    if (autoResponse?.ok && autoResponse.result?.connected) {
      return refresh({ tryAutoConnect: false });
    }
  }

  applySettings(response.settings, response.queueCount, response.recent || [], response.trackingPause || {});

  if (!response.settings?.employeeId) {
    setMessage("Open or refresh the CRM while logged in. The extension will connect automatically.");
    return;
  }

  if (response.trackingPause?.paused) {
    setMessage(`Tracking and screenshots are paused during ${response.trackingPause.reason || response.trackingPause.availabilityStatus || "break"}.`);
    return;
  }

  setMessage("Managed tracking is active.");
}

refresh().catch((error) => setMessage(error.message || String(error), true));
window.setInterval(() => {
  refresh({ tryAutoConnect: true }).catch(() => undefined);
}, 15000);
