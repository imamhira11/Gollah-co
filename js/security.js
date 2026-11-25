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
  const RESEND_COOLDOWN_LS_KEY = 'gollah_resend_cooldown_until';
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
  let resendCountdownTimer = null;
  let emailBarReshowTimer = null;
  const EMAIL_BAR_RESHOW_MS = 40000; // auto re-show 40s after dismiss while unverified

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
      '#gollah-verified-toast{position:fixed;bottom:84px;left:24px;right:auto;z-index:99999;display:inline-flex;align-items:center;gap:10px;background:linear-gradient(135deg,#00e67a 0%,#00d676 45%,#00c86b 100%);color:#ffffff;font-weight:800;font-size:13px;padding:12px 20px;border-radius:12px;border:none;box-shadow:0 8px 28px rgba(0,214,114,0.4),0 2px 8px rgba(0,0,0,0.2);opacity:0;transform:translateX(-18px);transition:opacity .28s ease,transform .28s cubic-bezier(0.16,1,0.3,1);pointer-events:none;max-width:calc(100vw - 32px);}',
      '#gollah-verified-toast.show{opacity:1;transform:translateX(0);}',
      '#gollah-verified-toast .gvt-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0;}',
      '#gollah-verified-toast .gvt-icon svg{width:18px;height:18px;stroke:#fff;fill:none;}',
      '#gollah-verified-toast .gvt-text{color:#ffffff;font-weight:800;letter-spacing:0.01em;white-space:nowrap;}'
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

  /** Resolve the shared Supabase client (`db` from supabase-config.js). */
  function getSupabaseClient() {
    try {
      if (typeof db !== 'undefined' && db && db.auth) return db;
    } catch (e) {}
    try {
      if (typeof window !== 'undefined' && window.db && window.db.auth) return window.db;
    } catch (e2) {}
    return null;
  }


  // Source of truth: public.profiles.is_email_verified (Confirm email is OFF in Auth)
  let profileEmailVerified = null; // null = unknown, true/false once loaded
  let profileVerifiedUserId = null;

  function getAuthUser() {
    try {
      if (typeof currentUser !== 'undefined' && currentUser) return currentUser;
    } catch (e) {}
    return null;
  }

  function isOAuthVerifiedUser(user) {
    if (!user) return false;
    try {
      const identities = user.identities || [];
      for (let i = 0; i < identities.length; i++) {
        const p = String((identities[i] && identities[i].provider) || '').toLowerCase();
        if (p && p !== 'email') return true;
      }
    } catch (e) {}
    try {
      const am = user.app_metadata || {};
      const providers = am.providers || (am.provider ? [am.provider] : []);
      for (let i = 0; i < providers.length; i++) {
        const p = String(providers[i] || '').toLowerCase();
        if (p && p !== 'email') return true;
      }
      if (am.provider && String(am.provider).toLowerCase() !== 'email') return true;
    } catch (e2) {}
    return false;
  }

  /** Single source of truth: profiles.is_email_verified */
  function isEmailVerified(user) {
    if (!user) return false;
    if (profileVerifiedUserId && user.id && profileVerifiedUserId === user.id && profileEmailVerified === true) {
      return true;
    }
    if (profileVerifiedUserId && user.id && profileVerifiedUserId === user.id && profileEmailVerified === false) {
      return false;
    }
    // Fallback while profile row is still loading
    if (user.is_email_verified === true) return true;
    return false;
  }

  /* ── Verification toast audio: stays on opened tab, plays immediately or while toast is visible ── */
  var ENTER_CASHOUT_SOUND_SRC = 'assets/sounds/enter_cashout_sound.mp3';
  var _audioCtx = null;
  var _decodedVerifyBuffer = null;
  var _sharedToastAudio = null;
  var _audioUnlocked = false;
  var _lastPlayedSoundAt = 0;
  var _toastActiveUntil = 0;

  function _initWebAudioEngine() {
    if (!_audioCtx) {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) _audioCtx = new Ctx();
      } catch (e) {}
    }
    if (_audioCtx && !_decodedVerifyBuffer && !window._gollahFetchingVerifyAudio) {
      window._gollahFetchingVerifyAudio = true;
      fetch(ENTER_CASHOUT_SOUND_SRC)
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) { return _audioCtx.decodeAudioData(buf); })
        .then(function (decoded) { _decodedVerifyBuffer = decoded; })
        .catch(function () {});
    }
  }

  function _getSharedToastAudio() {
    if (!_sharedToastAudio) {
      try {
        _sharedToastAudio = new Audio(ENTER_CASHOUT_SOUND_SRC);
        _sharedToastAudio.preload = 'auto';
        _sharedToastAudio.volume = 1.0;
      } catch (e) {}
    }
    return _sharedToastAudio;
  }

  function _playEnterCashoutSoundDirect() {
    var now = Date.now();
    if (now - _lastPlayedSoundAt < 1800) return true;
    _lastPlayedSoundAt = now;

    // 1) Try Web Audio API AudioBuffer first
    try {
      if (_audioCtx && _decodedVerifyBuffer) {
        if (_audioCtx.state === 'suspended') {
          _audioCtx.resume().catch(function () {});
        }
        if (_audioCtx.state === 'running') {
          var src = _audioCtx.createBufferSource();
          src.buffer = _decodedVerifyBuffer;
          src.connect(_audioCtx.destination);
          src.start(0);
          _toastActiveUntil = 0;
          return true;
        }
      }
    } catch (eWebAudio) {}

    // 2) Standard HTMLAudioElement playback
    try {
      var audio = _getSharedToastAudio() || new Audio(ENTER_CASHOUT_SOUND_SRC);
      audio.muted = false;
      audio.volume = 1.0;
      audio.currentTime = 0;
      var p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          _toastActiveUntil = 0;
        }).catch(function () {
          // Blocked by cold-tab autoplay; will only play if user interacts WHILE toast is still visible
          _lastPlayedSoundAt = 0;
        });
      }
    } catch (e) {
      _lastPlayedSoundAt = 0;
    }
    return false;
  }

  /**
   * Play enter_cashout_sound immediately when Email Verified or Email Not Verified appears.
   * If browser autoplay blocks initial load, allows playback ONLY while the toast pill is still visible on screen.
   */
  function playVerifyTockSound(opts) {
    opts = opts || {};
    var duration = opts.durationMs || 4200;
    _toastActiveUntil = Date.now() + duration;
    _playEnterCashoutSoundDirect();
  }

  /** Unlock audio on user gesture; if toast is currently visible and sound hasn't played yet, play it now */
  function primeVerifySoundFromUserGesture() {
    _initWebAudioEngine();
    try {
      if (_audioCtx && _audioCtx.state === 'suspended') {
        _audioCtx.resume().catch(function () {});
      }
    } catch (eCtx) {}

    if (_toastActiveUntil > Date.now() && _lastPlayedSoundAt === 0) {
      _toastActiveUntil = 0;
      _playEnterCashoutSoundDirect();
      return;
    }

    if (_audioUnlocked) return;
    try {
      var audio = _getSharedToastAudio();
      if (!audio) return;
      audio.muted = true;
      var p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          try {
            audio.pause();
            audio.currentTime = 0;
            audio.muted = false;
            audio.volume = 1.0;
            _audioUnlocked = true;
          } catch (e2) {}
        }).catch(function () {
          try { audio.muted = false; } catch (e3) {}
        });
      }
    } catch (e) {}
  }

  function preloadVerifySound() {
    _initWebAudioEngine();
    try {
      var a = _getSharedToastAudio();
      if (a) { try { a.load(); } catch (eLoad) {} }
    } catch (e) {}
    if (!window._gollahAudioGestureBound) {
      window._gollahAudioGestureBound = true;
      ['pointerdown', 'click', 'touchstart', 'keydown'].forEach(function (evt) {
        document.addEventListener(evt, primeVerifySoundFromUserGesture, { capture: true, passive: true });
      });
    }
  }

  function showVerifiedToast(opts) {
    opts = opts || {};
    // Success toast only when verification actually succeeded — hide bar in the same moment
    hideEmailVerifyBar();
    ensureSecurityModalStyles();
    let toast = document.getElementById('gollah-verified-toast');
    var pillHtml =
      '<span class="gvt-icon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
          '<path d="M9 12l2 2 4-4"/>' +
        '</svg>' +
      '</span>' +
      '<span class="gvt-text">Email Verified</span>';
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'gollah-verified-toast';
      toast.setAttribute('role', 'status');
      toast.innerHTML = pillHtml;
      document.body.appendChild(toast);
    } else {
      toast.innerHTML = pillHtml;
    }
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.classList.add('show');
    playVerifyTockSound({ allowColdFallback: !!opts.allowColdFallback });
    setTimeout(function () { toast.classList.remove('show'); }, 4000);
  }

  function clearEmailBarReshowTimer() {
    if (emailBarReshowTimer) {
      try { clearTimeout(emailBarReshowTimer); } catch (e) {}
      emailBarReshowTimer = null;
    }
  }

  /** Soft-dismiss only — bar returns after EMAIL_BAR_RESHOW_MS while still unverified. */
  function scheduleEmailBarReshow() {
    clearEmailBarReshowTimer();
    emailBarReshowTimer = setTimeout(function () {
      emailBarReshowTimer = null;
      try {
        const user = getAuthUser();
        if (!user || !user.email) return;
        if (isEmailVerified(user)) {
          hideEmailVerifyBar();
          return;
        }
        showEmailVerifyBar();
        restoreResendCooldownUI();
      } catch (e) {}
    }, EMAIL_BAR_RESHOW_MS);
  }

  function showEmailVerifyBar() {
    // Block during onboarding until user taps Get Started
    try {
      if (typeof window.isGollahOnboardingActive === 'function' && window.isGollahOnboardingActive()) {
        const barHide = document.getElementById('email-verify-bar');
        if (barHide) barHide.classList.add('hidden');
        return;
      }
      if (window.__gollahOnboardingActive === true) {
        const barHide2 = document.getElementById('email-verify-bar');
        if (barHide2) barHide2.classList.add('hidden');
        return;
      }
      try {
        var raw = localStorage.getItem('gollah_onboard_v1') || sessionStorage.getItem('gollah_onboard_v1');
        if (raw) {
          var o = JSON.parse(raw);
          if (o && (o.step === 'pending_username_avatar' || o.step === 'pending_welcome_get_started')) {
            const barHide3 = document.getElementById('email-verify-bar');
            if (barHide3) barHide3.classList.add('hidden');
            return;
          }
        }
      } catch (eSt) {}
    } catch (eOnb) {}
    const bar = document.getElementById('email-verify-bar');
    if (bar) bar.classList.remove('hidden');
    // Visible again — cancel pending re-show so we don't double-fire
    clearEmailBarReshowTimer();
  }

  function refreshEmailVerifyBarAfterOnboarding() {
    try {
      window.__gollahOnboardingActive = false;
      // Re-run the same evaluation path used after login
      if (typeof evaluateEmailVerifyBar === 'function') {
        evaluateEmailVerifyBar();
        return;
      }
      if (typeof updateEmailVerifyBar === 'function') {
        updateEmailVerifyBar();
        return;
      }
      // Fallback: if profile not verified, show bar once onboarding is done
      var u = (typeof currentUser !== 'undefined') ? currentUser : null;
      var verified = u && (u.is_email_verified === true || u.is_email_verified === 'true' || u.is_email_verified === 1);
      if (!verified && u) showEmailVerifyBar();
    } catch (e) {}
  }
  function hideEmailVerifyBar() {
    const bar = document.getElementById('email-verify-bar');
    if (bar) bar.classList.add('hidden');
  }

  async function fetchProfileEmailVerified(userId) {
    const client = getSupabaseClient();
    if (!userId || !client) return null;
    try {
      const { data, error } = await client.from('profiles').select('is_email_verified').eq('id', userId).maybeSingle();
      if (error) return null;
      if (!data) return false;
      return data.is_email_verified === true || data.is_email_verified === 'true' || data.is_email_verified === 1;
    } catch (e) {
      return null;
    }
  }

  async function markEmailVerifiedInProfile(userId, opts) {
    opts = opts || {};
    const client = getSupabaseClient();
    if (!userId || !client) return false;
    try {
      const { error } = await client.from('profiles').update({ is_email_verified: true }).eq('id', userId);
      if (error) {
        // Fallback upsert if row missing columns partially
        try {
          await client.from('profiles').upsert({ id: userId, is_email_verified: true });
        } catch (e2) {
          return false;
        }
      }
      profileEmailVerified = true;
      profileVerifiedUserId = userId;
      try {
        if (typeof currentUser !== 'undefined' && currentUser && currentUser.id === userId) {
          currentUser.is_email_verified = true;
        }
      } catch (e3) {}
      clearEmailBarReshowTimer();
      hideEmailVerifyBar();
      if (opts.showToast) {
        try {
          const key = EMAIL_VERIFIED_TOAST_KEY + '_' + userId;
          if (!localStorage.getItem(key)) {
            localStorage.setItem(key, '1');
            showVerifiedToast();
          } else if (opts.forceToast) {
            showVerifiedToast();
          }
        } catch (e4) {
          showVerifiedToast();
        }
      }
      updateEmailVerificationUI();
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Ensure Google/OAuth users are auto-marked verified in profiles */
  async function ensureOAuthEmailVerified(user) {
    if (!user || !user.id) return;
    if (!isOAuthVerifiedUser(user)) return;
    if (profileEmailVerified === true && profileVerifiedUserId === user.id) return;
    const current = await fetchProfileEmailVerified(user.id);
    if (current === true) {
      profileEmailVerified = true;
      profileVerifiedUserId = user.id;
      return;
    }
    await markEmailVerifiedInProfile(user.id, { showToast: false });
  }

  async function syncProfileEmailVerifiedState(user) {
    if (!user || !user.id) {
      profileEmailVerified = null;
      profileVerifiedUserId = null;
      return;
    }
    // OAuth → always verified
    if (isOAuthVerifiedUser(user)) {
      await ensureOAuthEmailVerified(user);
      return;
    }
    const flag = await fetchProfileEmailVerified(user.id);
    if (flag === null) return;
    profileEmailVerified = flag;
    profileVerifiedUserId = user.id;
    try {
      if (typeof currentUser !== 'undefined' && currentUser && currentUser.id === user.id) {
        currentUser.is_email_verified = flag;
      }
    } catch (e) {}
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
        try {
          const key = EMAIL_VERIFIED_TOAST_KEY + '_' + user.id;
          if (lastKnownVerified === false && !localStorage.getItem(key)) {
            localStorage.setItem(key, '1');
            showVerifiedToast();
          }
        } catch (e) {}
        lastKnownVerified = true;
        return;
      }
      lastKnownVerified = false;
      // Unverified: show bar unless soft-dismissed (timer will re-show after 40s)
      const bar = document.getElementById('email-verify-bar');
      const currentlyHidden = bar && bar.classList.contains('hidden');
      if (!currentlyHidden || !emailBarReshowTimer) {
        // Show immediately when first detected unverified, or when not in a dismiss wait
        if (!emailBarReshowTimer) showEmailVerifyBar();
      }
      // Restore persistent Resend cooldown UI after bar is visible
      restoreResendCooldownUI();
    } catch (e) {}
  }

  function resendCooldownStorageKey(emailOrId) {
    const k = String(emailOrId || 'anon').toLowerCase().replace(/[^a-z0-9@._-]/g, '');
    return RESEND_COOLDOWN_LS_KEY + '_' + k;
  }

  function persistResendCooldown(untilTs, emailOrId) {
    resendCooldownUntil = untilTs;
    try {
      const key = resendCooldownStorageKey(emailOrId || (getAuthUser() && getAuthUser().id) || 'anon');
      localStorage.setItem(key, String(untilTs));
      // Also store a generic key for quick restore before user id is known
      localStorage.setItem(RESEND_COOLDOWN_LS_KEY, String(untilTs));
    } catch (e) {}
  }

  function loadResendCooldownFromStorage() {
    let until = 0;
    try {
      const user = getAuthUser();
      const keys = [RESEND_COOLDOWN_LS_KEY];
      if (user && user.id) keys.push(resendCooldownStorageKey(user.id));
      if (user && user.email) keys.push(resendCooldownStorageKey(user.email));
      for (let i = 0; i < keys.length; i++) {
        const raw = localStorage.getItem(keys[i]);
        const n = parseInt(raw, 10);
        if (n && n > until) until = n;
      }
    } catch (e) {}
    if (until > Date.now()) {
      resendCooldownUntil = until;
    } else {
      resendCooldownUntil = 0;
    }
    return resendCooldownUntil;
  }

  function startResendCountdown(btn) {
    btn = btn || document.getElementById('email-verify-resend-btn');
    if (!btn) return;
    if (resendCountdownTimer) {
      clearTimeout(resendCountdownTimer);
      resendCountdownTimer = null;
    }
    const tick = function () {
      loadResendCooldownFromStorage();
      const left = Math.ceil((resendCooldownUntil - Date.now()) / 1000);
      if (left <= 0) {
        resendCooldownUntil = 0;
        btn.disabled = false;
        btn.textContent = 'Resend';
        resendCountdownTimer = null;
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Resend (' + left + 's)';
      resendCountdownTimer = setTimeout(tick, 1000);
    };
    tick();
  }

  function restoreResendCooldownUI() {
    loadResendCooldownFromStorage();
    if (resendCooldownUntil > Date.now()) {
      startResendCountdown(document.getElementById('email-verify-resend-btn'));
    }
  }

  async function resolveActiveUserEmail() {
    let userEmail = '';
    const client = getSupabaseClient();
    if (client && client.auth) {
      try {
        const { data: userData, error: userErr } = await client.auth.getUser();
        if (!userErr && userData && userData.user && userData.user.email) {
          userEmail = String(userData.user.email).trim();
        }
      } catch (eGetUser) {}
      if (!userEmail) {
        try {
          const { data: sessData } = await client.auth.getSession();
          if (sessData && sessData.session && sessData.session.user && sessData.session.user.email) {
            userEmail = String(sessData.session.user.email).trim();
          }
        } catch (eGetSess) {}
      }
    }
    if (!userEmail) {
      const cached = getAuthUser();
      if (cached && cached.email) userEmail = String(cached.email).trim();
    }
    return userEmail;
  }

  /**
   * Send verification email via Magic Link OTP.
   * Works when Supabase "Confirm email" is OFF (auth.resend signup does not send then).
   */
  async function sendVerificationOtpEmail(options) {
    options = options || {};
    const silent = !!options.silent;
    const btn = document.getElementById('email-verify-resend-btn');
    // User-initiated Resend also primes audio unlock for this tab
    if (!silent) {
      try { primeVerifySoundFromUserGesture(); } catch (ePrime) {}
    }

    loadResendCooldownFromStorage();
    if (Date.now() < resendCooldownUntil) {
      const secs = Math.ceil((resendCooldownUntil - Date.now()) / 1000);
      if (!silent) showSecurityWarning('Please wait', 'You can resend in ' + secs + 's.');
      startResendCountdown(btn);
      return { ok: false, error: 'cooldown' };
    }
    const client = getSupabaseClient();
    if (!client || !client.auth) {
      if (!silent) showSecurityWarning('Resend failed', 'Supabase client is not ready. Please refresh the page and try again.');
      return { ok: false, error: 'no_client' };
    }

    if (btn && !silent) { btn.disabled = true; btn.textContent = 'Sending…'; }

    try {
      const userEmail = await resolveActiveUserEmail();
      if (!userEmail) {
        if (!silent) {
          showSecurityWarning('Resend failed', 'No active user email found. Please log in again.');
          if (btn) { btn.disabled = false; btn.textContent = 'Resend'; }
        }
        return { ok: false, error: 'no_email' };
      }

      const redirectTo = window.location.origin + '/?email_verified=1';
      const { error } = await client.auth.signInWithOtp({
        email: userEmail,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: redirectTo
        }
      });

      if (error) {
        if (!silent) {
          showSecurityWarning('Resend failed', error.message || 'Could not send verification email.');
        }
        const msg = String(error.message || '').toLowerCase();
        if (msg.indexOf('rate') !== -1 || msg.indexOf('seconds') !== -1 || msg.indexOf('60') !== -1) {
          persistResendCooldown(Date.now() + RESEND_COOLDOWN_MS, userEmail);
          startResendCountdown(btn);
        } else if (btn && !silent) {
          btn.disabled = false;
          btn.textContent = 'Resend';
        }
        return { ok: false, error: error.message || 'send_failed' };
      }

      persistResendCooldown(Date.now() + RESEND_COOLDOWN_MS, userEmail);
      if (!silent) {
        showSecurityWarning('Verification link sent!', 'Check your inbox (and spam folder) for the verification link.');
      }
      startResendCountdown(btn);
      return { ok: true };
    } catch (e) {
      if (!silent) {
        showSecurityWarning('Resend failed', (e && e.message) || 'Could not send verification email.');
        if (btn) { btn.disabled = false; btn.textContent = 'Resend'; }
      }
      return { ok: false, error: (e && e.message) || 'exception' };
    }
  }

  async function resendVerificationEmail() {
    return sendVerificationOtpEmail({ silent: false });
  }

  /** Called after email/password signup to auto-send verification link */
  async function sendVerificationAfterSignup() {
    try {
      // Small delay so session/profile settle
      await new Promise(function (r) { setTimeout(r, 600); });
      return await sendVerificationOtpEmail({ silent: true });
    } catch (e) {
      return { ok: false };
    }
  }

  function parseAuthUrlErrors() {
    // Supabase expired/invalid links: #error=access_denied&error_code=otp_expired&...
    var result = { hasError: false, code: '', description: '' };
    try {
      var hash = String(window.location.hash || '').replace(/^#/, '');
      var search = String(window.location.search || '').replace(/^\?/, '');
      var combined = [];
      if (hash) combined.push(hash);
      if (search) combined.push(search);
      // Also support error params embedded after another hash segment
      for (var i = 0; i < combined.length; i++) {
        var part = combined[i];
        try {
          var params = new URLSearchParams(part);
          var err = params.get('error') || params.get('error_code') || params.get('error_description');
          if (err) {
            result.hasError = true;
            result.code = params.get('error_code') || params.get('error') || '';
            result.description = params.get('error_description') || params.get('error') || '';
            return result;
          }
        } catch (eParse) {}
        // Fallback string scan
        if (/error=/i.test(part) || /error_code=/i.test(part) || /otp_expired/i.test(part) || /access_denied/i.test(part)) {
          result.hasError = true;
          result.code = 'link_error';
          if (/otp_expired/i.test(part)) result.code = 'otp_expired';
          return result;
        }
      }
    } catch (e) {}
    return result;
  }

  function clearAuthCallbackParamsFromUrl() {
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete('email_verified');
      // Strip auth error / token fragments from hash
      var hash = String(url.hash || '').replace(/^#/, '');
      if (hash && (/error=/i.test(hash) || /error_code=/i.test(hash) || /access_token=/i.test(hash) || /email_verified=/i.test(hash))) {
        url.hash = '';
      }
      var clean = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '');
      window.history.replaceState({}, document.title, clean);
    } catch (e) {}
  }

  function showVerifyLinkErrorToast(message, opts) {
    opts = opts || {};
    ensureSecurityModalStyles();
    var toast = document.getElementById('gollah-verify-error-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'gollah-verify-error-toast';
      toast.setAttribute('role', 'alert');
      document.body.appendChild(toast);
      // Inject minimal styles once
      if (!document.getElementById('gollah-verify-error-toast-style')) {
        var st = document.createElement('style');
        st.id = 'gollah-verify-error-toast-style';
        st.textContent =
          '#gollah-verify-error-toast{position:fixed;bottom:84px;left:24px;z-index:99999;display:none;align-items:center;gap:10px;' +
          'background:#ED1E4C;color:#fff;font-weight:800;font-size:13px;padding:12px 20px;border-radius:12px;' +
          'box-shadow:0 8px 28px rgba(237,30,76,0.4);max-width:calc(100vw - 32px);}' +
          '#gollah-verify-error-toast.show{display:inline-flex;animation:toastSlideIn .28s ease;}' +
          '#gollah-verify-error-toast .gvt-icon{display:inline-flex;width:18px;height:18px;flex-shrink:0;}' +
          '#gollah-verify-error-toast .gvt-icon svg{width:18px;height:18px;stroke:#fff;fill:none;}';
        document.head.appendChild(st);
      }
    }
    toast.innerHTML =
      '<span class="gvt-icon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="12" cy="12" r="10"/><path d="M12 8v5"/><path d="M12 16h.01"/>' +
        '</svg>' +
      '</span>' +
      '<span>' + (message || 'Email Not Verified') + '</span>';
    toast.classList.add('show');
    playVerifyTockSound({ allowColdFallback: !!opts.allowColdFallback });
    setTimeout(function () { toast.classList.remove('show'); }, 5000);
  }

  function clearEmailVerifiedQueryParam() {
    clearAuthCallbackParamsFromUrl();
  }

  async function handleEmailVerifiedCallback() {
    try {
      // 1) CRITICAL: URL errors first — even if profile already says verified
      // Expired/old links always show red "Email Not Verified" toast + sound right in this tab
      var urlErr = parseAuthUrlErrors();
      if (urlErr.hasError) {
        clearAuthCallbackParamsFromUrl();
        showVerifyLinkErrorToast('Email Not Verified', { durationMs: 5000 });
        try {
          var uErr = getAuthUser();
          if (uErr && uErr.id && !isEmailVerified(uErr)) {
            try { localStorage.removeItem(EMAIL_BAR_DISMISS_KEY); } catch (eRm) {}
            showEmailVerifyBar();
          }
        } catch (eU) {}
        restoreResendCooldownUI();
        return;
      }

      const client = getSupabaseClient();
      if (!client || !client.auth) return;

      var flagged = false;
      try {
        var params = new URLSearchParams(window.location.search || '');
        if (params.get('email_verified') === '1') flagged = true;
      } catch (e) {}

      // Magic-link success also arrives as session without error hash
      const { data } = await client.auth.getUser();
      const user = data && data.user ? data.user : null;
      if (!user) return;

      // OAuth → auto-verify (not magic-link dependent)
      if (isOAuthVerifiedUser(user)) {
        await ensureOAuthEmailVerified(user);
        updateEmailVerificationUI();
        return;
      }

      // Only mark verified on explicit success flag AND no URL error
      if (flagged) {
        const ok = await markEmailVerifiedInProfile(user.id, { showToast: true, forceToast: true });
        if (ok) clearAuthCallbackParamsFromUrl();
        return;
      }

      await syncProfileEmailVerifiedState(user);
      updateEmailVerificationUI();
      restoreResendCooldownUI();
    } catch (e) {}
  }

  function bindEmailBarButtons() {
    const resend = document.getElementById('email-verify-resend-btn');
    const closeBtn = document.getElementById('email-verify-close-btn');
    if (resend && !resend.dataset.bound) {
      resend.dataset.bound = '1';
      resend.addEventListener('click', function (e) {
        e.preventDefault();
        try { primeVerifySoundFromUserGesture(); } catch (ePrime) {}
        resendVerificationEmail();
      });
    }
    if (closeBtn && !closeBtn.dataset.bound) {
      closeBtn.dataset.bound = '1';
      closeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        // Soft dismiss: hide now, auto re-show after 40s until email is verified
        hideEmailVerifyBar();
        try {
          const user = getAuthUser();
          if (user && !isEmailVerified(user)) scheduleEmailBarReshow();
        } catch (e2) {
          scheduleEmailBarReshow();
        }
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
      // Force bar visible even if previously dismissed
      clearEmailBarReshowTimer();
      showEmailVerifyBar();
    } catch (err) {}
  }

  async function refreshAuthUserFromSession() {
    try {
      const client = getSupabaseClient();
      if (!client || !client.auth) return;
      const { data } = await client.auth.getUser();
      if (data && data.user) {
        try {
          if (typeof currentUser !== 'undefined' && currentUser && currentUser.id === data.user.id) {
            currentUser.email_confirmed_at = data.user.email_confirmed_at;
            currentUser.confirmed_at = data.user.confirmed_at;
          }
        } catch (e) {}
        await syncProfileEmailVerifiedState(data.user);
        updateEmailVerificationUI();
      }
    } catch (e) {}
  }

  function startEmailVerificationWatch() {
    preloadVerifySound();
    loadResendCooldownFromStorage();
    bindEmailBarButtons();
    handleEmailVerifiedCallback();
    updateEmailVerificationUI();
    restoreResendCooldownUI();
    if (emailWatchTimer) clearInterval(emailWatchTimer);
    emailWatchTimer = setInterval(function () {
      refreshAuthUserFromSession();
      updateEmailVerificationUI();
    }, 8000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        refreshAuthUserFromSession();
        handleEmailVerifiedCallback();
      }
    });
    window.addEventListener('focus', function () {
      refreshAuthUserFromSession();
      handleEmailVerifiedCallback();
    });
    // Magic-link / OTP sign-in lands here — mark profile verified when ?email_verified=1
    try {
      const _authClient = getSupabaseClient();
      if (_authClient && _authClient.auth && typeof _authClient.auth.onAuthStateChange === 'function') {
        _authClient.auth.onAuthStateChange(function (event, session) {
          try {
            if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
              const u = session && session.user ? session.user : null;
              if (u) {
                handleEmailVerifiedCallback();
                syncProfileEmailVerifiedState(u).then(function () {
                  updateEmailVerificationUI();
                }).catch(function () {});
              }
            }
            if (event === 'SIGNED_OUT') {
              profileEmailVerified = null;
              profileVerifiedUserId = null;
              lastKnownVerified = null;
              hideEmailVerifyBar();
            }
          } catch (eAuth) {}
        });
      }
    } catch (eListen) {}
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
      preloadVerifySound();
      loadResendCooldownFromStorage();
      handleEmailVerifiedCallback();
      updateEmailVerificationUI();
      restoreResendCooldownUI();
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
      isEmailVerified: isEmailVerified,
      updateEmailVerificationUI: updateEmailVerificationUI,
      isEmailVerified: function () { return isEmailVerified(getAuthUser()); },
      sendVerificationAfterSignup: sendVerificationAfterSignup,
      sendVerificationOtpEmail: sendVerificationOtpEmail,
      markEmailVerifiedInProfile: markEmailVerifiedInProfile,
      syncProfileEmailVerifiedState: syncProfileEmailVerifiedState,
      handleEmailVerifiedCallback: handleEmailVerifiedCallback
    };
    // Also expose helpers for auth.js / ui-core.js without namespace
    window.sendVerificationAfterSignup = sendVerificationAfterSignup;
    window.syncProfileEmailVerifiedState = syncProfileEmailVerifiedState;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSecurityModule);
  } else {
    initSecurityModule();
  }
})();

try {
  if (window.GollahSecurity) {
    window.GollahSecurity.refreshEmailVerifyBarAfterOnboarding = refreshEmailVerifyBarAfterOnboarding;
    window.GollahSecurity.hideEmailVerifyBar = hideEmailVerifyBar;
    window.GollahSecurity.showEmailVerifyBar = showEmailVerifyBar;
  }
} catch (eExpSec) {}
