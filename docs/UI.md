# Fluid UI

The UI is static and has no build step. `platform/public/` holds `index.html`, `styles.css`, `app.js`, and `js/`, which the platform Worker serves as static assets.

## Mock mode

The platform build copies `stock/dist/app.js` to `platform/public/vendor/stock-app.js` (gitignored). Mock mode (`?mock=1`, or automatic when `GET /api/personas` fails) uses that file to answer questions with the real stock engine, and falls back to canned cards when it is absent.

## Local preview

```
cd stock && npm run build && cp dist/app.js ../platform/public/vendor/stock-app.js
```

Then serve `platform/public/` and open `/?mock=1`.

## Untrusted text

Intent records, harvest labels, run steps, gate failures, and ledger records can carry attacker-controlled text. The UI never assigns HTML: every element is built with `h()` in `js/dom.js`, which sets text through text nodes and `textContent`. Keep it that way; do not add `innerHTML`, `insertAdjacentHTML`, or `outerHTML`.

## Fork UI preferences

A fork can change how the control plane looks for its owner through one declarative file, `ui/preferences.json`, on its `main`. No fork code ever runs in the browser.

- **Schema.** `platform/src/ui/preferences.ts` validates the file: `look` (`standard`, `crimson`, `luna-xp`), `font` (`system`, `palatino`, `georgia`, `humanist-sans`, `mono`; web-safe stacks only, no font loading), `density` (`comfortable` or `compact`), `accent` (`teal`, `blue`, `violet`, `amber`, `green`, `rose`, `slate`), and `tabs` (at most 4, each a plain-text `title` of at most 40 characters and 1 to 6 `widgets`). Unknown keys are rejected at every level.
- **Reading.** `GET /api/forks/:repo/ui` returns `{repo, commit, path, present, valid, preferences}` from `main`. An invalid file is reported with `errors` and the defaults are served; the gate keeps invalid files off `main`.
- **Applying.** `app.js` sets `data-look`, `data-font`, `data-density`, and `data-accent` on the root element through `js/ui-prefs.js`, which keeps only allowlisted values. `styles.css` maps each value to its stack, sizes, and a light and a dark accent shade. Mode colors (clinical, research, administrative) never change.
- **Looks.** A look is a whole set of colors, weights, and shapes, defined only in `styles.css`, with a light and a dark set of values. `crimson` is bold red and white institutional colors: a deep red rail and header band, white panels, charcoal text, red primary buttons and links, and heavier headings. A request for the St. Jude look maps to it; it uses no logo, name, or trademark. `luna-xp` is a Windows XP style from about 2001: Tahoma or Verdana at a slightly smaller size, blue title bars on panel heads, a blue rail, bevelled grey buttons with a green primary, a sky blue to green page background, and square inputs. No images or fonts are loaded. `standard` (or no look) is the stock look. The look rules come before the font, density, and accent rules, so an explicit `font`, `density`, or `accent` wins over the look's own (with `luna-xp` and an accent, the primary button uses the accent instead of green). Light or dark stays the local **Theme** toggle (`data-theme`), separate from the look. A look changes the shared colors (page, panels, text, lines, rail, accent, links) and the type size, and answer cards pick those up like every other part of the page. It never changes the mode colors, what an answer card contains, or how a card is built.
- **Tabs and charts.** Extra tabs appear under **Your tabs** in the rail and open `#tab?i=<n>` (`js/views/tab.js`). Widgets are computed by the platform over the session's own fork (`GET /api/me/charts`, `platform/src/ui/charts.ts`): answers by intent over time, confidence distribution, override rate, sources cited by kind, the build-time intent timeline, and gate results history. `js/charts.js` draws them as inline SVG with `s()` (the SVG twin of `h()` in `js/dom.js`), with no libraries and no `innerHTML`.
- **What counts as one answer.** The charts count one answer per user question. When the user overrides a mode or attests, the UI asks again with `reaskOf` set to the answer it re-asks; the platform records the question's first `answer_id` as `reask_of` on the new ledger record, and the charts fold every record that shares it into one question. That question is charted under the intent and confidence of its first answer, and its sources are the union of all its answers. The override rate is overridden questions divided by questions: a question is overridden when its first answer carries an override (set by `POST /api/override`, or an explicit mode chosen on a fresh ask). The `override` field on a re-ask record only repeats the mode that was asked for, so it is not counted, and an attestation re-ask is never an override. A re-ask whose first answer has aged out of the 500 record window still counts as one question, but not as overridden.
- **Accessibility.** Every chart has a heading, a text summary as its caption, an SVG title, a legend when it has more than one series, a native tooltip per mark, and a "Show data as a table" view. Colors come from CSS variables, so charts follow the light and dark themes. The mode colors are the established identity colors of the UI and are close for some color vision deficiencies, so charts never rely on color alone: legends, captions, and tables carry the same information.
- **After a change merges.** When a customization that writes `ui/preferences.json` merges, **Customize** reloads the fork's preferences and shows what changed, with an **Open** button for each new tab. While the change is in yellow the line says "Merged to main, live in yellow"; once the soak passes it says "Applied". If the soak fails, the line says the change was rolled back (or that the soak failed) and the buttons go away. If the change added a tab and you are still on **Customize** when the run merges, the app opens the new tab.
- **Mock mode** serves `GET /api/forks/:repo/ui` and `GET /api/me/charts` from the in-browser data and routes and simulates requests with `js/ui-recipe.js`, a copy of the platform's recipe matching and UI mapping. Tests check that every rule is the same and that both route, map, and merge requests the same way, so the same request works with `?mock=1`. A request that maps to nothing fails with a "Not mapped" message, changes nothing, and lists requests that do work.


## Yellow to green health

Every change that lands on a fork's `main` is live in yellow until the end-to-end suite passes three times in a row (`docs/GATE_AND_AGENTS.md`, "Yellow to green"). `js/health.js` renders it with `h()` only.

- **Top bar.** The fork pill starts with a health badge: **Green**, **Yellow: soak pass 2 of 3**, or **Rolled back**. While the fork is yellow, `app.js` polls `GET /api/forks/:repo/health` every 3 seconds, so the badge follows the soak to green or a rollback. Clicking it opens **My fork**.
- **My fork.** The **Health: yellow to green** panel shows the badge, a three-segment soak progress bar, the yellow, green, or revert commit, the last green commit, the browser checks, the scenario list of the latest pass grouped by tier (stock, basic platform, your own), the failing step of a failed scenario (path, op, expected, actual), and the health history.
- **Customize.** After the gate merges, the **Yellow phase** panel follows the yellow run until it is green, rolled back, or cancelled; the page keeps polling until then. End-to-end scenario suggestions (`tests/user/e2e.json`) list their steps and can be accepted or rejected.
- **Fleet.** The grid and the counts show **Yellow (soaking)** and **Rolled back** over idle statuses (`displayStatus`, mirrored from `platform/src/yellow/state.ts`); yellow squares blink while they soak. Rolled back forks appear under **Needs attention**, and the fork detail shows the health badge.
- **Colors.** `--yellow` and `--rolled` (with light and dark shades) are new tokens. The badge carries its state as text, so color is never the only signal; animation stops under `prefers-reduced-motion`.
- **Mock mode** simulates the soak: a mock customization lands, goes yellow, passes three soak passes with the browser checks once, and turns green; a mock release shows auto-upgraded forks as yellow squares that turn green a few seconds later.
