#!/usr/bin/env node
/**
 * FROZEN — Cloudflare record upsert. Points the app's hostname at a VPS IP, and
 * parks a wildcard CNAME on the apex so every subdomain follows it.
 * Used by migrate-vps.mjs to cut traffic over to a freshly provisioned box.
 *
 * Cloudflare is the ONLY supported DNS provider and it is mandatory: there is no
 * other-registrar path and no operator-managed fallback. A domain deploy without
 * CF_API_TOKEN / CF_ZONE_ID is a hard error, not a "repoint it by hand" warning —
 * migration cuts traffic over unattended, so a DNS write it cannot perform must
 * stop the run rather than silently leave the record on a box about to be
 * destroyed. (Free sslip.io hostnames resolve from the IP itself and involve no
 * DNS records at all; callers skip this module entirely for those.)
 *
 * The credential is a zone-scoped API token (DNS:Edit on one zone), deliberately
 * not an account-global key, so what leaks from Actions can only touch this zone.
 *
 * Env:  CF_API_TOKEN   zone-scoped Cloudflare token (DNS:Edit)
 *       CF_ZONE_ID     the zone the record lives in
 * CLI:  node dns.mjs <name> <ip>   e.g. node dns.mjs longlivethis.site 1.2.3.4
 */
const API = 'https://api.cloudflare.com/client/v4'

const MISSING_ENV =
  'CF_API_TOKEN and CF_ZONE_ID are required — Cloudflare is the only supported DNS provider. ' +
  'Mint a zone-scoped token with the "Edit zone DNS" template and store both as GitHub Secrets.'

function cfEnv() {
  assertDnsConfigured()
  return { token: process.env.CF_API_TOKEN.trim(), zoneId: process.env.CF_ZONE_ID.trim() }
}

async function cf(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    const msg = (data.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ') || res.status
    throw new Error(`Cloudflare ${method} ${path} failed: ${msg}`)
  }
  return data.result
}

/**
 * Throw unless the Cloudflare credentials are present. Every entry point below
 * calls this, so no code path can reach the API half-configured; callers run it
 * directly as a preflight to fail a workflow before it spends money on a box.
 */
export function assertDnsConfigured() {
  if (!process.env.CF_API_TOKEN?.trim() || !process.env.CF_ZONE_ID?.trim()) {
    throw new Error(MISSING_ENV)
  }
}

/**
 * Whether the token can READ the zone object, not just edit records within it.
 *
 * Editing an A record needs only DNS:Edit, but lego's Cloudflare provider first
 * resolves the zone by name to write the DNS-01 challenge, which needs Zone:Read.
 * Cloudflare's "Edit zone DNS" template bundles both, so this passes for most
 * tokens — but a hand-scoped DNS:Edit-only token edits DNS fine and fails ACME,
 * which is a confusing pair of symptoms worth naming explicitly.
 */
export async function canReadZone() {
  try {
    const { token, zoneId } = cfEnv()
    await cf(token, 'GET', `/zones/${zoneId}`)
    return { ok: true, error: '' }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/**
 * The current A record for `name` as `{ ip, proxied }`, or null if there is none.
 *
 * `ip` is the record's content — the ORIGIN address, even when the record is
 * proxied (the orange cloud changes what public DNS answers, not what the record
 * stores). So this is the authoritative answer to "which box is serving this
 * domain right now", where a plain DNS lookup would return Cloudflare's edge.
 */
export async function getA(name) {
  const { token, zoneId } = cfEnv()
  const rec = await cf(token, 'GET', `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`)
  if (!Array.isArray(rec) || !rec.length) return null
  return { ip: rec[0].content ?? '', proxied: Boolean(rec[0].proxied) }
}

/**
 * Point the A record for `name` at `ip`. Idempotent. Only the IP changes — the
 * existing record's `proxied` flag is PRESERVED (flipping the orange cloud would
 * change the TLS topology mid-cutover and can break it).
 *
 * A brand-new record is created DNS-only, matching create-longlive's `upsertA`
 * (src/lib/dns.ts) so the record is born the same way whichever side makes it:
 * Caddy needs a clean HTTP-01 challenge and end-to-end TLS, and a fresh zone's
 * default "Flexible" SSL mode behind the proxy would talk plain HTTP to an origin
 * that only redirects to :443. Turning the proxy on later is preserved by the
 * branch above. Cloudflare forces ttl=1 ("auto") on proxied records, so honour it.
 */
export async function upsertA(name, ip, { proxied } = {}) {
  const { token, zoneId } = cfEnv()
  const existing = await cf(token, 'GET', `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`)
  const prev = Array.isArray(existing) && existing.length ? existing[0] : null
  const isProxied = proxied ?? prev?.proxied ?? false
  const record = { type: 'A', name, content: ip, proxied: isProxied, ttl: isProxied ? 1 : 120 }
  if (prev) {
    return cf(token, 'PUT', `/zones/${zoneId}/dns_records/${prev.id}`, record)
  }
  return cf(token, 'POST', `/zones/${zoneId}/dns_records`, record)
}

/**
 * Point a wildcard CNAME at the apex, so EVERY subdomain resolves to whatever
 * box the apex currently names. Idempotent.
 *
 * A CNAME, not an A record, and that is the whole point: it targets the apex
 * NAME rather than an IP, so a migration that repoints the apex A record drags
 * every subdomain along with it. Nothing here has to be re-run on cutover and
 * migrate-vps.mjs never has to learn which subdomains exist.
 *
 * This is what lets the agent add a vhost on its own. Caddy gets the cert for a
 * named site block over HTTP-01 — which Cloudflare forwards to the origin — so a
 * new subdomain needs a Caddyfile edit and nothing else. DNS is not a resource
 * the agent has to reach.
 *
 * Proxied to match the apex: the Caddyfile's origin-pull `client_auth` block
 * rejects any connection that did not come through Cloudflare, so a DNS-only
 * (grey cloud) record would resolve and then fail the TLS handshake. Cloudflare's
 * Universal SSL covers `*.zone` at the edge — one level only, which is all a
 * single wildcard record answers for anyway.
 *
 * A subdomain with no vhost fails the origin handshake and surfaces as a
 * Cloudflare 526. That is the accepted cost of not maintaining a wildcard origin
 * cert (stock Caddy renews over HTTP-01, which cannot renew a wildcard).
 */
export async function upsertWildcardCname(apex) {
  const { token, zoneId } = cfEnv()
  const name = `*.${apex}`
  const existing = await cf(token, 'GET', `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`)
  const prev = Array.isArray(existing) && existing.length ? existing[0] : null
  const record = { type: 'CNAME', name, content: apex, proxied: true, ttl: 1 }
  if (prev) {
    return cf(token, 'PUT', `/zones/${zoneId}/dns_records/${prev.id}`, record)
  }
  return cf(token, 'POST', `/zones/${zoneId}/dns_records`, record)
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const [name, ip] = process.argv.slice(2)
  if (!name || !ip) {
    console.error('usage: node dns.mjs <name> <ip>')
    process.exit(1)
  }
  upsertA(name, ip)
    .then((r) => {
      console.log(`DNS: ${name} A → ${ip} (${r?.id ?? 'ok'})`)
    })
    .catch((err) => {
      console.error(`::error::${err.message}`)
      process.exit(1)
    })
}
