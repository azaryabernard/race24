# Fix: `/app.js` MIME error and `DIFFICULTY_VERSION` missing

The Difficulty v2 solver **does** export `DIFFICULTY_VERSION = 2`. These two
console errors appear when your public website gets HTML for a JS URL or mixes
assets from old and new deployments. They are not Supabase errors.

## Get back online

1. Redeploy the **Race24 Netlify project** from this full updated source ZIP.
   Netlify must run `npm run build`, publish `dist`, and set Base directory to
   the project folder if your repository has a wrapping `race24/` directory.
   In the Netlify Deploys page, use **Clear cache and deploy site** if offered.
   For manual drag-and-drop, use the _standalone website_ ZIP, not the full
   project ZIP, and ensure its five files are in the publish root.
2. Open the game's own `https://YOUR-GAME-SITE.netlify.app/engine.js` URL.
   It must show JavaScript containing `export const DIFFICULTY_VERSION = 2`.
   Also check `/app.js` returns JavaScript and not your homepage.
3. On your **main website** that owns `zar.moe`, keep the 200 rewrite/proxy:
   ```toml
   [[redirects]]
     from = "/race24"
     to = "https://YOUR-GAME-SITE.netlify.app/"
     status = 200
   [[redirects]]
     from = "/race24/*"
     to = "https://YOUR-GAME-SITE.netlify.app/:splat"
     status = 200
   ```
   Place these **above** any catch-all SPA rewrite (e.g. `/* -> /index.html`).
   If `/race24` or `/race24/*` exists as actual published content on your main
   site, Netlify file shadowing might block the proxy; check for collisions
   before considering `force = true`.
4. Visit `https://zar.moe/race24/` (with the **trailing slash**) and refresh
   with the browser cache disabled. Direct URLs
   `https://zar.moe/race24/app.js` and `/race24/engine.js` must return
   JavaScript, not HTML. Search the engine response for `DIFFICULTY_VERSION`.
5. Deploy the main Netlify website **only if you edited its redirect rules**.

## Prevention in this release

The build now generates fingerprinted asset references (e.g.
`./app.js?v=abcdef...` and `./engine.js?v=123456...`). Every updated engine
gets a new URL; browsers and the `/race24` proxy should not silently reuse a
stale engine with a newer app. HTML is marked for revalidation in the game
site's Netlify config. The dynamic base URL for `/race24` and `/race24/` is
preserved, as is the standalone Netlify root URL.

**No new SQL migration, Supabase settings, or Edge Function changes are
required to fix these two console errors.** If Difficulty v2 hasn't been fully
deployed yet, still follow `DIFFICULTY_V2_SETUP.md` for its regular backend
migration/function deployment.
