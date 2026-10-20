/** Self-hosted opening film and live logo, with shared transition timing. */
export const loginIntroConfig = {
  enabled: true,
  introVideoUrl: '/media/assistly/algorithm-opening-clean.mp4',
  introVideoEnd: 5.5,
  logoModelUrl: '/models/assistly/logo-reference.glb',
  timeline: {
    knot: .08, transition: 3.16,
    filmFadeStart: 5.08, filmFadeEnd: 5.64,
    burst: 5.48, logo: 5.36, logoFull: 5.88, logoSettled: 6.45,
    brand: 6.65, brandFull: 7.3, tagline: 7.12, taglineFull: 7.75,
    dock: 8.2, platform: 9.15, complete: 10.2,
  },
  logoRotationY: Math.PI,
  maxPixelRatio: 1.75,
} as const;

export const introTotalDuration = loginIntroConfig.timeline.complete;
