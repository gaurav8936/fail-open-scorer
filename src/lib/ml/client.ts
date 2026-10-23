/**
 * WS-GG-RECSYS-01 M0 · typed client for the planner-ranker `POST /v1/score` (contract: score.v1.ts).
 *
 * Never throws and never blocks a plan for more than the timeout: every failure becomes a status and NO scores, which
 * the engine treats as "no model score" → b = 0. Flag OFF by default.
 *
 * Env:
 *   PLANNER_RANKER_MODE        off (default) | shadow. M0 never blends: "live" is accepted but served as shadow.
 *   PLANNER_RANKER_URL         base URL of the service (e.g. http://planner-ranker:8080); /v1/score is appended.
 *   GG_ML_RANKER_TOKEN         bearer token (optional locally).
 *   PLANNER_RANKER_TIMEOUT_MS  client hard timeout, default 80 (decision §1).
 */
import { CircuitBreaker } from "./breaker";
import { ScoreResponseV1, type ScoreRequestV1, type ScoreResponseV1 as ScoreResponse } from "./score.v1";
import type { ModelPart } from "@/lib/planner/types";

export type RankerStatus = "off" | "unconfigured" | "ok" | "timeout" | "error" | "breaker_open" | `rejected:${string}`;

export type RankerSettings = { mode: "off" | "shadow"; url: string | null; token: string | null; timeoutMs: number };

export function rankerSettings(env: Record<string, string | undefined> = process.env): RankerSettings {
  const raw = (env.PLANNER_RANKER_MODE ?? "off").trim().toLowerCase();
  // M0: effective b stays 0 → "live" is downgraded to shadow until MLADMIN A2 + RECSYS M5 gate it.
  const mode = raw === "shadow" || raw === "live" ? "shadow" : "off";
  const t = Number(env.PLANNER_RANKER_TIMEOUT_MS);
  return { mode, url: env.PLANNER_RANKER_URL?.trim() || null, token: env.GG_ML_RANKER_TOKEN?.trim() || null, timeoutMs: Number.isFinite(t) && t > 0 ? t : 80 };
}

export type ScoreResult = {
  status: RankerStatus;
  latencyMs: number;
  /** Present only when status = ok. Key `${slot}:${item_id}`. */
  scores?: Map<string, Omit<ModelPart, "mode">>;
  bundleId?: string;
  modelVersions?: Record<string, string>;
  degraded?: boolean;
  specVersion?: string;
};

const g = globalThis as unknown as { __plannerRankerBreaker?: CircuitBreaker };
export const rankerBreaker = (): CircuitBreaker => (g.__plannerRankerBreaker ??= new CircuitBreaker());
/** Test hook. */
export const resetRankerBreaker = (b?: CircuitBreaker) => { g.__plannerRankerBreaker = b ?? new CircuitBreaker(); };

export const scoreKey = (slot: number, itemId: string) => `${slot}:${itemId}`;

/**
 * Client-side sanity checks (RECSYS doc 11 §4) on a parsed response. Any failure drops the model term for the whole
 * request. Items the ranker skipped (listed in `missing` or simply absent) just get no score (b = 0 for them).
 */
export function checkResponse(req: ScoreRequestV1, res: ScoreResponse): string | null {
  if (res.request_id !== req.request_id) return "request_id";
  const slots = new Set(req.slots.map((s) => s.index)), items = new Set(req.candidates.map((c) => c.item_id));
  const known = res.scores.filter((r) => slots.has(r.slot) && items.has(r.item_id)); // unknown pairs are ignored
  if (!known.length) return "empty";
  for (const r of known) {
    for (const v of [r.score, r.p_complete, r.sim]) if (v !== undefined && !(Number.isFinite(v) && v >= 0 && v <= 1)) return "range";
    if (r.duration_ratio !== undefined && !(Number.isFinite(r.duration_ratio) && r.duration_ratio > 0)) return "range";
  }
  if (known.length > 1) {
    const m = known.reduce((a, r) => a + r.score, 0) / known.length;
    const sd = Math.sqrt(known.reduce((a, r) => a + (r.score - m) ** 2, 0) / known.length);
    if (sd <= 0.001) return "degenerate";
  }
  return null;
}

/** One batched call per plan. Resolves within ~timeoutMs whatever the service does. */
export async function scorePlan(req: ScoreRequestV1, o: { settings?: RankerSettings; fetchImpl?: typeof fetch; breaker?: CircuitBreaker; now?: () => number } = {}): Promise<ScoreResult> {
  const st = o.settings ?? rankerSettings();
  const now = o.now ?? (() => performance.now());
  if (st.mode === "off") return { status: "off", latencyMs: 0 };
  if (!st.url) return { status: "unconfigured", latencyMs: 0 };
  const breaker = o.breaker ?? rankerBreaker();
  if (!breaker.allow()) return { status: "breaker_open", latencyMs: 0 };

  const t0 = now();
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, st.timeoutMs);
  const url = st.url.replace(/\/+$/, "").replace(/\/v1\/score$/, "") + "/v1/score";
  try {
    const call = (o.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(st.token ? { authorization: `Bearer ${st.token}` } : {}) },
      body: JSON.stringify(req),
      signal: ctl.signal,
      cache: "no-store",
    }).then(async (r) => ({ ok: r.ok, body: r.ok ? await r.json() : null }));
    // The abort also races a body that never arrives / a fetch impl that ignores the signal.
    const aborted = new Promise<never>((_, rej) => ctl.signal.addEventListener("abort", () => rej(new Error("timeout")), { once: true }));
    const r = await Promise.race([call, aborted]);
    const latencyMs = now() - t0;
    if (!r.ok) { breaker.failure(); return { status: "error", latencyMs }; }
    const parsed = ScoreResponseV1.safeParse(r.body);
    if (!parsed.success) { breaker.failure(); return { status: "rejected:shape", latencyMs }; }
    const bad = checkResponse(req, parsed.data);
    // A sane-but-rejected response is not a transport failure: the service is up, keep the breaker closed.
    breaker.success();
    if (bad) return { status: `rejected:${bad}`, latencyMs, bundleId: parsed.data.bundle_id };
    const missing = new Set(parsed.data.missing);
    const scores = new Map<string, Omit<ModelPart, "mode">>();
    for (const x of parsed.data.scores) {
      if (missing.has(x.item_id)) continue;
      const outputs: Record<string, number> = {};
      for (const k of ["p_complete", "duration_ratio", "minutes_p50", "sim"] as const) if (x[k] !== undefined) outputs[k] = x[k]!;
      scores.set(scoreKey(x.slot, x.item_id), { score: x.score, ...(x.score_raw !== undefined ? { raw: x.score_raw } : {}), ...(Object.keys(outputs).length ? { outputs } : {}) });
    }
    return { status: "ok", latencyMs, scores, bundleId: parsed.data.bundle_id, modelVersions: parsed.data.model_versions, degraded: parsed.data.degraded, specVersion: req.spec_version };
  } catch {
    breaker.failure();
    return { status: timedOut ? "timeout" : "error", latencyMs: now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}
