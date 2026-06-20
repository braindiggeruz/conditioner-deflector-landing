// Cloudflare Pages Function: /api/lead
// - POST: validates lead -> sends to BUYO CPA -> sends Meta CAPI Lead -> stores in KV -> returns ok:true
// - GET: health check
//
// Env vars:
//   BUYO_API_URL              (default: https://api.buyo.network/api/v1/leads)
//   BUYO_API_KEY              REQUIRED  (Bearer token)
//   BUYO_FLOW_ID              REQUIRED  (flow_id from Flows table)
//   META_PIXEL_ID             optional  (enables Meta CAPI)
//   META_CAPI_ACCESS_TOKEN    optional  (enables Meta CAPI)
//   META_TEST_EVENT_CODE      optional
//   META_GRAPH_VERSION        optional  (default: v23.0)
//
// KV binding:
//   LEAD_EVENTS               stores event_id -> {phone, name, ts, ...} for offline conversion upload

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });

export const onRequestOptions = () => json({ ok: true });
export const onRequestGet = () => json({ ok: true, service: 'buyo-meta-lead', version: '2.0' });

// --- helpers ---
function normalizeUzPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  let d = digits;
  if (d.startsWith('998')) {
    // ok
  } else if (d.length === 9) {
    d = '998' + d;
  } else if (d.startsWith('8') && d.length === 10) {
    d = '998' + d.slice(1);
  } else if (d.startsWith('0') && d.length === 10) {
    d = '998' + d.slice(1);
  } else {
    return null;
  }
  if (d.length !== 12) return null;
  return '+' + d;
}

// Uzbekistan mobile prefixes (operator codes). Phones not starting with one of
// these after +998 are almost certainly fake. Verified UZ mobile codes 2024-2026:
//  Beeline:   90, 91
//  Ucell:     93, 94
//  UMS:       97, 98
//  Mobiuz:    88, 99
//  Perfectum: 95
//  Humans:    33
const UZ_MOBILE_PREFIXES = new Set(['33', '88', '90', '91', '93', '94', '95', '97', '98', '99']);

function isPhonePatternSuspect(phone) {
  // phone format: +998XXYYYYYYY (12 digits after +)
  const d = phone.replace(/\D/g, ''); // 998XXYYYYYYY (12)
  if (d.length !== 12) return 'length';
  const opCode = d.slice(3, 5);
  if (!UZ_MOBILE_PREFIXES.has(opCode)) return 'op_code';
  const sub = d.slice(5); // 7 last digits
  // all same digit (1111111, 0000000, ...)
  if (/^(\d)\1{6}$/.test(sub)) return 'all_same';
  // exact sequence (1234567 / 7654321 / 0123456 / 9876543)
  if (sub === '1234567' || sub === '7654321' || sub === '0123456' || sub === '9876543') return 'sequence';
  // mostly zeros (>=5 zeros in a row)
  if (/0{5,}/.test(sub)) return 'too_many_zeros';
  return null;
}

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(String(text).trim().toLowerCase());
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function pickIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return '';
}

function sanitize(s, max = 500) {
  if (s === undefined || s === null) return '';
  return String(s).slice(0, max);
}

// ---- Debug observability ring buffer ----
// Stores the last N lead attempts (without PII) so the operator can verify
// in real-time WHY a given submit did or did not reach BUYO.
// GET /api/debug-recent (X-Debug-Token: CRON_SECRET) returns the buffer.
const DEBUG_BUFFER_KEY = 'debug:recent';
const DEBUG_BUFFER_LIMIT = 50;

function maskPhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (d.length < 6) return '***';
  return d.slice(0, 5) + '***' + d.slice(-2);
}

async function recordAttempt(env, partial) {
  if (!env.LEAD_EVENTS) return;
  try {
    const cur = await env.LEAD_EVENTS.get(DEBUG_BUFFER_KEY);
    const arr = cur ? (JSON.parse(cur) || []) : [];
    arr.unshift({ ts: Date.now(), at: new Date().toISOString(), ...partial });
    while (arr.length > DEBUG_BUFFER_LIMIT) arr.pop();
    await env.LEAD_EVENTS.put(DEBUG_BUFFER_KEY, JSON.stringify(arr));
  } catch (e) {
    console.log(JSON.stringify({ stage: 'debug_record_failed', err: String(e).slice(0,200) }));
  }
}

function normalizeCityForMatch(city) {
  // Strip "shahri", "viloyati"; lowercase. Used only for CAPI hash.
  return String(city || '')
    .toLowerCase()
    .replace(/\s+(shahri|viloyati|shaxri|vil)\b/g, '')
    .replace(/[^a-z0-9'`ʻʼ\u0400-\u04ff]/g, '')
    .trim();
}

async function sendToBuyo(env, payload) {
  const url = env.BUYO_API_URL || 'https://api.buyo.network/api/v1/leads';
  const body = new URLSearchParams();
  body.set('flow_id', env.BUYO_FLOW_ID);
  body.set('name', payload.name);
  body.set('phone', payload.phone);
  if (payload.ip) body.set('ip', payload.ip);
  if (payload.utm_source) body.set('utm_source', payload.utm_source);
  if (payload.utm_medium) body.set('utm_medium', payload.utm_medium);
  if (payload.utm_campaign) body.set('utm_campaign', payload.utm_campaign);
  if (payload.utm_term) body.set('utm_term', payload.utm_term);
  if (payload.utm_content) body.set('utm_content', payload.utm_content);

  let res, text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.BUYO_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, status: 0, error: 'network', detail: String(e).slice(0, 200) };
  }
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }

  const success = res.ok && parsed && parsed.success === true;
  let reason = null;
  if (!success) {
    const apiErr = (parsed && (parsed.error || parsed.message)) || '';
    const lower = String(apiErr).toLowerCase();
    if (res.status === 422) reason = 'buyo_validation_failed';
    else if (res.status === 401 || res.status === 403 || lower.includes('access denied') || lower.includes('flow')) reason = 'buyo_flow_invalid';
    else if (res.status === 200 && parsed && parsed.success === false && !apiErr) reason = 'buyo_auth_failed';
    else if (lower.includes('duplic')) reason = 'buyo_duplicate';
    else reason = 'buyo_failed';
  }
  const leadId = parsed?.data?.id || parsed?.data?.lead?.id || parsed?.lead_id || null;
  return { ok: success, status: res.status, reason, lead_id: leadId };
}

async function sendMetaCapi(env, ev) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_ACCESS_TOKEN) {
    return { ok: false, skipped: true, reason: 'meta_not_configured' };
  }
  const version = env.META_GRAPH_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${version}/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_ACCESS_TOKEN)}`;

  const user_data = {};
  if (ev.ip) user_data.client_ip_address = ev.ip;
  if (ev.user_agent) user_data.client_user_agent = ev.user_agent;
  if (ev.phone_hash) user_data.ph = [ev.phone_hash];
  if (ev.name_hash) user_data.fn = [ev.name_hash];
  if (ev.city_hash) user_data.ct = [ev.city_hash];
  if (ev.country_hash) user_data.country = [ev.country_hash];
  if (ev.external_id_hash) user_data.external_id = [ev.external_id_hash];
  if (ev.fbp) user_data.fbp = ev.fbp;
  if (ev.fbc) user_data.fbc = ev.fbc;

  const payload = {
    data: [
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id: ev.event_id,
        action_source: 'website',
        event_source_url: ev.event_source_url,
        user_data,
        custom_data: {
          content_name: 'conditioner_deflector',
          content_category: 'conditioner_deflector',
          currency: 'UZS',
          value: 175000,
        },
      },
    ],
  };
  if (env.META_TEST_EVENT_CODE) payload.test_event_code = env.META_TEST_EVENT_CODE;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* */ }
    return { ok: res.ok && !parsed?.error, status: res.status, error: parsed?.error?.message };
  } catch (e) {
    return { ok: false, status: 0, error: String(e).slice(0, 200) };
  }
}

// Persist lead context so /api/buyo-poll can upload Purchase events later
// when BUYO marks the lead as approved.
async function persistLead(env, key, value) {
  if (!env.LEAD_EVENTS) return;
  try {
    await env.LEAD_EVENTS.put(key, JSON.stringify(value), { expirationTtl: 60 * 60 * 24 * 90 }); // 90 days
  } catch (e) {
    console.log(JSON.stringify({ stage: 'kv_put_failed', key_kind: key.split(':')[0], err: String(e).slice(0, 100) }));
  }
}

// Detect a very-recent duplicate phone submit (defends only against accidental
// double-tap / page-refresh). BUYO itself dedupes longer-term duplicates and
// surfaces them to operators as "Треш", so we only need a short window here.
// Returns true if same phone was submitted within last `windowSec` seconds.
async function isPhoneDuplicateWindow(env, phone, windowSec = 30) {
  if (!env.LEAD_EVENTS) return false;
  try {
    const phoneKey = `phone:${phone.replace(/\D/g, '')}`;
    const last = await env.LEAD_EVENTS.get(phoneKey);
    if (!last) return false;
    const parsed = JSON.parse(last);
    const ageSec = (Date.now() - (parsed.ts || 0)) / 1000;
    return ageSec < windowSec;
  } catch {
    return false;
  }
}

export const onRequestPost = async ({ request, env }) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // ---- Honeypot: hidden field that must remain empty ----
  if (body._hp && String(body._hp).trim().length > 0) {
    console.log(JSON.stringify({ stage: 'honeypot_triggered' }));
    await recordAttempt(env, { outcome: 'honeypot_triggered', phone_masked: maskPhone(body.phone) });
    // Silently respond ok to avoid revealing the trap to bots
    return json({ ok: true, event_id: 'bot_silenced' });
  }

  // ---- Form-fill speed: < 0.5s is clearly automated (humans need >0.5s even to tap "submit") ----
  // Client-side guarantees >= 3s. This server check is a final safety net.
  const fillMs = Number(body.fill_ms || 0);
  if (fillMs > 0 && fillMs < 500) {
    console.log(JSON.stringify({ stage: 'fill_too_fast', fill_ms: fillMs }));
    await recordAttempt(env, { outcome: 'fill_too_fast', fill_ms: fillMs, phone_masked: maskPhone(body.phone) });
    return json({ ok: true, event_id: 'bot_silenced' });
  }

  const name = sanitize(body.name, 120).trim();
  const phone = normalizeUzPhone(body.phone);
  const city = sanitize(body.city, 120).trim();
  const width = sanitize(body.width, 60).trim();
  const slot = sanitize(body.slot, 40).trim();
  const acType = sanitize(body.ac_type, 40).trim();
  const acPanel = sanitize(body.ac_panel, 40).trim();
  const acMount = sanitize(body.ac_mount, 40).trim();

  if (name.length < 2) { await recordAttempt(env, { outcome: 'invalid_name', phone_masked: maskPhone(body.phone) }); return json({ ok: false, error: 'invalid_name' }, 400); }
  if (!phone) { await recordAttempt(env, { outcome: 'invalid_phone_format', phone_masked: maskPhone(body.phone) }); return json({ ok: false, error: 'invalid_phone' }, 400); }
  if (!city) { await recordAttempt(env, { outcome: 'invalid_city', phone_masked: maskPhone(phone) }); return json({ ok: false, error: 'invalid_city' }, 400); }

  // ---- UZ phone pattern blacklist ----
  const patternIssue = isPhonePatternSuspect(phone);
  if (patternIssue) {
    console.log(JSON.stringify({ stage: 'phone_pattern_rejected', issue: patternIssue }));
    await recordAttempt(env, { outcome: 'phone_pattern_rejected', issue: patternIssue, phone_masked: maskPhone(phone) });
    return json({ ok: false, error: 'invalid_phone' }, 400);
  }

  // ---- Incompatible AC pre-filter (server-side belt-and-braces) ----
  // If client-side quiz said the AC is window/floor, we already blocked,
  // but double-check on server in case form was tampered.
  if (acType && (acType === 'window' || acType === 'floor')) {
    console.log(JSON.stringify({ stage: 'incompatible_ac_blocked', type: acType }));
    await recordAttempt(env, { outcome: 'incompatible_ac', ac_type: acType, phone_masked: maskPhone(phone) });
    return json({ ok: false, error: 'incompatible_ac' }, 400);
  }

  if (!env.BUYO_API_KEY || !env.BUYO_FLOW_ID) {
    await recordAttempt(env, { outcome: 'buyo_config_missing', phone_masked: maskPhone(phone) });
    return json({ ok: false, error: 'buyo_config_missing' }, 500);
  }

  const ip = pickIp(request);
  if (!ip) {
    await recordAttempt(env, { outcome: 'no_client_ip', phone_masked: maskPhone(phone) });
    return json({ ok: false, error: 'no_client_ip' }, 500);
  }
  const ua = request.headers.get('User-Agent') || sanitize(body.user_agent, 500);
  const rawEid = sanitize(body.meta_event_id, 80);
  const VALID_EID = /^[a-zA-Z0-9_-]{8,80}$/;
  const event_id = VALID_EID.test(rawEid) ? rawEid : crypto.randomUUID();
  const event_source_url = sanitize(body.page_url, 500) || request.headers.get('Referer') || '';

  // ---- Duplicate-window check (silent block) ----
  // Narrow 30s window: protects ONLY against accidental double-tap / page-refresh
  // re-submits. Real users who come back later (5 min, 1h, next day) MUST be
  // allowed through — BUYO surfaces longer-term duplicates via its "Треш" filter.
  const isDuplicate = await isPhoneDuplicateWindow(env, phone, 30);
  if (isDuplicate) {
    console.log(JSON.stringify({ stage: 'phone_duplicate_window_30s', event_id }));
    await recordAttempt(env, { outcome: 'duplicate_30s', event_id, phone_masked: maskPhone(phone) });
    // Silent success — same lead already in BUYO pipeline, no need to re-fire.
    return json({ ok: true, event_id, meta: 'duplicate_silent' });
  }

  // utm + click ids
  const t = body.tracking || {};
  const utm_source = sanitize(t.utm_source, 200);
  const utm_medium = sanitize(t.utm_medium, 200);
  const utm_campaign = sanitize(t.utm_campaign, 200);
  const utm_term = sanitize(t.utm_term, 200);
  const extras = [];
  if (city) extras.push(`city:${city}`);
  if (width) extras.push(`w:${width}`);
  if (slot) extras.push(`slot:${slot}`);
  if (acType) extras.push(`ac:${acType}`);
  if (acPanel) extras.push(`panel:${acPanel}`);
  if (acMount) extras.push(`mount:${acMount}`);
  if (t.subid || t.sub_id) extras.push(`subid:${sanitize(t.subid || t.sub_id, 80)}`);
  if (t.clickid || t.click_id) extras.push(`clickid:${sanitize(t.clickid || t.click_id, 80)}`);
  if (t.fbclid) extras.push(`fbclid:${sanitize(t.fbclid, 120)}`);
  if (t.gclid) extras.push(`gclid:${sanitize(t.gclid, 120)}`);
  if (t.ttclid) extras.push(`ttclid:${sanitize(t.ttclid, 120)}`);
  const userUtmContent = sanitize(t.utm_content, 200);
  const utm_content = [userUtmContent, extras.join('|')].filter(Boolean).join('|').slice(0, 500);

  const buyo = await sendToBuyo(env, {
    name,
    phone,
    ip,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_term,
    utm_content,
  });

  if (!buyo.ok) {
    console.log(JSON.stringify({ stage: 'buyo_rejected', event_id, status: buyo.status, reason: buyo.reason }));
    await recordAttempt(env, { outcome: 'buyo_rejected', reason: buyo.reason, http_status: buyo.status, event_id, phone_masked: maskPhone(phone), city });
    return json({ ok: false, error: buyo.reason || 'buyo_failed' }, 502);
  }
  console.log(JSON.stringify({ stage: 'buyo_success', event_id, status: buyo.status, buyo_lead_id: buyo.lead_id || null }));

  // ---- CAPI Advanced Matching: hash all available PII ----
  const phoneDigits = phone.replace(/\D/g, ''); // 998XXXXXXXXX
  const fbp = sanitize(body.fbp, 200);
  const fbc = sanitize(body.fbc, 200);
  const [phone_hash, name_hash, city_hash, country_hash, external_id_hash] = await Promise.all([
    sha256Hex(phoneDigits),
    sha256Hex(name),
    sha256Hex(normalizeCityForMatch(city)),
    sha256Hex('uz'),
    sha256Hex(event_id), // external_id = own event_id, helps Meta dedup across devices
  ]);

  const meta = await sendMetaCapi(env, {
    event_id,
    event_source_url,
    ip,
    user_agent: ua,
    phone_hash,
    name_hash,
    city_hash,
    country_hash,
    external_id_hash,
    fbp,
    fbc,
  });

  let metaStatus = 'sent';
  if (meta.skipped) metaStatus = 'skipped_config_missing';
  else if (!meta.ok) metaStatus = 'failed';

  console.log(JSON.stringify({
    stage: meta.skipped ? 'capi_skipped_config_missing' : (meta.ok ? 'capi_sent' : 'capi_failed'),
    event_id,
    buyo_lead_id: buyo.lead_id || null,
    capi_status: meta.status || null,
  }));

  // ---- KV: store event context so /api/buyo-poll can upload Purchase later ----
  // Two indexes:
  //  phone:{digits}     -> { event_id, ts, ... }  (lookup when polling approved leads from BUYO)
  //  buyo:{lead_id}     -> { event_id, ts, ... }  (alternative lookup if BUYO returns lead_id)
  //  event:{event_id}   -> full context (for offline Purchase upload)
  const leadCtx = {
    event_id,
    phone_digits: phoneDigits,
    phone_hash,
    name_hash,
    city_hash,
    country_hash,
    external_id_hash,
    fbp,
    fbc,
    ip,
    user_agent: ua,
    event_source_url,
    buyo_lead_id: buyo.lead_id || null,
    ts: Date.now(),
  };
  // No PII in primary key — only phone digits (which BUYO already has).
  await persistLead(env, `phone:${phoneDigits}`, leadCtx);
  await persistLead(env, `event:${event_id}`, leadCtx);
  if (buyo.lead_id) {
    await persistLead(env, `buyo:${buyo.lead_id}`, leadCtx);
  }
  await recordHappyPath(env, {
    event_id,
    buyo_lead_id: buyo.lead_id || null,
    capi: metaStatus,
    phone_masked: maskPhone(phone),
    city,
  });

  return json({
    ok: true,
    event_id,
    meta: metaStatus,
  });
};

// ---------------------------------------------------------------------------
// Final-attempt recorder for the happy path.
// We hook this at the very end so the debug buffer reflects what BUYO accepted.
// Placed below the handler so the closure captures the same KV binding.
// ---------------------------------------------------------------------------
async function recordHappyPath(env, ctx) {
  await recordAttempt(env, {
    outcome: 'sent_to_buyo',
    event_id: ctx.event_id,
    buyo_lead_id: ctx.buyo_lead_id,
    capi: ctx.capi,
    phone_masked: ctx.phone_masked,
    city: ctx.city,
  });
}
