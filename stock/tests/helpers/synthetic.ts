// Loads the synthetic data set the platform injects as env.data. Test-only (Node).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SyntheticData } from "../../connectors/types.js";

const SYNTHETIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "synthetic");

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(SYNTHETIC_DIR, relativePath), "utf8"));
}

export function loadSyntheticData(): SyntheticData {
  const manifest = readJson("manifest.json") as { envDataKeys: Record<string, string> };
  const data: Record<string, unknown> = {};
  for (const [key, file] of Object.entries(manifest.envDataKeys)) data[key] = readJson(file);
  return data as SyntheticData;
}

export const STOCK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readStockFile(relativePath: string): string {
  return readFileSync(join(STOCK_ROOT, relativePath), "utf8");
}
