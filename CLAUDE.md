# Orbot V2.0 — Claude Instructions

## Design

Before writing or editing any UI (HTML, CSS, Tailwind classes, JS-rendered markup), read `Other/DESIGN.md` first. For visual polish, also consult `design-refs/` — it holds distilled design-system specs (Linear, Vercel, Raycast, Resend, Supabase, Warp, Cursor) and reference screenshots; see `design-refs/README.md` for how to use them. It defines the color tokens, typography rules, component patterns, and do's/don'ts for Orbot's dark sci-fi aesthetic. Key rules:

- IBM Plex Mono for all data values (SKUs, IDs, timestamps, file names, weights)
- Outfit for headings and button labels
- Green (`#3ecf8e`) is the only primary action color — one per section max
- All cards use the flat `panel` pattern (`card` background + `line` border) — no glassmorphism, no shadows/blur on inline cards; blur is reserved for floating elements (dock, dropdowns) only
- Product type colors: DS = steel-blue `#7ea6e8`, WM = peach `#ffaa6b`, FWM = orange `#ff8c00`

## Frontend

- `app.js` is the entire frontend (~8200 lines). Bump `?v=X.X.X` in `index.html` after every `app.js` change (always read the current value from `index.html` — never trust a version number written elsewhere).
- `index.css` holds all custom CSS. Draft 4 component classes are `d4-` prefixed (appended sections at the bottom of the file); legacy classes above them are being retired as renderers migrate.
- Tailwind CDN is still loaded: modal internals, the platform-listings cards, and the job-table renderers in `app.js` still emit utility classes. Do NOT remove the CDN until those are migrated to `d4-` classes. New markup should use `d4-` classes, not Tailwind utilities.
- Two legacy `!important` input/select overrides (one in `index.html`'s inline `<style>`, one in `index.css`) skip any element whose class contains `d4-` — give styled form controls a `d4-` class or they'll be clobbered.
- Vercel serves static files — no server-side rendering, no env vars at runtime. Supabase credentials come from localStorage (`orbot_supabase_url`, `orbot_supabase_key`). Deploy with `vercel --prod` (GitHub is not connected to Vercel).

## Backend

- `main.py` is the entire backend (~3200 lines), FastAPI on Railway.
- Railway auto-deploys on push to `main`.
- Do not use `maybeSingle()` from supabase-py — use `.limit(1).execute()` and index `r.data[0]`.
- When fetching from Railway in JS, use `response.text()` then `JSON.parse()` — never call `.json()` directly, as Railway returns HTML on 5xx errors.

## Commits

Push `main.py` changes and frontend changes in separate commits so it's clear what triggered a Railway redeploy vs a Vercel deploy.
