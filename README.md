# yt-dlp Downloader

A Chrome extension that downloads videos, music and subtitles from YouTube and the 1,000+ other sites [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports. yt-dlp runs **inside the browser**: there's nothing else to install.

## What it does

Open a page with a video and click the extension's icon. It reads the page and offers:

- **Video:** the best video and sound in one MP4, with the subtitles (the creator's, plus the automatic ones in the video's own language), chapters, title and the thumbnail as cover.
- **Music:** the sound only as M4A (no re-encoding, so no quality loss), with the cover art cropped square and the song's title, artist, album and date.

It picks Music by itself for YouTube Music links, "Topic" channels and videos YouTube lists as music; one click switches it. For a video in a playlist you can download just that video or the whole playlist, into a folder named after it.

## Install

The extension isn't in the Chrome Web Store (the store doesn't allow YouTube downloaders), so it's installed by hand:

1. Download the latest `yt-dlp-downloader-….zip` and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder.

It works in Chrome, Chromium, Brave, Edge and Vivaldi, version 137 or newer. Chrome shows a notice about developer-mode extensions: that's expected for extensions installed this way.

**Updating:** YouTube changes often and yt-dlp follows; each release of this extension ships one yt-dlp version (the zip's name says which). To update, remove the old version from `chrome://extensions` and load the new folder. Your settings are kept only if you load the new version from the same folder path.

## Options

The gear in the popup opens the options:

- **Quality:** best available (default), or a maximum such as 1080p. "Prefer H.264" picks video that plays on every device; the very best quality is often AV1 or VP9, which some older devices can't play.
- **Subtitles:** on by default. YouTube translates captions automatically into 100+ languages; only the creator's subtitles and the automatic captions in the video's own language are embedded.
- **Logins:** age-restricted, members-only or private videos need you to be logged in. By default the extension uses this browser's logins **only when a video needs one**, because downloading a lot with an account can get it flagged. You can also choose always or never.
- **Log in with another browser:** pick the browser and your system, and the options show where that browser keeps its cookies; select the file. Firefox works on every system. Chrome, Brave, Edge and other Chromium browsers only work on Linux without a system keyring, since Windows, macOS and most Linux desktops encrypt their cookies so only the browser itself can read them. For those, export a `cookies.txt` file with a cookies.txt extension and import that. Imported cookies stay only in this extension; **Remove** deletes them.
- **Pauses in playlists:** between videos, at least 10 seconds plus a random extra up to 10; 0.75 seconds between requests; 1 second between subtitles. These keep sites from flagging the downloads; raise them for very long playlists.

## Limits

- Live streams aren't supported yet (download them once they've ended).
- DRM-protected videos (Netflix, Disney+, paid films…) can't be downloaded.
- When a site's best format can't go into MP4 (some only offer WebM), the original files are saved as they are, with a note.
- Downloads run one at a time, in the background; they keep going when the popup is closed, but stop if the browser closes.

## For maintainers

```sh
npm install           # Pyodide, Playwright and its Chromium (for the tests)
npm run vendor        # puts the yt-dlp version from versions.json into extension/vendor
npm test              # unit tests (MP4 writer, subtitles)
npm run test:e2e      # the real extension in Chromium, against local test media
ONLINE=1 npm run test:e2e   # also real YouTube downloads
npm run package       # dist/yt-dlp-downloader-<version>-yt-dlp-<yt-dlp>.zip
```

**New yt-dlp release:** set its version in `versions.json`, bump `version` in `extension/manifest.json`, then run `npm run vendor`, the tests (including `ONLINE=1`) and `npm run package`. `npm run vendor` checks the download against PyPI's checksum and fetches the `yt-dlp-ejs` version that yt-dlp release expects.

How it works: yt-dlp runs in [Pyodide](https://pyodide.org) (Python compiled to WebAssembly) in an offscreen document. Its requests go through the browser's `fetch`, and YouTube's JavaScript challenges are solved by yt-dlp's own solver scripts in a sandboxed extension page. yt-dlp only finds what to download; the extension downloads it and writes the final MP4/M4A itself (`extension/engine/mp4out.js`), so there's no ffmpeg and no file size limit.
