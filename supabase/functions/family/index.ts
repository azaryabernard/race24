import { withSupabase } from 'npm:@supabase/server@1';

const reply = (body: unknown, status = 200) => Response.json(body, { status });
const normalize = (text: unknown) => typeof text === 'string' ? text.trim().toUpperCase() : '';
const uuid = (text: unknown) => typeof text === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
function newKey(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(prefix === 'FAM' ? 8 : 24));
  const hex = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
  return prefix + '-' + hex.match(/.{8}/g)!.join('-');
}
async function hash(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
function validKey(text: unknown, prefix: string) {
  return new RegExp(`^${prefix}(-[0-9A-F]{8}){${prefix === 'FAM' ? 2 : 6}}$`).test(normalize(text));
}
function validNickname(text: unknown) {
  const nickname = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
  return nickname.length >= 2 && nickname.length <= 24 && /^[\p{L}\p{N} ._-]+$/u.test(nickname) ? nickname : null;
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (request, ctx) => {
    if (request.method !== 'POST') return reply({ error: 'POST required' }, 405);
    let input: Record<string, unknown>;
    try { input = await request.json(); }
    catch { return reply({ error: 'Invalid JSON' }, 400); }
    const authId = ctx.userClaims?.id;
    if (!authId) return reply({ error: 'Player session required' }, 401);
    const db = ctx.supabaseAdmin;
    const { data: session, error: sessionError } = await db.from('player_sessions')
      .select('player_id').eq('auth_user_id', authId).maybeSingle();
    if (sessionError) return reply({ error: 'Could not load player' }, 500);
    const playerId: string | null = session?.player_id || null;

    // Private family names are returned only for memberships owned by the
    // authenticated player's permanent identity.
    async function memberships() {
      if (!playerId) return [];
      const { data: memberRows, error } = await db.from('family_members')
        .select('family_id,nickname').eq('player_id', playerId);
      if (error) throw Error('Could not load memberships');
      if (!memberRows?.length) return [];
      const { data: families, error: namesError } = await db.from('families')
        .select('id,name').in('id', memberRows.map(m => m.family_id));
      if (namesError) throw Error('Could not load family names');
      const names = new Map((families || []).map(f => [f.id, f.name]));
      return memberRows.map(m => ({ familyId: m.family_id, familyName: names.get(m.family_id) || 'Family', nickname: m.nickname }))
        .sort((a, b) => a.familyName.localeCompare(b.familyName));
    }
    let joined: { familyId: string; familyName: string; nickname: string }[];
    try { joined = await memberships(); }
    catch { return reply({ error: 'Could not load memberships' }, 500); }

    if (input.action === 'status') return reply({ memberships: joined });

    if (['bootstrap','join','recover','rotate-invite','rotate-admin'].includes(String(input.action))) {
      const { data: permitted, error } = await db.rpc('consume_family_action', {
        p_auth: authId, p_action: String(input.action), p_max: 5,
      });
      if (error || permitted !== true) return reply({ error: 'Too many attempts; retry in 15 minutes' }, 429);
    }

    if (input.action === 'bootstrap') {
      // Only the site owner has the private Edge Function setup secret.
      // Each family is independent: there is no project-wide singleton.
      const serverSecret = Deno.env.get('FAMILY_SETUP_SECRET') || '';
      if (serverSecret.length < 24 || typeof input.setupSecret !== 'string' ||
          await hash('setup:' + input.setupSecret) !== await hash('setup:' + serverSecret))
        return reply({ error: 'Invalid setup secret' }, 403);
      const name = typeof input.familyName === 'string' ? input.familyName.trim() : '';
      if (name.length < 2 || name.length > 50) return reply({ error: 'Family name must be 2–50 characters' }, 400);
      const inviteCode = newKey('FAM');
      const adminKey = newKey('ADM');
      const { error } = await db.from('families').insert({
        name, invite_hash: await hash('invite:' + inviteCode), admin_key_hash: await hash('admin:' + adminKey),
      });
      if (error) return reply({ error: 'Unable to create this family' }, 409);
      return reply({ ok: true, familyName: name, inviteCode, adminKey });
    }

    if (input.action === 'join') {
      const nickname = validNickname(input.nickname);
      if (!nickname) return reply({ error: 'Nickname must contain 2–24 letters or numbers' }, 400);
      if (!validKey(input.inviteCode, 'FAM')) return reply({ error: 'Invalid invitation code' }, 403);
      // Match the supplied code without disclosing any other family details.
      const { data: target, error: familyError } = await db.from('families')
        .select('id,name').eq('invite_hash', await hash('invite:' + normalize(input.inviteCode))).maybeSingle();
      if (familyError || !target) return reply({ error: 'Invalid invitation code' }, 403);
      if (joined.some(m => m.familyId === target.id)) return reply({ error: 'Already in this family' }, 409);

      const permanentId = playerId || authId;
      if (!playerId) {
        const { error: mapError } = await db.from('player_sessions')
          .insert({ auth_user_id: authId, player_id: permanentId });
        if (mapError) return reply({ error: 'Could not create player identity' }, 500);
      }
      const { error: joinError } = await db.from('family_members').insert({
        family_id: target.id, player_id: permanentId, nickname,
      });
      if (joinError) return reply({ error: 'Nickname is already taken in that family' }, 409);

      // A personal recovery key belongs to the PLAYER, not to one family.
      // Joining a second family never invalidates their previous REC key.
      let recoveryKey: string | undefined;
      const { data: existingRecovery } = await db.from('player_recovery')
        .select('player_id').eq('player_id', permanentId).maybeSingle();
      if (!existingRecovery) {
        recoveryKey = newKey('REC');
        const { error } = await db.from('player_recovery').insert({
          player_id: permanentId, key_hash: await hash('recovery:' + recoveryKey),
        });
        if (error) return reply({ error: 'Joined, but recovery key setup failed. Contact the organizer.' }, 500);
      }
      return reply({ ok: true, familyId: target.id, familyName: target.name, nickname, recoveryKey });
    }

    if (input.action === 'recover') {
      // Never silently overwrite an established player's sessions/memberships.
      if (joined.length) return reply({ error: 'This device already has a player. Use the family switcher.' }, 409);
      if (!validKey(input.recoveryKey, 'REC')) return reply({ error: 'Invalid recovery key' }, 403);
      const { data: match } = await db.from('player_recovery').select('player_id')
        .eq('key_hash', await hash('recovery:' + normalize(input.recoveryKey))).maybeSingle();
      if (!match) return reply({ error: 'Invalid recovery key' }, 403);
      const { data: restored } = await db.from('family_members')
        .select('family_id').eq('player_id', match.player_id).limit(1);
      if (!restored?.length) return reply({ error: 'No memberships found for that key' }, 403);
      const { error } = await db.from('player_sessions').upsert({
        auth_user_id: authId, player_id: match.player_id,
      }, { onConflict: 'auth_user_id' });
      if (error) return reply({ error: 'Could not recover player' }, 500);
      return reply({ ok: true });
    }

    if (input.action === 'rotate-recovery') {
      if (!joined.length || !playerId) return reply({ error: 'Join a family first' }, 403);
      const recoveryKey = newKey('REC');
      const { error } = await db.from('player_recovery').upsert({
        player_id: playerId, key_hash: await hash('recovery:' + recoveryKey),
        rotated_at: new Date().toISOString(),
      });
      if (error) return reply({ error: 'Could not replace recovery key' }, 500);
      return reply({ ok: true, recoveryKey });
    }

    if (input.action === 'rename') {
      if (!uuid(input.familyId) || !joined.some(m => m.familyId === input.familyId) || !playerId)
        return reply({ error: 'Select one of your families' }, 403);
      const nickname = validNickname(input.nickname);
      if (!nickname) return reply({ error: 'Invalid nickname' }, 400);
      const { error } = await db.from('family_members').update({ nickname })
        .eq('family_id', input.familyId).eq('player_id', playerId);
      if (error) return reply({ error: 'Nickname is already taken in that family' }, 409);
      return reply({ ok: true, nickname });
    }

    if (input.action === 'rotate-invite' || input.action === 'rotate-admin') {
      if (!validKey(input.adminKey, 'ADM')) return reply({ error: 'Invalid family admin key' }, 403);
      const { data: family } = await db.from('families').select('id,name')
        .eq('admin_key_hash', await hash('admin:' + normalize(input.adminKey))).maybeSingle();
      if (!family) return reply({ error: 'Invalid family admin key' }, 403);
      if (input.action === 'rotate-invite') {
        const inviteCode = newKey('FAM');
        const { error } = await db.from('families').update({
          invite_hash: await hash('invite:' + inviteCode), updated_at: new Date().toISOString(),
        }).eq('id', family.id);
        if (error) return reply({ error: 'Could not replace invitation code' }, 500);
        return reply({ ok: true, familyName: family.name, inviteCode });
      }
      const adminKey = newKey('ADM');
      const { error } = await db.from('families').update({
        admin_key_hash: await hash('admin:' + adminKey), updated_at: new Date().toISOString(),
      }).eq('id', family.id);
      if (error) return reply({ error: 'Could not replace admin key' }, 500);
      return reply({ ok: true, familyName: family.name, adminKey });
    }

    return reply({ error: 'Unknown action' }, 400);
  }),
};
