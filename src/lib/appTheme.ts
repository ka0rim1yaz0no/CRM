import { defaultThemeKey, getTheme, isThemeKey, type ThemeKey } from "./themes";
import { getAuthUser } from "../api/authStorage";

const storedThemeKey = "crmThemeKey";
const storedThemeOverrideKey = "crmThemeUserOverride";
export const adminThemeKey: ThemeKey = "light-command";

function applyTheme(themeKey: ThemeKey) {
    const theme = getTheme(themeKey);
    const root = document.documentElement;

    root.dataset.theme = theme.key;
    root.style.setProperty("color-scheme", theme.key.startsWith("light-") || theme.key.startsWith("mail-") ? "light" : "dark");
    root.style.setProperty("--app-bg", theme.colors.app);
    root.style.setProperty("--shell-bg", theme.colors.shell);
    root.style.setProperty("--surface-bg", theme.colors.surface);
    root.style.setProperty("--panel-bg", theme.colors.panel);
    root.style.setProperty("--modal-bg", theme.colors.modal);
    root.style.setProperty("--primary", theme.colors.primary);
    root.style.setProperty("--primary-dark", theme.colors.primaryDark);
    root.style.setProperty("--primary-soft", theme.colors.primarySoft);
    root.style.setProperty("--primary-text", theme.colors.primaryText);
    root.style.setProperty("--secondary", theme.colors.secondary);
}

type SetAppThemeOptions = {
    userOverride?: boolean;
};

export function getStoredThemeKey() {
    if (getAuthUser()?.userType === "admin") return adminThemeKey;
    const cachedThemeKey = localStorage.getItem(storedThemeKey);
    return cachedThemeKey && isThemeKey(cachedThemeKey) ? cachedThemeKey : defaultThemeKey;
}

export function hasAppThemeOverride() {
    return localStorage.getItem(storedThemeOverrideKey) === "true";
}

export function setAppTheme(themeKey: string, options: SetAppThemeOptions = {}) {
    const role = getAuthUser()?.userType;
    document.documentElement.dataset.themeRole = role || "guest";
    // Admin appearance is shared application policy, not a tenant or browser preference.
    if (role === "admin") { applyTheme(adminThemeKey); return; }
    const safeThemeKey = isThemeKey(themeKey) ? themeKey : defaultThemeKey;
    localStorage.setItem(storedThemeKey, safeThemeKey);

    if (options.userOverride === true) {
        localStorage.setItem(storedThemeOverrideKey, "true");
    }

    if (options.userOverride === false) {
        localStorage.removeItem(storedThemeOverrideKey);
    }

    applyTheme(safeThemeKey);
}
