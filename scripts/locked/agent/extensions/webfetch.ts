// FROZEN at init — the one extension the agent gets by default.
//
// Pi's built-in tools are read/bash/edit/write/ls/find/grep: there is no way to
// retrieve a URL, and an agent implementing a feature against an unfamiliar API
// needs to read its documentation rather than guess at it. This adds that one
// tool and nothing else.
//
// Deliberately ZERO npm dependencies. The run is sandboxed as a sudo-less user
// with no registry credentials and PI_OFFLINE set, so an extension that needed
// an install would simply fail to load — and a dependency here would be code
// running beside the agent that nobody pinned. Node's global fetch and a crude
// markup strip are enough for reading docs.
//
// This is retrieval, NOT search: it fetches a URL the agent already has. The
// agent may add its own tools — including a search tool — by committing an
// extension to .pi/extensions/ (see AGENTS.md); this file is frozen so that
// capability cannot be removed from it.
//
// Bounded on every axis a hostile or broken page could abuse: http(s) only, one
// response capped at 512KB, 30s timeout, redirects followed by fetch's own
// limit. A failure returns an error result the agent can read and work around —
// it never throws into the run.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 30_000;

/** Reduce markup to readable text. Crude on purpose — no parser dependency. */
function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "webfetch",
		label: "Fetch URL",
		description:
			"Fetch a URL and return its content as text. HTML is reduced to readable text; " +
			"other content types are returned as-is. Use it to read documentation and API " +
			"references you have a link to.",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL to fetch" }),
			raw: Type.Optional(
				Type.Boolean({ description: "Return the body unmodified instead of extracted text" }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			let url: URL;
			try {
				url = new URL(params.url);
			} catch {
				return fail(`not a valid URL: ${params.url}`);
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				return fail(`refusing ${url.protocol} — http and https only`);
			}

			// Two independent aborts: our own timeout, and the run's cancellation
			// (a killed turn must not leave a fetch running).
			const control = new AbortController();
			const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
			signal?.addEventListener("abort", () => control.abort(), { once: true });
			try {
				const res = await fetch(url, {
					signal: control.signal,
					redirect: "follow",
					headers: {
						"user-agent": "longlive-agent-webfetch/1",
						accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
					},
				});
				const buf = await res.arrayBuffer();
				const truncated = buf.byteLength > MAX_BYTES;
				const body = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, MAX_BYTES));
				const type = res.headers.get("content-type") ?? "";
				const text = params.raw || !/html/i.test(type) ? body : htmlToText(body);
				const header =
					`${res.status} ${res.statusText} ${type} ${buf.byteLength} bytes` +
					`${truncated ? ` (truncated to ${MAX_BYTES})` : ""}\n\n`;
				return {
					content: [{ type: "text", text: header + text }],
					isError: !res.ok,
					details: { status: res.status, url: url.toString() },
				};
			} catch (err) {
				const why = control.signal.aborted
					? `aborted after ${TIMEOUT_MS}ms`
					: String((err as Error)?.message ?? err);
				return fail(`${url} failed — ${why}`);
			} finally {
				clearTimeout(timer);
			}
		},
	});
}

function fail(message: string) {
	return { content: [{ type: "text" as const, text: `webfetch: ${message}` }], isError: true, details: {} };
}
