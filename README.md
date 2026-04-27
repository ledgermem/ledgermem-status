# ledgermem-status

Self-built status page for **status.proofly.dev**. Cloudflare Worker, free tier.

## What it does

- Pings every target in `wrangler.jsonc:vars.TARGETS` once a minute (cron)
- Stores up to 24h of samples per target in Cloudflare KV
- Serves:
  - `GET /` — HTML status page (light/dark, semantic, inline CSS)
  - `GET /api/v2/status.json` — Statuspage.io-compatible JSON (the marketing site's `<StatusPill>` already polls this shape)
  - `GET /api/v2/components.json` — per-component history with uptime + p95 latency
  - `GET /healthz` — liveness for the worker itself

Default targets: `api.proofly.dev`, `app.proofly.dev`, `proofly.dev`, `mcp.proofly.dev`.

## Why not Better Stack / Statuspage.io?

Cost. Better Stack is $24/mo, Statuspage.io is $79/mo. This worker runs on the Cloudflare free tier (cron triggers + 100k KV reads/day are well below limits for a one-minute probe of 4 targets).

Trade-off: no incident timeline UI, no subscriber notifications, no SMS/email alerts. Add those when revenue justifies it (probably ~30 paying customers).

## Deploy

```bash
npm install

# 1. Create the KV namespace once:
npx wrangler kv:namespace create STATUS
# → paste the returned id into wrangler.jsonc

# 2. Deploy:
npx wrangler deploy

# 3. Bind status.proofly.dev to this worker in the Cloudflare dashboard
#    (Workers & Pages → ledgermem-status → Settings → Triggers → Custom Domains)
```

## Local dev

```bash
npm run dev
# Worker available at http://localhost:8787
# Trigger a probe manually with:
#   curl -X POST http://localhost:8787/__scheduled?cron=*+*+*+*+*
```

## License

MIT
