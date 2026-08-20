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
    // Discord's OAuth redirect lands here with ?code=...&state=... in the
    // query string — served by the main SPA itself (index.html), which
    // checks its own path on load and handles the exchange client-side.
    // No separate page needed; same reasoning as /metas/ above, just
    // pointed at index instead.
    if (url.pathname === '/discord/callback') {
      url.pathname = '/';
      return env.ASSETS.fetch(new Request(url, request));
    }
    // /support opens the New Ticket modal on index.html directly, same
    // redirect-to-index approach as /discord/callback above -- there's no
    // standalone support.html, so this maps straight to index.html's own
    // ?ticket=1 handling instead.
    if (url.pathname === '/support') {
      url.pathname = '/';
      url.searchParams.set('ticket', '1');
      return env.ASSETS.fetch(new Request(url, request));
    }
    // /download is now a real standalone page (download.html) rather than
    // a redirect into index.html's #download anchor -- Cloudflare Pages'
    // own clean-URL resolution in env.ASSETS.fetch() already serves it at
    // this path with no rule needed here, same as /metas serving
    // metas.html with nothing special beyond the /metas/ case above.
    const response = await env.ASSETS.fetch(request);
    // Advanced Mode (this file) replaces Cloudflare Pages' normal request
    // handling entirely, which means the usual _headers-file cache-control
    // mechanism never runs either -- env.ASSETS.fetch() was serving every
    // static file (logos, favicons, panorama.js) with its bare default of
    // max-age=0, must-revalidate, so the browser re-validated them on
    // every single repeat visit instead of using its own cache (flagged by
    // Lighthouse's "efficient cache lifetimes" audit). None of these
    // filenames are content-hashed, so a long cache is only safe because
    // they change rarely -- swapping one of these files for a genuinely
    // different image under the same name won't show up site-wide for up
    // to CACHE_MAX_AGE for anyone who already has it cached.
    if (CACHEABLE_PATH.test(url.pathname)) {
      const cached = new Response(response.body, response);
      cached.headers.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}, stale-while-revalidate=86400`);
      return cached;
    }
    return response;
  }
};

const CACHE_MAX_AGE = 2592000; // 30 days
const CACHEABLE_PATH = /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|js)$/i;
