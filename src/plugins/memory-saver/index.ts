import { app } from 'electron';

import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import type { MusicPlayer } from '@/types/music-player';
import type { VideoDataChanged } from '@/types/video-data-changed';

const CHECK_INTERVAL_MS = 60_000;
/** How long to keep waiting for a pause before interrupting playback anyway. */
const GRACE_MS = 30 * 60_000;
/**
 * Minimum spacing between reloads. Without this, a threshold set below the
 * app's own baseline would reload over and over.
 */
const COOLDOWN_MS = 60 * 60_000;
const THRESHOLD_CHOICES_MB = [800, 1200, 2000];

const RELOAD_CHANNEL = 'memory-saver:reload-when-idle';
/** Survives the reload but not an app restart, which is exactly the lifetime needed. */
const WAS_PAUSED_KEY = 'peard:memory-saver-was-paused';

export type MemorySaverPluginConfig = {
  enabled: boolean;
  /** Reload once the renderer process is above this many MB. */
  thresholdMB: number;
};

export default createPlugin<
  {
    interval: NodeJS.Timeout | null;
    lastRequestAt: number;
  },
  unknown,
  {
    api: MusicPlayer | null;
    pending: boolean;
    graceTimeout: NodeJS.Timeout | null;
    reload: () => void;
    onPause: () => void;
    onVideoDataChange: (event: CustomEvent<VideoDataChanged>) => void;
    keepPaused: () => void;
    onTimeUpdate: (event: Event) => void;
  },
  MemorySaverPluginConfig
>({
  name: () => t('plugins.memory-saver.name'),
  description: () => t('plugins.memory-saver.description'),
  addedVersion: '3.12.X',
  restartNeeded: false,
  config: {
    enabled: false,
    thresholdMB: 1200,
  },
  menu: async ({ getConfig, setConfig }) => {
    const config = await getConfig();

    return [
      {
        label: t('plugins.memory-saver.menu.threshold'),
        submenu: THRESHOLD_CHOICES_MB.map((thresholdMB) => ({
          label: `${thresholdMB} MB`,
          type: 'radio' as const,
          checked: config.thresholdMB === thresholdMB,
          click() {
            setConfig({ thresholdMB });
          },
        })),
      },
    ];
  },
  backend: {
    interval: null,
    lastRequestAt: 0,
    start({ window, ipc, getConfig }) {
      this.interval = setInterval(async () => {
        if (Date.now() - this.lastRequestAt < COOLDOWN_MS) return;

        const { thresholdMB } = await getConfig();
        const pid = window.webContents.getOSProcessId();
        const usedKB = app.getAppMetrics().find((metric) => metric.pid === pid)
          ?.memory.workingSetSize;

        if (usedKB && usedKB / 1024 >= thresholdMB) {
          this.lastRequestAt = Date.now();
          ipc.send(RELOAD_CHANNEL);
        }
      }, CHECK_INTERVAL_MS);
    },
    stop() {
      if (this.interval) clearInterval(this.interval);
      this.interval = null;
    },
  },
  renderer: {
    api: null,
    pending: false,
    graceTimeout: null,
    reload() {
      // Built from the player rather than `options.resumeOnStart`'s saved url,
      // which still points at the previous song during a track change
      const { video_id: videoId, list } = this.api?.getVideoData() ?? {};
      if (!videoId) return;

      this.pending = false;
      if (this.graceTimeout) clearTimeout(this.graceTimeout);
      this.graceTimeout = null;

      const target = new URL('https://music.youtube.com/watch');
      target.searchParams.set('v', videoId);
      if (list) target.searchParams.set('list', list);

      // Carry the playback position over; YouTube Music honours `t` and then
      // drops it from the address bar, so it cannot pile up across reloads.
      const video = document.querySelector('video');
      const elapsed = Math.floor(video?.currentTime ?? 0);
      if (elapsed > 0) target.searchParams.set('t', `${elapsed}s`);

      // The page always autoplays after loading, so remember a paused player
      // and put it back afterwards — pausing must not restart the music.
      if (video?.paused) sessionStorage.setItem(WAS_PAUSED_KEY, '1');

      location.replace(target.toString());
    },
    keepPaused() {
      const video = document.querySelector('video');
      this.api?.pauseVideo();
      // Autoplay can win the race, so pause again on the first frame it plays
      video?.addEventListener('timeupdate', this.onTimeUpdate, { once: true });
    },
    onTimeUpdate(event) {
      if (event.target instanceof HTMLVideoElement) event.target.pause();
    },
    onPause() {
      if (this.pending) this.reload();
    },
    onVideoDataChange(event) {
      // A track change is the least disruptive moment to lose a few seconds
      if (this.pending && event.detail.name === 'dataloaded') this.reload();
    },
    onPlayerApiReady(api, { ipc }) {
      this.api = api;

      if (sessionStorage.getItem(WAS_PAUSED_KEY)) {
        sessionStorage.removeItem(WAS_PAUSED_KEY);
        this.keepPaused();
      }

      ipc.on(RELOAD_CHANNEL, () => {
        if (this.pending) return;
        this.pending = true;

        if (document.querySelector('video')?.paused) {
          this.reload();
          return;
        }

        // Otherwise hold out for a pause or a track change, but not forever
        this.graceTimeout = setTimeout(() => this.reload(), GRACE_MS);
      });

      document
        .querySelector('video')
        ?.addEventListener('pause', this.onPause, { passive: true });
      document.addEventListener('videodatachange', this.onVideoDataChange);
    },
    stop() {
      if (this.graceTimeout) clearTimeout(this.graceTimeout);
      this.graceTimeout = null;
      this.pending = false;

      const video = document.querySelector('video');
      video?.removeEventListener('pause', this.onPause);
      video?.removeEventListener('timeupdate', this.onTimeUpdate);
      document.removeEventListener('videodatachange', this.onVideoDataChange);
    },
  },
});
