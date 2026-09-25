/* auth.js — Login, signup, logout, privacy, banned screen, session */
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
      
      if (user) {
        let coins = 0;
        let displayName = user.email.split('@')[0];
        let avatarUrl = 'assets/avatars/1.png';
        let userCountry = user.user_metadata?.country || 'GLOBAL';

        let isBanned = false;
        let banReason = 'Policy Violation';
        try {
          const { data: profile } = await db.from('profiles').select('coins, username, level, avatar_url, country, is_banned, ban_reason').eq('id', user.id).single();
          if (profile) {
            coins = profile.coins || 0;
            displayName = profile.username || displayName;
            userCountry = (profile.country && profile.country !== 'Unknown') ? profile.country : userCountry;
            if (profile.avatar_url) avatarUrl = profile.avatar_url;
            if (profile.is_banned === true || profile.is_banned === 'true' || profile.is_banned === 1) {
              isBanned = true;
              banReason = profile.ban_reason || 'Policy Violation';
            }
          }
        } catch (e) {
          // Fallback without ban columns
          try {
            const { data: profile } = await db.from('profiles').select('coins, username, level, avatar_url, country').eq('id', user.id).single();
            if (profile) {
              coins = profile.coins || 0;
              displayName = profile.username || displayName;
              userCountry = (profile.country && profile.country !== 'Unknown') ? profile.country : userCountry;
              if (profile.avatar_url) avatarUrl = profile.avatar_url;
            }
          } catch (e2) {}
        }

        if (isBanned) {
          showBannedScreen(banReason);
        } else {
          hideBannedScreen();
        }

        userCoins = coins;
        document.getElementById('header-avatar-img').src = avatarUrl;
        document.getElementById('dropdown-avatar-img').src = avatarUrl;
        document.getElementById('profile-username-display').innerText = displayName;
        document.getElementById('profile-email-display').innerText = user.email;
        document.getElementById('profile-user-id-snippet').innerText = user.id.substring(0, 12) + '…';
        updateHeaderCoinsDisplay();
        document.getElementById('profile-country-badge').innerText = `🚩 ${userCountry}`;
        
        updateLevelAndXpUI(userCoins);
        loadUserDataFromStorage();
        await fetchUserWithdrawals();
        if (typeof fetchUserPostbacksHistory === 'function') {
          await fetchUserPostbacksHistory();
        }
        if (typeof subscribePostbacksRealtime === 'function') {
          subscribePostbacksRealtime();
        }
        startAutoSyncEngine();
        try {
          cacheProfile(user.id, displayName, avatarUrl);
          cacheProfile(displayName, displayName, avatarUrl);
          updateChatLockUI();
          renderChatStream();
        } catch (e) {}

        authSlot.innerHTML = `
          <button onclick="handleLogout()" class="w-full flex items-center gap-2.5 py-3 px-2.5 hover:bg-[#253243] text-slate-400 hover:text-rose-400 font-medium rounded-lg text-left transition text-[13px]">
            <i data-lucide="log-out" class="w-4 h-4"></i> Logout
          </button>
        `;
      } else {
        hideBannedScreen();
        if (typeof unsubscribePostbacksRealtime === 'function') {
          unsubscribePostbacksRealtime();
        }
        userCoins = 0;
        userNotifications = [];
        userWithdrawals = [];
        userCompletedOffers = [];
        document.getElementById('profile-username-display').innerText = "Guest User";
        document.getElementById('profile-email-display').innerText = "guest@gollah.top";
        document.getElementById('profile-user-id-snippet').innerText = "guest";
        userCoins = 0; updateHeaderCoinsDisplay();
        document.getElementById('profile-country-badge').innerText = `🌐 GLOBAL`;
        document.getElementById('header-avatar-img').src = 'assets/avatars/1.png';
        document.getElementById('dropdown-avatar-img').src = 'assets/avatars/1.png';
        
        updateLevelAndXpUI(0);
        updateNotificationsBadge();

        authSlot.innerHTML = `
          <button onclick="openAuthModal(false)" class="w-full flex items-center justify-center gap-2 py-2.5 px-3 bg-[#00d672] hover:bg-[#00be64] text-black font-extrabold rounded-xl text-[13px] transition shadow-lg shadow-emerald-950/40">
            <i data-lucide="log-in" class="w-4 h-4"></i> Login / Sign Up
          </button>
        `;
      }
      updateGuestLayout(!!user);
      if (window.lucide) lucide.createIcons();
    }

    let chatPanelOpen = false;

    function setChatPanelOpen(open) {
      chatPanelOpen = !!open;
      const right = document.getElementById('right-chat-sidebar');
      const btn = document.getElementById('chat-float-btn');
      const backdrop = document.getElementById('chat-backdrop');
      if (!right) return;
      if (chatPanelOpen) {
        right.classList.remove('hidden');
        right.classList.add('flex');
        if (backdrop) backdrop.classList.remove('hidden');
        if (btn) {
          btn.classList.add('hidden');
          btn.classList.remove('flex');
        }
      } else {
        right.classList.add('hidden');
        right.classList.remove('flex');
        if (backdrop) backdrop.classList.add('hidden');
        if (btn && currentUser) {
          btn.classList.remove('hidden');
          btn.classList.add('flex');
        }
      }
      if (window.lucide) lucide.createIcons();
    }

    function toggleChatPanel() {
      setChatPanelOpen(!chatPanelOpen);
    }

    /** Guest = PaidCash-style wide landing: no sidebars, no coins/wallet/profile; top Sign In / Sign Up */
    function updateGuestLayout(isLoggedIn) {
      const left = document.getElementById('left-sidebar');
      const right = document.getElementById('right-chat-sidebar');
      const userActions = document.getElementById('header-user-actions');
      const guestActions = document.getElementById('header-guest-actions');
      const searchWrap = document.getElementById('header-search-wrap');
      const logoZone = document.getElementById('header-logo-zone');
      const qaBar = document.getElementById('qa-bar');
      const chatBtn = document.getElementById('chat-float-btn');
      const backdrop = document.getElementById('chat-backdrop');

      if (isLoggedIn) {
        if (left) {
          left.classList.add('hidden');
          left.classList.add('lg:flex');
        }
        // Chat starts closed — open via float button
        chatPanelOpen = false;
        if (right) {
          right.classList.add('hidden');
          right.classList.remove('flex', 'xl:flex');
        }
        if (chatBtn) {
          chatBtn.classList.remove('hidden');
          chatBtn.classList.add('flex');
        }
        if (backdrop) backdrop.classList.add('hidden');
        if (userActions) {
          userActions.classList.remove('hidden');
          userActions.classList.add('flex');
        }
        if (guestActions) {
          guestActions.classList.add('hidden');
          guestActions.classList.remove('flex');
        }
        if (searchWrap) {
          searchWrap.classList.remove('hidden');
          searchWrap.classList.add('sm:block');
          searchWrap.style.display = '';
        }
        if (logoZone) {
          logoZone.classList.add('lg:w-56', 'lg:border-r', 'lg:border-[#18232e]');
        }
        if (qaBar) qaBar.classList.remove('hidden');
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
        if (searchWrap) {
          searchWrap.classList.add('hidden');
          searchWrap.classList.remove('sm:block');
          searchWrap.style.display = 'none';
        }
        if (logoZone) {
          logoZone.classList.remove('lg:w-56', 'lg:border-r', 'lg:border-[#18232e]');
        }
        if (qaBar) qaBar.classList.add('hidden');
      }
    }

    function openAuthModal(signup = false) {
      closeProfileDropdown();
      isSignupMode = signup;
      updateAuthModalUI();
      document.getElementById('auth-error-banner').classList.add('hidden');
      document.getElementById('auth-modal').classList.remove('hidden');
    }

    function closeAuthModal() {
      document.getElementById('auth-modal').classList.add('hidden');
      isPasswordVisible = false;
      document.getElementById('auth-pass-input').type = 'password';
      const icon = document.getElementById('pass-toggle-icon');
      if (icon) icon.setAttribute('data-lucide', 'eye');
      if (window.lucide) lucide.createIcons();
    }

    function toggleAuthMode() {
      isSignupMode = !isSignupMode;
      updateAuthModalUI();
      document.getElementById('auth-error-banner').classList.add('hidden');
    }

    function updateAuthModalUI() {
      const usernameBox = document.getElementById('auth-username-container');
      const agreeBox = document.getElementById('auth-agree-container');
      const footerAgree = document.getElementById('auth-footer-agree-text');
      const agreeCb = document.getElementById('auth-agree-checkbox');

      if (isSignupMode) {
        if (usernameBox) usernameBox.classList.remove('hidden');
        if (agreeBox) {
          agreeBox.classList.remove('hidden');
          agreeBox.classList.add('flex');
        }
        if (footerAgree) footerAgree.classList.add('hidden');
        if (agreeCb) agreeCb.checked = false;
      } else {
        if (usernameBox) usernameBox.classList.add('hidden');
        if (agreeBox) {
          agreeBox.classList.add('hidden');
          agreeBox.classList.remove('flex');
        }
        if (footerAgree) footerAgree.classList.remove('hidden');
      }

      document.getElementById('auth-modal-title').innerText = isSignupMode ? "Create Account" : "Welcome Back";
      document.getElementById('auth-modal-subtitle').innerText = isSignupMode ? "Join Gollah and start earning rewards" : "Sign in to your rewards account";
      document.getElementById('auth-submit-btn').innerText = isSignupMode ? "Sign Up Free" : "Login";
      document.getElementById('auth-toggle-msg').innerText = isSignupMode ? "Already have an account?" : "Don't have an account?";
      document.getElementById('auth-toggle-btn').innerText = isSignupMode ? "Login" : "Create Account";
      if (window.lucide) lucide.createIcons();
    }

    function togglePasswordVisibility() {
      const passInput = document.getElementById('auth-pass-input');
      const icon = document.getElementById('pass-toggle-icon');
      isPasswordVisible = !isPasswordVisible;

      if (isPasswordVisible) {
        passInput.type = 'text';
        icon.setAttribute('data-lucide', 'eye-off');
      } else {
        passInput.type = 'password';
        icon.setAttribute('data-lucide', 'eye');
      }
      if (window.lucide) lucide.createIcons();
    }

    function showAuthError(msg) {
      const banner = document.getElementById('auth-error-banner');
      const text = document.getElementById('auth-error-text');
      text.innerText = msg;
      banner.classList.remove('hidden');
    }

    async function submitAuthForm() {
      const email = document.getElementById('auth-email-input').value.trim();
      const password = document.getElementById('auth-pass-input').value.trim();
      const username = document.getElementById('auth-username-input').value.trim();

      document.getElementById('auth-error-banner').classList.add('hidden');

      if (!email || !password) {
        showAuthError("Please fill in both email and password.");
        return;
      }
      if (password.length < 6) {
        showAuthError("Password must be at least 6 characters.");
        return;
      }
      if (isSignupMode && (!username || username.length < 3)) {
        showAuthError("Username must be at least 3 characters.");
        return;
      }
      if (isSignupMode) {
        const agreeCb = document.getElementById('auth-agree-checkbox');
        if (!agreeCb || !agreeCb.checked) {
          showAuthError("Please agree to the Terms of Service and Privacy Policy.");
          return;
        }
      }

      const submitBtn = document.getElementById('auth-submit-btn');
      const originalText = submitBtn.innerText;
      submitBtn.innerText = "Processing...";
      submitBtn.disabled = true;

      try {
        if (isSignupMode) {
          const detectedCountry = await getUserCountry();
          let finalUsername = username;
          const { data: existingProfile } = await db.from('profiles').select('id').eq('username', username).maybeSingle();
          if (existingProfile) {
            finalUsername = `${username}_${Math.floor(Math.random() * 899 + 100)}`;
          }

          const { data, error } = await db.auth.signUp({ 
            email, 
            password,
            options: {
              data: {
                user_name: finalUsername,
                avatar_url: 'assets/avatars/1.png',
                country: detectedCountry
              }
            }
          });
          
          if (error) {
            showAuthError(error.message);
          } else {
            if (data.user) {
              await db.from('profiles').upsert({
                id: data.user.id,
                username: finalUsername,
                avatar_url: 'assets/avatars/1.png',
                country: detectedCountry,
                coins: 0,
                level: 1
              });
            }
            closeAuthModal();
            await syncUserSession(data.user);
            navigate('home');
          }
        } else {
          const { data, error } = await db.auth.signInWithPassword({ email, password });
          if (error) {
            showAuthError(error.message);
          } else {
            closeAuthModal();
            await syncUserSession(data.user?.user || data.user || data.session?.user);
            navigate('home');
          }
        }
      } catch (err) {
        showAuthError(err.message || "Authentication failed.");
      } finally {
        submitBtn.innerText = originalText;
        submitBtn.disabled = false;
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

            <div class="bg-[#111a24] border border-rose-500/20 p-3.5 rounded-xl space-y-2">
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
        titleEl.innerHTML = `<i data-lucide="life-buoy" class="w-5 h-5 text-amber-400"></i> Support Desk`;
        bodyEl.innerHTML = `
          <div class="bg-[#121c25] border border-[#202c38] rounded-xl p-3.5 space-y-3 text-[12px] text-slate-300">
            <div class="flex items-center gap-2">
              <i data-lucide="mail" class="w-4 h-4 text-[#00d672]"></i>
              <span class="font-bold text-white">Support Email:</span>
              <span class="text-emerald-400 font-mono">admin@gollah.top</span>
            </div>
            <p>For missing credits, include: username, offer name, approximate time, and device type. Network verification can take 24–72 hours.</p>
            <p class="text-slate-500">Min cashout: 300 coins · Business / partnership inquiries welcome at the same address.</p>
          </div>
        `;
      }

      document.getElementById('legal-modal').classList.remove('hidden');
      if (window.lucide) lucide.createIcons();
    }

    function closeLegalModal() {
      document.getElementById('legal-modal').classList.add('hidden');
    }

