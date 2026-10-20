import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { introTotalDuration, loginIntroConfig as config } from './loginIntroConfig';
import { createReferenceMaterials } from './referenceMaterials';
import { createReferenceEffects, smooth } from './referenceEffects';
import { createReferenceBloom } from './referenceBloom';
import { createPremiumStage } from './premiumStage';
import { createCinematicBackdrop } from './cinematicBackdrop';
import { createVideoIntro } from './videoIntro';

export type IntroPhase = 'intro' | 'knot' | 'transition' | 'logoReveal' | 'docking' | 'login';
type SceneOptions = {
  reducedMotion: boolean; startAtLogin: boolean;
  introVideo: HTMLVideoElement | null;
  onLoaded: (asset: 'intro' | 'logo') => void;
  onUnavailable: () => void; onPhase: (phase: IntroPhase) => void;
};

/** Decoded reference film hands off to the persistent, interactive Three.js logo. */
export function createLoginScene(host: HTMLDivElement, options: SceneOptions) {
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' }); }
  catch {
    options.onUnavailable(); options.onPhase('login');
    return { finishIntro() {}, replay() { options.onPhase('login'); }, dispose() {} };
  }
  renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio || 1, 1.4), config.maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0); renderer.domElement.setAttribute('aria-hidden', 'true'); host.appendChild(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(38, 1, .02, 60);
  const stage = new THREE.Group(), logo = new THREE.Group(); stage.add(logo); scene.add(stage);
  const surface = createReferenceMaterials(), effects = createReferenceEffects(stage, window.innerWidth <= 900 ? 140 : 230);
  const studio = createPremiumStage(renderer, scene);
  const backdrop = createCinematicBackdrop(scene, window.innerWidth <= 900 ? 220 : 440);
  const bloom = createReferenceBloom(renderer);
  const geometry = new Set<THREE.BufferGeometry>();
  const abort = new AbortController(), loaded = { intro: false, logo: false };
  let disposed = false, unavailable = false, finished = options.startAtLogin || options.reducedMotion;
  let playing = false;
  let frame = 0, lastFrame = -1, start = performance.now(), lastPhase: IntroPhase | undefined;
  let lastDraw = start, loginEnteredAt = 0;
  let slowFrames = 0, economy = false;
  let width = 1, height = 1, viewWidth = 1, viewHeight = 1, hover = 0, pointerInside = false;
  let hiddenAt: number | null = document.hidden ? start : null;
  const pointer = new THREE.Vector2(), softPointer = new THREE.Vector2();
  const shell = host.closest<HTMLElement>('.assistly-entrance');
  function begin() {
    if (!loaded.intro || !loaded.logo || disposed || unavailable) return;
    clearTimeout(loadDeadline);
    if (!finished && !playing) { playing = true; start = performance.now(); film.play(); }
  }
  const film = createVideoIntro(options.introVideo, {
    ready() { loaded.intro = true; options.onLoaded('intro'); begin(); },
    unavailable() {
      loaded.intro = true; finished = true; host.dataset.videoUnavailable = 'true';
      options.onLoaded('intro'); options.onPhase('login'); begin(); draw(performance.now());
    },
  });
  function fail() {
    if (disposed || unavailable) return;
    unavailable = true; finished = true; film.finish(); abort.abort(); cancelAnimationFrame(frame); clearTimeout(loadDeadline);
    options.onUnavailable(); options.onPhase('login');
  }
  const loadDeadline = window.setTimeout(() => { if (!loaded.intro || !loaded.logo) fail(); }, 8000);
  const loader = new GLTFLoader();
  function release(root: THREE.Object3D) {
    root.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose(); } });
  }
  async function load(url: string) {
    try {
      const response = await fetch(url, { signal: abort.signal }); if (!response.ok) throw new Error(`Asset HTTP ${response.status}`);
      const gltf = await loader.parseAsync(await response.arrayBuffer(), new URL('.', new URL(url, location.href)).href);
      if (disposed || unavailable) { release(gltf.scene); return; }
      const meshes: THREE.Mesh[] = []; gltf.scene.traverse(o => { if (o instanceof THREE.Mesh) meshes.push(o); });
      if (!meshes.length) { release(gltf.scene); throw new Error('Asset has no geometry'); }
      gltf.scene.updateMatrixWorld(true);
      for (const mesh of meshes) {
        const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld); geometry.add(g);
        const echo = new THREE.Mesh(g, surface.echo);
        echo.renderOrder = -1;
        logo.add(echo, new THREE.Mesh(g, surface.logo), new THREE.Mesh(g, surface.edge), new THREE.Mesh(g, surface.highlight));
      }
      release(gltf.scene);
      // Compile hidden reveal/effect programs before playback, avoiding a GPU
      // compilation hitch precisely when the explosion uncovers the logo.
      const visibility = new Map<THREE.Object3D, boolean>();
      scene.traverse(object => { visibility.set(object, object.visible); object.visible = true; });
      await renderer.compileAsync(scene, camera);
      if (disposed || unavailable) return;
      visibility.forEach((visible, object) => { object.visible = visible; });
      loaded.logo = true; options.onLoaded('logo'); begin();
      draw(performance.now());
    } catch (error) { if (!disposed && !abort.signal.aborted) { console.warn('Assistly logo asset failed', error); fail(); } }
  }
  function draw(now: number) {
    if (disposed || unavailable) return;
    const elapsed = (now - start) / 1000;
    const dt = Math.min(.05, Math.max(0, (now - lastDraw) / 1000)); lastDraw = now;
    const t = finished ? introTotalDuration : loaded.intro && loaded.logo ? film.time(now) : 0;
    const marks = config.timeline;
    const phase: IntroPhase = t >= marks.complete ? 'login' : t >= marks.dock ? 'docking' : t >= marks.logo ? 'logoReveal' : t >= marks.transition ? 'transition' : t >= marks.knot ? 'knot' : 'intro';
    if (phase !== lastPhase) { if (phase === 'login') loginEnteredAt = elapsed; lastPhase = phase; options.onPhase(phase); }
    const mobile = width <= 900, dock = smooth(marks.dock, marks.complete, t);
    const formReveal = smooth(marks.dock + (mobile ? 1.15 : .4), marks.complete, t);
    shell?.style.setProperty('--login-reveal', String(formReveal)); shell?.style.setProperty('--login-lift', `${(1 - formReveal) * 22}px`);
    const finalScale = mobile ? Math.min(188, width * .48) * viewHeight / (1.68 * height) : .95 * Math.min(1, width * .48 / (height * .75));
    const scale = THREE.MathUtils.lerp(1, finalScale, dock);
    stage.scale.setScalar(scale);
    stage.position.set(mobile ? 0 : -.21 * viewWidth * dock, (mobile ? (.5 - 150 / height) * viewHeight - .4 * finalScale : .09 * viewHeight - .4 * finalScale) * dock, 0);
    const px = (stage.position.x / viewWidth + .5) * width;
    const textY = height * .5 - (stage.position.y - .5 * scale) / viewHeight * height;
    shell?.style.setProperty('--brand-x', `${px}px`); shell?.style.setProperty('--brand-y', `${textY}px`);
    shell?.style.setProperty('--platform-y', `${height * .5 - (stage.position.y - 1.14 * scale) / viewHeight * height}px`);
    shell?.style.setProperty('--platform-width', `${2.14 * scale * height / viewHeight}px`);
    shell?.style.setProperty('--brand-font', `${.24 * height / viewHeight * scale}px`);
    shell?.style.setProperty('--tagline-offset', `${.25 * height / viewHeight * scale}px`);
    shell?.style.setProperty('--tagline-font', `${Math.max(8, .048 * height / viewHeight * scale)}px`);
    shell?.style.setProperty('--brand-alpha', String(smooth(marks.brand, marks.brandFull, t)));
    shell?.style.setProperty('--tagline-alpha', String(smooth(marks.tagline, marks.taglineFull, t)));
    const filmAlpha = finished ? 0 : smooth(0, .2, t) * (1 - smooth(marks.filmFadeStart, marks.filmFadeEnd, t));
    shell?.style.setProperty('--film-alpha', String(filmAlpha));
    shell?.style.setProperty('--film-scale', String(1.035 - .035 * smooth(0, 5.5, t)));
    shell?.style.setProperty('--film-x', `${softPointer.x * 5 * (1 - dock)}px`);
    shell?.style.setProperty('--film-y', `${softPointer.y * 3 * (1 - dock)}px`);
    // Overlap the film's contracting point with the emerging silhouette.
    // Opacity and velocity both start at zero, avoiding a one-frame pop at impact.
    const reveal = smooth(marks.logo, marks.logoFull, t);
    const outline = smooth(marks.logo, marks.burst + .2, t);
    const idle = smooth(marks.logoFull, marks.logoSettled, t);
    const travelFocus = smooth(marks.dock - .35, marks.dock + .2, t) * (1 - smooth(marks.complete, marks.complete + .65, t));
    const response = 1 - Math.exp(-9 * dt);
    softPointer.lerp(pointer, response); hover = THREE.MathUtils.lerp(hover, pointerInside && phase === 'login' && !options.reducedMotion ? 1 : 0, response);
    logo.visible = loaded.logo && reveal > .001;
    const live = phase === 'login' && !options.reducedMotion;
    const breathing = smooth(0, .9, elapsed - loginEnteredAt);
    logo.position.y = THREE.MathUtils.lerp(.08, .4, smooth(marks.logo, marks.logoSettled, t)) + (live ? Math.sin(elapsed * .65) * .018 * breathing : 0);
    // One eased scale curve accelerates out of the point and settles before
    // docking; there is no change in growth speed at the opacity keyframe.
    const arrivalScale = THREE.MathUtils.lerp(.08, 1, smooth(marks.logo, marks.logoSettled, t));
    logo.scale.setScalar(arrivalScale * (1 + hover * .04 + (live ? Math.sin(elapsed * .7) * .004 * breathing : 0)));
    logo.rotation.set(-.055 + (options.reducedMotion ? 0 : -softPointer.y * .10 * idle * hover), config.logoRotationY - .12 + (options.reducedMotion ? 0 : softPointer.x * .14 * idle * hover), -.015);
    surface.logo.opacity = reveal;
    surface.logo.emissiveIntensity = .42 + .10 * travelFocus;
    surface.logo.envMapIntensity = .4 + .08 * travelFocus;
    surface.brand.time.value = options.reducedMotion ? 9 : elapsed; surface.brand.alpha.value = outline; surface.brand.hover.value = hover;
    surface.brand.focus.value = 1 + .22 * travelFocus;
    surface.echo.uniforms.alpha.value = outline * smooth(marks.logoFull, marks.logoSettled, t);
    const burstAlpha = effects.update(t < marks.filmFadeStart ? 0 : t, 0, options.reducedMotion, Math.max(viewWidth, viewHeight) / 5);
    const platform = studio.update(t);
    shell?.style.setProperty('--platform-alpha', String(platform));
    shell?.style.setProperty('--platform-lift', `${(1 - platform) * 14}px`);
    backdrop.update(options.reducedMotion ? 0 : elapsed, dock, viewWidth, viewHeight, renderer.getPixelRatio());
    host.dataset.timeline = t.toFixed(2); host.dataset.dock = dock.toFixed(3); host.dataset.hover = hover > .3 ? 'active' : 'idle';
    host.dataset.impact = t >= marks.burst ? 'true' : 'false';
    host.dataset.platform = platform.toFixed(3); host.dataset.introStyle = 'reference-film';
    host.dataset.logoReveal = reveal.toFixed(3); host.dataset.filmAlpha = filmAlpha.toFixed(3);
    host.dataset.logoOutline = outline.toFixed(3); host.dataset.logoFocus = surface.brand.focus.value.toFixed(3);
    host.dataset.burstAlpha = burstAlpha.toFixed(3);
    host.dataset.renderMode = 'film-and-live-logo'; host.dataset.quality = economy ? 'balanced' : 'high';
    bloom.render(scene, camera);
  }
  function animate(now: number) {
    if (disposed || unavailable || document.hidden) return;
    frame = requestAnimationFrame(animate);
    if (lastFrame > 0 && loaded.logo && now - lastFrame > 42) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
    if (!economy && slowFrames > 90) { economy = true; renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.25)); resize(); }
    if (now - lastFrame < 1000 / (width <= 900 || economy ? 30 : 60) - .5) return;
    lastFrame = now; draw(now);
  }
  function resize() {
    width = Math.max(host.clientWidth, 1); height = Math.max(host.clientHeight, 1);
    camera.aspect = width / height; camera.position.set(0, 0, 5.2 / Math.min(1, camera.aspect / 1.5)); camera.updateProjectionMatrix();
    viewHeight = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2); viewWidth = viewHeight * camera.aspect;
    renderer.setSize(width, height, false); bloom.resize(width, height); draw(performance.now());
  }
  function visibility() {
    cancelAnimationFrame(frame);
    const now = performance.now(), pausedFor = hiddenAt === null ? 0 : now - Math.max(hiddenAt, start);
    if (!finished) film.visibility(document.hidden, now, pausedFor);
    if (document.hidden) hiddenAt = now;
    else if (hiddenAt !== null) { start += pausedFor; hiddenAt = null; }
    if (!document.hidden && !unavailable && !options.reducedMotion) frame = requestAnimationFrame(animate);
  }
  function pointerMove(event: PointerEvent) {
    if (options.reducedMotion || event.pointerType === 'touch' || width <= 900) return;
    const bounds = host.getBoundingClientRect(), x = (event.clientX - bounds.left) / width, y = (event.clientY - bounds.top) / height;
    pointerInside = x > .06 && x < .51 && y > .14 && y < .68;
    pointer.set(THREE.MathUtils.clamp((x - .29) / .22, -1, 1), THREE.MathUtils.clamp((y - .43) / .25, -1, 1));
  }
  function leave() { pointerInside = false; pointer.set(0, 0); }
  function contextLost(event: Event) { event.preventDefault(); fail(); }
  const observer = new ResizeObserver(resize); observer.observe(host);
  document.addEventListener('visibilitychange', visibility); document.addEventListener('pointerleave', leave);
  window.addEventListener('pointermove', pointerMove, { passive: true }); renderer.domElement.addEventListener('webglcontextlost', contextLost);
  resize();
  if (finished) { loaded.intro = true; options.onLoaded('intro'); } else film.load();
  void load(config.logoModelUrl);
  if (!options.reducedMotion && !document.hidden) frame = requestAnimationFrame(animate);
  return {
    finishIntro() { finished = true; film.finish(); draw(performance.now()); },
    replay() {
      if (unavailable || options.reducedMotion) { options.onPhase('login'); return; }
      finished = false; playing = false; loaded.intro = false; start = performance.now(); lastPhase = undefined;
      film.load(); draw(start);
    },
    dispose() {
      disposed = true; film.dispose(); abort.abort(); clearTimeout(loadDeadline); cancelAnimationFrame(frame); observer.disconnect();
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('pointerleave', leave); window.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost); effects.dispose(); backdrop.dispose(); studio.dispose(); surface.dispose(); bloom.dispose(); geometry.forEach(g => g.dispose());
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}
