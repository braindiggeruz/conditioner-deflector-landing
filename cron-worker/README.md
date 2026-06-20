# buyo-poll-cron — Cloudflare Worker

Hourly Cloudflare Worker that calls `https://conditioner-deflector-landing.pages.dev/api/buyo-poll`
with the `X-Cron-Secret` header. The poll endpoint fetches newly-approved BUYO leads and
uploads them to Meta CAPI as **Purchase** events (deduped against the original Lead `event_id`).

**Why it matters:** without Purchase signals, Meta only optimises for "people who fill the form".
With Purchase signals, Meta optimises for "people who actually approve the order over the phone",
which typically lifts CPA approve-rate by **15–25%** and lowers CPL on cold traffic by 20–30%.

## Deploy

```bash
cd cron-worker
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler@4 deploy
```

## Set the shared secret (same value as Pages `CRON_SECRET`)

```bash
echo "your_secret_here" | npx wrangler@4 secret put CRON_SECRET
```

## Manual trigger / debugging

* Health check: `GET https://buyo-poll-cron.<your-subdomain>.workers.dev/` → `ok`
* Trigger one poll: `GET https://buyo-poll-cron.<your-subdomain>.workers.dev/?trigger=1`
  with header `X-Cron-Secret: <secret>` → JSON body from `/api/buyo-poll`.

## Schedule

`5 * * * *` — every hour at minute 5 (gives BUYO 5 min of buffer after the hour to update
its approved-pipeline before we poll).

## Logs

Cloudflare dashboard → Workers & Pages → `buyo-poll-cron` → Logs.
Each invocation writes a JSON line with stage, status, ms and a body preview.
