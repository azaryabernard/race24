-- Apply ONCE, after 001_initial.sql and 002_family_keys.sql.
-- Upgrades an EXISTING single-family site to multi-family without deleting anything.
-- Take a database backup first. Deploy BOTH updated Edge Functions immediately afterward.

-- Previously restricted creation to one family per project.
alter table public.families drop constraint if exists families_singleton_slot_key;
alter table public.families drop constraint if exists families_singleton_slot_check;
alter table public.families drop column if exists singleton_slot;
create unique index if not exists families_invite_hash_unique on public.families (invite_hash);
create unique index if not exists families_admin_hash_unique on public.families (admin_key_hash);

-- A player's best for the same four cards belongs to the family in which they
-- solved the hand. Unlike player_hand_bests, rows never cross family boundaries.
create table if not exists public.family_hand_bests (
  family_id uuid not null,
  player_id uuid not null,
  hand_key text not null,
  rules_version integer not null,
  difficulty text not null check (difficulty in ('Easy','Medium','Hard','Expert')),
  best_time_ms bigint not null check (best_time_ms >= 250),
  updated_at timestamptz not null default now(),
  primary key (family_id, player_id, hand_key, rules_version),
  foreign key (family_id, player_id) references public.family_members (family_id, player_id) on delete cascade,
  foreign key (hand_key, rules_version) references public.hands (hand_key, rules_version)
);
create index if not exists family_hand_bests_rank_idx
  on public.family_hand_bests (family_id, difficulty, best_time_ms);
alter table public.family_hand_bests enable row level security;
revoke all on public.family_hand_bests from public, anon, authenticated;

-- Copy existing verified times into the EXISTING family's scope; the source
-- table is retained for safety/rollback. Run this migration only ONCE,
-- before enrolling anyone into new families.
insert into public.family_hand_bests as best (
  family_id, player_id, hand_key, rules_version, difficulty, best_time_ms, updated_at
)
select m.family_id, b.user_id, b.hand_key, b.rules_version,
       b.difficulty, b.best_time_ms, b.updated_at
from public.player_hand_bests b
join public.family_members m on m.player_id = b.user_id
on conflict (family_id, player_id, hand_key, rules_version) do update
  set best_time_ms = least(best.best_time_ms, excluded.best_time_ms),
      updated_at = case when excluded.best_time_ms < best.best_time_ms
                        then excluded.updated_at else best.updated_at end;

-- Every server-issued hand remembers the family it was started in, so switching
-- family mid-hand cannot move a time to another leaderboard.
alter table public.solo_challenges add column if not exists family_id uuid
  references public.families(id) on delete set null;
create index if not exists solo_challenges_family_idx on public.solo_challenges(family_id, started_at desc);

-- Old function accepted any family membership; remove it before deploying
-- the new family-scoped version. Previously issued in-flight challenges will
-- need to be restarted after deployment.
drop function if exists public.record_verified_family_solo_result(uuid, uuid);

create or replace function public.record_verified_family_solo_result(
  p_challenge uuid, p_auth_user uuid, p_family uuid
)
returns table(time_ms bigint, new_best boolean)
language plpgsql security definer set search_path = '' as $$
declare
  challenge public.solo_challenges%rowtype;
  persistent_player uuid;
  previous_best bigint;
  elapsed bigint;
  hand_difficulty text;
begin
  select * into challenge from public.solo_challenges
    where id = p_challenge and user_id = p_auth_user and family_id = p_family for update;
  if not found then raise exception 'Challenge not found in selected family'; end if;
  if challenge.completed_at is not null then raise exception 'Challenge already completed'; end if;
  if challenge.started_at < now() - interval '30 minutes' then raise exception 'Challenge expired'; end if;

  select s.player_id into persistent_player
    from public.player_sessions s
    join public.family_members m on m.player_id = s.player_id and m.family_id = p_family
    where s.auth_user_id = p_auth_user;
  if persistent_player is null then raise exception 'Not a member of the selected family'; end if;

  elapsed := floor(extract(epoch from (clock_timestamp() - challenge.started_at)) * 1000)::bigint;
  if elapsed < 250 then raise exception 'Duration too short'; end if;
  select h.difficulty into hand_difficulty from public.hands h
    where h.hand_key = challenge.hand_key and h.rules_version = challenge.rules_version;
  if hand_difficulty is null then raise exception 'Hand analysis missing'; end if;

  select b.best_time_ms into previous_best from public.family_hand_bests b
    where b.family_id = p_family and b.player_id = persistent_player
      and b.hand_key = challenge.hand_key and b.rules_version = challenge.rules_version;

  update public.solo_challenges set completed_at = clock_timestamp() where id = p_challenge;
  insert into public.family_hand_bests as best
    (family_id, player_id, hand_key, rules_version, difficulty, best_time_ms)
  values (p_family, persistent_player, challenge.hand_key, challenge.rules_version, hand_difficulty, elapsed)
  on conflict (family_id, player_id, hand_key, rules_version) do update
    set best_time_ms = least(best.best_time_ms, excluded.best_time_ms),
        updated_at = case when excluded.best_time_ms < best.best_time_ms
                          then now() else best.updated_at end;

  return query select elapsed, (previous_best is null or elapsed < previous_best);
end;
$$;
revoke all on function public.record_verified_family_solo_result(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_verified_family_solo_result(uuid, uuid, uuid) to service_role;
