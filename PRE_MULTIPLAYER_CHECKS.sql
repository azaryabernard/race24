-- Race24: READ-ONLY checks for an already migrated Supabase project.
-- Do not use this script as a migration. Requires 001, 002, 003 and 004.

-- May return 0 rows if these particular hands were never played online.
-- If present under rules_version 1, these should read Medium and Expert.
select hand_key, rules_version, difficulty, score
from public.hands
where rules_version = 1 and hand_key in ('5-7-10-10', '3-3-8-8')
order by hand_key;

-- Difficulty consistency across online family records; expected mismatches = 0.
select count(*) as mismatched_family_difficulties
from public.family_hand_bests as b
join public.hands as h on h.hand_key = b.hand_key and h.rules_version = b.rules_version
where b.difficulty is distinct from h.difficulty;

-- Historical player-level records, if any; expected mismatches = 0.
select count(*) as mismatched_legacy_difficulties
from public.player_hand_bests as b
join public.hands as h on h.hand_key = b.hand_key and h.rules_version = b.rules_version
where b.difficulty is distinct from h.difficulty;

-- Inventory only (no private row data returned).
select 'families' as category, count(*) as count from public.families
union all select 'memberships', count(*) from public.family_members
union all select 'verified family hand records', count(*) from public.family_hand_bests
union all select 'issued solo challenges', count(*) from public.solo_challenges
order by category;

-- RLS must be enabled on private tables.
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('families', 'family_members', 'player_sessions',
                    'player_recovery', 'solo_challenges', 'family_hand_bests')
order by tablename;
