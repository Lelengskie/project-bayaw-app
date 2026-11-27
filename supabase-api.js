// Project Bayaw App — Direct Supabase Backend Adapter (100% Free Tier, Zero Netlify Credits!)
const SUPABASE_URL = 'https://iqktfuofdxiuubkycvau.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9KSkABDrgL41B-KfgEqFIQ_4372HQ1H';
// Only the SHA-256 hash of the owner passcode is stored, so the code cannot be read from this file.
const OWNER_PASSCODE_SHA256 = "0e177d08b90792386d55f21a131c8fdc7824c0d1e138ec27103053ab6fa92118";

window.sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
}

async function isOwnerPasscode(pass) {
  const p = String(pass || '').trim();
  return !!p && (await sha256Hex(p)) === OWNER_PASSCODE_SHA256;
}

// Unified API handler replacing /api/leaderboard so every single feature works seamlessly on Supabase + GitHub Pages
window.bayawApi = async function(method, body = null, adminPasscode = '') {
  const sb = window.sbClient;
  const okRes = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

  try {
    if (method === 'GET') {
      const [{ data: accs, error: accErr }, { data: cfg }] = await Promise.all([
        sb.from('accounts').select('id,username_key,name,is_owner,title,a1_levels,a2_levels,a3_levels,a1_mastered,a2_mastered,a3_mastered,total_mastered,xp,rp,pvp_wins,pvp_losses,best_time_sec,last_active_at,updated_at'),
        sb.from('app_config').select('value').eq('key', 'launch_promo').maybeSingle()
      ]);
      if (accErr) return okRes({ error: accErr.message }, 500);

      const nowMs = Date.now();
      const onlineCount = (accs || []).filter(a => a.last_active_at && (nowMs - a.last_active_at) <= 180 * 1000).length;

      const records = (accs || []).map(a => ({
        id: a.id,
        usernameKey: a.username_key,
        name: a.name,
        isOwner: !!a.is_owner,
        title: a.title || '',
        a1Levels: a.a1_levels || 0,
        a2Levels: a.a2_levels || 0,
        a3Levels: a.a3_levels || 0,
        a1Mastered: a.a1_mastered || 0,
        a2Mastered: a.a2_mastered || 0,
        a3Mastered: a.a3_mastered || 0,
        totalMastered: a.total_mastered || 0,
        xp: a.xp || 0,
        rp: a.rp || 1200,
        pvpWins: a.pvp_wins || 0,
        pvpLosses: a.pvp_losses || 0,
        bestTimeSec: a.best_time_sec ?? null,
        updatedAt: a.updated_at || 0
      }));

      const progression = [...records]
        .sort((a, b) => (b.totalMastered - a.totalMastered) || (b.xp - a.xp))
        .slice(0, 100);

      const pvp = [...records]
        .filter(r => (r.pvpWins || 0) > 0 || (r.pvpLosses || 0) > 0 || r.rp !== 1200 || r.bestTimeSec !== null)
        .sort((a, b) => ((b.pvpWins || 0) - (a.pvpWins || 0)) || ((a.pvpLosses || 0) - (b.pvpLosses || 0)) || (b.rp - a.rp))
        .slice(0, 100);

      const promoVal = cfg?.value || { enabled: true, endsAt: Date.now() + 48 * 3600 * 1000, trialDays: 5 };
      const promoActive = !!(promoVal.enabled && promoVal.endsAt > Date.now());

      return okRes({
        totalReviewees: records.length,
        onlineCount,
        progression,
        pvp,
        allUsers: records.sort((a, b) => b.updatedAt - a.updatedAt),
        promo: {
          active: promoActive,
          enabled: !!promoVal.enabled,
          endsAt: promoVal.endsAt || 0,
          trialDays: promoVal.trialDays || 5
        }
      });
    }

    // POST actions
    const action = body?.action || 'sync';

    // 1. GLOBAL CHAT
    if (action === 'chat_list') {
      const { data } = await sb.from('global_chat').select('*').order('created_at', { ascending: true }).limit(50);
      const messages = (data || []).map(m => ({
        id: m.id, name: m.name, isOwner: !!m.is_owner, title: m.title || '', text: m.text, createdAt: m.created_at
      }));
      return okRes({ ok: true, messages });
    }

    if (action === 'chat_send') {
      const senderName = String(body.name || '').trim().slice(0, 24);
      const senderId = String(body.id || '').trim();
      const text = String(body.text || '').trim().slice(0, 240);
      if (!senderName || !text) return okRes({ ok: false, error: 'Empty message' }, 400);

      let isOwner = await isOwnerPasscode(adminPasscode);
      let title = '';
      if (senderId) {
        const { data: u } = await sb.from('accounts').select('is_owner,title').eq('id', senderId).maybeSingle();
        if (u) {
          isOwner = isOwner || !!u.is_owner;
          title = u.title || '';
        }
      }

      const msg = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: senderName,
        is_owner: isOwner,
        title,
        text,
        created_at: Date.now()
      };
      await sb.from('global_chat').insert(msg);
      const { data } = await sb.from('global_chat').select('*').order('created_at', { ascending: true }).limit(50);
      const messages = (data || []).map(m => ({
        id: m.id, name: m.name, isOwner: !!m.is_owner, title: m.title || '', text: m.text, createdAt: m.created_at
      }));
      return okRes({ ok: true, messages });
    }

    if (action === 'admin_clear_chat') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      await sb.from('global_chat').delete().neq('id', '');
      return okRes({ ok: true });
    }

    // 1B. REAL HUMAN-VS-HUMAN 1v1 PvP MATCHMAKING
    if (action === 'pvp_find_match') {
      const areaId = Number(body.areaId) || 1;
      const levelVal = String(body.levelVal || '1');
      const deckSize = Number(body.deckSize) || 10;
      const playerId = String(body.playerId || '');
      const playerName = String(body.playerName || 'Reviewee');
      const playerRp = Number(body.playerRp) || 1200;
      const now = Date.now();

      // Clean up stale waiting rooms older than 3 minutes
      await sb.from('pvp_matches').update({ status: 'cancelled' }).eq('status', 'waiting').lt('created_at', now - 180000);

      // Look for another real reviewee waiting for the exact same Area + Level + Deck Size
      const { data: waitingList } = await sb
        .from('pvp_matches')
        .select('*')
        .eq('status', 'waiting')
        .eq('area_id', areaId)
        .eq('level_val', levelVal)
        .eq('deck_size', deckSize)
        .neq('p1_id', playerId)
        .order('created_at', { ascending: true })
        .limit(1);

      if (waitingList && waitingList.length > 0) {
        const room = waitingList[0];
        const { data: joined, error: joinErr } = await sb
          .from('pvp_matches')
          .update({
            status: 'active',
            p2_id: playerId,
            p2_name: playerName,
            p2_rp: playerRp,
            p2_remaining: deckSize,
            p2_cleared: 0,
            p2_lapses: 0,
            started_at: now,
            updated_at: now
          })
          .eq('id', room.id)
          .eq('status', 'waiting')
          .select()
          .maybeSingle();

        if (!joinErr && joined) {
          return okRes({ ok: true, role: 'p2', matched: true, match: joined });
        }
      }

      // No waiting opponent found yet — create a waiting room and wait for a real human reviewee!
      const matchId = `pvp_${now}_${Math.random().toString(36).slice(2, 6)}`;
      const deckSeed = `BAYAW-${Math.floor(10000 + Math.random() * 90000)}`;
      const newRoom = {
        id: matchId,
        area_id: areaId,
        level_val: levelVal,
        deck_size: deckSize,
        deck_seed: deckSeed,
        status: 'waiting',
        p1_id: playerId,
        p1_name: playerName,
        p1_rp: playerRp,
        p1_remaining: deckSize,
        p1_cleared: 0,
        p1_lapses: 0,
        created_at: now,
        updated_at: now
      };
      const { data: created, error: createErr } = await sb.from('pvp_matches').insert(newRoom).select().single();
      if (createErr) return okRes({ ok: false, error: createErr.message }, 500);
      return okRes({ ok: true, role: 'p1', matched: false, match: created });
    }

    if (action === 'pvp_poll_match') {
      const matchId = String(body.matchId || '');
      const { data: match, error } = await sb.from('pvp_matches').select('*').eq('id', matchId).maybeSingle();
      if (error || !match) return okRes({ ok: false, error: 'Match not found' }, 404);
      return okRes({ ok: true, match });
    }

    if (action === 'pvp_cancel_match') {
      const matchId = String(body.matchId || '');
      if (matchId) {
        await sb.from('pvp_matches').update({ status: 'cancelled', updated_at: Date.now() }).eq('id', matchId).eq('status', 'waiting');
      }
      return okRes({ ok: true });
    }

    if (action === 'pvp_update_progress') {
      const matchId = String(body.matchId || '');
      const role = body.role === 'p2' ? 'p2' : 'p1';
      const remaining = Math.max(0, Number(body.remaining) || 0);
      const cleared = Math.max(0, Number(body.cleared) || 0);
      const lapses = Math.max(0, Number(body.lapses) || 0);
      const now = Date.now();

      const updates = {
        [`${role}_remaining`]: remaining,
        [`${role}_cleared`]: cleared,
        [`${role}_lapses`]: lapses,
        updated_at: now
      };

      if (remaining === 0) {
        updates[`${role}_finished_at`] = now;
        const { data: cur } = await sb.from('pvp_matches').select('winner_id,p1_id,p2_id').eq('id', matchId).maybeSingle();
        if (cur && !cur.winner_id) {
          updates.winner_id = role === 'p1' ? cur.p1_id : cur.p2_id;
          updates.status = 'finished';
        }
      }

      const { data: updated } = await sb.from('pvp_matches').update(updates).eq('id', matchId).select().maybeSingle();
      return okRes({ ok: true, match: updated });
    }

    if (action === 'pvp_forfeit') {
      const matchId = String(body.matchId || '');
      const role = body.role === 'p2' ? 'p2' : 'p1';
      const { data: cur } = await sb.from('pvp_matches').select('winner_id,p1_id,p2_id,status').eq('id', matchId).maybeSingle();
      if (cur && cur.status === 'active' && !cur.winner_id) {
        const oppId = role === 'p1' ? cur.p2_id : cur.p1_id;
        await sb.from('pvp_matches').update({ status: 'finished', winner_id: oppId, updated_at: Date.now() }).eq('id', matchId);
      }
      return okRes({ ok: true });
    }

    if (action === 'pvp_list_waiting') {
      const now = Date.now();
      const { data } = await sb
        .from('pvp_matches')
        .select('id,area_id,level_val,deck_size,p1_name,p1_rp,created_at')
        .eq('status', 'waiting')
        .gt('created_at', now - 180000)
        .order('created_at', { ascending: false })
        .limit(10);
      return okRes({ ok: true, waiting: data || [] });
    }

    // 2. USER FEEDBACK / SUGGESTIONS
    if (action === 'feedback_submit') {
      const senderName = String(body.name || 'Anonymous').trim().slice(0, 28);
      const category = String(body.category || 'Suggestion').trim().slice(0, 24);
      const message = String(body.message || '').trim().slice(0, 600);
      if (message.length < 3) return okRes({ ok: false, error: 'Too short' }, 400);
      await sb.from('feedback_inbox').insert({
        id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: senderName, category, message, created_at: Date.now()
      });
      return okRes({ ok: true });
    }

    if (action === 'admin_list_feedback') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const { data } = await sb.from('feedback_inbox').select('*').order('created_at', { ascending: false }).limit(100);
      const feedback = (data || []).map(f => ({
        id: f.id, name: f.name, category: f.category, message: f.message, createdAt: f.created_at
      }));
      return okRes({ ok: true, feedback });
    }

    if (action === 'admin_delete_feedback') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      await sb.from('feedback_inbox').delete().eq('id', body.feedbackId);
      return okRes({ ok: true });
    }

    // 2B. SUBMITTED REVIEWERS (.DOCX / .PDF) INBOX
    if (action === 'admin_list_reviewers') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const { data, error } = await sb.from('reviewer_submissions').select('*').order('created_at', { ascending: false }).limit(200);
      if (error) return okRes({ ok: false, error: error.message }, 500);
      const list = (data || []).map(r => ({
        id: r.id,
        usernameKey: r.username_key,
        senderName: r.sender_name,
        area: r.area || 'Mixed',
        title: r.title || r.file_name,
        notes: r.notes || '',
        fileName: r.file_name,
        fileSize: r.file_size || 0,
        filePath: r.file_path || null,
        fileUrl: r.file_url || null,
        status: r.status || 'pending',
        createdAt: r.created_at
      }));
      const countMap = {};
      let activeStorageBytes = 0;
      let activeFilesCount = 0;
      for (const r of list) {
        if (!countMap[r.usernameKey]) {
          countMap[r.usernameKey] = { usernameKey: r.usernameKey, senderName: r.senderName, count: 0 };
        }
        countMap[r.usernameKey].count += 1;
        if (r.filePath) {
          activeStorageBytes += Number(r.fileSize) || 0;
          activeFilesCount += 1;
        }
      }
      const contributors = Object.values(countMap).sort((a, b) => b.count - a.count);
      return okRes({ ok: true, reviewers: list, contributors, activeStorageBytes, activeFilesCount });
    }

    if (action === 'admin_mark_reviewer_added') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const id = String(body.reviewerId || '');
      const { data: rec } = await sb.from('reviewer_submissions').select('file_path').eq('id', id).maybeSingle();
      if (rec?.file_path) {
        await sb.storage.from('reviewer-submissions').remove([rec.file_path]);
      }
      await sb.from('reviewer_submissions').update({ status: 'added', file_path: null, file_url: null }).eq('id', id);
      return okRes({ ok: true });
    }

    if (action === 'admin_delete_reviewer') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const id = String(body.reviewerId || '');
      const { data: rec } = await sb.from('reviewer_submissions').select('file_path').eq('id', id).maybeSingle();
      if (rec?.file_path) {
        await sb.storage.from('reviewer-submissions').remove([rec.file_path]);
      }
      await sb.from('reviewer_submissions').delete().eq('id', id);
      return okRes({ ok: true });
    }

    // 3. AUTH: REGISTER, LOGIN, HEARTBEAT
    if (action === 'auth_register') {
      const displayName = String(body.username || '').trim().slice(0, 24);
      const password = String(body.password || '');
      const accessCodeRaw = String(body.accessCode || '').trim();
      const key = normKey(displayName);
      if (key.length < 3) return okRes({ ok: false, error: 'Username must be at least 3 letters/numbers.' }, 400);
      if (password.length < 4) return okRes({ ok: false, error: 'Password must be at least 4 characters.' }, 400);

      const { data: existing } = await sb.from('accounts').select('username_key').eq('username_key', key).maybeSingle();
      if (existing) return okRes({ ok: false, error: "That username is already taken! Switch to Sign In if it's yours." }, 409);

      const { data: cfg } = await sb.from('app_config').select('value').eq('key', 'launch_promo').maybeSingle();
      const promoVal = cfg?.value || { enabled: true, endsAt: Date.now() + 48 * 3600 * 1000, trialDays: 5 };
      const promoActive = !!(promoVal.enabled && promoVal.endsAt > Date.now());

      let isOwnerMaster = false;
      let usedCodeStr = 'OWNER-MASTER';
      let durationDays = null;
      let durationLabel = 'Unlimited';

      if (await isOwnerPasscode(accessCodeRaw)) {
        isOwnerMaster = true;
      } else if (!accessCodeRaw && promoActive) {
        usedCodeStr = 'LAUNCH-PROMO-5D';
        durationDays = promoVal.trialDays || 5;
        durationLabel = `${durationDays} Days Free (Launch Promo)`;
      } else {
        const upperCode = accessCodeRaw.toUpperCase();
        if (!upperCode) {
          return okRes({ ok: false, error: 'The 2-day free launch promo has ended. An Owner Access Code is required.' }, 403);
        }
        const { data: codeRec } = await sb.from('access_codes').select('*').eq('code', upperCode).maybeSingle();
        if (!codeRec) return okRes({ ok: false, error: 'Invalid Access Code. Ask the Owner for an invite code.' }, 403);
        if ((codeRec.uses || 0) >= (codeRec.max_uses || 1)) {
          return okRes({ ok: false, error: 'This Access Code has reached its maximum uses.' }, 403);
        }
        await sb.from('access_codes').update({ uses: (codeRec.uses || 0) + 1 }).eq('code', upperCode);
        usedCodeStr = upperCode;
        durationDays = codeRec.duration_days ?? null;
        durationLabel = codeRec.duration_label || (durationDays ? `${durationDays} Days` : 'Unlimited');
      }

      const now = Date.now();
      const passwordHash = await sha256Hex(`bayaw_salt_${key}_${password}`);
      const accessExpiresAt = durationDays ? now + durationDays * 24 * 60 * 60 * 1000 : null;
      const userId = `acc_${key}`;

      const newRow = {
        username_key: key,
        id: userId,
        name: displayName,
        password_hash: passwordHash,
        is_owner: isOwnerMaster,
        title: isOwnerMaster ? 'OWNER' : '',
        access_code_used: usedCodeStr,
        access_duration_label: durationLabel,
        access_expires_at: accessExpiresAt,
        revoked: false,
        last_active_at: now,
        a1_levels: 0, a2_levels: 0, a3_levels: 0,
        a1_mastered: 0, a2_mastered: 0, a3_mastered: 0,
        total_mastered: 0, xp: 0, rp: 1200, pvp_wins: 0, pvp_losses: 0,
        best_time_sec: null, srs: {},
        created_at: now, updated_at: now
      };
      const { error: insErr } = await sb.from('accounts').insert(newRow);
      if (insErr) return okRes({ ok: false, error: insErr.message }, 500);

      return okRes({
        ok: true,
        isOwnerMaster,
        user: {
          id: userId, usernameKey: key, name: displayName,
          isOwner: isOwnerMaster, title: newRow.title,
          xp: 0, rp: 1200, pvpWins: 0, pvpLosses: 0, bestTimeSec: null, srs: {}
        }
      });
    }

    if (action === 'auth_login') {
      const displayName = String(body.username || '').trim();
      const password = String(body.password || '');
      const key = normKey(displayName);
      if (!key || !password) return okRes({ ok: false, error: 'Enter both username and password.' }, 400);

      const { data: acc } = await sb.from('accounts').select('*').eq('username_key', key).maybeSingle();
      if (!acc) return okRes({ ok: false, error: 'Account not found. Please Create Account first.' }, 404);

      const hash = await sha256Hex(`bayaw_salt_${key}_${password}`);
      if (hash !== acc.password_hash) return okRes({ ok: false, error: 'Incorrect password. Please try again.' }, 401);

      if (!acc.is_owner) {
        if (acc.revoked) return okRes({ ok: false, error: 'Your access has been revoked by the Owner.' }, 403);
        if (acc.access_expires_at && acc.access_expires_at < Date.now()) {
          return okRes({ ok: false, error: 'Your access pass has expired! Ask the Owner to renew your access.' }, 403);
        }
      }

      await sb.from('accounts').update({ last_active_at: Date.now() }).eq('username_key', key);
      return okRes({
        ok: true,
        user: {
          id: acc.id, usernameKey: acc.username_key, name: acc.name,
          isOwner: !!acc.is_owner, title: acc.title || '',
          fullMockAccess: !!(acc.full_mock_access || acc.is_owner),
          mockHistory: Array.isArray(acc.mock_history) ? acc.mock_history : [],
          xp: acc.xp || 0, rp: acc.rp || 1200,
          pvpWins: acc.pvp_wins || 0, pvpLosses: acc.pvp_losses || 0,
          bestTimeSec: acc.best_time_sec ?? null,
          srs: acc.srs || {}
        }
      });
    }

    if (action === 'get_mock_access') {
      const key = normKey(body.usernameKey);
      if (!key) return okRes({ ok: false, fullMockAccess: false, mockHistory: [] });
      const { data: acc } = await sb.from('accounts').select('*').eq('username_key', key).maybeSingle();
      if (!acc) return okRes({ ok: false, fullMockAccess: false, mockHistory: [] });
      return okRes({
        ok: true,
        fullMockAccess: !!(acc.full_mock_access || acc.is_owner),
        mockHistory: Array.isArray(acc.mock_history) ? acc.mock_history : []
      });
    }

    if (action === 'save_mock_history') {
      const key = normKey(body.usernameKey);
      const history = Array.isArray(body.mockHistory) ? body.mockHistory.slice(0, 30) : [];
      if (!key) return okRes({ ok: false }, 400);
      const { error } = await sb.from('accounts').update({ mock_history: history, updated_at: Date.now() }).eq('username_key', key);
      return okRes({ ok: !error, error: error?.message || '' });
    }

    if (action === 'heartbeat') {
      const key = normKey(body.usernameKey);
      if (!key) return okRes({ ok: false }, 400);
      const { data: acc } = await sb.from('accounts').select('is_owner,revoked,access_expires_at').eq('username_key', key).maybeSingle();
      if (!acc) return okRes({ ok: false, kicked: true, reason: 'Account removed by Owner.' }, 403);
      if (!acc.is_owner && acc.revoked) return okRes({ ok: false, kicked: true, reason: 'Your access was revoked by the Owner.' }, 403);
      if (!acc.is_owner && acc.access_expires_at && acc.access_expires_at < Date.now()) {
        return okRes({ ok: false, kicked: true, reason: 'Your access pass has expired.' }, 403);
      }
      await sb.from('accounts').update({ last_active_at: Date.now() }).eq('username_key', key);
      return okRes({ ok: true });
    }

    // 4. OWNER ADMIN ACTIONS
    if (action === 'admin_verify') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Invalid Admin Passcode' }, 401);
      return okRes({ ok: true });
    }

    if (action === 'admin_set_promo') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const enabled = !!body.enabled;
      const hours = Math.max(1, Math.min(720, Number(body.hours) || 48));
      const trialDays = Math.max(1, Math.min(30, Number(body.trialDays) || 5));
      const endsAt = enabled ? Date.now() + hours * 3600 * 1000 : 0;
      const promo = { enabled, endsAt, trialDays };
      await sb.from('app_config').upsert({ key: 'launch_promo', value: promo });
      return okRes({ ok: true, promo: { ...promo, active: enabled && endsAt > Date.now() } });
    }

    if (action === 'admin_generate_access_code') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let randPart = '';
      for (let i = 0; i < 6; i++) randPart += chars[Math.floor(Math.random() * chars.length)];
      const maxUses = Math.max(1, Math.min(500, Number(body.maxUses) || 1));
      const label = String(body.label || '').trim().slice(0, 32);
      const dMap = {
        '3d': { days: 3, label: '3 Days' },
        '7d': { days: 7, label: '7 Days' },
        '30d': { days: 30, label: '1 Month' },
        '90d': { days: 90, label: '3 Months' },
        'unli': { days: null, label: 'Unlimited' }
      };
      const chosen = dMap[body.duration] || dMap['unli'];
      const code = `BAYAW-${randPart}`;
      await sb.from('access_codes').insert({
        code, label, max_uses: maxUses, uses: 0,
        duration_days: chosen.days, duration_label: chosen.label, created_at: Date.now()
      });
      return okRes({ ok: true, code, maxUses, label, durationLabel: chosen.label });
    }

    if (action === 'admin_list_access_codes') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const { data } = await sb.from('access_codes').select('*').order('created_at', { ascending: false });
      const codes = (data || []).map(c => ({
        code: c.code, label: c.label, maxUses: c.max_uses, uses: c.uses,
        durationDays: c.duration_days, durationLabel: c.duration_label, createdAt: c.created_at
      }));
      return okRes({ ok: true, codes });
    }

    if (action === 'admin_delete_access_code') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      await sb.from('access_codes').delete().eq('code', String(body.code || '').toUpperCase());
      return okRes({ ok: true });
    }

    if (action === 'admin_list_accounts') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const [{ data }, revRes] = await Promise.all([
        sb.from('accounts').select('*'),
        sb.from('reviewer_submissions').select('username_key')
      ]);
      const revCounts = {};
      if (!revRes?.error && Array.isArray(revRes?.data)) {
        for (const r of revRes.data) {
          revCounts[r.username_key] = (revCounts[r.username_key] || 0) + 1;
        }
      }
      const now = Date.now();
      const accounts = (data || []).map(acc => {
        const isOnline = !!(acc.last_active_at && (now - acc.last_active_at) <= 180 * 1000);
        const daysRemaining = acc.access_expires_at ? Math.max(0, Math.ceil((acc.access_expires_at - now) / (86400 * 1000))) : null;
        return {
          id: acc.id, usernameKey: acc.username_key, name: acc.name,
          isOwner: !!acc.is_owner, title: acc.title || '',
          fullMockAccess: !!(acc.full_mock_access || acc.is_owner),
          accessCodeUsed: acc.access_code_used || '—',
          accessDurationLabel: acc.access_duration_label || 'Unlimited',
          accessExpiresAt: acc.access_expires_at ?? null,
          daysRemaining, revoked: !!acc.revoked, isOnline,
          lastActiveAt: acc.last_active_at || 0, xp: acc.xp || 0, rp: acc.rp || 1200,
          reviewersSent: revCounts[acc.username_key] || 0
        };
      }).sort((a, b) => (Number(b.isOnline) - Number(a.isOnline)) || (b.lastActiveAt - a.lastActiveAt));
      return okRes({ ok: true, onlineCount: accounts.filter(a => a.isOnline).length, totalAccounts: accounts.length, accounts });
    }

    if (action === 'admin_set_full_mock') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const key = normKey(body.usernameKey);
      const granted = !!body.granted;
      const { error } = await sb.from('accounts').update({ full_mock_access: granted, updated_at: Date.now() }).eq('username_key', key);
      if (error) return okRes({ ok: false, error: error.message }, 500);
      return okRes({ ok: true, granted });
    }

    if (action === 'admin_revoke_account') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const key = normKey(body.usernameKey);
      await sb.from('accounts').update({ revoked: body.revoke !== false, updated_at: Date.now() }).eq('username_key', key);
      return okRes({ ok: true });
    }

    if (action === 'admin_renew_account') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const key = normKey(body.usernameKey);
      const { data: acc } = await sb.from('accounts').select('access_expires_at').eq('username_key', key).maybeSingle();
      if (!acc) return okRes({ ok: false, error: 'Account not found' }, 404);
      const rMap = {
        '1d': { days: 1, label: '+1 Day' }, '3d': { days: 3, label: '+3 Days' },
        '7d': { days: 7, label: '+1 Week' }, '14d': { days: 14, label: '+2 Weeks' },
        '30d': { days: 30, label: '+1 Month' }, '90d': { days: 90, label: '+3 Months' },
        'unli': { days: null, label: 'Unlimited' }
      };
      const chosen = rMap[body.duration] || rMap['7d'];
      const now = Date.now();
      let newExp = null;
      if (chosen.days !== null) {
        const base = (acc.access_expires_at && acc.access_expires_at > now) ? acc.access_expires_at : now;
        newExp = base + chosen.days * 86400 * 1000;
      }
      await sb.from('accounts').update({
        access_expires_at: newExp,
        access_duration_label: chosen.label,
        revoked: false,
        updated_at: now
      }).eq('username_key', key);
      return okRes({ ok: true });
    }

    if (action === 'admin_set_title') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const updates = { title: String(body.title || '').trim().slice(0, 28), updated_at: Date.now() };
      if (typeof body.isOwner === 'boolean') updates.is_owner = body.isOwner;
      await sb.from('accounts').update(updates).eq('id', body.targetId);
      return okRes({ ok: true });
    }

    if (action === 'admin_delete_user') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      if (body.usernameKey) {
        await sb.from('accounts').delete().eq('username_key', normKey(body.usernameKey));
      } else if (body.targetId) {
        await sb.from('accounts').delete().eq('id', body.targetId);
      }
      return okRes({ ok: true });
    }

    if (action === 'admin_reset_password') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const key = normKey(body.usernameKey);
      const newPw = String(body.newPassword || '');
      if (!key || newPw.length < 4) {
        return okRes({ ok: false, error: 'New password must be at least 4 characters.' }, 400);
      }
      const newHash = await sha256Hex(`bayaw_salt_${key}_${newPw}`);
      await sb.from('accounts').update({ password_hash: newHash, updated_at: Date.now() }).eq('username_key', key);
      return okRes({ ok: true });
    }

    if (action === 'admin_reset_leaderboard') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const scope = body.scope || 'all';
      if (scope === 'pvp') {
        await sb.from('accounts').update({ rp: 1200, pvp_wins: 0, pvp_losses: 0, best_time_sec: null, updated_at: Date.now() }).neq('id', '');
      } else if (scope === 'progression') {
        await sb.from('accounts').update({
          a1_levels: 0, a2_levels: 0, a3_levels: 0,
          a1_mastered: 0, a2_mastered: 0, a3_mastered: 0,
          total_mastered: 0, xp: 0, srs: {}, updated_at: Date.now()
        }).neq('id', '');
      } else {
        await sb.from('accounts').update({
          a1_levels: 0, a2_levels: 0, a3_levels: 0,
          a1_mastered: 0, a2_mastered: 0, a3_mastered: 0,
          total_mastered: 0, xp: 0, rp: 1200, pvp_wins: 0, pvp_losses: 0,
          best_time_sec: null, srs: {}, updated_at: Date.now()
        }).neq('id', '');
      }
      return okRes({ ok: true });
    }

    if (action === 'admin_generate_reset_code') {
      if (!(await isOwnerPasscode(adminPasscode))) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let randPart = '';
      for (let i = 0; i < 6; i++) randPart += chars[Math.floor(Math.random() * chars.length)];
      const code = `RESET-${randPart}`;
      const expiresAt = Date.now() + 24 * 3600 * 1000;
      await sb.from('reset_codes').insert({ code, expires_at: expiresAt, created_at: Date.now() });
      return okRes({ ok: true, code, expiresAt });
    }

    if (action === 'verify_reset_code') {
      const rawInput = String(body.code || '').trim();
      const rawCode = rawInput.toUpperCase();
      if (!rawCode) return okRes({ ok: false, error: 'Please enter a reset code from the Owner.' }, 400);
      if (await isOwnerPasscode(rawInput)) return okRes({ ok: true, usedByOwner: true });

      const { data: rec } = await sb.from('reset_codes').select('*').eq('code', rawCode).maybeSingle();
      if (!rec) return okRes({ ok: false, error: 'Invalid or already-used Reset Code. Ask the Owner for a valid code.' }, 403);
      if (rec.expires_at && rec.expires_at < Date.now()) {
        await sb.from('reset_codes').delete().eq('code', rawCode);
        return okRes({ ok: false, error: 'This Reset Code has expired. Ask the Owner for a new one.' }, 403);
      }
      // Strictly one-time use: burn immediately
      await sb.from('reset_codes').delete().eq('code', rawCode);
      return okRes({ ok: true, verifiedCode: rawCode });
    }

    // 5. DEFAULT: REGULAR REVIEWEE CLOUD SYNC
    if (body && body.usernameKey) {
      const uKey = normKey(body.usernameKey);
      const updates = {
        name: String(body.name || '').trim().slice(0, 28),
        a1_levels: Math.max(0, Math.min(13, Number(body.a1Levels) || 0)),
        a2_levels: Math.max(0, Math.min(13, Number(body.a2Levels) || 0)),
        a3_levels: Math.max(0, Math.min(22, Number(body.a3Levels) || 0)),
        a1_mastered: Math.max(0, Math.min(1222, Number(body.a1Mastered) || 0)),
        a2_mastered: Math.max(0, Math.min(1242, Number(body.a2Mastered) || 0)),
        a3_mastered: Math.max(0, Math.min(2115, Number(body.a3Mastered) || 0)),
        total_mastered: Math.max(0, Math.min(4579, Number(body.totalMastered) || 0)),
        xp: Math.max(0, Number(body.xp) || 0),
        rp: Math.max(800, Math.min(5000, Number(body.rp) || 1200)),
        pvp_wins: Math.max(0, Number(body.pvpWins) || 0),
        pvp_losses: Math.max(0, Number(body.pvpLosses) || 0),
        best_time_sec: body.bestTimeSec ? Number(body.bestTimeSec) : null,
        last_active_at: Date.now(),
        updated_at: Date.now()
      };
      if (body.srs && typeof body.srs === 'object') updates.srs = body.srs;
      await sb.from('accounts').update(updates).eq('username_key', uKey);
      const { data: acc } = await sb.from('accounts').select('is_owner,title').eq('username_key', uKey).maybeSingle();
      return okRes({ ok: true, record: { isOwner: !!acc?.is_owner, title: acc?.title || '' } });
    }

    return okRes({ ok: false, error: 'Unknown action' }, 400);
  } catch (err) {
    console.error('Supabase API error:', err);
    return okRes({ ok: false, error: err?.message || 'Supabase error' }, 500);
  }
};

// Direct Supabase Storage uploader for reviewee .docx / .pdf contributions
window.bayawUploadReviewer = async function(file, meta = {}) {
  const sb = window.sbClient;
  const maxBytes = 15 * 1024 * 1024; // 15 MB cap
  if (!file) return { ok: false, error: 'Please select a .docx or .pdf file.' };
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!['docx', 'doc', 'pdf'].includes(ext)) {
    return { ok: false, error: 'Only .docx, .doc, or .pdf reviewer files are allowed.' };
  }
  if (file.size > maxBytes) {
    return { ok: false, error: 'File is too large. Maximum allowed size is 15 MB.' };
  }

  const uKey = normKey(meta.usernameKey || meta.senderName || 'guest') || 'guest';
  const senderName = String(meta.senderName || 'Reviewee').trim().slice(0, 28);
  const area = String(meta.area || 'Mixed / All Areas').trim().slice(0, 40);
  const title = String(meta.title || file.name).trim().slice(0, 120);
  const notes = String(meta.notes || '').trim().slice(0, 400);
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const now = Date.now();
  const filePath = `${uKey}/${now}_${safeName}`;

  const { error: upErr } = await sb.storage.from('reviewer-submissions').upload(filePath, file, {
    cacheControl: '3600',
    upsert: false
  });
  if (upErr) return { ok: false, error: upErr.message || 'Upload failed.' };

  const { data: urlData } = sb.storage.from('reviewer-submissions').getPublicUrl(filePath);
  const fileUrl = urlData?.publicUrl || '';

  const row = {
    id: `rev_${now}_${Math.random().toString(36).slice(2, 6)}`,
    username_key: uKey,
    sender_name: senderName,
    area,
    title,
    notes,
    file_name: file.name.slice(0, 120),
    file_size: file.size || 0,
    file_path: filePath,
    file_url: fileUrl,
    status: 'pending',
    created_at: now
  };
  const { error: dbErr } = await sb.from('reviewer_submissions').insert(row);
  if (dbErr) {
    // Clean up orphaned file if DB insert failed
    await sb.storage.from('reviewer-submissions').remove([filePath]);
    return { ok: false, error: dbErr.message || 'Could not record submission.' };
  }
  return { ok: true, submission: row };
};
