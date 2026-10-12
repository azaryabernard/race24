# Start here — 24 RACE (family edition)

## A. Play Solo Mode immediately

Extract the project, then run in the project folder:

```bash
npm run build
python -m http.server 4173 -d dist
```

Open http://localhost:4173. Solo Mode, difficulty, card operations, the timer, light/dark mode, and **local personal records work without any backend**.

You can also upload the **extracted `dist` folder** to Netlify Drop to publish this guest-only website. The online features will stay unavailable until Supabase is configured.

## B. Add your family leaderboard on Supabase

1. Create a Supabase project. In **Authentication → Providers → Anonymous sign-ins**, **enable anonymous sign-ins**. No Google/email setup is needed.
2. In the **SQL Editor**, run both files, **in order**:
   - `supabase/migrations/001_initial.sql`
   - `supabase/migrations/002_family_keys.sql`
3. Create a strong random bootstrap secret (at least 24 characters), e.g. `openssl rand -hex 24`. Store it **only** in **Supabase Edge Function Secrets** named `FAMILY_SETUP_SECRET` (or use `npx supabase secrets set FAMILY_SETUP_SECRET=...`). Do **not** add it to Netlify or the browser.
4. Configure Netlify environment variables **for building the website**:

   ```text
   SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   SUPABASE_PUBLISHABLE_KEY=YOUR-PUBLIC-PUBLISHABLE-KEY
   ```

   Both are client-safe public project settings. Never publish your Supabase secret/service-role key.
5. Link to your Supabase project and deploy the **two** functions:

   ```bash
   npm run build
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase functions deploy family
   npx supabase functions deploy solo
   ```

6. Build and deploy the frontend again with those Netlify variables. Use Netlify's linked-repository deployment (the included `netlify.toml` builds and publishes `dist/`). **A prebuilt `dist` ZIP without your two public project values will only support local guest play.**
7. Open the website → **Join family** → **Family organizer tools** → enter your family name and the bootstrap secret from step 3 → **Set up family**. **Copy both displayed keys**:
   - `FAM-...` = code to share with friends and family.
   - `ADM-...` = organizer's private recovery/admin key; do **not** share it.
8. Close the organizer tools and join with a nickname + your new family invitation code. **Save the personal `REC-...` recovery key** displayed after joining.

Read `README.md` for security details and troubleshooting. Online setup requires your own Supabase project and has not been tested against your credentials.

## C. Rotating your family invitation code

Open **Join family** → **Family organizer tools**, paste the `ADM-...` admin key and click **Generate new invitation code**. Copy/share the new `FAM-...` code. The old code stops working immediately. **All existing members, recovery keys, hand records, and leaderboards stay intact.** You do **not** create a new family or transfer a database.

Each player can restore their records on a new device using **Already played before? → Personal recovery key**. They don't need the current family invitation code. A signed-in player can regenerate their recovery key; the previous one immediately stops working.
