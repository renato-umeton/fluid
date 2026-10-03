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
