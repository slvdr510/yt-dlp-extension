# Connects yt-dlp to the browser: its requests go through fetch(), YouTube's JS
# challenges run in a sandboxed extension page, and extract() hands back the
# video's information as JSON. yt-dlp only extracts here; the extension downloads.
import hashlib
import hmac
import io
import json

import js
from pyodide.ffi import run_sync, to_js

from yt_dlp import YoutubeDL
from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP
from yt_dlp.extractor.youtube.jsc.provider import JsChallengeProviderError, register_provider
from yt_dlp.extractor.youtube.jsc.provider import register_preference as register_jcp_preference
from yt_dlp.extractor.youtube.pot._provider import BuiltinIEContentProvider
from yt_dlp.globals import supported_js_runtimes
from yt_dlp.networking.common import RequestHandler, Response, register_preference, register_rh
from yt_dlp.networking.exceptions import HTTPError, TransportError
from yt_dlp.utils._jsruntime import JsRuntime, JsRuntimeInfo


if not hasattr(hashlib, 'pbkdf2_hmac'):
    # Pyodide's hashlib has no OpenSSL: yt-dlp needs PBKDF2 to decrypt Chromium cookies.
    def _pbkdf2_hmac(hash_name, password, salt, iterations, dklen=None):
        size = hashlib.new(hash_name).digest_size
        dklen = dklen or size
        out = b''
        block = 1
        while len(out) < dklen:
            u = hmac.new(password, salt + block.to_bytes(4, 'big'), hash_name).digest()
            t = int.from_bytes(u, 'big')
            for _ in range(iterations - 1):
                u = hmac.new(password, u, hash_name).digest()
                t ^= int.from_bytes(u, 'big')
            out += t.to_bytes(size, 'big')
            block += 1
        return out[:dklen]

    hashlib.pbkdf2_hmac = _pbkdf2_hmac


@register_rh
class BrowserRH(RequestHandler):
    """Sends yt-dlp's requests through the browser's fetch()."""
    _SUPPORTED_URL_SCHEMES = ('http', 'https')
    _SUPPORTED_PROXY_SCHEMES = None
    _SUPPORTED_FEATURES = None
    # With imported cookies, yt-dlp's own cookie jar is sent instead of the browser's cookies.
    use_jar = False

    def _send(self, request):
        headers = self._get_headers(request)
        if BrowserRH.use_jar:
            cookie = self._get_cookiejar(request).get_cookie_header(request.url)
            if cookie:
                headers['Cookie'] = cookie
        data = request.data
        if data is not None and not isinstance(data, (bytes, bytearray)):
            data = data.read() if hasattr(data, 'read') else bytes(data)
        try:
            res = run_sync(js.bridgeFetch(
                request.url, request.method, to_js(headers, dict_converter=js.Object.fromEntries),
                to_js(data) if data else None, self._calculate_timeout(request) or 30))
        except Exception as e:
            raise TransportError(cause=e) from e
        response = Response(io.BytesIO(res.body.to_bytes()), res.url, res.headers.to_py(), res.status)
        if not 200 <= response.status < 300:
            raise HTTPError(response)
        return response


@register_preference(BrowserRH)
def _prefer_browser(rh, request):
    return 1000


class BrowserJsRuntime(JsRuntime):
    def _info(self):
        return JsRuntimeInfo(name='browser', path='browser', version='1', version_tuple=(1,), supported=True)


supported_js_runtimes.value['browser'] = BrowserJsRuntime


@register_provider
class BrowserJCP(EJSBaseJCP, BuiltinIEContentProvider):
    """Solves YouTube's JS challenges with the browser's JS engine, in a sandboxed page."""
    PROVIDER_NAME = 'browser'
    JS_RUNTIME_NAME = 'browser'

    def _run_js_runtime(self, stdin, /):
        res = run_sync(js.bridgeRunJs(stdin))
        if res.err:
            raise JsChallengeProviderError(f'JS error: {res.err[:500]}')
        return res.out


@register_jcp_preference(BrowserJCP)
def _prefer_browser_jcp(provider, requests):
    return 1000


class _Log:
    def __init__(self):
        self.lines = []

    def debug(self, msg):
        if not msg.startswith('[debug] '):
            self.lines.append(msg)

    info = debug

    def warning(self, msg):
        self.lines.append(f'WARNING: {msg}')

    def error(self, msg):
        self.lines.append(f'ERROR: {msg}')


COOKIE_FILE = '/cookies.txt'
CACHE_DIR = '/cache'  # kept in IndexedDB by ytdlp.js


def extract(url, options_json):
    """Extracts `url` with yt-dlp. Options: format (a format spec), playlist (bool),
    cookies (cookies.txt text to log in with, instead of the browser's cookies).
    Returns JSON: {"info": ..., "log": [...]} or {"error": ..., "log": [...]}."""
    options = json.loads(options_json)
    log = _Log()
    cookies = options.get('cookies')
    BrowserRH.use_jar = bool(cookies)
    if cookies:
        with open(COOKIE_FILE, 'w', encoding='utf-8') as f:
            f.write(cookies)
    params = {
        'js_runtimes': {'browser': {}},
        'logger': log,
        'noplaylist': not options.get('playlist'),
        'extract_flat': 'in_playlist',
        'format': options.get('format') or 'bv*+ba/b',
        'skip_download': True,
        'cachedir': CACHE_DIR,
    }
    if cookies:
        params['cookiefile'] = COOKIE_FILE
    try:
        with YoutubeDL(params) as ydl:
            info = ydl.extract_info(url, download=False)
            return json.dumps({'info': ydl.sanitize_info(info), 'log': log.lines})
    except Exception as e:
        return json.dumps({'error': str(e), 'log': log.lines})


def has_extractor(url):
    """Whether one of yt-dlp's site extractors takes `url` (not the generic one,
    which takes any page). Only matches the URL: nothing is fetched."""
    from yt_dlp.extractor import gen_extractor_classes
    return any(ie.ie_key() != 'Generic' and ie.suitable(url) for ie in gen_extractor_classes())


IMPORT_DIR = '/import'


def import_cookies(kind):
    """Reads the cookies the user picked (saved in /import) with yt-dlp's own readers.
    kind: 'txt' (a cookies.txt), 'firefox', or a Chromium-based browser ('chrome',
    'chromium', 'brave', 'edge', 'vivaldi', 'opera'). Returns JSON: {"text": the
    cookies as a cookies.txt, "count", "domains", "log"} or {"error", "log"}."""
    import os
    import sqlite3

    from yt_dlp.cookies import YDLLogger, YoutubeDLCookieJar, extract_cookies_from_browser

    log = _Log()
    try:
        if kind == 'txt':
            jar = YoutubeDLCookieJar(f'{IMPORT_DIR}/cookies.txt')
            jar.load(ignore_discard=True, ignore_expires=True)
        else:
            db = f'{IMPORT_DIR}/cookies.sqlite'
            if kind == 'firefox' and os.path.exists(f'{db}-wal'):
                # The newest cookies are still in the write-ahead log: merge it in,
                # since yt-dlp reads a copy of the main file only.
                con = sqlite3.connect(db)
                con.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                con.close()
            with YoutubeDL({'logger': log, 'verbose': True}) as ydl:
                # No system keyring here: only cookies not protected by one can be read.
                keyring = None if kind == 'firefox' else 'BASICTEXT'
                jar = extract_cookies_from_browser(kind, IMPORT_DIR, YDLLogger(ydl), keyring=keyring)
        out = YoutubeDLCookieJar(f'{IMPORT_DIR}/out.txt')
        for c in jar:
            out.set_cookie(c)
        out.save(ignore_discard=True, ignore_expires=True)
        with open(f'{IMPORT_DIR}/out.txt', encoding='utf-8') as f:
            text = f.read()
        domains = sorted({c.domain.lstrip('.') for c in jar})
        return json.dumps({'text': text, 'count': len(out), 'domains': domains, 'log': log.lines})
    except Exception as e:
        return json.dumps({'error': str(e), 'log': log.lines})
