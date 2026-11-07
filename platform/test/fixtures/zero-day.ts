// A stock release with two planted bugs, for the polymorphic installation
// experiment (polymorph-e2e.test.ts); stock itself stays clean. The release
// lets screens pass display options with a request, and draftFor in
// app/cards.ts spreads them into the options of enforceContract after the
// safety flag:
// - bug A, a mass assignment: an option with the internal flag's name
//   overrides the flag, so one request releases a held research dose. The
//   exploit has to name an internal property, which a renamed copy no longer
//   has under that name.
// - bug B, a public switch: display.preview skips the attestation hold. It
//   names only public fields, so renaming cannot touch it.
// Both pass every probe, as a real zero-day would: no probe sends display
// options. The new code holds no string, so it uses no listed name as text
// and a copy skips no name because of it.
import { POLYMORPH_LIST_PATH } from "../../src/polymorph/list.ts";
import { alignStockTag } from "../../src/stock/publish.ts";
import { pinnedTagOf, releaseMetadata, releaseMetadataPath } from "../../src/stock/releases.ts";
import { ENFORCE_CONTRACT, patched } from "../helpers/polymorph-platform.ts";

const PLANTED = [
	"  // Since this release, screens can pass display options with a request.",
	"  const display = (request.context as { display?: { preview?: boolean } }).display ?? {};",
	"  return enforceContract(draft, { researchNeedsAttestation: decision.researchNeedsAttestation && display.preview !== true, ...display });",
].join("\n");

/** A fixed date, so the release file is the same on every run. */
const RELEASED = new Date("2026-11-02T00:00:00Z");

/**
 * Stock files for the fixture release `tag`: app/cards.ts with both bugs,
 * fluid.toml pinning `tag`, and releases/<tag>.json next to the earlier
 * releases' files, as publishing a release commits them. Throws when stock no
 * longer has the line the bugs replace or the list the copies need.
 */
export function zeroDayRelease(files: Record<string, string>, tag: string): Record<string, string> {
	if (files[POLYMORPH_LIST_PATH] === undefined) throw new Error(`zeroDayRelease: the stock files have no ${POLYMORPH_LIST_PATH}, so no fork on the release would get a renamed copy`);
	const planted = alignStockTag(patched("app/cards.ts", ENFORCE_CONTRACT, PLANTED, files), tag);
	const metadata = releaseMetadata({ tag, notes: "Screens can pass display options with a request.", date: RELEASED, previousTag: pinnedTagOf(files["fluid.toml"]) });
	return { ...planted, [releaseMetadataPath(tag)]: `${JSON.stringify(metadata, null, 2)}\n` };
}
