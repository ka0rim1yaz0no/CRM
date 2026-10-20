import { useEffect, useRef } from 'react';

/** Aether Flow's particle network, bounded and independent of pointer presence. */
export default function LoginParticleField({ active, reducedMotion }: { active: boolean; reducedMotion: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current, context = element?.getContext('2d');
    if (!element || !context) return;
    let width = 1, height = 1, frame = 0, last = 0;
    const pointer = { x: -1000, y: -1000 };
    let particles: { x: number; y: number; vx: number; vy: number }[] = [];
    function resize() {
      width = window.innerWidth; height = window.innerHeight;
      const dpr = Math.min(devicePixelRatio || 1, 1.25);
      element!.width = Math.round(width * dpr); element!.height = Math.round(height * dpr);
      context!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(width <= 900 ? 58 : 112, Math.max(34, Math.round(width * height / 11000)));
      particles = Array.from({ length: count }, (_, i) => ({ x: ((i * .618034) % 1) * width, y: ((i * .414214 + .2) % 1) * height, vx: Math.cos(i * 2.4) * 9, vy: Math.sin(i * 2.4) * 9 }));
      paint(0);
    }
    function paint(delta: number) {
      context!.clearRect(0, 0, width, height);
      // Broad flowing light is visible behind the network, never above the form.
      const time = reducedMotion ? 0 : last / 1000;
      for (let band = 0; band < 3; band++) {
        const y = height * (.25 + band * .27) + Math.sin(time * .12 + band * 2) * height * .07;
        const wash = context!.createRadialGradient(width * (.2 + band * .31), y, 0, width * (.2 + band * .31), y, width * .48);
        wash.addColorStop(0, band === 1 ? 'rgba(110,47,220,.15)' : 'rgba(88,38,187,.13)'); wash.addColorStop(1, 'rgba(58,14,110,0)');
        context!.fillStyle = wash; context!.fillRect(0, 0, width, height);
      }
      for (const p of particles) {
        const dx = p.x - pointer.x, dy = p.y - pointer.y, distance = Math.hypot(dx, dy);
        if (!reducedMotion && distance > .001 && distance < 145) { const force = (1 - distance / 145) * 55 * delta; p.x += dx / distance * force; p.y += dy / distance * force; }
        p.x += p.vx * delta; p.y += p.vy * delta;
        // Clamp after repulsion as well as drift so particles cannot escape permanently.
        if (p.x < 2 || p.x > width - 2) { p.x = Math.max(2, Math.min(width - 2, p.x)); p.vx = p.x <= 2 ? Math.abs(p.vx) : -Math.abs(p.vx); }
        if (p.y < 2 || p.y > height - 2) { p.y = Math.max(2, Math.min(height - 2, p.y)); p.vy = p.y <= 2 ? Math.abs(p.vy) : -Math.abs(p.vy); }
      }
      for (let a = 0; a < particles.length; a++) {
        const p = particles[a]; let connections = 0;
        for (let b = a + 1; b < particles.length && connections < 4; b++) {
          const q = particles[b], distance = Math.hypot(p.x - q.x, p.y - q.y);
          if (distance > 195) continue;
          context!.strokeStyle = `rgba(177,128,245,${(1 - distance / 195) * .46})`; context!.lineWidth = .8;
          context!.beginPath(); context!.moveTo(p.x, p.y); context!.lineTo(q.x, q.y); context!.stroke(); connections++;
        }
        context!.fillStyle = 'rgba(211,176,255,.82)'; context!.beginPath(); context!.arc(p.x, p.y, 1.7, 0, Math.PI * 2); context!.fill();
      }
    }
    function animate(now: number) {
      if (!active || reducedMotion || document.hidden) { frame = 0; return; }
      frame = requestAnimationFrame(animate); if (now - last < 1000 / 30) return;
      const delta = last ? Math.min(.05, (now - last) / 1000) : 0; last = now; paint(delta);
    }
    function visibility() { cancelAnimationFrame(frame); frame = 0; last = 0; if (active && !reducedMotion && !document.hidden) frame = requestAnimationFrame(animate); }
    function move(event: PointerEvent) { if (event.pointerType === 'mouse') { pointer.x = event.clientX; pointer.y = event.clientY; } }
    function leave() { pointer.x = pointer.y = -1000; }
    resize(); visibility(); window.addEventListener('resize', resize); window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave); window.addEventListener('blur', leave); document.addEventListener('visibilitychange', visibility);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize); window.removeEventListener('pointermove', move); document.removeEventListener('pointerleave', leave); window.removeEventListener('blur', leave); document.removeEventListener('visibilitychange', visibility); };
  }, [active, reducedMotion]);
  return <canvas ref={canvas} className="login-particle-field" data-active={active} aria-hidden="true" />;
}
