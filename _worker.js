// Cloudflare Pages "Advanced Mode" worker — takes complete manual control
// over every request.
//
// The actual root cause (found via DevTools across three failed attempts —
// _redirects, a Pages Function, and an earlier version of this worker):
// env.ASSETS.fetch() — Cloudflare's own internal asset resolver, which
// every one of those approaches ultimately calls into — auto-redirects
// any request for an EXPLICIT ".html" path to its clean-URL equivalent
// (e.g. a request for /metas.html itself gets 308'd to /metas). That
// redirect was firing from inside the fetch call itself, not from
// routing precedence, so nothing that dispatched to "/metas.html" could
// ever have avoided it — including the previous version of this file.
// Requesting the already-clean "/metas" path instead sidesteps it
// entirely, since Cloudflare has nothing left to canonicalize.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/metas/')) {
      url.pathname = '/metas';
      return env.ASSETS.fetch(new Request(url, request));
    }
    // Everything else: identical to Cloudflare Pages' own default behavior
    // (this is the same asset server it would have used automatically).
    return env.ASSETS.fetch(request);
  }
};
