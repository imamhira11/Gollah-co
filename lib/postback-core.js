/**
 * Gollah master postback processor (production)
 * ---------------------------------------------------------------------------
 * UNIFIED RATE (all walls, present + future):
 *   540 user coins = $1.00 publisher revenue
 *   coins_awarded = round(|payout_usd| * 540)
 *   When network only sends a coin amount: payout_usd = coins / 540
 *   Same formula for credits and chargebacks (sign applied after).
 *
 * Offer completions → postbacks + user_notifications (with coins delta)
 *                  + live_activity
 * Chargebacks → signed postbacks row + atomic clawback + reversal notif
 *
 * SECURITY: Fail-closed secret (POSTBACK_MASTER_SECRET / POSTBACK_SECRET_*).
 * GUARD: Reject non-UUID / placeholder user_id before any Postgres uuid touch.
 * IDEMPOTENCY: provider + trans_id unique; stable collision-safe fallback
 *              when trans_id is empty (same offer replay = duplicate).
 * BALANCE: Atomic RPC apply_coin_delta (falls back to guarded RMW).
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

/** Fixed user coins per $1.00 revenue — applies to EVERY wall. */
const USER_COINS_PER_USD = 540;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getServiceDb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function toNum(v, fallback) {
  if (v == null || v === '') return fallback;
  const s = String(v).trim();
  if (!s || s.indexOf('{') !== -1 || s.indexOf('}') !== -1) return fallback;
  if (/^(nan|undefined|null|true|false)$/i.test(s)) return fallback;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function str(v, max) {
  if (v == null) return '';
  return String(v).trim().slice(0, max || 500);
}

function isValidUuid(value) {
  const s = str(value, 80);
  if (!s) return false;
  if (s.indexOf('{') !== -1 || s.indexOf('}') !== -1) return false;
  if (s.indexOf('%') !== -1) return false;
  return UUID_RE.test(s);
}

function normalizeProvider(p) {
  const s = str(p, 80).toLowerCase().replace(/[\s_-]+/g, '');
  const map = {
    ovnix: 'Ovnix',
    adlexy: 'Adlexy',
    adlaxy: 'Adlexy',
    rewardtym: 'RewardTym',
    vortexwall: 'VortexWall',
    vortex: 'VortexWall',
    gemiad: 'GemiAd',
    gemi: 'GemiAd',
    upwall: 'Upwall',
    clickwall: 'Clickwall',
    click: 'Clickwall',
    revtoo: 'Revtoo',
    taskwall: 'Taskwall',
    task: 'Taskwall',
    theoremreach: 'TheoremReach',
    theorem: 'TheoremReach',
    cpx: 'CPX Research',
    cpxresearch: 'CPX Research',
    lootably: 'Lootably',
    adgate: 'Adgate',
    offertoro: 'OfferToro',
    torox: 'Torox',
    bitlabs: 'BitLabs',
    monlix: 'Monlix',
    offery: 'Offery'
  };
  if (map[s]) return map[s];
  if (!p) return 'Unknown';
  return String(p).charAt(0).toUpperCase() + String(p).slice(1);
}

function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) {
    const dummy = Buffer.alloc(aa.length);
    try {
      crypto.timingSafeEqual(aa, dummy);
    } catch (_) {}
    return false;
  }
  return crypto.timingSafeEqual(aa, bb);
}

function assertPostbackSecret(provider, q) {
  const provKey = str(provider || 'Unknown')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const perWall = process.env['POSTBACK_SECRET_' + provKey] || '';
  const master = process.env.POSTBACK_MASTER_SECRET || '';
  const required = perWall || master;

  if (!required) {
    console.warn('[postback] REJECT: no secret configured (set POSTBACK_MASTER_SECRET)');
    return { ok: false, statusCode: 403, body: 'Forbidden' };
  }

  const got = str(
    (q && (q.secret || q.password || q.key || q.token || q.pass || q.api_key)) || '',
    500
  );
  if (!got || !timingSafeEqualStr(got, required)) {
    console.warn('[postback] REJECT: invalid or missing secret for', provider);
    return { ok: false, statusCode: 403, body: 'Forbidden' };
  }
  return { ok: true };
}

function looksLikeUsd(n) {
  if (!Number.isFinite(n)) return false;
  const abs = Math.abs(n);
  if (abs > 0 && abs < 50 && (String(n).includes('.') || abs < 20)) return true;
  if (abs > 0 && abs <= 5) return true;
  return false;
}

function looksLikeCoins(n) {
  if (!Number.isFinite(n)) return false;
  const abs = Math.abs(n);
  if (abs >= 10 && Math.abs(abs - Math.round(abs)) < 0.001) return true;
  if (abs >= 50) return true;
  return false;
}

/**
 * Stable fallback trans_id (no time bucket).
 * Same provider+user+offer+coins always maps to the same key → replays dedupe.
 */
function buildFallbackTransId(provider, userId, offerId, offerName, coinsSigned) {
  const raw = [
    str(provider, 40),
    str(userId, 80),
    str(offerId, 80) || '-',
    str(offerName, 80) || '-',
    String(coinsSigned)
  ].join('|');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return 'fb_' + hash;
}

function isDummyTransId(tid) {
  const s = str(tid, 160).toLowerCase();
  if (!s) return true;
  if (s.indexOf('{') !== -1 || s.indexOf('}') !== -1) return true;
  if (/^(null|undefined|none|n\/a|na|test|dummy|0|-)$/i.test(s)) return true;
  return false;
}

/**
 * UNIFIED money normalization — one rule for every wall.
 *
 * Priority:
 *  1. Explicit USD fields → payout_usd, coins = round(usd * 540)
 *  2. Explicit coin fields only → coins kept, payout_usd = coins / 540
 *  3. Ambiguous amount/reward classified by magnitude, then same rules
 *  4. Contamination (usd ≈ coins integer) → treat as coins, re-derive usd
 */
function normalizeMoneyFields(q) {
  const explicitCoins = toNum(
    q.coins_awarded ?? q.coins ?? q.points ?? q.virtual_currency ?? q.user_amount ?? q.vc,
    NaN
  );
  const explicitUsd = toNum(
    q.payout_usd ?? q.revenue ?? q.reward_usd ?? q.price ?? q.payout,
    NaN
  );
  const ambiguous = toNum(q.amount ?? q.reward, NaN);

  let coinsIn = Number.isFinite(explicitCoins) ? explicitCoins : NaN;
  let usdIn = Number.isFinite(explicitUsd) ? explicitUsd : NaN;

  if (!Number.isFinite(coinsIn) && Number.isFinite(ambiguous)) {
    if (looksLikeCoins(ambiguous) && !looksLikeUsd(ambiguous)) {
      coinsIn = ambiguous;
    } else if (looksLikeUsd(ambiguous)) {
      usdIn = Number.isFinite(usdIn) ? usdIn : ambiguous;
    } else {
      coinsIn = ambiguous;
    }
  } else if (!Number.isFinite(usdIn) && Number.isFinite(ambiguous) && looksLikeUsd(ambiguous)) {
    usdIn = ambiguous;
  }

  // Contamination: network put coin integer into payout field
  if (
    Number.isFinite(coinsIn) &&
    Number.isFinite(usdIn) &&
    Math.abs(coinsIn) >= 10 &&
    Math.abs(usdIn - coinsIn) < 0.5
  ) {
    usdIn = NaN;
  }

  let coins;
  let payoutUsd;

  if (Number.isFinite(usdIn)) {
    // USD is authoritative → unified 540 coins per $1
    payoutUsd = usdIn;
    coins = Math.round(Math.abs(usdIn) * USER_COINS_PER_USD);
    if (usdIn < 0) coins = -coins;
  } else if (Number.isFinite(coinsIn)) {
    // Coins only → derive USD so ratio matches unified rate
    coins = coinsIn;
    payoutUsd = coinsIn / USER_COINS_PER_USD;
  } else {
    coins = 0;
    payoutUsd = 0;
  }

  return { coins, payoutUsd };
}

function parseProviderPayload(providerKey, q) {
  const provider = normalizeProvider(providerKey || q.provider || q.network || q.source);
  let userId = str(
    q.user_id || q.userId || q.userid || q.uid || q.subid || q.sub_id || q.sub1 ||
    q.player_id || q.playerId || q.external_user_id || q.sid,
    80
  );
  if (userId.indexOf('{') !== -1 || userId.indexOf('}') !== -1 || userId.indexOf('%7B') !== -1) {
    userId = '';
  }

  let transId = str(
    q.trans_id || q.transid || q.transaction_id || q.txid || q.tx_id ||
    q.event_id || q.conversion_id || q.oid,
    160
  );
  if (isDummyTransId(transId)) transId = '';

  const offerId = (() => {
    const v = q.offer_id || q.offerid || q.offerId || q.campaign_id || q.campid || q.ad_id || q.goal_id;
    if (v == null || String(v) === '') return null;
    const s = str(v, 120);
    if (s.indexOf('{') !== -1 || s.indexOf('}') !== -1) return null;
    return s;
  })();

  let offerName = str(
    q.offer_name || q.offername || q.offerName || q.campaign_name || q.offer || q.goal_name || q.ad_name,
    200
  ) || 'Offer Completed';
  if (offerName.indexOf('{') !== -1 || offerName.indexOf('}') !== -1) {
    offerName = 'Offer Completed';
  }

  const { coins, payoutUsd } = normalizeMoneyFields(q);

  const statusRaw = str(q.status || q.event || q.type || q.action || 'completed').toLowerCase();
  const statusClean =
    !statusRaw || statusRaw.indexOf('{') !== -1 || statusRaw.indexOf('}') !== -1
      ? 'completed'
      : statusRaw;

  const isReversal =
    statusClean.includes('charge') ||
    statusClean.includes('revers') ||
    statusClean.includes('reject') ||
    statusClean === '0' ||
    statusClean === '2' ||
    statusClean === 'failed' ||
    statusClean === 'denied' ||
    statusClean === 'chargeback' ||
    payoutUsd < 0 ||
    coins < 0;

  const coinsAbs = Math.abs(Math.floor(coins));
  const payoutAbs = Math.abs(payoutUsd);

  // Stable fallback — no time component so identical replays collide
  if (!transId) {
    transId = buildFallbackTransId(
      provider,
      userId,
      offerId,
      offerName,
      isReversal ? -coinsAbs : coinsAbs
    );
  }

  return {
    provider,
    user_id: userId,
    trans_id: transId,
    offer_id: offerId,
    offer_name: offerName,
    payout_usd: payoutAbs,
    coins_awarded: coinsAbs,
    is_reversal: isReversal,
    status: isReversal ? 'reversed' : 'completed',
    raw: q
  };
}

function verifySharedSecret(q, envName) {
  if (!envName) {
    return assertPostbackSecret('Unknown', q).ok;
  }
  const expected = process.env[envName];
  if (!expected) return false;
  const got = q.secret || q.key || q.token || q.password || q.pass || q.api_key || q.hash;
  return timingSafeEqualStr(got, expected);
}

async function matchesAutoHold(db, event) {
  const { data: rules, error } = await db
    .from('auto_hold_rules')
    .select('id, provider, offer_id, offer_name_keyword, hold_days, reason, is_active')
    .eq('is_active', true);
  if (error || !rules || !rules.length) return null;

  const prov = str(event.provider).toLowerCase();
  const oid = str(event.offer_id).toLowerCase();
  const oname = str(event.offer_name).toLowerCase();

  for (const r of rules) {
    const rp = str(r.provider || 'ALL').toLowerCase();
    if (rp !== 'all' && rp !== prov) continue;
    let matched = false;
    if (r.offer_id && oid && str(r.offer_id).toLowerCase() === oid) matched = true;
    if (r.offer_name_keyword && oname.includes(str(r.offer_name_keyword).toLowerCase())) matched = true;
    if (!r.offer_id && !r.offer_name_keyword) matched = true;
    if (matched) return r;
  }
  return null;
}

async function applyCoinDelta(db, userId, delta) {
  const d = Math.floor(Number(delta) || 0);
  if (!d) return { ok: true, coins: null, method: 'noop' };

  try {
    const { data, error } = await db.rpc('apply_coin_delta', {
      p_user_id: userId,
      p_delta: d
    });
    if (!error) {
      const newCoins = Array.isArray(data) ? (data[0] && data[0].coins) : (data && data.coins);
      return { ok: true, coins: newCoins != null ? Number(newCoins) : null, method: 'rpc' };
    }
    if (error.code !== 'PGRST202' && error.code !== '42883') {
      console.warn('[apply_coin_delta rpc]', error.message || error);
    }
  } catch (e) {
    console.warn('[apply_coin_delta rpc ex]', e && e.message);
  }

  try {
    const { data: prof, error: readErr } = await db
      .from('profiles')
      .select('coins')
      .eq('id', userId)
      .maybeSingle();
    if (readErr) throw readErr;
    const cur = Math.max(0, toNum(prof && prof.coins, 0));
    const next = Math.max(0, cur + d);
    const { error: upErr } = await db.from('profiles').update({ coins: next }).eq('id', userId);
    if (upErr) throw upErr;
    return { ok: true, coins: next, method: 'rmw' };
  } catch (e) {
    console.error('[apply_coin_delta fallback]', e && e.message);
    return { ok: false, coins: null, method: 'failed', error: e };
  }
}

async function processPostbackEvent(event, opts) {
  const okBody = opts && opts.okBody != null ? opts.okBody : '1';
  const q = (event && event.raw) || {};

  const auth = assertPostbackSecret(event && event.provider, q);
  if (!auth.ok) {
    return { statusCode: 403, body: auth.body || 'Forbidden', detail: 'unauthorized' };
  }

  if (!event.user_id) {
    return { statusCode: 200, body: okBody, detail: 'missing_user_id' };
  }
  if (!isValidUuid(event.user_id)) {
    console.info('[postback] ignored invalid_or_placeholder_user_id', String(event.user_id).slice(0, 40));
    return { statusCode: 200, body: okBody, detail: 'invalid_or_placeholder_user_id' };
  }

  const db = getServiceDb();

  // Idempotency: always has trans_id after parse (real or stable fallback)
  if (event.trans_id) {
    const { data: existing, error: dedupeErr } = await db
      .from('postbacks')
      .select('id, status, coins_awarded')
      .eq('provider', event.provider)
      .eq('trans_id', event.trans_id)
      .limit(1);

    if (!dedupeErr && existing && existing.length) {
      return { statusCode: 200, body: okBody, detail: 'duplicate' };
    }
  }

  const signedCoins = event.is_reversal ? -Math.abs(event.coins_awarded) : event.coins_awarded;
  const signedPayout = event.is_reversal ? -Math.abs(event.payout_usd) : event.payout_usd;

  const { error: pbErr } = await db.from('postbacks').insert({
    user_id: event.user_id,
    provider: event.provider,
    offer_id: event.offer_id,
    offer_name: event.offer_name,
    payout_usd: signedPayout,
    coins_awarded: signedCoins,
    trans_id: event.trans_id,
    status: event.status
  });

  if (pbErr) {
    if (pbErr.code === '23505') {
      return { statusCode: 200, body: okBody, detail: 'duplicate' };
    }
    console.error('[postbacks insert]', pbErr);
    return { statusCode: 200, body: okBody, detail: 'postbacks_insert_failed' };
  }

  try {
    await db.from('postback_ledger').insert({
      user_id: event.user_id,
      provider: event.provider,
      trans_id: event.trans_id,
      offer_id: event.offer_id,
      offer_name: event.offer_name,
      coins_delta: signedCoins,
      payout_usd: signedPayout,
      status: event.status,
      direction: event.is_reversal ? 'reversal' : 'credit'
    });
  } catch (_) {}

  // ── REVERSAL ──────────────────────────────────────────────────────────
  if (event.is_reversal && event.coins_awarded > 0) {
    const claw = -Math.abs(event.coins_awarded);
    const bal = await applyCoinDelta(db, event.user_id, claw);
    if (!bal.ok) {
      console.error('[reversal] coin clawback failed', event.user_id, claw);
    }
    try {
      await db.from('user_notifications').insert({
        user_id: event.user_id,
        title: 'Offer reversed',
        message:
          event.offer_name +
          ' (' +
          event.provider +
          ') reversed -' +
          Math.abs(event.coins_awarded) +
          ' coins',
        type: 'offer_reversal',
        coins: claw
      });
    } catch (e) {
      console.warn('[reversal notif]', e && e.message);
    }
    return {
      statusCode: 200,
      body: okBody,
      detail: bal.ok ? 'reversed' : 'reversed_balance_failed'
    };
  }

  if (event.coins_awarded <= 0) {
    return { statusCode: 200, body: okBody, detail: 'zero_coins_logged' };
  }

  // Auto-hold
  let holdRule = null;
  try {
    holdRule = await matchesAutoHold(db, event);
  } catch (e) {
    console.warn('[auto_hold]', e && e.message);
  }

  if (holdRule) {
    const holdDays = Math.max(0, toNum(holdRule.hold_days, 30));
    const releaseAt = holdDays > 0 ? new Date(Date.now() + holdDays * 86400000).toISOString() : null;
    try {
      await db.from('offer_holds').insert({
        user_id: event.user_id,
        provider: event.provider,
        offer_id: event.offer_id,
        offer_name: event.offer_name,
        coins: event.coins_awarded,
        status: 'ON_HOLD',
        hold_days: holdDays,
        release_at: releaseAt,
        reason: holdRule.reason || ('Auto-hold (' + holdDays + 'd)'),
        trans_id: event.trans_id
      });
    } catch (e2) {
      console.error('[offer_holds]', e2 && e2.message);
    }
    try {
      await db.from('user_notifications').insert({
        user_id: event.user_id,
        title: 'Offer On Hold',
        message:
          event.offer_name +
          ' · ' +
          event.coins_awarded +
          ' coins held' +
          (holdDays ? ' for ' + holdDays + ' days' : ''),
        type: 'offer_hold',
        coins: event.coins_awarded
      });
    } catch (e) {
      console.warn('[notif hold]', e && e.message);
    }
    return { statusCode: 200, body: okBody, detail: 'held' };
  }

  // Instant credit
  const credit = await applyCoinDelta(db, event.user_id, event.coins_awarded);
  if (!credit.ok) {
    console.error('[profiles credit] failed', event.user_id, event.coins_awarded);
  }

  try {
    await db.from('user_notifications').insert({
      user_id: event.user_id,
      title: 'Offer Completed',
      message:
        '+' +
        event.coins_awarded +
        ' coins from ' +
        event.provider +
        (event.offer_name ? ' · ' + event.offer_name : ''),
      type: 'offer_complete',
      coins: event.coins_awarded
    });
  } catch (e) {
    console.warn('[user_notifications]', e && e.message);
  }

  try {
    await db.from('live_activity').insert({
      user_id: event.user_id,
      type: 'offer_complete',
      provider: event.provider,
      offer_name: event.offer_name,
      coins: event.coins_awarded,
      message: '+' + event.coins_awarded + ' coins from ' + event.provider
    });
  } catch (e) {
    console.warn('[live_activity]', e && e.message);
  }

  return {
    statusCode: 200,
    body: okBody,
    detail: credit.ok ? 'credited' : 'credited_balance_failed'
  };
}

module.exports = {
  parseProviderPayload,
  processPostbackEvent,
  verifySharedSecret,
  assertPostbackSecret,
  normalizeProvider,
  normalizeMoneyFields,
  isValidUuid,
  buildFallbackTransId,
  USER_COINS_PER_USD,
  COINS_PER_USD: USER_COINS_PER_USD
};
