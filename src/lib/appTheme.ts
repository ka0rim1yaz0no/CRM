import { defaultThemeKey, getTheme, isThemeKey, type ThemeKey } from "./themes";

const storedThemeKey = "crmThemeKey";
const storedThemeOverrideKey = "crmThemeUserOverride";

function applyTheme(themeKey: ThemeKey) {
    const theme = getTheme(themeKey);
    const root = document.documentElement;

    root.dataset.theme = theme.key;
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
    const cachedThemeKey = localStorage.getItem(storedThemeKey);
    return cachedThemeKey && isThemeKey(cachedThemeKey) ? cachedThemeKey : defaultThemeKey;
}

export function hasAppThemeOverride() {
    return localStorage.getItem(storedThemeOverrideKey) === "true";
}

export function setAppTheme(themeKey: string, options: SetAppThemeOptions = {}) {
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
