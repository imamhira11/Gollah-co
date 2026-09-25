/* live-ticker.js — Live activity ticker, shared feed, realtime subscriptions */
    // Live Ticker — PERMANENT (localStorage + shared Supabase). Never auto-wipe your withdraws.
    let liveTickerItems = [];
    let liveFeedChannel = null;
    const seenActivityIds = new Set();
    const LIVE_TICKER_STORAGE_KEY = 'gollah_live_ticker_v5';
    const LIVE_TICKER_MAX = 20;

    function saveLiveTickerToStorage() {
      try {
        localStorage.setItem(LIVE_TICKER_STORAGE_KEY, JSON.stringify(liveTickerItems.slice(0, LIVE_TICKER_MAX)));
      } catch (e) {}
    }

    function loadLiveTickerFromStorage() {
      try {
        const raw = localStorage.getItem(LIVE_TICKER_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.length) return;
        liveTickerItems = [];
        seenActivityIds.clear();
        const fpSeen = new Set();
        parsed.forEach(item => {
          if (!item || !item.type) return;
          const id = item.id || ('stored_' + item.type + '_' + item.amount + '_' + (item.time || ''));
          if (seenActivityIds.has(id)) return;
          // Drop stored duplicates of the same withdraw/offer
          const fp = String(item.type || '').toLowerCase() + '|' +
            String(item.amount || '0').replace(/,/g, '') + '|' +
            String(item.username || '').toLowerCase() + '|' +
            String(item.status || '').toLowerCase();
          if (fpSeen.has(fp)) return;
          fpSeen.add(fp);
          seenActivityIds.add(id);
          seenActivityIds.add('fp:' + fp);
          liveTickerItems.push({
            id: id,
            type: item.type,
            amount: String(item.amount),
            time: item.time || 'just now',
            icon: item.icon || 'Ł',
            status: item.status || '',
            username: item.username || '',
            offerName: item.offerName || '',
            provider: item.provider || '',
            createdAt: item.createdAt || null
          });
        });
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

    // Refresh live ticker relative times every few seconds (seconds ago → minutes ago…)
    let tickerTimeInterval = null;
    function startTickerTimeClock() {
      if (tickerTimeInterval) return;
      tickerTimeInterval = setInterval(() => {
        // Update stored relative time strings from createdAt
        let changed = false;
        liveTickerItems.forEach(t => {
          if (t.createdAt) {
            const next = formatTickerTime(t.createdAt);
            if (t.time !== next) {
              t.time = next;
              changed = true;
            }
          }
        });
        if (changed) {
          // Soft-update only time labels in DOM if possible, else full re-render
          const track = document.getElementById('global-live-ticker-track');
          if (track) {
            track.querySelectorAll('.ticker-chip').forEach(chip => {
              const idx = parseInt(chip.getAttribute('data-idx'), 10);
              const item = liveTickerItems[idx];
              if (!item) return;
              const timeEl = chip.querySelector('.ticker-live-time');
              if (timeEl) timeEl.textContent = item.time || formatTickerTime(item.createdAt);
            });
          }
        }
      }, 4000);
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
      const item = liveTickerItems.find(t => t.id === activityId);
      if (!item) return;
      if (item.username && item.username !== 'Member' && item.username !== 'Someone') return;
      item.username = username;
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

    function bindTickerChipHovers(track) {
      track.querySelectorAll('.ticker-chip').forEach(chip => {
        chip.style.cursor = 'pointer';
        chip.addEventListener('mouseenter', () => {
          const idx = parseInt(chip.getAttribute('data-idx'), 10);
          const item = liveTickerItems[idx];
          if (!item) return;
          showTickerFloatTip(chip, buildTickerTooltip(item));
        });
        chip.addEventListener('mouseleave', hideTickerFloatTip);
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          // Ignore real drag scrolls
          if (window.__tickerDragMoved) return;
          const idx = parseInt(chip.getAttribute('data-idx'), 10);
          const item = liveTickerItems[idx];
          if (!item) return;
          hideTickerFloatTip();
          openPublicProfileModal(item.username || 'Member', item);
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
      const m = document.getElementById('public-profile-modal');
      if (m) m.classList.add('hidden');
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
      const uname = (username && String(username).trim()) ? String(username).trim() : 'Member';
      const modal = document.getElementById('public-profile-modal');
      const body = document.getElementById('pp-body');
      const nameEl = document.getElementById('pp-username');
      const subEl = document.getElementById('pp-subtitle');
      if (!modal || !body) return;

      nameEl.textContent = uname;
      subEl.textContent = 'Loading activity…';
      body.innerHTML = `<div class="py-10 text-center text-[12px] text-slate-500">Loading…</div>`;
      modal.classList.remove('hidden');
      if (window.lucide) lucide.createIcons();

      const isPrivate = await isProfilePrivateByUsername(uname);
      if (isPrivate) {
        subEl.textContent = 'Private account';
        body.innerHTML = `
          <div class="flex flex-col items-center justify-center py-12 px-6 text-center">
            <div class="w-14 h-14 rounded-2xl bg-[#1a2530] border border-[#243040] flex items-center justify-center mb-4">
              <i data-lucide="eye-off" class="w-6 h-6 text-slate-500"></i>
            </div>
            <p class="text-[15px] font-bold text-white mb-1">Profile is private</p>
            <p class="text-[12px] text-slate-500 max-w-[260px]">This user has enabled private mode. Offers and withdrawals are hidden.</p>
          </div>
        `;
        if (window.lucide) lucide.createIcons();
        return;
      }

      const activities = await fetchUserPublicActivity(uname);
      // Ensure seed item is included
      if (seedItem && seedItem.username) {
        const has = activities.some(a => a.id === seedItem.id);
        if (!has) activities.unshift(seedItem);
      }

      const offers = activities.filter(t => !isWithdrawalTickerType(t.type));
      const withdraws = activities.filter(t => isWithdrawalTickerType(t.type));

      subEl.textContent = `${offers.length} offers · ${withdraws.length} withdrawals`;

      if (!activities.length) {
        body.innerHTML = `
          <div class="py-10 text-center text-[12px] text-slate-500">No public activity found for this user.</div>
        `;
        return;
      }

      let html = '';

      if (offers.length) {
        html += `<div class="text-[11px] font-bold uppercase tracking-wider text-slate-500 px-1">Offers completed</div>`;
        html += offers.map(t => {
          const timeStr = t.createdAt ? formatTickerTime(t.createdAt) : (t.time || '');
          const matched = findOfferFromActivity(t);
          const offerTitle = t.offerName || (matched && matched.name) || t.type || 'Offer';
          const wall = t.provider || (matched && matched.provider) || 'Network';
          const startBtn = matched
            ? `<button type="button" onclick="event.stopPropagation(); startOfferFromActivity('${matched.id}')" class="mt-2.5 w-full text-[13px] font-extrabold py-2.5 rounded-xl bg-[#00d672] text-black hover:bg-[#00be64] transition shadow-md shadow-emerald-950/30">Start this offer</button>`
            : `<button type="button" onclick="event.stopPropagation(); showAppAlert('This offer is not in the current catalog.', { title: 'Unavailable', type: 'info' })" class="mt-2.5 w-full text-[13px] font-bold py-2.5 rounded-xl bg-[#1a2530] text-slate-400 border border-[#243040]">Offer info only</button>`;
          return `
            <div class="bg-[#0e1620] border border-[#1a2530] rounded-xl p-3 flex items-start gap-3">
              <span class="w-9 h-9 rounded-xl bg-[#16202a] border border-[#1e2a38] flex items-center justify-center text-sm shrink-0">${t.icon || '⚡'}</span>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-[13px] font-semibold text-white truncate">${offerTitle}</span>
                  <span class="coin-amt font-bold text-[12px] shrink-0">● ${t.amount}</span>
                </div>
                <div class="text-[11px] text-slate-500 mt-0.5">Wall: <span class="text-emerald-400/90">${wall}</span> · ${timeStr}</div>
                <div class="flex items-center gap-2 flex-wrap mt-1">
                  <span class="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400">${t.status || 'Complete'}</span>
                </div>
                ${startBtn}
              </div>
            </div>
          `;
        }).join('');
      }

      if (withdraws.length) {
        html += `<div class="text-[11px] font-bold uppercase tracking-wider text-slate-500 px-1 mt-2">Withdrawals</div>`;
        html += withdraws.map(t => {
          const timeStr = t.createdAt ? formatTickerTime(t.createdAt) : (t.time || '');
          const isPending = (t.status || '') === 'Pending';
          return `
            <div class="bg-[#0e1620] border border-[#1a2530] rounded-xl p-3 flex items-start gap-3">
              <span class="w-9 h-9 rounded-xl bg-[#16202a] border border-[#1e2a38] flex items-center justify-center text-sm shrink-0">${t.icon || 'Ł'}</span>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-[13px] font-semibold text-white truncate">${t.type} withdraw</span>
                  <span class="coin-amt font-bold text-[12px] shrink-0">● ${t.amount}</span>
                </div>
                <div class="text-[11px] text-slate-500 mt-0.5">${timeStr}</div>
                <span class="inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-md ${isPending ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/15 text-emerald-400'}">${t.status || 'Sent'}</span>
                <p class="text-[10px] text-slate-600 mt-2">Info only — withdrawals cannot be started from here.</p>
              </div>
            </div>
          `;
        }).join('');
      }

      body.innerHTML = html;
      if (window.lucide) lucide.createIcons();
    }

    function renderGlobalLiveTicker() {
      const track = document.getElementById('global-live-ticker-track') || document.getElementById('global-live-ticker');
      if (!track) return;
      hideTickerFloatTip();
      if (!liveTickerItems.length) {
        track.innerHTML = `<span class="text-[11px] text-slate-600 font-medium shrink-0">Live activity will appear here…</span>`;
        return;
      }
      track.innerHTML = liveTickerItems.map((t, idx) => {
        // Live relative time (updates via startTickerTimeClock)
        const liveTime = t.createdAt ? formatTickerTime(t.createdAt) : (t.time || 'just now');
        t.time = liveTime;
        const isBinance = /binance/i.test(String(t.type || '')) || t.icon === '🟡' || t.icon === 'B';
        const iconBg = isBinance ? 'bg-[#F0B90B]' : 'bg-[#9195a1]';
        const iconFg = isBinance ? 'text-[#0b0e11] font-black' : 'text-white';
        const iconChar = isBinance ? 'B' : (t.icon || 'Ł');
        return `
          <div class="ticker-chip flex items-center gap-2 bg-[#1a1f28] border border-[#252b36] pl-1.5 pr-1.5 py-1 rounded-2xl shrink-0 hover:border-[#323846] transition" data-idx="${idx}">
            <span class="w-8 h-8 rounded-xl ${iconBg} ${iconFg} font-bold flex items-center justify-center text-[13px] shrink-0">${iconChar}</span>
            <div class="flex flex-col gap-0.5 min-w-0 pr-1 leading-tight">
              <span class="text-[#e2e6ed] font-semibold block text-[11px]">${t.type}</span>
              <span class="ticker-live-time text-[#6b7280] text-[10px] font-medium">${liveTime}</span>
            </div>
            <span class="bg-[#0b0e13] text-white font-bold text-[12px] px-3 py-1.5 rounded-full shrink-0 tabular-nums leading-none">${t.amount}</span>
          </div>
        `;
      }).join('');
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

    function tickerFingerprint(type, amount, username, status) {
      const ty = String(type || '').toLowerCase().trim();
      const amt = normalizeTickerAmount(amount);
      const user = String(username || '').toLowerCase().trim();
      const st = String(status || '').toLowerCase().trim();
      return ty + '|' + amt + '|' + user + '|' + st;
    }

    function findDuplicateTickerItem(type, amount, username, status, createdAt) {
      const fp = tickerFingerprint(type, amount, username, status);
      const nowTs = createdAt ? new Date(createdAt).getTime() : Date.now();
      // Same action within 5 minutes counts as duplicate (local id + server id + reload)
      const WINDOW_MS = 5 * 60 * 1000;
      return liveTickerItems.find(t => {
        if (!t) return false;
        const tFp = tickerFingerprint(t.type, t.amount, t.username, t.status);
        if (tFp !== fp) return false;
        const tTs = t.createdAt ? new Date(t.createdAt).getTime() : 0;
        if (!tTs || !nowTs) return true;
        return Math.abs(nowTs - tTs) < WINDOW_MS;
      }) || null;
    }

    function prependLiveTicker(type, amount, icon = 'Ł', status = '', activityId = null, createdAt = null, meta = {}) {
      const amtStr = (typeof amount === 'number')
        ? amount.toLocaleString()
        : String(amount);
      const username = (meta && meta.username) || '';
      const id = activityId || ('local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));

      // Exact id already shown
      if (seenActivityIds.has(id)) return;

      // Same withdraw/offer already on bar (local + realtime + DB fetch)
      const dup = findDuplicateTickerItem(type, amount, username, status, createdAt);
      if (dup) {
        // Promote local placeholder to real server id when realtime/DB arrives
        if (activityId && String(dup.id).startsWith('local_')) {
          seenActivityIds.delete(dup.id);
          dup.id = activityId;
          seenActivityIds.add(activityId);
          if (createdAt && !dup.createdAt) dup.createdAt = createdAt;
          if (username && !dup.username) dup.username = username;
          saveLiveTickerToStorage();
          renderGlobalLiveTicker();
        } else if (activityId) {
          seenActivityIds.add(activityId);
        }
        return;
      }

      seenActivityIds.add(id);
      // Also track fingerprint key to block rapid double-broadcast
      seenActivityIds.add('fp:' + tickerFingerprint(type, amount, username, status));

      liveTickerItems.unshift({
        id: id,
        type: type,
        amount: amtStr,
        time: formatTickerTime(createdAt),
        icon: icon || 'Ł',
        status: status || '',
        username: username,
        offerName: (meta && meta.offerName) || '',
        provider: (meta && meta.provider) || '',
        createdAt: createdAt || null
      });
      if (liveTickerItems.length > LIVE_TICKER_MAX) {
        const removed = liveTickerItems.pop();
        if (removed && removed.id) seenActivityIds.delete(removed.id);
      }
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

    async function initSharedLiveFeed() {
      loadLiveTickerFromStorage();

      // Drop stale items that have no real username (old "Someone" bug)
      liveTickerItems = liveTickerItems.filter(t => {
        if (!t) return false;
        // keep demos & items that already have a name
        return true;
      });

      if (!liveTickerItems.length) {
        liveTickerItems = [
          { id: 'demo1', type: 'LTC', amount: '805', time: '', icon: 'Ł', status: 'Sent', username: 'The KHALID', offerName: '', provider: '', createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
          { id: 'demo2', type: 'Binance', amount: '1,500', time: '', icon: 'B', status: 'Sent', username: 'CryptoKing', offerName: '', provider: '', createdAt: new Date(Date.now() - 14 * 60 * 1000).toISOString() },
          { id: 'demo3', type: 'Offer', amount: '2,500', time: '', icon: '⚡', status: 'Complete', username: 'SaraBD', offerName: 'TheoremReach Surveys', provider: 'TheoremReach', createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
          { id: 'demo4', type: 'LTC', amount: '300', time: '', icon: 'Ł', status: 'Pending', username: 'Rafi', offerName: '', provider: '', createdAt: new Date(Date.now() - 8 * 1000).toISOString() },
          { id: 'demo5', type: 'Offer', amount: '43,500', time: '', icon: '⚡', status: 'Complete', username: 'GamerPro', offerName: 'RAID Shadow Legends', provider: 'Adgate', createdAt: new Date(Date.now() - 22 * 60 * 1000).toISOString() },
          { id: 'demo6', type: 'Binance', amount: '300', time: '', icon: 'B', status: 'Pending', username: 'Nila', offerName: '', provider: '', createdAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() }
        ];
        liveTickerItems.forEach(d => seenActivityIds.add(d.id));
        saveLiveTickerToStorage();
      }

      renderGlobalLiveTicker();
      initLiveTickerDrag();

      if (!db) {
        if (currentTab === 'home' || currentTab === 'premium') renderHome();
        return;
      }

      try {
        // Prefer columns with username + user_id; fallback if username col missing
        let data = null;
        let error = null;
        let res = await db
          .from('live_activity')
          .select('id, type, amount, icon, status, created_at, user_id, username')
          .order('created_at', { ascending: false })
          .limit(LIVE_TICKER_MAX);
        data = res.data;
        error = res.error;

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
          for (const row of data.reverse()) {
            const uname = await resolveActivityUsername(row);
            prependLiveTicker(
              row.type,
              row.amount,
              row.icon || 'Ł',
              row.status || '',
              row.id,
              row.created_at,
              {
                username: uname,
                offerName: row.offer_name || row.offerName || '',
                provider: row.provider || ''
              }
            );
            // If still empty, async profile resolve may fill later
            if (!uname && row.user_id) {
              resolveActivityUsername(row).then(name => {
                if (name) patchTickerUsername(row.id, name);
              });
            }
          }
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
              prependLiveTicker(
                row.type,
                row.amount,
                row.icon || 'Ł',
                row.status || '',
                row.id,
                row.created_at,
                {
                  username: uname,
                  offerName: row.offer_name || '',
                  provider: row.provider || ''
                }
              );
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
    }

