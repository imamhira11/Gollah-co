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

  /** Link referred_by on profiles after signup (once) */
  async function applyReferralToProfile(userId) {
    if (!userId || !window.db) return;
    try {
      if (localStorage.getItem(REF_APPLIED_KEY + '_' + userId) === '1') return;
    } catch (e) {}
    const ref = getStoredRef();
    if (!ref || ref === userId) return;
    try {
      // Only set if currently null
      const { data: row } = await db.from('profiles').select('id, referred_by').eq('id', userId).maybeSingle();
      if (row && row.referred_by) {
        try { localStorage.setItem(REF_APPLIED_KEY + '_' + userId, '1'); } catch (e) {}
        return;
      }
      const { error } = await db.from('profiles').update({ referred_by: ref }).eq('id', userId).is('referred_by', null);
      if (!error) {
        try { localStorage.setItem(REF_APPLIED_KEY + '_' + userId, '1'); } catch (e) {}
      }
    } catch (e) {}
  }

  function getCurrentUserId() {
    try {
      if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) return currentUser.id;
    } catch (e) {}
    return null;
  }

  function getReferralLink(userId) {
    const id = userId || getCurrentUserId() || '';
    return 'https://gollah.top/?ref=' + encodeURIComponent(id);
  }

  function closeReferralModal() {
    const m = document.getElementById('referral-modal');
    if (m) m.classList.add('hidden');
  }

  async function fetchReferralStats(userId) {
    const empty = { invited: 0, active: 0, totalCoins: 0, rows: [] };
    if (!window.db || !userId) return empty;
    try {
      const { data: invited, error } = await db
        .from('profiles')
        .select('id, username, avatar_url, coins, created_at')
        .eq('referred_by', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) return empty;
      const list = invited || [];
      const ids = list.map(function (r) { return r.id; });
      let commissionMap = {};
      try {
        const { data: comm } = await db
          .from('referral_earnings')
          .select('referred_user_id, coins, created_at')
          .eq('referrer_id', userId)
          .order('created_at', { ascending: false })
          .limit(200);
        (comm || []).forEach(function (c) {
          const k = c.referred_user_id;
          commissionMap[k] = (commissionMap[k] || 0) + (Number(c.coins) || 0);
        });
      } catch (e2) {}

      let totalCoins = 0;
      Object.keys(commissionMap).forEach(function (k) { totalCoins += commissionMap[k]; });

      // Active = referred users who have earned at least once (have commission or coins > 0)
      let active = 0;
      const rows = list.map(function (r) {
        const earned = commissionMap[r.id] || 0;
        if (earned > 0 || (Number(r.coins) || 0) > 0) active++;
        return {
          id: r.id,
          username: r.username || 'User',
          avatar_url: r.avatar_url || 'assets/avatars/01 (1).png',
          commission: earned,
          joined: r.created_at
        };
      });

      // Prefer sum from referral_earnings if available
      if (!totalCoins) {
        try {
          const { data: sumRows } = await db
            .from('referral_earnings')
            .select('coins')
            .eq('referrer_id', userId);
          (sumRows || []).forEach(function (r) { totalCoins += Number(r.coins) || 0; });
        } catch (e3) {}
      }

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
    }, 2500);
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
      getStoredRef: getStoredRef
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReferralModule);
  } else {
    initReferralModule();
  }
})();
