const ACTIVITY_THROTTLE_MS = 60_000;
const REPEAT_WINDOW_MS = 60_000;
const REPEAT_LIMIT = 25;
const PASSIVE_EVENT_TYPES = new Set(["keyboard_activity", "mouse_activity", "scroll"]);
const lastSentAt = new Map();
let repeatedAction = { signature: "", firstAt: 0, count: 0 };
let autoConnectAttempts = 0;
let autoConnectTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, location.href);
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

function visibleText(value, maxLength = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isCrmAppPage() {
  const hostname = location.hostname.toLowerCase();
  const isLocalCrm = (hostname === "localhost" || hostname === "127.0.0.1") && location.port === "5173";
  const isAssistlyCrm = hostname === "crm.assistly123.com" || hostname.endsWith(".assistly123.com");
  return isLocalCrm || isAssistlyCrm;
}

function readCrmAuthUser() {
  try {
    const rawUser = window.localStorage.getItem("authUser");
    return rawUser ? JSON.parse(rawUser) : null;
  } catch {
    return null;
  }
}

function requestAutoConnect() {
  if (!isCrmAppPage()) return;
  const authUser = readCrmAuthUser();
  if (!authUser || authUser.userType !== "employee" || !authUser.user?._id || !authUser.user?.employeeCode) return;

  sendAutoConnect(authUser, location.href);
}

function sendAutoConnect(authUser, pageUrl) {
  chrome.runtime.sendMessage({
    type: "auto-connect-from-crm",
    pageUrl,
    authUser,
  }).then((response) => {
    if (response?.ok && response.result?.connected) {
      window.clearInterval(autoConnectTimer);
      autoConnectTimer = null;
    }
  }).catch(() => undefined);
}

function repeatedMetadata(signature) {
  const now = Date.now();
  if (repeatedAction.signature === signature && now - repeatedAction.firstAt <= REPEAT_WINDOW_MS) {
    repeatedAction.count += 1;
  } else {
    repeatedAction = { signature, firstAt: now, count: 1 };
  }

  return {
    repeatedPattern: repeatedAction.count > REPEAT_LIMIT,
    repeatCount: repeatedAction.count,
  };
}

function sendActivity(eventType, metadata = {}, options = {}) {
  if (PASSIVE_EVENT_TYPES.has(eventType)) return;
  if (document.visibilityState !== "visible") return;

  const now = Date.now();
  const throttleKey = options.throttleKey || eventType;
  if (options.throttle && now - (lastSentAt.get(throttleKey) || 0) < options.throttle) {
    return;
  }

  lastSentAt.set(throttleKey, now);
  chrome.runtime.sendMessage({
    type: "activity-event",
    event: {
      eventType,
      url: location.href,
      title: document.title,
      occurredAt: nowIso(),
      metadata,
    },
  }).catch(() => undefined);
}

document.addEventListener(
  "click",
  (event) => {
    if (!event.isTrusted) return;

    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest("a[href]");
    const button = target?.closest("button, [role='button']");

    if (link) {
      const href = link.getAttribute("href") || "";
      const metadata = {
        href: redactUrl(href),
        linkText: visibleText(link.textContent),
        target: link.getAttribute("target") || "",
        ...repeatedMetadata(`link:${redactUrl(href)}`),
      };
      sendActivity("link_clicked", metadata);
      return;
    }

    if (button) {
      sendActivity(
        "mouse_activity",
        {
          action: "button_clicked",
          elementText: visibleText(button.textContent),
          elementRole: button.getAttribute("role") || button.tagName.toLowerCase(),
          ...repeatedMetadata(`button:${visibleText(button.textContent)}`),
        },
        { throttle: 5_000, throttleKey: "button_click" }
      );
    }
  },
  true
);

document.addEventListener(
  "submit",
  (event) => {
    if (!event.isTrusted) return;
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    sendActivity("form_submitted", {
      formAction: redactUrl(form?.action || location.href),
      formMethod: String(form?.method || "get").toUpperCase(),
      formId: visibleText(form?.id || form?.name || ""),
      fieldCount: form ? form.elements.length : 0,
      ...repeatedMetadata(`form:${form?.action || location.href}`),
    });
  },
  true
);

document.addEventListener(
  "keydown",
  (event) => {
    if (!event.isTrusted || event.repeat) return;

    const target = event.target instanceof HTMLElement ? event.target : null;
    const tagName = target?.tagName.toLowerCase() || "";
    const inputType = target instanceof HTMLInputElement ? target.type : "";

    sendActivity(
      "keyboard_activity",
      {
        action: "key_pressed",
        targetTag: tagName,
        inputType,
        isEditable: Boolean(target?.isContentEditable || tagName === "textarea" || tagName === "input"),
        ...repeatedMetadata(`key:${event.code}:${tagName}:${inputType}`),
      },
      { throttle: ACTIVITY_THROTTLE_MS, throttleKey: "keyboard_activity" }
    );
  },
  true
);

document.addEventListener(
  "mousemove",
  (event) => {
    if (!event.isTrusted) return;
    sendActivity(
      "mouse_activity",
      {
        action: "mouse_moved",
        xBucket: Math.round(event.clientX / 100),
        yBucket: Math.round(event.clientY / 100),
      },
      { throttle: ACTIVITY_THROTTLE_MS, throttleKey: "mouse_activity" }
    );
  },
  { passive: true }
);

document.addEventListener(
  "scroll",
  (event) => {
    if (!event.isTrusted) return;
    sendActivity(
      "scroll",
      {
        scrollYBucket: Math.round(window.scrollY / 500),
        scrollXBucket: Math.round(window.scrollX / 500),
        ...repeatedMetadata(`scroll:${Math.round(window.scrollY / 500)}`),
      },
      { throttle: ACTIVITY_THROTTLE_MS, throttleKey: "scroll" }
    );
  },
  { passive: true }
);

["copy", "paste"].forEach((eventType) => {
  document.addEventListener(
    eventType,
    (event) => {
      if (!event.isTrusted) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      sendActivity(eventType, {
        targetTag: target?.tagName.toLowerCase() || "",
        isEditable: Boolean(target?.isContentEditable || target?.tagName === "TEXTAREA" || target?.tagName === "INPUT"),
      });
    },
    true
  );
});

if (isCrmAppPage()) {
  requestAutoConnect();
  autoConnectTimer = window.setInterval(() => {
    autoConnectAttempts += 1;
    requestAutoConnect();

    if (autoConnectAttempts >= 24) {
      window.clearInterval(autoConnectTimer);
      autoConnectTimer = null;
    }
  }, 5_000);
  window.addEventListener("storage", (event) => {
    if (event.key === "authUser") {
      requestAutoConnect();
    }
  });
  window.addEventListener("focus", () => {
    requestAutoConnect();
  });
}
