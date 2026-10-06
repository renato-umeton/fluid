# Demo video script (v2.0-beta)

Target length: about 8 minutes 50 seconds. The competition allows 5 to 10. Keep it between 8 and 9.5, and never go over 10.

The video opens with the tagline and the four ideas, then shows them working: one question in two jobs, customization with the yellow soak, a contest between agents, your own agent pushing over plain git, release day with intent replay, the ledger, and harvest. Each shot lists its time budget, what to click, the narration, and what to point out. View and control names match the UI in `platform/public/`.

Words to avoid on camera, and what to say instead:

- "mothership": say "the central team" or "the fleet view".
- "floor": say "upstream's safety rules" or "the upstream minimum".
- "tau" or "τ": say "confidence threshold". The UI still shows the τ symbol; that is fine on screen.
- "stock": say "upstream". The UI says upstream. A few run step names on the live site still say stock (for example "Replay wishes on stock v1.14.0", "Merge stock v1.14.0 into ...", "Draft stock feature branches for eligible clusters"). If one is on screen, you can say once: "stock is our code name for upstream".
- "wish": say it freely after the opening defines it: one change plus its reason.
- "probe": say "test question".
- "check mode" and "merge mode": say "a trial gate" and "the real gate".
- "isolate": say "a sandbox".
- "invariant": say "a safety rule".

Running total: about 8 minutes 50 seconds.

| Part | Budget | Ends at |
| :-- | :-- | :-- |
| Opening: four ideas | 0:45 | 0:45 |
| Scene 1: the proving ground, one question in two jobs | 1:00 | 1:45 |
| Scene 2: customization, recipe and yellow soak | 1:35 | 3:20 |
| Scene 3: Contest | 1:30 | 4:50 |
| Scene 4: bring your own agent | 1:00 | 5:50 |
| Scene 5: release day and intent replay | 1:40 | 7:30 |
| Scene 6: the ledger | 0:20 | 7:50 |
| Scene 7: harvest | 0:20 | 8:10 |
| Closing | 0:40 | 8:50 |

## Pre-recording checklist

Live URL: https://fluid.frontier-software.workers.dev

Do these in order, about 30 minutes before recording.

1. **Deployment is current.** The deployed Worker runs the latest `main`, including intent replay, bring your own agent (the inbox token, the import workflow, and the **Connect your own agent** panel), Contest, and the upstream wording in the UI. Push `main` and deploy before recording, then smoke test one token, one outside push, and one replay upgrade on a test fork. Upstream is published (`npm run publish-stock`, see `docs/DEPLOY.md`). The **Fleet** header lists **Upstream tags** up to the newest release, and the **Release** form suggests the next tag. Use the tag the form suggests.
2. **The inbox flow needs the deployed Worker.** An outside push is imported only when the Artifacts push event reaches the Queue, which then starts an import workflow. Queue events go only to the deployed consumer (`docs/DEPLOY.md`), so Scene 4 only works on the live URL (or in mock mode, see below). On the live URL the import has no step-by-step timeline on screen: the result shows up in **My fork** only after you click **My fork** again to refresh it.
3. **Admin secret ready.** Have the `ADMIN_TOKEN` value in your password manager. You will paste it once into the Fleet view (**Admin secret (sent as x-fluid-admin)**). Never show it on screen: paste it before you start recording the Fleet scene, or blur it in editing.
4. **Check the fleet.** The production fleet should hold 200 seeded forks pinned to v1.5.0. **Fleet** should show about 195 **Pinned** and 5 **Repair open**. The repair-open forks are seeds whose lowered confidence threshold failed on a work branch. Their `main` is clean, so they upgrade normally on release day.
   - **Reseed once after deploying intent replay.** Seeds write the replay data into their intent records only from that deploy on. A fleet seeded earlier has no replayable wishes, and every fork would upgrade by merge.
   - To reseed: `POST /api/admin/fleet/cleanup` with `{}` and the admin header. This deletes only `user-seed-*` forks. Then in **Fleet**, enter the admin secret, set **Seed demo fleet** to 200 (the box defaults to 300), and press **Seed**. It settled in about 40 seconds on production.
   - Do not seed fewer than 12. The forks that stay pinned on release day (compact research answers) are seed numbers 11, 61, 111, and 161, so a 200-fork fleet has 4 of them.
5. **The replay shot needs a release.** "Wishes carried to vX" and the counts "by intent replay" and "by merge" appear only after a release is tagged. In Scene 5, **uncheck Safety release**. On a safety release, any wish that changes a file upstream also changed takes the merge path on purpose, and the seeded wishes touch such files, so almost nothing would replay. If you rehearse a release on production, clean up and reseed afterwards; the next tag goes up by one. Rehearsals on 2026-10-06 used v1.12.0 and v1.13.0 (after the replay retry fix: 167 forks by replay, 39 by merge, none failed), so release v1.14.0 on camera (the form suggests it).
6. **Clear the page state.** Open a fresh private window (or a new browser profile) on the live URL. The session cookie, and with it your persona forks, belongs to that window. Reloading keeps the same session and the same forks. The **Customize** view keeps its last run only in the page, so do not reload while a run is on screen.
7. **Create the persona forks a few minutes before recording, in that window.** The first page load provisions Dr. Rowan Ellery's fork (4 to 7 seconds). Then click **Sam Okonkwo-Reyes**, then **Dana Whitfield**, once each. That makes three forks, which is exactly the per-client limit of 3 forks per hour. A client is your public IPv4 address (or IPv6 /64), so every browser on your network shares it.
   - Switching back to a persona you already used in this window reuses its fork and costs no quota. You can switch freely during the recording.
   - Do not open another private window or profile on the live URL within the hour, and do not provision forks from other devices on the same network. A new window starts a new session, and a fourth fork is refused with a quota error. Mock mode (`/?mock=1`) creates no live forks, so the mock tab for Scene 3 is safe.
   - If you have to start over within the hour, wait until an hour has passed since the first fork, or delete the old forks first (`POST /api/admin/forks/<repo>/delete` with the admin header). Deleting does not give quota back.
   - The inbox repo is not a fleet fork and does not count toward these limits.
8. **Token rules for Scene 4.** Each token from **Get a one hour git token** lasts one hour and writes only to the fork's inbox. Every token request deletes the inbox and forks it again from the fork's `main`. So a new token ends the old one, and any clone or push made with the old one is lost. Mint the token only once, in Shot 4.1, and clone with that token. If you minted one in rehearsal, the on-camera token replaces that inbox, so clone again; never reuse a rehearsal clone. After the first token the button reads **Get a new token (replaces your inbox)**: do not click it during the scene. Limits: 3 tokens per hour per user, 6 per client, 60 overall. The inbox is deleted 15 minutes after its token expires.
9. **Import rules for Scene 4.** Only a new head of a branch named `work/<name>` is imported; pushes to the inbox's `main`, tags, and other branches are ignored. A fork takes at most 10 imports an hour (200 an hour across the platform), and a push must stay within 50 commits, 200 files, 1 MB per file, and 8 MB to download. A refused import (over a quota or a cap) shows nothing in the live UI: the branch simply never appears in **My fork**. Pushing the same commit to the same branch again is silently ignored, because the import is keyed by fork, branch, and commit. To retry, amend the commit (`git commit --amend --no-edit`, then `git push -f origin work/<name>`) or push under a new `work/` name. A failed gate on an imported change opens no repair: fix it and push a new commit.
10. **Prepare the terminal for Scene 4.** Use a terminal with a large font (18 pt or more) next to the browser, each at half the screen. Prepare the change you will commit before recording: something small you rehearsed on the live URL (local dev cannot import) more than an hour before recording, because a rehearsal fork counts toward the 3 forks per hour per client, for example one new tier 3 test in `tests/user/manifest.json` plus a one-line wording change. Do not add a `.intent/` record, so the gate drafts one. Do not touch `fluid.toml`. The clone command carries the token in its URL: pause the recording after Shot 4.1 and clone off camera, then start Shot 4.2 at `git checkout -b`, or blur the clone line in editing.
11. **Pick the clock times.** The synthetic schedule for 2026-10-03 has Dr. Rowan Ellery on service from 07:00 to 13:00, and a manuscript writing block from 14:00 to 17:00. The manuscript shot must be off service, after 14:00. The **Writing the manuscript** scene sets the clock to 15:00. The **At the bedside** scene sets 09:00. Check the clock readout before each ask.
12. **Keep the fleet stream open.** Open **Fleet** in a second tab and leave it open. Confirm the header reads **Live stream: live**. Switch to that tab for Scene 5.
13. **Prepare the Contest tab.** Record Scene 3 in mock mode. Open a third tab on `https://fluid.frontier-software.workers.dev/?mock=1#contest`. Contest is new in v2.0-beta. It is covered by unit tests, route tests, and mock mode, but it has not yet been run end to end against live Artifacts and Workers AI, so the live path is not ready for camera. The mock contest plays one fixed scenario whatever the wish: model-a wins, model-b changes administrative answers, and model-c adds a dose line and fails a safety rule. It decides in about 7 seconds, and the merge gate after **Ship the winner** takes about 3 seconds. Rehearse it once in that tab, then reload the tab before recording: mock state lives only in the page, and a fork runs one contest at a time.
14. **Rehearse Scene 2 off production.** A dry run in the recording window uses the same fork, and the run then shows up in its history. On production the REDCap customization took 13 to 20 seconds from accepting the tests to the merge, and the yellow soak to green about 40 seconds. Plan to cut the waits in editing.
15. **Screen setup.** Browser at 1440 by 900, zoom 100 percent, light theme (**Theme** button in the bottom left), notifications off. The synthetic data notice bar ("Synthetic demo data, not for clinical use.") stays visible at the top of every shot.

### Mock mode fallback

Every live scene has a fallback in mock mode: open the live URL with `/?mock=1`. Mock mode runs in the browser, answers with the real upstream engine, and simulates the gate, the yellow soak, contests, releases, replay, the inbox, and harvest. It needs no admin secret and uses no quota. Its state lives only in the page, so do not reload in the middle of a scene. Exact mock steps are listed at the end of each scene. Two things differ: the mock fleet has 360 forks, so say "hundreds" rather than "two hundred", and the mock does not run a model, so a Customize request that matches no recipe fails with "Not mapped".

## Opening: four ideas (0:45)

**Shot O1 (0:45).** Title card "Fluid", then the tagline: "Everyone gets their own fork. Behavior decides what ships." Then four short lines appear one by one on a plain background:

1. "Behavior is the merge rule."
2. "Living forks."
3. "Git is the audit log for what software says."
4. "Every commit runs."

Then a last, smaller line: "Proving ground: academic medicine."

Narration:
> This is Fluid. Everyone gets their own fork. Behavior decides what ships.
> One: behavior is the merge rule. A change reaches main only when upstream's tests pass, your own tests pass, and a live soak stays clean.
> Two: forks stay alive. You reshape yours in plain words or with your own agent, and each release grants your recipe wishes again on fresh code, while other changes merge. A wish is one change plus its reason.
> Three: git is the audit log for what software says. Every change records why. Every answer records the commit that produced it.
> Four: every commit runs, in its own sandbox, with no build queue.
> We picked the domain where a wrong merge can hurt someone. If behavior-gated forks are safe enough for a dosing question, they are safe enough for your expense tool.

Point out: nothing yet. Keep it fast.

## Scene 1: the proving ground, one question in two jobs (1:00)

Persona: **Dr. Rowan Ellery**, hospitalist and researcher. View: **Workspace**.

**Shot 1.1 (0:30).** Click **Dr. Rowan Ellery** under **Signed in as**. Under **Scenes**, click **At the bedside**. The clock jumps to 09:00 and a synthetic patient chart opens. Click the first example question, "What is the right dose of Morphinex for a patient of 70 kg and 45 years?"

> Dr. Ellery has her own fork. All the data you see is synthetic.
> It is nine in the morning. She is on service, with a patient's chart open. She asks a dosing question.
> Fluid answers in clinical mode. It cites the policy, shows why it chose that mode, and gives no computed dose.
> That rule lives upstream. Her fork cannot remove it.

Point out: the fork pill in the top right ("Fork user-... on upstream v..."), the **Clinical** badge, **Signals that drove the intent**, and the absence of a dose.

**Shot 1.2 (0:30).** Click **Writing the manuscript**. The clock reads 15:00 and **Off service per call schedule** shows. Click the same example question.

> At three in the afternoon she is off service, writing a paper. Same question.
> Now Fluid answers in research mode. It computes the dose for the stated numbers and cross-checks two independent sources.
> If the signals are unclear, it shows one labeled answer per job, and she picks.

Point out: the **Research** badge, the box "Computed dose, hypothetical parameters", and the two sources with different publishers. Keep this card on screen; Scene 6 comes back to it.

Mock fallback: `/?mock=1`, click **Dr. Rowan Ellery**, then the same scenes and question. The answers come from the real upstream engine.

## Scene 2: customization, recipe and yellow soak (1:35)

Persona: **Sam Okonkwo-Reyes**, research coordinator, then **Dana Whitfield**, department administrator. View: **Customize**.

**Shot 2.1 (0:10).** Click **Sam Okonkwo-Reyes**, then **Customize** in **Views**. Under the examples, click "Add a REDCap connector so research mode reports enrollment for my protocols". Click **Start customization**.

> Sam runs two research protocols. He asks his fork, in plain words, to report enrollment.

**Shot 2.2 (0:20).** Watch the **Run** timeline fill in. Point at **Diff summary** and **Intent record for this change**. In **Suggested tests**, click **Accept** on each one.

> A fixed recipe writes the change on a work branch in Sam's fork, with an intent record: what he asked for, why, and which files it touches.
> A test suggester proposes tests for Sam's own tier. He accepts them.

Point out: the branch name `work/...` next to **Diff summary**, the intent record id, and "verifies int_..." under each test.

**Shot 2.3 (0:15).** Watch **Gate result** turn green.

> The gate has three tiers. Tier one is upstream's safety rules. Tier two is upstream's functional tests. Both are read from upstream, so Sam's fork cannot edit them. Tier three is Sam's own tests. All pass, so main fast-forwards.

Point out: the three tier boxes and their counts.

**Shot 2.4 (0:25), required: yellow to green.** Stay on **Customize**. The top bar badge reads **Yellow: soak pass 1 of 3**, and the **Yellow phase** panel fills in with the upstream end-to-end scenarios, Sam's accepted REDCap scenario, and the browser checks. About 40 seconds later (cut the wait) it turns **Green**.

> Merged means live, but in yellow.
> A slower end-to-end suite now runs against Sam's live fork three times in a row, plus a real browser check.
> If any of it fails, main rolls back on its own to the last green commit, and a repair opens. Here it turns green.

Point out: the badge in the top bar, the three-segment soak bar, and Sam's own scenario in the list (its id ends in `e2e-redcap-no-leak`).

**Shot 2.5 (0:10).** Go to **Workspace**, click **IRB portal**, type "How many participants are enrolled in IRB-2026-0142?" and press **Ask**.

> Research mode now answers with live enrollment, from his fork.

Point out: the enrollment figure in the research card.

**Shot 2.6 (0:15), montage.** Click **Dana Whitfield**, then **Customize**. Run three short requests back to back, each cut to the moment it merges:

1. "Give the app a crimson look and feel": the app turns bold red and white.
2. "Make the look and feel like it is 2001 and we run on Windows XP" (an example on the page): the Luna XP look.
3. "Add a page of charts": a **Charts** tab appears under **Your tabs** and opens.

> A fork can change its own look too. These go through a declarative file that the platform checks, and no fork code runs in the browser. Each one is gated, goes yellow, then green.

Point out: **How your request was mapped**, and the line "Merged to main, live in yellow" that turns to "Applied".

Mock fallback: `/?mock=1`, click **Sam Okonkwo-Reyes**, **Customize**, and the same REDCap request. The mock runs the gate, then the yellow soak with three passes and the browser checks, then **Green**. Then **Dana Whitfield** and the three look requests; they use the same recipe code as the platform.

## Scene 3: Contest (1:30)

Persona: **Dr. Rowan Ellery**. View: **Contest**, in the mock tab you prepared (`/?mock=1#contest`).

**Shot 3.1 (0:15).** Switch to the mock tab. Say on camera that this scene runs in mock mode. The **Contest** view shows **One wish, several agents**. Under **Examples**, click "Add a plain-language summary line to research answers". Leave **Contestants** at **3 contestants** and leave "Let my own agent join (it pushes to the inbox within 5 minutes)" unchecked. Click **Start the contest**.

> What if several agents try the same wish? Here is Contest. This scene runs in our mock mode: the contest code is tested, but we have not yet run it end to end on live infrastructure, and the mock plays one fixed scenario.
> Dr. Ellery wants a plain-language summary line on research answers. Three agents will compete for it.

Point out: the line "A contest of N counts as N customizations on ...", and that the same option exists in **Customize** as "Run as a contest".

**Shot 3.2 (0:20).** Watch **Contestants** fill in side by side: **model-a** ("Model plan A: smallest change"), **model-b** ("Model plan B: direct and careful"), **model-c** ("Model plan C: edit in place"). Each column moves from **Planning** to **Checking**, and shows its branch `work/contest-<id>-<label>` and its tier lines.

> Each agent works on its own branch, writes its intent record, and faces the same wish tests.
> Each one goes through a trial gate, with all three tiers. The platform keeps the fork's answer to every test question, on main and on every branch.

Point out: the three branch names, and the **Contest** panel steps **Contestants work at the same time** and **Check main as the baseline**.

**Shot 3.3 (0:25).** When all three read **passed the gate** or **failed the gate**, point at **model-c**: "failed the gate", **Tier 1 invariants** "fail: 19 of 21", and "First failure: invariant: inv-chart-open-dosing-clinical (computed_dose equals)". Then scroll to **Behavior diff**, check **Only rows with changes**, and open "Show 2 field changes" in the model-c cell of the row `inv-chart-open-dosing-clinical`.

> Model C added a starting dose to every answer, clinical ones included. That breaks an upstream safety rule, so it can never win.
> This table is the behavior diff, and it takes the place of the pull request. Each row is a test question. Each column is main or a contestant. You review what changed in the answers.
> Model B passed too, but it also rewrote administrative answers. The wish was about research answers, so that counts against it.

Point out: in the model-c cell, "computed_dose changed from null to ...", and in the model-b column, "2 changes outside the wish". Model-a reads "0 changes outside the wish".

**Shot 3.4 (0:15).** Scroll up to the banner. It reads **Winner: model-a** and "model-a wins: like model-b, it passed every tier and every wish test, and it changed behavior on 0 probes outside the wish (model-b: 2)." Open **How the winner is picked**.

> The winner comes from a fixed rule. First, every tier and every wish test must pass. Then the fewest behavior changes outside the wish. Then the fewest files changed. Then whoever finished first.
> The rule says why, in words.

Point out: the four lines (a) to (d) under **How the winner is picked**, and the **winner** tag on the model-a column.

**Shot 3.5 (0:15).** Click **Ship the winner (model-a)**. The banner reads "Shipping model-a: the rule's choice. It is being gated in merge mode; main moves only if every tier passes.", then "Shipped model-a: the rule's choice. It is on main now, live in yellow until the end-to-end soak passes." and **Health:** "yellow, soak pass n of 3" (it starts at 0 of 3). Cut to **Health:** "green: the end-to-end soak passed 3 times".

> Only the one you ship goes through the real gate. It lands like any other change: fast-forward, yellow soak, then green.
> The others stay as branches, each with a note saying why it lost.
> And your own coding agent can join a contest too. It pushes its entry to your inbox, and the same rule judges it.

Point out: the notes under the banner ("model-b: lost to model-a because it changed behavior on 2 probes outside the wish (model-a: 0)"), and **Ship this one (model-b)** before you ship, to show you may pick another contestant that passed.

Mock fallback steps (this scene is already in mock mode; these are the steps if anything goes wrong):

1. Reload `https://fluid.frontier-software.workers.dev/?mock=1#contest`. This resets the mock, including any contest still running on the fork.
2. If the default persona is not Dr. Rowan Ellery, click her under **Signed in as**.
3. Click the example "Add a plain-language summary line to research answers", keep **3 contestants**, leave the join box unchecked, and click **Start the contest**.
4. Wait about 7 seconds for the banner **Winner: model-a**. Then click **Ship the winner (model-a)** and wait for **Health:** to read green.
5. If the start fails with "a contest is already running on this fork", reload (step 1).
6. If you checked "Let my own agent join", the mock simulates the agent joining after about 4 seconds, and the agent takes the failing seat in place of model-c. The narration still fits: say "this entry" in place of "model C".
7. To start from **Customize**: type the wish, check "Run as a contest: 3 agents compete on their own branches, a behavior diff and a fixed rule pick the winner (counts as 3 customizations)", and click **Start customization**. The app opens **Contest** with the run.

## Scene 4: bring your own agent (1:00)

Persona: **Sam Okonkwo-Reyes**. View: **My fork**, with a terminal on the right half of the screen. Back in the live tab.

**Shot 4.1 (0:15).** Click **Sam Okonkwo-Reyes**, then **My fork**. In the **Connect your own agent** panel, click **Get a one hour git token** once. The panel shows the countdown "Expires in 59:..", the line "Write access to your inbox inbox-user-... only, never to user-.... Branches that start with work/ are imported.", and the five commands, with the secret hidden as `art_v2_****`. On the live site Sam's fork has a session name (`user-s-` and ten letters and digits, the same name as in the fork pill), so the inbox is `inbox-` plus that name. Only mock mode shows `inbox-user-research-coordinator`.

> Any git client or coding agent can work on Sam's fork.
> The token lasts one hour and reaches only an inbox: a fresh copy of his fork's main. It cannot write the fork itself.

Point out: the "Write access to your inbox ... only, never to ..." line and the hidden secret. Do not click **Show token**, and do not click the button again: it now reads **Get a new token (replaces your inbox)**, and a second token would delete this inbox.

**Shot 4.2 (0:15).** Split screen. In the terminal, run the commands from the panel (use its **Copy** buttons). Clone with the recording paused, or blur the clone line. The panel suggests the branch `work/my-change`; any `work/<name>` works, so this script uses `work/plain-summary`:

```sh
git clone https://x:<token>@<account>.artifacts.cloudflare.net/git/fluid/<inbox>.git <inbox>
cd <inbox>
git checkout -b work/plain-summary
# apply the change you prepared
git add -A && git commit -m "Add a plain summary line to research answers"
git push origin work/plain-summary
```

> This is plain git. Clone, branch, commit, push. There is no intent record in this push.

**Shot 4.3 (0:30).** In the browser, wait (cut the wait; time the import in rehearsal), then click **My fork** in **Views** to refresh it. Click again if nothing changed yet. The import lands in the fork as `work/inbox/plain-summary`. **Branches** and **Recent gate runs** list it, and the gate run shows its tier tags (invariant, functional, user). The **Health: yellow to green** panel reads **Yellow: soak pass n of 3** (or **Green** if the soak already finished) with **Landed by** `outside-push`. The **Intent ledger** shows a new record "outside agent, via outside-agent".

> The platform copied the branch from his inbox into his fork, under work/inbox.
> Every wish needs its reason, so the gate drafted an intent record from his commit message and the files he touched.
> Then the same three tiers ran. It passed and is live in yellow. Only the gate moves main, whoever wrote the change.

Point out: the branch name `work/inbox/plain-summary`, the drafted record (its request is the commit message), the three tier tags in **Recent gate runs**, and the yellow badge.

Mock fallback: `/?mock=1`, click **Sam Okonkwo-Reyes**, then **My fork**, then **Get a one hour git token**, then **Simulate a push to the inbox**. The panel follows the run step by step: "Push received in inbox-user-research-coordinator on work/my-change", **Import from your inbox** (pushed to `work/inbox/my-change`), **Check the change** (the drafted record), **Gate tier 1: invariants**, **Gate tier 2: functional**, **Gate tier 3: user tests**, **Merge to main**, then **Yellow: soak pass n of 3** and **Green**, with the drafted record below. Optional: **Simulate a push to inbox main** shows the push ignored, because only `work/*` branches are imported. In mock mode skip the terminal, or show the commands in the panel instead.

## Scene 5: release day and intent replay (1:40)

View: **Fleet**, in the tab you kept open.

**Shot 5.1 (0:10).** Show the full grid, almost all **Pinned**.

> This is the fleet view for the central team. Each square is one person's fork. There are about two hundred.

Point out: the header with the fork count and **Upstream tags**, and **Live stream: live**.

**Shot 5.2 (0:15).** In **Release**, leave the suggested **Tag** and the **Release notes**. Uncheck **Safety release**. The admin secret is already filled in. Click **Tag release and upgrade the fleet**.

> The central team tags a new upstream release. One click starts one upgrade agent per fork.

Point out: the status line "Tagged v... N upgrade runs started."

**Shot 5.3 (0:25).** Watch the grid and counters change: **Upgrading**, **Gating**, **Passed**, **Yellow (soaking)**. Point at the **Event stream**.

> Hundreds of agents, on hundreds of repositories, at once.
> Each fork goes through its own gate at the new release, then soaks in yellow and turns green. A failure would roll that fork back by itself.

A 200-fork release took about 2 to 3 minutes in rehearsals. Cut the waits.

Point out: the counters moving, yellow squares turning green, and event lines ending in ", N of N wishes replayed".

**Shot 5.4 (0:35).** Point at the line under the status bar: "Upgraded to vX: N by intent replay (wishes granted again on fresh upstream code), M by merge." Click **Show a replayed fork that would have conflicted under merge**. In **Fork detail**, point at "Wishes carried to vX: N of N", the **replayed** tags, the line "Upstream vX also changed app/cards.ts. A merge would have had to resolve it; replay granted the wish again on the new code.", and **Gate on the replay branch**.

> Most tools upgrade a fork by merging old text into new text. That is where conflicts come from.
> A Fluid fork is a list of wishes and the tests that prove them. On every release we grant your recipe wishes again on fresh code. Other changes merge.
> This fork reworded the same line the release reworded. A merge would conflict. Replay starts from the new release, applies the wish again, and runs the fork's own tests to prove it still holds.

Point out: the counts, the wish list, and the run step "Replay wishes on stock vX" (the step name still says stock on the live site).

**Shot 5.5 (0:15).** Under **Needs attention**, click a fork with **repair open**. Scroll **Fork detail**.

> Wishes that replay cannot repeat exactly take the merge path, and the gate still decides.
> This fork breaks an upstream safety rule at the new release, so it stays where it was. A repair agent explains why and proposes a fix on a branch. Repairs never merge on their own.

Pick a fork whose explanation reads well on camera. The seeds that stay pinned carry a compact research customization that fails only `inv-research-cross-check-visible` at the new tag.

Point out: the **Repair agent:** explanation, **Proposed fix**, and the failing probe under **Gate on the upgrade branch**.

Mock fallback: `/?mock=1`, **Fleet**, uncheck **Safety release** as on live, then **Tag release and upgrade the fleet** (there is no admin secret field). The mock fleet has 360 forks. Forks whose wishes are all replayable upgrade by replay on `replay/<tag>`; the others merge. The counts line, **Show a replayed fork that would have conflicted under merge**, "Wishes carried to vX", and the repair forks under **Needs attention** all appear.

## Scene 6: the ledger (0:20)

Persona: **Dr. Rowan Ellery**. Views: **Workspace**, then **My fork**. Back in the first live tab.

**Shot 6.1 (0:20).** Click **Dr. Rowan Ellery**, then **Workspace**. The research answer from Scene 1 is still there (if not, click **Writing the manuscript** and ask the same question again). Point at the card footer: **Ledger record**, **Fork commit**, and **Upstream tag**. Click **Open in ledger**. **My fork** opens on the **Run-time ledger**, with that answer's row highlighted.

> Every answer points to its commit. The ledger row names the exact fork commit and the upstream tag that produced it, and the ledger itself is committed to git every day.
> The yellow soak tests this link too. If an answer ever named the wrong commit, the soak would roll the change back.

Point out: the highlighted row and its **Fork commit** and **Upstream** columns.

Mock fallback: `/?mock=1`, **Dr. Rowan Ellery**, **Writing the manuscript**, ask the example question, then **Open in ledger** on the card.

## Scene 7: harvest (0:20)

View: **Harvest**.

**Shot 7.1 (0:20).** Click **Harvest**, then **Run the harvester** (or **Run the harvester again**). When it finishes, click the REDCap cluster in **Clusters** and point at **Proposal**.

> Forks also tell the central team what people need. With each user's opt-in, a harvester groups similar wishes across forks, and drafts the common ones as an upstream branch for maintainers to review.

Point out: the fork count, **Draft upstream feature branch:** `harvest/...`, and **Intent records it was built from**. Do not say the harvester removes code from forks; it only drafts a branch.

Mock fallback: `/?mock=1`, **Harvest**, **Run the harvester**, then the REDCap cluster.

## Closing (0:40)

Static slide titled **Fluid: what the next Git platform looks like**, with the four questions from the brief and one answer each:

1. How do agents know what other agents are working on? Every wish in flight is a branch with its intent record, and run timelines and fleet status stream live.
2. How do you keep track of why? In git: intent records next to the code, and a ledger that ties every answer to its commit.
3. What about conflicting changes? Main only fast-forwards to a gated commit, and releases grant each wish again on fresh code.
4. How do you compare changes and decide which ships? A contest: a behavior diff and a fixed rule.

Then the tagline: "Everyone gets their own fork. Behavior decides what ships."

Footer: https://fluid.frontier-software.workers.dev, https://github.com/renato-umeton/fluid, "Built on Cloudflare Workers and Artifacts", "MIT license", "All data synthetic".

Narration:
> Cloudflare asked four questions.
> How do agents know what other agents are doing? Every wish in flight is a branch with its reason, and the platform streams every run live.
> How do you keep track of why? In git, next to the code, and every answer points to its commit.
> What about conflicts? Main only moves to a gated commit, and each release grants recipe wishes again on fresh code, while other changes merge.
> How do you pick which change ships? Let agents compete, and let behavior decide.
> Everyone gets their own fork. Behavior decides what ships.
> It all runs on Cloudflare Workers and Artifacts. Try it at the link on screen. The code is MIT licensed, and all the data is synthetic.

## If something goes wrong while recording

- A card says "The fork could not answer": wait a few seconds and ask again. The fork isolate loads on first use.
- **Live stream** reads **reconnecting**: reload the Fleet tab before tagging.
- A release fails with a 409: the tag already exists. The form suggests the next tag after a reload.
- Fork creation fails with a quota error: you hit the 3 forks per hour limit. Go back to the window that already has the persona forks; switching personas there costs nothing.
- A harvest or release button reports `admin token required`: enter the admin secret in **Fleet** first. It is kept for the browser tab only.
- The counts line shows 0 by intent replay: **Safety release** was checked, or the fleet was seeded before intent replay was deployed. Reseed and release again, or use the mock fallback.
- The pushed branch never shows up in **My fork**: click **My fork** again to refresh it, and look for `work/inbox/<name>` (the import adds `inbox/` to the name). Then check that you pushed a branch whose name starts with `work/` (pushes to the inbox's main, tags, and other branches are ignored), that you cloned with the latest token (a newer token deleted the old inbox, so that push is lost), and that the fork has not used its 10 imports this hour or broken a cap. A refused import shows nothing in the live UI. Pushing the same commit again does nothing: amend it or push under a new `work/` name.
- The imported change fails the gate: no repair opens for it. Fix the change in the terminal, commit (or amend), and push again.
- The token shows "Expired. Get a new token to push again.": click **Get a new token (replaces your inbox)**. It deletes the old inbox and makes a fresh one from the fork's main, so clone again before you push.
- The contest shows "a contest is already running on this fork": reload the mock tab and start again.
- Any live scene fails on the day: switch to `/?mock=1` and follow that scene's mock steps.
