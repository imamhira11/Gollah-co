/* auth.js — Login, signup, logout, privacy, banned screen, session */

    // ─── Global Announcement Banner (class: .global-announcement-banner) ───
    // Storage key requested by product: 'announcement_hidden'
    const ANNOUNCEMENT_STORAGE_KEY = 'announcement_hidden';
    const ANNOUNCEMENT_SHOW_MS = 20000; // exactly 20 seconds after login
    let announcementHideTimer = null;

    function getAnnouncementBannerEl() {
      return document.getElementById('global-announcement-banner');
    }

    function isAnnouncementHiddenFlag() {
      try {
        return localStorage.getItem(ANNOUNCEMENT_STORAGE_KEY) === 'true';
      } catch (e) {
        return false;
      }
    }

    function setAnnouncementHiddenFlag(val) {
      try {
        if (val) localStorage.setItem(ANNOUNCEMENT_STORAGE_KEY, 'true');
        else localStorage.removeItem(ANNOUNCEMENT_STORAGE_KEY);
      } catch (e) {}
    }

    function showAnnouncementBanner() {
      const el = getAnnouncementBannerEl();
      if (!el) return;
      el.classList.remove('gab-hiding', 'hidden');
      el.style.display = '';
      el.style.opacity = '';
      el.style.maxHeight = '';
      el.style.pointerEvents = '';
    }

    function hideAnnouncementBanner(immediate) {
      const el = getAnnouncementBannerEl();
      if (!el) return;
      if (immediate) {
        el.classList.add('gab-hiding', 'hidden');
        el.style.display = 'none';
        el.style.opacity = '0';
        el.style.maxHeight = '0';
        el.style.pointerEvents = 'none';
        return;
      }
      // Graceful fade then display:none
      el.classList.add('gab-hiding');
      setTimeout(() => {
        const still = getAnnouncementBannerEl();
        if (still) {
          still.style.display = 'none';
          still.classList.add('hidden');
        }
      }, 480);
    }

    /**
     * Auth-tied announcement control (tied to syncUserSession / auth state):
     * - Guest / logout → always show Quality Assurance banner
     * - Logged in (sign-in + reload) → NEVER show banner
     */
    function updateAnnouncementBannerForAuth(isLoggedIn) {
      // Quality Assurance banner permanently removed from landing
      if (announcementHideTimer) {
        clearTimeout(announcementHideTimer);
        announcementHideTimer = null;
      }
      setAnnouncementHiddenFlag(true);
      hideAnnouncementBanner(true);
    }

    async function initAuth() {
      // Shared live bar works for guests + logged-in users
      initSharedLiveFeed();

      if (!db) return;
      try {
        const { data: { session } } = await db.auth.getSession();
        syncUserSession(session ? session.user : null);

        db.auth.onAuthStateChange((_event, session) => {
          syncUserSession(session ? session.session?.user || session.user : null);
        });
      } catch (err) {}
    }

    async function syncUserSession(user) {
      currentUser = user;
      const authSlot = document.getElementById('auth-button-slot');

      // Resume incomplete onboarding lock (reload / browser reopen)
      try {
        if (user && typeof resumeOnboardingIfNeeded === 'function') {
          var locked = resumeOnboardingIfNeeded(user);
          if (locked) suppressEmailVerifyDuringOnboard();
        } else if (!user) {
          // Keep lock if mid-onboarding with stored state; only clear on explicit finish
        }
      } catch (eOnbSync) {}

      // ── INSTANT UI shell (never block on network) ──
      try {
        updateGuestLayout(!!user);
        updateAnnouncementBannerForAuth(!!user);
      } catch (eUi0) {}

      if (user) {
        // Optimistic header so Home is usable immediately
        try {
          var optimisticName = (user.user_metadata && user.user_metadata.user_name) || (user.email ? user.email.split('@')[0] : 'Member');
          var optimisticAvatar = (user.user_metadata && user.user_metadata.avatar_url) || 'assets/avatars/01 (1).png';
          var elName = document.getElementById('profile-username-display');
          var elEmail = document.getElementById('profile-email-display');
          var elId = document.getElementById('profile-user-id-snippet');
          if (elName && (!elName.innerText || elName.innerText === 'Guest' || elName.innerText === 'Guest User')) elName.innerText = optimisticName;
          if (elEmail) elEmail.innerText = user.email || '';
          if (elId) elId.innerText = String(user.id || '').substring(0, 12) + '…';
          var _hai0 = document.getElementById('header-avatar-img');
          var _dai0 = document.getElementById('dropdown-avatar-img');
          if (_hai0 && (!_hai0.src || _hai0.src.indexOf('01%20(1)') !== -1 || _hai0.src.indexOf('01 (1)') !== -1)) {
            _hai0.src = optimisticAvatar;
          }
          if (_dai0 && (!_dai0.src || _dai0.src.indexOf('01%20(1)') !== -1 || _dai0.src.indexOf('01 (1)') !== -1)) {
            _dai0.src = optimisticAvatar;
          }
          if (authSlot) {
            authSlot.innerHTML = `
          <button onclick="handleLogout()" class="w-full flex items-center gap-2.5 py-3 px-2.5 hover:bg-[#253243] text-slate-400 hover:text-[#ED1E4C] font-medium rounded-lg text-left transition text-[13px]">
            <i data-lucide="log-out" class="w-4 h-4"></i> Logout
          </button>
        `;
          }
          // Switch to working Home immediately (landing → offers)
          try {
            if (typeof navigate === 'function') navigate('home');
            else if (typeof renderHome === 'function') renderHome();
          } catch (eNav) {}
          if (window.lucide) try { lucide.createIcons(); } catch (eLuc) {}
        } catch (eOpt) {}

        // ── Background hydration (non-blocking) ──
        (async function hydrateLoggedInUser() {
          let coins = 0;
          let profileLevel = 1;
          let displayName = (user.email || '').split('@')[0] || 'Member';
          let avatarUrl = 'assets/avatars/01 (1).png';
          let userCountry = user.user_metadata?.country || 'GLOBAL';
          let isBanned = false;
          let banReason = 'Policy Violation';

          try {
            const { data: profile } = await db.from('profiles').select('coins, username, level, avatar_url, country, is_banned, ban_reason, is_email_verified, role').eq('id', user.id).single();
            try { applyProfileRoleToCurrentUser(profile); } catch (eRoleApply) {}
            if (profile) {
              coins = profile.coins || 0;
              profileLevel = (profile.level != null && Number(profile.level) > 0) ? Math.floor(Number(profile.level)) : 1;
              displayName = profile.username || displayName;
              userCountry = (profile.country && profile.country !== 'Unknown') ? profile.country : userCountry;
              if (profile.avatar_url) avatarUrl = profile.avatar_url;
              if (profile.is_banned === true || profile.is_banned === 'true' || profile.is_banned === 1) {
                isBanned = true;
                banReason = profile.ban_reason || 'Policy Violation';
              }
              try {
                user.is_email_verified = (profile.is_email_verified === true || profile.is_email_verified === 'true' || profile.is_email_verified === 1);
                try { if (profile.role != null) user.role = profile.role; } catch (eR) {}
              } catch (eFlag) {}
            }
          } catch (e) {
            try {
              const { data: profile } = await db.from('profiles').select('coins, username, level, avatar_url, country, is_email_verified, role').eq('id', user.id).single();
            try { applyProfileRoleToCurrentUser(profile); } catch (eRoleApply) {}
              if (profile) {
                coins = profile.coins || 0;
                profileLevel = (profile.level != null && Number(profile.level) > 0) ? Math.floor(Number(profile.level)) : 1;
                displayName = profile.username || displayName;
                userCountry = (profile.country && profile.country !== 'Unknown') ? profile.country : userCountry;
                if (profile.avatar_url) avatarUrl = profile.avatar_url;
                try {
                  user.is_email_verified = (profile.is_email_verified === true || profile.is_email_verified === 'true' || profile.is_email_verified === 1);
                try { if (profile.role != null) user.role = profile.role; } catch (eR) {}
                } catch (eFlag2) {}
              }
            } catch (e2) {
              try {
                const { data: profile } = await db.from('profiles').select('coins, username, level, avatar_url, country').eq('id', user.id).single();
                if (profile) {
                  coins = profile.coins || 0;
                  profileLevel = (profile.level != null && Number(profile.level) > 0) ? Math.floor(Number(profile.level)) : 1;
                  displayName = profile.username || displayName;
                  userCountry = (profile.country && profile.country !== 'Unknown') ? profile.country : userCountry;
                  if (profile.avatar_url) avatarUrl = profile.avatar_url;
                }
              } catch (e3) {}
            }
          }

          try {
            if (typeof window.GollahSecurity !== 'undefined' && typeof window.GollahSecurity.syncProfileEmailVerifiedState === 'function') {
              await window.GollahSecurity.syncProfileEmailVerifiedState(user);
            } else if (typeof syncProfileEmailVerifiedState === 'function') {
              await syncProfileEmailVerifiedState(user);
            }
          } catch (eOAuth) {}

          if (isBanned) {
            try { showBannedScreen(banReason); } catch (eBan) {}
          } else {
            try { hideBannedScreen(); } catch (eBan2) {}
          }

          userCoins = coins;
          var levelProgressCoins = coins;
          try {
            if (typeof loadUserLevelProgress === 'function') {
              levelProgressCoins = loadUserLevelProgress(user.id, coins, profileLevel);
            } else if (typeof window.loadUserLevelProgress === 'function') {
              levelProgressCoins = window.loadUserLevelProgress(user.id, coins, profileLevel);
            }
          } catch (eLvlLoad) {
            levelProgressCoins = coins;
          }

          try {
            if (typeof ensureLocalAvatarForProfile === 'function') {
              avatarUrl = await ensureLocalAvatarForProfile({
                id: user.id,
                username: displayName,
                avatar_url: avatarUrl
              });
            } else if (!avatarUrl || !/^assets\/avatars\/01 \(\d+\)\.png$/i.test(String(avatarUrl).trim())) {
              var _rn = Math.floor(Math.random() * 79) + 1;
              avatarUrl = 'assets/avatars/01 (' + _rn + ').png';
              if (db) {
                try { await db.from('profiles').update({ avatar_url: avatarUrl }).eq('id', user.id); } catch (e3) {}
              }
            }
          } catch (e) {
            if (!avatarUrl || String(avatarUrl).indexOf('assets/avatars/01 (') === -1) {
              avatarUrl = 'assets/avatars/01 (1).png';
            }
          }

          var _hai = document.getElementById('header-avatar-img');
          var _dai = document.getElementById('dropdown-avatar-img');
          if (_hai) { _hai.src = avatarUrl; _hai.onerror = function(){ this.onerror=null; this.src='assets/avatars/01 (1).png'; }; }
          if (_dai) { _dai.src = avatarUrl; _dai.onerror = function(){ this.onerror=null; this.src='assets/avatars/01 (1).png'; }; }
          try {
            if (typeof refreshMyGlobalAvatars === 'function') {
              refreshMyGlobalAvatars({ avatar_url: avatarUrl, coins: levelProgressCoins, username: displayName, id: user.id });
            } else {
              var hs = document.getElementById('header-avatar-slot');
              var ds = document.getElementById('dropdown-avatar-slot');
              if (typeof mountGlobalAvatar === 'function') {
                if (hs) mountGlobalAvatar(hs, { avatar_url: avatarUrl, coins: levelProgressCoins }, { size: 'sm' });
                if (ds) mountGlobalAvatar(ds, { avatar_url: avatarUrl, coins: levelProgressCoins }, { size: 'lg', levelId: 'profile-level-badge' });
              }
            }
          } catch (eAv) {}

          try {
            document.getElementById('profile-username-display').innerText = displayName;
            document.getElementById('profile-email-display').innerText = user.email;
            document.getElementById('profile-user-id-snippet').innerText = user.id.substring(0, 12) + '…';
            updateHeaderCoinsDisplay();
            document.getElementById('profile-country-badge').innerText = `🚩 ${userCountry}`;
            updateLevelAndXpUI(levelProgressCoins);
            loadUserDataFromStorage();
          } catch (eDom) {}

          try { await fetchUserWithdrawals(); } catch (eW) {}
          try {
            if (typeof fetchUserEarningsHistory === 'function') await fetchUserEarningsHistory();
            else if (typeof fetchUserPostbacksHistory === 'function') await fetchUserPostbacksHistory();
          } catch (eE) {}

          try {
            var lifeNow = levelProgressCoins;
            if (typeof getCoinsEarnedTotal === 'function') {
              lifeNow = Math.max(lifeNow, Number(getCoinsEarnedTotal()) || 0);
            }
            if (typeof raiseMyLifeCoins === 'function') raiseMyLifeCoins(lifeNow);
            else if (typeof raiseUserLevelCoins === 'function') raiseUserLevelCoins(lifeNow);
            if (typeof updateLevelAndXpUI === 'function') updateLevelAndXpUI(lifeNow);
            if (typeof refreshMyGlobalAvatars === 'function') {
              refreshMyGlobalAvatars({ avatar_url: avatarUrl, coins: lifeNow, username: displayName, id: user.id });
            }
          } catch (eLifeSync) {}

          try {
            if (typeof fetchUserNotificationsFromServer === 'function') await fetchUserNotificationsFromServer();
          } catch (eN) {}
          try {
            if (typeof subscribePostbacksRealtime === 'function') subscribePostbacksRealtime();
          } catch (eSp) {}
          try {
            if (typeof subscribeUserNotificationsRealtime === 'function') subscribeUserNotificationsRealtime();
          } catch (eSn) {}
          try { startAutoSyncEngine(); } catch (eAs) {}
          try {
            cacheProfile(user.id, displayName, avatarUrl);
            cacheProfile(displayName, displayName, avatarUrl);
            updateChatLockUI();
            renderChatStream();
          } catch (e) {}

          try {
            if (typeof window.GollahSecurity !== 'undefined' && typeof window.GollahSecurity.updateEmailVerificationUI === 'function') {
              window.GollahSecurity.updateEmailVerificationUI();
            }
          } catch (eVer) {}
          try { if (typeof initRealtimeOnlinePresence === 'function') initRealtimeOnlinePresence(); } catch (ePres) {}
          if (window.lucide) try { lucide.createIcons(); } catch (eL2) {}
        })();

      } else {
        hideBannedScreen();
        if (typeof unsubscribePostbacksRealtime === 'function') {
          unsubscribePostbacksRealtime();
        }
        if (typeof unsubscribeUserNotificationsRealtime === 'function') {
          unsubscribeUserNotificationsRealtime();
        }
        userCoins = 0;
        try {
          if (typeof resetUserLevelProgress === 'function') resetUserLevelProgress();
          else if (typeof window.resetUserLevelProgress === 'function') window.resetUserLevelProgress();
        } catch (eResetLvl) {}
        userNotifications = [];
        userWithdrawals = [];
        userCompletedOffers = [];
        try {
          document.getElementById('profile-username-display').innerText = "Guest User";
          document.getElementById('profile-email-display').innerText = "guest@gollah.top";
          document.getElementById('profile-user-id-snippet').innerText = "guest";
          userCoins = 0; updateHeaderCoinsDisplay();
          document.getElementById('profile-country-badge').innerText = `🌐 GLOBAL`;
          var _hg = document.getElementById('header-avatar-img'); if (_hg) { _hg.src = 'assets/avatars/01 (1).png'; _hg.onerror = function(){ this.onerror=null; this.src='assets/avatars/01 (1).png'; }; }
          var _dg = document.getElementById('dropdown-avatar-img'); if (_dg) { _dg.src = 'assets/avatars/01 (1).png'; _dg.onerror = function(){ this.onerror=null; this.src='assets/avatars/01 (1).png'; }; }
          if (typeof refreshMyGlobalAvatars === 'function') {
            refreshMyGlobalAvatars({ avatar_url: 'assets/avatars/01 (1).png', coins: 0 });
          }
          updateLevelAndXpUI(0);
          updateNotificationsBadge();
        } catch (eGuest) {}

        if (authSlot) {
          authSlot.innerHTML = `
          <button onclick="openAuthModal(false)" class="w-full flex items-center justify-center gap-2 py-2.5 px-3 bg-[#00d672] hover:bg-[#00be64] text-black font-extrabold rounded-xl text-[13px] transition shadow-lg shadow-emerald-950/40">
            <i data-lucide="log-in" class="w-4 h-4"></i> Login / Sign Up
          </button>
        `;
        }
        try { if (typeof initRealtimeOnlinePresence === 'function') initRealtimeOnlinePresence(); } catch (ePres) {}
        try {
          if (typeof window.GollahSecurity !== 'undefined' && typeof window.GollahSecurity.updateEmailVerificationUI === 'function') {
            window.GollahSecurity.updateEmailVerificationUI();
          }
        } catch (eVer) {}
        if (window.lucide) try { lucide.createIcons(); } catch (eL3) {}
      }
    }


    let chatPanelOpen = false;

    /** True when NOT a phone-sized viewport — used to suppress the float Chat button */
    function isDesktopChatLayout() {
      try {
        // Float Chat is mobile-only (< 768px). Tablets/desktop never show it.
        return window.matchMedia('(min-width: 768px)').matches;
      } catch (e) { return true; }
    }

    function isMobileChatFloatAllowed() {
      try { return window.matchMedia('(max-width: 767px)').matches; } catch (e) { return false; }
    }

    function setChatPanelOpen(open, opts) {
      opts = opts || {};
      // Mobile: ignore background force-open unless explicit user action (opts.user = true)
      try {
        if (open && isMobileChatFloatAllowed() && opts.user !== true && opts.force !== true) {
          // Allow only if already open (no-op) or caller marked user intent
          // Default: block silent auto-open from sync/login
          if (!chatPanelOpen && opts.fromSync) return;
        }
      } catch (eG) {}
      chatPanelOpen = !!open;
      const right = document.getElementById('right-chat-sidebar');
      const btn = document.getElementById('chat-float-btn');
      const backdrop = document.getElementById('chat-backdrop');
      if (!right) return;
      const desktop = isDesktopChatLayout();
      if (chatPanelOpen) {
        right.classList.remove('hidden');
        right.classList.add('flex');
        // Backdrop only on mobile overlay
        if (backdrop) {
          if (desktop) backdrop.classList.add('hidden');
          else backdrop.classList.remove('hidden');
        }
        if (btn) {
          btn.classList.add('hidden');
          btn.classList.remove('flex');
        }
        if (desktop) document.body.classList.add('chat-desktop-open');
      } else {
        right.classList.add('hidden');
        right.classList.remove('flex');
        if (backdrop) backdrop.classList.add('hidden');
        // Float Chat button: mobile only (max-width 767px)
        if (btn && currentUser && isMobileChatFloatAllowed()) {
          btn.classList.remove('hidden');
          btn.classList.add('flex');
        } else if (btn) {
          btn.classList.add('hidden');
          btn.classList.remove('flex');
        }
        if (desktop) document.body.classList.add('chat-desktop-open');
        else document.body.classList.remove('chat-desktop-open');
      }
      if (window.lucide) lucide.createIcons();
    }

    function toggleChatPanel() {
      // On desktop xl the panel stays available; on mobile only explicit taps open it
      if (currentUser && isDesktopChatLayout() && window.matchMedia('(min-width: 1280px)').matches) {
        setChatPanelOpen(true, { user: true });
        return;
      }
      setChatPanelOpen(!chatPanelOpen, { user: true });
    }

    // Keep float button suppressed when resizing into desktop layout
    try {
      if (typeof window !== 'undefined' && !window.__gollahChatResizeBound) {
        window.__gollahChatResizeBound = true;
        window.addEventListener('resize', function () {
          try {
            if (!currentUser) return;
            var btn = document.getElementById('chat-float-btn');
            if (!isMobileChatFloatAllowed()) {
              // Tablet / desktop / narrowed desktop window: never show float Chat
              document.body.classList.add('chat-desktop-open');
              if (btn) { btn.classList.add('hidden'); btn.classList.remove('flex'); }
              if (window.matchMedia('(min-width: 1280px)').matches) {
                var right = document.getElementById('right-chat-sidebar');
                if (right) { right.classList.remove('hidden'); right.classList.add('flex', 'xl:flex'); }
                chatPanelOpen = true;
              }
            } else {
              document.body.classList.remove('chat-desktop-open');
              // Mobile: show float only when panel is closed
              if (btn && !chatPanelOpen) {
                btn.classList.remove('hidden');
                btn.classList.add('flex');
              }
            }
          } catch (eR) {}
        });
      }
    } catch (eBind) {}

    /** Guest = PaidCash-style wide landing: no sidebars, no coins/wallet/profile; top Sign In / Sign Up */

    function measureGuestTickerHeight() {
      try {
        var t = document.getElementById('global-live-ticker');
        if (!t) return;
        var h = Math.ceil(t.getBoundingClientRect().height) || 48;
        document.documentElement.style.setProperty('--guest-ticker-h', h + 'px');
      } catch (e) {}
    }

    function repositionTickerForAuth(isLoggedIn) {
      try {
        var ticker = document.getElementById('global-live-ticker');
        if (!ticker) return;
        var header = document.querySelector('body > header') || document.querySelector('header');
        var slot = document.getElementById('live-ticker-slot');
        if (isLoggedIn) {
          // Move ticker into center column slot (below header in app layout)
          if (slot && ticker.parentNode !== slot.parentNode) {
            slot.parentNode.insertBefore(ticker, slot.nextSibling);
          } else if (slot) {
            slot.parentNode.insertBefore(ticker, slot);
          } else {
            var center = document.querySelector('.flex-1.flex.flex-col.overflow-y-auto.custom-scroll');
            var main = document.getElementById('app-content');
            if (center && main) center.insertBefore(ticker, main);
            else if (center) center.insertBefore(ticker, center.firstChild);
          }
          document.documentElement.style.removeProperty('--guest-ticker-h');
        } else {
          // Guest: ticker must sit ABOVE the header (document top)
          if (header && ticker.nextElementSibling !== header) {
            header.parentNode.insertBefore(ticker, header);
          }
          measureGuestTickerHeight();
          setTimeout(measureGuestTickerHeight, 50);
          setTimeout(measureGuestTickerHeight, 300);
        }
      } catch (e) {
        console.warn('[ticker-pos]', e);
      }
    }


    try {
      window.addEventListener('resize', function () {
        try {
          if (!document.body.classList.contains('layout-logged-in') && typeof measureGuestTickerHeight === 'function') {
            measureGuestTickerHeight();
          }
        } catch (e) {}
      }, { passive: true });
    } catch (eGuestTickResize) {}

    
    function applyProfileRoleToCurrentUser(profile) {
      try {
        if (!profile || typeof currentUser === 'undefined' || !currentUser) return;
        if (profile.role != null && profile.role !== '') currentUser.role = profile.role;
        else if (currentUser.role == null) currentUser.role = 'user';
      } catch (e) {}
    }

    function updateGuestLayout(isLoggedIn) {
      try {
        if (isLoggedIn) document.body.classList.add('layout-logged-in');
        else document.body.classList.remove('layout-logged-in');
      } catch (eBodyCls) {}
      try { repositionTickerForAuth(!!isLoggedIn); } catch (eTick) {}
      try { updateAnnouncementBannerForAuth(!!isLoggedIn); } catch (eAnn) {}
      // Logged-in: keep all password inputs disabled so search never triggers Chrome password dropdown
      try {
        if (isLoggedIn) setAuthPasswordFieldsEnabled(false);
        else {
          // Guest: only enable landing password if landing form is present; modal stays disabled until open
          var landingPass = document.getElementById('landing-pass-input');
          if (landingPass) {
            landingPass.removeAttribute('disabled');
            landingPass.disabled = false;
          }
          var authPass = document.getElementById('auth-pass-input');
          if (authPass) {
            authPass.setAttribute('disabled', 'disabled');
            authPass.disabled = true;
          }
        }
      } catch (ePw) {}
      const left = document.getElementById('left-sidebar');
      const right = document.getElementById('right-chat-sidebar');
      const userActions = document.getElementById('header-user-actions');
      const guestActions = document.getElementById('header-guest-actions');
      const searchWrap = document.getElementById('header-search-wrap');
      const logoZone = document.getElementById('header-logo-zone');
      const chatBtn = document.getElementById('chat-float-btn');
      const backdrop = document.getElementById('chat-backdrop');

      if (isLoggedIn) {
        if (left) {
          left.classList.add('hidden');
          left.classList.add('lg:flex');
        }
        // Desktop xl+: persistent chat column. Mobile: NEVER auto-open drawer (user must tap Chat).
        var isMobile = false;
        try { isMobile = isMobileChatFloatAllowed(); } catch (eM) { isMobile = false; }
        var isXl = false;
        try { isXl = window.matchMedia('(min-width: 1280px)').matches; } catch (eX) { isXl = false; }
        if (isMobile) {
          chatPanelOpen = false;
          if (right) {
            right.classList.add('hidden');
            right.classList.remove('flex', 'xl:flex');
          }
          if (chatBtn) {
            chatBtn.classList.add('hidden');
            chatBtn.classList.remove('flex');
          }
          document.body.classList.remove('chat-desktop-open');
          if (backdrop) backdrop.classList.add('hidden');
        } else if (isXl) {
          chatPanelOpen = true;
          if (right) {
            right.classList.remove('hidden');
            right.classList.add('flex', 'xl:flex');
          }
          if (chatBtn) {
            chatBtn.classList.add('hidden');
            chatBtn.classList.remove('flex');
          }
          document.body.classList.add('chat-desktop-open');
          if (backdrop) backdrop.classList.add('hidden');
        } else {
          // Tablet / mid widths: keep chat closed until user opens it
          chatPanelOpen = false;
          if (right) {
            right.classList.add('hidden');
            right.classList.remove('flex', 'xl:flex');
          }
          if (chatBtn) {
            chatBtn.classList.add('hidden');
            chatBtn.classList.remove('flex');
          }
          document.body.classList.remove('chat-desktop-open');
          if (backdrop) backdrop.classList.add('hidden');
        }
        if (userActions) {
          userActions.classList.remove('hidden');
          userActions.classList.add('flex');
        }
        if (guestActions) {
          guestActions.classList.add('hidden');
          guestActions.classList.remove('flex');
        }
        var guestNav = document.getElementById('header-guest-nav');
        if (guestNav) {
          guestNav.classList.add('hidden');
          guestNav.classList.remove('flex');
        }
        if (searchWrap) {
          searchWrap.classList.remove('hidden');
          searchWrap.classList.add('sm:block');
          searchWrap.style.display = '';
        }
        if (logoZone) {
          logoZone.classList.add('lg:w-56', 'lg:border-r', 'lg:border-[#18232e]');
        }
        // announcement banner visibility is controlled exclusively by updateAnnouncementBannerForAuth
      } else {
        if (left) {
          left.classList.add('hidden');
          left.classList.remove('lg:flex');
        }
        if (right) {
          right.classList.add('hidden');
          right.classList.remove('flex', 'xl:flex');
        }
        if (chatBtn) {
          chatBtn.classList.add('hidden');
          chatBtn.classList.remove('flex');
        }
        if (backdrop) backdrop.classList.add('hidden');
        chatPanelOpen = false;
        if (userActions) {
          userActions.classList.add('hidden');
          userActions.classList.remove('flex');
        }
        if (guestActions) {
          guestActions.classList.remove('hidden');
          guestActions.classList.add('flex');
        }
        var guestNav = document.getElementById('header-guest-nav');
        if (guestNav) {
          guestNav.classList.remove('hidden');
          guestNav.classList.add('flex');
        }
        if (searchWrap) {
          searchWrap.classList.add('hidden');
          searchWrap.classList.remove('sm:block');
          searchWrap.style.display = 'none';
        }
        if (logoZone) {
          logoZone.classList.remove('lg:w-56', 'lg:border-r', 'lg:border-[#18232e]');
        }
        // announcement banner visibility is controlled exclusively by updateAnnouncementBannerForAuth
      }
    }


    function setAuthPasswordFieldsEnabled(enabled) {
      try {
        var ids = ['auth-pass-input', 'auth-confirm-input', 'landing-pass-input'];
        ids.forEach(function (id) {
          var el = document.getElementById(id);
          if (!el) return;
          if (enabled) {
            el.removeAttribute('disabled');
            el.disabled = false;
          } else {
            el.setAttribute('disabled', 'disabled');
            el.disabled = true;
            // Keep type=password but disabled so Chrome ignores for password UI on other fields
            try { el.type = 'password'; } catch (eT) {}
          }
        });
      } catch (e) {}
    }

    function openAuthModal(signup = false) {
      closeProfileDropdown();
      isSignupMode = !!signup;
      updateAuthModalUI();
      document.getElementById('auth-error-banner').classList.add('hidden');
      document.getElementById('auth-modal').classList.remove('hidden');
      try { setAuthPasswordFieldsEnabled(true); } catch (eEn) {}
      if (window.lucide) try { lucide.createIcons(); } catch (eL) {}
    }

    function closeAuthModal() {
      const m = document.getElementById('auth-modal');
      if (m) m.classList.add('hidden');
      isPasswordVisible = false;
      try {
        var pass = document.getElementById('auth-pass-input');
        if (pass) pass.type = 'password';
        var conf = document.getElementById('auth-confirm-input');
        if (conf) conf.type = 'password';
      } catch (eP) {}
      try {
        const icon = document.getElementById('pass-toggle-icon');
        if (icon) icon.setAttribute('data-lucide', 'eye');
        const icon2 = document.getElementById('confirm-toggle-icon');
        if (icon2) icon2.setAttribute('data-lucide', 'eye');
      } catch (eI) {}
      if (window.lucide) try { lucide.createIcons(); } catch (eL) {}
      try { setAuthPasswordFieldsEnabled(false); } catch (eDis) {}
    }

    function setAuthMode(signup) {
      isSignupMode = !!signup;
      updateAuthModalUI();
      document.getElementById('auth-error-banner').classList.add('hidden');
    }

    function toggleAuthMode() {
      setAuthMode(!isSignupMode);
    }

    function updateAuthModalUI() {
      const agreeBox = document.getElementById('auth-agree-container');
      const confirmBox = document.getElementById('auth-confirm-container');
      const agreeCb = document.getElementById('auth-agree-checkbox');
      const pillIn = document.getElementById('auth-pill-signin');
      const pillUp = document.getElementById('auth-pill-signup');
      const submitBtn = document.getElementById('auth-submit-btn');
      const passInput = document.getElementById('auth-pass-input');

      if (pillIn && pillUp) {
        if (isSignupMode) {
          pillUp.classList.add('auth-mode-pill-active');
          pillIn.classList.remove('auth-mode-pill-active');
        } else {
          pillIn.classList.add('auth-mode-pill-active');
          pillUp.classList.remove('auth-mode-pill-active');
        }
      }

      if (isSignupMode) {
        if (confirmBox) confirmBox.classList.remove('hidden');
        if (agreeBox) {
          agreeBox.classList.remove('hidden');
          agreeBox.classList.add('flex');
        }
        if (agreeCb) agreeCb.checked = false;
        if (submitBtn) submitBtn.innerText = 'Sign Up';
        if (passInput) {
          passInput.autocomplete = 'new-password';
          passInput.placeholder = 'Password';
        }
      } else {
        if (confirmBox) confirmBox.classList.add('hidden');
        if (agreeBox) {
          agreeBox.classList.add('hidden');
          agreeBox.classList.remove('flex');
        }
        if (submitBtn) submitBtn.innerText = 'Sign In';
        if (passInput) {
          passInput.autocomplete = 'current-password';
          passInput.placeholder = 'Password';
        }
      }

      try {
        const t = document.getElementById('auth-modal-title');
        const s = document.getElementById('auth-modal-subtitle');
        if (t) t.innerText = isSignupMode ? 'Create Account' : 'Welcome Back';
        if (s) s.innerText = isSignupMode ? 'Join Gollah and start earning rewards' : 'Sign in to your rewards account';
      } catch (eT) {}
      if (window.lucide) try { lucide.createIcons(); } catch (eL) {}
    }

    function togglePasswordVisibility(inputId, iconId) {
      inputId = inputId || 'auth-pass-input';
      iconId = iconId || 'pass-toggle-icon';
      const input = document.getElementById(inputId);
      const icon = document.getElementById(iconId);
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        if (icon) icon.setAttribute('data-lucide', 'eye-off');
      } else {
        input.type = 'password';
        if (icon) icon.setAttribute('data-lucide', 'eye');
      }
      if (window.lucide) try { lucide.createIcons(); } catch (e) {}
    }

    // ── Onboarding (post-signup): username + avatar → welcome ──
    let onboardSelectedAvatar = 'assets/avatars/01 (1).png';
    let onboardPendingUser = null;
    const ONBOARD_AVATAR_COUNT = 79;
    const ONBOARD_NAME_PARTS = [
      'HOSSAIN', 'JAWAAN', 'NOVA', 'PIXEL', 'ECHO', 'VEX', 'BLAZE', 'KIRA', 'ORION', 'ZEPHYR',
      'LUNA', 'AXEL', 'NEXUS', 'RIO', 'SORA', 'JETT', 'MIKA', 'TORN', 'QUINN', 'FABLE',
      'WEED', 'CASH', 'GOLD', 'STAR', 'WAVE', 'DASH', 'BOLT', 'FROST', 'EMBER', 'SHADOW'
    ];

    function buildAvatarPath(n) {
      return 'assets/avatars/01 (' + n + ').png';
    }

    function randomizeOnboardUsername() {
      const a = ONBOARD_NAME_PARTS[Math.floor(Math.random() * ONBOARD_NAME_PARTS.length)];
      const b = ONBOARD_NAME_PARTS[Math.floor(Math.random() * ONBOARD_NAME_PARTS.length)];
      const num = Math.floor(Math.random() * 90) + 10;
      const name = (a === b) ? (a + num) : (a + '-' + b);
      const input = document.getElementById('onboard-username-input');
      if (input) {
        input.value = String(name).toUpperCase().slice(0, 24);
      }
      const err = document.getElementById('onboard-username-error');
      if (err) err.classList.add('hidden');
    }

    function renderOnboardAvatarGrid() {
      const grid = document.getElementById('onboard-avatar-grid');
      if (!grid) return;
      grid.className = 'onboard-avatar-grid custom-scroll';
      grid.setAttribute('role', 'listbox');
      let html = '';
      for (let i = 1; i <= ONBOARD_AVATAR_COUNT; i++) {
        const src = buildAvatarPath(i);
        const sel = (src === onboardSelectedAvatar) ? ' onboard-avatar-selected' : '';
        html += '<div class="onboard-avatar-cell" role="option">' +
          '<button type="button" class="onboard-avatar-btn' + sel + '" data-avatar="' + src.replace(/"/g, '') + '" onclick="selectOnboardAvatar(this)" aria-label="Avatar ' + i + '">' +
          '<img src="' + src.replace(/"/g, '') + '" alt="" loading="lazy" draggable="false" onerror="this.onerror=null;this.src=\'assets/avatars/01 (1).png\'" />' +
          '</button></div>';
      }
      grid.innerHTML = html;
    }

    function selectOnboardAvatar(btn) {
      if (!btn) return;
      const src = btn.getAttribute('data-avatar') || buildAvatarPath(1);
      onboardSelectedAvatar = src;
      document.querySelectorAll('.onboard-avatar-btn').forEach(function (el) {
        el.classList.toggle('onboard-avatar-selected', el === btn);
      });
    }

    // ── Onboarding lock (survives reload + browser reopen) ──
    const ONBOARD_STORAGE_KEY = 'gollah_onboard_v1';
    // steps: pending_username_avatar | pending_welcome_get_started | done
    function readOnboardState() {
      try {
        var raw = localStorage.getItem(ONBOARD_STORAGE_KEY) || sessionStorage.getItem(ONBOARD_STORAGE_KEY);
        if (!raw) return null;
        var o = JSON.parse(raw);
        if (!o || typeof o !== 'object') return null;
        return o;
      } catch (e) { return null; }
    }
    function writeOnboardState(partial) {
      try {
        var cur = readOnboardState() || {};
        var next = Object.assign({}, cur, partial || {}, { updatedAt: Date.now() });
        var s = JSON.stringify(next);
        localStorage.setItem(ONBOARD_STORAGE_KEY, s);
        sessionStorage.setItem(ONBOARD_STORAGE_KEY, s);
        window.__gollahOnboardingActive = (next.step === 'pending_username_avatar' || next.step === 'pending_welcome_get_started');
      } catch (e) {}
    }
    function clearOnboardState() {
      try {
        localStorage.removeItem(ONBOARD_STORAGE_KEY);
        sessionStorage.removeItem(ONBOARD_STORAGE_KEY);
      } catch (e) {}
      window.__gollahOnboardingActive = false;
    }
    function isOnboardingActive() {
      try {
        if (window.__gollahOnboardingActive === true) return true;
        var st = readOnboardState();
        return !!(st && (st.step === 'pending_username_avatar' || st.step === 'pending_welcome_get_started'));
      } catch (e) { return false; }
    }
    window.isGollahOnboardingActive = isOnboardingActive;
    window.__gollahOnboardingActive = false;

    function suppressEmailVerifyDuringOnboard() {
      try {
        if (typeof hideEmailVerifyBar === 'function') hideEmailVerifyBar();
        else if (window.GollahSecurity && typeof window.GollahSecurity.hideEmailVerifyBar === 'function') {
          window.GollahSecurity.hideEmailVerifyBar();
        } else {
          var bar = document.getElementById('email-verify-bar');
          if (bar) bar.classList.add('hidden');
        }
      } catch (e) {}
    }

    function openOnboardProfileModal(user) {
      onboardPendingUser = user || null;
      closeAuthModal();
      suppressEmailVerifyDuringOnboard();
      var uid = (user && user.id) || (typeof currentUser !== 'undefined' && currentUser && currentUser.id) || null;
      writeOnboardState({
        step: 'pending_username_avatar',
        userId: uid,
        username: (document.getElementById('onboard-username-input') && document.getElementById('onboard-username-input').value) || '',
        avatar: onboardSelectedAvatar || buildAvatarPath(1)
      });
      const m = document.getElementById('onboard-profile-modal');
      if (!m) return;
      // Seed random username + avatar if empty
      var unInput = document.getElementById('onboard-username-input');
      var st = readOnboardState();
      if (st && st.username) {
        if (unInput) unInput.value = st.username;
      } else if (!unInput || !unInput.value) {
        randomizeOnboardUsername();
      }
      if (st && st.avatar) {
        onboardSelectedAvatar = st.avatar;
      } else {
        onboardSelectedAvatar = buildAvatarPath(Math.floor(Math.random() * ONBOARD_AVATAR_COUNT) + 1);
      }
      renderOnboardAvatarGrid();
      const err = document.getElementById('onboard-username-error');
      if (err) err.classList.add('hidden');
      // Close welcome if open
      try { closeOnboardWelcomeModal(); } catch (eW) {}
      m.classList.remove('hidden');
      if (window.lucide) try { lucide.createIcons(); } catch (e) {}
    }

    function closeOnboardProfileModal() {
      const m = document.getElementById('onboard-profile-modal');
      if (m) m.classList.add('hidden');
    }

    async function submitOnboardProfile() {
      const input = document.getElementById('onboard-username-input');
      const err = document.getElementById('onboard-username-error');
      let username = (input && input.value ? input.value : '').trim().replace(/\s+/g, '-');
      if (!username || username.length < 3) {
        if (err) {
          err.textContent = 'Please set a username';
          err.classList.remove('hidden');
        }
        return;
      }
      if (username.length > 24) username = username.slice(0, 24);
      if (err) err.classList.add('hidden');

      // Persist username + avatar
      try {
        const uid = (onboardPendingUser && onboardPendingUser.id) || (typeof currentUser !== 'undefined' && currentUser && currentUser.id);
        if (uid && db) {
          // uniqueness soft-check
          try {
            const { data: existing } = await db.from('profiles').select('id').eq('username', username).maybeSingle();
            if (existing && existing.id && String(existing.id) !== String(uid)) {
              username = username + '_' + Math.floor(Math.random() * 899 + 100);
            }
          } catch (eU) {}
          await db.from('profiles').upsert({
            id: uid,
            username: username,
            avatar_url: onboardSelectedAvatar
          });
          try {
            await db.auth.updateUser({ data: { user_name: username, avatar_url: onboardSelectedAvatar } });
          } catch (eMeta) {}
        }
        // Local UI
        try {
          const el = document.getElementById('profile-username-display');
          if (el) el.innerText = username;
          const hai = document.getElementById('header-avatar-img');
          const dai = document.getElementById('dropdown-avatar-img');
          if (hai) hai.src = onboardSelectedAvatar;
          if (dai) dai.src = onboardSelectedAvatar;
        } catch (eDom) {}
        try {
          const hidden = document.getElementById('auth-username-input');
          if (hidden) hidden.value = username;
        } catch (eH) {}
      } catch (e) {
        console.warn('[onboard] profile save', e);
      }

      writeOnboardState({
        step: 'pending_welcome_get_started',
        username: username,
        avatar: onboardSelectedAvatar
      });
      suppressEmailVerifyDuringOnboard();
      closeOnboardProfileModal();
      openOnboardWelcomeModal(username, onboardSelectedAvatar);
    }

    function openOnboardWelcomeModal(username, avatarUrl) {
      const m = document.getElementById('onboard-welcome-modal');
      if (!m) return;
      suppressEmailVerifyDuringOnboard();
      const msg = document.getElementById('onboard-welcome-msg');
      const av = document.getElementById('onboard-welcome-avatar');
      const name = username || 'Member';
      if (msg) msg.textContent = 'Hey ' + name + ', welcome to Gollah. Start earning now!';
      if (av) {
        av.src = avatarUrl || onboardSelectedAvatar || buildAvatarPath(1);
      }
      writeOnboardState({
        step: 'pending_welcome_get_started',
        username: name,
        avatar: avatarUrl || onboardSelectedAvatar
      });
      try { closeOnboardProfileModal(); } catch (eP) {}
      m.classList.remove('hidden');
      spawnOnboardConfetti();
    }

    function closeOnboardWelcomeModal() {
      const m = document.getElementById('onboard-welcome-modal');
      if (m) m.classList.add('hidden');
      const box = document.getElementById('onboard-confetti');
      if (box) box.innerHTML = '';
    }

    function spawnOnboardConfetti() {
      const box = document.getElementById('onboard-confetti');
      if (!box) return;
      box.innerHTML = '';
      const colors = ['#00d672', '#34d399', '#fbbf24', '#f472b6', '#22d3ee', '#a78bfa', '#f97316', '#fff'];
      for (let i = 0; i < 28; i++) {
        const el = document.createElement('span');
        el.className = 'onboard-confetti-piece';
        el.style.left = (Math.random() * 100) + '%';
        el.style.animationDelay = (Math.random() * 2.5) + 's';
        el.style.animationDuration = (3.5 + Math.random() * 3) + 's';
        el.style.background = colors[i % colors.length];
        el.style.width = (6 + Math.random() * 8) + 'px';
        el.style.height = (4 + Math.random() * 10) + 'px';
        el.style.borderRadius = Math.random() > 0.5 ? '2px' : '50%';
        el.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
        box.appendChild(el);
      }
    }

    function finishOnboarding() {
      writeOnboardState({ step: 'done' });
      clearOnboardState();
      closeOnboardWelcomeModal();
      try { closeOnboardProfileModal(); } catch (eP) {}
      try {
        if (onboardPendingUser) syncUserSession(onboardPendingUser);
        else if (typeof currentUser !== 'undefined' && currentUser) syncUserSession(currentUser);
      } catch (eS) {}
      try { navigate('home'); } catch (eN) {}
      onboardPendingUser = null;
      // Email verify bar may now appear (after Get Started)
      window.__gollahOnboardingActive = false;
      try {
        if (window.GollahSecurity && typeof window.GollahSecurity.refreshEmailVerifyBarAfterOnboarding === 'function') {
          window.GollahSecurity.refreshEmailVerifyBarAfterOnboarding();
        }
      } catch (eRef) {}
    }

    async function signInWithProvider(provider) {
      if (!db) {
        showAuthError('Auth is not ready. Please refresh.');
        return;
      }
      try {
        const { error } = await db.auth.signInWithOAuth({
          provider: provider,
          options: { redirectTo: window.location.origin + window.location.pathname }
        });
        if (error) showAuthError(error.message || ('Could not start ' + provider + ' sign-in'));
      } catch (e) {
        showAuthError(e.message || 'OAuth failed');
      }
    }

    function showAuthError(msg) {
      const banner = document.getElementById('auth-error-banner');
      const text = document.getElementById('auth-error-text');
      if (text) text.innerText = msg || 'An error occurred';
      if (banner) banner.classList.remove('hidden');
    }

    async function submitAuthForm() {
      const email = (document.getElementById('auth-email-input')?.value || '').trim();
      const password = document.getElementById('auth-pass-input')?.value || '';
      const confirm = document.getElementById('auth-confirm-input')?.value || '';
      const submitBtn = document.getElementById('auth-submit-btn');
      if (!email || !password) {
        showAuthError('Please enter email and password.');
        return;
      }
      if (password.length < 6) {
        showAuthError('Password must be at least 6 characters.');
        return;
      }
      if (isSignupMode) {
        if (password !== confirm) {
          showAuthError('Passwords do not match.');
          return;
        }
        const agree = document.getElementById('auth-agree-checkbox');
        if (agree && !agree.checked) {
          showAuthError('Please agree to the Privacy Policy and Terms of Service.');
          return;
        }
      }
      if (!db) {
        showAuthError('Auth is not ready. Please refresh.');
        return;
      }

      const originalText = submitBtn ? submitBtn.innerText : '';
      if (submitBtn) {
        submitBtn.innerText = isSignupMode ? 'Creating…' : 'Signing in…';
        submitBtn.disabled = true;
      }
      document.getElementById('auth-error-banner')?.classList.add('hidden');

      try {
        if (isSignupMode) {
          // Temp username until onboarding step 2
          let finalUsername = 'User' + Math.floor(Math.random() * 90000 + 10000);
          var signupAvatar = 'assets/avatars/01 (' + (Math.floor(Math.random() * 79) + 1) + ').png';
          const { data, error } = await db.auth.signUp({
            email,
            password,
            options: {
              data: {
                user_name: finalUsername,
                avatar_url: signupAvatar
              }
            }
          });
          if (error) {
            showAuthError(error.message);
          } else if (data && data.user) {
            let detectedCountry = 'GLOBAL';
            try {
              if (typeof window.GollahSecurity !== 'undefined' && typeof window.GollahSecurity.detectCountry === 'function') {
                detectedCountry = await window.GollahSecurity.detectCountry() || 'GLOBAL';
              }
            } catch (eC) {}
            try {
              await db.from('profiles').upsert({
                id: data.user.id,
                username: finalUsername,
                avatar_url: signupAvatar,
                country: detectedCountry,
                coins: 0,
                level: 1,
                is_email_verified: false
              });
            } catch (eUp) {}
            // Step 2 onboarding instead of jumping straight to Home
            onboardSelectedAvatar = signupAvatar;
            try {
              const hid = document.getElementById('auth-username-input');
              if (hid) hid.value = finalUsername;
            } catch (eH) {}
            writeOnboardState({
              step: 'pending_username_avatar',
              userId: data.user.id,
              email: email || null
            });
            suppressEmailVerifyDuringOnboard();
            openOnboardProfileModal(data.user);
            // Still send verification email in background, but bar stays hidden until Get Started
            try {
              if (typeof sendVerificationAfterSignup === 'function') sendVerificationAfterSignup();
              else if (window.GollahSecurity && typeof window.GollahSecurity.sendVerificationAfterSignup === 'function') {
                window.GollahSecurity.sendVerificationAfterSignup();
              }
            } catch (eSend) {}
          } else {
            showAuthError('Check your email to confirm signup, then sign in.');
          }
        } else {
          const { data, error } = await db.auth.signInWithPassword({ email, password });
          if (error) {
            showAuthError(error.message);
          } else {
            closeAuthModal();
            try { syncUserSession(data.user?.user || data.user || data.session?.user); } catch (eSync) {}
            try { navigate('home'); } catch (eNav) {}
          }
        }
      } catch (err) {
        showAuthError(err.message || 'Authentication failed.');
      } finally {
        if (submitBtn) {
          submitBtn.innerText = originalText || (isSignupMode ? 'Sign Up' : 'Sign In');
          submitBtn.disabled = false;
        }
      }
    }

    let accountIsBanned = false;

    function showBannedScreen(reason) {
      accountIsBanned = true;
      const el = document.getElementById('banned-overlay');
      const pill = document.getElementById('banned-reason-pill');
      if (pill) pill.textContent = reason || 'Policy Violation';
      if (el) el.classList.remove('hidden');
      // Block chat / offers while banned
      try {
        const input = document.getElementById('chat-input');
        const btn = document.getElementById('chat-send-btn');
        if (input) input.disabled = true;
        if (btn) btn.disabled = true;
      } catch (e) {}
    }

    function hideBannedScreen() {
      accountIsBanned = false;
      const el = document.getElementById('banned-overlay');
      if (el) el.classList.add('hidden');
    }

    function isAccountBanned() {
      return accountIsBanned === true;
    }

    async function handleLogout() {
      if (db) await db.auth.signOut();
      currentUser = null;
      syncUserSession(null);
      closeProfileDropdown();
      navigate('home');
    }

    function openLegalModal(type) {
      closeProfileDropdown();
      const titleEl = document.getElementById('legal-modal-title');
      const bodyEl = document.getElementById('legal-modal-body');

      if (type === 'terms') {
        titleEl.innerHTML = `<i data-lucide="file-text" class="w-5 h-5 text-emerald-400"></i> Terms of Service`;
        bodyEl.innerHTML = `
          <div class="space-y-4 text-[12px] text-slate-300 leading-relaxed">
            <p class="text-slate-500 text-[11px]">Last updated: January 2026 · Gollah Inc. (“Gollah”, “we”, “our”, “the Platform”)</p>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">1. Acceptance of Terms</h4>
              <p>By creating an account, accessing, or using Gollah, you agree to be bound by these Terms of Service, our Privacy Policy, and Anti-Fraud Guidelines. If you do not agree, you must not use the Platform.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">2. Eligibility</h4>
              <ul class="list-disc pl-5 space-y-1">
                <li>You must be at least <strong class="text-white">18 years of age</strong> (or the age of majority in your jurisdiction).</li>
                <li>You must provide accurate registration information and keep it up to date.</li>
                <li>One natural person may maintain only <strong class="text-white">one account</strong>. Multiple accounts, shared devices used to farm rewards, or account selling is prohibited.</li>
                <li>You are responsible for all activity under your account credentials.</li>
              </ul>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">3. Nature of the Service</h4>
              <p>Gollah is a <strong class="text-white">rewards and offer aggregation platform</strong>. Users may complete third-party tasks (app installs, surveys, registrations, quizzes, and similar CPA actions) promoted by independent advertising networks and advertisers. Gollah credits virtual “Coins” after verified completions and allows users to request payouts subject to these Terms.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">4. Third-Party Offers &amp; Networks</h4>
              <ul class="list-disc pl-5 space-y-1">
                <li>Offers are provided by external networks and advertisers (e.g. offer walls). Gollah does not control their content, availability, or approval decisions.</li>
                <li>Completion tracking relies on advertiser <strong class="text-white">postbacks / conversion callbacks</strong>. Rewards are credited only after the network confirms a valid conversion.</li>
                <li>Advertisers may reverse, hold, or deny conversions for fraud, policy violations, or incomplete actions. Gollah may reverse coin credits accordingly.</li>
                <li>Links may contain tracking parameters (sub IDs) solely for attribution and quality control.</li>
              </ul>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">5. Rewards, Coins &amp; Cashouts</h4>
              <ul class="list-disc pl-5 space-y-1">
                <li>Coins have no cash value until a valid withdrawal is approved and processed.</li>
                <li>Minimum cashout threshold applies (currently <strong class="text-white">300 Coins</strong> unless otherwise stated).</li>
                <li>Payouts may be made in supported cryptocurrencies or methods shown in the Shop (e.g. LTC, Binance Pay). Processing times vary.</li>
                <li>Gollah may request identity or wallet verification before releasing funds.</li>
                <li>We reserve the right to withhold, delay, or cancel payouts where fraud, abuse, chargebacks, or network clawbacks are suspected or confirmed.</li>
              </ul>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">6. Prohibited Conduct</h4>
              <p class="mb-1">You agree <strong class="text-white">not</strong> to:</p>
              <ul class="list-disc pl-5 space-y-1">
                <li>Use bots, scripts, emulators, VPNs/proxies for deception, click farms, or automated completion tools.</li>
                <li>Generate fake installs, incentivized traffic that violates advertiser rules, or incomplete/fraudulent survey responses.</li>
                <li>Misrepresent device, location, or identity to offer networks.</li>
                <li>Abuse promotions, referrals, or exploit bugs for unfair advantage.</li>
                <li>Harass other users or attempt unauthorized access to systems or data.</li>
              </ul>
              <p class="mt-2">Violation may result in immediate account suspension, forfeiture of balance, and reporting to partner networks.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">7. Quality Assurance &amp; Compliance</h4>
              <p>Gollah maintains quality controls including conversion verification, duplicate detection, and compliance review. We cooperate with advertising partners to uphold industry standards (legitimate human engagement only). Traffic and conversions must comply with each network’s publisher and advertiser policies.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">8. Account Suspension &amp; Termination</h4>
              <p>We may suspend or terminate accounts at our discretion for Terms violations, fraud risk, legal requirements, or network requests. You may stop using the Platform at any time. Outstanding balances may be forfeited if the account is closed for cause.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">9. Disclaimers</h4>
              <p>The Platform is provided “as is”. We do not guarantee uninterrupted service, specific earnings, or that every offer will credit. Third-party sites are outside our control. To the maximum extent permitted by law, Gollah is not liable for indirect, incidental, or consequential damages arising from use of the Platform or third-party offers.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">10. Changes to Terms</h4>
              <p>We may update these Terms at any time. Continued use after changes constitutes acceptance. Material changes may be highlighted on the Platform or via notice.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">11. Contact</h4>
              <p>Questions about these Terms: <span class="text-emerald-400 font-mono">admin@gollah.top</span></p>
            </div>
          </div>
        `;
      } else if (type === 'privacy') {
        titleEl.innerHTML = `<i data-lucide="lock" class="w-5 h-5 text-blue-400"></i> Privacy Policy`;
        bodyEl.innerHTML = `
          <div class="space-y-4 text-[12px] text-slate-300 leading-relaxed">
            <p class="text-slate-500 text-[11px]">Last updated: January 2026 · Gollah Inc.</p>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">1. Information We Collect</h4>
              <ul class="list-disc pl-5 space-y-1">
                <li><strong class="text-white">Account data:</strong> email, username, password (hashed), optional profile fields.</li>
                <li><strong class="text-white">Usage data:</strong> offer clicks, completions, device/browser type, approximate location (e.g. country), IP address for security and fraud prevention.</li>
                <li><strong class="text-white">Transaction data:</strong> coin balances, withdrawal requests, destination wallet identifiers you provide.</li>
                <li><strong class="text-white">Support communications:</strong> messages you send to support.</li>
              </ul>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">2. How We Use Information</h4>
              <ul class="list-disc pl-5 space-y-1">
                <li>To operate accounts, deliver offers, and credit verified rewards.</li>
                <li>To process cashouts and prevent fraud, abuse, and duplicate accounts.</li>
                <li>To attribute conversions to advertising partners via standard tracking (sub IDs / postbacks).</li>
                <li>To improve the Platform, provide support, and meet legal obligations.</li>
              </ul>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">3. Sharing with Partners</h4>
              <p>We share limited data with offer networks and payment processors only as needed to run campaigns, verify conversions, and pay users. We do not sell personal data for unrelated marketing.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">4. Cookies &amp; Tracking</h4>
              <p>We and our partners may use cookies, local storage, and similar technologies for session management, preferences, and conversion tracking. You can control cookies via browser settings; some features may not work if disabled.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">5. Data Security</h4>
              <p>We use industry-standard measures (including encrypted transport / SSL) to protect data. No method of transmission is 100% secure; you use the Platform at your own risk regarding residual security risks.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">6. Retention</h4>
              <p>We retain account and transaction records as long as needed for operations, dispute resolution, fraud prevention, and legal compliance.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">7. Your Choices</h4>
              <p>You may update profile information, request account closure, or contact us about data requests at <span class="text-emerald-400 font-mono">admin@gollah.top</span>, subject to applicable law and fraud-hold requirements.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">8. Children</h4>
              <p>The Platform is not directed to individuals under 18. We do not knowingly collect data from minors.</p>
            </div>
          </div>
        `;
      } else if (type === 'antifraud') {
        titleEl.innerHTML = `<i data-lucide="shield-check" class="w-5 h-5 text-emerald-400"></i> Anti-Fraud &amp; Quality Guidelines`;
        bodyEl.innerHTML = `
          <div class="space-y-4 text-[12px] text-slate-300 leading-relaxed">
            <p class="text-slate-500 text-[11px]">These rules protect advertisers, networks, and honest users. Violations lead to holds, reversals, or bans.</p>

            <div class="bg-[#111a24] border border-[#1e2a36] p-3.5 rounded-xl space-y-2">
              <h4 class="font-bold text-white text-sm">Required: Genuine Human Engagement</h4>
              <ul class="list-disc pl-5 space-y-1">
                <li>Complete offers yourself with real intent (install, register, survey answers, level goals as stated).</li>
                <li>Use your own device and legitimate residential connection unless an offer explicitly allows otherwise.</li>
                <li>Follow each advertiser’s on-screen instructions fully before expecting credit.</li>
              </ul>
            </div>

            <div class="bg-[#111a24] border border-[rgba(237,30,76,0.2)] p-3.5 rounded-xl space-y-2">
              <h4 class="font-bold text-white text-sm">Strictly Prohibited</h4>
              <ul class="list-disc pl-5 space-y-1">
                <li>Bots, auto-clickers, macros, emulators used to fake engagement, or headless browsers.</li>
                <li>VPN / proxy / datacenter traffic used to disguise location or bypass geo rules.</li>
                <li>Incentive traffic that breaks network rules, fake leads, or incomplete form fills.</li>
                <li>Multiple accounts, device farms, or coordinated conversion fraud.</li>
                <li>Chargeback abuse, stolen payment methods on paid trials, or identity misrepresentation.</li>
              </ul>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">Enforcement</h4>
              <p>Gollah monitors postbacks, velocity, device signals, and partner feedback. Suspicious activity may trigger automatic holds. Confirmed fraud results in balance forfeiture and permanent exclusion. We may share relevant evidence with partner networks upon request.</p>
            </div>

            <div>
              <h4 class="font-bold text-white text-sm mb-1.5">Publisher / Network Alignment</h4>
              <p>As an offer aggregator, Gollah is committed to <strong class="text-white">valid, brand-safe, human traffic only</strong>. We do not encourage or reward invalid conversions. Partners may audit activity tied to our publisher IDs.</p>
            </div>

            <p>Report abuse: <span class="text-emerald-400 font-mono">admin@gollah.top</span></p>
          </div>
        `;
      } else if (type === 'contact') {
        // Redirect to private 1-to-1 Help support chat (no static form popup)
        try {
          if (typeof closeLegalModal === 'function') closeLegalModal();
        } catch (eC) {}
        try {
          if (typeof openHelpSupportChat === 'function') openHelpSupportChat();
          else if (typeof window.openHelpSupportChat === 'function') window.openHelpSupportChat();
        } catch (eH) {}
        return;
      }

      document.getElementById('legal-modal').classList.remove('hidden');
      if (window.lucide) lucide.createIcons();
    }

    function closeLegalModal() {
      document.getElementById('legal-modal').classList.add('hidden');
    }


try {
  window.setAuthMode = setAuthMode;
  window.randomizeOnboardUsername = randomizeOnboardUsername;
  window.selectOnboardAvatar = selectOnboardAvatar;
  window.submitOnboardProfile = submitOnboardProfile;
  window.finishOnboarding = finishOnboarding;
  window.signInWithProvider = signInWithProvider;
  window.togglePasswordVisibility = togglePasswordVisibility;
} catch (eExpOnb) {}


    function resumeOnboardingIfNeeded(user) {
      try {
        var st = readOnboardState();
        if (!st || !st.step) return false;
        if (st.step === 'done') { clearOnboardState(); return false; }
        if (st.step !== 'pending_username_avatar' && st.step !== 'pending_welcome_get_started') return false;
        // Optional userId match when available
        if (st.userId && user && user.id && String(st.userId) !== String(user.id)) {
          // Different account signed in — clear stale lock
          clearOnboardState();
          return false;
        }
        window.__gollahOnboardingActive = true;
        suppressEmailVerifyDuringOnboard();
        if (user) onboardPendingUser = user;
        if (st.step === 'pending_username_avatar') {
          if (st.username) {
            var ui = document.getElementById('onboard-username-input');
            if (ui) ui.value = st.username;
          }
          if (st.avatar) onboardSelectedAvatar = st.avatar;
          openOnboardProfileModal(user || onboardPendingUser);
          return true;
        }
        if (st.step === 'pending_welcome_get_started') {
          if (st.avatar) onboardSelectedAvatar = st.avatar;
          openOnboardWelcomeModal(st.username || 'Member', st.avatar || onboardSelectedAvatar);
          return true;
        }
      } catch (e) {}
      return false;
    }
    window.resumeOnboardingIfNeeded = resumeOnboardingIfNeeded;

    // Boot resume after DOM ready
    (function scheduleOnboardResume() {
      function run() {
        try {
          var st = readOnboardState();
          if (!st || (st.step !== 'pending_username_avatar' && st.step !== 'pending_welcome_get_started')) return;
          window.__gollahOnboardingActive = true;
          suppressEmailVerifyDuringOnboard();
          // Wait briefly for auth session
          var tries = 0;
          var t = setInterval(function () {
            tries++;
            var u = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
            if (u || tries > 25) {
              clearInterval(t);
              resumeOnboardingIfNeeded(u);
              suppressEmailVerifyDuringOnboard();
            }
          }, 200);
        } catch (e) {}
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
      else run();
    })();
