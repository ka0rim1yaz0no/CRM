import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FiCheck, FiCopy, FiDownload, FiLink, FiMonitor, FiRefreshCcw, FiWifi, FiWifiOff, FiXCircle } from "react-icons/fi";
import {
    callBridgeBackendUrl,
    callBridgeBusinessId,
    callBridgePackageUrl,
    createCallBridgePairing,
    getCallBridgeStatus,
    revokeCallBridgeDevices,
    type CallBridgePairing,
} from "../../api/callBridge";
import { getAuthUser } from "../../api/authStorage";
import { getEmployeeSummary, normalizeEmployeeAvailabilityStatus } from "../../api/employees";
import { getNextAutoCallLead } from "../../api/leads";
import { getSystemSettings } from "../../api/systemSettings";
import { getStoredThemeKey, hasAppThemeOverride, setAppTheme } from "../../components/ThemeProvider";
import { isWithinAutoCallWindow } from "../../lib/employeeAutoCall";
import { defaultThemeKey, themeOptions, type ThemeKey } from "../../lib/themes";
import MainLayout from "../layout";

function availabilityLabel(status: ReturnType<typeof normalizeEmployeeAvailabilityStatus>) {
    if (status === "BREAK") return "On break";
    if (status === "LUNCH") return "At lunch";
    if (status === "OFF THE PHONE") return "Off the phone";
    if (status === "OFFLINE") return "Offline";
    return "Online";
}

export default function Settings() {
    const authUser = getAuthUser();
    const employee = authUser?.userType === "employee" ? authUser.user : null;
    const isSalesEmployee = String(employee?.role || "").toLowerCase().includes("sales");
    const [activeThemeKey, setActiveThemeKey] = useState<ThemeKey>(() => getStoredThemeKey());
    const [isPersonalTheme, setIsPersonalTheme] = useState(() => hasAppThemeOverride());
    const [pairing, setPairing] = useState<CallBridgePairing | null>(null);
    const [bridgeActionMessage, setBridgeActionMessage] = useState("");
    const [bridgeActionPending, setBridgeActionPending] = useState(false);
    const [autoCallNow, setAutoCallNow] = useState(() => new Date());
    const pairingDetailsRef = useRef<HTMLDivElement | null>(null);
    const { data: systemSettings, isLoading: systemSettingsLoading } = useQuery({
        queryKey: ["system-settings"],
        queryFn: getSystemSettings,
    });
    const {
        data: bridgeStatus,
        isLoading: bridgeStatusLoading,
        refetch: refetchBridgeStatus,
    } = useQuery({
        queryKey: ["call-bridge-status", employee?.employeeCode],
        queryFn: () => getCallBridgeStatus(employee?.employeeCode || ""),
        enabled: Boolean(isSalesEmployee && employee?.employeeCode),
        refetchInterval: 5_000,
    });
    const {
        data: currentEmployee,
        isLoading: currentEmployeeLoading,
    } = useQuery({
        queryKey: ["auto-call-employee", employee?._id],
        queryFn: () => getEmployeeSummary(employee?._id || ""),
        enabled: Boolean(isSalesEmployee && employee?._id),
        refetchInterval: 5_000,
    });
    const employeeNames = useMemo(
        () =>
            Array.from(
                new Set(
                    [
                        currentEmployee?.name || employee?.name,
                        currentEmployee?.employeeCode || employee?.employeeCode,
                        ...(currentEmployee?.aliases || employee?.aliases || []),
                    ].filter((value): value is string => Boolean(value))
                )
            ),
        [currentEmployee, employee]
    );
    const availabilityStatus = normalizeEmployeeAvailabilityStatus(currentEmployee?.availabilityStatus);
    const withinAutoCallWindow = isWithinAutoCallWindow(autoCallNow);
    const canCheckAutoCallLeads = Boolean(
        currentEmployee?._id &&
        availabilityStatus === "ONLINE" &&
        withinAutoCallWindow &&
        bridgeStatus?.connected &&
        bridgeStatus.nextivaProcessDetected &&
        bridgeStatus.state !== "active" &&
        bridgeStatus.state !== "calling"
    );
    const {
        data: nextAutoCallLead,
        isLoading: autoCallLeadLoading,
        isError: autoCallLeadError,
    } = useQuery({
        queryKey: ["auto-call-next-lead", currentEmployee?._id, employeeNames.join("|")],
        queryFn: () =>
            getNextAutoCallLead({
                employeeId: currentEmployee?._id || "",
                employeeNames,
            }),
        enabled: canCheckAutoCallLeads,
        refetchInterval: 5_000,
    });
    const companyThemeKey = systemSettings?.themeKey || defaultThemeKey;
    const activeTheme = useMemo(
        () => themeOptions.find((theme) => theme.key === activeThemeKey) || themeOptions[0],
        [activeThemeKey]
    );
    const companyTheme = useMemo(
        () => themeOptions.find((theme) => theme.key === companyThemeKey) || themeOptions[0],
        [companyThemeKey]
    );

    useEffect(() => {
        if (!isPersonalTheme) {
            setActiveThemeKey(companyThemeKey);
        }
    }, [companyThemeKey, isPersonalTheme]);

    useEffect(() => {
        if (!pairing) return;

        pairingDetailsRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, [pairing]);

    useEffect(() => {
        const intervalId = window.setInterval(() => setAutoCallNow(new Date()), 5_000);
        return () => window.clearInterval(intervalId);
    }, []);

    const chooseTheme = (themeKey: ThemeKey) => {
        setAppTheme(themeKey, { userOverride: true });
        setActiveThemeKey(themeKey);
        setIsPersonalTheme(true);
    };

    const useCompanyTheme = () => {
        setAppTheme(companyThemeKey, { userOverride: false });
        setActiveThemeKey(companyThemeKey);
        setIsPersonalTheme(false);
    };

    const generatePairingCode = async () => {
        if (!employee?._id) return;

        setBridgeActionPending(true);
        setBridgeActionMessage("");

        try {
            const result = await createCallBridgePairing(employee._id);
            setPairing(result);
            setBridgeActionMessage(
                result.accountSwitchingEnabled
                    ? "Pairing code created. This computer will follow the latest sales login after installation."
                    : "Pairing code created. Automatic account switching is unavailable in this browser."
            );
        } catch (error) {
            const endpointMessage = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
            setBridgeActionMessage(
                typeof endpointMessage === "string" ? endpointMessage : "Unable to create a pairing code."
            );
        } finally {
            setBridgeActionPending(false);
        }
    };

    const disconnectBridge = async () => {
        if (!employee?.employeeCode) return;

        setBridgeActionPending(true);
        setBridgeActionMessage("");

        try {
            const result = await revokeCallBridgeDevices(employee.employeeCode);
            setPairing(null);
            setBridgeActionMessage(result.message);
            await refetchBridgeStatus();
        } catch {
            setBridgeActionMessage("Unable to disconnect Call Bridge.");
        } finally {
            setBridgeActionPending(false);
        }
    };

    const copyValue = async (value: string) => {
        await navigator.clipboard.writeText(value);
        setBridgeActionMessage("Copied.");
    };

    const bridgeStatusLabel = bridgeStatusLoading
        ? "Checking"
        : bridgeStatus?.state === "active"
            ? "Active call"
            : bridgeStatus?.state === "calling"
                ? "Calling"
                : bridgeStatus?.connected
                    ? bridgeStatus.nextivaProcessDetected
                        ? "Connected"
                        : "Nextiva closed"
                    : "Not connected";
    const bridgeStatusTone = bridgeStatus?.state === "active"
        ? "border-rose-400/30 bg-rose-400/10 text-rose-100"
        : bridgeStatus?.connected && bridgeStatus.nextivaProcessDetected
            ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
            : "border-white/10 bg-white/[0.04] text-white/60";
    const autoCallDisplay = (() => {
        if (bridgeStatusLoading || currentEmployeeLoading) {
            return { label: "Checking", detail: "Checking auto-call requirements.", ready: false };
        }

        if (!bridgeStatus?.connected) {
            return { label: "Not connected", detail: "Pair this computer with Call Bridge.", ready: false };
        }

        if (!bridgeStatus.nextivaProcessDetected) {
            return { label: "Nextiva closed", detail: "Open Nextiva on this computer.", ready: false };
        }

        if (bridgeStatus.state === "active") {
            return { label: "On a call", detail: "Auto call will wait for the current call to finish.", ready: false };
        }

        if (bridgeStatus.state === "calling") {
            return { label: "Starting call", detail: "A Nextiva call is being opened.", ready: false };
        }

        if (availabilityStatus !== "ONLINE") {
            return {
                label: availabilityLabel(availabilityStatus),
                detail: "Attendance status must be ONLINE for auto call.",
                ready: false,
            };
        }

        if (!withinAutoCallWindow) {
            return { label: "Outside calling hours", detail: "Auto call runs from 11 PM to 8 AM PH time.", ready: false };
        }

        if (!bridgeStatus.ready) {
            return { label: "Waiting", detail: bridgeStatus.reason, ready: false };
        }

        if (autoCallLeadLoading) {
            return { label: "Checking leads", detail: "Finding the next callable lead.", ready: false };
        }

        if (autoCallLeadError) {
            return { label: "Lead check failed", detail: "Unable to verify the next callable lead.", ready: false };
        }

        if (!nextAutoCallLead) {
            return { label: "No leads available", detail: "No callable New or Follow up leads are available.", ready: false };
        }

        return nextAutoCallLead.queue === "NEW"
            ? { label: "Ready: New lead", detail: "The next New lead can be called.", ready: true }
            : { label: "Ready: Follow up", detail: "No New leads remain; the next Follow up can be called.", ready: true };
    })();
    const autoCallStatusTone = autoCallDisplay.ready
        ? "border-emerald-400/30 bg-emerald-400/10"
        : bridgeStatus?.state === "active" || bridgeStatus?.state === "calling"
            ? "border-amber-400/30 bg-amber-400/10"
            : "border-white/10 bg-white/[0.04]";

    return (
        <MainLayout>
            <div className="space-y-4">
            <section className="rounded-lg border border-white/10 bg-[#090b13]/80">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
                    <div>
                        <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Preferences</p>
                        <h2 className="mt-1 text-xl font-semibold text-white">Settings</h2>
                        <p className="mt-1 text-sm text-white/45">Choose a workspace theme for your employee account.</p>
                    </div>
                    <button
                        className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-sm font-semibold text-white/65 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                        type="button"
                        disabled={!isPersonalTheme || systemSettingsLoading}
                        onClick={useCompanyTheme}
                    >
                        <FiRefreshCcw className="size-4" aria-hidden="true" />
                        Company Theme
                    </button>
                </div>

                <div className="grid gap-3 p-5 md:grid-cols-3">
                    {[
                        ["Active Theme", activeTheme.name],
                        ["Preference", isPersonalTheme ? "Personal" : "Company default"],
                        ["Company Default", companyTheme.name],
                    ].map(([label, value]) => (
                        <div key={label} className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{label}</p>
                            <p className="mt-2 text-sm font-semibold text-white">{value}</p>
                        </div>
                    ))}
                </div>

                <div className="px-5 pb-5">
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {themeOptions.map((theme) => {
                            const isActive = activeThemeKey === theme.key;
                            const isCompanyDefault = companyThemeKey === theme.key;
                            const isLightTheme = theme.key.startsWith("light-") || theme.key.startsWith("mail-");

                            return (
                                <button
                                    key={theme.key}
                                    className={[
                                        "group rounded-lg border p-4 text-left transition",
                                        isActive
                                            ? "theme-primary-border theme-primary-soft-bg text-white shadow-xl shadow-black/15"
                                            : "border-white/10 bg-white/[0.035] text-white/70 hover:border-white/20 hover:bg-white/[0.06] hover:text-white",
                                    ].join(" ")}
                                    type="button"
                                    aria-pressed={isActive}
                                    onClick={() => chooseTheme(theme.key)}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm font-semibold text-white">{theme.name}</span>
                                            <span className="mt-1 block line-clamp-2 text-xs leading-5 text-white/45">{theme.description}</span>
                                        </span>
                                        <span
                                            className={[
                                                "flex size-8 shrink-0 items-center justify-center rounded-lg border",
                                                isActive ? "border-white/20 bg-white text-[var(--primary-dark)]" : "border-white/10 bg-black/20 text-white/35",
                                            ].join(" ")}
                                        >
                                            {isActive ? <FiCheck className="size-4" aria-hidden="true" /> : <FiMonitor className="size-4" aria-hidden="true" />}
                                        </span>
                                    </div>
                                    <div className="mt-4 flex items-center gap-1.5">
                                        {[theme.colors.primary, theme.colors.secondary, theme.colors.app, theme.colors.panel].map((color) => (
                                            <span key={color} className="size-6 rounded-md border border-white/10" style={{ backgroundColor: color }} />
                                        ))}
                                    </div>
                                    <div className="mt-4 flex flex-wrap gap-2">
                                        <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs font-semibold text-white/55">
                                            {isLightTheme ? "Light" : "Dark"}
                                        </span>
                                        {isCompanyDefault && (
                                            <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs font-semibold text-white/55">
                                                Company
                                            </span>
                                        )}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </section>
            {isSalesEmployee && (
                <section className="rounded-lg border border-white/10 bg-[#090b13]/80">
                    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
                        <div>
                            <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/35">Calling</p>
                            <h2 className="mt-1 text-lg font-semibold text-white">Nextiva Call Bridge</h2>
                            <p className="mt-1 text-sm text-white/45">{bridgeStatus?.reason || "Pair once, then Call Bridge follows the latest sales login on this computer."}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <a
                                className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-sm font-semibold text-white/70 transition hover:bg-white/[0.08] hover:text-white"
                                href={callBridgePackageUrl}
                            >
                                <FiDownload className="size-4" aria-hidden="true" />
                                Download
                            </a>
                            <button
                                className="theme-primary-bg inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-45"
                                type="button"
                                disabled={bridgeActionPending}
                                onClick={generatePairingCode}
                            >
                                <FiLink className="size-4" aria-hidden="true" />
                                {bridgeActionPending ? "Creating..." : "Pair Computer"}
                            </button>
                            {bridgeStatus?.connected && (
                                <button
                                    className="inline-flex size-10 items-center justify-center rounded-lg border border-rose-400/20 bg-rose-400/10 text-rose-200 transition hover:bg-rose-400/15 disabled:cursor-not-allowed disabled:opacity-45"
                                    type="button"
                                    title="Disconnect Call Bridge"
                                    aria-label="Disconnect Call Bridge"
                                    disabled={bridgeActionPending}
                                    onClick={disconnectBridge}
                                >
                                    <FiXCircle className="size-4" aria-hidden="true" />
                                </button>
                            )}
                        </div>
                    </div>

                    {pairing && (
                        <div ref={pairingDetailsRef} className="border-b border-white/10 px-5 py-5">
                            <div className="grid gap-3 md:grid-cols-3">
                                {[
                                    ["CRM URL", callBridgeBackendUrl],
                                    ["Business ID", pairing.businessId || callBridgeBusinessId()],
                                    ["Pairing Code", pairing.pairingCode],
                                ].map(([label, value]) => (
                                    <div key={label} className="flex min-w-0 items-center gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{label}</p>
                                            <p className="mt-1 truncate font-mono text-sm font-semibold text-white">{value}</p>
                                        </div>
                                        <button
                                            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/55 transition hover:bg-white/[0.08] hover:text-white"
                                            type="button"
                                            title={`Copy ${label}`}
                                            aria-label={`Copy ${label}`}
                                            onClick={() => void copyValue(value)}
                                        >
                                            <FiCopy className="size-4" aria-hidden="true" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="grid gap-3 p-5 md:grid-cols-3">
                        <div className={["rounded-lg border p-4", bridgeStatusTone].join(" ")}>
                            <div className="flex items-center gap-2">
                                {bridgeStatus?.connected ? <FiWifi className="size-4" aria-hidden="true" /> : <FiWifiOff className="size-4" aria-hidden="true" />}
                                <p className="text-xs font-medium uppercase tracking-[0.14em] opacity-70">Bridge Status</p>
                            </div>
                            <p className="mt-2 text-sm font-semibold">{bridgeStatusLabel}</p>
                        </div>
                        <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Computer</p>
                            <p className="mt-2 truncate text-sm font-semibold text-white">{bridgeStatus?.deviceName || "Not paired"}</p>
                        </div>
                        <div className={["rounded-lg border p-4", autoCallStatusTone].join(" ")}>
                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Auto Call</p>
                            <p className="mt-2 text-sm font-semibold text-white">{autoCallDisplay.label}</p>
                            <p className="mt-1 text-xs leading-5 text-white/45">{autoCallDisplay.detail}</p>
                        </div>
                    </div>

                    {bridgeActionMessage && (
                        <p className="border-t border-white/10 px-5 py-3 text-sm text-white/55" aria-live="polite">
                            {bridgeActionMessage}
                        </p>
                    )}
                </section>
            )}
            </div>
        </MainLayout>
    );
}
