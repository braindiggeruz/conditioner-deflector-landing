// Cloudflare Worker: buyo-poll-cron
//
// Cron trigger: hourly at minute 5 (every :05 of every hour, every day).
// Calls https://deflector.savdomix.uz/api/buyo-poll with the X-Cron-Secret
// header. The poll function fetches approved leads from BUYO and uploads
// them to Meta CAPI as Purchase events (event_id dedup'd against the
// original Lead event_id). This lifts Meta optimization quality because
// the algo now learns "who actually buys", not "who fills the form".
//
// Manual health check: fetch the worker URL -> "ok\n"
// Manual trigger:      fetch the worker URL with ?trigger=1 -> proxies once,
//                      protected by the same X-Cron-Secret header.

const POLL_URL = 'https://deflector.savdomix.uz/api/buyo-poll';

async function pollOnce(env) {
  const t0 = Date.now();
  let resp, bodyText = '';
  try {
    resp = await fetch(POLL_URL, {
      headers: {
        'X-Cron-Secret': env.CRON_SECRET || '',
        'User-Agent': 'buyo-poll-cron/1.0 (+cloudflare-workers)',
      },
    });
    bodyText = await resp.text();
  } catch (err) {
    console.log(JSON.stringify({
      stage: 'cron_fetch_failed',
      err: String(err).slice(0, 300),
      ms: Date.now() - t0,
    }));
    return { ok: false, error: String(err).slice(0, 300) };
  }
  console.log(JSON.stringify({
    stage: 'cron_polled',
    status: resp.status,
    ms: Date.now() - t0,
    body_preview: bodyText.slice(0, 500),
  }));
  return { ok: resp.ok, status: resp.status, body: bodyText };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollOnce(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.searchParams.get('trigger') === '1') {
      // Manual trigger guarded by the same secret.
      const token = request.headers.get('X-Cron-Secret') || url.searchParams.get('token') || '';
      if (!env.CRON_SECRET || token !== env.CRON_SECRET) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const result = await pollOnce(env);
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    return new Response('ok\n', { headers: { 'Content-Type': 'text/plain' } });
  },
};
