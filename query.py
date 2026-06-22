import os
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_SERVICE_KEY")

if not url or not key:
    print("Error: Missing Supabase credentials in .env")
    exit(1)

supabase = create_client(url, key)

variant_sku = "BLO-MVL-76254-DS"

# Query the variant
variant_res = supabase.table("variants").select("id, variant_name").eq("variant_sku", variant_sku).execute()

if not variant_res.data:
    print(f"Variant '{variant_sku}' not found.")
else:
    variant_id = variant_res.data[0]["id"]
    variant_name = variant_res.data[0]["variant_name"]
    print(f"Found Variant: {variant_name} (ID: {variant_id})")
    
    # Query the print files
    print_files_res = supabase.table("print_files").select("*").eq("variant_id", variant_id).execute()
    
    if not print_files_res.data:
        print("No print files found for this variant.")
    else:
        print(f"Found {len(print_files_res.data)} print files:")
        for pf in print_files_res.data:
            print(f"- {pf['print_file_name']} (SimplyPrint ID: {pf.get('simplyprint_file_id', 'N/A')}, Duration: {pf.get('print_duration_minutes', 'N/A')}m, Weight: {pf.get('material_weight_grams', 'N/A')}g)")
