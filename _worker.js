// Cloudflare Pages "Advanced Mode" worker — takes complete manual control
// over every request, which is the only thing that actually worked.
//
// Two earlier attempts at this both got silently overridden by Cloudflare
// Pages' own automatic implicit redirect for nested paths under an
// existing .html file's name (confirmed via DevTools: /metas/<slug>
// always came back as a fresh, non-cached 308 to bare /metas, even with
// a matching _redirects rule present and even with a functions/metas/
// [slug].js Pages Function in place — neither one actually intercepted
// the request before that automatic redirect fired). A root _worker.js
// replaces Cloudflare's whole default request pipeline for this project,
// so there's no automatic behavior left to race against.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/metas/')) {
      url.pathname = '/metas.html';
      return env.ASSETS.fetch(new Request(url, request));
    }
    // Everything else: identical to Cloudflare Pages' own default behavior
    // (this is the same asset server it would have used automatically).
    return env.ASSETS.fetch(request);
  }
};
