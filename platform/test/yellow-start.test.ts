import { describe, expect, it } from "vitest";
import { yellowInstanceId, yellowInstanceToStart, type WorkflowBinding } from "../src/workflows/common.ts";

const C = "c".repeat(40);

function binding(statuses: Record<string, string>): WorkflowBinding<unknown> {
	return {
		create: async () => ({ id: "x" }) as never,
		createBatch: async () => [],
		get: async (id: string) => {
			if (!(id in statuses)) throw new Error(`instance ${id} not found`);
			return { id, status: async () => ({ status: statuses[id]! }), sendEvent: async () => undefined };
		},
	};
}

describe("yellow instance ids", () => {
	it("are one per (repo, commit), with a nonce for an admin re-check", () => {
		expect(yellowInstanceId("user-a", C)).toBe(yellowInstanceId("user-a", C));
		expect(yellowInstanceId("user-a", C, "k1")).not.toBe(yellowInstanceId("user-a", C));
		expect(yellowInstanceId("user-a", C, "k1")).not.toBe(yellowInstanceId("user-a", C, "k2"));
		expect(yellowInstanceId("user-a", C, "k1").length).toBeLessThanOrEqual(64);
	});

	it("reuse the instance while it runs or after it finished, and start a fresh one after it errored", async () => {
		const id = yellowInstanceId("user-a", C);
		expect(await yellowInstanceToStart(binding({}), id)).toBe(id);
		expect(await yellowInstanceToStart(binding({ [id]: "running" }), id)).toBe(id);
		expect(await yellowInstanceToStart(binding({ [id]: "complete" }), id)).toBe(id);
		const retry = await yellowInstanceToStart(binding({ [id]: "errored" }), id);
		expect(retry).not.toBe(id);
		expect(retry.startsWith(id.slice(0, 40))).toBe(true);
		expect(await yellowInstanceToStart(binding({ [id]: "terminated" }), id)).not.toBe(id);
	});
});
