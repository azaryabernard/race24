# Race24 — add a second family (same website)

This version lets several families share **one Race24 Netlify site + one Supabase project**, with **separate leaderboards, invitation codes, and admin keys**. A player can belong to several families under **one permanent player ID and one personal recovery key**.

## If you ALREADY set up your first family

1. **Back up your database first.** In the Supabase SQL Editor, run **only the new file**:
   `supabase/migrations/003_multiple_families.sql`.
   Do **not** re-run `001_initial.sql` or `002_family_keys.sql` on your existing live project.
2. Redeploy both updated backend functions (from the **new project ZIP**) using the CLI:

   ```bash
   npm run build
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase functions deploy family
   npx supabase functions deploy solo
   ```

3. Push the updated `web/` files (or the whole source project) to GitHub and let Netlify rebuild the Race24 game. The existing `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` stay exactly the same.
4. Open **Player profile → Family organizer tools**. Enter a **new family name** and your existing `FAMILY_SETUP_SECRET` (the original setup secret stored in your Supabase Edge Function Secrets). Click **Create family**.
5. **Save both freshly generated keys**: the new group's `FAM-...` join code and its `ADM-...` admin key. Both are independent of your original family's keys.
6. Join the new group using its `FAM-...` code and a nickname. A returning member retains their existing personal `REC-...` recovery key.
7. In the **Family leaderboard** dropdown, choose the group you want. Each family has its own scoreboard and verified bests. **Deal a new hand after switching** to start a verified run for that group.

Your first family's records are **copied** into the new `family_hand_bests` table during migration; the old `player_hand_bests` table is retained as an archive. The previous family ID, members, nicknames, recovery keys, invite hashes and admin hashes remain untouched. Do not erase the existing tables or create another Supabase project.

**Important:** Deploy the migration and BOTH functions together, as the updated functions rely on the new family-scoped tables and challenges. In-progress verified challenges started before migration need to be restarted after deployment.

## If you have NOT set up Supabase yet

Apply these files **in order** using SQL Editor:

1. `supabase/migrations/001_initial.sql`
2. `supabase/migrations/002_family_keys.sql`
3. `supabase/migrations/003_multiple_families.sql`

Then follow `START_HERE.md` for authentication, secrets, function deployment and Netlify variables. You can create the first family, then return to **Family organizer tools** to create more groups with your private `FAMILY_SETUP_SECRET`.

## How players use multiple families

- **Joining:** Open **Player profile** and fill in **Join a family** with a nickname and that family's `FAM-...` code. No second account is needed.
- **Switching:** Use the **Family leaderboard** dropdown. The selected group is remembered in the browser.
- **Recovery:** One personal `REC-...` key restores **all** joined families and their records after switching browser/device.
- **Rotating invitations:** Open **Family organizer tools**, enter the target family's **own** `ADM-...` admin key, then click **Generate new invitation code**. Only that family's invite changes; neither its scores nor other families are affected.
- **Renaming:** Nicknames can differ between families; editing the nickname applies only to the selected family.
- **Privacy:** Only members can see a family's scoreboard or submit verified runs. Other families' names and records aren't exposed through player status or leaderboard endpoints.

**Personal best distinction:** The displayed online personal bests and combination history are scoped to the selected family. Guest-only scores remain on the device separately and **aren't retroactively uploaded**, as they lack server verification.

## Security and limits

`FAMILY_SETUP_SECRET` is a **server-only owner secret**, used to create every new family. Do not share it with organizers of other families. Instead share their **ADM** key so they can rotate their own family's invite and admin keys without controlling other families. Store each admin key securely; the Supabase Secrets dashboard shows a hash, not the original setup secret. Neither secrets nor recovery keys belong in GitHub, Netlify variables, or public chats.

This is intended for small groups. Anonymous signup + invitation codes are not protection against a determined automated attacker. Server verification makes it harder to submit fake results, but a scripted solver is still possible. Supabase integration has not been tested against your live account; test the upgrade with the first family before creating more groups.
