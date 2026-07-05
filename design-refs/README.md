# Design References

Award-caliber dark-UI references for Orbot. When building or restyling UI, read the
relevant spec in `specs/` and look at the screenshots before writing code.

## Specs (`specs/`)

Distilled design systems (colors, typography scales, spacing, component patterns) from
[voltagent/awesome-design-md](https://github.com/voltagent/awesome-design-md):

| File | Why it matters for Orbot |
|---|---|
| `linear.app-DESIGN.md` | The gold standard for dense dark product UI. Steal: near-black canvas (#010102), charcoal surface ladder, hairline borders, one accent color, tight negative letter-spacing on headings. |
| `vercel-DESIGN.md` | Dashboard restraint — monochrome-first, geometric type, minimal chrome. |
| `raycast-DESIGN.md` | Glassy dark panels + glow accents; closest to Orbot's sci-fi glassmorphism. |
| `resend-DESIGN.md` | Quiet luxury dark theme; excellent typography contrast (serif display vs mono data). |
| `supabase-DESIGN.md` | Dark dashboard with a single green accent — direct analogue to Orbot's lime. |
| `warp-DESIGN.md` | Terminal aesthetic done tastefully; mono type in anger. |
| `cursor-DESIGN.md` | Modern dev-tool dark marketing style. |

## Screenshots

- `raycast-og.png` — dark launcher UI: list rows, selection highlight, metadata panel, red glow accents.
- `resend-og.png` — dark code panel with tab pills; serif display over mono body.
- `railway-og.png` — dark deploy cards with status chips and connector lines (very close to Orbot's printer/job cards).

Add your own: screenshot any UI you want to emulate into this folder with a descriptive
name (`linear-issue-list-dark.png`), then reference it by filename in prompts.

## How to use in prompts

- "Restyle the orders table. Match the density and hairline borders described in
  `design-refs/specs/linear.app-DESIGN.md`."
- "Make the printer cards feel like `design-refs/railway-og.png` — status chip top-right,
  muted metadata line, 1px border."
