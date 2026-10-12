-- Apply once in Supabase Dashboard > SQL Editor.
-- Public reads are intentional for leaderboards; writes are server-only.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 24),
  created_at timestamptz not null default now()
);

create table if not exists public.hands (
  hand_key text not null,
  rules_version integer not null,
  difficulty text not null check (difficulty in ('Easy','Medium','Hard','Expert')),
  score integer not null check (score >= 0),
  created_at timestamptz not null default now(),
  primary key (hand_key, rules_version)
);

create table if not exists public.player_hand_bests (
  user_id uuid not null references public.profiles(id) on delete cascade,
  hand_key text not null,
  rules_version integer not null,
  difficulty text not null check (difficulty in ('Easy','Medium','Hard','Expert')),
  best_time_ms bigint not null check (best_time_ms >= 250),
  updated_at timestamptz not null default now(),
  primary key (user_id, hand_key, rules_version),
  foreign key (hand_key, rules_version) references public.hands(hand_key, rules_version)
);

create table if not exists public.solo_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cards jsonb not null,
  hand_key text not null,
  rules_version integer not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (hand_key, rules_version) references public.hands(hand_key, rules_version)
);
create index if not exists solo_challenges_user_idx on public.solo_challenges(user_id, started_at desc);
create index if not exists player_hand_bests_diff_idx on public.player_hand_bests(difficulty, best_time_ms);

-- Automatic profile for email-link sign-in, without exposing email addresses.
create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, 'Player-' || substring(new.id::text from 1 for 8))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_24race on auth.users;
create trigger on_auth_user_created_24race after insert on auth.users
for each row execute function public.create_profile_for_new_user();

alter table public.profiles enable row level security;
alter table public.hands enable row level security;
alter table public.player_hand_bests enable row level security;
alter table public.solo_challenges enable row level security;

-- Explicit grants: leaderboard data readable publicly; only the owner may edit their display name.
revoke all on public.profiles from anon, authenticated;
revoke all on public.hands from anon, authenticated;
revoke all on public.player_hand_bests from anon, authenticated;
revoke all on public.solo_challenges from anon, authenticated;
grant select on public.profiles, public.hands, public.player_hand_bests to anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy "Public display names" on public.profiles for select to anon, authenticated using (true);
create policy "Own display name" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
create policy "Public hand classifications" on public.hands for select to anon, authenticated using (true);
create policy "Public best records" on public.player_hand_bests for select to anon, authenticated using (true);
-- No INSERT / UPDATE policy on challenges, hands or personal bests: server only.

-- Exposes only the fastest best per difficulty per player, rather than every attempt.
create or replace view public.difficulty_leaderboard with (security_invoker = true) as
select b.user_id, p.display_name, b.difficulty, min(b.best_time_ms)::bigint as best_time_ms
from public.player_hand_bests b
join public.profiles p on p.id = b.user_id
where b.rules_version = 1
group by b.user_id, p.display_name, b.difficulty;
grant select on public.difficulty_leaderboard to anon, authenticated;

-- Atomic one-time completion and minimum-time upsert; only service_role may call.
create or replace function public.record_verified_solo_result(p_challenge uuid, p_user uuid)
returns table(time_ms bigint, new_best boolean)
language plpgsql security definer set search_path = '' as $$
declare
  challenge public.solo_challenges%rowtype;
  previous_best bigint;
  elapsed bigint;
  hand_difficulty text;
begin
  select * into challenge from public.solo_challenges
    where id = p_challenge and user_id = p_user for update;
  if not found then raise exception 'Challenge not found'; end if;
  if challenge.completed_at is not null then raise exception 'Challenge already completed'; end if;
  if challenge.started_at < now() - interval '30 minutes' then raise exception 'Challenge expired'; end if;
  elapsed := floor(extract(epoch from (clock_timestamp() - challenge.started_at)) * 1000)::bigint;
  if elapsed < 250 then raise exception 'Duration too short'; end if;
  select h.difficulty into hand_difficulty from public.hands h
    where h.hand_key = challenge.hand_key and h.rules_version = challenge.rules_version;
  if hand_difficulty is null then raise exception 'Hand analysis missing'; end if;
  select b.best_time_ms into previous_best from public.player_hand_bests b
    where b.user_id = p_user and b.hand_key = challenge.hand_key and b.rules_version = challenge.rules_version;
  update public.solo_challenges set completed_at = clock_timestamp() where id = p_challenge;
  insert into public.player_hand_bests as best
    (user_id, hand_key, rules_version, difficulty, best_time_ms)
  values (p_user, challenge.hand_key, challenge.rules_version, hand_difficulty, elapsed)
  on conflict (user_id, hand_key, rules_version) do update
    set best_time_ms = least(best.best_time_ms, excluded.best_time_ms),
        updated_at = case when excluded.best_time_ms < best.best_time_ms then now() else best.updated_at end;
  return query select elapsed, (previous_best is null or elapsed < previous_best);
end;
$$;
revoke all on function public.record_verified_solo_result(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_verified_solo_result(uuid, uuid) to service_role;
