// User settings, with the defaults. Shared by the worker, the engine and the popup.
export const DEFAULTS = {
  mode: 'auto', // 'auto' (music or video, guessed per video), 'video', 'music'
  maxHeight: 1080, // 0 = best quality, else a cap such as 1080
  compatible: false, // prefer H.264 video, which plays on every device
  audioFormat: 'm4a', // music: 'm4a' (original AAC), 'mp3', 'opus' (original), 'wav'
  subtitleTracks: [], // subtitles to embed (ids from subtitleOptions), chosen per download
  // Pauses for playlists, so sites don't flag the downloads (yt-dlp's suggested values):
  sleepMin: 10, // seconds between videos, at least…
  sleepRandom: 10, // …plus a random 0 to this many seconds
  sleepRequests: 0.75, // seconds between yt-dlp's requests
  sleepSubtitles: 1, // seconds between subtitle downloads
};

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}

export const saveSettings = (settings) => chrome.storage.local.set({ settings });
