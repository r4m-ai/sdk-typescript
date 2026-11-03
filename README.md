# @r4mai/sdk

Official TypeScript client for the [r4m.ai](https://r4m.ai) route
optimization API: the optimal driving order for a list of stops on real
roads, with delivery windows, service times and fleets, plus geocoding.

Generated from the r4m.ai OpenAPI spec with
[`@hey-api/openapi-ts`](https://heyapi.dev), so every request and response is
typed. Do not edit by hand — changes are overwritten on regeneration.

## Install

```bash
npm install @r4mai/sdk
```

You need an API key (`acc_…`): sign in at [r4m.ai](https://r4m.ai) and create
one under API Keys. A new account starts with a $1.00 balance.

## Optimize a route

```ts
import { createClient } from "@r4mai/sdk";

const r4m = createClient({ apiKey: process.env.R4M_API_KEY! });

const addresses = [
  { address: "350 5th Ave, New York, NY", isDepot: true },
  { address: "11 Wall St, New York, NY" },
  { address: "89 E 42nd St, New York, NY" },
  { address: "200 Eastern Pkwy, Brooklyn, NY" },
];

// Submits, waits for the solver (usually 2–60 seconds) and returns the
// finished plan. Addresses without lat/lng are geocoded in the same call.
const optimization = await r4m.createOptimizationAndWaitForRoutes({
  body: {
    addresses,
    parameters: { roundTrip: true },
  },
});

const [route] = optimization.result!.routes;
for (const stop of route.waypoints) {
  console.log(addresses[stop.index].address);
}
console.log(
  `${(route.totalDistanceMeters / 1000).toFixed(1)} km,`,
  `${Math.round(route.totalTimeSeconds / 60)} min`,
);
```

`waypoints` is the driving order; each `index` points back into the
`addresses` you sent. `routes` is always an array — one route per vehicle, a
single entry for an ordinary run.

**Always check `result.unroutedStops`.** A stop listed there could not be
fitted (usually a delivery window no route can reach) and is not in the plan.

## Delivery windows and service time

Windows are local times of day, so they need `routeStartAt` and `timezone`.
A stop must finish inside its window, service time included.

```ts
const planned = await r4m.createOptimizationAndWaitForRoutes({
  body: {
    addresses: [
      { address: "350 5th Ave, New York, NY", isDepot: true },
      {
        address: "11 Wall St, New York, NY",
        timeWindowStart: "09:00",
        timeWindowEnd: "11:00",
        serviceTimeSeconds: 600,
      },
      { address: "89 E 42nd St, New York, NY", serviceTimeSeconds: 300 },
    ],
    parameters: {
      routeStartAt: "2026-04-14T08:00",
      timezone: "America/New_York",
    },
  },
});

for (const stop of planned.result!.routes[0].waypoints) {
  console.log(stop.index, stop.arrivalAt, stop.departureAt);
}
console.log("not scheduled:", planned.result!.unroutedStops);
```

## Plain addresses and geocoding

An address sent without `lat`/`lng` is geocoded first, at the geocoding
price, and must resolve to exactly one precise place. Set `geocoding.region`
to rule out homonyms elsewhere (`"Springfield, MO"`, `"Berlin, Germany"`):

```ts
await r4m.createOptimizationAndWaitForRoutes({
  body: {
    addresses: [
      { address: "1 Main St", isDepot: true },
      { address: "200 Oak Ave" },
      { address: "45 Elm St" },
    ],
    geocoding: { region: "Springfield, MO" },
  },
});
```

To geocode on its own — say, to show candidates before optimizing:

```ts
const { data } = await r4m.bulkGeocode({
  body: { addresses: ["350 5th Ave, New York, NY", "11 Wall St, New York"] },
});
console.log(data?.data);
```

## Errors

```ts
import {
  BusyError,
  OptimizationFailedError,
  OptimizationTimeoutError,
} from "@r4mai/sdk";

try {
  await r4m.createOptimizationAndWaitForRoutes({ body: { addresses } });
} catch (err) {
  if (err instanceof OptimizationFailedError) {
    // The solver ran and failed; the message says why.
  } else if (err instanceof OptimizationTimeoutError) {
    // Still running at the deadline (`timeoutMs`, 5 minutes by default) —
    // it keeps running; collect it later with r4m.waitForRoutes(id).
  } else if (err instanceof BusyError) {
    // Rate limit or plan concurrency for longer than `busyTimeoutMs`.
  } else {
    // A refused request, with the server's message: an empty balance
    // (402 INSUFFICIENT_FUNDS), an address that did not resolve
    // (422 GEOCODING_UNRESOLVED), a plan limit, an invalid body.
    throw err;
  }
}
```

## Webhooks instead of waiting

Pass a public `webhookUrl` and collect the plan when it arrives. Every
delivery is signed with your account's webhook secret
(`r4m.getWebhookSecret()` or the console); `verifyWebhook` checks the
signature and returns the typed event:

```ts
import { verifyWebhook } from "@r4mai/sdk";

const receipt = await r4m.submitOptimization({
  body: { addresses, webhookUrl: "https://your-server.com/webhooks/r4m" },
});
console.log(receipt.id, receipt.status); // "pending"

// In your webhook handler (any framework with a Fetch-API Request):
export async function POST(request: Request) {
  const event = await verifyWebhook(request, process.env.R4M_WEBHOOK_SECRET!);
  if (event.type === "optimization.completed") {
    console.log(event.optimizationId, event.result.routes);
  } else {
    console.error(event.optimizationId, event.error.code, event.error.message);
  }
  return new Response(null, { status: 204 });
}
```

## Waiting and busy

The client's helpers:

- `createOptimizationAndWaitForRoutes` — submit and return the finished plan.
- `waitForRoutes(id)` — wait on an id you already have.
- `submitOptimization` — submit and return the receipt (a webhook brings the plan).
- `waitForActiveOptimizations` — resolve once nothing of yours is running.

Every helper treats a `429` as "busy" — the per-minute `RATE_LIMITED` and the
plan's `CONCURRENCY_LIMIT_EXCEEDED` alike — and waits it out for up to
`busyTimeoutMs` (2 minutes), honouring `Retry-After`. Pass `onBusy` to decide
per event: it is synchronous and returns `"wait"` or `"fail"`; once
`event.timedOut` is set only `"fail"` is honoured.

## Every endpoint

The client also carries every API operation, typed: `getAccount`,
`getUsage`, `listOptimizations`, `getOptimization`, `deleteOptimization`,
`forwardGeocode`, `bulkGeocode`, `createApiKey`, `listApiKeys`,
`revokeApiKey`, `getWebhookSecret`, `topupCredits`. Each returns
`{ data, error, response }`; the payload is `data.data`.

```ts
const { data } = await r4m.getUsage();
console.log(data?.data.balanceMicros); // integer micro-dollars: 1 USD = 1 000 000
```

The same functions are exported standalone for code that manages its own
client configuration (`baseUrl` plus your raw `acc_…` key as `auth`).

Full reference: [r4m.ai/docs/sdks](https://r4m.ai/docs/sdks).

## License

MIT
