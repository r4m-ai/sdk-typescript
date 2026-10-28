# @r4mai/sdk

Official TypeScript client for the [r4m.ai](https://r4m.ai) route optimization API.

This package is **auto-generated** from the r4m.ai OpenAPI spec with
[`@hey-api/openapi-ts`](https://heyapi.dev) and the `@hey-api/client-fetch`
runtime. Do not edit by hand — changes are overwritten on regeneration.

## Install

```bash
npm install @r4mai/sdk
```

## Usage

```ts
import { getAccount } from "@r4mai/sdk";

const { data } = await getAccount({
  baseUrl: "https://r4m.ai",
  // `auth` is your raw acc_ key — the client adds the "Bearer " prefix itself.
  auth: process.env.R4M_API_KEY,
});

console.log(data?.planTier);
```

Every endpoint is exported as a typed function. Pass `baseUrl` and your raw
`acc_…` key via the `auth` option on each call (the client formats the
`Authorization: Bearer …` header for you).

## Waiting and busy

`createClient({ apiKey })` binds the key once and adds the helpers:

- `createOptimizationAndWaitForRoutes` — submit and return the finished plan.
- `waitForRoutes(id)` — wait on an id you already have.
- `submitOptimization` — submit and return the receipt (a webhook brings the plan).
- `waitForActiveOptimizations` — resolve once nothing of yours is running.

Every helper treats a `429` as "busy" — the per-minute `RATE_LIMITED` and the
plan's `CONCURRENCY_LIMIT_EXCEEDED` alike — and waits it out for up to
`busyTimeoutMs` (2 minutes), honouring `Retry-After`. Pass `onBusy` to decide
per event: it is synchronous and returns `"wait"` or `"fail"`; once
`event.timedOut` is set only `"fail"` is honoured.

## License

MIT
