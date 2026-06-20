// Cloudflare Pages Function: GET /api/debug-recent
//
// Returns the last 50 lead attempts and their outcome so the operator can
// verify in real-time WHY a given submit did or did not reach BUYO.
// PII is masked (phone shown as 99890***45). No name/email/city stored.
//
// Auth: requires X-Debug-Token header that matches the CRON_SECRET env var
// (same secret used by /api/buyo-poll, so no new secret to manage).

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });

export const onRequestOptions = () => json({ ok: true });

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  const token = request.headers.get('X-Debug-Token') || url.searchParams.get('token') || '';
  const expected = env.CRON_SECRET || '';
  if (!expected || token !== expected) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  if (!env.LEAD_EVENTS) {
    return json({ ok: false, error: 'kv_not_bound' }, 500);
  }

  let buf = [];
  try {
    const raw = await env.LEAD_EVENTS.get('debug:recent');
    buf = raw ? JSON.parse(raw) : [];
  } catch (e) {
    return json({ ok: false, error: 'read_failed', detail: String(e).slice(0, 200) }, 500);
  }

  // Aggregate outcome counts so the operator can spot patterns at a glance.
  const counts = {};
  for (const a of buf) {
    const k = a.outcome || 'unknown';
    counts[k] = (counts[k] || 0) + 1;
  }

  return json({
    ok: true,
    total: buf.length,
    by_outcome: counts,
    legend: {
      sent_to_buyo: '✅ Lead WAS sent to BUYO (should appear in dashboard within seconds)',
      duplicate_30s: '⏱️ Same phone re-submitted within 30 seconds — silently dropped (double-tap guard)',
      honeypot_triggered: '🤖 Hidden _hp field filled — bot blocked',
      fill_too_fast: '🤖 Form filled in < 500ms — bot blocked',
      invalid_name: '❌ Name shorter than 2 characters',
      invalid_phone_format: '❌ Phone failed +998XXXXXXXXX format',
      phone_pattern_rejected: '❌ Phone matched UZ blacklist pattern (sequence, all-zeros, wrong op code...)',
      invalid_city: '❌ No city selected',
      incompatible_ac: '❌ Quiz set ac_type=window or floor (incompatible product)',
      buyo_config_missing: '🔥 Env vars BUYO_API_KEY/BUYO_FLOW_ID not set on Cloudflare Pages',
      no_client_ip: '🔥 Could not resolve CF-Connecting-IP',
      buyo_rejected: '🔥 BUYO API returned non-success — check reason field',
    },
    attempts: buf,
  });
};
