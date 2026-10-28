// Hand-written, copied in by scripts/generate-sdks.sh. It is NOT generated —
// the generator wipes sdks/typescript/ on every run, so this file lives in
// scripts/sdk-templates/typescript/ and is copied back afterwards.
//
// Everything here sits ON TOP of the generated calls; nothing is shadowed.
// `createOptimization` keeps returning a receipt, so setting a `webhookUrl`
// and waiting, or setting one and polling yourself, all stay legal — the
// delivery modes are deliberately not mutually exclusive.

import {
	type Client,
	createConfig,
	createClient as createFetchClient,
	type TDataShape,
} from "./client";
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
	ListApiKeysData,
	ListOptimizationsData,
	Optimization,
	RevokeApiKeyData,
	TopupCreditsData,
} from "./types.gen";

/** Production host, baked in at generation time. */
export const DEFAULT_BASE_URL = "https://r4m.ai";

/**
 * Per-call options with the client removed — the client is already bound.
 *
 * `ThrowOnError` is pinned to `false` rather than left at its `boolean`
 * default. Left open, inference widened every result to "either the throwing
 * shape or the returning one", so `const { data, error } = await ...` no
 * longer narrowed and `error` vanished from the type. Callers who want the
 * throwing behaviour can use the standalone functions with `client: r4m.http`.
 */
type Bound<TData extends TDataShape> = Omit<Options<TData, false>, "client">;

/**
 * Build a client for your account. Nothing is sent — this only holds your
 * credentials until the first call.
 *
 * Every operation hangs off the returned object, so there is no separate
 * configuration step to forget: without a client there is nothing to call.
 * (The generated standalone functions are still exported for tree-shaking, and
 * take a `client` of their own.)
 *
 * `baseUrl` is optional and normally omitted. Set it to reach a staging
 * deployment.
 */
export function createClient(options: { apiKey: string; baseUrl?: string }) {
	const bound: Client = createFetchClient(
		createConfig<ClientOptions>({
			baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
			auth: options.apiKey,
		}),
	);

	return {
		bulkGeocode: (o: Bound<BulkGeocodeData>) =>
			operations.bulkGeocode({ ...o, client: bound }),
		createApiKey: (o: Bound<CreateApiKeyData>) =>
			operations.createApiKey({ ...o, client: bound }),
		createOptimization: (o: Bound<CreateOptimizationData>) =>
			operations.createOptimization({ ...o, client: bound }),
		deleteOptimization: (o: Bound<DeleteOptimizationData>) =>
			operations.deleteOptimization({ ...o, client: bound }),
		forwardGeocode: (o: Bound<ForwardGeocodeData>) =>
			operations.forwardGeocode({ ...o, client: bound }),
		getAccount: (o?: Bound<GetAccountData>) =>
			operations.getAccount({ ...o, client: bound }),
		getOptimization: (o: Bound<GetOptimizationData>) =>
			operations.getOptimization({ ...o, client: bound }),
		getUsage: (o?: Bound<GetUsageData>) =>
			operations.getUsage({ ...o, client: bound }),
		listApiKeys: (o?: Bound<ListApiKeysData>) =>
			operations.listApiKeys({ ...o, client: bound }),
		listOptimizations: (o?: Bound<ListOptimizationsData>) =>
			operations.listOptimizations({ ...o, client: bound }),
		revokeApiKey: (o: Bound<RevokeApiKeyData>) =>
			operations.revokeApiKey({ ...o, client: bound }),
		topupCredits: (o: Bound<TopupCreditsData>) =>
			operations.topupCredits({ ...o, client: bound }),

		submitOptimization: (o: Bound<CreateOptimizationData> & BusyOptions) =>
			submitOptimization({ ...o, client: bound }),
		createOptimizationAndWaitForRoutes: (
			o: Bound<CreateOptimizationData> & WaitOptions & BusyOptions,
		) => createOptimizationAndWaitForRoutes({ ...o, client: bound }),
		waitForRoutes: (id: string, o: WaitOptions & BusyOptions = {}) =>
			waitForRoutes(id, { ...o, client: bound }),
		waitForActiveOptimizations: (o: ActiveWaitOptions = {}) =>
			waitForActiveOptimizations({ ...o, client: bound }),

		/** The underlying HTTP client, for interceptors and other advanced use. */
		http: bound,
	};
}

export type WaitOptions = {
	/** Give up after this long. Default: 5 minutes. */
	timeoutMs?: number;
	/** Delay before the first re-poll, doubling up to `maxDelayMs`. Default: 1s. */
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
	initialDelayMs: 1_000,
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
		details?: { activeOptimizationIds?: unknown };
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
		if (error) {
			throw new Error(
				asErrorBody(error).error?.message ??
					"Could not create the optimization",
			);
		}
		if (!created.data) throw new Error("Could not create the optimization");
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
 * Backs off 1s, 2s, 4s, then every 5s; treats a 429 as busy (see `onBusy`);
 * and keeps going through transient network errors and 5xx, since the
 * optimization runs whether or not you stay connected.
 *
 * @throws {OptimizationFailedError} the optimization finished as `failed`
 * @throws {OptimizationTimeoutError} the deadline passed while still running
 * @throws {BusyError} busy for longer than `busyTimeoutMs`, or `onBusy` said `"fail"`
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
		if (error && status !== undefined && status < 500 && status !== 429) {
			throw new Error(
				asErrorBody(error).error?.message ??
					`Could not fetch optimization ${id}`,
			);
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
			const { data, response } = await operations.listOptimizations({
				client: options.client,
				query: { status, limit: 100 },
			});
			if (response?.status === 429) {
				retryAfter = retryAfterMs(response);
				break;
			}
			for (const item of data?.data.items ?? []) ids.push(item.id);
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
 * The object `createClient` returns.
 *
 * Derived rather than written out: spelling the methods by hand dropped
 * hey-api's `ThrowOnError` generic, which widened every result so that
 * `const { data, error } = await r4m.createOptimization(...)` stopped
 * narrowing. The runtime check that every generated operation is present
 * lives in `__tests__/unit/sdk/wait.test.ts` instead.
 */
export type R4MClient = ReturnType<typeof createClient>;
