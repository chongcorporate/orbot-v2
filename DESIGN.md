---
version: 1.0
name: Orbot-Design-System
description: "A dark sci-fi command-deck aesthetic for Orbot V2.0 — deep space backgrounds, glassmorphism panels, lime green as the primary action signal, cyan for telemetry/data, warm peach for WM products, and orange for FWM. JetBrains Mono carries all data values; Outfit drives headings and labels. The system feels like mission-control software: every number is monospace, every state change glows."

colors:
  primary: "#a4e844"
  primary-glow: "rgba(164, 232, 68, 0.25)"
  secondary: "#ffaa6b"
  secondary-glow: "rgba(255, 170, 107, 0.25)"
  tertiary: "#ff8c00"
  tertiary-glow: "rgba(255, 140, 0, 0.25)"

  success: "#10b981"
  success-glow: "rgba(16, 185, 129, 0.25)"
  warning: "#eab308"
  warning-glow: "rgba(234, 179, 8, 0.25)"
  error: "#ef4444"
  error-glow: "rgba(239, 68, 68, 0.25)"

  cyan: "#22d3ee"
  cyan-glow: "rgba(34, 211, 238, 0.25)"

  bg: "radial-gradient(circle at 50% 50%, #0d1527 0%, #030712 100%)"
  glass-bg: "rgba(15, 23, 42, 0.65)"
  glass-border: "rgba(255, 255, 255, 0.08)"
  surface-hover: "rgba(255, 255, 255, 0.04)"

  text-primary: "#f8fafc"
  text-secondary: "#cbd5e1"
  text-muted: "#64748b"
  text-on-primary: "#020617"

typography:
  font-title: "Outfit, Inter, sans-serif"
  font-body: "Inter, sans-serif"
  font-mono: "JetBrains Mono, monospace"

  heading:
    fontFamily: Outfit
    fontSize: 1.85rem
    fontWeight: 700
    letterSpacing: -0.5px
    gradient: "linear-gradient(to right, #ffffff, #93c5fd)"

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
    fontFamily: JetBrains Mono
    fontSize: 0.75rem
    fontWeight: 500

  data-lg:
    fontFamily: Outfit
    fontSize: 2.25rem
    fontWeight: 700
    lineHeight: 1

  caption:
    fontFamily: JetBrains Mono
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
  glass-panel:
    background: "{colors.glass-bg}"
    border: "1px solid {colors.glass-border}"
    borderRadius: "{rounded.xl}"
    backdropFilter: blur(24px)
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)"

  glass-panel-hover:
    borderColor: "rgba(164, 232, 68, 0.2)"
    boxShadow: "0 12px 40px rgba(0,0,0,0.65), 0 0 25px rgba(164,232,68,0.06)"

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
    background: "rgba(255,255,255,0.04)"
    color: "{colors.text-secondary}"
    border: "1px solid {colors.glass-border}"
    borderRadius: "{rounded.md}"
    padding: "6px 12px"
    hover-background: "rgba(255,255,255,0.08)"

  btn-danger:
    background: "rgba(239,68,68,0.1)"
    color: "{colors.error}"
    border: "1px solid rgba(239,68,68,0.3)"
    borderRadius: "{rounded.md}"
    hover-background: "rgba(239,68,68,0.2)"

  status-dot:
    size: 8px
    borderRadius: "{rounded.pill}"
    active: "{colors.success} + glow {colors.success-glow}"
    warning: "{colors.warning} + glow {colors.warning-glow}"
    error: "{colors.error} + glow {colors.error-glow}"
    pulse-animation: "1.8s infinite"

  stat-card:
    extends: glass-panel
    padding: "{spacing.lg}"
    label: "{typography.label} {colors.text-secondary}"
    value: "{typography.data-lg} gradient or solid"
    active-accent: "3px left border in {colors.primary}"

  table-row:
    background: transparent
    hover-background: "rgba(164,232,68,0.04)"
    border-bottom: "1px solid rgba(255,255,255,0.05)"
    font: "{typography.data}"

  badge-primary:
    background: "rgba(164,232,68,0.1)"
    border: "1px solid rgba(164,232,68,0.3)"
    color: "{colors.primary}"
    borderRadius: "{rounded.sm}"
    padding: "2px 8px"
    font: "{typography.caption}"

  badge-cyan:
    background: "rgba(34,211,238,0.1)"
    border: "1px solid rgba(34,211,238,0.3)"
    color: "{colors.cyan}"
    borderRadius: "{rounded.sm}"
    padding: "2px 8px"
    font: "{typography.caption}"

  badge-warning:
    background: "rgba(234,179,8,0.1)"
    border: "1px solid rgba(234,179,8,0.3)"
    color: "{colors.warning}"
    borderRadius: "{rounded.sm}"
    padding: "2px 8px"
    font: "{typography.caption}"

  badge-error:
    background: "rgba(239,68,68,0.1)"
    border: "1px solid rgba(239,68,68,0.3)"
    color: "{colors.error}"
    borderRadius: "{rounded.sm}"
    padding: "2px 8px"
    font: "{typography.caption}"

  toast:
    position: fixed bottom-right
    borderRadius: "{rounded.lg}"
    padding: "{spacing.sm} {spacing.md}"
    font: "{typography.data}"
    success: "border-left 3px {colors.success}, bg rgba(16,185,129,0.1)"
    error: "border-left 3px {colors.error}, bg rgba(239,68,68,0.1)"
    warning: "border-left 3px {colors.warning}, bg rgba(234,179,8,0.1)"

  nav-item:
    default: "color {colors.text-secondary}, bg transparent, icon + label"
    active: "color {colors.text-on-primary}, bg {colors.primary}, font-weight 700"
    hover: "color {colors.text-primary}, bg {colors.surface-hover}"
    borderRadius: "{rounded.xl}"
    padding: "10px 16px"

  input:
    background: "rgba(0,0,0,0.3)"
    border: "1px solid {colors.glass-border}"
    borderRadius: "{rounded.md}"
    color: "{colors.text-primary}"
    font: "{typography.data}"
    padding: "8px 12px"
    focus-border: "rgba(164,232,68,0.5)"

  modal:
    overlay: "rgba(0,0,0,0.7)"
    panel: "{glass-panel} max-w-md"
    title: "{typography.section-title}"
    actions: "right-aligned, btn-danger + btn-ghost"

  gantt-block-active:
    background: "rgba(164,232,68,0.15)"
    border: "1px solid {colors.primary}"
    color: "{colors.primary}"
    animation: "pulse 2.5s infinite"

  gantt-block-ds:
    background: "rgba(164,180,232,0.15)"
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

Orbot V2.0 is a private operations dashboard — not a marketing site, not a consumer product. Its visual register is **command-deck / mission-control**: deep space background, glowing status indicators, monospace data readouts, glassmorphism panels that look like a HUD floating over darkness.

The system has one primary action color (lime `{colors.primary}`) and three supporting semantic colors for product types: cyan for data/telemetry, warm peach (`{colors.secondary}`) for Wall Mounts, orange (`{colors.tertiary}`) for Floating Wall Mounts. Everything else is grayscale hierarchy.

**Key rule**: if it's a number, a SKU, an ID, a timestamp, or a file name — it's `{typography.data}` (JetBrains Mono). If it's a heading or a button label — it's Outfit. Body copy is Inter.

## Colors

### Primary Hierarchy

- **Lime** (`{colors.primary}`, `#a4e844`): The only true action color. Used for primary buttons, active nav items, active Gantt blocks, "active" stat card accents, and `focus` ring on inputs. Also used as the brand glow in hover states on glass panels. Pair with `{colors.text-on-primary}` (`#020617`) for text on lime backgrounds.
- **Cyan** (`{colors.cyan}`, `#22d3ee`): Telemetry, live data, SimplyPrint sync actions, MINI printer badges. Use at 10-15% opacity for backgrounds, full opacity for text/borders.
- **Peach** (`{colors.secondary}`, `#ffaa6b`): Wall Mount product category. Gantt WM blocks, WM badges.
- **Orange** (`{colors.tertiary}`, `#ff8c00`): Floating Wall Mount product category. Gantt FWM blocks, FWM badges.
- **Steel-blue** (`#7ea6e8`): Display Stand product category. Gantt DS blocks, DS badges.

### Semantic

- **Success** (`{colors.success}`, `#10b981`): Healthy agents, completed prints, order status "shipped".
- **Warning** (`{colors.warning}`, `#eab308`): Degraded states, orders on hold, queue warnings.
- **Error** (`{colors.error}`, `#ef4444`): Failures, cancellations, system errors. Never use for decorative accents.

### Surface & Glass

- **Background**: `{colors.bg}` — radial gradient from `#0d1527` (centre) to `#030712` (edge). Never use a flat black.
- **Glass panel**: `{colors.glass-bg}` with `backdropFilter: blur(24px)` and `{colors.glass-border}` at 1px. This is the default surface for every card, section, and sidebar.
- **Hover tint**: `{colors.surface-hover}` — barely-visible white at 4%. Used on table rows, ghost buttons, nav items.
- **Decorative orbs**: two blurred circles at 15% opacity (`primary` top-right, `secondary` bottom-left) give the page depth. Never add more than two.

### Text

- **Primary** (`{colors.text-primary}`, `#f8fafc`): All headings, stat values, important labels.
- **Secondary** (`{colors.text-secondary}`, `#cbd5e1`): Body copy, table cell text, nav item default.
- **Muted** (`{colors.text-muted}`, `#64748b`): Placeholder text, disabled states, timestamps in secondary position.

## Typography

### Font Roles

| Font | Role | Never Use For |
|---|---|---|
| **Outfit** | Headings, nav labels, button text, stat values | Data readouts, IDs, file names |
| **Inter** | Body copy, descriptions, modal text | Data values, any monospace context |
| **JetBrains Mono** | SKUs, IDs, timestamps, file names, Gantt labels, table data cells, code snippets, captions | Headings, body paragraphs |

### Scale

| Token | Size | Weight | Use |
|---|---|---|---|
| `heading` | 1.85rem | 700 | Brand wordmark "Orbot V2.0" |
| `section-title` | 1rem | 700 | Section headers (uppercase, tracked) e.g. "ACTIVE 3D PRINTERS" |
| `label` | 0.9rem | 600 | Stat card labels, filter labels |
| `body` | 0.875rem | 400 | Descriptions, paragraph copy |
| `data-lg` | 2.25rem | 700 | Large numeric stats (order counts, queue depth) |
| `data` | 0.75rem | 500 | Mono data — table cells, file names, order IDs |
| `caption` | 0.65rem | 500 | Mono uppercase — small badges, Gantt time labels, secondary IDs |

### Principles

- **Never mix fonts within a single line.** A table row is all mono. A button label is all Outfit. Do not put an ID inside an Outfit sentence — wrap it in a mono `<span>`.
- **Lime text signals interactive / active state.** If text is lime, clicking or focusing it does something.
- **Weight carries status, not size.** A `font-weight: 700` row in a table is more prominent than a 0.9rem one — use weight before reaching for color.

## Layout

### Sidebar + Main

- Fixed left sidebar (`w-60`, ~240px) with dark glass background, logo at top, nav items stacked vertically.
- Main content area: fluid, padded `p-6`, scrolls independently.
- No top navbar in the main content area — header lives inside the sidebar.

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

- Stat cards: `grid-cols-4` on desktop, collapse to 2 on tablet.
- Quick Operations: `grid-cols-3` or `grid-cols-5` depending on section.
- Table: always full-width, never truncated with horizontal scroll — truncate cell text with `text-ellipsis` instead.

## Glass Panel System

Every card and section uses the same glass panel pattern:

```
background: rgba(15, 23, 42, 0.65)
border: 1px solid rgba(255, 255, 255, 0.08)
border-radius: 16px
backdrop-filter: blur(24px)
box-shadow: 0 8px 32px rgba(0,0,0,0.5)
```

On hover, the border shifts toward lime:
```
border-color: rgba(164, 232, 68, 0.2)
box-shadow: 0 12px 40px rgba(0,0,0,0.65), 0 0 25px rgba(164,232,68,0.06)
```

**Do not add additional box shadows or drop shadows inside a glass panel.** The panel shadow is the elevation device.

## Components

### Buttons

**Primary** — lime fill, dark text. One per section maximum.
```
bg: #a4e844 | text: #020617 | font: Outfit 700 0.875rem | radius: pill | padding: 8px 16px
```

**Ghost** — barely-there. Used for secondary actions, filter toggles, toolbar buttons.
```
bg: rgba(255,255,255,0.04) | border: rgba(255,255,255,0.08) | text: text-secondary | hover-bg: rgba(255,255,255,0.08)
```

**Danger** — red tint. Confirmation-only — always behind a modal.
```
bg: rgba(239,68,68,0.1) | border: rgba(239,68,68,0.3) | text: #ef4444 | hover-bg: rgba(239,68,68,0.2)
```

**Icon button** — square or rounded, no label. Must have a `title` tooltip.
```
p-1.5 | hover: bg rgba(255,255,255,0.08) | active icon color: primary or cyan
```

### Status Dots

8px circle with matching glow. Always paired with a text label — never used as the sole status signal.
- `success` (#10b981 + emerald glow) — online, printing, shipped
- `warning` (#eab308 + yellow glow) — on hold, degraded
- `error` (#ef4444 + red glow) — failed, cancelled
- Pulse animation (1.8s) for actively changing states.

### Badges

All badges use the same pattern: 10% opacity background, matching border at 30% opacity, full-opacity text, `{rounded.sm}`, `{typography.caption}` (mono uppercase).

| Variant | Color | Use |
|---|---|---|
| Primary (lime) | `{colors.primary}` | Active, success, primary SKU type |
| Cyan | `{colors.cyan}` | Telemetry, MINI printer type, live data |
| Warning | `{colors.warning}` | Held, pending review |
| Error | `{colors.error}` | Failed, cancelled |
| DS (steel-blue) | `#7ea6e8` | Display Stand product type |
| WM (peach) | `{colors.secondary}` | Wall Mount product type |
| FWM (orange) | `{colors.tertiary}` | Floating Wall Mount product type |

### Tables

- `bg: transparent` rows — no card background inside a table.
- `hover: rgba(164,232,68,0.04)` — barely-visible lime tint on hover.
- `border-bottom: 1px solid rgba(255,255,255,0.05)` between rows.
- All cell text in `{typography.data}` (mono). Column headers in `{typography.caption}` (mono uppercase, text-muted).
- Sticky header when table scrolls.
- Truncate long strings with `truncate` — never wrap or scroll horizontally.

### Inputs & Search

```
bg: rgba(0,0,0,0.3) | border: 1px solid rgba(255,255,255,0.08) | radius: 8px
color: text-primary | font: JetBrains Mono 0.75rem | padding: 8px 12px
focus: border-color rgba(164,232,68,0.5), outline none
```

### Modals

- Overlay: `rgba(0,0,0,0.7)` full-screen backdrop.
- Panel: glass panel, `max-w-md`, centered.
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
| Active (printing) | Lime pulsing | Currently on printer |
| DS | Steel-blue `#7ea6e8` | Display Stand |
| WM | Peach `{colors.secondary}` | Wall Mount |
| FWM | Orange `{colors.tertiary}` | Floating Wall Mount |
| Other | Grey `#909090` | Everything else |

Printer rows: MINI badge (cyan tint) for A1 Mini group, A1 badge (lime tint) for regular group. IDLE label in `rgba(255,255,255,0.12)` when no blocks scheduled. Offline printers at 45% opacity.

## Do's and Don'ts

### Do

- Use `{colors.primary}` lime for exactly one primary CTA per section. If two lime buttons are visible simultaneously, one should be ghost.
- Use JetBrains Mono for every data value — SKU, order ID, file name, weight, time. No exceptions.
- Use the glass panel for every card surface — never a flat opaque background.
- Show a status dot AND a text label together — never just the dot.
- Use the semantic color system for product types consistently: DS = steel-blue, WM = peach, FWM = orange, active = lime.
- Always show a confirmation modal before destructive or irreversible actions.
- Keep glow effects subtle — they accent, they don't dominate.
- Truncate long text with ellipsis. This is a dense data dashboard — content must fit its container.

### Don't

- Don't use lime as a decorative color. It means "primary action" or "active state". Lime text = clickable or active.
- Don't introduce new accent colors outside the documented palette. Adding a purple or teal for a new state breaks the system.
- Don't use Inter or Outfit for order IDs, SKUs, file names, timestamps, or any numeric data. Always mono.
- Don't add hard white (`#ffffff`) backgrounds inside panels — use glass-bg or transparent.
- Don't place more than two decorative orbs on a page.
- Don't add borders to table rows on hover — use background tint only.
- Don't skip the confirmation modal for delete/cancel operations because "it's obvious" — always confirm.
- Don't use `font-weight: 400` Outfit for button labels — always 600 or 700.
- Don't render a flat black background — always use the radial gradient.

## Interaction Patterns

- **Loading state**: `animate-spin` icon + "Loading [thing]..." in text-muted mono. Never a blank space.
- **Empty state**: Centered, text-muted, descriptive — "No orders found" or similar. Never a broken layout.
- **Transitions**: `transition-all duration-300` is the standard. `cubic-bezier(0.4, 0, 0.2, 1)` for anything that moves position.
- **Hover lift**: `translateY(-1px)` for nav items and interactive cards. `scaleY(1.08)` for Gantt blocks.
- **Active press**: `scale(0.97)` or `brightness(0.9)` — subtle, not bouncy.
- **Icon + label**: always. Icons (`material-symbols-outlined`) are decorative — always accompany with a visible label or `title` tooltip.

## Agent / System Color Identity

Each background agent has an implied color identity used for accent borders and dot colors:
- **Scout** (Gmail poller): cyan — it's watching external systems
- **Foreman** (print dispatch): lime — it's the action taker
- **Waybill Agent**: peach — it handles physical logistics
- **SimplyPrint Sync**: steel-blue — it's telemetry
- **Product Manager**: muted grey — background catalog work
