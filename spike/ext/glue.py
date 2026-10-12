import io
import js
from pyodide.ffi import run_sync, to_js

from yt_dlp.networking.common import RequestHandler, Response, register_rh, register_preference
from yt_dlp.networking.exceptions import HTTPError, TransportError
from yt_dlp.globals import supported_js_runtimes
from yt_dlp.utils._jsruntime import JsRuntime, JsRuntimeInfo
from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP
from yt_dlp.extractor.youtube.jsc.provider import register_provider, register_preference as jcp_preference, JsChallengeProviderError
from yt_dlp.extractor.youtube.pot._provider import BuiltinIEContentProvider


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
            res = run_sync(js.lvFetch(request.url, request.method, to_js(headers, dict_converter=js.Object.fromEntries),
                                      to_js(data) if data else None, self._calculate_timeout(request) or 30))
        except Exception as e:
            raise TransportError(cause=e) from e
        response = Response(io.BytesIO(res.body.to_bytes()), res.url, res.headers.to_py(), res.status)
        if not 200 <= response.status < 300:
            raise HTTPError(response)
        return response


@register_preference(BrowserRH)
def _browser_first(rh, request):
    return 1000


class BrowserJsRuntime(JsRuntime):
    def _info(self):
        return JsRuntimeInfo(name='browser', path='browser', version='1', version_tuple=(1,), supported=True)


supported_js_runtimes.value['browser'] = BrowserJsRuntime


@register_provider
class BrowserJCP(EJSBaseJCP, BuiltinIEContentProvider):
    """Solves YouTube's JS challenges with the browser's own JS engine (in a sandboxed page)."""
    PROVIDER_NAME = 'browser'
    JS_RUNTIME_NAME = 'browser'

    def _run_js_runtime(self, stdin, /):
        res = run_sync(js.lvRunJs(stdin))
        if res.err:
            raise JsChallengeProviderError(f'JS error: {res.err[:500]}')
        return res.out


@jcp_preference(BrowserJCP)
def _browser_jcp(provider, requests):
    return 1000
