import { useEffect, type ReactNode } from "react";
import { getStoredThemeKey, hasAppThemeOverride, setAppTheme } from "../lib/appTheme";
import { getActiveBusinessId } from "../api/businessStorage";

export function ThemeProvider({ children }: { children: ReactNode }) {
    useEffect(() => {
        setAppTheme(getStoredThemeKey());

        let generation = 0;
        const refresh = () => {
            const request = ++generation;
            const business = getActiveBusinessId();
            void import("../api/systemSettings")
                .then(({ getSystemSettings }) => getSystemSettings())
                .then((settings) => {
                    if (request === generation && business === getActiveBusinessId() && !hasAppThemeOverride()) {
                        setAppTheme(settings.themeKey, { userOverride: false });
                    }
                })
                .catch(() => undefined);
        };
        refresh();
        window.addEventListener("crm:business-changed", refresh);
        return () => { generation++; window.removeEventListener("crm:business-changed", refresh); };
    }, []);

    return children;
}
