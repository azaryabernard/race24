import { withSupabase } from 'npm:@supabase/server@1';

const reply = (body: unknown, status = 200) => Response.json(body, { status });
const normalize = (text: unknown) => typeof text === 'string' ? text.trim().toUpperCase() : '';
function newKey(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(prefix === 'FAM' ? 8 : 24)); // 64-bit invite; 192-bit recovery/admin
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
    const userId = ctx.userClaims?.id;
    if (!userId) return reply({ error: 'Anonymous Supabase session required' }, 401);
    const db = ctx.supabaseAdmin;
    const { data: family, error: familyError } = await db.from('families').select('*').limit(1).maybeSingle();
    if (familyError) return reply({ error: 'Family database unavailable' }, 500);
    const { data: session } = await db.from('player_sessions').select('player_id').eq('auth_user_id', userId).maybeSingle();
    const { data: member } = family && session ? await db.from('family_members')
      .select('nickname,player_id').eq('family_id', family.id).eq('player_id', session.player_id).maybeSingle()
      : { data: null };

    if (input.action === 'status') return reply({ configured: !!family, joined: !!member,
      familyName: member ? family.name : null, nickname: member?.nickname || null });

    if (['bootstrap','join','recover','rotate-invite','rotate-admin'].includes(String(input.action))) {
      const { data: permitted, error } = await db.rpc('consume_family_action', {
        p_auth: userId, p_action: String(input.action), p_max: 5,
      });
      if (error || permitted !== true) return reply({ error: 'Too many attempts; retry in 15 minutes' }, 429);
    }

    if (input.action === 'bootstrap') {
      if (family) return reply({ error: 'Family already exists' }, 409);
      const serverSecret = Deno.env.get('FAMILY_SETUP_SECRET') || '';
      if (serverSecret.length < 24 || typeof input.setupSecret !== 'string' ||
          await hash('setup:' + input.setupSecret) !== await hash('setup:' + serverSecret))
        return reply({ error: 'Invalid setup secret' }, 403);
      const name = typeof input.familyName === 'string' ? input.familyName.trim() : '';
      if (name.length < 2 || name.length > 50) return reply({ error: 'Family name must be 2–50 characters' }, 400);
      const inviteCode = newKey('FAM'); const adminKey = newKey('ADM');
      const { error } = await db.from('families').insert({
        name, invite_hash: await hash('invite:' + inviteCode), admin_key_hash: await hash('admin:' + adminKey),
      });
      if (error) return reply({ error: 'Unable to create family (or already created)' }, 409);
      return reply({ ok: true, inviteCode, adminKey });
    }
    if (!family) return reply({ error: 'Ask the organizer to set up the family first' }, 404);

    if (input.action === 'join') {
      if (member) return reply({ error: 'Already joined' }, 409);
      const nickname = validNickname(input.nickname);
      if (!nickname) return reply({ error: 'Nickname must contain 2–24 letters or numbers' }, 400);
      if (!validKey(input.inviteCode, 'FAM') || await hash('invite:' + normalize(input.inviteCode)) !== family.invite_hash)
        return reply({ error: 'Invalid invitation code' }, 403);
      if (session?.player_id && session.player_id !== userId) return reply({ error: 'Already recovered a different profile' }, 409);
      const { error: mappingError } = await db.from('player_sessions').upsert({ auth_user_id: userId, player_id: userId });
      if (mappingError) return reply({ error: 'Unable to create player identity' }, 500);
      const { error: joinError } = await db.from('family_members').insert({
        family_id: family.id, player_id: userId, nickname,
      });
      if (joinError) return reply({ error: 'Nickname already taken or unable to join' }, 409);
      const recoveryKey = newKey('REC');
      const { error: recoveryError } = await db.from('player_recovery').upsert({
        player_id: userId, key_hash: await hash('recovery:' + recoveryKey),
      });
      if (recoveryError) return reply({ error: 'Joined, but recovery key creation failed. Please contact organizer.' }, 500);
      return reply({ ok: true, nickname, familyName: family.name, recoveryKey });
    }

    if (input.action === 'recover') {
      if (member) return reply({ error: 'Already a member on this device' }, 409);
      if (!validKey(input.recoveryKey, 'REC')) return reply({ error: 'Invalid recovery key' }, 403);
      const { data: found } = await db.from('player_recovery').select('player_id')
        .eq('key_hash', await hash('recovery:' + normalize(input.recoveryKey))).maybeSingle();
      if (!found) return reply({ error: 'Invalid recovery key' }, 403);
      const { data: restored } = await db.from('family_members').select('nickname')
        .eq('family_id', family.id).eq('player_id', found.player_id).maybeSingle();
      if (!restored) return reply({ error: 'Recovery key does not belong to this family' }, 403);
      const { error } = await db.from('player_sessions').upsert({ auth_user_id: userId, player_id: found.player_id });
      if (error) return reply({ error: 'Could not recover player' }, 500);
      return reply({ ok: true, nickname: restored.nickname, familyName: family.name });
    }

    if (input.action === 'rotate-recovery') {
      if (!member) return reply({ error: 'Join first' }, 403);
      const recoveryKey = newKey('REC');
      const { error } = await db.from('player_recovery').upsert({
        player_id: member.player_id, key_hash: await hash('recovery:' + recoveryKey),
        rotated_at: new Date().toISOString(),
      });
      if (error) return reply({ error: 'Could not rotate recovery key' }, 500);
      return reply({ ok: true, recoveryKey });
    }

    if (input.action === 'rename') {
      if (!member) return reply({ error: 'Join first' }, 403);
      const nickname = validNickname(input.nickname);
      if (!nickname) return reply({ error: 'Invalid nickname' }, 400);
      const { error } = await db.from('family_members').update({ nickname })
        .eq('family_id', family.id).eq('player_id', member.player_id);
      if (error) return reply({ error: 'Nickname unavailable' }, 409);
      return reply({ ok: true, nickname });
    }

    if (input.action === 'rotate-invite' || input.action === 'rotate-admin') {
      if (!validKey(input.adminKey, 'ADM') || await hash('admin:' + normalize(input.adminKey)) !== family.admin_key_hash)
        return reply({ error: 'Invalid family admin recovery key' }, 403);
      if (input.action === 'rotate-invite') {
        const inviteCode = newKey('FAM');
        const { error } = await db.from('families').update({
          invite_hash: await hash('invite:' + inviteCode), updated_at: new Date().toISOString(),
        }).eq('id', family.id);
        if (error) return reply({ error: 'Could not change family code' }, 500);
        return reply({ ok: true, inviteCode });
      }
      const adminKey = newKey('ADM');
      const { error } = await db.from('families').update({
        admin_key_hash: await hash('admin:' + adminKey), updated_at: new Date().toISOString(),
      }).eq('id', family.id);
      if (error) return reply({ error: 'Could not rotate admin key' }, 500);
      return reply({ ok: true, adminKey });
    }
    return reply({ error: 'Unknown action' }, 400);
  }),
};
