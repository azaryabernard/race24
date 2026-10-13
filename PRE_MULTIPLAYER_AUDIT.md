# Race24 — pre-multiplayer audit (13 October 2026)

Audited source: user's `race24(3).zip`. **No gameplay, engine, Edge Function, or SQL migration files were modified** during this review. This document accompanies the cleaned source archive.

## Passed (local and source inspection)

- `npm run build`: passes, with `dist/app.js`, `dist/engine.js`, `dist/styles.css` and versioned references in `dist/index.html`. The new build matched every corresponding file already in the uploaded `dist/` exactly.
- `npm test`: 17/17 tests pass. The exhaustive difficulty test covers all 715 four-value combinations, including 98 unsolvable cases. Shared engine is byte-identical to Supabase `_shared/engine.js`. Examples: `5-7-10-10` Medium; `3-3-8-8` Expert.
- In-browser desktop (1280x840) and mobile (390x844) smoke tests using the supplied source: deal hand, numbers-first operations, operation-first taps, drag/drop operation picker, Swap with stable popup position, operation reset, Undo, Give Up and three-step solution, theme change, no horizontal overflow. Tests run in an isolated browser with a deliberately injected test hand and stubbed cloud configuration. Browser tests do NOT prove live Supabase behavior or that the zar.moe proxy is correct.
- Source review: both Edge Functions require authenticated requests; `solo` verifies family membership and math expression before attempting to record results; the SQL record RPC scopes to the original challenge family and locks the challenge against duplicate records; direct browser DB writes to family and scoring tables are revoked and RLS enabled. This was a code-only review, **not** a live security penetration test.
- Four migrations present: 001 (core), 002 (families and keys), 003 (multiple families), 004 (difficulty v2 backfill). No schema changes performed in the user's live project.

## Important before implementing real multiplayer

1. **Server-authoritative match lifecycle (required).** No rooms, ready-state, shared round deadlines, placements, or real-time broadcast are in this project yet. Implement with new multiplayer tables/RPCs/Edge Function and authorized private Realtime channels. Use one server-controlled starting time, deadline, first-solve time, optional grace deadline, verified ranked finishes, and transaction-safe end-of-round logic. First Wins and Everyone Finishes can share this foundation.
2. **Fair timing (required).** In Solo, `solo_challenges.started_at` is assigned on the server before the browser receives cards and calls `beginClock()`. Therefore local stopwatch and online recorded time may differ by network latency. For multiplayer, schedule future starts, calculate finish order on the server, and use the displayed timer only as a synchronized visualization. Never rank by reported client time.
3. **Forfeiture and anti-cheat (required).** Solo `revealSolution()` only clears the challenge ID in the browser; it does not mark a server challenge forfeited. That's sufficient for the normal Solo UI, not a server-enforced competitive forfeit. Multiplayer should have a server-side `forfeit`/`finished` status, reject additional submissions once forfeited or expired, and hide the reveal control for the entire active multiplayer round. Also note the four cards and JS solver are visible to advanced users, so you cannot make a purely browser game completely cheat-proof.
4. **Asset versioning (recommended).** The current build appends `?v=<hash>` to JS/CSS URLs but still publishes fixed physical filenames (`app.js`, `engine.js`). This is better than plain URLs, but a cache/proxy that ignores query strings can still mix versions. Consider content-hashed *file names* and suitable immutable caching before substantial frontend expansion. **The main zar.moe proxy config is not included in this ZIP**; check it separately.
5. **Live deployment checks (required).** Confirm Netlify project base directory, `npm run build`, publish `dist`, and environment variables `SUPABASE_URL` and **public** `SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_ANON_KEY`. The ZIP's prebuilt `dist/config.js` is intentionally empty and therefore *guest-only* if deployed without a rebuild. Ensure the main site's `/race24` and `/race24/*` 200 proxies appear before any SPA catch-all, and that `.js` endpoints serve JavaScript. Verify deployed Edge Function versions and that migration 004 has run. Never put `FAMILY_SETUP_SECRET` or service-role credentials into Netlify browser build variables.
6. **Third-party SDK loading (recommended).** Online features currently load `@supabase/supabase-js` dynamically from a public CDN. For dependable real-time multiplayer, bundle/pin a tested version locally, with a clear connection/reconnect indicator.
7. **Family switching and data freshness (minor).** Switching family while a Solo run is in progress retains the original challenge family (good) but changes the visible leaderboard. In multiplayer, block or explicitly handle room/family switches during a match. Subscription reconnects, tab suspension, and joins after a round starts need explicit handling.

## What I could not verify here

- Live `zar.moe` and the main site's Netlify redirect order, or whether every public asset currently has the right MIME type and cache headers.
- Real Supabase anonymous sign-in, your deployed function versions, the current database schema, existing records and their consistency, or RLS against live keys. No privileged credentials were provided, and none are needed for this local review.
- Real multi-user synchronization, disconnect/rejoin, timing races, and live websocket behavior: multiplayer does not exist yet.

## Read-only post-deploy SQL verification

Run `PRE_MULTIPLAYER_CHECKS.sql` in Supabase's SQL Editor after migration 004. These checks do not change records.

## Summary

**Good baseline for multiplayer; not yet a multiplayer-ready backend.** Preserve Solo and family membership behavior, implement a separate server-owned match lifecycle, and verify the deployment and SQL checklist before enabling live matches.
