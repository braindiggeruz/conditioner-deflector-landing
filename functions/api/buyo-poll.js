// Cloudflare Pages Function: /api/buyo-poll
//
// Polls BUYO API for newly-approved leads and uploads them to Meta CAPI as
// 'Purchase' events with the original event_id from /api/lead.
//
// This is the #1 CPA optimisation lever: it teaches Meta which leads actually
// converted to approved orders, so Meta optimises ads toward similar buyers
// (not toward people who only leave phone numbers).
//
// Invocation:
//   GET /api/buyo-poll
//   Header: X-Cron-Secret: <CRON_SECRET env var>
//
// External cron (recommended): cron-job.org -> hit every 60 minutes.
//
// Env vars (in addition to lead.js vars):
//   CRON_SECRET               REQUIRED  (random string, ≥16 chars, shared with cron caller)
//   META_PURCHASE_VALUE_UZS   optional  (default: 175000)
//
// KV: LEAD_EVENTS

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const LAST_POLL_KEY = 'cron:last_poll_iso';
const PROCESSED_PREFIX = 'processed:';

async function fetchApprovedLeads(env, sinceIso) {
  // BUYO GET /api/v1/leads. Docs say JSON body, but Cloudflare Workers fetch
  // disallows body in GET — so we send via query params (standard REST).
  const baseUrl = env.BUYO_API_URL || 'https://api.buyo.network/api/v1/leads';
  const sinceDate = sinceIso ? sinceIso.slice(0, 10) : new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);

  const all = [];
  let page = 1;
  const maxPages = 20; // safety

  while (page <= maxPages) {
    const qs = new URLSearchParams();
    qs.append('statuses[]', 'approved');
    if (env.BUYO_FLOW_ID) qs.append('flow_ids[]', env.BUYO_FLOW_ID);
    qs.set('since', sinceDate);
    qs.set('page', String(page));

    const res = await fetch(`${baseUrl}?${qs.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.BUYO_API_KEY}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`buyo_get_${res.status}_${text.slice(0, 120)}`);
    }
    const data = await res.json();
    const leads = data?.data?.leads || [];
    all.push(...leads);
    const pagination = data?.data?.pagination;
    if (!pagination || page * (pagination.per_page || 100) >= (pagination.total || 0)) break;
    page++;
  }
  return all;
}

async function sendMetaPurchase(env, ctx, buyoLead) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_ACCESS_TOKEN) {
    return { ok: false, skipped: true, reason: 'meta_not_configured' };
  }
  const version = env.META_GRAPH_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${version}/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_ACCESS_TOKEN)}`;

  // event_id for Purchase is DIFFERENT from the Lead event_id (Meta requires
  // distinct event_ids per event_name). We derive it deterministically so
  // re-polling never creates duplicates.
  const purchaseEventId = `purchase_${ctx.event_id}`;

  // event_time: when BUYO approved it (best signal). Falls back to now.
  const approvedAt = buyoLead?.approved_at || buyoLead?.updated_at || buyoLead?.created_at;
  const eventTimeSec = approvedAt
    ? Math.floor(new Date(approvedAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const user_data = {};
  if (ctx.ip) user_data.client_ip_address = ctx.ip;
  if (ctx.user_agent) user_data.client_user_agent = ctx.user_agent;
  if (ctx.phone_hash) user_data.ph = [ctx.phone_hash];
  // Backwards-compat: legacy KV rows used `name_hash` (full name). New rows use fn_hash + ln_hash.
  if (ctx.fn_hash) user_data.fn = [ctx.fn_hash];
  else if (ctx.name_hash) user_data.fn = [ctx.name_hash];
  if (ctx.ln_hash) user_data.ln = [ctx.ln_hash];
  if (ctx.city_hash) user_data.ct = [ctx.city_hash];
  if (ctx.state_hash) user_data.st = [ctx.state_hash];
  if (ctx.country_hash) user_data.country = [ctx.country_hash];
  if (ctx.external_id_hash) user_data.external_id = [ctx.external_id_hash];
  if (ctx.fbp) user_data.fbp = ctx.fbp;
  if (ctx.fbc) user_data.fbc = ctx.fbc;

  const value = Number(env.META_PURCHASE_VALUE_UZS || 175000);

  const payload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: eventTimeSec,
        event_id: purchaseEventId,
        action_source: 'website',
        event_source_url: ctx.event_source_url || 'https://conditioner-deflector-landing.pages.dev/',
        user_data,
        custom_data: {
          content_name: 'conditioner_deflector',
          content_category: 'conditioner_deflector',
          currency: 'UZS',
          value,
          order_id: String(buyoLead?.id || ctx.buyo_lead_id || ctx.event_id),
        },
      },
    ],
  };
  if (env.META_TEST_EVENT_CODE) payload.test_event_code = env.META_TEST_EVENT_CODE;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* */ }
  return {
    ok: res.ok && !parsed?.error,
    status: res.status,
    error: parsed?.error?.message,
    purchase_event_id: purchaseEventId,
  };
}

async function findLeadContext(env, lead) {
  if (!env.LEAD_EVENTS) return null;
  // Try by BUYO lead id first, then by normalized phone.
  if (lead.id) {
    const v = await env.LEAD_EVENTS.get(`buyo:${lead.id}`);
    if (v) return JSON.parse(v);
  }
  if (lead.phone) {
    const digits = String(lead.phone).replace(/\D/g, '');
    const v = await env.LEAD_EVENTS.get(`phone:${digits}`);
    if (v) return JSON.parse(v);
  }
  return null;
}

export const onRequestGet = async ({ request, env }) => {
  // Auth: shared secret via header, exposing endpoint publicly is safe behind this.
  const got = request.headers.get('X-Cron-Secret') || new URL(request.url).searchParams.get('secret') || '';
  if (!env.CRON_SECRET || got !== env.CRON_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!env.BUYO_API_KEY) {
    return json({ ok: false, error: 'buyo_not_configured' }, 500);
  }
  if (!env.LEAD_EVENTS) {
    return json({ ok: false, error: 'kv_not_configured' }, 500);
  }

  const startedAt = Date.now();
  const lastPoll = (await env.LEAD_EVENTS.get(LAST_POLL_KEY)) || null;

  let approvedLeads;
  try {
    approvedLeads = await fetchApprovedLeads(env, lastPoll);
  } catch (e) {
    return json({ ok: false, error: 'buyo_fetch_failed', detail: String(e).slice(0, 200) }, 502);
  }

  const result = {
    fetched: approvedLeads.length,
    matched: 0,
    purchases_sent: 0,
    purchases_failed: 0,
    already_processed: 0,
    no_context: 0,
    errors: [],
  };

  for (const lead of approvedLeads) {
    // Skip already-processed
    const processedKey = `${PROCESSED_PREFIX}${lead.id}`;
    const already = await env.LEAD_EVENTS.get(processedKey);
    if (already) {
      result.already_processed++;
      continue;
    }

    const ctx = await findLeadContext(env, lead);
    if (!ctx) {
      result.no_context++;
      // Mark as processed anyway to avoid re-checking forever
      await env.LEAD_EVENTS.put(processedKey, JSON.stringify({ status: 'no_context', ts: Date.now() }), {
        expirationTtl: 60 * 60 * 24 * 90,
      });
      continue;
    }

    result.matched++;
    try {
      const purchase = await sendMetaPurchase(env, ctx, lead);
      if (purchase.ok) {
        result.purchases_sent++;
        await env.LEAD_EVENTS.put(processedKey, JSON.stringify({
          status: 'purchase_sent',
          purchase_event_id: purchase.purchase_event_id,
          ts: Date.now(),
        }), { expirationTtl: 60 * 60 * 24 * 90 });
      } else if (purchase.skipped) {
        result.purchases_failed++;
        result.errors.push('meta_not_configured');
      } else {
        result.purchases_failed++;
        if (purchase.error) result.errors.push(String(purchase.error).slice(0, 80));
        // Don't mark processed — retry next poll.
      }
    } catch (e) {
      result.purchases_failed++;
      result.errors.push(String(e).slice(0, 80));
    }
  }

  // Update last poll watermark
  await env.LEAD_EVENTS.put(LAST_POLL_KEY, new Date(startedAt).toISOString());

  const tookMs = Date.now() - startedAt;
  console.log(JSON.stringify({ stage: 'buyo_poll_done', took_ms: tookMs, ...result, errors: result.errors.slice(0, 5) }));

  return json({ ok: true, ...result, took_ms: tookMs, last_poll: new Date(startedAt).toISOString() });
};
