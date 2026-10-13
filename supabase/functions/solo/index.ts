import { withSupabase } from 'npm:@supabase/server@1';
import {
  RULES_VERSION, drawHand, analyzeHand, canonicalKey, verifySolution,
} from '../_shared/engine.js';

function secureRandom() {
  const numbers = new Uint32Array(1);
  crypto.getRandomValues(numbers);
  return numbers[0] / 4294967296;
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const validUuid = (s: unknown) => typeof s === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// The family ID is verified against the player's authenticated, permanent
// identity on EVERY request. Client-side dropdown selection alone grants nothing.
export default {
  fetch: withSupabase({ auth: 'user' }, async (request, ctx) => {
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
    let payload: Record<string, unknown>;
    try { payload = await request.json(); }
    catch { return json({ error: 'Invalid JSON' }, 400); }
    const authId = ctx.userClaims?.id;
    if (!authId) return json({ error: 'Player session required' }, 401);
    if (!validUuid(payload.familyId)) return json({ error: 'Select a family first' }, 400);
    const familyId = payload.familyId as string;
    const db = ctx.supabaseAdmin;
    const { data: session, error: sessionError } = await db.from('player_sessions')
      .select('player_id').eq('auth_user_id', authId).maybeSingle();
    if (sessionError || !session) return json({ error: 'Join a family to save online records' }, 403);
    const { data: member, error: memberError } = await db.from('family_members')
      .select('nickname').eq('player_id', session.player_id).eq('family_id', familyId).maybeSingle();
    if (memberError || !member) return json({ error: 'Not a member of that family' }, 403);

    if (payload.action === 'bests') {
      const { data, error } = await db.from('family_hand_bests')
        .select('hand_key,difficulty,best_time_ms,updated_at')
        .eq('family_id', familyId).eq('player_id', session.player_id).eq('rules_version', RULES_VERSION);
      return error ? json({ error: 'Could not load records' }, 500) : json({ records: data || [] });
    }
    if (payload.action === 'leaderboard') {
      const difficulty = payload.difficulty;
      if (!['Easy', 'Medium', 'Hard', 'Expert'].includes(String(difficulty)))
        return json({ error: 'Invalid difficulty' }, 400);
      const { data: members, error: membersError } = await db.from('family_members')
        .select('player_id,nickname').eq('family_id', familyId);
      if (membersError) return json({ error: 'Could not load family members' }, 500);
      const { data: records, error: recordsError } = await db.from('family_hand_bests')
        .select('player_id,best_time_ms').eq('family_id', familyId)
        .eq('rules_version', RULES_VERSION).eq('difficulty', difficulty);
      if (recordsError) return json({ error: 'Could not load leaderboard' }, 500);
      const best = new Map<string, number>();
      for (const record of records || []) {
        const value = Number(record.best_time_ms);
        best.set(record.player_id, Math.min(best.get(record.player_id) ?? Infinity, value));
      }
      const rows = (members || []).filter(m => best.has(m.player_id))
        .map(m => ({ display_name: m.nickname, best_time_ms: best.get(m.player_id), user_id: m.player_id }))
        .sort((a, b) => a.best_time_ms! - b.best_time_ms!).slice(0, 10);
      return json({ rows });
    }
    if (payload.action === 'start') {
      let cards, report;
      for (let i = 0; i < 60; i++) {
        cards = drawHand(secureRandom);
        report = analyzeHand(cards);
        if (report.solvable) break;
      }
      if (!report?.solvable || !cards) return json({ error: 'Could not draw a solvable hand' }, 503);
      const { error: handError } = await db.from('hands').upsert({
        hand_key: report.key, rules_version: RULES_VERSION,
        difficulty: report.difficulty, score: report.score,
      }, { onConflict: 'hand_key,rules_version', ignoreDuplicates: true });
      if (handError) return json({ error: 'Could not save hand' }, 500);
      const { data, error } = await db.from('solo_challenges').insert({
        user_id: authId, family_id: familyId, cards,
        hand_key: canonicalKey(cards), rules_version: RULES_VERSION,
      }).select('id').single();
      if (error) return json({ error: 'Could not create challenge' }, 500);
      return json({ challengeId: data.id, cards, handKey: report.key,
        difficulty: report.difficulty, score: report.score, rulesVersion: RULES_VERSION });
    }
    if (payload.action === 'submit') {
      if (!validUuid(payload.challengeId)) return json({ error: 'Invalid challenge ID' }, 400);
      const { data: challenge, error } = await db.from('solo_challenges')
        .select('id,user_id,cards,completed_at,rules_version,family_id')
        .eq('id', payload.challengeId).eq('user_id', authId).eq('family_id', familyId).maybeSingle();
      if (error || !challenge) return json({ error: 'Challenge not found in this family' }, 404);
      if (challenge.completed_at || challenge.rules_version !== RULES_VERSION)
        return json({ error: 'Challenge already finished or rules changed' }, 409);
      const valid = verifySolution(challenge.cards, payload.expression).valid;
      if (!valid) return json({ error: 'Invalid solution: use every card exactly once to make 24' }, 400);
      const { data, error: rpcError } = await db.rpc('record_verified_family_solo_result', {
        p_challenge: challenge.id, p_auth_user: authId, p_family: familyId,
      });
      if (rpcError || !data?.length) return json({ error: rpcError?.message || 'Could not record result' }, 409);
      return json({ ok: true, timeMs: Number(data[0].time_ms), newBest: data[0].new_best });
    }
    return json({ error: 'Unknown solo action' }, 400);
  }),
};
