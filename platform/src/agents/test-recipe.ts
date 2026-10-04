// ADMIN-ONLY TEST RECIPE. It exists to prove the yellow soak works: it lands
// a change that passes tiers 1 to 3 and breaks a basic flow that only the
// end-to-end suite checks. Every ledger record names the constant
// "build-cache" as its fork commit; tier 1 only checks that fork_commit
// exists, while the end-to-end suite checks it equals the live commit. The
// customize route refuses it without the admin token, and it is never
// offered in the UI.
import type { PlannedChange } from "./recipes.ts";

export const ADMIN_TEST_MARKER = "[admin test]";
const BREAK_LEDGER = /\[admin test\]\s*break (the )?ledger fork[_ ]commit/i;

const INDEX_RETURN = /^(\s*)return buildCard\((\{[^\n]*\})\);$/m;
export const BROKEN_FORK_COMMIT = "build-cache";

export function isAdminTestRequest(request: string): boolean {
	return request.toLowerCase().includes(ADMIN_TEST_MARKER);
}

export function matchAdminTestRecipe(request: string): "break-ledger-commit" | null {
	return BREAK_LEDGER.test(request) ? "break-ledger-commit" : null;
}

/** Patches app/index.ts so every top-level ledger record carries a constant fork commit. */
export function breakLedgerCommitChange(indexSource: string): PlannedChange {
	if (!INDEX_RETURN.test(indexSource)) throw new Error("app/index.ts no longer has the stock buildCard call; the admin test recipe cannot patch it");
	const index = indexSource.replace(
		INDEX_RETURN,
		(_m, indent: string, args: string) =>
			`${indent}// ADMIN TEST RECIPE: deliberately breaks ledger provenance so the yellow soak can be shown catching it.\n${indent}const card = await buildCard(${args});\n${indent}return { ...card, ledger: { ...card.ledger, fork_commit: ${JSON.stringify(BROKEN_FORK_COMMIT)} } };`,
	);
	return {
		summary: "ADMIN TEST: record a constant fork commit in every ledger record",
		purpose: "Admin-only test change: passes tiers 1 to 3 but breaks ledger provenance, which only the end-to-end suite checks",
		modes_affected: [],
		files: { "app/index.ts": index },
		notes: { "app/index.ts": `ADMIN TEST: ledger.fork_commit is always "${BROKEN_FORK_COMMIT}"` },
		recipe: "admin-test",
	};
}
