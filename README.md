# fail-open-scorer

**A client for an ML scoring service that can never take the product down with it.** When a recommendation request
asks a separate model service to score its candidates, that call sits in the user's request path. If the service is
slow, down, returns garbage or returns plausible-looking garbage, the user should still get their result, just without
the model's opinion. This client guarantees that: it never throws, it never waits past its timeout, and every failure
comes back as a status with no scores.

It is the client GabbleGrid (an AI-engineering coach) uses to ask its ranking model to score the items in a learning
plan. This repository is a **read-only copy** of it, published unchanged. See `PUBLISHED_FROM` for the exact commit.

## What it does

`scorePlan(request)` makes one batched call per plan and always resolves, within about the timeout (80 ms by default),
to one of:

| Status | Meaning |
|---|---|
| `ok` | Scores, keyed by `slot:item_id`. Items the service listed as `missing` get no score. |
| `off` / `unconfigured` | The feature flag is off, or no service URL is set. No network call. |
| `timeout` | The timeout fired. The client stops waiting even if `fetch` ignores the abort signal: the abort also races the call. |
| `error` | Non-200, network failure, or a body that never arrives. |
| `breaker_open` | Recent calls kept failing, so this one is skipped without touching the network. |
| `rejected:<why>` | The service answered, but the answer can't be trusted, so it is dropped for the whole request. |

**The contract is checked, then sanity-checked.** The response is parsed against a zod schema (`score.v1.ts`; the
model service holds a copy of the same example request and response). A response that parses can still be wrong, so the whole response
is rejected when:
- its `request_id` is not the one sent (`rejected:request_id`);
- none of the scored pairs match a slot and item that were asked for (`rejected:empty`);
- a score or probability falls outside [0, 1], or a duration ratio is not positive (`rejected:range`);
- every score is the same, to within 0.001 standard deviation (`rejected:degenerate`): a model serving a constant is
  broken, even though each number on its own looks fine.

**A circuit breaker protects both sides.** After 5 consecutive failures it opens and calls skip the network for 30 s.
Then it half-opens and lets exactly **one** trial call through: success closes it, failure re-opens it for another
cooldown. A response that arrives but fails the sanity checks is not counted as a failure: the service is up, so the
breaker stays closed.

## Use

```ts
import { scorePlan, rankerSettings } from "./src/lib/ml/client";

const result = await scorePlan(request, { settings: rankerSettings(process.env) });
if (result.status === "ok") {
  // result.scores: Map<"slot:item_id", { score, raw?, outputs? }>
} else {
  // carry on without the model: result.status says why
}
```

Settings come from the environment: `PLANNER_RANKER_MODE` (`off` by default, or `shadow`), `PLANNER_RANKER_URL`,
`GG_ML_RANKER_TOKEN` (optional bearer token) and `PLANNER_RANKER_TIMEOUT_MS` (default 80). Every dependency can be
injected (`fetchImpl`, `breaker`, `now`), which is how the tests drive timeouts and failures without a network.

## What's in it

| Path | What it is |
|---|---|
| `src/lib/ml/client.ts` | `scorePlan`, `checkResponse`, `rankerSettings`. |
| `src/lib/ml/breaker.ts` | The circuit breaker (closed → open → half-open, one trial at a time). |
| `src/lib/ml/score.v1.ts` | The request/response contract (zod), with its limits: ≤ 200 candidates, ≤ 8 slots, ≤ 1,000 pairs. |
| `src/lib/ml/score.v1.fixture.json` | An example request and response. |
| `src/lib/ml/__tests__/client.test.ts` | 14 tests: settings, every status, timeout with a `fetch` that ignores aborts, each sanity check, missing items, and the breaker opening, half-opening and resetting. |
| `src/lib/planner/types.ts` | A one-type stand-in for the app's planner types, which stay private. |

Not included, and staying private: how candidates are chosen and ranked before the call, how the model's score is
blended with the planner's own scoring, the feature definitions and the models themselves.

## Install and test

```bash
npm install
npm test           # vitest, 14 tests
npm run typecheck  # tsc
```

Node 20+.

## License

MIT, see [LICENSE](LICENSE).
