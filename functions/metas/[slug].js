// Cloudflare Pages Function for /metas/<slug>.
//
// The _redirects rule (/metas/* -> /metas.html, 200) should have handled
// this, but Cloudflare Pages has an automatic implicit-redirect step for
// nested paths under an existing .html file's name that runs BEFORE
// custom _redirects rules are consulted — it was silently overriding ours
// and 308-redirecting every /metas/<slug> request straight to bare
// /metas, which is exactly the "distinct URL that isn't really a distinct
// page" problem this was supposed to fix in the first place.
//
// Pages Functions are matched before both static-asset resolution and
// _redirects, so this can't be overridden the same way — it fetches
// metas.html's real content directly and returns it with a 200 status
// for the original /metas/<slug> URL, unchanged.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  url.pathname = '/metas.html';
  return context.env.ASSETS.fetch(new Request(url, context.request));
}
