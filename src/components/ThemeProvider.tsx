import { useEffect, type ReactNode } from "react";
import { getStoredThemeKey, hasAppThemeOverride, setAppTheme } from "../lib/appTheme";
import { getActiveBusinessId } from "../api/businessStorage";
import { getAuthUser } from "../api/authStorage";

export function ThemeProvider({ children }: { children: ReactNode }) {
    useEffect(() => {
        setAppTheme(getStoredThemeKey());

        let generation = 0;
        const refresh = () => {
            const request = ++generation;
            setAppTheme(getStoredThemeKey());
            const auth = getAuthUser();
            if (!auth || auth.userType === "admin") return;
            const business = getActiveBusinessId();
            void import("../api/systemSettings")
                .then(({ getSystemSettings }) => request === generation && getAuthUser()?.attendanceHubSession === auth.attendanceHubSession ? getSystemSettings() : null)
                .then((settings) => {
                    if (settings && request === generation && business === getActiveBusinessId() && !hasAppThemeOverride()) {
                        setAppTheme(settings.themeKey, { userOverride: false });
                    }
                })
                .catch(() => undefined);
        };
        refresh();
        const storageChanged = (event: StorageEvent) => {
            if (!event.key || ["authUser", "crmThemeKey", "crmThemeUserOverride", "activeBusinessId"].includes(event.key)) refresh();
        };
        window.addEventListener("crm:business-changed", refresh);
        window.addEventListener("crm:auth-changed", refresh);
        window.addEventListener("storage", storageChanged);
        return () => {
            generation++; window.removeEventListener("crm:business-changed", refresh);
            window.removeEventListener("crm:auth-changed", refresh); window.removeEventListener("storage", storageChanged);
        };
    }, []);

    return children;
}
