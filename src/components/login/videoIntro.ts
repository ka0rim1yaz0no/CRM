import { loginIntroConfig as config } from './loginIntroConfig';

/** Use decoded media time, then continue the same clock through the live logo reveal. */
export function createVideoIntro(video: HTMLVideoElement | null, callbacks: { ready(): void; unavailable(): void }) {
  let disposed = false, started = false, ending = false, endAt = 0, endMediaTime = 0, waitingSince = 0;
  let deadline: number | undefined;
  function clearDeadline() { window.clearTimeout(deadline); }
  function fail(error?: unknown) { if (!disposed) { clearDeadline(); if (video) video.dataset.playbackError = error instanceof Error ? error.message : video.error?.message || 'Media loading timed out'; video?.pause(); callbacks.unavailable(); } }
  function ready() { clearDeadline(); if (video) delete video.dataset.playbackError; if (!disposed) callbacks.ready(); }
  function load() {
    if (!video || disposed) { fail(); return; }
    video.preload = 'auto';
    if (!video.getAttribute('src')) {
      video.src = config.introVideoUrl; video.muted = true; video.load();
      deadline = window.setTimeout(fail, 8000);
    } else if (video.readyState >= 2) ready();
    else { video.load(); deadline = window.setTimeout(fail, 8000); }
  }
  video?.addEventListener('loadeddata', ready); video?.addEventListener('error', fail);
  video?.addEventListener('stalled', stalled);
  function stalled() { waitingSince ||= performance.now(); }
  function playing() { waitingSince = 0; }
  video?.addEventListener('playing', playing); video?.addEventListener('waiting', stalled);
  return {
    load,
    play() {
      if (!video || disposed) { fail(); return; }
      started = true; ending = false; waitingSince = 0; video.currentTime = 0;
      if (!document.hidden) void video.play().catch(fail);
    },
    time(now: number) {
      if (!video || !started) return 0;
      if (ending) return endMediaTime + (now - endAt) / 1000;
      if (video.ended || video.currentTime >= config.introVideoEnd - .04) {
        ending = true; endAt = now; endMediaTime = video.currentTime; video.pause();
        return endMediaTime;
      }
      if (waitingSince && now - waitingSince > 6000) fail();
      return video.currentTime;
    },
    finish() { video?.pause(); clearDeadline(); },
    visibility(hidden: boolean, now: number, pausedFor: number) {
      if (ending) endAt += pausedFor;
      if (hidden) { video?.pause(); waitingSince = 0; }
      else if (started && !ending && video && !disposed) { waitingSince = now; void video.play().catch(fail); }
    },
    dispose() {
      disposed = true; clearDeadline();
      if (!video) return;
      video.pause(); video.removeEventListener('loadeddata', ready); video.removeEventListener('error', fail);
      video.removeEventListener('stalled', stalled); video.removeEventListener('waiting', stalled); video.removeEventListener('playing', playing);
      video.removeAttribute('src'); video.load();
    },
  };
}
