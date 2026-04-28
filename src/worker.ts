/**
 * status.proofly.dev — Cloudflare Worker.
 *
 * Two responsibilities:
 *   1. Run a probe of every TARGETS entry once a minute (cron trigger),
 *      record latency + status into KV.
 *   2. Serve:
 *        GET /                      → HTML status page
 *        GET /api/v2/status.json    → Statuspage.io-compatible JSON
 *                                     (consumed by the marketing site's
 *                                     <StatusPill> component)
 *        GET /api/v2/components.json → per-component history
 *        GET /healthz               → liveness for the worker itself
 */

export interface Env {
  STATUS: KVNamespace
  TARGETS: string // JSON-encoded array of { name, url }
}

type Target = { name: string; url: string }
type Sample = { ts: number; ok: boolean; status: number; latencyMs: number }
type ComponentState = {
  name: string
  status: 'operational' | 'degraded_performance' | 'partial_outage' | 'major_outage'
  uptime24h: number
  latencyP95Ms: number
  lastSample: Sample | null
}

const SAMPLES_PER_TARGET = 60 * 24 // 1 day at 1/min
const MAX_OUTAGES = 50

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') return json({ status: 'ok' })
    if (url.pathname === '/api/v2/status.json') return statusJson(env)
    if (url.pathname === '/api/v2/components.json') return componentsJson(env)
    if (url.pathname === '/' || url.pathname === '/index.html')
      return new Response(await renderHtml(env), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Probes only run once a minute; serve the page from edge cache for
          // 30s so a Twitter spike doesn't burst-read KV on every visit.
          'cache-control': 'public, max-age=30, s-maxage=30',
        },
      })
    return new Response('Not found', { status: 404 })
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runProbes(env))
  },
}

async function runProbes(env: Env): Promise<void> {
  const targets = parseTargets(env.TARGETS)
  await Promise.all(
    targets.map(async (t) => {
      const key = `samples:${t.name}`
      const existing = (await env.STATUS.get(key, 'json')) as Sample[] | null
      // Probabilistic backoff: after N consecutive failures, skip some probe
      // ticks so a target that has been down for 10+ minutes doesn't keep
      // getting pinged at 1/min — we still get one sample per ~5 minutes.
      if (shouldSkipProbe(existing ?? [])) return
      const sample = await probe(t)
      const next = [...(existing ?? []), sample].slice(-SAMPLES_PER_TARGET)
      await env.STATUS.put(key, JSON.stringify(next))
    }),
  )
}

function shouldSkipProbe(samples: Sample[]): boolean {
  // Count trailing consecutive failures.
  let consecutiveFails = 0
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (samples[i]!.ok) break
    consecutiveFails += 1
  }
  if (consecutiveFails < 10) return false
  // After 10 fails, only probe every Nth tick where N grows logarithmically.
  // Use the failure count as the tick counter — `samples.length` was previously
  // used, but when we *skip* a tick we don't append to samples, so the length
  // never advances and the worker would skip every subsequent tick forever
  // (target stays "down" with no new probes). Using consecutiveFails advances
  // by one each tick a sample is recorded, which is the behavior we want.
  const stride = Math.max(2, Math.min(5, Math.floor(Math.log2(consecutiveFails))))
  return consecutiveFails % stride !== 0
}

async function probe(t: Target): Promise<Sample> {
  const start = Date.now()
  let ok = false
  let status = 0
  try {
    const res = await fetch(t.url, {
      method: 'GET',
      cf: { cacheTtl: 0 },
      signal: AbortSignal.timeout(15_000),
    })
    status = res.status
    ok = res.ok
  } catch {
    ok = false
    status = 0
  }
  return { ts: Date.now(), ok, status, latencyMs: Date.now() - start }
}

async function loadState(env: Env): Promise<ComponentState[]> {
  const targets = parseTargets(env.TARGETS)
  return Promise.all(
    targets.map(async (t) => {
      const samples = ((await env.STATUS.get(`samples:${t.name}`, 'json')) as Sample[] | null) ?? []
      return {
        name: t.name,
        status: deriveStatus(samples),
        uptime24h: uptime(samples),
        latencyP95Ms: p95Latency(samples),
        lastSample: samples[samples.length - 1] ?? null,
      }
    }),
  )
}

function deriveStatus(samples: Sample[]): ComponentState['status'] {
  const recent = samples.slice(-5)
  if (recent.length === 0) return 'operational'
  const fails = recent.filter((s) => !s.ok).length
  if (fails === recent.length) return 'major_outage'
  if (fails >= 3) return 'partial_outage'
  if (fails >= 1) return 'degraded_performance'
  return 'operational'
}

function uptime(samples: Sample[]): number {
  if (samples.length === 0) return 1
  const ok = samples.filter((s) => s.ok).length
  return ok / samples.length
}

function p95Latency(samples: Sample[]): number {
  const ok = samples.filter((s) => s.ok).map((s) => s.latencyMs)
  if (ok.length === 0) return 0
  const sorted = [...ok].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  return sorted[idx] ?? 0
}

function parseTargets(raw: string): Target[] {
  try {
    const parsed = JSON.parse(raw) as Target[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t) => typeof t.name === 'string' && typeof t.url === 'string')
  } catch {
    return []
  }
}

async function statusJson(env: Env): Promise<Response> {
  const components = await loadState(env)
  const worst = worstStatus(components.map((c) => c.status))
  const indicator = INDICATOR[worst]
  return json(
    {
      page: {
        id: 'ledgermem',
        name: 'LedgerMem',
        url: 'https://status.proofly.dev',
        time_zone: 'UTC',
        updated_at: new Date().toISOString(),
      },
      status: {
        indicator,
        description: DESCRIPTION[worst],
      },
    },
    60,
  )
}

async function componentsJson(env: Env): Promise<Response> {
  const components = await loadState(env)
  return json(
    {
      components: components.map((c) => ({
        id: c.name.toLowerCase(),
        name: c.name,
        status: c.status,
        uptime_24h: Number((c.uptime24h * 100).toFixed(3)),
        latency_p95_ms: c.latencyP95Ms,
        last_sample: c.lastSample,
      })),
    },
    30,
  )
}

const INDICATOR: Record<ComponentState['status'], string> = {
  operational: 'none',
  degraded_performance: 'minor',
  partial_outage: 'major',
  major_outage: 'critical',
}
const DESCRIPTION: Record<ComponentState['status'], string> = {
  operational: 'All systems operational',
  degraded_performance: 'Degraded performance',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
}

function worstStatus(statuses: ComponentState['status'][]): ComponentState['status'] {
  const order: ComponentState['status'][] = [
    'operational',
    'degraded_performance',
    'partial_outage',
    'major_outage',
  ]
  return statuses.reduce(
    (worst, s) => (order.indexOf(s) > order.indexOf(worst) ? s : worst),
    'operational' as ComponentState['status'],
  )
}

function json(body: unknown, maxAgeSeconds = 0): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAgeSeconds > 0 ? `public, max-age=${maxAgeSeconds}` : 'no-store',
      'access-control-allow-origin': '*',
    },
  })
}

async function renderHtml(env: Env): Promise<string> {
  const components = await loadState(env)
  const worst = worstStatus(components.map((c) => c.status))
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LedgerMem Status</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 720px; margin: 4rem auto; padding: 0 1rem; }
  .pill { display: inline-block; padding: .25rem .75rem; border-radius: 999px; font-weight: 600; }
  .pill.operational { background: #d1fae5; color: #065f46; }
  .pill.degraded_performance { background: #fef3c7; color: #92400e; }
  .pill.partial_outage { background: #fed7aa; color: #9a3412; }
  .pill.major_outage { background: #fecaca; color: #991b1b; }
  table { width: 100%; border-collapse: collapse; margin-top: 2rem; }
  th, td { text-align: left; padding: .75rem; border-bottom: 1px solid rgba(0,0,0,.08); }
  .dot { display: inline-block; width: .6rem; height: .6rem; border-radius: 50%; vertical-align: middle; margin-right: .5rem; }
  .dot.operational { background: #10b981; }
  .dot.degraded_performance { background: #f59e0b; }
  .dot.partial_outage { background: #f97316; }
  .dot.major_outage { background: #ef4444; }
  small { color: #6b7280; }
</style>
</head>
<body>
  <h1>LedgerMem Status</h1>
  <p><span class="pill ${worst}">${DESCRIPTION[worst]}</span></p>

  <table>
    <thead><tr><th>Component</th><th>Status</th><th>Uptime (24h)</th><th>p95 latency</th></tr></thead>
    <tbody>
      ${components
        .map(
          (c) => `<tr>
            <td><span class="dot ${c.status}"></span>${c.name}</td>
            <td>${DESCRIPTION[c.status]}</td>
            <td>${(c.uptime24h * 100).toFixed(2)}%</td>
            <td>${c.latencyP95Ms} ms</td>
          </tr>`,
        )
        .join('')}
    </tbody>
  </table>

  <p style="margin-top:3rem"><small>Probed every 60 seconds. <a href="/api/v2/status.json">JSON</a> · <a href="/api/v2/components.json">components.json</a> · <a href="https://proofly.dev">proofly.dev</a></small></p>
</body>
</html>`
}
