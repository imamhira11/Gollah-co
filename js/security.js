/* security.js — VPN/Proxy, Multi-Account, Email Verification + Withdrawal Lock
   Fail-open on IP API timeout. Hooks auth/landing signup. Does not touch offers.js.
*/
(function () {
  'use strict';

  const DEVICE_FP_KEY = 'gollah_device_fp_v2';
  const DEVICE_LOCK_KEY = 'gollah_device_lock_v2';
  const DEVICE_ACCOUNTS_KEY = 'gollah_device_accounts_v2';
  const VPN_CACHE_KEY = 'gollah_vpn_status_v2';
  const EMAIL_BAR_DISMISS_KEY = 'gollah_email_bar_dismissed_v1';
  const EMAIL_VERIFIED_TOAST_KEY = 'gollah_email_verified_toast_v1';
  const VPN_CACHE_TTL_MS = 10 * 60 * 1000;
  const IP_API_TIMEOUT_MS = 4500;
  const COOKIE_DAYS = 400;
  const RESEND_COOLDOWN_MS = 60000;

  let vpnDetected = false;
  let vpnReason = '';
  let vpnCheckDone = false;
  let vpnCheckPromise = null;
  let authHookInstalled = false;
  let landingHookInstalled = false;
  let resendCooldownUntil = 0;
  let lastKnownVerified = null;
  let emailWatchTimer = null;

  function setCookie(name, value, days) {
    try {
      const d = new Date();
      d.setTime(d.getTime() + (days || COOKIE_DAYS) * 24 * 60 * 60 * 1000);
      document.cookie = name + '=' + encodeURIComponent(String(value)) +
        ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
    } catch (e) {}
  }
  function getCookie(name) {
    try {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  function generateDeviceFingerprint() {
    try {
      const parts = [
        navigator.userAgent || '', navigator.language || '',
        String(screen.width || 0) + 'x' + String(screen.height || 0) + 'x' + String(screen.colorDepth || 0),
        String(new Date().getTimezoneOffset()),
        (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })(),
        String(navigator.hardwareConcurrency || 0), String(navigator.maxTouchPoints || 0),
        navigator.platform || '', String(screen.availWidth || 0)
      ];
      const raw = parts.join('|');
      let hash = 2166136261;
      for (let i = 0; i < raw.length; i++) { hash ^= raw.charCodeAt(i); hash = Math.imul(hash, 16777619); }
      return 'fp_' + (hash >>> 0).toString(36) + '_' + (raw.length % 997).toString(36);
    } catch (e) { return 'fp_fb_' + Date.now().toString(36); }
  }

  function getOrCreateDeviceFingerprint() {
    try {
      let fp = localStorage.getItem(DEVICE_FP_KEY) || getCookie(DEVICE_FP_KEY);
      if (fp && String(fp).indexOf('fp_') === 0) {
        try { localStorage.setItem(DEVICE_FP_KEY, fp); } catch (e) {}
        setCookie(DEVICE_FP_KEY, fp);
        return fp;
      }
      fp = generateDeviceFingerprint();
      try { localStorage.setItem(DEVICE_FP_KEY, fp); } catch (e) {}
      setCookie(DEVICE_FP_KEY, fp);
      return fp;
    } catch (e) { return generateDeviceFingerprint(); }
  }

  function isDeviceLocked() {
    try {
      const lock = localStorage.getItem(DEVICE_LOCK_KEY) || getCookie(DEVICE_LOCK_KEY);
      if (lock === '1' || lock === 'true') return true;
      return getDeviceAccountIds().length > 0;
    } catch (e) { return false; }
  }

  function setDeviceLock(userId) {
    try {
      localStorage.setItem(DEVICE_LOCK_KEY, '1');
      setCookie(DEVICE_LOCK_KEY, '1');
      const fp = getOrCreateDeviceFingerprint();
      localStorage.setItem(DEVICE_FP_KEY, fp);
      setCookie(DEVICE_FP_KEY, fp);
      if (userId) registerAccountOnDevice(userId);
    } catch (e) {}
  }

  function getDeviceAccountIds() {
    try {
      const raw = localStorage.getItem(DEVICE_ACCOUNTS_KEY) || getCookie(DEVICE_ACCOUNTS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch (e) { return []; }
  }

  function registerAccountOnDevice(userId) {
    if (!userId) return;
    try {
      const ids = getDeviceAccountIds();
      const id = String(userId);
      if (ids.indexOf(id) === -1) {
        ids.push(id);
        while (ids.length > 5) ids.shift();
        const json = JSON.stringify(ids);
        localStorage.setItem(DEVICE_ACCOUNTS_KEY, json);
        setCookie(DEVICE_ACCOUNTS_KEY, json);
      }
      localStorage.setItem(DEVICE_LOCK_KEY, '1');
      setCookie(DEVICE_LOCK_KEY, '1');
    } catch (e) {}
  }

  function getBrowserTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }
  function tzRegionKey(tz) {
    if (!tz) return '';
    const parts = String(tz).trim().split('/');
    if (parts.length >= 2) return (parts[0] + '/' + parts[1]).toLowerCase();
    return String(tz).toLowerCase();
  }
  function timezonesMismatch(browserTz, ipTz) {
    if (!browserTz || !ipTz) return false;
    const a = tzRegionKey(browserTz), b = tzRegionKey(ipTz);
    if (!a || !b) return false;
    if (a === b) return false;
    if (String(browserTz).toLowerCase() === String(ipTz).toLowerCase()) return false;
    return true;
  }

  function readVpnCache() {
    try {
      const raw = sessionStorage.getItem(VPN_CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.ts !== 'number') return null;
      if (Date.now() - obj.ts > VPN_CACHE_TTL_MS) return null;
      return obj;
    } catch (e) { return null; }
  }
  function writeVpnCache(detected, reason) {
    try {
      sessionStorage.setItem(VPN_CACHE_KEY, JSON.stringify({ ts: Date.now(), detected: !!detected, reason: reason || '' }));
    } catch (e) {}
  }

  function parseSecurityFromIpwho(data) {
    if (!data || typeof data !== 'object') return { blocked: false, reason: '', ipTz: '' };
    const sec = data.security || {};
    const reasons = [];
    if (sec.vpn || sec.isVpn || sec.is_vpn) reasons.push('VPN');
    if (sec.proxy || sec.isProxy || sec.is_proxy) reasons.push('Proxy');
    if (sec.tor || sec.isTor || sec.is_tor) reasons.push('Tor');
    if (sec.hosting || sec.isHosting || sec.is_hosting || sec.datacenter) reasons.push('Hosting/Datacenter');
    if ((sec.anonymous || sec.isAnonymous) && !reasons.length) reasons.push('Anonymous');
    let ipTz = '';
    try {
      if (data.timezone && typeof data.timezone === 'object')
        ipTz = data.timezone.id || data.timezone.time_zone || data.timezone.name || '';
      else if (typeof data.timezone === 'string') ipTz = data.timezone;
    } catch (e) {}
    return { blocked: reasons.length > 0, reason: reasons.join(', '), ipTz: ipTz };
  }
  function parseSecurityFromIpapi(data) {
    if (!data || typeof data !== 'object') return { blocked: false, reason: '', ipTz: '' };
    const ipTz = data.timezone || '';
    const org = String(data.org || data.asn || '').toLowerCase();
    const reasons = [];
    if (/amazon|aws|google|digitalocean|ovh|hetzner|linode|vultr|cloudflare|microsoft|azure|hosting|datacenter|vps|server/i.test(org))
      reasons.push('Hosting/Datacenter');
    return { blocked: reasons.length > 0, reason: reasons.join(', '), ipTz: ipTz };
  }

  async function fetchWithTimeout(url, ms) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(function () { try { if (controller) controller.abort(); } catch (e) {} }, ms);
    try {
      return await fetch(url, { method: 'GET', signal: controller ? controller.signal : undefined, cache: 'no-store' });
    } finally { clearTimeout(timer); }
  }

  async function checkVpnProxy() {
    if (vpnCheckDone) return vpnDetected;
    if (vpnCheckPromise) return vpnCheckPromise;
    const cached = readVpnCache();
    if (cached) {
      vpnDetected = !!cached.detected; vpnReason = cached.reason || ''; vpnCheckDone = true;
      return vpnDetected;
    }
    vpnCheckPromise = (async function () {
      const browserTz = getBrowserTimeZone();
      let blocked = false, reasonParts = [], ipTz = '';
      try {
        let data = null;
        try {
          const res = await fetchWithTimeout('https://ipwho.is/', IP_API_TIMEOUT_MS);
          if (res && res.ok) data = await res.json();
        } catch (e1) {}
        if (data && data.success !== false) {
          const flags = parseSecurityFromIpwho(data);
          if (flags.blocked) { blocked = true; reasonParts.push(flags.reason); }
          ipTz = flags.ipTz || ipTz;
        } else {
          try {
            const res2 = await fetchWithTimeout('https://ipapi.co/json/', IP_API_TIMEOUT_MS);
            if (res2 && res2.ok) {
              const data2 = await res2.json();
              const flags2 = parseSecurityFromIpapi(data2);
              if (flags2.blocked) { blocked = true; reasonParts.push(flags2.reason || 'Proxy/Hosting'); }
              ipTz = flags2.ipTz || ipTz;
            }
          } catch (e2) {}
        }
        if (ipTz && browserTz && timezonesMismatch(browserTz, ipTz)) {
          blocked = true;
          reasonParts.push('Timezone mismatch (' + browserTz + ' vs ' + ipTz + ')');
        }
        vpnDetected = blocked;
        vpnReason = reasonParts.join('; ') || (blocked ? 'VPN/Proxy' : '');
        writeVpnCache(vpnDetected, vpnReason);
        vpnCheckDone = true;
        return vpnDetected;
      } catch (e) {
        writeVpnCache(false, 'timeout_or_error');
        vpnDetected = false; vpnReason = ''; vpnCheckDone = true;
        return false;
      } finally { vpnCheckPromise = null; }
    })();
    return vpnCheckPromise;
  }

  function ensureSecurityModalStyles() {
    if (document.getElementById('gollah-security-modal-style')) return;
    const style = document.createElement('style');
    style.id = 'gollah-security-modal-style';
    style.textContent = [
      '#gollah-security-modal{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(4,8,12,0.78);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);}',
      '#gollah-security-modal.hidden{display:none!important;}',
      '#gollah-security-modal .gsm-card{position:relative;isolation:isolate;overflow:hidden;background:#1E2532;border:1px solid #343E50;border-radius:18px;width:100%;max-width:400px;padding:24px;box-shadow:0 24px 64px rgba(0,0,0,0.55),0 0 0 1px rgba(255,255,255,0.04);animation:gsmIn 0.32s cubic-bezier(0.16,1,0.3,1) forwards;}',
      '#gollah-security-modal .gsm-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#00d672,#34d399,#22d3ee,#a78bfa,#f472b6,#fbbf24,#00d672);background-size:200% 100%;animation:gsmStrip 3s linear infinite;pointer-events:none;}',
      '@keyframes gsmIn{0%{opacity:0;transform:translateY(16px) scale(0.97)}100%{opacity:1;transform:translateY(0) scale(1)}}',
      '@keyframes gsmStrip{0%{background-position:0% 50%}100%{background-position:200% 50%}}',
      '#gollah-security-modal .gsm-icon{width:48px;height:48px;border-radius:14px;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.25);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:22px;}',
      '#gollah-security-modal .gsm-title{font-size:16px;font-weight:800;color:#F8FAFC;text-align:center;margin-bottom:8px;}',
      '#gollah-security-modal .gsm-msg{font-size:13px;color:#94A3B8;text-align:center;line-height:1.5;margin-bottom:18px;}',
      '#gollah-security-modal .gsm-btn{display:block;width:100%;background:linear-gradient(135deg,#00e67a 0%,#00d672 45%,#00b85c 100%);color:#061910;font-weight:800;font-size:13px;padding:12px 16px;border:none;border-radius:12px;cursor:pointer;}',
      '#gollah-verified-toast{position:fixed;bottom:24px;right:16px;z-index:99998;background:#0f2a1c;border:1px solid rgba(0,214,114,0.45);color:#ecfdf5;font-weight:800;font-size:13px;padding:10px 16px;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,0.4);opacity:0;transform:translateY(10px);transition:opacity .25s ease,transform .25s ease;pointer-events:none;}',
      '#gollah-verified-toast.show{opacity:1;transform:translateY(0);}'
    ].join('');
    document.head.appendChild(style);
  }

  function showSecurityWarning(title, message) {
    ensureSecurityModalStyles();
    let modal = document.getElementById('gollah-security-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'gollah-security-modal';
      modal.className = 'hidden';
      modal.innerHTML = '<div class="gsm-card" role="dialog" aria-modal="true"><div class="gsm-icon">⚠️</div><div class="gsm-title" id="gsm-title"></div><div class="gsm-msg" id="gsm-msg"></div><button type="button" class="gsm-btn" id="gsm-close-btn">Got it</button></div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function (e) { if (e.target === modal) hideSecurityWarning(); });
      const btn = document.getElementById('gsm-close-btn');
      if (btn) btn.addEventListener('click', hideSecurityWarning);
    }
    const t = document.getElementById('gsm-title');
    const m = document.getElementById('gsm-msg');
    if (t) t.textContent = title || 'Security Notice';
    if (m) m.textContent = message || '';
    modal.classList.remove('hidden');
  }
  function hideSecurityWarning() {
    const modal = document.getElementById('gollah-security-modal');
    if (modal) modal.classList.add('hidden');
  }
  function showMultiAccountWarning() {
    showSecurityWarning('Multi-Account Detected!', 'Only 1 account is allowed per device/browser.');
  }
  function showVpnWarning() {
    showSecurityWarning('VPN/Proxy Detected!', 'Please disable VPN/Proxy to access offers and protect your account.');
  }

  // ── Multi-account signup (modal + landing) ────────────────────────────────
  function isModalSignupMode() {
    try { if (typeof isSignupMode !== 'undefined' && isSignupMode === true) return true; } catch (e) {}
    try {
      const title = document.getElementById('auth-modal-title');
      if (title && /create account|sign\s*up/i.test(title.textContent || '')) return true;
      const btn = document.getElementById('auth-submit-btn');
      if (btn && /sign\s*up/i.test(btn.innerText || btn.textContent || '')) return true;
    } catch (e2) {}
    return false;
  }
  function isLandingSignupMode() {
    try { if (typeof landingSignupMode !== 'undefined' && landingSignupMode === true) return true; } catch (e) {}
    try {
      const title = document.getElementById('landing-auth-title');
      if (title && /sign\s*up|create/i.test(title.textContent || '')) return true;
      const btn = document.getElementById('landing-auth-submit');
      if (btn && /start earning|sign\s*up/i.test(btn.innerText || btn.textContent || '')) return true;
    } catch (e2) {}
    return false;
  }

  function onAuthSubmitClickCapture(e) {
    try {
      const btn = e.target && e.target.closest ? e.target.closest('#auth-submit-btn, #landing-auth-submit') : null;
      if (!btn) return;
      if (btn.id === 'auth-submit-btn' && !isModalSignupMode()) return;
      if (btn.id === 'landing-auth-submit' && !isLandingSignupMode()) return;
      if (!isDeviceLocked()) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      showMultiAccountWarning();
    } catch (err) {}
  }

  function lockAfterAuth() {
    setTimeout(function () {
      try { if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) setDeviceLock(currentUser.id); } catch (e) {}
    }, 600);
    setTimeout(function () {
      try { if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) setDeviceLock(currentUser.id); } catch (e) {}
      updateEmailVerificationUI();
    }, 2000);
  }

  function installSubmitAuthFormHook() {
    if (authHookInstalled) return;
    try {
      if (typeof window.submitAuthForm !== 'function') return;
      const original = window.submitAuthForm;
      window.submitAuthForm = async function () {
        try {
          if (isModalSignupMode() && isDeviceLocked()) { showMultiAccountWarning(); return; }
        } catch (e) {}
        const result = await original.apply(this, arguments);
        lockAfterAuth();
        return result;
      };
      authHookInstalled = true;
    } catch (e) {}
  }
  function installSubmitLandingAuthHook() {
    if (landingHookInstalled) return;
    try {
      if (typeof window.submitLandingAuth !== 'function') return;
      const original = window.submitLandingAuth;
      window.submitLandingAuth = async function () {
        try {
          if (isLandingSignupMode() && isDeviceLocked()) { showMultiAccountWarning(); return; }
        } catch (e) {}
        const result = await original.apply(this, arguments);
        lockAfterAuth();
        return result;
      };
      landingHookInstalled = true;
    } catch (e) {}
  }
  function ensureAuthHooks() {
    installSubmitAuthFormHook();
    installSubmitLandingAuthHook();
    if (!authHookInstalled || !landingHookInstalled) {
      let tries = 0;
      const iv = setInterval(function () {
        installSubmitAuthFormHook();
        installSubmitLandingAuthHook();
        tries++;
        if ((authHookInstalled && landingHookInstalled) || tries > 50) clearInterval(iv);
      }, 200);
    }
  }

  // ── VPN offerwall block ───────────────────────────────────────────────────
  function isOfferwallLaunchTarget(el) {
    if (!el || !el.closest) return false;
    if (el.closest('[onclick*="openProviderWallModal"]')) return true;
    if (el.closest('[onclick*="filterByProvider"]')) return true;
    if (el.closest('[onclick*="openOfferModal"]')) return true;
    const btn = el.closest('button, a, [role="button"]');
    if (!btn) return false;
    const oc = (btn.getAttribute('onclick') || '') + ' ' + (btn.getAttribute('href') || '');
    if (/openProviderWallModal|filterByProvider|openOfferModal|startOffer/i.test(oc)) return true;
    return false;
  }
  function onOfferwallClickCapture(e) {
    try {
      if (!vpnDetected) return;
      if (!isOfferwallLaunchTarget(e.target)) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      showVpnWarning();
    } catch (err) {}
  }

  // ── Email verification bar + toast + withdrawal lock ──────────────────────
  function getAuthUser() {
    try {
      if (typeof currentUser !== 'undefined' && currentUser) return currentUser;
    } catch (e) {}
    return null;
  }

  function isEmailVerified(user) {
    if (!user) return false;
    return !!(user.email_confirmed_at || user.confirmed_at);
  }

  function playVerifyTockSound() {
    try {
      if (typeof playCashoutClickSound === 'function') {
        playCashoutClickSound();
        return;
      }
    } catch (e) {}
    try {
      const audio = new Audio('assets/sounds/enter_cashout_sound.mp3');
      audio.volume = 0.7;
      audio.play().catch(function () {});
    } catch (e2) {}
  }

  function showVerifiedToast() {
    ensureSecurityModalStyles();
    let toast = document.getElementById('gollah-verified-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'gollah-verified-toast';
      toast.textContent = 'Verified';
      document.body.appendChild(toast);
    }
    toast.classList.add('show');
    playVerifyTockSound();
    setTimeout(function () { toast.classList.remove('show'); }, 3500);
  }

  function getEmailBarDismissedFor(userId) {
    try {
      return localStorage.getItem(EMAIL_BAR_DISMISS_KEY) === String(userId);
    } catch (e) { return false; }
  }
  function setEmailBarDismissedFor(userId) {
    try { localStorage.setItem(EMAIL_BAR_DISMISS_KEY, String(userId)); } catch (e) {}
  }

  function showEmailVerifyBar() {
    const bar = document.getElementById('email-verify-bar');
    if (bar) bar.classList.remove('hidden');
  }
  function hideEmailVerifyBar() {
    const bar = document.getElementById('email-verify-bar');
    if (bar) bar.classList.add('hidden');
  }

  function updateEmailVerificationUI() {
    try {
      const user = getAuthUser();
      if (!user || !user.email) {
        hideEmailVerifyBar();
        lastKnownVerified = null;
        return;
      }
      const verified = isEmailVerified(user);
      if (verified) {
        hideEmailVerifyBar();
        // One-time verified toast
        try {
          const key = EMAIL_VERIFIED_TOAST_KEY + '_' + user.id;
          if (lastKnownVerified === false && !localStorage.getItem(key)) {
            localStorage.setItem(key, '1');
            showVerifiedToast();
          } else if (lastKnownVerified === null && !localStorage.getItem(key) && user.email_confirmed_at) {
            // First load already verified — do not spam toast
          }
        } catch (e) {}
        lastKnownVerified = true;
        return;
      }
      lastKnownVerified = false;
      if (!getEmailBarDismissedFor(user.id)) showEmailVerifyBar();
      else hideEmailVerifyBar();
    } catch (e) {}
  }

  async function resendVerificationEmail() {
    const btn = document.getElementById('email-verify-resend-btn');
    const user = getAuthUser();
    if (!user || !user.email) return;
    if (Date.now() < resendCooldownUntil) {
      const secs = Math.ceil((resendCooldownUntil - Date.now()) / 1000);
      showSecurityWarning('Please wait', 'You can resend in ' + secs + 's.');
      return;
    }
    if (!window.db || !db.auth) {
      showSecurityWarning('Error', 'Connection error. Please try again.');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      const { error } = await db.auth.resend({ type: 'signup', email: user.email });
      if (error) {
        showSecurityWarning('Resend failed', error.message || 'Could not send verification email.');
      } else {
        resendCooldownUntil = Date.now() + RESEND_COOLDOWN_MS;
        showSecurityWarning('Verification link sent!', 'Check your inbox (and spam folder) for the verification link.');
      }
    } catch (e) {
      showSecurityWarning('Resend failed', (e && e.message) || 'Could not send verification email.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Resend';
      }
    }
  }

  function bindEmailBarButtons() {
    const resend = document.getElementById('email-verify-resend-btn');
    const closeBtn = document.getElementById('email-verify-close-btn');
    if (resend && !resend.dataset.bound) {
      resend.dataset.bound = '1';
      resend.addEventListener('click', function (e) {
        e.preventDefault();
        resendVerificationEmail();
      });
    }
    if (closeBtn && !closeBtn.dataset.bound) {
      closeBtn.dataset.bound = '1';
      closeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        const user = getAuthUser();
        if (user && user.id) setEmailBarDismissedFor(user.id);
        hideEmailVerifyBar();
      });
    }
  }

  function isWithdrawalActionTarget(el) {
    if (!el || !el.closest) return false;
    if (el.closest('#cashout-submit-btn')) return true;
    if (el.closest('[onclick*="submitCustomWithdrawal"]')) return true;
    if (el.closest('[onclick*="openCashoutModal"]')) return true;
    if (el.closest('[onclick*="openCashout"]')) return true;
    const btn = el.closest('button, a, [role="button"]');
    if (!btn) return false;
    const oc = (btn.getAttribute('onclick') || '') + ' ' + (btn.id || '') + ' ' + (btn.textContent || '');
    if (/submitCustomWithdrawal|openCashoutModal|cashout-submit/i.test(oc)) return true;
    if (/cash\s*out|withdraw/i.test(btn.textContent || '') && btn.closest('#cashout-modal, #shop-view, [id*="shop"]')) return true;
    return false;
  }

  function onWithdrawalClickCapture(e) {
    try {
      if (!isWithdrawalActionTarget(e.target)) return;
      const user = getAuthUser();
      if (!user) return;
      if (isEmailVerified(user)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      showSecurityWarning('Email verification required', 'Please verify your email first to unlock withdrawals.');
      showEmailVerifyBar();
    } catch (err) {}
  }

  async function refreshAuthUserFromSession() {
    try {
      if (!window.db || !db.auth) return;
      const { data } = await db.auth.getUser();
      if (data && data.user) {
        // Merge into global currentUser without breaking auth.js ownership
        try {
          if (typeof currentUser !== 'undefined' && currentUser && currentUser.id === data.user.id) {
            currentUser.email_confirmed_at = data.user.email_confirmed_at;
            currentUser.confirmed_at = data.user.confirmed_at;
          } else if (typeof currentUser !== 'undefined') {
            // leave currentUser as-is if different
          }
        } catch (e) {}
        updateEmailVerificationUI();
      }
    } catch (e) {}
  }

  function startEmailVerificationWatch() {
    bindEmailBarButtons();
    updateEmailVerificationUI();
    if (emailWatchTimer) clearInterval(emailWatchTimer);
    emailWatchTimer = setInterval(function () {
      refreshAuthUserFromSession();
      updateEmailVerificationUI();
    }, 8000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshAuthUserFromSession();
    });
    window.addEventListener('focus', function () { refreshAuthUserFromSession(); });
  }

  function trackCurrentUserOnDevice() {
    try {
      if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) setDeviceLock(currentUser.id);
    } catch (e) {}
  }

  function initSecurityModule() {
    getOrCreateDeviceFingerprint();
    document.addEventListener('click', onAuthSubmitClickCapture, true);
    document.addEventListener('click', onOfferwallClickCapture, true);
    document.addEventListener('click', onWithdrawalClickCapture, true);
    ensureAuthHooks();
    checkVpnProxy().catch(function () {});
    startEmailVerificationWatch();
    setTimeout(trackCurrentUserOnDevice, 1500);
    setTimeout(function () { trackCurrentUserOnDevice(); updateEmailVerificationUI(); }, 3500);
    setInterval(trackCurrentUserOnDevice, 20000);
    window.addEventListener('load', function () {
      ensureAuthHooks();
      trackCurrentUserOnDevice();
      checkVpnProxy().catch(function () {});
      updateEmailVerificationUI();
      refreshAuthUserFromSession();
    });
    window.GollahSecurity = {
      checkVpnProxy: checkVpnProxy,
      isVpnDetected: function () { return vpnDetected; },
      getVpnReason: function () { return vpnReason; },
      getDeviceFingerprint: getOrCreateDeviceFingerprint,
      isDeviceLocked: isDeviceLocked,
      setDeviceLock: setDeviceLock,
      showSecurityWarning: showSecurityWarning,
      showMultiAccountWarning: showMultiAccountWarning,
      showVpnWarning: showVpnWarning,
      updateEmailVerificationUI: updateEmailVerificationUI,
      isEmailVerified: function () { return isEmailVerified(getAuthUser()); }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSecurityModule);
  } else {
    initSecurityModule();
  }
})();
