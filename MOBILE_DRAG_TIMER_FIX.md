# Race24 — mobile drag + calm timer patch

Source files changed:
- `web/app.js`: release pointer capture after a drag, guard against Safari's extra compatibility click, and wait until the next frame to insert the operation picker on touch release. Operation buttons respond directly on touch release, while preserving normal mouse clicks and keyboard activation. Swap retains its original fixed popup position.
- `web/app.js`: update the visible Solo clock in tenths; freeze it in hundredths, using the precise `performance.now()` difference for recorded times.
- `web/styles.css`: fixed-width timer, improved touch handling for the operation picker.
- `web/index.html`: initial timer `00:00.0`.

Backend database migrations, Supabase Edge Functions, shared math engine, verification and leaderboard behavior are unchanged.

## Deploy

Push the **source project** to your Race24 GitHub repository and let Netlify execute `npm run build`. Keep the existing Netlify Supabase environment variables; the `dist/config.js` generated locally has blank cloud credentials and is **not** a suitable manual upload for online play. The generated JS and CSS receive new content-hash URL query parameters.

No Supabase migration or function deployment is necessary for this patch.

## QA

- 17 math tests passed (`npm test`).
- Browser tests passed in Chromium with real touch-event emulation at iPhone-size (390px) and Android-size (412px), plus desktop mouse at 1280px: drag onto card + one tap on operator, tapping two cards + one tap, swap staying in place, undo, forfeiting, frozen hundredths timer, no horizontal scrolling.
- Actual Safari on a physical iPhone must be confirmed by testing after deployment; Chromium's emulation is not WebKit.
