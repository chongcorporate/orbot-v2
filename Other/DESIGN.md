---
version: 2.0
name: Orbot-Design-System
description: "A dark sci-fi command-deck aesthetic for Orbot V2.0 — flat deep-space surfaces, green as the primary action signal, cyan for telemetry/data, warm peach for WM products, and orange for FWM. IBM Plex Mono carries all data values; Outfit drives headings and labels. The system feels like mission-control software: every number is monospace, every state change glows."

colors:
  primary: "#3ecf8e"
  primary-dim: "rgba(62, 207, 142, 0.12)"
  primary-glow: "rgba(62, 207, 142, 0.35)"
  secondary: "#ffaa6b"
  secondary-glow: "rgba(255, 170, 107, 0.25)"
  tertiary: "#ff8c00"
  tertiary-glow: "rgba(255, 140, 0, 0.25)"

  success: "#3ecf8e"
  success-glow: "rgba(62, 207, 142, 0.25)"
  warning: "#fbbf24"
  warning-glow: "rgba(251, 191, 36, 0.25)"
  error: "#ff6666"
  error-glow: "rgba(255, 102, 102, 0.25)"

  cyan: "#38bdf8"
  cyan-glow: "rgba(56, 189, 248, 0.25)"

  canvas: "#0c0f14"
  card: "#12161d"
  card-2: "#171c25"
  inset: "#0a0d11"
  line: "#1f2530"
  line-2: "#2b3342"

  text-primary: "#edf0f4"
  text-secondary: "#b6bec9"
  text-muted: "#7d8794"
  text-faint: "#525c69"
  text-on-primary: "#04120b"

typography:
  font-title: "Outfit, Inter, sans-serif"
  font-body: "Inter, sans-serif"
  font-mono: "IBM Plex Mono, monospace"

  heading:
    fontFamily: Outfit
    fontSize: 1.85rem
    fontWeight: 700
    letterSpacing: -0.5px

  section-title:
    fontFamily: Outfit
    fontSize: 1rem
    fontWeight: 700
    letterSpacing: 0.05em
    textTransform: uppercase

  label:
    fontFamily: Outfit
    fontSize: 0.9rem
    fontWeight: 600

  body:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 400

  data:
    fontFamily: IBM Plex Mono
    fontSize: 0.75rem
    fontWeight: 500

  data-lg:
    fontFamily: Outfit
    fontSize: 2.25rem
    fontWeight: 700
    lineHeight: 1

  caption:
    fontFamily: IBM Plex Mono
    fontSize: 0.65rem
    fontWeight: 500
    letterSpacing: 0.05em
    textTransform: uppercase

rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  pill: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px

components:
  panel:
    background: "{colors.card}"
    border: "1px solid {colors.line}"
    borderRadius: "{rounded.lg}"

  panel-hover:
    borderColor: "{colors.line-2}"

  floating-panel:
    background: "rgba(10, 13, 17, 0.85)"
    border: "1px solid {colors.line-2}"
    borderRadius: "{rounded.xl}"
    backdropFilter: blur(18px)
    boxShadow: "0 12px 40px rgba(0,0,0,0.5)"

  btn-primary:
    background: "{colors.primary}"
    color: "{colors.text-on-primary}"
    fontFamily: Outfit
    fontWeight: 700
    fontSize: 0.875rem
    borderRadius: "{rounded.pill}"
    padding: "8px 16px"
    border: none

  btn-ghost:
    background: "{colors.card}"
    color: "{colors.text-secondary}"
    border: "1px solid {colors.line}"
    borderRadius: "{rounded.md}"
    padding: "6px 12px"
    hover-background: "{colors.card-2}"

  btn-danger:
    background: "rgba(255,102,102,0.1)"
    color: "{colors.error}"
    border: "1px solid rgba(255,102,102,0.3)"
    borderRadius: "{rounded.md}"
    hover-background: "rgba(255,102,102,0.2)"

  status-dot:
    size: 8px
    borderRadius: "{rounded.pill}"
    active: "{colors.success} + glow {colors.success-glow}"
    warning: "{colors.warning} + glow {colors.warning-glow}"
    error: "{colors.error} + glow {colors.error-glow}"
    pulse-animation: "1.8s infinite"

  stat-card:
    extends: panel
    padding: "{spacing.lg}"
    label: "{typography.label} {colors.text-secondary}"
    value: "{typography.data-lg} solid"
    active-accent: "3px left border in {colors.primary}"

  table-row:
    background: transparent
    hover-background: "{colors.card-2}"
    border-bottom: "1px solid {colors.line}"
    font: "{typography.data}"

  badge-primary:
    background: "{colors.primary-dim}"
    border: "1px solid {colors.primary-glow}"
    color: "{colors.primary}"
    borderRadius: "{rounded.sm}"
    padding: "2px 8px"
    font: "{typography.caption}"

  badge-cyan:
    background: "rgba(56,189,248,0.1)"
    border: "1px solid rgba(56,189,248,0.3)"
    color: "{colors.cyan}"
    borderRadius: "{rounded.sm}"
    padding: "2px 8px"
    font: "{typography.caption}"

  badge-warning:
    background: "rgba(251,191,36,0.1)"
    border: "1px solid rgba(251,191,36,0.3)"
    color: "{colors.warning}"
    borderRadius: "{rounded.sm}"
    padding: "2px 8px"
    font: "{typography.caption}"

  badge-error:
    background: "rgba(255,102,102,0.1)"
    border: "1px solid rgba(255,102,102,0.3)"
    color: "{colors.error}"
    borderRadius: "{rounded.sm}"
    padding: "2px 8px"
    font: "{typography.caption}"

  toast:
    position: fixed bottom-right
    borderRadius: "{rounded.lg}"
    padding: "{spacing.sm} {spacing.md}"
    font: "{typography.data}"
    success: "border-left 3px {colors.success}, bg rgba(62,207,142,0.1)"
    error: "border-left 3px {colors.error}, bg rgba(255,102,102,0.1)"
    warning: "border-left 3px {colors.warning}, bg rgba(251,191,36,0.1)"

  nav-item:
    default: "color {colors.text-muted}, bg transparent, icon + label"
    active: "color {colors.text-on-primary}, bg {colors.primary}, font-weight 600, glow {colors.primary-glow}"
    hover: "color {colors.text-secondary}, bg {colors.card-2}"
    borderRadius: "{rounded.md}"
    padding: "7px 15px"

  input:
    background: "{colors.inset}"
    border: "1px solid {colors.line}"
    borderRadius: "{rounded.md}"
    color: "{colors.text-primary}"
    font: "{typography.data}"
    padding: "8px 12px"
    focus-border: "{colors.line-2}"

  modal:
    overlay: "rgba(0,0,0,0.7)"
    panel: "{panel} max-w-md"
    title: "{typography.section-title}"
    actions: "right-aligned, btn-danger + btn-ghost"

  gantt-block-active:
    background: "{colors.primary-dim}"
    border: "1px solid {colors.primary}"
    color: "{colors.primary}"
    animation: "pulse 2.5s infinite"

  gantt-block-ds:
    background: "rgba(126,166,232,0.15)"
    border: "1px solid #7ea6e8"
    color: "#7ea6e8"

  gantt-block-wm:
    background: "rgba(255,170,107,0.15)"
    border: "1px solid {colors.secondary}"
    color: "{colors.secondary}"

  gantt-block-fwm:
    background: "rgba(255,140,0,0.15)"
    border: "1px solid {colors.tertiary}"
    color: "{colors.tertiary}"

  gantt-block-other:
    background: "rgba(144,144,144,0.15)"
    border: "1px solid #909090"
    color: "#909090"
---

## Overview

Orbot V2.0 is a private operations dashboard — not a marketing site, not a consumer product. Its visual register is **command-deck / mission-control**: a flat, near-black canvas (`{colors.canvas}`), glowing status indicators, monospace data readouts, and slim-bordered flat panels that read like a HUD floating over darkness.

The system has one primary action color (green `{colors.primary}`) and three supporting semantic colors for product types: cyan for data/telemetry, warm peach (`{colors.secondary}`) for Wall Mounts, orange (`{colors.tertiary}`) for Floating Wall Mounts. Everything else is grayscale hierarchy.

**Key rule**: if it's a number, a SKU, an ID, a timestamp, or a file name — it's `{typography.data}` (IBM Plex Mono). If it's a heading or a button label — it's Outfit. Body copy is Inter.

## Colors

### Primary Hierarchy

- **Green** (`{colors.primary}`, `#3ecf8e`): The only true action color. Used for primary buttons, active nav items, active Gantt blocks, "active" stat card accents, and `focus` ring on inputs. Also used as the brand glow on the logo mark and hover states. Pair with `{colors.text-on-primary}` (`#04120b`) for text on green backgrounds.
- **Cyan** (`{colors.cyan}`, `#38bdf8`): Telemetry, live data, SimplyPrint sync actions, MINI printer badges. Use at 10-15% opacity for backgrounds, full opacity for text/borders.
- **Peach** (`{colors.secondary}`, `#ffaa6b`): Wall Mount product category. Gantt WM blocks, WM badges.
- **Orange** (`{colors.tertiary}`, `#ff8c00`): Floating Wall Mount product category. Gantt FWM blocks, FWM badges.
- **Steel-blue** (`#7ea6e8`): Display Stand product category. Gantt DS blocks, DS badges.

### Semantic

- **Success** (`{colors.success}`, `#3ecf8e`): Healthy agents, completed prints, order status "shipped". Same value as primary — success states over this canvas double as the brand accent.
- **Warning** (`{colors.warning}`, `#fbbf24`): Degraded states, orders on hold, queue warnings.
- **Error** (`{colors.error}`, `#ff6666`): Failures, cancellations, system errors. Never use for decorative accents.

### Surface

- **Canvas** (`{colors.canvas}`, `#0c0f14`): The page background. Flat — no gradient, no radial glow behind content.
- **Card** (`{colors.card}`, `#12161d`) / **Card-2** (`{colors.card-2}`, `#171c25`): Default flat surface for every card, section, table, and sidebar. `card-2` is one step lighter, used for hover states and nested surfaces (e.g. a card inside a card).
- **Inset** (`{colors.inset}`, `#0a0d11`): Recessed surfaces — input fields, wells, code blocks.
- **Border**: `{colors.line}` (`#1f2530`) for default 1px borders, `{colors.line-2}` (`#2b3342`) for hover/emphasis borders. This is the primary depth cue — panels are flat, borders (not shadows or blur) separate surfaces.
- **Floating elements only**: the bottom action dock and dropdown menus use `{floating-panel}` — `rgba(10,13,17,0.85)` with `backdrop-filter: blur(18px)`. This is the one place blur is used; it signals "floats above the page," not "this is a card."

### Text

- **Primary** (`{colors.text-primary}`, `#edf0f4`): All headings, stat values, important labels.
- **Secondary** (`{colors.text-secondary}`, `#b6bec9`): Body copy, table cell text, nav item hover.
- **Muted** (`{colors.text-muted}`, `#7d8794`): Nav item default, secondary metadata.
- **Faint** (`{colors.text-faint}`, `#525c69`): Placeholder text, disabled states, decorative sub-labels (e.g. the mono tagline under the logo).

## Typography

### Font Roles

| Font | Role | Never Use For |
|---|---|---|
| **Outfit** | Headings, nav labels, button text, stat values | Data readouts, IDs, file names |
| **Inter** | Body copy, descriptions, modal text | Data values, any monospace context |
| **IBM Plex Mono** | SKUs, IDs, timestamps, file names, Gantt labels, table data cells, code snippets, captions | Headings, body paragraphs |

### Scale

| Token | Size | Weight | Use |
|---|---|---|---|
| `heading` | 1.85rem | 700 | Brand wordmark "Orbot" |
| `section-title` | 1rem | 700 | Section headers (uppercase, tracked) e.g. "ACTIVE 3D PRINTERS" |
| `label` | 0.9rem | 600 | Stat card labels, filter labels |
| `body` | 0.875rem | 400 | Descriptions, paragraph copy |
| `data-lg` | 2.25rem | 700 | Large numeric stats (order counts, queue depth) |
| `data` | 0.75rem | 500 | Mono data — table cells, file names, order IDs |
| `caption` | 0.65rem | 500 | Mono uppercase — small badges, Gantt time labels, secondary IDs |

### Principles

- **Never mix fonts within a single line.** A table row is all mono. A button label is all Outfit. Do not put an ID inside an Outfit sentence — wrap it in a mono `<span>`.
- **Green text signals interactive / active state.** If text is green, clicking or focusing it does something.
- **Weight carries status, not size.** A `font-weight: 700` row in a table is more prominent than a 0.9rem one — use weight before reaching for color.

## Layout

### Header + Main

- Fixed top header: logo/wordmark on the left, centered pill-style tab navigation, shop-scope switcher and system status on the right.
- Main content area: fluid, max-width container centered, padded, scrolls independently.
- No sidebar — navigation lives in the header as a centered nav pill group.

### Spacing

Base unit is **8px**. All padding/margin values are multiples of 4px.

| Token | Value | Common Use |
|---|---|---|
| `xxs` | 4px | Icon-to-label gap, tight badge padding |
| `xs` | 8px | Button vertical padding, row padding |
| `sm` | 12px | Input padding, card inner gap |
| `md` | 16px | Card padding side, section gap |
| `lg` | 24px | Card padding, stat card interior |
| `xl` | 32px | Between major sections |
| `xxl` | 48px | Page-level vertical rhythm |

### Grid

- Stat cards: `grid-cols-5` on desktop, collapse to 2 on tablet.
- Quick Operations: `grid-cols-3` or `grid-cols-5` depending on section.
- Table: always full-width, never truncated with horizontal scroll — truncate cell text with `text-ellipsis` instead.

## Panel System

Every card and section uses the same flat panel pattern — borders provide depth, not shadows or blur:

```
background: #12161d
border: 1px solid #1f2530
border-radius: 12px
```

On hover, the border shifts lighter:
```
border-color: #2b3342
```

**Do not add box shadows or blur inside a panel.** Border color is the elevation device. Reserve `backdrop-filter: blur()` for floating elements only (the bottom dock, dropdown menus) — never on an inline card.

## Components

### Buttons

**Primary** — green fill, dark text. One per section maximum.
```
bg: #3ecf8e | text: #04120b | font: Outfit 700 0.875rem | radius: pill | padding: 8px 16px
```

**Ghost** — barely-there. Used for secondary actions, filter toggles, toolbar buttons.
```
bg: #12161d | border: #1f2530 | text: text-secondary | hover-bg: #171c25
```

**Danger** — red tint. Confirmation-only — always behind a modal.
```
bg: rgba(255,102,102,0.1) | border: rgba(255,102,102,0.3) | text: #ff6666 | hover-bg: rgba(255,102,102,0.2)
```

**Icon button** — square or rounded, no label. Must have a `title` tooltip.
```
p-1.5 | hover: bg card-2 | active icon color: primary or cyan
```

### Status Dots

8px circle with matching glow. Always paired with a text label — never used as the sole status signal.
- `success` (#3ecf8e + green glow) — online, printing, shipped
- `warning` (#fbbf24 + amber glow) — on hold, degraded
- `error` (#ff6666 + red glow) — failed, cancelled
- Pulse animation (1.8s) for actively changing states.

### Badges

All badges use the same pattern: 10% opacity background, matching border at 30% opacity, full-opacity text, `{rounded.sm}`, `{typography.caption}` (mono uppercase).

| Variant | Color | Use |
|---|---|---|
| Primary (green) | `{colors.primary}` | Active, success, primary SKU type |
| Cyan | `{colors.cyan}` | Telemetry, MINI printer type, live data |
| Warning | `{colors.warning}` | Held, pending review |
| Error | `{colors.error}` | Failed, cancelled |
| DS (steel-blue) | `#7ea6e8` | Display Stand product type |
| WM (peach) | `{colors.secondary}` | Wall Mount product type |
| FWM (orange) | `{colors.tertiary}` | Floating Wall Mount product type |

### Tables

- `bg: transparent` rows — no card background inside a table.
- `hover: card-2` — subtle solid-color tint on hover (not a green tint).
- `border-bottom: 1px solid {colors.line}` between rows.
- All cell text in `{typography.data}` (mono). Column headers in `{typography.caption}` (mono uppercase, text-muted).
- Sticky header when table scrolls.
- Truncate long strings with `truncate` — never wrap or scroll horizontally.

### Inputs & Search

```
bg: #0a0d11 | border: 1px solid #1f2530 | radius: 8px
color: text-primary | font: IBM Plex Mono 0.75rem | padding: 8px 12px
focus: border-color #2b3342, outline none
```

### Modals

- Overlay: `rgba(0,0,0,0.7)` full-screen backdrop.
- Panel: flat panel, `max-w-md`, centered.
- Title: `{typography.section-title}` in text-primary.
- Body: Inter, text-secondary.
- Actions: right-aligned. Destructive action is `btn-danger`, dismiss is `btn-ghost`.
- Always require explicit confirmation for destructive actions (delete, cancel order, E-stop).

### Toasts

Fixed bottom-right, stacked. Auto-dismiss:
- Info: 3 seconds
- Error: 5 seconds (stays until read)

Left border 3px in semantic color, matching 10% opacity background, mono text.

### Gantt Chart

Blocks are color-coded by product type. All text in `{typography.caption}` (mono). Tooltip appears on hover — edge-clamped so it never clips off-screen.

| Block type | Color | Product |
|---|---|---|
| Active (printing) | Green pulsing | Currently on printer |
| DS | Steel-blue `#7ea6e8` | Display Stand |
| WM | Peach `{colors.secondary}` | Wall Mount |
| FWM | Orange `{colors.tertiary}` | Floating Wall Mount |
| Other | Grey `#909090` | Everything else |

Printer rows: MINI badge (cyan tint) for A1 Mini group, A1 badge (green tint) for regular group. IDLE label in `{colors.card-2}` when no blocks scheduled. Offline printers at 45% opacity.

## Do's and Don'ts

### Do

- Use `{colors.primary}` green for exactly one primary CTA per section. If two green buttons are visible simultaneously, one should be ghost.
- Use IBM Plex Mono for every data value — SKU, order ID, file name, weight, time. No exceptions.
- Use the flat panel pattern for every card surface — `card` background + `line` border, no blur, no shadow.
- Show a status dot AND a text label together — never just the dot.
- Use the semantic color system for product types consistently: DS = steel-blue, WM = peach, FWM = orange, active = green.
- Always show a confirmation modal before destructive or irreversible actions.
- Keep glow effects subtle — they accent, they don't dominate.
- Truncate long text with ellipsis. This is a dense data dashboard — content must fit its container.
- Reserve `backdrop-filter: blur()` for floating/overlaid elements (bottom dock, dropdown menus) — it signals "floating above the page."

### Don't

- Don't use green as a decorative color. It means "primary action" or "active state". Green text = clickable or active.
- Don't introduce new accent colors outside the documented palette. Adding a purple or teal for a new state breaks the system.
- Don't use Inter or Outfit for order IDs, SKUs, file names, timestamps, or any numeric data. Always mono.
- Don't add hard white (`#ffffff`) backgrounds inside panels — use `card`/`card-2` or transparent.
- Don't add box-shadow or backdrop-blur to an inline card — border color is the only elevation device for in-page panels.
- Don't add borders to table rows on hover — use a solid background tint (`card-2`) only.
- Don't skip the confirmation modal for delete/cancel operations because "it's obvious" — always confirm.
- Don't use `font-weight: 400` Outfit for button labels — always 600 or 700.
- Don't render a gradient or radial-glow page background — the canvas is flat.

## Interaction Patterns

- **Loading state**: `animate-spin` icon + "Loading [thing]..." in text-muted mono. Never a blank space.
- **Empty state**: Centered, text-muted, descriptive — "No orders found" or similar. Never a broken layout.
- **Transitions**: `transition-all duration-300` is the standard. `cubic-bezier(0.4, 0, 0.2, 1)` for anything that moves position.
- **Hover lift**: `translateY(-1px)` for nav items and interactive cards. `scaleY(1.08)` for Gantt blocks.
- **Active press**: `scale(0.97)` or `brightness(0.9)` — subtle, not bouncy.
- **Icon + label**: always. Icons are decorative — always accompany with a visible label or `title` tooltip.

## Agent / System Color Identity

Each background agent has an implied color identity used for accent borders and dot colors:
- **Scout** (Gmail poller): cyan — it's watching external systems
- **Foreman** (print dispatch): green — it's the action taker
- **Waybill Agent**: peach — it handles physical logistics
- **SimplyPrint Sync**: steel-blue — it's telemetry
- **Product Manager**: muted grey — background catalog work
