#!/usr/bin/env node
// -*- mode: javascript -*-
// AGENT-OWNED (NOT under scripts/locked/): chooses the cheapest usable code
// model for mechanical subtask delegation and verifies it actually answers.
//
// Why it exists: the frozen implement step runs opencode on only the base
// model. AGENTS.md lets the agent delegate mechanical work to a subagent on a
// cheaper model, but opencode only routes to a model id that is REGISTERED in
// the x402gate provider's models map (project .opencode/opencode.json). This
// script resolves the tension by picking the candidate with the lowest blended
// price from live pricing and smoke-checking it through the local payment proxy
// before returning it — "registering is not using" (AGENTS.md): a model the
// proxy does not actually serve must never be delegated to.
//
// Live pricing source: OpenRouter's public model catalogue
// (GET https://openrouter.ai/api/v1/models). No credentials needed, and the
// proxy / x402gate has no model-list endpoint, so OpenRouter is the one neutral
// place that lists both the cheap candidates and their per-token prices.
//
// Output (stdout), one shell-assignable line each:
//   DELEGATE_MODEL=<model server id, e.g. deepseek/deepseek-v4-flash-0731>
//   DELEGATE_AGENT=cheap-delegate
//   DELEGATE_PRICE=<blended USD per token>
// Exit code 0 only when a verified model was found AND an agent file exists at
// .opencode/agents/cheap-delegate.md pinning that same model. On any failure it
// prints a reason to stderr and exits nonzero (the caller — the agent — then
// simply continues on the base model: delegation is a cost optimization, never
// a hard dependency).

import { readFile, access } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const PROXY_BASE = process.env.PROXY_BASE;
const BASE_MODEL = (process.env.INFERENCE_MODEL || "")
  .split(",")[0]
  .trim() || "~deepseek/deepseek-v4-flash-latest";

// The allowlist the pick is drawn from: coding-capable models that are cheap
// enough to be worth delegating mechanical work to, expressed by server id
// (OpenRouter ids work verbatim through the proxy). A candidate that is not
// listed cannot be picked no matter how cheap it gets — this keeps the decision
// inside a curated set rather than trusting live prices for an arbitrary model.
// ~deepseek/deepseek-v4-flash-latest (the base) is deliberately absent: the
// base model does the planning/review; delegation exists to spend LESS.
const ALLOWLIST = [
  "deepseek/deepseek-v4-flash-0731",
  "qwen/qwen3-coder-flash",
  "qwen/qwen3-coder-30b-a3b-instruct",
  "openai/gpt-5-mini",
];

const OR_MODELS = "https://openrouter.ai/api/v1/models";

function blended(p) {
  const input = Number(p.prompt ?? 0);
  const output = Number(p.completion ?? 0);
  if (!(input >= 0 && output >= 0)) return Infinity;
  // Mechanical work is ~small requests, dominated by output tokens.
  return input * 0.4 + output * 0.6;
}

async function fetchPricing() {
  const res = await fetch(OR_MODELS, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`OpenRouter models list ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(list)) throw new Error("unexpected OpenRouter response shape");
  return list;
}

function indexPricing(list) {
  const byId = new Map();
  for (const m of list) if (m?.id) byId.set(m.id, m);
  return byId;
}

async function statMtimeMs(p) {
  try {
    const st = await access(p).then(() => import("node:fs").then((fs) => fs.statSync(p)));
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

async function fetchPricingCached() {
  // A tiny on-disk cache so a run that consults pricing repeatedly does not
  // re-download the ~140KB catalogue every time. Path: repo-local tmp.
  const cache = path.join(process.env.RUNNER_TEMP || "/tmp", "longlive-opencode-models.json");
  const mtime = await statMtimeMs(cache);
  if (mtime > 0 && Date.now() - mtime < 15 * 60 * 1000) {
    try {
      return JSON.parse(readFileSync(cache, "utf8"));
    } catch {}
  }
  const data = await fetchPricing();
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(cache, JSON.stringify(data));
  } catch {}
  return data;
}

async function verifyModel(model) {
  if (!PROXY_BASE) throw new Error("PROXY_BASE env is required to verify a model");
  const res = await fetch(`${PROXY_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
      max_tokens: 8,
      stream: false,
    }),
  });
  if (res.status !== 200) {
    const t = await res.text();
    throw new Error(`proxy smoke ${model} → HTTP ${res.status}: ${t.slice(0, 120)}`);
  }
  const json = await res.json().catch(() => ({}));
  return (json.choices?.[0]?.message?.content || "").trim();
}

function modelRoutable(byId, id) {
  const m = byId.get(id);
  if (!m) return false;
  const p = m.pricing || {};
  return Number(p.prompt) >= 0 && Number(p.completion) >= 0;
}

async function main() {
  let byId;
  try {
    byId = indexPricing(await fetchPricingCached());
  } catch (e) {
    // No catalogue → no live choice. Exit nonzero so the agent knows
    // delegation-on-a-cheaper-model cannot be verified today.
    console.error(`model-pricing: no live pricing: ${e.message}`);
    process.exit(2);
  }

  const candidates = ALLOWLIST
    .filter((id) => modelRoutable(byId, id))
    .map((id) => ({ id, price: blended(byId.get(id).pricing) }))
    .filter((c) => Number.isFinite(c.price))
    .sort((a, b) => a.price - b.price);

  if (candidates.length === 0) {
    console.error("model-pricing: no allowlisted model routable in the catalogue");
    process.exit(3);
  }

  // Verify cheapest first; if the proxy cannot serve it, fall to the next.
  let chosen = null;
  for (const c of candidates) {
    try {
      await verifyModel(c.id);
      chosen = c;
      break;
    } catch (e) {
      console.error(`model-pricing: verified ${c.id} FAILED, next: ${e.message}`);
    }
  }

  if (!chosen) {
    console.error("model-pricing: no allowlisted model verified through the proxy");
    process.exit(4);
  }

  // The committed .opencode/agents/cheap-delegate.md must pin the SAME model id
  // the pricing script chose — otherwise opencode refuses the delegation
  // ("model not found") and the feature would be a lie. This is the "registering
  // is not using" check worn as a second pair of eyes.
  const agentFile = path.join(ROOT, ".opencode", "agents", "cheap-delegate.md");
  let pinned = null;
  try {
    const text = readFileSync(agentFile, "utf8");
    const mm = text.match(/^model:\s*x402gate\/(\S+)\s*$/m);
    if (mm) pinned = mm[1];
  } catch {}

  if (pinned !== chosen.id) {
    console.error(
      `model-pricing: chose ${chosen.id} but .opencode/agents/cheap-delegate.md pins ${pinned} — fix the agent file (or allowlist) before delegating`,
    );
    process.exit(5);
  }

  process.stdout.write(`DELEGATE_MODEL=${chosen.id}\n`);
  process.stdout.write("DELEGATE_AGENT=cheap-delegate\n");
  process.stdout.write(`DELEGATE_PRICE=${chosen.price}\n`);
}

main().catch((e) => {
  console.error(`model-pricing: ${e.message}`);
  process.exit(1);
});