import { useEffect, useRef, useState, type ReactNode } from "react";

export default function DeferredDashboardSection({ children }: { children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    if (element.current) observer.observe(element.current);
    const print = () => setVisible(true);
    window.addEventListener("beforeprint", print);
    return () => { observer.disconnect(); window.removeEventListener("beforeprint", print); };
  }, []);
  return <div ref={element} className="dw-deferred">{visible ? children : <p role="status">Loading insights...</p>}</div>;
}
