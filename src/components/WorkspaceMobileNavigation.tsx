import { useEffect, useRef, useState } from "react";
import { FiMenu } from "react-icons/fi";
import "./WorkspaceMobileNavigation.css";

export default function WorkspaceMobileNavigation() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const root = button.current?.closest(".theme-app-bg"); if (!root) return;
    root.classList.toggle("workspace-nav-open", open);
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } };
    window.addEventListener("keydown", close);
    return () => { root.classList.remove("workspace-nav-open"); window.removeEventListener("keydown", close); };
  }, [open]);
  return <><button ref={button} data-mobile-navigation type="button" className="workspace-mobile-menu" aria-label={open ? "Close navigation" : "Open navigation"} aria-expanded={open} onClick={() => setOpen(!open)}><FiMenu /></button>{open && <button type="button" className="workspace-nav-backdrop" aria-label="Close navigation" onClick={() => setOpen(false)} />}</>;
}
