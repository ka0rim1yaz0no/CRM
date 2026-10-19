import { useEffect, useRef } from "react";
import { gsap } from "gsap";
export default function MetricValue({ value }: { value?: number }) {
  const node = useRef<HTMLSpanElement>(null); const first = useRef(true);
  useEffect(() => {
    if (value === undefined || !node.current) return;
    if (!first.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { node.current.textContent = value.toLocaleString(); first.current = false; return; }
    first.current = false;
    const state = { number: 0 }; const tween = gsap.to(state, { number: value, duration: .5, ease: "power1.out", onUpdate: () => { if (node.current) node.current.textContent = Math.round(state.number).toLocaleString(); } });
    return () => { tween.kill(); };
  }, [value]);
  return <span ref={node} aria-label={value === undefined ? "Loading" : String(value)} className={value === undefined ? "metric-value-skeleton" : ""}>{value === undefined ? "..." : value.toLocaleString()}</span>;
}
