// AgriBoard Prep (Project Bayaw) — Gamified ABELE Reviewer & 1v1 PvP Anki Race Engine
const STORAGE_KEY = 'agriboard_prep_abe_v2';
// PRC 2027 schedule: ABE licensure exam on Nov 22-23, 2027 (prc.gov.ph/2027-schedule-examination). Reviewees can change it.
const DEFAULT_EXAM_DATE = '2027-11-22';
// Shown one per day on the home dashboard
const DAILY_LINES = [
  "One more card today is one less surprise on exam day.",
  "You don't need to be perfect. You need to keep going.",
  "The board exam rewards the reviewee who showed up on the boring days.",
  "A little effort today, Engr. on your name tomorrow.",
  "Every question you miss here is one you won't miss in November.",
  "Small daily reviews beat one big cram. Your streak proves it.",
  "Picture your name on the list of passers. One more level.",
];
const PRC_SCHEDULE = { filingStart: '2027-08-24', filingEnd: '2027-10-25', examEnd: '2027-11-23', results: '2027-11-29' };

class AgriBoardApp {
  constructor() {
    this.db = null;
    this.allItemsFlat = [];

    // Filter & Active Study Level State
    this.levelFilterArea = 0; // 0 = All, 1 = Area 1, 2 = Area 2, 3 = Area 3
    this.activeStudyArea = 1;
    this.activeStudyLevel = 1;
    this.problemSolvingOnly = false;
    this.studyStyle = 'mcq'; // 'mcq' | 'flip'
    this.currentDeck = [];
    this.currentCardIdx = 0;
    this.isAnswerRevealed = false;
    this.requeueBannerText = '';

    // 1v1 PvP State (100% Real Human-vs-Human Matchmaking)
    this.pvpActive = false;
    this.pvpSearching = false;
    this.pvpMatchId = null;
    this.pvpRole = null; // 'p1' | 'p2'
    this.pvpSearchTimerInterval = null;
    this.pvpPollInterval = null;
    this.pvpPlayerQueue = [];
    this.pvpTotalCards = 10;
    this.pvpClearedCount = 0;
    this.pvpCombo = 0;
    this.pvpLapses = 0;
    this.pvpStartTime = 0;
    this.pvpTimerInterval = null;
    this.pvpOpponent = null;
    this.pvpLocked = false;

    this.liveLeaderboard = { totalReviewees: 0, progression: [], pvp: [], allUsers: [], connected: false };
    this.promoState = { active: false, enabled: false, endsAt: 0, trialDays: 5 };
    this.syncDebounceTimer = null;
    this.adminPasscode = sessionStorage.getItem('bayaw_admin_passcode') || '';
    this.isAdminVerified = !!this.adminPasscode;
    this.authMode = 'login'; // 'login' | 'register'

    this.user = this.loadUserState();
  }

  generateUserId() {
    return 'rev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  loadUserState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        p.id = p.id || this.generateUserId();
        p.usernameKey = p.usernameKey || '';
        p.loggedIn = !!p.loggedIn && !!p.usernameKey;
        p.srs = p.srs || {};
        p.xp = p.xp || 0;
        p.rp = p.rp || 1200;
        p.pvpWins = p.pvpWins || 0;
        p.pvpLosses = p.pvpLosses || 0;
        p.bestTimeSec = p.bestTimeSec || null;
        p.name = p.name || '';
        p.hasCustomName = !!p.loggedIn && p.name.length > 0;
        p.accessUnlocked = !!p.loggedIn;
        return p;
      }
    } catch (e) {}
    return {
      id: this.generateUserId(),
      usernameKey: '',
      loggedIn: false,
      name: '',
      hasCustomName: false,
      accessUnlocked: false,
      xp: 0,
      rp: 1200,
      pvpWins: 0,
      pvpLosses: 0,
      bestTimeSec: null,
      srs: {} // itemId -> { status: 'mastered'|'learning', interval, due, reps }
    };
  }

  saveUserState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.user));
    } catch (e) {}
    this.updateAllProgressWidgets();
    this.scheduleLeaderboardSync();
  }

  scheduleLeaderboardSync() {
    if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
    this.syncDebounceTimer = setTimeout(() => this.syncUserToLeaderboard(), 12000);
  }

  async syncUserToLeaderboard() {
    if (!this.db || !this.user.loggedIn || !this.user.name) return;
    const s1 = this.getAreaStats(1);
    const s2 = this.getAreaStats(2);
    const s3 = this.getAreaStats(3);
    const payload = {
      id: this.user.id,
      usernameKey: this.user.usernameKey,
      name: this.user.name,
      a1Levels: s1.completedLevels,
      a2Levels: s2.completedLevels,
      a3Levels: s3.completedLevels,
      a1Mastered: s1.mastered,
      a2Mastered: s2.mastered,
      a3Mastered: s3.mastered,
      totalMastered: s1.mastered + s2.mastered + s3.mastered,
      xp: this.user.xp,
      rp: this.user.rp,
      pvpWins: this.user.pvpWins,
      pvpLosses: this.user.pvpLosses || 0,
      bestTimeSec: this.user.bestTimeSec,
      srs: this.user.srs
    };
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.adminPasscode) headers['x-admin-passcode'] = this.adminPasscode;
      const res = await this.apiCall('POST', payload);
      if (res.ok) {
        const result = await res.json();
        if (result?.record) {
          this.user.isOwner = !!result.record.isOwner;
          this.user.title = result.record.title || '';
          this.updateOwnerBadgeUI();
        }
        if (!document.getElementById('view-leaderboards')?.classList.contains('hidden')) await this.fetchLiveLeaderboard();
      }
    } catch (e) {
      // Offline / local server fallback handled gracefully
    }
  }

  async fetchLiveLeaderboard() {
    try {
      const res = await this.apiCall('GET');
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.progression)) {
        this.liveLeaderboard = {
          totalReviewees: data.totalReviewees || data.progression.length,
          progression: data.progression,
          pvp: data.pvp || [],
          allUsers: data.allUsers || data.progression,
          connected: true
        };
        if (data.promo) {
          this.promoState = data.promo;
          this.updatePromoUI();
        }
        const onlineEl = document.getElementById('header-online-count');
        if (onlineEl) {
          const onlineCnt = Math.max(this.user.loggedIn ? 1 : 0, Number(data.onlineCount) || 0);
          onlineEl.textContent = `${onlineCnt} Online`;
        }
        const me = this.liveLeaderboard.allUsers.find(u => u.id === this.user.id);
        if (me) {
          this.user.isOwner = !!me.isOwner;
          this.user.title = me.title || '';
          this.updateOwnerBadgeUI();
        }
        this.renderLeaderboards();
        this.renderGroupCard();
        if (!document.getElementById('view-groups').classList.contains('hidden')) this.renderGroupView();
        if (this.user.loggedIn) this.checkGroupmatesOnline();
        if (!document.getElementById('view-admin').classList.contains('hidden') && this.isAdminVerified) {
          this.renderAdminUsersTable();
        }
      }
    } catch (e) {
      // Running locally without Netlify Functions
    }
  }

  updateOwnerBadgeUI() {
    const tagEl = document.getElementById('header-owner-tag');
    if (!tagEl) return;
    if (this.user.isOwner || this.isAdminVerified) {
      tagEl.classList.remove('hidden');
      tagEl.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-crown"/></svg> OWNER';
    } else if (this.user.title) {
      tagEl.classList.remove('hidden');
      tagEl.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-tag"/></svg> ${this.escapeHtml(this.user.title)}`;
    } else {
      tagEl.classList.add('hidden');
    }
  }

  // ==================== OWNER ADMIN CONSOLE ====================
  openAdminPanel() {
    this.showView('admin');
    if (this.isAdminVerified) {
      document.getElementById('admin-login-box').classList.add('hidden');
      document.getElementById('admin-tools-body').classList.remove('hidden');
      document.getElementById('btn-admin-logout').classList.remove('hidden');
      this.adminTab(this.owTab || 'people');
      this.refreshAdminUsers();
    } else {
      document.getElementById('admin-login-box').classList.remove('hidden');
      document.getElementById('admin-tools-body').classList.add('hidden');
      document.getElementById('btn-admin-logout').classList.add('hidden');
    }
  }

  // ---- Owner console: tabs, toast and in-page confirm (replace browser alert/confirm/prompt here)
  adminTab(name, peopleFilter) {
    this.owTab = name;
    if (peopleFilter) { this.owPeople = peopleFilter; this.renderAdminAccounts(); }
    document.querySelectorAll('[data-ow-tab]').forEach(b => { const on = b.dataset.owTab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    document.querySelectorAll('[data-ow-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.owPane !== name));
  }

  owToast(msg) {
    document.getElementById('ow-toast')?.remove();
    const el = document.createElement('div');
    el.id = 'ow-toast'; el.className = 'ow-toast'; el.setAttribute('role', 'status');
    el.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-check"/></svg><span></span>`;
    el.querySelector('span').textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // Resolves to true / the typed or picked value, or null when cancelled
  owAsk({ title, body = '', ok = 'Confirm', danger = false, input = null, options = null }) {
    return new Promise(resolve => {
      document.getElementById('ow-ask')?.remove();
      const wrap = document.createElement('div');
      wrap.id = 'ow-ask'; wrap.className = 'ow-ask';
      wrap.innerHTML = `<div class="ow-ask-card panel" role="dialog" aria-modal="true" aria-labelledby="ow-ask-t">
        <h2 id="ow-ask-t" class="font-serif !font-normal text-[22px] leading-tight"></h2>
        <p class="text-sm text-slate-400 mt-1.5"></p>
        ${input ? `<input class="ow-field mt-3" type="${input.type || 'text'}" autocomplete="off" />` : ''}
        ${options ? `<select class="ow-field mt-3">${options.map(o => `<option value="${o[0]}">${o[1]}</option>`).join('')}</select>` : ''}
        <div class="ow-ask-err hidden text-[13px] text-rose-400 mt-2"></div>
        <div class="flex justify-end gap-2 mt-4"><button class="ow-btn" data-a="no">Cancel</button><button class="ow-btn ${danger ? 'danger solid' : 'primary'}" data-a="ok"></button></div>
      </div>`;
      wrap.querySelector('h2').textContent = title;
      wrap.querySelector('p').textContent = body;
      wrap.querySelector('[data-a=ok]').textContent = ok;
      const field = wrap.querySelector('input, select');
      if (field && input?.value) field.value = input.value;
      if (field && options?.value) field.value = options.value;
      const done = (v) => { wrap.remove(); document.removeEventListener('keydown', key); resolve(v); };
      const submit = () => {
        if (!field) return done(true);
        const v = field.value.trim();
        if (input?.min && v.length < input.min) { const e = wrap.querySelector('.ow-ask-err'); e.textContent = `Use at least ${input.min} characters.`; e.classList.remove('hidden'); return; }
        done(v);
      };
      const key = (e) => { if (e.key === 'Escape') done(null); if (e.key === 'Enter' && field) submit(); };
      document.addEventListener('keydown', key);
      wrap.addEventListener('click', e => { if (e.target === wrap || e.target.dataset.a === 'no') done(null); if (e.target.dataset.a === 'ok') submit(); });
      document.body.appendChild(wrap);
      (field || wrap.querySelector('[data-a=ok]')).focus();
    });
  }

  owCopy(text, msg) {
    navigator.clipboard?.writeText(text);
    this.owToast(msg || `Copied ${text}`);
  }

  owMenu(btn) {
    const menu = btn.nextElementSibling;
    const open = menu.classList.contains('hidden');
    document.querySelectorAll('.ow-menu').forEach(m => m.classList.add('hidden'));
    if (open) {
      menu.classList.remove('hidden');
      const close = (e) => { if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) { menu.classList.add('hidden'); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  }

  owStats() {
    const $ = (id) => document.getElementById(id);
    const a = this.owAccts || [];
    const expiring = a.filter(x => x.accessExpiresAt && x.daysRemaining > 0 && x.daysRemaining <= 3).length;
    if ($('ow-online')) $('ow-online').textContent = a.filter(x => x.isOnline).length;
    if ($('ow-accounts')) $('ow-accounts').textContent = (this.owTotal ?? a.length).toLocaleString();
    if ($('ow-accounts-sub')) $('ow-accounts-sub').textContent = expiring ? `accounts · ${expiring} expiring` : 'accounts';
    const n = (this.owFeedback || []).length;
    if ($('ow-inbox')) $('ow-inbox').textContent = n;
    if ($('ow-tab-n')) { $('ow-tab-n').textContent = n; $('ow-tab-n').classList.toggle('hidden', !n); }
  }

  async adminSignIn() {
    const input = document.getElementById('admin-passcode-input');
    const errEl = document.getElementById('admin-login-error');
    const code = (input.value || '').trim();
    if (!code) return;

    errEl.classList.add('hidden');
    try {
      const res = await window.bayawApi('POST', { action: 'admin_verify' }, code);
      if (res.ok) {
        this.adminPasscode = code;
        this.isAdminVerified = true;
        this.user.isOwner = true;
        sessionStorage.setItem('bayaw_admin_passcode', code);
        input.value = '';
        this.updateOwnerBadgeUI();
        await this.syncUserToLeaderboard();
        this.openAdminPanel();
      } else {
        errEl.textContent = 'Incorrect Owner Admin Passcode.';
        errEl.classList.remove('hidden');
      }
    } catch (e) {
      errEl.textContent = 'Admin verification requires the live Netlify deployment.';
      errEl.classList.remove('hidden');
    }
  }

  adminSignOut() {
    this.adminPasscode = '';
    this.isAdminVerified = false;
    sessionStorage.removeItem('bayaw_admin_passcode');
    this.openAdminPanel();
  }

  async refreshAdminUsers() {
    await this.fetchLiveLeaderboard();
    this.renderAdminUsersTable();
    await Promise.all([this.loadAdminAccessCodes(), this.loadAdminAccounts(), this.loadAdminReviewers(), this.loadAdminFeedback()]);
  }

  async adminGenerateAccessCode() {
    const label = (document.getElementById('admin-access-label')?.value || '').trim();
    const maxUses = parseInt(document.getElementById('admin-access-maxuses')?.value || '1', 10);
    const duration = document.getElementById('admin-access-duration')?.value || 'unli';
    const res = await this.apiCall('POST', { action: 'admin_generate_access_code', label, maxUses, duration });
    const data = await res.json();
    if (res.ok && data.code) {
      const lblInput = document.getElementById('admin-access-label');
      if (lblInput) lblInput.value = '';
      navigator.clipboard?.writeText(data.code);
      await this.loadAdminAccessCodes();
      this.owToast(`Made and copied ${data.code} · ${data.durationLabel} · ${data.maxUses} ${data.maxUses === 1 ? 'person' : 'people'}`);
    } else {
      this.owToast(data.error || 'Could not make the access code.');
    }
  }

  async loadAdminAccessCodes() {
    const container = document.getElementById('admin-access-codes-list');
    if (!container || !this.adminPasscode) return;
    try {
      const res = await this.apiCall('POST', { action: 'admin_list_access_codes' });
      const data = await res.json();
      this.owCodes = res.ok && Array.isArray(data.codes) ? data.codes : [];
      if (!this.owCodes.length) {
        container.innerHTML = `<div class="ow-empty">No access codes yet. Make one above.</div>`;
        return;
      }
      const esc = (x) => this.escapeHtml(x);
      container.innerHTML = this.owCodes.map((c, i) => {
        const full = c.uses >= c.maxUses;
        return `<div class="ow-row">
          <div class="min-w-0"><span class="ow-code">${esc(c.code)}</span>
            <div class="ow-meta flex flex-wrap items-center gap-2 mt-1"><span class="ow-tag gold">${esc(c.durationLabel || 'Unlimited')}</span>${c.label ? `<span>${esc(c.label)}</span>` : ''}<span class="ow-meter ${full ? 'full' : ''}"><i style="width:${Math.min(100, c.uses / Math.max(1, c.maxUses) * 100)}%"></i></span><span class="font-mono text-xs" ${full ? 'style="color:rgb(var(--c-rust-400))"' : ''}>${c.uses} / ${c.maxUses} used${full ? ' · full' : ''}</span></div></div>
          <div class="flex gap-1.5"><button onclick="app.owCopy(app.owCodes[${i}].code)" class="ow-btn sm"><svg class="ic" aria-hidden="true"><use href="#i-copy"/></svg>Copy</button><button onclick="app.adminDeleteAccessCode(app.owCodes[${i}].code)" aria-label="Delete code ${esc(c.code)}" class="ow-btn sm danger"><svg class="ic" aria-hidden="true"><use href="#i-trash-2"/></svg></button></div>
        </div>`;
      }).join('');
    } catch (e) {}
  }

  async loadAdminAccounts() {
    if (!document.getElementById('admin-accounts-tbody') || !this.adminPasscode) return;
    try {
      const res = await this.apiCall('POST', { action: 'admin_list_accounts' });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.accounts)) return;
      this.owAccts = data.accounts;
      this.owTotal = data.totalAccounts ?? data.accounts.length;
      this.renderAdminAccounts();
    } catch (e) {}
  }

  renderAdminAccounts() {
    const box = document.getElementById('admin-accounts-tbody');
    if (!box) return;
    const esc = (x) => this.escapeHtml(x);
    const all = this.owAccts || [];
    const f = this.owPeople || 'all';
    const tests = {
      all: () => true,
      online: a => a.isOnline,
      expiring: a => a.accessExpiresAt && a.daysRemaining > 0 && a.daysRemaining <= 3,
      expired: a => a.accessExpiresAt && a.daysRemaining <= 0,
      revoked: a => a.revoked,
    };
    const names = { all: 'All', online: 'Online', expiring: 'Expiring', expired: 'Expired', revoked: 'Revoked' };
    document.getElementById('ow-people-chips').innerHTML = Object.keys(tests).map(k => {
      const n = all.filter(tests[k]).length;
      return (k === 'all' || n) ? `<button class="ow-chip ${f === k ? 'on' : ''}" aria-pressed="${f === k}" onclick="app.owPeople='${k}'; app.renderAdminAccounts()">${names[k]} ${n}</button>` : '';
    }).join('');
    this.owStats();
    const q = (document.getElementById('ow-people-q')?.value || '').trim().toLowerCase();
    const list = all.map((a, i) => [a, i]).filter(([a]) => tests[f](a) && (!q || `${a.name} ${a.accessCodeUsed}`.toLowerCase().includes(q)));
    if (!list.length) {
      box.innerHTML = `<div class="ow-empty">${all.length ? 'No accounts match.' : 'No registered accounts yet.'}</div>`;
      return;
    }
    box.innerHTML = list.map(([a, i]) => {
      let plan = `<span class="ow-tag green">Unlimited</span>`;
      if (a.isOwner) plan = `<span class="ow-tag gold">Owner</span>`;
      else if (a.accessExpiresAt) plan = a.daysRemaining <= 0 ? `<span class="ow-tag rust">Expired</span>` : `<span class="ow-tag ${a.daysRemaining <= 3 ? 'rust' : 'gold'}">${a.daysRemaining}d left</span>`;
      const tags = [
        a.isOwner ? `<span class="ow-tag gold"><svg class="ic" aria-hidden="true"><use href="#i-crown"/></svg>Owner</span>` : '',
        a.fullMockAccess && !a.isOwner ? `<span class="ow-tag green"><svg class="ic" aria-hidden="true"><use href="#i-trophy"/></svg>Full mock</span>` : '',
        (a.reviewersSent || 0) > 0 ? `<span class="ow-tag plum"><svg class="ic" aria-hidden="true"><use href="#i-file-text"/></svg>${a.reviewersSent} file${a.reviewersSent === 1 ? '' : 's'}</span>` : '',
        a.revoked ? `<span class="ow-tag rust">Revoked</span>` : '',
      ].join('');
      const actions = a.isOwner
        ? `<span class="ow-prot"><svg class="ic" aria-hidden="true"><use href="#i-crown"/></svg>Owner account, protected</span>`
        : `<span class="ow-extend"><select id="renew-sel-${i}" aria-label="Extend ${esc(a.name)} by"><option value="1d">+1 day</option><option value="3d">+3 days</option><option value="7d" selected>+1 week</option><option value="14d">+2 weeks</option><option value="30d">+1 month</option><option value="90d">+3 months</option><option value="unli">Unlimited</option></select><button onclick="app.adminAcct(${i}, 'renew')">Extend</button></span>
          <span class="relative"><button onclick="app.owMenu(this)" aria-label="More actions for ${esc(a.name)}" aria-haspopup="menu" class="ow-btn sm !w-9 !px-0"><svg class="ic" aria-hidden="true"><use href="#i-ellipsis-vertical"/></svg></button>
            <span class="ow-menu hidden" role="menu">
              <button role="menuitem" onclick="app.adminAcct(${i}, 'mock')"><svg class="ic" aria-hidden="true"><use href="#i-trophy"/></svg>${a.fullMockAccess ? 'Remove full mock exam' : 'Give full mock exam'}</button>
              <button role="menuitem" onclick="app.adminAcct(${i}, 'password')"><svg class="ic" aria-hidden="true"><use href="#i-key-round"/></svg>Reset password</button>
              <hr>
              <button role="menuitem" class="danger" onclick="app.adminAcct(${i}, 'revoke')"><svg class="ic" aria-hidden="true"><use href="#i-ban"/></svg>${a.revoked ? 'Restore access' : 'Revoke access'}</button>
              <button role="menuitem" class="danger" onclick="app.adminAcct(${i}, 'remove')"><svg class="ic" aria-hidden="true"><use href="#i-trash-2"/></svg>Remove account</button>
            </span></span>`;
      return `<div class="ow-acct">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1.5"><span class="ow-dot ${a.isOnline ? '' : 'off'}" title="${a.isOnline ? 'Online' : 'Offline'}"></span><b class="font-semibold text-[15px]">${esc(a.name)}</b>${tags}</div>
          <div class="ow-meta mt-0.5">Code <span class="font-mono text-xs">${esc(a.accessCodeUsed || '–')}</span> · ${plan}${a.isOnline ? ' · online now' : ''}</div>
        </div>
        <div class="ow-acct-act">${actions}</div>
      </div>`;
    }).join('');
  }

  // Row actions look the account up by index, so names with quotes can't break the buttons
  adminAcct(i, act) {
    const a = (this.owAccts || [])[i];
    if (!a) return;
    document.querySelectorAll('.ow-menu').forEach(m => m.classList.add('hidden'));
    if (act === 'renew') return this.adminRenewAccount(a.usernameKey, a.name, document.getElementById(`renew-sel-${i}`));
    if (act === 'mock') return this.adminToggleFullMock(a.usernameKey, !a.fullMockAccess, a.name);
    if (act === 'password') return this.adminResetUserPassword(a.usernameKey, a.name);
    if (act === 'revoke') return this.adminToggleRevokeAccount(a.usernameKey, !a.revoked, a.name);
    if (act === 'remove') return this.adminRemoveAccount(a.usernameKey, a.name);
  }

  updatePromoUI() {
    const p = this.promoState || {};
    const now = Date.now();
    const isActive = !!(p.active && p.endsAt > now);
    const hrsLeft = isActive ? Math.max(1, Math.ceil((p.endsAt - now) / (60 * 60 * 1000))) : 0;

    // Update Auth Modal Promo Banner & Access Code Label
    const banner = document.getElementById('auth-promo-banner');
    const countdown = document.getElementById('auth-promo-countdown');
    const codeLabel = document.getElementById('auth-access-code-label');
    const codeHint = document.getElementById('auth-access-code-hint');

    if (banner) {
      if (isActive && this.authMode === 'register') {
        banner.classList.remove('hidden');
        if (countdown) countdown.textContent = `Sign up in the next ${hrsLeft}h to get ${p.trialDays || 5} days free. No access code needed.`;
      } else {
        banner.classList.add('hidden');
      }
    }
    if (codeLabel) {
      codeLabel.textContent = isActive
        ? 'Access code (optional)'
        : 'Access code';
    }
    if (codeHint) {
      codeHint.innerHTML = isActive
        ? `Leave blank to get ${p.trialDays || 5} days free, or enter an invite code.`
        : 'Ask the owner for an invite code.';
    }

    // Owner console promo card
    const adminPill = document.getElementById('admin-promo-status-pill');
    if (adminPill) {
      adminPill.textContent = isActive ? `On · ${hrsLeft}h left` : 'Off';
      adminPill.className = `ow-tag ${isActive ? 'green' : 'gray'}`;
      const start = document.getElementById('ow-promo-start'), stop = document.getElementById('ow-promo-stop');
      if (start) start.lastChild.textContent = isActive ? 'Restart 48-hour promo' : 'Start 48-hour promo';
      if (stop) stop.disabled = !isActive;
    }
  }

  async adminSetPromo(enabled, hours, trialDays) {
    const res = await this.apiCall('POST', { action: 'admin_set_promo', enabled, hours, trialDays });
    const data = await res.json();
    if (res.ok && data.promo) {
      this.promoState = data.promo;
      this.updatePromoUI();
      this.owToast(enabled ? `Promo started. New sign-ups get ${trialDays} days free for 48 hours.` : 'Promo stopped. New sign-ups need an access code again.');
    }
  }

  async adminRenewAccount(usernameKey, displayName, sel) {
    const duration = sel ? sel.value : '7d';
    const labelText = sel ? sel.options[sel.selectedIndex].text : duration;
    if (!await this.owAsk({ title: `Extend ${displayName}?`, body: `Adds ${labelText.replace('+', '')} of access.`, ok: 'Extend' })) return;
    const res = await this.apiCall('POST', { action: 'admin_renew_account', usernameKey, duration });
    if (res.ok) {
      await this.loadAdminAccounts();
      this.owToast(`Extended ${displayName} (${labelText})`);
    } else {
      this.owToast('Could not extend that account.');
    }
  }

  async adminResetUserPassword(usernameKey, displayName) {
    const newPassword = await this.owAsk({ title: `New password for ${displayName}`, body: 'Type a temporary password, at least 6 characters. Their progress stays safe. It is copied after saving so you can send it to them.', ok: 'Save password', input: { type: 'text', min: 6 } });
    if (!newPassword) return;
    const res = await this.apiCall('POST', { action: 'admin_reset_password', usernameKey, newPassword });
    if (res.ok) this.owCopy(newPassword, `Password updated for ${displayName}. New password copied.`);
    else this.owToast('Could not reset the password.');
  }

  async adminRemoveAccount(usernameKey, displayName) {
    if (!await this.owAsk({ title: `Remove ${displayName}'s account?`, body: 'This deletes the account for good. The username becomes free to register again.', ok: 'Remove account', danger: true })) return;
    const res = await this.apiCall('POST', { action: 'admin_delete_user', usernameKey });
    if (res.ok) {
      await this.refreshAdminUsers();
      this.owToast(`Removed ${displayName}'s account`);
    } else this.owToast('Could not remove that account.');
  }

  async adminToggleRevokeAccount(usernameKey, revoke, displayName) {
    if (!await this.owAsk({ title: `${revoke ? 'Revoke' : 'Restore'} access for ${displayName}?`, body: revoke ? 'They will not be able to use the reviewer until you restore it.' : 'They can use the reviewer again right away.', ok: revoke ? 'Revoke access' : 'Restore access', danger: revoke })) return;
    await this.apiCall('POST', { action: 'admin_revoke_account', usernameKey, revoke });
    await this.loadAdminAccounts();
    this.owToast(`${revoke ? 'Revoked' : 'Restored'} access for ${displayName}`);
  }

  async adminToggleFullMock(usernameKey, granted, displayName) {
    if (!await this.owAsk({ title: `${granted ? 'Give' : 'Remove'} the full mock exam${granted ? ' to' : ' from'} ${displayName}?`, body: 'This is the full 100-item PRC-style board mock.', ok: granted ? 'Give access' : 'Remove access', danger: !granted })) return;
    const res = await this.apiCall('POST', { action: 'admin_set_full_mock', usernameKey, granted });
    if (res.ok) {
      await this.loadAdminAccounts();
      this.owToast(`${granted ? 'Gave' : 'Removed'} full mock exam ${granted ? 'to' : 'from'} ${displayName}`);
    } else {
      const d = await res.json().catch(() => ({}));
      this.owToast(`Could not update full mock access: ${d.error || 'check the Supabase columns'}`);
    }
  }

  async adminDeleteAccessCode(code) {
    if (!await this.owAsk({ title: `Delete code ${code}?`, body: 'Nobody new can sign up with it. People who already used it keep their access.', ok: 'Delete code', danger: true })) return;
    await this.apiCall('POST', { action: 'admin_delete_access_code', code });
    await this.loadAdminAccessCodes();
    this.owToast(`Deleted ${code}`);
  }

  renderAdminUsersTable() {
    const sel = document.getElementById('ow-title-user');
    if (!sel) return;
    const users = this.liveLeaderboard.allUsers || [];
    const keep = sel.value;
    sel.innerHTML = users.length ? users.map(u => `<option value="${this.escapeHtml(u.id)}">${this.escapeHtml(u.name)}${u.isOwner ? ' (owner)' : u.title ? ` · ${this.escapeHtml(u.title)}` : ''}</option>`).join('') : '<option value="">No reviewees on the leaderboard yet</option>';
    if (users.some(u => u.id === keep)) sel.value = keep;
    this.adminTitlePick();
  }

  adminTitlePick() {
    const users = this.liveLeaderboard.allUsers || [];
    const u = users.find(x => x.id === document.getElementById('ow-title-user')?.value);
    const input = document.getElementById('ow-title-text');
    const more = document.getElementById('admin-users-tbody');
    if (input) input.value = u && !u.isOwner ? (u.title || '') : '';
    if (!more) return;
    more.innerHTML = u ? `<span>${(u.xp || 0).toLocaleString()} XP · ${(u.rp || 1200).toLocaleString()} RP</span>
      <button onclick="app.adminToggleOwner(document.getElementById('ow-title-user').value, ${!u.isOwner})" class="ow-btn sm">${u.isOwner ? 'Remove owner badge' : 'Make owner'}</button>
      <button onclick="app.adminDeleteUser(document.getElementById('ow-title-user').value)" class="ow-btn sm danger">Remove from leaderboard</button>` : '';
  }

  async adminSaveTitle() {
    const id = document.getElementById('ow-title-user')?.value;
    if (!id) return;
    const title = (document.getElementById('ow-title-text')?.value || '').trim();
    await this.apiCall('POST', { action: 'admin_set_title', targetId: id, title });
    await this.refreshAdminUsers();
    this.owToast(title ? `Title saved: ${title}` : 'Title cleared');
  }

  async adminToggleOwner(targetId, makeOwner) {
    if (!targetId) return;
    if (!await this.owAsk({ title: makeOwner ? 'Make this reviewee an owner?' : 'Remove their owner badge?', body: makeOwner ? 'They get the owner badge and are left out of the rankings.' : 'They go back to a normal reviewee.', ok: makeOwner ? 'Make owner' : 'Remove badge', danger: !makeOwner })) return;
    await this.apiCall('POST', { action: 'admin_set_title', targetId, title: makeOwner ? 'OWNER' : '', isOwner: makeOwner });
    await this.refreshAdminUsers();
  }

  async adminDeleteUser(targetId) {
    const u = (this.liveLeaderboard.allUsers || []).find(x => x.id === targetId);
    if (!u || !await this.owAsk({ title: `Remove ${u.name} from the leaderboard?`, body: 'Their leaderboard entry is deleted. Their account stays.', ok: 'Remove', danger: true })) return;
    await this.apiCall('POST', { action: 'admin_delete_user', targetId });
    await this.refreshAdminUsers();
  }

  async adminGenerateResetCode() {
    const res = await this.apiCall('POST', { action: 'admin_generate_reset_code' });
    const data = await res.json();
    if (res.ok && data.code) {
      this.lastGeneratedResetCode = data.code;
      document.getElementById('admin-generated-code-text').textContent = data.code;
      document.getElementById('admin-generated-code-box').classList.remove('hidden');
    } else {
      this.owToast(data.error || 'Could not make a reset code.');
    }
  }

  copyGeneratedResetCode() {
    if (!this.lastGeneratedResetCode) return;
    this.owCopy(this.lastGeneratedResetCode);
  }

  async adminResetLeaderboard(scope) {
    const copy = {
      pvp: ['Reset PvP ranks?', 'Everyone goes back to 1,200 RP. This cannot be undone.', 'Reset PvP'],
      progression: ['Reset study XP and levels?', 'Clears the progression leaderboard for everyone. This cannot be undone.', 'Reset XP'],
      all: ['Wipe the whole leaderboard?', 'PvP ranks and study XP for every reviewee. This cannot be undone.', 'Wipe all'],
    }[scope];
    if (!await this.owAsk({ title: copy[0], body: copy[1], ok: copy[2], danger: true })) return;
    const res = await this.apiCall('POST', { action: 'admin_reset_leaderboard', scope });
    if (res.ok) {
      this.owToast('Leaderboard reset');
      await this.refreshAdminUsers();
    } else this.owToast('Could not reset the leaderboard.');
  }

  async apiCall(method, body = null) {
    if (typeof window.bayawApi === 'function') {
      return await window.bayawApi(method, body, this.adminPasscode);
    }
    const headers = { 'Content-Type': 'application/json' };
    if (this.adminPasscode) headers['x-admin-passcode'] = this.adminPasscode;
    return await fetch('/api/leaderboard', method === 'GET' ? { method: 'GET' } : { method: 'POST', headers, body: JSON.stringify(body) });
  }

  fixAssetPath(src) {
    if (!src) return src;
    return src.startsWith('/images/') ? '.' + src : src;
  }

  async init() {
    try {
      const res = await fetch('./abe_database.json?v=20261129a');
      this.db = await res.json();
      this.allItemsFlat = [];
      for (const area of this.db.areas) {
        for (const item of area.items) {
          this.allItemsFlat.push(item);
        }
      }
      document.getElementById('loading-overlay').classList.add('hidden');
      this.renderLevelTiles();
      const saved = this.dailyState();
      this.selectStudyLevel(saved.lastArea || 1, saved.lastLevel || 1);
      this.updateAllProgressWidgets();
      this.showView('home');
      this.setupKeyboardShortcuts();
      this.fetchLiveLeaderboard();
      this.loadGlobalChat();
      // Signed in here before the login upgrade (or the login expired): sign in once more to keep saving progress
      if (this.user.loggedIn && !(await window.bayawHasLogin?.(this.user.usernameKey))) {
        const name = this.user.name || this.user.usernameKey;
        this.user.loggedIn = false;
        this.openAuthModal('login');
        document.getElementById('auth-username-input').value = name;
        document.getElementById('auth-modal-title').textContent = 'Please sign in again';
        document.getElementById('auth-modal-sub').textContent = 'We upgraded account security. Sign in once with your usual password and your progress keeps saving.';
        setTimeout(() => document.getElementById('auth-password-input')?.focus(), 80);
      } else if (!this.user.loggedIn) {
        this.openAuthModal('login');
      } else {
        this.updateOwnerBadgeUI();
        this.syncUserToLeaderboard();
        this.sendHeartbeat();
      }
      // Kept slow on purpose: Supabase free tier allows 5 GB of downloads a month
      setInterval(() => { if (!document.hidden) this.fetchLiveLeaderboard(); }, 300000);
      setInterval(() => { if (!document.hidden && this.isChatOnScreen()) this.loadGlobalChat(); }, 15000);
      setInterval(() => { if (!document.hidden) this.sendHeartbeat(); }, 90000);
      window.addEventListener('beforeunload', () => {
        if (this.syncDebounceTimer) {
          clearTimeout(this.syncDebounceTimer);
          this.syncUserToLeaderboard();
        }
      });
    } catch (err) {
      document.getElementById('loading-overlay').innerHTML = `
        <div class="text-rose-400 font-bold text-lg">Failed to load abe_database.json</div>
        <p class="text-xs text-slate-400">${err.message}</p>
      `;
    }
  }

  setupKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const dashVisible = !document.getElementById('view-dashboard').classList.contains('hidden');
      if (!dashVisible) return;

      // Only allow 1-4 Anki ratings after the answer has been revealed
      if (!this.isAnswerRevealed) return;
      if (e.key === '1') {
        this.rateCard('again');
      } else if (e.key === '2') {
        this.rateCard('hard');
      } else if (e.key === '3') {
        this.rateCard('good');
      } else if (e.key === '4') {
        this.rateCard('easy');
      }
    });
  }

  // ==================== CLOUD ACCOUNT SIGN IN / CREATE ACCOUNT / LOGOUT ====================
  openAuthModal(mode = 'login') {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.classList.remove('hidden');
    this.switchAuthTab(mode);
    setTimeout(() => {
      const u = document.getElementById('auth-username-input');
      if (u) u.focus();
    }, 60);
  }

  togglePasswordVisibility(inputId, btnId) {
    const inp = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (!inp || !btn) return;
    if (inp.type === 'password') {
      inp.type = 'text';
      btn.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-eye-off"/></svg>';
      btn.setAttribute('aria-label', 'Hide password');
    } else {
      inp.type = 'password';
      btn.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-eye"/></svg>';
      btn.setAttribute('aria-label', 'Show password');
    }
  }

  switchAuthTab(mode) {
    this.authMode = mode;
    const loginTab = document.getElementById('auth-tab-login');
    const regTab = document.getElementById('auth-tab-register');
    const codeWrap = document.getElementById('auth-access-code-wrap');
    const submitBtn = document.getElementById('auth-submit-btn');
    const err = document.getElementById('auth-error-msg');
    if (err) err.classList.add('hidden');

    const isReg = mode === 'register';
    loginTab.setAttribute('aria-selected', String(!isReg));
    regTab.setAttribute('aria-selected', String(isReg));
    codeWrap.classList.toggle('hidden', !isReg);
    submitBtn.textContent = isReg ? 'Create account' : 'Sign in';
    document.getElementById('auth-modal-title').textContent = isReg ? 'Create your account' : 'Welcome back';
    document.getElementById('auth-modal-sub').textContent = isReg
      ? 'Pick a username and password. Your progress saves to the cloud.'
      : 'Sign in to continue your review. Your progress syncs across phone and PC.';
    document.getElementById('auth-password-input').autocomplete = isReg ? 'new-password' : 'current-password';
    document.getElementById('auth-password-input').placeholder = isReg ? 'At least 6 characters' : 'Your password';
    this.updatePromoUI();
  }

  async submitAuth() {
    const username = (document.getElementById('auth-username-input')?.value || '').trim();
    const password = (document.getElementById('auth-password-input')?.value || '');
    const accessCode = (document.getElementById('auth-access-code-input')?.value || '').trim();
    const err = document.getElementById('auth-error-msg');
    const btn = document.getElementById('auth-submit-btn');

    err.classList.add('hidden');
    if (username.length < 3) {
      err.textContent = 'Username must be at least 3 characters.';
      err.classList.remove('hidden');
      return;
    }
    const minPw = this.authMode === 'register' ? 6 : 4; // older accounts may still have 4-5 character passwords
    if (password.length < minPw) {
      err.textContent = `Password must be at least ${minPw} characters.`;
      err.classList.remove('hidden');
      return;
    }

    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = this.authMode === 'register' ? 'Creating account…' : 'Signing in…';

    try {
      const action = this.authMode === 'register' ? 'auth_register' : 'auth_login';
      const res = await this.apiCall('POST', { action, username, password, accessCode });
      const data = await res.json();
      if (res.ok && data.ok && data.user) {
        this.user = {
          id: data.user.id,
          usernameKey: data.user.usernameKey,
          loggedIn: true,
          name: data.user.name,
          hasCustomName: true,
          accessUnlocked: true,
          isOwner: !!data.user.isOwner,
          title: data.user.title || '',
          xp: data.user.xp || 0,
          rp: data.user.rp || 1200,
          pvpWins: data.user.pvpWins || 0,
          pvpLosses: data.user.pvpLosses || 0,
          bestTimeSec: data.user.bestTimeSec ?? null,
          srs: data.user.srs || {}
        };
        if (data.isOwnerMaster && accessCode) {
          this.adminPasscode = accessCode;
          this.isAdminVerified = true;
          sessionStorage.setItem('bayaw_admin_passcode', accessCode);
        }
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.user)); } catch (e) {}
        document.getElementById('auth-password-input').value = '';
        document.getElementById('auth-access-code-input').value = '';
        document.getElementById('auth-modal').classList.add('hidden');

        this.updateOwnerBadgeUI();
        this.updateAllProgressWidgets();
        this.renderLevelTiles();
        const saved = this.dailyState();
        this.selectStudyLevel(saved.lastArea || 1, saved.lastLevel || 1);
        this.fetchLiveLeaderboard();
        if (!document.getElementById('view-home')?.classList.contains('hidden')) this.maybePlayHomeIntro();
      } else {
        err.textContent = data.error || 'Authentication failed. Please check your details.';
        err.classList.remove('hidden');
      }
    } catch (e) {
      err.textContent = 'Connection error. Please try again.';
      err.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  }

  async sendHeartbeat() {
    if (!this.user.loggedIn || !this.user.usernameKey) return;
    try {
      const res = await this.apiCall('POST', { action: 'heartbeat', usernameKey: this.user.usernameKey });
      if (res.status === 403) {
        const data = await res.json();
        if (data?.kicked) {
          localStorage.removeItem(STORAGE_KEY);
          window.bayawSignOut?.();
          this.user = this.loadUserState();
          this.openAuthModal('login');
          alert(`🔒 ${data.reason || 'Your access has ended.'}`);
        }
      }
    } catch (e) {}
  }

  async logoutAccount() {
    if (!confirm('Sign out of your account? Your progress is safely saved in the cloud — you can log back in anytime on any device!')) return;
    // Push one final cloud sync before signing out
    await this.syncUserToLeaderboard();
    localStorage.removeItem(STORAGE_KEY);
    await window.bayawSignOut?.();
    sessionStorage.removeItem('bayaw_admin_passcode');
    this.adminPasscode = '';
    this.isAdminVerified = false;
    this.user = this.loadUserState();
    this.updateOwnerBadgeUI();
    this.updateAllProgressWidgets();
    this.renderLevelTiles();
    this.showView('home');
    this.openAuthModal('login');
  }

  getAvatarInitials(name) {
    const clean = (name || '').trim();
    if (!clean) return '??';
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return clean.slice(0, 2).toUpperCase();
  }

  resetProgress() {
    const modal = document.getElementById('reset-code-modal');
    const inp = document.getElementById('reset-code-input');
    const err = document.getElementById('reset-code-error');
    if (inp) inp.value = '';
    if (err) err.classList.add('hidden');
    if (modal) modal.classList.remove('hidden');
    setTimeout(() => inp && inp.focus(), 60);
  }

  closeResetModal() {
    const modal = document.getElementById('reset-code-modal');
    if (modal) modal.classList.add('hidden');
  }

  async submitResetCode() {
    const inp = document.getElementById('reset-code-input');
    const err = document.getElementById('reset-code-error');
    const code = (inp.value || '').trim().toUpperCase();
    if (!code) {
      err.textContent = 'Please enter a Reset Code from the Owner.';
      err.classList.remove('hidden');
      return;
    }
    err.classList.add('hidden');
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.adminPasscode) headers['x-admin-passcode'] = this.adminPasscode;
      const res = await this.apiCall('POST', { action: 'verify_reset_code', code });
      const data = await res.json();
      if (res.ok && data.ok) {
        // Keep the logged-in account identity & owner/title intact, wipe all SRS/XP/RP/PvP stats locally AND in the cloud!
        this.user.srs = {};
        this.user.xp = 0;
        this.user.rp = 1200;
        this.user.pvpWins = 0;
        this.user.pvpLosses = 0;
        this.user.bestTimeSec = null;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(this.user));
        } catch (e) {}
        // Immediately sync the wiped progress to the cloud account & leaderboard
        await this.syncUserToLeaderboard();
        this.closeResetModal();
        this.updateAllProgressWidgets();
        this.renderStudyCard();
        this.renderLevelTiles();
        alert('✅ Reset Code verified! Your local & cloud progress have both been reset to 0.');
      } else {
        err.textContent = data.error || 'Invalid Reset Code. Please ask the Owner for a valid code.';
        err.classList.remove('hidden');
      }
    } catch (e) {
      err.textContent = 'Could not verify Reset Code. Please try again when connected to the live site.';
      err.classList.remove('hidden');
    }
  }

  showView(viewName) {
    const views = ['home', 'dashboard', 'pvp-lobby', 'pvp-arena', 'leaderboards', 'vault', 'paes', 'progress', 'weak', 'groups', 'admin', 'mock-exam'];
    views.forEach(v => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.classList.add('hidden');
    });
    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.remove('hidden');

    // Sidebar (PC) and tab bar (phone) active state
    const sideKey = (viewName === 'pvp-lobby' || viewName === 'pvp-arena') ? 'side-pvp' : `side-${viewName}`;
    document.querySelectorAll('.side-btn').forEach(b => b.classList.toggle('sidebar-item-active', b.id === sideKey));
    const tabView = viewName === 'pvp-arena' ? 'pvp-lobby' : viewName;
    document.querySelectorAll('.tabbar-btn[data-view]').forEach(b => b.classList.toggle('is-active', b.dataset.view === tabView));

    if (viewName === 'leaderboards') this.renderLeaderboards();
    if (viewName === 'vault') { this.vaultIds = null; this.renderVault(); }
    if (viewName === 'paes') this.renderPaes();
    if (viewName === 'progress') this.renderAllLevelsProgress();
    if (viewName === 'weak') this.renderWeakTopics();
    if (viewName === 'groups') this.renderGroupView();
    if (viewName === 'dashboard') this.applyTabletMode(this.currentDeck?.[this.currentCardIdx]);
    if (viewName === 'home') { this.renderHome(); this.maybePlayHomeIntro(); }
  }

  openPvpLobby() {
    this.cancelFindingMatch();
    this.clearPvpTimers();
    this.pvpActive = false;
    const areaSel = document.getElementById('lobby-pvp-area');
    if (areaSel) {
      areaSel.value = String(this.activeStudyArea || 1);
      this.populateLobbyLevels();
    }
    this.showView('pvp-lobby');
    this.renderPvpLobby();
    this.loadWaitingPvpRooms();
  }

  populateLobbyLevels() {
    const areaSel = document.getElementById('lobby-pvp-area');
    const lvlSel = document.getElementById('lobby-pvp-level');
    if (!areaSel || !lvlSel || !this.db) return;
    const areaId = parseInt(areaSel.value, 10) || 1;
    const regItems = this.getRegularItems(areaId);
    const regLevels = Math.ceil(regItems.length / 100);
    let opts = '';
    for (let lvl = 1; lvl <= regLevels; lvl++) {
      const start = (lvl - 1) * 100 + 1;
      const end = Math.min(lvl * 100, regItems.length);
      opts += `<option value="${lvl}">Level ${lvl} · cards ${start}–${end}</option>`;
    }
    const ps = this.getPsItems(areaId);
    if (ps.length > 0) {
      opts += `<option value="ps">Problem solving · ${ps.length} problems</option>`;
    }
    const keep = lvlSel.value;
    lvlSel.innerHTML = opts;
    if ([...lvlSel.options].some(o => o.value === keep)) lvlSel.value = keep;
    this.renderPvpLobby();
  }

  setPvpOpt(kind, val) {
    const sel = document.getElementById(kind === 'area' ? 'lobby-pvp-area' : 'quick-pvp-size');
    if (!sel) return;
    sel.value = String(val);
    if (kind === 'area') this.populateLobbyLevels(); else this.renderPvpLobby();
  }

  pvpLevelLabel(areaId, levelVal) {
    return `Area ${areaId} · ${levelVal === 'ps' ? 'Problems' : `Level ${levelVal}`}`;
  }

  // Lobby header, setup buttons and summary; all from data already on the device
  renderPvpLobby() {
    const $ = (id) => document.getElementById(id);
    if (!$('lobby-pvp-area')) return;
    const area = $('lobby-pvp-area').value, size = $('quick-pvp-size').value, lvl = $('lobby-pvp-level').value;
    document.querySelectorAll('[data-pvp-area]').forEach(b => { const on = b.dataset.pvpArea === area; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    document.querySelectorAll('[data-pvp-size]').forEach(b => { const on = b.dataset.pvpSize === size; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    const par = Number(size) * 5;  // same par as the RP bonus in finishPvpMatch
    $('pvl-summary').innerHTML = `<b class="font-semibold">${this.pvpLevelLabel(area, lvl)} · ${size} cards</b> <span class="text-slate-400">· par time ${Math.floor(par / 60)}:${String(par % 60).padStart(2, '0')}</span>`;
    const u = this.user || {};
    const rp = (u.rp || 1200).toLocaleString();
    $('pvl-rp').textContent = rp;
    $('pvl-you-rp').textContent = `${rp} RP`;
    $('pvl-wl').innerHTML = `${u.pvpWins || 0}<span class="text-slate-400 text-sm"> – ${u.pvpLosses || 0}</span>`;
    $('pvl-best').innerHTML = u.bestTimeSec ? `${u.bestTimeSec}<span class="text-slate-400 text-sm">s</span>` : '–';
    const initials = (u.loggedIn && u.name ? u.name.replace(/^Engr\.?\s*/i, '').split(/\s+/).map(w => w[0]).join('').slice(0, 2) : 'YOU').toUpperCase();
    $('pvl-you-av').textContent = initials;
    if (this.pvpRooms) this.renderPvpRooms();
  }

  scrollToStudySession() {
    this.showView('dashboard');
    setTimeout(() => {
      const el = document.getElementById('study-session-panel');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  }

  selectAreaAndShow(areaId) {
    this.showView('dashboard');
    this.filterLevelsByArea(areaId);
    this.selectStudyLevel(areaId, 1);
  }

  globalSearch(query) {
    this.showView('vault');
    const inp = document.getElementById('vault-search-input');
    if (inp) {
      inp.value = query;
      this.renderVault();
    }
  }

  // ==================== STATS & PROGRESS CALCULATIONS ====================
  getRegularItems(areaId) {
    const area = this.db.areas.find(a => a.id === areaId);
    if (!area) return [];
    return area.items.filter(i => i.category !== 'problem_solving');
  }

  getPsItems(areaId) {
    const area = this.db.areas.find(a => a.id === areaId);
    if (!area) return [];
    return area.items.filter(i => i.category === 'problem_solving');
  }

  getRegularTotalLevels(areaId) {
    const reg = this.getRegularItems(areaId);
    return Math.ceil(reg.length / 100);
  }

  getAreaStats(areaId) {
    const area = this.db.areas.find(a => a.id === areaId);
    if (!area) return { total: 0, mastered: 0, learning: 0, completedLevels: 0, pct: 0, totalLevels: 0 };
    let mastered = 0;
    let learning = 0;
    for (const item of area.items) {
      const rec = this.user.srs[item.id];
      if (rec?.status === 'mastered') mastered++;
      else if (rec?.status === 'learning') learning++;
    }
    const regTotalLevels = this.getRegularTotalLevels(areaId);
    let completedLevels = 0;
    for (let lvl = 1; lvl <= regTotalLevels; lvl++) {
      const lst = this.getLevelStats(areaId, lvl);
      if (lst.total > 0 && lst.mastered === lst.total) completedLevels++;
    }
    // Check PS level completion too
    const psItems = this.getPsItems(areaId);
    const hasPs = psItems.length > 0;
    if (hasPs && psItems.every(x => this.user.srs[x.id]?.status === 'mastered')) {
      completedLevels++;
    }
    const totalLevelsWithPs = regTotalLevels + (hasPs ? 1 : 0);
    const pct = area.totalItems > 0 ? (mastered / area.totalItems) * 100 : 0;
    return { total: area.totalItems, mastered, learning, completedLevels, totalLevels: totalLevelsWithPs, pct };
  }

  getLevelStats(areaId, levelNum) {
    // Non-Problem-Solving 100-item levels only
    const reg = this.getRegularItems(areaId);
    const startIdx = (levelNum - 1) * 100;
    const items = reg.slice(startIdx, startIdx + 100);
    let mastered = 0;
    let learning = 0;
    for (const it of items) {
      const rec = this.user.srs[it.id];
      if (rec?.status === 'mastered') mastered++;
      else if (rec?.status === 'learning') learning++;
    }
    const pct = items.length > 0 ? (mastered / items.length) * 100 : 0;
    return { items, total: items.length, mastered, learning, pct };
  }

  getPsStats(areaId) {
    const items = this.getPsItems(areaId);
    let mastered = 0;
    let learning = 0;
    for (const it of items) {
      const rec = this.user.srs[it.id];
      if (rec?.status === 'mastered') mastered++;
      else if (rec?.status === 'learning') learning++;
    }
    const pct = items.length > 0 ? (mastered / items.length) * 100 : 0;
    return { items, total: items.length, mastered, learning, pct };
  }

  // ==================== TODAY: exam countdown, daily goal, streak ====================
  // Kept inside srs (key "_daily") so it syncs with the rest of the progress, with no extra Supabase calls.
  localDay(offsetDays = 0) {
    const d = new Date(); d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  dailyState() {
    if (!this.user.srs) this.user.srs = {};
    const d = this.user.srs._daily || (this.user.srs._daily = { goal: 50, count: 0, day: '', streak: 0, lastHit: '' });
    const today = this.localDay();
    if (d.day !== today) { d.day = today; d.count = 0; }
    return d;
  }

  countAnswered(n = 1) {
    const d = this.dailyState();
    const before = d.count;
    d.count += n;
    if (before < d.goal && d.count >= d.goal) {
      d.streak = d.lastHit === this.localDay(-1) ? (d.streak || 0) + 1 : 1;
      d.lastHit = this.localDay();
    }
  }

  setDailyGoal(v) {
    const d = this.dailyState();
    d.goal = Math.max(5, Math.min(500, Number(v) || 50));
    setTimeout(() => this.renderHome(), 0);
    if (d.count >= d.goal && d.lastHit !== this.localDay()) {
      d.streak = d.lastHit === this.localDay(-1) ? (d.streak || 0) + 1 : 1;
      d.lastHit = this.localDay();
    }
    this.saveUserState();
  }

  setExamDate(v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return;
    this.dailyState().examDate = v;
    setTimeout(() => this.renderHome(), 0);
    this.saveUserState();
  }

  // ==================== HOME DASHBOARD ====================
  daysUntil(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return Math.round((new Date(y, m - 1, d) - start) / 86400000);
  }

  continueStudying() {
    const d = this.dailyState();
    const area = d.lastArea || this.activeStudyArea || 1, level = d.lastLevel || this.activeStudyLevel || 1;
    this.showView('dashboard');
    if (this.problemSolvingOnly || this.drillLabel || this.activeStudyArea !== area || this.activeStudyLevel !== level) this.selectStudyLevel(area, level);
    this.scrollToStudySession();
  }

  renderHome() {
    const root = document.getElementById('view-home');
    if (!root || !this.db) return;
    const $ = (id) => document.getElementById(id);
    const guest = !this.user.loggedIn;
    root.classList.toggle('is-guest', guest);
    const d = this.dailyState();
    const h = new Date().getHours();
    const hello = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    $('home-hello').textContent = `${hello} · ${new Date().toLocaleDateString('en-PH', { weekday: 'long', month: 'short', day: 'numeric' })}`;
    const title = guest ? 'Pass the ABE board exam, one card at a time.' : `Welcome back, ${this.user.name || 'reviewee'}.`;
    $('home-title').innerHTML = title.split(' ').map((w, i) => `<span class="h-word" style="--d:${(0.25 + i * 0.08).toFixed(2)}s">${this.escapeHtml(w)}</span>`).join(' ');
    this.homeQuote = DAILY_LINES[Math.floor(Date.now() / 86400000) % DAILY_LINES.length];
    $('home-quote').textContent = this.homeQuote;

    // Countdown and timeline
    const exam = d.examDate || DEFAULT_EXAM_DATE;
    const days = this.daysUntil(exam);
    this.homeDays = Math.max(0, days);
    $('home-days').textContent = days >= 0 ? days.toLocaleString() : '—';
    const [ey, em, ed] = exam.split('-').map(Number);
    $('home-exam-date').textContent = exam === DEFAULT_EXAM_DATE ? 'Nov 22–23, 2027 · Mon & Tue'
      : new Date(ey, em - 1, ed).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const toResults = this.daysUntil(PRC_SCHEDULE.results);
    $('home-timeline').classList.toggle('hidden', exam !== DEFAULT_EXAM_DATE || toResults < 0);
    if (toResults > 0) {
      // Spaced by date, but kept apart enough to read on a phone
      const pct = (ymd) => Math.max(0, this.daysUntil(ymd)) / toResults * 100;
      const ex = Math.min(pct(DEFAULT_EXAM_DATE), 93), fe = Math.min(pct(PRC_SCHEDULE.filingEnd), ex - 7), fs = Math.min(pct(PRC_SCHEDULE.filingStart), fe - 7);
      const place = (id, p, passed) => { const el = $(id); el.style.left = `calc(6px + (100% - 12px) * ${Math.max(0, p) / 100})`; el.classList.toggle('passed', passed); };
      place('home-tl-fs', fs, this.daysUntil(PRC_SCHEDULE.filingStart) <= 0);
      place('home-tl-fe', fe, this.daysUntil(PRC_SCHEDULE.filingEnd) < 0);
      place('home-tl-ex', ex, false);
      $('home-tl-done').style.width = `calc((100% - 12px) * ${ex / 100})`;
      $('home-tl-today').textContent = new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
    }

    this.renderGroupCard();
    this.renderHomePaes();

    // Continue button
    $('home-continue-label').textContent = `Area ${d.lastArea || 1} · Level ${d.lastLevel || 1}`;

    // Visitor stats
    $('home-g-q').textContent = this.allItemsFlat.length.toLocaleString();
    $('home-g-ps').textContent = this.allItemsFlat.filter(it => it.category === 'problem_solving').length.toLocaleString();

    // Today's goal
    $('home-today').textContent = d.count;
    $('home-goal').textContent = d.goal;
    const sel = $('home-goal-select');
    if (![...sel.options].some(o => Number(o.value) === d.goal)) sel.add(new Option(String(d.goal), String(d.goal)));
    sel.value = String(d.goal);
    $('home-exam-input').value = exam;
    $('home-ring').style.strokeDashoffset = 213.6 * (1 - Math.min(1, d.count / d.goal));
    const alive = d.lastHit === this.localDay() || d.lastHit === this.localDay(-1);
    const streak = alive ? (d.streak || 0) : 0;
    const left = Math.max(0, d.goal - d.count);
    $('home-today-sub').textContent = left ? `${left} more to hit today's goal` : 'Goal done today';

    // Streak: last 7 days, ending today
    $('home-streak').textContent = streak;
    $('home-streak-unit').textContent = streak === 1 ? 'day' : 'days';
    const lastOff = d.lastHit === this.localDay() ? 0 : -1;
    $('home-week').innerHTML = [-6, -5, -4, -3, -2, -1, 0].map(k => {
      const day = new Date(); day.setDate(day.getDate() + k);
      const hit = streak > 0 && k <= lastOff && k > lastOff - streak;
      const cls = hit ? 'hit' : k === 0 ? 'today' : '';
      return `<span class="home-day ${cls}" title="${day.toLocaleDateString('en-PH', { weekday: 'long' })}${hit ? ': goal hit' : ''}">${'SMTWTFS'[day.getDay()]}</span>`;
    }).join('');

    // Where you stand
    const names = { 1: 'Power & Machinery', 2: 'Land & Water', 3: 'Structures & Bioprocess' };
    const tints = { 1: 'var(--c-inkblue-400)', 2: 'var(--c-green-400)', 3: 'var(--c-plum-400)' };
    const stats = [1, 2, 3].map(id => ({ id, ...this.getAreaStats(id) }));
    $('home-areas').innerHTML = stats.map(s => {
      const pct = Math.round(s.pct);
      return `<button onclick="app.selectAreaAndShow(${s.id})" class="w-full text-left grid grid-cols-[1fr_auto] gap-x-2.5 gap-y-1 items-center py-2 border-b border-rule last:border-b-0">
          <span class="text-sm truncate">Area ${s.id} · ${names[s.id]}</span><span class="font-mono text-xs text-slate-400">${pct}%</span>
          <span class="home-bar col-span-2"><b style="width:${Math.max(pct ? 2 : 0, pct)}%; background:rgb(${tints[s.id]})"></b></span>
        </button>`;
    }).join('');

    // Weak spots (same list and order as the Weak Topics page)
    this.weakTopicsCache = this.getWeakTopics().slice(0, 10);
    const weak = this.weakTopicsCache.slice(0, 3);
    $('home-weak').innerHTML = weak.length ? weak.map((t, i) => `
        <div class="flex items-center gap-2.5 py-2.5 border-b border-rule last:border-b-0">
          <span class="label-mono shrink-0">A${t.area}</span>
          <span class="text-sm truncate min-w-0 flex-1" title="${this.escapeHtml(t.name)}">${this.escapeHtml(t.name)}</span>
          <span class="font-mono text-xs text-slate-400 shrink-0">${t.missed.length} missed</span>
          <button onclick="app.drillWeakTopic(${i})" class="shrink-0 min-h-[34px] px-3 rounded-lg border border-rule text-xs font-semibold text-emerald-300 hover:border-emerald-500">Drill</button>
        </div>`).join('')
      : '<p class="text-sm text-slate-400 py-2">Answer a few questions and the topics you keep missing show up here.</p>';

    // Next best move: the area with the most ground left to cover
    const next = stats.slice().sort((a, b) => (a.pct - b.pct) || (b.total - a.total))[0];
    $('home-next-title').textContent = `Start with Area ${next.id}`;
    $('home-next-text').textContent = `${names[next.id]}: ${next.total.toLocaleString()} items, and you've mastered ${Math.round(next.pct)}%. A few levels a day there closes the gap fastest.`;
    $('home-next-hint').textContent = !left ? 'Goal done today. Anything extra is a bonus.'
      : streak ? `Finish today's goal (${left} to go) to keep your ${streak}-day streak.`
      : `Answer ${d.goal} questions today to start a streak.`;
  }

  // The full intro plays once a day (separately for visitors and signed-in reviewees)
  // Full intro once a day (separately for visitors and signed-in reviewees); a quick entrance on every other visit
  maybePlayHomeIntro() {
    const root = document.getElementById('view-home');
    if (!root || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const key = this.localDay() + (this.user.loggedIn ? 'm' : 'g');
    let seen = '';
    try { seen = localStorage.getItem('bayaw_home_intro') || ''; } catch (e) {}
    const full = seen !== key;
    if (full) { try { localStorage.setItem('bayaw_home_intro', key); } catch (e) {} }
    root.classList.remove('home-play', 'home-quick'); void root.offsetWidth;
    root.classList.add('home-play');
    if (!full) root.classList.add('home-quick');
    clearTimeout(this.homeIntroTimer);
    // afterwards redraw with final values (count-ups pause while the tab is in the background)
    this.homeIntroTimer = setTimeout(() => { root.classList.remove('home-play', 'home-quick'); this.renderHome(); }, full ? 4000 : 1500);
    const t = full ? 1 : 0.25; // quick visits compress the timing

    const countUp = (el, to, delay, ms = 1300) => {
      if (!el) return;
      el.textContent = '0';
      setTimeout(() => {
        const t0 = performance.now();
        const tick = (t) => { const p = Math.min(1, (t - t0) / ms); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))).toLocaleString(); if (p < 1) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      }, delay);
    };
    if (this.user.loggedIn) countUp(document.getElementById('home-days'), this.homeDays, 900 * t, full ? 1300 : 700);
    else { countUp(document.getElementById('home-g-q'), this.allItemsFlat.length, 1100 * t, full ? 1300 : 700); countUp(document.getElementById('home-g-ps'), this.allItemsFlat.filter(it => it.category === 'problem_solving').length, 1220 * t, full ? 1300 : 700); }

    // Type the daily line, then fill the ring and bars once their cards are in
    const q = document.getElementById('home-quote');
    const text = this.homeQuote || q.textContent;
    if (full) q.textContent = '';
    if (full) setTimeout(() => {
      let i = 0;
      const step = () => { q.innerHTML = this.escapeHtml(text.slice(0, ++i)) + '<span class="home-caret"></span>'; if (i < text.length) setTimeout(step, 22); else setTimeout(() => (q.textContent = text), 1800); };
      step();
    }, 1600);
    const ring = document.getElementById('home-ring');
    const bars = [...root.querySelectorAll('.home-bar > b')];
    const ringTo = ring.style.strokeDashoffset, barTo = bars.map(b => b.style.width);
    ring.style.transition = 'none'; ring.style.strokeDashoffset = 213.6;
    bars.forEach(b => { b.style.transition = 'none'; b.style.width = '0%'; });
    setTimeout(() => {
      ring.style.transition = ''; ring.style.strokeDashoffset = ringTo;
      bars.forEach((b, i) => { b.style.transition = ''; b.style.width = barTo[i]; });
    }, full ? 2500 : 450);
  }

  updateAllProgressWidgets() {
    if (!document.getElementById('view-home')?.classList.contains('hidden') && !document.getElementById('view-home')?.classList.contains('home-play')) this.renderHome();
    if (!this.db) return;
    const s1 = this.getAreaStats(1);
    const s2 = this.getAreaStats(2);
    const s3 = this.getAreaStats(3);
    const totalMastered = s1.mastered + s2.mastered + s3.mastered;
    const totalItems = this.allItemsFlat.length || 4579;
    const overallPct = (totalMastered / totalItems) * 100;

    // Header
    const displayName = this.user.hasCustomName ? this.user.name : 'Set Username';
    document.getElementById('header-player-name').textContent = displayName;
    const initEl = document.getElementById('header-avatar-initials');
    if (initEl) initEl.textContent = this.getAvatarInitials(this.user.name);
    document.getElementById('header-rp').textContent = this.user.rp.toLocaleString();
    document.getElementById('header-xp').textContent = this.user.xp.toLocaleString();

    // My Progress Panel
    document.getElementById('prog-a1-lvl').textContent = `Lv ${s1.completedLevels} / ${s1.totalLevels}`;
    document.getElementById('prog-a1-txt').textContent = `${s1.mastered.toLocaleString()} / ${s1.total.toLocaleString()} (${s1.pct.toFixed(0)}%)`;

    document.getElementById('prog-a2-lvl').textContent = `Lv ${s2.completedLevels} / ${s2.totalLevels}`;
    document.getElementById('prog-a2-txt').textContent = `${s2.mastered.toLocaleString()} / ${s2.total.toLocaleString()} (${s2.pct.toFixed(0)}%)`;

    document.getElementById('prog-a3-lvl').textContent = `Lv ${s3.completedLevels} / ${s3.totalLevels}`;
    document.getElementById('prog-a3-txt').textContent = `${s3.mastered.toLocaleString()} / ${s3.total.toLocaleString()} (${s3.pct.toFixed(0)}%)`;

    this.renderFieldPlots();
    [s1, s2, s3].forEach((s, i) => {
      const pct = `${Math.round(s.pct)}%`;
      const t = document.getElementById(`dash-area-pct-${i + 1}`), bar = document.getElementById(`dash-area-bar-${i + 1}`);
      if (t) t.textContent = pct;
      if (bar) bar.style.width = s.pct ? `max(2%, ${pct})` : '0%';
    });

    document.getElementById('prog-overall-txt').textContent = `${totalMastered.toLocaleString()} / ${totalItems.toLocaleString()} (${overallPct.toFixed(1)}%)`;
    document.getElementById('prog-overall-bar').style.width = `${overallPct}%`;

    // Study Card Mini Overall Bar
    document.getElementById('study-mini-all-txt').textContent = `${totalMastered.toLocaleString()} / ${totalItems.toLocaleString()} (${overallPct.toFixed(1)}%)`;
    document.getElementById('study-mini-all-bar').style.width = `${overallPct}%`;

    // Refresh leaderboards
    this.renderLeaderboards();
  }

  // "Your field": one plot per level (plus the Problem Solving set), coloured by mastery
  renderFieldPlots() {
    const plot = (st) => `<span class="plot${st.total && st.mastered === st.total ? ' plot-done' : (st.mastered + st.learning > 0 ? ' plot-active' : '')}"></span>`;
    for (const area of this.db.areas) {
      const el = document.getElementById(`prog-a${area.id}-field`);
      if (!el) continue;
      const levels = this.getRegularTotalLevels(area.id);
      let html = '';
      for (let lvl = 1; lvl <= levels; lvl++) html += plot(this.getLevelStats(area.id, lvl));
      const ps = this.getPsStats(area.id);
      if (ps.total) html += plot(ps);
      el.innerHTML = html;
    }
  }

  // ==================== 100-ITEM LEVEL TILES ====================
  filterLevelsByArea(areaId) {
    this.levelFilterArea = areaId;
    [0, 1, 2, 3].forEach(id => {
      const btn = document.getElementById(id === 0 ? 'lvl-filter-all' : `lvl-filter-${id}`);
      if (!btn) return;
      if (id === areaId) {
        btn.className = 'lvl-filter-btn px-2.5 py-1 rounded-md font-bold bg-emerald-600 text-on-accent';
      } else {
        btn.className = 'lvl-filter-btn px-2.5 py-1 rounded-md font-semibold bg-white/[0.04] text-slate-300 hover:text-white border border-white/[0.08]';
      }
    });
    this.renderLevelTiles();
  }

  renderLevelTiles() {
    const container = document.getElementById('dashboard-level-tiles');
    if (!container || !this.db) return;

    const areasToShow = this.levelFilterArea === 0
      ? this.db.areas
      : this.db.areas.filter(a => a.id === this.levelFilterArea);

    let html = '';
    for (const area of areasToShow) {
      const regItems = this.getRegularItems(area.id);
      const regLevels = Math.ceil(regItems.length / 100);

      // 1) Pure 100-item Concept / MCQ / Anki levels (ZERO Problem Solving mixed in)
      for (let lvl = 1; lvl <= regLevels; lvl++) {
        const start = (lvl - 1) * 100 + 1;
        const end = Math.min(lvl * 100, regItems.length);
        const count = end - start + 1;
        const lst = this.getLevelStats(area.id, lvl);
        const isActive = (!this.problemSolvingOnly && this.activeStudyArea === area.id && this.activeStudyLevel === lvl);

        html += `
          <button onclick="app.selectStudyLevel(${area.id}, ${lvl})" class="shrink-0 w-36 text-left rounded-xl px-3 py-2 ${isActive ? 'level-tile-active' : 'level-tile'}">
            <div class="flex items-center justify-between gap-1">
              <span class="text-xs font-extrabold text-white">A${area.id} • Lv ${lvl}</span>
              <span class="text-xs font-mono font-bold ${lst.pct === 100 ? 'text-emerald-400' : 'text-sky-300'}">${lst.pct.toFixed(0)}%</span>
            </div>
            <div class="text-[11px] font-mono text-slate-400 mt-0.5 whitespace-nowrap">${start}–${end} · ${count}</div>
          </button>
        `;
      }

      // 2) Dedicated Area-X Level (PS) tile for Problem Solving Only
      const ps = this.getPsStats(area.id);
      if (ps.total > 0) {
        const isPsActive = (this.problemSolvingOnly && this.activeStudyArea === area.id);
        html += `
          <button onclick="app.openProblemSolvingMode(${area.id})" class="shrink-0 w-36 text-left rounded-lg px-2.5 py-1.5 transition-all ${isPsActive ? ' bg-amber-500/30 border-2 border-amber-400 shadow-lg' : 'bg-amber-950/35 border border-amber-500/40 hover:border-amber-400'}">
            <div class="flex items-center justify-between gap-1">
              <span class="text-xs font-extrabold text-amber-300"><svg class="ic" aria-hidden="true"><use href="#i-calculator"/></svg> A${area.id} (PS)</span>
              <span class="text-xs font-mono font-bold ${ps.pct === 100 ? 'text-emerald-400' : 'text-amber-300'}">${ps.pct.toFixed(0)}%</span>
            </div>
            <div class="text-xs font-mono text-amber-200/75 mt-0.5">${ps.total} problems</div>
          </button>
        `;
      }
    }
    container.innerHTML = html;
  }

  // ==================== INLINE STUDY SESSION & ANKI SRS ====================
  selectStudyLevel(areaId, levelNum) {
    this.problemSolvingOnly = false;
    this.drillLabel = null;
    this.activeStudyArea = areaId;
    this.activeStudyLevel = levelNum;
    const daily = this.dailyState();
    daily.lastArea = areaId; daily.lastLevel = levelNum;
    const lst = this.getLevelStats(areaId, levelNum);
    this.currentDeck = [...lst.items];

    const strip = document.getElementById('prob-solving-strip');
    if (strip) strip.classList.add('hidden');
    const toggleBtn = document.getElementById('btn-toggle-prob-only');
    if (toggleBtn) {
      toggleBtn.className = 'shrink-0 whitespace-nowrap px-2.5 py-1 rounded-full bg-amber-500/10 hover:bg-amber-500/20 border border-amber-400/35 text-xs font-bold text-amber-300 transition-colors';
      toggleBtn.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-calculator"/></svg> Problem Solving Only (Area 1–3)';
    }

    // Jump to first unseen/unmastered item in this level
    const firstUnmastered = this.currentDeck.findIndex(it => this.user.srs[it.id]?.status !== 'mastered');
    this.currentCardIdx = firstUnmastered >= 0 ? firstUnmastered : 0;

    this.renderLevelTiles();
    this.renderStudyCard();
  }

  openProblemSolvingMode(areaId) {
    this.showView('dashboard');
    this.problemSolvingOnly = true;
    this.drillLabel = null;
    this.activeStudyArea = areaId;
    const area = this.db.areas.find(a => a.id === areaId);
    this.currentDeck = area ? area.items.filter(it => it.category === 'problem_solving') : [];

    const firstUnmastered = this.currentDeck.findIndex(it => this.user.srs[it.id]?.status !== 'mastered');
    this.currentCardIdx = firstUnmastered >= 0 ? firstUnmastered : 0;

    const strip = document.getElementById('prob-solving-strip');
    if (strip) strip.classList.remove('hidden');

    const toggleBtn = document.getElementById('btn-toggle-prob-only');
    if (toggleBtn) {
      toggleBtn.className = 'shrink-0 whitespace-nowrap px-2.5 py-1 rounded-full bg-amber-400 text-on-accent border border-amber-300 text-xs font-bold transition-colors';
      toggleBtn.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-calculator"/></svg> Problem Solving Active (Area ${areaId})`;
    }

    [1, 2, 3].forEach(id => {
      const btn = document.getElementById(`prob-area-btn-${id}`);
      if (!btn) return;
      const activeColors = { 1: 'bg-sky-600 text-on-accent', 2: 'bg-emerald-600 text-on-accent', 3: 'bg-purple-600 text-on-accent' };
      btn.className = id === areaId
        ? `shrink-0 whitespace-nowrap px-3 min-h-[36px] rounded-lg text-xs font-bold ${activeColors[id]}`
        : 'shrink-0 whitespace-nowrap px-3 min-h-[36px] rounded-lg text-xs font-semibold bg-white/[0.04] text-slate-300 hover:text-white border border-white/[0.08]';
    });

    this.renderLevelTiles();
    this.renderStudyCard();
    setTimeout(() => {
      const el = document.getElementById('study-session-panel');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  }

  toggleProblemSolvingOnly() {
    if (this.problemSolvingOnly) {
      this.exitProblemSolvingMode();
    } else {
      this.openProblemSolvingMode(this.activeStudyArea || 1);
    }
  }

  exitProblemSolvingMode() {
    this.selectStudyLevel(this.activeStudyArea || 1, this.activeStudyLevel || 1);
  }

  // Tablet mode: Problem Solving only. Hides the right column and shows scratch paper (notes-pad.js).
  toggleTabletMode() {
    this.tabletMode = !this.isTabletModeOn();
    try { localStorage.setItem('bayaw-tablet-mode', this.tabletMode ? '1' : '0'); } catch (e) {}
    if (!document.getElementById('view-mock-exam')?.classList.contains('hidden')) window.bayawMock?.applyTablet();
    else this.applyTabletMode(this.currentDeck?.[this.currentCardIdx]);
  }

  isTabletModeOn() {
    if (this.tabletMode === undefined) {
      try { this.tabletMode = localStorage.getItem('bayaw-tablet-mode') === '1'; } catch (e) { this.tabletMode = false; }
    }
    return this.tabletMode;
  }

  applyTabletMode(card) {
    const on = this.problemSolvingOnly && this.isTabletModeOn() && !!card;
    document.getElementById('study-stage')?.classList.toggle('tablet-on', on);
    const btn = document.getElementById('btn-tablet-mode');
    if (btn) {
      btn.setAttribute('aria-pressed', on);
      btn.querySelector('span').textContent = on ? 'Exit tablet mode' : 'Tablet mode';
    }
    if (on) window.bayawNotes?.open(card.id);
    else window.bayawNotes?.close();
  }

  setStudyStyle(style) {
    this.studyStyle = style;
    const mcqBtn = document.getElementById('mode-btn-mcq');
    const flipBtn = document.getElementById('mode-btn-flip');
    const chkMcq = document.getElementById('mode-check-mcq');
    const chkFlip = document.getElementById('mode-check-flip');

    if (style === 'mcq') {
      mcqBtn.className = 'p-2.5 rounded-xl text-left border-2 border-emerald-400 bg-emerald-500/15 transition-all';
      flipBtn.className = 'p-2.5 rounded-xl text-left border border-blue-900/60 bg-navy-900/80 hover:border-sky-400/60 transition-all';
      chkMcq.classList.remove('hidden');
      chkFlip.classList.add('hidden');
      document.getElementById('study-mode-pill').textContent = 'Board MCQ + Anki SRS';
    } else {
      flipBtn.className = 'p-2.5 rounded-xl text-left border-2 border-emerald-400 bg-emerald-500/15 transition-all';
      mcqBtn.className = 'p-2.5 rounded-xl text-left border border-blue-900/60 bg-navy-900/80 hover:border-sky-400/60 transition-all';
      chkFlip.classList.remove('hidden');
      chkMcq.classList.add('hidden');
      document.getElementById('study-mode-pill').textContent = 'Classic Anki Flip';
    }
    this.renderStudyCard();
  }

  renderStudyCard() {
    if (!this.currentDeck || this.currentDeck.length === 0) return;
    const card = this.currentDeck[this.currentCardIdx];
    this.isAnswerRevealed = false;

    const startNum = (this.activeStudyLevel - 1) * 100 + 1;
    const endNum = startNum + this.currentDeck.length - 1;
    const masteredInDeck = this.currentDeck.filter(it => this.user.srs[it.id]?.status === 'mastered').length;
    const deckPct = this.currentDeck.length > 0 ? (masteredInDeck / this.currentDeck.length) * 100 : 0;

    if (this.drillLabel) {
      document.getElementById('study-header-title').textContent = `Weak-topic drill — ${this.drillLabel} (${this.currentDeck.length} questions)`;
      document.getElementById('study-q-num').textContent = `Q. ${this.currentCardIdx + 1} / ${this.currentDeck.length}`;
      document.getElementById('study-mini-lvl-label').textContent = 'Weak-topic drill';
      document.getElementById('study-mini-lvl-txt').textContent = `${masteredInDeck} / ${this.currentDeck.length} (${deckPct.toFixed(0)}%)`;
      document.getElementById('study-mini-lvl-bar').style.width = `${deckPct}%`;
    } else if (this.problemSolvingOnly) {
      document.getElementById('study-header-title').innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-calculator"/></svg> Study Session — Area-${this.activeStudyArea} Level (PS) (${this.currentDeck.length} Problems)`;
      document.getElementById('study-q-num').textContent = `Problem ${this.currentCardIdx + 1} / ${this.currentDeck.length}`;
      document.getElementById('study-mini-lvl-label').textContent = `Area-${this.activeStudyArea} Level (PS)`;
      document.getElementById('study-mini-lvl-txt').textContent = `${masteredInDeck} / ${this.currentDeck.length} (${deckPct.toFixed(0)}%)`;
      document.getElementById('study-mini-lvl-bar').style.width = `${deckPct}%`;
    } else {
      const lst = this.getLevelStats(this.activeStudyArea, this.activeStudyLevel);
      document.getElementById('study-header-title').textContent = `Study Session — Area ${this.activeStudyArea} • Level ${this.activeStudyLevel} (${startNum} – ${endNum})`;
      document.getElementById('study-q-num').textContent = `Q. ${this.currentCardIdx + 1} / ${this.currentDeck.length}`;
      document.getElementById('study-mini-lvl-label').textContent = `Area ${this.activeStudyArea} Lv ${this.activeStudyLevel} (${startNum}–${endNum})`;
      document.getElementById('study-mini-lvl-txt').textContent = `${lst.mastered} / ${lst.total} (${lst.pct.toFixed(0)}%)`;
      document.getElementById('study-mini-lvl-bar').style.width = `${lst.pct}%`;
    }

    document.getElementById('study-area-pill').textContent = this.problemSolvingOnly ? `Area ${card.area} • Math` : `Area ${card.area}`;
    document.getElementById('study-id-pill').textContent = `#${card.index} (${card.id})`;
    document.getElementById('study-question-text').textContent = card.question;
    this.applyTabletMode(card);

    // SRS next review status (show live Anki countdown if in learning!)
    const rec = this.user.srs[card.id];
    const nextRevEl = document.getElementById('study-next-review');
    if (!rec) {
      nextRevEl.textContent = 'New card';
    } else if (rec.status === 'learning') {
      const remSec = Math.max(0, Math.ceil(((rec.due || 0) - Date.now()) / 1000));
      nextRevEl.innerHTML = remSec === 0 ? '<svg class="ic" aria-hidden="true"><use href="#i-rotate-ccw"/></svg> Due now' : `<svg class="ic" aria-hidden="true"><use href="#i-timer"/></svg> Again in ${remSec}s`;
    } else {
      nextRevEl.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-calendar"/></svg> ${rec.interval || 3} days`;
    }

    // Show Anki Re-queue notification banner if this card came back automatically
    const areaPill = document.getElementById('study-area-pill');
    if (this.requeueBannerText) {
      areaPill.innerHTML = this.requeueBannerText;
      areaPill.className = 'px-2.5 py-0.5 rounded-md bg-rose-600/35 border border-rose-400/60 text-xs font-extrabold text-rose-200';
      this.requeueBannerText = '';
    } else {
      areaPill.textContent = this.problemSolvingOnly ? `Area ${card.area} • Math` : `Area ${card.area}`;
      areaPill.className = 'px-2.5 py-0.5 rounded-md bg-blue-600/35 border border-blue-400/50 text-xs font-bold text-sky-200';
    }

    // Images (blur solution images until answer is submitted/revealed!)
    const imgBox = document.getElementById('study-images-container');
    if (card.images && card.images.length > 0) {
      imgBox.classList.remove('hidden');
      imgBox.innerHTML = card.images.map(src => `
        <div class="study-img-wrapper relative rounded-xl overflow-hidden border border-blue-900/60 bg-white inline-block">
          <img src="${this.fixAssetPath(src)}" loading="lazy" decoding="async" alt="Solution figure" class="study-solution-img max-h-56 p-1.5 object-contain blur-lg scale-105 opacity-60 transition-all duration-300 select-none pointer-events-none" />
          <div class="study-img-veil absolute inset-0 bg-navy-950/65 backdrop-blur-md flex flex-col items-center justify-center p-3 text-center">
            <span class="text-xs font-extrabold text-amber-300"><svg class="ic" aria-hidden="true"><use href="#i-lock"/></svg> Solution Image Hidden</span>
            <span class="text-xs text-slate-300 mt-0.5">Select an answer or press Show Answer to reveal clearly</span>
          </div>
        </div>
      `).join('');
    } else {
      imgBox.classList.add('hidden');
      imgBox.innerHTML = '';
    }

    // Choices vs Flip
    const choicesBox = document.getElementById('study-mcq-choices');
    const flipWrap = document.getElementById('study-flip-btn-wrap');
    if (this.studyStyle === 'mcq' && card.choices && card.choices.length > 0) {
      choicesBox.classList.remove('hidden');
      flipWrap.classList.add('hidden');
      const letters = ['A', 'B', 'C', 'D'];
      // New order once per visit, so a repeat review tests the content, not "it was C"
      if (!card._shuffled) {
        for (let i = card.choices.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [card.choices[i], card.choices[j]] = [card.choices[j], card.choices[i]]; }
        card._shuffled = true;
      }
      choicesBox.innerHTML = card.choices.map((ch, idx) => `
        <button onclick="app.selectStudyMcqChoice(${idx})" id="study-choice-${idx}" class="choice">
          <span class="choice-badge">${letters[idx]}</span>
          <span class="text-[15px] leading-snug flex-1">${this.escapeHtml(ch)}</span>
        </button>
      `).join('');
    } else {
      choicesBox.classList.add('hidden');
      flipWrap.classList.remove('hidden');
    }

    document.getElementById('study-answer-box').classList.add('hidden');
    this.renderMinimap();
  }

  selectStudyMcqChoice(choiceIdx) {
    if (this.isAnswerRevealed) return;
    const card = this.currentDeck[this.currentCardIdx];
    const chosen = card.choices[choiceIdx];
    const isCorrect = chosen === card.answer;
    if (!isCorrect) {
      const r = this.user.srs[card.id] || (this.user.srs[card.id] = { status: 'learning', lastRating: 'again', interval: 0, due: Date.now(), reps: 0 });
      r.misses = (r.misses || 0) + 1;
      this.missCountedFor = card.id; // the rating that follows should not count the same miss again
      this.saveUserState();
    }

    card.choices.forEach((ch, idx) => {
      const btn = document.getElementById(`study-choice-${idx}`);
      if (!btn) return;
      if (ch === card.answer) {
        btn.classList.add('is-right');
        btn.insertAdjacentHTML('beforeend', '<span class="choice-tag">ANSWER</span>');
      } else if (idx === choiceIdx && !isCorrect) {
        btn.classList.add('is-wrong');
        btn.insertAdjacentHTML('beforeend', '<span class="choice-tag">YOURS</span>');
      }
    });

    this.revealStudyAnswer(chosen);
  }

  buildChoiceExplanationsHtml(card, chosenAnswer = null) {
    const ce = card?.choiceExplanations;
    if (!ce || typeof ce !== 'object') return '';
    const ans = String(card.answer || '').trim();
    const chosen = chosenAnswer ? String(chosenAnswer).trim() : '';
    const isWrongPick = chosen && chosen.toLowerCase() !== ans.toLowerCase();

    const findExp = (txt) => {
      if (!txt) return '';
      if (ce[txt]) return ce[txt];
      const low = txt.toLowerCase();
      const k = Object.keys(ce).find(x => x.trim().toLowerCase() === low);
      return k ? ce[k] : '';
    };

    const parts = [];
    if (isWrongPick) {
      const wrongExp = findExp(chosen);
      if (wrongExp) {
        parts.push(`
          <div class="rounded-lg bg-rose-950/55 border border-rose-400/45 px-3 py-2 text-xs text-rose-100 leading-relaxed">
            <span class="font-extrabold text-rose-300"><svg class="ic" aria-hidden="true"><use href="#i-circle-x"/></svg> Why "${this.escapeHtml(chosen)}" Is Wrong: </span>${this.escapeHtml(wrongExp)}
          </div>
        `);
      }
    }

    const ansExp = findExp(ans);
    if (ansExp) {
      parts.push(`
        <div class="rounded-lg bg-emerald-950/55 border border-emerald-400/40 px-3 py-2 text-xs text-emerald-100 leading-relaxed">
          <span class="font-extrabold text-emerald-300"><svg class="ic" aria-hidden="true"><use href="#i-circle-check"/></svg> Why "${this.escapeHtml(ans)}" Is Correct: </span>${this.escapeHtml(ansExp)}
        </div>
      `);
    }

    const others = (card.choices || []).filter(ch => {
      const c = String(ch || '').trim();
      if (!c) return false;
      if (c.toLowerCase() === ans.toLowerCase()) return false;
      if (isWrongPick && c.toLowerCase() === chosen.toLowerCase()) return false;
      return !!findExp(c);
    });

    if (others.length > 0) {
      parts.push(`
        <details class="rounded-lg bg-navy-950/75 border border-blue-900/50 px-3 py-2 text-xs">
          <summary class="cursor-pointer font-bold text-sky-300 select-none">See why the other ${others.length === 1 ? 'choice is' : 'choices are'} wrong (${others.length})</summary>
          <div class="space-y-1.5 pt-2">
            ${others.map(ch => `
              <div class="text-slate-300 leading-relaxed">
                <span class="font-bold text-slate-100">• ${this.escapeHtml(ch)}:</span> ${this.escapeHtml(findExp(ch))}
              </div>
            `).join('')}
          </div>
        </details>
      `);
    }

    // whitespace-normal: the rationale box keeps line breaks (pre-line), which would turn this markup's newlines into blank lines
    return parts.length ? `<div class="space-y-2 pt-1.5 whitespace-normal">${parts.join('')}</div>` : '';
  }

  revealStudyAnswer(chosenAnswer = null) {
    const card = this.currentDeck[this.currentCardIdx];
    this.isAnswerRevealed = true;
    document.getElementById('study-flip-btn-wrap').classList.add('hidden');
    document.getElementById('study-answer-box').classList.remove('hidden');
    document.getElementById('study-answer-text').textContent = card.answer;
    // Problem-solving items read like an engineer's worked solution: mono working on graph paper
    const isPs = card.category === 'problem_solving';
    document.getElementById('study-answer-label').textContent = isPs ? 'Worked solution' : 'Verified answer & rationale';
    document.getElementById('study-rationale-text').classList.toggle('worked', isPs);
    const ceHtml = this.buildChoiceExplanationsHtml(card, chosenAnswer);
    const ratHtml = this.formatRationaleHtml(card);
    document.getElementById('study-rationale-text').innerHTML = ceHtml
      ? `${ceHtml}${card.rationale && card.rationale.trim() ? `<div class="pt-1.5 border-t border-emerald-500/20 mt-1.5">${ratHtml}</div>` : ''}`
      : ratHtml;

    // Unblur any solution images clearly
    document.querySelectorAll('.study-solution-img').forEach(img => {
      img.classList.remove('blur-lg', 'scale-105', 'opacity-60', 'pointer-events-none');
    });
    document.querySelectorAll('.study-img-veil').forEach(veil => {
      veil.classList.add('hidden');
    });
  }

  rateCard(rating) {
    if (!this.currentDeck || this.currentDeck.length === 0) return;
    const card = this.currentDeck[this.currentCardIdx];
    const prev = this.user.srs[card.id] || { status: 'new', interval: 0, reps: 0 };
    const now = Date.now();
    const DAY_MS = 86400000;

    if ((rating === 'again' || rating === 'hard') && this.missCountedFor !== card.id) prev.misses = (prev.misses || 0) + 1;
    this.missCountedFor = null;

    if (rating === 'again') {
      // Real Anki behavior: returns automatically in 1 minute (60s)
      prev.status = 'learning';
      prev.lastRating = 'again';
      prev.interval = 0;
      prev.due = now + 60 * 1000;
      this.user.xp += 5;
    } else if (rating === 'hard') {
      // Real Anki behavior: returns automatically in 10 minutes (600s)
      prev.status = 'learning';
      prev.lastRating = 'hard';
      prev.interval = 0.5;
      prev.due = now + 10 * 60 * 1000;
      this.user.xp += 10;
    } else if (rating === 'good') {
      prev.status = 'mastered';
      prev.lastRating = 'good';
      prev.reps = (prev.reps || 0) + 1;
      prev.interval = prev.interval >= 1 ? Math.round(prev.interval * 2.2) : 3;
      prev.due = now + prev.interval * DAY_MS;
      this.user.xp += 20;
    } else if (rating === 'easy') {
      prev.status = 'mastered';
      prev.lastRating = 'easy';
      prev.reps = (prev.reps || 0) + 1;
      prev.interval = prev.interval >= 1 ? Math.round(prev.interval * 3.0) : 7;
      prev.due = now + prev.interval * DAY_MS;
      this.user.xp += 25;
    }

    this.user.srs[card.id] = prev;
    this.countAnswered(1);
    this.saveUserState();
    this.renderLevelTiles();

    // Pick next card like real Anki:
    // 1) First priority: Any "Again" / "Hard" learning card in this deck whose timer has expired (due <= now)!
    const dueNowIdx = this.currentDeck.findIndex((it, idx) => {
      if (idx === this.currentCardIdx) return false;
      const r = this.user.srs[it.id];
      return r && r.status === 'learning' && r.due && r.due <= now;
    });

    if (dueNowIdx >= 0) {
      this.currentCardIdx = dueNowIdx;
      this.requeueBannerText = '<span class="inline-block w-2 h-2 rounded-full bg-rose-400 align-middle"></span> Anki Re-Review (Due Now!)';
      this.renderStudyCard();
      return;
    }

    // 2) Next priority: Next unseen/unmastered card forward in the deck
    let nextIdx = -1;
    for (let i = this.currentCardIdx + 1; i < this.currentDeck.length; i++) {
      if (this.user.srs[this.currentDeck[i].id]?.status !== 'mastered') {
        nextIdx = i;
        break;
      }
    }

    // 3) If we reached the end, wrap around to any remaining learning/unseen card (earliest due first!)
    if (nextIdx < 0) {
      let earliestLearningIdx = -1;
      let earliestDue = Infinity;
      this.currentDeck.forEach((it, idx) => {
        const r = this.user.srs[it.id];
        if (r && r.status === 'learning' && (r.due || 0) < earliestDue) {
          earliestDue = r.due || 0;
          earliestLearningIdx = idx;
        }
      });
      if (earliestLearningIdx >= 0) {
        nextIdx = earliestLearningIdx;
        this.requeueBannerText = '<span class="inline-block w-2 h-2 rounded-full bg-rose-400 align-middle"></span> Anki Learning Queue';
      } else {
        const anyUnseen = this.currentDeck.findIndex(it => !this.user.srs[it.id]);
        nextIdx = anyUnseen >= 0 ? anyUnseen : 0;
      }
    }

    this.currentCardIdx = nextIdx;
    this.renderStudyCard();
  }

  renderMinimap() {
    const map = document.getElementById('study-item-minimap');
    const startNum = (this.activeStudyLevel - 1) * 100 + 1;
    const endNum = startNum + this.currentDeck.length - 1;
    document.getElementById('minimap-title').innerHTML = this.drillLabel
      ? `<svg class="ic" aria-hidden="true"><use href="#i-target"/></svg> Drill minimap (${this.currentDeck.length} questions)`
      : this.problemSolvingOnly
      ? `<svg class="ic" aria-hidden="true"><use href="#i-calculator"/></svg> Area ${this.activeStudyArea} Problem Solving Minimap (${this.currentDeck.length} Problems)`
      : `<svg class="ic" aria-hidden="true"><use href="#i-map"/></svg> 100-Item Level Minimap (Level ${this.activeStudyLevel}: ${startNum} – ${endNum})`;

    let cAgain = 0, cHard = 0, cGood = 0, cEasy = 0, unseen = 0;
    map.innerHTML = this.currentDeck.map((it, idx) => {
      const rec = this.user.srs[it.id];
      const isCur = idx === this.currentCardIdx;
      let cls = 'bg-navy-900 border border-blue-900/50 text-slate-400 hover:border-sky-400';

      if (rec) {
        const r = rec.lastRating || (rec.status === 'mastered' ? 'easy' : 'again');
        if (r === 'again') {
          cAgain++;
          cls = 'bg-rose-600 text-on-accent font-extrabold';
        } else if (r === 'hard') {
          cHard++;
          cls = 'bg-amber-500 text-on-accent font-extrabold';
        } else if (r === 'good') {
          cGood++;
          cls = 'bg-blue-600 text-on-accent font-extrabold';
        } else {
          cEasy++;
          cls = 'bg-emerald-500 text-on-accent font-extrabold';
        }
      } else {
        unseen++;
      }

      if (isCur) {
        cls += ' ring-2 ring-inset ring-white'; // inset so the scroll box doesn't clip it
      }
      return `
        <button onclick="app.jumpToStudyCard(${idx})" class="h-6 rounded text-xs font-mono transition-all ${cls}" title="${this.problemSolvingOnly || this.drillLabel ? 'Question ' + (idx + 1) : 'Item #' + it.index}">
          ${this.problemSolvingOnly || this.drillLabel ? idx + 1 : it.index}
        </button>
      `;
    }).join('');

    const elAgain = document.getElementById('map-cnt-again');
    const elHard = document.getElementById('map-cnt-hard');
    const elGood = document.getElementById('map-cnt-good');
    const elEasy = document.getElementById('map-cnt-easy');
    const elNew = document.getElementById('map-cnt-new');
    if (elAgain) elAgain.textContent = cAgain;
    if (elHard) elHard.textContent = cHard;
    if (elGood) elGood.textContent = cGood;
    if (elEasy) elEasy.textContent = cEasy;
    if (elNew) elNew.textContent = unseen;
  }

  jumpToStudyCard(idx) {
    this.currentCardIdx = idx;
    this.renderStudyCard();
  }

  // ==================== 1v1 PvP REAL HUMAN-VS-HUMAN MATCHMAKING ====================
  seededRng(seedStr) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seedStr.length; i++) {
      h ^= seedStr.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return () => {
      h += h << 13; h ^= h >>> 7;
      h += h << 3;  h ^= h >>> 17;
      h += h << 5;
      return (h >>> 0) / 4294967296;
    };
  }

  async loadWaitingPvpRooms() {
    if (!document.getElementById('pvp-waiting-list')) return;
    try {
      const res = await this.apiCall('POST', { action: 'pvp_list_waiting' });
      const data = await res.json();
      this.pvpRooms = (data.waiting || []).filter(r => r.p1_name !== this.user.name);
      this.renderPvpRooms();
    } catch (e) {}
  }

  renderPvpRooms() {
    const listEl = document.getElementById('pvp-waiting-list');
    if (!listEl) return;
    const rooms = this.pvpRooms || [];
    if (!rooms.length) {
      listEl.innerHTML = `<div class="pvl-empty"><svg class="ic" aria-hidden="true"><use href="#i-users"/></svg><div>No one is waiting right now.</div><div class="text-[12.5px]">Tap Find match to open a room. Others will see it here.</div></div>`;
      return;
    }
    const v = (id) => document.getElementById(id)?.value;
    listEl.innerHTML = rooms.map(r => {
      const name = String(r.p1_name || 'Reviewee');
      const ini = this.escapeHtml(name.replace(/^Engr\.?\s*/i, '').replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase());
      const label = `${this.pvpLevelLabel(r.area_id, String(r.level_val))} · ${r.deck_size} cards`;
      const match = String(r.area_id) === v('lobby-pvp-area') && String(r.level_val) === v('lobby-pvp-level') && String(r.deck_size) === v('quick-pvp-size');
      const btn = match ? 'bg-emerald-600 hover:bg-emerald-700 text-on-accent border-transparent' : 'border-rule bg-surface hover:border-emerald-500';
      return `<div class="pvl-room">
          <div class="pvl-av sm" aria-hidden="true">${ini}</div>
          <div class="min-w-0"><b class="font-semibold text-sm">${this.escapeHtml(name)}</b> <span class="font-mono text-xs text-slate-400">${(r.p1_rp || 1200).toLocaleString()} RP</span><div class="text-[12.5px] text-slate-400">${label}</div></div>
          <button onclick="app.joinWaitingPvpRoom(${Number(r.area_id)}, '${this.escapeHtml(String(r.level_val))}', ${Number(r.deck_size)})" aria-label="Accept duel with ${this.escapeHtml(name)}, ${label}" class="inline-flex items-center gap-1.5 px-3 min-h-[38px] rounded-[10px] border text-[13px] font-semibold ${btn}"><svg class="ic" aria-hidden="true"><use href="#i-swords"/></svg><span class="pvl-acc">Accept</span></button>
        </div>`;
    }).join('');
  }

  joinWaitingPvpRoom(areaId, levelVal, deckSize) {
    const areaSel = document.getElementById('lobby-pvp-area');
    const lvlSel = document.getElementById('lobby-pvp-level');
    const sizeSel = document.getElementById('quick-pvp-size');
    if (areaSel) {
      areaSel.value = String(areaId);
      this.populateLobbyLevels();
    }
    if (lvlSel) lvlSel.value = String(levelVal);
    if (sizeSel) sizeSel.value = String(deckSize);
    this.startFindingMatch();
  }

  async startFindingMatch() {
    if (!this.user.loggedIn) {
      this.openAuthModal('login');
      return;
    }
    this.clearPvpTimers();
    const areaId = parseInt(document.getElementById('lobby-pvp-area')?.value || '1', 10);
    const levelVal = String(document.getElementById('lobby-pvp-level')?.value || '1');
    const deckSize = parseInt(document.getElementById('quick-pvp-size')?.value || '10', 10);

    document.getElementById('pvp-lobby-settings').classList.add('hidden');
    document.getElementById('pvp-searching-box').classList.remove('hidden');
    document.getElementById('pvp-search-desc').innerHTML = `Waiting for a reviewee on <b class="font-semibold text-white">${this.pvpLevelLabel(areaId, levelVal)} · ${deckSize} cards</b>. Others in the lobby can see your room.`;

    // Start live "Finding Match" stopwatch timer
    this.pvpSearching = true;
    const searchStart = Date.now();
    document.getElementById('pvp-search-timer').textContent = '00:00';
    this.pvpSearchTimerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - searchStart) / 1000);
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      const el = document.getElementById('pvp-search-timer');
      if (el) el.textContent = `${m}:${s}`;
    }, 500);

    try {
      const res = await this.apiCall('POST', {
        action: 'pvp_find_match',
        areaId,
        levelVal,
        deckSize,
        playerId: this.user.id,
        playerName: this.user.name,
        playerRp: this.user.rp || 1200
      });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.match) {
        alert(data.error || 'Could not start matchmaking. Make sure the pvp_matches table was created in Supabase!');
        this.cancelFindingMatch();
        return;
      }

      this.pvpMatchId = data.match.id;
      this.pvpRole = data.role;

      if (data.matched && data.match.status === 'active') {
        this.launchRealPvpArena(data.match);
        return;
      }

      // Poll Supabase every 1.5s until another real reviewee joins our waiting room
      this.pvpPollInterval = setInterval(async () => {
        if (!this.pvpSearching || !this.pvpMatchId) return;
        try {
          const pr = await this.apiCall('POST', { action: 'pvp_poll_match', matchId: this.pvpMatchId });
          const pd = await pr.json();
          if (pr.ok && pd.match) {
            if (pd.match.status === 'active' && pd.match.p2_id) {
              this.launchRealPvpArena(pd.match);
            } else if (pd.match.status === 'cancelled') {
              this.cancelFindingMatch();
            }
          }
        } catch (e) {}
      }, 1500);
    } catch (err) {
      alert('Network error starting matchmaking.');
      this.cancelFindingMatch();
    }
  }

  async cancelFindingMatch() {
    this.pvpSearching = false;
    if (this.pvpSearchTimerInterval) clearInterval(this.pvpSearchTimerInterval);
    if (this.pvpPollInterval) clearInterval(this.pvpPollInterval);
    if (this.pvpMatchId && !this.pvpActive) {
      const idToCancel = this.pvpMatchId;
      this.pvpMatchId = null;
      try {
        await this.apiCall('POST', { action: 'pvp_cancel_match', matchId: idToCancel });
      } catch (e) {}
    }
    const settings = document.getElementById('pvp-lobby-settings');
    const searching = document.getElementById('pvp-searching-box');
    if (settings) settings.classList.remove('hidden');
    if (searching) searching.classList.add('hidden');
    this.loadWaitingPvpRooms();
  }

  launchRealPvpArena(match) {
    this.pvpSearching = false;
    this.clearPvpTimers();

    // Build exact same shuffled deck for both real players using match.deck_seed
    let pool = [];
    let deckLabel = '';
    if (match.level_val === 'ps') {
      pool = [...this.getPsItems(match.area_id)];
      deckLabel = `Area-${match.area_id} Level (PS)`;
    } else {
      const lvlNum = parseInt(match.level_val, 10) || 1;
      const lst = this.getLevelStats(match.area_id, lvlNum);
      pool = [...lst.items];
      deckLabel = `Area ${match.area_id} • Level ${lvlNum}`;
    }

    const rng = this.seededRng(match.deck_seed);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const sharedDeck = pool.slice(0, Math.min(match.deck_size, pool.length));
    this.pvpPlayerQueue = [...sharedDeck];
    this.pvpTotalCards = sharedDeck.length;
    this.pvpClearedCount = 0;
    this.pvpCombo = 0;
    this.pvpLapses = 0;
    this.pvpLocked = false;
    this.pvpActive = true;

    const oppIsP1 = (this.pvpRole === 'p2');
    this.pvpOpponent = {
      id: oppIsP1 ? match.p1_id : match.p2_id,
      name: oppIsP1 ? match.p1_name : match.p2_name,
      rp: oppIsP1 ? (match.p1_rp || 1200) : (match.p2_rp || 1200),
      remaining: sharedDeck.length,
      cleared: 0,
      lapses: 0,
      status: 'Live Opponent Connected!'
    };

    const settings = document.getElementById('pvp-lobby-settings');
    const searching = document.getElementById('pvp-searching-box');
    if (settings) settings.classList.remove('hidden');
    if (searching) searching.classList.add('hidden');

    document.getElementById('pvp-arena-deck-label').textContent = `${deckLabel} (${this.pvpTotalCards} Cards)`;
    document.getElementById('pvp-arena-seed-badge').textContent = `Shared Deck: ${match.deck_seed}`;
    document.getElementById('pvp-you-name').textContent = `YOU (${this.user.name})`;
    document.getElementById('pvp-opp-name').textContent = `${this.pvpOpponent.name} • ${this.pvpOpponent.rp} RP`;
    document.getElementById('pvp-result-box').classList.add('hidden');
    document.getElementById('pvp-card-container').classList.remove('hidden');
    document.getElementById('pvp-penalty-overlay').classList.add('hidden');

    this.showView('pvp-arena');
    this.updatePvpScoreboard();
    this.renderPvpCard();

    this.pvpStartTime = performance.now();
    this.pvpTimerInterval = setInterval(() => {
      if (!this.pvpActive) return;
      const elapsed = (performance.now() - this.pvpStartTime) / 1000;
      const m = Math.floor(elapsed / 60);
      const s = (elapsed % 60).toFixed(1);
      document.getElementById('pvp-timer').textContent = `${String(m).padStart(2, '0')}:${s.padStart(4, '0')}`;
    }, 100);

    // Poll real human opponent's live progress every 1.2s
    this.pvpPollInterval = setInterval(async () => {
      if (!this.pvpActive || !this.pvpMatchId) return;
      try {
        const res = await this.apiCall('POST', { action: 'pvp_poll_match', matchId: this.pvpMatchId });
        const data = await res.json();
        if (!res.ok || !data.match) return;
        const m = data.match;
        const oppRem = oppIsP1 ? m.p1_remaining : m.p2_remaining;
        const oppClr = oppIsP1 ? m.p1_cleared : m.p2_cleared;
        const oppLap = oppIsP1 ? m.p1_lapses : m.p2_lapses;

        if (oppLap > this.pvpOpponent.lapses) {
          this.pvpOpponent.status = '<svg class="ic" aria-hidden="true"><use href="#i-circle-x"/></svg> Lapsed! Card cycled back';
        } else if (oppClr > this.pvpOpponent.cleared) {
          this.pvpOpponent.status = `Cleared ${oppClr}/${this.pvpTotalCards}!`;
        }
        this.pvpOpponent.remaining = oppRem ?? this.pvpTotalCards;
        this.pvpOpponent.cleared = oppClr || 0;
        this.pvpOpponent.lapses = oppLap || 0;
        this.updatePvpScoreboard();

        if (m.status === 'finished' && m.winner_id) {
          this.finishPvpMatch(m.winner_id === this.user.id);
        }
      } catch (e) {}
    }, 1200);
  }

  async syncMyPvpProgress() {
    if (!this.pvpMatchId || !this.pvpRole) return;
    try {
      const res = await this.apiCall('POST', {
        action: 'pvp_update_progress',
        matchId: this.pvpMatchId,
        role: this.pvpRole,
        remaining: this.pvpPlayerQueue.length,
        cleared: this.pvpClearedCount,
        lapses: this.pvpLapses
      });
      const data = await res.json();
      if (res.ok && data.match && data.match.status === 'finished' && data.match.winner_id) {
        this.finishPvpMatch(data.match.winner_id === this.user.id);
      }
    } catch (e) {}
  }

  updatePvpScoreboard() {
    const youRem = this.pvpPlayerQueue.length;
    const youPct = ((this.pvpTotalCards - youRem) / this.pvpTotalCards) * 100;
    document.getElementById('pvp-you-remaining').textContent = `${youRem} cards left`;
    document.getElementById('pvp-you-bar').style.width = `${youPct}%`;
    document.getElementById('pvp-you-cleared').textContent = this.pvpClearedCount;
    document.getElementById('pvp-you-combo').textContent = `${this.pvpCombo}x`;
    document.getElementById('pvp-you-lapses').textContent = this.pvpLapses;

    const oppRem = this.pvpOpponent.remaining;
    const oppPct = ((this.pvpTotalCards - oppRem) / this.pvpTotalCards) * 100;
    document.getElementById('pvp-opp-remaining').textContent = `${oppRem} cards left`;
    document.getElementById('pvp-opp-bar').style.width = `${oppPct}%`;
    document.getElementById('pvp-opp-cleared').textContent = this.pvpOpponent.cleared;
    document.getElementById('pvp-opp-status').innerHTML = this.pvpOpponent.status;
    document.getElementById('pvp-opp-lapses').textContent = this.pvpOpponent.lapses;
  }

  renderPvpCard() {
    if (this.pvpPlayerQueue.length === 0) {
      this.finishPvpMatch(true);
      return;
    }
    const card = this.pvpPlayerQueue[0];
    document.getElementById('pvp-q-subtopic').textContent = card.subtopic;
    document.getElementById('pvp-q-id').textContent = `#${card.id} • ${card.levelLabel}`;
    document.getElementById('pvp-q-text').textContent = card.question;

    const imgBox = document.getElementById('pvp-q-images');
    // Hide solution images during active PvP question so answers aren't leaked
    imgBox.classList.add('hidden');
    imgBox.innerHTML = '';

    const letters = ['A', 'B', 'C', 'D'];
    document.getElementById('pvp-q-choices').innerHTML = card.choices.map((ch, idx) => `
      <button onclick="app.answerPvpCard(${idx})" class="p-3.5 rounded-xl bg-navy-950 hover:bg-navy-800 border border-blue-900/60 hover:border-sky-400 text-left transition-all flex items-center gap-3">
        <span class="w-6 h-6 rounded-md bg-navy-800 text-sky-300 font-mono text-xs font-extrabold flex items-center justify-center shrink-0">${letters[idx]}</span>
        <span class="text-xs sm:text-sm font-semibold text-white">${this.escapeHtml(ch)}</span>
      </button>
    `).join('');
  }

  answerPvpCard(choiceIdx) {
    if (!this.pvpActive || this.pvpLocked || this.pvpPlayerQueue.length === 0) return;
    const card = this.pvpPlayerQueue[0];
    if (card.choices[choiceIdx] === card.answer) {
      this.pvpPlayerQueue.shift();
      this.pvpClearedCount++;
      this.pvpCombo++;
      this.user.xp += 15;
      this.user.srs[card.id] = { status: 'mastered', interval: 3, due: Date.now() + 3 * 86400000, reps: (this.user.srs[card.id]?.reps || 0) + 1, misses: this.user.srs[card.id]?.misses || 0 };
      this.saveUserState();
      this.updatePvpScoreboard();
      this.syncMyPvpProgress();
      if (this.pvpPlayerQueue.length === 0) this.finishPvpMatch(true);
      else this.renderPvpCard();
    } else {
      this.pvpLocked = true;
      this.pvpCombo = 0;
      this.pvpLapses++;
      const missed = this.pvpPlayerQueue.shift();
      this.pvpPlayerQueue.push(missed);
      this.user.srs[card.id] = { status: 'learning', lastRating: 'again', interval: 0, due: Date.now(), reps: 0, misses: (this.user.srs[card.id]?.misses || 0) + 1 };
      this.saveUserState();
      this.updatePvpScoreboard();
      this.syncMyPvpProgress();

      const overlay = document.getElementById('pvp-penalty-overlay');
      document.getElementById('pvp-penalty-correct').textContent = card.answer;
      overlay.classList.remove('hidden');
      let rem = 1.8;
      document.getElementById('pvp-penalty-countdown').textContent = rem.toFixed(1);
      const t = setInterval(() => {
        rem -= 0.2;
        if (rem <= 0) {
          clearInterval(t);
          overlay.classList.add('hidden');
          this.pvpLocked = false;
          if (this.pvpActive) this.renderPvpCard();
        } else {
          document.getElementById('pvp-penalty-countdown').textContent = rem.toFixed(1);
        }
      }, 200);
    }
  }

  finishPvpMatch(won) {
    if (!this.pvpActive) return;
    this.pvpActive = false;
    this.clearPvpTimers();
    const elapsed = (performance.now() - this.pvpStartTime) / 1000;
    const attempts = this.pvpClearedCount + this.pvpLapses;
    const acc = attempts > 0 ? Math.round((this.pvpClearedCount / attempts) * 100) : 100;

    let rpDelta = 0;
    if (won) {
      rpDelta = 28 + Math.min(20, Math.max(0, Math.round((this.pvpTotalCards * 5 - elapsed) * 0.4)));
      this.user.rp += rpDelta;
      this.user.pvpWins++;
      this.user.xp += 120;
      if (!this.user.bestTimeSec || elapsed < this.user.bestTimeSec) {
        this.user.bestTimeSec = Number(elapsed.toFixed(1));
      }
    } else {
      rpDelta = -15;
      this.user.rp = Math.max(800, this.user.rp + rpDelta);
      this.user.pvpLosses = (this.user.pvpLosses || 0) + 1;
      this.user.xp += 35;
    }
    this.saveUserState();

    document.getElementById('pvp-card-container').classList.add('hidden');
    document.getElementById('pvp-result-box').classList.remove('hidden');
    document.getElementById('pvp-result-badge').innerHTML = won ? '<svg class="ic" aria-hidden="true"><use href="#i-trophy"/></svg> VICTORY • DECK CLEARED FIRST!' : '<svg class="ic" aria-hidden="true"><use href="#i-swords"/></svg> DEFEAT • OPPONENT FINISHED FIRST';
    document.getElementById('pvp-result-title').textContent = won ? `Deck Cleared in ${elapsed.toFixed(1)}s!` : `${this.pvpOpponent.name} Won!`;
    document.getElementById('pvp-result-subtitle').textContent = won
      ? `You outpaced ${this.pvpOpponent.name} (${this.pvpOpponent.remaining} cards left in their deck).`
      : `You had ${this.pvpPlayerQueue.length} cards left. Missed cards were added to your Anki SRS queue.`;
    document.getElementById('pvp-res-rp-delta').textContent = `${rpDelta > 0 ? '+' : ''}${rpDelta} RP`;
    document.getElementById('pvp-res-rp-delta').className = `text-xl font-extrabold font-mono ${won ? 'text-emerald-400' : 'text-rose-400'}`;
    document.getElementById('pvp-res-time').textContent = `${elapsed.toFixed(1)}s`;
    document.getElementById('pvp-res-accuracy').textContent = `${acc}%`;
  }

  async forfeitPvpMatch() {
    if (this.pvpActive && this.pvpMatchId && this.pvpRole) {
      try {
        await this.apiCall('POST', { action: 'pvp_forfeit', matchId: this.pvpMatchId, role: this.pvpRole });
      } catch (e) {}
      this.finishPvpMatch(false);
    }
    this.pvpActive = false;
    this.clearPvpTimers();
    this.openPvpLobby();
  }

  clearPvpTimers() {
    if (this.pvpTimerInterval) clearInterval(this.pvpTimerInterval);
    if (this.pvpSearchTimerInterval) clearInterval(this.pvpSearchTimerInterval);
    if (this.pvpPollInterval) clearInterval(this.pvpPollInterval);
  }

  // ==================== LEADERBOARDS (SIDEBAR + FULL VIEW) ====================
  highlightSideLb(tab) {
    const pBtn = document.getElementById('side-lb-tab-prog');
    const vBtn = document.getElementById('side-lb-tab-pvp');
    if (tab === 'prog') {
      pBtn.className = 'py-1.5 rounded-lg text-xs font-bold bg-indigo-600 text-on-accent';
      vBtn.className = 'py-1.5 rounded-lg text-xs font-bold text-slate-400 hover:text-white';
    } else {
      vBtn.className = 'py-1.5 rounded-lg text-xs font-bold bg-purple-600 text-on-accent';
      pBtn.className = 'py-1.5 rounded-lg text-xs font-bold text-slate-400 hover:text-white';
    }
  }

  getTierLabel(rp) {
    if (rp >= 1700) return { label: '<svg class="ic" aria-hidden="true"><use href="#i-star"/></svg> Legend', cls: 'bg-amber-500/20 text-amber-300 border-amber-400/50' };
    if (rp >= 1450) return { label: 'Diamond', cls: 'bg-sky-500/20 text-sky-300 border-sky-400/50' };
    if (rp >= 1250) return { label: 'Platinum', cls: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/50' };
    return { label: 'Gold ABE', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50' };
  }

  renderTitleBadge(p) {
    if (p.isOwner) {
      return `<span class="ml-1 px-1.5 py-0.5 rounded bg-amber-400 text-on-accent font-black text-xs uppercase"><svg class="ic" aria-hidden="true"><use href="#i-crown"/></svg> OWNER</span>`;
    }
    if (p.title) {
      return `<span class="ml-1 px-1.5 py-0.5 rounded bg-sky-500/20 border border-sky-400/40 text-sky-300 font-bold text-xs">${this.escapeHtml(p.title)}</span>`;
    }
    return '';
  }

  // Uses last_active_at the leaderboard already downloads (heartbeat every 90s), so no extra Supabase calls
  renderLastSeen(p) {
    const t = p.isUser ? Date.now() : p.lastActiveAt;
    if (!t) return '';
    const min = Math.floor((Date.now() - t) / 60000);
    if (min < 3) return `<span class="basis-full text-[11px] font-normal text-emerald-400 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>Online</span>`;
    const ago = min < 60 ? `${min}m` : min < 1440 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / 1440)}d`;
    return `<span class="basis-full text-[11px] font-normal text-slate-500">${ago} ago</span>`;
  }

  renderLeaderboards() {
    const s1 = this.getAreaStats(1);
    const s2 = this.getAreaStats(2);
    const s3 = this.getAreaStats(3);

    const selfEntry = {
      id: this.user.id,
      name: this.user.name,
      isOwner: !!this.user.isOwner,
      title: this.user.title || '',
      isUser: true,
      a1Levels: s1.completedLevels,
      a2Levels: s2.completedLevels,
      a3Levels: s3.completedLevels,
      totalMastered: s1.mastered + s2.mastered + s3.mastered,
      xp: this.user.xp,
      rp: this.user.rp,
      pvpWins: this.user.pvpWins || 0,
      pvpLosses: this.user.pvpLosses || 0,
      bestTimeSec: this.user.bestTimeSec
    };

    // Real reviewees only — zero fake/seeded bots!
    let progPlayers = [];
    let pvpPlayers = [];

    if (this.liveLeaderboard.connected && this.liveLeaderboard.progression.length > 0) {
      progPlayers = this.liveLeaderboard.progression.map(r => ({
        ...r,
        isUser: r.id === this.user.id
      }));
      pvpPlayers = this.liveLeaderboard.pvp.map(r => ({
        ...r,
        isUser: r.id === this.user.id
      })).sort((a, b) => ((b.pvpWins || 0) - (a.pvpWins || 0)) || ((a.pvpLosses || 0) - (b.pvpLosses || 0)) || ((b.rp || 1200) - (a.rp || 1200)));
      const badge = document.getElementById('lb-real-badge');
      if (badge) badge.textContent = `${this.liveLeaderboard.totalReviewees} Real Reviewee${this.liveLeaderboard.totalReviewees === 1 ? '' : 's'}`;
    } else if (!this.user.isOwner) {
      progPlayers = [selfEntry];
      if (selfEntry.pvpWins > 0 || selfEntry.pvpLosses > 0 || selfEntry.rp !== 1200 || selfEntry.bestTimeSec !== null) {
        pvpPlayers = [selfEntry];
      }
    }

    const progRowsHtml = progPlayers.length > 0
      ? progPlayers.map((p, i) => `
        <tr class="${p.isUser ? 'bg-blue-600/20 font-bold text-white' : 'text-slate-300'}">
          <td class="py-1.5 font-mono ${i === 0 ? 'text-amber-400 font-bold' : 'text-slate-400'}">${i === 0 ? '<svg class="ic" aria-hidden="true"><use href="#i-crown"/></svg>' : i + 1}</td>
          <td class="py-1.5 ${p.isUser ? 'text-sky-300' : 'text-white'}">
            <div class="flex flex-wrap items-center gap-0.5">
              <span class="truncate max-w-[100px]">${this.escapeHtml(p.name)}</span>
              ${this.renderTitleBadge(p)}
              ${this.renderLastSeen(p)}
            </div>
          </td>
          <td class="py-1.5 text-center font-mono text-sky-300">${p.a1Levels ?? 0}</td>
          <td class="py-1.5 text-center font-mono text-emerald-300">${p.a2Levels ?? 0}</td>
          <td class="py-1.5 text-center font-mono text-purple-300">${p.a3Levels ?? 0}</td>
          <td class="py-1.5 text-right font-mono text-amber-300">${(p.xp || 0).toLocaleString()}</td>
        </tr>
      `).join('')
      : `<tr><td colspan="6" class="py-4 text-center text-slate-400 text-xs">No reviewees yet. Start studying to claim #1!</td></tr>`;

    const pvpRowsHtml = pvpPlayers.length > 0
      ? pvpPlayers.map((p, i) => {
        const wins = p.pvpWins || 0;
        const losses = p.pvpLosses || 0;
        const bestStr = p.bestTimeSec ? `${Number(p.bestTimeSec).toFixed(1)}s` : '—';
        return `
          <tr class="${p.isUser ? 'bg-purple-600/20 font-bold text-white' : 'text-slate-300'}">
            <td class="py-1.5 font-mono ${i === 0 ? 'text-amber-400 font-bold' : 'text-slate-400'}">${i === 0 ? '<svg class="ic" aria-hidden="true"><use href="#i-crown"/></svg>' : i + 1}</td>
            <td class="py-1.5 ${p.isUser ? 'text-purple-200' : 'text-white'}">
              <div class="flex flex-wrap items-center gap-0.5">
                <span class="truncate max-w-[85px]">${this.escapeHtml(p.name)}</span>
                ${this.renderTitleBadge(p)}
                ${this.renderLastSeen(p)}
              </div>
            </td>
            <td class="py-1.5 text-center font-mono text-xs whitespace-nowrap">
              <span class="text-emerald-400 font-extrabold">${wins}W</span>
              <span class="text-slate-500 mx-0.5">-</span>
              <span class="text-rose-400 font-bold">${losses}L</span>
            </td>
            <td class="py-1.5 text-right font-mono font-bold text-amber-300">${(p.rp || 1200).toLocaleString()}</td>
            <td class="py-1.5 text-right font-mono text-slate-400">${bestStr}</td>
          </tr>
        `;
      }).join('')
      : `<tr><td colspan="5" class="py-4 text-center text-slate-400 text-xs">Finish a 1v1 PvP match to rank on the real PvP board!</td></tr>`;

    const sideProg = document.getElementById('side-lb-prog-body');
    const sidePvp = document.getElementById('side-lb-pvp-body');

    if (sideProg) sideProg.innerHTML = progRowsHtml;
    if (sidePvp) sidePvp.innerHTML = pvpRowsHtml;
    this.renderFullBoard(progPlayers, pvpPlayers);
  }

  setLbView(key, value) {
    if (key === 'board') this.lbBoard = value; else this.lbFilter = value;
    document.querySelectorAll('[data-lb-board]').forEach(b => b.classList.toggle('on', b.dataset.lbBoard === (this.lbBoard || 'prog')));
    document.querySelectorAll('[data-lb-filter]').forEach(b => b.classList.toggle('on', b.dataset.lbFilter === (this.lbFilter || 'all')));
    this.renderLeaderboards();
  }

  // Full Leaderboards page: podium, your position, one board at a time
  renderFullBoard(progPlayers, pvpPlayers) {
    const el = document.getElementById('lb-board');
    if (!el) return;
    const esc = (s) => this.escapeHtml(s);
    const board = this.lbBoard || 'prog', filter = this.lbFilter || 'all';
    const isOnline = (p) => p.isUser || (!!p.lastActiveAt && Date.now() - p.lastActiveAt <= 180000);
    const ranked = (board === 'prog' ? progPlayers : pvpPlayers).map((p, i) => ({ ...p, rank: i + 1 }));
    const me = ranked.find(p => p.isUser);
    const first = (p) => esc(String(p.name || 'Reviewee').split(' ')[0]);
    const primary = 'min-h-[44px] px-4 rounded-[10px] bg-emerald-600 hover:bg-emerald-700 text-on-accent text-sm font-semibold inline-flex items-center gap-2';
    const action = board === 'prog' ? `<button onclick="app.continueStudying()" class="${primary}">Continue studying</button>` : `<button onclick="app.openPvpLobby()" class="${primary}">Find a match</button>`;

    const others = (this.liveLeaderboard.allUsers || []).filter(u => !u.isOwner && u.id !== this.user.id);
    document.getElementById('lb-stat-total').textContent = (this.liveLeaderboard.totalReviewees || ranked.length).toLocaleString();
    document.getElementById('lb-stat-online').textContent = others.filter(isOnline).length + (this.user.loggedIn && !this.user.isOwner ? 1 : 0);
    document.getElementById('lb-stat-rank').textContent = me ? `#${me.rank}` : '—';

    if (!ranked.length) {
      el.innerHTML = `<div class="panel py-9 px-4 text-center"><svg class="ic !w-7 !h-7 text-slate-400" aria-hidden="true"><use href="#i-${board === 'prog' ? 'trophy' : 'swords'}"/></svg>
        <h2 class="font-serif !font-normal text-[24px] mt-2">${board === 'prog' ? 'No one on the board yet' : 'No PvP matches yet'}</h2>
        <p class="text-sm text-slate-400 mt-1 mb-4 mx-auto max-w-[38ch]">${board === 'prog' ? 'Master your first questions and you take the #1 spot.' : 'Finish one 1v1 match to put your name on the PvP board.'}</p>${action}</div>`;
      return;
    }

    const av = (p) => `<span class="lb-av ${p.isUser ? 'me' : ''}">${esc(String(p.name || '?')[0].toUpperCase())}</span>`;
    const metric = (p) => board === 'prog' ? [(p.totalMastered || 0).toLocaleString(), 'mastered'] : [`${p.pvpWins || 0}W – ${p.pvpLosses || 0}L`, `${(p.rp || 1200).toLocaleString()} RP`];
    let html = '';
    if (filter === 'all' && ranked.length >= 3) {
      html += `<div class="lb-podium">${[ranked[1], ranked[0], ranked[2]].map(p => `<div class="panel lb-pod p${p.rank}">${p.rank === 1 ? '<svg class="ic crown" aria-hidden="true"><use href="#i-crown"/></svg>' : ''}
          <div class="place">${['', '1ST', '2ND', '3RD'][p.rank]}</div>${av(p)}<div class="nm">${first(p)}</div><div class="big">${metric(p)[0]}</div><div class="text-[11.5px] text-slate-400">${metric(p)[1]}</div></div>`).join('')}</div>`;
    }
    if (me && filter === 'all') {
      const above = ranked[me.rank - 2];
      let gap = 'You are #1. Keep it.';
      if (above && board === 'prog') {
        const need = (above.totalMastered || 0) - (me.totalMastered || 0) + 1;
        gap = need > 0 ? `<b class="font-semibold">${need.toLocaleString()} more mastered</b> to pass ${first(above)} for #${above.rank}.` : `Earn more XP to pass ${first(above)} for #${above.rank}.`;
      } else if (above) {
        const need = Math.max(1, (above.pvpWins || 0) - (me.pvpWins || 0) + 1);
        gap = `<b class="font-semibold">${need} more win${need === 1 ? '' : 's'}</b> to pass ${first(above)} for #${above.rank}.`;
      }
      html += `<div class="panel lb-you"><span class="rk">#${me.rank}</span><div class="flex-1 min-w-[200px] text-sm"><div class="label-mono mb-0.5">Your position</div>${gap}</div>${action}</div>`;
    }
    const shown = filter === 'online' ? ranked.filter(isOnline) : ranked;
    const maxLv = [13, 13, 22], tint = ['inkblue-400', 'green-400', 'plum-400'];
    const rows = shown.map((p, i) => {
      const who = `<div class="lb-who">${av(p)}<div class="min-w-0"><div class="nm"><span>${esc(p.name || 'Reviewee')}${p.isUser ? ' <span class="font-normal text-slate-400">(you)</span>' : ''}</span>${this.renderTitleBadge(p).replace('ml-1 ', '')}</div><div class="flex">${this.renderLastSeen(p)}</div></div></div>`;
      const delay = `style="animation-delay:${Math.min(i, 20) * 30}ms"`;
      if (board === 'prog') {
        const lv = [p.a1Levels, p.a2Levels, p.a3Levels].map(v => v || 0);
        return `<div class="lb-row ${p.isUser ? 'me' : ''}" ${delay}><span class="lb-rn">${p.rank}</span>${who}
          <div class="lb-wide grid gap-1">${lv.map((v, k) => `<div class="lb-ar"><span>A${k + 1}</span><i><b style="width:${Math.min(100, v / maxLv[k] * 100)}%; background:rgb(var(--c-${tint[k]}))"></b></i><em>${v}</em></div>`).join('')}</div>
          <div class="lb-num">${(p.totalMastered || 0).toLocaleString()}</div><div class="lb-num">${(p.xp || 0).toLocaleString()}</div></div>`;
      }
      const w = p.pvpWins || 0, l = p.pvpLosses || 0, pct = w + l ? Math.round(w / (w + l) * 100) : 0;
      return `<div class="lb-row ${p.isUser ? 'me' : ''}" ${delay}><span class="lb-rn">${p.rank}</span>${who}
        <div><span class="lb-wl"><span class="text-emerald-300">${w}W</span> <span class="text-slate-400">–</span> <span class="text-rose-300">${l}L</span> <span class="lb-pct text-slate-400 text-[11px]">· ${pct}%</span></span><span class="lb-wlbar"><b style="width:${pct}%"></b></span></div>
        <div class="lb-num">${(p.rp || 1200).toLocaleString()}</div><div class="lb-num lb-best">${p.bestTimeSec ? Number(p.bestTimeSec).toFixed(1) + 's' : '—'}</div></div>`;
    }).join('');
    const head = board === 'prog'
      ? '<div class="lb-lhead"><span>#</span><span>Reviewee</span><span class="lb-wide">Levels by area</span><span class="text-right">Mastered</span><span class="text-right">XP</span></div>'
      : '<div class="lb-lhead"><span>#</span><span>Duelist</span><span>Record</span><span class="text-right">RP</span><span class="text-right lb-best">Best</span></div>';
    html += `<div class="panel lb-list ${board === 'prog' ? 'lb-prog' : 'lb-pvp'}">${head}${rows || '<p class="py-5 px-1 text-sm text-slate-400">No one else is online right now.</p>'}</div>`;
    el.innerHTML = html;
  }

  // ==================== QUESTION VAULT ====================
  // Status comes from progress already on this device, so filters cost no Supabase calls.
  vaultStatus(it) {
    const rec = this.user.srs[it.id];
    if (!rec) return 'new';
    if (rec.status === 'mastered') return 'mastered';
    if ((rec.misses || 0) > 0) return 'missed';
    return rec.status === 'learning' ? 'learning' : 'new';
  }

  setVaultFilter(key, value) {
    if (key === 'showAll') this.vaultShowAll = !this.vaultShowAll;
    else if (key === 'area') this.vaultArea = value;
    else this.vaultStatusF = value;
    document.querySelectorAll('[data-vault-area]').forEach(b => b.classList.toggle('on', b.dataset.vaultArea === (this.vaultArea || 'all')));
    document.querySelectorAll('[data-vault-status]').forEach(b => b.classList.toggle('on', b.dataset.vaultStatus === (this.vaultStatusF || 'all')));
    document.getElementById('vault-show-all')?.setAttribute('aria-pressed', !!this.vaultShowAll);
    this.renderVault(key === 'showAll');
  }

  vaultTry(btn) {
    document.getElementById('vault-search-input').value = btn.textContent;
    this.renderVault();
  }

  vaultToggle(id) {
    this.vaultOpen = this.vaultOpen || new Set();
    if (this.vaultOpen.has(id)) this.vaultOpen.delete(id); else this.vaultOpen.add(id);
    this.renderVault(true);
  }

  vaultMore() {
    this.vaultLimit = (this.vaultLimit || 40) + 40;
    this.renderVault(true);
  }

  // keepPlace: re-render the same results (reveal, show more) without resetting the page size
  renderVault(keepPlace = false) {
    const raw = (document.getElementById('vault-search-input').value || '').trim();
    const q = raw.toLowerCase();
    const areaF = this.vaultArea || 'all', statusF = this.vaultStatusF || 'all';
    const catF = document.getElementById('vault-filter-cat').value;
    if (!keepPlace) this.vaultLimit = 40;
    this.vaultOpen = this.vaultOpen || new Set();
    document.getElementById('vault-clear')?.classList.toggle('hidden', !raw);

    const all = this.allItemsFlat;
    document.getElementById('vault-stat-total').textContent = all.length.toLocaleString();
    document.getElementById('vault-stat-ps').textContent = all.filter(it => it.category === 'problem_solving').length.toLocaleString();
    document.getElementById('vault-stat-mastered').textContent = all.filter(it => this.user.srs[it.id]?.status === 'mastered').length.toLocaleString();

    const only = this.vaultIds; // set by the PAES Vault "Practice" button
    const filtered = all.filter(it => {
      if (only && !only.ids.has(it.id)) return false;
      if (areaF !== 'all' && String(it.area) !== areaF) return false;
      if (catF !== 'all' && it.category !== catF) return false;
      if (statusF !== 'all') {
        const st = this.vaultStatus(it);
        if (statusF === 'missed' ? !this.isMissed(this.user.srs[it.id]) : st !== statusF) return false;
      }
      return !q || `${it.id} ${it.question} ${it.answer} ${it.subtopic} ${it.rationale}`.toLowerCase().includes(q);
    });
    const limit = this.vaultLimit || 40;
    const slice = filtered.slice(0, limit);
    document.getElementById('vault-result-count').innerHTML = this.escapeHtml(`${filtered.length.toLocaleString()} question${filtered.length === 1 ? '' : 's'}${only ? ` citing ${only.label}` : ''}${raw ? ` matching "${raw}"` : ''}`)
      + (only ? ` <button onclick="app.vaultIds = null; app.renderVault()" class="paes-ed !ml-2 align-middle"><svg class="ic !w-3.5 !h-3.5" aria-hidden="true"><use href="#i-x"/></svg>Show all questions</button>` : '');

    const esc = (s) => this.escapeHtml(s || '');
    // Escape first, then mark matches (the search text is escaped the same way so it still lines up)
    const re = q ? new RegExp(`(${esc(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig') : null;
    const hl = (s) => re ? esc(s).replace(re, '<mark class="vault-mark">$1</mark>') : esc(s);
    const tint = { 1: 'inkblue-400', 2: 'green-400', 3: 'plum-400' };
    const stLabel = { new: ['New', 'var(--line-strong)'], learning: ['Learning', 'var(--gold)'], mastered: ['Mastered', 'var(--accent)'], missed: ['Missed', 'rgb(var(--c-rust-400))'] };
    const btn = 'min-h-[40px] px-3.5 rounded-[10px] border border-rule text-[13.5px] font-semibold inline-flex items-center justify-center gap-2';

    document.getElementById('vault-list').innerHTML = slice.map((it, i) => {
      const shown = this.vaultShowAll || this.vaultOpen.has(it.id);
      const [stT, stC] = stLabel[this.vaultStatus(it)];
      const level = it.category === 'problem_solving' ? 'Problem solving' : String(it.levelLabel || '').replace(/\s*\(.*\)$/, '');
      return `<article class="panel vault-card" style="animation-delay:${Math.min(i, 12) * 25}ms">
        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-slate-400">
          <span class="font-mono text-white">#${hl(it.id)}</span>
          <span class="vault-atag" style="color:rgb(var(--c-${tint[it.area]}))">AREA ${it.area}</span>
          ${it.category === 'problem_solving' ? '<span class="vault-ps">PROBLEM SOLVING</span>' : ''}
          <span>${esc(level)}${it.subtopic ? ' · ' + hl(it.subtopic) : ''}</span>
          <span class="ml-auto inline-flex items-center gap-1.5"><span class="vault-dot" style="background:${stC}"></span>${stT}</span>
        </div>
        <p class="font-serif text-[17px] sm:text-[18px] leading-[1.4] text-white mt-2.5 mb-3 whitespace-pre-line">${hl(it.question)}</p>
        ${it.images?.length ? (shown
          ? `<div class="flex flex-wrap gap-2 mb-3">${it.images.map(src => `<img src="${this.fixAssetPath(src)}" loading="lazy" decoding="async" alt="Figure for ${esc(it.id)}" class="max-h-48 rounded-lg bg-white p-1.5 border border-rule"/>`).join('')}</div>`
          : '<div class="vault-fig">Figure included · shows with the answer</div>') : ''}
        <div class="vault-ans">
          ${shown
            ? `<span class="vault-answer"><small>ANSWER</small>${hl(it.answer)}</span>${this.vaultShowAll ? '' : `<button onclick="app.vaultToggle('${esc(it.id)}')" class="${btn} !min-h-[34px] bg-paper">Hide</button>`}`
            : `<button onclick="app.vaultToggle('${esc(it.id)}')" class="${btn} bg-paper hover:border-emerald-500"><svg class="ic" aria-hidden="true"><use href="#i-eye"/></svg> Show answer</button>`}
          <button onclick="app.jumpFromVault(${it.area}, ${it.level}, '${esc(it.id)}')" class="${btn} vault-study hover:border-emerald-500"><svg class="ic" aria-hidden="true"><use href="#i-book-open"/></svg> Study this card</button>
          ${shown && it.rationale ? `<div class="vault-why">${hl(it.rationale)}</div>` : ''}
        </div>
      </article>`;
    }).join('') + (filtered.length > limit
      ? `<div class="grid place-items-center gap-1.5 pt-2 text-[12.5px] text-slate-400"><button onclick="app.vaultMore()" class="${btn} bg-surface hover:border-emerald-500">Show 40 more</button><span>Showing ${slice.length.toLocaleString()} of ${filtered.length.toLocaleString()}</span></div>`
      : '') || `
      <div class="panel py-9 px-4 text-center">
        <svg class="ic !w-7 !h-7 text-slate-400" aria-hidden="true"><use href="#i-search"/></svg>
        <h2 class="font-serif !font-normal text-[22px] mt-2">No questions match${raw ? ` "${esc(raw)}"` : ''}</h2>
        <p class="text-sm text-slate-400 mt-1 mb-4">Try a shorter keyword or a PAES number, or reset the filters.</p>
        <button onclick="app.resetVault()" class="${btn} bg-surface hover:border-emerald-500">Reset filters</button>
      </div>`;
  }

  resetVault() {
    this.vaultIds = null;
    document.getElementById('vault-search-input').value = '';
    document.getElementById('vault-filter-cat').value = 'all';
    this.vaultArea = 'all';
    this.setVaultFilter('status', 'all');
  }

  // Open the PAES Vault, optionally already searched or showing saved standards only
  openPaes(query = '', savedOnly = false) {
    this.showView('paes');
    document.getElementById('paes-search-input').value = query.trim();
    if (savedOnly !== !!this.paesOn?.saved) this.setPaesFilter('saved'); else this.renderPaes();
    window.scrollTo({ top: 0 });
  }

  // Dashboard highlight: same paes.json and device marks as the PAES Vault, no Supabase calls
  async renderHomePaes() {
    const box = document.getElementById('home-paes');
    if (!box) return;
    const all = await this.loadPaes();
    if (!all) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const esc = (s) => this.escapeHtml(s || '');
    const marks = this.paesMarks();
    const cur = all.filter(p => !p.old);
    const asked = cur.filter(p => p.q).sort((a, b) => b.q - a.q);
    const top = asked.slice(0, 3);
    // One standard to read per day, skipping ones already marked read
    const unread = asked.filter(p => !marks.read.has(p.id) && p.url);
    const pool = unread.length ? unread : asked.filter(p => p.url);
    const pick = pool[Math.floor(Date.now() / 86400000) % pool.length];
    const tile = document.getElementById('home-paes-count');
    if (tile) tile.textContent = `${cur.length.toLocaleString()} standards`;

    box.innerHTML = `
      <svg class="bg-ic" aria-hidden="true"><use href="#i-scroll-text"/></svg>
      <div class="relative">
        <div class="flex items-center gap-2"><span class="label-mono">PAES vault</span><span class="vault-ps">NEW</span></div>
        <h2 class="font-serif !font-normal text-[24px] sm:text-[30px] leading-tight mt-2.5 mb-1.5">Every PAES, one tap away</h2>
        <p class="text-[14.5px] text-slate-400 max-w-[46ch]">All agricultural engineering standards from 2000 to 2026, current edition first, with the official PDF. Know which ones the board exam asks, and practice them.</p>
        <div class="hp-figs">
          <div><b>${cur.length.toLocaleString()}</b><span>standards</span></div>
          <div><b class="text-emerald-300">${asked.length}</b><span>in our questions</span></div>
          ${marks.saved.size ? `<div><b style="color:var(--gold)">${marks.saved.size}</b><span>you've saved</span></div>` : ''}
        </div>
        <form class="hp-search" onsubmit="app.openPaes(this.q.value); return false;">
          <svg class="ic" aria-hidden="true"><use href="#i-search"/></svg>
          <input name="q" type="search" placeholder="Find a PAES: 419, thresher…" aria-label="Find a PAES" autocomplete="off" />
          <button type="submit" class="min-h-[38px] px-3.5 rounded-[9px] bg-emerald-600 hover:bg-emerald-700 text-on-accent text-[13.5px] font-semibold">Search</button>
        </form>
        <div class="hp-links">
          <button onclick="app.openPaes()"><svg class="ic" aria-hidden="true"><use href="#i-arrow-right"/></svg>Open PAES Vault</button>
          ${marks.saved.size ? `<button onclick="app.openPaes('', true)"><svg class="ic" aria-hidden="true"><use href="#i-bookmark"/></svg>Your saved standards</button>` : ''}
        </div>
      </div>
      <div class="relative min-w-0">
        <div class="hp-top">
          <div class="flex items-baseline justify-between gap-2.5"><span class="label-mono">Most asked in our questions</span><span class="font-mono text-xs text-slate-400">questions</span></div>
          ${top.map((p, i) => `
            <div class="hp-row">
              <span class="hp-rank">${i + 1}</span>
              <div class="min-w-0"><div class="font-mono text-xs text-slate-400">${esc(p.code)}</div><div class="font-serif text-[16px] leading-snug">${esc(p.t)}</div><div class="hp-bar"><i style="width:${Math.round(p.q / top[0].q * 100)}%; animation-delay:${i * 0.1}s"></i></div></div>
              <button onclick="app.paesPractice('${p.id}')" aria-label="Practice ${p.q} questions on ${esc(p.code)}" class="min-h-[36px] px-3 rounded-[10px] border border-rule bg-surface hover:border-emerald-500 text-[13px] font-semibold whitespace-nowrap">${p.q}<span class="hp-prac"> · Practice</span></button>
            </div>`).join('')}
        </div>
        ${pick ? `<div class="hp-today">
          <svg class="ic" style="color:var(--gold)" aria-hidden="true"><use href="#i-file-text"/></svg>
          <span class="min-w-0"><span class="text-slate-400">Read today:</span> <b class="font-semibold">${esc(pick.code.replace(/^PNS\/(BAFS\/)?/, ''))} ${esc(pick.t)}</b> <span class="text-slate-400">· ${pick.q} question${pick.q === 1 ? '' : 's'}</span></span>
          <a href="${esc(pick.url)}" target="_blank" rel="noopener" class="min-h-[34px] px-3 rounded-[10px] border border-rule bg-surface hover:border-emerald-500 text-[13px] font-semibold inline-flex items-center whitespace-nowrap">Open PDF</a>
        </div>` : ''}
      </div>`;
  }

  // ==================== PAES VAULT ====================
  // paes.json is built from the AMTEC (2000-2017) and BAFS (2017-2026) lists by site-tools/build_paes.py.
  // Saves and read marks stay on this device (localStorage), so this page makes no Supabase calls.
  async loadPaes() {
    if (this.paes) return this.paes;
    try {
      const res = await fetch('./paes.json?v=20261206c');
      if (!res.ok) throw new Error(res.status);
      this.paes = await res.json();
    } catch (e) {
      document.getElementById('paes-list').innerHTML = `
        <div class="panel py-9 px-4 text-center">
          <h2 class="font-serif !font-normal text-[22px]">Couldn't load the PAES list</h2>
          <p class="text-sm text-slate-400 mt-1 mb-4">Check your connection, then try again.</p>
          <button onclick="app.renderPaes()" class="min-h-[40px] px-3.5 rounded-[10px] border border-rule bg-surface text-[13.5px] font-semibold hover:border-emerald-500">Try again</button>
        </div>`;
      return null;
    }
    this.paesById = Object.fromEntries(this.paes.map(p => [p.id, p]));
    return this.paes;
  }

  paesMarks() {
    if (!this._paesMarks) {
      let m = {};
      try { m = JSON.parse(localStorage.getItem('bayaw-paes') || '{}'); } catch (e) { m = {}; }
      this._paesMarks = { saved: new Set(m.saved || []), read: new Set(m.read || []) };
    }
    return this._paesMarks;
  }

  paesMark(kind, id) {
    const m = this.paesMarks();
    if (m[kind].has(id)) m[kind].delete(id); else m[kind].add(id);
    try { localStorage.setItem('bayaw-paes', JSON.stringify({ saved: [...m.saved], read: [...m.read] })); } catch (e) { /* private mode: marks last until reload */ }
    this.renderPaes(true);
    this.renderHomePaes();
  }

  setPaesFilter(key, value) {
    if (key === 'topic') this.paesTopic = value;
    else if (key === 'sort') this.paesSort = value;
    else this.paesOn = { ...this.paesOn, [key]: !this.paesOn?.[key] };
    document.querySelectorAll('[data-paes-topic]').forEach(b => b.classList.toggle('on', b.dataset.paesTopic === (this.paesTopic || 'all')));
    ['asked', 'saved', 'old'].forEach(k => document.getElementById(`paes-${k}`)?.setAttribute('aria-pressed', !!this.paesOn?.[k]));
    this.renderPaes();
  }

  paesTry(btn) {
    document.getElementById('paes-search-input').value = btn.textContent;
    this.renderPaes();
  }

  paesMore() {
    this.paesLimit = (this.paesLimit || 40) + 40;
    this.renderPaes(true);
  }

  // Jump to another edition of the same standard
  paesGo(id) {
    const p = this.paesById?.[id];
    if (!p) return;
    if (p.old && !this.paesOn?.old) this.setPaesFilter('old');
    document.getElementById('paes-search-input').value = p.code;
    this.renderPaes();
    document.getElementById('paes-result-count')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Open the Question Vault on the questions that cite this standard
  paesPractice(id) {
    const p = this.paesById?.[id];
    if (!p?.qs) return;
    this.showView('vault');
    this.resetVault();
    this.vaultIds = { ids: new Set(p.qs), label: p.code };
    this.renderVault();
    window.scrollTo({ top: 0 });
  }

  resetPaes() {
    document.getElementById('paes-search-input').value = '';
    this.paesOn = {};
    this.setPaesFilter('topic', 'all');
  }

  async renderPaes(keepPlace = false) {
    const all = await this.loadPaes();
    if (!all) return;
    const raw = (document.getElementById('paes-search-input').value || '').trim();
    // "PAES 610", "pns/bafs 289" and "610" all search the number
    const q = raw.toLowerCase().replace(/^(pns\s*\/?\s*)?(bafs\s*\/?\s*)?paes[\s:]*/, '').trim();
    const on = this.paesOn || {}, topic = this.paesTopic || 'all', sort = this.paesSort || 'asked';
    const marks = this.paesMarks();
    if (!keepPlace) this.paesLimit = 40;
    document.getElementById('paes-clear')?.classList.toggle('hidden', !raw);

    const current = all.filter(p => !p.old);
    document.getElementById('paes-stat-total').textContent = current.length.toLocaleString();
    document.getElementById('paes-stat-asked').textContent = current.filter(p => p.q).length.toLocaleString();
    document.getElementById('paes-stat-saved').textContent = marks.saved.size.toLocaleString();

    const prevCodes = (p) => (p.prev || []).map(id => this.paesById[id]?.code || '').join(' ');
    const filtered = all.filter(p => {
      if (p.old && !on.old) return false;
      if (topic !== 'all' && p.topic !== topic) return false;
      if (on.asked && !p.q) return false;
      if (on.saved && !marks.saved.has(p.id)) return false;
      return !q || `${p.code} ${p.t} ${p.grp || ''} ${p.aka || ''} ${prevCodes(p)}`.toLowerCase().includes(q);
    });
    const byNum = (a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }) || a.yr - b.yr;
    filtered.sort(sort === 'num' ? byNum : sort === 'new' ? (a, b) => b.yr - a.yr || byNum(a, b) : (a, b) => b.q - a.q || byNum(a, b));
    const limit = this.paesLimit || 40;
    const slice = filtered.slice(0, limit);
    document.getElementById('paes-result-count').textContent = `${filtered.length.toLocaleString()} standard${filtered.length === 1 ? '' : 's'}${raw ? ` matching "${raw}"` : ''}`;

    const esc = (s) => this.escapeHtml(s || '');
    const re = q ? new RegExp(`(${esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig') : null;
    const hl = (s) => re ? esc(s).replace(re, '<mark class="vault-mark">$1</mark>') : esc(s);
    const tint = { mach: 'rgb(var(--c-inkblue-400))', post: 'var(--gold)', struct: 'rgb(var(--c-plum-400))', sw: 'rgb(var(--c-green-400))', other: 'var(--muted)' };
    const tname = { mach: 'MACHINERY', post: 'POSTHARVEST', struct: 'STRUCTURES', sw: 'SOIL &amp; WATER', other: 'GENERAL' };
    const btn = 'min-h-[40px] px-3.5 rounded-[10px] border border-rule text-[13.5px] font-semibold inline-flex items-center justify-center gap-2';
    const edBtn = (id, label) => `<button onclick="app.paesGo('${id}')" class="paes-ed">${hl(this.paesById[id]?.code || id)}${label ? ` <small>${label}</small>` : ''}</button>`;

    document.getElementById('paes-list').innerHTML = slice.map((p, i) => {
      const saved = marks.saved.has(p.id), read = marks.read.has(p.id);
      const eds = [
        p.aka ? `<span class="paes-ed paes-aka">${hl(p.aka)} <small>same standard, earlier number</small></span>` : '',
        p.by ? `Replaced by ${edBtn(p.by)}` : '',
        !p.by && p.prev?.length ? `Replaces ${p.prev.map(id => edBtn(id)).join('')}` : '',
        ...(p.files || []).map(([label, url]) => `<a class="paes-ed" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`),
      ].filter(Boolean).join('');
      return `<article class="panel vault-card" style="animation-delay:${Math.min(i, 12) * 25}ms">
        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-slate-400">
          <span class="font-mono text-[13px] text-white">${hl(p.code)}</span>
          ${p.old ? '<span class="paes-tag paes-old">OLDER EDITION</span>' : '<span class="paes-tag paes-cur">CURRENT</span>'}
          <span class="vault-atag" style="color:${tint[p.topic]}">${tname[p.topic]}</span>
          ${p.q >= 10 ? '<span class="vault-ps">MOST ASKED</span>' : ''}
        </div>
        <h3 class="font-serif !font-normal text-[18px] sm:text-[19px] leading-snug text-white mt-2 mb-1">${hl(p.t)}</h3>
        <p class="text-[13px] text-slate-400 mb-2.5">${p.grp ? esc(p.grp) + ' · ' : ''}${p.src === 'AMTEC' ? esc(p.vol) + ' · ' : ''}from ${p.src}</p>
        ${eds ? `<div class="flex flex-wrap items-center gap-1.5 text-[12.5px] text-slate-400 mb-3">${eds}</div>` : ''}
        <div class="vault-ans paes-actions">
          ${p.url
            ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="${btn} !border-transparent bg-emerald-600 hover:bg-emerald-700 text-on-accent"><svg class="ic" aria-hidden="true"><use href="#i-file-text"/></svg> Open PDF</a>`
            : '<span class="text-[13px] text-slate-400">PDF not available online</span>'}
          ${p.q
            ? `<button onclick="app.paesPractice('${p.id}')" class="${btn} bg-surface hover:border-emerald-500"><svg class="ic" aria-hidden="true"><use href="#i-book-open"/></svg> Practice ${p.q} question${p.q === 1 ? '' : 's'}</button>`
            : (p.old ? '' : '<span class="paes-qnone">Not in our questions yet</span>')}
          <span class="paes-spacer"></span>
          <button onclick="app.paesMark('read', '${p.id}')" aria-pressed="${read}" class="${btn} paes-read bg-surface hover:border-emerald-500"><svg class="ic" aria-hidden="true"><use href="#i-check"/></svg> ${read ? 'Read' : 'Mark read'}</button>
          <button onclick="app.paesMark('saved', '${p.id}')" aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved' : 'Save'}" class="${btn} paes-save !px-0 w-10 bg-surface hover:border-emerald-500"><svg class="ic" aria-hidden="true"><use href="#i-bookmark"/></svg></button>
        </div>
      </article>`;
    }).join('') + (filtered.length > limit
      ? `<div class="grid place-items-center gap-1.5 pt-2 text-[12.5px] text-slate-400"><button onclick="app.paesMore()" class="${btn} bg-surface hover:border-emerald-500">Show 40 more</button><span>Showing ${slice.length.toLocaleString()} of ${filtered.length.toLocaleString()}</span></div>`
      : '') || `
      <div class="panel py-9 px-4 text-center">
        <svg class="ic !w-7 !h-7 text-slate-400" aria-hidden="true"><use href="#i-search"/></svg>
        <h2 class="font-serif !font-normal text-[22px] mt-2">No standard matches${raw ? ` "${esc(raw)}"` : ''}</h2>
        <p class="text-sm text-slate-400 mt-1 mb-4">${on.saved && !marks.saved.size ? 'You haven\'t saved any standards yet. Tap the bookmark on one to keep it here.' : 'Try only the number, like 419, or a machine name.'}</p>
        <button onclick="app.resetPaes()" class="${btn} bg-surface hover:border-emerald-500">Reset filters</button>
      </div>`;
  }

  jumpFromVault(areaId, levelNum, itemId) {
    this.showView('dashboard');
    this.selectStudyLevel(areaId, levelNum);
    const idx = this.currentDeck.findIndex(x => x.id === itemId);
    if (idx >= 0) {
      this.currentCardIdx = idx;
      this.renderStudyCard();
    }
    this.scrollToStudySession();
  }

  // ==================== WEAK TOPICS ====================
  // A question counts as missed if it was ever answered wrong / rated Again or Hard, or is still being learned.
  isMissed(rec) {
    return !!rec && ((rec.misses || 0) > 0 || rec.status === 'learning');
  }

  getWeakTopics() {
    const topics = new Map();
    for (const it of this.allItemsFlat) {
      const rec = this.user.srs[it.id];
      if (!rec) continue;
      const name = /^\d\.0 /.test(it.subtopic || '') || !it.subtopic ? `${it.area}.0 Mixed practice problems` : it.subtopic;
      const t = topics.get(name) || { name, area: it.area, seen: 0, missed: [], open: 0 };
      t.seen++;
      if (this.isMissed(rec)) {
        t.missed.push(it);
        if (rec.status === 'learning') t.open++;
      }
      topics.set(name, t);
    }
    return [...topics.values()]
      .filter(t => t.seen >= 5 && t.missed.length > 0)
      .map(t => ({ ...t, rate: t.missed.length / t.seen }))
      .sort((a, b) => (b.rate - a.rate) || (b.missed.length - a.missed.length));
  }

  renderWeakTopics() {
    const box = document.getElementById('weak-topics-list');
    if (!box) return;
    const seenTotal = Object.keys(this.user.srs || {}).filter(k => !k.startsWith('_')).length;
    this.weakTopicsCache = this.getWeakTopics().slice(0, 10);
    const drillAll = document.getElementById('btn-drill-all-weak');
    if (drillAll) drillAll.classList.toggle('hidden', this.weakTopicsCache.length < 2);

    if (!this.weakTopicsCache.length) {
      box.innerHTML = `
        <div class="py-10 text-center space-y-2">
          <svg class="ic text-slate-400" style="width:28px;height:28px" aria-hidden="true"><use href="#i-target"/></svg>
          <div class="text-sm font-semibold text-white">${seenTotal < 5 ? 'Answer a few questions first' : 'No weak topics yet'}</div>
          <div class="text-sm text-slate-400 max-w-sm mx-auto">${seenTotal < 5
            ? 'Study or take a mock exam. Topics where you miss questions will show up here.'
            : 'You have not missed any questions in a topic you studied (5 or more questions). Keep going.'}</div>
        </div>`;
      return;
    }

    box.innerHTML = this.weakTopicsCache.map((t, i) => {
      const pct = Math.round(t.rate * 100);
      const tone = pct >= 50 ? 'bg-rose-500' : pct >= 25 ? 'bg-amber-500' : 'bg-emerald-500';
      return `
        <div class="py-3.5 border-b border-rule last:border-b-0 flex flex-col sm:flex-row sm:items-center gap-3">
          <div class="flex-1 min-w-0 space-y-1.5">
            <div class="flex items-baseline gap-2">
              <span class="label-mono shrink-0">Area ${t.area}</span>
              <span class="text-[15px] font-semibold text-white truncate" title="${this.escapeHtml(t.name)}">${this.escapeHtml(t.name)}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="flex-1 h-1.5 rounded-full bg-navy-950 overflow-hidden" role="img" aria-label="${pct}% missed">
                <div class="h-full rounded-full ${tone}" style="width:${Math.max(4, pct)}%"></div>
              </div>
              <span class="font-mono text-sm text-white w-11 text-right">${pct}%</span>
            </div>
            <div class="text-xs text-slate-400">Missed ${t.missed.length} of ${t.seen} answered${t.open ? ` · ${t.open} not mastered yet` : ''}</div>
          </div>
          <button onclick="app.drillWeakTopic(${i})" class="shrink-0 self-start sm:self-center min-h-[40px] px-4 rounded-[10px] border border-rule text-sm font-semibold text-white hover:border-emerald-500 hover:text-emerald-300 transition-colors">Drill ${t.missed.length}</button>
        </div>`;
    }).join('');
  }

  // index = one topic from the list; 'all' = the top 3 topics together
  drillWeakTopic(index) {
    const list = this.weakTopicsCache || this.getWeakTopics().slice(0, 10);
    const picked = index === 'all' ? list.slice(0, 3) : [list[index]].filter(Boolean);
    if (!picked.length) return;
    const score = (it) => { const r = this.user.srs[it.id] || {}; return (r.status === 'learning' ? 1000 : 0) + (r.misses || 0); };
    const deck = picked.flatMap(t => t.missed).sort((a, b) => score(b) - score(a)).slice(0, 60);

    this.problemSolvingOnly = false;
    this.drillLabel = index === 'all' ? 'Top 3 weak topics' : picked[0].name;
    this.activeStudyArea = deck[0].area;
    this.currentDeck = deck;
    this.currentCardIdx = 0;
    const strip = document.getElementById('prob-solving-strip');
    if (strip) strip.classList.add('hidden');
    this.showView('dashboard');
    this.renderLevelTiles();
    this.renderStudyCard();
    this.scrollToStudySession();
  }

  // Progress & Stats page: reads only the progress saved on this device (user.srs), no Supabase calls
  renderAllLevelsProgress() {
    const grid = document.getElementById('all-levels-progress-grid');
    if (!grid || !this.db) return;
    const fmt = (n) => n.toLocaleString();
    const w = (n, t) => (t ? (n / t * 100).toFixed(2) : 0) + '%';
    const d = this.dailyState();
    const curA = d.lastArea || 1, curL = d.lastLevel || 1;
    let M = 0, L = 0, T = 0, done = 0, levels = 0, cur = null;
    const bar = (m, l, t, cls) => `<span class="${cls}" aria-hidden="true"><i class="m" style="width:${w(m, t)}"></i><i class="l" style="width:${w(l, t)}"></i></span>`;

    const areasHtml = this.db.areas.map(area => {
      const n = this.getRegularTotalLevels(area.id);
      let am = 0, al = 0, at = 0, tiles = '';
      for (let lvl = 1; lvl <= n; lvl++) {
        const st = this.getLevelStats(area.id, lvl);
        am += st.mastered; al += st.learning; at += st.total; levels++;
        const isDone = st.total > 0 && st.mastered === st.total;
        if (isDone) done++;
        const isCur = area.id === curA && lvl === curL;
        if (isCur) cur = { area: area.id, lvl, st };
        const cls = isCur ? 'cur' : isDone ? 'done' : (st.mastered || st.learning) ? '' : 'new';
        const tag = isCur ? '<span class="pg-tag go">CONTINUE</span>' : isDone ? '<span class="pg-tag done">DONE</span>' : '';
        tiles += `<button onclick="app.showView('dashboard'); app.selectStudyLevel(${area.id}, ${lvl}); app.scrollToStudySession();" class="pg-lv ${cls}" aria-label="Area ${area.id} level ${lvl}, ${st.mastered} of ${st.total} mastered">
          <span class="pg-lv-top"><span class="pg-lv-name">Level ${lvl}</span>${tag}</span>
          ${bar(st.mastered, st.learning, st.total, 'pg-lv-bar')}
          <span class="pg-lv-num"><b>${st.mastered}</b> / ${st.total}${st.total < 100 ? ` <small>card${st.total === 1 ? '' : 's'}</small>` : ''}</span>
        </button>`;
      }
      const ps = this.getPsStats(area.id);
      if (ps.total > 0) {
        am += ps.mastered; al += ps.learning; at += ps.total; levels++;
        if (ps.mastered === ps.total) done++;
        tiles += `<button onclick="app.openProblemSolvingMode(${area.id});" class="pg-lv ps ${ps.mastered || ps.learning ? '' : 'new'}" aria-label="Area ${area.id} problem solving, ${ps.mastered} of ${ps.total} mastered">
          <span class="pg-lv-top"><span class="pg-lv-name"><svg class="ic" aria-hidden="true"><use href="#i-calculator"/></svg>Problems</span>${ps.mastered === ps.total ? '<span class="pg-tag done">DONE</span>' : ''}</span>
          ${bar(ps.mastered, ps.learning, ps.total, 'pg-lv-bar')}
          <span class="pg-lv-num"><b>${ps.mastered}</b> / ${ps.total}</span>
        </button>`;
      }
      M += am; L += al; T += at;
      return `<section class="panel pg-area" aria-label="Area ${area.id}">
        <div class="pg-area-hd">
          <div class="min-w-0"><div class="label-mono">Area ${area.id} · ${n} levels${ps.total ? ' + problems' : ''}</div><h2 class="font-serif !font-normal text-[19px] sm:text-[23px] leading-tight mt-1">${this.escapeHtml(area.name || '')}</h2></div>
          <div class="pg-pct">${Math.floor(at ? am / at * 100 : 0)}<small>%</small></div>
          <div class="pg-sub"><span class="font-mono">${fmt(am)}</span> of <span class="font-mono">${fmt(at)}</span> mastered · <span class="font-mono">${fmt(al)}</span> learning</div>
        </div>
        ${bar(am, al, at, 'pg-stack thin')}
        <div class="pg-levels">${tiles}</div>
      </section>`;
    }).join('');

    const alive = d.lastHit === this.localDay() || d.lastHit === this.localDay(-1);
    const streak = alive ? (d.streak || 0) : 0;
    document.getElementById('pg-stats').innerHTML = `
      <div class="lb-stat"><b style="color:var(--accent-ink)">${fmt(M)}</b><span>mastered <small class="font-mono">· ${Math.floor(T ? M / T * 100 : 0)}%</small></span></div>
      <div class="lb-stat"><b style="color:var(--pg-learn)">${fmt(L)}</b><span>learning</span></div>
      <div class="lb-stat"><b>${done}<small class="text-slate-400 text-[13px]"> / ${levels}</small></b><span>levels complete</span></div>
      <div class="lb-stat"><b style="color:var(--gold)">${streak}</b><span>day streak · ${d.count} / ${d.goal} today</span></div>`;
    document.getElementById('pg-all').innerHTML = bar(M, L, T, 'pg-stack');
    document.getElementById('pg-intro').textContent = `All ${levels} levels across the three areas, ${fmt(T)} questions in all. Tap a level to study it. A card counts as mastered once you get it right on review.`;
    document.getElementById('pg-next').innerHTML = cur ? `
      <svg class="ic" style="color:var(--gold)" aria-hidden="true"><use href="#i-arrow-right"/></svg>
      <span class="min-w-0"><span class="text-slate-400">Pick up where you left off:</span> <b class="font-semibold">Area ${cur.area} · Level ${cur.lvl}</b> <span class="text-slate-400 font-mono text-[13px]">${cur.st.mastered} / ${cur.st.total} mastered</span></span>
      <button onclick="app.continueStudying()" class="inline-flex items-center justify-center gap-2 px-4 min-h-[42px] rounded-[10px] bg-emerald-600 hover:bg-emerald-700 text-on-accent text-sm font-semibold whitespace-nowrap"><svg class="ic" aria-hidden="true"><use href="#i-play"/></svg>Continue</button>` : '';
    grid.innerHTML = areasHtml;
  }

  // ==================== GLOBAL CHAT & FEEDBACK / SUGGESTIONS ====================
  isChatOnScreen() {
    return ['global-chat-messages', 'mobile-chat-messages'].some(id => document.getElementById(id)?.offsetParent);
  }

  // full = reload the last 50; otherwise only ask for messages newer than the ones already shown
  async loadGlobalChat(full = false) {
    const box = document.getElementById('global-chat-messages');
    if (!box) return;
    const have = full ? [] : (this.chatMessages || []);
    const since = have.length ? have[have.length - 1].createdAt : 0;
    try {
      const res = await this.apiCall('POST', { action: 'chat_list', since });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.messages)) return;
      if (since && data.messages.length === 0) return;
      this.chatMessages = [...have, ...data.messages].slice(-50);
      this.renderGlobalChat(this.chatMessages);
    } catch (e) {}
  }

  // ==================== STUDY GROUP ====================
  // Group data rides along with the leaderboard fetch; only create / join / leave / remove write to Supabase.
  groupLevel(xp) {
    const steps = [0, 2000, 5000, 12000, 25000, 35000, 45000, 60000, 80000, 100000];
    let lv = 1;
    while (lv < 10 && xp >= steps[lv]) lv++;
    const stages = ['Seed', 'Sprout', 'Sapling', 'Bloom', 'Harvest'];
    const stageIdx = lv <= 2 ? 0 : lv === 3 ? 1 : lv === 4 ? 2 : lv <= 7 ? 3 : 4;
    const next = lv < 10 ? steps[lv] : null;
    const pct = next ? Math.min(100, (xp - steps[lv - 1]) / (next - steps[lv - 1]) * 100) : 100;
    return { lv, stage: stages[stageIdx], stageIdx, stages, next, pct };
  }

  groupData() {
    const now = Date.now();
    const groups = new Map();
    for (const u of this.liveLeaderboard?.allUsers || []) {
      if (!u.group) continue;
      let g = groups.get(u.group.id);
      if (!g) groups.set(u.group.id, g = { ...u.group, members: [], xp: 0, online: 0 });
      const isMe = u.id === this.user.id;
      const xp = isMe ? (this.user.xp || 0) : (u.xp || 0);
      const online = isMe || (!!u.lastActiveAt && now - u.lastActiveAt <= 180000);
      g.members.push({ ...u, xp, online, isMe });
      g.xp += xp;
      if (online) g.online++;
    }
    const list = [...groups.values()].sort((a, b) => b.xp - a.xp);
    list.forEach(g => g.members.sort((a, b) => b.xp - a.xp));
    return { list, mine: list.find(g => g.members.some(m => m.isMe)) || null };
  }

  schoolRanks(list) {
    const m = new Map();
    for (const g of list) {
      if (!g.school) continue;
      const k = g.school.toLowerCase();
      const s = m.get(k) || { name: g.school, xp: 0, groups: 0, members: 0 };
      s.xp += g.xp; s.groups++; s.members += g.members.length;
      m.set(k, s);
    }
    return [...m.values()].sort((a, b) => b.xp - a.xp);
  }

  currentStreak() {
    const d = this.dailyState();
    return (d.lastHit === this.localDay() || d.lastHit === this.localDay(-1)) ? (d.streak || 0) : 0;
  }

  renderGroupCard() {
    const el = document.getElementById('home-group');
    if (!el) return;
    const esc = (s) => this.escapeHtml(s);
    const { mine } = this.groupData();
    const btn = 'min-h-[44px] px-4 rounded-[10px] text-sm font-semibold inline-flex items-center gap-2';
    if (mine) {
      const L = this.groupLevel(mine.xp);
      el.innerHTML = `<div class="flex flex-wrap items-center gap-4">
        <div class="group-crest">${esc(mine.name[0].toUpperCase())}</div>
        <div class="flex-1 min-w-[180px]">
          <div class="label-mono">Study group</div>
          <div class="font-serif text-[19px] mt-0.5 truncate">${esc(mine.name)}</div>
          <div class="flex justify-between gap-2 text-xs text-slate-400 mt-2"><span>Lv ${L.lv} · ${L.stage}</span><span class="font-mono">${mine.xp.toLocaleString()} XP</span></div>
          <div class="home-bar mt-1.5"><b style="width:${L.pct.toFixed(1)}%; background:var(--accent)"></b></div>
        </div>
        <div class="text-sm flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-emerald-400"></span><span class="font-mono">${mine.online}</span><span class="text-slate-400">of ${mine.members.length} online</span></div>
        <button onclick="app.showView('groups')" class="${btn} border border-rule hover:border-emerald-500">View group <svg class="ic" aria-hidden="true"><use href="#i-arrow-right"/></svg></button>
      </div>`;
      return;
    }
    const streak = this.currentStreak();
    const unlocked = streak >= 7 || this.user.isOwner;
    el.innerHTML = `<div class="flex flex-wrap items-center gap-4">
      <div class="group-crest"><svg class="ic" aria-hidden="true"><use href="#i-users"/></svg></div>
      <div class="flex-1 min-w-[200px]">
        <div class="label-mono">Study group</div>
        <div class="font-serif text-[19px] mt-0.5">Review with your groupmates</div>
        <p class="text-[13px] text-slate-400 mt-1">Every member's XP levels up the group. ${unlocked ? 'You can start a group.' : `Start your own at a 7-day streak (<span class="font-mono text-amber-300">${Math.min(streak, 7)} / 7</span>).`}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button onclick="app.setGroupTab('mine'); app.showView('groups')" class="${btn} bg-emerald-600 hover:bg-emerald-700 text-on-accent">Join with code</button>
        <button onclick="app.setGroupTab('mine'); app.showView('groups')" class="${btn} border border-rule ${unlocked ? 'hover:border-emerald-500' : 'text-slate-400'}">${unlocked ? '' : '<svg class="ic" aria-hidden="true"><use href="#i-lock"/></svg> '}Create</button>
      </div>
    </div>`;
  }

  setGroupTab(tab) {
    this.groupTab = tab;
    this.renderGroupView();
  }

  renderGroupView() {
    const root = document.getElementById('group-body');
    if (!root) return;
    const tab = this.groupTab || 'mine';
    document.querySelectorAll('.group-tab').forEach(b => b.classList.toggle('on', b.dataset.gtab === tab));
    const esc = (s) => this.escapeHtml(s);
    const { list, mine } = this.groupData();
    const btn = 'min-h-[44px] px-4 rounded-[10px] text-sm font-semibold inline-flex items-center justify-center gap-2';

    if (!this.user.loggedIn) {
      root.innerHTML = `<div class="panel p-6 text-center space-y-3"><h1 class="font-serif !font-normal text-[26px]">Study groups</h1><p class="text-sm text-slate-400">Sign in to join or start a study group.</p><button onclick="app.openAuthModal('login')" class="${btn} bg-emerald-600 hover:bg-emerald-700 text-on-accent">Sign in</button></div>`;
      return;
    }

    if (tab === 'rank') {
      const mode = this.groupRankMode || 'groups';
      const rows = mode === 'groups'
        ? list.map((g, i) => {
            const L = this.groupLevel(g.xp);
            const del = this.user.isOwner ? `<button onclick="app.deleteGroup('${esc(g.id)}')" class="text-xs text-rose-300/80 hover:text-rose-300 px-2 min-h-[36px]">Delete</button>` : '';
            return `<div class="flex items-center gap-3 py-3 ${mine && g.id === mine.id ? 'text-emerald-300' : ''}">
              <span class="font-mono w-7 text-slate-400">${i + 1}</span>
              <div class="flex-1 min-w-0"><div class="font-semibold truncate">${esc(g.name)}</div><div class="text-xs text-slate-400 truncate">Lv ${L.lv} ${L.stage} · ${g.members.length} member${g.members.length === 1 ? '' : 's'}${g.school ? ' · ' + esc(g.school) : ''}</div></div>
              <span class="font-mono text-sm">${g.xp.toLocaleString()}</span>${del}
            </div>`;
          })
        : this.schoolRanks(list).map((s, i) => `<div class="flex items-center gap-3 py-3">
              <span class="font-mono w-7 text-slate-400">${i + 1}</span>
              <div class="flex-1 min-w-0"><div class="font-semibold truncate">${esc(s.name)}</div><div class="text-xs text-slate-400">${s.groups} group${s.groups === 1 ? '' : 's'} · ${s.members} member${s.members === 1 ? '' : 's'}</div></div>
              <span class="font-mono text-sm">${s.xp.toLocaleString()}</span>
            </div>`);
      root.innerHTML = `<div class="panel p-5 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div><div class="label-mono">Rankings by total XP</div><h1 class="font-serif !font-normal text-[26px] mt-1">${mode === 'groups' ? 'Top study groups' : 'Top schools'}</h1></div>
          <div class="flex gap-2"><button onclick="app.groupRankMode='groups'; app.renderGroupView()" class="group-tab ${mode === 'groups' ? 'on' : ''}">Groups</button><button onclick="app.groupRankMode='schools'; app.renderGroupView()" class="group-tab ${mode === 'schools' ? 'on' : ''}">Schools</button></div>
        </div>
        <div class="divide-y divide-[color:var(--line)] border-t border-rule">${rows.join('') || `<p class="py-6 text-sm text-slate-400">No ${mode === 'groups' ? 'study groups' : 'schools'} yet. Be the first.</p>`}</div>
        <p class="text-xs text-slate-400">School ranking adds up every group that set the same school. Groups without a school still appear in group rankings.</p>
      </div>`;
      return;
    }

    if (!mine) {
      const streak = this.currentStreak();
      const unlocked = streak >= 7 || this.user.isOwner;
      const lockAttr = unlocked ? '' : 'disabled';
      root.innerHTML = `<div class="grid gap-4 md:grid-cols-2">
        <div class="panel p-5">
          <div class="label-mono">Join a group</div>
          <h2 class="font-serif !font-normal text-[26px] mt-1.5">Got an invite code?</h2>
          <p class="text-sm text-slate-400 mt-1">Ask your groupmate for the code and review together. Anyone can join, up to 20 per group.</p>
          <label class="block text-sm mt-4">Invite code<input id="group-join-code" class="group-input font-mono uppercase tracking-[.15em]" maxlength="6" autocomplete="off" placeholder="XXXXXX" onkeydown="if(event.key==='Enter') app.joinGroup()" /></label>
          <button onclick="app.joinGroup()" class="${btn} mt-4 w-full bg-emerald-600 hover:bg-emerald-700 text-on-accent">Join group</button>
        </div>
        <div class="panel p-5">
          <div class="label-mono">Create a group</div>
          <h2 class="font-serif !font-normal text-[26px] mt-1.5">Start your own study group</h2>
          <p class="text-sm text-slate-400 mt-1">Leaders are consistent reviewers. Keep a <b class="text-white">7-day streak</b> to unlock this.</p>
          <div class="text-[13px] mt-3"><span class="font-mono text-amber-300">${Math.min(streak, 7)} / 7</span> <span class="text-slate-400">${unlocked ? 'Unlocked.' : `days. Hit your daily goal ${7 - streak} more day${7 - streak === 1 ? '' : 's'} in a row.`}</span></div>
          <label class="block text-sm mt-4">Group name<input id="group-new-name" class="group-input" maxlength="30" placeholder="e.g. Agri Engineers 2027" ${lockAttr} /></label>
          <label class="block text-sm mt-3">School <span class="text-slate-400">(optional)</span><input id="group-new-school" class="group-input" maxlength="60" placeholder="e.g. CSU Sanchez Mira" ${lockAttr} /></label>
          <button onclick="app.createGroup()" class="${btn} mt-4 w-full ${unlocked ? 'bg-emerald-600 hover:bg-emerald-700 text-on-accent' : 'border border-rule text-slate-400 cursor-not-allowed'}" ${lockAttr}>${unlocked ? 'Create group' : '<svg class="ic" aria-hidden="true"><use href="#i-lock"/></svg> Unlocks at a 7-day streak'}</button>
        </div>
      </div>`;
      return;
    }

    const L = this.groupLevel(mine.xp);
    const amLeader = mine.leaderId === this.user.id;
    const rank = list.indexOf(mine) + 1;
    const schoolList = this.schoolRanks(list);
    const schoolRank = mine.school ? schoolList.findIndex(s => s.name.toLowerCase() === mine.school.toLowerCase()) + 1 : 0;
    if (this.groupCodeFor !== mine.id) { this.groupCode = null; this.groupCodeFor = mine.id; }
    const code = this.groupCode
      ? `<span class="group-code">${esc(this.groupCode)}</span><button onclick="app.copyGroupCode(this)" class="${btn} border border-rule hover:border-emerald-500"><svg class="ic" aria-hidden="true"><use href="#i-copy"/></svg> Copy</button>`
      : `<button onclick="app.showGroupCode()" class="${btn} border border-rule hover:border-emerald-500">Show invite code</button>`;
    const members = mine.members.map(m => `<div class="flex items-center gap-3 py-2.5">
        <div class="relative w-9 h-9 rounded-full grid place-items-center bg-[color:var(--accent-soft)] text-emerald-300 font-semibold shrink-0">${esc((m.name || '?')[0].toUpperCase())}${m.online ? '<span class="absolute -right-0.5 -bottom-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-[color:var(--surface)]"></span>' : ''}</div>
        <div class="flex-1 min-w-0 flex flex-wrap items-center gap-x-1.5"><span class="font-semibold truncate">${esc(m.name || 'Reviewee')}${m.isMe ? ' <span class="text-slate-400 font-normal">(you)</span>' : ''}</span>${m.id === mine.leaderId ? '<span class="text-amber-300 text-xs inline-flex items-center gap-1"><svg class="ic" aria-hidden="true"><use href="#i-crown"/></svg>Leader</span>' : ''}${this.renderLastSeen({ isUser: m.isMe, lastActiveAt: m.lastActiveAt })}</div>
        <span class="font-mono text-sm">${m.xp.toLocaleString()}</span>
        ${amLeader && !m.isMe ? `<button onclick="app.kickMember('${esc(m.id)}')" aria-label="Remove ${esc(m.name || 'member')}" class="w-9 h-9 rounded-lg text-slate-400 hover:text-rose-300 grid place-items-center"><svg class="ic" aria-hidden="true"><use href="#i-x"/></svg></button>` : ''}
      </div>`).join('');
    root.innerHTML = `<div class="panel p-5 sm:p-6 grid gap-6 lg:grid-cols-[1.3fr_1fr] lg:items-end">
        <div class="min-w-0">
          <div class="label-mono">Study group</div>
          <div class="flex items-center gap-3.5 mt-2.5">
            <div class="group-crest">${esc(mine.name[0].toUpperCase())}</div>
            <div class="min-w-0">
              <h1 class="font-serif !font-normal text-[26px] sm:text-[34px] leading-tight break-words">${esc(mine.name)}</h1>
              <div class="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-slate-400 mt-1">${mine.school ? `<span>${esc(mine.school)}</span>` : ''}<span class="inline-flex items-center gap-1"><svg class="ic" aria-hidden="true"><use href="#i-users"/></svg>${mine.members.length} / 20 members</span></div>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-3 mt-5"><span class="label-mono">Invite code</span>${code}</div>
        </div>
        <div>
          <div class="label-mono">Group level</div>
          <div class="flex items-baseline gap-2.5 mt-2"><b class="font-mono text-[28px] font-normal">Lv ${L.lv}</b><span class="font-serif text-[22px]">${L.stage}</span></div>
          <div class="flex justify-between gap-2 text-[13px] text-slate-400 mt-3 mb-1.5"><span><b class="font-mono font-normal text-white">${mine.xp.toLocaleString()}</b> group XP</span><span>${L.next ? `${(L.next - mine.xp).toLocaleString()} to Lv ${L.lv + 1}` : 'Max level'}</span></div>
          <div class="home-bar"><b style="width:${L.pct.toFixed(1)}%; background:var(--accent)"></b></div>
          <div class="group-stages">${L.stages.map((s, i) => `<span class="${i <= L.stageIdx ? 'on' : ''}">${s.toUpperCase()}</span>`).join('')}</div>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div class="panel p-4"><b class="block font-mono text-[24px] font-normal text-emerald-400">${mine.online}</b><span class="text-xs text-slate-400">online now</span></div>
        <div class="panel p-4"><b class="block font-mono text-[24px] font-normal">#${rank}</b><span class="text-xs text-slate-400">of ${list.length} group${list.length === 1 ? '' : 's'}</span></div>
        <div class="panel p-4"><b class="block font-mono text-[24px] font-normal">${schoolRank ? '#' + schoolRank : '—'}</b><span class="text-xs text-slate-400">${schoolRank ? `of ${schoolList.length} school${schoolList.length === 1 ? '' : 's'}` : 'no school set'}</span></div>
      </div>
      <div class="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <div class="panel p-5">
          <div class="flex justify-between items-center"><span class="label-mono">Members</span><span class="text-xs text-slate-400">sorted by XP</span></div>
          <div class="divide-y divide-[color:var(--line)] mt-1">${members}</div>
        </div>
        <div class="space-y-4">
          <div class="panel p-5"><div class="label-mono">How group XP works</div><p class="text-sm text-slate-400 mt-2">Every member's XP adds to the group. Study together, level up together, and climb the group and school rankings. When a groupmate starts reviewing, you get a heads-up.</p></div>
          <div class="panel p-5"><div class="label-mono">Levels</div><div class="grid gap-2 mt-2.5 text-[13.5px]">
            ${[['Lv 1–2 · Seed', '0 XP', 0], ['Lv 3 · Sprout', '5,000', 1], ['Lv 4 · Sapling', '12,000', 2], ['Lv 5–7 · Bloom', '25,000', 3], ['Lv 8–10 · Harvest', '60,000', 4]].map(([a, b, i]) => `<div class="flex justify-between ${i === L.stageIdx ? 'text-emerald-300 font-semibold' : ''}"><span>${a}</span><span class="font-mono ${i === L.stageIdx ? '' : 'text-slate-400'}">${b}</span></div>`).join('')}
          </div></div>
          <button onclick="app.leaveGroup()" class="${btn} border border-rule text-slate-400 hover:text-rose-300">Leave group</button>
        </div>
      </div>`;
  }

  async groupPost(body) {
    if (!this.user.loggedIn) { this.openAuthModal('login'); return null; }
    try {
      const res = await this.apiCall('POST', body);
      const data = await res.json();
      if (!res.ok || data?.ok === false) { alert(data?.error || 'Something went wrong. Please try again.'); return null; }
      return data;
    } catch (e) {
      alert('Could not reach the server. Check your connection and try again.');
      return null;
    }
  }

  async groupChanged() {
    await this.fetchLiveLeaderboard();
    this.renderGroupView();
    this.renderGroupCard();
  }

  async joinGroup() {
    const code = (document.getElementById('group-join-code')?.value || '').trim().toUpperCase();
    if (!code) return;
    if (await this.groupPost({ action: 'group_join', code })) { this.groupTab = 'mine'; await this.groupChanged(); }
  }

  async createGroup() {
    const name = (document.getElementById('group-new-name')?.value || '').trim();
    const school = (document.getElementById('group-new-school')?.value || '').trim();
    if (name.length < 3) { alert('Group name must be 3 to 30 characters.'); return; }
    // The server checks the streak from saved progress, so save first
    clearTimeout(this.syncDebounceTimer);
    await this.syncUserToLeaderboard();
    const d = await this.groupPost({ action: 'group_create', name, school });
    if (d) { this.groupCode = d.code; this.groupCodeFor = d.groupId; await this.groupChanged(); }
  }

  async leaveGroup() {
    if (!confirm('Leave your study group? You can join again with an invite code.')) return;
    if (await this.groupPost({ action: 'group_leave' })) await this.groupChanged();
  }

  async kickMember(id) {
    const m = this.groupData().mine?.members.find(x => x.id === id);
    if (!m || !confirm(`Remove ${m.name || 'this member'} from the group?`)) return;
    if (await this.groupPost({ action: 'group_kick', memberId: id })) await this.groupChanged();
  }

  async deleteGroup(id) {
    const g = this.groupData().list.find(x => x.id === id);
    if (!g || !confirm(`Delete the study group "${g.name}"? Its ${g.members.length} member(s) will be removed from it.`)) return;
    if (await this.groupPost({ action: 'group_delete', groupId: id })) await this.groupChanged();
  }

  async showGroupCode() {
    const d = await this.groupPost({ action: 'group_code' });
    if (d) { this.groupCode = d.code; this.renderGroupView(); }
  }

  copyGroupCode(btn) {
    navigator.clipboard?.writeText(this.groupCode || '');
    if (btn) { btn.lastChild.textContent = ' Copied'; setTimeout(() => { btn.lastChild.textContent = ' Copy'; }, 1500); }
  }

  // Called after each leaderboard refresh: pops up when a groupmate went from offline to online
  checkGroupmatesOnline() {
    const { mine } = this.groupData();
    const now = new Set(mine ? mine.members.filter(m => m.online && !m.isMe).map(m => m.id) : []);
    const prev = this.groupOnlineIds;
    if (prev && mine && prev.gid === mine.id) {
      const fresh = mine.members.filter(m => !m.isMe && now.has(m.id) && !prev.has(m.id));
      if (fresh.length) this.showGroupToast(fresh.map(m => m.name || 'A groupmate'));
    }
    now.gid = mine?.id;
    this.groupOnlineIds = now;
  }

  showGroupToast(names) {
    document.getElementById('group-toast')?.remove();
    const esc = (s) => this.escapeHtml(s);
    const title = names.length > 1 ? `${names[0]} and ${names.length - 1} more are online` : `${names[0]} is online`;
    const el = document.createElement('div');
    el.id = 'group-toast';
    el.className = 'group-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `<div class="relative w-10 h-10 rounded-full grid place-items-center bg-[color:var(--accent-soft)] text-emerald-300 font-semibold shrink-0">${esc(names[0][0].toUpperCase())}<span class="absolute -right-0.5 -bottom-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-[color:var(--surface)]"></span></div>
      <button onclick="this.parentElement.remove(); app.showView('groups')" class="flex-1 min-w-0 text-left"><b class="block text-sm truncate">${esc(title)}</b><span class="text-xs text-slate-400">Your study groupmate${names.length > 1 ? 's' : ''} just started reviewing</span></button>
      <button onclick="this.parentElement.remove()" aria-label="Dismiss" class="w-10 h-10 rounded-lg text-slate-400 hover:text-white grid place-items-center shrink-0"><svg class="ic" aria-hidden="true"><use href="#i-x"/></svg></button>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }

  openMoreSheet() {
    document.getElementById('more-sheet')?.classList.remove('hidden');
  }

  closeMoreSheet() {
    document.getElementById('more-sheet')?.classList.add('hidden');
  }

  openMobileChat() {
    const modal = document.getElementById('mobile-chat-modal');
    if (modal) modal.classList.remove('hidden');
    this.loadGlobalChat();
    setTimeout(() => {
      const box = document.getElementById('mobile-chat-messages');
      if (box) box.scrollTop = box.scrollHeight;
    }, 100);
  }

  closeMobileChat() {
    const modal = document.getElementById('mobile-chat-modal');
    if (modal) modal.classList.add('hidden');
  }

  renderGlobalChat(messages) {
    const boxes = [
      document.getElementById('global-chat-messages'),
      document.getElementById('mobile-chat-messages')
    ].filter(Boolean);
    if (boxes.length === 0) return;

    const html = (!messages || messages.length === 0)
      ? `<div class="text-slate-500 text-xs text-center py-6">No messages yet. Say hi! <svg class="ic" aria-hidden="true"><use href="#i-hand"/></svg></div>`
      : messages.map(m => {
        const badge = m.isOwner
          ? `<span class="px-1 py-0.2 rounded bg-amber-400 text-on-accent font-black text-xs">OWNER</span>`
          : (m.title ? `<span class="px-1 rounded bg-sky-500/20 text-sky-300 font-bold text-xs">${this.escapeHtml(m.title)}</span>` : '');
        return `
          <div class="bg-navy-950/75 border border-blue-900/35 rounded-lg px-2.5 py-1.5 leading-snug">
            <div class="flex items-center gap-1 flex-wrap">
              <span class="font-bold ${m.isOwner ? 'text-amber-300' : 'text-emerald-300'} text-xs">${this.escapeHtml(m.name)}</span>
              ${badge}
            </div>
            <div class="text-slate-200 text-xs break-words mt-0.5">${this.escapeHtml(m.text)}</div>
          </div>
        `;
      }).join('');

    boxes.forEach(box => {
      const wasNearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 50;
      box.innerHTML = html;
      if (wasNearBottom) box.scrollTop = box.scrollHeight;
    });
  }

  async sendGlobalChat(source = 'desktop') {
    const inp = document.getElementById(source === 'mobile' ? 'mobile-chat-input' : 'global-chat-input');
    if (!inp) return;
    const text = (inp.value || '').trim();
    if (!text) return;
    if (!this.user.loggedIn || !this.user.name) {
      alert('Please sign in first to chat.');
      return;
    }
    inp.value = '';
    try {
      const res = await this.apiCall('POST', { action: 'chat_send', id: this.user.id, name: this.user.name, text });
      const data = await res.json();
      if (res.ok && Array.isArray(data.messages)) {
        this.chatMessages = data.messages;
        this.renderGlobalChat(data.messages);
        ['global-chat-messages', 'mobile-chat-messages'].forEach(id => {
          const b = document.getElementById(id);
          if (b) b.scrollTop = b.scrollHeight;
        });
      }
    } catch (e) {}
  }

  async adminClearChat() {
    if (!await this.owAsk({ title: 'Clear global chat?', body: 'Deletes every chat message for everyone. This cannot be undone.', ok: 'Clear chat', danger: true })) return;
    await this.apiCall('POST', { action: 'admin_clear_chat' });
    await this.loadGlobalChat(true);
    this.owToast('Global chat cleared');
  }

  reportCurrentQuestion(source = 'study') {
    const card = source === 'pvp'
      ? (this.pvpPlayerQueue && this.pvpPlayerQueue[0])
      : (this.currentDeck && this.currentDeck[this.currentCardIdx]);
    this.openFeedbackModal();
    const catEl = document.getElementById('feedback-category');
    const msgEl = document.getElementById('feedback-message');
    if (catEl) catEl.value = 'Question Correction';
    if (msgEl && card) {
      const qPreview = (card.question || '').slice(0, 90);
      msgEl.value = `[Item #${card.id} | Area ${card.area} | ${card.levelLabel}]\nQ: "${qPreview}..."\nCurrent Answer: "${card.answer}"\n\nCorrection / Issue: `;
      msgEl.focus();
      msgEl.setSelectionRange(msgEl.value.length, msgEl.value.length);
    }
  }

  openFeedbackModal() {
    const modal = document.getElementById('feedback-modal');
    const msg = document.getElementById('feedback-message');
    const st = document.getElementById('feedback-status-msg');
    if (msg) msg.value = '';
    if (st) st.classList.add('hidden');
    if (modal) modal.classList.remove('hidden');
    setTimeout(() => msg && msg.focus(), 60);
  }

  closeFeedbackModal() {
    const modal = document.getElementById('feedback-modal');
    if (modal) modal.classList.add('hidden');
  }

  async submitFeedback() {
    const cat = document.getElementById('feedback-category')?.value || 'Suggestion';
    const msgEl = document.getElementById('feedback-message');
    const st = document.getElementById('feedback-status-msg');
    const message = (msgEl?.value || '').trim();
    if (message.length < 3) {
      st.textContent = 'Please write at least a short message.';
      st.className = 'text-xs font-semibold text-rose-400';
      st.classList.remove('hidden');
      return;
    }
    try {
      const res = await this.apiCall('POST', { action: 'feedback_submit', name: this.user.name || 'Guest', category: cat, message });
      if (res.ok) {
        st.textContent = 'Sent to the Owner! Thank you for helping improve Project Bayaw App.';
        st.className = 'text-xs font-semibold text-emerald-400';
        st.classList.remove('hidden');
        if (msgEl) msgEl.value = '';
        setTimeout(() => this.closeFeedbackModal(), 1400);
      } else {
        st.textContent = 'Could not send feedback. Try again.';
        st.className = 'text-xs font-semibold text-rose-400';
        st.classList.remove('hidden');
      }
    } catch (e) {}
  }

  async loadAdminFeedback() {
    if (!document.getElementById('admin-feedback-list') || !this.adminPasscode) return;
    try {
      const res = await this.apiCall('POST', { action: 'admin_list_feedback' });
      const data = await res.json();
      this.owFeedback = res.ok && Array.isArray(data.feedback) ? data.feedback : [];
      this.renderAdminFeedback();
    } catch (e) {}
  }

  renderAdminFeedback() {
    const box = document.getElementById('admin-feedback-list');
    const chips = document.getElementById('ow-fb-chips');
    if (!box) return;
    const esc = (x) => this.escapeHtml(x);
    const all = this.owFeedback || [];
    this.owStats();
    const cats = [...new Set(all.map(f => f.category || 'Other'))];
    if (this.owFb && !cats.includes(this.owFb)) this.owFb = '';
    chips.innerHTML = all.length ? [['', `All ${all.length}`], ...cats.map(c => [c, `${c} ${all.filter(f => (f.category || 'Other') === c).length}`])]
      .map(([k, label], i) => `<button class="ow-chip ${(this.owFb || '') === k ? 'on' : ''}" onclick="app.owFb=${i ? `app.owFbCats[${i - 1}]` : "''"}; app.renderAdminFeedback()">${esc(label)}</button>`).join('') : '';
    this.owFbCats = cats;
    const tone = (c) => /correct/i.test(c) ? 'gold' : /bug|error|problem/i.test(c) ? 'rust' : /idea|suggest|feature/i.test(c) ? 'blue' : 'gray';
    const list = all.map((f, i) => [f, i]).filter(([f]) => !this.owFb || (f.category || 'Other') === this.owFb);
    box.innerHTML = list.length ? list.map(([f, i]) => `<div class="ow-fb">
        <div class="flex flex-wrap items-center gap-2 text-[12.5px] text-slate-400"><span class="ow-tag ${tone(f.category || '')}">${esc(f.category || 'Other')}</span><b class="font-semibold text-[13.5px] text-white">${esc(f.name)}</b><span>· ${new Date(f.createdAt).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}</span></div>
        <p class="text-[14.5px] mt-1.5 whitespace-pre-line break-words">${esc(f.message)}</p>
        <button onclick="app.adminDeleteFeedback(app.owFeedback[${i}].id)" class="ow-btn sm danger mt-2"><svg class="ic" aria-hidden="true"><use href="#i-trash-2"/></svg>Delete</button>
      </div>`).join('') : `<div class="ow-empty">No feedback yet. Reviewees send it with Report on a question or the feedback form.</div>`;
  }

  async adminDeleteFeedback(feedbackId) {
    await this.apiCall('POST', { action: 'admin_delete_feedback', feedbackId });
    await this.loadAdminFeedback();
  }

  // ==================== SUBMIT REVIEWER (.DOCX / .PDF) & OWNER INBOX ====================
  openSubmitReviewerModal() {
    const modal = document.getElementById('submit-reviewer-modal');
    const titleEl = document.getElementById('rev-submit-title');
    const notesEl = document.getElementById('rev-submit-notes');
    const fileEl = document.getElementById('rev-submit-file');
    const infoEl = document.getElementById('rev-submit-file-info');
    const stEl = document.getElementById('rev-submit-status');
    if (titleEl) titleEl.value = '';
    if (notesEl) notesEl.value = '';
    if (fileEl) fileEl.value = '';
    if (infoEl) infoEl.classList.add('hidden');
    if (stEl) stEl.classList.add('hidden');
    if (modal) modal.classList.remove('hidden');
  }

  closeSubmitReviewerModal() {
    const modal = document.getElementById('submit-reviewer-modal');
    if (modal) modal.classList.add('hidden');
  }

  onReviewerFileSelected() {
    const fileEl = document.getElementById('rev-submit-file');
    const infoEl = document.getElementById('rev-submit-file-info');
    const titleEl = document.getElementById('rev-submit-title');
    const file = fileEl?.files?.[0];
    if (!file || !infoEl) return;
    const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
    infoEl.textContent = `Selected: ${file.name} (${sizeMb} MB)`;
    infoEl.classList.remove('hidden');
    if (titleEl && !titleEl.value.trim()) {
      titleEl.value = file.name.replace(/\.(docx|doc|pdf)$/i, '').replace(/[_-]+/g, ' ').slice(0, 100);
    }
  }

  async submitReviewerFile() {
    const area = document.getElementById('rev-submit-area')?.value || 'Mixed / All Areas';
    const title = (document.getElementById('rev-submit-title')?.value || '').trim();
    const notes = (document.getElementById('rev-submit-notes')?.value || '').trim();
    const fileEl = document.getElementById('rev-submit-file');
    const st = document.getElementById('rev-submit-status');
    const btn = document.getElementById('btn-submit-reviewer');
    const file = fileEl?.files?.[0];

    if (!file) {
      st.textContent = 'Please select a .docx, .doc, or .pdf file first.';
      st.className = 'text-xs font-semibold text-rose-400';
      st.classList.remove('hidden');
      return;
    }

    const prevTxt = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    st.textContent = 'Uploading your reviewer to the Owner Inbox...';
    st.className = 'text-xs font-semibold text-sky-300';
    st.classList.remove('hidden');

    try {
      const res = await window.bayawUploadReviewer(file, {
        usernameKey: this.user.usernameKey || this.user.name || 'guest',
        senderName: this.user.name || 'Reviewee',
        area,
        title: title || file.name,
        notes
      });
      if (res.ok) {
        st.textContent = 'Uploaded! Thank you for sharing — the Owner can now download it and credit your contribution.';
        st.className = 'text-xs font-semibold text-emerald-400';
        setTimeout(() => this.closeSubmitReviewerModal(), 1600);
      } else {
        st.textContent = `${res.error || 'Upload failed. Please try again.'}`;
        st.className = 'text-xs font-semibold text-rose-400';
      }
    } catch (e) {
      st.textContent = 'Upload error. Check your internet connection and try again.';
      st.className = 'text-xs font-semibold text-rose-400';
    } finally {
      btn.disabled = false;
      btn.textContent = prevTxt;
    }
  }

  async loadAdminReviewers() {
    const listBox = document.getElementById('admin-reviewers-list');
    const contribBox = document.getElementById('admin-reviewers-contributors');
    if (!listBox || !this.adminPasscode) return;
    const esc = (x) => this.escapeHtml(x);
    try {
      const res = await this.apiCall('POST', { action: 'admin_list_reviewers' });
      const data = await res.json();
      if (!res.ok) {
        listBox.innerHTML = `<div class="ow-empty">The reviewer files table is not set up in Supabase yet. Run the setup SQL in the Supabase SQL Editor.</div>`;
        return;
      }
      const mb = (data.activeStorageBytes || 0) / (1024 * 1024);
      const contribs = data.contributors || [];
      const list = data.reviewers || [];
      this.owFiles = list; this.owContribs = contribs;
      document.getElementById('admin-reviewers-storage-pill').innerHTML = `<b class="font-mono text-white">${data.activeFilesCount || 0}</b> stored file${data.activeFilesCount === 1 ? '' : 's'} from ${contribs.length} ${contribs.length === 1 ? 'person' : 'people'}`;
      document.getElementById('ow-mb-of').textContent = `${mb.toFixed(1)} / 1,000 MB`;
      document.getElementById('ow-store-bar').style.width = `${Math.min(100, mb / 10)}%`;
      const mbEl = document.getElementById('ow-mb');
      if (mbEl) mbEl.textContent = Math.round(mb).toLocaleString();
      if (contribBox) contribBox.innerHTML = contribs.map((c, i) => `<button onclick="app.adminFile('contrib', ${i})" title="Reward ${esc(c.senderName)}" class="ow-tag plum !min-h-[30px] !px-2.5 hover:brightness-110">${esc(c.senderName)} · ${c.count}<svg class="ic" aria-hidden="true"><use href="#i-gift"/></svg></button>`).join('');
      if (!list.length) {
        listBox.innerHTML = `<div class="ow-empty">No files yet. Reviewees share them with "Submit reviewer" in the sidebar.</div>`;
        return;
      }
      listBox.innerHTML = list.map((r, i) => {
        const size = r.fileSize ? `${(r.fileSize / (1024 * 1024)).toFixed(1)} MB` : '–';
        const freed = !r.filePath || r.status === 'added';
        return `<div class="ow-file">
          <span class="ow-fi"><svg class="ic" aria-hidden="true"><use href="#i-file-text"/></svg></span>
          <div class="min-w-0">
            <b class="font-semibold text-sm break-words">${esc(r.title || r.fileName)}</b> ${freed ? '<span class="ow-tag green">Added · file freed</span>' : ''}
            <div class="ow-meta">${esc(r.senderName)} · ${esc(r.area || '')} · <span class="font-mono text-xs">${size}</span> · ${new Date(r.createdAt).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })}</div>
            ${r.notes ? `<div class="text-[13px] mt-1 whitespace-pre-line break-words">${esc(r.notes)}</div>` : ''}
          </div>
          <div class="ow-file-act">
            ${r.fileUrl ? `<a href="${esc(r.fileUrl)}" target="_blank" rel="noopener" download="${esc(r.fileName)}" class="ow-btn sm"><svg class="ic" aria-hidden="true"><use href="#i-download"/></svg>Download</a>` : ''}
            ${!freed ? `<button onclick="app.adminFile('added', ${i})" title="Deletes the file from storage and keeps their count" class="ow-btn sm"><svg class="ic" aria-hidden="true"><use href="#i-circle-check"/></svg>Mark added</button>` : ''}
            <button onclick="app.adminFile('reward', ${i})" class="ow-btn sm"><svg class="ic" aria-hidden="true"><use href="#i-gift"/></svg>Reward</button>
            <button onclick="app.adminFile('delete', ${i})" aria-label="Delete file" class="ow-btn sm danger"><svg class="ic" aria-hidden="true"><use href="#i-trash-2"/></svg></button>
          </div>
        </div>`;
      }).join('');
    } catch (e) {}
  }

  adminFile(act, i) {
    if (act === 'contrib') { const c = this.owContribs?.[i]; if (c) this.adminQuickRewardReviewer(c.usernameKey, c.senderName); return; }
    const r = this.owFiles?.[i];
    if (!r) return;
    if (act === 'added') return this.adminMarkReviewerAdded(r.id);
    if (act === 'delete') return this.adminDeleteReviewer(r.id);
    if (act === 'reward') return this.adminQuickRewardReviewer(r.usernameKey, r.senderName);
  }

  async adminMarkReviewerAdded(reviewerId) {
    if (!await this.owAsk({ title: 'Mark as added?', body: 'Deletes the file from storage to free space. Their contribution count stays.', ok: 'Mark added' })) return;
    await this.apiCall('POST', { action: 'admin_mark_reviewer_added', reviewerId });
    await Promise.all([this.loadAdminReviewers(), this.loadAdminAccounts()]);
  }

  async adminDeleteReviewer(reviewerId) {
    if (!await this.owAsk({ title: 'Delete this file?', body: 'Removes the file and its record, so it no longer counts for the sender.', ok: 'Delete', danger: true })) return;
    await this.apiCall('POST', { action: 'admin_delete_reviewer', reviewerId });
    await Promise.all([this.loadAdminReviewers(), this.loadAdminAccounts()]);
  }

  async adminQuickRewardReviewer(usernameKey, senderName) {
    const duration = await this.owAsk({ title: `Reward ${senderName}`, body: 'Add bonus access days for sharing a reviewer.', ok: 'Give reward',
      options: [['1d', '+1 day'], ['3d', '+3 days'], ['7d', '+1 week'], ['14d', '+2 weeks'], ['30d', '+1 month'], ['90d', '+3 months'], ['unli', 'Unlimited']], });
    if (!duration) return;
    const res = await this.apiCall('POST', { action: 'admin_renew_account', usernameKey, duration });
    if (res.ok) {
      await this.loadAdminAccounts();
      this.owToast(`Rewarded ${senderName} with ${duration === 'unli' ? 'unlimited access' : `+${duration}`}`);
    } else {
      this.owToast(`Could not find ${senderName}'s account to reward.`);
    }
  }

  escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  plainExprToLatex(expr) {
    let s = String(expr || '').trim().replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    // Protect common engineering units in \text{...}
    s = s.replace(/\bm_dot\b/g, '\\dot{m}');
    // √( ... ) and ^( ... ) with nested parens, e.g. √(2(0.9/9.81)), e^((y + z)/2)
    const wrapParens = (open, repl) => {
      for (let i = s.indexOf(open); i !== -1; i = s.indexOf(open, i + 1)) {
        let depth = 0, j = i + open.length - 1;
        for (; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')' && --depth === 0) break; }
        if (j < s.length) s = s.slice(0, i) + repl + '{' + s.slice(i + open.length, j) + '}' + s.slice(j + 1);
      }
    };
    wrapParens('√(', '\\sqrt');
    s = s.replace(/√(\d+(?:\.\d+)?|[A-Za-z]+)/g, '\\sqrt{$1}');
    // Exponents & superscripts
    wrapParens('^(', '^');
    s = s.replace(/\^(-?[A-Za-z0-9\.]+)/g, '^{$1}');
    // Unicode superscript runs, e.g. 10⁻³ -> 10^{-3}
    const SUP = { '⁻': '-', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
    s = s.replace(/[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, m => `^{${[...m].map(c => SUP[c]).join('')}}`);
    // Subscripts like T_i, S_d, P_w, c_p
    s = s.replace(/\b([A-Za-z])_([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)\b/g, (m, a, b) => `${a}_{${b.replace(/_/g, ' ')}}`);
    // Symbols
    s = s.replace(/=>|⇒/g, ' \\Rightarrow ').replace(/->|→/g, ' \\rightarrow ');
    s = s.replace(/×/g, ' \\times ').replace(/÷/g, ' \\div ');
    s = s.replace(/≈/g, ' \\approx ').replace(/≤/g, ' \\le ').replace(/≥/g, ' \\ge ').replace(/±/g, ' \\pm ');
    s = s.replace(/π/g, '\\pi ').replace(/Δ/g, '\\Delta ').replace(/θ/g, '\\theta ').replace(/η/g, '\\eta ').replace(/°/g, '^\\circ ');
    // Stacked fractions for clean patterns: (a)/(b) or (a/b) or num/den where not a unit like m/s or ha/hr
    const unitDen = /^(s|hr|hrs|h|min|day|kg|g|m|cm|mm|km|L|mL|ha|gal|lb|lbs|ft|in|s\^\{2\}|m\^\{2\}|m\^\{3\}|kW|hp|yr|year|rev|pass|row|bag|bags|head|heads|°C|C|K)$/i;
    // skip a match that would cut through an exponent like (x^{3/2})
    const braced = t => t.split('{').length === t.split('}').length;
    s = s.replace(/\(([^()]+)\)\s*\/\s*\(([^()]+)\)/g, (m, a, b) => braced(a) && braced(b) ? `\\frac{${a}}{${b}}` : m);
    s = s.replace(/\(([^()\/]+)\/([^()\/]+)\)/g, (m, a, b) => unitDen.test(b.trim()) || !braced(a) || !braced(b) ? m : `\\left(\\frac{${a.trim()}}{${b.trim()}}\\right)`);
    s = s.replace(/(?<![A-Za-z\\])(\d+(?:,\d{3})*(?:\.\d+)?|[A-Za-z](?:_\{[^}]+\})?|\d+[A-Za-z]|\\sqrt\{[^}]+\})\s*\/\s*(\d+(?:,\d{3})*(?:\.\d+)?|[A-Za-z](?:_\{[^}]+\})?|\\sqrt\{[^}]+\})/g, (m, a, b, off, str) => {
      if (unitDen.test(b.trim())) return m;
      if (/^[A-Za-z]$/.test(a.trim()) && /\d\s*$/.test(str.slice(0, off))) return m; // "24 V / 6 V": V is a unit, not a numerator
      return `\\frac{${a.trim()}}{${b.trim()}}`;
    });
    // Words stay readable: math mode would italicize them and drop their spaces ("Modulesinseries")
    s = s.replace(/\b(sin|cos|tan|log|ln|exp)\b(?=\s*[(\d])/g, '\\$1 ');
    s = s.replace(/(?<![\\A-Za-z])[A-Za-z]{2,}(?:[ \t]+[A-Za-z]{2,})*(?![A-Za-z])/g, (w, off, str) => {
      const before = str.slice(0, off), after = str.slice(off + w.length);
      const padL = /[0-9A-Za-z)}]\s+$/.test(before) && !/\\[A-Za-z]+\s+$/.test(before) ? '\\ ' : '';
      const padR = /^\s+[0-9A-Za-z(]/.test(after) ? '\\ ' : '';
      return `${padL}\\text{${w}}${padR}`;
    });
    // Escape % and $ for KaTeX
    s = s.replace(/%/g, '\\%').replace(/\$/g, '\\$').replace(/&/g, '\\&').replace(/#/g, '\\#');
    return s;
  }

  renderKatexSafe(expr, displayMode = false) {
    if (typeof window.katex !== 'undefined') {
      try {
        const latex = this.plainExprToLatex(expr);
        return window.katex.renderToString(latex, { throwOnError: false, displayMode, strict: false });
      } catch (e) {}
    }
    return `<span class="font-mono text-emerald-200">${this.escapeHtml(expr)}</span>`;
  }

  formatRationaleHtml(card) {
    const raw = (card.rationale || '').trim();
    if (!raw) {
      return `<div class="text-slate-300 text-xs">Source: ${this.escapeHtml(card.source || '')} • ${this.escapeHtml(card.subtopic || '')}</div>`;
    }

    // Check if this rationale contains math equations/steps
    const hasMath = raw.includes('=') || /Given:|Formula:|Step \d+:/i.test(raw);
    if (!hasMath) {
      return `<div class="text-xs sm:text-sm text-slate-200 leading-relaxed whitespace-pre-line">${this.escapeHtml(raw)}</div>`;
    }

    // Break dense single-paragraph solutions into clear logical lines
    let normalized = raw
      .replace(/\s*(Given\s*:)/gi, '\n$1')
      .replace(/\s*(Formula\s*:|Using [^:]{3,35}:)/gi, '\n$1')
      .replace(/\s*(Step\s*\d+\s*:)/gi, '\n$1')
      .replace(/\s*(Substitution\s*:|Solving[^:]*:|Calculate[^:]*:|Convert[^:]*:)/gi, '\n$1')
      .replace(/\s*(⇒|=>)\s*/g, '\n⇒ ')
      .replace(/\s*(Answer\s*[=:]|Therefore\s*,?)/gi, '\n$1')
      .replace(/\.\s+(?=[A-Z][a-zA-Z0-9_ ]{0,22}\s*=)/g, '.\n');

    const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean);

    const htmlLines = lines.map(line => {
      // Tag badge for Given / Formula / Step / Answer
      const labelMatch = line.match(/^(Given|Formula|Step\s*\d+|Substitution|Answer|Therefore|Reference|Notes)\s*[:=]?\s*(.*)$/i);
      if (labelMatch) {
        const lbl = labelMatch[1];
        const rest = labelMatch[2].trim();
        const isAns = /^(Answer|Therefore)$/i.test(lbl);
        const isGiven = /^Given$/i.test(lbl);
        const bodyHtml = this.formatMathLineContent(rest);
        // Notebook style: small step label above the working, answer line in green
        return `
          <div class="py-1">
            <div class="font-sans text-xs ${isAns ? 'text-emerald-300 font-semibold' : 'text-slate-400'}">${this.escapeHtml(lbl)}</div>
            <div class="leading-relaxed overflow-x-auto overflow-y-hidden ${isAns ? 'text-emerald-300 font-semibold' : 'text-white'}">${bodyHtml}</div>
          </div>
        `;
      }

      // Pure equation line (starts with ⇒ or has = and mostly math symbols)
      const isEqLine = line.startsWith('⇒') || (line.includes('=') && line.length < 130 && !/^[A-Z][a-z]+\s+[a-z]+\s+[a-z]+\s+[a-z]+/.test(line));
      if (isEqLine) {
        const eqText = line.replace(/^⇒\s*/, '');
        const prefix = line.startsWith('⇒') ? '<span class="text-emerald-300 mr-1.5">⇒</span>' : '';
        return `
          <div class="py-1 overflow-x-auto overflow-y-hidden text-white">
            ${prefix}${this.renderKatexSafe(eqText, false)}
          </div>
        `;
      }

      return `<div class="text-sm text-slate-300 leading-relaxed py-0.5">${this.formatMathLineContent(line)}</div>`;
    });

    // the rationale box keeps line breaks (pre-line), so drop template whitespace between tags
    return `<div class="space-y-1.5 pt-1">${htmlLines.join('').replace(/>\s*\n\s*</g, '><').trim()}</div>`;
  }

  formatMathLineContent(text) {
    if (!text) return '';
    // If the whole segment is a clean equation (contains '=' and few prose words), render via KaTeX!
    const words = text.match(/\b[a-z]{4,}\b/g) || [];
    if (text.includes('=') && words.length <= 3 && text.length <= 110) {
      return `<span class="inline-block">${this.renderKatexSafe(text, false)}</span>`;
    }
    // Otherwise render inline equations separated by semicolons/commas or embedded formulas like "A = √3 d²"
    const escaped = this.escapeHtml(text);
    // Highlight inline equation segments like "Q = 5 m³/s", "R = d/2", "b = 2d/√3"
    // decimals (0.25) and thousands (1,000) stay inside the equation
    return escaped.replace(/([A-Za-zΔηθπ][A-Za-z0-9_]*\s*=\s*(?:[^,.;\n]|\.(?=\d)|,(?=\d{3}\b)){1,52})/g, (match) => {
      // Unescape basic entities for KaTeX
      const rawEq = match.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      if (/[0-9√^\/×÷²³]/.test(rawEq)) {
        return `<span class="inline-block mx-0.5 align-middle">${this.renderKatexSafe(rawEq, false)}</span>`;
      }
      return match;
    });
  }
}

const app = new AgriBoardApp();
window.app = app;
window.addEventListener('DOMContentLoaded', () => app.init());

// Installable app: offline cache + "Install App" buttons (shown only when the browser can install)
let deferredInstall = null;
const showInstall = on => document.querySelectorAll('.install-app-btn').forEach(b => b.classList.toggle('hidden', !on));
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; showInstall(true); });
window.addEventListener('appinstalled', () => { deferredInstall = null; showInstall(false); });
window.addEventListener('DOMContentLoaded', () => { if (isIos && !isStandalone()) showInstall(true); });
AgriBoardApp.prototype.installApp = async function () {
  if (deferredInstall) {
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    showInstall(false);
  } else if (isIos) {
    alert('To install on iPhone/iPad: tap the Share button in Safari, then "Add to Home Screen".');
  }
};
