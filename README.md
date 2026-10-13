> **Multi-family update:** Race24 now supports multiple private families on the same website. To upgrade an existing Supabase project without losing the original family, see **[MULTI_FAMILY_SETUP.md](MULTI_FAMILY_SETUP.md)**.

# 24 RACE — Family edition

Netlify-ready Solo Time Trial with a shared exact math engine and optional private Supabase family leaderboards. Multiplayer rooms are a future phase; the shared engine and permanent player IDs support them later.

## Play locally

```bash
npm run build
python -m http.server 4173 -d dist
```

Open http://localhost:4173/. Read **START_HERE.md** for step-by-step Netlify + Supabase setup.

## What is implemented

- Random **solvable** four-card hands with no more than two ten-valued cards; `10`, `J`, `Q`, and `K` have the same canonical value. Card order and suit don't change the hand key. Ace is `1` for identification but can be played as `1` or `11`.
- Solo stopwatch and mobile-friendly tap/drag math tiles. Undo, clear, Ace switch; finish only after combining all four cards into exactly 24.
- **Give up / Show solution** under the Solo controls: stops the timer, displays three exact intermediate calculations (including the chosen Ace values), and records **no personal best or online leaderboard time**. Deal cards again to restart. It is intentionally a Solo-only feature; do not make it available in future multiplayer rounds.
- Exact arithmetic using `BigInt` fractions. Rational division is allowed, powers require integer exponents, logs/roots must return exact integers. There is a maximum exponent and a 256-bit size guard.
- Heuristic Easy/Medium/Hard/Expert ratings based on search complexity; **not** based on AFK time.
- Local personal records in browser storage, **light/dark mode** saved per device.
- Optional Supabase **anonymous authentication**, nicknames + separate invitation codes per family, **personal recovery key**, private family leaderboards and server-verified times.
- Organizer bootstrap, **admin recovery key**, invitation rotation (does not delete/transfer any records), and optional admin recovery-key rotation.
- Shared engine in `shared/engine.js`, also deployed into the Supabase `solo` function at build time.

## Identity and key roles

**FAM-...** is the shared family invitation code. It is checked by a backend function, never embedded in website JavaScript or stored in plaintext in the database. Rotating it **stops new joins using that family's old code**. The existing family ID, members and records remain unchanged.

**REC-...** is each player's personal high-entropy recovery key. A player whose browser storage was wiped gets a *new* anonymous Supabase session, then enters this key to connect the session back to their **original permanent player ID**. All existing leaderboard records are preserved. The key works even if the family invitation code has changed. Generating a replacement recovery key invalidates the old one.

**ADM-...** is the organizer's high-entropy recovery/admin key, created when bootstrapping the family. It authorizes rotating the family invite or the admin key, and **must not be shared with regular players**. Losing both the admin key and the `FAMILY_SETUP_SECRET` does not automatically allow self-service admin recovery; the project owner would have to reset the admin hash in Supabase securely. A shared `FAM-...` code does not give admin privileges.

The keys are shown **only when generated** and are stored by their SHA-256 hashes. The shared invite code has 64 random bits; individual recovery and admin keys have 192 random bits. Combined with secret server-side storage and throttling, these are suitable for a small family game. The database enforces a five-attempts-per-15-minutes throttle per anonymous auth user for joining, recovering and rotating. This alone does *not* eliminate automated abuse through repeated anonymous signup, so for wider/public deployment enable Supabase Auth CAPTCHA and additional IP-based gateway protections.

**Important privacy note:** anyone who knows a valid recovery key can access that player's profile; treat it like a password. Anyone with the family admin key can rotate family codes. Do not paste either into public chats.

## Family creation (one-time)

1. Create your Supabase project and enable **Anonymous sign-ins** in Authentication settings.
2. Execute `supabase/migrations/001_initial.sql`, then `supabase/migrations/002_family_keys.sql` in SQL Editor. The second migration preserves existing tables and personal bests while restricting public read access.
3. Set **Supabase Edge Function secret** `FAMILY_SETUP_SECRET` (random 24+ characters). Set this secret only in Supabase, not on Netlify.
4. Deploy the two Edge Functions with `npx supabase functions deploy family` and `npx supabase functions deploy solo`. `supabase/config.toml` has `verify_jwt = true`; functions use `@supabase/server` with `auth: 'user'`, so calls require a valid Supabase Auth JWT even for anonymous sign-ins.
5. Set the **Netlify build** variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, then redeploy the website. They are public client settings, never private service keys.
6. On the website, **Join family → Family organizer tools → Set up family**. Enter family name and setup secret. Store both generated keys (`FAM-...` and `ADM-...`). The setup secret cannot create a family without the private setup secret.
7. Join with a nickname and the `FAM-...` code. Store the resulting `REC-...` personal recovery key. Tell invited friends/family the `FAM-...` code, **not** the admin/setup key.

Use a linked Git repository for Netlify continuous deploys; `netlify.toml` publishes `dist/` after `npm run build`. The prebuilt website ZIP is for guest demos unless it is rebuilt with your project URL/key.

## Rotate the invitation code without resetting leaderboard

In the website open **Join family → Family organizer tools**, paste the **ADM** key, click **Generate new invitation code**, and copy the returned new **FAM** code. Share it with any new players. Existing members and verified records remain, and a returning player can recover with their personal **REC** key **without knowing the latest FAM code**.

The organizer can separately regenerate the **ADM** key. That invalidates the old admin key, but does not affect players, recovery keys or the leaderboard.

## Online security model

- Supabase Auth creates **anonymous browser sessions** only when players join, recover or configure the family; a guest may play locally without signing in at all.
- The `profiles.id` is a persistent player identifier; `player_sessions.auth_user_id` maps any restored anonymous session back to that stable identifier. Leaderboard rows reference `profiles.id`, so rotating the invite code or restoring on a new device never changes leaderboard ownership.
- Database table reads are revoked for browser roles. The `family` and `solo` Edge Functions check the Supabase user JWT and family membership before returning private records. Server-only admin clients manage writes.
- The `solo` Edge Function issues a hand and server start time, validates a complete four-card expression using the exact shared engine, and atomically records the minimum time against a permanent player ID. It does **not** import pre-join local guest times, because those were not server-verifiable.
- Official online times include network delay; they're suitable for a casual family competition, not highly precise latency-equalized esports events.
- No browser submission can guarantee a human rather than a bot solved the cards. Family-only sharing and backend checks are reasonable safeguards for casual use, but this is not hardened for prizes or anonymous public competition.

## Data persistence

Guest bests and theme preferences are stored in localStorage; clearing browser storage erases those **local-only** settings and bests. Verified cloud bests live on Supabase and survive browser data deletion if the player retains their personal recovery key. The family code does not have to remain the same.

## Project map

```text
web/                                      Browser UI (including light/dark)
shared/engine.js                          Shared solver, validator and difficulty analyzer
scripts/build.mjs                         Builds dist/ and copies shared solver for backend
supabase/migrations/001_initial.sql        Original core tables/score transaction
supabase/migrations/002_family_keys.sql    First family memberships, recovery, privacy, stable identities
supabase/migrations/003_multiple_families.sql  Family-scoped records and multiple families
supabase/functions/family/index.ts        Bootstrap/join/recover/rotate
supabase/functions/solo/index.ts          Verified challenges and private leaderboard
supabase/functions/_shared/engine.js      Generated by npm run build
netlify.toml                              Netlify build settings
```

Run `npm test` for the arithmetic engine unit tests. This software was tested locally for math and static browser behavior, but **Supabase authentication, recovery and rotation cannot be verified end-to-end without a live project**. Validate the SQL migrations/functions in your Supabase project before relying on records, especially after any schema changes.

## Card controls (tap or drag)

- **Tap two cards** (in the order you want them evaluated) or **drag one card onto another**. A compact operation picker appears beside the pair. Dragged card = first operand, target card = second operand.
- **Choose an operation before selecting the second card** to apply it immediately, without the popup. You can also use **number → operation → number**.
- **Every successful calculation clears the selected operation automatically**. Clicking an already selected operation toggles it off before a pair is complete.
- Use **Swap** in the popup to reverse operand order for subtraction, division, powers, logs or roots. If an operation is invalid, the pair stays selected and the picker reopens so you can try another operation.
- **Clear selection**, **Escape**, **Undo** or dealing a new hand resets the pending operation and dismisses the picker.

These controls are frontend-only; the exact arithmetic rules, server-side verification, and Supabase functions remain unchanged.
