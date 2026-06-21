// Cloudflare Pages Function: GET /api/config
//
// Exposes ONLY the public Meta Pixel ID (which is already public on any pixel
// fire to facebook.com/tr anyway) so the client-side script can initialise
// the Pixel without needing a build-time VITE_* env var.
//
// This lets wrangler-only deploys (no CI) load the Pixel correctly.
// All sensitive credentials (access_token, api_key, etc.) stay server-side.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Browser cache 5 min, CDN edge cache 1 hour. Pixel ID is stable.
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });

export const onRequestOptions = () => json({ ok: true });

export const onRequestGet = async ({ env }) => {
  return json({
    ok: true,
    pixel_id: env.META_PIXEL_ID || '',
  });
};
