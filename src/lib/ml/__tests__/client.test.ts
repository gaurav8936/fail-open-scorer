/** WS-GG-RECSYS-01 M0 · ranker client: timeout, circuit breaker, sanity checks, fallback (no scores → b = 0). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../score.v1.fixture.json";
import { CircuitBreaker } from "../breaker";
import { rankerSettings, scorePlan, scoreKey, type RankerSettings } from "../client";
import type { ScoreRequestV1 } from "../score.v1";

const REQ = fixture.request as unknown as ScoreRequestV1;
const RES = fixture.response;
const ON: RankerSettings = { mode: "shadow", url: "http://ranker.test", token: "t0k", timeoutMs: 80 };
const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const never = () => vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
/** A fetch that ignores the abort signal entirely (the client must still give up at the timeout). */
const deaf = () => vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;

let breaker: CircuitBreaker;
beforeEach(() => { breaker = new CircuitBreaker(5, 30_000); });

describe("rankerSettings", () => {
  it("is OFF by default", () => expect(rankerSettings({}).mode).toBe("off"));
  it("shadow when asked; M0 serves 'live' as shadow (b stays 0)", () => {
    expect(rankerSettings({ PLANNER_RANKER_MODE: "shadow" }).mode).toBe("shadow");
    expect(rankerSettings({ PLANNER_RANKER_MODE: "live" }).mode).toBe("shadow");
    expect(rankerSettings({ PLANNER_RANKER_MODE: "banana" }).mode).toBe("off");
  });
  it("timeout defaults to 80 ms and reads PLANNER_RANKER_URL", () => {
    const s = rankerSettings({ PLANNER_RANKER_MODE: "shadow", PLANNER_RANKER_URL: " http://x:8080 " });
    expect(s.timeoutMs).toBe(80);
    expect(s.url).toBe("http://x:8080");
    expect(rankerSettings({ PLANNER_RANKER_TIMEOUT_MS: "120" }).timeoutMs).toBe(120);
  });
});

describe("scorePlan", () => {
  it("off → no network call, no scores", async () => {
    const f = ok(RES);
    const r = await scorePlan(REQ, { settings: { ...ON, mode: "off" }, fetchImpl: f, breaker });
    expect(r).toMatchObject({ status: "off" });
    expect(r.scores).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
  it("no URL → unconfigured, no call", async () => {
    const f = ok(RES);
    expect((await scorePlan(REQ, { settings: { ...ON, url: null }, fetchImpl: f, breaker })).status).toBe("unconfigured");
    expect(f).not.toHaveBeenCalled();
  });
  it("200 → scores keyed by (slot, item), bundle id, model versions; posts to /v1/score with the bearer token", async () => {
    const f = ok(RES);
    const r = await scorePlan(REQ, { settings: ON, fetchImpl: f, breaker });
    expect(r.status).toBe("ok");
    expect(r.bundleId).toBe("b-20261015-03");
    expect(r.modelVersions).toEqual(RES.model_versions);
    expect(r.scores!.get(scoreKey(0, "pi_003"))).toEqual({ score: 0.73, raw: 0.41, outputs: { p_complete: 0.61, duration_ratio: 1.15, minutes_p50: 5.5 } });
    expect(r.scores!.size).toBe(4);
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("http://ranker.test/v1/score");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer t0k");
    expect(JSON.parse(String(init.body)).request_id).toBe(REQ.request_id);
  });
  it("hard timeout (80 ms) → status timeout, no scores, resolves promptly", async () => {
    const t0 = Date.now();
    const r = await scorePlan(REQ, { settings: { ...ON, timeoutMs: 30 }, fetchImpl: never(), breaker });
    expect(r.status).toBe("timeout");
    expect(r.scores).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("gives up at the timeout even when fetch ignores the abort signal", async () => {
    const r = await scorePlan(REQ, { settings: { ...ON, timeoutMs: 20 }, fetchImpl: deaf(), breaker });
    expect(r.status).toBe("timeout");
  });
  it("non-200 / network error → error, no scores", async () => {
    const e500 = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    expect((await scorePlan(REQ, { settings: ON, fetchImpl: e500, breaker })).status).toBe("error");
    const thrown = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const r = await scorePlan(REQ, { settings: ON, fetchImpl: thrown, breaker });
    expect(r.status).toBe("error");
    expect(r.scores).toBeUndefined();
  });
  it("sanity checks reject the whole response (doc 11 §4): bad shape, out of range, NaN-ish, degenerate, wrong request id", async () => {
    const cases: [unknown, string][] = [
      [{ nope: 1 }, "rejected:shape"],
      [{ ...RES, scores: RES.scores.map((s, i) => (i === 1 ? { ...s, score: 1.7 } : s)) }, "rejected:range"],
      [{ ...RES, scores: RES.scores.map((s) => ({ ...s, p_complete: -0.1 })) }, "rejected:range"],
      [{ ...RES, scores: RES.scores.map((s) => ({ ...s, score: 0.5 })) }, "rejected:degenerate"],
      [{ ...RES, request_id: "someone-else" }, "rejected:request_id"],
      [{ ...RES, scores: [{ slot: 7, item_id: "ghost", score: 0.4 }] }, "rejected:empty"],
    ];
    for (const [body, status] of cases) {
      const r = await scorePlan(REQ, { settings: ON, fetchImpl: ok(body), breaker });
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(status);
      expect(r.scores).toBeUndefined();
    }
  });
  it("items listed as missing, and unknown pairs, get no score (b = 0 for those items only)", async () => {
    const body = { ...RES, missing: ["pi_006"], scores: [...RES.scores, { slot: 0, item_id: "not-requested", score: 0.9 }] };
    const r = await scorePlan(REQ, { settings: ON, fetchImpl: ok(body), breaker });
    expect(r.status).toBe("ok");
    expect(r.scores!.has(scoreKey(0, "pi_006"))).toBe(false);
    expect(r.scores!.has(scoreKey(0, "pi_003"))).toBe(true);
  });
});

describe("circuit breaker", () => {
  it("opens after 5 consecutive failures: further calls skip the network (breaker_open)", async () => {
    const thrown = vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
    for (let i = 0; i < 5; i++) expect((await scorePlan(REQ, { settings: ON, fetchImpl: thrown, breaker })).status).toBe("error");
    expect(breaker.state()).toBe("open");
    const r = await scorePlan(REQ, { settings: ON, fetchImpl: thrown, breaker });
    expect(r.status).toBe("breaker_open");
    expect(thrown).toHaveBeenCalledTimes(5);
  });
  it("half-opens after the cooldown: one trial; success closes, failure re-opens", async () => {
    let t = 0;
    const b = new CircuitBreaker(2, 1000, () => t);
    b.failure(); b.failure();
    expect(b.state()).toBe("open");
    expect(b.allow()).toBe(false);
    t = 1000;
    expect(b.state()).toBe("half_open");
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false); // only one trial in flight
    b.failure();
    expect(b.state()).toBe("open");
    t = 2000;
    expect(b.allow()).toBe(true);
    b.success();
    expect(b.state()).toBe("closed");
    expect(b.allow()).toBe(true);
  });
  it("a success resets the consecutive-failure count", async () => {
    const thrown = vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
    for (let i = 0; i < 4; i++) await scorePlan(REQ, { settings: ON, fetchImpl: thrown, breaker });
    await scorePlan(REQ, { settings: ON, fetchImpl: ok(RES), breaker });
    for (let i = 0; i < 4; i++) await scorePlan(REQ, { settings: ON, fetchImpl: thrown, breaker });
    expect(breaker.state()).toBe("closed");
  });
});
