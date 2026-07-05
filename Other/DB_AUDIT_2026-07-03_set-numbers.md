# Orbot V2.0 — Set Name / Set Number Audit
**Date:** 2026-07-03
**Scope:** All 338 products / 320 unique set-number rows in `products` + `variants`, cross-checked against the real-world LEGO catalog (not just internal DB consistency — this pass asks "is this actually the correct LEGO set?").
**Status:** REPORT ONLY — no changes made, per instructions.

**Method:** Pulled every product's `master_sku`, `product_base_name`, and each variant's `set_number` from Supabase. First ran internal-consistency checks (sku digits vs. name digits vs. stored set_number — all agreed, no drift since the 2026-07-02/07-03 fixes). Then verified every one of the 320 set numbers against the real LEGO catalog (own knowledge + live web search against Brickset/official listings), since a set number can be internally self-consistent and still be *factually wrong* — as happened with the ISS 21312/21321 and LRV 42152/42182 bugs found and fixed yesterday.

---

## 🔴 HIGH — live, customer-facing wrong-set errors

### H-1. `BLO-SW-75357` — sold as "Millennium Falcon," set 75357 is actually "Ghost & Phantom II"
`product_base_name` = `Millennium Falcon - 75357`. LEGO 75357 is officially **"Ghost & Phantom II"** (Ahsoka, 2023) — an unrelated ship, not a Millennium Falcon. This isn't just an internal label problem: there are **live listings** built from this mislabeled product —
- "Display Stand for Lego Star Wars **Millennium Falcon** (75357)" — wrong name, wrong customer expectation
- "Display Stand for Lego Star Wars **Ghost & Phantom II** (75357)" — correct name, same underlying product
- "Wall Mount For Lego Star Wars Ghost & Phantom II (75357)"

A customer who owns the real Falcon and searches "Millennium Falcon 75357" will land on a listing that ships a Ghost & Phantom II stand instead (the real Falcon sets are 75105, 75192, 75212, 75257, 75404, etc. — none is 75357).
**Fix:** rename `product_base_name` to "Ghost & Phantom II - 75357" and correct/retire the "Millennium Falcon (75357)" listing title.

### H-2. `BLO-SC-DS` / variant `BLO-SC-DS-76924` — `set_number` stored as the model year, not the set number
Variant's `set_number` column = `"2024"` (the car's model year) instead of `"76924"` (the real LEGO Speed Champions set number). `product_base_name` and the live listing title both correctly say "...76924", so Stage-1 listing matching is unaffected — but the `set_number` column itself (used by Foreman's Stage 2 set-number fallback matching, per `resolve_variant_id` in `main.py`) is wrong and would silently fail to match this product if Stage 1 ever misses.
**Fix:** update `set_number` to `76924` on that variant row.

---

## 🟡 MEDIUM — catalog data says the wrong real-world set (lower immediate order risk — correct number/listing coverage exists elsewhere)

### M-1. Two products both mislabeled "First Order Special Forces TIE Fighter"
- `BLO-SW-75211` — 75211 is actually **"Imperial TIE Fighter"** (Solo: A Star Wars Story, 2018)
- `BLO-SW-9492` — 9492 is actually the classic **"TIE Fighter"** (2012, Episode IV)

The real First Order Special Forces TIE Fighter is set **75101**, which already exists correctly as its own product (`BLO-SW-75101`). All three (`75211`, `75101`, `9492`) are bundled into one live listing — "Display Stand for Lego Star Wars First Order Special Forces TIE Fighter (75211 / 75101 / 9492)" — so functionally the listing may still route orders correctly by variation name (Stage 1), but the catalog itself misidentifies what 75211 and 9492 physically are. Worth deciding: rename them to their real identities, or confirm the print files for 75211/9492 are genuinely built for those TIE Fighter models (in which case just the label is wrong).

### M-2. `BLO-SW-31160` — "Plo Koon's Starfighter" is really an unrelated Creator set
`product_base_name` = `Plo Koon's Starfighter - 31160`. Set 31160 is officially **LEGO Creator 3-in-1 "Aircraft: Race Plane"** — no Star Wars license, no minifigures, unrelated to Plo Koon. The correct official Plo Koon's Starfighter set (**75388**) already exists separately and correctly in the catalog (`BLO-SW-75388`). The live listing hedges with both numbers — "Plo Koon's Starfighter (75388 / 31160)" — suggesting 31160 may be an intentional fan/MOC alternate-build reference rather than an error. Worth confirming with whoever built this listing whether 31160 is deliberate (alt build) or a leftover mistake, since as a standalone entry it's factually wrong.

---

## 🟢 LOW — cosmetic naming only (set numbers are correct)

1. **`BLO-SW-8089`** — named "Snowspeeder - 8089," but 8089 is officially **"Hoth Wampa Cave"** (2010), which happens to include a small Snowspeeder sub-build. It's bundled in a listing alongside 5 other genuinely-numbered Snowspeeder sets (7130/7666/75049/75259/75268), so likely intentional shorthand for "the snowspeeder piece within this set" — just flagging that the set itself isn't called "Snowspeeder."
2. **Three Harry Potter products share one generic name**: `BLO-HPR-75979`, `BLO-HPR-76394`, `BLO-HPR-76406` are all labeled "Harry Potter Flying Beasts" even though they're three distinct official sets — **Hedwig** (75979), **Fawkes, Dumbledore's Phoenix** (76394), and **Hungarian Horntail Dragon** (76406). Set numbers are all correct; only the shared generic name could confuse catalog browsing/reporting.

---

## ✅ Clean (no action needed)

- **All ~312 other set-number/name pairings checked out** against the real LEGO catalog — City, DC, Disney Pixar, Fortnite, Harry Potter (aside from the naming note above), Icons, Ideas, Marvel, Ninjago, Nintendo, "Other" themes, Speed Champions (all other bundle products, including the multi-set bundles which legitimately combine 2-3 real set numbers in one name), Star Wars (~230 products), and Technic — all confirmed correct.
- **No internal drift**: master_sku digits, product_base_name digits, and stored `set_number` agree everywhere except the one H-2 case above (which passed the internal check precisely because "2024" coincidentally appears as a substring of the product name's text).
- Umbrella/non-set-specific products (`BLO-MFG`, `BLO-F1C`, Skadis mounts, generic minifig displays, "General Lego Car") correctly have no `set_number` — that's by design, not a gap.

---

## Summary

| Severity | Count | Item |
|---|---|---|
| 🔴 High | 2 | 75357 sold as wrong set (live listing risk); 76924's `set_number` column holds a year, not the set number |
| 🟡 Medium | 2 | 75211 & 9492 both mislabeled as First Order Special Forces TIE Fighter (real one is 75101, exists separately); 31160 mislabeled as Plo Koon's Starfighter (real one is 75388, exists separately) |
| 🟢 Low | 2 | 8089 "Snowspeeder" is really Hoth Wampa Cave; 3 Harry Potter sets share one generic name |
| ✅ Clean | ~312 | Everything else verified correct against the real LEGO catalog |

No changes have been made — awaiting your go-ahead on which of these to fix.
