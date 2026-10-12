# Serving Race24 at `/race24` (with or without the trailing slash)

**The fix is already included** in `web/index.html`: an early, inline `<script>` adds a `<base>` element based on the browser's URL, before the stylesheet is loaded.

- `https://your-domain.example/race24` → assets load from `/race24/`.
- `https://your-domain.example/race24/` → assets load from `/race24/`.
- `https://your-game.netlify.app/` → assets load from `/`.

No static `<base href="/race24/">` tag is needed. **Do not add one on top of the script.**

## On the MAIN website's Netlify project

Add these rules to the **main site's** `netlify.toml` (not to the Race24 project's `netlify.toml`):

```toml
# Both rules are rewrites/proxies, not browser redirects.
[[redirects]]
  from = "/race24"
  to = "https://YOUR-RACE24-SITE.netlify.app/"
  status = 200

[[redirects]]
  from = "/race24/*"
  to = "https://YOUR-RACE24-SITE.netlify.app/:splat"
  status = 200
```

Replace `YOUR-RACE24-SITE` with your game site's Netlify name and redeploy **the main site**. Do **not** add a `301` rule from `/race24` to `/race24/`: URL-path normalization can make it self-redirect.

`force = true` is **not needed** unless your main site's own published files already occupy those paths, in which case Netlify's file shadowing can take precedence. If in doubt, leave it out.

## On the RACE24 Netlify project

Keep the supplied `netlify.toml` that runs `npm run build` and publishes `dist/`. Deploy the updated project, including `web/index.html` and `web/styles.css`.

**Deploy both sites** if you updated the main site's proxy rules and the Race24 game itself.

## Verify

These URLs must serve CSS and JavaScript (not HTML):

- `https://your-domain.example/race24/styles.css`
- `https://your-domain.example/race24/app.js`
- `https://your-domain.example/race24/engine.js`

If the HTML appears unstyled, check your browser's developer tools Network tab for 404 or HTML responses to these asset requests. The site's proxy configuration must actually forward `/race24/*`.

## Supabase

This visual/subpath update **does not change the Supabase backend, database migrations, functions, or keys**. You can configure Supabase later following `START_HERE.md`.
