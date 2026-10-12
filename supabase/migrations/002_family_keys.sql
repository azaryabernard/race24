-- Run after 001_initial.sql. Existing leaderboard records are preserved.
-- All family/user identity writes are performed by authenticated Edge Functions.
create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  singleton_slot integer not null default 1 unique check (singleton_slot = 1),
  name text not null check (char_length(name) between 2 and 50),
  invite_hash text not null,
  admin_key_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Persistent identity is profiles.id; anonymous auth sessions may be re-bound
-- to this profile after proving ownership with a personal recovery key.
create table if not exists public.player_sessions (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  player_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists player_sessions_player_idx on public.player_sessions(player_id);

create table if not exists public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  player_id uuid not null references public.profiles(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 2 and 24),
  joined_at timestamptz not null default now(),
  primary key (family_id, player_id)
);
create unique index if not exists family_nickname_unique on public.family_members(family_id, lower(nickname));

create table if not exists public.player_recovery (
  player_id uuid primary key references public.profiles(id) on delete cascade,
  key_hash text not null unique,
  rotated_at timestamptz not null default now()
);

-- Persisted per-auth-session limit. Anonymous signup is still susceptible to
-- deliberate Sybil abuse; combine with Supabase Auth CAPTCHA/edge gateway limits.
create table if not exists public.family_action_limits (
  auth_user_id uuid not null,
  action text not null,
  window_start timestamptz not null default now(),
  attempts integer not null default 0,
  primary key (auth_user_id, action)
);

create or replace function public.consume_family_action(p_auth uuid, p_action text, p_max integer default 5)
returns boolean language plpgsql security definer set search_path = '' as $$
declare updated_attempts integer;
begin
  if p_max < 1 or p_max > 100 or length(p_action) > 40 then return false; end if;
  insert into public.family_action_limits(auth_user_id, action, window_start, attempts)
  values (p_auth, p_action, clock_timestamp(), 1)
  on conflict (auth_user_id, action) do update set
    attempts = case when public.family_action_limits.window_start < clock_timestamp() - interval '15 minutes' then 1
                    else public.family_action_limits.attempts + 1 end,
    window_start = case when public.family_action_limits.window_start < clock_timestamp() - interval '15 minutes' then clock_timestamp()
                        else public.family_action_limits.window_start end
  returning attempts into updated_attempts;
  return updated_attempts <= p_max;
end;
$$;
revoke all on function public.consume_family_action(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.consume_family_action(uuid,text,integer) to service_role;

-- Never expose private membership, recovery hashes or family secrets through REST.
alter table public.families enable row level security;
alter table public.player_sessions enable row level security;
alter table public.family_members enable row level security;
alter table public.player_recovery enable row level security;
alter table public.family_action_limits enable row level security;
revoke all on public.families, public.player_sessions, public.family_members,
  public.player_recovery, public.family_action_limits from anon, authenticated;

-- New family leaderboard is served only after membership verification in
-- the Edge Function. Revoke pre-existing public read access and permissive RLS.
revoke all on public.difficulty_leaderboard from public, anon, authenticated;
revoke all on public.profiles, public.hands, public.player_hand_bests from anon, authenticated;
drop policy if exists "Public display names" on public.profiles;
drop policy if exists "Own display name" on public.profiles;
drop policy if exists "Public hand classifications" on public.hands;
drop policy if exists "Public best records" on public.player_hand_bests;

-- Only member sessions may submit challenges. The transaction locks the
-- challenge and writes results against the stable player ID, not the session ID.
create or replace function public.record_verified_family_solo_result(p_challenge uuid, p_auth_user uuid)
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
    where id = p_challenge and user_id = p_auth_user for update;
  if not found then raise exception 'Challenge not found'; end if;
  if challenge.completed_at is not null then raise exception 'Challenge already completed'; end if;
  if challenge.started_at < now() - interval '30 minutes' then raise exception 'Challenge expired'; end if;

  select s.player_id into persistent_player
    from public.player_sessions s
    join public.family_members m on m.player_id = s.player_id
    where s.auth_user_id = p_auth_user limit 1;
  if persistent_player is null then raise exception 'Not a family member'; end if;

  elapsed := floor(extract(epoch from (clock_timestamp() - challenge.started_at)) * 1000)::bigint;
  if elapsed < 250 then raise exception 'Duration too short'; end if;
  select h.difficulty into hand_difficulty from public.hands h
    where h.hand_key = challenge.hand_key and h.rules_version = challenge.rules_version;
  if hand_difficulty is null then raise exception 'Hand analysis missing'; end if;
  select b.best_time_ms into previous_best from public.player_hand_bests b
    where b.user_id = persistent_player and b.hand_key = challenge.hand_key and b.rules_version = challenge.rules_version;
  update public.solo_challenges set completed_at = clock_timestamp() where id = p_challenge;
  insert into public.player_hand_bests as best
    (user_id, hand_key, rules_version, difficulty, best_time_ms)
  values (persistent_player, challenge.hand_key, challenge.rules_version, hand_difficulty, elapsed)
  on conflict (user_id, hand_key, rules_version) do update
    set best_time_ms = least(best.best_time_ms, excluded.best_time_ms),
        updated_at = case when excluded.best_time_ms < best.best_time_ms then now() else best.updated_at end;
  return query select elapsed, (previous_best is null or elapsed < previous_best);
end;
$$;
revoke all on function public.record_verified_family_solo_result(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_verified_family_solo_result(uuid, uuid) to service_role;

-- Disable old completion RPC to avoid bypassing family membership.
revoke all on function public.record_verified_solo_result(uuid, uuid) from service_role;
