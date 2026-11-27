/**
 * Gollah Ranking — shared daily leaderboard
 * - Never stuck on "Loading…" (timeout + always clear body)
 * - Day coins from RPC only (no client double-count boost)
 */
(function (global) {
  'use strict';

  var RANKING_LIMIT = 50;
  /** Ranking day boundary is strict UTC (00:00:00Z). */
  var RESET_HOUR = 6;
  var REFRESH_MS = 30000;
  var RPC_TIMEOUT_MS = 12000;
  var _loading = false;
  var _lastRows = [];
  var _refreshTimer = null;
  var _signature = '';
  var _myDayCoinsCache = 0;

  function levelBadgeClass(lvl) {
    var n = String(lvl == null ? '' : lvl).replace(/\D/g, '');
    if (n.length >= 3) return 'rank-level-badge rank-lvl-3d';
    if (n.length === 2) return 'rank-level-badge rank-lvl-2d';
    return 'rank-level-badge rank-lvl-1d';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function truncateName(name, maxLen) {
    var s = String(name || '').trim();
    if (!s) return 'Member';
    maxLen = maxLen || 12;
    if (s.length <= maxLen) return s;
    return s.slice(0, Math.max(1, maxLen - 1)) + '…';
  }

  /** Next daily reset boundary: 00:00:00 UTC (matches get_daily_ranking UTC day window) */
  function getNextUtcMidnight() {
    try {
      var now = new Date();
      return new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0, 0, 0, 0
      ));
    } catch (e) {
      return new Date(Date.now() + 3600000);
    }
  }
  // Back-compat alias used by window helpers
  function getNextRankingResetUtc() { return getNextUtcMidnight(); }

  function getWindowStartMs() {
    return getNextRankingResetUtc().getTime() - 24 * 60 * 60 * 1000;
  }

  function formatCountdown(ms) {
    if (ms < 0) ms = 0;
    var totalSec = Math.floor(ms / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function startResetCountdown() {
    function tick() {
      var left = getNextRankingResetUtc().getTime() - Date.now();
      var txt = formatCountdown(left);
      try {
        var el2 = document.getElementById('ranking-ends-in');
        if (el2) el2.textContent = 'Ends in ' + txt + ' (UTC)';
      } catch (e) {}
    }
    tick();
    try {
      if (window.__gollahRankCountdown) clearInterval(window.__gollahRankCountdown);
      window.__gollahRankCountdown = setInterval(tick, 1000);
    } catch (e) {}
  }

  function levelFromCoins(coins) {
    var c = Math.max(0, Math.floor(Number(coins) || 0));
    if (typeof computeLevelFromCoins === 'function') {
      try { return computeLevelFromCoins(c).level; } catch (e) {}
    }
    return Math.floor(c / 1000) + 1;
  }

  function avatarSrc(p) {
    var u = p && p.avatar_url;
    if (u && typeof isValidAvatarUrl === 'function' && isValidAvatarUrl(u)) return u;
    if (u && /^assets\/avatars\//i.test(String(u))) return u;
    if (u && /^https?:\/\//i.test(String(u))) return u;
    return 'assets/avatars/01 (1).png';
  }

  function displayName(p) {
    var u = String((p && p.username) || '').trim();
    if (u) return u;
    if (p && p.id) return 'User ' + String(p.id).slice(0, 6);
    return 'Member';
  }

  function extractCoins(row) {
    if (!row) return 0;
    try {
      if (typeof extractRewardCoins === 'function') {
        var x = Math.floor(Number(extractRewardCoins(row)) || 0);
        if (x > 0) return x;
      }
    } catch (e) {}
    var keys = ['coins_awarded', 'coins', 'amount', 'reward', 'payout', 'points', 'coin'];
    for (var i = 0; i < keys.length; i++) {
      if (row[keys[i]] == null || row[keys[i]] === '') continue;
      var n = Math.floor(Number(String(row[keys[i]]).replace(/,/g, '')));
      if (n > 0) return n;
    }
    var msg = String(row.message || row.title || '');
    var m = msg.match(/\+?\s*([\d,]+)\s*coins?/i);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10) || 0;
    return 0;
  }

  function isWithdrawLike(row) {
    var blob = String((row && (row.title || '')) + ' ' + (row && (row.message || ''))).toLowerCase();
    return /cashout|withdraw|payout|\bltc\b|binance|litecoin|pending approval/.test(blob);
  }

  function normalizeServerRows(data) {
    return (data || []).map(function (r, i) {
      var id = String(r.user_id || r.id || '').trim();
      var life = Math.max(0, Math.floor(Number(r.lifetime_coins != null ? r.lifetime_coins : 0) || 0));
      var dayRaw = r.day_coins != null ? r.day_coins : (r.coins != null ? r.coins : 0);
      var day = Math.max(0, Math.floor(Number(dayRaw) || 0));
      var uname = String(r.username || '').trim();
      if (!uname) uname = id ? ('User ' + id.slice(0, 6)) : 'Member';
      return {
        id: id,
        username: uname,
        avatar_url: r.avatar_url || '',
        coins: day,
        lifetime_coins: life,
        level: levelFromCoins(life),
        country: r.country || '',
        rank: r.rank != null ? Number(r.rank) : (i + 1)
      };
    }).filter(function (r) { return !!r.id && r.coins > 0; });
  }

  async function enrichFromProfiles(rows) {
    if (!rows.length || typeof db === 'undefined' || !db) return rows;
    var ids = rows.map(function (r) { return r.id; }).filter(Boolean);
    var map = {};
    try {
      for (var i = 0; i < ids.length; i += 50) {
        var chunk = ids.slice(i, i + 50);
        try {
          var res = await db.from('profiles')
            .select('id, username, avatar_url, coins, lifetime_coins, level, country')
            .in('id', chunk);
          if (res && !res.error && res.data) {
            res.data.forEach(function (p) { map[String(p.id)] = p; });
          }
        } catch (e) {}
      }
    } catch (e2) {}
    return rows.map(function (r) {
      var pr = map[String(r.id)];
      if (!pr) return r;
      var life = Math.max(0, Math.floor(Number(pr.lifetime_coins != null ? pr.lifetime_coins : (r.lifetime_coins != null ? r.lifetime_coins : pr.coins)) || 0));
      var uname = String(pr.username || r.username || '').trim() || ('User ' + String(r.id).slice(0, 6));
      return {
        id: r.id,
        username: uname,
        avatar_url: pr.avatar_url || r.avatar_url || '',
        coins: r.coins,
        lifetime_coins: life,
        level: levelFromCoins(life),
        country: pr.country || r.country || '',
        rank: r.rank
      };
    });
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        resolve({ error: { message: 'timeout after ' + ms + 'ms' }, data: null });
      }, ms);
      Promise.resolve(promise).then(function (v) {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      }).catch(function (err) {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve({ error: err || { message: 'request failed' }, data: null });
      });
    });
  }

  async function fetchMyNotifDayCoins() {
    var total = 0;
    try {
      if (typeof db === 'undefined' || !db || typeof currentUser === 'undefined' || !currentUser || !currentUser.id) {
        return 0;
      }
      var sinceIso = new Date(getWindowStartMs()).toISOString();
      var res = await withTimeout(
        db.from('user_notifications').select('*').eq('user_id', currentUser.id).gte('created_at', sinceIso).limit(300),
        8000
      );
      if (res && !res.error && res.data) {
        var seen = {};
        res.data.forEach(function (row) {
          if (isWithdrawLike(row)) return;
          var c = extractCoins(row);
          if (c <= 0) return;
          var key = String(row.id || (row.created_at + ':' + c + ':' + (row.message || '')));
          if (seen[key]) return;
          seen[key] = true;
          total += c;
        });
      }
    } catch (e) {}
    return total;
  }

  async function fetchSharedRankingRows() {
    var rows = [];

    try {
      if (typeof db !== 'undefined' && db && typeof db.rpc === 'function') {
        var res = await withTimeout(db.rpc('get_daily_ranking', { limit_n: RANKING_LIMIT }), RPC_TIMEOUT_MS);
        if (res && !res.error && Array.isArray(res.data)) {
          rows = normalizeServerRows(res.data);
        } else if (res && res.error) {
          console.warn('[ranking] RPC:', res.error.message || res.error);
        }
      }
    } catch (e) {
      console.warn('[ranking] RPC exception', e);
    }

    if (!rows.length) {
      try {
        if (typeof db !== 'undefined' && db) {
          var v = await withTimeout(
            db.from('daily_ranking_v1').select('*').order('day_coins', { ascending: false }).limit(RANKING_LIMIT),
            8000
          );
          if (v && !v.error && Array.isArray(v.data) && v.data.length) {
            rows = normalizeServerRows(v.data);
          }
        }
      } catch (e2) {}
    }

    try {
      rows = await enrichFromProfiles(rows);
    } catch (e3) {}

    // Summary cache: prefer my RPC row; else notifications-only (once each)
    try {
      if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) {
        var meIdx = rows.findIndex(function (r) { return String(r.id) === String(currentUser.id); });
        if (meIdx >= 0) {
          _myDayCoinsCache = Math.max(0, Math.floor(Number(rows[meIdx].coins) || 0));
        } else {
          _myDayCoinsCache = await fetchMyNotifDayCoins();
          // Only append me if shared board already has others (RPC lag), never solo-board
          if (_myDayCoinsCache > 0 && rows.length > 0) {
            var me = {
              id: String(currentUser.id),
              username: 'You',
              avatar_url: '',
              coins: _myDayCoinsCache,
              lifetime_coins: 0,
              level: 1,
              country: '',
              rank: 0
            };
            try {
              var en = await enrichFromProfiles([me]);
              me = en[0] || me;
            } catch (e4) {}
            rows.push(me);
          }
        }
      }
    } catch (e5) {}

    rows = rows.filter(function (r) { return r && r.coins > 0; });
    rows.sort(function (a, b) { return b.coins - a.coins; });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    return rows.slice(0, RANKING_LIMIT);
  }

  function myDailyCoins(rows) {
    try {
      if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) {
        var me = (rows || []).find(function (r) { return String(r.id) === String(currentUser.id); });
        if (me) return Math.max(0, Math.floor(Number(me.coins) || 0));
      }
    } catch (e) {}
    return Math.max(0, _myDayCoinsCache || 0);
  }

  function rowsSignature(rows) {
    return (rows || []).map(function (r) {
      return r.id + ':' + r.coins + ':' + r.username + ':' + r.level;
    }).join('|');
  }

  function openRankProfile(userId) {
    try {
      var id = String(userId || '').trim();
      if (!id) return;
      if (typeof openRealtimeUserStats === 'function') openRealtimeUserStats(id);
      else if (typeof window.openRealtimeUserStats === 'function') window.openRealtimeUserStats(id);
    } catch (e) {}
  }
  global.openRankProfile = openRankProfile;

  function renderRankingRows(rows) {
    if (!rows || !rows.length) {
      return '<div class="rank-empty">No shared earnings in today\'s window yet. Complete offers — the board updates for everyone together.</div>';
    }
    var top = rows.slice(0, 3);
    var rest = rows.slice(3);
    var podium = '';
    if (top.length) {
      var order = top.length >= 3 ? [top[1], top[0], top[2]] : top;
      var ranks = top.length >= 3 ? [2, 1, 3] : top.map(function (_, i) { return i + 1; });
      podium = '<div class="rank-podium">' + order.map(function (p, i) {
        var r = ranks[i];
        var fullName = displayName(p);
        var name = escapeHtml(truncateName(fullName, r === 1 ? 14 : 11));
        var title = escapeHtml(fullName);
        var coins = Math.max(0, Math.floor(Number(p.coins) || 0)).toLocaleString();
        var lvl = p.level || levelFromCoins(p.lifetime_coins);
        var av = escapeHtml(avatarSrc(p));
        var uid = escapeHtml(String(p.id || ''));
        return (
          '<div class="rank-podium-card rank-place-' + r + ' rank-clickable" role="button" tabindex="0" data-rank-user="' + uid + '" onclick="openRankProfile(this.getAttribute(\'data-rank-user\'))" title="' + title + '">' +
            (r === 1 ? '<span class="rank-crown" aria-hidden="true">👑</span>' : '<div class="rank-medal">' + (r === 2 ? '🥈' : '🥉') + '</div>') +
            '<div class="rank-avatar-slot">' +
              '<img src="' + av + '" alt="" class="rank-podium-avatar" onerror="this.onerror=null;this.src=\'assets/avatars/01 (1).png\'" />' +
              '<span class="' + levelBadgeClass(lvl) + '">' + lvl + '</span>' +
            '</div>' +
            '<div class="rank-podium-name">' + name + '</div>' +
            '<div class="rank-podium-coins">' + coins + '</div>' +
          '</div>'
        );
      }).join('') + '</div>';
    }

    var list = rest.map(function (p, idx) {
      var rank = p.rank != null ? p.rank : (idx + 4);
      var fullName = displayName(p);
      var name = escapeHtml(truncateName(fullName, 18));
      var title = escapeHtml(fullName);
      var coins = Math.max(0, Math.floor(Number(p.coins) || 0)).toLocaleString();
      var lvl = p.level || levelFromCoins(p.lifetime_coins);
      var av = escapeHtml(avatarSrc(p));
      var uid = escapeHtml(String(p.id || ''));
      var isMe = false;
      try {
        if (typeof currentUser !== 'undefined' && currentUser && currentUser.id && String(p.id) === String(currentUser.id)) isMe = true;
      } catch (e) {}
      return (
        '<div class="rank-row rank-clickable' + (isMe ? ' rank-row-me' : '') + '" role="button" tabindex="0" data-rank-user="' + uid + '" onclick="openRankProfile(this.getAttribute(\'data-rank-user\'))" title="' + title + '">' +
          '<span class="rank-row-pos">' + rank + '</span>' +
          '<div class="rank-avatar-slot rank-avatar-slot-sm">' +
            '<img src="' + av + '" alt="" class="rank-row-avatar" onerror="this.onerror=null;this.src=\'assets/avatars/01 (1).png\'" />' +
            '<span class="' + levelBadgeClass(lvl) + '">' + lvl + '</span>' +
          '</div>' +
          '<div class="rank-row-meta min-w-0">' +
            '<span class="rank-row-name truncate">' + name + (isMe ? ' <span class="rank-you">(you)</span>' : '') + '</span>' +
          '</div>' +
          '<span class="rank-row-coins">' +
            '<span class="rank-row-coin-wrap">' +
              '<svg class="rank-row-coin-icon" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="#F5C542"/><circle cx="32" cy="32" r="24" fill="none" stroke="#E8B830" stroke-width="3"/><circle cx="32" cy="32" r="8" fill="#FFE082"/></svg>' +
              '<span class="rank-row-coin-num">' + coins + '</span>' +
            '</span>' +
          '</span>' +
        '</div>'
      );
    }).join('');

    return podium + '<div class="rank-list">' + (list || '') + '</div>';
  }

  function renderSummaryBar(rows) {
    var mine = myDailyCoins(rows);
    return (
      '<div class="rank-summary-bar">' +
        '<div class="rank-summary-you">You earned <span class="rank-summary-coins">● ' + mine.toLocaleString() + '</span> today</div>' +
        '<div id="ranking-ends-in" class="rank-summary-ends">Ends in --:--:--</div>' +
      '</div>'
    );
  }

  function applyRankingDom(rows, silent) {
    var sum = document.getElementById('ranking-summary');
    var body = document.getElementById('ranking-body');
    if (!body) return;
    rows = rows || [];
    var sig = rowsSignature(rows);
    if (silent && sig === _signature && body.querySelector('.rank-podium, .rank-row, .rank-empty')) {
      if (sum) {
        var coinEl = sum.querySelector('.rank-summary-coins');
        if (coinEl) coinEl.textContent = '● ' + myDailyCoins(rows).toLocaleString();
      }
      return;
    }
    _signature = sig;
    _lastRows = rows;
    try {
      if (sum) sum.innerHTML = renderSummaryBar(rows);
    } catch (e) {}
    try {
      body.innerHTML = renderRankingRows(rows);
    } catch (e2) {
      body.innerHTML = '<div class="rank-empty">Could not render ranking. Tap Refresh.</div>';
    }
    startResetCountdown();
  }

  function stopRankingRefresh() {
    try {
      if (_refreshTimer) clearInterval(_refreshTimer);
      _refreshTimer = null;
    } catch (e) {}
  }

  function startRankingRefresh() {
    stopRankingRefresh();
    _refreshTimer = setInterval(function () {
      if (!document.querySelector('.ranking-page')) {
        stopRankingRefresh();
        return;
      }
      silentRefreshRanking();
    }, REFRESH_MS);
  }

  async function silentRefreshRanking() {
    if (_loading) return;
    _loading = true;
    try {
      var rows = await fetchSharedRankingRows();
      applyRankingDom(rows, true);
    } catch (e) {
      console.warn('[ranking] silent refresh failed', e);
      var body = document.getElementById('ranking-body');
      if (body && body.querySelector('.rank-loading')) {
        body.innerHTML = '<div class="rank-empty">Could not load ranking. Tap Refresh.</div>';
      }
    } finally {
      _loading = false;
    }
  }

  async function renderRanking() {
    var container = document.getElementById('app-content');
    if (!container) return;

    try {
      if (!container.querySelector('.ranking-page')) {
        container.innerHTML =
          '<div class="ranking-page flex flex-col gap-4">' +
            '<div class="flex items-start justify-between gap-3 flex-wrap">' +
              '<div class="min-w-0">' +
                '<h2 class="text-lg font-black text-white tracking-tight flex items-center gap-2.5">' +
                  '<span class="w-9 h-9 rounded-xl bg-[#00d672]/15 border border-[#00d672]/30 flex items-center justify-center shrink-0">' +
                    '<i data-lucide="trophy" class="w-4 h-4 text-[#00d672]"></i>' +
                  '</span>Ranking' +
                '</h2>' +
              '</div>' +
              '<button type="button" onclick="renderRanking()" class="text-[11px] font-semibold px-3.5 py-2 rounded-xl bg-[#1a2530] border border-[#2a3848] text-slate-300 hover:text-white transition shrink-0">Refresh</button>' +
            '</div>' +
            '<div id="ranking-summary"></div>' +
            '<div id="ranking-body" class="rank-body"><div class="rank-loading">Loading today\'s leaderboard…</div></div>' +
          '</div>';
        if (window.lucide) try { lucide.createIcons(); } catch (e) {}
        startResetCountdown();
      }
    } catch (eShell) {}

    // Allow re-entry if a previous load hung
    if (_loading) {
      _loading = false;
    }
    _loading = true;
    try {
      var rows = await fetchSharedRankingRows();
      applyRankingDom(rows, false);
      if (window.lucide) try { lucide.createIcons(); } catch (e2) {}
    } catch (err) {
      console.warn('[ranking] render failed', err);
      applyRankingDom([], false);
      var body = document.getElementById('ranking-body');
      if (body) {
        body.innerHTML = '<div class="rank-empty">Could not load ranking. Tap Refresh.</div>';
      }
    } finally {
      _loading = false;
      // Absolute safety: never leave the loading label visible
      try {
        var b = document.getElementById('ranking-body');
        if (b && b.querySelector('.rank-loading') && !b.querySelector('.rank-podium, .rank-row, .rank-empty')) {
          b.innerHTML = '<div class="rank-empty">No shared earnings in today\'s window yet. Complete offers — the board updates for everyone together.</div>';
        }
      } catch (e3) {}
    }
    startRankingRefresh();
  }

  function softRefreshRankingIfVisible() {
    try {
      if (!document.querySelector('.ranking-page')) return;
      silentRefreshRanking();
    } catch (e) {}
  }

  global.renderRanking = renderRanking;
  global.fetchRankingRows = fetchSharedRankingRows;
  global.softRefreshRankingIfVisible = softRefreshRankingIfVisible;
})(typeof window !== 'undefined' ? window : this);
