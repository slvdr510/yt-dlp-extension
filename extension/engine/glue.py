# Connects yt-dlp to the browser: its requests go through fetch(), YouTube's JS
# challenges run in a sandboxed extension page, and extract() hands back the
# video's information as JSON. yt-dlp only extracts here; the extension downloads.
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


@register_rh
class BrowserRH(RequestHandler):
    """Sends yt-dlp's requests through the browser's fetch()."""
    _SUPPORTED_URL_SCHEMES = ('http', 'https')
    _SUPPORTED_PROXY_SCHEMES = None
    _SUPPORTED_FEATURES = None

    def _send(self, request):
        headers = self._get_headers(request)
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


def extract(url, options_json):
    """Extracts `url` with yt-dlp. Options: format (a format spec), playlist (bool).
    Returns JSON: {"info": ..., "log": [...]} or {"error": ..., "log": [...]}."""
    options = json.loads(options_json)
    log = _Log()
    params = {
        'js_runtimes': {'browser': {}},
        'logger': log,
        'noplaylist': not options.get('playlist'),
        'extract_flat': 'in_playlist',
        'format': options.get('format') or 'bv*+ba/b',
        'skip_download': True,
    }
    try:
        with YoutubeDL(params) as ydl:
            info = ydl.extract_info(url, download=False)
            return json.dumps({'info': ydl.sanitize_info(info), 'log': log.lines})
    except Exception as e:
        return json.dumps({'error': str(e), 'log': log.lines})
