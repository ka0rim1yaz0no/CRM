import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { createLoginScene, IntroPhase } from './referenceLoginScene';
import { loginIntroConfig as config } from './loginIntroConfig';
import PremiumCursor from './PremiumCursor';
import LoginParticleField from './LoginParticleField';
import './loginExperience.css';

const seenKey = 'assistly:cinematic-intro-seen:v12';
function hasSeenIntro() { try { return sessionStorage.getItem(seenKey) === '1'; } catch { return false; } }
function rememberIntro() { try { sessionStorage.setItem(seenKey, '1'); } catch { /* Optional session storage. */ } }
function prefersReducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

/** Owns one scene and wraps the existing authentication form without changing its behavior. */
export default function AssistlyCinematicIntro({ children }: { children: ReactNode }) {
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [startAtLogin] = useState(() => !config.enabled || hasSeenIntro() || prefersReducedMotion());
  const [phase, setPhase] = useState<IntroPhase>(startAtLogin ? 'login' : 'intro');
  const [loaded, setLoaded] = useState({ intro: false, logo: false, unavailable: false });
  const stage = useRef<HTMLDivElement>(null);
  const introVideo = useRef<HTMLVideoElement>(null);
  const scene = useRef<ReturnType<typeof createLoginScene> | null>(null);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => { setLoaded({ intro: false, logo: false, unavailable: false }); setReducedMotion(media.matches); };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!stage.current) return;
    let cancelled = false;
    let renderer: ReturnType<typeof createLoginScene> | undefined;
    void import('./referenceLoginScene').then(({ createLoginScene }) => {
      if (cancelled || !stage.current) return;
      renderer = createLoginScene(stage.current, {
        reducedMotion: reducedMotion || !config.enabled,
        startAtLogin: startAtLogin || hasSeenIntro() || reducedMotion || !config.enabled,
        introVideo: introVideo.current,
        onLoaded: asset => setLoaded(current => ({ ...current, [asset]: true })),
        onUnavailable: () => { setLoaded(current => ({ ...current, unavailable: true })); setPhase('login'); rememberIntro(); },
        onPhase: next => { setPhase(next); if (next === 'login') rememberIntro(); },
      });
      scene.current = renderer;
    }).catch(() => {
      if (!cancelled) { setLoaded(current => ({ ...current, unavailable: true })); setPhase('login'); }
    });
    return () => { cancelled = true; renderer?.dispose(); scene.current = null; };
  }, [startAtLogin, reducedMotion]);

  function skipIntro() { scene.current?.finishIntro(); setPhase('login'); rememberIntro(); }
  function replayIntro() { scene.current?.replay(); }
  return (
    <main className="login-screen assistly-entrance" data-phase={phase} data-reduced-motion={reducedMotion} data-unavailable={loaded.unavailable}>
      <header className="entrance-header">
        {phase !== 'login' && <button type="button" className="entrance-skip" onClick={skipIntro}>Skip intro <span aria-hidden="true">↗</span></button>}
      </header>
      <div className="entrance-floor" aria-hidden="true" />
      <LoginParticleField reducedMotion={reducedMotion} active={phase === 'login' || phase === 'docking'} />
      <div className="entrance-visual" aria-hidden="true">
        {!reducedMotion && config.enabled && <video ref={introVideo} className="entrance-film" muted playsInline preload={startAtLogin ? 'none' : 'auto'} disablePictureInPicture tabIndex={-1} />}
        <div className="entrance-podium"><span className="podium-light" /><span className="podium-base" /><span className="podium-surface" /></div>
        <div className={`entrance-canvas ${loaded.unavailable ? 'unavailable' : ''}`} data-intro-loaded={loaded.intro} data-logo-loaded={loaded.logo} ref={stage} />
        <div className="entrance-brand-reveal"><strong>ASSISTLY</strong><span>YOUR TASK PARTNER</span></div>
      </div>
      <div className="entrance-panel" inert={phase !== 'login' && phase !== 'docking'} onFocusCapture={skipIntro}>{children}</div>
      <footer className="entrance-footer"><span>PEOPLE. PROCESS. POSSIBILITY.</span>{phase === 'login' && !reducedMotion && config.enabled && !loaded.unavailable && <button type="button" onClick={replayIntro}>Replay intro <span aria-hidden="true">↺</span></button>}</footer>
      <PremiumCursor reducedMotion={reducedMotion} />
    </main>
  );
}
