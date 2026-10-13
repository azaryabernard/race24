# Race24 multiplayer — first deployment

This version adds **private family multiplayer rooms**, using the existing player identities and math engine. **Solo Mode and family best times remain separate and unchanged.** The multiplayer schema is additive.

## Deployment (in this order)

1. **Back up your Supabase database.** Confirm your project already has migrations `001_initial.sql`, `002_family_keys.sql`, `003_multiple_families.sql`, and `004_difficulty_v2.sql` applied, and that Solo/family accounts work.
2. In Supabase **SQL Editor**, run the full **`supabase/migrations/005_multiplayer.sql`** file. Run it once. It creates `mp_rooms`, `mp_players`, `mp_rounds`, `mp_finishes` and locked-down transaction functions. It does not modify any existing Solo or family best rows.
3. Deploy the NEW multiplayer Edge Function from the project root using a Supabase CLI linked to **your existing project**:

   ```bash
   npx supabase functions deploy multiplayer --use-api
   ```

   `supabase/config.toml` has `[functions.multiplayer] verify_jwt = true`. **No new Supabase secrets are necessary.** Your existing `family` and `solo` functions need no changes.
4. Push the updated website files to GitHub and let Netlify **rebuild** the site with `npm run build` and publish `dist/`. Keep `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) set as **Netlify build** environment variables. They are public publishable credentials, not a service-role key.
5. Check the `zar.moe/race24/` site and your `/race24` proxy rules as before. **Do not manually deploy a prebuilt `dist` compiled without your Supabase environment variables.**

## Two-phone smoke test

- On separate phones/browsers, join **the same existing family** using the family invitation `FAM-...` code. Each player needs a **different personal identity** and nickname. Keep your REC recovery keys private.
- Open the **Multiplayer** tab on Phone A; create a room in **Everyone Finishes**, Mixed, 90s, 5 rounds, 60s grace. Share the new `R24-XXXXXXXX` **room** code with Phone B; this is different from the FAM family invitation code.
- On Phone B, enter the R24 code. Confirm that both nicknames appear. Both players press **Ready**, then the host presses **Start match**.
- Both should see a three-second countdown and then the **same four cards**. The timer shows whole seconds; every browser gets the deadline set by the database, not a local winning time.
- On Phone A, solve first. Everyone Finishes should keep the round going on Phone B until Phone B also solves or the timer/grace expires. Finishing order awards N, N−1, …, 1 points for N players.
- Play another round. Then repeat with **First Wins**: the first server-verified solution should end the round and award 1 point.
- Verify that **Give up / Show solution** and the Solo Deal button are hidden in multiplayer, and **Solo records do not change**.
- Check **Next round**, **New match**, **Leave room**, reconnecting after a refresh, and the host **Remove** button for players who disconnect between rounds.

## Rules and limits

- **2–8 players per room**; each player must belong to the same family, and joining is allowed only while the room is in its initial lobby. Create/join attempts are throttled using the existing rate-limit infrastructure.
- Two modes: `Everyone Finishes` (ranked points, race continues until everyone solves or timer/grace expires), and `First Wins` (first correct proof ends the round, winner earns 1 point).
- Room host can choose 1/3/5/10 rounds, 30/60/90/120 seconds, 0/30/60 seconds grace, and Mixed/Easy/Medium/Hard/Expert difficulty. Grace applies only to Everyone Finishes and never extends the original round deadline.
- **Every player gets identical cards.** The browser sends the complete math expression; the Edge Function verifies it with the exact shared engine; a locked Postgres transaction assigns place, points and server receipt time.
- **The solution is hidden until the round is over.** Solo-only reveal and Solo leaderboard recording do not run in Multiplayer.
- Room state updates by **authenticated polling every ~1.2 seconds**; this MVP does not require configuring Supabase Realtime publications or Broadcast authorization. An optional Realtime push enhancement could reduce status-update latency later. For competitive precision, the authoritative result is the locked server transaction, not the client display.
- If the host or another player needs to leave, **wait until the active round ends**. The host can remove absent players while waiting in the lobby or between rounds. A departing host passes ownership to the oldest remaining player.
- Browsers use a server-time offset for the display timer. Network delivery can still give different users slightly different perceived time; this is a family game, not a latency-normalized professional competition. Browser automation is not preventable merely by math validation.

## Security and privacy

- Multiplayer tables have RLS enabled and **no browser read/write grants or policies**. All room data and transactions go through the JWT-authenticated `multiplayer` Edge Function using a service-role admin client; do not expose your service-role key to Netlify or the browser.
- RPCs are granted only to `service_role`, validate host/room membership, and serialize score updates by locking the room row. New room codes use cryptographically secure random bytes.
- The room code is a private invitation, **not an account password**. Only members of the room's family may use it. If you need broad/public rooms later, use additional rate-limiting, presence, moderation and abuse controls.
- Existing family Solo bests, player recovery keys, and migrations are untouched by `005_multiplayer.sql`.

## Testing status and rollback

The project builds and passes the existing arithmetic tests; desktop/mobile browser simulations cover the create/ready/start/solve/results UI for **both modes**. The Supabase SQL transactions and real two-device network race **cannot be proven from a browser-only test** and must be smoke-tested on your live project after deployment.

Rollback the website via your previous Git/Netlify deployment if necessary. You can leave migration `005` installed until you have verified that its tables contain no needed match data; **do not drop it automatically**, because it may contain match records.
