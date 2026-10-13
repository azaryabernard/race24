import { withSupabase } from 'npm:@supabase/server@1';
import { drawHand, analyzeHand, canonicalKey, verifySolution } from '../_shared/engine.js';

const reply = (data: unknown, status = 200) => Response.json(data, { status });
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const roomCode = (v: unknown) => typeof v === 'string' && /^R24-[A-HJ-NP-Z2-9]{8}$/.test(v.trim().toUpperCase());
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return 'R24-' + [...bytes].map(b => alphabet[b & 31]).join('');
}
function random() {
  const numbers = new Uint32Array(1); crypto.getRandomValues(numbers);
  return numbers[0] / 4294967296;
}
function failure(message: string, status = 400) { return reply({ error: message }, status); }

export default {
  fetch: withSupabase({ auth: 'user' }, async (request, ctx) => {
    if (request.method !== 'POST') return failure('POST required', 405);
    let input: Record<string, unknown>;
    try { input = await request.json(); }
    catch { return failure('Invalid JSON'); }
    const authId = ctx.userClaims?.id;
    if (!authId) return failure('Sign in and join a family to play multiplayer', 401);
    const db = ctx.supabaseAdmin;
    const { data: session, error: identityError } = await db.from('player_sessions')
      .select('player_id').eq('auth_user_id', authId).maybeSingle();
    if (identityError) return failure('Could not verify your identity', 500);
    const player = session?.player_id;
    if (!player) return failure('Join a family before using multiplayer', 403);

    async function rpc(name: string, params: Record<string, unknown>) {
      const { data, error } = await db.rpc(name, params);
      if (error) throw new Error(error.message);
      return data;
    }
    async function getRoom(roomId: unknown) {
      if (!uuid(roomId)) throw Error('Invalid room');
      const { data: member, error: memberError } = await db.from('mp_players')
        .select('player_id').eq('room_id', roomId).eq('player_id', player).maybeSingle();
      if (memberError || !member) throw Error('You are not a member of this room');
      const { data: room, error: roomError } = await db.from('mp_rooms').select('*').eq('id', roomId).maybeSingle();
      if (roomError || !room) throw Error('Room not found');
      return room;
    }
    async function status(roomId: unknown) {
      const room = await getRoom(roomId);
      await rpc('mp_sync', { p_room: room.id, p_player: player });
      // Re-read after mp_sync because it can transition the round to results.
      const { data: updated, error: roomError } = await db.from('mp_rooms').select('*').eq('id', room.id).single();
      if (roomError || !updated) throw Error('Could not refresh room');
      const { data: players, error: playersError } = await db.from('mp_players')
        .select('player_id,nickname,ready,score').eq('room_id', room.id);
      if (playersError) throw Error('Could not load room players');
      const members = (players || []).map(p => ({
        id: p.player_id, nickname: p.nickname, ready: p.ready, score: p.score,
        isYou: p.player_id === player, isHost: p.player_id === updated.host_id,
      }));
      let round = null;
      if (updated.current_round_id) {
        const { data: rd, error: roundError } = await db.from('mp_rounds').select('*')
          .eq('id', updated.current_round_id).single();
        if (roundError || !rd) throw Error('Could not load current round');
        const { data: finishes, error: finishError } = await db.from('mp_finishes')
          .select('player_id,place,points,time_ms').eq('round_id', rd.id).order('place');
        if (finishError) throw Error('Could not load results');
        const started = Date.now() >= Date.parse(rd.starts_at);
        const revealed = updated.status === 'results';
        const yourFinish = (finishes || []).find(f => f.player_id === player);
        const firstEndsAt = rd.first_finished_at && updated.mode === 'everyone' && updated.grace_seconds > 0
          ? Date.parse(rd.first_finished_at) + updated.grace_seconds * 1000 : Infinity;
        round = {
          id: rd.id, number: rd.number, startsAt: rd.starts_at,
          endsAt: new Date(Math.min(Date.parse(rd.ends_at), firstEndsAt)).toISOString(),
          handKey: started || revealed ? rd.hand_key : null,
          difficulty: started || revealed ? rd.difficulty : null,
          // No hand or solution is exposed ahead of the synchronized start.
          cards: started || revealed ? rd.cards : null,
          solutionSteps: revealed ? rd.solution_steps : null,
          finishes: (finishes || []).map(f => ({ playerId: f.player_id, place: f.place,
            points: f.points, timeMs: revealed || f.player_id === player ? Number(f.time_ms) : null })),
          yourFinish: yourFinish ? { place: yourFinish.place, points: yourFinish.points, timeMs: Number(yourFinish.time_ms) } : null,
        };
      }
      return { serverTime: new Date().toISOString(), room: {
        id: updated.id, code: updated.code, familyId: updated.family_id,
        mode: updated.mode, difficulty: updated.difficulty_filter, seconds: updated.round_seconds,
        grace: updated.grace_seconds, maxRounds: updated.max_rounds, status: updated.status,
        roundNumber: updated.round_number, hostId: updated.host_id,
      }, players: members, round, you: player };
    }

    try {
      if (input.action === 'create') {
        if (!uuid(input.familyId)) return failure('Choose a family to play with');
        const mode = input.mode === 'first' ? 'first' : input.mode === 'everyone' ? 'everyone' : '';
        const difficulty = String(input.difficulty || 'Mixed');
        const seconds = Number(input.seconds), grace = Number(input.grace), rounds = Number(input.rounds);
        if (!mode || !['Mixed','Easy','Medium','Hard','Expert'].includes(difficulty)
          || ![30,60,90,120].includes(seconds) || ![0,30,60].includes(grace)
          || !Number.isInteger(rounds) || rounds < 1 || rounds > 10) return failure('Invalid room settings');
        if (!await rpc('consume_family_action', { p_auth: authId, p_action: 'mp-create', p_max: 5 }))
          return failure('Too many rooms created. Try again later.', 429);
        for (let attempt = 0; attempt < 4; attempt++) {
          const newCode = code();
          try {
            const roomId = await rpc('mp_create_room', { p_family: input.familyId,
              p_player: player, p_code: newCode, p_mode: mode, p_difficulty: difficulty,
              p_seconds: seconds, p_grace: grace, p_rounds: rounds });
            return reply(await status(roomId));
          } catch (error) {
            if (!String(error).toLowerCase().includes('duplicate key')) throw error;
          }
        }
        return failure('Could not allocate a room code', 503);
      }
      if (input.action === 'join') {
        if (!roomCode(input.code)) return failure('Enter a valid R24 room code');
        if (!await rpc('consume_family_action', { p_auth: authId, p_action: 'mp-join', p_max: 10 }))
          return failure('Too many join attempts. Try again later.', 429);
        const roomId = await rpc('mp_join_room', { p_code: String(input.code).trim().toUpperCase(), p_player: player });
        return reply(await status(roomId));
      }
      const room = await getRoom(input.roomId);
      if (input.action === 'status') return reply(await status(room.id));
      if (input.action === 'ready') {
        await rpc('mp_ready', { p_room: room.id, p_player: player, p_ready: input.ready === true });
        return reply(await status(room.id));
      }
      if (input.action === 'start') {
        // Only trusted server code creates the shared hand. The DB transaction
        // rechecks the host, ready roster, round limit and state atomically.
        if (room.host_id !== player) return failure('Only the host can start');
        let cards, report;
        for (let i = 0; i < 110; i++) {
          cards = drawHand(random);
          report = analyzeHand(cards);
          if (report.solvable && (room.difficulty_filter === 'Mixed' || report.difficulty === room.difficulty_filter)) break;
        }
        if (!cards || !report?.solvable ||
            (room.difficulty_filter !== 'Mixed' && report.difficulty !== room.difficulty_filter))
          return failure('Could not find a hand in this difficulty. Try again.', 503);
        await rpc('mp_start_round', { p_room: room.id, p_player: player,
          p_cards: cards, p_key: canonicalKey(cards), p_difficulty: report.difficulty,
          p_steps: report.solutionSteps });
        return reply(await status(room.id));
      }
      if (input.action === 'submit') {
        if (!uuid(input.roundId) || input.roundId !== room.current_round_id || room.status !== 'playing')
          return failure('Round no longer active', 409);
        const { data: rd, error: roundError } = await db.from('mp_rounds')
          .select('cards').eq('id', input.roundId).eq('room_id', room.id).maybeSingle();
        if (roundError || !rd) return failure('Round not found', 404);
        if (!verifySolution(rd.cards, input.expression).valid) return failure('Invalid solution: use all four cards to make 24');
        const results = await rpc('mp_submit', { p_room: room.id, p_player: player, p_round: input.roundId });
        return reply({ ok: true, finish: results?.[0], state: await status(room.id) });
      }
      if (input.action === 'rematch') {
        await rpc('mp_rematch', { p_room: room.id, p_player: player });
        return reply(await status(room.id));
      }
      if (input.action === 'kick') {
        if (!uuid(input.targetId)) return failure('Invalid player');
        await rpc('mp_kick', { p_room: room.id, p_player: player, p_target: input.targetId });
        return reply(await status(room.id));
      }
      if (input.action === 'leave') {
        await rpc('mp_leave', { p_room: room.id, p_player: player });
        return reply({ ok: true });
      }
      return failure('Unknown multiplayer action');
    } catch (error) {
      // RPC errors are safe, generic game-state failures; no secret columns are returned.
      return failure(error instanceof Error ? error.message : 'Multiplayer request failed', 409);
    }
  }),
};
