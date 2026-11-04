// Hand-written, copied in by scripts/generate-sdks.sh. It is NOT generated —
// the generator wipes sdks/typescript/ on every run, so this file lives in
// scripts/sdk-templates/typescript/ and is copied back afterwards.
//
// This is the SDK's public face; the generated calls are its internals. What
// the generator produces is shaped by its own conventions (`data.data`, a field
// per status code), which a caller should not have to learn. So every method of
// `createClient` returns a `Result`: read `error` first, and only then does the
// compiler let you at `data`.
//
// `createOptimization` keeps returning a receipt, so setting a `webhookUrl` and
// waiting, or setting one and polling yourself, all stay legal — the delivery
// modes are deliberately not mutually exclusive.

import {
	type Client,
	createConfig,
	createClient as createFetchClient,
	type TDataShape,
} from "./client";
import { guardResponses, UnexpectedResponseError } from "./guards";
import type { Options } from "./sdk.gen";
import * as operations from "./sdk.gen";
import type {
	BulkGeocodeData,
	ClientOptions,
	CreateApiKeyData,
	CreateOptimizationData,
	DeleteOptimizationData,
	ForwardGeocodeData,
	GetAccountData,
	GetOptimizationData,
	GetUsageData,
	GetWebhookSecretData,
	ListApiKeysData,
	ListOptimizationsData,
	Optimization,
	RevokeApiKeyData,
	TopupCreditsData,
} from "./types.gen";

/** Production host, baked in at generation time. */
export const DEFAULT_BASE_URL = "https://r4m.ai";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Refuse a base URL that would carry the API key over plain http. Only
 * localhost may be http, for a server running on the developer's machine.
 */
export function assertSafeBaseUrl(baseUrl: string): void {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error(`baseUrl is not a URL: ${JSON.stringify(baseUrl)}`);
	}
	if (url.protocol === "https:") return;
	if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return;
	throw new Error(
		`baseUrl must be https (got ${url.protocol}//${url.host}): an API key must never travel in clear text. Only http://localhost is allowed.`,
	);
}

/**
 * What every client method resolves to. The two shapes exclude each other, so
 * `data` cannot be read until `error` has been ruled out:
 *
 *     const { data, error } = await r4m.getAccount();
 *     data.email;            // does not compile: `data` may be undefined
 *     if (error) throw error;
 *     data.email;            // fine
 *
 * The promise itself never rejects: a refused request and a network failure
 * arrive the same way, so there is one way to handle failure, not two.
 */
export type Result<T, E extends Error = ApiError> =
	| { data: T; error: undefined }
	| { data: undefined; error: E };

/** The API refused the request, or the request never got an answer. */
export class ApiError extends Error {
	/**
	 * Machine-readable: an API error code such as `INSUFFICIENT_FUNDS`, or one of
	 * `NETWORK_ERROR`, `ABORTED`, `UNEXPECTED_RESPONSE`, `UNEXPECTED_ERROR` when
	 * the API did not get to answer.
	 */
	readonly code: string;
	/** The HTTP status; undefined when no response arrived. */
	readonly status: number | undefined;
	/** Optional machine-readable context. The message stands alone without it. */
	readonly details: Record<string, unknown> | undefined;
	/** How long the server asked us to wait, on a 429. */
	readonly retryAfterMs: number | undefined;
	/** The response body as sent, for fields outside the error envelope. */
	readonly body: unknown;

	constructor(init: {
		code: string;
		message: string;
		status?: number;
		details?: Record<string, unknown>;
		retryAfterMs?: number;
		body?: unknown;
		cause?: unknown;
	}) {
		super(init.message, { cause: init.cause });
		this.name = "ApiError";
		this.code = init.code;
		this.status = init.status;
		this.details = init.details;
		this.retryAfterMs = init.retryAfterMs;
		this.body = init.body;
	}
}

function toApiError(error: unknown, response: Response | undefined): ApiError {
	if (error instanceof UnexpectedResponseError) {
		return new ApiError({
			code: "UNEXPECTED_RESPONSE",
			message: error.message,
			status: error.status,
			cause: error,
		});
	}
	if (!response) {
		return new ApiError({
			code: "NETWORK_ERROR",
			message:
				error instanceof Error
					? error.message
					: "The request did not reach the API",
			cause: error,
		});
	}
	const body = asErrorBody(error);
	return new ApiError({
		code: body.error?.code ?? "UNEXPECTED_RESPONSE",
		message: body.error?.message ?? `The API answered HTTP ${response.status}`,
		status: response.status,
		details: body.error?.details,
		retryAfterMs: response.status === 429 ? retryAfterMs(response) : undefined,
		body: error,
	});
}

/** A generated call as a `Result`, with the `{ success, data }` envelope gone. */
async function settle<T>(
	pending: Promise<{
		data?: { data: T };
		error?: unknown;
		response?: Response;
	}>,
): Promise<Result<T>> {
	try {
		const { data, error, response } = await pending;
		if (!error && data?.data !== undefined) {
			return { data: data.data, error: undefined };
		}
		return { data: undefined, error: toApiError(error, response) };
	} catch (cause) {
		return { data: undefined, error: toApiError(cause, undefined) };
	}
}

/** A waiting helper, which throws internally, as a `Result`. */
async function settleWait<T, E extends Error>(
	run: () => Promise<T>,
	signal?: AbortSignal | null,
): Promise<Result<T, E | ApiError>> {
	try {
		return { data: await run(), error: undefined };
	} catch (cause) {
		if (
			cause instanceof ApiError ||
			cause instanceof BusyError ||
			cause instanceof OptimizationFailedError ||
			cause instanceof OptimizationTimeoutError ||
			cause instanceof ActiveOptimizationsTimeoutError
		) {
			return { data: undefined, error: cause as E | ApiError };
		}
		return {
			data: undefined,
			error: new ApiError({
				code: signal?.aborted ? "ABORTED" : "UNEXPECTED_ERROR",
				message: cause instanceof Error ? cause.message : String(cause),
				cause,
			}),
		};
	}
}

/** Per-call options with the client removed — the client is already bound. */
type Bound<TData extends TDataShape> = Omit<Options<TData, false>, "client">;

/**
 * Build a client for your account. Nothing is sent — this only holds your
 * credentials until the first call.
 *
 * Every operation hangs off the returned object, so there is no separate
 * configuration step to forget: without a client there is nothing to call.
 *
 * `baseUrl` is optional and normally omitted: the host is built in. It exists
 * for r4m.ai's own staging deployments and must be https — a plain-http URL
 * (other than localhost) would send your API key in clear text, so it is
 * refused.
 */
export function createClient(options: { apiKey: string; baseUrl?: string }) {
	const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
	assertSafeBaseUrl(baseUrl);
	const bound: Client = guardResponses(
		createFetchClient(
			createConfig<ClientOptions>({
				baseUrl,
				auth: options.apiKey,
			}),
		),
	);

	return {
		bulkGeocode: (o: Bound<BulkGeocodeData>) =>
			settle(operations.bulkGeocode({ ...o, client: bound })),
		createApiKey: (o: Bound<CreateApiKeyData>) =>
			settle(operations.createApiKey({ ...o, client: bound })),
		createOptimization: (o: Bound<CreateOptimizationData>) =>
			settle(operations.createOptimization({ ...o, client: bound })),
		deleteOptimization: (o: Bound<DeleteOptimizationData>) =>
			settle(operations.deleteOptimization({ ...o, client: bound })),
		forwardGeocode: (o: Bound<ForwardGeocodeData>) =>
			settle(operations.forwardGeocode({ ...o, client: bound })),
		getAccount: (o?: Bound<GetAccountData>) =>
			settle(operations.getAccount({ ...o, client: bound })),
		getOptimization: (o: Bound<GetOptimizationData>) =>
			settle(operations.getOptimization({ ...o, client: bound })),
		getUsage: (o?: Bound<GetUsageData>) =>
			settle(operations.getUsage({ ...o, client: bound })),
		getWebhookSecret: (o?: Bound<GetWebhookSecretData>) =>
			settle(operations.getWebhookSecret({ ...o, client: bound })),
		listApiKeys: (o?: Bound<ListApiKeysData>) =>
			settle(operations.listApiKeys({ ...o, client: bound })),
		listOptimizations: (o?: Bound<ListOptimizationsData>) =>
			settle(operations.listOptimizations({ ...o, client: bound })),
		revokeApiKey: (o: Bound<RevokeApiKeyData>) =>
			settle(operations.revokeApiKey({ ...o, client: bound })),
		topupCredits: (o: Bound<TopupCreditsData>) =>
			settle(operations.topupCredits({ ...o, client: bound })),

		submitOptimization: (o: Bound<CreateOptimizationData> & BusyOptions) =>
			settleWait<Optimization, BusyError>(
				() => submitOptimization({ ...o, client: bound }),
				o.signal,
			),
		createOptimizationAndWaitForRoutes: (
			o: Bound<CreateOptimizationData> & WaitOptions & BusyOptions,
		) =>
			settleWait<Optimization, WaitError>(
				() => createOptimizationAndWaitForRoutes({ ...o, client: bound }),
				o.signal,
			),
		waitForRoutes: (id: string, o: WaitOptions & BusyOptions = {}) =>
			settleWait<Optimization, WaitError>(
				() => waitForRoutes(id, { ...o, client: bound }),
				o.signal,
			),
		waitForActiveOptimizations: (o: ActiveWaitOptions = {}) =>
			settleWait<undefined, ActiveOptimizationsTimeoutError>(
				() =>
					waitForActiveOptimizations({ ...o, client: bound }).then(
						() => undefined,
					),
				o.signal,
			),

		/** The underlying HTTP client, for interceptors and other advanced use. */
		http: bound,
	};
}

export type WaitOptions = {
	/** Give up after this long. Default: 5 minutes. */
	timeoutMs?: number;
	/** Delay before the first re-poll, doubling up to `maxDelayMs`. Default: 2s. */
	initialDelayMs?: number;
	/** Ceiling for the poll interval. Default: 5s. */
	maxDelayMs?: number;
	/** Cancel the wait. The optimization itself keeps running. */
	signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Busy
//
// The API says "busy" with a 429 in two situations, and a client should treat
// them the same way: the per-minute rate limit (`RATE_LIMITED`) and the plan's
// optimizations-in-flight allowance (`CONCURRENCY_LIMIT_EXCEEDED`). Both carry
// `Retry-After`; the second also names the optimizations holding the slots.
// ---------------------------------------------------------------------------

export type BusyReason = "RATE_LIMITED" | "CONCURRENCY_LIMIT_EXCEEDED";

/** What to do about a busy answer: wait it out, or give up now. */
export type BusyDecision = "wait" | "fail";

export type BusyEvent = {
	reason: BusyReason;
	/** The server's own explanation. */
	message: string;
	/** How long the server asked us to wait before trying again. */
	retryAfterMs: number;
	/** 1 for the first busy answer of this call, counting up. */
	attempt: number;
	/** Time spent busy-waiting in this call so far. */
	elapsedMs: number;
	/** The optimizations holding the slots (concurrency only; empty otherwise). */
	activeOptimizationIds: string[];
	/**
	 * `busyTimeoutMs` has elapsed. From here on only `"fail"` is honoured: a
	 * `"wait"` returned after the deadline is treated as `"fail"`, because the
	 * caller already said how long busy is acceptable.
	 */
	timedOut: boolean;
};

/**
 * Called on every busy answer, synchronously: decide, and the SDK does the
 * waiting (honouring `Retry-After` and polling a named optimization first, so
 * a slot whose deadline passed is released server-side). Do not sleep here.
 * Without a callback the SDK waits until `busyTimeoutMs`, then fails.
 */
export type OnBusy = (event: BusyEvent) => BusyDecision;

export type BusyOptions = {
	onBusy?: OnBusy;
	/** How long busy is acceptable before the call fails. Default: 2 minutes. */
	busyTimeoutMs?: number;
};

/** The API was busy and the call was not allowed to keep waiting. */
export class BusyError extends Error {
	readonly reason: BusyReason;
	readonly activeOptimizationIds: string[];
	readonly timedOut: boolean;
	readonly retryAfterMs: number;

	constructor(event: BusyEvent) {
		super(
			event.timedOut
				? `Still busy (${event.reason}) after ${event.elapsedMs}ms: ${event.message}`
				: `Busy (${event.reason}): ${event.message}`,
		);
		this.name = "BusyError";
		this.reason = event.reason;
		this.activeOptimizationIds = event.activeOptimizationIds;
		this.timedOut = event.timedOut;
		this.retryAfterMs = event.retryAfterMs;
	}
}

/** The optimization finished, but the solver could not produce a plan. */
export class OptimizationFailedError extends Error {
	readonly optimization: Optimization;

	constructor(optimization: Optimization) {
		super(optimization.errorMessage ?? "Optimization failed");
		this.name = "OptimizationFailedError";
		this.optimization = optimization;
	}
}

/** The ways waiting for a plan can end without one, besides an `ApiError`. */
export type WaitError =
	| BusyError
	| OptimizationFailedError
	| OptimizationTimeoutError;

/** The wait ran out of time. The optimization is still running server-side. */
export class OptimizationTimeoutError extends Error {
	readonly optimizationId: string;

	constructor(optimizationId: string, timeoutMs: number) {
		super(
			`Timed out after ${timeoutMs}ms waiting for optimization ${optimizationId}. ` +
				"It is still being processed — fetch it later with getOptimization().",
		);
		this.name = "OptimizationTimeoutError";
		this.optimizationId = optimizationId;
	}
}

const DEFAULTS = {
	timeoutMs: 300_000,
	initialDelayMs: 2_000,
	maxDelayMs: 5_000,
	busyTimeoutMs: 120_000,
	activePollMs: 5_000,
};

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Seconds to wait per the Retry-After header (RFC 9110), or a sane fallback.
 * Honouring it matters: the limiter protects the backend, so ignoring the one
 * header that says "stop" turns a busy moment into an outage.
 */
function retryAfterMs(response: Response | undefined): number {
	const header = response?.headers.get("Retry-After");
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5_000;
}

/** The error envelope, read defensively: a 429 may arrive with any body. */
type ErrorBody = {
	error?: {
		code?: string;
		message?: string;
		details?: Record<string, unknown> & { activeOptimizationIds?: unknown };
	};
};

function asErrorBody(error: unknown): ErrorBody {
	return error !== null && typeof error === "object"
		? (error as ErrorBody)
		: {};
}

/** Per-call busy bookkeeping: when waiting started and how often it happened. */
type BusyState = { startedAt: number; attempt: number };

/**
 * One busy answer: build the event, ask the callback, then either wait as the
 * server asked or throw. Shared by every helper so a 429 means the same thing
 * whichever call met it.
 */
async function onBusyResponse(
	error: unknown,
	response: Response | undefined,
	state: BusyState,
	options: BusyOptions & {
		signal?: AbortSignal | null;
		client?: Options["client"];
	},
): Promise<void> {
	state.attempt += 1;
	const body = asErrorBody(error);
	const ids = body.error?.details?.activeOptimizationIds;
	const elapsedMs = Date.now() - state.startedAt;
	const event: BusyEvent = {
		reason:
			body.error?.code === "CONCURRENCY_LIMIT_EXCEEDED"
				? "CONCURRENCY_LIMIT_EXCEEDED"
				: "RATE_LIMITED",
		message: body.error?.message ?? "Too many requests",
		retryAfterMs: retryAfterMs(response),
		attempt: state.attempt,
		elapsedMs,
		activeOptimizationIds: Array.isArray(ids)
			? ids.filter((id): id is string => typeof id === "string")
			: [],
		timedOut: elapsedMs >= (options.busyTimeoutMs ?? DEFAULTS.busyTimeoutMs),
	};

	const decision = options.onBusy ? options.onBusy(event) : "wait";
	if (decision === "fail" || event.timedOut) throw new BusyError(event);

	// Reading one of the optimizations holding a slot is not idle curiosity:
	// that GET is what lets the server notice a slot whose deadline has passed
	// and release it. Then wait exactly as long as the server asked.
	if (event.activeOptimizationIds.length > 0) {
		await operations.getOptimization({
			client: options.client,
			path: { id: event.activeOptimizationIds[0] },
		});
	}
	await sleep(event.retryAfterMs, options.signal);
}

/**
 * Submit an optimization, waiting out "busy" answers, and return the receipt
 * (`status: "pending"`). Use this when you will collect the plan some other
 * way — a webhook, your own poller — but still want the 429s handled.
 *
 * @throws {BusyError} `onBusy` returned `"fail"`, or `busyTimeoutMs` elapsed
 * @throws {ApiError} the API refused the request
 */
export async function submitOptimization(
	options: Options<CreateOptimizationData> & BusyOptions,
): Promise<Optimization> {
	const { onBusy, busyTimeoutMs, signal, ...createOptions } = options;
	const state: BusyState = { startedAt: Date.now(), attempt: 0 };

	for (;;) {
		const created = await operations.createOptimization(createOptions);
		const error = "error" in created ? created.error : undefined;
		if (created.response?.status === 429) {
			await onBusyResponse(error, created.response, state, {
				onBusy,
				busyTimeoutMs,
				signal,
				client: createOptions.client,
			});
			continue;
		}
		if (error || !created.data) throw toApiError(error, created.response);
		return created.data.data;
	}
}

/**
 * Poll an optimization until it is finished.
 *
 * Use this when the id came from somewhere else — your own queue, a database
 * row, an earlier process. If you are submitting and waiting in one place,
 * `createOptimizationAndWaitForRoutes` does both.
 *
 * Backs off 2s, 4s, then every 5s; treats a 429 as busy (see `onBusy`);
 * and keeps going through transient network errors and 5xx, since the
 * optimization runs whether or not you stay connected.
 *
 * @throws {OptimizationFailedError} the optimization finished as `failed`
 * @throws {OptimizationTimeoutError} the deadline passed while still running
 * @throws {BusyError} busy for longer than `busyTimeoutMs`, or `onBusy` said `"fail"`
 * @throws {ApiError} the API refused the request (401, 404 and the like)
 */
export async function waitForRoutes(
	id: string,
	options: WaitOptions & BusyOptions & { client?: Options["client"] } = {},
): Promise<Optimization> {
	const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
	const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
	const deadline = Date.now() + timeoutMs;
	let delay = options.initialDelayMs ?? DEFAULTS.initialDelayMs;
	const busy: BusyState = { startedAt: Date.now(), attempt: 0 };

	while (Date.now() < deadline) {
		const { data, error, response } = await operations.getOptimization({
			client: options.client,
			path: { id },
		});

		if (response?.status === 429) {
			// Not counted against the backoff: the server named its own interval.
			await onBusyResponse(error, response, busy, options);
			continue;
		}

		// 401/404 and friends are final — retrying cannot change the answer.
		const status = response?.status;
		if (error && status !== undefined && status < 500) {
			throw toApiError(error, response);
		}

		const optimization = data?.data;
		if (optimization?.status === "completed") return optimization;
		if (optimization?.status === "failed") {
			throw new OptimizationFailedError(optimization);
		}

		// Anything else — still pending or processing, a 5xx, or a network
		// error that left `response` undefined — is worth another try.
		await sleep(delay, options.signal);
		delay = Math.min(delay * 2, maxDelayMs);
	}

	throw new OptimizationTimeoutError(id, timeoutMs);
}

/**
 * Submit an optimization and wait for the finished plan.
 *
 * Equivalent to `submitOptimization` followed by `waitForRoutes`, for the
 * common case where both happen in the same place. A `webhookUrl` may still
 * be set — you will simply be notified as well.
 */
export async function createOptimizationAndWaitForRoutes(
	options: Options<CreateOptimizationData> & WaitOptions & BusyOptions,
): Promise<Optimization> {
	const {
		timeoutMs,
		initialDelayMs,
		maxDelayMs,
		signal,
		onBusy,
		busyTimeoutMs,
		...createOptions
	} = options;

	const receipt = await submitOptimization({
		...createOptions,
		onBusy,
		busyTimeoutMs,
		signal,
	});

	return waitForRoutes(receipt.id, {
		client: createOptions.client,
		timeoutMs,
		initialDelayMs,
		maxDelayMs,
		signal,
		onBusy,
		busyTimeoutMs,
	});
}

export type ActiveWaitEvent = {
	/** How many optimizations are still pending or processing. */
	active: number;
	activeOptimizationIds: string[];
	elapsedMs: number;
	/** 1 for the first look, counting up. */
	attempt: number;
};

export type ActiveWaitOptions = {
	/** Called after every look while something is still running, for display. */
	onWait?: (event: ActiveWaitEvent) => void;
	/** Give up after this long. Default: 5 minutes. */
	timeoutMs?: number;
	/** How often to look. Default: 5s. */
	pollIntervalMs?: number;
	signal?: AbortSignal;
};

/** The account still had optimizations running when the wait ran out. */
export class ActiveOptimizationsTimeoutError extends Error {
	readonly activeOptimizationIds: string[];

	constructor(activeOptimizationIds: string[], timeoutMs: number) {
		super(
			`Timed out after ${timeoutMs}ms with ${activeOptimizationIds.length} optimization(s) still running: ${activeOptimizationIds.join(", ")}`,
		);
		this.name = "ActiveOptimizationsTimeoutError";
		this.activeOptimizationIds = activeOptimizationIds;
	}
}

/**
 * Resolve once the account has nothing pending or processing — the moment a
 * `submitOptimization` is guaranteed a free slot. Useful before a batch, or
 * when `onBusy` told you to come back later.
 *
 * @throws {ActiveOptimizationsTimeoutError} something was still running at the deadline
 * @throws {ApiError} the API refused the request
 */
export async function waitForActiveOptimizations(
	options: ActiveWaitOptions & { client?: Options["client"] } = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.activePollMs;
	const startedAt = Date.now();
	let attempt = 0;
	let lastSeen: string[] = [];

	while (Date.now() - startedAt < timeoutMs) {
		attempt += 1;
		const ids: string[] = [];
		let retryAfter: number | undefined;

		for (const status of ["pending", "processing"] as const) {
			const { data, error, response } = await operations.listOptimizations({
				client: options.client,
				query: { status, limit: 100 },
			});
			if (response?.status === 429) {
				retryAfter = retryAfterMs(response);
				break;
			}
			if (error || !data) {
				// A failed look proves nothing: read as an empty list, it would report
				// "nothing running" to a caller whose key was just revoked.
				if (response && response.status < 500) {
					throw toApiError(error, response);
				}
				retryAfter = pollIntervalMs;
				break;
			}
			for (const item of data.data.items) ids.push(item.id);
		}

		if (retryAfter === undefined) {
			if (ids.length === 0) return;
			lastSeen = ids;
			options.onWait?.({
				active: ids.length,
				activeOptimizationIds: ids,
				elapsedMs: Date.now() - startedAt,
				attempt,
			});
		}
		await sleep(retryAfter ?? pollIntervalMs, options.signal);
	}

	throw new ActiveOptimizationsTimeoutError(lastSeen, timeoutMs);
}

/**
 * The object `createClient` returns. Derived rather than written out, so the
 * types cannot drift from the methods. The runtime check that every generated
 * operation is present lives in `__tests__/unit/sdk/wait.test.ts`.
 */
export type R4MClient = ReturnType<typeof createClient>;
