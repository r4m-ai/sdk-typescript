// Hand-written, copied in by scripts/generate-sdks.sh (see wait.ts for why).
//
// The generated client parses a 2xx response by its Content-Type, so a 2xx
// that is not JSON — an HTML sign-in page the request was redirected to, a
// proxy's "OK" page, a captive portal — comes back as a string in `data`
// with no `error`. Code that then reads `data.data` sees `undefined` and has
// nothing to go on. This guard turns that into an error that names the
// status, the final URL and what came back, so the cause is visible.

import type { Client } from "./client";
import { client as defaultClient } from "./client.gen";

/** A 2xx response whose body is not the JSON the API promises. */
export class UnexpectedResponseError extends Error {
	readonly status: number;
	/** Where the body came from — after redirects, so it can differ from the request. */
	readonly url: string;
	readonly contentType: string | null;
	/** The first bytes of the body, for the log line. */
	readonly bodyPreview: string;

	constructor(response: Response, bodyPreview: string, hint: string | null) {
		const contentType = response.headers.get("content-type");
		super(
			[
				`Expected JSON from the API but received ${contentType ?? "no content type"} (HTTP ${response.status}) from ${response.url || "the request URL"}.`,
				hint,
			]
				.filter(Boolean)
				.join(" "),
		);
		this.name = "UnexpectedResponseError";
		this.status = response.status;
		this.url = response.url;
		this.contentType = contentType;
		this.bodyPreview = bodyPreview;
	}
}

const PREVIEW_BYTES = 160;

function isJson(contentType: string | null): boolean {
	if (!contentType) return false;
	const type = contentType.split(";")[0].trim().toLowerCase();
	return type === "application/json" || type.endsWith("+json");
}

function hintFor(
	response: Response,
	request: Request | undefined,
): string | null {
	if (!response.url || !request) return null;
	try {
		const landed = new URL(response.url);
		const asked = new URL(request.url);
		if (landed.hostname !== asked.hostname) {
			return `The request to ${asked.hostname} was redirected to ${landed.hostname}: the deployment is probably behind an authentication wall that API clients cannot pass (for Vercel Deployment Protection, send the x-vercel-protection-bypass header).`;
		}
	} catch {
		// Not URLs we can compare; no hint.
	}
	return null;
}

/**
 * The error for a 2xx response that is not JSON, or null when the response
 * is fine (JSON, or legitimately empty). Reads the body of a clone only.
 */
export async function unexpectedResponseProblem(
	response: Response,
	request?: Request,
): Promise<UnexpectedResponseError | null> {
	if (!response.ok) return null;
	if (response.status === 204 || response.headers.get("content-length") === "0")
		return null;
	if (isJson(response.headers.get("content-type"))) return null;
	let preview = "";
	try {
		preview = (await response.clone().text()).slice(0, PREVIEW_BYTES);
	} catch {
		// A body that cannot be read is reported without a preview.
	}
	return new UnexpectedResponseError(
		response,
		preview,
		hintFor(response, request),
	);
}

const guarded = new WeakSet<object>();

/**
 * Installs the guard on a client as a response interceptor: a 2xx that is
 * not JSON is rejected with UnexpectedResponseError, which the client then
 * returns as `error` (or throws, with `throwOnError`). Idempotent.
 */
export function guardResponses(client: Client): Client {
	if (guarded.has(client)) return client;
	guarded.add(client);
	client.interceptors.response.use(async (response, request) => {
		const problem = await unexpectedResponseProblem(response, request);
		if (problem) throw problem;
		return response;
	});
	return client;
}

// The default client exported from the package root gets the guard as soon
// as the package is imported; createClient() guards its own instance.
guardResponses(defaultClient);
