// Where each browser keeps its cookies, so the user can find the file to import.
// "<profile>" is a folder with a random name (Firefox: like "abcd1234.default-release";
// Chromium-based browsers: "Default", or "Profile 1"… for other profiles).

export const BROWSERS = {
  firefox: { name: 'Firefox', file: 'cookies.sqlite' },
  chrome: { name: 'Google Chrome', file: 'Cookies' },
  chromium: { name: 'Chromium', file: 'Cookies' },
  brave: { name: 'Brave', file: 'Cookies' },
  edge: { name: 'Microsoft Edge', file: 'Cookies' },
  vivaldi: { name: 'Vivaldi', file: 'Cookies' },
  opera: { name: 'Opera', file: 'Cookies' },
  txt: { name: 'A cookies.txt file', file: 'cookies.txt' },
};

export const SYSTEMS = { linux: 'Linux', windows: 'Windows', mac: 'macOS' };

export function detectSystem() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  return p.includes('win') ? 'windows' : p.includes('mac') ? 'mac' : 'linux';
}

// Chromium-based browsers keep cookies in <profile>/Network/Cookies (older versions: <profile>/Cookies).
const chromium = (dir) => [`${dir}/<profile>/Network/Cookies`, `${dir}/<profile>/Cookies (older versions)`];

const PATHS = {
  firefox: {
    linux: [
      '~/.mozilla/firefox/<profile>/cookies.sqlite',
      '~/.config/mozilla/firefox/<profile>/cookies.sqlite (newer versions)',
      'Flatpak: ~/.var/app/org.mozilla.firefox/.mozilla/firefox/<profile>/cookies.sqlite',
      'Snap: ~/snap/firefox/common/.mozilla/firefox/<profile>/cookies.sqlite',
    ],
    windows: ['%APPDATA%\\Mozilla\\Firefox\\Profiles\\<profile>\\cookies.sqlite'],
    mac: ['~/Library/Application Support/Firefox/Profiles/<profile>/cookies.sqlite'],
  },
  chrome: {
    linux: [...chromium('~/.config/google-chrome'), 'Flatpak: ~/.var/app/com.google.Chrome/config/google-chrome/<profile>/Network/Cookies'],
    windows: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data\\<profile>\\Network\\Cookies'],
    mac: ['~/Library/Application Support/Google/Chrome/<profile>/Cookies'],
  },
  chromium: {
    linux: [...chromium('~/.config/chromium'), 'Flatpak: ~/.var/app/org.chromium.Chromium/config/chromium/<profile>/Network/Cookies', 'Snap: ~/snap/chromium/common/chromium/<profile>/Network/Cookies'],
    windows: ['%LOCALAPPDATA%\\Chromium\\User Data\\<profile>\\Network\\Cookies'],
    mac: ['~/Library/Application Support/Chromium/<profile>/Cookies'],
  },
  brave: {
    linux: [...chromium('~/.config/BraveSoftware/Brave-Browser'), 'Flatpak: ~/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/<profile>/Network/Cookies'],
    windows: ['%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data\\<profile>\\Network\\Cookies'],
    mac: ['~/Library/Application Support/BraveSoftware/Brave-Browser/<profile>/Cookies'],
  },
  edge: {
    linux: chromium('~/.config/microsoft-edge'),
    windows: ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\<profile>\\Network\\Cookies'],
    mac: ['~/Library/Application Support/Microsoft Edge/<profile>/Cookies'],
  },
  vivaldi: {
    linux: chromium('~/.config/vivaldi'),
    windows: ['%LOCALAPPDATA%\\Vivaldi\\User Data\\<profile>\\Network\\Cookies'],
    mac: ['~/Library/Application Support/Vivaldi/<profile>/Cookies'],
  },
  opera: {
    linux: ['~/.config/opera/Network/Cookies', '~/.config/opera/Cookies (older versions)'],
    windows: ['%APPDATA%\\Opera Software\\Opera Stable\\Network\\Cookies'],
    mac: ['~/Library/Application Support/com.operasoftware.Opera/Cookies'],
  },
  txt: {
    linux: ['Export it with a cookies.txt extension in the browser you’re logged in with.'],
    windows: ['Export it with a cookies.txt extension in the browser you’re logged in with.'],
    mac: ['Export it with a cookies.txt extension in the browser you’re logged in with.'],
  },
};

// Hints and warnings for a browser on a system: { paths, notes, works }.
export function hintsFor(browser, system) {
  const paths = PATHS[browser]?.[system] || [];
  const notes = [];
  let works = true;
  if (system === 'linux' && browser !== 'txt') notes.push('In the file dialog, press Ctrl+H to show hidden folders like .mozilla or .config.');
  if (browser === 'firefox') notes.push('If there’s a cookies.sqlite-wal file next to it, select both: it holds the newest cookies.');
  if (!['firefox', 'txt'].includes(browser)) {
    if (system === 'linux') notes.push('This only works if the browser doesn’t protect its cookies with the system keyring (KWallet or GNOME Keyring), which most desktops use. If no cookies come out, use a cookies.txt file instead.');
    else {
      works = false;
      notes.push(`${system === 'windows' ? 'Windows' : 'macOS'} encrypts this browser’s cookies so that only the browser itself can read them. Use a cookies.txt file instead.`);
    }
  }
  return { paths, notes, works };
}
