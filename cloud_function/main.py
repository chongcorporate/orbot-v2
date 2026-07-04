import os
import json
import requests
from datetime import datetime, timezone
import functions_framework
from supabase import create_client, Client

# Read environment variables
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")
# Secret token registered with Telegram's setWebhook `secret_token` param. Telegram echoes
# this back in the X-Telegram-Bot-Api-Secret-Token header on every webhook POST, letting us
# reject requests that didn't actually come from Telegram.
TELEGRAM_WEBHOOK_SECRET = os.environ.get("TELEGRAM_WEBHOOK_SECRET")
# Shared secret for the Orbot edge functions / Railway backend (X-Orbot-Key header)
ORBOT_API_KEY = os.environ.get("ORBOT_API_KEY")

# Initialize Supabase client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

def parse_iso_datetime(dt_str):
    if not dt_str:
        return None
    try:
        # Standardize 'Z' suffix to +00:00 timezone format
        if dt_str.endswith("Z"):
            dt_str = dt_str[:-1] + "+00:00"
        return datetime.fromisoformat(dt_str)
    except Exception:
        try:
            # Fallback parse for YYYY-MM-DDTHH:MM:SS
            base_str = dt_str.split(".")[0].split("+")[0]
            if "T" in base_str:
                return datetime.strptime(base_str, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        except Exception:
            pass
    return None

def send_telegram_reply(chat_id, text, reply_to_message_id=None):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown"
    }
    if reply_to_message_id:
        payload["reply_to_message_id"] = reply_to_message_id
    try:
        r = requests.post(url, json=payload, timeout=10)
        r.raise_for_status()
    except Exception as e:
        print(f"Error sending Telegram reply: {e}")

@functions_framework.http
def telegram_webhook(request):
    """Responds to any HTTP request from Telegram.
    Args:
        request (flask.Request): HTTP request object.
    Returns:
        The response text, or any set of values that can be turned into a
        Response object.
    """
    if request.method != 'POST':
        return 'Only POST is accepted', 405

    # Security: verify Telegram's secret token. Telegram includes this header on every
    # webhook POST when a secret_token was set via setWebhook. Reject if it's missing,
    # wrong, or if we don't have a secret configured at all (fail closed).
    provided_secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
    if not TELEGRAM_WEBHOOK_SECRET or provided_secret != TELEGRAM_WEBHOOK_SECRET:
        return 'Unauthorized', 401

    request_json = request.get_json(silent=True)
    if not request_json:
        return 'No JSON payload', 400

    # Extract message details
    message = request_json.get("message")
    if not message:
        return 'OK', 200

    chat = message.get("chat")
    if not chat:
        return 'OK', 200

    chat_id = str(chat.get("id"))
    message_id = message.get("message_id")
    text = message.get("text", "").strip()

    # Security: Chat ID validation
    if chat_id != str(TELEGRAM_CHAT_ID):
        print(f"Unauthorized chat_id: {chat_id}. Expected: {TELEGRAM_CHAT_ID}")
        return 'OK', 200

    # Command detection
    if not text.startswith("/"):
        send_telegram_reply(chat_id, "🤖 Orbot only accepts command requests starting with `/`. Send `/help` for available commands.", message_id)
        return 'OK', 200

    parts = text.split(" ")
    cmd = parts[0].split("@")[0].lower()

    # Log only the command being actioned, not the raw payload (which can contain
    # the chat id and message content).
    print(f"Handling command {cmd!r}")

    if cmd in ["/start", "/help"]:
        help_text = (
            "🤖 *Orbot System Control Bot*\n\n"
            "Here are the available commands:\n"
            "• `/status` - Check agent heartbeats & active statuses\n"
            "• `/jobs` - List the 5 most recent jobs in queue\n"
            "• `/scan` - Enqueue a Gmail waybill scan job\n"
            "• `/dispatch` - Trigger Foreman print dispatch Edge function\n"
            "• `/compile` - Enqueue waybill batch PDF compilation job\n"
            "• `/sync` - Enqueue SimplyPrint mapping sync job\n"
            "• `/errors` - Get the 4 most recent warnings or errors"
        )
        send_telegram_reply(chat_id, help_text, message_id)

    elif cmd == "/status":
        try:
            res = supabase.table("agent_heartbeats").select("*").execute()
            heartbeats = res.data or []
            
            now = datetime.now(timezone.utc)
            status_lines = []
            # The backend writes two heartbeats: 'orbot_service' (main daemon loop, ~5s
            # cadence) and 'scout' (Gmail poll, ~300s cadence). Thresholds allow one
            # missed cycle plus slack; the old scout/foreman/waybill_agent/archivist @30s
            # list showed everything permanently Offline/Never-reported.
            agents = [("orbot_service", 60), ("scout", 700)]

            for agent, threshold in agents:
                hb = next((h for h in heartbeats if h["agent_name"] == agent), None)
                if hb and hb.get("last_heartbeat"):
                    hb_time = parse_iso_datetime(hb["last_heartbeat"])
                    if hb_time:
                        diff = (now - hb_time).total_seconds()
                        if diff < threshold:
                            status_lines.append(f"🟢 *{agent.upper()}*: Online (last active {int(diff)}s ago)")
                        else:
                            status_lines.append(f"🔴 *{agent.upper()}*: Offline (last active {int(diff)}s ago)")
                    else:
                        status_lines.append(f"🔴 *{agent.upper()}*: Offline (invalid heartbeat time)")
                else:
                    status_lines.append(f"⚪ *{agent.upper()}*: Never reported status")
                    
            status_reply = "🤖 *Orbot Agent Statuses*:\n\n" + "\n".join(status_lines)
            send_telegram_reply(chat_id, status_reply, message_id)
        except Exception as e:
            send_telegram_reply(chat_id, f"❌ Failed to fetch agent statuses: {str(e)}", message_id)

    elif cmd == "/jobs":
        try:
            res = supabase.table("waybill_jobs").select("*").order("created_at", desc=True).limit(5).execute()
            jobs = res.data or []
            
            if not jobs:
                jobs_reply = "📝 No waybill jobs found in the queue."
            else:
                lines = []
                for j in jobs:
                    job_id_short = j["id"][:8]
                    job_type = j["job_type"]
                    status = j["status"]
                    created_at = j["created_at"].split(".")[0].replace("T", " ")
                    
                    emoji = "⚪"
                    if status == "completed":
                        emoji = "🟢"
                    elif status == "pending":
                        emoji = "🟡"
                    elif status == "processing":
                        emoji = "🔵"
                    elif status == "failed":
                        emoji = "🔴"
                        
                    lines.append(f"{emoji} `{job_id_short}` *{job_type}*\nStatus: `{status}` | {created_at}")
                jobs_reply = "📝 *Recent Jobs Queue (Last 5)*:\n\n" + "\n\n".join(lines)
                
            send_telegram_reply(chat_id, jobs_reply, message_id)
        except Exception as e:
            send_telegram_reply(chat_id, f"❌ Failed to fetch jobs: {str(e)}", message_id)

    elif cmd == "/scan":
        try:
            res = supabase.table("waybill_jobs").insert({
                "job_type": "scout_gmail_scan",
                "status": "pending"
            }).execute()
            job = res.data[0]
            send_telegram_reply(chat_id, f"✅ Enqueued *scout_gmail_scan* job successfully!\nJob ID: `{job['id']}`", message_id)
        except Exception as e:
            send_telegram_reply(chat_id, f"❌ Failed to enqueue scan job: {str(e)}", message_id)

    elif cmd == "/dispatch":
        try:
            foreman_url = f"{SUPABASE_URL}/functions/v1/foreman"
            # The foreman edge function authenticates via the X-Orbot-Key shared secret
            # (and forwards it to Railway); the Bearer token only satisfies the platform
            # JWT check. Without ORBOT_API_KEY set, this call gets a 401.
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "X-Orbot-Key": ORBOT_API_KEY or ""
            }
            send_telegram_reply(chat_id, "⏳ Triggering Foreman print dispatch Edge function...", message_id)
            r = requests.post(foreman_url, headers=headers, json={}, timeout=20)
            res_data = r.json()
            if r.status_code != 200:
                raise Exception(res_data.get("error") or f"HTTP {r.status_code}")
            
            status_msg = res_data.get("status") or json.dumps(res_data)
            send_telegram_reply(chat_id, f"✅ *Foreman Dispatched successfully!*\nResponse: `{status_msg}`", message_id)
        except Exception as e:
            send_telegram_reply(chat_id, f"❌ Foreman trigger failed: {str(e)}", message_id)

    elif cmd == "/compile":
        try:
            res = supabase.table("waybill_jobs").insert({
                "job_type": "waybill_batch_print",
                "status": "pending"
            }).execute()
            job = res.data[0]
            send_telegram_reply(chat_id, f"✅ Enqueued *waybill_batch_print* job successfully!\nJob ID: `{job['id']}`", message_id)
        except Exception as e:
            send_telegram_reply(chat_id, f"❌ Failed to enqueue compilation job: {str(e)}", message_id)

    elif cmd == "/sync":
        try:
            res = supabase.table("waybill_jobs").insert({
                "job_type": "sync_simplyprint_ids",
                "status": "pending"
            }).execute()
            job = res.data[0]
            send_telegram_reply(chat_id, f"✅ Enqueued *sync_simplyprint_ids* job successfully!\nJob ID: `{job['id']}`", message_id)
        except Exception as e:
            send_telegram_reply(chat_id, f"❌ Failed to enqueue sync job: {str(e)}", message_id)

    elif cmd == "/errors":
        try:
            res = supabase.table("system_logs").select("*").in_("log_level", ["error", "warning"]).order("created_at", desc=True).limit(4).execute()
            logs = res.data or []
            
            if not logs:
                logs_reply = "✅ No warnings or errors logged in system logs."
            else:
                lines = []
                for l in logs:
                    emoji = "🚨" if l["log_level"] == "error" else "⚠️"
                    agent_name = l.get("agent_name") or "system"
                    message_text = l.get("log_message") or ""
                    created_at = l["created_at"].split(".")[0].replace("T", " ")
                    lines.append(f"{emoji} *[{agent_name.upper()}]* at {created_at}\n`{message_text}`")
                logs_reply = "⚠️ *Recent Errors/Warnings (Last 4)*:\n\n" + "\n\n".join(lines)
                
            send_telegram_reply(chat_id, logs_reply, message_id)
        except Exception as e:
            send_telegram_reply(chat_id, f"❌ Failed to fetch logs: {str(e)}", message_id)

    else:
        send_telegram_reply(chat_id, f"❌ Unknown command: `{cmd}`. Send `/help` for list of commands.", message_id)

    return 'OK', 200
