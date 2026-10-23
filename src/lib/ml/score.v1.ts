/**
 * WS-GG-RECSYS-01 M0 · the `planner-ranker` service contract, `POST /v1/score` (v1).
 *
 * Source: WS-GG-MLINFRA-01 07_interfaces §2.5 (MLINFRA owns the service API), reconciled by
 * ws-gg-recsys-01/00_cross-workstream-decisions (which wins):
 *   - one batched call per plan (≤ 200 candidates, ≤ 1,000 (slot, item) pairs), client timeout 80 ms, circuit breaker;
 *   - the app holds config and sends each model's MODE and pinned version in the request (the ranker never reads config);
 *   - the response carries `bundle_id` (C4), stored in plan_session.model_version and resolved via ml.model_bundle;
 *   - timeout, error or no score → b = 0 for that item.
 * Example request/response: score.v1.fixture.json (kept in sync by src/lib/ml/__tests__/contract.test.ts).
 */
import { z } from "zod";

export const MODEL_IDS = ["planner-ranker", "personal-duration", "completion-predictor", "interest-embedder", "time-budget-forecaster"] as const;
export type ModelId = (typeof MODEL_IDS)[number];
export const ModelMode = z.enum(["off", "shadow", "live"]);
export type ModelMode = z.infer<typeof ModelMode>;

export const SPEC_VERSION = "1.0";
export const MAX_CANDIDATES = 200;
export const MAX_PAIRS = 1000;
export const MAX_SLOTS = 8;

export const ScoreRequestV1 = z.object({
  /** Correlates the call with the plan; stored in plan_session.context.request_id. */
  request_id: z.string().min(1).max(64),
  /** Opaque pseudonymous planner key; never an email. */
  user_id: z.string().min(1),
  spec_version: z.string(),
  /** Raw request context; the ranker computes context features from it (decision C8). */
  context: z.object({
    budget_min: z.number().int(),
    template: z.number().int(),
    objective: z.enum(["career", "company", "both"]),
    focus_step: z.string(),
    beats: z.array(z.string()),
    week_step_minutes: z.record(z.string(), z.number()),
    seen_item_ids: z.array(z.string()),
    local_hour: z.number().int().min(0).max(23),
    dow: z.number().int().min(0).max(6),
    tz: z.string(),
  }),
  /** ml.user_feature row, forwarded verbatim (null values when the user has no snapshot yet). */
  user_features: z.object({ as_of: z.string().nullable(), values: z.record(z.string(), z.unknown()) }),
  slots: z.array(z.object({ index: z.number().int().min(0), step: z.string(), minutes: z.number().int().positive(), swap_count: z.number().int().min(0) })).min(1).max(MAX_SLOTS),
  candidates: z.array(z.object({
    item_id: z.string(),
    /** ml.item_feature row, forwarded verbatim (may be empty: the ranker may hold item features itself). */
    features: z.record(z.string(), z.unknown()),
    /** Slot-independent rule features f_k and the rules score (doc 03 §6: the ranker learns corrections to the rules). */
    rules: z.record(z.string(), z.number()),
  })).min(1).max(MAX_CANDIDATES),
  /** Per model: mode + optional pinned version (the app resolves modes from config; the ranker never reads config). */
  models: z.record(z.enum(MODEL_IDS), z.object({ mode: ModelMode, version: z.string().nullable().optional() })),
}).refine((r) => r.slots.length * r.candidates.length <= MAX_PAIRS, { message: "too many (slot, item) pairs" });
export type ScoreRequestV1 = z.infer<typeof ScoreRequestV1>;

const unit = z.number();
export const ScoreRowV1 = z.object({
  slot: z.number().int().min(0),
  item_id: z.string(),
  /** planner-ranker output, percentile-normalised to [0, 1] (doc 01 §3.3). */
  score: unit,
  /** Raw model output before normalisation (logged next to `score`). */
  score_raw: z.number().optional(),
  p_complete: z.number().optional(),
  duration_ratio: z.number().optional(),
  minutes_p50: z.number().optional(),
  sim: z.number().optional(),
});
export type ScoreRowV1 = z.infer<typeof ScoreRowV1>;

export const ScoreResponseV1 = z.object({
  request_id: z.string(),
  /** Decision C4: the bundle the scores came from (e.g. "b-20261015-03"). */
  bundle_id: z.string().min(1),
  model_versions: z.record(z.string(), z.string()).default({}),
  /** true = serving the fallback model baked into the image. */
  degraded: z.boolean().default(false),
  scores: z.array(ScoreRowV1),
  /** Items the ranker could not score ⇒ b = 0 for them. */
  missing: z.array(z.string()).default([]),
  latency_ms: z.number().optional(),
});
export type ScoreResponseV1 = z.infer<typeof ScoreResponseV1>;
