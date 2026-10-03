Fluid UI (static, no build step)

index.html, styles.css, app.js and js/ are served as static assets by the platform Worker.

The platform build copies stock/dist/app.js to public/vendor/stock-app.js (gitignored).
Mock mode (?mock=1, or automatic when GET /api/personas fails) uses that file to answer
questions with the real stock engine, and falls back to canned cards when it is absent.

Local preview: cd stock && npm run build && cp dist/app.js ../platform/public/vendor/stock-app.js,
then serve this folder and open /?mock=1.
