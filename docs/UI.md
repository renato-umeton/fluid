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

- **Schema.** `platform/src/ui/preferences.ts` validates the file: `font` (`system`, `palatino`, `georgia`, `humanist-sans`, `mono`; web-safe stacks only, no font loading), `density` (`comfortable` or `compact`), `accent` (`teal`, `blue`, `violet`, `amber`, `green`, `rose`, `slate`), and `tabs` (at most 4, each a plain-text `title` of at most 40 characters and 1 to 6 `widgets`). Unknown keys are rejected at every level.
- **Reading.** `GET /api/forks/:repo/ui` returns `{repo, commit, path, present, valid, preferences}` from `main`. An invalid file is reported with `errors` and the defaults are served; the gate keeps invalid files off `main`.
- **Applying.** `app.js` sets `data-font`, `data-density`, and `data-accent` on the root element through `js/ui-prefs.js`, which keeps only allowlisted values. `styles.css` maps each value to its stack, sizes, and a light and a dark accent shade. Mode colors (clinical, research, administrative) never change.
- **Tabs and charts.** Extra tabs appear under **Your tabs** in the rail and open `#tab?i=<n>` (`js/views/tab.js`). Widgets are computed by the platform over the session's own fork (`GET /api/me/charts`, `platform/src/ui/charts.ts`): answers by intent over time, confidence distribution, override rate, sources cited by kind, the build-time intent timeline, and gate results history. `js/charts.js` draws them as inline SVG with `s()` (the SVG twin of `h()` in `js/dom.js`), with no libraries and no `innerHTML`.
- **Accessibility.** Every chart has a heading, a text summary as its caption, an SVG title, a legend when it has more than one series, a native tooltip per mark, and a "Show data as a table" view. Colors come from CSS variables, so charts follow the light and dark themes. The mode colors are the established identity colors of the UI and are close for some color vision deficiencies, so charts never rely on color alone: legends, captions, and tables carry the same information.
- **Mock mode** serves `GET /api/forks/:repo/ui` and `GET /api/me/charts` from the in-browser data and simulates the UI recipe, so the same request works with `?mock=1`.


## Yellow to green health

Every change that lands on a fork's `main` is live in yellow until the end-to-end suite passes three times in a row (`docs/GATE_AND_AGENTS.md`, "Yellow to green"). `js/health.js` renders it with `h()` only.

- **Top bar.** The fork pill starts with a health badge: **Green**, **Yellow: soak pass 2 of 3**, or **Rolled back**. While the fork is yellow, `app.js` polls `GET /api/forks/:repo/health` every 3 seconds, so the badge follows the soak to green or a rollback. Clicking it opens **My fork**.
- **My fork.** The **Health: yellow to green** panel shows the badge, a three-segment soak progress bar, the yellow, green, or revert commit, the last green commit, the browser checks, the scenario list of the latest pass grouped by tier (stock, basic platform, your own), the failing step of a failed scenario (path, op, expected, actual), and the health history.
- **Customize.** After the gate merges, the **Yellow phase** panel follows the yellow run until it is green, rolled back, or cancelled; the page keeps polling until then. End-to-end scenario suggestions (`tests/user/e2e.json`) list their steps and can be accepted or rejected.
- **Fleet.** The grid and the counts show **Yellow (soaking)** and **Rolled back** over idle statuses (`displayStatus`, mirrored from `platform/src/yellow/state.ts`); yellow squares blink while they soak. Rolled back forks appear under **Needs attention**, and the fork detail shows the health badge.
- **Colors.** `--yellow` and `--rolled` (with light and dark shades) are new tokens. The badge carries its state as text, so color is never the only signal; animation stops under `prefers-reduced-motion`.
- **Mock mode** simulates the soak: a mock customization lands, goes yellow, passes three soak passes with the browser checks once, and turns green; a mock release shows auto-upgraded forks as yellow squares that turn green a few seconds later.
