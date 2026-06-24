"""
One-time backfill script: populates normalized_variation_name on all listing_variations rows.

Run AFTER update_schema_v6.sql has been applied in Supabase.

Usage:
    python scratch/backfill_normalized_variations.py

Reads credentials from environment: SUPABASE_URL, SUPABASE_KEY
(or set them directly below for a one-off run)
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Set SUPABASE_URL and SUPABASE_KEY env vars.")
    sys.exit(1)


def normalize_variation(raw: str) -> str:
    s = (raw or "").strip().lower()
    s = re.sub(r'^\(\d+\)\s*', '', s)
    s = re.sub(r'\s*-\s*', ' - ', s)
    s = re.sub(r'\s*,\s*', ',', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def run():
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    print("Fetching all listing_variations...")
    page, page_size, total_updated = 0, 500, 0

    while True:
        res = sb.table("listing_variations")\
            .select("id, platform_variation_name")\
            .range(page * page_size, (page + 1) * page_size - 1)\
            .execute()

        rows = res.data
        if not rows:
            break

        updates = []
        for row in rows:
            norm = normalize_variation(row["platform_variation_name"])
            updates.append({"id": row["id"], "normalized_variation_name": norm})

        for u in updates:
            sb.table("listing_variations")\
                .update({"normalized_variation_name": u["normalized_variation_name"]})\
                .eq("id", u["id"])\
                .execute()

        total_updated += len(updates)
        print(f"  Page {page + 1}: updated {len(updates)} rows (total {total_updated})")
        page += 1

    print(f"\nDone. {total_updated} listing_variations updated.")


if __name__ == "__main__":
    run()
