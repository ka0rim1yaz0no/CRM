import { useEffect, useRef } from 'react';

/** A decorative follower; native hit targets and text cursors remain intact. */
export default function PremiumCursor({ reducedMotion }: { reducedMotion: boolean }) {
  const ring = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ring.current;
    if (!element || reducedMotion) return;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const layers = Array.from(element.querySelectorAll<HTMLElement>('span'));
    const points = layers.map(() => ({ x: 0, y: 0 }));
    let frame = 0, targetX = 0, targetY = 0, active = false;
    function hide() {
      active = false; element!.dataset.visible = 'false';
      cancelAnimationFrame(frame); frame = 0;
    }
    function animate() {
      let moving = false;
      layers.forEach((layer, i) => {
        const p = points[i], follow = [.34, .24, .16][i];
        p.x += (targetX - p.x) * follow; p.y += (targetY - p.y) * follow;
        layer.style.transform = `translate3d(${p.x}px,${p.y}px,0)`;
        moving ||= Math.abs(targetX - p.x) + Math.abs(targetY - p.y) > .15;
      });
      frame = active && moving ? requestAnimationFrame(animate) : 0;
    }
    function move(event: PointerEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (!fine.matches || event.pointerType !== 'mouse' || !target?.closest('.assistly-entrance') || target.closest('input,textarea,[contenteditable="true"]')) { hide(); return; }
      targetX = event.clientX; targetY = event.clientY;
      if (!active) points.forEach(p => { p.x = targetX; p.y = targetY; });
      active = true; element!.dataset.visible = 'true';
      element!.dataset.interactive = String(Boolean(target.closest('button,a,select')));
      if (!frame) frame = requestAnimationFrame(animate);
    }
    window.addEventListener('pointermove', move, { passive: true });
    const press = () => { element.dataset.pressed = 'true'; };
    const release = () => { element.dataset.pressed = 'false'; };
    window.addEventListener('pointerdown', press); window.addEventListener('pointerup', release);
    window.addEventListener('blur', hide);
    document.addEventListener('pointerleave', hide);
    document.addEventListener('visibilitychange', hide);
    fine.addEventListener('change', hide);
    return () => {
      hide(); window.removeEventListener('pointermove', move); window.removeEventListener('blur', hide);
      window.removeEventListener('pointerdown', press); window.removeEventListener('pointerup', release);
      document.removeEventListener('pointerleave', hide); document.removeEventListener('visibilitychange', hide);
      fine.removeEventListener('change', hide);
    };
  }, [reducedMotion]);
  return <div className="premium-cursor" ref={ring} aria-hidden="true"><span /><span /><span /></div>;
}
