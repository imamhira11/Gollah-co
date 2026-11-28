/**
 * Single postback endpoint for all offerwalls.
 *   /api/postback?provider=GemiAd&user_id=...
 *   /api/postback-gemiad?...   (via vercel.json rewrite → provider=gemiad)
 * Always HTTP 200 + plain text "1" (or "0" on bad per-wall secret).
 * Add &debug=1 (with valid secret) to receive JSON step-by-step result.
 */

const {
  parseProviderPayload,
  processPostbackEvent,
  verifySharedSecret,
  assertPostbackSecret
} = require('../lib/postback-core');

const PROVIDER_SECRET_ENV = {
  Ovnix: 'POSTBACK_SECRET_OVNIX',
  Adlexy: 'POSTBACK_SECRET_ADLEXY',
  RewardTym: 'POSTBACK_SECRET_REWARDTYM',
  VortexWall: 'POSTBACK_SECRET_VORTEXWALL',
  GemiAd: 'POSTBACK_SECRET_GEMIAD',
  Upwall: 'POSTBACK_SECRET_UPWALL',
  Clickwall: 'POSTBACK_SECRET_CLICKWALL',
  Revtoo: 'POSTBACK_SECRET_REVTOO',
  Taskwall: 'POSTBACK_SECRET_TASKWALL',
  TheoremReach: 'POSTBACK_SECRET_THEOREMREACH',
  'CPX Research': 'POSTBACK_SECRET_CPX',
  Lootably: 'POSTBACK_SECRET_LOOTABLY',
  Adgate: 'POSTBACK_SECRET_ADGATE',
  OfferToro: 'POSTBACK_SECRET_OFFERTORO',
  Torox: 'POSTBACK_SECRET_TOROX',
  BitLabs: 'POSTBACK_SECRET_BITLABS',
  Monlix: 'POSTBACK_SECRET_MONLIX',
  Offery: 'POSTBACK_SECRET_OFFERY'
};

function mergeParams(req) {
  const q = Object.assign({}, req.query || {});
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    Object.assign(q, req.body);
  } else if (typeof req.body === 'string' && req.body) {
    try {
      Object.assign(q, JSON.parse(req.body));
    } catch (_) {
      try {
        const params = new URLSearchParams(req.body);
        params.forEach(function (v, k) {
          q[k] = v;
        });
      } catch (_) {}
    }
  }
  return q;
}

module.exports = async function handler(req, res) {
  const debug = false;
  try {
    const q = mergeParams(req);
    const wantDebug = String(q.debug || '') === '1';
    const providerKey = q.provider || q.p || 'Unknown';
    const event = parseProviderPayload(providerKey, q);

    // Per-wall secret (legacy map) — still enforced when env is set
    const secretEnv = PROVIDER_SECRET_ENV[event.provider];
    if (secretEnv && process.env[secretEnv] && !verifySharedSecret(q, secretEnv)) {
      console.warn('[postback] bad secret', event.provider);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('0');
      return;
    }

    // Master / per-provider secret gate (assertPostbackSecret inside processPostbackEvent)
    const result = await processPostbackEvent(event, { okBody: '1' });

    if (wantDebug) {
      // Only expose debug JSON when secret was accepted (processPostbackEvent already gated)
      // and the caller explicitly asked for it.
      const auth = assertPostbackSecret(event.provider, q);
      if (auth.ok) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          ok: result.detail === 'credited' || result.detail === 'duplicate' || result.detail === 'held' || result.detail === 'reversed',
          user_id: event.user_id || null,
          provider: event.provider || null,
          trans_id: event.trans_id || null,
          coins_awarded: event.coins_awarded,
          detail: result.detail || null,
          error: result.error || null,
          body: result.body || '1'
        }));
        return;
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(result.body || '1');
  } catch (e) {
    console.error('[postback]', e);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('1');
  }
};
