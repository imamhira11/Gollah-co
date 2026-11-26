/* live-ticker.js — Live activity ticker, shared feed, realtime subscriptions */
    // Live Ticker — PERMANENT (localStorage + shared Supabase). Never auto-wipe your withdraws.
    // liveTickerItemsAll = full activity list (offers + withdrawals) shared with bottom Live Feed
    // TOP horizontal ticker renders WITHDRAWALS ONLY (pending + sent)
    // liveTickerItems     = public bottom Live Feed (offers + completed withdrawals)
    let liveTickerItemsAll = [];
    let liveTickerItems = [];
    let liveFeedChannel = null;
    let liveFeedPollTimer = null;
    let liveFeedLastSeenAt = null;
    const seenActivityIds = new Set();
    const LIVE_TICKER_STORAGE_KEY = 'gollah_live_ticker_v5';
    const LIVE_TICKER_MAX = 80;
    let __liveActivityChannel = null;
    let __liveActivitySubscribing = false;

    function isCompletedPayoutStatus(status) {
      const s = String(status || '').toLowerCase().trim();
      return s === 'sent' || s === 'paid' || s === 'completed' || s === 'complete';
    }

    function isWithdrawalActivityType(type) {
      const ty = String(type || '').toLowerCase();
      return ty === 'ltc' || ty === 'binance' || ty.includes('withdraw') || ty.includes('cashout');
    }

    /** Bottom Live Feed: hide Pending (and any non-Sent/Paid) withdrawals; keep offers */
    function shouldShowInBottomLiveFeed(t) {
      if (!t) return false;
      if (!isWithdrawalActivityType(t.type)) return true;
      return isCompletedPayoutStatus(t.status);
    }

    function sortLiveTickerNewestFirst() {
      liveTickerItemsAll.sort(function (a, b) {
        const ta = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (tb !== ta) return tb - ta; // newest first
        // Stable tie-break: prefer real server ids
        const ia = a && a.id != null ? String(a.id) : '';
        const ib = b && b.id != null ? String(b.id) : '';
        return ib.localeCompare(ia);
      });
    }

    function syncPublicLiveTickerItems() {
      sortLiveTickerNewestFirst();
      liveTickerItems = liveTickerItemsAll.filter(shouldShowInBottomLiveFeed);
    }

    
    /**
     * Called from offers.js when user_notifications realtime fires for offer complete/reversal.
     * Guarantees Live Feed updates even if live_activity insert/realtime fails.
     */
    function pushLiveFeedActivity(opts) {
      try {
        opts = opts || {};
        const coins = Math.floor(Number(opts.coins) || 0);
        if (!coins) return;
        const isRev = !!(opts.reversal || coins < 0 || /revers|cashback|chargeback/i.test(String(opts.status || '') + String(opts.type || '')));
        const amount = isRev ? -Math.abs(coins) : Math.abs(coins);
        const type = isRev ? 'offer_reversal' : (opts.type || 'Offer');
        const status = isRev ? 'Cashback' : (opts.status || 'Complete');
        const provider = String(opts.provider || 'Offerwall').trim() || 'Offerwall';
        const offerName = String(opts.offerName || opts.offer_name || '').trim();
        const username = String(opts.username || (typeof getDisplayUsername === 'function' ? getDisplayUsername() : '') || '').trim();
        const createdAt = opts.createdAt || opts.created_at || new Date().toISOString();
        const activityId = opts.id || opts.activityId || null;
        prependLiveTicker(
          type,
          amount,
          opts.icon || (isRev ? '↩' : '⚡'),
          status,
          activityId,
          createdAt,
          { username: username, offerName: offerName, provider: provider }
        );
        try { syncPublicLiveTickerItems(); } catch (e1) {}
        try { renderGlobalLiveTicker(); } catch (e2) {}
        try {
          if (typeof currentTab !== 'undefined' && (currentTab === 'home' || currentTab === 'premium') && typeof renderHome === 'function') {
            renderHome();
          }
        } catch (e3) {}
      } catch (e) {
        console.warn('[pushLiveFeedActivity]', e && e.message);
      }
    }
    try { window.pushLiveFeedActivity = pushLiveFeedActivity; } catch (eW) {}

function saveLiveTickerToStorage() {
      try {
        localStorage.setItem(LIVE_TICKER_STORAGE_KEY, JSON.stringify(liveTickerItemsAll.slice(0, LIVE_TICKER_MAX)));
      } catch (e) {}
    }

    function loadLiveTickerFromStorage() {
      try {
        const raw = localStorage.getItem(LIVE_TICKER_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.length) return;
        liveTickerItemsAll = [];
        seenActivityIds.clear();
        parsed.forEach(item => {
          if (!item || !item.type) return;
          const id = item.id || (
            'stored_' + String(item.type) + '_' + String(item.amount) + '_' +
            String(item.offerName || '') + '_' + String(item.createdAt || item.time || '')
          );
          if (seenActivityIds.has(id)) return;
          seenActivityIds.add(id);
          liveTickerItemsAll.push({
            id: id,
            type: item.type,
            amount: item.amount,
            time: item.time || '',
            icon: item.icon || 'Ł',
            status: item.status || '',
            username: item.username || '',
            offerName: item.offerName || '',
            provider: item.provider || '',
            trans_id: item.trans_id || '',
            createdAt: item.createdAt || null,
            user_id: item.user_id || null
          });
        });
        // Keep storage newest-first
        try { sortLiveTickerNewestFirst(); } catch (eS) {}
      } catch (e) {}
    }


    function formatTickerTime(isoOrNow) {
      // Live relative time like Dollah: "seconds ago" → "2 minutes ago" → …
      if (!isoOrNow) return 'just now';
      if (isoOrNow === 'just now') return 'just now';
      try {
        let d;
        // Support already-relative strings stored offline (best-effort)
        if (typeof isoOrNow === 'string' && isoOrNow.includes('ago')) {
          return isoOrNow;
        }
        d = new Date(isoOrNow);
        if (isNaN(d.getTime())) return 'just now';
        const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
        if (sec < 5) return 'just now';
        if (sec < 60) return sec + (sec === 1 ? ' second ago' : ' seconds ago');
        const min = Math.floor(sec / 60);
        if (min < 60) return min + (min === 1 ? ' minute ago' : ' minutes ago');
        const hr = Math.floor(min / 60);
        if (hr < 24) return hr + (hr === 1 ? ' hour ago' : ' hours ago');
        const day = Math.floor(hr / 24);
        if (day < 30) return day + (day === 1 ? ' day ago' : ' days ago');
        const mo = Math.floor(day / 30);
        if (mo < 12) return mo + (mo === 1 ? ' month ago' : ' months ago');
        const yr = Math.floor(day / 365);
        return yr + (yr === 1 ? ' year ago' : ' years ago');
      } catch (e) {
        return 'just now';
      }
    }

    function formatJoinedAgo(iso) {
      if (!iso) return 'Joined recently';
      try {
        const d = new Date(iso);
        const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
        const day = Math.floor(sec / 86400);
        if (day < 1) return 'Joined today';
        if (day < 30) return 'Joined ' + day + (day === 1 ? ' day ago' : ' days ago');
        const mo = Math.floor(day / 30);
        if (mo < 12) return 'Joined ' + mo + (mo === 1 ? ' month ago' : ' months ago');
        const yr = Math.floor(day / 365);
        return 'Joined ' + yr + (yr === 1 ? ' year ago' : ' years ago');
      } catch (e) {
        return 'Joined recently';
      }
    }

    // Refresh live ticker relative times smoothly (1s) — seconds ago → minutes ago…
    let tickerTimeInterval = null;
    function startTickerTimeClock() {
      if (tickerTimeInterval) return;
      tickerTimeInterval = setInterval(() => {
        let changed = false;
        liveTickerItemsAll.forEach(t => {
          if (t.createdAt) {
            const next = formatTickerTime(t.createdAt);
            if (t.time !== next) {
              t.time = next;
              changed = true;
            }
          }
        });
        if (!changed) return;
        const track = document.getElementById('global-live-ticker-track');
        if (!track) return;
        track.querySelectorAll('.ticker-chip').forEach(chip => {
          const id = chip.getAttribute('data-id');
          const item = id
            ? liveTickerItemsAll.find(x => String(x.id) === String(id))
            : liveTickerItemsAll[parseInt(chip.getAttribute('data-idx'), 10)];
          if (!item) return;
          const timeEl = chip.querySelector('.ticker-live-time');
          if (timeEl) timeEl.textContent = item.time || formatTickerTime(item.createdAt);
        });
      }, 1000);
    }

    function getDisplayUsername() {
      try {
        const el = document.getElementById('profile-username-display');
        if (el && el.innerText && el.innerText !== 'Guest' && el.innerText !== 'Guest User') {
          return el.innerText.trim();
        }
      } catch (e) {}
      if (currentUser && currentUser.email) {
        return currentUser.email.split('@')[0];
      }
      return 'User';
    }

    function isWithdrawalTickerType(type) {
      const ty = String(type || '').toLowerCase();
      return ty === 'ltc' || ty === 'binance' || ty.includes('withdraw') || ty.includes('cashout');
    }

    function buildTickerTooltip(t) {
      const timeStr = t.createdAt ? formatTickerTime(t.createdAt) : (t.time || 'just now');
      const user = (t.username && String(t.username).trim()) ? String(t.username).trim() : 'Member';
      const amt = t.amount || '0';
      if (isWithdrawalTickerType(t.type)) {
        return `
          <div class="text-[11px] leading-relaxed">
            <div class="font-bold text-white mb-1">${user}</div>
            <div class="text-slate-300">Withdrew <span class="coin-amt font-bold">● ${amt}</span></div>
            <div class="text-slate-500 mt-0.5">${t.type || 'Crypto'} · ${t.status || 'Sent'} · ${timeStr}</div>
          </div>
        `;
      }
      const offerTitle = t.offerName || t.type || 'Offer';
      const wall = t.provider || 'Network';
      return `
        <div class="text-[11px] leading-relaxed">
          <div class="font-bold text-white mb-1 truncate">${offerTitle}</div>
          <div class="text-slate-300">Wall: <span class="text-emerald-400 font-semibold">${wall}</span></div>
          <div class="text-slate-300 mt-0.5">Completed by <span class="text-white font-semibold">${user}</span></div>
          <div class="text-slate-500 mt-0.5">● ${amt} · ${timeStr}</div>
        </div>
      `;
    }

    // Resolve display name from row / profiles table
    const usernameCache = {};
    async function resolveActivityUsername(row) {
      if (!row) return '';
      if (row.username && String(row.username).trim()) return String(row.username).trim();
      if (row.user_name && String(row.user_name).trim()) return String(row.user_name).trim();
      const uid = row.user_id;
      if (!uid || !db) return '';
      if (usernameCache[uid]) return usernameCache[uid];
      try {
        const { data } = await db.from('profiles').select('username').eq('id', uid).maybeSingle();
        if (data && data.username) {
          usernameCache[uid] = data.username;
          return data.username;
        }
      } catch (e) {}
      return '';
    }

    // Update username on an already-rendered ticker item + localStorage
    function patchTickerUsername(activityId, username) {
      if (!activityId || !username) return;
      const item = liveTickerItemsAll.find(t => t.id === activityId);
      if (!item) return;
      if (item.username && item.username !== 'Member' && item.username !== 'Someone') return;
      item.username = username;
      syncPublicLiveTickerItems();
      saveLiveTickerToStorage();
      renderGlobalLiveTicker();
    }

    function ensureTickerFloatTip() {
      let tip = document.getElementById('ticker-float-tip');
      if (!tip) {
        tip = document.createElement('div');
        tip.id = 'ticker-float-tip';
        document.body.appendChild(tip);
      }
      return tip;
    }

    function hideTickerFloatTip() {
      const tip = document.getElementById('ticker-float-tip');
      if (tip) tip.style.display = 'none';
    }

    function showTickerFloatTip(chipEl, html) {
      const tip = ensureTickerFloatTip();
      tip.innerHTML = html;
      tip.style.display = 'block';
      tip.style.visibility = 'hidden';

      const rect = chipEl.getBoundingClientRect();
      const tipW = tip.offsetWidth || 200;
      const tipH = tip.offsetHeight || 80;

      // Prefer BELOW the chip
      let left = rect.left + rect.width / 2 - tipW / 2;
      let top = rect.bottom + 10;

      // Keep inside viewport horizontally
      left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));

      // If not enough space below, still keep below bar area (min top after header)
      if (top + tipH > window.innerHeight - 8) {
        top = Math.max(rect.bottom + 6, window.innerHeight - tipH - 8);
      }

      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
      tip.style.visibility = 'visible';
    }

    function resolveTickerChipItem(chip) {
      if (!chip) return null;
      const id = chip.getAttribute('data-id');
      if (id) {
        const byId = liveTickerItemsAll.find(x => String(x.id) === String(id));
        if (byId) return byId;
      }
      const idx = parseInt(chip.getAttribute('data-idx'), 10);
      const topItems = liveTickerItemsAll.filter(function (t) {
        return t && isWithdrawalActivityType(t.type);
      });
      return topItems[idx] || liveTickerItemsAll[idx] || null;
    }

    function bindTickerChipHovers(track) {
      track.querySelectorAll('.ticker-chip').forEach(chip => {
        chip.style.cursor = 'pointer';
        chip.addEventListener('mouseenter', () => {
          const item = resolveTickerChipItem(chip);
          if (!item) return;
          showTickerFloatTip(chip, buildTickerTooltip(item));
        });
        chip.addEventListener('mouseleave', hideTickerFloatTip);
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          // Ignore real drag scrolls
          if (window.__tickerDragMoved) return;
          const item = resolveTickerChipItem(chip);
          if (!item) return;
          hideTickerFloatTip();
          (function(){
            const t = item.user_id || item.userId || item.username || 'Member';
            if (typeof openRealtimeUserStats === 'function') openRealtimeUserStats(t);
            else openPublicProfileModal(item.username || 'Member', item);
          })();
        });
      });
      track.addEventListener('scroll', hideTickerFloatTip, { passive: true });
    }

    function findOfferFromActivity(t) {
      if (!t) return null;
      const name = (t.offerName || '').trim();
      if (name) {
        const byName = ALL_OFFERS.find(o => o.name.toLowerCase() === name.toLowerCase());
        if (byName) return byName;
      }
      // Match by provider + similar coins
      const coins = parseTickerAmount(t.amount);
      if (t.provider) {
        const byProv = ALL_OFFERS.find(o =>
          o.provider.toLowerCase() === String(t.provider).toLowerCase() && o.coins === coins
        );
        if (byProv) return byProv;
      }
      if (coins > 0) {
        const byCoins = ALL_OFFERS.find(o => o.coins === coins);
        if (byCoins) return byCoins;
      }
      return null;
    }

    function startOfferFromActivity(offerId) {
      closePublicProfileModal();
      if (!offerId) {
        showAppAlert('This offer is not available in the catalog right now.', { title: 'Offer unavailable', type: 'info' });
        return;
      }
      openOfferModal(offerId);
    }

    function closePublicProfileModal() {
      if (typeof closeAdvancedUserStats === 'function') {
        closeAdvancedUserStats();
        return;
      }
      const m = document.getElementById('user-advanced-stats-modal');
      if (m) {
        m.classList.add('hidden');
        m.style.display = 'none';
      }
    }

    async function isProfilePrivateByUsername(username) {
      if (!username || !db) return false;
      // Own account uses local private flag
      if (currentUser && getDisplayUsername() === username && getPrivateAccountSetting()) return true;
      try {
        const { data } = await db.from('profiles').select('is_private, username').eq('username', username).maybeSingle();
        if (data && data.is_private) return true;
      } catch (e) {}
      // Fallback: localStorage key if viewing self on another device not applicable
      try {
        if (currentUser && getDisplayUsername() === username) {
          return getPrivateAccountSetting();
        }
      } catch (e) {}
      return false;
    }

    async function fetchUserPublicActivity(username) {
      // Start from local live ticker
      let items = liveTickerItems.filter(t =>
        (t.username || '').toLowerCase() === String(username || '').toLowerCase()
      );

      if (db && username) {
        try {
          let res = await db
            .from('live_activity')
            .select('id, type, amount, icon, status, created_at, username, user_id')
            .eq('username', username)
            .order('created_at', { ascending: false })
            .limit(40);
          if (res.error) {
            // username column may not exist — skip remote
            res = { data: [] };
          }
          if (res.data && res.data.length) {
            const mapped = res.data.map(row => ({
              id: row.id,
              type: row.type,
              amount: String(row.amount),
              icon: row.icon || 'Ł',
              status: row.status || '',
              username: row.username || username,
              createdAt: row.created_at,
              time: formatTickerTime(row.created_at),
              offerName: '',
              provider: ''
            }));
            // Merge unique by id
            const seen = new Set(items.map(i => i.id));
            mapped.forEach(m => {
              if (!seen.has(m.id)) {
                items.push(m);
                seen.add(m.id);
              }
            });
          }
        } catch (e) {}
      }

      // Sort newest first
      items.sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
      return items;
    }

    async function openPublicProfileModal(username, seedItem) {
      // Redirect ALL profile clicks to Zxearn-style advanced stats modal
      const seed = seedItem || {};
      const target = seed.user_id || seed.userId || username || seed.username || 'Member';
      if (typeof openRealtimeUserStats === 'function') {
        await openRealtimeUserStats(target);
        return;
      }
      console.warn('[profile] openRealtimeUserStats not available');
    }

    function renderGlobalLiveTicker() {
      const track = document.getElementById('global-live-ticker-track') || document.getElementById('global-live-ticker');
      if (!track) return;
      hideTickerFloatTip();
      // TOP ticker = withdrawals ONLY (pending + sent). Offers stay in bottom Live Feed.
      const topItems = liveTickerItemsAll.filter(function (t) {
        return t && isWithdrawalActivityType(t.type);
      });
      if (!topItems.length) {
        track.innerHTML = `<span class="text-[11px] text-slate-600 font-medium shrink-0">Live withdrawals will appear here…</span>`;
        return;
      }

      function buildChipHtml(t, idx, dupKey) {
        const liveTime = t.createdAt ? formatTickerTime(t.createdAt) : (t.time || 'just now');
        t.time = liveTime;
        const isBinance = /binance/i.test(String(t.type || '')) || t.icon === '🟡' || t.icon === 'B';
        const iconBg = isBinance ? 'bg-[#F0B90B]' : 'bg-[#9195a1]';
        const iconFg = isBinance ? 'text-[#0b0e11] font-black' : 'text-white';
        const iconChar = isBinance ? 'B' : (t.icon || 'Ł');
        const safeId = String(t.id || idx).replace(/"/g, '') + (dupKey ? ('-d' + dupKey) : '');
        return `
          <div class="ticker-chip flex items-center gap-2 bg-[#1a1f28] border border-[#252b36] pl-1.5 pr-1.5 py-1 rounded-2xl shrink-0 hover:border-[#323846] transition" data-idx="${idx}" data-id="${safeId}">
            <span class="w-8 h-8 rounded-xl ${iconBg} ${iconFg} font-bold flex items-center justify-center text-[13px] shrink-0">${iconChar}</span>
            <div class="flex flex-col gap-0.5 min-w-0 pr-1 leading-tight">
              <span class="text-[#e2e6ed] font-semibold block text-[11px]">${t.type}</span>
              <span class="ticker-live-time text-[#6b7280] text-[10px] font-medium">${liveTime}</span>
            </div>
            <span class="bg-[#0b0e13] text-white font-bold text-[12px] px-3 py-1.5 rounded-full shrink-0 tabular-nums leading-none">${t.amount}</span>
          </div>
        `;
      }

      // Always render base set, then duplicate until the strip fills ~100% viewport width
      // (prevents empty black gap on the right when few live payouts exist)
      let html = topItems.map(function (t, idx) { return buildChipHtml(t, idx, 0); }).join('');
      const approxChipW = 168; // avg chip width incl. gap
      const targetW = Math.max(window.innerWidth || 1200, 1200);
      const minChips = Math.ceil(targetW / approxChipW) + 2;
      let dup = 1;
      let chipCount = topItems.length;
      while (chipCount < minChips && dup < 8) {
        html += topItems.map(function (t, idx) { return buildChipHtml(t, idx, dup); }).join('');
        chipCount += topItems.length;
        dup++;
      }
      track.innerHTML = html;
      bindTickerChipHovers(track);
      startTickerTimeClock();
    }

    function initLiveTickerDrag() {
      const el = document.getElementById('global-live-ticker-track') || document.getElementById('global-live-ticker');
      if (!el || el.dataset.dragBound) return;
      el.dataset.dragBound = '1';

      let isDown = false;
      let startX = 0;
      let scrollLeft = 0;
      let moved = false;

      // Expose drag state so chip clicks can ignore real drags
      window.__tickerDragMoved = false;

      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDown = true;
        moved = false;
        window.__tickerDragMoved = false;
        // Do NOT add is-dragging until user actually moves (keeps chip clicks working)
        startX = e.pageX - el.offsetLeft;
        scrollLeft = el.scrollLeft;
      });

      const endDrag = () => {
        isDown = false;
        el.classList.remove('is-dragging');
        // Keep __tickerDragMoved true until after click event
        setTimeout(() => { window.__tickerDragMoved = false; }, 0);
      };

      window.addEventListener('mouseup', endDrag);
      window.addEventListener('blur', endDrag);

      el.addEventListener('mouseleave', () => {
        if (isDown) endDrag();
      });

      el.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        const x = e.pageX - el.offsetLeft;
        const walk = (x - startX) * 1.35;
        if (Math.abs(walk) > 5) {
          moved = true;
          window.__tickerDragMoved = true;
          el.classList.add('is-dragging');
          e.preventDefault();
          el.scrollLeft = scrollLeft - walk;
        }
      });

      el.addEventListener('click', (e) => {
        if (moved || window.__tickerDragMoved) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);

      let touchStartX = 0;
      let touchScrollLeft = 0;
      el.addEventListener('touchstart', (e) => {
        if (!e.touches[0]) return;
        touchStartX = e.touches[0].pageX;
        touchScrollLeft = el.scrollLeft;
      }, { passive: true });
      el.addEventListener('touchmove', (e) => {
        if (!e.touches[0]) return;
        const dx = e.touches[0].pageX - touchStartX;
        el.scrollLeft = touchScrollLeft - dx;
      }, { passive: true });
    }

    function normalizeTickerAmount(amount) {
      if (typeof amount === 'number') return String(amount);
      return String(amount || '0').replace(/,/g, '').trim();
    }

        function tickerFingerprint(type, amount, username, status, meta) {
      const ty = String(type || '').toLowerCase().trim();
      const amt = normalizeTickerAmount(amount);
      const user = String(username || '').toLowerCase().trim();
      const st = String(status || '').toLowerCase().trim();
      const offer = String((meta && (meta.offerName || meta.offer_name)) || '').toLowerCase().trim();
      const tid = String((meta && (meta.trans_id || meta.transId || meta.eventId)) || '').toLowerCase().trim();
      // Include offer + trans id so distinct postbacks with same coins never collapse
      return ty + '|' + amt + '|' + user + '|' + st + '|' + offer + '|' + tid;
    }

    /**
     * Dedup rules:
     * - Offers / chargebacks: ONLY exact activity id (never amount+user window)
     * - Withdrawals: soft fingerprint within 2 minutes (local + server race)
     */
    function findDuplicateTickerItem(type, amount, username, status, createdAt, meta) {
      if (!isWithdrawalActivityType(type)) {
        return null; // offer completions & chargebacks are never soft-deduped
      }
      const fp = tickerFingerprint(type, amount, username, status, meta);
      const nowTs = createdAt ? new Date(createdAt).getTime() : Date.now();
      const WINDOW_MS = 2 * 60 * 1000;
      return liveTickerItemsAll.find(t => {
        if (!t) return false;
        if (!isWithdrawalActivityType(t.type)) return false;
        const tFp = tickerFingerprint(t.type, t.amount, t.username, t.status, {
          offerName: t.offerName,
          trans_id: t.trans_id
        });
        if (tFp !== fp) return false;
        const tTs = t.createdAt ? new Date(t.createdAt).getTime() : 0;
        if (!tTs || !nowTs) return true;
        return Math.abs(nowTs - tTs) < WINDOW_MS;
      }) || null;
    }

function prependLiveTicker(type, amount, icon = '⚡', status = '', activityId = null, createdAt = null, meta = {}) {
      const amtStr = (typeof amount === 'number')
        ? amount.toLocaleString()
        : String(amount);
      const username = (meta && meta.username) || '';
      const id = activityId || ('local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));

      // Exact id already shown
      if (seenActivityIds.has(id)) return;

      // Dedup by trans_id (DB trigger + API insert + realtime can overlap)
      const tid = meta && (meta.trans_id || meta.transId) ? String(meta.trans_id || meta.transId).trim() : '';
      if (tid) {
        if (seenActivityIds.has('tid:' + tid)) return;
        const tidDup = liveTickerItemsAll.find(function (t) {
          return t && t.trans_id && String(t.trans_id) === tid;
        });
        if (tidDup) {
          if (activityId && String(tidDup.id).startsWith('local_')) {
            seenActivityIds.delete(tidDup.id);
            tidDup.id = activityId;
            seenActivityIds.add(activityId);
          }
          seenActivityIds.add('tid:' + tid);
          return;
        }
        seenActivityIds.add('tid:' + tid);
      }

      // Near-identical offer rows within 90s (same user + coins; titles may differ
      // e.g. "Offer Completed" vs real offer_name from notif vs live_activity)
      if (!isWithdrawalActivityType(type)) {
        const nowTs = createdAt ? new Date(createdAt).getTime() : Date.now();
        const amtN = normalizeTickerAmount(amount);
        function isGenericOfferTitle(s) {
          const x = String(s || '').toLowerCase().trim();
          return !x || x === 'offer' || x === 'offer completed' || x === 'offer reversed'
            || x === 'offer_complete' || x === 'offer_reversal' || x === 'offerwall';
        }
        const near = liveTickerItemsAll.find(function (t) {
          if (!t || isWithdrawalActivityType(t.type)) return false;
          if (normalizeTickerAmount(t.amount) !== amtN) return false;
          const u1 = String(username || '').toLowerCase();
          const u2 = String(t.username || '').toLowerCase();
          if (u1 && u2 && u1 !== u2) return false;
          const o1 = String((meta && meta.offerName) || '').toLowerCase();
          const o2 = String(t.offerName || '').toLowerCase();
          // If both have specific different names, not a dup
          if (o1 && o2 && !isGenericOfferTitle(o1) && !isGenericOfferTitle(o2) && o1 !== o2) return false;
          const tTs = t.createdAt ? new Date(t.createdAt).getTime() : 0;
          if (!tTs || !nowTs) return false;
          return Math.abs(nowTs - tTs) < 90000;
        });
        if (near) {
          // Prefer server uuid over local/notif id
          if (activityId && String(near.id).startsWith('local_') || (activityId && String(near.id).indexOf('la_notif_') === 0 && !String(activityId).startsWith('la_'))) {
            seenActivityIds.delete(near.id);
            near.id = activityId;
            seenActivityIds.add(activityId);
            if (createdAt) near.createdAt = createdAt;
            if (meta && meta.provider) near.provider = meta.provider;
            if (meta && meta.offerName) near.offerName = meta.offerName;
            if (tid) near.trans_id = tid;
            syncPublicLiveTickerItems();
            saveLiveTickerToStorage();
            renderGlobalLiveTicker();
          }
          return;
        }
      }

      // Soft dedupe ONLY for withdrawals (local placeholder vs server row)
      const dup = findDuplicateTickerItem(type, amount, username, status, createdAt, meta);
      if (dup) {
        if (activityId && String(dup.id).startsWith('local_')) {
          seenActivityIds.delete(dup.id);
          dup.id = activityId;
          seenActivityIds.add(activityId);
          if (createdAt && !dup.createdAt) dup.createdAt = createdAt;
          if (username && !dup.username) dup.username = username;
          if (meta && meta.offerName && !dup.offerName) dup.offerName = meta.offerName;
          if (meta && meta.provider && !dup.provider) dup.provider = meta.provider;
          syncPublicLiveTickerItems();
          saveLiveTickerToStorage();
          renderGlobalLiveTicker();
        } else if (activityId) {
          seenActivityIds.add(activityId);
        }
        return;
      }

      seenActivityIds.add(id);

      liveTickerItemsAll.unshift({
        id: id,
        type: type,
        amount: amtStr,
        time: formatTickerTime(createdAt),
        icon: icon || 'Ł',
        status: status || '',
        username: username,
        offerName: (meta && meta.offerName) || '',
        provider: (meta && meta.provider) || '',
        trans_id: (meta && (meta.trans_id || meta.transId)) || '',
        createdAt: createdAt || null
      });
      if (liveTickerItemsAll.length > LIVE_TICKER_MAX) {
        const removed = liveTickerItemsAll.pop();
        if (removed && removed.id) seenActivityIds.delete(removed.id);
      }
      // Bottom Live Feed only gets Sent/Paid withdrawals (+ all offers)
      syncPublicLiveTickerItems();
      saveLiveTickerToStorage();
      renderGlobalLiveTicker();
      if (currentTab === 'home' || currentTab === 'premium') renderHome();
    }

    async function broadcastLiveActivity(type, amount, icon, status, meta = {}) {
      const uname = (meta.username || getDisplayUsername() || '').trim();
      const fullMeta = {
        username: uname && uname !== 'Guest' && uname !== 'Guest User' ? uname : getDisplayUsername(),
        offerName: meta.offerName || '',
        provider: meta.provider || ''
      };
      const createdAt = new Date().toISOString();
      // Only show once locally; server id will merge into same chip
      prependLiveTicker(type, amount, icon, status, null, createdAt, fullMeta);

      if (!db) return;
      try {
        const amtNum = typeof amount === 'number' ? amount : parseInt(String(amount).replace(/,/g, ''), 10) || 0;
        const payload = {
          type: String(type || 'Offer'),
          amount: amtNum,
          icon: icon || 'Ł',
          status: status || '',
          username: fullMeta.username || null
        };
        if (currentUser && currentUser.id) {
          payload.user_id = currentUser.id;
        }

        // Single insert attempt — avoid double-row if username column missing
        let data = null;
        let error = null;
        let res = await db.from('live_activity').insert(payload).select('id');
        data = res.data;
        error = res.error;

        if (error) {
          const fallback = {
            type: payload.type,
            amount: payload.amount,
            icon: payload.icon,
            status: payload.status
          };
          if (payload.user_id) fallback.user_id = payload.user_id;
          const retry = await db.from('live_activity').insert(fallback).select('id');
          data = retry.data;
          error = retry.error;
          if (error) {
            console.error('live_activity INSERT ERROR:', error.message, error);
            return;
          }
        }
        if (data && data[0] && data[0].id) {
          // Merge server id into the local chip we just added (no second chip)
          prependLiveTicker(type, amount, icon, status, data[0].id, createdAt, fullMeta);
        }
      } catch (e) {
        console.error('broadcastLiveActivity exception', e);
      }
    }

    
    async function pollLiveActivityOnce() {
      if (!db) return;
      try {
        let q = db
          .from('live_activity')
          .select('id, type, amount, coins, icon, status, created_at, user_id, username, provider, offer_name, offer_id, trans_id')
          .order('created_at', { ascending: false })
          .limit(15);
        if (liveFeedLastSeenAt) {
          q = q.gt('created_at', liveFeedLastSeenAt);
        }
        let res = await q;
        if (res.error) {
          res = await db
            .from('live_activity')
            .select('id, type, amount, icon, status, created_at, user_id, username')
            .order('created_at', { ascending: false })
            .limit(15);
        }
        if (res.error || !res.data || !res.data.length) return;
        // process oldest→newest so prepend ends newest-first
        const rows = res.data.slice().reverse();
        for (const row of rows) {
          if (!row) continue;
          if (row.created_at && (!liveFeedLastSeenAt || row.created_at > liveFeedLastSeenAt)) {
            liveFeedLastSeenAt = row.created_at;
          }
          if (row.id && seenActivityIds.has(row.id)) continue;
          const uname = await resolveActivityUsername(row);
          const rowAmt = (row.coins != null && row.coins !== '') ? row.coins : row.amount;
          const rowType = row.type || 'Offer';
          let rowStatus = row.status || '';
          if (!rowStatus) {
            const ty = String(rowType).toLowerCase();
            if (ty.includes('revers') || ty.includes('charge')) rowStatus = 'Cashback';
            else if (!isWithdrawalActivityType(rowType)) rowStatus = 'Complete';
          }
          prependLiveTicker(
            rowType,
            rowAmt,
            row.icon || (String(rowType).toLowerCase().includes('revers') ? '↩' : '⚡'),
            rowStatus,
            row.id,
            row.created_at,
            {
              username: uname || row.username || '',
              offerName: row.offer_name || '',
              provider: row.provider || ''
            }
          );
        }
        try { syncPublicLiveTickerItems(); } catch (eS) {}
        try { renderGlobalLiveTicker(); } catch (eT) {}
        try {
          if (typeof currentTab !== 'undefined' && (currentTab === 'home' || currentTab === 'premium') && typeof renderHome === 'function') {
            renderHome();
          }
        } catch (eH) {}
      } catch (e) {
        console.warn('[live_activity poll]', e && e.message);
      }
    }

    function startLiveFeedPolling() {
      try {
        if (liveFeedPollTimer) clearInterval(liveFeedPollTimer);
      } catch (e) {}
      // Fallback every 8s if realtime is delayed/disconnected
      liveFeedPollTimer = setInterval(function () {
        pollLiveActivityOnce();
      }, 8000);
      // Immediate catch-up after subscribe
      setTimeout(function () { pollLiveActivityOnce(); }, 1500);
    }

async function initSharedLiveFeed() {
      // Optional fast paint from cache ONLY — Supabase is the permanent global source of truth
      try { loadLiveTickerFromStorage(); } catch (eC) {}
      syncPublicLiveTickerItems();
      renderGlobalLiveTicker();
      try { initLiveTickerDrag(); } catch (eD) {}

      if (!db) {
        if (currentTab === 'home' || currentTab === 'premium') renderHome();
        return;
      }

      try {
        // Prefer full column set; fall back to minimal schema used by broadcastLiveActivity
        let data = null;
        let error = null;
        let res = await db
          .from('live_activity')
          .select('id, type, amount, coins, icon, status, created_at, user_id, username, provider, offer_name, offer_id, trans_id')
          .order('created_at', { ascending: false })
          .limit(LIVE_TICKER_MAX);
        data = res.data;
        error = res.error;

        if (error) {
          res = await db
            .from('live_activity')
            .select('id, type, amount, icon, status, created_at, user_id, username')
            .order('created_at', { ascending: false })
            .limit(LIVE_TICKER_MAX);
          data = res.data;
          error = res.error;
        }

        if (error) {
          res = await db
            .from('live_activity')
            .select('id, type, amount, icon, status, created_at, user_id')
            .order('created_at', { ascending: false })
            .limit(LIVE_TICKER_MAX);
          data = res.data;
          error = res.error;
        }

        if (!error && data && data.length) {
          // Rebuild from server rows (newest first) so stale localStorage cannot pin old rows on top
          const serverItems = [];
          const serverIds = new Set();

          for (const row of data) {
            if (!row || row.id == null) continue;
            const uname = await resolveActivityUsername(row);
            const rowAmt = (row.coins != null && row.coins !== '') ? row.coins : row.amount;
            const rowType = row.type || 'offer_complete';
            let rowStatus = row.status || '';
            if (!rowStatus) {
              const ty = String(rowType).toLowerCase();
              if (ty.includes('revers') || ty.includes('charge')) rowStatus = 'Cashback';
              else if (!isWithdrawalActivityType(rowType)) rowStatus = 'Complete';
            }
            const amtStr = (typeof rowAmt === 'number')
              ? rowAmt.toLocaleString()
              : String(rowAmt != null ? rowAmt : '0');
            const id = row.id;
            serverIds.add(String(id));
            serverItems.push({
              id: id,
              type: rowType,
              amount: amtStr,
              time: formatTickerTime(row.created_at),
              icon: row.icon && row.icon !== 'Ł' ? row.icon : (String(rowType).toLowerCase().includes('revers') || String(rowStatus).toLowerCase().includes('cashback') ? '↩' : (isWithdrawalActivityType(rowType) ? 'Ł' : '⚡')),
              status: rowStatus,
              username: uname || row.username || '',
              offerName: row.offer_name || row.offerName || '',
              provider: row.provider || '',
              trans_id: row.trans_id || '',
              createdAt: row.created_at || null,
              user_id: row.user_id || null
            });
            if (row.trans_id) seenActivityIds.add('tid:' + String(row.trans_id));
            if (!uname && row.user_id) {
              resolveActivityUsername(row).then(name => {
                if (name) patchTickerUsername(row.id, name);
              });
            }
          }

          // Merge server + local cache so postback-driven rows survive reloads even if
          // live_activity insert was delayed, while never double-listing the same event.
          const byId = new Map();
          serverItems.forEach(function (it) {
            if (it && it.id != null) byId.set(String(it.id), it);
          });

          function softOfferDup(a, b) {
            if (!a || !b) return false;
            if (isWithdrawalActivityType(a.type) || isWithdrawalActivityType(b.type)) return false;
            const amtA = normalizeTickerAmount(a.amount);
            const amtB = normalizeTickerAmount(b.amount);
            if (amtA !== amtB) return false;
            const stA = String(a.status || '').toLowerCase();
            const stB = String(b.status || '').toLowerCase();
            if (stA && stB && stA !== stB) return false;
            const userA = String(a.username || '').toLowerCase();
            const userB = String(b.username || '').toLowerCase();
            if (userA && userB && userA !== userB) return false;
            const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            if (tA && tB && Math.abs(tA - tB) > 120000) return false; // 2 min window only
            // Same coins + user + status within 2 min → same event (server uuid vs la_notif_*)
            return true;
          }

          const prior = (liveTickerItemsAll || []).slice();
          prior.forEach(function (t) {
            if (!t || t.id == null) return;
            const sid = String(t.id);
            if (byId.has(sid)) return;
            // Keep recent offer/chargeback cache rows that are not already represented on server
            const isOfferLike = !isWithdrawalActivityType(t.type);
            if (isOfferLike) {
              let dup = false;
              byId.forEach(function (s) {
                if (softOfferDup(t, s)) dup = true;
              });
              if (dup) return;
              byId.set(sid, t);
              return;
            }
            // Keep local withdrawal placeholders
            if (String(t.id).startsWith('local_') || String(t.id).startsWith('stored_')) {
              byId.set(sid, t);
            }
          });

          liveTickerItemsAll = Array.from(byId.values());
          // Collapse residual pairs: generic title + real offer_name, same user+coins within 2min
          (function collapseGenericOfferDupes() {
            function gen(s) {
              const x = String(s || '').toLowerCase().trim();
              return !x || x === 'offer' || x === 'offer completed' || x === 'offer reversed'
                || x === 'offer_complete' || x === 'offer_reversal';
            }
            const keep = [];
            const used = new Set();
            const sorted = liveTickerItemsAll.slice().sort(function (a, b) {
              return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
            });
            sorted.forEach(function (t, i) {
              if (!t || used.has(i)) return;
              if (isWithdrawalActivityType(t.type)) { keep.push(t); return; }
              const amt = normalizeTickerAmount(t.amount);
              const user = String(t.username || '').toLowerCase();
              let best = t;
              for (let j = i + 1; j < sorted.length; j++) {
                if (used.has(j)) continue;
                const o = sorted[j];
                if (!o || isWithdrawalActivityType(o.type)) continue;
                if (normalizeTickerAmount(o.amount) !== amt) continue;
                if (user && String(o.username || '').toLowerCase() !== user) continue;
                const ta = new Date(t.createdAt || 0).getTime();
                const tb = new Date(o.createdAt || 0).getTime();
                if (Math.abs(ta - tb) > 120000) continue;
                // prefer row with trans_id and non-generic offerName
                const score = function (x) {
                  let s = 0;
                  if (x.trans_id) s += 4;
                  if (!gen(x.offerName)) s += 2;
                  if (x.provider && x.provider !== 'Offerwall') s += 1;
                  return s;
                };
                if (score(o) > score(best)) best = o;
                used.add(j);
              }
              keep.push(best);
            });
            liveTickerItemsAll = keep;
          })();

          seenActivityIds.clear();
          liveTickerItemsAll.forEach(function (t) {
            if (t && t.id != null) seenActivityIds.add(t.id);
          });
          syncPublicLiveTickerItems();
          saveLiveTickerToStorage();
        }
      } catch (e) {
        console.warn('live_activity fetch failed', e);
      }

      renderGlobalLiveTicker();
      if (currentTab === 'home' || currentTab === 'premium') renderHome();

      try {
        if (liveFeedChannel) {
          db.removeChannel(liveFeedChannel);
          liveFeedChannel = null;
        }
        liveFeedChannel = db
          .channel('live_activity_feed')
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'live_activity' },
            async (payload) => {
              const row = payload.new;
              if (!row) return;
              const uname = await resolveActivityUsername(row);
              const rowAmt = (row.coins != null && row.coins !== '') ? row.coins : row.amount;
              const rowType = row.type || 'offer_complete';
              let rowStatus = row.status || '';
              if (!rowStatus) {
                const ty = String(rowType).toLowerCase();
                if (ty.includes('revers') || ty.includes('charge')) rowStatus = 'Cashback';
                else if (!isWithdrawalActivityType(rowType)) rowStatus = 'Complete';
              }
              prependLiveTicker(
                rowType,
                rowAmt,
                row.icon || (String(rowType).toLowerCase().includes('revers') ? '↩' : '⚡'),
                rowStatus,
                row.id,
                row.created_at,
                {
                  username: uname,
                  offerName: row.offer_name || '',
                  provider: row.provider || '',
                  trans_id: row.trans_id || ''
                }
              );
              // Force newest-first + home re-render so Live Feed updates immediately
              try { syncPublicLiveTickerItems(); } catch (eS) {}
              try { renderGlobalLiveTicker(); } catch (eT) {}
              try {
                if (currentTab === 'home' || currentTab === 'premium') renderHome();
              } catch (eH) {}
              if (!uname && row.user_id) {
                resolveActivityUsername(row).then(name => {
                  if (name) patchTickerUsername(row.id, name);
                });
              }
            }
          )
          .subscribe();
      } catch (e) {
        console.warn('Realtime subscribe failed', e);
      }

      try { startLiveFeedPolling(); } catch (ePoll) {}
    }


// Fast first paint: hydrate ticker from localStorage as soon as DOM is ready
    // (full Supabase sync still runs via initSharedLiveFeed from auth boot)
    (function earlyTickerPaint() {
      function paint() {
        try {
          if (!liveTickerItemsAll.length) loadLiveTickerFromStorage();
          syncPublicLiveTickerItems();
          renderGlobalLiveTicker();
        } catch (e) {}
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', paint, { once: true });
      } else {
        paint();
      }
    })();
