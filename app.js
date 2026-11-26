// AgriBoard Prep (Project Bayaw) — Gamified ABELE Reviewer & 1v1 PvP Anki Race Engine
const STORAGE_KEY = 'agriboard_prep_abe_v2';

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
    this.syncDebounceTimer = setTimeout(() => this.syncUserToLeaderboard(), 600);
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
        await this.fetchLiveLeaderboard();
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
        const me = this.liveLeaderboard.allUsers.find(u => u.id === this.user.id);
        if (me) {
          this.user.isOwner = !!me.isOwner;
          this.user.title = me.title || '';
          this.updateOwnerBadgeUI();
        }
        this.renderLeaderboards();
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
      tagEl.textContent = '👑 OWNER';
    } else if (this.user.title) {
      tagEl.classList.remove('hidden');
      tagEl.textContent = `🏷️ ${this.user.title}`;
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
      this.refreshAdminUsers();
    } else {
      document.getElementById('admin-login-box').classList.remove('hidden');
      document.getElementById('admin-tools-body').classList.add('hidden');
      document.getElementById('btn-admin-logout').classList.add('hidden');
    }
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
    await Promise.all([this.loadAdminAccessCodes(), this.loadAdminAccounts(), this.loadAdminFeedback()]);
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
      alert(`✅ Generated & Copied Access Code: ${data.code}\nDuration: ${data.durationLabel} • Max uses: ${data.maxUses}`);
    } else {
      alert(data.error || 'Could not generate Access Code.');
    }
  }

  async loadAdminAccessCodes() {
    const container = document.getElementById('admin-access-codes-list');
    if (!container || !this.adminPasscode) return;
    try {
      const res = await this.apiCall('POST', { action: 'admin_list_access_codes' });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.codes) || data.codes.length === 0) {
        container.innerHTML = `<div class="text-[11px] text-slate-400">No access codes generated yet. Click "+ Generate Code" above!</div>`;
        return;
      }
      container.innerHTML = data.codes.map(c => `
        <div class="flex flex-wrap items-center justify-between gap-2 bg-navy-950 border border-emerald-500/30 rounded-xl px-3.5 py-2 text-xs">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono font-black text-emerald-300 tracking-wider">${this.escapeHtml(c.code)}</span>
            <span class="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/40 text-amber-300 font-bold">${this.escapeHtml(c.durationLabel || 'Unlimited')}</span>
            ${c.label ? `<span class="text-[10px] px-2 py-0.5 rounded bg-navy-800 text-slate-300">${this.escapeHtml(c.label)}</span>` : ''}
            <span class="text-[10px] font-mono ${c.uses >= c.maxUses ? 'text-rose-400' : 'text-sky-300'}">${c.uses} / ${c.maxUses} used</span>
          </div>
          <div class="flex items-center gap-1.5">
            <button onclick="navigator.clipboard?.writeText('${c.code}'); alert('Copied: ${c.code}')" class="px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-200 text-[10px] font-bold">📋 Copy</button>
            <button onclick="app.adminDeleteAccessCode('${c.code}')" class="px-2.5 py-1 rounded-lg bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 text-[10px] font-bold">Delete</button>
          </div>
        </div>
      `).join('');
    } catch (e) {}
  }

  async loadAdminAccounts() {
    const tbody = document.getElementById('admin-accounts-tbody');
    const pill = document.getElementById('admin-online-pill');
    if (!tbody || !this.adminPasscode) return;
    try {
      const res = await this.apiCall('POST', { action: 'admin_list_accounts' });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.accounts)) return;

      if (pill) pill.textContent = `${data.onlineCount || 0} Online Now • ${data.totalAccounts || 0} Total`;
      if (data.accounts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-4 text-center text-slate-400">No registered accounts yet.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.accounts.map(acc => {
        const statusDot = acc.isOnline
          ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400"><span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Online</span>`
          : `<span class="inline-flex items-center gap-1 text-[10px] text-slate-500"><span class="w-2 h-2 rounded-full bg-slate-600"></span> Offline</span>`;

        let daysBadge = `<span class="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-bold text-[10px]">♾️ Unlimited</span>`;
        if (acc.accessExpiresAt) {
          if (acc.daysRemaining <= 0) {
            daysBadge = `<span class="px-2 py-0.5 rounded bg-rose-500/20 border border-rose-400/50 text-rose-300 font-bold text-[10px]">Expired (0d)</span>`;
          } else {
            daysBadge = `<span class="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/40 text-amber-300 font-bold text-[10px]">${acc.daysRemaining}d left (${this.escapeHtml(acc.accessDurationLabel)})</span>`;
          }
        }

        const revokedTag = acc.revoked
          ? `<span class="ml-1.5 px-1.5 py-0.5 rounded bg-rose-600 text-white font-black text-[9px] uppercase">REVOKED</span>`
          : '';

        const actionBtn = acc.isOwner
          ? `<span class="text-[10px] text-amber-300 font-bold">👑 Owner Protected</span>`
          : `<div class="inline-flex flex-wrap items-center justify-end gap-1.5">
              <select id="renew-sel-${acc.usernameKey}" class="bg-navy-950 border border-sky-500/40 rounded-lg px-2 py-1 text-[10px] font-bold text-sky-300">
                <option value="1d">+1 Day</option>
                <option value="3d">+3 Days</option>
                <option value="7d" selected>+1 Week</option>
                <option value="14d">+2 Weeks</option>
                <option value="30d">+1 Month</option>
                <option value="90d">+3 Months</option>
                <option value="unli">♾️ Unli</option>
              </select>
              <button onclick="app.adminRenewAccount('${acc.usernameKey}', '${this.escapeHtml(acc.name)}')" class="px-2.5 py-1 rounded-lg bg-sky-600/25 hover:bg-sky-600/45 border border-sky-400/50 text-sky-200 text-[11px] font-bold">Renew</button>
              ${acc.revoked
                ? `<button onclick="app.adminToggleRevokeAccount('${acc.usernameKey}', false, '${this.escapeHtml(acc.name)}')" class="px-2.5 py-1 rounded-lg bg-emerald-600/25 hover:bg-emerald-600/45 border border-emerald-400/50 text-emerald-200 text-[11px] font-bold">Restore</button>`
                : `<button onclick="app.adminToggleRevokeAccount('${acc.usernameKey}', true, '${this.escapeHtml(acc.name)}')" class="px-2.5 py-1 rounded-lg bg-rose-600/25 hover:bg-rose-600/50 border border-rose-400/50 text-rose-200 text-[11px] font-bold">Revoke</button>`}
            </div>`;

        return `
          <tr>
            <td class="py-2.5">
              <div class="flex items-center gap-2">
                ${statusDot}
                <span class="font-bold text-white">${this.escapeHtml(acc.name)}</span>
                ${revokedTag}
              </div>
            </td>
            <td class="py-2.5 font-mono text-[11px] text-sky-300">${this.escapeHtml(acc.accessCodeUsed)}</td>
            <td class="py-2.5 text-center">${daysBadge}</td>
            <td class="py-2.5 text-right">${actionBtn}</td>
          </tr>
        `;
      }).join('');
    } catch (e) {}
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
        if (countdown) countdown.textContent = `Sign up in the next ${hrsLeft}h to get ${p.trialDays || 5} Days FREE — No Access Code Needed!`;
      } else {
        banner.classList.add('hidden');
      }
    }
    if (codeLabel) {
      codeLabel.textContent = isActive
        ? 'Owner Access Code (Optional during 2-Day Free Launch Promo)'
        : 'Owner Access Code (Required for Registration)';
    }
    if (codeHint) {
      codeHint.textContent = isActive
        ? 'Leave blank to claim 5 Days FREE, or enter an Owner Access Code / Master Passcode.'
        : 'Ask the 👑 Owner for an invite code (Owner can enter master passcode here).';
    }

    // Update Admin Promo Pill
    const adminPill = document.getElementById('admin-promo-status-pill');
    if (adminPill) {
      if (isActive) {
        adminPill.textContent = `🟢 ACTIVE (${hrsLeft}h left • ${p.trialDays || 5}d Free)`;
        adminPill.className = 'px-2.5 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-400/50 text-[10px] font-black text-emerald-300';
      } else {
        adminPill.textContent = '🔒 ENDED (Access Code Required)';
        adminPill.className = 'px-2.5 py-0.5 rounded-full bg-rose-500/20 border border-rose-400/50 text-[10px] font-black text-rose-300';
      }
    }
  }

  async adminSetPromo(enabled, hours, trialDays) {
    const res = await this.apiCall('POST', { action: 'admin_set_promo', enabled, hours, trialDays });
    const data = await res.json();
    if (res.ok && data.promo) {
      this.promoState = data.promo;
      this.updatePromoUI();
      alert(enabled ? `🎉 48-Hour Launch Promo STARTED! New sign-ups get ${trialDays} Days FREE.` : '🔒 Launch Promo STOPPED. Access Code is now required for all new sign-ups.');
    }
  }

  async adminRenewAccount(usernameKey, displayName) {
    const sel = document.getElementById(`renew-sel-${usernameKey}`);
    const duration = sel ? sel.value : '7d';
    const labelText = sel ? sel.options[sel.selectedIndex].text : duration;
    if (!confirm(`Renew / extend ${displayName}'s access by ${labelText}?`)) return;
    const res = await this.apiCall('POST', { action: 'admin_renew_account', usernameKey, duration });
    if (res.ok) {
      await this.loadAdminAccounts();
      alert(`✅ Renewed ${displayName}'s access (${labelText})!`);
    } else {
      alert('Could not renew account.');
    }
  }

  async adminToggleRevokeAccount(usernameKey, revoke, displayName) {
    const verb = revoke ? 'REVOKE' : 'RESTORE';
    if (!confirm(`${verb} access for ${displayName}?`)) return;
    await this.apiCall('POST', { action: 'admin_revoke_account', usernameKey, revoke });
    await this.loadAdminAccounts();
  }

  async adminDeleteAccessCode(code) {
    if (!confirm(`Revoke Access Code ${code}?`)) return;
    await this.apiCall('POST', { action: 'admin_delete_access_code', code });
    await this.loadAdminAccessCodes();
  }

  renderAdminUsersTable() {
    const tbody = document.getElementById('admin-users-tbody');
    if (!tbody) return;
    const users = this.liveLeaderboard.allUsers || [];
    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="py-4 text-center text-slate-400">No reviewees synced yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = users.map(u => {
      const badgeHtml = u.isOwner
        ? `<span class="px-2 py-0.5 rounded bg-gradient-to-r from-amber-400 to-orange-500 text-navy-950 font-black text-[10px]">👑 OWNER</span>`
        : (u.title
            ? `<span class="px-2 py-0.5 rounded bg-sky-500/20 border border-sky-400/40 text-sky-300 font-bold text-[10px]">🏷️ ${this.escapeHtml(u.title)}</span>`
            : `<span class="text-slate-500 text-[10px]">No custom title</span>`);
      return `
        <tr>
          <td class="py-2.5 font-bold text-white">${this.escapeHtml(u.name)} <span class="text-[10px] text-slate-500 font-mono">(${u.id.slice(0,8)})</span></td>
          <td class="py-2.5">${badgeHtml}</td>
          <td class="py-2.5 text-center font-mono text-[11px] text-slate-300">${(u.xp || 0).toLocaleString()} XP • ${u.rp || 1200} RP</td>
          <td class="py-2.5 text-right space-x-1.5">
            <button onclick="app.adminPromptTitle('${u.id}', '${this.escapeHtml(u.name)}', '${this.escapeHtml(u.title || '')}')" class="px-2.5 py-1 rounded-lg bg-sky-600/20 hover:bg-sky-600/40 border border-sky-400/40 text-sky-300 text-[11px] font-bold">Give Title</button>
            <button onclick="app.adminToggleOwner('${u.id}', ${!u.isOwner})" class="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/40 border border-amber-400/40 text-amber-300 text-[11px] font-bold">${u.isOwner ? 'Remove Owner' : 'Make Owner'}</button>
            <button onclick="app.adminDeleteUser('${u.id}', '${this.escapeHtml(u.name)}')" class="px-2 py-1 rounded-lg bg-rose-600/20 hover:bg-rose-600/40 border border-rose-500/40 text-rose-300 text-[11px] font-bold">Remove</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  async adminPromptTitle(targetId, userName, currentTitle) {
    const newTitle = prompt(`Assign a custom title/tag to ${userName} (e.g., "Topnotcher", "Area 1 Ace", "VIP Reviewee", or leave blank to clear):`, currentTitle);
    if (newTitle === null) return;
    await this.apiCall('POST', { action: 'admin_set_title', targetId, title: newTitle.trim() });
    await this.refreshAdminUsers();
  }

  async adminToggleOwner(targetId, makeOwner) {
    await this.apiCall('POST', { action: 'admin_set_title', targetId, title: makeOwner ? 'OWNER' : '', isOwner: makeOwner });
    await this.refreshAdminUsers();
  }

  async adminDeleteUser(targetId, userName) {
    if (!confirm(`Remove ${userName} from the live leaderboard?`)) return;
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
      alert(data.error || 'Could not generate reset code.');
    }
  }

  copyGeneratedResetCode() {
    if (!this.lastGeneratedResetCode) return;
    navigator.clipboard?.writeText(this.lastGeneratedResetCode);
    alert(`Copied Reset Code: ${this.lastGeneratedResetCode}`);
  }

  async adminResetLeaderboard(scope) {
    const msg = scope === 'all'
      ? 'WIPE the entire leaderboard for all reviewees? This cannot be undone.'
      : `Reset ${scope.toUpperCase()} scores for all reviewees?`;
    if (!confirm(msg)) return;
    const res = await this.apiCall('POST', { action: 'admin_reset_leaderboard', scope });
    if (res.ok) {
      alert(`Leaderboard (${scope}) has been reset!`);
      await this.refreshAdminUsers();
    }
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
      const res = await fetch('./abe_database.json');
      this.db = await res.json();
      this.allItemsFlat = [];
      for (const area of this.db.areas) {
        for (const item of area.items) {
          this.allItemsFlat.push(item);
        }
      }
      document.getElementById('loading-overlay').classList.add('hidden');
      this.renderLevelTiles();
      this.selectStudyLevel(1, 1);
      this.updateAllProgressWidgets();
      this.setupKeyboardShortcuts();
      this.fetchLiveLeaderboard();
      this.loadGlobalChat();
      if (!this.user.loggedIn) {
        this.openAuthModal('login');
      } else {
        this.updateOwnerBadgeUI();
        this.syncUserToLeaderboard();
        this.sendHeartbeat();
      }
      setInterval(() => this.fetchLiveLeaderboard(), 20000);
      setInterval(() => this.loadGlobalChat(), 10000);
      setInterval(() => this.sendHeartbeat(), 30000);
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

  switchAuthTab(mode) {
    this.authMode = mode;
    const loginTab = document.getElementById('auth-tab-login');
    const regTab = document.getElementById('auth-tab-register');
    const codeWrap = document.getElementById('auth-access-code-wrap');
    const submitBtn = document.getElementById('auth-submit-btn');
    const err = document.getElementById('auth-error-msg');
    if (err) err.classList.add('hidden');

    if (mode === 'register') {
      regTab.className = 'py-2 rounded-lg text-xs font-extrabold bg-emerald-600 text-white transition-all';
      loginTab.className = 'py-2 rounded-lg text-xs font-bold text-slate-400 hover:text-white transition-all';
      codeWrap.classList.remove('hidden');
      submitBtn.textContent = 'Create Account & Unlock App';
      submitBtn.className = 'w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:brightness-110 text-white font-extrabold text-sm shadow-lg shadow-emerald-600/30 transition-all';
    } else {
      loginTab.className = 'py-2 rounded-lg text-xs font-extrabold bg-blue-600 text-white transition-all';
      regTab.className = 'py-2 rounded-lg text-xs font-bold text-slate-400 hover:text-white transition-all';
      codeWrap.classList.add('hidden');
      submitBtn.textContent = 'Sign In & Sync Progress';
      submitBtn.className = 'w-full py-3.5 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 hover:brightness-110 text-white font-extrabold text-sm shadow-lg shadow-blue-600/30 transition-all';
    }
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
    if (password.length < 4) {
      err.textContent = 'Password must be at least 4 characters.';
      err.classList.remove('hidden');
      return;
    }

    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = this.authMode === 'register' ? 'Creating Cloud Account...' : 'Signing In & Loading Progress...';

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
        this.selectStudyLevel(this.activeStudyArea || 1, this.activeStudyLevel || 1);
        this.fetchLiveLeaderboard();
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
    sessionStorage.removeItem('bayaw_admin_passcode');
    this.adminPasscode = '';
    this.isAdminVerified = false;
    this.user = this.loadUserState();
    this.updateOwnerBadgeUI();
    this.updateAllProgressWidgets();
    this.renderLevelTiles();
    this.showView('dashboard');
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
    const views = ['dashboard', 'pvp-lobby', 'pvp-arena', 'leaderboards', 'vault', 'progress', 'admin'];
    views.forEach(v => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.classList.add('hidden');
    });
    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.remove('hidden');

    // Update top nav & sidebar active styling
    document.querySelectorAll('.topnav-btn').forEach(b => {
      b.className = 'topnav-btn px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 text-slate-300 hover:text-white hover:bg-navy-800/80';
    });
    const topMap = { 'dashboard': 'topnav-dashboard', 'pvp-lobby': 'topnav-pvp', 'pvp-arena': 'topnav-pvp', 'leaderboards': 'topnav-leaderboards', 'vault': 'topnav-vault', 'progress': 'topnav-progress' };
    const topEl = document.getElementById(topMap[viewName]);
    if (topEl) {
      topEl.className = 'topnav-btn px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 nav-home-active text-white';
    }

    document.querySelectorAll('.side-btn').forEach(b => {
      if (b.id === 'side-pvp') {
        b.className = 'side-btn w-full flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-xs font-bold text-white sidebar-pvp-glow hover:brightness-110 transition-all';
      } else {
        b.className = 'side-btn w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-xs font-semibold text-slate-300 hover:bg-navy-800/80 hover:text-white';
      }
    });
    const sideKey = (viewName === 'pvp-lobby' || viewName === 'pvp-arena') ? 'side-pvp' : `side-${viewName}`;
    const sideEl = document.getElementById(sideKey);
    if (sideEl && sideKey !== 'side-pvp') {
      sideEl.className = 'side-btn w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-xs font-bold sidebar-item-active';
    }

    if (viewName === 'leaderboards') this.renderLeaderboards();
    if (viewName === 'vault') this.renderVault();
    if (viewName === 'progress') this.renderAllLevelsProgress();
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
      opts += `<option value="${lvl}">Area ${areaId} – Level ${lvl} (${start} – ${end})</option>`;
    }
    const ps = this.getPsItems(areaId);
    if (ps.length > 0) {
      opts += `<option value="ps">🧮 Area-${areaId} Level (PS) — ${ps.length} Problems</option>`;
    }
    lvlSel.innerHTML = opts;
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

  updateAllProgressWidgets() {
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
    document.getElementById('prog-a1-bar').style.width = `${s1.pct}%`;

    document.getElementById('prog-a2-lvl').textContent = `Lv ${s2.completedLevels} / ${s2.totalLevels}`;
    document.getElementById('prog-a2-txt').textContent = `${s2.mastered.toLocaleString()} / ${s2.total.toLocaleString()} (${s2.pct.toFixed(0)}%)`;
    document.getElementById('prog-a2-bar').style.width = `${s2.pct}%`;

    document.getElementById('prog-a3-lvl').textContent = `Lv ${s3.completedLevels} / ${s3.totalLevels}`;
    document.getElementById('prog-a3-txt').textContent = `${s3.mastered.toLocaleString()} / ${s3.total.toLocaleString()} (${s3.pct.toFixed(0)}%)`;
    document.getElementById('prog-a3-bar').style.width = `${s3.pct}%`;

    document.getElementById('prog-overall-txt').textContent = `${totalMastered.toLocaleString()} / ${totalItems.toLocaleString()} (${overallPct.toFixed(1)}%)`;
    document.getElementById('prog-overall-bar').style.width = `${overallPct}%`;

    // Study Card Mini Overall Bar
    document.getElementById('study-mini-all-txt').textContent = `${totalMastered.toLocaleString()} / ${totalItems.toLocaleString()} (${overallPct.toFixed(1)}%)`;
    document.getElementById('study-mini-all-bar').style.width = `${overallPct}%`;

    // Refresh leaderboards
    this.renderLeaderboards();
  }

  // ==================== 100-ITEM LEVEL TILES ====================
  filterLevelsByArea(areaId) {
    this.levelFilterArea = areaId;
    [0, 1, 2, 3].forEach(id => {
      const btn = document.getElementById(id === 0 ? 'lvl-filter-all' : `lvl-filter-${id}`);
      if (!btn) return;
      if (id === areaId) {
        btn.className = 'lvl-filter-btn px-2.5 py-1 rounded-md font-bold bg-blue-600 text-white';
      } else {
        btn.className = 'lvl-filter-btn px-2.5 py-1 rounded-md font-semibold bg-navy-900 text-slate-300 hover:text-white border border-blue-900/50';
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
          <button onclick="app.selectStudyLevel(${area.id}, ${lvl})" class="shrink-0 w-40 text-left rounded-xl p-3 ${isActive ? 'level-tile-active' : 'level-tile'}">
            <div class="text-xs font-extrabold text-white">Area ${area.id} – Level ${lvl}</div>
            <div class="text-[11px] font-mono text-sky-300 mt-0.5">${start} – ${end}</div>
            <div class="flex items-center justify-between mt-2.5">
              <span class="text-[10px] px-2 py-0.5 rounded-full bg-navy-950/80 border border-blue-900/60 text-slate-300 font-semibold">${count} items</span>
              <span class="text-[10px] font-mono font-bold ${lst.pct === 100 ? 'text-emerald-400' : 'text-slate-400'}">${lst.pct.toFixed(0)}%</span>
            </div>
          </button>
        `;
      }

      // 2) Dedicated Area-X Level (PS) tile for Problem Solving Only
      const ps = this.getPsStats(area.id);
      if (ps.total > 0) {
        const isPsActive = (this.problemSolvingOnly && this.activeStudyArea === area.id);
        html += `
          <button onclick="app.openProblemSolvingMode(${area.id})" class="shrink-0 w-44 text-left rounded-xl p-3 transition-all ${isPsActive ? 'bg-gradient-to-b from-amber-500/30 to-orange-900/50 border-2 border-amber-400 shadow-lg shadow-amber-500/25' : 'bg-amber-950/35 border border-amber-500/40 hover:border-amber-400'}">
            <div class="text-xs font-extrabold text-amber-300 flex items-center gap-1">🧮 Area-${area.id} Level (PS)</div>
            <div class="text-[11px] font-mono text-amber-200/80 mt-0.5">Problem Solving</div>
            <div class="flex items-center justify-between mt-2.5">
              <span class="text-[10px] px-2 py-0.5 rounded-full bg-navy-950/80 border border-amber-500/40 text-amber-200 font-semibold">${ps.total} problems</span>
              <span class="text-[10px] font-mono font-bold ${ps.pct === 100 ? 'text-emerald-400' : 'text-amber-300'}">${ps.pct.toFixed(0)}%</span>
            </div>
          </button>
        `;
      }
    }
    container.innerHTML = html;
  }

  // ==================== INLINE STUDY SESSION & ANKI SRS ====================
  selectStudyLevel(areaId, levelNum) {
    this.problemSolvingOnly = false;
    this.activeStudyArea = areaId;
    this.activeStudyLevel = levelNum;
    const lst = this.getLevelStats(areaId, levelNum);
    this.currentDeck = [...lst.items];

    const strip = document.getElementById('prob-solving-strip');
    if (strip) strip.classList.add('hidden');
    const toggleBtn = document.getElementById('btn-toggle-prob-only');
    if (toggleBtn) {
      toggleBtn.className = 'px-2.5 py-1 rounded-full bg-amber-500/15 hover:bg-amber-500/30 border border-amber-400/50 text-[10px] font-extrabold text-amber-300 transition-all';
      toggleBtn.textContent = '🧮 Problem Solving Only (Area 1–3)';
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
    this.activeStudyArea = areaId;
    const area = this.db.areas.find(a => a.id === areaId);
    this.currentDeck = area ? area.items.filter(it => it.category === 'problem_solving') : [];

    const firstUnmastered = this.currentDeck.findIndex(it => this.user.srs[it.id]?.status !== 'mastered');
    this.currentCardIdx = firstUnmastered >= 0 ? firstUnmastered : 0;

    const strip = document.getElementById('prob-solving-strip');
    if (strip) strip.classList.remove('hidden');

    const toggleBtn = document.getElementById('btn-toggle-prob-only');
    if (toggleBtn) {
      toggleBtn.className = 'px-2.5 py-1 rounded-full bg-amber-500 text-navy-950 border border-amber-300 text-[10px] font-black transition-all';
      toggleBtn.textContent = `🧮 Problem Solving Active (Area ${areaId})`;
    }

    [1, 2, 3].forEach(id => {
      const btn = document.getElementById(`prob-area-btn-${id}`);
      if (!btn) return;
      const activeColors = { 1: 'bg-sky-600 text-white', 2: 'bg-emerald-600 text-white', 3: 'bg-purple-600 text-white' };
      btn.className = id === areaId
        ? `px-2.5 py-1 rounded-lg text-[11px] font-extrabold ${activeColors[id]}`
        : 'px-2.5 py-1 rounded-lg text-[11px] font-bold bg-navy-900 text-slate-300 hover:text-white border border-blue-900/50';
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

    if (this.problemSolvingOnly) {
      document.getElementById('study-header-title').textContent = `🧮 Study Session — Area-${this.activeStudyArea} Level (PS) (${this.currentDeck.length} Problems)`;
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

    // SRS next review status (show live Anki countdown if in learning!)
    const rec = this.user.srs[card.id];
    const nextRevEl = document.getElementById('study-next-review');
    if (!rec) {
      nextRevEl.textContent = 'New card';
    } else if (rec.status === 'learning') {
      const remSec = Math.max(0, Math.ceil(((rec.due || 0) - Date.now()) / 1000));
      nextRevEl.textContent = remSec === 0 ? '🔴 Due NOW (Re-review!)' : `🔴 Again in ${remSec}s`;
    } else {
      nextRevEl.textContent = `✅ ${rec.interval || 3} days`;
    }

    // Show Anki Re-queue notification banner if this card came back automatically
    const areaPill = document.getElementById('study-area-pill');
    if (this.requeueBannerText) {
      areaPill.textContent = this.requeueBannerText;
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
          <img src="${this.fixAssetPath(src)}" class="study-solution-img max-h-56 p-1.5 object-contain blur-lg scale-105 opacity-60 transition-all duration-300 select-none pointer-events-none" />
          <div class="study-img-veil absolute inset-0 bg-navy-950/65 backdrop-blur-md flex flex-col items-center justify-center p-3 text-center">
            <span class="text-xs font-extrabold text-amber-300">🔒 Solution Image Hidden</span>
            <span class="text-[10px] text-slate-300 mt-0.5">Select an answer or press Show Answer to reveal clearly</span>
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
      choicesBox.innerHTML = card.choices.map((ch, idx) => `
        <button onclick="app.selectStudyMcqChoice(${idx})" id="study-choice-${idx}" class="w-full text-left px-3.5 py-2.5 rounded-xl bg-navy-950/85 hover:bg-navy-800 border border-blue-900/50 hover:border-sky-400/60 transition-all flex items-center gap-3">
          <span class="w-6 h-6 rounded-md bg-navy-800 text-sky-300 font-mono text-xs font-extrabold flex items-center justify-center shrink-0">${letters[idx]}</span>
          <span class="text-xs sm:text-sm font-medium text-slate-200 flex-1">${this.escapeHtml(ch)}</span>
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

    card.choices.forEach((ch, idx) => {
      const btn = document.getElementById(`study-choice-${idx}`);
      if (!btn) return;
      if (ch === card.answer) {
        btn.className = 'w-full text-left px-3.5 py-2.5 rounded-xl bg-emerald-600/30 border-2 border-emerald-400 flex items-center gap-3 shadow-lg shadow-emerald-900/30';
      } else if (idx === choiceIdx && !isCorrect) {
        btn.className = 'w-full text-left px-3.5 py-2.5 rounded-xl bg-rose-600/30 border-2 border-rose-400 flex items-center gap-3';
      }
    });

    this.revealStudyAnswer();
  }

  revealStudyAnswer() {
    const card = this.currentDeck[this.currentCardIdx];
    this.isAnswerRevealed = true;
    document.getElementById('study-flip-btn-wrap').classList.add('hidden');
    document.getElementById('study-answer-box').classList.remove('hidden');
    document.getElementById('study-answer-text').textContent = card.answer;
    document.getElementById('study-rationale-text').textContent = card.rationale || `Source: ${card.source} • ${card.subtopic}`;

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
      this.requeueBannerText = '🔴 Anki Re-Review (Due Now!)';
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
        this.requeueBannerText = '🔴 Anki Learning Queue';
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
    document.getElementById('minimap-title').textContent = this.problemSolvingOnly
      ? `🧮 Area ${this.activeStudyArea} Problem Solving Minimap (${this.currentDeck.length} Problems)`
      : `🗺️ 100-Item Level Minimap (Level ${this.activeStudyLevel}: ${startNum} – ${endNum})`;

    let cAgain = 0, cHard = 0, cGood = 0, cEasy = 0, unseen = 0;
    map.innerHTML = this.currentDeck.map((it, idx) => {
      const rec = this.user.srs[it.id];
      const isCur = idx === this.currentCardIdx;
      let cls = 'bg-navy-900 border border-blue-900/50 text-slate-400 hover:border-sky-400';

      if (rec) {
        const r = rec.lastRating || (rec.status === 'mastered' ? 'easy' : 'again');
        if (r === 'again') {
          cAgain++;
          cls = 'bg-rose-600 text-white font-extrabold';
        } else if (r === 'hard') {
          cHard++;
          cls = 'bg-amber-500 text-navy-950 font-extrabold';
        } else if (r === 'good') {
          cGood++;
          cls = 'bg-blue-600 text-white font-extrabold';
        } else {
          cEasy++;
          cls = 'bg-emerald-500 text-navy-950 font-extrabold';
        }
      } else {
        unseen++;
      }

      if (isCur) {
        cls += ' ring-2 ring-white scale-110 z-10 shadow-md';
      }
      return `
        <button onclick="app.jumpToStudyCard(${idx})" class="h-6 rounded text-[10px] font-mono transition-all ${cls}" title="${this.problemSolvingOnly ? 'Problem #' + (idx + 1) : 'Item #' + it.index}">
          ${this.problemSolvingOnly ? idx + 1 : it.index}
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
    const listEl = document.getElementById('pvp-waiting-list');
    if (!listEl) return;
    try {
      const res = await this.apiCall('POST', { action: 'pvp_list_waiting' });
      const data = await res.json();
      const rooms = (data.waiting || []).filter(r => r.p1_name !== this.user.name);
      if (rooms.length === 0) {
        listEl.innerHTML = `<div class="text-slate-400 text-[11px]">No other reviewees waiting right now. Click <strong>Find Match</strong> above to open a room!</div>`;
        return;
      }
      listEl.innerHTML = rooms.map(r => {
        const lvlTxt = r.level_val === 'ps' ? `Area-${r.area_id} Level (PS)` : `Area ${r.area_id} • Level ${r.level_val}`;
        return `
          <div class="flex items-center justify-between gap-2 bg-navy-900/90 border border-purple-500/35 rounded-lg px-3 py-2">
            <div>
              <div class="text-xs font-bold text-white">${this.escapeHtml(r.p1_name)} <span class="text-[10px] font-mono text-amber-300">(${r.p1_rp || 1200} RP)</span></div>
              <div class="text-[10px] text-sky-300">${lvlTxt} • ${r.deck_size} Cards</div>
            </div>
            <button onclick="app.joinWaitingPvpRoom(${r.area_id}, '${r.level_val}', ${r.deck_size})" class="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-extrabold">
              ⚔️ Accept Duel
            </button>
          </div>
        `;
      }).join('');
    } catch (e) {}
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
    const lvlLabel = levelVal === 'ps' ? `Area-${areaId} Level (PS)` : `Area ${areaId} • Level ${levelVal}`;
    document.getElementById('pvp-search-desc').textContent = `Looking for a real reviewee in ${lvlLabel} (${deckSize} Cards)...`;

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
          this.pvpOpponent.status = '❌ Lapsed! Card cycled back';
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
    document.getElementById('pvp-opp-status').textContent = this.pvpOpponent.status;
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
      this.user.srs[card.id] = { status: 'mastered', interval: 3, due: Date.now() + 3 * 86400000, reps: (this.user.srs[card.id]?.reps || 0) + 1 };
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
      this.user.srs[card.id] = { status: 'learning', lastRating: 'again', interval: 0, due: Date.now(), reps: 0 };
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
    document.getElementById('pvp-result-badge').textContent = won ? '🏆 VICTORY • DECK CLEARED FIRST!' : '⚔️ DEFEAT • OPPONENT FINISHED FIRST';
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
      pBtn.className = 'py-1.5 rounded-lg text-[11px] font-bold bg-indigo-600 text-white';
      vBtn.className = 'py-1.5 rounded-lg text-[11px] font-bold text-slate-400 hover:text-white';
    } else {
      vBtn.className = 'py-1.5 rounded-lg text-[11px] font-bold bg-purple-600 text-white';
      pBtn.className = 'py-1.5 rounded-lg text-[11px] font-bold text-slate-400 hover:text-white';
    }
  }

  getTierLabel(rp) {
    if (rp >= 1700) return { label: '★ Legend', cls: 'bg-amber-500/20 text-amber-300 border-amber-400/50' };
    if (rp >= 1450) return { label: 'Diamond', cls: 'bg-sky-500/20 text-sky-300 border-sky-400/50' };
    if (rp >= 1250) return { label: 'Platinum', cls: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/50' };
    return { label: 'Gold ABE', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50' };
  }

  renderTitleBadge(p) {
    if (p.isOwner) {
      return `<span class="ml-1 px-1.5 py-0.5 rounded bg-gradient-to-r from-amber-400 to-orange-500 text-navy-950 font-black text-[9px] uppercase">👑 OWNER</span>`;
    }
    if (p.title) {
      return `<span class="ml-1 px-1.5 py-0.5 rounded bg-sky-500/20 border border-sky-400/40 text-sky-300 font-bold text-[9px]">${this.escapeHtml(p.title)}</span>`;
    }
    return '';
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
    } else {
      progPlayers = [selfEntry];
      if (selfEntry.pvpWins > 0 || selfEntry.pvpLosses > 0 || selfEntry.rp !== 1200 || selfEntry.bestTimeSec !== null) {
        pvpPlayers = [selfEntry];
      }
    }

    const progRowsHtml = progPlayers.length > 0
      ? progPlayers.map((p, i) => `
        <tr class="${p.isUser ? 'bg-blue-600/20 font-bold text-white' : 'text-slate-300'}">
          <td class="py-1.5 font-mono ${i === 0 ? 'text-amber-400 font-bold' : 'text-slate-400'}">${i === 0 ? '👑' : i + 1}</td>
          <td class="py-1.5 ${p.isUser ? 'text-sky-300' : 'text-white'}">
            <div class="flex flex-wrap items-center gap-0.5">
              <span class="truncate max-w-[100px]">${this.escapeHtml(p.name)}</span>
              ${this.renderTitleBadge(p)}
            </div>
          </td>
          <td class="py-1.5 text-center font-mono text-sky-300">${p.a1Levels ?? 0}</td>
          <td class="py-1.5 text-center font-mono text-emerald-300">${p.a2Levels ?? 0}</td>
          <td class="py-1.5 text-center font-mono text-purple-300">${p.a3Levels ?? 0}</td>
          <td class="py-1.5 text-right font-mono text-amber-300">${(p.xp || 0).toLocaleString()}</td>
        </tr>
      `).join('')
      : `<tr><td colspan="6" class="py-4 text-center text-slate-400 text-[11px]">No reviewees yet. Start studying to claim #1!</td></tr>`;

    const pvpRowsHtml = pvpPlayers.length > 0
      ? pvpPlayers.map((p, i) => {
        const wins = p.pvpWins || 0;
        const losses = p.pvpLosses || 0;
        const bestStr = p.bestTimeSec ? `${Number(p.bestTimeSec).toFixed(1)}s` : '—';
        return `
          <tr class="${p.isUser ? 'bg-purple-600/20 font-bold text-white' : 'text-slate-300'}">
            <td class="py-1.5 font-mono ${i === 0 ? 'text-amber-400 font-bold' : 'text-slate-400'}">${i === 0 ? '👑' : i + 1}</td>
            <td class="py-1.5 ${p.isUser ? 'text-purple-200' : 'text-white'}">
              <div class="flex flex-wrap items-center gap-0.5">
                <span class="truncate max-w-[85px]">${this.escapeHtml(p.name)}</span>
                ${this.renderTitleBadge(p)}
              </div>
            </td>
            <td class="py-1.5 text-center font-mono text-[11px] whitespace-nowrap">
              <span class="text-emerald-400 font-extrabold">${wins}W</span>
              <span class="text-slate-500 mx-0.5">-</span>
              <span class="text-rose-400 font-bold">${losses}L</span>
            </td>
            <td class="py-1.5 text-right font-mono font-bold text-amber-300">${(p.rp || 1200).toLocaleString()}</td>
            <td class="py-1.5 text-right font-mono text-slate-400">${bestStr}</td>
          </tr>
        `;
      }).join('')
      : `<tr><td colspan="5" class="py-4 text-center text-slate-400 text-[11px]">Finish a 1v1 PvP match to rank on the real PvP board!</td></tr>`;

    const sideProg = document.getElementById('side-lb-prog-body');
    const sidePvp = document.getElementById('side-lb-pvp-body');
    const fullProg = document.getElementById('full-lb-prog-body');
    const fullPvp = document.getElementById('full-lb-pvp-body');

    if (sideProg) sideProg.innerHTML = progRowsHtml;
    if (sidePvp) sidePvp.innerHTML = pvpRowsHtml;
    if (fullProg) fullProg.innerHTML = progRowsHtml;
    if (fullPvp) fullPvp.innerHTML = pvpRowsHtml;
  }

  // ==================== QUESTION VAULT & ALL LEVELS PROGRESS ====================
  renderVault() {
    const q = (document.getElementById('vault-search-input').value || '').toLowerCase().trim();
    const areaF = document.getElementById('vault-filter-area').value;
    const catF = document.getElementById('vault-filter-cat').value;

    const filtered = this.allItemsFlat.filter(it => {
      if (areaF !== 'all' && String(it.area) !== areaF) return false;
      if (catF !== 'all' && it.category !== catF) return false;
      if (q) {
        return `${it.id} ${it.question} ${it.answer} ${it.subtopic} ${it.rationale}`.toLowerCase().includes(q);
      }
      return true;
    });

    const slice = filtered.slice(0, 60);
    document.getElementById('vault-result-count').textContent = `Showing ${slice.length} of ${filtered.length.toLocaleString()} items`;
    document.getElementById('vault-list').innerHTML = slice.map(it => `
      <div class="panel p-4 space-y-1.5">
        <div class="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div class="flex items-center gap-2">
            <span class="font-mono font-bold text-sky-400">#${it.id}</span>
            <span class="px-2 py-0.5 rounded bg-navy-950 border border-blue-900/60 text-slate-300 font-semibold">Area ${it.area} • ${it.levelLabel}</span>
            <span class="text-slate-400">${this.escapeHtml(it.subtopic)}</span>
          </div>
          <button onclick="app.jumpFromVault(${it.area}, ${it.level}, '${it.id}')" class="text-sky-400 hover:underline font-bold">Study This Card →</button>
        </div>
        <div class="text-sm font-bold text-white">${this.escapeHtml(it.question)}</div>
        ${it.images?.length ? `<div class="flex gap-2 pt-1">${it.images.map(s => `<img src="${this.fixAssetPath(s)}" class="max-h-36 rounded bg-white p-1"/>`).join('')}</div>` : ''}
        <div class="text-xs font-bold text-emerald-400">Answer: ${this.escapeHtml(it.answer)}</div>
        ${it.rationale ? `<div class="text-[11px] text-slate-400 whitespace-pre-line">${this.escapeHtml(it.rationale)}</div>` : ''}
      </div>
    `).join('');
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

  renderAllLevelsProgress() {
    const grid = document.getElementById('all-levels-progress-grid');
    let html = '';
    for (const area of this.db.areas) {
      const regItems = this.getRegularItems(area.id);
      const regLevels = Math.ceil(regItems.length / 100);
      for (let lvl = 1; lvl <= regLevels; lvl++) {
        const lst = this.getLevelStats(area.id, lvl);
        const start = (lvl - 1) * 100 + 1;
        const end = Math.min(lvl * 100, regItems.length);
        html += `
          <div onclick="app.showView('dashboard'); app.selectStudyLevel(${area.id}, ${lvl});" class="panel p-3.5 cursor-pointer hover:border-sky-400 transition-all space-y-2">
            <div class="flex justify-between text-xs font-extrabold">
              <span class="text-white">Area ${area.id} • Level ${lvl}</span>
              <span class="font-mono text-sky-300">${lst.pct.toFixed(0)}%</span>
            </div>
            <div class="text-[11px] font-mono text-slate-400">Items ${start} – ${end} (${lst.mastered}/${lst.total})</div>
            <div class="w-full h-2 bg-navy-950 rounded-full overflow-hidden">
              <div class="h-full bg-gradient-to-r from-sky-500 to-emerald-400 rounded-full" style="width: ${lst.pct}%"></div>
            </div>
          </div>
        `;
      }
      const ps = this.getPsStats(area.id);
      if (ps.total > 0) {
        html += `
          <div onclick="app.openProblemSolvingMode(${area.id});" class="panel p-3.5 cursor-pointer border border-amber-500/40 hover:border-amber-400 transition-all space-y-2">
            <div class="flex justify-between text-xs font-extrabold">
              <span class="text-amber-300">🧮 Area-${area.id} Level (PS)</span>
              <span class="font-mono text-amber-300">${ps.pct.toFixed(0)}%</span>
            </div>
            <div class="text-[11px] font-mono text-slate-400">Problem Solving Only (${ps.mastered}/${ps.total})</div>
            <div class="w-full h-2 bg-navy-950 rounded-full overflow-hidden">
              <div class="h-full bg-gradient-to-r from-amber-500 to-orange-400 rounded-full" style="width: ${ps.pct}%"></div>
            </div>
          </div>
        `;
      }
    }
    grid.innerHTML = html;
  }

  // ==================== GLOBAL CHAT & FEEDBACK / SUGGESTIONS ====================
  async loadGlobalChat() {
    const box = document.getElementById('global-chat-messages');
    if (!box) return;
    try {
      const res = await this.apiCall('POST', { action: 'chat_list' });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.messages)) return;
      this.renderGlobalChat(data.messages);
    } catch (e) {}
  }

  renderGlobalChat(messages) {
    const box = document.getElementById('global-chat-messages');
    if (!box) return;
    if (!messages || messages.length === 0) {
      box.innerHTML = `<div class="text-slate-500 text-[10px] text-center py-6">No messages yet. Say hi! 👋</div>`;
      return;
    }
    const wasNearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
    box.innerHTML = messages.map(m => {
      const badge = m.isOwner
        ? `<span class="px-1 py-0.2 rounded bg-amber-400 text-navy-950 font-black text-[8px]">OWNER</span>`
        : (m.title ? `<span class="px-1 rounded bg-sky-500/20 text-sky-300 font-bold text-[8px]">${this.escapeHtml(m.title)}</span>` : '');
      return `
        <div class="bg-navy-950/75 border border-blue-900/35 rounded-lg px-2 py-1.5 leading-snug">
          <div class="flex items-center gap-1 flex-wrap">
            <span class="font-bold ${m.isOwner ? 'text-amber-300' : 'text-emerald-300'} text-[10px]">${this.escapeHtml(m.name)}</span>
            ${badge}
          </div>
          <div class="text-slate-200 text-[11px] break-words mt-0.5">${this.escapeHtml(m.text)}</div>
        </div>
      `;
    }).join('');
    if (wasNearBottom) box.scrollTop = box.scrollHeight;
  }

  async sendGlobalChat() {
    const inp = document.getElementById('global-chat-input');
    if (!inp) return;
    const text = (inp.value || '').trim();
    if (!text) return;
    if (!this.user.loggedIn || !this.user.name) {
      alert('Please sign in first to chat.');
      return;
    }
    inp.value = '';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.adminPasscode) headers['x-admin-passcode'] = this.adminPasscode;
      const res = await this.apiCall('POST', { action: 'chat_send', id: this.user.id, name: this.user.name, text });
      const data = await res.json();
      if (res.ok && Array.isArray(data.messages)) {
        this.renderGlobalChat(data.messages);
        const box = document.getElementById('global-chat-messages');
        if (box) box.scrollTop = box.scrollHeight;
      }
    } catch (e) {}
  }

  async adminClearChat() {
    if (!confirm('Clear all Global Chat messages?')) return;
    await this.apiCall('POST', { action: 'admin_clear_chat' });
    await this.loadGlobalChat();
    alert('🧹 Global Chat cleared!');
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
        st.textContent = '✅ Sent to the Owner! Thank you for helping improve Project Bayaw App.';
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
    const box = document.getElementById('admin-feedback-list');
    if (!box || !this.adminPasscode) return;
    try {
      const res = await this.apiCall('POST', { action: 'admin_list_feedback' });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.feedback) || data.feedback.length === 0) {
        box.innerHTML = `<div class="text-xs text-slate-400 py-2">No reviewee feedback or suggestions yet.</div>`;
        return;
      }
      box.innerHTML = data.feedback.map(f => `
        <div class="bg-navy-950 border border-teal-500/30 rounded-xl p-3 flex items-start justify-between gap-3">
          <div class="space-y-1">
            <div class="flex items-center gap-2 text-[11px]">
              <span class="font-bold text-white">${this.escapeHtml(f.name)}</span>
              <span class="px-2 py-0.5 rounded bg-teal-500/20 text-teal-300 font-bold text-[10px]">${this.escapeHtml(f.category)}</span>
              <span class="text-slate-500 font-mono text-[10px]">${new Date(f.createdAt).toLocaleDateString()}</span>
            </div>
            <div class="text-xs text-slate-200 whitespace-pre-line">${this.escapeHtml(f.message)}</div>
          </div>
          <button onclick="app.adminDeleteFeedback('${f.id}')" class="px-2 py-1 rounded bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 text-[10px] font-bold shrink-0">Delete</button>
        </div>
      `).join('');
    } catch (e) {}
  }

  async adminDeleteFeedback(feedbackId) {
    await this.apiCall('POST', { action: 'admin_delete_feedback', feedbackId });
    await this.loadAdminFeedback();
  }

  escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

const app = new AgriBoardApp();
window.addEventListener('DOMContentLoaded', () => app.init());
