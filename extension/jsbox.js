// A sandboxed page (extension pages can't eval): runs yt-dlp's challenge-solver
// scripts for YouTube and returns what they print.
addEventListener('message', (e) => {
  const { id, code } = e.data;
  const out = [];
  const errors = [];
  const console = { log: (...a) => out.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')), warn() {}, info() {}, debug() {} };
  try {
    new Function('console', code)(console);
    e.source.postMessage({ id, out: out.join('\n'), err: errors.join('\n') }, '*');
  } catch (err) {
    e.source.postMessage({ id, out: '', err: String(err?.stack || err) }, '*');
  }
});
