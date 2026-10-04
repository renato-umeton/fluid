// An in-memory E2E host for tests: asks go to an app module, the ledger is a
// map keyed by answer id, and config files are parsed the way the platform
// does (fluid.toml as TOML, ui/preferences.json as JSON). Test-only.
import { parseToml } from "../../app/toml.js";
import type { AnswerCard, AskRequest, ForkApp, ForkEnv, Mode, RunTimeRecord } from "../../app/types.js";
import type { ConfigResult, E2EHost } from "../e2e/runner.js";

export interface FakeHostOptions {
  app: ForkApp;
  env?: ForkEnv;
  files?: Record<string, string>;
  connectors?: string[];
  intents?: unknown[];
  /** Rewrites every card before the ledger sees it (simulates a broken fork). */
  mapCard?: (card: AnswerCard) => AnswerCard;
}

export interface FakeHost extends E2EHost {
  records: Map<string, RunTimeRecord & { override_at?: string }>;
  calls: string[];
}

export function fakeHost(options: FakeHostOptions): FakeHost {
  const records = new Map<string, RunTimeRecord & { override_at?: string }>();
  const calls: string[] = [];
  const files = options.files ?? {};
  return {
    records,
    calls,
    async ask(request: AskRequest) {
      calls.push(`ask:${request.question}`);
      const raw = await options.app.ask(request, { ...options.env, fluidToml: files["fluid.toml"] });
      const card = options.mapCard ? options.mapCard(raw) : raw;
      records.set(card.ledger.answer_id, { ...card.ledger });
      return JSON.parse(JSON.stringify(card));
    },
    async override(answerId: string, mode: Mode) {
      calls.push(`override:${answerId}:${mode}`);
      const record = records.get(answerId);
      if (!record) return null;
      const updated = { ...record, override: mode, override_at: "2026-10-04T00:00:00Z" };
      records.set(answerId, updated);
      return updated;
    },
    async ledger(answerId: string) {
      calls.push(`ledger:${answerId}`);
      return records.get(answerId) ?? null;
    },
    async intents() {
      return options.intents ?? [{ id: "int_onboarding", files: ["fluid.toml"], purpose: "onboarding" }];
    },
    async config(file: string): Promise<ConfigResult> {
      const text = files[file];
      if (text === undefined) return { present: false, valid: true };
      try {
        return { present: true, valid: true, parsed: file.endsWith(".json") ? JSON.parse(text) : parseToml(text) };
      } catch (error) {
        return { present: true, valid: false, errors: [error instanceof Error ? error.message : String(error)] };
      }
    },
    async connectors() {
      return options.connectors ?? ["calendar", "call-schedule", "documents", "fhir", "formulary"];
    },
  };
}
