import { effectiveTau } from "../intent/thresholds.js";
import { parseToml, type TomlTable } from "./toml.js";

export const STOCK_TAG = "v1.0.0";

export interface ForkConfig {
  stockTag: string;
  /** Raw value from fluid.toml, kept so the gate can see a lowered tau. */
  configuredTau: number | null;
  /** Value actually used: never below the stock minimum. */
  tau: number;
}

export function readForkConfig(fluidToml: string | undefined): ForkConfig {
  if (fluidToml === undefined) return { stockTag: STOCK_TAG, configuredTau: null, tau: effectiveTau(null) };
  const parsed = parseToml(fluidToml);
  const stockTag = typeof parsed.stock_tag === "string" ? parsed.stock_tag : STOCK_TAG;
  const configuredTau = readTau(parsed);
  return { stockTag, configuredTau, tau: effectiveTau(configuredTau) };
}

function readTau(parsed: TomlTable): number | null {
  const thresholds = parsed.thresholds;
  if (thresholds === undefined || typeof thresholds !== "object") return null;
  const tau = thresholds.tau;
  if (tau === undefined) return null;
  if (typeof tau !== "number") throw new Error(`fluid.toml: thresholds.tau must be a number, got ${JSON.stringify(tau)}`);
  return tau;
}
