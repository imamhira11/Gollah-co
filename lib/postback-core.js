/**
 * Gollah master postback processor
 * 1,000 coins = $1.00
 * Offer completions → postbacks + user_notifications + live_activity (bottom feed only).
 * Top ticker remains withdrawals-only.
 *
 * SECURITY: Fail-closed secret enforcement (POSTBACK_MASTER_SECRET and/or POSTBACK_SECRET_<PROVIDER>).
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const COINS_PER_USD = 1000;

function getServiceDb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v, max) {
  if (v == null) return '';
  return String(v).trim().slice(0, max || 500);
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
    // still do a compare to reduce timing leakage on length
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
 * If neither env is set → reject (no open postbacks).
 * Incoming token from secret | password | key | token.
 * Returns { ok: true } or { ok: false, statusCode: 403, body: 'Forbidden' }.
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
 */
function parseProviderPayload(providerKey, q) {
  const provider = normalizeProvider(providerKey || q.provider || q.network || q.source);
  const userId = str(
    q.user_id || q.userId || q.userid || q.uid || q.subid || q.sub_id || q.sub1 ||
    q.player_id || q.playerId || q.external_user_id || q.sid,
    80
  );
  let transId = str(
    q.trans_id || q.transid || q.transaction_id || q.txid || q.tx_id ||
    q.event_id || q.conversion_id || q.oid,
    160
  );
  const offerId = (() => {
    const v = q.offer_id || q.offerid || q.offerId || q.campaign_id || q.campid || q.ad_id || q.goal_id;
    return v != null && String(v) !== '' ? str(v, 120) : null;
  })();
  const offerName = str(
    q.offer_name || q.offername || q.offerName || q.campaign_name || q.offer || q.goal_name || q.ad_name,
    200
  ) || 'Offer Completed';
  const datePart = str(q.date || q.datetime || q.timestamp || '', 40);

  if (!transId) {
    const parts = [provider, userId, offerId || '', datePart || '', str(q.payout || q.user_amount || q.amount || '', 40)];
    if (parts.filter(Boolean).length >= 2) {
      transId = 'fb_' + parts.join('|').slice(0, 150);
    }
  }

  let coins = toNum(q.coins_awarded ?? q.coins ?? q.reward ?? q.points ?? q.user_amount ?? q.virtual_currency, NaN);
  let payoutUsd = toNum(q.payout_usd ?? q.payout ?? q.amount ?? q.revenue ?? q.reward_usd ?? q.price, NaN);
  if (!Number.isFinite(coins) && Number.isFinite(payoutUsd)) coins = Math.round(payoutUsd * COINS_PER_USD);
  if (!Number.isFinite(payoutUsd) && Number.isFinite(coins)) payoutUsd = coins / COINS_PER_USD;
  if (!Number.isFinite(coins)) coins = 0;
  if (!Number.isFinite(payoutUsd)) payoutUsd = coins / COINS_PER_USD;

  const statusRaw = str(q.status || q.event || q.type || q.action || 'completed').toLowerCase();
  const isReversal =
    statusRaw.includes('charge') ||
    statusRaw.includes('revers') ||
    statusRaw.includes('reject') ||
    statusRaw === '0' ||
    statusRaw === 'failed' ||
    toNum(q.payout, 1) < 0 ||
    coins < 0;

  return {
    provider,
    user_id: userId,
    trans_id: transId || null,
    offer_id: offerId,
    offer_name: offerName,
    payout_usd: Math.abs(payoutUsd),
    coins_awarded: Math.abs(Math.floor(coins)),
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
    // Fail-closed: missing configured secret
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

  // 0) Fail-closed secret gate — no DB writes without valid secret
  const auth = assertPostbackSecret(event && event.provider, q);
  if (!auth.ok) {
    return { statusCode: 403, body: auth.body || 'Forbidden', detail: 'unauthorized' };
  }

  if (!event.user_id) {
    return { statusCode: 200, body: okBody, detail: 'missing_user_id' };
  }

  const db = getServiceDb();

  // 1) Deduplicate
  if (event.trans_id) {
    try {
      const { data: existing } = await db
        .from('postbacks')
        .select('id')
        .eq('provider', event.provider)
        .eq('trans_id', event.trans_id)
        .limit(1);
      if (existing && existing.length) {
        return { statusCode: 200, body: okBody, detail: 'duplicate' };
      }
    } catch (e) {
      console.warn('[dedupe]', e && e.message);
    }
  }

  const signedCoins = event.is_reversal ? -Math.abs(event.coins_awarded) : event.coins_awarded;

  // 2) ALWAYS insert master log
  let inserted = false;
  try {
    const { error } = await db.from('postbacks').insert({
      user_id: event.user_id,
      provider: event.provider,
      offer_id: event.offer_id,
      offer_name: event.offer_name,
      payout_usd: event.payout_usd,
      coins_awarded: signedCoins,
      trans_id: event.trans_id,
      status: event.status
    });
    if (!error) inserted = true;
    else console.warn('[postbacks full]', error.message);
  } catch (e) {
    console.warn('[postbacks full]', e && e.message);
  }
  if (!inserted) {
    const { error } = await db.from('postbacks').insert({
      user_id: event.user_id,
      provider: event.provider,
      offer_id: event.offer_id,
      offer_name: event.offer_name,
      payout_usd: event.payout_usd,
      coins_awarded: signedCoins
    });
    if (error) {
      console.error('[postbacks minimal]', error);
      return { statusCode: 200, body: okBody, detail: 'postbacks_insert_failed' };
    }
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
    } catch (e) {
      try {
        await db.from('offer_holds').insert({
          user_id: event.user_id,
          provider: event.provider,
          offer_name: event.offer_name,
          coins: event.coins_awarded,
          status: 'ON_HOLD'
        });
      } catch (e2) {
        console.error('[offer_holds]', e2 && e2.message);
      }
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

  // 4) Instant credit + notification + bottom live_activity only
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
    try {
      await db.from('live_activity').insert({
        user_id: event.user_id,
        type: 'offer',
        coins: event.coins_awarded,
        message: '+' + event.coins_awarded + ' from ' + event.provider
      });
    } catch (e2) {
      console.warn('[live_activity]', e2 && e2.message);
    }
  }

  return { statusCode: 200, body: okBody, detail: 'credited' };
}

module.exports = {
  parseProviderPayload,
  processPostbackEvent,
  verifySharedSecret,
  assertPostbackSecret,
  normalizeProvider,
  COINS_PER_USD
};
