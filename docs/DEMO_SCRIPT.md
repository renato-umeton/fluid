# Demo video script

Target length: about 8 minutes 50 seconds. The competition allows 5 to 10. Never go over 10.

The video leads with the Git idea, then shows it working: one question in two jobs, customization by recipe or by model, a failed shortcut, your own agent pushing over plain git, release day with intent replay, and harvesting. Each shot lists its time budget, what to click, the narration, and what to point out. View and control names match the UI in `platform/public/`.

Words to avoid on camera, and what to say instead:

- "mothership": say "the central team" or "the fleet view".
- "floor": say "the stock safety rules" or "the stock minimum".
- "tau" or "τ": say "confidence threshold". The UI still shows the τ symbol; that is fine on screen.
- "stock": the first time, say "the shared release, called stock". After that, "stock" is fine.

Running total: about 8 minutes 50 seconds.

| Part | Budget | Ends at |
| :-- | :-- | :-- |
| Opening: the Git idea | 0:45 | 0:45 |
| Scene 1: one question, two jobs | 1:00 | 1:45 |
| Scene 2: customization, by recipe or by model | 2:05 | 3:50 |
| Scene 3: a failed shortcut | 0:40 | 4:30 |
| Scene 4: bring your own agent | 1:20 | 5:50 |
| Scene 5: release day and intent replay | 2:05 | 7:55 |
| Scene 6: harvesting | 0:25 | 8:20 |
| Closing | 0:30 | 8:50 |

## Pre-recording checklist

Live URL: https://fluid.frontier-software.workers.dev

Do these in order, about 30 minutes before recording.

1. **Deployment is current.** The deployed Worker runs the latest `main`, including intent replay and the bring your own agent work (the inbox token, the import workflow, and the **Connect your own agent** panel). Both are merged into `main` locally; push `main` and deploy before recording, then smoke test one token, one outside push, and one replay upgrade on a test fork. Stock is published (`npm run publish-stock`, see `docs/DEPLOY.md`). The **Fleet** header lists stock tags up to the newest release (v1.11.0 at the last check), and the **Release** form suggests the next tag (v1.12.0 if nothing was released since). Use the tag the form suggests.
2. **The inbox flow needs the deployed Worker.** An outside push is imported only when the Artifacts push event reaches the Queue, which then starts an import workflow. Queue events go only to the deployed consumer (`docs/DEPLOY.md`), so Scene 4 only works on the live URL (or in mock mode, see below). On the live URL the import has no step-by-step timeline on screen: the result shows up in **My fork** only after you click **My fork** again to refresh it.
3. **Admin secret ready.** Have the `ADMIN_TOKEN` value in your password manager. You will paste it once into the Fleet view (**Admin secret (sent as x-fluid-admin)**). Never show it on screen: paste it before you start recording the Fleet scene, or blur it in editing.
4. **Check the fleet.** The production fleet should hold 200 seeded forks pinned to v1.5.0. **Fleet** should show about 195 **Pinned** and 5 **Repair open**. The repair-open forks are seeds whose lowered confidence threshold failed on a work branch. Their `main` is clean, so they upgrade normally on release day.
   - **Reseed once after deploying intent replay.** Seeds write the replay data into their intent records only from that deploy on. A fleet seeded earlier has no replayable wishes, and every fork would upgrade by merge.
   - To reseed: `POST /api/admin/fleet/cleanup` with `{}` and the admin header. This deletes only `user-seed-*` forks. Then in **Fleet**, enter the admin secret, set **Seed demo fleet** to 200 (the box defaults to 300), and press **Seed**. It settled in about 40 seconds on production.
   - Do not seed fewer than 12. The forks that stay pinned on release day (compact research answers) are seed numbers 11, 61, 111, and 161, so a 200-fork fleet has 4 of them.
5. **The replay shot needs a release.** "Wishes carried to vX" and the counts "by intent replay" and "by merge" appear only after a release is tagged. In Scene 5, **uncheck Safety release**. On a safety release, any wish that changes a file stock also changed takes the merge path on purpose, and the seeded wishes touch such files, so almost nothing would replay. If you rehearse a release on production, clean up and reseed afterwards; the next tag goes up by one.
6. **Clear the page state.** Open a fresh private window (or a new browser profile) on the live URL. The session cookie, and with it your persona forks, belongs to that window. Reloading keeps the same session and the same forks. The **Customize** view keeps its last run only in the page, so do not reload while a run is on screen.
7. **Create the persona forks a few minutes before recording, in that window.** The first page load provisions Dr. Rowan Ellery's fork (4 to 7 seconds). Then click **Sam Okonkwo-Reyes**, then **Dana Whitfield**, once each. That makes three forks, which is exactly the per-client limit of 3 forks per hour. A client is your public IPv4 address (or IPv6 /64), so every browser on your network shares it.
   - Switching back to a persona you already used in this window reuses its fork and costs no quota. You can switch freely during the recording.
   - Do not open another private window or profile within the hour, and do not provision forks from other devices on the same network. A new window starts a new session, and a fourth fork is refused with a quota error.
   - If you have to start over within the hour, wait until an hour has passed since the first fork, or delete the old forks first (`POST /api/admin/forks/<repo>/delete` with the admin header). Deleting does not give quota back.
   - The inbox repo is not a fleet fork and does not count toward these limits.
8. **Token rules for Scene 4.** Each token from **Get a one hour git token** lasts one hour and writes only to the fork's inbox. Every token request deletes the inbox and forks it again from the fork's `main`. So a new token ends the old one, and any clone or push made with the old one is lost. Mint the token only once, in Shot 4.2, and clone with that token. If you minted one in rehearsal, the on-camera token replaces that inbox, so clone again; never reuse a rehearsal clone. After the first token the button reads **Get a new token (replaces your inbox)**: do not click it during the scene. Limits: 3 tokens per hour per user, 6 per client, 60 overall. The inbox is deleted 15 minutes after its token expires.
9. **Import rules for Scene 4.** Only a new head of a branch named `work/<name>` is imported; pushes to the inbox's `main`, tags, and other branches are ignored. A fork takes at most 10 imports an hour (200 an hour across the platform), and a push must stay within 50 commits, 200 files, 1 MB per file, and 8 MB to download. A refused import (over a quota or a cap) shows nothing in the live UI: the branch simply never appears in **My fork**. Pushing the same commit to the same branch again is silently ignored, because the import is keyed by fork, branch, and commit. To retry, amend the commit (`git commit --amend --no-edit`, then `git push -f origin work/<name>`) or push under a new `work/` name. A failed gate on an imported change opens no repair: fix it and push a new commit.
10. **Prepare the terminal for Scene 4.** Use a terminal with a large font (18 pt or more) next to the browser, each at half the screen. Prepare the change you will commit before recording: something small you rehearsed on the live URL (local dev cannot import) more than an hour before recording, because a rehearsal fork counts toward the 3 forks per hour per client, for example one new tier 3 test in `tests/user/manifest.json` plus a one-line wording change. Do not add a `.intent/` record, so the gate drafts one. Do not touch `fluid.toml`; the threshold change in the same scene writes it. The clone command carries the token in its URL: pause the recording after Shot 4.2 and clone off camera, then start Shot 4.3 at `git checkout -b`, or blur the clone line in editing.
11. **Pick the clock times.** The synthetic schedule for 2026-10-03 has Dr. Rowan Ellery on service from 07:00 to 13:00, and a manuscript writing block from 14:00 to 17:00. The manuscript shot must be off service, after 14:00. The **Writing the manuscript** scene sets the clock to 15:00. The **At the bedside** scene sets 09:00. Check the clock readout before each ask.
12. **Keep the fleet stream open.** Open **Fleet** in a second tab and leave it open. Confirm the header reads **Live stream: live**. Switch to that tab for Scene 5.
13. **Rehearse Scene 2 in your head, not on production.** A dry run in the recording window uses the same fork, and the run then shows up in its history. Rehearse the model-planned request (Shot 2.6) in local dev; a model plan can differ from run to run. On production the REDCap customization took 13 to 20 seconds from accepting the tests to the merge, the yellow soak to green about 40 seconds, and the lower threshold run 15 to 27 seconds to the failed gate and the repair. Plan to cut the waits in editing.
14. **Screen setup.** Browser at 1440 by 900, zoom 100 percent, light theme (**Theme** button in the bottom left), notifications off. The synthetic data notice bar stays visible at the top of every shot.

### Mock mode fallback

Every live scene has a fallback in mock mode: open the live URL with `/?mock=1`. Mock mode runs in the browser, answers with the real stock engine, and simulates the gate, the yellow soak, releases, replay, the inbox, and harvest. It needs no admin secret and uses no quota. Its state lives only in the page, so do not reload in the middle of a scene. Exact mock steps are listed at the end of each scene. Two things differ: the mock fleet has 360 forks, so say "hundreds" rather than "two hundred", and the mock does not run the model, so a request that matches no recipe fails with "Not mapped" (skip Shot 2.6 in mock mode).

## Opening: the Git idea (0:45)

**Shot O1 (0:45).** Title card "Fluid", then three lines appear one by one on a plain background:
1. "One fork per person."
2. "Every change carries its reason."
3. "Behavior is the merge rule."
Then a fourth, smaller line: "Agents keep thousands of forks current."

Narration:
> This is Fluid, our idea for the next Git platform.
> First, every person gets their own fork. A fork is an Artifacts repository, made from a shared release, called stock.
> Second, every change carries its reason, as data in the repo. An intent record sits next to the code. The commit points to it with an Intent-Id trailer.
> Third, behavior is the merge rule. A change merges only if it still behaves like upstream, on upstream's own tests.
> And agents keep thousands of forks current.
> We built it for medicine, because medicine is the hardest test case. But the platform is domain-agnostic. Stock can be any repo with invariants.

Point out: nothing yet. Keep it fast.

## Scene 1: one question, two jobs (1:00)

Persona: **Dr. Rowan Ellery**, hospitalist and researcher. View: **Workspace**.

**Shot 1.1 (0:30).** Click **Dr. Rowan Ellery** under **Signed in as**. Under **Scenes**, click **At the bedside**. The clock jumps to 09:00 and a synthetic patient chart opens. Click the first example question, "What is the right dose of Morphinex for a patient of 70 kg and 45 years?"

> Dr. Ellery has her own fork. All the data you see is synthetic.
> It is nine in the morning. She is on service, with a patient's chart open. She asks a dosing question.
> Fluid answers in clinical mode. It cites the policy, shows why it chose that mode, and gives no computed dose.
> That rule lives in stock. Her fork cannot remove it.

Point out: the fork pill in the top right (repo name and pinned stock tag), the **Clinical** badge, **Signals that drove the intent**, and the absence of a dose.

**Shot 1.2 (0:30).** Click **Writing the manuscript**. The clock reads 15:00 and **Off service per call schedule** shows. Click the same example question.

> At three in the afternoon she is off service, writing a paper. Same question.
> Now Fluid answers in research mode. It computes the dose for the stated numbers and cross-checks two independent sources.
> If the signals are unclear, it shows one labeled answer per job, and she picks. Every answer is logged with the fork commit that produced it.

Point out: the **Research** badge, the box "Computed dose, hypothetical parameters", and the two sources with different publishers.

Mock fallback: `/?mock=1`, click **Dr. Rowan Ellery**, then the same scenes and question. The answers come from the real stock engine.

## Scene 2: customization, by recipe or by model (2:05)

Persona: **Sam Okonkwo-Reyes**, research coordinator, then **Dana Whitfield**, department administrator. View: **Customize**.

**Shot 2.1 (0:10).** Click **Sam Okonkwo-Reyes**, then **Customize** in **Views**. Under the examples, click "Add a REDCap connector so research mode reports enrollment for my protocols". Click **Start customization**.

> Sam runs two research protocols. He asks his fork, in plain words, to report enrollment.

**Shot 2.2 (0:25).** Watch the **Run** timeline fill in. Point at **Diff summary** and **Intent record for this change**. In **Suggested tests**, read the first suggestion, then click **Accept** on each one.

> An agent writes the change on a work branch in Sam's fork.
> Before it commits, it writes the intent record: what Sam asked for, why, and which files it touches.
> Then a test suggester proposes tests for Sam's own tier. Sam accepts them. He could edit or reject them.

Point out: the branch name `work/...` next to **Diff summary**, the intent record id, and "verifies int_..." under each test.

**Shot 2.3 (0:15).** Watch **Gate result** turn green.

> The gate has three tiers. Tier one is the stock safety rules. Tier two is the stock functional tests. Both come from stock, never from Sam's fork. Tier three is Sam's own tests.
> All pass, so the change merges.

Point out: the three tier boxes and their counts.

**Shot 2.4 (0:25), required: yellow to green.** Stay on **Customize**. The top bar badge reads **Yellow: soak pass 1 of 3**, and the **Yellow phase** panel fills in with the stock end-to-end scenarios, Sam's accepted REDCap scenario, and the browser checks. About 40 seconds later (cut the wait) it turns **Green**.

> Merged means live, but in yellow.
> A slower end-to-end suite now runs against Sam's live fork three times in a row, plus a real browser check.
> If any of it fails, main rolls back on its own to the last green commit, and a repair opens. Here it turns green.

Point out: the badge in the top bar, the three-segment soak bar, and Sam's own scenario in the list (its id ends in `e2e-redcap-no-leak`).

**Shot 2.5 (0:10).** Go to **Workspace**, click **IRB portal**, type "How many participants are enrolled in IRB-2026-0142?" and press **Ask**.

> Research mode now answers with live enrollment, from his fork.

Point out: the enrollment figure in the research card.

**Shot 2.6 (0:25), a model-planned change.** Click **Dana Whitfield**, then **Customize**. Type "Flag budget lines that are more than 10 percent over plan in administrative answers" and click **Start customization**. Point at the first step, **Plan the change**, while it is still running: it says "Planning with" and the model name, not "Matched the ... recipe". When the plan is done, the step shows the change summary instead, so catch it early (if a check fails, it reads "Repair 1 of 2: the exact error went back to" the model). Accept the suggested tests and cut to **Gate result**.

> Simple requests, like Sam's, use fixed recipes. A request that matches no recipe goes to a model.
> The model's plan is checked before anything runs it: which files, whether it loads, whether it answers. If it fails a check, the model gets the exact error and tries again, at most twice.
> Either way, the gate decides. Recipe or model, nothing merges without the three tiers.

Point out: **Plan the change** with the model name (only while it runs), the intent record, and the tier boxes. If the run ends with "Nothing committed", keep it: point at **Why the run stopped** and say "nothing reached main". Rehearse this request in local dev first.

**Shot 2.7 (0:15), montage.** Still as Dana, in **Customize**, run three short requests back to back, each cut to the moment it merges:
1. "Give the app a crimson look and feel": the app turns bold red and white.
2. "Make the look and feel like it is 2001 and we run on Windows XP" (an example on the page): the Luna XP look.
3. "Add a page of charts": a **Charts** tab appears under **Your tabs** and opens.

> A fork can change its own look too. These go through a declarative file that the platform checks. No fork code runs in the browser. And each change is gated, and goes yellow, then green.

Point out: **How your request was mapped**, and the line "Merged to main, live in yellow" that turns to "Applied".

Mock fallback: `/?mock=1`, click **Sam Okonkwo-Reyes**, **Customize**, and the same REDCap request. The mock runs the gate, then the yellow soak with three passes and the browser checks, then **Green**. Then **Dana Whitfield** and the three look requests; they use the same recipe code as the platform. Skip Shot 2.6.

## Scene 3: a failed shortcut (0:40)

Persona: **Sam Okonkwo-Reyes**. View: **Customize**.

**Shot 3.1 (0:10).** Click **Sam Okonkwo-Reyes**, then **Customize**. Click the example "Lower my confidence threshold to 0.6". Click **Start customization**. Accept the suggested test.

> Sam finds the multi-answer view slow. He asks to lower his confidence threshold to 0.6.

**Shot 3.2 (0:20).** Scroll to **Gate result**. It reads "Gate failed ... Merge is blocked." Point at **Failing probes**.

> The gate fails. Stock sets a minimum confidence threshold of 0.85, and a stock rule checks it.
> Here is the failing check: the file, the expected value 0.85, the actual value 0.6.
> Main is untouched.

Point out: the red **Tier 1: invariants** box, the probe id `inv-tau-config-floor`, and the Expected and Actual rows.

**Shot 3.3 (0:10).** Click **My fork**. Point at **Branches** and the threshold meter.

> A repair agent already opened a repair branch that explains why. Sam can raise his threshold. He can never go below the stock minimum.

Point out: the `repair/...` branch, and the red stock minimum mark on the meter.

Mock fallback: `/?mock=1`, same steps.

## Scene 4: bring your own agent (1:20)

Persona: **Sam Okonkwo-Reyes**. Views: **Customize** and **My fork**, with a terminal on the right half of the screen.

**Shot 4.1 (0:10).** In **Customize**, click the example "Raise my confidence threshold to 0.9" and click **Start customization**. Stop when **Suggested tests** appears. Do not accept yet.

> The platform's own agent is now working on Sam's fork. At the same time, Sam wants to use his own coding agent.

**Shot 4.2 (0:15).** Click **My fork**. In the **Connect your own agent** panel, click **Get a one hour git token** once. The panel shows the countdown "Expires in 59:..", the line "Write access to your inbox inbox-user-... only, never to user-.... Branches that start with work/ are imported.", and the five commands, with the secret hidden as `art_v2_****`. On the live site Sam's fork has a session name (`user-s-` and ten letters and digits, the same name as in the fork pill), so the inbox is `inbox-` plus that name. Only mock mode shows `inbox-user-research-coordinator`.

> Any git client or coding agent can work on his fork.
> The token lasts one hour, and it only reaches an inbox: a fresh copy of his fork's main. It cannot write the fork itself.

Point out: the "Write access to your inbox ... only, never to ..." line, the branch prefix `work/`, and the hidden secret. Do not click **Show token**, and do not click the button again: it now reads **Get a new token (replaces your inbox)**, and a second token would delete this inbox.

**Shot 4.3 (0:20).** Split screen. In the terminal, run the commands from the panel (use its **Copy** buttons). Clone with the recording paused, or blur the clone line. The panel suggests the branch `work/my-change`; any `work/<name>` works, so this script uses `work/plain-summary`:

```sh
git clone https://x:<token>@<account>.artifacts.cloudflare.net/git/fluid/<inbox>.git <inbox>
cd <inbox>
git checkout -b work/plain-summary
# apply the change you prepared
git add -A && git commit -m "Add a plain summary line to research answers"
git push origin work/plain-summary
```

> This is plain git. Clone, branch, commit, push.
> He pushes a work branch to his inbox. There is no intent record in this push.

**Shot 4.4 (0:20).** In the browser, wait (cut the wait; time the import in rehearsal, it was not measured on production), then click **My fork** in **Views** to refresh it. Click again if nothing changed yet. The import lands in the fork as `work/inbox/plain-summary`, not `work/plain-summary`. **Branches** and **Recent gate runs** list `work/inbox/plain-summary`, and the gate run shows its tier tags (invariant, functional, user). The **Health: yellow to green** panel reads **Yellow: soak pass n of 3** (or **Green** if the soak already finished) with **Landed by** `outside-push`. The **Intent ledger** shows a new record "outside agent, via outside-agent".

> The platform copied the branch from his inbox into his fork, under work/inbox.
> Every change needs its reason, so the gate drafted an intent record from his commit messages and the files he touched.
> Then the same three tiers ran. It passed, merged, and is live in yellow.
> Only the gate moves main. Not Sam's agent, and not ours.

Point out: the branch name `work/inbox/plain-summary`, the drafted record (its request is the commit message), the three tier tags in **Recent gate runs**, and the yellow badge.

**Shot 4.5 (0:15).** Go back to **Customize**. The threshold run is still waiting at **Suggested tests**. Click **Accept** on each suggested test and cut to **Gate result**. The run commits on top of the new main, so its timeline has no "main moved" step: main moved before it committed, and the outside change did not touch `fluid.toml`, the one file the threshold change writes. The gate passes and the change merges.

> Our own agent planned its change before Sam's push landed.
> When Sam accepts, it commits on top of the new main, so Sam's work stays. Then it goes through the same three tiers.
> If main moves while a gate is running, the gate merges the new main in and gates it again. If both changed the same lines, it stops and names the files.
> Two agents, one fork, no lost work.

Point out: the merge, the badge going yellow, then **Green**. Optionally click **My fork**: the **Intent ledger** now holds both records, the drafted one and the threshold one.

Optional, to show the race on camera (rehearse it first; the timing is not reliable): push in Shot 4.3, then accept the threshold test a few seconds later, so both gates run at the same time. If Sam's change lands while ours is in its gate, the **Customize** timeline adds a step **main moved during the gate** that reads "main moved to ... by an outside push (...); merged it into work/... as ..., which is gated next. main is unchanged.", and the merge is gated again before it lands. If ours lands first, Sam's change is the one merged and gated again, and **Customize** shows nothing about it; then use the narration above. For this variant, leave the tier 3 test out of the prepared change: both changes would add to `tests/user/manifest.json`, which can conflict and stop the run.

Mock fallback: `/?mock=1`, click **Sam Okonkwo-Reyes**. In **Customize**, start "Raise my confidence threshold to 0.9" and stop at **Suggested tests**. Click **My fork**, then **Get a one hour git token**, then **Simulate a push to the inbox**. The panel follows the run step by step: "Push received in inbox-user-research-coordinator on work/my-change", **Import from your inbox** (pushed to `work/inbox/my-change`), **Check the change** (the drafted record), **Gate tier 1: invariants**, **Gate tier 2: functional**, **Gate tier 3: user tests**, **Merge to main**, then **Yellow: soak pass n of 3** and **Green**, with the drafted record below. Then go back to **Customize** and accept the suggested tests: its **Merge to main and deploy** step starts "main moved to ... by an outside push (...); main was merged into work/... and the merge passed the gate." The mock shows this line whenever the outside push lands while the run is waiting, so the narration above fits both. Optional: **Simulate a push to inbox main** shows the push ignored, because only `work/*` branches are imported. In mock mode skip the terminal, or show the commands in the panel instead.

## Scene 5: release day and intent replay (2:05)

View: **Fleet**, in the tab you kept open.

**Shot 5.1 (0:10).** Show the full grid, almost all **Pinned**.

> This is the fleet view for the central team. Each square is one person's fork. There are about two hundred.

Point out: the header with the fork count and stock tags, and **Live stream: live**.

**Shot 5.2 (0:15).** In **Release**, leave the suggested **Tag** and the **Release notes**. Uncheck **Safety release**. The admin secret is already filled in. Click **Tag release and upgrade the fleet**.

> The central team tags a new release. One click starts one upgrade agent per fork.

Point out: the status line "Tagged v... N upgrade runs started."

**Shot 5.3 (0:30).** Watch the grid and counters change: **Upgrading**, **Gating**, **Passed**, **Yellow (soaking)**. Point at the **Event stream**.

> Hundreds of agents, on hundreds of repositories, at once.
> Each fork goes through its own gate at the new release. Forks that upgrade on their own go live in yellow, soak three times, and turn green. A failure would roll that fork back by itself.

A 200-fork release took about 2 to 3 minutes in rehearsals. Cut the waits.

Point out: the counters moving, yellow squares turning green, and event lines ending in ", N of N wishes replayed".

**Shot 5.4 (0:40).** Point at the line under the status bar: "Upgraded to vX: N by intent replay (wishes granted again on fresh stock), M by merge." Click **Show a replayed fork that would have conflicted under merge**. In **Fork detail**, point at "Wishes carried to vX: N of N", the **replayed** tags, the line "Stock vX also changed app/cards.ts. A merge would have had to resolve it; replay granted the wish again on the new code.", and **Gate on the replay branch**.

> Most tools upgrade a fork by merging old text into new text. That is where conflicts come from.
> A Fluid fork is a list of wishes and the tests that prove them. On every release we grant your wishes again on fresh code.
> This fork reworded the same line the release reworded. A merge would conflict. Replay starts from the new release, applies the fork's wish again, and runs the fork's own tests to prove it still holds.

Point out: the counts, the wish list, and the run step "Replay wishes on stock vX".

**Shot 5.5 (0:30).** Under **Needs attention**, click a fork with **repair open**. Scroll **Fork detail**.

> Replay only takes wishes it can repeat exactly. Everything else takes the merge path.
> There, a merge agent resolves conflicts guided by the fork's intent records. It uses a model for small conflicts, and a fixed rule otherwise. Either way, the gate decides.
> This fork did not pass. One customization breaks a stock rule at the new release. So it stays on the release it was on.
> A repair agent read its intent records, explains the failure, and proposes a fix on a repair branch. Repairs never merge on their own.

Pick a fork whose explanation reads well on camera. The seeds that stay pinned carry a compact research customization that fails only `inv-research-cross-check-visible` at the new tag. Be honest about numbers: say "some conflicts" for the merge agent and the fixed rule unless you counted them in this run's **Run steps**.

Point out: the summary line, the **Repair agent:** explanation, **Run steps**, **Proposed fix**, the failing probe under **Gate on the upgrade branch**, and the highlighted intent record it relied on.

Mock fallback: `/?mock=1`, **Fleet**, uncheck **Safety release** as on live, then **Tag release and upgrade the fleet** (there is no admin secret field). The mock fleet has 360 forks. Forks whose wishes are all replayable upgrade by replay on `replay/<tag>`; the others merge. The counts line, **Show a replayed fork that would have conflicted under merge**, "Wishes carried to vX", and the repair forks under **Needs attention** all appear.

## Scene 6: harvesting (0:25)

View: **Harvest**.

**Shot 6.1 (0:25).** Click **Harvest**, then **Run the harvester** (or **Run the harvester again**). When it finishes, click the REDCap cluster in **Clusters** and point at **Proposal**.

> Forks also tell the central team what people need.
> With each user's opt-in, a harvester reads intent records across forks and groups similar changes.
> Many people added the same REDCap connector. The harvester drafts it as a stock branch, with the intent records it came from, for the maintainers to review.

Point out: the fork count, **Draft stock feature branch:** `harvest/...`, and **Intent records it was built from**. Do not say the harvester removes code from forks; it only drafts a branch.

Mock fallback: `/?mock=1`, **Harvest**, **Run the harvester**, then the REDCap cluster.

## Closing (0:30)

Static slide titled **Fluid: what the next Git platform looks like**, with three lines and the pitch line:

1. One fork per person.
2. Every change carries its reason, as data in the repo.
3. Behavior is the merge rule.

"A Fluid fork is a list of wishes and the tests that prove them."

Footer: https://fluid.frontier-software.workers.dev, https://github.com/renato-umeton/fluid, "Built on Cloudflare Workers and Artifacts", "MIT license", "All data synthetic".

Narration:
> One fork per person. Every change carries its reason. Behavior decides what merges.
> A Fluid fork is a list of wishes and the tests that prove them. On every release we grant your wishes again on fresh code.
> It all runs on Cloudflare Workers and Artifacts. Try it at the link on screen. The code is MIT licensed, and all the data is synthetic.

## If something goes wrong while recording

- A card says "The fork could not answer": wait a few seconds and ask again. The fork isolate loads on first use.
- **Live stream** reads **reconnecting**: reload the Fleet tab before tagging.
- A release fails with a 409: the tag already exists. The form suggests the next tag after a reload.
- Fork creation fails with a quota error: you hit the 3 forks per hour limit. Go back to the window that already has the persona forks; switching personas there costs nothing.
- A harvest or release button reports `admin token required`: enter the admin secret in **Fleet** first. It is kept for the browser tab only.
- The counts line shows 0 by intent replay: **Safety release** was checked, or the fleet was seeded before intent replay was deployed. Reseed and release again, or use the mock fallback.
- The pushed branch never shows up in **My fork**: click **My fork** again to refresh it, and look for `work/inbox/<name>`, not `work/<name>`. Then check that you pushed a branch whose name starts with `work/` (pushes to the inbox's main, tags, and other branches are ignored), that you cloned with the latest token (a newer token deleted the old inbox, so that push is lost), and that the fork has not used its 10 imports this hour or broken a cap. A refused import shows nothing in the live UI. Pushing the same commit again does nothing: amend it or push under a new `work/` name.
- The imported change fails the gate: no repair opens for it. Fix the change in the terminal, commit (or amend), and push again.
- The token shows "Expired. Get a new token to push again.": click **Get a new token (replaces your inbox)**. It deletes the old inbox and makes a fresh one from the fork's main, so clone again before you push.
- A model-planned change ends with "Nothing committed": that is a true outcome. Show **Why the run stopped**, or cut the shot.
- Any live scene fails on the day: switch to `/?mock=1` and follow that scene's mock steps.
