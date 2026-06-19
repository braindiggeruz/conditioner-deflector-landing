// Cloudflare Pages Function: /api/lead
// - POST: validates lead -> sends to BUYO CPA -> sends Meta CAPI Lead -> returns ok:true
// - GET: health check
//
// Env vars (set in Cloudflare Pages -> Settings -> Environment variables):
//   BUYO_API_URL              (default: https://api.buyo.network/api/v1/leads)
//   BUYO_API_KEY              REQUIRED  (Bearer token)
//   BUYO_FLOW_ID              REQUIRED  (flow_id from Flows table)
//   META_PIXEL_ID             optional  (enables Meta CAPI)
//   META_CAPI_ACCESS_TOKEN    optional  (enables Meta CAPI)
//   META_TEST_EVENT_CODE      optional
//   META_GRAPH_VERSION        optional  (default: v23.0)

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

export const onRequestGet = () =>
  json({ ok: true, service: 'buyo-meta-lead' });

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

async function sendToBuyo(env, payload) {
  const url = env.BUYO_API_URL || 'https://api.buyo.network/api/v1/leads';
  const body = new URLSearchParams();
  // required
  body.set('flow_id', env.BUYO_FLOW_ID);
  body.set('name', payload.name);
  body.set('phone', payload.phone);
  // optional
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
  const ok = res.ok && (parsed?.success !== false);
  return { ok, status: res.status, data: parsed, raw: parsed ? undefined : text?.slice(0, 300) };
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
          currency: 'USD',
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

export const onRequestPost = async ({ request, env }) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const name = sanitize(body.name, 120).trim();
  const phone = normalizeUzPhone(body.phone);
  const city = sanitize(body.city, 120).trim();
  const width = sanitize(body.width, 60).trim();

  if (name.length < 2) return json({ ok: false, error: 'invalid_name' }, 400);
  if (!phone) return json({ ok: false, error: 'invalid_phone' }, 400);
  if (!city) return json({ ok: false, error: 'invalid_city' }, 400);

  // config check (after input validation)
  if (!env.BUYO_API_KEY || !env.BUYO_FLOW_ID) {
    return json({ ok: false, error: 'buyo_config_missing' }, 500);
  }

  const ip = pickIp(request);
  const ua = request.headers.get('User-Agent') || sanitize(body.user_agent, 500);
  const event_id = sanitize(body.meta_event_id, 80) || crypto.randomUUID();
  const event_source_url = sanitize(body.page_url, 500) || request.headers.get('Referer') || '';

  // utm + click ids
  const t = body.tracking || {};
  const utm_source = sanitize(t.utm_source, 200);
  const utm_medium = sanitize(t.utm_medium, 200);
  const utm_campaign = sanitize(t.utm_campaign, 200);
  const utm_term = sanitize(t.utm_term, 200);
  // pack extras (city/width/click ids) into utm_content to keep CRM context
  const extras = [];
  if (city) extras.push(`city:${city}`);
  if (width) extras.push(`w:${width}`);
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
    return json(
      { ok: false, error: 'buyo_failed', status: buyo.status },
      502
    );
  }

  // Meta CAPI (best-effort, never blocks success)
  const phone_hash = await sha256Hex(phone.replace(/\D/g, ''));
  const meta = await sendMetaCapi(env, {
    event_id,
    event_source_url,
    ip,
    user_agent: ua,
    phone_hash,
    fbp: sanitize(body.fbp, 200),
    fbc: sanitize(body.fbc, 200),
  });

  let metaStatus = 'sent';
  if (meta.skipped) metaStatus = 'skipped_config_missing';
  else if (!meta.ok) metaStatus = 'failed';

  return json({
    ok: true,
    event_id,
    meta: metaStatus,
  });
};
