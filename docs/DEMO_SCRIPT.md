# Demo video script

Target length: 7 to 9 minutes. The competition allows 5 to 10.

The script follows the five scenes in spec section 13, with a 30-second opening and a closing slide. Each shot lists its time budget, what to click, the narration, and what to point out. View and control names match the UI in `platform/public/`.

Running total: about 8 minutes 40 seconds.

| Part | Budget | Ends at |
| :-- | :-- | :-- |
| Opening: the problem through one question | 0:30 | 0:30 |
| Scene 1: the dosing question, three times | 2:00 | 2:30 |
| Scene 2: customization | 1:45 | 4:15 |
| Scene 3: a failed shortcut | 1:00 | 5:15 |
| Scene 4: release day | 2:15 | 7:30 |
| Scene 5: harvesting | 0:45 | 8:15 |
| Closing slide | 0:25 | 8:40 |

## Pre-recording checklist

Live URL: https://fluid.renato83.workers.dev

Do these in order, about 30 minutes before recording.

1. **Deployment is current.** The deployed Worker runs the latest commit, and stock is published (`npm run publish-stock`, see `docs/DEPLOY.md`). The **Fleet** header lists stock tags up to the newest release (v1.9.0 at the last check), and the **Release** form suggests the next tag (v1.10.0).
2. **Admin secret ready.** Have the `ADMIN_TOKEN` value in your password manager. You will paste it once into the Fleet view. Never show it on screen: paste it before you start recording the Fleet scene, or blur it in editing.
3. **Check the fleet.** The production fleet is already seeded with 200 forks pinned to v1.5.0. **Fleet** should show about 195 **Pinned** and 5 **Repair open**. The repair-open forks are seeds whose lowered-tau change failed on a work branch. Their `main` is clean, so they upgrade normally on release day. Leave the fleet alone if it looks like that. If it has already been released, or it looks wrong, reseed it:
   - `POST /api/admin/fleet/cleanup` with `{}` and the admin header. This deletes only `user-seed-*` forks.
   - In **Fleet**, enter the admin secret, set **Seed demo fleet** to 200, and press **Seed**. It settled in about 40 seconds on production.
   - Do not seed fewer than 12. The forks that stay pinned on release day (compact research answers) are seed numbers 11, 61, 111, and 161, so a 200-fork fleet has 4 of them.
4. **Clear the page state.** Open a fresh private window (or a new browser profile) on the live URL. The session cookie, and with it your persona forks, belongs to that window. Reloading keeps the same session and the same forks. The Customize view keeps its last run only in the page.
5. **Create the persona forks a few minutes before recording, in that window.** The first page load provisions Dr. Rowan Ellery's fork (4 to 7 seconds). Then click **Sam Okonkwo-Reyes**, then **Dana Whitfield**, once each. That makes three forks, which is exactly the per-client limit of 3 forks per hour. A client is your public IPv4 address (or IPv6 /64), so every browser on your network shares it.
   - Switching back to a persona you already used in this window reuses its fork and costs no quota. You can switch freely during the recording.
   - Do not open another private window or profile within the hour, and do not provision forks from other devices on the same network. A new window starts a new session, and a fourth fork is refused with a quota error.
   - If you have to start over within the hour, wait until an hour has passed since the first fork, or delete the old forks first (`POST /api/admin/forks/<repo>/delete` with the admin header). Deleting does not give quota back.
6. **Pick the clock times.** The synthetic schedule for 2026-10-03 has Dr. Rowan Ellery on service from 07:00 to 13:00, and a manuscript writing block from 14:00 to 17:00. The manuscript shot must be off service, after 14:00. The **Writing the manuscript** scene sets the clock to 15:00. The **At the bedside** scene sets 09:00. Check the clock readout before each ask.
7. **Keep the fleet stream open.** Open **Fleet** in a second tab and leave it open. Confirm the header reads **Live stream: live**. Switch to that tab for scene 4.
8. **Rehearse scene 2 in your head, not on production.** A dry run in the recording window uses the same fork, and the run then shows up in its history. On production the REDCap customization took 13 to 20 seconds from accepting the tests to the merge, and the lower-tau run took 15 to 27 seconds to the failed gate and the repair. Plan to cut the waits in editing.
9. **Screen setup.** Browser at 1440 by 900, zoom 100 percent, light theme (**Theme** button in the bottom left), notifications off. The synthetic data notice bar stays visible at the top of every shot.

## Opening: the problem through one question (0:30)

**Shot O1 (0:30).** Title card, then the question typed on a plain background:
"What is the right dose of opioid X for a patient of Y kg and Z years?"
Then three short lines appear: clinical service, writing a paper, preparing a budget.

Narration:
> People in an academic medical center change roles all day.
> In the morning a physician rounds on patients. After lunch she writes a paper. Later she reviews a budget.
> The same dosing question has three correct answers, one for each role.
> In medicine, giving the wrong one is a safety problem.
> Fluid is an assistant that knows which job you are doing, shows why, and lets you correct it.
> And every person gets their own fork of it.

Point out: nothing yet. Keep it fast.

## Scene 1: the dosing question, three times (2:00)

Persona: **Dr. Rowan Ellery**, hospitalist and researcher. View: **Workspace**.

**Shot 1.1 (0:15).** Click **Dr. Rowan Ellery** under **Signed in as**. Point at the fork pill in the top right.

> This is Dr. Ellery. She has her own fork of Fluid, a personal Artifacts repository forked from the stock release.
> On the left is a context simulator. It stands in for what the assistant can observe. All of it is synthetic.

Point out: the fork pill shows the repo name, the pinned stock tag, and τ 0.85.

**Shot 1.2 (0:35).** Under **Scenes**, click **At the bedside**. The clock jumps to 09:00, a synthetic patient chart opens, and the screen label reads EHR chart view. Click the first example question, "What is the right dose of Morphinex for a patient of 70 kg and 45 years?"

> It is nine in the morning. She is on service and has a patient's chart open.
> She asks the dosing question.
> Fluid answers in clinical mode. It cites the institution's policy. It shows its basis. And it gives no computed dose.
> That rule is fixed code in the stock release. A fork cannot remove it.

Point out: the **Clinical** badge and confidence, **Signals that drove the intent** (chart open, on service, screen label), the policy source, and the absence of a dose.

**Shot 1.3 (0:20).** In the same card, under **Answer as**, click **Research**. The attestation dialog opens. Click **Confirm and show research answer**.

> If she really is doing research, she can switch modes.
> With a patient chart open, the number stays held until she attests she is not deciding for a patient.
> That attestation goes into her ledger.

Point out: the dialog text "I am not making a decision for a patient right now", then the **Attested** tag on the new card.

**Shot 1.4 (0:30).** Click **Writing the manuscript**. The clock reads 15:00, **Off service per call schedule** shows, and the manuscript document is active. Click the same example question.

> Now it is three in the afternoon. She is off service, in her manuscript writing block, with the draft open.
> Same question. Now Fluid answers in research mode.
> It computes the dose for the stated parameters, and cross-checks it against two independent US sources.

Point out: the **Research** badge, the computed dose box ("Computed dose, hypothetical parameters"), the two registry sources with different publishers, and the discrepancy framing.

**Shot 1.5 (0:20).** Click **Ambiguous screen**. Ask the same question.

> Here the signals are weak. No intent passes the threshold.
> So Fluid shows a labeled answer for each plausible intent, and she picks one.

Point out: the **Multi-intent** badge, the distribution bar with the τ 0.85 marker, and **Labeled answers for each plausible intent**.

**Shot 1.6 (optional, 0:00 to 0:10, cut if over time).** Click **Open in ledger** on any card. The **My fork** view scrolls to the **Run-time ledger** row.

> Every answer writes a record: the intent, the signals, any override or attestation, the fork commit, and the stock tag.

## Scene 2: customization (1:45)

Persona: **Sam Okonkwo-Reyes**, research coordinator. View: **Customize**.

**Shot 2.1 (0:20).** Click **Sam Okonkwo-Reyes**, then **Customize** in **Views**. Under **Examples**, click "Add a REDCap connector so research mode reports enrollment for my protocols". Click **Start customization**.

> Sam coordinates two research protocols. He wants enrollment numbers inside research mode.
> He asks for the change in plain words.

**Shot 2.2 (0:30).** Watch the **Run** timeline fill in. Then point at **Diff summary** and at **Intent record for this change**.

> An agent writes the change on a work branch in Sam's fork.
> Before it commits, it writes an intent record: what Sam asked for, why, which modes and files it touches.
> The commit links to that record with an Intent-Id trailer.

Point out: the branch name `work/...` next to **Diff summary**, the new connector file, and the intent record id.

**Shot 2.3 (0:25).** In **Suggested tests**, read the first suggestion's title and assertions. Click **Accept** on each suggestion.

> A test suggester reads the diff and the intent record, and proposes tests for Sam's own tier.
> This one asks about his protocol and expects an enrollment count from REDCap.
> Sam accepts. He could also edit or reject it.

Point out: "verifies int_..." under each suggestion, tying the test to the intent record.

**Shot 2.4 (0:20).** Watch **Gate result** turn green.

> The push starts the gate.
> Tier one is the stock invariants. Tier two is the stock functional tests. Both are read from stock at Sam's pinned tag, never from his fork.
> Tier three is his own tests. All three pass, so the gate merges the change to main.

Point out: the three tier boxes and their counts.

**Shot 2.5 (0:10).** Go to **Workspace**, click **IRB portal**, type "How many participants are enrolled in IRB-2026-0142?" and press **Ask**.

> And now research mode answers with live enrollment, from his fork.

Point out: the enrollment figure in the research card.

**Optional shot 2.6 (0:20).** If there is time, stay on Sam and ask in **Customize**: "Always use palatino lino type kind of fonts and add a tab with charts". The run maps the request onto `ui/preferences.json` (the Palatino stack and a **Charts** tab), says what it mapped, proposes one config test, and passes all three tiers. The font changes and **Charts** appears under **Your tabs**.

> Forks can change their own look too, but only through a declarative file the platform validates. No fork code runs in the browser.

## Scene 3: a failed shortcut (1:00)

Persona: **Sam Okonkwo-Reyes**. View: **Customize**.

**Shot 3.1 (0:15).** In **Customize**, click the example "Lower my confidence threshold to 0.6". Click **Start customization**. Accept the suggested test.

> Sam finds the multi-intent view slow. He asks to lower his confidence threshold to 0.6.

**Shot 3.2 (0:30).** Scroll to **Gate result**. It reads "Gate failed ... Merge is blocked." Point at **Failing probes**.

> The gate fails. The stock minimum for the threshold is 0.85, and an invariant checks it.
> Here is the failing probe: the file, the path, the expected value 0.85, the actual value 0.6.
> Main is untouched. Sam keeps working on the version that passed.

Point out: the red **Tier 1: invariants** box, the probe id `inv-tau-config-floor`, and the Expected and Actual rows.

**Shot 3.3 (0:15).** Click **My fork**. Point at **Branches** and at the τ meter.

> A repair agent has already opened a repair branch that explains the failure.
> Sam can raise his threshold. He can never lower it below the floor.

Point out: the `repair/...` branch, and the red stock minimum mark on the τ meter.

## Scene 4: release day (2:15)

View: **Fleet**, in the tab you kept open.

**Shot 4.1 (0:20).** Show the full grid, almost all **Pinned**.

> This is the mothership view. Each square is one user's fork. Here there are about two hundred.
> All of them are pinned to the current stock release.

Point out: the header line with the fork count and stock tags, and **Live stream: live**.

**Shot 4.2 (0:20).** In **Release**, leave the suggested **Tag**. Read the **Release notes**. Leave **Safety release** checked. The admin secret is already filled in. Click **Tag release and upgrade the fleet**.

> The central team tags a new release. This one is a safety release: it tightens an invariant, so research answers must always show their discrepancy summary.
> One click starts one upgrade agent per fork.

Point out: the status line "Tagged v... N upgrade runs started."

**Shot 4.3 (0:40).** Watch the grid and the counters change: **Upgrading**, **Gating**, **Passed**. Point at the **Event stream** scrolling.

> Each fork gets its own upgrade branch. An agent merges the new stock into it.
> When a customization conflicts with stock, a merge agent resolves it, guided by the fork's intent records.
> Then each fork runs its own gate, at the new tag.
> These are hundreds of agents working on hundreds of repositories at once.
> In our test run, more than a hundred forks were upgrading or gating at the same moment.

The production rehearsal (12 forks) finished in 43 seconds, and the first upgrade finished after 12 seconds. Expect a 200-fork release to take about 2 to 3 minutes. Of the 200 seeds, the 4 compact-research forks stay pinned with a repair branch. Everything else should pass, some after the merge agent resolves a conflict.

Point out: the counters moving, the progress bar, and the stream lines arriving with fork names.

**Shot 4.4 (0:15).** When most squares are green, point at **Failed** and **Repair open**.

> Most forks pass. A few do not.
> Those stay pinned to the release they were on. A fork's pin only moves forward, and only through a passing gate.

**Shot 4.5 (0:40).** Under **Needs attention**, click a fork with **repair open**. Scroll **Fork detail**.

> Here is one that stayed pinned. One of its customizations breaks a stock test at the new tag.
> The repair agent read the fork's intent records, so it knows what the user wanted from that change. It names the record, explains the failure, and proposes a fix on a repair branch.
> The user reviews the fix. Repairs never merge on their own.
> Because this is a safety release, there is a grace period. After it ends, this capability runs in stock mode until the repair is merged. The customization stays safe on its branch.

Pick a fork whose explanation reads well on camera during the dry run. The seeded forks that stay pinned carry a compact research customization. It passed at their pinned tag and fails only the invariant the demo release adds, `inv-research-cross-check-visible`.

Point out: the **Repair agent:** explanation, the safety release box, **Run steps**, **Proposed fix**, the failing probe under **Gate on the upgrade branch**, and the highlighted intent record it relied on.

## Scene 5: harvesting (0:45)

View: **Harvest**.

**Shot 5.1 (0:15).** Click **Harvest**. Click **Run the harvester** (or **Run the harvester again**). Watch the **Harvester run** timeline.

> Forks are also a research channel for the mothership.
> With the user's opt-in, a harvester reads intent records across forks and clusters similar customizations.

**Shot 5.2 (0:30).** Click the REDCap cluster in **Clusters**. Point at **Proposal**.

> Many users added the same REDCap connector.
> The harvester drafts it as a stock feature on a branch in stock, with the fork implementations and their intent records attached.
> When it ships, upgrade agents can retire the duplicate custom code in each fork.

Point out: the fork count, the **Draft stock feature branch** name `harvest/...`, the proposed files, and **Intent records it was built from**.

## Closing slide (0:25)

Static slide titled **What the next Git platform looks like**, with four lines:

1. Forks as distribution: one fork per person.
2. Intent as repository content: every change and every answer carries its why.
3. Behavioral regression as the merge criterion: upstream tests decide what merges and what upgrades.
4. All on Workers and Artifacts: Artifacts, Worker Loader, Workflows, Queues, Durable Objects, Workers AI, and AI Gateway.

Footer: repository link, "MIT license", "All data synthetic".

Narration:
> This is what we think the next Git platform looks like.
> Forks are how software is distributed: one per person.
> Intent is repository content, next to the code it explains.
> And behavioral regression against upstream decides what merges.
> All of it runs on Cloudflare Workers and Artifacts.
> The source is MIT licensed, and every piece of data in it is synthetic.

## If something goes wrong while recording

- A card says "The fork could not answer": wait a few seconds and ask again. The fork isolate loads on first use.
- **Live stream** reads **reconnecting**: reload the Fleet tab before tagging.
- A release fails with a 409: the tag already exists. The form suggests the next tag after a reload.
- Fork creation fails with a quota error: you hit the 3 forks per hour limit. Go back to the window that already has the persona forks; switching personas there costs nothing.
- A harvest or release button reports `admin token required`: enter the admin secret in **Fleet** first. It is kept for the browser tab only.
