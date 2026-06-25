// Cloudflare Pages Function: POST /api/track
//
// Lightweight first-party funnel telemetry. Stores anonymous events to a
// short-lived KV ring buffer so we can prove where users drop off without
// relying on Meta Ads Manager (which is unreliable without verified domain).
//
// NO PII is stored. Only:
//   - timestamp
//   - anonymous session_id (client-generated, 16 random chars)
//   - event name (e.g. "page_loaded", "form_started", "submit_attempt")
//   - meta: { utm_source, utm_medium, fbclid_present, device, browser, ... }
//
// GET /api/track?token=<CRON_SECRET> returns aggregated funnel counts.

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

const FUNNEL_BUFFER_KEY = 'funnel:recent';
const FUNNEL_BUFFER_LIMIT = 2000; // last 2000 events (rolling window)
const FUNNEL_COUNTS_KEY = 'funnel:counts:v1';

// Whitelist of allowed event names — anything else is silently dropped.
const ALLOWED_EVENTS = new Set([
  'page_loaded',
  'hero_viewed',
  'hero_cta_clicked',
  'sticky_cta_clicked',
  'mini_form_viewed',
  'form_viewed',
  'form_started',
  'name_completed',
  'phone_completed',
  'city_completed',
  'form_validation_error',
  'form_submit_attempt',
  'initiate_checkout_fired',
  'meta_browser_lead_sent',
  'api_request_started',
  'api_request_failed',
  'buyo_accepted',
  'buyo_rejected',
  'success_screen_viewed',
  'quiz_opened',
  'quiz_answered',
  'sheet_opened',
  'sheet_closed',
]);

function sanitize(s, max = 200) {
  if (s === undefined || s === null) return '';
  return String(s).slice(0, max);
}

function classifyDevice(ua) {
  if (!ua) return 'unknown';
  if (/iPad|iPhone|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Mobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

function classifyBrowser(ua) {
  if (!ua) return 'unknown';
  if (/Instagram/i.test(ua)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'facebook';
  if (/CriOS/i.test(ua)) return 'chrome-ios';
  if (/Chrome/i.test(ua)) return 'chrome';
  if (/Safari/i.test(ua)) return 'safari';
  return 'other';
}

export const onRequestPost = async ({ request, env }) => {
  if (!env.LEAD_EVENTS) return json({ ok: false, error: 'kv_not_bound' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  // Accept either a single event {event, ...} or batch {events:[...]}
  const events = Array.isArray(body.events) ? body.events : [body];
  if (events.length === 0) return json({ ok: true, stored: 0 });
  if (events.length > 50) return json({ ok: false, error: 'batch_too_large' }, 400);

  const ua = request.headers.get('User-Agent') || '';
  const device = classifyDevice(ua);
  const browser = classifyBrowser(ua);
  const referer = request.headers.get('Referer') || '';

  const safe = [];
  for (const ev of events) {
    const name = sanitize(ev.event, 60);
    if (!name || !ALLOWED_EVENTS.has(name)) continue;
    safe.push({
      ts: Date.now(),
      sid: sanitize(ev.sid, 32),
      ev: name,
      dev: device,
      br: browser,
      utm_s: sanitize(ev.utm_source, 80),
      utm_m: sanitize(ev.utm_medium, 80),
      utm_c: sanitize(ev.utm_campaign, 80),
      fbc: ev.fbc_present ? 1 : 0,
      fbp: ev.fbp_present ? 1 : 0,
      fbclid: ev.fbclid_present ? 1 : 0,
      err: sanitize(ev.error_code, 40),
      dur: Number(ev.duration_ms) || 0,
    });
  }
  if (safe.length === 0) return json({ ok: true, stored: 0 });

  // Append to ring buffer
  try {
    const cur = await env.LEAD_EVENTS.get(FUNNEL_BUFFER_KEY);
    const arr = cur ? (JSON.parse(cur) || []) : [];
    for (const e of safe) arr.unshift(e);
    while (arr.length > FUNNEL_BUFFER_LIMIT) arr.pop();
    await env.LEAD_EVENTS.put(FUNNEL_BUFFER_KEY, JSON.stringify(arr));
  } catch (e) {
    // KV write failed — don't block the user
  }

  // Update aggregated counts (best-effort)
  try {
    const cur = await env.LEAD_EVENTS.get(FUNNEL_COUNTS_KEY);
    const counts = cur ? (JSON.parse(cur) || {}) : {};
    const today = new Date().toISOString().slice(0, 10);
    if (!counts[today]) counts[today] = {};
    for (const e of safe) {
      counts[today][e.ev] = (counts[today][e.ev] || 0) + 1;
    }
    // Keep last 14 days only
    const dates = Object.keys(counts).sort();
    while (dates.length > 14) {
      delete counts[dates.shift()];
    }
    await env.LEAD_EVENTS.put(FUNNEL_COUNTS_KEY, JSON.stringify(counts));
  } catch (e) {
    /* best effort */
  }

  return json({ ok: true, stored: safe.length });
};

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  const token = request.headers.get('X-Debug-Token') || url.searchParams.get('token') || '';
  const expected = env.CRON_SECRET || '';
  if (!expected || token !== expected) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.LEAD_EVENTS) return json({ ok: false, error: 'kv_not_bound' }, 500);

  // Aggregated counts (last 14 days)
  let counts = {};
  try {
    const raw = await env.LEAD_EVENTS.get(FUNNEL_COUNTS_KEY);
    counts = raw ? JSON.parse(raw) : {};
  } catch (e) { /* */ }

  // Optionally include raw recent events
  let recent = [];
  if (url.searchParams.get('raw') === '1') {
    try {
      const raw = await env.LEAD_EVENTS.get(FUNNEL_BUFFER_KEY);
      recent = raw ? JSON.parse(raw).slice(0, 200) : [];
    } catch (e) { /* */ }
  }

  return json({
    ok: true,
    counts_by_day: counts,
    funnel_legend: {
      page_loaded: 'Landing Page View (LPV)',
      hero_viewed: 'Hero rendered + visible >= 50%',
      hero_cta_clicked: 'Primary CTA tapped',
      sticky_cta_clicked: 'Sticky CTA tapped',
      mini_form_viewed: 'Inline form became visible (under hero)',
      form_viewed: 'Order form became visible',
      form_started: 'First focus on any field',
      name_completed: 'Name field validated (>=2 chars)',
      phone_completed: 'Phone field validated (+998XXXXXXXXX)',
      form_validation_error: 'Client-side validation rejected submit',
      form_submit_attempt: 'POST /api/lead initiated',
      initiate_checkout_fired: 'Meta `InitiateCheckout` fired (post-validation, pre-API)',
      meta_browser_lead_sent: 'Meta browser-side `Lead` fired (post BUYO Accepted)',
      api_request_failed: 'Network failure (timeout, offline, ...)',
      buyo_accepted: 'Server returned ok:true, event_id valid',
      buyo_rejected: 'Server returned ok:false',
      success_screen_viewed: 'Success state shown to user',
      sheet_opened: 'Bottom-sheet form modal opened',
      sheet_closed: 'Bottom-sheet form modal closed',
    },
    recent_sample: recent,
  });
};
