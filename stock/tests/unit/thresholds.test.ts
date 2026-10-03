import { describe, expect, it } from "vitest";
import { STOCK_MIN_TAU, effectiveTau } from "../../intent/thresholds.js";
import { readForkConfig } from "../../app/config.js";

describe("effective tau", () => {
  it("stock minimum is 0.85", () => {
    expect(STOCK_MIN_TAU).toBe(0.85);
  });

  it("a user may raise tau", () => {
    expect(effectiveTau(0.93)).toBe(0.93);
  });

  it("a user may not lower tau below the stock minimum", () => {
    expect(effectiveTau(0.5)).toBe(STOCK_MIN_TAU);
  });

  it("missing tau falls back to the stock minimum", () => {
    expect(effectiveTau(undefined)).toBe(STOCK_MIN_TAU);
  });

  it("tau above 1 is capped at 1", () => {
    expect(effectiveTau(1.4)).toBe(1);
  });
});

describe("readForkConfig", () => {
  it("reads stock tag and tau from fluid.toml", () => {
    const config = readForkConfig('stock_tag = "v1.2.0"\n[thresholds]\ntau = 0.9\n');
    expect(config).toEqual({ stockTag: "v1.2.0", configuredTau: 0.9, tau: 0.9 });
  });

  it("clamps a lowered tau but reports what was configured", () => {
    const config = readForkConfig('stock_tag = "v1.0.0"\n[thresholds]\ntau = 0.6\n');
    expect(config.configuredTau).toBe(0.6);
    expect(config.tau).toBe(STOCK_MIN_TAU);
  });

  it("uses stock defaults without a fluid.toml", () => {
    expect(readForkConfig(undefined)).toEqual({ stockTag: "v1.0.0", configuredTau: null, tau: STOCK_MIN_TAU });
  });

  it("rejects a non-numeric tau", () => {
    expect(() => readForkConfig('[thresholds]\ntau = "low"\n')).toThrow(/tau/);
  });
});
