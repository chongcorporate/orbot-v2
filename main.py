import os
import sys
import argparse
import threading
import asyncio
import time
import shutil
import re
import json
import base64
import hmac
import html as html_module
import logging
import mimetypes
import tempfile
import traceback
import ipaddress
import socket
import zipfile
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime
from io import BytesIO
from datetime import datetime, date, timedelta, timezone
from collections import defaultdict
from pathlib import Path
from typing import List, Optional, Dict, Any
from urllib.parse import urlparse, urljoin

# Third-party imports
import requests
import pandas as pd
import numpy as np
from dotenv import load_dotenv
from supabase import create_client, Client
from google import genai
from google.genai import types as genai_types
from pydantic import BaseModel, Field, field_validator

# FastAPI imports
from fastapi import FastAPI, BackgroundTasks, UploadFile, File, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# PyPDF2 imports
from PyPDF2 import PdfReader, PdfWriter

# Google APIs / Gmail OAuth imports
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload

# Try importing thefuzz for Archivist's smart boost match logic
try:
    from thefuzz import process, fuzz
except ImportError:
    fuzz = None

try:
    import fcntl
except ImportError:
    fcntl = None

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("OrbotUnified")

# Load environment variables — prefer .env in project directory
_base_dir = Path(__file__).parent
load_dotenv(_base_dir / ".env")

# Bootstrap Google auth files from env vars (Railway cloud deployment).
# Locally, the files exist on disk. On Railway, store their JSON content as
# GOOGLE_TOKEN_JSON and GOOGLE_CREDENTIALS_JSON environment variables.
_token_env = os.environ.get("GOOGLE_TOKEN_JSON")
_creds_env = os.environ.get("GOOGLE_CREDENTIALS_JSON")
if _token_env:
    (_base_dir / "token.json").write_text(_token_env)
if _creds_env and not (_base_dir / "credentials.json").exists():
    (_base_dir / "credentials.json").write_text(_creds_env)

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

# Shared-secret auth for backend routes. Every route except the health checks and
# inbound webhooks that third parties call directly (which can't send a custom header)
# requires this in the X-Orbot-Key header — including /config, which returns the
# Supabase anon key and so must not be reachable by URL alone. Fails
# CLOSED: if unset, require_api_key() rejects every request rather than skipping the check.
ORBOT_API_KEY = os.environ.get("ORBOT_API_KEY")

# CORS: explicit allowlist of origins permitted to call this API, comma-separated.
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY / SUPABASE_KEY in environment variables.")

from supabase import ClientOptions

# Global clients
supabase_options = ClientOptions(
    postgrest_client_timeout=10,
    storage_client_timeout=10
)
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY, options=supabase_options)
ai_client = None
if GEMINI_API_KEY:
    # 30s request timeout — a hung Gemini call must not stall a Scout webhook scan indefinitely.
    ai_client = genai.Client(api_key=GEMINI_API_KEY, http_options={"timeout": 30000})

# Global HTTP Session for connection pooling
http_session = requests.Session()

# Global Configs
INCOMING_FOLDER_ID = "1rBxiIFTHgRVizQ8nwQjTiUhrU-a9j2rN"
WAYBILL_MAIN_FOLDER_ID = "1AH2vclLcPO7xNTvcW9s3w5XqfuA4mkFE"
SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.modify']
SIMPLYPRINT_COMPANY_ID = "13502"
# SimplyPrint printer groups by capability: files sliced for the A1 Mini can only run on
# the Minis; everything else runs on the regular A1s. Keep in sync with the physical farm.
A1_MINI_PRINTER_IDS = [38959, 38960]
A1_REGULAR_PRINTER_IDS = [38961, 39538]

def route_printers_for_file(print_file_name: str) -> list:
    """Returns the printer-ID group for a file based on filename slice markers ('a1m'/'mini'
    → A1 Mini, else regular A1; 'minifig' is not a Mini marker). Single source of truth —
    Foreman dispatch and /print-files/queue previously carried two diverging copies."""
    name_lower = print_file_name.lower()
    name_no_ext = name_lower[:-6].strip() if name_lower.endswith('.gcode') else name_lower.strip()
    if name_no_ext.endswith('a1m') or name_no_ext.endswith('mini'):
        is_a1_mini = True
    elif name_no_ext.endswith('a1'):
        is_a1_mini = False
    else:
        is_a1_mini = bool(re.search(r'(?:[-_ ]a1m\b|^a1m\b|\ba1m\b|[-_]a1m[-_(])|(?:\bmini\b|[-_]mini\b)', name_lower)) \
                     and not re.search(r'\bminifig', name_lower)
    return A1_MINI_PRINTER_IDS if is_a1_mini else A1_REGULAR_PRINTER_IDS

# Gmail push notifications (Pub/Sub). When GMAIL_PUBSUB_TOPIC is set, Scout runs
# event-driven: Gmail users.watch() publishes to this topic, Pub/Sub pushes to the
# /gmail/notifications webhook, and each push triggers a single scan. GMAIL_PUSH_TOKEN
# is a shared secret appended to the push URL (?token=...) to reject spoofed requests.
# If GMAIL_PUBSUB_TOPIC is unset, Scout falls back to the legacy periodic poll.
GMAIL_PUBSUB_TOPIC = os.environ.get("GMAIL_PUBSUB_TOPIC")  # e.g. projects/orbot-123/topics/gmail-orders
GMAIL_PUSH_TOKEN = os.environ.get("GMAIL_PUSH_TOKEN")

TOKEN_PATH = str(_base_dir / 'token.json')
CREDENTIALS_PATH = str(_base_dir / 'credentials.json')

# Module-level cache for Google OAuth creds + built API service clients. Gmail and Drive
# share one token.json under the combined SCOPES above. Without this cache, every
# ScoutAgent() instantiation (one per Pub/Sub webhook push in event-driven mode) and every
# get_drive_service() call would re-read token.json from disk and rebuild the API client
# from scratch — wasteful, and each unnecessary refresh risks Google rate-limiting us.
_google_creds_cache = None
_gmail_service_cache = None
_drive_service_cache = None

def _get_google_creds():
    """Loads/refreshes Google OAuth creds, caching in memory across calls. Only touches
    disk or the network when the cached credentials are missing or actually invalid."""
    global _google_creds_cache, _gmail_service_cache, _drive_service_cache
    creds = _google_creds_cache
    if not creds and os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(GoogleAuthRequest())
            except Exception as e:
                logger.warning(f"Google token refresh failed: {e}. Re-authenticating...")
                creds = None
        if not creds:
            check_interactive("Google OAuth (Scout/Waybill)")
            if not os.path.exists(CREDENTIALS_PATH):
                raise FileNotFoundError(f"Missing Google OAuth credentials.json at {CREDENTIALS_PATH}")
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)
            # Brand-new credentials object — any cached services were built against the
            # old one and must be rebuilt against this one.
            _gmail_service_cache = None
            _drive_service_cache = None
        with open(TOKEN_PATH, 'w') as token:
            token.write(creds.to_json())

    _google_creds_cache = creds
    return creds

# Module-level cache of the shops table, keyed for fast shop resolution. Scout resolves the
# shop for every incoming order, so we avoid a DB round-trip per email. Refreshed lazily
# (TTL) and on demand (invalidate_shops_cache) when shops are edited.
_shops_cache = None
_shops_cache_ts = 0.0
_SHOPS_CACHE_TTL = 300  # seconds

def invalidate_shops_cache():
    """Force the next get_shops() to re-read from the DB (call after editing shops)."""
    global _shops_cache, _shops_cache_ts
    _shops_cache = None
    _shops_cache_ts = 0.0

def get_shops(force: bool = False):
    """Returns the list of shop rows, cached in memory with a short TTL."""
    global _shops_cache, _shops_cache_ts
    now = time.time()
    if not force and _shops_cache is not None and (now - _shops_cache_ts) < _SHOPS_CACHE_TTL:
        return _shops_cache
    try:
        res = supabase.table("shops").select(
            "id, name, slug, sku_prefix, email_aliases, product_model, "
            "default_currency, waybill_folder_id, ai_copy_profile, is_active"
        ).execute()
        _shops_cache = res.data or []
        _shops_cache_ts = now
    except Exception as e:
        logger.error(f"Failed to load shops: {e}")
        if _shops_cache is None:
            _shops_cache = []
    return _shops_cache

def get_shop_by_id(shop_id: Optional[str]) -> Optional[dict]:
    """Returns the shop row for an id, or None."""
    if not shop_id:
        return None
    for s in get_shops():
        if s["id"] == shop_id:
            return s
    return None

def resolve_shop(shop_name: Optional[str]) -> Optional[dict]:
    """Resolves a marketplace shop/seller name (as extracted from an order email) to a shop
    row by matching against each shop's email_aliases (case-insensitive, whitespace/handle
    tolerant). Returns the shop dict, or None when no alias matches (→ Unassigned)."""
    if not shop_name:
        return None

    def _norm(s: str) -> str:
        # Lowercase and strip everything but alphanumerics so "Blocked Off", "blockedoff",
        # and "blockedoff.my" all compare equal on their shared stem.
        return re.sub(r'[^a-z0-9]', '', (s or '').lower())

    target = _norm(shop_name)
    if not target:
        return None

    best = None
    for s in get_shops():
        if s.get("is_active") is False:
            continue
        for alias in (s.get("email_aliases") or []):
            na = _norm(alias)
            if not na:
                continue
            # Match if either side contains the other's stem (handles "blockedoff" vs
            # "blockedoff.my" and shop names that embed extra marketplace suffixes).
            if na == target or na in target or target in na:
                # Prefer the longest alias match (most specific shop).
                if best is None or len(na) > best[0]:
                    best = (len(na), s)
    return best[1] if best else None

# In-process Scout lock (used when fcntl is unavailable)
_scout_thread_lock = threading.Lock()

# Gmail label name (lowercased) → label ID, cached per process.
_gmail_label_cache: dict = {}


# ----------------- Shared Helper Functions -----------------

def log_system(level: str, message: str, details: Optional[Dict[str, Any]] = None, agent_name: str = "System"):
    """Logs system events and messages to the system_logs table in Supabase."""
    try:
        log_data = {
            "agent_name": agent_name,
            "log_level": level,
            "log_message": message,
            "additional_details": details or {}
        }
        supabase.table("system_logs").insert(log_data).execute()
        print(f"[{agent_name.upper()}] [{level.upper()}] {message}")
    except Exception as e:
        print(f"CRITICAL: Failed to write to system_logs: {e}")

def write_heartbeat(agent_name: str):
    """Upserts an agent's heartbeat row (UTC). Shared by every daemon loop / job handler."""
    supabase.table('agent_heartbeats').upsert({
        'agent_name': agent_name,
        'last_heartbeat': datetime.now(timezone.utc).isoformat()
    }).execute()

def log_gemini_usage(agent_name: str, model_name: str, response):
    """Logs Gemini API token usage to the database."""
    try:
        metadata = getattr(response, 'usage_metadata', None)
        if metadata:
            prompt_tokens = getattr(metadata, 'prompt_token_count', 0)
            completion_tokens = getattr(metadata, 'candidates_token_count', 0)
            total_tokens = getattr(metadata, 'total_token_count', 0)
            
            supabase.table("gemini_usage_log").insert({
                "agent_name": agent_name,
                "model_name": model_name,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens
            }).execute()
            print(f"[*] Gemini usage logged: {total_tokens} tokens for {agent_name} ({model_name})")
    except Exception as e:
        print(f"[*] Failed to log Gemini usage: {e}")

def gemini_generate(agent_name: str, contents, config: Optional[dict] = None,
                    models: tuple = ('gemini-2.5-flash', 'gemini-2.5-pro')):
    """Calls Gemini with a model fallback chain — transient errors (timeout/503/429) move
    to the next model — logging token usage per call. Raises the last error if every model
    fails. Scout keeps its own chain: its retry semantics differ (TransientLLMError must
    leave the source email unread for the next scan)."""
    last_err = None
    for model in models:
        try:
            kwargs = {'config': config} if config else {}
            response = ai_client.models.generate_content(model=model, contents=contents, **kwargs)
            log_gemini_usage(agent_name, model, response)
            return response
        except Exception as e:
            last_err = e
            err_str, err_type = str(e), type(e).__name__
            is_transient = ('Timeout' in err_type or 'timeout' in err_str.lower() or '503' in err_str
                            or 'UNAVAILABLE' in err_str or '429' in err_str or 'RESOURCE_EXHAUSTED' in err_str)
            if not is_transient:
                break
            logger.warning(f"[{agent_name}] {model} transient error ({err_type}) — trying next model.")
    raise last_err

def fetch_all_rows(table: str, columns: str = "*", page_size: int = 1000) -> list:
    """Fetches every row of a table, paginating past the Supabase server-side max-rows cap
    (default 1000): a plain .select() silently truncates once a table outgrows the cap,
    no matter what .limit() asks for. Any query meant to return an ENTIRE table must go
    through this (or its own .range() loop)."""
    rows: list = []
    page = 0
    while True:
        res = supabase.table(table).select(columns).range(page * page_size, (page + 1) * page_size - 1).execute()
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < page_size:
            return rows
        page += 1

def check_interactive(action_name: str):
    """Checks if the application is running in an interactive CLI session.
    If not, raises an error to prevent headless browser authentication hangs."""
    is_interactive = sys.stdin.isatty() and os.environ.get("START_DAEMON_THREADS", "true").lower() != "true"
    if not is_interactive:
        raise RuntimeError(
            f"Google API authentication required for '{action_name}', but the application "
            "is running in a headless/non-interactive context (daemon or background service). "
            "Please run manually in a terminal once (e.g. 'python3 main.py scout') to complete OAuth sign-in."
        )

def get_f1_sku_suffix(var_name: str) -> str:
    if not var_name:
        return ""
    val = var_name.lower().strip()
    if "mclaren" in val:
        return "MCLAREN"
    if "aston" in val:
        return "ASTON"
    if "ferrari" in val:
        return "FERRARI"
    if "haas" in val:
        return "HAAS"
    if "alpine" in val:
        return "ALPINE"
    if "apx" in val:
        return "APX"
    if "kick" in val or "sauber" in val:
        return "KICK"
    if "mercedes" in val or "merc" in val:
        return "MERC"
    if "redbull" in val or "red bull" in val:
        return "REDBULL"
    if "racing bulls" in val or "racing buls" in val or "racing" in val or val == "rb":
        return "RACINGBULLS"
    if "williams" in val:
        return "WILLIAMS"
    return ""

def get_f1_multi_tier_suffix(var_name: Optional[str], listing_title: str) -> str:
    if var_name:
        v_clean = var_name.lower().strip()
        m = re.search(r'\b([1-4])\s*tier', v_clean)
        if m:
            return f"T{m.group(1)}"
        for t in ["t1", "t2", "t3", "t4"]:
            if t == v_clean or f" {t}" in v_clean or f"{t} " in v_clean or f"({t})" in v_clean:
                return t.upper()
        if "1 tier" in v_clean or "1-tier" in v_clean:
            return "T1"
        if "2 tier" in v_clean or "2-tier" in v_clean:
            return "T2"
        if "3 tier" in v_clean or "3-tier" in v_clean:
            return "T3"
        if "4 tier" in v_clean or "4-tier" in v_clean:
            return "T4"

    combined = f"{listing_title} {var_name or ''}".lower()
    m = re.search(r'\b([1-4])\s*tier', combined)
    if m:
        return f"T{m.group(1)}"
    
    for t in ["t4", "t3", "t2", "t1"]:
        if re.search(rf'\b{t}\b', combined):
            return t.upper()
            
    if "4 tier" in combined or "4-tier" in combined:
        return "T4"
    if "3 tier" in combined or "3-tier" in combined:
        return "T3"
    if "2 tier" in combined or "2-tier" in combined:
        return "T2"
    if "1 tier" in combined or "1-tier" in combined:
        return "T1"
    return ""


# ----------------- Pydantic Models for LLM Structured Outputs -----------------

class OrderItem(BaseModel):
    listing_title: str = Field(description="The name of the product listing. CRITICAL: Strip off any leading item numbering, indices, or list prefixes like '1. ', '2) ', '• ' so that it is just the text name, e.g. 'Display Stand for Time Machine...'.")
    variation_name: Optional[str] = Field(default=None, description="The specific variation/option selected. CRITICAL: Copy the variation name EXACTLY as it appears in the email — do NOT strip trailing numbers, commas, or suffixes (e.g. '(75394)Base - Plaque,1' must stay '(75394)Base - Plaque,1', not 'Base - Plaque'). These trailing values are part of the variant identifier, not quantities. Use None if no variation is mentioned.")
    purchased_quantity: int = Field(description="Quantity ordered.")
    item_subtotal: Optional[float] = Field(default=None, description="The line price/subtotal shown next to THIS item in the email (number only, no currency symbol). Use None if no per-item price is shown.")
    source_snippet: Optional[str] = Field(default=None, description="RECEIPT: copy the exact contiguous text from the email that this item was read from — the product name line as it literally appears, VERBATIM, character for character (including any numbering, prices, 'x1' quantities). Do not paraphrase, reorder, or fix typos. This is used to verify the item really exists in the email.")

    @field_validator('item_subtotal', mode='before')
    @classmethod
    def clean_item_subtotal(cls, v):
        if isinstance(v, str):
            v = re.sub(r'[^\d,.]', '', v.strip())
            if '.' in v and ',' in v:
                v = v.replace(',', '')
            elif ',' in v:
                v = v.replace(',', '.')
        try:
            return float(v) if v not in (None, '') else None
        except (ValueError, TypeError):
            return None

class OrderDetails(BaseModel):
    is_order_email: bool = Field(description="Set to true ONLY if this email is a genuine new order confirmation from Shopee or Lazada containing an order ID, customer name, and items. Set to false for logistics notifications (SPX, J&T, tracking updates, drop-off reminders, seller centre alerts, or any email that is NOT a new order).")
    platform_order_id: str = Field(description="Shopee/Lazada order ID. CRITICAL: Strip any leading '#' prefix if present.")
    order_timestamp: str = Field(description="Order timestamp (ISO 8601). Guess timezone if not provided, assume UTC+8 for Malaysia.")
    sales_platform: str = Field(description="Platform name ('Shopee', 'Lazada').")
    shop_name: Optional[str] = Field(default=None, description="The SELLER'S shop/store name — i.e. the name of OUR store that received this order (NOT the buyer, NOT the marketplace). On Shopee/Lazada order emails this appears in greetings like 'Hello <ShopName>', 'Your shop <ShopName> received an order', or in the email footer/subject. Return the shop name verbatim if present, otherwise null.")
    customer_name: str = Field(description="Customer/buyer name or username, e.g. 'duoble8402' from 'Kindly ship order to duoble8402.'.")
    order_subtotal: float = Field(description="Order subtotal amount.")
    order_currency: str = Field(default="MYR", description="ISO currency code of the order, inferred from the currency symbol/code in the email (RM/MYR→MYR, S$/SGD→SGD, ฿/บาท/THB→THB, ₱/PhP/PHP→PHP, Rp/IDR→IDR, ₫/đ/VND→VND, NT$/TWD→TWD). Use 'MYR' only if no currency indicator is present.")

    @field_validator('order_subtotal', mode='before')
    @classmethod
    def clean_subtotal(cls, v):
        if isinstance(v, str):
            v = re.sub(r'[^\d,.]', '', v.strip())
            if '.' in v and ',' in v:
                v = v.replace(',', '')          # "1,234.50" → "1234.50"
            elif ',' in v:
                v = v.replace(',', '.')         # "1234,50" → "1234.50"
        try:
            return float(v) if v else 0.0
        except (ValueError, TypeError):
            return 0.0
    items: List[OrderItem] = Field(description="CRITICAL: ALL items purchased in this order. Shopee/Lazada emails may list multiple products separated by numbers, bullets, line breaks, or in a table. You MUST extract every distinct product as a separate OrderItem — never collapse multiple products into one entry. If the email says '2 products' or '3 items', your list must have that many entries.")
    stated_item_count: Optional[int] = Field(default=None, description="If the email explicitly states how many products/items the order contains (e.g. '2 products', '3 items', 'Jumlah Produk: 2'), copy that number. Use None if the email never states a count. Do NOT compute it yourself from the item list.")

class PLItem(BaseModel):
    listing_title: str = Field(description="The name or title of the product listing. E.g. 'Display Base for Lego Minifigure' or 'Wall Mount for Lego NASA ISS Space Station (21312)'. Strip off any item indices like '1.' or trailing quantity/price if they are merged.")
    variation_name: Optional[str] = Field(default=None, description="The variation or variation name in the variation column, if any. E.g. '5'. Strip off quantity or other values if they are merged.")
    quantity: int = Field(description="The purchased quantity of this item.")

class PLOrder(BaseModel):
    platform_order_id: str = Field(description="The platform order ID for this packing list (typically a 14-character alphanumeric string YYMMDD...).")
    items: List[PLItem] = Field(description="The list of items parsed for this order.")

class PackingListDetails(BaseModel):
    orders: List[PLOrder] = Field(description="The list of orders in the packing list.")

class IngestEmailRequest(BaseModel):
    email_body: str

class CancelRequest(BaseModel):
    order_id: Optional[str] = None
    platform_order_id: Optional[str] = None
    email_body: Optional[str] = None


# ----------------- SECTION 1: Product Manager Ingestion -----------------

def clean_dict(d: Dict[str, Any]) -> Dict[str, Any]:
    """Removes None/NaN values from dictionary for Supabase compatibility."""
    return {k: v for k, v in d.items() if v is not None and not (isinstance(v, float) and np.isnan(v))}

def clean_set_number(val: Any, ref_name: str) -> str:
    """Resolves and cleans LEGO set numbers to standard integers."""
    if pd.isna(val) or not str(val).strip() or str(val).strip().lower() == 'nan':
        match = re.search(r'\b\d{4,5}\b', ref_name)
        return match.group(0) if match else "UNKNOWN"
        
    val_str = str(val).strip()
    if '.' in val_str:
        try:
            return str(int(float(val_str)))
        except ValueError:
            pass
            
    match = re.search(r'\b\d{4,5}\b', val_str)
    if match:
        return match.group(0)
        
    digits = "".join(c for c in val_str if c.isdigit())
    if 4 <= len(digits) <= 5:
        return digits
        
    return val_str

def clean_variant_type(val: Any) -> str:
    """Maps variant types to valid database enum values (BASE, DS, WM, DS-NP, FWM)."""
    if pd.isna(val) or not str(val).strip() or str(val).strip().lower() == 'nan':
        return "BASE"
        
    val_str = str(val).strip().upper()
    if val_str in {'BASE', 'DS', 'WM', 'DS-NP', 'FWM'}:
        return val_str
        
    return "BASE"

def derive_master_sku(sku: str, set_number: str) -> str:
    """Derives the master SKU up to the set number."""
    sku = sku.strip()
    if set_number != "UNKNOWN" and set_number in sku:
        idx = sku.find(set_number)
        return sku[:idx + len(set_number)].strip()
    else:
        parts = sku.split('-')
        return "-".join(parts[:-1]) if len(parts) > 1 else sku

def normalize_filename(name: str) -> str:
    """Normalizes a filename recursively by stripping trailing extensions and printer profiles."""
    name = str(name).lower().strip()
    while True:
        # Strip extensions
        new_name = re.sub(r'\.+(?:gcode|3mf|stl)$', '', name)
        # Strip printer profiles like -a1m, -a1, -p1s, -x1c
        new_name = re.sub(r'\s*-\s*(?:a1m|a1|p1s|x1c|mini|combo|a1-mini)\s*$', '', new_name)
        if new_name == name:
            break
        name = new_name
    return name.strip()

def normalize_variation(raw: str) -> str:
    """Canonical normalization for matching variation names.
    Lowercases, normalizes spacing around - and ,.

    Does NOT strip a leading "(N)" prefix: on shared/multi-set listings (e.g. a base
    plate compatible with two sets, sold under one listing) that prefix is the set
    number distinguishing otherwise-identical variation text like "(60367)Base - Blank"
    vs "(60262)Base - Blank". Stripping it collapsed both to the same normalized key,
    made Stage 1 exact-match ambiguous, and let a fallback stage silently resolve to
    the wrong set (see order 260703PDMEJC73)."""
    s = (raw or "").strip().lower()
    s = re.sub(r'\s*-\s*', ' - ', s)         # normalize hyphens: space-hyphen-space
    s = re.sub(r'\s*,\s*', ',', s)           # normalize commas: no spaces
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def extract_set_number_from_text(text: str) -> Optional[str]:
    """Extract first LEGO set number (4-6 digits, not a year) from any text string."""
    matches = re.findall(r'\b\d{4,6}\b', text or "")
    non_years = [m for m in matches if not re.match(r'^(19|20)\d{2}$', m)]
    return non_years[0] if non_years else None

def extract_variant_intent(norm_var: str, listing_title: str = '') -> dict:
    """Extract structured matching intent from a normalized variation name.
    Returns dict with keys: variant_type (str), plaque_count (int|None), set_number_override (str|None)."""
    combined = f"{norm_var} {listing_title}".lower()

    # Wall / flush wall mount. The variation name (what the customer actually picked)
    # takes priority over the listing title — a listing titled "Flush Wall Mount ..."
    # can still offer a plain "Wall Mount" variation alongside flush ones, and the
    # title-level "flush" must not override that explicit per-variation signal.
    if re.search(r'\b(fwm|flush)\b', norm_var):
        return {"variant_type": "FWM", "plaque_count": None, "set_number_override": None}
    if re.search(r'\b(wall|mount|wm)\b', norm_var):
        return {"variant_type": "WM", "plaque_count": None, "set_number_override": None}
    if 'flush' in listing_title.lower():
        return {"variant_type": "FWM", "plaque_count": None, "set_number_override": None}

    # Plaque count: "base - plaque,N" or "plaque,N"
    m = re.search(r'plaque,(\d+)', norm_var)
    if m:
        return {"variant_type": "DS", "plaque_count": int(m.group(1)), "set_number_override": None}

    # No nameplate: "blank"
    if re.search(r'\bblank\b', norm_var):
        # Star Wars: set number may appear after comma in variation (e.g. "base - blank,75389")
        set_override = extract_set_number_from_text(norm_var)
        return {"variant_type": "DS-NP", "plaque_count": None, "set_number_override": set_override}

    # Variation gave no type signal at all (blank/None variation) — fall back to the
    # listing title: a "Wall Mount for ..." listing with an unnamed variation is a WM,
    # not a DS (e.g. order 260703PRBGA7CS: "Wall Mount for Lego NASA Space Shuttle
    # Discovery (10283)" with variation None missed its WM variant in Stage 2).
    if not norm_var and re.search(r'wall\s*mount|\bwm\b|\bfwm\b', listing_title.lower()):
        return {"variant_type": "WM", "plaque_count": None, "set_number_override": None}

    return {"variant_type": "DS", "plaque_count": None, "set_number_override": None}

def _self_heal_listing_variation(supabase_client, listing_id: Optional[str], listing_title: str,
                                  variant_id: str, norm_var: str, raw_var: Optional[str]) -> None:
    """Write a fallback-matched listing_variation back to DB so future orders hit Stage 1."""
    if not listing_id:
        return
    try:
        supabase_client.table("listing_variations").insert({
            "listing_id":               listing_id,
            "variant_id":               variant_id,
            "platform_variation_name":  raw_var or norm_var,
            "normalized_variation_name": norm_var,
            "reference_name":           f"{listing_title} [{raw_var or norm_var}]",
            "match_source":             "self_heal",
        }).execute()
        logger.info(f"[Matching] Self-healed listing variation for '{listing_title}' → '{norm_var}'")
    except Exception:
        pass  # duplicate = already healed, safe to ignore

_VARIANT_COLS = "variant_sku, variant_name, plaque_count, set_number"

def _embed_variant_row(embedded) -> Optional[dict]:
    """Normalize a PostgREST embedded `variants(...)` payload (which may come back as a
    single dict for a to-one relationship, or a 1-element list) into a plain dict or None."""
    if isinstance(embedded, list):
        return embedded[0] if embedded else None
    return embedded or None

def resolve_variant(supabase_client, listing_title: str, variation_name: Optional[str],
                     shop_id: Optional[str] = None) -> tuple[Optional[str], bool, Optional[dict]]:
    """Canonical variant resolver shared by Scout and Foreman.
    Returns (variant_id, is_new_match, variant_row). is_new_match=True means matched via
    fallback. variant_row carries {variant_sku, variant_name, plaque_count} when the matching
    query already fetched it (lets callers skip a follow-up variants lookup); it may be None,
    in which case the caller must fetch those columns itself.

    shop_id scopes Stage 1/2/3 lookups to that shop's own listings/variants, preventing
    two brands with colliding listing titles or set numbers from cross-matching. When
    shop_id is None (order not yet attributed to a shop), matching stays global — the
    legacy, pre-multi-shop behavior — so unattributed orders are never silently dropped.

    The LEGO-specific stages (set_number/plaque_count lookup, Star Wars, F1 Speed
    Champions) only run when the resolved shop's product_model is 'lego_display'
    (the default when shop_id is None/unknown, to preserve legacy behavior for the
    original single-brand catalog)."""
    shop = get_shop_by_id(shop_id) if shop_id else None
    product_model = shop["product_model"] if shop else "lego_display"
    sku_prefix = shop["sku_prefix"] if shop else "BLO"
    is_lego = product_model == "lego_display"

    norm_var = normalize_variation(variation_name)
    exact_listing_id = None

    logger.info(f"[Matching] Stage 1: listing='{listing_title}' norm_var='{norm_var}' shop_id={shop_id}")
    try:
        listing_q = supabase_client.table("listings").select("id, products!inner(shop_id)" if shop_id else "id") \
            .eq("platform_listing_name", listing_title)
        if shop_id:
            listing_q = listing_q.eq("products.shop_id", shop_id)
        listing_res = listing_q.limit(1).execute()
        if listing_res.data:
            listing_id = listing_res.data[0]["id"]
            exact_listing_id = listing_id

            lv_res = supabase_client.table("listing_variations")\
                .select(f"variant_id, variants({_VARIANT_COLS})")\
                .eq("listing_id", listing_id)\
                .eq("normalized_variation_name", norm_var)\
                .limit(1).execute()
            if lv_res.data:
                logger.info(f"[Matching] Stage 1 Success: '{norm_var}' → {lv_res.data[0]['variant_id']}")
                return lv_res.data[0]["variant_id"], False, _embed_variant_row(lv_res.data[0].get("variants"))

            # Fallback 1.1: listing has exactly one variation with a blank/default name
            all_vars_res = supabase_client.table("listing_variations")\
                .select(f"variant_id, platform_variation_name, variants({_VARIANT_COLS})")\
                .eq("listing_id", listing_id).execute()
            if all_vars_res.data and len(all_vars_res.data) == 1:
                db_var = all_vars_res.data[0]["platform_variation_name"].strip()
                if db_var == "" or db_var.lower() == "default" or norm_var == "":
                    logger.info(f"[Matching] Fallback 1.1: single blank variation → {all_vars_res.data[0]['variant_id']}")
                    return all_vars_res.data[0]["variant_id"], True, _embed_variant_row(all_vars_res.data[0].get("variants"))

    except Exception as e:
        logger.error(f"[Matching] Stage 1 database error: {e}")

    # Stage 2: intent-based set number + indexed variant lookup (LEGO-specific: set
    # numbers, plaque counts). Skipped for non-LEGO ('generic') shops.
    if is_lego:
        intent = extract_variant_intent(norm_var, listing_title)
        # Variation-derived set number takes priority over the listing title: shared
        # listings (e.g. "Display Stand ... (60367 / 60262)") name multiple sets, and
        # extract_set_number_from_text(listing_title) would otherwise always grab
        # whichever set number appears first, ignoring what the customer actually picked.
        set_num = (
            intent.get("set_number_override") or
            extract_set_number_from_text(norm_var) or
            extract_set_number_from_text(listing_title)
        )
        logger.info(f"[Matching] Stage 2: set_num={set_num} intent={intent}")

        if set_num:
            try:
                q = supabase_client.table("variants")\
                    .select("id, variant_sku, variant_name, variant_type, plaque_count, set_number, products!inner(shop_id)" if shop_id else
                            "id, variant_sku, variant_name, variant_type, plaque_count, set_number")\
                    .eq("set_number", set_num)
                if shop_id:
                    q = q.eq("products.shop_id", shop_id)

                vtype = intent["variant_type"]
                pc    = intent.get("plaque_count")

                if vtype == "DS" and pc is not None:
                    q = q.eq("variant_type", "DS").eq("plaque_count", pc)
                elif vtype == "DS-NP":
                    q = q.eq("variant_type", "DS-NP")
                elif vtype == "FWM":
                    q = q.in_("variant_type", ["FWM", "WM"])
                elif vtype == "WM":
                    q = q.in_("variant_type", ["WM", "FWM"])
                else:
                    q = q.in_("variant_type", ["DS", "BASE"])

                result = q.limit(5).execute()
                rows = result.data or []
                variant = None
                if len(rows) == 1:
                    variant = rows[0]
                elif len(rows) > 1:
                    # WM/FWM intents span both mount types — prefer the exact type asked
                    # for. Any other ambiguity (e.g. DS-1 vs DS-2 with no plaque count in
                    # the variation) means guessing, which would self-heal a wrong mapping
                    # permanently — fall through to the next stage instead.
                    if vtype in ("WM", "FWM"):
                        preferred = [r for r in rows if r.get("variant_type") == vtype]
                        if len(preferred) == 1:
                            variant = preferred[0]
                    if variant is None:
                        logger.info(f"[Matching] Stage 2: set {set_num} {intent} matched {len(rows)} variants — not guessing.")
                if variant:
                    logger.info(f"[Matching] Stage 2 Success: set {set_num} {intent} → '{variant['variant_sku']}'")
                    _self_heal_listing_variation(supabase_client, exact_listing_id, listing_title,
                                                 variant["id"], norm_var, variation_name)
                    return variant["id"], True, {k: variant.get(k) for k in ("variant_sku", "variant_name", "plaque_count", "set_number")}
            except Exception as e:
                logger.error(f"[Matching] Stage 2 database error: {e}")

    # Stage 2.5: F1 Speed Champions special matching (LEGO-specific; skipped for generic shops)
    is_f1 = is_lego and any(k in listing_title.lower() for k in ["f1", "formula 1", "formula one"])
    is_sc  = any(k in listing_title.lower() for k in ["speed champions", "sc"])
    is_vertical = not any(k in listing_title.lower() for k in ["foldable", "skadis", "wall", "flush", "lift"])

    if is_f1 and is_sc and norm_var:
        tier_suffix = get_f1_multi_tier_suffix(norm_var, listing_title)
        if tier_suffix:
            target_sku = f"{sku_prefix}-SC-DS-F1-{tier_suffix}"
            logger.info(f"[Matching] Stage 2.5 F1 multi-tier: '{target_sku}'")
            try:
                res = supabase_client.table("variants").select(f"id, {_VARIANT_COLS}").eq("variant_sku", target_sku).execute()
                if res.data:
                    _self_heal_listing_variation(supabase_client, exact_listing_id, listing_title,
                                                 res.data[0]["id"], norm_var, variation_name)
                    return res.data[0]["id"], True, {k: res.data[0].get(k) for k in ("variant_sku", "variant_name", "plaque_count", "set_number")}
            except Exception as e:
                logger.error(f"[Matching] Stage 2.5 F1 multi-tier database error: {e}")

    if is_f1 and is_sc and is_vertical and norm_var:
        suffix = get_f1_sku_suffix(norm_var)
        if suffix:
            target_sku = f"{sku_prefix}-SC-VDS-F1-{suffix}"
            logger.info(f"[Matching] Stage 2.5 F1 team: '{target_sku}'")
            try:
                res = supabase_client.table("variants").select(f"id, {_VARIANT_COLS}").eq("variant_sku", target_sku).execute()
                if res.data:
                    _self_heal_listing_variation(supabase_client, exact_listing_id, listing_title,
                                                 res.data[0]["id"], norm_var, variation_name)
                    return res.data[0]["id"], True, {k: res.data[0].get(k) for k in ("variant_sku", "variant_name", "plaque_count", "set_number")}
            except Exception as e:
                logger.error(f"[Matching] Stage 2.5 F1 team database error: {e}")

    # Stage 3: fuzzy listing title match
    logger.info(f"[Matching] Stage 3: Fuzzy similarity matching for '{listing_title}'")
    clean_title = re.sub(r'Display Stand for Lego|Display Stand for|Wall Mount for Lego|Wall Mount for|Lego', '',
                         listing_title, flags=re.IGNORECASE).strip()
    words = [w for w in clean_title.split() if len(w) > 2]
    if len(words) >= 2:
        search_pattern = f"%{words[0]}%{words[1]}%"
        try:
            fuzzy_q = supabase_client.table("listings")\
                .select("id, platform_listing_name, products!inner(shop_id)" if shop_id else "id, platform_listing_name")\
                .ilike("platform_listing_name", search_pattern)
            if shop_id:
                fuzzy_q = fuzzy_q.eq("products.shop_id", shop_id)
            fuzzy_listings = fuzzy_q.limit(5).execute()
            if fuzzy_listings.data:
                candidates = fuzzy_listings.data
                # Rank by actual title similarity — Postgres returns ILIKE matches in
                # unspecified order, so data[0] was an arbitrary pick whenever several
                # listings share the same first two words.
                if fuzz and len(candidates) > 1:
                    candidates = sorted(
                        candidates,
                        key=lambda l: fuzz.token_sort_ratio(listing_title, l["platform_listing_name"]),
                        reverse=True)
                best_fuzzy = candidates[0]
                variations = supabase_client.table("listing_variations")\
                    .select(f"variant_id, platform_variation_name, normalized_variation_name, variants({_VARIANT_COLS})")\
                    .eq("listing_id", best_fuzzy["id"]).execute()
                if variations.data:
                    best_var = next((v for v in variations.data if v["normalized_variation_name"] == norm_var), None)
                    if not best_var:
                        best_var = next((v for v in variations.data
                                         if v["platform_variation_name"].lower() == (variation_name or "").strip().lower()), None)
                    if not best_var:
                        best_var = next((v for v in variations.data
                                         if norm_var and (norm_var in v["normalized_variation_name"] or
                                                          v["normalized_variation_name"] in norm_var)), None)
                    if not best_var:
                        is_wm = any(k in norm_var for k in ["wall", "mount", "wm", "fwm"])
                        if is_wm:
                            best_var = next((v for v in variations.data
                                             if any(k in v["platform_variation_name"].lower()
                                                    for k in ["wall", "mount", "wm", "fwm"])), None)
                    if not best_var:
                        logger.warning(f"[Matching] Stage 3: found '{best_fuzzy['platform_listing_name']}' "
                                        f"but no variation matched '{norm_var}'. Not guessing.")
                        return None, False, None
                    return best_var["variant_id"], True, _embed_variant_row(best_var.get("variants"))
        except Exception as e:
            logger.error(f"[Matching] Stage 3 database error: {e}")

    return None, False, None


# Maps new human-readable column names to the internal names used throughout process_catalog.
_COL_ALIASES: dict[str, str] = {
    # Human-readable template names
    "brand name":                   "Brand",
    "category":                     "Catagory",   # intentional — matches internal typo
    "set number":                   "Set Number",
    "product base name":            "Reference Name",
    "variant type":                 "Type",
    "variant sku":                  "SKU",
    "seal sticker url":             "Seal Sticker",
    "print files url":              "Files",
    "pictures url":                 "Pictures",
    "adobe express url":            "Express",
    "print file name":              "File Name",
    "simplyprint file id":          "Simplyprint File ID",
    "print time (min)":             "Print Time",
    "listing title":                "Listing Title",
    "price myr":                    "MY",
    "price sgd":                    "SG",
    "shopee my id":                 "Shopee",
    "shopee sg id":                 "SG.1",
    "shopee ph id":                 "PH",
    "shopee th id":                 "TH",
    "lazada my id":                 "Laz",
    "variation name":               "Variation Name",
    # DB export column names
    "variant_type":                 "Type",
    "variant_sku":                  "SKU",
    "reference_name":               "Reference Name",
    "platform_variation_name":      "Variation Name",
    "platform_listing_name":        "Listing Title",
    "platform_listing_description": "Listing Description",
    # Alternative price/platform column names
    "price my":                     "MY",
    "price sg":                     "SG",
    "shopee my link":               "Shopee",
    "shopee sg link":               "SG.1",
    "shopee th link":               "TH",
    "shopee ph link":               "PH",
    "lazada my link":               "Laz",
}

def _split_catalog_list(val) -> list:
    """Split a pipe- or comma-delimited catalog field into a list of stripped strings."""
    s = str(val).strip() if val is not None else ""
    if not s or s.lower() in ("nan", "none"):
        return []
    sep = "|" if "|" in s else ","
    return [item.strip() for item in s.split(sep) if item.strip()]

def fetch_simplyprint_file_list() -> list:
    """Recursively fetches every file (name + id) in the SimplyPrint file system via the
    API. Returns [] when the API key is missing or the API is unreachable. Replaces the
    old local sp_files.json cache, which is untracked and never shipped to Railway — so
    catalog imports through the backend endpoint silently skipped SP auto-matching."""
    api_key = os.getenv("SIMPLYPRINT_API_KEY")
    if not api_key:
        print("[-] SIMPLYPRINT_API_KEY not set — cannot fetch SimplyPrint file list.")
        return []
    headers = {"X-API-KEY": api_key, "Accept": "application/json", "Content-Type": "application/json"}
    url = f"https://api.simplyprint.io/{SIMPLYPRINT_COMPANY_ID}/files/GetFiles"

    def _fetch_folder(folder_id: int) -> list:
        r = None
        for attempt in range(5):
            r = http_session.post(url, headers=headers, json={"f": folder_id}, timeout=15)
            if r.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            break
        if r is None or r.status_code != 200:
            print(f"[-] SimplyPrint GetFiles failed for folder {folder_id}: "
                  f"HTTP {r.status_code if r is not None else 'n/a'}")
            return []
        data = r.json()
        if not data.get("status"):
            print(f"[-] SimplyPrint GetFiles error for folder {folder_id}: {data.get('message')}")
            return []
        all_files = list(data.get("files", []))
        for sub in data.get("folders", []):
            sub_id = sub.get("id")
            if sub_id is None:
                continue
            time.sleep(0.3)  # stay clear of the API rate limit while recursing
            all_files.extend(_fetch_folder(sub_id))
        return all_files

    try:
        files = _fetch_folder(0)
        print(f"[*] Fetched {len(files)} file(s) from SimplyPrint.")
        return files
    except Exception as e:
        print(f"[-] SimplyPrint file list fetch failed: {e}")
        return []


def run_sync_simplyprint_ids() -> dict:
    """Matches print_files rows to SimplyPrint file IDs by filename (exact, then without
    extension) and backfills simplyprint_file_id. Inlined from scratch/sync_simplyprint_ids.py:
    scratch/ is gitignored, so the old subprocess call failed on every Railway run."""
    sp_files = fetch_simplyprint_file_list()
    if not sp_files:
        raise RuntimeError("No files returned from SimplyPrint — check API key/connectivity.")

    sp_lookup_exact, sp_lookup_base = {}, {}
    for f in sp_files:
        name = (f.get("name") or "").strip()
        fid = f.get("id")
        if name and fid:
            sp_lookup_exact[name.lower()] = fid
            sp_lookup_base[os.path.splitext(name)[0].lower()] = fid

    db_files = fetch_all_rows("print_files", "id, print_file_name, simplyprint_file_id")

    matched = updated = 0
    unmatched = []
    for db_f in db_files:
        db_name = (db_f.get("print_file_name") or "").strip()
        if not db_name:
            continue
        matched_id = sp_lookup_exact.get(db_name.lower()) or \
                     sp_lookup_base.get(os.path.splitext(db_name)[0].lower())
        if matched_id:
            matched += 1
            matched_id_str = str(matched_id)
            if db_f.get("simplyprint_file_id") != matched_id_str:
                supabase.table("print_files").update({"simplyprint_file_id": matched_id_str}).eq("id", db_f["id"]).execute()
                updated += 1
        else:
            unmatched.append(db_name)

    summary = {"sp_files": len(sp_files), "db_files": len(db_files), "matched": matched,
               "updated": updated, "unmatched": len(unmatched)}
    print(f"[+] SimplyPrint ID sync: {summary}")
    if unmatched:
        log_system("warning", f"SimplyPrint ID sync: {len(unmatched)} print file(s) had no matching SimplyPrint file.",
                   {"unmatched_sample": unmatched[:30]}, agent_name="Product Manager")
    return summary


def process_catalog(file_path: str):
    """Processes catalog sheet and upserts it into Supabase."""
    try:
        if file_path.endswith('.csv'):
            df = pd.read_csv(file_path)
            if 'Brand' not in df.columns and len(df) > 0:
                r1 = [str(v).lower() for v in df.iloc[0].values if pd.notna(v)]
                if any('brand' in v for v in r1):
                    df = pd.read_csv(file_path, header=1)
        elif file_path.endswith(('.xls', '.xlsx')):
            df = pd.read_excel(file_path)
            if 'Brand' not in df.columns and len(df) > 0:
                r1 = [str(v).lower() for v in df.iloc[0].values if pd.notna(v)]
                if any('brand' in v for v in r1):
                    df = pd.read_excel(file_path, header=1)
        else:
            raise ValueError("Unsupported file format. Please provide a .csv or .xlsx file.")

        print(f"Processing catalog from {file_path}...")

        # Strip whitespace and required-field markers (* suffix) from column names
        df.columns = [re.sub(r'\s*\*\s*$', '', str(c)).strip() for c in df.columns]
        # Map new human-readable column names to internal names
        col_renames = {c: _COL_ALIASES[c.lower()] for c in df.columns if c.lower() in _COL_ALIASES}
        if col_renames:
            df = df.rename(columns=col_renames)
        # Rename any remaining SKU casing variant
        df = df.rename(columns={col: 'SKU' for col in df.columns if col.lower() == 'sku' and col != 'SKU'})
        # Skip instruction/example row (first data row containing "e.g.")
        if len(df) > 0 and any('e.g.' in str(v).lower() for v in df.iloc[0].values if pd.notna(v)):
            df = df.iloc[1:].reset_index(drop=True)
        df = df[df['Reference Name'].notna() & (df['Reference Name'].astype(str).str.strip() != '')].copy()
        
        resolved_rows = []
        for idx, row in df.iterrows():
            ref_name = str(row.get('Reference Name', '')).strip()
            set_number = clean_set_number(row.get('Set Number'), ref_name)
            
            cat_val = row.get('Catagory')
            if pd.isna(cat_val) or not str(cat_val).strip() or str(cat_val).strip().lower() == 'nan':
                if 'star wars' in file_path.lower() or 'starwars' in file_path.lower():
                    cat_val = "Star Wars"
                else:
                    cat_val = "Other"
                    
            brand_val = row.get('Brand')
            if pd.isna(brand_val) or not str(brand_val).strip() or str(brand_val).strip().lower() == 'nan':
                brand_val = "Blocked Off"

            # Resolve the shop for this row's Brand column (cached lookup — no DB round-trip
            # per row). Falls back to Blocked Off's "BLO" prefix when the brand doesn't match
            # any known shop, preserving legacy behavior for the original single-brand catalog.
            brand_shop = resolve_shop(str(brand_val).strip())
            row_sku_prefix = brand_shop["sku_prefix"] if brand_shop else "BLO"

            v_type = clean_variant_type(row.get('Type'))
            sku_val = row.get('SKU')
            if pd.isna(sku_val) or not str(sku_val).strip() or str(sku_val).strip().lower() == 'nan':
                theme_map = {
                    "star wars": "SWR", "marvel": "MVL", "technic": "TCH",
                    "speed champions": "SC", "icons": "ICN", "ideas": "IDS",
                    "disney": "DNY", "harry potter": "HPR", "fortnite": "FNT",
                    "nintendo": "NTD", "jurassic world": "OTR", "dc": "DC"
                }
                theme_code = theme_map.get(str(cat_val).strip().lower(), str(cat_val).strip()[:3].upper() if cat_val else "OTH")
                sku = f"{row_sku_prefix}-{theme_code}-{set_number}-{v_type}"
            else:
                sku = str(sku_val).strip()
                
            if sku.endswith("-DS-NP"):
                v_type = "DS-NP"
            elif sku.endswith("-WM"):
                v_type = "WM"
            elif sku.endswith("-FWM"):
                v_type = "FWM"
                
            master_sku = derive_master_sku(sku, set_number)
            temp_base = re.sub(r'\s*-\s*(?:DS-NP|DS|WM|FWM)\s*$', '', ref_name, flags=re.IGNORECASE)
            
            resolved_rows.append({
                "row_idx": idx + 2,
                "sku": sku,
                "set_number": set_number,
                "category": cat_val,
                "brand": brand_val,
                "shop_id": brand_shop["id"] if brand_shop else None,
                "v_type": v_type,
                "master_sku": master_sku,
                "reference_name": ref_name,
                "temp_base": temp_base,
                "original_row": row
            })
            
        sku_to_rows = defaultdict(list)
        for r in resolved_rows:
            sku_to_rows[r["sku"]].append(r)
            
        conflicts = {}
        for sku, group in sku_to_rows.items():
            if len(group) > 1:
                first_set = group[0]["set_number"]
                first_base = group[0]["temp_base"]
                has_conflict = False
                for item in group[1:]:
                    if item["set_number"] != first_set or item["temp_base"] != first_base:
                        has_conflict = True
                        break
                if has_conflict:
                    conflicts[sku] = [
                        {
                            "row_index": item["row_idx"],
                            "set_number": item["set_number"],
                            "reference_name": item["reference_name"]
                        } for item in group
                    ]
                    
        if conflicts:
            print("\n" + "!" * 80)
            print("WARNING: AUDIT DETECTED SKU CONFLICTS IN CATALOG!")
            for sku, rows in conflicts.items():
                print(f"\nSKU: '{sku}'")
                for r in rows:
                    print(f" - CSV Row {r['row_index']} | Set Number: {r['set_number']} | Name: '{r['reference_name']}'")
            print("!" * 80 + "\n")
            log_system("warning", f"Catalog audit detected SKU conflicts in {os.path.basename(file_path)}.", {"conflicts": conflicts}, agent_name="Product Manager")

        # SimplyPrint file list for auto-matching: fetch live from the API. The old
        # sp_files.json cache is untracked and never shipped to Railway, so imports through
        # the backend endpoint silently skipped auto-matching; the file now only serves as
        # a local-dev fallback when the API is unreachable.
        sp_files = fetch_simplyprint_file_list()
        if not sp_files:
            sp_files_path = "sp_files.json"
            if os.path.exists(sp_files_path):
                try:
                    with open(sp_files_path, "r") as f:
                        sp_files = json.load(f)
                    print(f"Loaded {len(sp_files)} files from local SimplyPrint cache (API fetch failed).")
                except Exception as e:
                    print(f"Warning: Failed to load SimplyPrint cache: {e}")
                
        parsed_sp = []
        sp_id_lookup = {}
        sp_name_lookup = {}
        for sf in sp_files:
            sf_name = sf.get("name", "")
            sf_id = sf.get("id", "")
            if not sf_name:
                continue
            norm = normalize_filename(sf_name)
            if sf_id:
                sp_id_lookup[norm] = str(sf_id)
            sp_name_lookup[norm] = sf_name
                
            set_match = re.search(r'\b\d{4,5}\b', sf_name)
            sf_set = set_match.group(0) if set_match else None
            
            sf_type = None
            sf_name_lower = sf_name.lower()
            for t in ['ds-np', 'fwm', 'wm', 'plate', 'ds', 'base']:
                pattern = r'(?:\b|[-_])' + re.escape(t) + r'(?:\b|[-_]|\()'
                if re.search(pattern, sf_name_lower):
                    sf_type = t
                    break
                    
            sf_weight = 0
            w_match = re.search(r'\b(\d+)g\b', sf_name_lower)
            if w_match:
                sf_weight = int(w_match.group(1))
                
            sf_time = 0
            time_match = re.search(r'\b(?:(\d+)h)?(?:(\d+)m)\b|\b(\d+)h\b', sf_name_lower)
            if time_match:
                h = time_match.group(1) or time_match.group(3)
                m = time_match.group(2)
                h_val = int(h) if h else 0
                m_val = int(m) if m else 0
                sf_time = h_val * 60 + m_val
                
            parsed_sp.append({
                "name": sf_name, "id": sf_id, "set": sf_set, "type": sf_type, "weight": sf_weight, "time": sf_time
            })

        product_groups = defaultdict(list)
        for r in resolved_rows:
            product_groups[r["master_sku"]].append(r)
            
        for m_sku, group in product_groups.items():
            first_item = group[0]
            product_base_name = first_item["reference_name"]
            product_base_name = re.sub(r'\s*-\s*(?:DS-NP|DS|WM|FWM)\s*$', '', product_base_name, flags=re.IGNORECASE)
            
            product_data = clean_dict({
                "brand_name": first_item["brand"],
                "product_category": first_item["category"],
                "master_sku": m_sku,
                "product_base_name": product_base_name,
                "shop_id": first_item["shop_id"]
            })
            prod_res = supabase.table("products").upsert(product_data, on_conflict="master_sku").execute()
            product_id = prod_res.data[0]["id"]
            
            for item in group:
                item["product_id"] = product_id
                v_type = item["v_type"]
                row_ref = item["reference_name"]
                
                if "Big Technic Car" in row_ref or "Vertical" in row_ref:
                    v_ref_name = row_ref
                else:
                    v_ref_name = f"{product_base_name} - {v_type}"
                    
                item["reference_name"] = v_ref_name
                
                _sku = item["sku"]
                _pc_m = re.search(r'-DS-(\d+)$', _sku)
                _plaque_count = int(_pc_m.group(1)) if _pc_m and v_type == "DS" else None
                variant_data = clean_dict({
                    "product_id": product_id,
                    "variant_sku": _sku,
                    "variant_name": v_ref_name,
                    "reference_name": v_ref_name,
                    "variant_type": v_type,
                    "set_number": item["set_number"] if item.get("set_number") and item["set_number"] != "UNKNOWN" else None,
                    "plaque_count": _plaque_count,
                    "seal_sticker_gdrive_url": item["original_row"].get("Seal Sticker"),
                    "print_files_gdrive_url": item["original_row"].get("Files"),
                    "pictures_gdrive_url": item["original_row"].get("Pictures"),
                    "adobe_express_url": str(item["original_row"].get("Express")) if not pd.isna(item["original_row"].get("Express")) else None
                })
                var_res = supabase.table("variants").upsert(variant_data, on_conflict="variant_sku").execute()
                variant_id = var_res.data[0]["id"]
                item["variant_id"] = variant_id
                
                row = item["original_row"]
                file_names_str = row.get("File Name")
                if file_names_str is None or pd.isna(file_names_str):
                    file_names_str = row.get("Simplyprint File Name")
                file_names_str = str(file_names_str).strip() if pd.notna(file_names_str) else ""
                
                sp_ids_str = row.get("Simplyprint File ID")
                if sp_ids_str is None or pd.isna(sp_ids_str):
                    sp_ids_str = row.get("Simplyprint ID")
                sp_ids_str = str(sp_ids_str).strip() if pd.notna(sp_ids_str) else ""
                
                weights_str = str(row.get("Weight (g)", "")) if pd.notna(row.get("Weight (g)", "")) else ""
                times_str = str(row.get("Print Time", "")) if pd.notna(row.get("Print Time", "")) else ""
                
                is_missing_files = (not file_names_str) or (file_names_str.lower() in ['nan', 'none'])
                
                if is_missing_files and item["set_number"] != "UNKNOWN":
                    matched_files = []
                    target_types = [v_type.lower()]
                    if v_type.lower() == 'ds':
                        target_types.append('plate')
                        
                    for sf in parsed_sp:
                        if sf["set"] == item["set_number"] and sf["type"] in target_types:
                            matched_files.append(sf)
                            
                    if matched_files:
                        file_names = [sf["name"] for sf in matched_files]
                        sp_ids = [str(sf["id"]) for sf in matched_files]
                        weights = [str(sf["weight"]) for sf in matched_files]
                        times = [str(sf["time"]) for sf in matched_files]
                    else:
                        file_names, sp_ids, weights, times = [], [], [], []
                else:
                    file_names = _split_catalog_list(file_names_str)
                    sp_ids     = _split_catalog_list(sp_ids_str)
                    weights    = _split_catalog_list(weights_str)
                    times      = _split_catalog_list(times_str)
                    
                existing_pf_res = supabase.table("print_files").select("id, print_file_name").eq("variant_id", variant_id).execute()
                existing_pfs = existing_pf_res.data if existing_pf_res.data else []
                
                for f_idx, orig_name in enumerate(file_names):
                    weight = weights[f_idx] if f_idx < len(weights) else None
                    # time_val, not time: shadowing the time module here would break any
                    # later time.* call in this scope.
                    time_val = times[f_idx] if f_idx < len(times) else None

                    is_plate = "PLATE" in orig_name.upper()
                    is_weight_blank = (weight is None or str(weight).strip() == "" or str(weight).lower() in ["nan", "none"])
                    is_time_blank = (time_val is None or str(time_val).strip() == "" or str(time_val).lower() in ["nan", "none"])

                    if is_plate:
                        if is_weight_blank:
                            weight = 5
                            is_weight_blank = False
                        if is_time_blank:
                            time_val = 17
                            is_time_blank = False

                    try:
                        clean_weight = int(float(str(weight).strip())) if not is_weight_blank else 0
                    except ValueError:
                        clean_weight = 0

                    try:
                        clean_time = int(float(str(time_val).strip())) if not is_time_blank else 0
                    except ValueError:
                        clean_time = 0
                        
                    target_sp_id = sp_ids[f_idx] if f_idx < len(sp_ids) else None
                    if not target_sp_id or str(target_sp_id).strip().lower() in ['nan', 'none', '']:
                        norm_name = normalize_filename(orig_name)
                        target_sp_id = sp_id_lookup.get(norm_name)
                        if target_sp_id:
                            if is_missing_files:
                                orig_name = sp_name_lookup.get(norm_name, orig_name)
                        else:
                            if item["set_number"] != "UNKNOWN":
                                file_type = "plate" if "plate" in orig_name.lower() else item["v_type"].lower()
                                matched_cache = [sf for sf in parsed_sp if sf["set"] == item["set_number"] and sf["type"] == file_type]
                                if matched_cache:
                                    target_sp_id = str(matched_cache[0]["id"])
                                    if is_missing_files:
                                        orig_name = matched_cache[0]["name"]
                    
                    pf_data = {
                        "variant_id": variant_id,
                        "variant_sku": item["sku"],
                        "print_file_name": orig_name,
                        "reference_name": f"{v_ref_name} ({'Plate' if is_plate else 'Main'})",
                        "simplyprint_file_id": target_sp_id,
                        "weight_g": clean_weight,
                        "print_time_m": clean_time
                    }
                    
                    if f_idx < len(existing_pfs):
                        supabase.table("print_files").update(pf_data).eq("id", existing_pfs[f_idx]["id"]).execute()
                    else:
                        supabase.table("print_files").insert(pf_data).execute()
                        
                if len(existing_pfs) > len(file_names):
                    for extra_pf in existing_pfs[len(file_names):]:
                        try:
                            supabase.table("print_files").delete().eq("id", extra_pf["id"]).execute()
                        except Exception as delete_err:
                            log_system("warning", f"Could not delete old print file {extra_pf['id']} due to constraint: {delete_err}", agent_name="Product Manager")
                    
        # Bridge variations mapping globally across all master products
        listing_groups = defaultdict(list)
        for item in resolved_rows:
            listing_title = item["original_row"].get("Listing Title")
            if pd.isna(listing_title) or not str(listing_title).strip():
                continue
            listing_groups[str(listing_title).strip()].append(item)
            
        for raw_listing_title, l_group in listing_groups.items():
            l_first = l_group[0]["original_row"]
            
            shopee_my_col = "Shopee" if "Shopee" in df.columns else ("My" if "My" in df.columns else None)
            shopee_sg_col = "SG.1" if "SG.1" in df.columns else None
            shopee_ph_col = "PH" if "PH" in df.columns else None
            shopee_th_col = "TH" if "TH" in df.columns else None
            lazada_my_col = "Laz" if "Laz" in df.columns else ("My.1" if "My.1" in df.columns else None)
            
            # Map listing to the product_id of its first associated variant
            listing_product_id = l_group[0]["product_id"]
            
            listing_data = clean_dict({
                "product_id": listing_product_id,
                "platform_listing_name": raw_listing_title,
                "platform_listing_description": l_first.get("Listing Description"),
                "price_myr": l_first.get("MY"),
                "price_sgd": l_first.get("SG"),
                "shopee_my": l_first.get(shopee_my_col) if shopee_my_col else None,
                "shopee_sg": l_first.get(shopee_sg_col) if shopee_sg_col else None,
                "shopee_ph": l_first.get(shopee_ph_col) if shopee_ph_col else None,
                "shopee_th": l_first.get(shopee_th_col) if shopee_th_col else None,
                "lazada_my": l_first.get(lazada_my_col) if lazada_my_col else None
            })
            list_res = supabase.table("listings").upsert(listing_data, on_conflict="platform_listing_name").execute()
            listing_id = list_res.data[0]["id"]
            
            for l_item in l_group:
                l_row = l_item["original_row"]
                variant_id = l_item["variant_id"]
                
                v_name_raw = l_row.get("Variation Name")
                if v_name_raw is None or pd.isna(v_name_raw):
                    v_name_raw = l_row.get("Listing Variation Name")
                    
                platform_variation = str(v_name_raw).strip() if pd.notna(v_name_raw) and str(v_name_raw).strip() else ""
                
                if l_item["v_type"] == "WM":
                    ref_name = f"{raw_listing_title} [{platform_variation}]" if platform_variation else raw_listing_title
                else:
                    ref_name = f"{raw_listing_title} [{platform_variation if platform_variation else 'Base'}]"
                    
                bridge_data = clean_dict({
                    "listing_id": listing_id,
                    "variant_id": variant_id,
                    "platform_variation_name": platform_variation,
                    # Stage 1 matching keys on normalized_variation_name — without it
                    # the column defaults to '' and every imported variation falls
                    # through to fuzzy fallbacks forever
                    "normalized_variation_name": normalize_variation(platform_variation),
                    "match_source": "catalog",
                    "reference_name": ref_name
                })
                supabase.table("listing_variations").upsert(bridge_data, on_conflict="listing_id, platform_variation_name").execute()
                    
        log_system("info", f"Successfully ingested catalog from {os.path.basename(file_path)}.", agent_name="Product Manager")
    except Exception as e:
        error_trace = traceback.format_exc()
        log_system("error", f"Ingestion failed: {str(e)}", {"traceback": error_trace}, agent_name="Product Manager")
        print(error_trace)
        raise RuntimeError(f"Catalog ingestion failed: {e}") from e


# ----------------- SECTION 2: Archivist Logic -----------------

def fetch_master_truth():
    """Fetches full products catalog metadata from Supabase for reorganization.
    Paginated via fetch_all_rows — variants already exceeds the Supabase server-side
    max-rows cap, and a plain .select('*') silently truncates at that cap."""
    print("Fetching master truth from Supabase...")

    products = fetch_all_rows('products')
    products_dict = {p['id']: p for p in products}

    variants = fetch_all_rows('variants')
    variants_dict = {v['id']: v for v in variants}

    print_files = fetch_all_rows('print_files')
    
    match_map = {}
    set_num_map = {}
    
    for p in products:
        p_info = {'type': 'product', 'product': p}
        match_map[p['product_base_name']] = p_info
        match_map[p['master_sku']] = p_info
        parts = p['master_sku'].split('-')
        if len(parts) >= 3:
            set_num = parts[2]
            set_num_map[set_num] = p['id']
            if set_num not in match_map:
                match_map[set_num] = p_info

    for v in variants:
        p = products_dict.get(v['product_id'])
        if not p: continue
        v_info = {'type': 'variant', 'variant': v, 'product': p}
        match_map[v['variant_sku']] = v_info
        
    for pf in print_files:
        v = variants_dict.get(pf['variant_id'])
        if not v: continue
        p = products_dict.get(v['product_id'])
        if not p: continue
        
        pf_info = {'type': 'file', 'file': pf, 'variant': v, 'product': p}
        match_map[pf['print_file_name']] = pf_info

    print(f"Loaded {len(products)} products, {len(variants)} variants, and {len(print_files)} print file records.")
    return match_map, set_num_map

def get_best_match_with_boost(query, targets, match_map):
    """Evaluates the best fuzzy text match applying set keyword boosts."""
    if not targets: return None, 0
    results = []
    query_upper = query.upper()
    keywords = ['PLATE', 'WM', 'DS', 'NP']
    query_keywords = [k for k in keywords if k in query_upper]
    
    for target in targets:
        if fuzz:
            base_score = fuzz.token_sort_ratio(query, target)
        else:
            base_score = 50 # simple fallback
            
        target_upper = target.upper()
        boost = 0
        
        for k in keywords:
            if k in query_keywords and k in target_upper:
                boost += 15
            elif k in keywords and k in target_upper and k not in query_keywords:
                boost -= 20
        
        final_score = base_score + boost
        results.append((target, final_score))
    
    if not results: return None, 0
    best_target, best_score = max(results, key=lambda x: x[1])
    return best_target, best_score

def scan_and_reorganize(source_dir, dest_dir, match_map, set_num_map):
    """Walks directory, matches print files against Supabase, and copies/renames."""
    source_path = Path(source_dir)
    dest_path = Path(dest_dir)
    
    matched_print_files = set()
    generic_orphans = []
    valid_extensions = {'.gcode', '.3mf', '.stl'}
    
    print(f"\nScanning source directory: {source_dir}")
    
    for root, _, files in os.walk(source_path):
        for file in files:
            file_path = Path(root) / file
            if file.startswith('.'): continue
            if file_path.suffix.lower() not in valid_extensions: continue
            
            file_name = file_path.name
            set_num_match = re.search(r'\b(7\d{4}|6\d{4}|1\d{4}|5\d{4})\b', file_name)
            detected_set_num = set_num_match.group(1) if set_num_match else None
            
            if detected_set_num and detected_set_num in set_num_map:
                target_product_id = set_num_map[detected_set_num]
                filtered_targets = [k for k, v in match_map.items() if v['product']['id'] == target_product_id]
            else:
                filtered_targets = list(match_map.keys())
            
            file_targets = [k for k in filtered_targets if match_map[k]['type'] == 'file']
            best_key, best_score = get_best_match_with_boost(file_name, file_targets, match_map)
            
            if best_score < 75:
                best_match_gen, gen_score = get_best_match_with_boost(file_name, filtered_targets, match_map)
                if gen_score > best_score:
                    best_score = gen_score
                    best_key = best_match_gen
            
            threshold = 85 if not detected_set_num else 70
            
            if best_score >= threshold:
                match_info = match_map[best_key]
                product = match_info['product']
                product_folder = product['product_base_name']
                
                is_gcode = '.gcode' in file_name.lower() or file_path.suffix.lower() == '.gcode'
                is_3mf = file_path.suffix.lower() == '.3mf'
                
                def get_clean_prefix(name):
                    if " - " in name:
                        parts = name.rsplit(" - ", 1)
                        return f"{parts[0].strip()}-{parts[1].strip()}"
                    return name
                clean_prefix = get_clean_prefix(product_folder)
                
                if is_gcode:
                    target_subfolder = f"{clean_prefix} - GCODE"
                    if match_info['type'] == 'file':
                        final_name = match_info['file']['print_file_name']
                        if file_name.lower().endswith('.gcode.3mf') and not final_name.lower().endswith('.3mf'):
                            final_name += '.3mf'
                        matched_print_files.add(match_info['file']['print_file_name'])
                    else:
                        final_name = file_name
                elif is_3mf:
                    project_keywords = ['DS', 'WM', 'PLATE', 'DISPLAY', 'MOUNT', 'NP']
                    is_project = any(k in file_name.upper() for k in project_keywords) or (detected_set_num and detected_set_num in product['master_sku'])
                    
                    if is_project:
                        target_subfolder = ""
                        if match_info['type'] == 'file':
                            db_name = match_info['file']['print_file_name']
                            final_name = Path(db_name).with_suffix('.3mf').name
                            matched_print_files.add(db_name)
                        else:
                            final_name = file_name
                    else:
                        target_subfolder = f"{clean_prefix} - RF"
                        final_name = file_name
                else:
                    target_subfolder = f"{clean_prefix} - RF"
                    final_name = file_name
                
                target_dir = dest_path / product_folder / target_subfolder
                target_dir.mkdir(parents=True, exist_ok=True)
                target_file_path = target_dir / final_name
                
                print(f"Organizing: '{file_name}' -> '{target_file_path.relative_to(dest_path)}' (Match: '{best_key}', Score: {best_score})")
                shutil.copy2(file_path, target_file_path)
            else:
                generic_orphans.append(str(file_path))
                print(f"Orphan: No match for '{file_name}' (Best score: {best_score})")

    print("\n" + "="*50)
    print("AUDIT REPORT (Reference Structure)")
    print("="*50)
    all_expected = [pf['print_file_name'] for pf in fetch_all_rows('print_files', 'print_file_name')]
    missing = set(all_expected) - matched_print_files
    print(f"Total Master Files Organized: {len(matched_print_files)} / {len(all_expected)}")
    print(f"Generic Orphans:              {len(generic_orphans)}")
    if missing:
        print("\n--- MISSING FROM LOCAL DRIVE ---")
        for m in sorted(missing): print(f" - {m}")
    print("\nDone.")


# ----------------- SECTION 3: Scout Gmail Ingestion Agent -----------------

class TransientLLMError(Exception):
    """Raised when every Gemini model in the fallback chain is temporarily unavailable
    (timeout / 503 / 429). The caller must leave the email unread so it is retried on the
    next scan (webhook push or the periodic backstop) rather than being marked processed."""
    pass


class OrderHeldForReview(Exception):
    """Raised by process_order() when the order row WAS created but needs manual review
    (matching failure or an incomplete item-insert) — i.e. a deliberate hold, not a crash.
    The source email is still safe to mark processed: the order exists in the DB (as
    'hold') and re-running the scan would just re-parse the same email without changing
    the outcome. Distinct from a bare Exception, which signals an unexpected failure where
    we do NOT know the order was safely recorded, so the email must be left unread/retried."""
    pass


# ----------------- Extraction coverage verification -----------------
# The LLM's item list is never trusted on its own: every extracted item must
# quote its verbatim source text ("receipt"), and independent signals from the
# email (stated item count, per-line prices vs order subtotal, leftover price
# lines) must corroborate that the WHOLE email was ingested. Any hold-level
# failure inserts the order as 'hold' (Foreman only dispatches pending/printing
# orders) with a hold_reason, and fires a warning log → Discord.

# Price token: currency indicator adjacent to an amount (matches _detect_currency's codes).
_ITEM_PRICE_RE = re.compile(
    r'(?:MYR|SGD|THB|PHP|IDR|VND|TWD|NT\$|S\$|RM|PhP|Rp|฿|₱|₫|đ)\s*\d[\d,.]*', re.I)
# Residual lines carrying a price are expected when labeled as totals/fees/vouchers
# (EN + MY/ID labels); anything else priced that survives snippet removal is an
# item line no extracted item accounted for.
_NON_ITEM_PRICE_LABELS = (
    'subtotal', 'sub-total', 'total', 'shipping', 'delivery', 'postage', 'fee',
    'voucher', 'discount', 'rebate', 'tax', 'sst', 'vat', 'cod', 'payment',
    'refund', 'coin', 'cashback', 'jumlah', 'penghantaran', 'baucar', 'diskaun',
)


def _snippet_regex(snippet: str) -> re.Pattern:
    """Whitespace-flexible verbatim matcher: the LLM copies text, but HTML→text
    conversion means runs of spaces/newlines may differ between its quote and
    our cleaned body."""
    parts = [re.escape(p) for p in snippet.split()]
    return re.compile(r'\s+'.join(parts), re.IGNORECASE)


def verify_extraction_coverage(order_details: "OrderDetails", cleaned_body: Optional[str]) -> tuple[list[str], list[str]]:
    """Cross-checks the LLM's extraction against the email it came from.
    Returns (hold_problems, warn_problems). hold_problems block dispatch;
    warn_problems only alert. cleaned_body may be None (manual ingestion) —
    body-dependent checks are skipped then."""
    hold: list[str] = []
    warn: list[str] = []
    items = order_details.items or []

    # 1) Stated item count vs extracted count — the email's own number wins.
    stated = order_details.stated_item_count
    if stated is not None and stated > 0 and stated != len(items):
        hold.append(f"Email states {stated} item(s) but only {len(items)} were extracted.")

    # 2) Line-price checksum vs order subtotal. Shopee shows unit prices next to a
    # 'xN' quantity, so accept either interpretation (unit×qty or line total) —
    # only hold when even the larger sum falls far short of the subtotal, which
    # is the signature of a whole missing line. Overage is a voucher/discount.
    subtotal = order_details.order_subtotal or 0
    prices = [it.item_subtotal for it in items]
    if subtotal > 0 and prices and all(p is not None and p > 0 for p in prices):
        sum_flat = sum(prices)
        sum_qty = sum(p * max(it.purchased_quantity, 1) for p, it in zip(prices, items))
        best = max(sum_flat, sum_qty)
        shortfall = (subtotal - best) / subtotal
        if shortfall > 0.20:
            hold.append(f"Extracted line prices sum to {best:.2f} but order subtotal is "
                        f"{subtotal:.2f} — {shortfall:.0%} unaccounted for (missing item?).")
        elif shortfall > 0.02:
            warn.append(f"Line prices sum to {best:.2f} vs subtotal {subtotal:.2f} "
                        f"({shortfall:.0%} short) — verify nothing is missing.")

    if not cleaned_body:
        return hold, warn

    body_norm = re.sub(r'[ \t]+', ' ', cleaned_body)
    residual = body_norm

    # 3) Receipts: every item must have quoted verbatim source text that actually
    # occurs in the email. No receipt / unfindable receipt → can't prove the item
    # came from this email → hold.
    for it in items:
        snip = (it.source_snippet or '').strip()
        label = f"'{it.listing_title}'" + (f" ({it.variation_name})" if it.variation_name else "")
        if not snip:
            hold.append(f"Item {label} has no source snippet — cannot verify it against the email.")
            continue
        pat = _snippet_regex(snip)
        m = pat.search(residual)
        if m:
            residual = residual[:m.start()] + ' ' + residual[m.end():]
        elif not pat.search(body_norm):
            hold.append(f"Item {label} quotes text that does not appear in the email — possible misread.")
        # else: snippet exists but its region was already claimed by an identical
        # earlier snippet (true duplicate lines) — count/checksum checks still guard.

    # 4) Coverage: after deleting every verified receipt, any surviving line that
    # still carries a price and isn't a known total/fee/voucher line is email
    # content no extracted item claimed. Warn-level: line-splitting of HTML email
    # bodies is too template-dependent to hard-block on.
    for line in residual.splitlines():
        if not _ITEM_PRICE_RE.search(line):
            continue
        low = line.lower()
        if any(lbl in low for lbl in _NON_ITEM_PRICE_LABELS):
            continue
        warn.append(f"Unclaimed price line in email not covered by any extracted item: "
                    f"'{line.strip()[:120]}'")

    return hold, warn


class ScoutAgent:
    def __init__(self):
        self.agent_name = "Scout"
        self._lock_file = None
        self._held_thread_lock = False

        # Initialize clients referencing globals. Gmail auth is lazy (see gmail_service):
        # several endpoints (/scout/ingest-order, /scout/reparse-email, /scout/ingest-email)
        # construct a ScoutAgent for parsing/matching only, and a Gmail token hiccup must
        # not take those Gmail-independent paths down with it.
        self.supabase = supabase
        self.ai_client = ai_client
        self._gmail_service = None

    @property
    def gmail_service(self):
        if self._gmail_service is None:
            self._gmail_service = self._authenticate_gmail()
        return self._gmail_service

    def _log_gemini_usage(self, model_name: str, response):
        log_gemini_usage(self.agent_name, model_name, response)

    def _acquire_lock(self) -> bool:
        """Acquires an exclusive lock. Returns False if already locked. Uses fcntl file lock
        when available (cross-process), falls back to threading.Lock (in-process only)."""
        lock_path = "scout.lock"
        try:
            self._lock_file = open(lock_path, "w")
            if fcntl:
                try:
                    fcntl.flock(self._lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    logger.info("Acquired file lock.")
                    return True
                except (IOError, BlockingIOError):
                    logger.warning("Scout agent lock already held by another thread or process.")
                    return False
            else:
                if not _scout_thread_lock.acquire(blocking=False):
                    logger.warning("Scout agent lock already held by another thread (in-process).")
                    return False
                self._held_thread_lock = True
                return True
        except Exception as e:
            # Fail CLOSED: if we can't even create/open the lock file, we cannot guarantee
            # exclusivity, so treat this as "lock not acquired" rather than proceeding as if
            # it were — the previous `return True` here gave false confidence of exclusivity
            # and could let two Scout runs execute concurrently.
            logger.error(f"Failed to create lock file: {e}")
            return False

    def _authenticate_gmail(self):
        """Returns the (module-level cached) Gmail API service object. See
        _get_google_creds() — repeated ScoutAgent() instantiations reuse the same
        service instead of rebuilding it on every webhook push / poll cycle."""
        global _gmail_service_cache
        creds = _get_google_creds()
        if _gmail_service_cache is not None:
            return _gmail_service_cache
        try:
            service = build('gmail', 'v1', credentials=creds)
            _gmail_service_cache = service
            return service
        except HttpError as error:
            logger.error(f"An error occurred during Gmail API authentication: {error}")
            raise

    def log_to_db(self, level: str, message: str, details: Optional[dict] = None):
        log_system(level, message, details, agent_name=self.agent_name)

    def start_watch(self) -> Optional[dict]:
        """Registers a Gmail push-notification watch on the INBOX against the configured
        Pub/Sub topic. Gmail then publishes a message to the topic whenever the inbox
        changes, which Pub/Sub pushes to /gmail/notifications. Must be renewed before the
        ~7-day expiry. Returns the watch response ({historyId, expiration}) or None."""
        if not GMAIL_PUBSUB_TOPIC:
            logger.warning("start_watch called but GMAIL_PUBSUB_TOPIC is not set — skipping.")
            return None
        try:
            resp = self.gmail_service.users().watch(userId='me', body={
                'topicName': GMAIL_PUBSUB_TOPIC,
                'labelIds': ['INBOX'],
                'labelFilterAction': 'include',
            }).execute()
            exp_ms = int(resp.get('expiration', 0))
            exp_str = datetime.fromtimestamp(exp_ms / 1000).isoformat() if exp_ms else 'unknown'
            logger.info(f"Gmail watch registered on topic {GMAIL_PUBSUB_TOPIC}. "
                        f"historyId={resp.get('historyId')} expires={exp_str}")
            return resp
        except HttpError as error:
            logger.error(f"Failed to register Gmail watch: {error}")
            return None

    def _get_or_create_label(self, name: str) -> str:
        """Returns the Gmail label ID for `name`, creating it if it doesn't exist.
        Cached at module level: mark_email_as_read calls this for every processed email,
        and an uncached labels().list() round-trip per email dominated scan time."""
        cached = _gmail_label_cache.get(name.lower())
        if cached:
            return cached
        existing = self.gmail_service.users().labels().list(userId='me').execute().get('labels', [])
        for lbl in existing:
            if lbl['name'].lower() == name.lower():
                _gmail_label_cache[name.lower()] = lbl['id']
                return lbl['id']
        created = self.gmail_service.users().labels().create(userId='me', body={'name': name}).execute()
        logger.info(f"Created Gmail label '{name}' (id={created['id']})")
        _gmail_label_cache[name.lower()] = created['id']
        return created['id']

    # Subjects that clearly mark a NON-order email (marketing, logistics, account notices) —
    # safe to skip without an LLM call.
    _NON_ORDER_SUBJECT_RE = re.compile(
        r'(?i)\b('
        r'voucher|flash\s*sale|\d+\s*%|%\s*off|discount|promo(tion)?|deal|cashback|'
        r'coins?|reward|rate\s+your|review\s+your|leave\s+(a\s+)?feedback|'
        r'has\s+been\s+delivered|out\s+for\s+delivery|on\s+(its|the)\s+way|'
        r'in\s+transit|tracking|parcel|picked\s*up|pick\s*up|drop\s*off|'
        r'refund|payment\s+received|payout|withdraw|wallet|statement|'
        r'newsletter|subscribe|welcome|verify|password|security|otp'
        r')\b'
    )
    # Subjects that clearly mark an ORDER — always parse, regardless of other signals.
    _ORDER_SUBJECT_RE = re.compile(
        r'(?i)('
        r'^cod\s+order|'
        r'time\s+to\s+ship|new\s+order|order\s+confirmation|order\s+placed|to\s+ship|'
        r'you\s+(have|\'?ve)\s+(got\s+)?a?\s*new\s+order|new\s+sale|made\s+a\s+sale|'
        r'pesanan\s+bahar?u|ada\s+pesanan'
        r')'
    )

    def _is_probable_order(self, subject: str, sender: str) -> bool:
        """Cheap pre-LLM gate on subject/sender. Returns False only for emails that clearly
        are NOT orders (marketing, logistics, account notices) so they can be skipped without
        paying for a Gemini call. Anything ambiguous returns True — the LLM + is_order_email
        flag remain the safety net, so the gate never drops a genuine order."""
        subj = subject or ''
        if self._ORDER_SUBJECT_RE.search(subj):
            return True
        if self._NON_ORDER_SUBJECT_RE.search(subj):
            return False
        return True

    def fetch_unread_order_emails(self):
        """Fetches unprocessed order emails from Shopee/Lazada (last 14 days, not yet labelled
        orbot-processed). Uses a metadata-first pass so obvious non-order emails (marketing,
        logistics) are labelled and skipped without fetching the full body or calling Gemini;
        only probable-order candidates are returned with their full body."""
        try:
            # Include subject-based fallback in case Shopee/Lazada route emails via third-party domains
            query = '(from:shopee OR from:lazada OR subject:"time to ship" OR subject:"new order" OR subject:"Order Confirmation" OR subject:"COD order") newer_than:14d -label:orbot-processed'
            logger.info(f"Scout Gmail query: {query}")

            # 1) List every matching id, following pagination so a backlog >100 isn't truncated.
            messages = []
            page_token = None
            while True:
                results = self.gmail_service.users().messages().list(
                    userId='me', q=query, pageToken=page_token, maxResults=100
                ).execute()
                messages.extend(results.get('messages', []))
                page_token = results.get('nextPageToken')
                if not page_token:
                    break
            logger.info(f"Scout Gmail query returned {len(messages)} message(s).")

            email_contents = []
            for message in messages:
                # 2) Metadata-only fetch — enough to run the pre-LLM gate without pulling the body.
                meta = self.gmail_service.users().messages().get(
                    userId='me', id=message['id'], format='metadata',
                    metadataHeaders=['Subject', 'From', 'Date']
                ).execute()
                headers = {h['name'].lower(): h['value'] for h in meta.get('payload', {}).get('headers', [])}
                subject = headers.get('subject', 'No Subject')
                sender  = headers.get('from', '')
                date    = headers.get('date', '')

                if not self._is_probable_order(subject, sender):
                    logger.info(f"Scout skipping non-order email without LLM: subject='{subject}' from='{sender}'")
                    self.mark_email_as_read(message['id'])
                    continue

                # 3) Survivor — fetch the full body for LLM parsing.
                msg = self.gmail_service.users().messages().get(userId='me', id=message['id'], format='full').execute()
                body_content = self._extract_email_body(msg['payload'])
                logger.info(f"Scout found order candidate: subject='{subject}' from='{sender}'")

                email_contents.append({
                    'id': message['id'],
                    'subject': subject,
                    'sender': sender,
                    'date': date,
                    'body': body_content
                })
            return email_contents
        except HttpError as error:
            logger.error(f"An error occurred fetching emails: {error}")
            return []

    def _extract_email_body(self, payload):
        """Extract email body, preferring text/plain, falling back to stripped text/html."""
        plain, html = self._collect_parts(payload)
        if plain:
            return plain
        if html:
            # Strip HTML tags to get readable text for the LLM
            text = re.sub(r'<style[^>]*>.*?</style>', ' ', html, flags=re.DOTALL | re.IGNORECASE)
            text = re.sub(r'<script[^>]*>.*?</script>', ' ', text, flags=re.DOTALL | re.IGNORECASE)
            text = re.sub(r'<[^>]+>', ' ', text)
            text = html_module.unescape(text)
            text = re.sub(r'[ \t]+', ' ', text)
            text = re.sub(r'\n{3,}', '\n\n', text)
            return text.strip()
        return ""

    def _collect_parts(self, payload):
        """Recursively collect text/plain and text/html content from MIME parts."""
        plain, html = "", ""
        if 'parts' in payload:
            for part in payload['parts']:
                p, h = self._collect_parts(part)
                plain = plain or p
                html = html or h
        else:
            mime = payload.get('mimeType', '')
            data = payload.get('body', {}).get('data')
            if data:
                text = base64.urlsafe_b64decode(data).decode('utf-8', errors='replace')
                if mime == 'text/plain':
                    plain = text
                elif mime == 'text/html':
                    html = text
        return plain, html

    def mark_email_as_read(self, message_id):
        try:
            label_id = self._get_or_create_label('orbot-processed')
            self.gmail_service.users().messages().modify(
                userId='me',
                id=message_id,
                body={'addLabelIds': [label_id], 'removeLabelIds': ['UNREAD']}
            ).execute()
            logger.info(f"Marked email {message_id} as orbot-processed.")
        except HttpError as error:
            logger.error(f"An error occurred marking email as read: {error}")

    def _store_ingested_email(self, email: dict, cleaned_body: str) -> Optional[str]:
        """Persists the email verbatim BEFORE any parsing — the lossless-ingestion
        guarantee. Upserts on gmail_message_id (retried emails reuse their row).
        Never raises: capture failing must not stop order processing, it just
        loses the audit copy for this one email."""
        try:
            received_at = None
            if email.get('date'):
                try:
                    received_at = parsedate_to_datetime(email['date']).isoformat()
                except Exception:
                    pass
            res = self.supabase.table("ingested_emails").upsert({
                "gmail_message_id": email['id'],
                "subject": email.get('subject'),
                "sender": email.get('sender'),
                "received_at": received_at,
                "raw_body": email.get('body') or '',
                "cleaned_body": cleaned_body,
                "parse_status": "pending",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }, on_conflict="gmail_message_id").execute()
            return res.data[0]['id'] if res.data else None
        except Exception as e:
            logger.error(f"Failed to store ingested email {email.get('id')}: {e}")
            self.log_to_db("error", f"Failed to store raw email copy (gmail id {email.get('id')}) — "
                                     f"order will still be processed but without the audit copy: {e}")
            return None

    def _update_ingested_email(self, row_id: Optional[str], fields: dict):
        """Best-effort status update on an ingested_emails row (no-op if capture failed)."""
        if not row_id:
            return
        try:
            fields = {**fields, "updated_at": datetime.now(timezone.utc).isoformat()}
            self.supabase.table("ingested_emails").update(fields).eq("id", row_id).execute()
        except Exception as e:
            logger.error(f"Failed to update ingested_emails {row_id}: {e}")

    def _clean_text_for_llm(self, text: str) -> str:
        text = re.sub(r'http[s]?://\S+', '[URL]', text)
        # Cut at common footer markers
        for marker in [
            r'(?i)this is an (?:auto-generated|automatically generated) email',
            r'(?i)download (?:shopee|lazada)?\s*app',
            r'(?i)need help\??',
            r'(?i)copyright\s*©',
            r'(?i)privacy policy|terms of service',
            r'(?i)you are receiving this email',
            r'(?i)unsubscribe',
            r'(?i)follow us on',
            r'(?i)customer service hotline',
        ]:
            text = re.split(marker, text)[0]
        text = re.sub(r'\n{3,}', '\n\n', text)
        # Generous cap — a truncated email is a silently lost order item (order
        # 2607071JS7VYVW lost its 2nd item to the old 1500-char cap). Multi-item
        # Shopee emails run several thousand chars; 20k covers any realistic order
        # while still bounding pathological bodies.
        return text.strip()[:20000]

    def _regex_preparse(self, subject: str, sender: str, date_header: str, body: str) -> dict:
        """Extract fields that don't need LLM — platform, order ID, timestamp."""
        result = {}

        # Platform from sender address
        s = sender.lower()
        if 'shopee' in s:
            result['sales_platform'] = 'Shopee'
        elif 'lazada' in s:
            result['sales_platform'] = 'Lazada'

        # Order ID: Shopee's real order ID is alphanumeric (YYMMDD + 8 alnum chars),
        # e.g. "2607072M1VWU29". Forwarded Shopee emails also contain a *different*
        # purely-numeric internal order reference inside redirect-link URLs (e.g.
        # .../seller.shopee.ph/.../order/237090258205769?utm_content=...) — strip URLs
        # first and prefer the alnum pattern, or a bare digit run gets misread as the
        # order ID (see order 2607072M1VWU29, wrongly ingested as 237090258205769).
        url_stripped_body = re.sub(r'http[s]?://\S+', '[URL]', body[:600])
        for text in [subject, url_stripped_body]:
            order_id = extract_shopee_order_id(text)
            if order_id:
                result['platform_order_id'] = order_id
                break
        # 14-20 digit numeric string fallback — Lazada's format, or any Shopee variant
        # that doesn't match the alnum pattern above.
        if 'platform_order_id' not in result:
            for text in [subject, url_stripped_body]:
                m = re.search(r'#?(\d{14,20})', text)
                if m:
                    result['platform_order_id'] = m.group(1)
                    break
        # Lazada shorter alphanumeric format e.g. 102xxxxxxx
        if 'platform_order_id' not in result:
            m = re.search(r'(?:order\s*(?:id|no|number|#)\s*[:\-]?\s*)([A-Z0-9]{8,20})', subject, re.I)
            if m:
                result['platform_order_id'] = m.group(1).lstrip('#')

        # Timestamp from email Date header (avoids asking Gemini to guess it)
        if date_header:
            try:
                dt = parsedate_to_datetime(date_header)
                result['order_timestamp'] = dt.isoformat()
            except Exception:
                pass

        # Currency hint — detect across SEA Shopee markets from symbols/codes in the body.
        # Only set when a clear signal is found; otherwise leave unset so the LLM (or the
        # OrderDetails MYR default) decides. Order matters: multi-char symbols first so
        # 'S$'/'NT$' aren't swallowed by a bare '$'.
        cur = self._detect_currency(body)
        if cur:
            result['order_currency'] = cur

        return result

    # ISO code first (unambiguous), then currency symbols. NT$/S$/RM checked before bare '$'.
    _CURRENCY_CODES = ('MYR', 'SGD', 'THB', 'PHP', 'IDR', 'VND', 'TWD')
    _CURRENCY_SYMBOLS = (
        ('NT$', 'TWD'), ('S$', 'SGD'), ('RM', 'MYR'), ('₱', 'PHP'), ('PhP', 'PHP'),
        ('฿', 'THB'), ('บาท', 'THB'), ('Rp', 'IDR'), ('₫', 'VND'), ('đ', 'VND'),
    )

    def _detect_currency(self, body: str) -> Optional[str]:
        """Detect the order currency from an email body. Returns an ISO code or None."""
        window = (body or "")[:1500]
        # Explicit ISO code beats everything (e.g. "Subtotal: THB 1,200").
        for code in self._CURRENCY_CODES:
            if re.search(rf'\b{code}\b', window, re.I):
                return code
        # Fall back to currency symbols; require an adjacent amount so substrings like
        # 'rm' in 'warm' don't false-trigger. Most-specific symbols are checked first.
        for sym, code in self._CURRENCY_SYMBOLS:
            pat = re.escape(sym)
            if re.search(rf'{pat}\s*[\d]', window, re.I) or re.search(rf'[\d]\s*{pat}', window, re.I):
                return code
        return None

    def parse_email_with_llm(self, email_body: str, subject: str = '', sender: str = '', date_header: str = '') -> Optional[OrderDetails]:
        prefilled = self._regex_preparse(subject, sender, date_header, email_body)
        cleaned_body = self._clean_text_for_llm(email_body)

        # Build a tighter prompt that skips fields we already know
        known = []
        if prefilled.get('platform_order_id'):
            known.append(f"Order ID: {prefilled['platform_order_id']}")
        if prefilled.get('sales_platform'):
            known.append(f"Platform: {prefilled['sales_platform']}")
        if prefilled.get('order_timestamp'):
            known.append(f"Timestamp: {prefilled['order_timestamp']}")
        known_str = ('Known fields (use these, do not re-extract):\n' + '\n'.join(known) + '\n\n') if known else ''
        prompt = (
            f"{known_str}"
            f"Extract structured order details from this marketplace email.\n"
            f"CRITICAL for items: Extract EVERY product listed — Shopee/Lazada emails often list 2 or more items "
            f"separated by line breaks, numbers, or table rows. Each distinct product listing must be its own "
            f"entry in the items list. Do not skip any product even if it appears in a different section or language.\n"
            f"CRITICAL for source_snippet: for EACH item, copy the exact contiguous text from the email covering "
            f"that item — from its product name through its price and quantity if shown — VERBATIM, character for "
            f"character. Your extraction is machine-verified against the email text: an item whose snippet is not "
            f"found verbatim, or email price lines not covered by any item's snippet, will fail verification.\n"
            f"CRITICAL for stated_item_count: if the email states a product/item count anywhere (e.g. '2 products'), "
            f"copy that number; otherwise null. Never compute it from your own item list.\n"
            f"CRITICAL for shop_name: identify the SELLER'S shop/store name that received this order (the greeting "
            f"or footer names our store, e.g. 'Hello <ShopName>'). This is NOT the buyer and NOT 'Shopee'/'Lazada'. "
            f"If no seller shop name is present, set shop_name to null.\n\n"
            f"{cleaned_body}"
        )

        _scout_models = ('gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro')
        for i, model in enumerate(_scout_models):
            try:
                response = self.ai_client.models.generate_content(
                    model=model,
                    contents=prompt,
                    config={
                        'response_mime_type': 'application/json',
                        'response_schema': OrderDetails,
                        'temperature': 0.1
                    }
                )
                self._log_gemini_usage(model, response)
                order_data = json.loads(response.text)
                order_data.update({k: v for k, v in prefilled.items() if v})
                parsed = OrderDetails(**order_data)
                if not parsed.is_order_email:
                    logger.info(f"[Scout] Email is not an order (LLM flagged is_order_email=False). Skipping.")
                # Non-order parses are returned too (not None) so the caller can mark
                # the stored email row 'not_order' instead of 'failed'.
                return parsed
            except Exception as e:
                err_str = str(e)
                err_type = type(e).__name__
                is_timeout = 'Timeout' in err_type or 'timeout' in err_str.lower()
                is_transient = (
                    is_timeout or '503' in err_str or 'UNAVAILABLE' in err_str
                    or '429' in err_str or 'RESOURCE_EXHAUSTED' in err_str
                )
                is_last = i == len(_scout_models) - 1
                if is_transient and not is_last:
                    logger.warning(f"[Scout] {model} transient error ({err_type}), trying next model.")
                    continue
                if is_transient:
                    logger.warning(f"[Scout] All models temporarily unavailable — email will retry next cycle.")
                    raise TransientLLMError("All Gemini models temporarily unavailable")
                msg = f"LLM Parsing failed: {e}"
                logger.error(msg)
                self.log_to_db("error", msg, {"email_body_preview": email_body[:200]})
                return None

    def resolve_variant_id(self, listing_title: str, variation_name: Optional[str],
                            shop_id: Optional[str] = None) -> tuple[Optional[str], bool, Optional[dict]]:
        return resolve_variant(self.supabase, listing_title, variation_name, shop_id=shop_id)

    def process_order(self, order_details: OrderDetails, cleaned_body: Optional[str] = None,
                      source_email_id: Optional[str] = None):
        platform_order_id = order_details.platform_order_id.strip()
        try:
            existing = self.supabase.table("orders").select("id").eq("platform_order_id", platform_order_id).execute()
            if existing.data:
                logger.info(f"Order {platform_order_id} already exists in database. Skipping ingestion.")
                if source_email_id:
                    self._update_ingested_email(source_email_id, {"order_id": existing.data[0]["id"]})
                return
        except Exception as e:
            logger.error(f"Error checking order duplication: {e}")

        # Validate the parsed Gemini payload before inserting anything — an order with no
        # items, or items with non-numeric/non-positive quantities, is a bad parse, not a
        # real order. Treat it like any other failure (don't insert, let run() retry/hold
        # the source email) rather than creating an empty/broken order row.
        if not order_details.items:
            msg = f"Rejected order {platform_order_id}: parsed payload has no items."
            logger.error(msg)
            self.log_to_db("error", msg, {"platform_order_id": platform_order_id})
            raise ValueError(msg)
        for it in order_details.items:
            qty = it.purchased_quantity
            if not isinstance(qty, int) or isinstance(qty, bool) or qty <= 0:
                msg = (f"Rejected order {platform_order_id}: item '{it.listing_title}' has an invalid "
                       f"quantity ({qty!r}).")
                logger.error(msg)
                self.log_to_db("error", msg, {"platform_order_id": platform_order_id, "listing_title": it.listing_title})
                raise ValueError(msg)

        # Coverage verification: prove the extraction accounts for the whole email
        # BEFORE the order row exists — hold-level failures insert the order as
        # 'hold' from the start, so the Foreman daemon can never race a post-insert
        # status flip and dispatch an incompletely-ingested order.
        hold_problems, warn_problems = verify_extraction_coverage(order_details, cleaned_body)

        # Resolve which of our shops this order belongs to, from the seller shop name the
        # LLM extracted. No match → shop_id stays None ("Unassigned"), surfaced in the UI.
        shop = resolve_shop(getattr(order_details, "shop_name", None))
        shop_id = shop["id"] if shop else None
        if shop:
            logger.info(f"Order {platform_order_id} attributed to shop '{shop['name']}' "
                        f"(from shop_name={order_details.shop_name!r}).")
        else:
            logger.warning(f"Order {platform_order_id} could not be attributed to a shop "
                           f"(shop_name={getattr(order_details, 'shop_name', None)!r}) — leaving Unassigned.")

        try:
            order_record = {
                "platform_order_id": platform_order_id,
                "order_timestamp": order_details.order_timestamp,
                "sales_platform": order_details.sales_platform,
                "customer_name": order_details.customer_name,
                "order_subtotal": order_details.order_subtotal,
                "order_currency": order_details.order_currency,
                "overall_order_status": "hold" if hold_problems else "pending",
                "hold_reason": "; ".join(hold_problems) if hold_problems else None,
                "source_email_id": source_email_id,
                "shop_id": shop_id
            }
            order_response = self.supabase.table("orders").insert(order_record).execute()
            order_id = order_response.data[0]['id']
            logger.info(f"Inserted order {order_details.platform_order_id} with ID: {order_id}")
            if source_email_id:
                self._update_ingested_email(source_email_id, {"order_id": order_id})
        except Exception as e:
            # A UNIQUE(platform_order_id) violation means this order was ingested by a
            # concurrent/redelivered scan between our pre-check and this insert — benign,
            # not an error. Anything else is a genuine failure worth surfacing.
            err = str(e).lower()
            if "duplicate key" in err or "23505" in err or "already exists" in err:
                logger.info(f"Order {platform_order_id} already ingested (unique-violation race) — skipping.")
                return
            msg = f"Failed to insert order {order_details.platform_order_id}: {e}"
            logger.error(msg)
            self.log_to_db("error", msg, {"order_details": order_details.model_dump()})
            # Re-raise so run() leaves the source email unread for retry — returning
            # normally here would mark the email processed and silently lose the order.
            raise

        resolved_items = {}
        has_matching_failure = False
        has_fuzzy_match = False
        missing_item_details = ""
        fuzzy_items = []
        item_index = 0
        
        for item in order_details.items:
            listing_title = item.listing_title
            variation_name = item.variation_name
            quantity = item.purchased_quantity
            
            try:
                variant_id, is_fuzzy, variant_row = self.resolve_variant_id(listing_title, variation_name, shop_id=shop_id)

                if not variant_id:
                    has_matching_failure = True
                    error_msg = f"Listing or variation not found: '{listing_title}' (Variation: '{variation_name}') for order {order_details.platform_order_id}"
                    logger.warning(error_msg)
                    self.log_to_db("error", error_msg, {"platform_order_id": order_details.platform_order_id, "listing_title": listing_title, "variation_name": variation_name})
                    
                    fake_key = f"non_existent_{item_index}"
                    item_index += 1
                    resolved_items[fake_key] = {
                        "variant_sku": "item does not exist",
                        "variant_name": "item does not exist",
                        "quantity": quantity,
                        "variation_names": {variation_name} if variation_name else set(),
                        "is_fake": True
                    }
                    missing_item_details += f"Listing: '{listing_title}' (Var: '{variation_name}'); "
                    continue
                
                # Prefer the variant columns the resolver already fetched (avoids an extra
                # round-trip per item); fall back to a lookup only if they weren't returned.
                if variant_row:
                    v_sku          = variant_row.get("variant_sku")
                    v_name         = variant_row.get("variant_name")
                    v_plaque_count = variant_row.get("plaque_count")
                    v_set_number   = variant_row.get("set_number")
                else:
                    var_info = self.supabase.table("variants").select("variant_sku, variant_name, plaque_count, set_number").eq("id", variant_id).execute()
                    v_sku         = var_info.data[0]["variant_sku"]    if var_info.data else None
                    v_name        = var_info.data[0]["variant_name"]   if var_info.data else None
                    v_plaque_count = var_info.data[0].get("plaque_count") if var_info.data else None
                    v_set_number   = var_info.data[0].get("set_number") if var_info.data else None

                if is_fuzzy:
                    has_fuzzy_match = True
                    fuzzy_items.append({
                        "listing_title": listing_title,
                        "variation_name": variation_name,
                        "matched_sku": v_sku,
                    })

                # Sanity-check: if the variation expects a specific plaque count, the matched
                # variant must have the same plaque_count. Mismatches mean bad DB data —
                # hold the order rather than print the wrong item.
                intent = extract_variant_intent(normalize_variation(variation_name or ""))
                expected_pc = intent.get("plaque_count")
                if expected_pc is not None and v_plaque_count != expected_pc:
                    has_matching_failure = True
                    msg = (f"Plaque count mismatch: variation '{variation_name}' expects {expected_pc} plaques "
                           f"but matched SKU '{v_sku}' has plaque_count={v_plaque_count} "
                           f"for '{listing_title}' in order {order_details.platform_order_id}.")
                    logger.error(msg)
                    self.log_to_db("error", msg, {"platform_order_id": order_details.platform_order_id,
                                                   "variation_name": variation_name, "matched_sku": v_sku})
                    missing_item_details += f"Plaque mismatch: '{variation_name}' → '{v_sku}'; "
                    fake_key = f"non_existent_{item_index}"
                    item_index += 1
                    resolved_items[fake_key] = {"variant_sku": v_sku, "variant_name": v_name,
                                                 "quantity": quantity, "variation_names": {variation_name},
                                                 "is_fake": True}
                    continue

                # Sanity-check: if the variation text itself names a set number (common on
                # shared/"compatible with sets A/B" listings), the matched variant must be
                # for that exact set. Catches wrong-set mismatches regardless of which
                # matching stage produced them — hold the order rather than print the wrong item.
                expected_set_num = extract_set_number_from_text(variation_name or "")
                if expected_set_num is not None and v_set_number is not None and str(v_set_number) != str(expected_set_num):
                    has_matching_failure = True
                    msg = (f"Set number mismatch: variation '{variation_name}' expects set {expected_set_num} "
                           f"but matched SKU '{v_sku}' is for set {v_set_number} "
                           f"for '{listing_title}' in order {order_details.platform_order_id}.")
                    logger.error(msg)
                    self.log_to_db("error", msg, {"platform_order_id": order_details.platform_order_id,
                                                   "variation_name": variation_name, "matched_sku": v_sku})
                    missing_item_details += f"Set mismatch: '{variation_name}' → '{v_sku}'; "
                    fake_key = f"non_existent_{item_index}"
                    item_index += 1
                    resolved_items[fake_key] = {"variant_sku": v_sku, "variant_name": v_name,
                                                 "quantity": quantity, "variation_names": {variation_name},
                                                 "is_fake": True}
                    continue
                
                if variant_id not in resolved_items:
                    resolved_items[variant_id] = {
                        "variant_sku": v_sku,
                        "variant_name": v_name,
                        "quantity": quantity,
                        "variation_names": {variation_name} if variation_name else set(),
                        "subtotal": item.item_subtotal
                    }
                else:
                    resolved_items[variant_id]["quantity"] += quantity
                    if variation_name:
                        resolved_items[variant_id]["variation_names"].add(variation_name)
                    # Merged subtotal is only meaningful if every merged line had a
                    # price — one missing price makes the sum a lie, so store NULL.
                    prev_subtotal = resolved_items[variant_id].get("subtotal")
                    if prev_subtotal is not None and item.item_subtotal is not None:
                        resolved_items[variant_id]["subtotal"] = prev_subtotal + item.item_subtotal
                    else:
                        resolved_items[variant_id]["subtotal"] = None
            except Exception as e:
                msg = f"Failed to process item '{listing_title}' for order {order_details.platform_order_id}: {e}"
                logger.error(msg)
                self.log_to_db("error", msg, {"listing_title": listing_title, "order_id": order_id})

        successful_items = 0
        for variant_id, details in resolved_items.items():
            try:
                var_names_list = sorted(list(details["variation_names"]))
                var_names_str = ", ".join(var_names_list) if var_names_list else None
                v_name = details["variant_name"]
                is_fake = details.get("is_fake", False)
                
                order_item_record = {
                    "order_id": order_id,
                    "variant_id": None if is_fake else variant_id,
                    "variant_sku": details["variant_sku"],
                    "variant_name": "item does not exist" if is_fake else (f"{v_name} ({var_names_str})" if v_name and var_names_str else v_name),
                    "purchased_quantity": details["quantity"],
                    "item_print_status": "not_applicable" if is_fake else "pending",
                    "item_subtotal": details.get("subtotal")
                }
                self.supabase.table("order_items").insert(order_item_record).execute()
                successful_items += 1
            except Exception as e:
                msg = f"Failed to insert merged item for variant '{details['variant_sku']}' in order {order_details.platform_order_id}: {e}"
                logger.error(msg)
                self.log_to_db("error", msg, {"variant_id": variant_id, "order_id": order_id})

        expected_items = len(resolved_items)
        insert_incomplete = successful_items < expected_items
        if insert_incomplete:
            msg = (f"Order {order_details.platform_order_id}: only {successful_items}/{expected_items} "
                   f"resolved item(s) were successfully inserted into order_items.")
            logger.error(msg)
            self.log_to_db("error", msg, {"platform_order_id": order_details.platform_order_id,
                                           "successful_items": successful_items, "expected_items": expected_items})

        if has_matching_failure or insert_incomplete:
            try:
                reasons = [r for r in hold_problems + [missing_item_details.strip('; ') or None] if r]
                self.supabase.table("orders").update({
                    "overall_order_status": "hold",
                    "hold_reason": "; ".join(reasons) if reasons else "Item matching/insert failure"
                }).eq("id", order_id).execute()
            except Exception as e:
                logger.error(f"Failed to set order status to hold: {e}")

        if has_fuzzy_match and not has_matching_failure:
            item_lines = "; ".join(
                f"Listing: '{fi['listing_title']}' (Var: '{fi['variation_name']}') -> matched SKU '{fi['matched_sku']}'"
                for fi in fuzzy_items
            )
            warning_msg = (
                f"❗️ FUZZY MATCH — VERIFY SKU ❗️ Order {order_details.platform_order_id} "
                f"was NOT matched by exact listing/variation lookup — a fallback rule guessed the SKU. "
                f"Double-check before this prints: {item_lines}"
            )
            logger.warning(warning_msg)
            self.log_to_db("warning", warning_msg, {
                "platform_order_id": order_details.platform_order_id,
                "fuzzy_match": True,
                "fuzzy_items": fuzzy_items,
            })

        # Surface verification outcomes. Warn-level problems alert but don't block;
        # hold-level problems already inserted the order as 'hold' — announce and
        # bail before dispatch.
        if warn_problems:
            warn_msg = (f"⚠️ EXTRACTION COVERAGE WARNING — Order {order_details.platform_order_id}: "
                        + " | ".join(warn_problems))
            logger.warning(warn_msg)
            self.log_to_db("warning", warn_msg, {"platform_order_id": order_details.platform_order_id,
                                                  "coverage_warnings": warn_problems})
        if hold_problems:
            hold_msg = (f"🛑 ORDER HELD — EMAIL NOT FULLY INGESTED 🛑 Order {order_details.platform_order_id} "
                        f"failed extraction verification and will NOT print until reviewed: "
                        + " | ".join(hold_problems))
            logger.warning(hold_msg)
            self.log_to_db("warning", hold_msg, {"platform_order_id": order_details.platform_order_id,
                                                  "coverage_holds": hold_problems,
                                                  "source_email_id": source_email_id})

        if has_matching_failure:
            raise OrderHeldForReview(f"Order {order_details.platform_order_id} ingested with missing items: {missing_item_details}")
        if insert_incomplete:
            raise OrderHeldForReview(f"Order {order_details.platform_order_id} ingested with only "
                             f"{successful_items}/{expected_items} items inserted — set to hold.")
        if hold_problems:
            raise OrderHeldForReview(f"Order {order_details.platform_order_id} held: extraction coverage "
                             f"verification failed ({'; '.join(hold_problems)}).")

        if successful_items > 0:
            self.log_to_db("info", f"Successfully ingested order {order_details.platform_order_id} with {successful_items} items.", {"platform_order_id": order_details.platform_order_id})
            try:
                dispatch_result = run_foreman_dispatch()
                logger.info(f"[Foreman] Auto-dispatch after ingestion: {dispatch_result.get('message', dispatch_result)}")
            except Exception as fe:
                logger.error(f"[Foreman] Auto-dispatch failed for order {order_details.platform_order_id}: {fe}")
        else:
            msg = f"Order {order_details.platform_order_id} was created but no items were successfully matched/inserted."
            logger.warning(msg)
            self.log_to_db("warning", msg)

    def run(self, force=False):
        """Main execution loop for the Scout agent."""
        if not force and not self._acquire_lock():
            logger.warning("Scout Agent run skipped because lock is already held.")
            return

        try:
            logger.info("Scout Agent polling for new emails...")
            emails = self.fetch_unread_order_emails()
            if emails:
                for email in emails:
                    logger.info(f"Processing order email: {email['subject']}")
                    # Lossless capture FIRST: the raw email is in the DB before any
                    # LLM sees it, so no downstream failure can lose order content.
                    cleaned_body = self._clean_text_for_llm(email['body']) if email['body'] else ''
                    email_row_id = self._store_ingested_email(email, cleaned_body)

                    if not email['body']:
                        logger.warning(f"Email {email['id']} has no readable body text. Marking read to skip.")
                        self._update_ingested_email(email_row_id, {
                            "parse_status": "failed", "parse_error": "No readable body text extracted from MIME parts."})
                        self.mark_email_as_read(email['id'])
                        continue

                    try:
                        order_details = self.parse_email_with_llm(
                            email['body'],
                            subject=email.get('subject', ''),
                            sender=email.get('sender', ''),
                            date_header=email.get('date', ''),
                        )
                    except TransientLLMError:
                        logger.warning(f"Transient Gemini error for email {email['id']} — leaving unread for next cycle.")
                        continue  # row stays 'pending' — retried next cycle

                    if order_details and not order_details.is_order_email:
                        self._update_ingested_email(email_row_id, {"parse_status": "not_order"})
                        self.mark_email_as_read(email['id'])
                    elif order_details:
                        try:
                            self.process_order(order_details, cleaned_body=cleaned_body,
                                               source_email_id=email_row_id)
                        except OrderHeldForReview as e:
                            # Order row was created (as 'hold') — safe to mark processed;
                            # re-scanning won't change the outcome.
                            logger.warning(f"Order {order_details.platform_order_id} held for review: {e}")
                            self._update_ingested_email(email_row_id, {"parse_status": "held"})
                            self.mark_email_as_read(email['id'])
                        except Exception as e:
                            # Unexpected failure — we don't know the order was safely
                            # recorded, so leave the email unread for retry rather than
                            # silently marking it processed.
                            logger.error(f"Error processing order {order_details.platform_order_id}: {e}")
                            self._update_ingested_email(email_row_id, {
                                "parse_status": "failed", "parse_error": str(e)[:2000]})
                        else:
                            self._update_ingested_email(email_row_id, {"parse_status": "parsed"})
                            self.mark_email_as_read(email['id'])
                    else:
                        logger.error(f"Permanent parse failure for email {email['id']}. Marking read to skip.")
                        self._update_ingested_email(email_row_id, {
                            "parse_status": "failed", "parse_error": "Permanent LLM parse failure (see system_logs)."})
                        self.mark_email_as_read(email['id'])
            else:
                logger.info("No new order emails found.")

            logger.info("Scout Agent finished polling cycle.")
        finally:
            if self._held_thread_lock:
                _scout_thread_lock.release()
                self._held_thread_lock = False
            if self._lock_file:
                try:
                    self._lock_file.close()
                    self._lock_file = None
                except:
                    pass

    def __del__(self):
        if hasattr(self, '_held_thread_lock') and self._held_thread_lock:
            try:
                _scout_thread_lock.release()
            except:
                pass
        if hasattr(self, '_lock_file') and self._lock_file:
            try:
                self._lock_file.close()
            except:
                pass


# On-demand scan triggers (manual /scout/poll, the Gmail push webhook, and the
# scout_gmail_scan daemon job) all call ScoutAgent.run(force=True), which intentionally
# bypasses the fcntl-based lock so a user-initiated scan isn't silently skipped just
# because the periodic poll happens to be running. That leaves these on-demand triggers
# with no protection against each other — e.g. two Pub/Sub pushes arriving within
# milliseconds can otherwise run two fully concurrent scans. _trigger_scout_scan()
# coalesces overlapping triggers with a plain threading.Lock (these all run in FastAPI's
# background-task threadpool, not on the asyncio event loop, so threading.Lock — not
# asyncio.Lock — is the correct primitive here): if a scan is already in progress, the
# new trigger doesn't start a second one — it just asks the in-progress scan to loop
# once more after it finishes, so no new email is missed.
_scout_run_lock = threading.Lock()
_scout_rerun_requested = False

def _trigger_scout_scan():
    """Runs a forced Scout scan, coalescing overlapping triggers into a single execution."""
    global _scout_rerun_requested
    if not _scout_run_lock.acquire(blocking=False):
        _scout_rerun_requested = True
        logger.info("[Scout] Scan already in progress — coalescing this trigger into a rerun.")
        return
    try:
        while True:
            _scout_rerun_requested = False
            try:
                agent = ScoutAgent()
                agent.run(force=True)
            except Exception as e:
                logger.error(f"Scout scan error: {e}")
            if not _scout_rerun_requested:
                break
    finally:
        _scout_run_lock.release()


# ----------------- SECTION 4: Waybill Agent Ingest & SimplyPrint Telemetry -----------------

def resolve_variant_id_to_sku(supabase_client, listing_title: str, variation_name: Optional[str]) -> Optional[str]:
    """Resolves listing title and variation name to the database variant SKU. Thin wrapper over resolve_variant()."""
    variant_id, _, variant_row = resolve_variant(supabase_client, listing_title, variation_name)
    if not variant_id:
        return None
    if variant_row and variant_row.get("variant_sku"):
        return variant_row["variant_sku"]
    try:
        res = supabase_client.table("variants").select("variant_sku").eq("id", variant_id).limit(1).execute()
        return res.data[0]["variant_sku"] if res.data else None
    except Exception as e:
        logger.error(f"[Matching] resolve_variant_id_to_sku SKU fetch error: {e}")
        return None

def get_drive_service():
    """Returns the (module-level cached) Google Drive API service client. See
    _get_google_creds() — the waybill daemon calls this once per job; caching avoids
    rebuilding the API client and re-reading token.json on every call."""
    global _drive_service_cache
    creds = _get_google_creds()
    if _drive_service_cache is not None:
        return _drive_service_cache
    _drive_service_cache = build('drive', 'v3', credentials=creds)
    return _drive_service_cache

def log_system_waybill(level: str, message: str, details: dict = None):
    log_system(level, message, details, agent_name="Waybill Agent")

def extract_gdrive_id(url):
    if not url: return None
    match = re.search(r'/d/([^/&#?]+)', url)
    if match: return match.group(1)
    match_id = re.search(r'[?&]id=([^&#?]+)', url)
    if match_id: return match_id.group(1)
    return None

def download_drive_file(service, file_id, dest_path):
    try:
        request = service.files().get_media(fileId=file_id)
        fh = BytesIO()
        downloader = MediaIoBaseDownload(fh, request)
        done = False
        while not done:
            status, done = downloader.next_chunk()
        with open(dest_path, 'wb') as f:
            f.write(fh.getvalue())
        return True
    except Exception as e:
        print(f"[-] Drive API get_media failed for {file_id}: {e}")
        # Second attempt: direct HTTP with OAuth bearer token (works for
        # 'anyone with the link' files that get_media rejects)
        try:
            creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
            if creds.expired and creds.refresh_token:
                creds.refresh(GoogleAuthRequest())
            r = requests.get(
                f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media",
                headers={"Authorization": f"Bearer {creds.token}"},
                timeout=30
            )
            if r.ok and r.content.startswith(b'%PDF'):
                with open(dest_path, 'wb') as f:
                    f.write(r.content)
                print(f"[+] OAuth HTTP fallback succeeded for {file_id}.")
                return True
            print(f"[-] OAuth HTTP fallback: status={r.status_code}, starts={r.content[:40]}")
        except Exception as e2:
            print(f"[-] OAuth HTTP fallback failed for {file_id}: {e2}")
        return False

def _download_gdrive_public(file_id: str, dest_path: str) -> bool:
    """Download a publicly shared Google Drive file, handling the virus-scan warning redirect."""
    session = requests.Session()
    # Try the newer usercontent domain first (more reliable since ~2024)
    candidates = [
        f"https://drive.usercontent.google.com/download?id={file_id}&export=download&authuser=0",
        f"https://drive.google.com/uc?export=download&id={file_id}",
    ]
    for attempt_url in candidates:
        try:
            print(f"[*] Trying public download URL: {attempt_url}")
            r = session.get(attempt_url, timeout=30, allow_redirects=True)
            r.raise_for_status()
            content = r.content
            print(f"[*] Response: {r.status_code}, {len(content)} bytes, content-type={r.headers.get('content-type','?')}, starts={content[:20]}")
            if not content.startswith(b'%PDF'):
                # Drive returned HTML — extract confirmation token and retry
                confirm = None
                for k, v in r.cookies.items():
                    if k.startswith('download_warning'):
                        confirm = v
                        break
                if not confirm:
                    m = re.search(r'confirm=([^&"\']+)', r.text)
                    confirm = m.group(1) if m else 't'
                print(f"[*] Got HTML, retrying with confirm token: {confirm}")
                r = session.get(
                    f"https://drive.google.com/uc?export=download&confirm={confirm}&id={file_id}",
                    timeout=30, allow_redirects=True
                )
                r.raise_for_status()
                content = r.content
                print(f"[*] Confirmed response: {len(content)} bytes, starts={content[:20]}")
            if content.startswith(b'%PDF'):
                with open(dest_path, 'wb') as f:
                    f.write(content)
                print(f"[+] Successfully downloaded {file_id} via public URL.")
                return True
            print(f"[-] Content for {file_id} still not a PDF after confirm.")
        except Exception as e:
            print(f"[-] Public download attempt failed ({attempt_url}): {e}")
    return False

def download_file_from_url(service, url, dest_path):
    file_id = extract_gdrive_id(url)
    if file_id:
        # Try service-account API first (works for files owned/shared with the SA)
        if download_drive_file(service, file_id, dest_path):
            return True
        # Fall back to public HTTP download for "anyone with the link" shares
        print(f"[!] Drive API failed for {file_id}, retrying via public download URL...")
        if _download_gdrive_public(file_id, dest_path):
            return True
        print(f"[-] Public HTTP fallback also failed for file {file_id}.")
        return False
    else:
        try:
            r = http_session.get(url, timeout=30)
            r.raise_for_status()
            with open(dest_path, 'wb') as f:
                f.write(r.content)
            return True
        except Exception as e:
            print(f"[-] Error downloading URL {url}: {e}")
            return False

def get_or_create_folder(service, folder_name, parent_id=None):
    # Escape backslashes and single quotes for the Drive query language — an unescaped
    # apostrophe in a product name (e.g. "Luke's Landspeeder") breaks the query.
    safe_name = folder_name.replace("\\", "\\\\").replace("'", "\\'")
    query = f"name = '{safe_name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    if parent_id:
        query += f" and '{parent_id}' in parents"
    try:
        results = service.files().list(q=query, spaces='drive', fields='files(id, name)').execute()
        files = results.get('files', [])
        if files:
            return files[0]['id']
        else:
            file_metadata = {
                'name': folder_name,
                'mimeType': 'application/vnd.google-apps.folder'
            }
            if parent_id:
                file_metadata['parents'] = [parent_id]
            folder = service.files().create(body=file_metadata, fields='id').execute()
            print(f"[+] Created Google Drive folder: {folder_name}")
            return folder.get('id')
    except Exception as e:
        print(f"[-] Error in get_or_create_folder for '{folder_name}': {e}")
        return None

# Products root folder in Drive, resolved once per process. Env var wins; otherwise
# walk up from an existing variant's Pictures folder so new product folders land
# alongside the current structure ({root}/{Product}/Pictures).
_product_parent_folder_cache = None

def get_product_parent_folder_id(service):
    global _product_parent_folder_cache
    if _product_parent_folder_cache:
        return _product_parent_folder_cache
    env_id = os.environ.get("PRODUCT_PARENT_FOLDER_ID")
    if env_id:
        _product_parent_folder_cache = env_id
        return env_id
    try:
        res = supabase.table('variants').select('pictures_gdrive_url') \
            .like('pictures_gdrive_url', 'http%').limit(10).execute()
        for row in (res.data or []):
            fid = extract_gdrive_id(row.get('pictures_gdrive_url') or '')
            if not fid:
                continue
            try:
                info = service.files().get(fileId=fid, fields='name, parents').execute()
            except Exception:
                continue
            parents = info.get('parents') or []
            if not parents:
                continue
            if 'picture' in (info.get('name') or '').lower():
                # URL points at a Pictures subfolder — its grandparent is the products root
                try:
                    prod = service.files().get(fileId=parents[0], fields='parents').execute()
                    grandparent = (prod.get('parents') or [None])[0]
                    if grandparent:
                        _product_parent_folder_cache = grandparent
                        return grandparent
                except Exception:
                    continue
            else:
                # URL points at the product folder itself — its parent is the root
                _product_parent_folder_cache = parents[0]
                return parents[0]
    except Exception as e:
        print(f"[-] get_product_parent_folder_id failed: {e}")
    return None

def upload_to_drive(service, local_path, name, parent_folder_id, mimetype=None, make_public=True):
    """Uploads a local file to Google Drive. By default grants 'anyone with the link' read
    access (make_public=True), matching prior behavior for non-PII uploads (e.g. print
    files, product images). Waybill uploads contain customer name/address/phone and must
    pass make_public=False so they stay private (accessible only to the authenticated
    Drive account) instead of being world-readable."""
    try:
        date_suffix = datetime.now().strftime("%Y-%m-%d")
        base, ext = os.path.splitext(name)
        new_name = f"{base}_{date_suffix}{ext}"

        file_metadata = {
            'name': new_name,
            'parents': [parent_folder_id]
        }
        if mimetype is None:
            mimetype = mimetypes.guess_type(name)[0] or 'application/octet-stream'
        media = MediaFileUpload(local_path, mimetype=mimetype)
        file = service.files().create(body=file_metadata, media_body=media, fields='id').execute()
        file_id = file.get('id')

        if make_public:
            service.permissions().create(
                fileId=file_id,
                body={'type': 'anyone', 'role': 'reader'}
            ).execute()

        file_info = service.files().get(fileId=file_id, fields='webViewLink').execute()
        return file_info.get('webViewLink')
    except Exception as e:
        print(f"[-] Error uploading file '{name}': {e}")
        return None

def move_drive_file(service, file_id, target_parent_id):
    try:
        file = service.files().get(fileId=file_id, fields='parents').execute()
        previous_parents = ",".join(file.get('parents', []))
        service.files().update(
            fileId=file_id,
            addParents=target_parent_id,
            removeParents=previous_parents,
            fields='id, parents'
        ).execute()
        return True
    except Exception as e:
        print(f"[-] Error moving file {file_id}: {e}")
        return False

def extract_shopee_order_id(text):
    stripped_text = "".join(text.split())
    matches = re.findall(r'\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[A-Z0-9]{8}', stripped_text)
    for m in matches:
        if m.startswith(('24', '25', '26', '27', '28', '29')):
            return m
    if matches:
        return matches[0]
    return None

def _extract_waybill_order_id(text: str) -> Optional[str]:
    """Extracts the platform order ID from a waybill page: regex first, Gemini fallback.
    Strips whitespace, and strips a leading alpha prefix only when the remainder is a pure
    numeric Shopee-style ID (preserving Lazada IDs that legitimately start with letters)."""
    order_id = extract_shopee_order_id(text)
    if not order_id:
        prompt = (
            "Extract the platform/shipping Order ID (e.g. Shopee/Lazada order ID) from this shipping label text.\n"
            "Return ONLY a JSON object: {\"order_id\": \"ID_STRING\"}. If no order ID is found, return {\"order_id\": null}.\n"
            "Do not include any formatting other than raw JSON.\n"
            f"Text:\n{text}"
        )
        try:
            response = gemini_generate("Waybill Agent", prompt)
            res_text = response.text.replace('```json', '').replace('```', '').strip()
            order_id = json.loads(res_text).get('order_id')
        except Exception as e:
            print(f"[-] Gemini order-ID extraction failed: {e}")
            order_id = None
    if not order_id:
        return None
    order_id = "".join(order_id.split())
    _stripped = re.sub(r'^[A-Za-z]+', '', order_id)
    if _stripped and _stripped.isdigit():
        order_id = _stripped
    return order_id

def classify_page_text(text):
    text_lower = text.lower()
    if "packing list" in text_lower:
        return "packing_list"
    if any(k in text_lower for k in ["recipient details", "sender details", "consignment", "delivery partner", "ship with spx"]):
        return "waybill"
    return classify_document(text)

def classify_document(text):
    prompt = (
        "You are an assistant that classifies a document page as either a shipping waybill (shipping label) or a warehouse packing list.\n"
        "Based on the following extracted text, return only a JSON object: {\"class\": \"waybill\"} or {\"class\": \"packing_list\"}.\n"
        "Do not include any formatting other than raw JSON.\n"
        f"Text:\n{text}"
    )
    try:
        response = gemini_generate("Waybill Agent", prompt)
        res_text = response.text.replace('```json', '').replace('```', '').strip()
        data = json.loads(res_text)
        return data.get('class')
    except Exception as e:
        print(f"[-] Error classifying document: {e}")
        return None

def parse_packing_list(text):
    prompt = (
        "You are an assistant that extracts order details from a packing list PDF page.\n"
        "Extract the platform order ID, product listing titles, variation names, and purchased quantities.\n"
        "Make sure to separate the variation name and listing title if they are merged/stuck together in the text.\n"
        "Text:\n" + text
    )
    try:
        response = gemini_generate("Waybill Agent", prompt, config={
            'response_mime_type': 'application/json',
            'response_schema': PackingListDetails,
            'temperature': 0.1
        })
        res_text = response.text.strip()
        data = json.loads(res_text)
        orders = data.get('orders', [])
        
        regex_id = extract_shopee_order_id(text)
        for o in orders:
            p_id = o.get('platform_order_id', '').strip()
            if regex_id and (not p_id or len(p_id) < 10 or p_id == "11"):
                print(f"[*] Auto-correcting order ID '{p_id}' to regex match '{regex_id}'")
                o['platform_order_id'] = regex_id
        return orders
    except Exception as e:
        print(f"[-] Error parsing packing list with Gemini: {e}")
        return []

def reconcile_packing_list_order(pl_order: dict):
    """Pack-time safety net: the packing list is an independent document listing what
    each order actually contains — compare it against the order_items rows Scout
    ingested. A quantity mismatch means the DB order is incomplete (or over-full):
    hold the order and alert, BEFORE anything gets packed and shipped. Never raises —
    reconciliation must not break waybill processing."""
    try:
        pid = (pl_order.get('platform_order_id') or '').strip()
        pl_items = pl_order.get('items') or []
        if not pid or not pl_items:
            return
        res = supabase.table('orders').select('id, overall_order_status, hold_reason') \
            .eq('platform_order_id', pid).limit(1).execute()
        if not res.data:
            msg = f"Packing list references order {pid} which does not exist in the database — was its email ever ingested?"
            print(f"[!] {msg}")
            log_system_waybill("warning", msg, {"platform_order_id": pid})
            return
        order = res.data[0]
        db_items = supabase.table('order_items').select('purchased_quantity, variant_id, variant_sku') \
            .eq('order_id', order['id']).execute().data or []

        pl_qty = sum(int(i.get('quantity') or 0) for i in pl_items)
        db_qty = sum(int(i.get('purchased_quantity') or 0) for i in db_items)

        if pl_qty != db_qty:
            reason = (f"Packing list shows {pl_qty} unit(s) across {len(pl_items)} item(s) but the ingested "
                      f"order has {db_qty} unit(s) across {len(db_items)} item(s).")
            msg = (f"🛑 PACKING LIST MISMATCH 🛑 Order {pid}: {reason} "
                   f"Do NOT pack this order until the missing items are resolved.")
            print(f"[!] {msg}")
            log_system_waybill("warning", msg, {"platform_order_id": pid,
                                                 "packing_list_items": pl_items,
                                                 "db_quantity": db_qty, "pl_quantity": pl_qty})
            if order.get('overall_order_status') in ('pending', 'printing'):
                prior = (order.get('hold_reason') or '').strip()
                supabase.table('orders').update({
                    "overall_order_status": "hold",
                    "hold_reason": (prior + '; ' if prior else '') + reason
                }).eq('id', order['id']).execute()
        elif len(pl_items) != len(db_items):
            # Same total units but different line counts — usually legitimate variant
            # merging on ingest, so just flag it for a glance.
            msg = (f"Packing list for order {pid} lists {len(pl_items)} line item(s) but the DB has "
                   f"{len(db_items)} (same total quantity {pl_qty}) — likely variant merging; verify at pack time.")
            print(f"[*] {msg}")
            log_system_waybill("warning", msg, {"platform_order_id": pid, "packing_list_items": pl_items})
        else:
            print(f"[+] Packing list reconciled OK for order {pid}: {pl_qty} unit(s), {len(pl_items)} item(s).")
    except Exception as e:
        print(f"[-] Packing list reconciliation error for order {pl_order.get('platform_order_id')}: {e}")
        log_system_waybill("error", f"Packing list reconciliation failed: {e}",
                           {"platform_order_id": pl_order.get('platform_order_id')})


def process_ingestion(service, waybill_pdf_path, packing_list_pdf_path=None, waybill_file_id=None, packing_list_file_id=None):
    print("[*] Processing waybills with packing-list reconciliation.")
    waybill_pages = []
    
    if packing_list_pdf_path is None:
        print("[*] Processing combined PDF (waybill and packing list)...")
        reader = PdfReader(waybill_pdf_path)
        print(f"[*] Total pages to process: {len(reader.pages)}")
        
        for i, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            doc_class = classify_page_text(text)
            print(f" - Page {i+1}: Classified as: {doc_class}")
            
            if doc_class == 'waybill':
                order_id = _extract_waybill_order_id(text)
                if order_id:
                    waybill_pages.append((page, order_id))
                else:
                    print(f"[-] Warning: No Order ID identified on page {i+1}.")
            elif doc_class is None:
                # Classification failed outright (Gemini error) — don't misroute the page
                # into the packing-list parser; a waybill page routed there would silently
                # drop out of the stitched batch.
                msg = f"Waybill ingest: page {i+1} could not be classified — skipped. Re-upload to retry."
                print(f"[-] {msg}")
                log_system_waybill("warning", msg)
            else:
                print(f" - Page {i+1} is packing list/other — parsing for reconciliation...")
                for pl_order in parse_packing_list(text):
                    reconcile_packing_list_order(pl_order)
    else:
        print("[*] Processing separate waybill and packing list PDFs.")
        try:
            pl_reader = PdfReader(packing_list_pdf_path)
            print(f"[*] Reconciling {len(pl_reader.pages)} packing list page(s) against ingested orders...")
            for i, pl_page in enumerate(pl_reader.pages):
                pl_text = pl_page.extract_text() or ""
                if not pl_text.strip():
                    continue
                for pl_order in parse_packing_list(pl_text):
                    reconcile_packing_list_order(pl_order)
        except Exception as e:
            print(f"[-] Failed to parse packing list PDF for reconciliation: {e}")
            log_system_waybill("error", f"Packing list PDF could not be parsed for reconciliation: {e}", {})
        wb_reader = PdfReader(waybill_pdf_path)
        print(f"[*] Total waybill pages to process: {len(wb_reader.pages)}")
        for i, page in enumerate(wb_reader.pages):
            text = page.extract_text() or ""
            order_id = _extract_waybill_order_id(text)
            if order_id:
                waybill_pages.append((page, order_id))
            else:
                print(f"[-] Warning: No Order ID identified on page {i+1}.")
                
    archive_folder_id = get_or_create_folder(service, "Orbot_Incoming_Archive", parent_id=WAYBILL_MAIN_FOLDER_ID)
    raw_folder_id = get_or_create_folder(service, "Orbot_Raw_Waybills", parent_id=WAYBILL_MAIN_FOLDER_ID)
    processed_folder_id = get_or_create_folder(service, "Orbot_Processed_Waybills", parent_id=WAYBILL_MAIN_FOLDER_ID)
    
    print(f"[*] Processing {len(waybill_pages)} identified waybill page(s)...")
    for page, order_id in waybill_pages:
        res = supabase.table('orders').select('id').eq('platform_order_id', order_id).execute()
        if not res.data:
            print(f"[!] Warning: Order ID {order_id} extracted from waybill page not found in database. Skipping.")
            log_system_waybill("warning", f"Waybill order {order_id} not found in database. Skipping.", {"platform_order_id": order_id})
            continue
            
        db_order_id = res.data[0]['id']
        
        raw_writer = PdfWriter()
        raw_writer.add_page(page)
        raw_pdf_path = f"/tmp/Raw_Waybill_{order_id}.pdf"
        with open(raw_pdf_path, 'wb') as f:
            raw_writer.write(f)
            
        print(f"[*] Uploading raw waybill for {order_id}...")
        # Waybills contain customer name/address/phone — never make them publicly readable.
        raw_gdrive_url = upload_to_drive(service, raw_pdf_path, f"Raw_Waybill_{order_id}.pdf", raw_folder_id, make_public=False)
        
        processed_writer = PdfWriter()
        processed_writer.add_page(page)
        
        items_res = supabase.table('order_items').select('variant_id, purchased_quantity').eq('order_id', db_order_id).execute()
        for item in items_res.data:
            variant_id = item['variant_id']
            qty = item['purchased_quantity']
            if not variant_id: continue
                
            var_res = supabase.table('variants').select('seal_sticker_gdrive_url').eq('id', variant_id).execute()
            if var_res.data and var_res.data[0]['seal_sticker_gdrive_url']:
                sticker_url = var_res.data[0]['seal_sticker_gdrive_url']
                temp_sticker_path = f"/tmp/sticker_{variant_id}.pdf"
                
                print(f"[*] Downloading seal sticker for variant {variant_id}...")
                if download_file_from_url(service, sticker_url, temp_sticker_path):
                    try:
                        sticker_reader = PdfReader(temp_sticker_path)
                        if sticker_reader.pages:
                            for _ in range(qty):
                                processed_writer.add_page(sticker_reader.pages[0])
                            print(f"[+] Appended {qty} sticker(s) for variant {variant_id}.")
                    except Exception as e:
                        log_system_waybill("error", f"Failed to parse sticker PDF for variant {variant_id}: {e}")
                else:
                    log_system_waybill("error", f"Failed to download sticker PDF from {sticker_url} for variant {variant_id}")
                    
        processed_pdf_path = f"/tmp/Processed_Waybill_{order_id}.pdf"
        with open(processed_pdf_path, 'wb') as f:
            processed_writer.write(f)
            
        print(f"[*] Uploading processed waybill for {order_id}...")
        # Waybills contain customer name/address/phone — never make them publicly readable.
        processed_gdrive_url = upload_to_drive(service, processed_pdf_path, f"Processed_Waybill_{order_id}.pdf", processed_folder_id, make_public=False)

        if processed_gdrive_url:
            supabase.table('orders').update({
                'raw_waybill_gdrive_url': raw_gdrive_url,
                'processed_waybill_gdrive_url': processed_gdrive_url,
                'waybill_processing_status': 'ready'
            }).eq('id', db_order_id).execute()
            print(f"[+] Successfully matched and processed waybill for order {order_id}.")
        else:
            supabase.table('orders').update({
                'raw_waybill_gdrive_url': raw_gdrive_url,
                'waybill_processing_status': 'failed'
            }).eq('id', db_order_id).execute()
            log_system_waybill("error", f"Processed waybill upload failed for order {order_id} — Drive upload returned no URL. Order marked as failed.")
            print(f"[-] Processed waybill upload failed for order {order_id}.")
        try:
            os.remove(raw_pdf_path)
            os.remove(processed_pdf_path)
        except OSError:
            pass
            
    if waybill_file_id:
        move_drive_file(service, waybill_file_id, archive_folder_id)
        print(f"[+] Archived waybill file in Google Drive.")
    if packing_list_file_id:
        move_drive_file(service, packing_list_file_id, archive_folder_id)
        print(f"[+] Archived packing list file in Google Drive.")
        
    try:
        os.remove(waybill_pdf_path)
        if packing_list_pdf_path:
            os.remove(packing_list_pdf_path)
    except OSError:
        pass
    print("[+] Ingestion run completed.")

def run_batch_print(service):
    print("[*] Querying orders ready...")
    res = supabase.table('orders').select('id, platform_order_id, processed_waybill_gdrive_url').in_('waybill_processing_status', ['ready', 'ready to print']).execute()
    orders = res.data if res.data else []

    if not orders:
        raise RuntimeError("No orders currently marked as 'ready' or 'ready to print'.")

    print(f"[+] Found {len(orders)} orders ready.")
    orders_with_url = [o for o in orders if o.get('processed_waybill_gdrive_url')]
    orders_missing_url = [o for o in orders if not o.get('processed_waybill_gdrive_url')]
    if orders_missing_url:
        missing_ids = [o.get('platform_order_id') for o in orders_missing_url]
        print(f"[!] {len(orders_missing_url)} order(s) are 'ready' but have no processed waybill URL — resetting to 'failed': {missing_ids}")
        for bad in orders_missing_url:
            supabase.table('orders').update({'waybill_processing_status': 'failed'}).eq('id', bad['id']).execute()
        log_system_waybill("warning", f"Batch compile: reset {len(orders_missing_url)} 'ready' order(s) with no waybill PDF to 'failed': {missing_ids}")
    if not orders_with_url:
        raise RuntimeError(f"Found {len(orders)} ready order(s) but none have a processed waybill PDF — all reset to 'failed'. Re-upload waybills to reprocess.")

    batch_writer = PdfWriter()
    successful_order_ids = []
    failed_order_ids = []

    for o in orders_with_url:
        p_id = o.get('platform_order_id')
        url = o.get('processed_waybill_gdrive_url')

        print(f"[*] Downloading processed PDF for order {p_id}...")
        temp_path = f"/tmp/Processed_Temp_{p_id}.pdf"
        if download_file_from_url(service, url, temp_path):
            try:
                reader = PdfReader(temp_path)
                for page in reader.pages:
                    batch_writer.add_page(page)
                successful_order_ids.append(o['id'])
                print(f"[+] Appended order {p_id} to batch.")
            except Exception as e:
                print(f"[-] Error parsing processed PDF for order {p_id}: {e}")
                failed_order_ids.append(p_id)
            finally:
                try: os.remove(temp_path)
                except OSError: pass
        else:
            print(f"[-] Skipped order {p_id} due to download failure.")
            failed_order_ids.append(p_id)

    if len(successful_order_ids) == 0:
        detail = f"Failed orders: {failed_order_ids}" if failed_order_ids else "No downloadable PDFs."
        raise RuntimeError(f"No pages compiled — all waybill downloads failed. {detail}")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    batch_filename = f"Master_Waybill_Batch_{timestamp}.pdf"
    batch_pdf_path = f"/tmp/{batch_filename}"

    with open(batch_pdf_path, 'wb') as f:
        batch_writer.write(f)

    batch_folder_id = get_or_create_folder(service, "Orbot_Stitched_Batches", parent_id=WAYBILL_MAIN_FOLDER_ID)
    if not batch_folder_id:
        try: os.remove(batch_pdf_path)
        except OSError: pass
        raise RuntimeError("Could not get or create 'Orbot_Stitched_Batches' folder in Google Drive.")

    print(f"[*] Uploading compiled batch PDF to Google Drive...")
    # This batch PDF is a compilation of raw waybills — also contains customer PII, so
    # keep it private like the individual waybill uploads above.
    batch_url = upload_to_drive(service, batch_pdf_path, batch_filename, batch_folder_id, make_public=False)

    if batch_url:
        print(f"\n==========================================")
        print(f"SUCCESS! Master batch PDF created ({len(successful_order_ids)} orders).")
        print(f"Download Link: {batch_url}")
        print(f"==========================================\n")

        for order_id in successful_order_ids:
            supabase.table('orders').update({
                'waybill_processing_status': 'compiled',
                'overall_order_status': 'completed'
            }).eq('id', order_id).execute()
        print(f"[+] Updated status to 'completed' for {len(successful_order_ids)} orders.")
        try: os.remove(batch_pdf_path)
        except OSError: pass
        return batch_url
    else:
        try: os.remove(batch_pdf_path)
        except OSError: pass
        raise RuntimeError("Google Drive upload failed — check Drive API credentials and folder permissions.")

def run_incoming_scan(service):
    print(f"[*] Scanning incoming folder ({INCOMING_FOLDER_ID}) for PDFs...")
    results = service.files().list(
        q=f"'{INCOMING_FOLDER_ID}' in parents and mimeType = 'application/pdf' and trashed = false",
        fields="files(id, name)"
    ).execute()
    files = results.get('files', [])
    
    if not files:
        print("[*] No PDFs found in incoming folder.")
        return
        
    classified_files = []
    for f in files:
        file_id = f['id']
        local_path = f"/tmp/incoming_{file_id}.pdf"
        
        print(f"[*] Downloading {f['name']} for classification...")
        if download_drive_file(service, file_id, local_path):
            try:
                reader = PdfReader(local_path)
                if not reader.pages:
                    doc_class = "empty"
                else:
                    text = reader.pages[0].extract_text() or ""
                    doc_class = classify_page_text(text)
            except Exception as e:
                print(f"[-] Error reading file {f['name']}: {e}")
                doc_class = "error"
                
            print(f"[+] Classified {f['name']} as: {doc_class}")
            classified_files.append((file_id, local_path, f['name'], doc_class))
        else:
            print(f"[-] Failed to download file {f['name']}.")
            
    # Separate files by classification
    waybills = [f for f in classified_files if f[3] == 'waybill']
    packing_lists = [f for f in classified_files if f[3] == 'packing_list']
    others = [f for f in classified_files if f[3] not in ['waybill', 'packing_list']]

    if waybills:
        print(f"[*] Found {len(waybills)} waybill(s) to process.")
        for file_id, local_path, name, doc_class in waybills:
            print(f"[*] Processing waybill: {name}")
            try:
                process_ingestion(service, local_path, waybill_file_id=file_id)
            except Exception as e:
                print(f"[-] Error processing waybill {name}: {e}")
                try: os.remove(local_path)
                except OSError: pass
    else:
        print("[*] No waybills identified in the incoming folder.")

    if packing_lists:
        archive_folder_id = get_or_create_folder(service, "Orbot_Incoming_Archive", parent_id=WAYBILL_MAIN_FOLDER_ID)
        for file_id, local_path, name, doc_class in packing_lists:
            print(f"[*] Standalone packing list {name} found. Archiving directly...")
            try:
                move_drive_file(service, file_id, archive_folder_id)
            except Exception as e:
                print(f"[-] Failed to archive packing list {name}: {e}")
            finally:
                try: os.remove(local_path)
                except OSError: pass

    # Clean up local copies of non-processible files
    for file_id, local_path, name, doc_class in others:
        print(f"[*] Non-processible file {name} (class: {doc_class}). Cleaning up local copy.")
        try: os.remove(local_path)
        except OSError: pass

def check_and_update_item_completion(order_item_id):
    if not order_item_id: return
    try:
        res = supabase.table('print_jobs').select('job_execution_status').eq('order_item_id', order_item_id).execute()
        jobs = res.data
        if jobs and all(j.get('job_execution_status') == 'completed' for j in jobs):
            supabase.table('order_items').update({
                'item_print_status': 'completed'
            }).eq('id', order_item_id).execute()
            print(f"[+] All print jobs for order item {order_item_id} completed. Updated item status to completed.")
            
            item_res = supabase.table('order_items').select('order_id').eq('id', order_item_id).execute()
            if item_res.data:
                order_id = item_res.data[0].get('order_id')
                if order_id:
                    # Same all-items-done → 'printed' recompute Foreman uses — one
                    # implementation instead of two drifting copies.
                    check_overall_order_status(order_id)
    except Exception as e:
        log_system("error", f"check_and_update_item_completion failed for item {order_item_id}: {e}", agent_name="Waybill Agent")


def sync_simplyprint_printers_and_queue(printers_data, queue_data):
    try:
        active_ids = []
        printer_rows = []
        for p in printers_data:
            p_id = p.get("id")
            p_info = p.get("printer", {})
            job_info = p.get("job")
            
            temps = p_info.get("temps", {})
            current_temps = temps.get("current", {})
            target_temps = temps.get("target", {})
            
            nozzle_temp = current_temps.get("tool", [None])[0] if current_temps.get("tool") else None
            nozzle_target = target_temps.get("tool", [None])[0] if target_temps.get("tool") else None
            bed_temp = current_temps.get("bed")
            bed_target = target_temps.get("bed")
            
            model = p_info.get("model", {})
            
            current_job_name = None
            percent_complete = None
            remaining_seconds = None
            
            if job_info:
                current_job_name = job_info.get("file") or job_info.get("name")
                percent_complete = job_info.get("percentage")
                remaining_seconds = job_info.get("time")
                
            autoprint = p_info.get("autoprint", False)
            autoprint_current_jobs = p_info.get("currentAutoprintJobs")
            autoprint_max_jobs = p_info.get("autoprintMaxJobs")
                
            printer_row = {
                "id": p_id,
                "name": p_info.get("name", "Unknown"),
                "state": p_info.get("state", "unknown"),
                "online": p_info.get("online", False),
                "nozzle_temp": nozzle_temp,
                "nozzle_target": nozzle_target,
                "bed_temp": bed_temp,
                "bed_target": bed_target,
                "model_name": model.get("name"),
                "model_brand": model.get("brand"),
                "current_job_name": current_job_name,
                "percent_complete": percent_complete,
                "remaining_seconds": remaining_seconds,
                "autoprint": autoprint,
                "autoprint_current_jobs": autoprint_current_jobs,
                "autoprint_max_jobs": autoprint_max_jobs,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
            printer_rows.append(printer_row)
            active_ids.append(p_id)

        # One batched upsert instead of a round-trip per printer.
        if printer_rows:
            supabase.table('simplyprint_printers').upsert(printer_rows).execute()
        if active_ids:
            supabase.table('simplyprint_printers').delete().not_.in_('id', active_ids).execute()
    except Exception as pe:
        print(f"[-] Error syncing simplyprint_printers table: {pe}")
        
    try:
        # Upsert current rows by natural key (id), then delete only rows no longer present
        # in the latest fetch — matches the printers-table sync pattern above. Avoids the
        # delete-all-then-reinsert window where a concurrent reader could briefly see an
        # empty queue table.
        active_queue_ids = []
        queue_rows = []
        for idx, q_item in enumerate(queue_data):
            q_id = q_item.get("id")
            duration_seconds = q_item.get("analysis", {}).get("estimate", 0)

            queue_rows.append({
                "id": q_id,
                "name": q_item.get("filename") or q_item.get("name", "Unknown"),
                "position": idx + 1,
                "estimate_seconds": duration_seconds,
                "updated_at": datetime.now(timezone.utc).isoformat()
            })
            active_queue_ids.append(q_id)

        # One batched upsert instead of a round-trip per queue item.
        if queue_rows:
            supabase.table('simplyprint_queue').upsert(queue_rows).execute()
        if active_queue_ids:
            supabase.table('simplyprint_queue').delete().not_.in_('id', active_queue_ids).execute()
        else:
            supabase.table('simplyprint_queue').delete().neq('id', -1).execute()
    except Exception as qe:
        print(f"[-] Error syncing simplyprint_queue table: {qe}")

def sync_simplyprint_jobs():
    api_key = os.getenv("SIMPLYPRINT_API_KEY")
    if not api_key:
        print("[-] SimplyPrint API key not found in environment.")
        return

    headers = {
        "X-API-KEY": api_key,
        "Accept": "application/json",
        "Content-Type": "application/json"
    }
    base_url = f"https://api.simplyprint.io/{SIMPLYPRINT_COMPANY_ID}"

    try:
        res = supabase.table('print_jobs').select('id, simplyprint_job_id, job_execution_status, order_item_id').in_('job_execution_status', ['pending', 'printing']).execute()
        db_jobs = res.data or []
        print(f"[*] Syncing {len(db_jobs)} active print jobs with SimplyPrint...")

        # Fetch printers, queue, and history concurrently
        printers_data = []
        queue_data = []
        history_data = []
        api_calls_succeeded = True

        def _fetch_printers():
            return http_session.post(f"{base_url}/printers/Get", headers=headers, json={}, timeout=10)

        def _fetch_queue():
            return http_session.post(f"{base_url}/queue/GetItems", headers=headers, json={}, timeout=10)

        def _fetch_history():
            # 100 per page: with 50, a busy 5-min window could push finished-but-failed
            # jobs past page 1, where the fallback would mark them completed instead.
            return http_session.post(f"{base_url}/jobs/GetPaginatedPrintJobs", headers=headers, json={"page": 1, "page_size": 100}, timeout=10)

        with ThreadPoolExecutor(max_workers=3) as executor:
            fut_printers = executor.submit(_fetch_printers)
            fut_queue = executor.submit(_fetch_queue)
            fut_history = executor.submit(_fetch_history)

            # A non-200 response is just as much a failure as a raised exception: it must
            # disarm the "not found anywhere → completed" fallback below, or a SimplyPrint
            # auth error/5xx (empty data, no exception) fake-completes every active job.
            try:
                r = fut_printers.result()
                if r.status_code == 200:
                    printers_data = r.json().get("data", [])
                else:
                    print(f"[-] Printers fetch returned HTTP {r.status_code} — treating as failed.")
                    api_calls_succeeded = False
            except Exception as pe:
                print(f"[-] Failed to fetch printers: {pe}")
                api_calls_succeeded = False

            try:
                r = fut_queue.result()
                if r.status_code == 200:
                    queue_data = r.json().get("queue", [])
                else:
                    print(f"[-] Queue fetch returned HTTP {r.status_code} — treating as failed.")
                    api_calls_succeeded = False
            except Exception as qe:
                print(f"[-] Failed to fetch queue: {qe}")
                api_calls_succeeded = False

            try:
                r = fut_history.result()
                if r.status_code == 200:
                    history_data = r.json().get("data", [])
                else:
                    print(f"[-] History fetch returned HTTP {r.status_code} — treating as failed.")
                    api_calls_succeeded = False
            except Exception as he:
                print(f"[-] Failed to fetch history: {he}")
                api_calls_succeeded = False

        active_printer_jobs = {}
        for p in printers_data:
            p_info = p.get("printer", {})
            job_info = p.get("job")
            if job_info and job_info.get("state") == "printing":
                active_printer_jobs[str(job_info.get("id"))] = {
                    "printer_name": p_info.get("name", "Unknown"),
                    "percent_complete": job_info.get("percentage", 0),
                    "remaining_seconds": job_info.get("time", 0)
                }

        queued_jobs = {}
        running_preceding_seconds = 0
        total_printer_backlog_seconds = sum(j["remaining_seconds"] for j in active_printer_jobs.values())
        active_printers_count = sum(1 for p in printers_data if p.get("printer", {}).get("online") and p.get("printer", {}).get("state") in ["operational", "printing", "paused"])
        if active_printers_count == 0:
            active_printers_count = 1

        for idx, q_item in enumerate(queue_data):
            q_id = str(q_item.get("id"))
            duration_seconds = q_item.get("analysis", {}).get("estimate", 0)
            preceding_time_offset = (total_printer_backlog_seconds + running_preceding_seconds) / active_printers_count
            eta_seconds = preceding_time_offset + duration_seconds
            queued_jobs[q_id] = {"queue_position": idx + 1, "eta_seconds": eta_seconds}
            running_preceding_seconds += duration_seconds

        history_jobs = {str(j.get("id")): j for j in history_data}
        sync_simplyprint_printers_and_queue(printers_data, queue_data)

        for job in db_jobs:
            job_db_id = job.get("id")
            sp_job_id = job.get("simplyprint_job_id")

            # Skip placeholder ids that don't correspond to a real SimplyPrint job —
            # they'd fall through to the not-found fallback and be fake-completed.
            if not sp_job_id or not sp_job_id.isdigit():
                continue

            if sp_job_id in active_printer_jobs:
                p_job = active_printer_jobs[sp_job_id]
                eta_time = time.time() + p_job["remaining_seconds"]
                eta_iso = datetime.fromtimestamp(eta_time, tz=timezone.utc).isoformat()
                supabase.table('print_jobs').update({
                    'job_execution_status': 'printing',
                    'printer_name': p_job["printer_name"],
                    'queue_position': None,
                    'percent_complete': p_job["percent_complete"],
                    'estimated_finish_time': eta_iso
                }).eq('id', job_db_id).execute()
                print(f"[+] Updated printing job {sp_job_id}: printer={p_job['printer_name']}, progress={p_job['percent_complete']}%")

            elif sp_job_id in queued_jobs:
                q_job = queued_jobs[sp_job_id]
                eta_time = time.time() + q_job["eta_seconds"]
                eta_iso = datetime.fromtimestamp(eta_time, tz=timezone.utc).isoformat()
                supabase.table('print_jobs').update({
                    'job_execution_status': 'pending',
                    'printer_name': None,
                    'queue_position': q_job["queue_position"],
                    'percent_complete': 0,
                    'estimated_finish_time': eta_iso
                }).eq('id', job_db_id).execute()
                print(f"[+] Updated queued job {sp_job_id}: position={q_job['queue_position']}")

            elif sp_job_id in history_jobs:
                h_job = history_jobs[sp_job_id]
                h_status = h_job.get("status")
                new_status = 'completed' if h_status == 'completed' else 'failed'
                percent = 100 if new_status == 'completed' else 0
                end_date = h_job.get("endDate") or datetime.now(timezone.utc).isoformat()
                supabase.table('print_jobs').update({
                    'job_execution_status': new_status,
                    'queue_position': None,
                    'percent_complete': percent,
                    'estimated_finish_time': end_date
                }).eq('id', job_db_id).execute()
                print(f"[+] Updated historical job {sp_job_id}: status={new_status}")
                if new_status == 'completed':
                    check_and_update_item_completion(job.get("order_item_id"))

            elif api_calls_succeeded:
                # Only apply the "not found anywhere = completed" fallback when ALL three
                # API calls succeeded; a partial failure could cause active jobs to be
                # prematurely marked done (the history page only covers the last 50 jobs).
                supabase.table('print_jobs').update({
                    'job_execution_status': 'completed',
                    'percent_complete': 100,
                    'estimated_finish_time': datetime.now(timezone.utc).isoformat()
                }).eq('id', job_db_id).execute()
                check_and_update_item_completion(job.get("order_item_id"))
                print(f"[?] Job {sp_job_id} not found in active/queue/history. Marking completed as fallback.")
            else:
                print(f"[?] Job {sp_job_id} not found, but API calls had errors — skipping fallback to avoid false completion.")

    except Exception as e:
        print(f"[-] Error in sync_simplyprint_jobs: {e}")

_last_retention_cleanup_day = None

def run_retention_cleanup():
    """Purge old completed/log records to prevent unbounded table growth."""
    global _last_retention_cleanup_day
    today = date.today()
    if _last_retention_cleanup_day == today: return
    
    print("[*] Running daily data retention cleanup...")
    try:
        cutoff_90 = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
        cutoff_60 = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
        
        wj = supabase.table('waybill_jobs').delete().eq('status', 'completed').lt('updated_at', cutoff_90).execute()
        print(f"[+] Retention: removed {len(wj.data or [])} completed waybill_jobs older than 90d")
        
        pj = supabase.table('print_jobs').delete().eq('job_execution_status', 'completed').lt('updated_at', cutoff_90).execute()
        print(f"[+] Retention: removed {len(pj.data or [])} completed print_jobs older than 90d")
        
        sl = supabase.table('system_logs').delete().in_('log_level', ['info', 'warning']).lt('created_at', cutoff_60).execute()
        print(f"[+] Retention: removed {len(sl.data or [])} info/warning system_logs older than 60d")
        
        gl = supabase.table('gemini_usage_log').delete().lt('created_at', cutoff_90).execute()
        print(f"[+] Retention: removed {len(gl.data or [])} gemini_usage_log entries older than 90d")
        
        _last_retention_cleanup_day = today
        print("[+] Data retention cleanup complete.")
    except Exception as e:
        print(f"[-] Error during retention cleanup: {e}")

# ----------------- SECTION 5: Async Event-Loop Telemetry & Poller Tasks -----------------

async def run_waybill_daemon_async():
    """Runs the Waybill Daemon loop inside the asyncio event loop cooperatively.

    This loop also owns SimplyPrint telemetry, retention cleanup, and the orbot_service
    heartbeat — none of which need Google Drive. Drive auth therefore happens lazily per
    waybill job (get_drive_service caches after the first success) instead of
    authenticate-or-die at startup, which used to kill all four responsibilities until
    the next redeploy whenever Drive auth hiccuped."""
    print("[*] Starting Waybill/Telemetry daemon async task...")

    # Reap jobs stranded in 'processing' by a crash/redeploy mid-job: the poll loop only
    # ever claims 'pending' rows, so stranded jobs would sit 'processing' forever. They're
    # marked failed rather than re-queued to avoid crash-looping on a job that killed the
    # process — the loud error log makes them easy to re-trigger manually.
    try:
        stale = await asyncio.to_thread(
            supabase.table('waybill_jobs').update({
                'status': 'failed',
                'result': {'error': 'Job was stuck in processing at daemon startup '
                                    '(likely interrupted by a restart/redeploy) — re-trigger manually.'}
            }).eq('status', 'processing').execute
        )
        if stale.data:
            msg = (f"Reaped {len(stale.data)} stale 'processing' waybill job(s) at startup: "
                   f"{[j['id'] for j in stale.data]}")
            print(f"[!] {msg}")
            await asyncio.to_thread(log_system_waybill, "error", msg)
    except Exception as e:
        print(f"[-] Stale-job reaper failed: {e}")

    last_sp_sync_time = 0
    last_heartbeat_time = 0.0
    while True:
        # Heartbeat at most every 30s — writing on every 5s poll iteration was ~17k
        # upserts/day for no freshness benefit (staleness alerts use minutes-scale
        # thresholds).
        if time.time() - last_heartbeat_time >= 30:
            try:
                await asyncio.to_thread(write_heartbeat, 'orbot_service')
                last_heartbeat_time = time.time()
            except Exception as e:
                print(f"[-] Failed to update daemon heartbeat: {e}")
            
        current_time = time.time()
        if current_time - last_sp_sync_time >= 300:
            try:
                await asyncio.to_thread(sync_simplyprint_jobs)
                last_sp_sync_time = current_time
            except Exception as spe:
                print(f"[-] Error syncing SimplyPrint status: {spe}")

            try:
                await asyncio.to_thread(run_retention_cleanup)
            except Exception as rce:
                print(f"[-] Error during retention cleanup: {rce}")
                
        try:
            # Query oldest pending job
            res = await asyncio.to_thread(
                supabase.table('waybill_jobs').select('*').eq('status', 'pending').order('created_at', desc=False).limit(1).execute
            )
            if res.data:
                job = res.data[0]
                job_id = job['id']
                job_type = job['job_type']
                payload = job.get('payload') or {}

                # Atomic claim: only proceed if this call is the one that actually flips
                # status pending -> processing. If another worker claimed it first (zero
                # rows updated), skip it instead of processing it twice.
                claim_res = await asyncio.to_thread(
                    supabase.table('waybill_jobs').update({'status': 'processing'})
                    .eq('id', job_id).eq('status', 'pending').execute
                )
                if not claim_res.data:
                    print(f"[*] Job {job_id} was already claimed by another worker — skipping.")
                    await asyncio.sleep(5)
                    continue

                print(f"[*] Processing job {job_id} of type '{job_type}'...")

                try:
                    result_data = {}
                    if job_type in ('waybill_ingest', 'waybill_batch_print'):
                        # Always get a fresh Drive service so the OAuth token is current
                        fresh_drive = await asyncio.to_thread(get_drive_service)
                    if job_type == 'waybill_ingest':
                        file_name = payload.get('file_name')
                        if file_name:
                            print(f"[*] Downloading file {file_name} from Supabase Storage...")
                            # basename: file_name comes from the job payload — never let it
                            # traverse outside /tmp. (It stays untouched as the storage key.)
                            local_path = f"/tmp/{os.path.basename(file_name)}"
                            res_storage = await asyncio.to_thread(supabase.storage.from_('incoming-waybills').download, file_name)
                            with open(local_path, 'wb') as f:
                                f.write(res_storage)
                            await asyncio.to_thread(process_ingestion, fresh_drive, local_path)
                            try:
                                await asyncio.to_thread(supabase.storage.from_('incoming-waybills').remove, [file_name])
                            except Exception as se:
                                print(f"[-] Failed to delete file from storage: {se}")
                        else:
                            await asyncio.to_thread(run_incoming_scan, fresh_drive)

                    elif job_type == 'waybill_batch_print':
                        batch_url = await asyncio.to_thread(run_batch_print, fresh_drive)
                        result_data['url'] = batch_url
                            
                    elif job_type == 'scout_gmail_scan':
                        print("[*] Executing Scout Gmail scan...")
                        await asyncio.to_thread(_trigger_scout_scan)
                        await asyncio.to_thread(write_heartbeat, 'orbot_service')
                        print("[+] Scout Gmail scan completed successfully.")
                        
                    elif job_type == 'sync_simplyprint_ids':
                        print("[*] Executing SimplyPrint IDs sync...")
                        result_data = await asyncio.to_thread(run_sync_simplyprint_ids)
                        await asyncio.to_thread(write_heartbeat, 'orbot_service')
                        print("[+] SimplyPrint IDs sync completed successfully.")
                        
                    elif job_type == 'ready_all_printers':
                        print("[*] Marking all printers as ready...")
                        await asyncio.to_thread(
                            supabase.table('simplyprint_printers').update({
                                'state': 'operational', 'percent_complete': None, 'current_job_name': None, 'remaining_seconds': None
                            }).neq('id', -1).execute
                        )
                        print("[+] All printers marked as ready.")
                        try:
                            await asyncio.to_thread(sync_simplyprint_jobs)
                        except Exception as se:
                            print(f"[-] Telemetry sync after ready_all failed: {se}")
                            
                    elif job_type == 'clear_cycles':
                        printer_id = payload.get('printer_id')
                        if printer_id:
                            print(f"[*] Clearing autoprint cycle count for printer {printer_id}...")
                            await asyncio.to_thread(supabase.table('simplyprint_printers').update({'autoprint_current_jobs': 0}).eq('id', printer_id).execute)
                        else:
                            print("[*] Clearing autoprint cycle count for all printers...")
                            await asyncio.to_thread(supabase.table('simplyprint_printers').update({'autoprint_current_jobs': 0}).neq('id', -1).execute)
                        print("[+] Autoprint cycle counts cleared.")
                        try:
                            await asyncio.to_thread(sync_simplyprint_jobs)
                        except Exception as se:
                            print(f"[-] Telemetry sync after clear_cycles failed: {se}")
                            
                    elif job_type == 'estop_all_printers':
                        print("[*] EMERGENCY STOP ALL triggered! Stopping all printers...")
                        p_res = await asyncio.to_thread(supabase.table('simplyprint_printers').select('id').execute)
                        api_key = os.getenv("SIMPLYPRINT_API_KEY")
                        company_id = SIMPLYPRINT_COMPANY_ID
                        headers = {"X-API-KEY": api_key or "", "Accept": "application/json"}
                        for p in p_res.data:
                            p_id = p['id']
                            try:
                                print(f"[*] Sending Cancel print request for printer {p_id}...")
                                await asyncio.to_thread(http_session.post, f"https://api.simplyprint.io/{company_id}/printers/actions/Cancel?pid={p_id}", headers=headers, timeout=10)
                            except Exception as ce:
                                print(f"[-] SimplyPrint Cancel call failed for printer {p_id}: {ce}")
                        await asyncio.to_thread(
                            supabase.table('simplyprint_printers').update({
                                'state': 'offline', 'percent_complete': None, 'current_job_name': None, 'remaining_seconds': None
                            }).neq('id', -1).execute
                        )
                        print("[+] All printers marked as offline via E-Stop.")
                        try:
                            await asyncio.to_thread(sync_simplyprint_jobs)
                        except Exception as se:
                            print(f"[-] Telemetry sync after estop_all failed: {se}")
                            
                    elif job_type == 'printer_control':
                        printer_id = payload.get('printer_id')
                        action = payload.get('action')
                        if not printer_id or not action:
                            raise ValueError("printer_id and action are required in payload.")
                        
                        api_key = os.getenv("SIMPLYPRINT_API_KEY")
                        company_id = SIMPLYPRINT_COMPANY_ID
                        headers = {"X-API-KEY": api_key or "", "Accept": "application/json"}
                        print(f"[*] Printer control action '{action}' for printer {printer_id}...")
                        
                        if action == 'ready':
                            await asyncio.to_thread(
                                supabase.table('simplyprint_printers').update({
                                    'state': 'operational', 'percent_complete': None, 'current_job_name': None, 'remaining_seconds': None
                                }).eq('id', printer_id).execute
                            )
                        elif action == 'pause':
                            await asyncio.to_thread(http_session.post, f"https://api.simplyprint.io/{company_id}/printers/actions/Pause?pid={printer_id}", headers=headers, timeout=10)
                            await asyncio.to_thread(supabase.table('simplyprint_printers').update({'state': 'paused'}).eq('id', printer_id).execute)
                        elif action == 'resume':
                            await asyncio.to_thread(http_session.post, f"https://api.simplyprint.io/{company_id}/printers/actions/Resume?pid={printer_id}", headers=headers, timeout=10)
                            await asyncio.to_thread(supabase.table('simplyprint_printers').update({'state': 'printing'}).eq('id', printer_id).execute)
                        elif action == 'estop':
                            await asyncio.to_thread(http_session.post, f"https://api.simplyprint.io/{company_id}/printers/actions/Cancel?pid={printer_id}", headers=headers, timeout=10)
                            await asyncio.to_thread(
                                supabase.table('simplyprint_printers').update({
                                    'state': 'offline', 'percent_complete': None, 'current_job_name': None, 'remaining_seconds': None
                                }).eq('id', printer_id).execute
                            )
                        elif action == 'clear_cycles':
                            await asyncio.to_thread(supabase.table('simplyprint_printers').update({'autoprint_current_jobs': 0}).eq('id', printer_id).execute)
                        else:
                            raise ValueError(f"Unknown printer control action: {action}")
                        
                        print(f"[+] Printer control action '{action}' completed.")
                        try:
                            await asyncio.to_thread(sync_simplyprint_jobs)
                        except Exception as se:
                            print(f"[-] Telemetry sync after control command failed: {se}")
                    else:
                        raise ValueError(f"Unknown job type: {job_type}")
                        
                    await asyncio.to_thread(
                        supabase.table('waybill_jobs').update({
                            'status': 'completed', 'result': result_data
                        }).eq('id', job_id).execute
                    )
                    print(f"[+] Job {job_id} completed successfully.")
                    
                except Exception as je:
                    print(f"[-] Job {job_id} failed: {je}")
                    await asyncio.to_thread(
                        supabase.table('waybill_jobs').update({
                            'status': 'failed', 'result': {'error': str(je)}
                        }).eq('id', job_id).execute
                    )
                    await asyncio.to_thread(log_system_waybill, "error", f"Daemon job {job_id} failed: {je}")
        except Exception as e:
            print(f"[-] Error in daemon loop iteration: {e}")
            
        await asyncio.sleep(5)

async def run_scout_periodic_async():
    """Runs the periodic Scout Gmail polling loop in the asyncio event loop.
    Legacy fallback used only when GMAIL_PUBSUB_TOPIC is not configured."""
    print("[*] Scout Periodic Gmail Polling async task started.")
    while True:
        try:
            agent = await asyncio.to_thread(ScoutAgent)
            await asyncio.to_thread(agent.run)
            await asyncio.to_thread(write_heartbeat, 'scout')
        except Exception as e:
            print(f"Scout Periodic Poll Error: {e}")
        await asyncio.sleep(300)

async def run_gmail_watch_renewal_async():
    """Event-driven Scout: keeps the Gmail push-notification watch alive. Registers the
    watch immediately on startup, then renews daily (Gmail watches expire after ~7 days).
    Actual scanning is triggered by the /gmail/notifications webhook, not this loop."""
    print("[*] Gmail watch renewal task started (event-driven Scout).")
    while True:
        try:
            agent = await asyncio.to_thread(ScoutAgent)
            resp = await asyncio.to_thread(agent.start_watch)
            if resp:
                await asyncio.to_thread(write_heartbeat, 'scout')
        except Exception as e:
            print(f"Gmail watch renewal error: {e}")
        # Renew once a day — comfortably inside the ~7-day watch expiry.
        await asyncio.sleep(24 * 60 * 60)


async def run_scout_backstop_async():
    """Event-driven Scout safety net. In push mode the webhook drives scans, but a dropped
    Pub/Sub delivery or a transient Gemini error (which leaves the email unread) would
    otherwise wait for an unrelated inbox change to fire the next push. This loop runs a
    coalescing scan every 5 min so nothing sits unprocessed indefinitely. It routes through
    _trigger_scout_scan(), so it shares the same lock as webhook scans and never runs
    concurrently with one."""
    print("[*] Scout backstop scan task started (event-driven safety net, every 5 min).")
    while True:
        await asyncio.sleep(300)
        try:
            await asyncio.to_thread(_trigger_scout_scan)
            await asyncio.to_thread(write_heartbeat, 'scout')
        except Exception as e:
            print(f"Scout backstop scan error: {e}")


# ----------------- Foreman Dispatch (ported from Edge Function) -----------------

def filter_print_files(print_files: list, variant_name: Optional[str]) -> list:
    """Selects the right print files to dispatch: dedup by SP file ID, orientation filter, prefer A1M slices."""
    if not print_files:
        return []

    # 1. Deduplicate by simplyprint_file_id
    unique_files, seen_sp_ids = [], set()
    for f in print_files:
        sp_id = f.get('simplyprint_file_id')
        if sp_id:
            if sp_id in seen_sp_ids:
                continue
            seen_sp_ids.add(sp_id)
        unique_files.append(f)

    # 2. Orientation filter
    filtered = unique_files
    if variant_name:
        v = variant_name.lower()
        is_vert = any(kw in v for kw in ['vert', 'vertical', 'vfwm', 'vwm'])
        is_horiz = any(kw in v for kw in ['horiz', 'horizontal', 'hfwm', 'hwm'])
        if is_vert or is_horiz:
            def _keep(f):
                n = f['print_file_name'].lower()
                v_file = any(kw in n for kw in ['vfwm', 'vwm', 'vert', '-v-', '_v_'])
                h_file = any(kw in n for kw in ['hfwm', 'hwm', 'horiz', '-h-', '_h_'])
                if is_vert and h_file and not v_file: return False
                if is_horiz and v_file and not h_file: return False
                return True
            filtered = [f for f in unique_files if _keep(f)]

    # 3. Split into main bodies and plates, then prefer A1M slices within each group
    plates = [f for f in filtered if 'plate' in f['print_file_name'].lower()]
    mains  = [f for f in filtered if 'plate' not in f['print_file_name'].lower()]

    def _filter_slices(files):
        if len(files) <= 1: return files
        has_a1m = any('a1m' in f['print_file_name'].lower() or 'mini' in f['print_file_name'].lower() for f in files)
        if has_a1m:
            return [f for f in files if not ('a1' in f['print_file_name'].lower()
                                              and 'a1m' not in f['print_file_name'].lower()
                                              and 'mini' not in f['print_file_name'].lower())]
        return files

    def _process_group(files):
        if not files: return []
        groups: dict = {}
        for f in files:
            m = re.search(r'(?:\(|_|\b)(?:part|pt|p)?\s*([1-9])\s*(?:\)|\b)', f['print_file_name'].lower())
            idx = m.group(1) if m else 'default'
            groups.setdefault(idx, []).append(f)
        has_numbered_a1m = any(
            idx != 'default' and any('a1m' in f['print_file_name'].lower() or 'mini' in f['print_file_name'].lower() for f in gf)
            for idx, gf in groups.items()
        )
        if has_numbered_a1m:
            groups.pop('default', None)
        result = []
        for gf in groups.values():
            chosen = _filter_slices(gf)
            if len(chosen) == 1:
                result.append(chosen[0])
            elif len(chosen) > 1:
                result.append(max(chosen, key=lambda f: len(f['print_file_name'])))
        return result

    return _process_group(mains) + _process_group(plates)


def check_overall_order_status(order_id: str):
    """Updates an order's overall_order_status based on the state of its items."""
    res = supabase.table('order_items').select('item_print_status').eq('order_id', order_id).execute()
    items = res.data or []
    if not items:
        return
    DONE_STATUSES = {'completed', 'not_applicable'}
    if all(i['item_print_status'] in DONE_STATUSES for i in items):
        supabase.table('orders').update({'overall_order_status': 'printed'}).eq('id', order_id).execute()
    elif all(i['item_print_status'] in ('printing', 'completed', 'not_applicable') for i in items):
        supabase.table('orders').update({'overall_order_status': 'printing'}).eq('id', order_id).execute()


#
# Print sequencing guarantee: pending order_items are sorted by their parent order's
# order_timestamp (oldest first) and dispatched to SimplyPrint with "position": "bottom",
# so a single, uninterrupted dispatch pass appends jobs in order-arrival order. Two things
# could break that guarantee, and this lock + logging address them:
#
#   1. Concurrent dispatch runs. run_foreman_dispatch is triggered from two places — auto-
#      dispatch after every Scout-ingested order, and the manual "Dispatch Prints" button
#      (/foreman/dispatch). Without serialization, a manual click during a slow in-flight
#      auto-dispatch (large orders take 10-60s due to the 1s/file SimplyPrint rate limit)
#      could interleave AddItem calls in wall-clock order instead of order-arrival order.
#      _foreman_dispatch_lock forces every call to fully complete before the next begins —
#      each call re-queries pending items fresh, so this is cheap and correct even when a
#      queued-up call finds nothing left to do.
#
#   2. A single bad item shouldn't block the whole print farm. If the OLDEST pending item
#      fails (e.g. missing print files) it's put back to 'pending' and retried on the next
#      pass, but the loop continues to newer items rather than halting everyone behind it
#      (chosen deliberately: blocking all fulfillment on one bad data row is worse than a
#      brief, visible sequence skip). _log_sequence_skip_if_needed makes that skip loud —
#      logged with both the stuck order and the order that jumped ahead — instead of silent.
#
# Not fixable in software: A1-mini and regular-A1 printers are disjoint queues
# (for_printers groups jobs by physical printer capability), so FIFO can only be
# guaranteed within each printer-capability group, not globally across incompatible
# hardware — an order needing a busy printer type cannot block an idle one.
#
_foreman_dispatch_lock = threading.Lock()

def run_foreman_dispatch(dry_run: bool = False) -> dict:
    """Dispatches pending order items to SimplyPrint in order-arrival sequence. Serializes
    concurrent callers (see module comment above) so runs never interleave."""
    with _foreman_dispatch_lock:
        return _run_foreman_dispatch_locked(dry_run=dry_run)

def _restock_variant(variant_id: str, qty: int, max_attempts: int = 5) -> None:
    """Atomically adds qty back to variants.stock_quantity (compare-and-swap retry loop,
    same pattern as the decrement in _run_foreman_dispatch_locked)."""
    for _ in range(max_attempts):
        cur_res = supabase.table('variants').select('stock_quantity').eq('id', variant_id).single().execute()
        cur = (cur_res.data or {}).get('stock_quantity') or 0
        upd = supabase.table('variants') \
            .update({'stock_quantity': cur + qty}) \
            .eq('id', variant_id).eq('stock_quantity', cur) \
            .execute()
        if upd.data:
            return
    raise RuntimeError(f"Could not restock variant {variant_id} (+{qty}) after {max_attempts} attempts.")


def _sp_dispatch_enabled() -> bool:
    """Reads the shared sp_dispatch_enabled kill switch from app_settings.
    Fails open (enabled) on read errors, matching /config's behavior."""
    try:
        res = supabase.table("app_settings").select("value").eq("key", "sp_dispatch_enabled").limit(1).execute()
        if res.data:
            return res.data[0]["value"] != "false"
    except Exception as e:
        logging.warning(f"Failed to load app_settings.sp_dispatch_enabled, defaulting to enabled: {e}")
    return True


def _run_foreman_dispatch_locked(dry_run: bool = False) -> dict:
    """Fetches pending order items and dispatches their print files to the SimplyPrint queue."""
    # Server-side kill switch: gates EVERY dispatch path (Scout auto-dispatch included),
    # not just browser-initiated calls that pass dry_run. When disabled, this must be a
    # true no-op — no stock decrements, no print_jobs rows, no status changes — so items
    # stay 'pending' and dispatch cleanly when the switch is turned back on.
    if not _sp_dispatch_enabled():
        logger.info("[Foreman] Dispatch skipped: sp_dispatch_enabled is false.")
        return {"status": "skipped",
                "message": "SimplyPrint dispatch is disabled (sp_dispatch_enabled=false). No items were dispatched or modified."}

    if dry_run:
        # True no-op preview: report what would be dispatched without mutating anything.
        # (Previously dry_run still decremented stock, inserted DRY_RUN print_jobs rows and
        # flipped items to 'printing' — which telemetry then fake-completed.)
        res = supabase.table('order_items') \
            .select('id, orders!inner(overall_order_status)') \
            .eq('item_print_status', 'pending') \
            .filter('variant_id', 'not.is', 'null') \
            .execute()
        n = len([i for i in (res.data or [])
                 if i.get('orders', {}).get('overall_order_status') in ('pending', 'printing')])
        return {"status": "dry_run", "pending_items": n,
                "message": f"[DRY RUN] {n} pending order item(s) would be dispatched. Nothing was modified."}

    api_key = os.getenv("SIMPLYPRINT_API_KEY")
    if not api_key:
        raise ValueError("SIMPLYPRINT_API_KEY is not set.")

    sp_headers = {"X-API-KEY": api_key, "Content-Type": "application/json"}
    base_url = f"https://api.simplyprint.io/{SIMPLYPRINT_COMPANY_ID}"

    res = supabase.table('order_items') \
        .select('*, orders!inner(platform_order_id, order_timestamp, created_at, overall_order_status)') \
        .eq('item_print_status', 'pending') \
        .filter('variant_id', 'not.is', 'null') \
        .execute()
    pending_items = [
        item for item in (res.data or [])
        if item.get('orders', {}).get('overall_order_status') in ('pending', 'printing')
    ]

    if not pending_items:
        return {"status": "success", "message": "No pending order items to dispatch."}

    pending_items.sort(key=lambda item: (
        item.get('orders', {}).get('order_timestamp') or item.get('orders', {}).get('created_at') or '9999',
        item.get('created_at', '9999')
    ))

    total_files_dispatched = 0
    total_fulfilled_from_stock = 0
    processed_item_ids = []
    # Tracks orders whose item failed and was reverted to 'pending' earlier in THIS pass
    # (agreed policy: skip and continue rather than block the whole queue — see module
    # comment above run_foreman_dispatch). If a newer order's item then dispatches/
    # completes while an older one is stuck, that's a real sequence inversion — flag it
    # loudly instead of letting it pass silently.
    skipped_orders = []

    def _flag_if_jumped_ahead(current_item):
        if not skipped_orders:
            return
        current_order_id = current_item.get('orders', {}).get('platform_order_id', current_item.get('order_id'))
        stuck = ", ".join(f"{s['platform_order_id']} ({s['reason']})" for s in skipped_orders)
        msg = (f"Sequence skip: order {current_order_id} dispatched ahead of earlier "
               f"order(s) still pending due to a prior failure this pass: {stuck}")
        logger.warning(f"[Foreman] {msg}")
        log_system('warning', msg, agent_name='Foreman')

    for item in pending_items:
        lock_res = supabase.table('order_items') \
            .update({'item_print_status': 'printing'}) \
            .eq('id', item['id']).eq('item_print_status', 'pending') \
            .execute()
        if not lock_res.data:
            continue

        item_files_dispatched = 0
        remaining_to_print = item['purchased_quantity']
        fulfilled_from_stock = 0

        try:
            var_res = supabase.table('variants') \
                .select('variant_sku, variant_name, stock_quantity') \
                .eq('id', item['variant_id']).single().execute()
            variant = var_res.data
            if not variant:
                raise ValueError(f"Variant {item['variant_id']} not found.")

            stock_qty = variant.get('stock_quantity') or 0

            # Atomic conditional decrement instead of read-then-write: the .eq(...).gte(...)
            # predicate is evaluated by Postgres at update time, so a concurrent dispatcher
            # decrementing the same variant can't cause both callers to believe they
            # fulfilled from the same stock (lost-update race). We retry with a smaller
            # attempted amount, re-checking freshly each time, until either the update
            # succeeds or there's no stock left worth attempting.
            attempt_qty = min(remaining_to_print, stock_qty) if stock_qty > 0 else 0
            while attempt_qty > 0:
                upd_res = supabase.table('variants') \
                    .update({'stock_quantity': stock_qty - attempt_qty}) \
                    .eq('id', item['variant_id']) \
                    .gte('stock_quantity', attempt_qty) \
                    .execute()
                if upd_res.data:
                    fulfilled_from_stock = attempt_qty
                    remaining_to_print -= fulfilled_from_stock
                    log_system('info', f"Fulfilled {fulfilled_from_stock}x {variant['variant_sku']} from stock. "
                                        f"Remaining to print: {remaining_to_print}. New stock: {stock_qty - attempt_qty}.",
                               agent_name='Foreman')
                    break
                # Someone else changed stock_quantity between our read and this update —
                # re-read the current value and retry with the new ceiling.
                refresh_res = supabase.table('variants').select('stock_quantity').eq('id', item['variant_id']).single().execute()
                stock_qty = (refresh_res.data or {}).get('stock_quantity') or 0
                attempt_qty = min(remaining_to_print, stock_qty) if stock_qty > 0 else 0

            if remaining_to_print == 0:
                supabase.table('order_items').update({
                    'item_print_status': 'completed',
                    'sent_to_print_timestamp': datetime.now(timezone.utc).isoformat()
                }).eq('id', item['id']).execute()
                check_overall_order_status(item['order_id'])
                total_fulfilled_from_stock += fulfilled_from_stock
                processed_item_ids.append(item['id'])
                _flag_if_jumped_ahead(item)
                continue

            files_res = supabase.table('print_files') \
                .select('id, simplyprint_file_id, print_file_name') \
                .eq('variant_id', item['variant_id']).execute()
            all_files = files_res.data or []
            if not all_files:
                raise ValueError(f"No print files found for variant {item['variant_id']}.")

            print_files = filter_print_files(all_files, variant.get('variant_name'))

            # Snapshot of already-created jobs per print file for this item (left by a
            # prior partially-failed pass) — dispatch only tops up to the purchased
            # quantity. One query instead of one per file per unit; equivalent to the
            # old per-iteration re-query because rows inserted below grow in lockstep
            # with q, so the skip decision only ever depends on the pre-existing count.
            existing_jobs_res = supabase.table('print_jobs') \
                .select('print_file_id').eq('order_item_id', item['id']).execute()
            existing_counts: dict = {}
            for row in (existing_jobs_res.data or []):
                pf_id = row.get('print_file_id')
                existing_counts[pf_id] = existing_counts.get(pf_id, 0) + 1

            for q in range(remaining_to_print):
                for file in print_files:
                    if not file.get('simplyprint_file_id'):
                        log_system('warning', f"Missing SimplyPrint File ID for print file {file['id']}.", agent_name='Foreman')
                        continue

                    if existing_counts.get(file['id'], 0) > q:
                        continue

                    if total_files_dispatched > 0:
                        time.sleep(1)

                    for_printers = route_printers_for_file(file['print_file_name'])

                    sp_res = http_session.post(f"{base_url}/queue/AddItem", headers=sp_headers, json={
                        "filesystem": file['simplyprint_file_id'],
                        "amount": 1,
                        "for_printers": for_printers,
                        "position": "bottom"
                    }, timeout=15)

                    if not sp_res.ok:
                        raise ValueError(f"SimplyPrint AddItem failed for {file['print_file_name']}: HTTP {sp_res.status_code}")

                    sp_job_id = str(sp_res.json().get('created_id', 'UNKNOWN_JOB_ID'))
                    supabase.table('print_jobs').insert({
                        'order_item_id': item['id'],
                        'print_file_id': file['id'],
                        'print_file_name': file['print_file_name'],
                        'simplyprint_job_id': sp_job_id,
                        'job_execution_status': 'pending'
                    }).execute()

                    item_files_dispatched += 1
                    total_files_dispatched += 1

            supabase.table('order_items').update({
                'item_print_status': 'printing',
                'sent_to_print_timestamp': datetime.now(timezone.utc).isoformat()
            }).eq('id', item['id']).execute()
            check_overall_order_status(item['order_id'])
            processed_item_ids.append(item['id'])
            log_system('info', f"Dispatched {item_files_dispatched} file(s) for order item {item['id']}.", agent_name='Foreman')
            _flag_if_jumped_ahead(item)

        except Exception as e:
            logger.error(f"Foreman error on item {item['id']}: {e}")
            supabase.table('order_items').update({'item_print_status': 'pending'}).eq('id', item['id']).execute()
            # Roll back this pass's stock decrement: the item is back to 'pending' and the
            # next pass restarts from the full purchased_quantity, so leaving the decrement
            # in place would both lose stock and over-print on retry.
            if fulfilled_from_stock > 0:
                try:
                    _restock_variant(item['variant_id'], fulfilled_from_stock)
                    log_system('warning', f"Rolled back stock decrement of {fulfilled_from_stock} for variant "
                                          f"{item['variant_id']} after dispatch failure.", agent_name='Foreman')
                except Exception as re_err:
                    log_system('error', f"FAILED to roll back stock decrement of {fulfilled_from_stock} for variant "
                                        f"{item['variant_id']}: {re_err}. Stock is now understated.", agent_name='Foreman')
            log_system('error', f"Error processing item {item['id']}: {e}", agent_name='Foreman')
            order_pid = item.get('orders', {}).get('platform_order_id', item.get('order_id'))
            skipped_orders.append({'platform_order_id': order_pid, 'reason': str(e)})

    return {
        "status": "success",
        "processed_items_count": len(processed_item_ids),
        "files_dispatched": total_files_dispatched,
        "fulfilled_from_stock": total_fulfilled_from_stock
    }


def _do_cancel_order(order_id: str, platform_order_id: Optional[str] = None) -> dict:
    """Shared logic: cancel SimplyPrint jobs and mark an order cancelled in the database.

    Tracks success/failure per print job's SimplyPrint DeleteItem/Cancel call. Only jobs
    whose own SimplyPrint call succeeded (or that had no real SimplyPrint job to cancel)
    are deleted from print_jobs. Jobs whose cancellation could not be confirmed are left
    in place with job_execution_status='failed' and logged, so a printer that's
    still actually printing doesn't silently show as "cancelled" in the UI. The overall
    order is only marked 'cancelled' when there were no hard failures; otherwise it's set
    to 'hold' so the unresolved job is surfaced for manual follow-up.
    """
    api_key = os.getenv("SIMPLYPRINT_API_KEY")
    sp_headers = {"X-API-KEY": api_key, "Accept": "application/json"} if api_key else {}
    company_id = SIMPLYPRINT_COMPANY_ID

    if not platform_order_id:
        r = supabase.table('orders').select('platform_order_id').eq('id', order_id).limit(1).execute()
        platform_order_id = (r.data[0] if r.data else {}).get('platform_order_id', order_id)

    items_res = supabase.table('order_items').select('id').eq('order_id', order_id).execute()
    order_items = items_res.data or []

    active_printers = []
    printers_fetch_ok = False
    if api_key:
        try:
            r_pr = http_session.post(f"https://api.simplyprint.io/{company_id}/printers/Get", headers=sp_headers, json={}, timeout=10)
            if r_pr.status_code == 200:
                active_printers = r_pr.json().get("data", [])
                printers_fetch_ok = True
        except Exception as pe:
            logger.error(f"Failed to fetch SimplyPrint printers: {pe}")

    cancelled_job_ids = []
    failed_job_ids = []

    for item in order_items:
        jobs_res = supabase.table('print_jobs').select('id, simplyprint_job_id').eq('order_item_id', item['id']).execute()
        for job in (jobs_res.data or []):
            job_row_id = job['id']
            sp_job_id = job.get('simplyprint_job_id')

            # No real SimplyPrint job was ever created for this row — nothing to cancel
            # remotely, safe to remove.
            if not sp_job_id or sp_job_id == "UNKNOWN_JOB_ID" or sp_job_id.startswith("MOCK_"):
                cancelled_job_ids.append(job_row_id)
                continue

            if not api_key:
                # Can't confirm cancellation without the API key — don't pretend it worked.
                failed_job_ids.append(job_row_id)
                log_system('error', f"Cannot cancel SimplyPrint job {sp_job_id}: SIMPLYPRINT_API_KEY not set.",
                           agent_name='Cancellation')
                continue

            job_cancelled = False
            try:
                r_q = http_session.post(f"https://api.simplyprint.io/{company_id}/queue/DeleteItem?job={sp_job_id}", headers=sp_headers, timeout=10)
                if r_q.status_code == 200:
                    job_cancelled = True
                else:
                    # Not in the queue anymore — check if it's actively printing and stop it.
                    for p in active_printers:
                        p_job = p.get("job")
                        if p_job and str(p_job.get("id")) == str(sp_job_id):
                            pid = p.get("printer", {}).get("id")
                            if pid:
                                r_c = http_session.post(f"https://api.simplyprint.io/{company_id}/printers/actions/Cancel?pid={pid}", headers=sp_headers, timeout=10)
                                job_cancelled = r_c.status_code == 200
                            break
                    else:
                        # DeleteItem failed and the job isn't on any active printer either —
                        # most likely it already finished/was removed. But that conclusion is
                        # only safe if we actually saw the printer list; if the printers fetch
                        # failed, the job's state is unknown and claiming success could leave
                        # a printer physically printing a "cancelled" order.
                        job_cancelled = printers_fetch_ok
            except Exception as je:
                logger.error(f"Error cancelling SimplyPrint job {sp_job_id}: {je}")
                job_cancelled = False

            if job_cancelled:
                cancelled_job_ids.append(job_row_id)
            else:
                failed_job_ids.append(job_row_id)
                log_system('error', f"Failed to cancel SimplyPrint job {sp_job_id} (print_job {job_row_id}) "
                                    f"for order {platform_order_id} — leaving job in place.",
                           agent_name='Cancellation')

    if cancelled_job_ids:
        supabase.table('print_jobs').delete().in_('id', cancelled_job_ids).execute()
    if failed_job_ids:
        # 'failed' — chk_job_execution_status only allows pending/printing/completed/failed;
        # writing 'cancel_failed' raised 23514 and aborted before the order could be held
        supabase.table('print_jobs').update({'job_execution_status': 'failed'}).in_('id', failed_job_ids).execute()

    if failed_job_ids:
        # Don't silently show "cancelled" while a printer may still be printing — surface
        # the order for manual follow-up instead.
        supabase.table('orders').update({"overall_order_status": "hold"}).eq('id', order_id).execute()
        log_system('error', f"Order {platform_order_id} cancel incomplete — {len(failed_job_ids)} print job(s) "
                            f"could not be confirmed cancelled. Order set to 'hold' for manual review.",
                   agent_name='Cancellation')
        return {"cancelled": False, "platform_order_id": platform_order_id,
                "failed_job_count": len(failed_job_ids), "cancelled_job_count": len(cancelled_job_ids)}

    supabase.table('orders').update({"overall_order_status": "cancelled"}).eq('id', order_id).execute()
    log_system('info', f"Cancelled order {platform_order_id}.", agent_name='Cancellation')
    return {"cancelled": True, "platform_order_id": platform_order_id,
            "failed_job_count": 0, "cancelled_job_count": len(cancelled_job_ids)}


# ----------------- FastAPI Web Server Routes -----------------

def require_api_key(request: Request):
    """Shared-secret auth dependency. Applied to every route except the health checks
    and inbound webhooks (Gmail Pub/Sub push) that can't send a custom header; /config
    is included since it returns the Supabase anon key. Fails CLOSED — if ORBOT_API_KEY isn't configured,
    every dependent request is rejected rather than the check being silently skipped."""
    provided = request.headers.get("X-Orbot-Key") or ""
    if not ORBOT_API_KEY or not hmac.compare_digest(provided, ORBOT_API_KEY):
        raise HTTPException(status_code=401, detail="Unauthorized")

# Hard references to daemon tasks: asyncio only keeps weak refs to tasks, so an
# un-referenced background task can be garbage-collected mid-flight.
_daemon_tasks: list = []

@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Starts the background worker tasks on web server startup when enabled (replaces
    the deprecated @app.on_event('startup') hook)."""
    if os.environ.get("START_DAEMON_THREADS", "true").lower() == "true":
        print("[*] Spawning background worker tasks in unified app event loop...")
        _daemon_tasks.append(asyncio.create_task(run_waybill_daemon_async()))
        if GMAIL_PUBSUB_TOPIC:
            # Event-driven: scans are triggered by the /gmail/notifications webhook.
            # The watch-renewal loop keeps the Gmail watch registered; the backstop loop
            # is a low-frequency safety net catching dropped pushes / transient-error retries.
            print("[*] GMAIL_PUBSUB_TOPIC set — Scout running in event-driven (push) mode.")
            _daemon_tasks.append(asyncio.create_task(run_gmail_watch_renewal_async()))
            _daemon_tasks.append(asyncio.create_task(run_scout_backstop_async()))
        else:
            print("[*] GMAIL_PUBSUB_TOPIC not set — Scout running in legacy periodic-poll mode.")
            _daemon_tasks.append(asyncio.create_task(run_scout_periodic_async()))
    yield

app = FastAPI(
    title="Orbot Unified Service",
    description="Consolidated backend service for Scout Agent, Waybill Agent, Product Manager, and Archivist.",
    version="1.0.0",
    lifespan=_lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

@app.get("/")
@app.get("/status")
def get_status():
    """Returns the health status and last heartbeats of background agents."""
    try:
        res = supabase.table('agent_heartbeats').select('*').execute()
        return {
            "status": "healthy",
            "timestamp": time.time(),
            "heartbeats": res.data
        }
    except Exception as e:
        return {
            "status": "degraded",
            "error": str(e)
        }

@app.get("/config", dependencies=[Depends(require_api_key)])
def get_config():
    """Bootstrap config for the frontend so it works from any browser/device without
    manual setup — the dashboard previously required pasting these into a Settings
    modal saved to localStorage, which meant a fresh browser had nothing configured.

    Gated by require_api_key: this returns the Supabase anon key, and until RLS is
    enabled that key can read/write every table, so it must not be handed out to any
    caller that merely knows the Railway URL. The frontend prompts for the shared
    secret (getOrbotApiKey) before its first /config call, so bootstrap still works."""
    sp_dispatch_enabled = True
    try:
        res = supabase.table("app_settings").select("value").eq("key", "sp_dispatch_enabled").limit(1).execute()
        if res.data:
            sp_dispatch_enabled = res.data[0]["value"] != "false"
    except Exception as e:
        logging.warning(f"Failed to load app_settings.sp_dispatch_enabled, defaulting to enabled: {e}")

    return {
        "supabase_url": SUPABASE_URL,
        "supabase_key": os.environ.get("SUPABASE_ANON_KEY", ""),
        "sp_dispatch_enabled": sp_dispatch_enabled,
    }


class SpDispatchRequest(BaseModel):
    enabled: bool


@app.post("/config/sp-dispatch", dependencies=[Depends(require_api_key)])
def set_sp_dispatch(body: SpDispatchRequest):
    """Persists the SimplyPrint dispatch on/off toggle so it applies everywhere,
    not just the browser it was flipped in."""
    supabase.table("app_settings").upsert({
        "key": "sp_dispatch_enabled",
        "value": "true" if body.enabled else "false",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).execute()
    return {"status": "ok", "sp_dispatch_enabled": body.enabled}


@app.post("/scout/poll", dependencies=[Depends(require_api_key)])
def scout_poll(background_tasks: BackgroundTasks):
    """Manually triggers Scout Gmail unread orders poll cycle in a background thread."""
    background_tasks.add_task(_trigger_scout_scan)
    return {"status": "Scout Gmail poll triggered"}

@app.post("/scout/watch", dependencies=[Depends(require_api_key)])
def scout_watch():
    """Manually (re)registers the Gmail push-notification watch. Useful for first-time
    setup and debugging. Renewal otherwise happens automatically on a daily loop."""
    if not GMAIL_PUBSUB_TOPIC:
        raise HTTPException(status_code=400, detail="GMAIL_PUBSUB_TOPIC is not configured.")
    agent = ScoutAgent()
    resp = agent.start_watch()
    if not resp:
        raise HTTPException(status_code=502, detail="Gmail watch registration failed — check logs.")
    return {"status": "watch registered", "historyId": resp.get("historyId"), "expiration": resp.get("expiration")}

@app.post("/gmail/notifications")
async def gmail_notifications(request: Request, background_tasks: BackgroundTasks, token: str = ""):
    """Pub/Sub push endpoint. Gmail publishes to the topic on every inbox change; Pub/Sub
    pushes that here. We validate the shared secret, ack immediately (200), and run one
    dedup'd Scout scan in the background. The push body's historyId is not needed — the
    scan uses the '-label:orbot-processed' query, which is idempotent."""
    # Reject spoofed calls: the push subscription URL carries ?token=<GMAIL_PUSH_TOKEN>.
    # Fails CLOSED — if GMAIL_PUSH_TOKEN isn't configured, reject every push rather than
    # silently accepting unauthenticated requests to this webhook.
    if not GMAIL_PUSH_TOKEN or token != GMAIL_PUSH_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid push token.")

    # Ack the message even if the body is malformed, so Pub/Sub doesn't redeliver forever.
    try:
        envelope = await request.json()
        msg_id = (envelope or {}).get("message", {}).get("messageId", "?")
        print(f"[*] Gmail push notification received (messageId={msg_id}). Triggering Scout scan...")
    except Exception:
        print("[*] Gmail push notification received (unparseable body). Triggering Scout scan...")

    background_tasks.add_task(_trigger_scout_scan)
    return {"status": "ok"}

@app.post("/scout/ingest-order", dependencies=[Depends(require_api_key)])
def scout_ingest_order(order: dict):
    """Manually ingests an order payload using Scout matching and database ingestion logic."""
    try:
        order_details = OrderDetails.model_validate(order)
        agent = ScoutAgent()
        agent.process_order(order_details)
        return {
            "status": "Order processed successfully",
            "platform_order_id": order_details.platform_order_id
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to process order ingestion: {e}")

@app.post("/catalog/import", dependencies=[Depends(require_api_key)])
async def catalog_import(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    """Uploads a product catalog CSV/XLSX and triggers product manager ingestion in the background."""
    temp_dir = "/tmp" if os.name != "nt" else os.environ.get("TEMP", ".")
    os.makedirs(temp_dir, exist_ok=True)
    safe_filename = os.path.basename(file.filename or "")
    if not safe_filename:
        raise HTTPException(status_code=400, detail="Invalid or missing filename.")
    temp_file_path = os.path.join(temp_dir, safe_filename)

    with open(temp_file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    def run_catalog_ingestion(path):
        try:
            process_catalog(path)
        except Exception as e:
            print(f"Catalog ingestion background task error: {e}")
        finally:
            if os.path.exists(path):
                os.remove(path)

    background_tasks.add_task(run_catalog_ingestion, temp_file_path)
    return {
        "status": "Catalog import queued in background",
        "filename": file.filename
    }

@app.post("/waybill/batch-print", dependencies=[Depends(require_api_key)])
def waybill_batch_print():
    """Queues compilation of ready-to-print waybills into a single batch PDF. Enqueued as
    a waybill_jobs row (the daemon picks it up within ~5s) instead of running inline —
    the old direct path could compile the same orders concurrently with a queued
    waybill_batch_print job; now the daemon is the single executor."""
    res = supabase.table('waybill_jobs').insert({
        'job_type': 'waybill_batch_print',
        'status': 'pending',
        'payload': {}
    }).execute()
    job_id = res.data[0]['id'] if res.data else None
    return {"status": "Batch printing compilation queued", "job_id": job_id}

@app.post("/telemetry/sync", dependencies=[Depends(require_api_key)])
def telemetry_sync(background_tasks: BackgroundTasks):
    """Manually triggers SimplyPrint printer and queue status sync to Supabase database."""
    def run_sync():
        try:
            sync_simplyprint_jobs()
        except Exception as e:
            print(f"Telemetry sync background task error: {e}")

    background_tasks.add_task(run_sync)
    return {"status": "SimplyPrint telemetry sync triggered"}

@app.get("/diagnostics/simplyprint", dependencies=[Depends(require_api_key)])
def diagnostics_simplyprint():
    """Returns raw SimplyPrint printer list for diagnosing connectivity issues."""
    api_key = os.getenv("SIMPLYPRINT_API_KEY")
    if not api_key:
        return {"error": "SIMPLYPRINT_API_KEY not set"}
    headers = {"X-API-KEY": api_key, "Accept": "application/json", "Content-Type": "application/json"}
    try:
        r = http_session.post(f"https://api.simplyprint.io/{SIMPLYPRINT_COMPANY_ID}/printers/Get", headers=headers, json={}, timeout=10)
        printers = r.json().get("data", []) if r.status_code == 200 else []
        return {
            "http_status": r.status_code,
            "printer_count": len(printers),
            "printers": [
                {"id": p.get("id"), "name": p.get("printer", {}).get("name"), "online": p.get("printer", {}).get("online"), "state": p.get("printer", {}).get("state")}
                for p in printers
            ],
            "raw_status": r.text[:500] if r.status_code != 200 else None
        }
    except Exception as e:
        return {"error": str(e)}

@app.post("/scout/ingest-email", dependencies=[Depends(require_api_key)])
def scout_ingest_email(req: IngestEmailRequest):
    """Parses a raw order confirmation email body with Gemini and ingests the order."""
    try:
        agent = ScoutAgent()
        order_details = agent.parse_email_with_llm(req.email_body)
        if not order_details or not order_details.is_order_email:
            raise HTTPException(status_code=422, detail="Failed to parse order details from email body.")
        agent.process_order(order_details, cleaned_body=agent._clean_text_for_llm(req.email_body))
        return {"status": "Order ingested successfully", "platform_order_id": order_details.platform_order_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"scout/ingest-email error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ReparseEmailRequest(BaseModel):
    ingested_email_id: Optional[str] = None
    platform_order_id: Optional[str] = None

@app.post("/scout/reparse-email", dependencies=[Depends(require_api_key)])
def scout_reparse_email(req: ReparseEmailRequest):
    """Re-runs parsing + coverage verification from a stored raw email (by
    ingested_emails.id or by the platform_order_id of its linked order).
    process_order dedups on platform_order_id, so to re-ingest a badly parsed
    order, delete the broken order row first, then call this."""
    if not req.ingested_email_id and not req.platform_order_id:
        raise HTTPException(status_code=400, detail="Provide ingested_email_id or platform_order_id.")
    try:
        if req.ingested_email_id:
            row_res = supabase.table("ingested_emails").select("*").eq("id", req.ingested_email_id).limit(1).execute()
        else:
            o_res = supabase.table("orders").select("id").eq("platform_order_id", req.platform_order_id).limit(1).execute()
            if not o_res.data:
                raise HTTPException(status_code=404, detail=f"No order found for {req.platform_order_id}.")
            row_res = supabase.table("ingested_emails").select("*").eq("order_id", o_res.data[0]["id"]) \
                .order("created_at", desc=True).limit(1).execute()
        if not row_res.data:
            raise HTTPException(status_code=404, detail="No stored email found for that reference.")
        row = row_res.data[0]

        agent = ScoutAgent()
        order_details = agent.parse_email_with_llm(
            row.get("raw_body") or "", subject=row.get("subject") or "", sender=row.get("sender") or "")
        if not order_details or not order_details.is_order_email:
            agent._update_ingested_email(row["id"], {"parse_status": "failed",
                                                     "parse_error": "Reparse: LLM did not return an order."})
            raise HTTPException(status_code=422, detail="Reparse failed: LLM did not return an order.")

        cleaned_body = agent._clean_text_for_llm(row.get("raw_body") or "")
        try:
            agent.process_order(order_details, cleaned_body=cleaned_body, source_email_id=row["id"])
            agent._update_ingested_email(row["id"], {"parse_status": "parsed", "parse_error": None})
            status = "parsed"
        except OrderHeldForReview as e:
            agent._update_ingested_email(row["id"], {"parse_status": "held"})
            status = f"held: {e}"
        return {"status": status,
                "platform_order_id": order_details.platform_order_id,
                "items_extracted": len(order_details.items or []),
                "stated_item_count": order_details.stated_item_count}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"scout/reparse-email error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ForemanDispatchRequest(BaseModel):
    dry_run: bool = False

@app.post("/foreman/dispatch", dependencies=[Depends(require_api_key)])
def foreman_dispatch(body: ForemanDispatchRequest = ForemanDispatchRequest()):
    """Fetches all pending order items and dispatches their print files to the SimplyPrint queue."""
    try:
        result = run_foreman_dispatch(dry_run=body.dry_run)
        return result
    except Exception as e:
        logger.error(f"foreman/dispatch error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ─── Product Launch Pipeline ──────────────────────────────────────────────────

from PIL import Image as PILImage
from fastapi.responses import StreamingResponse

_THEME_CODES: dict = {
    "SC":  "Speed Champions",
    "SWR": "Star Wars",
    "MVL": "Marvel",
    "TCH": "Technic",
    "ICN": "Icons",
    "IDS": "Ideas",
    "DNY": "Disney",
    "HPR": "Harry Potter",
    "CTY": "City",
    "CRE": "Creator",
    "NTD": "Nintendo",
    "DC":  "DC",
    "FNT": "Fortnite",
    "OTH": "Other",
}

_PRODUCT_TYPE_LABELS: dict = {
    "DS":    "Display Stand",
    "DS-NP": "Display Stand (No Nameplate)",
    "WM":    "Wall Mount",
    "FWM":   "Full Wall Mount",
    "BASE":  "Base",
}


def _launch_build_sku_tree(theme: str, set_number: str, product_types: list, plaque_count: int,
                            sku_prefix: str = "BLO") -> list:
    master = f"{sku_prefix}-{theme}-{set_number}"
    out = []
    for ptype in product_types:
        if ptype == "DS":
            # plaque_count 0 → a single DS variant with no plaque ("Base - Plaque,0")
            for n in range(0 if plaque_count == 0 else 1, plaque_count + 1):
                out.append({"master_sku": master, "sku": f"{master}-DS-{n}", "type": "DS",
                             "plaque_num": n, "label": f"{n} Plaque{'s' if n != 1 else ''}"})
        else:
            suffix = {"DS-NP": "DS-NP", "WM": "WM", "FWM": "FWM", "BASE": "BASE"}.get(ptype, ptype)
            out.append({"master_sku": master, "sku": f"{master}-{suffix}", "type": ptype,
                        "plaque_num": None, "label": _PRODUCT_TYPE_LABELS.get(ptype, ptype)})
    return out


def _launch_variation_name(set_number: str, v: dict) -> str:
    ptype, n = v["type"], v.get("plaque_num")
    if ptype == "DS":     return f"({set_number})Base - Plaque,{n}"
    if ptype == "DS-NP":  return f"({set_number})Base - Blank"
    if ptype == "WM":     return f"({set_number})Wall Mount"
    if ptype == "FWM":    return f"({set_number})Full Wall Mount"
    if ptype == "BASE":   return f"({set_number})Base"
    return f"({set_number}){ptype}"


def _launch_generate_copy(set_name: str, set_number: str, theme: str, product_types: list,
                           shop: Optional[dict] = None) -> dict:
    """Generates Shopee/Lazada listing copy via Gemini. brand/domain/region come from
    shop['ai_copy_profile'] when a shop is resolved, falling back to the original
    Blocked Off/LEGO wording so the existing single-brand flow is unaffected."""
    profile = (shop or {}).get("ai_copy_profile") or {}
    brand  = profile.get("brand", "Blocked Off")
    domain = profile.get("domain", "custom 3D-printed LEGO display accessories")
    region = profile.get("region", "Malaysia")

    theme_full = _THEME_CODES.get(theme, theme)
    types_str  = ", ".join(_PRODUCT_TYPE_LABELS.get(pt, pt) for pt in product_types)
    prompt = (
        f"You are writing a product listing for a Shopee/Lazada seller in {region} selling {domain}.\n"
        f"Brand: {brand}\n"
        f"LEGO set: {set_name} ({set_number})\n"
        f"LEGO theme: {theme_full}\n"
        f"Product types: {types_str}\n\n"
        f"Return ONLY a JSON object with exactly these two keys:\n"
        f'{{"listing_title": "...", "description": "..."}}\n\n'
        f"Rules:\n"
        f"- listing_title: max 120 chars. Format: '[Product type] for Lego [Theme] [Set Name] ([Set Number])'. SEO-friendly.\n"
        f"- description: 150-250 words. Plain text, no markdown. Mention: custom-fit, high-quality 3D printing, "
        f"available variants, {brand} brand. Malaysian English is fine.\n"
        f"Return ONLY the JSON. No extra text."
    )
    response = ai_client.models.generate_content(model='gemini-2.5-flash', contents=prompt)
    log_gemini_usage("Product Launch", "gemini-2.5-flash", response)
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', response.text.strip(), flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except Exception:
        return {
            "listing_title": f"Display Stand for Lego {theme_full} {set_name} ({set_number})",
            "description": (f"Custom display stand for the Lego {set_name} ({set_number}). "
                            f"Available in {types_str}. High quality 3D printed by {brand} {region}."),
        }


def _launch_process_image(raw: bytes, size: int = 2000) -> bytes:
    img = PILImage.open(BytesIO(raw)).convert("RGB")
    w, h = img.size
    s = min(w, h)
    img = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))
    img = img.resize((size, size), PILImage.LANCZOS)
    quality = 85
    while True:
        out = BytesIO()
        img.save(out, format="JPEG", quality=quality, optimize=True)
        if out.tell() <= 2 * 1024 * 1024 or quality <= 50:
            return out.getvalue()
        quality -= 10


# ─── Product Intake from Link ─────────────────────────────────────────────────
# Paste a marketplace URL (MakerWorld/Printables/Cults3D/Etsy) → scrape name,
# description, set number, theme and product photos → prefill the Launch tab.

def _is_safe_url(url: str) -> bool:
    """Rejects URLs that resolve to private/loopback/link-local/reserved IP ranges, to
    guard against SSRF via user-supplied or LLM-extracted URLs (product page + image URLs)."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = parsed.hostname
        if not host:
            return False
        ip = ipaddress.ip_address(socket.gethostbyname(host))
        return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved)
    except Exception:
        return False


def _safe_get(url: str, *, headers: Optional[dict] = None, timeout: int = 30, max_redirects: int = 5):
    """GET that re-validates every redirect hop against _is_safe_url. requests' automatic
    redirect handling only sees the first URL pass validation — a hostile page could 302
    the request to a private/internal address after the initial check."""
    current = url
    for _ in range(max_redirects + 1):
        if not _is_safe_url(current):
            raise ValueError(f"Blocked unsafe URL: {current}")
        r = http_session.get(current, headers=headers, timeout=timeout, allow_redirects=False)
        if r.is_redirect or r.is_permanent_redirect:
            loc = r.headers.get('Location')
            if not loc:
                return r
            current = urljoin(current, loc)
            continue
        return r
    raise ValueError(f"Too many redirects fetching {url}")


_SCRAPE_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


class ProductScrapeExtract(BaseModel):
    """Structured fields Gemini extracts from a marketplace product page."""
    product_name: str = Field(description="The product/model name as shown on the page, without site branding or designer name.")
    description: str = Field(description="A faithful plain-text summary of the product description on the page, 100-250 words. No markdown.")
    set_name: Optional[str] = Field(default=None, description="If the product relates to a LEGO set: the set name only (e.g. 'Ferrari SF-24 F1 Car'). Null otherwise.")
    set_number: Optional[str] = Field(default=None, description="If a LEGO set number appears (4-6 digits, e.g. '77243'), that number as a string. Null otherwise.")
    theme_code: Optional[str] = Field(default=None, description="Best-matching LEGO theme code from the list given in the prompt, or null if none fits.")
    image_urls: List[str] = Field(default_factory=list, description="Absolute URLs of the distinct PRODUCT photos on the page, highest-resolution variant available, in display order. Exclude avatars, site logos, icons, banners and related-product thumbnails.")


def _condense_product_html(html_text: str, base_url: str) -> str:
    """Boil a product page down to what the LLM needs: meta tags, JSON-LD,
    candidate image URLs, and visible text. Keeps token usage sane on JS-heavy pages."""
    # JSON blobs (Next.js et al.) escape slashes — normalise so URL regexes hit
    html_text = html_text.replace('\\u002F', '/').replace('\\/', '/')

    chunks = []
    metas = re.findall(r'<meta[^>]+(?:property|name)=["\'](?:og:|twitter:|description)[^>]*>', html_text, re.I)
    if metas:
        chunks.append("META TAGS:\n" + "\n".join(metas[:30]))
    for m in re.finditer(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html_text, re.I | re.S):
        chunks.append("JSON-LD:\n" + m.group(1).strip()[:20000])

    img_urls = []
    for m in re.finditer(r'<img[^>]+(?:src|data-src|data-original)=["\']([^"\']+)["\']', html_text, re.I):
        u = urljoin(base_url, html_module.unescape(m.group(1)))
        if u.startswith('http') and u not in img_urls:
            img_urls.append(u)
    # image URLs buried in JSON blobs (MakerWorld/Printables render client-side)
    for m in re.finditer(r'https?://[^\s"\'<>\\]+\.(?:jpe?g|png|webp)(?:\?[^\s"\'<>\\]*)?', html_text, re.I):
        u = m.group(0)
        if u not in img_urls:
            img_urls.append(u)
    if img_urls:
        chunks.append("CANDIDATE IMAGE URLS:\n" + "\n".join(img_urls[:100]))

    text = re.sub(r'<(script|style|svg|noscript)[^>]*>.*?</\1>', ' ', html_text, flags=re.S | re.I)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = html_module.unescape(text)
    text = re.sub(r'\s+', ' ', text).strip()
    chunks.append("PAGE TEXT:\n" + text[:12000])
    return "\n\n".join(chunks)


@app.post("/catalog/scrape-product", dependencies=[Depends(require_api_key)])
async def catalog_scrape_product(request: Request):
    """Fetch a product page, extract name/description/set/theme/photos via Gemini,
    download + square-process the photos. No DB writes."""
    body = await request.json()
    url = str(body.get("url", "")).strip()
    if not re.match(r'^https?://', url):
        raise HTTPException(status_code=400, detail="A valid http(s) URL is required.")
    if not await asyncio.to_thread(_is_safe_url, url):
        raise HTTPException(status_code=400, detail="This URL cannot be fetched (blocked host/IP range).")

    def _do_scrape():
        # Tier 1: fetch the page ourselves (works for Printables, Cults3D, ...).
        # Tier 2: TLS-fingerprint blockers (MakerWorld/Cloudflare) 403 any non-browser
        # client, so let Google fetch it via Gemini's url_context tool — that recovers
        # the text fields but not image URLs (the fetcher strips markup).
        html_text = None
        try:
            page = _safe_get(url, headers=_SCRAPE_HEADERS, timeout=30)
            page.raise_for_status()
            if len(page.text) >= 500 and not re.search(
                    r'captcha|access denied|are you a robot|unusual traffic', page.text[:5000], re.I):
                html_text = page.text
        except Exception:
            pass

        theme_list = ", ".join(f"{code} = {name}" for code, name in _THEME_CODES.items())
        extraction, last_err, blocked_site = None, None, html_text is None

        if html_text:
            condensed = _condense_product_html(html_text, url)
            prompt = (
                "Below is condensed content from a 3D-model marketplace product page "
                f"({url}).\n"
                "Extract the product details. For image_urls, choose only the distinct product photos "
                "(gallery images), preferring the highest-resolution URL when the same photo appears at "
                "several sizes. Do not invent URLs — only use URLs present in the content.\n"
                f"LEGO theme codes: {theme_list}\n\n"
                f"{condensed}"
            )
            for model in ('gemini-2.5-flash', 'gemini-2.5-pro'):
                try:
                    response = ai_client.models.generate_content(
                        model=model,
                        contents=prompt,
                        config={'response_mime_type': 'application/json',
                                'response_schema': ProductScrapeExtract,
                                'temperature': 0.1,
                                'http_options': {'timeout': 60000}},
                    )
                    log_gemini_usage("Product Intake", model, response)
                    extraction = ProductScrapeExtract(**json.loads(response.text))
                    break
                except Exception as e:
                    last_err = e
        else:
            # url_context can't be combined with a response_schema — describe the JSON
            # in the prompt and parse it out of the reply instead.
            prompt = (
                f"Read this 3D-model marketplace product page: {url}\n"
                "Then return ONLY a JSON object with exactly these keys:\n"
                '{"product_name": "...", "description": "...", "set_name": null, "set_number": null, '
                '"theme_code": null, "image_urls": []}\n'
                "- product_name: the product/model name, without site branding or designer name.\n"
                "- description: faithful plain-text summary of the product description, 100-250 words.\n"
                "- set_name: if the product relates to a LEGO set, the set name only; else null.\n"
                "- set_number: LEGO set number (4-6 digits) as a string if one appears; else null.\n"
                f"- theme_code: best-matching code from [{theme_list}] or null.\n"
                "- image_urls: always [].\n"
                "Return ONLY the JSON, no extra text."
            )
            for model in ('gemini-2.5-flash', 'gemini-2.5-pro'):
                try:
                    response = ai_client.models.generate_content(
                        model=model,
                        contents=prompt,
                        config={'tools': [{'url_context': {}}],
                                'http_options': {'timeout': 60000}},
                    )
                    log_gemini_usage("Product Intake", model, response)
                    m = re.search(r'\{.*\}', response.text, re.S)
                    extraction = ProductScrapeExtract(**json.loads(m.group(0)))
                    extraction.image_urls = []
                    break
                except Exception as e:
                    last_err = e
        if extraction is None:
            raise HTTPException(status_code=502, detail=f"Couldn't read this page ({last_err}). Try another link or fill the form manually.")

        images = []
        for img_url in extraction.image_urls[:9]:  # Shopee allows max 9 listing images
            if not _is_safe_url(img_url):
                log_system("warning", f"Product intake: skipped image URL blocked by SSRF guard: {img_url}",
                           agent_name="Product Intake")
                continue
            try:
                r = _safe_get(img_url, headers={**_SCRAPE_HEADERS, "Referer": url}, timeout=30)
                r.raise_for_status()
                # Keep the raw original — no crop/resize here. Launch processes to
                # square 2000px later; verify it decodes so we never ship an HTML
                # error page as an "image", and cap payload size for the b64 response.
                raw = r.content
                # 8MB/image: base64 inflates ~33% and up to 9 images ride one JSON
                # response — the old 25MB cap allowed ~300MB payloads.
                if len(raw) > 8 * 1024 * 1024:
                    raise ValueError(f"image too large ({len(raw)} bytes)")
                img = PILImage.open(BytesIO(raw))
                fmt = (img.format or "JPEG").lower()
                images.append({"source_url": img_url,
                               "format": "jpg" if fmt == "jpeg" else fmt,
                               "image_b64": base64.b64encode(raw).decode()})
            except Exception as ie:
                log_system("warning", f"Product intake: image download failed ({img_url}): {ie}",
                           agent_name="Product Intake")

        log_system("info",
                   f"Product intake: scraped '{extraction.product_name}' — {len(images)} image(s) from {url}"
                   + (" (blocked site, text-only via url_context)" if blocked_site else ""),
                   agent_name="Product Intake")
        return {
            "source_url":   url,
            "product_name": extraction.product_name,
            "description":  extraction.description,
            "set_name":     extraction.set_name,
            "set_number":   extraction.set_number,
            "theme_code":   extraction.theme_code if extraction.theme_code in _THEME_CODES else None,
            "images":       images,
            "note":         ("This site blocks image downloads — add the product photos manually, "
                             "then use Remove Logos.") if blocked_site else None,
        }

    return await asyncio.to_thread(_do_scrape)


@app.post("/catalog/clean-image", dependencies=[Depends(require_api_key)])
async def catalog_clean_image(request: Request):
    """Remove logos/watermarks from one image via Gemini image editing.
    Always returns an image — falls back to the original with cleaned=false."""
    body = await request.json()
    img_b64 = body.get("image_b64") or ""
    try:
        raw = base64.b64decode(img_b64)
        PILImage.open(BytesIO(raw)).verify()
    except Exception:
        raise HTTPException(status_code=400, detail="image_b64 must be a valid base64-encoded image.")

    def _do_clean():
        prompt = ("Remove any logos, watermarks, brand marks, usernames or overlaid text from this "
                  "product photo, reconstructing the background naturally where they were. "
                  "Change absolutely nothing else — keep the product, colours, lighting and "
                  "composition identical. If there is no logo or watermark, return the image unchanged.")
        try:
            response = ai_client.models.generate_content(
                model='gemini-2.5-flash-image',
                contents=[genai_types.Part.from_bytes(data=raw, mime_type='image/jpeg'), prompt],
                config={'http_options': {'timeout': 120000}},
            )
            log_gemini_usage("Product Intake", "gemini-2.5-flash-image", response)
            for part in (response.candidates[0].content.parts or []):
                inline = getattr(part, 'inline_data', None)
                if inline and inline.data:
                    cleaned = _launch_process_image(inline.data)
                    return {"cleaned": True, "image_b64": base64.b64encode(cleaned).decode()}
            return {"cleaned": False, "image_b64": img_b64, "reason": "Model returned no image."}
        except Exception as e:
            log_system("warning", f"Product intake: logo clean failed: {e}", agent_name="Product Intake")
            reason = str(e)
            if 'RESOURCE_EXHAUSTED' in reason or '429' in reason:
                reason = ("Gemini image editing quota exhausted — the image model needs a paid-tier "
                          "API key (free tier has no image-editing quota).")
            return {"cleaned": False, "image_b64": img_b64, "reason": reason[:300]}

    return await asyncio.to_thread(_do_clean)

# ─── End Product Intake from Link ─────────────────────────────────────────────


def _do_preview_product(set_name: str, set_number: str, theme: str, brand_name: str,
                         product_types: list, plaque_count: int, price_myr, platforms: list) -> dict:
    """Synchronous body of /catalog/preview-product — runs Gemini + shop lookup off the
    event loop via asyncio.to_thread (see /catalog/scrape-product for the same pattern)."""
    shop       = resolve_shop(brand_name)
    sku_prefix = shop["sku_prefix"] if shop else "BLO"

    variants = _launch_build_sku_tree(theme, set_number, product_types, plaque_count, sku_prefix=sku_prefix)
    copy     = _launch_generate_copy(set_name, set_number, theme, product_types, shop=shop)

    return {
        "listing_title": copy["listing_title"],
        "description":   copy["description"],
        "master_sku":    f"{sku_prefix}-{theme}-{set_number}",
        "platforms":     platforms,
        "variants": [
            {"sku": v["sku"], "type": v["type"], "label": v["label"],
             "platform_variation_name": _launch_variation_name(set_number, v),
             "price_myr": price_myr}
            for v in variants
        ],
    }


@app.post("/catalog/preview-product", dependencies=[Depends(require_api_key)])
async def catalog_preview_product(request: Request):
    """Generate listing copy via Gemini — no DB writes, no images needed."""
    body = await request.json()
    set_name     = str(body.get("set_name", "")).strip()
    set_number   = str(body.get("set_number", "")).strip()
    theme        = str(body.get("theme", "")).strip().upper()
    brand_name   = str(body.get("brand_name", "Blocked Off")).strip() or "Blocked Off"
    product_types = body.get("product_types", [])
    plaque_count  = int(body.get("plaque_count", 1))
    price_myr     = body.get("price_myr")
    platforms     = body.get("platforms", ["shopee", "lazada"])

    if not set_name or not set_number or not theme or not product_types:
        raise HTTPException(status_code=400, detail="set_name, set_number, theme, product_types required.")

    return await asyncio.to_thread(
        _do_preview_product, set_name, set_number, theme, brand_name,
        product_types, plaque_count, price_myr, platforms,
    )


def _do_launch_product(set_name: str, set_number: str, theme: str, product_types: list,
                        plaque_count: int, price_myr, price_sgd, platforms: list,
                        listing_title: str, description: str, brand_name: str,
                        product_category: str, shopee_my, shopee_sg, shopee_ph, shopee_th,
                        lazada_my, source_url, source_description, vd_by_sku: dict,
                        raw_images: List[bytes]) -> StreamingResponse:
    """Synchronous body of /catalog/launch-product — DB writes, Drive uploads, image
    processing, and ZIP building all run off the event loop via asyncio.to_thread (see
    /catalog/scrape-product for the same pattern). raw_images are the already-read bytes
    of each uploaded image (reading the UploadFile itself must happen in the async route
    handler, since that part is genuinely async)."""
    shop       = resolve_shop(brand_name)
    sku_prefix = shop["sku_prefix"] if shop else "BLO"

    variants          = _launch_build_sku_tree(theme, set_number, product_types, plaque_count, sku_prefix=sku_prefix)
    master_sku        = f"{sku_prefix}-{theme}-{set_number}"
    product_base_name = f"{set_name} ({set_number})"
    if not product_category:
        product_category = _PRODUCT_TYPE_LABELS.get(product_types[0], product_types[0])

    # ── products upsert ────────────────────────────────────────────────────
    prod_data = clean_dict({
        "brand_name":        brand_name,
        "product_category":  product_category,
        "master_sku":        master_sku,
        "product_base_name": product_base_name,
        "shop_id":           shop["id"] if shop else None,
    })
    prod_res = supabase.table("products").upsert(prod_data, on_conflict="master_sku").execute()
    product_id = prod_res.data[0]["id"]

    # ── variants upsert ────────────────────────────────────────────────────
    for v in variants:
        vd = vd_by_sku.get(v["sku"], {})
        _pc_m = re.search(r'-DS-(\d+)$', v["sku"])
        _var_plaque_count = int(_pc_m.group(1)) if _pc_m and v["type"] == "DS" else None
        var_data = {
            "product_id":    product_id,
            "variant_sku":   v["sku"],
            "variant_name":  f"{product_base_name} - {v['type']}",
            "reference_name": f"{product_base_name} - {v['type']}",
            "variant_type":  v["type"],
            "set_number":    set_number,
            "plaque_count":  _var_plaque_count,
        }
        if vd.get("stock_quantity") is not None:
            var_data["stock_quantity"] = int(vd["stock_quantity"])
        if vd.get("seal_sticker_gdrive_url"):
            var_data["seal_sticker_gdrive_url"] = vd["seal_sticker_gdrive_url"]
        if vd.get("print_files_gdrive_url"):
            var_data["print_files_gdrive_url"] = vd["print_files_gdrive_url"]
        if vd.get("pictures_gdrive_url"):
            var_data["pictures_gdrive_url"] = vd["pictures_gdrive_url"]
        if vd.get("adobe_express_url"):
            var_data["adobe_express_url"] = vd["adobe_express_url"]
        var_res = supabase.table("variants").upsert(var_data, on_conflict="variant_sku").execute()
        v["variant_id"] = var_res.data[0]["id"]
        v["existing_pictures_url"] = var_res.data[0].get("pictures_gdrive_url")

    # ── listings + listing_variations upsert ──────────────────────────────
    listing_data = {
        "product_id":                   product_id,
        "platform_listing_name":        listing_title,
        "platform_listing_description": description,
        "price_myr":                    price_myr,
    }
    if price_sgd:
        listing_data["price_sgd"] = price_sgd
    if shopee_my:
        listing_data["shopee_my"] = shopee_my
    if shopee_sg:
        listing_data["shopee_sg"] = shopee_sg
    if shopee_ph:
        listing_data["shopee_ph"] = shopee_ph
    if shopee_th:
        listing_data["shopee_th"] = shopee_th
    if lazada_my:
        listing_data["lazada_my"] = lazada_my

    list_res   = supabase.table("listings").upsert(listing_data, on_conflict="platform_listing_name").execute()
    listing_id = list_res.data[0]["id"]

    for v in variants:
        var_name = _launch_variation_name(set_number, v)
        supabase.table("listing_variations").upsert({
            "listing_id":                  listing_id,
            "variant_id":                  v["variant_id"],
            "platform_variation_name":     var_name,
            "normalized_variation_name":   normalize_variation(var_name),
            "reference_name":              f"{listing_title} [{var_name}]",
            "match_source":                "catalog",
        }, on_conflict="listing_id, platform_variation_name").execute()

    log_system("info",
               f"Product launch: {master_sku} — {len(variants)} variant(s), {len(platforms)} platform(s).",
               agent_name="Product Launch")

    # ── image processing ───────────────────────────────────────────────────
    processed_imgs = []
    for i, raw in enumerate(raw_images):
        try:
            data = _launch_process_image(raw)
            processed_imgs.append((i + 1, data))
        except Exception as ie:
            log_system("warning", f"Image {i+1} processing failed: {ie}", agent_name="Product Launch")

    # ── Google Drive folders + asset upload ───────────────────────────────
    # Creates {products root}/{Product}/Pictures|Print Files|Seal Stickers,
    # uploads the processed images + description.txt, and fills the variant
    # folder-URL columns. Never fails the launch — Drive errors just log a warning.
    drive_folder_url = None
    try:
        if any(not v.get("existing_pictures_url") for v in variants):
            service   = get_drive_service()
            parent_id = get_product_parent_folder_id(service)
            if not parent_id:
                raise RuntimeError("No products parent folder found — set PRODUCT_PARENT_FOLDER_ID.")
            product_folder_id = get_or_create_folder(service, product_base_name, parent_id)
            pics_id  = get_or_create_folder(service, "Pictures", product_folder_id)
            files_id = get_or_create_folder(service, "Print Files", product_folder_id)
            seals_id = get_or_create_folder(service, "Seal Stickers", product_folder_id)
            if not all([product_folder_id, pics_id, files_id, seals_id]):
                raise RuntimeError("Drive folder creation failed.")

            _folder_url = lambda fid: f"https://drive.google.com/drive/folders/{fid}"
            with tempfile.TemporaryDirectory() as tmpd:
                desc_path = os.path.join(tmpd, "description.txt")
                with open(desc_path, "w") as f:
                    f.write(f"{listing_title}\n\n{description}\n"
                            + (f"\n--- Original product description ---\n{source_description}\n" if source_description else "")
                            + (f"\nSource: {source_url}\n" if source_url else ""))
                upload_to_drive(service, desc_path, "description.txt", pics_id)
                for idx, data in processed_imgs:
                    img_path = os.path.join(tmpd, f"{idx:02d}.jpg")
                    with open(img_path, "wb") as f:
                        f.write(data)
                    upload_to_drive(service, img_path, f"{idx:02d}.jpg", pics_id)

            for v in variants:
                if v.get("existing_pictures_url"):
                    continue  # never overwrite folder links that already exist
                supabase.table("variants").update({
                    "pictures_gdrive_url":     _folder_url(pics_id),
                    "print_files_gdrive_url":  _folder_url(files_id),
                    "seal_sticker_gdrive_url": _folder_url(seals_id),
                }).eq("id", v["variant_id"]).execute()

            drive_folder_url = _folder_url(product_folder_id)
            log_system("info", f"Product launch: Drive folders created for {master_sku}: {drive_folder_url}",
                       agent_name="Product Launch")
    except Exception as de:
        log_system("warning", f"Product launch: Drive folder step failed for {master_sku}: {de}",
                   agent_name="Product Launch")

    # ── build ZIP ──────────────────────────────────────────────────────────
    zip_buf = BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for platform in platforms:
            var_rows = "\n".join(
                f"  {v['sku']}  |  {_launch_variation_name(set_number, v)}  |  MYR {price_myr or 'TBC'}"
                for v in variants
            )
            zf.writestr(f"{platform}/listing.txt",
                        f"LISTING — {platform.upper()}\n{'='*50}\n"
                        f"Title: {listing_title}\n\nDescription:\n{description}\n\n"
                        f"Variants:\n{var_rows}\n\nPrice (MYR): {price_myr or 'TBC'}\n")
            for idx, data in processed_imgs:
                zf.writestr(f"{platform}/images/{idx:02d}.jpg", data)

        zf.writestr("variants.csv",
                    "SKU,Variant Type,Variation Name (Platform),Price MYR,Stock\n" +
                    "\n".join(
                        f"{v['sku']},{v['type']},{_launch_variation_name(set_number, v)},{price_myr or ''},"
                        f"{vd_by_sku.get(v['sku'], {}).get('stock_quantity', 0)}"
                        for v in variants))

        zf.writestr("db_summary.txt",
                    f"DB INSERTS\n{'='*40}\n"
                    f"Product: {product_base_name}  (master_sku: {master_sku}  id: {product_id})\n\n"
                    "Variants:\n" +
                    "\n".join(f"  {v['sku']}  (id: {v['variant_id']})" for v in variants) +
                    (f"\n\nDrive folder: {drive_folder_url}" if drive_folder_url else "") +
                    f"\n\nNOTE: print_files rows not created — add after uploading gcode to SimplyPrint.\n")

    zip_buf.seek(0)
    fname = f"launch_{master_sku}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
    return StreamingResponse(zip_buf, media_type="application/zip",
                             headers={"Content-Disposition": f"attachment; filename={fname}"})


@app.post("/catalog/launch-product", dependencies=[Depends(require_api_key)])
async def catalog_launch_product(request: Request):
    """Full pipeline: insert DB rows, process images, return downloadable ZIP."""
    form             = await request.form()
    set_name         = str(form.get("set_name", "")).strip()
    set_number       = str(form.get("set_number", "")).strip()
    theme            = str(form.get("theme", "")).strip().upper()
    product_types    = json.loads(form.get("product_types", "[]"))
    plaque_count     = int(form.get("plaque_count", 1))
    price_myr        = float(form.get("price_myr", 0) or 0) or None
    price_sgd        = float(form.get("price_sgd", 0) or 0) or None
    platforms        = json.loads(form.get("platforms", '["shopee","lazada"]'))
    listing_title    = str(form.get("listing_title", "")).strip()
    description      = str(form.get("description", "")).strip()
    brand_name       = str(form.get("brand_name", "Blocked Off")).strip() or "Blocked Off"
    product_category = str(form.get("product_category", "")).strip()
    shopee_my        = str(form.get("shopee_my", "")).strip() or None
    shopee_sg        = str(form.get("shopee_sg", "")).strip() or None
    shopee_ph        = str(form.get("shopee_ph", "")).strip() or None
    shopee_th        = str(form.get("shopee_th", "")).strip() or None
    lazada_my        = str(form.get("lazada_my", "")).strip() or None
    source_url         = str(form.get("source_url", "")).strip() or None
    source_description = str(form.get("source_description", "")).strip() or None
    variant_details  = json.loads(form.get("variant_details", "[]"))
    # keyed by SKU for O(1) lookup
    vd_by_sku        = {vd["sku"]: vd for vd in variant_details}

    if not set_name or not set_number or not theme or not product_types or not listing_title:
        raise HTTPException(status_code=400, detail="Missing required fields.")

    # Reading each UploadFile is genuinely async — do it here, then hand plain bytes to
    # the synchronous helper (run off the event loop below).
    raw_images = []
    for i, img_file in enumerate(form.getlist("images")):
        if hasattr(img_file, "read"):
            try:
                raw_images.append(await img_file.read())
            except Exception as ie:
                log_system("warning", f"Image {i+1} read failed: {ie}", agent_name="Product Launch")

    return await asyncio.to_thread(
        _do_launch_product, set_name, set_number, theme, product_types, plaque_count,
        price_myr, price_sgd, platforms, listing_title, description, brand_name,
        product_category, shopee_my, shopee_sg, shopee_ph, shopee_th, lazada_my,
        source_url, source_description, vd_by_sku, raw_images,
    )


# ─── End Product Launch Pipeline ──────────────────────────────────────────────

class QueueFileRequest(BaseModel):
    print_file_name: str
    simplyprint_file_id: Optional[str] = None
    print_job_id: Optional[str] = None

@app.post("/print-files/queue", dependencies=[Depends(require_api_key)])
def queue_single_file(req: QueueFileRequest):
    """Sends a single print file directly to the SimplyPrint queue."""
    api_key = os.getenv("SIMPLYPRINT_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="SimplyPrint API key not configured.")

    sp_file_id = req.simplyprint_file_id
    if not sp_file_id and req.print_job_id:
        # Look up via print_job FK → print_files
        res = supabase.table("print_jobs").select("print_files(simplyprint_file_id)").eq("id", req.print_job_id).limit(1).execute()
        if res.data and res.data[0].get("print_files"):
            sp_file_id = res.data[0]["print_files"].get("simplyprint_file_id")
    if not sp_file_id:
        # Fallback: search print_files by name
        res = supabase.table("print_files").select("simplyprint_file_id").ilike("print_file_name", req.print_file_name).limit(1).execute()
        if res.data and res.data[0].get("simplyprint_file_id"):
            sp_file_id = res.data[0]["simplyprint_file_id"]
    if not sp_file_id:
        raise HTTPException(status_code=404, detail=f"No SimplyPrint file ID found for '{req.print_file_name}'. Re-sync files from the product catalog.")

    sp_headers = {"X-API-KEY": api_key, "Content-Type": "application/json"}
    base_url = f"https://api.simplyprint.io/{SIMPLYPRINT_COMPANY_ID}"
    for_printers = route_printers_for_file(req.print_file_name)
    try:
        sp_res = http_session.post(f"{base_url}/queue/AddItem", headers=sp_headers, json={
            "filesystem": sp_file_id,
            "amount": 1,
            "for_printers": for_printers,
            "position": "bottom"
        }, timeout=15)
        if not sp_res.ok:
            raise HTTPException(status_code=sp_res.status_code, detail=f"SimplyPrint error: {sp_res.text}")
        sp_job_id = sp_res.json().get("created_id")
        return {"status": "success", "simplyprint_job_id": sp_job_id, "for_printers": for_printers}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/cancel", dependencies=[Depends(require_api_key)])
def cancel_order(req: CancelRequest):
    """Cancels an order: aborts SimplyPrint jobs and marks the order cancelled in the database."""
    try:
        order_id = req.order_id
        platform_order_id = req.platform_order_id

        if req.email_body:
            if not ai_client:
                raise HTTPException(status_code=503, detail="AI client not configured (missing GEMINI_API_KEY).")
            class _CancelSchema(BaseModel):
                platform_order_id: str = Field(description="The platform order ID to cancel")
            response = ai_client.models.generate_content(
                model='gemini-2.5-flash',
                contents=f"Extract the Order ID from this cancellation email. Return ONLY JSON: {{\"platform_order_id\": \"string\"}}.\n\n{req.email_body}",
                config={'response_mime_type': 'application/json', 'response_schema': _CancelSchema, 'temperature': 0.1}
            )
            log_gemini_usage('Cancellation', 'gemini-2.5-flash', response)
            cancel_data = json.loads(response.text)
            platform_order_id = cancel_data.get("platform_order_id")
            if not platform_order_id:
                raise HTTPException(status_code=422, detail="Could not extract order ID from email body.")

        if platform_order_id and not order_id:
            r = supabase.table('orders').select('id').eq('platform_order_id', platform_order_id).limit(1).execute()
            if not r.data:
                return {"status": "ignored", "reason": "Order not found"}
            order_id = r.data[0]['id']

        if not order_id:
            raise HTTPException(status_code=400, detail="Provide order_id, platform_order_id, or email_body.")

        result = _do_cancel_order(order_id, platform_order_id)
        if not result.get("cancelled"):
            return {
                "status": "partial_failure",
                "platform_order_id": platform_order_id or order_id,
                "detail": f"{result.get('failed_job_count', 0)} print job(s) could not be confirmed cancelled — "
                          "order set to 'hold' for manual review.",
            }
        return {"status": "success", "platform_order_id": platform_order_id or order_id}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"cancel endpoint error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ----------------- CLI Argument Routing -----------------

def main():
    parser = argparse.ArgumentParser(description="Orbot Unified Service CLI Router")
    subparsers = parser.add_subparsers(dest="command", help="Subcommand to execute")

    # 1. Server Subcommand
    server_parser = subparsers.add_parser("server", help="Start FastAPI web server + background workers daemon")
    server_parser.add_argument("--port", type=int, default=8080, help="Port to run the FastAPI web server on")
    server_parser.add_argument("--host", type=str, default="0.0.0.0", help="Host address to run the FastAPI web server on")
    server_parser.add_argument("--no-daemon", action="store_true", help="Start web server without background daemon threads")

    # 2. Daemon Subcommand
    subparsers.add_parser("daemon", help="Run background worker loops directly (blocking, no HTTP server)")

    # 3. Scout Subcommand
    subparsers.add_parser("scout", help="Run a single Gmail poll cycle of the Scout Agent")

    # 4. Waybill Subcommand
    waybill_parser = subparsers.add_parser("waybill", help="Run Waybill Agent features")
    waybill_group = waybill_parser.add_mutually_exclusive_group()
    waybill_group.add_argument("--daemon", action="store_true", help="Run waybill agent as background daemon polling jobs")
    waybill_group.add_argument("--batch-print", action="store_true", help="Compile ready-to-print waybills into a master batch PDF")
    waybill_parser.add_argument("--waybill", type=str, help="Manual override: local path to the raw waybill PDF")
    waybill_parser.add_argument("--packing-list", type=str, help="Manual override: local path to the packing list PDF")

    # 5. Catalog Subcommand
    catalog_parser = subparsers.add_parser("catalog", help="Run product catalog ingestion")
    catalog_parser.add_argument("file_path", type=str, help="Path to catalog CSV or XLSX file")

    # 6. Archivist Subcommand
    subparsers.add_parser("archivist", help="Run file archivist / reorganization tool")

    args = parser.parse_args()

    # Default: Run server if no command given
    if not args.command:
        print("[*] No command specified. Starting unified web server + background daemons...")
        os.environ["START_DAEMON_THREADS"] = "true"
        port = int(os.environ.get("PORT", 8080))
        # MUST stay a single worker/replica: dispatch serialization, Scout scan
        # coalescing, and the module-level caches all rely on in-process locks.
        uvicorn.run("main:app", host="0.0.0.0", port=port)
        return

    if args.command == "server":
        os.environ["START_DAEMON_THREADS"] = "false" if args.no_daemon else "true"
        port = args.port or int(os.environ.get("PORT", 8080))
        uvicorn.run("main:app", host=args.host, port=port)

    elif args.command == "daemon":
        print("[*] Starting background workers daemon mode...")
        try:
            async def run_daemon_loop():
                await asyncio.gather(
                    run_waybill_daemon_async(),
                    run_scout_periodic_async()
                )
            asyncio.run(run_daemon_loop())
        except KeyboardInterrupt:
            print("\n[*] Exiting background workers.")

    elif args.command == "scout":
        print("[*] Running Scout Gmail poll cycle...")
        agent = ScoutAgent()
        agent.run()

    elif args.command == "waybill":
        print("[*] Delegating to Waybill Agent...")
        try:
            drive_service = get_drive_service()
        except Exception as e:
            print(f"[-] Failed to authenticate with Google Drive API: {e}")
            sys.exit(1)

        if args.daemon:
            async def _waybill_daemon():
                await asyncio.gather(run_waybill_daemon_async(), run_scout_periodic_async())
            asyncio.run(_waybill_daemon())
        elif args.batch_print:
            run_batch_print(drive_service)
        elif args.waybill and args.packing_list:
            if not os.path.exists(args.waybill) or not os.path.exists(args.packing_list):
                print("[-] Error: One or both of the provided local files do not exist.")
                sys.exit(1)
            process_ingestion(drive_service, args.waybill, args.packing_list)
        elif args.waybill:
            if not os.path.exists(args.waybill):
                print("[-] Error: The provided local file does not exist.")
                sys.exit(1)
            process_ingestion(drive_service, args.waybill)
        else:
            run_incoming_scan(drive_service)

    elif args.command == "catalog":
        print(f"[*] Delegating catalog ingestion for {args.file_path}...")
        process_catalog(args.file_path)

    elif args.command == "archivist":
        print("[*] Delegating to Archivist...")
        match_map, set_num_map = fetch_master_truth()
        source_dir = input("Enter source directory: ").strip()
        dest_dir = input("Enter destination directory: ").strip()
        if source_dir and dest_dir:
            scan_and_reorganize(source_dir, dest_dir, match_map, set_num_map)

if __name__ == "__main__":
    main()
