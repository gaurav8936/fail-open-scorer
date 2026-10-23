/**
 * Stand-in for the app's planner types (that file stays private): the one type the scoring client returns.
 * A model's score for one (slot, item) pair, plus optional raw score and auxiliary outputs; `mode` is set by the planner.
 */
export type ModelPart = { score: number; raw?: number; outputs?: Record<string, number>; mode: "shadow" | "live" };
