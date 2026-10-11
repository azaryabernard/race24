# Race24 — Difficulty v2 update (before multiplayer)

This release improves **only the difficulty estimator**. All four-card rules, Ace choices,
exact math verification, accounts, family memberships, and original fastest-time records
remain intact. `RULES_VERSION` stays **1**; `DIFFICULTY_VERSION` is **2**.

## What's changed

- The solver first searches **+ − × ÷ only**, and uses powers/logs/roots only
  when there is no solution using basic arithmetic.
- It measures the simplest solution's mental arithmetic cost: multiplying is
  somewhat harder than adding, exact division costs more, and negative, large,
  or fractional intermediate results are penalized.
- It also counts **distinct useful opening moves** that can still lead to 24
  using reasonably straightforward basic arithmetic. This count is based on
  unique remaining-number states, not on arbitrary DFS pruning order.
- Easy (straightforward or many good openings), Medium (some planning), Hard
  (fewer good openings or harder arithmetic), and Expert (advanced-only or
  exceptionally intricate fraction work) are estimates, not a guarantee about
  individual players. The groups are not designed to be equal-sized.

Examples: 6–6–6–6 → **Easy**; 5–7–10–10 → **Medium**;
4–4–10–10 → **Hard**; 3–3–8–8 → **Expert**.

## Deployment order

1. **Back up your Supabase database**, especially `public.hands`,
   `public.family_hand_bests` and `public.player_hand_bests`. Finish any currently
   running timed rounds if you can.
2. Open **Supabase → SQL Editor** and run the entire
   `supabase/migrations/004_difficulty_v2.sql` **once**. The prerequisites are
   `001_initial.sql`, `002_family_keys.sql`, and `003_multiple_families.sql`.
   It's safe to rerun 004 if needed. It updates the difficulty/score labels for
   all known canonical hands and the difficulty labels of verified bests;
   **no best-time, player, family, or account rows are deleted or reset.**
3. Deploy the updated **`solo` Edge Function** (with the matching updated
   `supabase/functions/_shared/engine.js`). If using the Supabase CLI:
   `npx supabase functions deploy solo --use-api`
4. Deploy the updated site from this project through GitHub/Netlify, using your
   existing environment variables. `npm run build` updates `dist/`.
5. Verify `5–7–10–10` shows **Medium**, verify a historical personal best is
   still present, and check one family leaderboard category.

You do **not** need to redeploy the `family` Edge Function or change any
Supabase secrets for this release. No additional SQL tables or RLS policies
are created. No new multiplayer features are included yet.

The browser upgrades old *local* hand ratings on load while retaining all times
and attempt counts. The SQL migration upgrades *online* ratings and verified
leaderboard records. If an old `solo` Edge Function is still running when the
new frontend loads, online play is automatically bypassed for that draw rather
than mixing incompatible labels; it falls back to local play.

## Regenerating the SQL mapping

Run `node scripts/generate-difficulty-migration.mjs` from the project root.
This produces the same 617 solvable-hand rows in the migration using the shared
math engine (all 715 unique four-value hands are checked; 98 are unsolvable).
Do not hand-edit the mapping separately from the engine.
