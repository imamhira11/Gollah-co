/**
 * Gollah master postback processor
 * 1,000 coins = $1.00
 * Offer completions -> postbacks + user_notifications + live_activity (bottom feed only).
 * Top ticker remains withdrawals-only.
 *
 * SECURITY: Fail-closed secret enforcement (POSTBACK_MASTER_SECRET and/or POSTBACK_SECRET_<PROVIDER>).
 * GUARD: Reject placeholder / non-UUID user_id before any Postgres uuid column touch (avoids 22P02).
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const COINS_PER_USD = 1000;

/** Standard UUID v1–v5 (and common variant bits). Case-insensitive. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getServiceDb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Safe number parse. Treats placeholders ({payout}, {status}, empty, NaN) as fallback.
 */
function toNum(v, fallback) {
  if (v == null || v === '') return fallback;
  const s = String(v).trim();
  // Network template leftovers: {user_id}, {payout}, {{amount}}, etc.
  if (!s || s.indexOf('{') !== -1 || s.indexOf('}') !== -1) return fallback;
  if (/^(nan|undefined|null|true|false)$/i.test(s)) return fallback;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function str(v, max) {
  if (v == null) return '';
  return String(v).trim().slice(0, max || 500);
}

/**
 * True only for a real UUID usable in profiles.id / postbacks.user_id columns.
 * Rejects empty, {user_id}, macros, short ids, and anything with braces.
 */
function isValidUuid(value) {
  const s = str(value, 80);
  if (!s) return false;
  if (s.indexOf('{') !== -1 || s.indexOf('}') !== -1) return false;
  if (s.indexOf('%') !== -1) return false; // unexpanded %7Buser_id%7D style
  return UUID_RE.test(s);
}

function normalizeProvider(p) {
  const s = str(p, 80).toLowerCase().replace(/[\s_-]+/g, '');
  const map = {
    ovnix: 'Ovnix',
    adlexy: 'Adlexy',
    rewardtym: 'RewardTym',
    vortexwall: 'VortexWall',
    vortex: 'VortexWall',
    gemiad: 'GemiAd',
    gemi: 'GemiAd',
    upwall: 'Upwall',
    clickwall: 'Clickwall',
    revtoo: 'Revtoo',
    taskwall: 'Taskwall',
    task: 'Taskwall'
  };
  if (map[s]) return map[s];
  if (!p) return 'Unknown';
  return String(p).charAt(0).toUpperCase() + String(p).slice(1);
}

/** Constant-time string compare (length-safe). */
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

/**
 * Fail-closed auth.
 * Required secret = POSTBACK_SECRET_<PROVIDER> if set, else POSTBACK_MASTER_SECRET.
 */
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

/**
 * Unified parse for all networks (GET query + POST body merged by caller).
 * Placeholder macros in payout/status/user_id are neutralized here so they
 * never become NaN or reach a uuid column.
 */
function parseProviderPayload(providerKey, q) {
  const provider = normalizeProvider(providerKey || q.provider || q.network || q.source);
  let userId = str(
    q.user_id || q.userId || q.userid || q.uid || q.subid || q.sub_id || q.sub1 ||
    q.player_id || q.playerId || q.external_user_id || q.sid,
    80
  );
  // Neutralize obvious template leftovers early (still validated again in processPostbackEvent)
  if (userId.indexOf('{') !== -1 || userId.indexOf('}') !== -1 || userId.indexOf('%7B') !== -1) {
    userId = '';
  }

  let transId = str(
    q.trans_id || q.transid || q.transaction_id || q.txid || q.tx_id ||
    q.event_id || q.conversion_id || q.oid,
    160
  );
  // Drop placeholder trans ids so they don't pollute dedupe keys
  if (transId.indexOf('{') !== -1 || transId.indexOf('}') !== -1) {
    transId = '';
  }

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

  const datePart = str(q.date || q.datetime || q.timestamp || '', 40);

  if (!transId) {
    const parts = [provider, userId, offerId || '', datePart || '', str(q.payout || q.user_amount || q.amount || '', 40)];
    if (parts.filter(Boolean).length >= 2) {
      transId = 'fb_' + parts.join('|').slice(0, 150);
    }
  }

  // Safe numeric extraction — placeholders become NaN then 0
  let coins = toNum(q.coins_awarded ?? q.coins ?? q.reward ?? q.points ?? q.user_amount ?? q.virtual_currency, NaN);
  let payoutUsd = toNum(q.payout_usd ?? q.payout ?? q.amount ?? q.revenue ?? q.reward_usd ?? q.price, NaN);
  if (!Number.isFinite(coins) && Number.isFinite(payoutUsd)) coins = Math.round(payoutUsd * COINS_PER_USD);
  if (!Number.isFinite(payoutUsd) && Number.isFinite(coins)) payoutUsd = coins / COINS_PER_USD;
  if (!Number.isFinite(coins)) coins = 0;
  if (!Number.isFinite(payoutUsd)) payoutUsd = coins / COINS_PER_USD;

  const statusRaw = str(q.status || q.event || q.type || q.action || 'completed').toLowerCase();
  // Placeholder status → treat as completed (non-reversal) so test hits don't chargeback
  const statusClean =
    !statusRaw || statusRaw.indexOf('{') !== -1 || statusRaw.indexOf('}') !== -1
      ? 'completed'
      : statusRaw;

  const payoutProbe = toNum(q.payout, 1);
  const isReversal =
    statusClean.includes('charge') ||
    statusClean.includes('revers') ||
    statusClean.includes('reject') ||
    statusClean === '0' ||
    statusClean === 'failed' ||
    payoutProbe < 0 ||
    coins < 0;

  return {
    provider,
    user_id: userId,
    trans_id: transId || null,
    offer_id: offerId,
    offer_name: offerName,
    payout_usd: Math.abs(Number.isFinite(payoutUsd) ? payoutUsd : 0),
    coins_awarded: Math.abs(Math.floor(Number.isFinite(coins) ? coins : 0)),
    is_reversal: isReversal,
    status: isReversal ? 'reversed' : 'completed',
    raw: q
  };
}

/** @deprecated use assertPostbackSecret — kept for api/postback.js import compatibility */
function verifySharedSecret(q, envName) {
  if (!envName) {
    return assertPostbackSecret('Unknown', q).ok;
  }
  const expected = process.env[envName];
  if (!expected) {
    return false;
  }
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

async function processPostbackEvent(event, opts) {
  const okBody = opts && opts.okBody != null ? opts.okBody : '1';
  const q = (event && event.raw) || {};

  // 0) Fail-closed secret gate
  const auth = assertPostbackSecret(event && event.provider, q);
  if (!auth.ok) {
    return { statusCode: 403, body: auth.body || 'Forbidden', detail: 'unauthorized' };
  }

  // 0b) UUID gate — MUST run before any Postgres touch of user_id columns.
  // Prevents 22P02 on placeholder test hits like user_id={user_id}.
  if (!event.user_id) {
    return { statusCode: 200, body: okBody, detail: 'missing_user_id' };
  }
  if (!isValidUuid(event.user_id)) {
    // Soft-ignore: HTTP 200 so networks don't retry-storm; no console.error (keeps Vercel clean).
    console.info('[postback] ignored invalid_or_placeholder_user_id', String(event.user_id).slice(0, 40));
    return {
      statusCode: 200,
      body: okBody,
      detail: 'invalid_or_placeholder_user_id'
    };
  }

  const db = getServiceDb();

  // 1) Deduplicate before any write
  if (event.trans_id) {
    const { data: existing, error: dedupeErr } = await db
      .from('postbacks')
      .select('id')
      .eq('provider', event.provider)
      .eq('trans_id', event.trans_id)
      .limit(1);

    if (!dedupeErr && existing && existing.length) {
      return { statusCode: 200, body: okBody, detail: 'duplicate' };
    }
  }

  const signedCoins = event.is_reversal ? -Math.abs(event.coins_awarded) : event.coins_awarded;

  // 2) Single clean master log insert
  const { error: pbErr } = await db.from('postbacks').insert({
    user_id: event.user_id,
    provider: event.provider,
    offer_id: event.offer_id,
    offer_name: event.offer_name,
    payout_usd: event.payout_usd,
    coins_awarded: signedCoins,
    trans_id: event.trans_id,
    status: event.status
  });

  if (pbErr) {
    if (pbErr.code === '23505') {
      return { statusCode: 200, body: okBody, detail: 'duplicate' };
    }
    // Still log real DB errors, but 22P02 should no longer appear for bad user_id
    console.error('[postbacks insert]', pbErr);
    return { statusCode: 200, body: okBody, detail: 'postbacks_insert_failed' };
  }

  // Reversal path
  if (event.is_reversal && event.coins_awarded > 0) {
    try {
      const { data: prof } = await db.from('profiles').select('coins').eq('id', event.user_id).maybeSingle();
      const cur = Math.max(0, toNum(prof && prof.coins, 0));
      await db.from('profiles').update({ coins: Math.max(0, cur - Math.abs(event.coins_awarded)) }).eq('id', event.user_id);
      await db.from('user_notifications').insert({
        user_id: event.user_id,
        title: 'Offer reversed',
        message: event.offer_name + ' (' + event.provider + ') reversed -' + Math.abs(event.coins_awarded) + ' coins',
        type: 'offer_reversal'
      });
    } catch (e) {
      console.warn('[reversal]', e && e.message);
    }
    return { statusCode: 200, body: okBody, detail: 'reversed' };
  }

  if (event.coins_awarded <= 0) {
    return { statusCode: 200, body: okBody, detail: 'zero_coins_logged' };
  }

  // 3) Auto-hold
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
        message: event.offer_name + ' · ' + event.coins_awarded + ' coins held' + (holdDays ? ' for ' + holdDays + ' days' : ''),
        type: 'offer_hold'
      });
    } catch (e) {
      console.warn('[notif hold]', e && e.message);
    }
    return { statusCode: 200, body: okBody, detail: 'held' };
  }

  // 4) Instant credit + single notification + bottom live_activity only
  try {
    const { data: prof } = await db.from('profiles').select('coins').eq('id', event.user_id).maybeSingle();
    const cur = Math.max(0, toNum(prof && prof.coins, 0));
    await db.from('profiles').update({ coins: cur + event.coins_awarded }).eq('id', event.user_id);
  } catch (e) {
    console.error('[profiles credit]', e && e.message);
  }

  try {
    await db.from('user_notifications').insert({
      user_id: event.user_id,
      title: 'Offer Completed',
      message: '+' + event.coins_awarded + ' coins from ' + event.provider + (event.offer_name ? ' · ' + event.offer_name : ''),
      type: 'offer_complete'
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

  return { statusCode: 200, body: okBody, detail: 'credited' };
}

module.exports = {
  parseProviderPayload,
  processPostbackEvent,
  verifySharedSecret,
  assertPostbackSecret,
  normalizeProvider,
  isValidUuid,
  COINS_PER_USD
};
