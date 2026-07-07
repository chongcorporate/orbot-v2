# tw-compat.css build recipe

`/tw-compat.css` is a **statically compiled** replacement for the Tailwind Play CDN
that was removed from index.html in v1.20.0. It contains exactly the utility
classes that appear as literals in `index.html` + `app.js` at build time, compiled
with the same config (and forms plugin) the CDN used, so it renders pixel-identically.

## Consequences

- **New Tailwind utility combos will silently not work** — they aren't in the
  compiled file and nothing generates them at runtime anymore. This is intentional:
  new markup must use `d4-` classes (see CLAUDE.md / Other/DESIGN.md).
- As renderers migrate to `d4-` classes, regenerate to shrink the file. When the
  last utility markup is gone, delete `tw-compat.css`, its `<link>` in index.html,
  and this directory.

## Regenerate

From the **repo root** (content paths are cwd-relative):

```sh
npx -y -p tailwindcss@3.4.17 -p @tailwindcss/forms@0.5.9 tailwindcss \
  -c Other/tw-compat/tailwind.config.cjs \
  -i Other/tw-compat/in.css \
  -o tw-compat.css
```

Then bump the `tw-compat.css?v=` query in index.html.

Notes:
- The `container-queries` plugin the CDN loaded is dropped — zero usage in the codebase.
- The `<link>` sits at the **end of `<head>`** on purpose: the Play CDN injected its
  generated `<style>` after index.css, so the compiled file must too, or
  same-specificity cascade ties flip.
