/* referral.js — Standalone 7% referral system (UI + ref capture)
   Commission is applied at DB level via SQL trigger — no changes to offers.js.
*/
(function () {
  'use strict';

  const REF_STORAGE_KEY = 'gollah_ref_code_v1';
  const REF_APPLIED_KEY = 'gollah_ref_applied_v1';

  function getQueryRef() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const ref = (params.get('ref') || '').trim();
      if (ref && ref.length >= 8 && ref.length <= 64) return ref;
    } catch (e) {}
    return '';
  }

  function persistIncomingRef() {
    try {
      const ref = getQueryRef();
      if (!ref) return;
      // Never store self-ref if already logged in as that user
      try {
        if (typeof currentUser !== 'undefined' && currentUser && currentUser.id === ref) return;
      } catch (e) {}
      localStorage.setItem(REF_STORAGE_KEY, ref);
    } catch (e) {}
  }

  function getStoredRef() {
    try {
      return (localStorage.getItem(REF_STORAGE_KEY) || '').trim();
    } catch (e) { return ''; }
  }

  /** Link referred_by on profiles after signup (once). Clears pending ref key when bound. */
  async function applyReferralToProfile(userId) {
    if (!userId || !window.db) return false;
    try {
      if (localStorage.getItem(REF_APPLIED_KEY + '_' + userId) === '1') {
        try { localStorage.removeItem(REF_STORAGE_KEY); } catch (eC) {}
        return false;
      }
    } catch (e) {}
    const ref = getStoredRef();
    if (!ref || ref === userId) {
      // Self-ref or empty: drop pending key so we stop retrying
      if (ref === userId) {
        try { localStorage.removeItem(REF_STORAGE_KEY); } catch (eS) {}
      }
      return false;
    }
    var bound = false;
    try {
      const { data: row } = await db.from('profiles').select('id, referred_by').eq('id', userId).maybeSingle();
      if (row && row.referred_by) {
        try { localStorage.setItem(REF_APPLIED_KEY + '_' + userId, '1'); } catch (e) {}
        try { localStorage.removeItem(REF_STORAGE_KEY); } catch (e2) {}
        return false;
      }

      // Validate referrer exists + block mutual/circular A <-> B (before any write)
      try {
        const refRes = await db.from('profiles').select('id, referred_by').eq('id', ref).maybeSingle();
        if (refRes && refRes.error) {
          // Transient network/RLS error — keep pending ref for a later retry
          return false;
        }
        var refRow = refRes ? refRes.data : null;
        if (!refRow || !refRow.id) {
          // Invalid / non-existent referrer UUID — drop pending key
          try { localStorage.removeItem(REF_STORAGE_KEY); } catch (eInv) {}
          return false;
        }
        if (String(refRow.id) === String(userId)) {
          try { localStorage.removeItem(REF_STORAGE_KEY); } catch (eSelf) {}
          return false;
        }
        // Mutual/circular: target referrer was already referred by current user (A <-> B)
        if (refRow.referred_by != null && String(refRow.referred_by) === String(userId)) {
          try { localStorage.removeItem(REF_STORAGE_KEY); } catch (eCirc) {}
          return false;
        }
      } catch (eVal) {
        // Network failure — keep pending ref for retry
        return false;
      }

      const { error } = await db.from('profiles').update({ referred_by: ref }).eq('id', userId).is('referred_by', null);
      if (!error) {
        bound = true;
        try { localStorage.setItem(REF_APPLIED_KEY + '_' + userId, '1'); } catch (e) {}
        try { localStorage.removeItem(REF_STORAGE_KEY); } catch (e2) {}
      }
    } catch (e) {}
    if (bound) {
      try { await refreshReferralProfileStats(userId); } catch (eR) {}
      try {
        if (typeof softRefreshActiveProfileView === 'function') softRefreshActiveProfileView();
        else if (typeof refreshProfileInPlaceOnly === 'function') refreshProfileInPlaceOnly();
        else if (typeof currentTab !== 'undefined' && currentTab === 'profile' && typeof renderProfile === 'function') renderProfile();
      } catch (eUi) {}
    }
    return bound;
  }

  /**
   * Canonical referral stats for Profile boxes + Referrals modal (same queries).
   * Returns { referrerLabel, usersReferred, totalEarnings, active, rows }
   */
  async function refreshReferralProfileStats(userId) {
    var out = { referrerLabel: '—', usersReferred: 0, totalEarnings: 0, active: 0, rows: [] };
    if (!window.db || !userId) {
      try {
        window.__gollahReferrerLabel = out.referrerLabel;
        window.__gollahReferralEarnings = 0;
        window.__gollahUsersReferred = 0;
      } catch (e0) {}
      return out;
    }
    try {
      // Who referred ME
      const { data: me } = await db.from('profiles').select('referred_by').eq('id', userId).maybeSingle();
      var rid = me && me.referred_by ? String(me.referred_by) : '';
      if (rid) {
        out.referrerLabel = rid.length > 10 ? (rid.slice(0, 8) + '...') : rid;
        try {
          const { data: rp } = await db.from('profiles').select('username').eq('id', rid).maybeSingle();
          if (rp && rp.username && String(rp.username).trim()) {
            out.referrerLabel = String(rp.username).trim();
          }
        } catch (eN) {}
      }
    } catch (e1) {}
    try {
      const inv = await db.from('profiles').select('id', { count: 'exact', head: true }).eq('referred_by', userId);
      if (inv && typeof inv.count === 'number') out.usersReferred = inv.count;
    } catch (e2) {}
    try {
      const { data: earnRows } = await db.from('referral_earnings').select('coins, referred_user_id').eq('referrer_id', userId);
      var activeSet = {};
      (earnRows || []).forEach(function (r) {
        out.totalEarnings += Number(r.coins) || 0;
        if (r.referred_user_id) activeSet[String(r.referred_user_id)] = 1;
      });
      out.active = Object.keys(activeSet).length;
    } catch (e3) {}
    try {
      window.__gollahReferrerLabel = out.referrerLabel;
      window.__gollahReferralEarnings = out.totalEarnings;
      window.__gollahUsersReferred = out.usersReferred;
      var el1 = document.getElementById('profile-stat-referrer');
      var el2 = document.getElementById('profile-stat-ref-earn');
      var el3 = document.getElementById('profile-stat-ref-users');
      if (el1) el1.textContent = out.referrerLabel;
      if (el2) el2.textContent = Number(out.totalEarnings).toLocaleString();
      if (el3) el3.textContent = Number(out.usersReferred).toLocaleString();
    } catch (eFill) {}
    return out;
  }

  function getCurrentUserId() {
    try {
      if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) return currentUser.id;
    } catch (e) {}
    return null;
  }

  function getReferralLink(userId) {
    const id = userId || getCurrentUserId() || '';
    var base = 'https://gollah.top';
    try {
      if (typeof location !== 'undefined' && location.origin && /^https?:/i.test(location.origin)) {
        base = location.origin;
      }
    } catch (eB) {}
    return base.replace(/\/$/, '') + '/?ref=' + encodeURIComponent(id);
  }

  function closeReferralModal() {
    const m = document.getElementById('referral-modal');
    if (m) m.classList.add('hidden');
  }

  async function fetchReferralStats(userId) {
    const empty = { invited: 0, active: 0, totalCoins: 0, rows: [] };
    if (!window.db || !userId) return empty;
    try {
      // Same canonical sources as Personal Profile boxes
      const { data: invited, error } = await db
        .from('profiles')
        .select('id, username, avatar_url, coins, net_earned_coins, created_at')
        .eq('referred_by', userId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) return empty;
      const list = invited || [];

      let commissionMap = {};
      let totalCoins = 0;
      try {
        const { data: comm } = await db
          .from('referral_earnings')
          .select('referred_user_id, coins, created_at')
          .eq('referrer_id', userId)
          .order('created_at', { ascending: false })
          .limit(500);
        (comm || []).forEach(function (c) {
          const k = String(c.referred_user_id || '');
          const n = Number(c.coins) || 0;
          totalCoins += n;
          if (k) commissionMap[k] = (commissionMap[k] || 0) + n;
        });
      } catch (e2) {}

      // Active = distinct referred users who generated at least one referral_earnings row
      // (fallback: net_earned_coins > 0 on the referred profile)
      let active = 0;
      const activeSeen = {};
      Object.keys(commissionMap).forEach(function (k) {
        if (commissionMap[k] > 0) { activeSeen[k] = 1; }
      });
      const rows = list.map(function (r) {
        const earned = commissionMap[r.id] || 0;
        const net = Number(r.net_earned_coins != null ? r.net_earned_coins : r.coins) || 0;
        if (earned > 0 || net > 0) activeSeen[String(r.id)] = 1;
        return {
          id: r.id,
          username: r.username || 'User',
          avatar_url: r.avatar_url || 'assets/avatars/01 (1).png',
          commission: earned,
          joined: r.created_at
        };
      });
      active = Object.keys(activeSeen).length;

      // Keep global cache in sync with Profile boxes
      try {
        window.__gollahUsersReferred = list.length;
        window.__gollahReferralEarnings = totalCoins;
        var el2 = document.getElementById('profile-stat-ref-earn');
        var el3 = document.getElementById('profile-stat-ref-users');
        if (el2) el2.textContent = Number(totalCoins).toLocaleString();
        if (el3) el3.textContent = Number(list.length).toLocaleString();
      } catch (eSync) {}

      return { invited: list.length, active: active, totalCoins: totalCoins, rows: rows };
    } catch (e) {
      return empty;
    }
  }

  function formatJoined(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString();
    } catch (e) { return ''; }
  }

  async function renderReferralModalBody() {
    const body = document.getElementById('referral-modal-body');
    if (!body) return;
    const userId = getCurrentUserId();
    if (!userId) {
      body.innerHTML = '<p class="text-[13px] text-slate-400 text-center py-8">Please log in to view referrals.</p>';
      return;
    }
    body.innerHTML = '<p class="text-[13px] text-slate-500 text-center py-6">Loading…</p>';
    const link = getReferralLink(userId);
    const stats = await fetchReferralStats(userId);

    const rowsHtml = stats.rows.length
      ? stats.rows.map(function (r) {
          return (
            '<div class="flex items-center gap-3 bg-[#151A23] border border-[#2A3344] rounded-xl px-3 py-2.5">' +
              '<img src="' + String(r.avatar_url).replace(/"/g, '') + '" class="w-8 h-8 rounded-full object-cover bg-[#2A3344]" onerror="this.src=\'assets/avatars/01 (1).png\'" />' +
              '<div class="min-w-0 flex-1">' +
                '<div class="text-[13px] font-semibold text-white truncate">' + String(r.username).replace(/</g, '&lt;') + '</div>' +
                '<div class="text-[10px] text-slate-500">Joined ' + formatJoined(r.joined) + '</div>' +
              '</div>' +
              '<div class="text-[12px] font-bold text-[#00d672] tabular-nums">+' + Number(r.commission).toLocaleString() + '</div>' +
            '</div>'
          );
        }).join('')
      : '<p class="text-[12px] text-slate-500 text-center py-4">No referrals yet. Share your link to start earning.</p>';

    body.innerHTML =
      '<div class="bg-[#151A23] border border-[#2A3344] rounded-xl p-3.5 flex flex-col gap-2">' +
        '<label class="text-[11px] font-bold text-slate-400 uppercase tracking-wide">Your referral link</label>' +
        '<div class="flex items-center gap-2">' +
          '<input id="referral-link-input" type="text" readonly value="' + link.replace(/"/g, '&quot;') + '" class="flex-1 min-w-0 bg-[#0D1117] border border-[#2A3344] rounded-lg px-3 py-2 text-[11px] text-slate-200 font-mono" />' +
          '<button type="button" id="referral-copy-btn" class="shrink-0 bg-[#00d672] hover:bg-[#00be64] text-black font-bold text-[12px] px-3.5 py-2 rounded-lg transition">Copy</button>' +
        '</div>' +
        '<p class="text-[11px] text-emerald-400/90 font-semibold">Earn 7% lifetime commission whenever your referrals complete offers!</p>' +
      '</div>' +
      '<div class="grid grid-cols-3 gap-2">' +
        '<div class="bg-[#151A23] border border-[#2A3344] rounded-xl p-3 text-center">' +
          '<div class="text-[10px] text-slate-500 font-semibold mb-1">Invited</div>' +
          '<div class="text-[16px] font-black text-white">' + stats.invited + '</div>' +
        '</div>' +
        '<div class="bg-[#151A23] border border-[#2A3344] rounded-xl p-3 text-center">' +
          '<div class="text-[10px] text-slate-500 font-semibold mb-1">Active</div>' +
          '<div class="text-[16px] font-black text-white">' + stats.active + '</div>' +
        '</div>' +
        '<div class="bg-[#151A23] border border-[#2A3344] rounded-xl p-3 text-center">' +
          '<div class="text-[10px] text-slate-500 font-semibold mb-1">Earned</div>' +
          '<div class="text-[16px] font-black text-[#00d672]">' + Number(stats.totalCoins).toLocaleString() + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="flex flex-col gap-2">' +
        '<div class="text-[12px] font-bold text-slate-300">Your referrals</div>' +
        '<div class="flex flex-col gap-2 max-h-[220px] overflow-y-auto custom-scroll">' + rowsHtml + '</div>' +
      '</div>';

    const copyBtn = document.getElementById('referral-copy-btn');
    const input = document.getElementById('referral-link-input');
    if (copyBtn && input) {
      copyBtn.onclick = function () {
        try {
          input.select();
          input.setSelectionRange(0, 999);
          navigator.clipboard.writeText(input.value).then(function () {
            copyBtn.textContent = 'Copied!';
            setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
          }).catch(function () {
            document.execCommand('copy');
            copyBtn.textContent = 'Copied!';
            setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
          });
        } catch (e) {}
      };
    }
    if (window.lucide) try { lucide.createIcons(); } catch (e) {}
  }

  function openReferralModal() {
    try {
      if (typeof currentUser === 'undefined' || !currentUser) {
        if (typeof openAuthModal === 'function') openAuthModal(false);
        else if (typeof requireLogin === 'function') requireLogin('Please login to view referrals.');
        return;
      }
    } catch (e) {
      if (typeof openAuthModal === 'function') openAuthModal(false);
      return;
    }
    const m = document.getElementById('referral-modal');
    if (!m) return;
    m.classList.remove('hidden');
    renderReferralModalBody();
    if (window.lucide) try { lucide.createIcons(); } catch (e) {}
  }

  // Apply referral after login/signup settles
  function watchApplyReferral() {
    setInterval(function () {
      try {
        if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) {
          applyReferralToProfile(currentUser.id);
        }
      } catch (e) {}
    }, 4000);
    setTimeout(function () {
      try {
        if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) {
          applyReferralToProfile(currentUser.id);
        }
      } catch (e) {}
    }, 1500);
    setTimeout(function () {
      try {
        if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) {
          applyReferralToProfile(currentUser.id);
        }
      } catch (e) {}
    }, 5000);
  }

  function initReferralModule() {
    persistIncomingRef();
    watchApplyReferral();
    // Close modal on backdrop click
    const m = document.getElementById('referral-modal');
    if (m) {
      m.addEventListener('click', function (e) {
        if (e.target === m) closeReferralModal();
      });
    }
    window.openReferralModal = openReferralModal;
    window.closeReferralModal = closeReferralModal;
    window.GollahReferral = {
      openReferralModal: openReferralModal,
      closeReferralModal: closeReferralModal,
      getReferralLink: getReferralLink,
      getStoredRef: getStoredRef,
      applyReferralToProfile: applyReferralToProfile,
      refreshReferralProfileStats: refreshReferralProfileStats,
      fetchReferralStats: fetchReferralStats
    };
    try { window.refreshReferralProfileStats = refreshReferralProfileStats; } catch (eW) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReferralModule);
  } else {
    initReferralModule();
  }
})();
