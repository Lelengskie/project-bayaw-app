// Project Bayaw App — Official PRC ABELE TOS-Weighted Mock Exam Simulator (RA 10915)
(function() {
  const MOCK_SESSION_KEY = 'bayaw_mock_active_session_v1';
  const MOCK_RUN_KEY = 'bayaw_mock_board_run_v1';
  const MOCK_HISTORY_KEY = 'bayaw_mock_history_v1';

  const PRC_AREAS = {
    1: {
      id: 1,
      short: 'Area 1',
      title: 'AB Power, Energy, Machinery & Allied Subjects',
      weight: 0.32,
      weightPct: 32,
      fullHours: 4,
      quickHours: 2,
      color: 'sky',
      tos: [
        { code: '1.1', label: '1.1 AB Power Engineering', fullQuota: 28 },
        { code: '1.2', label: '1.2 AB Mechanization Planning, Operation & Mfg', fullQuota: 32 },
        { code: '1.3', label: '1.3 Machinery Specs, Testing & Evaluation (PAES)', fullQuota: 15 },
        { code: '1.4', label: '1.4 Automation, Instrumentation & Controls', fullQuota: 8 },
        { code: '1.5', label: '1.5 Project Mgmt, Feasibility, R&D & Info Systems', fullQuota: 8 },
        { code: '1.6', label: '1.6 Laws, Professional Standards & Ethics', fullQuota: 9 }
      ]
    },
    2: {
      id: 2,
      short: 'Area 2',
      title: 'Land & Water Resources Engineering & Allied Subjects',
      weight: 0.32,
      weightPct: 32,
      fullHours: 5,
      quickHours: 2.5,
      color: 'emerald',
      tos: [
        { code: '2.1', label: '2.1 Hydrology', fullQuota: 20 },
        { code: '2.2', label: '2.2 Irrigation & Drainage Engineering', fullQuota: 38 },
        { code: '2.3', label: '2.3 Soil & Water Conservation Engineering', fullQuota: 12 },
        { code: '2.4', label: '2.4 Aquaculture Engineering', fullQuota: 6 },
        { code: '2.5', label: '2.5 Fundamentals of Agri, Fishery & Env. Sciences', fullQuota: 12 },
        { code: '2.6', label: '2.6 Mathematics & Basic Engineering', fullQuota: 12 }
      ]
    },
    3: {
      id: 3,
      short: 'Area 3',
      title: 'AB Structures, Environment, Bioprocess & Allied Subjects',
      weight: 0.36,
      weightPct: 36,
      fullHours: 6,
      quickHours: 3,
      color: 'purple',
      tos: [
        { code: '3.1', label: '3.1 Agricultural Buildings & Structures', fullQuota: 30 },
        { code: '3.2', label: '3.2 Farm Electrification', fullQuota: 18 },
        { code: '3.3', label: '3.3 Environment Engineering & Waste Mgmt', fullQuota: 12 },
        { code: '3.4', label: '3.4 Agricultural & Bioprocess Engineering', fullQuota: 30 },
        { code: '3.5', label: '3.5 Food Engineering', fullQuota: 10 }
      ]
    }
  };

  function shuffleArr(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function extractTosCode(item, areaId) {
    const raw = String(item.subtopic || '');
    const m = raw.match(/^(\d+\.\d+)/);
    if (m) {
      const code = m[1];
      if (code === '1.0') return '1.6';
      if (code === '2.0') return '2.2';
      if (code === '3.0') return '3.4';
      return code;
    }
    return `${areaId}.1`;
  }

  function normChoiceBase(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^a-z0-9]/g, '');
  }

  function extractLawOrCode(s) {
    const m = String(s || '').match(/\b(?:r\.?\s*a\.?|p\.?\s*d\.?|pns|paes|eo)\s*[-#.]?\s*(\d{2,6})\b/i);
    return m ? m[1] : '';
  }

  function isTooSimilarChoice(a, b) {
    const na = normChoiceBase(a);
    const nb = normChoiceBase(b);
    if (!na || !nb) return true;
    if (na === nb) return true;
    if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
    const la = extractLawOrCode(a);
    const lb = extractLawOrCode(b);
    if (la && lb && la === lb) return true;
    return false;
  }

  function formatHMS(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  window.bayawMock = {
    fullMockAccess: false,
    strictMode: true,
    paused: false,
    activeSession: null, // { areaId, tier: 'quick'|'full', isBoardRun, strictMode, items: [{id, tosCode, isPs, choices, correctIdx}], answers: {}, flags: {}, idx: 0, remainingSec, totalSec, startedAt }
    timerInterval: null,
    boardRun: null, // { runId, startedAt, areas: { 1: null|res, 2: null|res, 3: null|res } }
    history: [],
    lastResult: null,
    reviewFilter: 'missed', // 'missed' | 'flagged' | 'all'

    hasFullAccess() {
      return !!(window.app?.user?.isOwner || this.fullMockAccess);
    },

    loadLocalState() {
      try {
        const s = localStorage.getItem(MOCK_SESSION_KEY);
        if (s) this.activeSession = JSON.parse(s);
      } catch (e) {}
      try {
        const r = localStorage.getItem(MOCK_RUN_KEY);
        if (r) this.boardRun = JSON.parse(r);
      } catch (e) {}
      try {
        const h = localStorage.getItem(MOCK_HISTORY_KEY);
        if (h) this.history = JSON.parse(h);
      } catch (e) {}
    },

    saveLocalSession() {
      try {
        if (this.activeSession) localStorage.setItem(MOCK_SESSION_KEY, JSON.stringify(this.activeSession));
        else localStorage.removeItem(MOCK_SESSION_KEY);
      } catch (e) {}
    },

    saveBoardRun() {
      try {
        if (this.boardRun) localStorage.setItem(MOCK_RUN_KEY, JSON.stringify(this.boardRun));
        else localStorage.removeItem(MOCK_RUN_KEY);
      } catch (e) {}
    },

    saveHistory() {
      try {
        localStorage.setItem(MOCK_HISTORY_KEY, JSON.stringify(this.history.slice(0, 30)));
      } catch (e) {}
      if (window.app?.user?.loggedIn && window.app?.user?.usernameKey) {
        window.app.apiCall('POST', {
          action: 'save_mock_history',
          usernameKey: window.app.user.usernameKey,
          mockHistory: this.history.slice(0, 30)
        }).catch(() => {});
      }
    },

    async openLobby() {
      this.loadLocalState();
      this.stopTimer();
      window.app.showView('mock-exam');
      document.getElementById('mock-lobby-panel')?.classList.remove('hidden');
      document.getElementById('mock-arena-panel')?.classList.add('hidden');
      document.getElementById('mock-results-panel')?.classList.add('hidden');

      // Live-check Owner-granted Full Mock Access from Supabase!
      if (window.app?.user?.loggedIn && window.app?.user?.usernameKey) {
        try {
          const res = await window.app.apiCall('POST', {
            action: 'get_mock_access',
            usernameKey: window.app.user.usernameKey
          });
          if (res.ok) {
            const data = await res.json();
            this.fullMockAccess = !!data.fullMockAccess;
            if (Array.isArray(data.mockHistory) && data.mockHistory.length > this.history.length) {
              this.history = data.mockHistory;
              try { localStorage.setItem(MOCK_HISTORY_KEY, JSON.stringify(this.history.slice(0, 30))); } catch (e) {}
            }
          }
        } catch (e) {}
      }
      this.renderLobby();
    },

    toggleStrictMode(isStrict) {
      this.strictMode = !!isStrict;
      this.renderLobby();
    },

    renderLobby() {
      const unlocked = this.hasFullAccess();
      const esc = (s) => window.app.escapeHtml(s);

      // Update access badge
      const badge = document.getElementById('mock-access-badge');
      if (badge) {
        if (window.app?.user?.isOwner) {
          badge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-400/50 text-[11px] font-black text-amber-300';
          badge.textContent = '👑 OWNER — Full 100-Item PRC Board Exam Unlocked';
        } else if (unlocked) {
          badge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/50 text-[11px] font-black text-emerald-300';
          badge.textContent = '✅ FULL BOARD MOCK UNLOCKED (Owner Granted)';
        } else {
          badge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-sky-500/20 border border-sky-400/45 text-[11px] font-extrabold text-sky-200';
          badge.textContent = '⚡ 50-Item Quick Mocks FREE • Full 100-Item Board Mock is Owner-Granted';
        }
      }

      // Strict vs Practice mode buttons
      const bStrict = document.getElementById('mock-mode-strict');
      const bPrac = document.getElementById('mock-mode-practice');
      if (bStrict && bPrac) {
        bStrict.className = this.strictMode
          ? 'px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-extrabold shadow'
          : 'px-3 py-1.5 rounded-lg bg-navy-900 border border-blue-900/50 text-slate-300 text-xs font-bold';
        bPrac.className = !this.strictMode
          ? 'px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-extrabold shadow'
          : 'px-3 py-1.5 rounded-lg bg-navy-900 border border-blue-900/50 text-slate-300 text-xs font-bold';
      }

      // Resume unfinished exam banner
      const resumeBox = document.getElementById('mock-resume-banner');
      if (resumeBox) {
        if (this.activeSession && this.activeSession.items?.length) {
          const s = this.activeSession;
          const a = PRC_AREAS[s.areaId];
          const answered = Object.keys(s.answers || {}).length;
          resumeBox.classList.remove('hidden');
          resumeBox.innerHTML = `
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div class="text-xs font-extrabold text-amber-300">⏸️ Unfinished Exam Auto-Saved!</div>
                <div class="text-xs text-slate-200 mt-0.5">
                  <strong>${a.short} (${s.tier === 'full' ? '100-Item Full' : '50-Item Quick'})</strong> • Answered ${answered}/${s.items.length} • Time Left: <span class="font-mono text-amber-300">${formatHMS(s.remainingSec)}</span>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button onclick="bayawMock.resumeSession()" class="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-navy-950 text-xs font-black shadow">▶ Resume Exam</button>
                <button onclick="bayawMock.discardSession()" class="px-3 py-2 rounded-xl bg-rose-950/70 hover:bg-rose-900 border border-rose-500/40 text-rose-200 text-xs font-bold">Discard</button>
              </div>
            </div>
          `;
        } else {
          resumeBox.classList.add('hidden');
        }
      }

      // Render FREE 50-Item Quick Mock Cards
      const quickGrid = document.getElementById('mock-quick-grid');
      if (quickGrid) {
        quickGrid.innerHTML = [1, 2, 3].map(id => {
          const a = PRC_AREAS[id];
          return `
            <div class="panel p-4 border border-${a.color}-500/35 flex flex-col justify-between gap-3">
              <div class="space-y-1.5">
                <div class="flex items-center justify-between">
                  <span class="px-2 py-0.5 rounded bg-${a.color}-500/20 text-${a.color}-300 text-[10px] font-black uppercase">${a.short} • ${a.weightPct}% Weight</span>
                  <span class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-black">FREE</span>
                </div>
                <div class="text-sm font-extrabold text-white leading-snug">${a.title}</div>
                <div class="text-[11px] text-slate-400 font-mono">50 PRC TOS-Weighted Items • ${a.quickHours} hrs</div>
              </div>
              <button onclick="bayawMock.startExam(${id}, 'quick', false)" class="w-full py-2.5 rounded-xl bg-gradient-to-r from-${a.color}-600 to-blue-600 hover:brightness-110 text-white text-xs font-extrabold shadow">
                ⚡ Start 50-Item ${a.short} Mock
              </button>
            </div>
          `;
        }).join('');
      }

      // Render FULL 100-Item PRC Board Exam & 3-Area Run Panel
      const fullPanel = document.getElementById('mock-full-panel');
      if (fullPanel) {
        if (!unlocked) {
          fullPanel.innerHTML = `
            <div class="rounded-2xl bg-navy-950/90 border border-amber-500/40 p-6 text-center space-y-3">
              <div class="text-3xl">🔒</div>
              <h3 class="text-base font-extrabold text-amber-300">Full 100-Item PRC Board Exam & Official 3-Area GWA Run</h3>
              <p class="text-xs text-slate-300 max-w-xl mx-auto leading-relaxed">
                Includes full <strong>100-item PRC TOS-weighted Area 1 (4h), Area 2 (5h), and Area 3 (6h)</strong> exams, multi-session <strong>3-Area Official Board Run</strong>, automated <strong>PRC GWA Grading (32% / 32% / 36% • ≥70% Passing & ≥50% Floor)</strong>, and your <strong>Shareable PRC Report of Rating Card</strong>.
              </p>
              <div class="inline-block px-4 py-2 rounded-xl bg-amber-500/15 border border-amber-400/40 text-xs font-bold text-amber-200">
                👑 Ask the Owner (Bryan) to grant you Full Mock Exam access from the Owner Panel!
              </div>
            </div>
          `;
        } else {
          const run = this.boardRun;
          const r1 = run?.areas?.[1];
          const r2 = run?.areas?.[2];
          const r3 = run?.areas?.[3];
          const doneCnt = [r1, r2, r3].filter(Boolean).length;
          let gwaHtml = '';
          if (doneCnt === 3) {
            const gwa = (r1.pct * 0.32) + (r2.pct * 0.32) + (r3.pct * 0.36);
            const floorFail = r1.pct < 50 || r2.pct < 50 || r3.pct < 50;
            const passed = gwa >= 70 && !floorFail;
            gwaHtml = `
              <div class="rounded-xl p-4 border ${passed ? 'bg-emerald-950/50 border-emerald-400/50' : 'bg-rose-950/45 border-rose-400/50'} flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div class="text-[11px] font-black uppercase tracking-wider ${passed ? 'text-emerald-300' : 'text-rose-300'}">
                    ${passed ? '🎉 OFFICIAL PRC BOARD RUN: PASSED!' : (floorFail && gwa >= 70 ? '⚠️ FAILED — SUBJECT BELOW 50% FLOOR' : '❌ OFFICIAL PRC BOARD RUN: FAILED')}
                  </div>
                  <div class="text-2xl font-black font-mono text-white mt-0.5">GWA: ${gwa.toFixed(2)}%</div>
                  <div class="text-[11px] text-slate-300">Area 1: ${r1.pct.toFixed(1)}% (×0.32) • Area 2: ${r2.pct.toFixed(1)}% (×0.32) • Area 3: ${r3.pct.toFixed(1)}% (×0.36)</div>
                </div>
                <div class="flex items-center gap-2">
                  <button onclick="bayawMock.openBoardRunReport()" class="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-navy-950 text-xs font-black shadow">📜 View PRC Rating Card</button>
                  <button onclick="bayawMock.resetBoardRun()" class="px-3 py-2 rounded-xl bg-navy-800 hover:bg-navy-700 text-slate-200 text-xs font-bold">New Board Run</button>
                </div>
              </div>
            `;
          }

          fullPanel.innerHTML = `
            <div class="space-y-4">
              ${gwaHtml}
              <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                ${[1, 2, 3].map(id => {
                  const a = PRC_AREAS[id];
                  const done = run?.areas?.[id];
                  return `
                    <div class="rounded-xl bg-navy-950/85 border ${done ? 'border-emerald-500/50' : 'border-amber-500/35'} p-4 flex flex-col justify-between gap-3">
                      <div class="space-y-1.5">
                        <div class="flex items-center justify-between">
                          <span class="text-xs font-black text-amber-300">${a.short} (${a.weightPct}%)</span>
                          ${done
                            ? `<span class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-black">✅ ${done.pct.toFixed(1)}%</span>`
                            : `<span class="text-[10px] font-mono text-slate-400">100 items • ${a.fullHours}h</span>`}
                        </div>
                        <div class="text-xs font-bold text-white leading-snug">${a.title}</div>
                        <div class="text-[10px] text-slate-400">
                          ${a.tos.map(t => `${t.code} (${t.fullQuota})`).join(' • ')}
                        </div>
                      </div>
                      <button onclick="bayawMock.startExam(${id}, 'full', true)" class="w-full py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:brightness-110 text-navy-950 text-xs font-black shadow">
                        ${done ? `↻ Retake 100-Item ${a.short}` : `🏆 Start 100-Item ${a.short}`}
                      </button>
                    </div>
                  `;
                }).join('')}
              </div>
              <div class="flex items-center justify-between text-[11px] text-slate-400">
                <span>Board Run Progress: <strong class="text-white">${doneCnt} / 3 Areas Completed</strong> (take each Area on your own schedule — auto-saved!)</span>
                ${doneCnt > 0 ? `<button onclick="bayawMock.resetBoardRun()" class="text-rose-300 hover:text-rose-200 font-bold">Reset 3-Area Run</button>` : ''}
              </div>
            </div>
          `;
        }
      }

      // Render Attempt History
      const histBox = document.getElementById('mock-history-list');
      if (histBox) {
        if (!this.history.length) {
          histBox.innerHTML = `<div class="text-xs text-slate-400 py-2">No mock exams completed yet. Take a Free 50-Item Quick Mock above to see your first PRC TOS diagnostic!</div>`;
        } else {
          histBox.innerHTML = this.history.slice(0, 12).map(h => {
            const passed = h.pct >= 70;
            const floor = h.pct < 50;
            const dt = new Date(h.date || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return `
              <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-navy-950/80 border border-blue-900/40 px-3.5 py-2.5 text-xs">
                <div class="flex items-center gap-2">
                  <span class="px-2 py-0.5 rounded font-black text-[10px] ${passed ? 'bg-emerald-500/20 text-emerald-300' : (floor ? 'bg-rose-600/30 text-rose-200' : 'bg-amber-500/20 text-amber-300')}">
                    ${h.pct.toFixed(1)}%
                  </span>
                  <span class="font-bold text-white">${esc(h.label)}</span>
                  <span class="text-[11px] text-slate-400 font-mono">(${h.correct}/${h.total})</span>
                </div>
                <span class="text-[10px] text-slate-400 font-mono">${dt}</span>
              </div>
            `;
          }).join('');
        }
      }
    },

    buildTosExamItems(areaId, tier) {
      const cfg = PRC_AREAS[areaId];
      const targetTotal = tier === 'full' ? 100 : 50;
      const areaObj = window.app.db.areas.find(a => a.id === areaId);
      if (!areaObj || !areaObj.items?.length) return [];

      const allAreaItems = areaObj.items;
      const byTos = {};
      for (const t of cfg.tos) byTos[t.code] = { reg: [], ps: [] };

      for (const it of allAreaItems) {
        const code = extractTosCode(it, areaId);
        const bucket = byTos[code] || byTos[cfg.tos[0].code];
        if (it.category === 'problem_solving') bucket.ps.push(it);
        else bucket.reg.push(it);
      }

      const selected = [];
      const usedIds = new Set();

      // Prioritize unseen / unmastered items slightly while keeping randomness fresh
      const srs = window.app?.user?.srs || {};
      const sortFreshFirst = (list) => {
        const unseen = shuffleArr(list.filter(x => !srs[x.id]));
        const seen = shuffleArr(list.filter(x => !!srs[x.id]));
        return [...unseen, ...seen];
      };

      // Draw exact PRC TOS quotas (proportional for 50-item quick mock)
      for (const t of cfg.tos) {
        const quota = tier === 'full' ? t.fullQuota : Math.max(1, Math.round(t.fullQuota / 2));
        const b = byTos[t.code];
        const psPool = sortFreshFirst(b.ps);
        const regPool = sortFreshFirst(b.reg);

        // Aim for ~25-30% PS within each sub-subject when available
        const psTarget = Math.min(psPool.length, Math.round(quota * 0.28));
        const pickedHere = [];

        for (let i = 0; i < psTarget && pickedHere.length < quota; i++) {
          if (!usedIds.has(psPool[i].id)) {
            usedIds.add(psPool[i].id);
            pickedHere.push(psPool[i]);
          }
        }
        for (const it of regPool) {
          if (pickedHere.length >= quota) break;
          if (!usedIds.has(it.id)) {
            usedIds.add(it.id);
            pickedHere.push(it);
          }
        }
        // Fallback if regPool was smaller than remaining quota
        for (const it of psPool) {
          if (pickedHere.length >= quota) break;
          if (!usedIds.has(it.id)) {
            usedIds.add(it.id);
            pickedHere.push(it);
          }
        }
        selected.push(...pickedHere);
      }

      // Top up or trim to exact targetTotal (50 or 100)
      if (selected.length < targetTotal) {
        const rem = sortFreshFirst(allAreaItems.filter(x => !usedIds.has(x.id)));
        for (const it of rem) {
          if (selected.length >= targetTotal) break;
          usedIds.add(it.id);
          selected.push(it);
        }
      }
      const finalItems = shuffleArr(selected.slice(0, targetTotal));

      // Build 4-option MCQ choices for every item
      const distractorPool = allAreaItems
        .map(x => String(x.answer || '').trim())
        .filter(a => a && a.length <= 140);

      return finalItems.map(it => {
        const ans = String(it.answer || '').trim();
        let choices = [];
        if (Array.isArray(it.choices) && it.choices.length >= 2) {
          const clean = [];
          for (const rawC of it.choices) {
            const c = String(rawC || '').trim();
            if (c && !clean.some(prev => isTooSimilarChoice(prev, c))) clean.push(c);
          }
          const hasAns = clean.some(c => c.toLowerCase() === ans.toLowerCase());
          choices = hasAns ? clean.slice(0, 4) : [ans, ...clean.filter(c => !isTooSimilarChoice(c, ans)).slice(0, 3)];
        } else {
          // Pick 3 unique, non-equivalent distractors from same subtopic first, then same area
          const sameSub = shuffleArr(allAreaItems.filter(x => x.id !== it.id && x.subtopic === it.subtopic && x.answer));
          const wrongs = [];
          const pickedAll = [ans];
          const canAdd = (txt) => txt && txt.length <= 140 && !pickedAll.some(p => isTooSimilarChoice(p, txt));

          for (const cand of sameSub) {
            const txt = String(cand.answer).trim();
            if (canAdd(txt)) {
              pickedAll.push(txt);
              wrongs.push(txt);
              if (wrongs.length === 3) break;
            }
          }
          if (wrongs.length < 3) {
            for (const txt of shuffleArr(distractorPool)) {
              if (canAdd(txt)) {
                pickedAll.push(txt);
                wrongs.push(txt);
                if (wrongs.length === 3) break;
              }
            }
          }
          choices = [ans, ...wrongs];
        }
        const sh = shuffleArr(choices);
        let correctIdx = sh.findIndex(c => c.toLowerCase() === ans.toLowerCase());
        if (correctIdx < 0) correctIdx = 0;

        return {
          id: it.id,
          tosCode: extractTosCode(it, areaId),
          isPs: it.category === 'problem_solving',
          choices: sh,
          correctIdx
        };
      });
    },

    startExam(areaId, tier = 'quick', isBoardRun = false) {
      if (tier === 'full' && !this.hasFullAccess()) {
        alert('🔒 Full 100-Item PRC Board Exam is Owner-Granted. Ask Bryan in Global Chat or Messenger to unlock it for your account!');
        return;
      }
      if (this.activeSession && this.activeSession.items?.length) {
        if (!confirm('You have an unfinished mock exam auto-saved. Start a brand new one and replace it?')) return;
      }
      const cfg = PRC_AREAS[areaId];
      const items = this.buildTosExamItems(areaId, tier);
      if (!items.length) {
        alert('Question bank is still loading. Please wait a moment and try again.');
        return;
      }
      const totalSec = Math.round((tier === 'full' ? cfg.fullHours : cfg.quickHours) * 3600);
      this.activeSession = {
        areaId,
        tier,
        isBoardRun: !!isBoardRun,
        strictMode: this.strictMode,
        items,
        answers: {},
        flags: {},
        idx: 0,
        remainingSec: totalSec,
        totalSec,
        startedAt: Date.now()
      };
      this.paused = false;
      this.saveLocalSession();
      this.enterArena();
    },

    resumeSession() {
      if (!this.activeSession || !this.activeSession.items?.length) return;
      this.paused = false;
      this.enterArena();
    },

    discardSession() {
      if (!confirm('Discard your unfinished mock exam?')) return;
      this.stopTimer();
      this.activeSession = null;
      this.saveLocalSession();
      this.renderLobby();
    },

    enterArena() {
      document.getElementById('mock-lobby-panel')?.classList.add('hidden');
      document.getElementById('mock-results-panel')?.classList.add('hidden');
      document.getElementById('mock-arena-panel')?.classList.remove('hidden');

      const s = this.activeSession;
      const cfg = PRC_AREAS[s.areaId];
      const titleEl = document.getElementById('mock-arena-title');
      if (titleEl) {
        titleEl.textContent = `${cfg.short} — ${s.tier === 'full' ? '100-Item Full PRC Board Mock' : '50-Item Quick Mock'} (${cfg.weightPct}%)`;
      }
      const pauseBtn = document.getElementById('mock-pause-btn');
      if (pauseBtn) {
        if (s.strictMode) pauseBtn.classList.add('hidden');
        else {
          pauseBtn.classList.remove('hidden');
          pauseBtn.textContent = '⏸ Pause';
        }
      }

      this.renderArenaQuestion();
      this.startTimer();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    startTimer() {
      this.stopTimer();
      this.updateTimerDisplay();
      this.timerInterval = setInterval(() => {
        if (!this.activeSession || this.paused) return;
        this.activeSession.remainingSec -= 1;
        this.updateTimerDisplay();
        if (this.activeSession.remainingSec % 5 === 0) this.saveLocalSession();
        if (this.activeSession.remainingSec <= 0) {
          this.stopTimer();
          alert('⏱️ Time is up! Submitting your PRC Mock Exam automatically.');
          this.submitExam(true);
        }
      }, 1000);
    },

    stopTimer() {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
    },

    togglePause() {
      if (!this.activeSession || this.activeSession.strictMode) return;
      this.paused = !this.paused;
      const btn = document.getElementById('mock-pause-btn');
      if (btn) btn.textContent = this.paused ? '▶ Resume' : '⏸ Pause';
      const overlay = document.getElementById('mock-pause-overlay');
      if (overlay) overlay.classList.toggle('hidden', !this.paused);
    },

    updateTimerDisplay() {
      const el = document.getElementById('mock-timer-text');
      if (!el || !this.activeSession) return;
      const sec = this.activeSession.remainingSec;
      el.textContent = formatHMS(sec);
      el.className = sec <= 300
        ? 'font-mono text-sm font-black text-rose-400 animate-pulse'
        : (sec <= 900 ? 'font-mono text-sm font-black text-amber-300' : 'font-mono text-sm font-black text-emerald-300');
    },

    getDbItemById(id) {
      return window.app?.allItemsFlat?.find(x => x.id === id) || null;
    },

    renderArenaQuestion() {
      const s = this.activeSession;
      if (!s) return;
      const qObj = s.items[s.idx];
      const dbItem = this.getDbItemById(qObj.id);
      if (!dbItem) return;
      const esc = (t) => window.app.escapeHtml(t);

      const answeredCnt = Object.keys(s.answers).length;
      const progEl = document.getElementById('mock-arena-progress');
      if (progEl) progEl.textContent = `Answered ${answeredCnt} / ${s.items.length}`;

      const metaEl = document.getElementById('mock-q-meta');
      if (metaEl) {
        metaEl.innerHTML = `Question <span class="text-white">${s.idx + 1}</span> / ${s.items.length} • <span class="text-sky-300">TOS ${esc(qObj.tosCode)}</span>${qObj.isPs ? ' • <span class="text-amber-300">🧮 Problem Solving</span>' : ''}`;
      }

      const flagBtn = document.getElementById('mock-flag-btn');
      if (flagBtn) {
        const flagged = !!s.flags[s.idx];
        flagBtn.textContent = flagged ? '🚩 Flagged' : '🏳️ Flag for Review';
        flagBtn.className = flagged
          ? 'px-3 py-1 rounded-lg bg-amber-500/25 border border-amber-400 text-[11px] font-extrabold text-amber-200'
          : 'px-3 py-1 rounded-lg bg-navy-900 border border-blue-900/60 text-[11px] font-bold text-slate-300 hover:text-amber-200';
      }

      const qTextEl = document.getElementById('mock-q-text');
      if (qTextEl) qTextEl.textContent = dbItem.question || '';

      // Never show solution/explanation images during an active exam!
      const imgWrap = document.getElementById('mock-q-images');
      if (imgWrap) {
        imgWrap.classList.add('hidden');
        imgWrap.innerHTML = '';
      }

      const letters = ['A', 'B', 'C', 'D'];
      const picked = s.answers[s.idx];
      const chWrap = document.getElementById('mock-q-choices');
      if (chWrap) {
        chWrap.innerHTML = qObj.choices.map((ch, i) => {
          const active = picked === i;
          return `
            <button onclick="bayawMock.pickChoice(${i})" class="w-full text-left px-4 py-3 rounded-xl border transition-all flex items-start gap-3 ${active ? 'bg-sky-600/30 border-sky-400 text-white shadow-md' : 'bg-navy-950/85 hover:bg-navy-900 border-blue-900/50 text-slate-200'}">
              <span class="w-6 h-6 rounded-lg flex items-center justify-center text-xs font-black shrink-0 ${active ? 'bg-sky-400 text-navy-950' : 'bg-navy-800 text-sky-300'}">${letters[i] || i + 1}</span>
              <span class="text-xs sm:text-sm leading-relaxed">${esc(ch)}</span>
            </button>
          `;
        }).join('');
      }

      // Render Scantron Navigator Grid
      const navGrid = document.getElementById('mock-nav-grid');
      if (navGrid) {
        navGrid.innerHTML = s.items.map((_, i) => {
          const isCur = i === s.idx;
          const isAns = s.answers[i] !== undefined;
          const isFlg = !!s.flags[i];
          let cls = 'bg-navy-950 border-blue-900/50 text-slate-400 hover:text-white';
          if (isFlg) cls = 'bg-amber-500/25 border-amber-400 text-amber-200';
          else if (isAns) cls = 'bg-emerald-600/30 border-emerald-400/70 text-emerald-200';
          if (isCur) cls += ' ring-2 ring-sky-400 text-white font-black';
          return `<button onclick="bayawMock.jumpTo(${i})" class="h-8 rounded-lg border text-[11px] font-mono font-bold transition-all ${cls}">${i + 1}</button>`;
        }).join('');
      }
    },

    pickChoice(choiceIdx) {
      if (!this.activeSession) return;
      this.activeSession.answers[this.activeSession.idx] = choiceIdx;
      this.saveLocalSession();
      this.renderArenaQuestion();
    },

    toggleFlag() {
      if (!this.activeSession) return;
      const i = this.activeSession.idx;
      if (this.activeSession.flags[i]) delete this.activeSession.flags[i];
      else this.activeSession.flags[i] = true;
      this.saveLocalSession();
      this.renderArenaQuestion();
    },

    nav(delta) {
      if (!this.activeSession) return;
      const len = this.activeSession.items.length;
      this.activeSession.idx = (this.activeSession.idx + delta + len) % len;
      this.saveLocalSession();
      this.renderArenaQuestion();
    },

    jumpTo(i) {
      if (!this.activeSession) return;
      this.activeSession.idx = Math.max(0, Math.min(this.activeSession.items.length - 1, i));
      this.saveLocalSession();
      this.renderArenaQuestion();
    },

    exitToLobby() {
      this.stopTimer();
      this.saveLocalSession();
      this.openLobby();
    },

    submitExam(auto = false) {
      const s = this.activeSession;
      if (!s) return;
      const unanswered = s.items.length - Object.keys(s.answers).length;
      if (!auto) {
        const msg = unanswered > 0
          ? `You still have ${unanswered} unanswered item(s). Submit your PRC Mock Exam now?`
          : 'Submit your PRC Mock Exam and compute your official rating?';
        if (!confirm(msg)) return;
      }

      this.stopTimer();
      const cfg = PRC_AREAS[s.areaId];
      let correct = 0;
      const tosStats = {};
      for (const t of cfg.tos) tosStats[t.code] = { label: t.label, correct: 0, total: 0 };

      const details = s.items.map((qObj, i) => {
        const picked = s.answers[i];
        const isCorrect = picked === qObj.correctIdx;
        if (isCorrect) correct += 1;
        if (!tosStats[qObj.tosCode]) tosStats[qObj.tosCode] = { label: qObj.tosCode, correct: 0, total: 0 };
        tosStats[qObj.tosCode].total += 1;
        if (isCorrect) tosStats[qObj.tosCode].correct += 1;
        return {
          idx: i,
          id: qObj.id,
          tosCode: qObj.tosCode,
          isPs: qObj.isPs,
          choices: qObj.choices,
          correctIdx: qObj.correctIdx,
          picked,
          isCorrect,
          flagged: !!s.flags[i]
        };
      });

      const total = s.items.length;
      const pct = total ? (correct / total) * 100 : 0;
      const elapsedSec = Math.max(1, s.totalSec - s.remainingSec);

      const result = {
        areaId: s.areaId,
        tier: s.tier,
        label: `${cfg.short} (${s.tier === 'full' ? '100-Item Full' : '50-Item Quick'})`,
        correct,
        total,
        pct,
        elapsedSec,
        tosStats,
        details,
        date: Date.now()
      };

      // Record in history
      this.history.unshift({
        areaId: result.areaId,
        tier: result.tier,
        label: result.label,
        correct: result.correct,
        total: result.total,
        pct: result.pct,
        date: result.date
      });
      this.saveHistory();

      // If part of Full 3-Area Board Run, save this Area score into boardRun
      if (s.tier === 'full' && s.isBoardRun) {
        if (!this.boardRun) {
          this.boardRun = { runId: 'run_' + Date.now(), startedAt: Date.now(), areas: { 1: null, 2: null, 3: null } };
        }
        this.boardRun.areas[s.areaId] = {
          correct: result.correct,
          total: result.total,
          pct: result.pct,
          date: result.date
        };
        this.saveBoardRun();
      }

      this.lastResult = result;
      this.activeSession = null;
      this.saveLocalSession();
      this.reviewFilter = 'missed';
      this.renderResults();
    },

    resetBoardRun() {
      if (!confirm('Start a fresh 3-Area PRC Board Exam Run?')) return;
      this.boardRun = null;
      this.saveBoardRun();
      this.renderLobby();
    },

    openBoardRunReport() {
      if (!this.boardRun) return;
      const r1 = this.boardRun.areas?.[1];
      const r2 = this.boardRun.areas?.[2];
      const r3 = this.boardRun.areas?.[3];
      if (!r1 || !r2 || !r3) return;
      const gwa = (r1.pct * 0.32) + (r2.pct * 0.32) + (r3.pct * 0.36);
      const floorFail = r1.pct < 50 || r2.pct < 50 || r3.pct < 50;
      const passed = gwa >= 70 && !floorFail;
      this.lastResult = {
        isBoardSummary: true,
        gwa,
        passed,
        floorFail,
        r1, r2, r3,
        date: Date.now()
      };
      this.renderResults();
    },

    setReviewFilter(f) {
      this.reviewFilter = f;
      this.renderReviewList();
    },

    renderResults() {
      document.getElementById('mock-lobby-panel')?.classList.add('hidden');
      document.getElementById('mock-arena-panel')?.classList.add('hidden');
      document.getElementById('mock-results-panel')?.classList.remove('hidden');

      const res = this.lastResult;
      if (!res) return;
      const esc = (t) => window.app.escapeHtml(t);
      const userName = esc(window.app?.user?.name || 'ABELE Reviewee');

      const cardEl = document.getElementById('mock-result-scorecard');
      const tosEl = document.getElementById('mock-result-tos');
      const revSection = document.getElementById('mock-result-review-section');

      if (res.isBoardSummary) {
        const verdictText = res.passed
          ? 'PASSED — PRC ABELE STANDARD MET'
          : (res.floorFail && res.gwa >= 70 ? 'FAILED — SUBJECT BELOW 50% FLOOR' : 'FAILED — BELOW 70% GWA');
        cardEl.innerHTML = `
          <div class="space-y-4">
            <div class="text-[11px] font-black uppercase tracking-widest text-amber-300">Official PRC-Style Mock Report of Rating • RA 10915</div>
            <div class="text-sm font-bold text-slate-300">Examinee: <span class="text-white">${userName}</span></div>
            <div class="inline-block px-4 py-1.5 rounded-full text-xs font-black ${res.passed ? 'bg-emerald-500/25 border border-emerald-400 text-emerald-200' : 'bg-rose-500/25 border border-rose-400 text-rose-200'}">
              ${res.passed ? '✅' : '❌'} ${verdictText}
            </div>
            <div class="text-4xl sm:text-5xl font-black font-mono text-white">${res.gwa.toFixed(2)}%</div>
            <div class="text-xs text-slate-400">General Weighted Average (Passing: ≥ 70.00% • Subject Floor: ≥ 50.00%)</div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl mx-auto pt-2 text-left">
              ${[
                { n: 'Area 1 (32%)', r: res.r1 },
                { n: 'Area 2 (32%)', r: res.r2 },
                { n: 'Area 3 (36%)', r: res.r3 }
              ].map(x => `
                <div class="rounded-xl bg-navy-950/90 border ${x.r.pct < 50 ? 'border-rose-500/60' : (x.r.pct >= 70 ? 'border-emerald-500/50' : 'border-amber-500/40')} p-3">
                  <div class="text-[11px] font-bold text-slate-400">${x.n}</div>
                  <div class="text-xl font-black font-mono ${x.r.pct < 50 ? 'text-rose-400' : (x.r.pct >= 70 ? 'text-emerald-300' : 'text-amber-300')}">${x.r.pct.toFixed(2)}%</div>
                  <div class="text-[10px] text-slate-400 font-mono">${x.r.correct}/${x.r.total} correct</div>
                </div>
              `).join('')}
            </div>
            <div class="text-[10px] font-mono text-slate-500 pt-2">Verified on project-bayaw-app.site • Screenshot & share your board readiness!</div>
          </div>
        `;
        if (tosEl) tosEl.innerHTML = '';
        if (revSection) revSection.classList.add('hidden');
        return;
      }

      const passed = res.pct >= 70;
      const belowFloor = res.pct < 50;
      const badgeCls = passed
        ? 'bg-emerald-500/25 border border-emerald-400 text-emerald-200'
        : (belowFloor ? 'bg-rose-600/30 border border-rose-400 text-rose-200' : 'bg-amber-500/20 border border-amber-400 text-amber-200');
      const verdictTxt = passed
        ? '✅ PASSED AREA (≥ 70% PRC Target)'
        : (belowFloor ? '⚠️ BELOW 50% PRC FLOOR (DISQUALIFYING IN REAL BOARD)' : '🟡 ABOVE 50% FLOOR — PUSH TO 70%!');

      cardEl.innerHTML = `
        <div class="space-y-3">
          <div class="text-[11px] font-black uppercase tracking-widest text-sky-300">${esc(res.label)} • ${userName}</div>
          <div class="inline-block px-4 py-1.5 rounded-full text-xs font-black ${badgeCls}">${verdictTxt}</div>
          <div class="text-4xl sm:text-5xl font-black font-mono text-white">${res.pct.toFixed(2)}%</div>
          <div class="text-xs text-slate-300 font-mono">
            Score: <strong>${res.correct} / ${res.total}</strong> • Time Used: <strong>${formatHMS(res.elapsedSec)}</strong>
          </div>
          <div class="text-[10px] font-mono text-slate-500 pt-1">project-bayaw-app.site • PRC ABELE TOS Mock Simulator</div>
        </div>
      `;

      // Per-TOS Sub-Subject Diagnostic Bars
      if (tosEl) {
        const rows = Object.values(res.tosStats).filter(x => x.total > 0);
        tosEl.innerHTML = `
          <div class="panel p-5 space-y-3 border border-sky-500/30">
            <h3 class="text-sm font-extrabold text-white">📊 PRC TOS Sub-Subject Diagnostic Breakdown</h3>
            <div class="space-y-2.5">
              ${rows.map(r => {
                const p = Math.round((r.correct / r.total) * 100);
                const barCls = p >= 70 ? 'bg-emerald-500' : (p < 50 ? 'bg-rose-500' : 'bg-amber-400');
                const txtCls = p >= 70 ? 'text-emerald-300' : (p < 50 ? 'text-rose-300' : 'text-amber-300');
                return `
                  <div class="space-y-1">
                    <div class="flex items-center justify-between text-xs">
                      <span class="font-semibold text-slate-200">${esc(r.label)}</span>
                      <span class="font-mono font-extrabold ${txtCls}">${r.correct}/${r.total} (${p}%)</span>
                    </div>
                    <div class="w-full h-2 rounded-full bg-navy-950 overflow-hidden">
                      <div class="h-full ${barCls} rounded-full" style="width:${p}%"></div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }

      if (revSection) revSection.classList.remove('hidden');
      this.renderReviewList();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    renderReviewList() {
      const res = this.lastResult;
      const listEl = document.getElementById('mock-result-review-list');
      if (!res || !res.details || !listEl) return;
      const esc = (t) => window.app.escapeHtml(t);
      const letters = ['A', 'B', 'C', 'D'];

      let items = res.details;
      if (this.reviewFilter === 'missed') items = items.filter(x => !x.isCorrect);
      else if (this.reviewFilter === 'flagged') items = items.filter(x => x.flagged);

      ['missed', 'flagged', 'all'].forEach(f => {
        const b = document.getElementById(`mock-rev-tab-${f}`);
        if (b) {
          b.className = this.reviewFilter === f
            ? 'px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-extrabold'
            : 'px-3 py-1.5 rounded-lg bg-navy-900 border border-blue-900/50 text-slate-300 text-xs font-bold';
        }
      });

      if (!items.length) {
        listEl.innerHTML = `<div class="text-xs text-emerald-300 font-bold py-4 text-center">🎉 No items in this filter!</div>`;
        return;
      }

      listEl.innerHTML = items.map(d => {
        const dbItem = this.getDbItemById(d.id);
        if (!dbItem) return '';
        const yourAns = d.picked !== undefined ? `${letters[d.picked]}. ${d.choices[d.picked]}` : 'Unanswered';
        const corAns = `${letters[d.correctIdx]}. ${d.choices[d.correctIdx]}`;
        const ratHtml = window.app.formatRationaleHtml ? window.app.formatRationaleHtml(dbItem.rationale || '') : esc(dbItem.rationale || '');
        const imgsHtml = (Array.isArray(dbItem.images) && dbItem.images.length)
          ? `<div class="pt-2 space-y-2">${dbItem.images.map(src => `<img src="${esc(src)}" class="max-h-64 rounded-xl border border-emerald-500/30 bg-white p-1" />`).join('')}</div>`
          : '';
        return `
          <div class="rounded-2xl bg-navy-950/90 border ${d.isCorrect ? 'border-emerald-500/35' : 'border-rose-500/40'} p-4 space-y-2.5">
            <div class="flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span class="font-mono font-bold text-sky-300">Item #${d.idx + 1} • TOS ${esc(d.tosCode)} • ${esc(d.id)}</span>
              <span class="font-extrabold ${d.isCorrect ? 'text-emerald-400' : 'text-rose-400'}">${d.isCorrect ? '✅ Correct' : '❌ Missed'}</span>
            </div>
            <div class="text-xs sm:text-sm font-bold text-white leading-relaxed">${esc(dbItem.question)}</div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div class="rounded-lg px-3 py-2 ${d.isCorrect ? 'bg-emerald-950/50 border border-emerald-500/40 text-emerald-200' : 'bg-rose-950/50 border border-rose-500/40 text-rose-200'}">
                <span class="font-bold">Your Answer:</span> ${esc(yourAns)}
              </div>
              <div class="rounded-lg px-3 py-2 bg-emerald-950/50 border border-emerald-500/40 text-emerald-200">
                <span class="font-bold">Verified Answer:</span> ${esc(corAns)}
              </div>
            </div>
            ${(ratHtml || imgsHtml) ? `
              <div class="rounded-xl bg-navy-900/90 border border-emerald-500/25 p-3 space-y-1">
                <div class="text-[10px] font-black uppercase tracking-wider text-emerald-400">VERIFIED ANSWER & RATIONALE</div>
                ${ratHtml}
                ${imgsHtml}
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
    }
  };
})();
