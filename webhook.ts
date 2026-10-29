// Hand-written, copied in by scripts/generate-sdks.sh. See wait.ts for why
// this cannot live in the generated tree.
//
// Webhook verification is the one piece of integration code where a mistake is
// a security hole rather than a bug, so we ship it rather than describing it.
// The three ways to get it wrong by hand:
//
//   1. Comparing digests with `===`, which leaks the answer through timing.
//   2. Verifying re-serialised JSON instead of the bytes we signed — key order
//      and whitespace differ, so it never matches, and the usual "fix" is to
//      stop verifying.
//   3. Node's `timingSafeEqual` throws RangeError on unequal lengths, so a
//      short signature from an attacker turns a 401 into a 500.

import type { OptimizationResult } from "./types.gen";

/** An optimization finished; `result` is the plan. */
export type OptimizationCompletedEvent = {
	type: "optimization.completed";
	optimizationId: string;
	result: OptimizationResult;
};

/** An optimization failed; there is no plan, only why. */
export type OptimizationFailedEvent = {
	type: "optimization.failed";
	optimizationId: string;
	error: {
		/**
		 * `NO_ROUTES` — the engine produced no routes; the charge was refunded.
		 * `PROCESSING_FAILED` — the job threw; the charge was refunded.
		 * `TIMED_OUT` — it did not finish within 15 minutes; the charge was
		 * refunded and its concurrency slot released.
		 *
		 * Widened to string so a code we add later does not break your build;
		 * the three above are the ones that exist today.
		 */
		code: "NO_ROUTES" | "PROCESSING_FAILED" | "TIMED_OUT" | (string & {});
		message: string;
	};
};

/**
 * The body we POST to your `webhookUrl`, discriminated on `type`.
 *
 * Switch on `type` and TypeScript narrows the rest: `result` exists on the
 * completed branch, `error` on the failed one. Neither is optional, so there
 * is no branch where you have to guess which field is present.
 */
export type WebhookEvent = OptimizationCompletedEvent | OptimizationFailedEvent;

/** Header carrying the HMAC-SHA256 hex digest of the raw body. */
export const WEBHOOK_SIGNATURE_HEADER = "X-Webhook-Signature";

/** The signature did not match. Treat as hostile: reject with a 401. */
export class WebhookSignatureError extends Error {
	constructor(message = "Webhook signature did not match") {
		super(message);
		this.name = "WebhookSignatureError";
	}
}

/** Constant-time string compare. Length is not secret; content is. */
function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Verify a delivery and return its parsed body.
 *
 * Pass the `Request` itself and the secret — the header name and the raw body
 * are ours to know:
 *
 * ```ts
 * const event = await verifyWebhook(request, process.env.R4M_WEBHOOK_SECRET!);
 *
 * if (event.type === "optimization.failed") {
 *   console.error(event.error.code, event.error.message);
 *   return new Response(null, { status: 204 });
 * }
 * console.log(event.result.routes.length);
 * ```
 *
 * On a runtime without a `Request` (Express and friends), pass the pieces
 * instead — the **raw** body, exactly the bytes you received, not an object
 * you have already parsed and re-stringified. That is what was signed.
 *
 * ```ts
 * const event = await verifyWebhook({
 *   body: rawBody,
 *   signature: req.header(WEBHOOK_SIGNATURE_HEADER) ?? "",
 *   secret: process.env.R4M_WEBHOOK_SECRET!,
 * });
 * ```
 *
 * Returns the typed event on success and throws {@link WebhookSignatureError}
 * otherwise, so an unverified payload cannot reach your handler by accident: a
 * boolean is easy to ignore, a thrown error is not.
 *
 * Uses WebCrypto rather than `node:crypto`, so the SDK stays usable on edge
 * runtimes.
 */
export async function verifyWebhook(
	request: Request,
	secret: string,
): Promise<WebhookEvent>;
export async function verifyWebhook(options: {
	body: string;
	signature: string;
	secret: string;
}): Promise<WebhookEvent>;
export async function verifyWebhook(
	source: Request | { body: string; signature: string; secret: string },
	secret?: string,
): Promise<WebhookEvent> {
	const options = isRequest(source)
		? {
				body: await source.text(),
				signature: source.headers.get(WEBHOOK_SIGNATURE_HEADER) ?? "",
				secret: requireSecret(secret),
			}
		: source;

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(options.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const expected = toHex(
		await crypto.subtle.sign("HMAC", key, encoder.encode(options.body)),
	);

	if (!timingSafeEqualHex(expected, options.signature)) {
		throw new WebhookSignatureError();
	}

	return JSON.parse(options.body) as WebhookEvent;
}

/**
 * Duck-typed rather than `instanceof Request`: a Request built in another
 * realm — a test harness, a polyfill, a framework wrapper — fails the
 * instanceof check while behaving exactly like one.
 */
function isRequest(source: Request | { body: string }): source is Request {
	return (
		typeof (source as Request).text === "function" &&
		typeof (source as Request).headers?.get === "function"
	);
}

function requireSecret(secret: string | undefined): string {
	if (!secret) {
		throw new TypeError(
			"verifyWebhook(request, secret): the webhook secret is required",
		);
	}
	return secret;
}
