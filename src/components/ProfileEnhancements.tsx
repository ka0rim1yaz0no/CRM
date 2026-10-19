import { useEffect, useState, type ReactNode } from "react";
import { FiCopy, FiEye, FiEyeOff, FiMail, FiPhone } from "react-icons/fi";
import { maskBankNumber } from "../lib/profilePresentation";
import { emitToast } from "../lib/toast";

export function ProfileFieldGroup({ enabled, title, children }: { enabled: boolean; title: string; children: ReactNode }) {
  return enabled ? <fieldset className="profile-fieldset"><legend>{title}</legend>{children}</fieldset> : <>{children}</>;
}

export function BankAccountInput({ value, disabled, className, onChange }: { value: string; disabled: boolean; className: string; onChange: (value: string) => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(false), 15_000);
    const hide = () => { if (document.visibilityState !== "visible") setShown(false); };
    document.addEventListener("visibilitychange", hide);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", hide); };
  }, [shown]);
  return <div className="profile-bank-input"><input aria-label="Bank account number" className={className} disabled={disabled} readOnly={!shown} value={shown ? value : maskBankNumber(value)} onChange={(event) => { if (shown) onChange(event.target.value); }} inputMode="numeric" autoComplete="off" />
    <button type="button" title={shown ? "Hide bank account number" : "Show bank account number"} aria-label={shown ? "Hide bank account number" : "Show bank account number"} aria-pressed={shown} disabled={!value && disabled} onClick={() => setShown(!shown)}>{shown ? <FiEyeOff /> : <FiEye />}</button></div>;
}
export function ProfileContactActions({ value, label, edit }: { value: string; label: string; edit: () => void }) {
  const missing = !value || value === "Not provided";
  return missing ? <button type="button" className="profile-empty-action" onClick={edit}>Add your {label.toLowerCase()}</button> : <div className="profile-contact-actions">
    <button type="button" title={`Copy ${label.toLowerCase()}`} aria-label={`Copy ${label.toLowerCase()}`} onClick={async () => { try { await navigator.clipboard.writeText(value); emitToast({ tone: "success", message: `${label} copied.` }); } catch { emitToast({ tone: "error", message: "Copy is unavailable in this browser." }); } }}><FiCopy /></button>
    {label === "Email" && <a aria-label="Email contact" title="Email contact" href={`mailto:${encodeURIComponent(value)}`}><FiMail /></a>}
    {label === "Phone" && <a aria-label="Phone contact" title="Phone contact" href={`tel:${value.replace(/[^+\d]/g, "")}`}><FiPhone /></a>}
  </div>;
}
export { default as ProfileMobileNavigation } from "./WorkspaceMobileNavigation";
