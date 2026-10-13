-- Race24 multiplayer. Apply AFTER 001-004. Private family-scoped rooms.
-- All multiplayer tables are denied to API roles; only the multiplayer Edge
-- Function can access them via service_role and the guarded RPCs below.
create table if not exists public.mp_rooms (
 id uuid primary key default gen_random_uuid(),
 family_id uuid not null references public.families(id) on delete cascade,
 code text not null unique check (code ~ '^R24-[A-HJ-NP-Z2-9]{8}$'),
 host_id uuid not null references public.profiles(id) on delete cascade,
 mode text not null check (mode in ('everyone','first')),
 difficulty_filter text not null default 'Mixed' check (difficulty_filter in ('Mixed','Easy','Medium','Hard','Expert')),
 round_seconds integer not null check (round_seconds in (30,60,90,120)),
 grace_seconds integer not null check (grace_seconds in (0,30,60)),
 max_rounds integer not null check (max_rounds between 1 and 10),
 status text not null default 'lobby' check (status in ('lobby','playing','results')),
 round_number integer not null default 0,
 current_round_id uuid,
 created_at timestamptz not null default now()
);
create table if not exists public.mp_players (
 room_id uuid not null references public.mp_rooms(id) on delete cascade,
 player_id uuid not null references public.profiles(id) on delete cascade,
 nickname text not null check (char_length(nickname) between 2 and 24),
 ready boolean not null default false,
 score integer not null default 0 check (score >= 0),
 joined_at timestamptz not null default now(),
 primary key(room_id,player_id)
);
create table if not exists public.mp_rounds (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references public.mp_rooms(id) on delete cascade,
 number integer not null check (number between 1 and 10),
 cards jsonb not null,
 hand_key text not null,
 difficulty text not null check (difficulty in ('Easy','Medium','Hard','Expert')),
 solution_steps jsonb not null,
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 first_finished_at timestamptz,
 ended_at timestamptz,
 unique(room_id,number)
);
create table if not exists public.mp_finishes (
 round_id uuid not null references public.mp_rounds(id) on delete cascade,
 player_id uuid not null references public.profiles(id) on delete cascade,
 finished_at timestamptz not null,
 time_ms bigint not null check (time_ms >= 0),
 place integer not null check (place between 1 and 8),
 points integer not null check (points between 0 and 8),
 primary key(round_id,player_id), unique(round_id,place)
);
create index if not exists mp_rooms_family_idx on public.mp_rooms(family_id, created_at desc);
create index if not exists mp_rounds_room_idx on public.mp_rounds(room_id, number desc);
create index if not exists mp_finishes_round_idx on public.mp_finishes(round_id, place);
alter table public.mp_rooms enable row level security;
alter table public.mp_players enable row level security;
alter table public.mp_rounds enable row level security;
alter table public.mp_finishes enable row level security;
revoke all on public.mp_rooms, public.mp_players, public.mp_rounds, public.mp_finishes from public, anon, authenticated;

-- Guarded transactions deliberately verify the caller's permanent player ID
-- against the family and room, even though the Edge Function also checks it.
create or replace function public.mp_create_room(p_family uuid,p_player uuid,p_code text,p_mode text,p_difficulty text,p_seconds int,p_grace int,p_rounds int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare room uuid;
begin
 if not exists (select 1 from public.family_members where family_id=p_family and player_id=p_player) then raise exception 'Join this family first'; end if;
 if p_mode not in ('everyone','first') or p_difficulty not in ('Mixed','Easy','Medium','Hard','Expert') or p_seconds not in (30,60,90,120) or p_grace not in (0,30,60) or p_rounds not between 1 and 10 then raise exception 'Invalid room settings'; end if;
 insert into public.mp_rooms(family_id,host_id,code,mode,difficulty_filter,round_seconds,grace_seconds,max_rounds)
 values(p_family,p_player,p_code,p_mode,p_difficulty,p_seconds,p_grace,p_rounds) returning id into room;
 insert into public.mp_players(room_id,player_id,nickname)
 select room, p_player, nickname from public.family_members where family_id=p_family and player_id=p_player;
 return room;
end $$;

create or replace function public.mp_join_room(p_code text,p_player uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.mp_rooms%rowtype; nick text;
begin
 select * into r from public.mp_rooms where code=p_code for update;
 if not found then raise exception 'Room not found'; end if;
 select nickname into nick from public.family_members where family_id=r.family_id and player_id=p_player;
 if nick is null then raise exception 'You must belong to this room''s family'; end if;
 if exists(select 1 from public.mp_players where room_id=r.id and player_id=p_player) then return r.id; end if;
 if r.status <> 'lobby' then raise exception 'Match already underway'; end if;
 if (select count(*) from public.mp_players where room_id=r.id) >= 8 then raise exception 'Room is full'; end if;
 insert into public.mp_players(room_id,player_id,nickname) values(r.id,p_player,nick);
 return r.id;
end $$;

create or replace function public.mp_ready(p_room uuid,p_player uuid,p_ready boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare s text;
begin
 select status into s from public.mp_rooms where id=p_room for update;
 if s is distinct from 'lobby' then raise exception 'Ready is only available in the lobby'; end if;
 update public.mp_players set ready=p_ready where room_id=p_room and player_id=p_player;
 if not found then raise exception 'Not in this room'; end if;
 return true;
end $$;

-- Called on every room status request. Idempotent with a room-row lock.
create or replace function public.mp_sync(p_room uuid,p_player uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare r public.mp_rooms%rowtype; rd public.mp_rounds%rowtype; deadline timestamptz;
begin
 select * into r from public.mp_rooms where id=p_room for update;
 if not found or not exists (select 1 from public.mp_players where room_id=p_room and player_id=p_player)
 then raise exception 'Room unavailable'; end if;
 if r.status <> 'playing' then return false; end if;
 select * into rd from public.mp_rounds where id=r.current_round_id;
 deadline := rd.ends_at;
 if r.mode='everyone' and rd.first_finished_at is not null and r.grace_seconds>0 then
   deadline := least(deadline, rd.first_finished_at + make_interval(secs => r.grace_seconds));
 end if;
 if clock_timestamp() >= deadline or
    (clock_timestamp() >= rd.starts_at and
     (select count(*) from public.mp_finishes where round_id=rd.id) >=
     (select count(*) from public.mp_players where room_id=p_room)) then
   update public.mp_rounds set ended_at=clock_timestamp() where id=rd.id and ended_at is null;
   update public.mp_rooms set status='results' where id=p_room;
   return true;
 end if;
 return false;
end $$;

create or replace function public.mp_start_round(p_room uuid,p_player uuid,p_cards jsonb,p_key text,p_difficulty text,p_steps jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.mp_rooms%rowtype; next_no int; new_id uuid; total int;
begin
 select * into r from public.mp_rooms where id=p_room for update;
 if not found or r.host_id<>p_player then raise exception 'Only the host can start a round'; end if;
 if r.status not in ('lobby','results') then raise exception 'A round is already active'; end if;
 next_no := r.round_number+1;
 if next_no>r.max_rounds then raise exception 'Match complete; start a rematch'; end if;
 select count(*) into total from public.mp_players where room_id=p_room;
 if total<2 then raise exception 'At least two players are required'; end if;
 if r.status='lobby' and exists(select 1 from public.mp_players where room_id=p_room and not ready) then
   raise exception 'All players must press Ready';
 end if;
 if jsonb_typeof(p_cards)<>'array' or jsonb_array_length(p_cards)<>4 or jsonb_typeof(p_steps)<>'array' or jsonb_array_length(p_steps)<>3
 then raise exception 'Invalid hand'; end if;
 insert into public.mp_rounds(room_id,number,cards,hand_key,difficulty,solution_steps,starts_at,ends_at)
 values(p_room,next_no,p_cards,p_key,p_difficulty,p_steps,clock_timestamp()+interval '3 seconds',clock_timestamp()+interval '3 seconds'+make_interval(secs=>r.round_seconds))
 returning id into new_id;
 update public.mp_rooms set status='playing',round_number=next_no,current_round_id=new_id where id=p_room;
 return new_id;
end $$;

-- Atomic finish order and scores, with authoritative database receive time.
-- The Edge Function verifies the submitted expression against stored cards
-- before entering this transaction. Clients never call this RPC directly.
create or replace function public.mp_submit(p_room uuid,p_player uuid,p_round uuid)
returns table(place int, points int, time_ms bigint) language plpgsql security definer set search_path = '' as $$
declare r public.mp_rooms%rowtype; rd public.mp_rounds%rowtype; deadline timestamptz;
        finish_time timestamptz; ranking int; earned int; duration bigint;
begin
 select * into r from public.mp_rooms where id=p_room for update;
 if not found or r.status <> 'playing' or r.current_round_id<>p_round then raise exception 'Round is no longer active'; end if;
 if not exists(select 1 from public.mp_players where room_id=p_room and player_id=p_player) then raise exception 'Not a room player'; end if;
 select * into rd from public.mp_rounds where id=p_round;
 finish_time := clock_timestamp();
 deadline := rd.ends_at;
 if r.mode='everyone' and rd.first_finished_at is not null and r.grace_seconds>0 then
   deadline := least(deadline,rd.first_finished_at+make_interval(secs=>r.grace_seconds));
 end if;
 if finish_time<rd.starts_at or finish_time>=deadline then raise exception 'Round timer has expired or not started'; end if;
 if exists(select 1 from public.mp_finishes where round_id=p_round and player_id=p_player) then raise exception 'Already finished'; end if;
 select count(*)+1 into ranking from public.mp_finishes where round_id=p_round;
 earned := case when r.mode='first' then 1 else (select count(*) from public.mp_players where room_id=p_room)-ranking+1 end;
 duration := greatest(0,floor(extract(epoch from (finish_time-rd.starts_at))*1000)::bigint);
 insert into public.mp_finishes(round_id,player_id,finished_at,time_ms,place,points)
 values(p_round,p_player,finish_time,duration,ranking,earned);
 update public.mp_players set score=score+earned where room_id=p_room and player_id=p_player;
 if ranking=1 then update public.mp_rounds set first_finished_at=finish_time where id=p_round; end if;
 if r.mode='first' or ranking >= (select count(*) from public.mp_players where room_id=p_room) then
   update public.mp_rounds set ended_at=finish_time where id=p_round;
   update public.mp_rooms set status='results' where id=p_room;
 end if;
 return query select ranking,earned,duration;
end $$;

create or replace function public.mp_rematch(p_room uuid,p_player uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare r public.mp_rooms%rowtype;
begin
 select * into r from public.mp_rooms where id=p_room for update;
 if not found or r.host_id<>p_player or r.status<>'results' or r.round_number<r.max_rounds then
   raise exception 'Host may restart only after the match ends';
 end if;
 delete from public.mp_rounds where room_id=p_room;
 update public.mp_players set score=0,ready=false where room_id=p_room;
 update public.mp_rooms set status='lobby',round_number=0,current_round_id=null where id=p_room;
 return true;
end $$;

-- Hosts can clear disconnected/unready players between rounds. Never mid-round.
create or replace function public.mp_kick(p_room uuid,p_player uuid,p_target uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare r public.mp_rooms%rowtype;
begin
 select * into r from public.mp_rooms where id=p_room for update;
 if not found or r.host_id<>p_player or r.status='playing' or p_target=p_player then
   raise exception 'Only the host can remove another player between rounds';
 end if;
 delete from public.mp_players where room_id=p_room and player_id=p_target;
 if not found then raise exception 'Player not found'; end if;
 return true;
end $$;

create or replace function public.mp_leave(p_room uuid,p_player uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare r public.mp_rooms%rowtype; successor uuid;
begin
 select * into r from public.mp_rooms where id=p_room for update;
 if not found then return true; end if;
 if r.status='playing' then raise exception 'Wait until the round ends before leaving'; end if;
 delete from public.mp_players where room_id=p_room and player_id=p_player;
 if not found then raise exception 'Not in the room'; end if;
 select player_id into successor from public.mp_players where room_id=p_room order by joined_at,player_id limit 1;
 if successor is null then delete from public.mp_rooms where id=p_room;
 elsif r.host_id=p_player then update public.mp_rooms set host_id=successor where id=p_room;
 end if;
 return true;
end $$;

-- Access to all multiplayer writes is limited to the Edge Function's service role.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('mp_create_room','mp_join_room','mp_ready','mp_sync','mp_start_round','mp_submit','mp_rematch','mp_leave','mp_kick')
 loop
  execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
