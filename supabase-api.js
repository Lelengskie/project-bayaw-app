// Project Bayaw App — Direct Supabase Backend Adapter (100% Free Tier, Zero Netlify Credits!)
const SUPABASE_URL = 'https://iqktfuofdxiuubkycvau.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9KSkABDrgL41B-KfgEqFIQ_4372HQ1H';
// Owner checks, sign-up, sign-in and chat badges run inside Supabase (bayaw_* functions, see site-tools/supabase-owner-lockdown.sql
// and site-tools/supabase-auth-upgrade.sql). Progress and PvP saves only work for your own account's real login.

window.sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
}

// ---------- Supabase Auth (real login) ----------
// Each username gets a hidden login e-mail; it must match private.auth_email() in site-tools/supabase-auth-upgrade.sql.
function authEmail(key) {
  return 'u' + Array.from(new TextEncoder().encode(key), b => b.toString(16).padStart(2, '0')).join('') + '@users.project-bayaw-app.site';
}
// The login password is the salted SHA-256 the site already used, so old accounts can move over with their own password.
const passwordHashFor = (key, password) => sha256Hex(`bayaw_salt_${key}_${password}`);

async function authSignIn(key, hash) {
  const { data, error } = await window.sbClient.auth.signInWithPassword({ email: authEmail(key), password: hash });
  return error ? null : data.session;
}

async function authSignUp(key, hash) {
  const { data, error } = await window.sbClient.auth.signUp({ email: authEmail(key), password: hash });
  if (error) return { error: error.message, taken: /already registered|already exists/i.test(error.message) };
  if (!data.session) return { error: 'Sign-up is not finished on the server yet. Ask the owner to turn off "Confirm email" in Supabase.' };
  return { session: data.session };
}

function userFromAccount(acc) {
  return {
    id: acc.id, usernameKey: acc.username_key, name: acc.name,
    isOwner: !!acc.is_owner, title: acc.title || '',
    fullMockAccess: !!(acc.full_mock_access || acc.is_owner),
    mockHistory: Array.isArray(acc.mock_history) ? acc.mock_history : [],
    xp: acc.xp || 0, rp: acc.rp || 1200,
    pvpWins: acc.pvp_wins || 0, pvpLosses: acc.pvp_losses || 0,
    bestTimeSec: acc.best_time_sec ?? null,
    srs: acc.srs || {}
  };
}

// True when this browser holds a real login for the given username.
window.bayawHasLogin = async function(usernameKey) {
  try {
    const { data } = await window.sbClient.auth.getSession();
    return !!data.session && data.session.user?.email === authEmail(normKey(usernameKey));
  } catch (e) { return false; }
};
window.bayawSignOut = async function() {
  try { await window.sbClient.auth.signOut(); } catch (e) {}
};

async function callRpc(fn, args) {
  const { data, error } = await window.sbClient.rpc(fn, args);
  return error ? { ok: false, status: 500, error: error.message } : data;
}

// Owner actions whose request body goes to bayaw_admin unchanged
const SIMPLE_ADMIN = new Set(['verify', 'clear_chat', 'delete_feedback', 'set_promo', 'generate_access_code', 'delete_access_code',
  'set_full_mock', 'revoke_account', 'renew_account', 'set_title', 'reset_leaderboard', 'generate_reset_code']);

// Unified API handler replacing /api/leaderboard so every single feature works seamlessly on Supabase + GitHub Pages
window.bayawApi = async function(method, body = null, adminPasscode = '') {
  const sb = window.sbClient;
  const okRes = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  const out = (d) => okRes(d, d && d.ok === false ? (d.status || 400) : 200);
  const admin = (act, p = {}) => callRpc('bayaw_admin', { p_pass: adminPasscode || '', p_action: act, p });

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
      // With "since", only messages newer than that are sent (usually none), which keeps downloads tiny
      const since = Number(body.since) || 0;
      let q = sb.from('global_chat').select('id,name,is_owner,title,text,created_at');
      q = since ? q.gt('created_at', since).order('created_at', { ascending: true }).limit(50)
                : q.order('created_at', { ascending: false }).limit(50);
      const { data } = await q;
      const rows = since ? (data || []) : (data || []).reverse();
      const messages = rows.map(m => ({
        id: m.id, name: m.name, isOwner: !!m.is_owner, title: m.title || '', text: m.text, createdAt: m.created_at
      }));
      return okRes({ ok: true, messages });
    }

    if (action === 'chat_send') {
      const senderName = String(body.name || '').trim().slice(0, 24);
      const senderId = String(body.id || '').trim();
      const text = String(body.text || '').trim().slice(0, 240);
      if (!senderName || !text) return okRes({ ok: false, error: 'Empty message' }, 400);

      // The owner badge and title are decided by Supabase, not by the browser
      const sent = await callRpc('bayaw_chat_send', { p_name: senderName, p_id: senderId, p_text: text, p_pass: adminPasscode || '' });
      if (!sent.ok) return out(sent);
      const { data } = await sb.from('global_chat').select('id,name,is_owner,title,text,created_at').order('created_at', { ascending: false }).limit(50);
      const messages = (data || []).reverse().map(m => ({
        id: m.id, name: m.name, isOwner: !!m.is_owner, title: m.title || '', text: m.text, createdAt: m.created_at
      }));
      return okRes({ ok: true, messages });
    }

    if (action.startsWith('admin_') && SIMPLE_ADMIN.has(action.slice(6))) {
      return out(await admin(action.slice(6), body));
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
      const res = await admin('list_feedback');
      if (!res.ok) return out(res);
      const feedback = (res.rows || []).map(f => ({
        id: f.id, name: f.name, category: f.category, message: f.message, createdAt: f.created_at
      }));
      return okRes({ ok: true, feedback });
    }

    // 2B. SUBMITTED REVIEWERS (.DOCX / .PDF) INBOX
    if (action === 'admin_list_reviewers') {
      const res = await admin('list_reviewers');
      if (!res.ok) return out(res);
      const list = (res.rows || []).map(r => ({
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

    if (action === 'admin_mark_reviewer_added' || action === 'admin_delete_reviewer') {
      const res = await admin(action === 'admin_delete_reviewer' ? 'delete_reviewer' : 'mark_reviewer_added', { reviewerId: String(body.reviewerId || '') });
      if (res.ok && res.filePath) await sb.storage.from('reviewer-submissions').remove([res.filePath]);
      return out(res);
    }

    // 3. AUTH: REGISTER, LOGIN, HEARTBEAT
    if (action === 'auth_register') {
      const displayName = String(body.username || '').trim().slice(0, 24);
      const password = String(body.password || '');
      const accessCodeRaw = String(body.accessCode || '').trim();
      const key = normKey(displayName);
      if (key.length < 3) return okRes({ ok: false, error: 'Username must be at least 3 letters/numbers.' }, 400);
      if (password.length < 6) return okRes({ ok: false, error: 'Password must be at least 6 characters.' }, 400);

      // Check username and code first so a failed sign-up does not leave a stray login behind
      const check = await callRpc('bayaw_register_check', { p_key: key, p_code: accessCodeRaw });
      if (!check.ok) return out(check);

      const hash = await passwordHashFor(key, password);
      const up = await authSignUp(key, hash);
      if (up.error) {
        // A login can be left over from an earlier attempt that stopped half way; it is yours if the password matches
        if (!up.taken || !(await authSignIn(key, hash))) {
          return okRes({ ok: false, error: up.taken ? 'That username is already taken! Switch to Sign In if it\'s yours.' : up.error }, up.taken ? 409 : 500);
        }
      }
      const res = await callRpc('bayaw_register', { p_key: key, p_name: displayName, p_hash: hash, p_code: accessCodeRaw });
      if (!res.ok) { await window.bayawSignOut(); return out(res); }
      const isOwnerMaster = !!res.isOwnerMaster;

      return okRes({
        ok: true,
        isOwnerMaster,
        user: {
          id: `acc_${key}`, usernameKey: key, name: displayName,
          isOwner: isOwnerMaster, title: res.title || '',
          xp: 0, rp: 1200, pvpWins: 0, pvpLosses: 0, bestTimeSec: null, srs: {}
        }
      });
    }

    if (action === 'auth_login') {
      const displayName = String(body.username || '').trim();
      const password = String(body.password || '');
      const key = normKey(displayName);
      if (!key || !password) return okRes({ ok: false, error: 'Enter both username and password.' }, 400);

      const hash = await passwordHashFor(key, password);
      if (!(await authSignIn(key, hash))) {
        // Not on the new login yet: check the old password, then move the account over (one time)
        const legacy = await callRpc('bayaw_login', { p_key: key, p_hash: hash });
        if (!legacy.ok) return out(legacy);
        const up = await authSignUp(key, hash);
        if (up.error) {
          return okRes({ ok: false, error: up.taken ? 'Your sign-in needs a quick fix. Ask the owner to reset your password.' : up.error }, 500);
        }
        const link = await callRpc('bayaw_link_auth', { p_key: key, p_hash: hash });
        if (!link.ok) { await window.bayawSignOut(); return out(link); }
      }
      const me = await callRpc('bayaw_me', {});
      if (!me.ok) { await window.bayawSignOut(); return out(me); }
      return okRes({ ok: true, user: userFromAccount(me.account) });
    }

    if (action === 'get_mock_access') {
      const key = normKey(body.usernameKey);
      if (!key) return okRes({ ok: false, fullMockAccess: false, mockHistory: [] });
      const { data: acc } = await sb.from('accounts').select('full_mock_access,is_owner,mock_history').eq('username_key', key).maybeSingle();
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

    // 4. OWNER ADMIN ACTIONS (checked inside Supabase by bayaw_admin; simple ones are handled near the top)
    if (action === 'admin_list_access_codes') {
      const res = await admin('list_access_codes');
      if (!res.ok) return out(res);
      const codes = (res.rows || []).map(c => ({
        code: c.code, label: c.label, maxUses: c.max_uses, uses: c.uses,
        durationDays: c.duration_days, durationLabel: c.duration_label, createdAt: c.created_at
      }));
      return okRes({ ok: true, codes });
    }

    if (action === 'admin_list_accounts') {
      const res = await admin('list_accounts');
      if (!res.ok) return out(res);
      const revCounts = res.reviewerCounts || {};
      const now = Date.now();
      const accounts = (res.rows || []).map(acc => {
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

    if (action === 'admin_reset_password') {
      const key = normKey(body.usernameKey);
      const newPw = String(body.newPassword || '');
      if (!key || newPw.length < 6) {
        return okRes({ ok: false, error: 'New password must be at least 6 characters.' }, 400);
      }
      // Changes both the old password and the real login password
      return out(await callRpc('bayaw_admin_auth', { p_pass: adminPasscode || '', p_action: 'reset_password', p: { usernameKey: key, hash: await passwordHashFor(key, newPw) } }));
    }

    if (action === 'admin_delete_user') {
      return out(await callRpc('bayaw_admin_auth', { p_pass: adminPasscode || '', p_action: 'delete_user', p: body }));
    }

    if (action === 'verify_reset_code') {
      return out(await callRpc('bayaw_verify_reset_code', { p_code: String(body.code || '') }));
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
