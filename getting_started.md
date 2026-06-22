# Getting Started with Orbot V0.2

Welcome to your new fully automated 3D printing factory architecture! I have generated all the blueprint prompts and the SQL schema. Follow these exact steps to get everything up and running.

## Step 1: Initialize the Database
1. Open your Supabase Dashboard for the Orbot v0.2 project.
2. Go to the **SQL Editor**.
3. Open the `init_schema.sql` file located in this folder (`Orbot V0.2`).
4. Copy the entire contents of the SQL script, paste it into the SQL Editor, and click **Run**.
   * *This will create all your tables (products, variants, print_files, listings, orders, order_items, print_jobs, system_logs).*

## Step 2: Set up your AI Agents
You requested **System Prompts** to paste into your independent agents. Inside this folder, you will find 5 markdown files:
* `prompt_product_manager.md`
* `prompt_scout.md`
* `prompt_foreman.md`
* `prompt_waybill_agent.md`
* `prompt_status_report_agent.md`
* `prompt_archivist.md`

**Instructions:**
1. Open your AI agent builder (e.g., Custom GPT, Claude Project, Dify, Flowise).
2. Create a new agent (e.g., name it "Scout").
3. Open the corresponding markdown file (e.g., `prompt_scout.md`).
4. Copy the entire text from the markdown file and paste it into the **System Instructions / Prompt** box of your agent.
5. Save the agent.
6. Simply tell the agent: "Write the code." It will instantly generate the exact, production-ready Python or Deno code you need based on the rigorous rules we designed.

## Step 3: Deployment
1. **Python Agents**: For the Product Manager, Scout, and Waybill Agent, the AI will give you Python scripts. Save these to your local machine (or a server), install the requirements (`pip install supabase google-genai PyPDF2`), and run them.
2. **Edge Functions**: For Foreman and the Status Report Agent, the AI will give you TypeScript (Deno) code. You will deploy these directly to Supabase Edge Functions using the Supabase CLI (`supabase functions deploy`). The AI will provide exact deployment instructions in its output.

## Catalog & Naming Rules
To maintain production integrity, all products follow these strict rules during ingestion:

1. **Official Naming**: Set names are audited against official LEGO data (e.g., "Venomized" vs "Venomised").
2. **File Naming**: `[Set Name]-[Set Number] - [Type] - [Weight]g-[Time]m.gcode`
3. **Plate Logic**: All `DS` variants automatically include a `PLATE` file (Nameplate).
4. **Marketing Sync**: Sales listing titles are automatically corrected to use official set names.

## Architecture Notes
* **Gemini Flash**: Scout and Waybill are specifically instructed to use `gemini-1.5-flash` or `gemini-2.0-flash` for high-speed, low-cost parsing.
* **Database Routing**: Order items link directly to Variants. The `listings` table is now purely for your own reference.
* **Multi-file Printing**: The system flawlessly handles 1 variant having 10 different print files via the decoupled `print_jobs` table.

You're ready to print!
