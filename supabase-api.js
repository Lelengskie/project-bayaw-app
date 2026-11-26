// Project Bayaw App — Direct Supabase Backend Adapter (100% Free Tier, Zero Netlify Credits!)
const SUPABASE_URL = 'https://iqktfuofdxiuubkycvau.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9KSkABDrgL41B-KfgEqFIQ_4372HQ1H';
const OWNER_MASTER_PASSCODE = 'BAYAW-OWNER-2026';

window.sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
}

function isOwnerPasscode(pass) {
  return String(pass || '').trim() === OWNER_MASTER_PASSCODE;
}

// Unified API handler replacing /api/leaderboard so every single feature works seamlessly on Supabase + GitHub Pages
window.bayawApi = async function(method, body = null, adminPasscode = '') {
  const sb = window.sbClient;
  const okRes = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

  try {
    if (method === 'GET') {
      const [{ data: accs, error: accErr }, { data: cfg }] = await Promise.all([
        sb.from('accounts').select('id,username_key,name,is_owner,title,a1_levels,a2_levels,a3_levels,a1_mastered,a2_mastered,a3_mastered,total_mastered,xp,rp,pvp_wins,pvp_losses,best_time_sec,updated_at'),
        sb.from('app_config').select('value').eq('key', 'launch_promo').maybeSingle()
      ]);
      if (accErr) return okRes({ error: accErr.message }, 500);

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

      let isOwner = isOwnerPasscode(adminPasscode);
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
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      await sb.from('global_chat').delete().neq('id', '');
      return okRes({ ok: true });
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
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const { data } = await sb.from('feedback_inbox').select('*').order('created_at', { ascending: false }).limit(100);
      const feedback = (data || []).map(f => ({
        id: f.id, name: f.name, category: f.category, message: f.message, createdAt: f.created_at
      }));
      return okRes({ ok: true, feedback });
    }

    if (action === 'admin_delete_feedback') {
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      await sb.from('feedback_inbox').delete().eq('id', body.feedbackId);
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

      if (isOwnerPasscode(accessCodeRaw)) {
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
          xp: acc.xp || 0, rp: acc.rp || 1200,
          pvpWins: acc.pvp_wins || 0, pvpLosses: acc.pvp_losses || 0,
          bestTimeSec: acc.best_time_sec ?? null,
          srs: acc.srs || {}
        }
      });
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
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Invalid Admin Passcode' }, 401);
      return okRes({ ok: true });
    }

    if (action === 'admin_set_promo') {
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const enabled = !!body.enabled;
      const hours = Math.max(1, Math.min(720, Number(body.hours) || 48));
      const trialDays = Math.max(1, Math.min(30, Number(body.trialDays) || 5));
      const endsAt = enabled ? Date.now() + hours * 3600 * 1000 : 0;
      const promo = { enabled, endsAt, trialDays };
      await sb.from('app_config').upsert({ key: 'launch_promo', value: promo });
      return okRes({ ok: true, promo: { ...promo, active: enabled && endsAt > Date.now() } });
    }

    if (action === 'admin_generate_access_code') {
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
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
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const { data } = await sb.from('access_codes').select('*').order('created_at', { ascending: false });
      const codes = (data || []).map(c => ({
        code: c.code, label: c.label, maxUses: c.max_uses, uses: c.uses,
        durationDays: c.duration_days, durationLabel: c.duration_label, createdAt: c.created_at
      }));
      return okRes({ ok: true, codes });
    }

    if (action === 'admin_delete_access_code') {
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      await sb.from('access_codes').delete().eq('code', String(body.code || '').toUpperCase());
      return okRes({ ok: true });
    }

    if (action === 'admin_list_accounts') {
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const { data } = await sb.from('accounts').select('id,username_key,name,is_owner,title,access_code_used,access_duration_label,access_expires_at,revoked,last_active_at,xp,rp');
      const now = Date.now();
      const accounts = (data || []).map(acc => {
        const isOnline = !!(acc.last_active_at && (now - acc.last_active_at) <= 90 * 1000);
        const daysRemaining = acc.access_expires_at ? Math.max(0, Math.ceil((acc.access_expires_at - now) / (86400 * 1000))) : null;
        return {
          id: acc.id, usernameKey: acc.username_key, name: acc.name,
          isOwner: !!acc.is_owner, title: acc.title || '',
          accessCodeUsed: acc.access_code_used || '—',
          accessDurationLabel: acc.access_duration_label || 'Unlimited',
          accessExpiresAt: acc.access_expires_at ?? null,
          daysRemaining, revoked: !!acc.revoked, isOnline,
          lastActiveAt: acc.last_active_at || 0, xp: acc.xp || 0, rp: acc.rp || 1200
        };
      }).sort((a, b) => (Number(b.isOnline) - Number(a.isOnline)) || (b.lastActiveAt - a.lastActiveAt));
      return okRes({ ok: true, onlineCount: accounts.filter(a => a.isOnline).length, totalAccounts: accounts.length, accounts });
    }

    if (action === 'admin_revoke_account') {
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const key = normKey(body.usernameKey);
      await sb.from('accounts').update({ revoked: body.revoke !== false, updated_at: Date.now() }).eq('username_key', key);
      return okRes({ ok: true });
    }

    if (action === 'admin_renew_account') {
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
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
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      const updates = { title: String(body.title || '').trim().slice(0, 28), updated_at: Date.now() };
      if (typeof body.isOwner === 'boolean') updates.is_owner = body.isOwner;
      await sb.from('accounts').update(updates).eq('id', body.targetId);
      return okRes({ ok: true });
    }

    if (action === 'admin_delete_user') {
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
      await sb.from('accounts').delete().eq('id', body.targetId);
      return okRes({ ok: true });
    }

    if (action === 'admin_reset_leaderboard') {
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
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
      if (!isOwnerPasscode(adminPasscode)) return okRes({ ok: false, error: 'Unauthorized' }, 401);
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
      if (isOwnerPasscode(rawInput)) return okRes({ ok: true, usedByOwner: true });

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
