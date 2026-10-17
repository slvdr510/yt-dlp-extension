# yt-dlp-extension

A Chrome extension that downloads videos, audio and subtitles from YouTube and the [other sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports. yt-dlp runs **inside the browser**: there's nothing else to install.

## What it does

Open a page with a video and click the extension's icon. It reads the page and offers:

- **Video:** the best video and sound in one MP4, up to the quality you pick, with the subtitles you choose, chapters, details and the thumbnail as cover.
- **Audio:** the sound only, as **M4A** (the original, not re-encoded), **MP3** (plays everywhere), **Opus** (the original, smallest) or **WAV** (for audio editors), with the cover art cropped square and the song's details. The **?** button explains which to pick.

The popup remembers your last choice of Video or Audio and of audio format. Until you pick, it chooses Audio by itself for YouTube Music links, "Topic" channels and videos YouTube lists as music. For a video in a playlist you can download just that video or the whole playlist, into a folder named after it.

**Subtitles** are a list you build per download: add as many languages as you like, or none (the default). The menu has the creator's subtitles, the automatic captions as spoken, and YouTube's automatic translations into 100+ languages.

## Install

The extension isn't in the Chrome Web Store (the store doesn't allow YouTube downloaders): you build it from this project and load it into the browser yourself. You need [Git](https://git-scm.com) and [Node.js](https://nodejs.org) 22 or newer.

**1. Get the project.**

```sh
git clone https://github.com/slvdr510/yt-dlp-extension.git
cd yt-dlp-extension
```

**2. Build it.** In the project's folder:

```sh
npm install && npm run build
```

`npm install` fetches Pyodide and the other tools; `npm run build` downloads yt-dlp from PyPI and puts the finished extension in the `dist` folder.

**3. Load it into the browser.**

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the project's `dist` folder.
3. Pin the extension (the puzzle-piece icon in the toolbar) so its icon is always at hand.

It works in Chrome, Chromium, Brave, Edge and Vivaldi, version 137 or newer. Chrome shows a notice about developer-mode extensions: that's expected for extensions loaded this way. Keep the project folder where it is: the browser runs the extension straight from `dist`.

### Updating

YouTube changes often and yt-dlp follows, so update now and then. In the project's folder:

```sh
git pull                        # brings the latest changes from GitHub
npm install && npm run build    # builds the extension again into dist
```

Then open `chrome://extensions` and click the reload arrow (↻) on the extension's card. Chrome doesn't pick up the new files until you do. Your settings are kept, since it's the same `dist` folder.

## Options

The gear in the popup opens the options. Everything is saved at once and applies to the next download.

### Quality and formats

| Option | Default | What it does |
| --- | --- | --- |
| When it's a video, quality | Up to 1080p | Best available, or a maximum: 4K, 1440p, 1080p, 720p or 480p. The popup starts at the highest quality the video has up to this, and you can change it per download. |
| Save audio as | M4A | M4A, MP3, Opus or WAV. Also set by the format menu in the popup. |
| Prefer H.264 video | Off | Video that plays on every device. The very best quality is often AV1 or VP9, which some older devices can't play. |

### File names

Each file is named from a template, with a live preview below it.

| Option | Default |
| --- | --- |
| Videos | `{title}` |
| Audio | `{artist} - {track}` |
| Underscores instead of spaces | On |
| Number a playlist's files by their place in it (`01 - Title`) | Off |

Click a field to add it to a template:

| Field | What it holds |
| --- | --- |
| `{title}` | The video's title |
| `{channel}` | Who uploaded it |
| `{artist}` | The song's artist (else the channel) |
| `{track}` | The song's name (else the title) |
| `{date}` | When it came out (`2024-05-31`) |
| `{id}` | The site's ID for it |

A field the video doesn't have is left out together with its separator, so `{date} - {title}` becomes just the title. Names are cleaned so they work on Windows, macOS and Linux.

### Details inside the file

What gets written into the file's metadata, the way yt-dlp's `--embed-metadata` does it. All on by default:

| Option | What it writes |
| --- | --- |
| Title, artist, album, date and genre | The video's or song's details |
| The video's description | The full description (where players show "description") |
| The video's link | The address, as the comment and as `purl` |
| The thumbnail as cover art | The thumbnail; square for audio |
| Chapters | The video's chapters, to jump between them in players such as VLC (Playback → Chapter). MP4 and M4A only. |

MP4, M4A, MP3 and WAV get these details (WAV only the basic ones). Opus files, and files that can't be joined into MP4, are saved as they come.

### Logins

Age-restricted, members-only or private videos need you to be logged in. The extension first tries without a login, and uses this browser's logins **only when a site asks for one**, since downloading a lot with an account can get it flagged.

**Log in with another browser:** pick the browser and your system, and the options show where that browser keeps its cookies; select the file. Firefox works on every system. Chrome, Brave, Edge and other Chromium browsers only work on Linux without a system keyring, since Windows, macOS and most Linux desktops encrypt their cookies so only the browser itself can read them. For those, export a `cookies.txt` file with a cookies.txt extension and import that. Imported cookies stay only in this extension; **Remove** deletes them.

### Pauses in playlists

These keep sites from flagging the downloads; raise them for very long playlists.

| Option | Default |
| --- | --- |
| Between videos, at least | 10 s |
| …plus a random extra up to | 10 s |
| Between requests | 0.75 s |
| Between subtitles | 1 s |

## Limits

- Live streams aren't supported yet (download them once they've ended).
- DRM-protected videos and music (Netflix, Disney+, paid films, Spotify…) can't be downloaded.
- When a site's best format can't go into MP4 (some only offer WebM), the original files are saved as they are, with a note.
- Downloads run one at a time, in the background; they keep going when the popup is closed, but stop if the browser closes.

## Use it responsibly

Only download what you have the right to: your own videos, content under a license that allows it, or what the law where you live allows for personal use. Downloading from YouTube and other sites may go against their terms of service. You're responsible for what you download with this extension.

## How it works

**Yes, it's the real yt-dlp.** The extension ships the official, unmodified yt-dlp package from PyPI (the version is in `versions.json`; `npm run vendor` downloads it and checks it against PyPI's checksum). It runs in [Pyodide](https://pyodide.org), Python compiled to WebAssembly, in an offscreen document of the extension.

**What yt-dlp does: the extraction.** It reads the page, solves YouTube's JavaScript challenges, picks the formats and returns the title, formats, subtitles, chapters, thumbnail and the rest: what `yt-dlp --dump-json` would give. So all of its extractors work, for every site it supports.

**What's adapted so it runs in a browser** (`extension/engine/glue.py`):

- Its network requests go through the browser's `fetch()` instead of its own HTTP client.
- YouTube's JavaScript challenges are solved by yt-dlp's official solver scripts (`yt-dlp-ejs`), run in a sandboxed extension page instead of Deno or Node.
- It runs with `skip_download`: it doesn't download anything itself.

**What the extension does, in JavaScript:**

- Downloads the files (HLS streams too), with progress (`extension/engine/download.js`).
- Joins video and audio into one MP4 and embeds subtitles, chapters, details and cover (`extension/engine/mp4out.js`). yt-dlp would need ffmpeg for this; here there's no ffmpeg and no file size limit.
- Converts to MP3 or WAV (`extension/engine/audio.js`, with the lamejs MP3 encoder).
- Names the files from your templates and saves them.

In short: yt-dlp decides what to download and from where; the extension downloads it and builds the final file. That's why updating yt-dlp (see below) is enough to keep up with YouTube's changes.

To feel quick, yt-dlp starts loading as soon as you open a YouTube video, and its cache (YouTube's solved challenges) is kept between browser restarts.

## For maintainers

```sh
npm install           # Pyodide, Playwright and its Chromium (for the tests)
npm run vendor        # puts the yt-dlp version from versions.json (and the MP3 encoder) into extension/vendor
npm run build         # vendor, then dist/ (load it unpacked)
npm run dev           # dist/, kept in sync with extension/ (load it unpacked)
npm test              # unit tests (MP4 writer, subtitles)
npm run test:e2e      # the real extension in Chromium, against local test media
ONLINE=1 npm run test:e2e   # also real YouTube downloads
```

**New yt-dlp release:** set its version in `versions.json`, bump `version` in `extension/manifest.json`, then run `npm run build` and the tests (including `ONLINE=1`). `npm run vendor` checks the download against PyPI's checksum and fetches the `yt-dlp-ejs` version that yt-dlp release expects.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md): you can use, change and share it for any noncommercial purpose. Commercial use isn't allowed.

`npm run build` downloads other projects into the extension, each under its own license: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense), [Pyodide](https://pyodide.org) (MPL-2.0) and [lamejs](https://www.npmjs.com/package/@breezystack/lamejs) (LGPL-3.0, its license goes along in `extension/vendor`).
