let supabaseClient = null;
// Fixed Railway URL for this deployment — used to bootstrap /config on first load, before
// any localStorage override exists. A per-browser override can still be set via Settings
// (e.g. pointing a local checkout at a different backend for testing).
const DEFAULT_BACKEND_URL = "https://web-production-fb6c3.up.railway.app";
let spDispatchEnabled = true; // synced from backend /config; see isSpDispatchEnabled()
let currentTab = "overview";
let activeLogFilter = "all";
let activeWaybillFilter = "all";
let activeOrderFilter = "active"; // "active" = everything not completed (daily default)
let orderSearchQuery = "";
let waybillSearchQuery = "";
let jobsSearchQuery = "";
let ordersStartDate = "";
let ordersEndDate = "";
let waybillsStartDate = "";
let waybillsEndDate = "";
let ordersDateSortDirection = "desc"; // "desc" or "asc"
let waybillsDateSortDirection = "desc"; // "desc" or "asc"
let catalogSortOrder = "asc"; // "asc" or "desc"
let cachedOrders = [];
// Monotonic request token guarding fetchAndRenderOrders() against a stale in-flight
// request (e.g. a slow manual refresh) overwriting a newer one (e.g. a rapid filter
// change or the poll interval firing again) — same pattern as cpQueryToken/cpRemoteSearch.
let ordersFetchToken = 0;
let selectedOrderId = null; // Master-detail: which order's detail panel is showing
let bulkSelectedOrderIds = new Set(); // Orders list: checkbox-selected rows for bulk actions
let selectedProductId = null; // Master-detail: which product's detail panel is showing
let catalogAttentionFilter = "all"; // "all" | "needs_attention" | "full_coverage" | "low_stock"
let lastRenderedProductsList = []; // Snapshot of the currently rendered product list, for keyboard nav
let lastRenderedOrdersList = []; // Snapshot of the currently rendered orders list, for keyboard nav + select-all
let cachedVariants = [];
let cachedProducts = [];
let cachedFilteredWaybills = [];
let cachedListings = [];
let listingsActiveFilter = "all";
let listingsPlatformFilter = "all";
let listingsSortOrder = "name_asc";
let listingsMissingFilter = "all";
let ganttTimeWindow = 24;
// Multi-shop: the currently-selected shop scope. "all" = every shop, "unassigned" = orders
// with no shop_id, otherwise a shops.id. Persisted so it survives reloads. cachedShops holds
// the shops table for the header switcher and for mapping shop_id -> name in the UI.
let currentShop = localStorage.getItem("orbot_current_shop") || "all";
let cachedShops = [];

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Rejects (returns "") any href/URL that resolves to a javascript: (or other
// script-executing) scheme, tolerating whitespace/control-char obfuscation
// (e.g. "java\tscript:"). Safe for use directly in an href="${...}" attribute
// alongside escapeHtml. Non-string/empty input passes through as "".
function sanitizeUrl(url) {
  if (url == null) return "";
  const raw = String(url);
  // Strip whitespace/control characters browsers ignore when parsing a URL
  // scheme, so a payload like "java\tscript:alert(1)" can't slip past a naive
  // prefix check.
  const stripped = raw.replace(/[\x00-\x1f\x7f\s]+/g, "");
  if (/^javascript:/i.test(stripped) || /^data:/i.test(stripped) || /^vbscript:/i.test(stripped)) {
    return "";
  }
  return raw;
}

// ---------------- Icon system (Signal Deck: inline SVG, not Material Symbols) ----------------
// Existing code (here and in index.html) still writes
// `<span class="material-symbols-outlined ...">icon_name</span>` exactly as before — that
// markup is untouched. This layer swaps each such span for an inline SVG matching the new
// hand-drawn icon style, driven by name lookup, then a MutationObserver keeps doing that for
// every future dynamically-rendered span (order rows, printer cards, etc.) with no per-call-site
// changes required anywhere else in the codebase.
const ICON_PATHS = {
  add: '<path d="M12 5v14M5 12h14"/>',
  add_box: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/>',
  add_circle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  add_photo_alternate: '<rect x="3" y="5" width="14" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="M5 17l4-4 3 3 3-3 3 3"/><path d="M18 3v6M15 6h6"/>',
  analytics: '<path d="M4 20V10M10 20V6M16 20v-8"/><path d="M2 20h20"/>',
  arrow_downward: '<path d="M12 4v16M6 14l6 6 6-6"/>',
  arrow_drop_down: '<path d="M7 10l5 5 5-5"/>',
  arrow_forward: '<path d="M4 12h16M14 6l6 6-6 6"/>',
  auto_awesome: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  auto_fix_high: '<path d="M4 20l9-9M14 8l2 2"/><path d="M17 3l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/><path d="M5 3l.6 1.4L7 5l-1.4.6L5 7l-.6-1.4L3 5l1.4-.6z"/>',
  autorenew: '<path d="M4 12a8 8 0 0114-5.3M20 5v5h-5"/><path d="M20 12a8 8 0 01-14 5.3M4 19v-5h5"/>',
  bar_chart: '<path d="M5 20V11M12 20V4M19 20v-7"/><path d="M3 20h18"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/>',
  bolt: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
  calendar_month: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  check_circle: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  clear_all: '<path d="M3 6h12M3 12h18M3 18h12"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  cloud_upload: '<path d="M7 18a4 4 0 01-1-7.9A5 5 0 0116 8a4.5 4.5 0 011 8.9"/><path d="M12 11v7M9 14l3-3 3 3"/>',
  code: '<path d="M8 6L2 12l6 6M16 6l6 6-6 6"/>',
  content_copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
  dashboard: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  delete: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  delete_sweep: '<path d="M4 6h9M8 6V4h4v2M6 6l.6 9.6M14 6l-.3 4.5M18 10l-1 9H8"/>',
  description: '<path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  dns: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><circle cx="7" cy="7" r="1"/><circle cx="7" cy="17" r="1"/>',
  done: '<path d="M4 12l5 5L20 6"/>',
  done_all: '<path d="M2 12l4 4L14 8"/><path d="M9 12l4 4L22 8"/>',
  donut_small: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 3v5M21 12h-5"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/>',
  dynamic_feed: '<rect x="4" y="9" width="16" height="4" rx="1"/><rect x="4" y="15" width="16" height="4" rx="1"/><path d="M7 5h10"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 000-3L18 6a2.1 2.1 0 00-3 0L4.5 16.5z"/>',
  emergency: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  emergency_home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M12 12v4M12 18h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  error_outline: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  expand_more: '<path d="M6 9l6 6 6-6"/>',
  filter_alt: '<path d="M4 5h16l-6 8v6l-4 2v-8z"/>',
  folder_open: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v1H6z"/><path d="M3 8l1.5 10a2 2 0 002 2h11a2 2 0 002-2L21 8"/>',
  history: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M3 8V4M3 8h4"/>',
  hub: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v6M12 13l-6 4M12 13l6 4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  inventory: '<rect x="3" y="7" width="18" height="14" rx="1.5"/><path d="M3 7l2-4h14l2 4"/><path d="M9 11h6"/>',
  inventory_2: '<rect x="3" y="8" width="18" height="12" rx="1.5"/><path d="M3 8l2-5h14l2 5"/><path d="M10 12h4"/>',
  label: '<path d="M3 10l7-7h8a2 2 0 012 2v8l-7 7a2 2 0 01-3 0l-7-7a2 2 0 010-3z"/><circle cx="15" cy="9" r="1.2"/>',
  label_off: '<path d="M3 10l7-7h8a2 2 0 012 2v8l-7 7a2 2 0 01-3 0l-7-7a2 2 0 010-3z"/><circle cx="15" cy="9" r="1.2"/><path d="M4 4l16 16"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  link: '<path d="M9 15l6-6"/><path d="M13 6l1.5-1.5a4 4 0 015.7 5.7L18.5 12"/><path d="M11 18l-1.5 1.5a4 4 0 01-5.7-5.7L5.5 12"/>',
  link_off: '<path d="M9 15l2-2"/><path d="M13 6l1.5-1.5a4 4 0 015.7 5.7L18.5 12"/><path d="M11 18l-1.5 1.5a4 4 0 01-5.7-5.7L5.5 12"/><path d="M4 4l16 16"/>',
  list_alt: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M7 9h10M7 13h10M7 17h6"/>',
  local_shipping: '<path d="M3 7h11v9H3z"/><path d="M14 11h4l3 3v2h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 6l9 7 9-7"/>',
  monitor_heart: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 12h3l2 4 3-8 2 4h4"/>',
  nest_heat_link_gen_3: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  note_add: '<path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5"/><path d="M12 11v6M9 14h6"/>',
  open_in_new: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h5"/>',
  photo_library: '<rect x="3" y="6" width="14" height="13" rx="2"/><circle cx="8" cy="11" r="1.3"/><path d="M5 17l3-3.5 2.5 2.5L15 12l3 5"/>',
  picture_as_pdf: '<path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5"/><path d="M9 13v4M9 13h1.5a1.5 1.5 0 010 3H9M13 17v-4h2M13 15h1.5"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><path d="M6 17v4h12v-4"/>',
  progress_activity: '<path d="M12 3a9 9 0 106.4 2.6"/>',
  receipt_long: '<path d="M6 2h12v20l-2-1.5L14 22l-2-1.5L10 22l-2-1.5L6 22z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  refresh: '<path d="M4 12a8 8 0 0114-5.3M20 5v5h-5"/><path d="M20 12a8 8 0 01-14 5.3M4 19v-5h5"/>',
  restart_alt: '<path d="M4 12a8 8 0 118 8"/><path d="M4 21v-5h5"/>',
  robot: '<rect x="5" y="8" width="14" height="10" rx="2"/><circle cx="9" cy="13" r="1.3"/><circle cx="15" cy="13" r="1.3"/><path d="M12 4v4M9 21h6"/>',
  rocket_launch: '<path d="M12 2c3 2 5 6 5 10 0 2-1 4-2 5l-3 2-3-2c-1-1-2-3-2-5 0-4 2-8 5-10z"/><path d="M9 15l-3 3 1 3 3-1M15 15l3 3-1 3-3-1"/>',
  rotate_left: '<path d="M9 3L5 7l4 4"/><path d="M5 7h8a7 7 0 11-6.3 10"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
  schedule: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a7.9 7.9 0 000-6l2-1.7-2-3.4-2.3 1a8 8 0 00-3.1-1.8L13.5 1h-3l-.5 2.1A8 8 0 006.9 4.9l-2.3-1-2 3.4L4.6 9a7.9 7.9 0 000 6l-2 1.7 2 3.4 2.3-1a8 8 0 003.1 1.8l.5 2.1h3l.5-2.1a8 8 0 003.1-1.8l2.3 1 2-3.4z"/>',
  settings_applications: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a7.9 7.9 0 000-6l2-1.7-2-3.4-2.3 1a8 8 0 00-3.1-1.8L13.5 1h-3l-.5 2.1A8 8 0 006.9 4.9l-2.3-1-2 3.4L4.6 9a7.9 7.9 0 000 6l-2 1.7 2 3.4 2.3-1a8 8 0 003.1 1.8l.5 2.1h3l.5-2.1a8 8 0 003.1-1.8l2.3 1 2-3.4z"/>',
  shopping_cart: '<circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/><path d="M2 3h3l2.5 12h11L21 8H6"/>',
  show_chart: '<path d="M3 17l5-6 4 3 6-8 3 3"/>',
  skip_next: '<path d="M5 5v14l10-7z"/><path d="M18 5v14"/>',
  storefront: '<path d="M3 9l1-5h16l1 5"/><path d="M4 9a2 2 0 004 0 2 2 0 004 0 2 2 0 004 0 2 2 0 004 0"/><path d="M5 9v10h14V9"/>',
  sync: '<path d="M4 12a8 8 0 0114-5.3M20 5v5h-5"/><path d="M20 12a8 8 0 01-14 5.3M4 19v-5h5"/>',
  thermometer: '<path d="M12 3a2 2 0 00-2 2v9a4 4 0 104 0V5a2 2 0 00-2-2z"/><circle cx="12" cy="18" r="2"/>',
  touch_app: '<path d="M9 12V5a1.5 1.5 0 013 0v6"/><path d="M12 11V4a1.5 1.5 0 013 0v7"/><path d="M15 11V6a1.5 1.5 0 013 0v9c0 4-2 7-6 7s-6-2-7-5l-2-5a1.4 1.4 0 012.5-1.2L7 13"/>',
  train: '<rect x="5" y="4" width="14" height="12" rx="4"/><path d="M5 12h14M9 16l-2 4M15 16l2 4"/><circle cx="9" cy="8" r="1"/><circle cx="15" cy="8" r="1"/>',
  travel_explore: '<circle cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 010 14M10 3a7 7 0 000 14M3 10h14"/><path d="M20 20l-4.3-4.3"/>',
  update: '<path d="M4 12a8 8 0 0114-5.3M20 5v5h-5"/><path d="M20 12a8 8 0 01-14 5.3M4 19v-5h5"/>',
  upload_file: '<path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5"/><path d="M12 17v-6M9 14l3-3 3 3"/>',
  view_timeline: '<rect x="3" y="5" width="18" height="4" rx="1"/><rect x="3" y="11" width="12" height="4" rx="1"/><rect x="3" y="17" width="16" height="4" rx="1"/>',
  warning: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17h.01"/>',
  wifi_off: '<path d="M3 3l18 18"/><path d="M9.5 9.5a7 7 0 018.5 1M5 8a11 11 0 013-1.8M2 5a15 15 0 013.5-2.3"/><path d="M12 18h.01"/>',
};

function materializeIcons(root) {
  (root || document).querySelectorAll(".material-symbols-outlined").forEach(el => {
    const name = el.textContent.trim();
    const inner = ICON_PATHS[name];
    if (!inner) return;
    const fontSize = parseFloat(getComputedStyle(el).fontSize) || 20;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.width = svg.style.height = fontSize + "px";
    svg.style.flexShrink = "0";
    svg.style.display = "inline-block";
    svg.style.verticalAlign = "middle";
    svg.innerHTML = inner;
    svg.className.baseVal = el.className;
    svg.setAttribute("data-icon", name);
    el.replaceWith(svg);
  });
}

function setupIconObserver() {
  materializeIcons(document);
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList && node.classList.contains("material-symbols-outlined")) materializeIcons(node.parentNode);
        else if (node.querySelector && node.querySelector(".material-symbols-outlined")) materializeIcons(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ---------------- Backend API (Railway) shared-secret auth ----------------
// Every backend route except GET /, GET /status, GET /config now requires an
// X-Orbot-Key header matching a server-side shared secret (set once here by
// whoever runs the dashboard, not a per-user credential). backendFetch() is
// the single call site every backend request should go through so the header
// is never forgotten, and so a rotated/incorrect key is handled uniformly.
function getBackendUrl() {
  return (localStorage.getItem("orbot_backend_url") || DEFAULT_BACKEND_URL).replace(/\/$/, "");
}

function getOrbotApiKey() {
  let key = localStorage.getItem("orbot_api_key");
  if (!key) {
    key = window.prompt("Enter the Orbot API key:") || "";
    if (key) localStorage.setItem("orbot_api_key", key);
  }
  return key || "";
}

// Wraps fetch() for calls to the Railway backend: resolves the backend base
// URL, attaches X-Orbot-Key, and if the backend replies 401 (missing/rotated
// key) clears the stored key and re-prompts so the next call can succeed.
async function backendFetch(path, opts = {}) {
  const url = `${getBackendUrl()}${path}`;
  const headers = { ...(opts.headers || {}), "X-Orbot-Key": localStorage.getItem("orbot_api_key") || "" };
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    localStorage.removeItem("orbot_api_key");
    showToast("Orbot API key was rejected — please re-enter it.", "warning");
    getOrbotApiKey();
  }
  return res;
}

function showToast(message, type = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.style.cssText = "position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;display:flex;flex-direction:column;gap:0.5rem;pointer-events:none;max-width:360px;";
    document.body.appendChild(container);
  }
  const palette = {
    success: { bg: "rgba(16,185,129,0.12)", border: "rgba(16,185,129,0.4)", text: "#10b981", icon: "check_circle" },
    error:   { bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.4)",  text: "#ef4444", icon: "error" },
    warning: { bg: "rgba(234,179,8,0.12)",  border: "rgba(234,179,8,0.4)",  text: "#eab308", icon: "warning" },
    info:    { bg: "rgba(62, 207, 142,0.12)", border: "rgba(62, 207, 142,0.4)", text: "#3ecf8e", icon: "info" },
  };
  const c = palette[type] || palette.info;
  const toast = document.createElement("div");
  toast.style.cssText = `background:${c.bg};border:1px solid ${c.border};color:${c.text};padding:0.65rem 0.875rem;border-radius:8px;font-family:'IBM Plex Mono',monospace;font-size:0.78rem;backdrop-filter:blur(12px);pointer-events:auto;opacity:0;transform:translateX(12px);transition:all 0.22s ease;display:flex;align-items:flex-start;gap:0.5rem;word-break:break-word;`;
  toast.innerHTML = `<span class="material-symbols-outlined" style="font-size:15px;flex-shrink:0;margin-top:1px;">${c.icon}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = "1"; toast.style.transform = "translateX(0)"; });
  setTimeout(() => {
    toast.style.opacity = "0"; toast.style.transform = "translateX(12px)";
    setTimeout(() => toast.remove(), 220);
  }, 3500);
}

async function logAction(message, level = "info", meta = {}) {
  if (!supabaseClient) return;
  try {
    await supabaseClient.from("system_logs").insert({
      agent_name: "dashboard",
      log_level: level,
      log_message: message,
      additional_details: Object.keys(meta).length ? meta : null
    });
  } catch (e) {
    // Best-effort, but never fully silent — a schema mismatch here once went
    // unnoticed for weeks because this catch swallowed every failure.
    console.warn("logAction failed:", e);
  }
}

// parseFloat(x) || null turns a legitimate 0 into null — keep 0 prices.
function priceOrNull(raw) {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// Skeleton shimmer placeholders (Aurora 3.0). Same call signatures as the
// old spinner helpers so every existing call site upgrades automatically.
function skeletonStack(bars = 4) {
  return `<div class="skeleton-stack">${`<div class="skeleton"></div>`.repeat(bars)}</div>`;
}

function loadingDiv(bars = 4) {
  return skeletonStack(bars);
}

// Optional third arg: pre-built action-button HTML (class "empty-action"),
// wired up by the caller after insertion.
function emptyDiv(message, icon = "search_off", actionHtml = "") {
  return `<div class="empty-state"><span class="material-symbols-outlined">${icon}</span><p>${message}</p>${actionHtml}</div>`;
}

function loadingRow(colspan = 6, bars = 3) {
  return `<tr><td colspan="${colspan}">${skeletonStack(bars)}</td></tr>`;
}

function emptyRow(message, icon = "search_off", colspan = 6) {
  return `<tr><td colspan="${colspan}">${emptyDiv(message, icon)}</td></tr>`;
}

// Animated count-up for numeric stat values (Aurora 3.0). Falls back to a
// plain assignment for non-numeric strings.
function tickStat(el, newValue) {
  if (!el) return;
  const target = Number(newValue);
  if (!Number.isFinite(target)) { el.innerText = newValue; return; }
  const from = Number(String(el.innerText).replace(/[^0-9.-]/g, "")) || 0;
  if (from === target) { el.innerText = String(target); return; }
  const t0 = performance.now(), dur = 450;
  const step = (t) => {
    const k = Math.min((t - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - k, 3);
    el.innerText = String(Math.round(from + (target - from) * eased));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // rAF is throttled/paused in background tabs — guarantee the final value.
  setTimeout(() => { el.innerText = String(target); }, dur + 120);
}

// Freshness stamps: fetch functions call markFresh(key); every element with
// data-fresh="key" is re-ticked by the 1s system clock so users can always
// tell how stale a polled panel is.
const panelFreshness = {};
function markFresh(key) {
  panelFreshness[key] = Date.now();
  tickFreshStamps();
}
function tickFreshStamps() {
  document.querySelectorAll("[data-fresh]").forEach(el => {
    const ts = panelFreshness[el.getAttribute("data-fresh")];
    if (!ts) return;
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    el.textContent = s < 5 ? "updated just now" : s < 60 ? `updated ${s}s ago` : `updated ${Math.floor(s / 60)}m ago`;
  });
}

// Helper to format remaining time (ETA)
function formatEta(isoString) {
  if (!isoString) return "";
  const target = new Date(isoString);
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return "Finishing now";
  
  const diffMins = Math.round(diffMs / 60000);
  if (diffMins < 60) {
    return `ETA: ~${diffMins}m`;
  } else {
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return `ETA: ~${hours}h ${mins}m`;
  }
}

// Helper to update system clock and date
function updateSystemClock() {
  const clockEl = document.getElementById("system-clock");
  const dateEl = document.getElementById("system-date");
  if (!clockEl || !dateEl) return;

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });

  clockEl.innerText = timeStr;
  dateEl.innerText = dateStr;
  tickFreshStamps();
}

function isSpDispatchEnabled() {
  return spDispatchEnabled;
}

function updateDispatchIndicator() {
  const enabled = isSpDispatchEnabled();
  document.querySelectorAll(".sp-dispatch-indicator").forEach(el => {
    el.classList.toggle("hidden", enabled);
  });
  // Dim foreman dispatch buttons when dispatch is off
  ["ctrl-trigger-foreman", "waybill-ctrl-trigger-foreman", "overview-ctrl-trigger-foreman"].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (enabled) {
      btn.classList.remove("opacity-60");
      btn.title = "";
    } else {
      btn.classList.add("opacity-60");
      btn.title = "SimplyPrint dispatch is disabled — running in dry-run mode";
    }
  });
}

// Initialize configuration. Credentials/keys are fetched from the backend's GET /config
// (sourced from Railway env vars) so the dashboard works on any browser/device with zero
// setup. A localStorage value still wins if present, for local-dev overrides only —
// normal use should never need to touch the Settings modal's text fields.
async function initSupabase() {
  const localUrl = localStorage.getItem("orbot_supabase_url");
  const localKey = localStorage.getItem("orbot_supabase_key");
  const backendUrl = getBackendUrl();

  // Shared secret required by every backend route except GET /, /status, /config.
  // Prompt once (if not already stored) so the very first backend call after
  // this succeeds without a surprise 401.
  getOrbotApiKey();

  let remote = null;
  try {
    const res = await fetch(`${backendUrl}/config`);
    remote = JSON.parse(await res.text());
  } catch (error) {
    console.error("Failed to fetch /config from backend:", error);
  }

  const envUrl = window.ENV ? window.ENV.SUPABASE_URL : "";
  const envKey = window.ENV ? window.ENV.SUPABASE_SERVICE_ROLE_KEY : "";
  const supabaseUrl = localUrl || (remote && remote.supabase_url) || envUrl || "";
  // NOTE: /config now returns the Supabase anon key (RLS-gated), not the service-role
  // key — safe to store/display in Settings, no special secret handling needed.
  const supabaseKey = localKey || (remote && remote.supabase_key) || envKey || "";
  spDispatchEnabled = remote ? remote.sp_dispatch_enabled !== false : true;

  document.getElementById("setting-supabase-url").value = supabaseUrl;
  document.getElementById("setting-supabase-key").value = supabaseKey;
  document.getElementById("setting-backend-url").value = localStorage.getItem("orbot_backend_url") || "";
  const apiKeyField = document.getElementById("setting-orbot-api-key");
  if (apiKeyField) apiKeyField.value = localStorage.getItem("orbot_api_key") || "";
  document.getElementById("setting-sp-dispatch").checked = spDispatchEnabled;
  updateDispatchIndicator();

  if (!supabaseUrl || !supabaseKey) {
    console.error("Supabase credentials not configured.");
    return false;
  }

  try {
    supabaseClient = supabase.createClient(supabaseUrl, supabaseKey);
    return true;
  } catch (error) {
    console.error("Failed to initialize Supabase client:", error);
    return false;
  }
}

// ---------------- Multi-shop scope ----------------
// Load shops, populate the header switcher, and re-render the active view on change.
async function initShopSwitcher() {
  const sel = document.getElementById("shop-switcher");
  if (!supabaseClient || !sel) return;
  try {
    const { data: shops, error } = await supabaseClient
      .from("shops")
      .select("id, name, slug, sku_prefix, is_active")
      .order("name", { ascending: true });
    if (error) throw error;
    cachedShops = shops || [];
  } catch (err) {
    console.error("Failed to load shops:", err);
    cachedShops = [];
  }

  // Rebuild options: All Shops → each active shop → Unassigned.
  const opts = [`<option value="all">All Shops</option>`];
  for (const s of cachedShops) {
    if (s.is_active === false) continue;
    opts.push(`<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`);
  }
  opts.push(`<option value="unassigned">Unassigned</option>`);
  sel.innerHTML = opts.join("");

  // Restore persisted selection if it still exists, else fall back to "all".
  const valid = ["all", "unassigned", ...cachedShops.map(s => s.id)];
  if (!valid.includes(currentShop)) currentShop = "all";
  sel.value = currentShop;

  // Keep the custom pill label in sync with the (invisible) native select.
  const SHOP_DOT_COLORS = ["#3ecf8e", "#38bdf8", "#7ea6e8", "#ffaa6b", "#ff8c00"];
  const syncShopLabel = () => {
    const label = document.getElementById("shop-switcher-label");
    if (label) label.textContent = sel.options[sel.selectedIndex]?.text || "All Shops";
    const pill = sel.closest(".shop-pill");
    pill?.classList.toggle("scoped", sel.value !== "all");
    const dot = pill?.querySelector(".sc-dot");
    if (dot) {
      if (sel.value === "all") dot.style.background = "#7d8794";
      else if (sel.value === "unassigned") dot.style.background = "#525c69";
      else {
        const idx = cachedShops.findIndex(s => s.id === sel.value);
        dot.style.background = SHOP_DOT_COLORS[((idx % SHOP_DOT_COLORS.length) + SHOP_DOT_COLORS.length) % SHOP_DOT_COLORS.length];
      }
    }
  };
  syncShopLabel();

  sel.addEventListener("change", () => {
    currentShop = sel.value;
    localStorage.setItem("orbot_current_shop", currentShop);
    syncShopLabel();
    onShopChange();
  });
}

// Map a shop_id to its display name (for badges/columns).
function shopName(shopId) {
  if (!shopId) return "Unassigned";
  const s = cachedShops.find(x => x.id === shopId);
  return s ? s.name : "Unknown";
}

// Apply the active shop scope to a Supabase query on a table that has a shop_id column
// (orders). "all" → no filter; "unassigned" → shop_id IS NULL; otherwise → that shop.
function scopeByShop(query) {
  if (currentShop === "all") return query;
  if (currentShop === "unassigned") return query.is("shop_id", null);
  return query.eq("shop_id", currentShop);
}

// True when a cached row (orders/products with a shop_id) passes the active shop scope —
// used for client-side filtered views (catalog, listings) and cached order lists.
function passesShopScope(shopId) {
  if (currentShop === "all") return true;
  if (currentShop === "unassigned") return !shopId;
  return shopId === currentShop;
}

// Re-render everything affected by a shop-scope change.
function onShopChange() {
  fetchSummaryStats();
  fetchAndRenderOrders();
  if (currentTab === "orders") fetchAndRenderWaybillsArchive();
  if (currentTab === "products") {
    fetchAndRenderCatalog();
    renderListingsFromCache();
  }
  if (currentTab === "overview") {
    fetchAndRenderMissionControl();
  }
}

// Stats & General Refreshes
// Builds an .or() filter string matching rows whose "effective timestamp"
// (order_timestamp, falling back to created_at when null — same coalesce
// semantics used everywhere else in this file) falls within [gte, lt).
// Used so the stats counts below can be computed with count-only queries
// instead of pulling every order row to Postgres-count in JS.
function effectiveTimestampRangeFilter(gteIso, ltIso) {
  return `and(order_timestamp.gte.${gteIso},order_timestamp.lt.${ltIso}),and(order_timestamp.is.null,created_at.gte.${gteIso},created_at.lt.${ltIso})`;
}

async function fetchSummaryStats() {
  if (!supabaseClient) return;

  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const startOfTomorrow = new Date(startOfToday.getTime() + 86400000);
    const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
    const startOfTodayIso = startOfToday.toISOString();
    const startOfTomorrowIso = startOfTomorrow.toISOString();
    const startOfYesterdayIso = startOfYesterday.toISOString();

    // Counts pulled directly from Postgres via count:'exact', head:true — no rows
    // transferred — instead of fetching every order to count in JS.
    const [todayRes, yesterdayRes, pendingRes, holdRes, errorsRes] = await Promise.all([
      scopeByShop(supabaseClient.from("orders").select("id", { count: "exact", head: true })
        .or(effectiveTimestampRangeFilter(startOfTodayIso, startOfTomorrowIso))),
      scopeByShop(supabaseClient.from("orders").select("id", { count: "exact", head: true })
        .or(effectiveTimestampRangeFilter(startOfYesterdayIso, startOfTodayIso))),
      scopeByShop(supabaseClient.from("orders").select("id", { count: "exact", head: true })
        .neq("overall_order_status", "completed")),
      scopeByShop(supabaseClient.from("orders").select("id", { count: "exact", head: true })
        .eq("overall_order_status", "hold")),
      supabaseClient.from("system_logs").select("id", { count: "exact", head: true }).eq("log_level", "error"),
    ]);

    if (todayRes.error || yesterdayRes.error || pendingRes.error || holdRes.error || errorsRes.error) {
      throw new Error("Stats query failed");
    }

    const ordersTodayCount = todayRes.count ?? 0;
    const ordersYesterdayCount = yesterdayRes.count ?? 0;
    const pendingOrdersCount = pendingRes.count ?? 0;
    const ordersOnHoldCount = holdRes.count ?? 0;
    const errorsCount = errorsRes.count ?? 0;

    tickStat(document.getElementById("stats-orders"), ordersTodayCount);

    const trendEl = document.getElementById("stats-orders-trend");
    if (trendEl) {
      if (ordersYesterdayCount === 0 && ordersTodayCount === 0) {
        trendEl.textContent = "";
      } else {
        const delta = ordersTodayCount - ordersYesterdayCount;
        if (delta > 0) {
          trendEl.textContent = `+${delta} vs yday`;
          trendEl.style.color = "var(--success-color)";
        } else if (delta < 0) {
          trendEl.textContent = `${delta} vs yday`;
          trendEl.style.color = "var(--error-color)";
        } else {
          trendEl.textContent = "= yday";
          trendEl.style.color = "var(--text-muted)";
        }
      }
    }
    tickStat(document.getElementById("stats-items"), pendingOrdersCount);
    const navOrdersBadge = document.getElementById("nav-badge-orders");
    if (navOrdersBadge) navOrdersBadge.textContent = pendingOrdersCount > 0 ? String(pendingOrdersCount) : "";
    tickStat(document.getElementById("stats-hold"), ordersOnHoldCount);
    
    const errorEl = document.getElementById("stats-errors");
    tickStat(errorEl, errorsCount ?? 0);
    if (errorsCount > 0) {
      errorEl.style.color = "var(--error-color)";
      errorEl.style.textShadow = "0 0 10px var(--error-glow)";
    } else {
      errorEl.style.color = "var(--text-primary)";
      errorEl.style.textShadow = "none";
    }
    // Greeting subline (Overview) — real counts, no fabrication.
    const greetSub = document.getElementById("overview-greeting-sub");
    if (greetSub) {
      greetSub.innerHTML = `<b>${pendingOrdersCount} pending order${pendingOrdersCount === 1 ? "" : "s"}</b> · ${ordersTodayCount} new today · ${ordersOnHoldCount} on hold`;
    }
    fetchAndRenderAgentFeed();

    markFresh("stats");
  } catch (err) {
    console.error("Error fetching stats:", err);
  }
}

// Time-of-day greeting header (static per page load; name is cosmetic).
function renderGreeting() {
  const el = document.getElementById("overview-greeting");
  if (!el) return;
  const h = new Date().getHours();
  const part = h < 5 ? "Burning the midnight oil" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  el.textContent = `${part}, Joel`;
}

// Overview agent-activity feed: latest system_logs rows as a Draft 4 timeline.
async function fetchAndRenderAgentFeed() {
  if (!supabaseClient) return;
  const feedEl = document.getElementById("overview-agent-feed");
  if (!feedEl) return;
  try {
    const { data: logs, error } = await supabaseClient
      .from("system_logs")
      .select("created_at, log_level, agent_name, message")
      .order("created_at", { ascending: false })
      .limit(8);
    if (error) throw error;
    if (!logs || logs.length === 0) {
      feedEl.innerHTML = emptyDiv("No recent agent activity.", "history");
      return;
    }
    feedEl.innerHTML = logs.map(l => {
      const lvl = (l.log_level || "info").toLowerCase();
      const cls = lvl === "error" ? "bad" : lvl === "warning" ? "warn" : "ok";
      const who = escapeHtml(l.agent_name || "system");
      return `<div class="d4-fe ${cls}"><div class="ic"></div><div style="min-width:0"><div class="m"><b>${who}</b> · ${escapeHtml(l.message || "")}</div><div class="t">${timeAgo(l.created_at)}</div></div></div>`;
    }).join("");
  } catch (err) {
    console.error("Agent feed fetch failed:", err);
  }
}

// Fetch and Render Gemini API Usage Stats
async function fetchAndRenderGeminiUsage() {
  if (!supabaseClient) return;

  try {
    // Get start of today in ISO format (local date, start of day)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    const { data: logs, error } = await supabaseClient
      .from("gemini_usage_log")
      .select("*")
      .gte("created_at", todayIso);

    if (error) throw error;

    let totalRequests = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalTokens = 0;
    let modelCounts = {};

    if (logs && logs.length > 0) {
      totalRequests = logs.length;
      for (const log of logs) {
        totalPromptTokens += log.prompt_tokens || 0;
        totalCompletionTokens += log.completion_tokens || 0;
        totalTokens += log.total_tokens || 0;
        
        const m = log.model_name || "unknown";
        modelCounts[m] = (modelCounts[m] || 0) + 1;
      }
    }

    // Estimate cost: input: $0.075 / 1M tokens, output: $0.30 / 1M tokens
    const estCost = ((totalPromptTokens * 0.075) + (totalCompletionTokens * 0.30)) / 1000000;

    // Update UI elements
    const reqCountEl = document.getElementById("gemini-requests-count");
    const reqBarEl = document.getElementById("gemini-requests-bar");
    const tokCountEl = document.getElementById("gemini-tokens-count");
    const tokBarEl = document.getElementById("gemini-tokens-bar");
    const costEl = document.getElementById("gemini-cost-est");
    const inputEl = document.getElementById("gemini-input-tokens");
    const outputEl = document.getElementById("gemini-output-tokens");
    const breakdownEl = document.getElementById("gemini-breakdown-list");

    if (reqCountEl) reqCountEl.innerText = `${totalRequests.toLocaleString()} / 1,500`;
    if (reqBarEl) {
      const pct = Math.min((totalRequests / 1500) * 100, 100);
      reqBarEl.style.width = `${pct}%`;
    }

    if (tokCountEl) tokCountEl.innerText = `${totalTokens.toLocaleString()} / 1,000,000`;
    if (tokBarEl) {
      const pct = Math.min((totalTokens / 1000000) * 100, 100);
      tokBarEl.style.width = `${pct}%`;
    }

    // Condensed health-strip mini-gauges (Operations page) — same numbers, compact form.
    const reqPct = Math.min((totalRequests / 1500) * 100, 100);
    const tokPct = Math.min((totalTokens / 1000000) * 100, 100);
    const stripReqCount = document.getElementById("ops-gemini-requests-count");
    const stripReqBar = document.getElementById("ops-gemini-requests-bar");
    const stripTokCount = document.getElementById("ops-gemini-tokens-count");
    const stripTokBar = document.getElementById("ops-gemini-tokens-bar");
    if (stripReqCount) stripReqCount.innerText = `${totalRequests.toLocaleString()} / 1,500`;
    if (stripReqBar) stripReqBar.style.width = `${reqPct}%`;
    if (stripTokCount) stripTokCount.innerText = `${(totalTokens / 1000).toFixed(0)}K / 1M`;
    if (stripTokBar) stripTokBar.style.width = `${tokPct}%`;

    if (costEl) costEl.innerText = `$${estCost.toFixed(4)}`;
    if (inputEl) inputEl.innerText = totalPromptTokens.toLocaleString();
    if (outputEl) outputEl.innerText = totalCompletionTokens.toLocaleString();

    if (breakdownEl) {
      if (Object.keys(modelCounts).length === 0) {
        breakdownEl.innerHTML = `<span class="text-outline/70">No Gemini API requests made today.</span>`;
      } else {
        breakdownEl.innerHTML = Object.entries(modelCounts).map(([model, count]) => {
          // color mapping indicator dot
          const dotColor = model.includes("2.5") ? "bg-primary" : "bg-secondary";
          return `
            <span class="flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full ${dotColor}"></span>
              ${model}: <span class="font-data-mono text-on-surface">${count} request${count > 1 ? 's' : ''}</span>
            </span>
          `;
        }).join("");
      }
    }
    markFresh("gemini");
  } catch (err) {
    console.error("Failed to fetch Gemini usage stats:", err);
  }
}

// Patches a single order's status in the in-memory cache and re-renders every
// mounted orders view from that cache (no network round-trip) — avoids a full
// refetch-and-rebuild of up to 200 nested orders (items + print_jobs + files)
// after a single-row status change. fetchSummaryStats() is still called since
// it's now a handful of lightweight count-only queries, not a full table scan.
// The periodic poll interval will still resync cachedOrders from the network
// on its own schedule, so any drift from this optimistic patch self-heals.
function patchOrderStatusLocally(orderId, newStatus) {
  const order = cachedOrders.find(o => o.id === orderId);
  if (order) order.overall_order_status = newStatus;
  fetchSummaryStats();
  fetchAndRenderOrders(false);
}

// Same idea as patchOrderStatusLocally() but for a deleted order: drop it from
// the in-memory cache and re-render from cache instead of a full network refetch.
function patchOrderDeletedLocally(orderId) {
  cachedOrders = cachedOrders.filter(o => o.id !== orderId);
  fetchSummaryStats();
  fetchAndRenderOrders(false);
}

// Fetch and Render Orders
async function fetchAndRenderOrders(forceFetch = true) {
  if (!supabaseClient) return;
  const listContainer = document.getElementById("orders-list");
  const overviewContainer = document.getElementById("overview-orders-list");
  if (!listContainer && !overviewContainer) return;

  const myToken = ++ordersFetchToken;

  if (listContainer) listContainer.innerHTML = loadingDiv();

  try {
    if (forceFetch || cachedOrders.length === 0) {
      let query = supabaseClient
        .from("orders")
        .select("*, order_items(id, variant_sku, variant_name, purchased_quantity, item_print_status, sent_to_print_timestamp, variants(seal_sticker_gdrive_url), print_jobs(id, print_file_name, simplyprint_job_id, job_execution_status, printer_name, queue_position, estimated_finish_time, percent_complete, print_files(print_time_m, simplyprint_file_id)))")
        .order("created_at", { ascending: false })
        .limit(200);

      if (ordersStartDate) {
        query = query.gte("order_timestamp", ordersStartDate);
      }
      if (ordersEndDate) {
        const end = new Date(ordersEndDate);
        end.setDate(end.getDate() + 1);
        query = query.lt("order_timestamp", end.toISOString().split("T")[0]);
      }
      query = scopeByShop(query);

      const { data: orders, error } = await query;
      if (myToken !== ordersFetchToken) return; // a newer fetch has since started — drop this stale response
      if (error) throw error;
      cachedOrders = orders || [];
    }

    let filtered = cachedOrders;

    // Apply status filter ("active" = everything not completed)
    if (activeOrderFilter !== "all") {
      filtered = filtered.filter(o => {
        const statusLower = (o.overall_order_status || "").toLowerCase();
        if (activeOrderFilter === "active") {
          return statusLower !== "completed";
        }
        if (activeOrderFilter === "hold") {
          return statusLower === "hold" || statusLower === "on hold";
        }
        return statusLower === activeOrderFilter;
      });
    }

    // Apply search query
    if (orderSearchQuery) {
      const query = orderSearchQuery.toLowerCase();
      filtered = filtered.filter(o => 
        (o.platform_order_id || "").toLowerCase().includes(query) ||
        (o.customer_name || "").toLowerCase().includes(query) ||
        (o.order_items || []).some(item => 
          (item.variant_sku || "").toLowerCase().includes(query) || 
          (item.variant_name || "").toLowerCase().includes(query)
        )
      );
    }

    // Apply date range filter
    if (ordersStartDate || ordersEndDate) {
      filtered = filtered.filter(o => {
        const orderDateVal = o.order_timestamp || o.created_at;
        if (!orderDateVal) return false;
        const oDate = new Date(orderDateVal);
        
        // Convert order date to YYYY-MM-DD local format for comparison
        const year = oDate.getFullYear();
        const month = String(oDate.getMonth() + 1).padStart(2, '0');
        const day = String(oDate.getDate()).padStart(2, '0');
        const oDateStr = `${year}-${month}-${day}`;

        if (ordersStartDate && oDateStr < ordersStartDate) return false;
        if (ordersEndDate && oDateStr > ordersEndDate) return false;
        return true;
      });
    }

    // Apply date sorting
    filtered.sort((a, b) => {
      const dateA = new Date(a.order_timestamp || a.created_at || 0);
      const dateB = new Date(b.order_timestamp || b.created_at || 0);
      return ordersDateSortDirection === "asc" ? dateA - dateB : dateB - dateA;
    });

    if (listContainer) {
      renderOrdersMasterDetail(filtered);
      markFresh("orders");
    }
    if (overviewContainer) {
      const pendingOrders = cachedOrders.filter(o => (o.overall_order_status || "").toLowerCase() !== "completed");
      pendingOrders.sort((a, b) => {
        const dateA = new Date(a.order_timestamp || a.created_at || 0);
        const dateB = new Date(b.order_timestamp || b.created_at || 0);
        return ordersDateSortDirection === "asc" ? dateA - dateB : dateB - dateA;
      });
      renderOrdersTableToContainer(overviewContainer, "overview-", pendingOrders);

      // KPI footer: age of the oldest pending order.
      const oldestEl = document.getElementById("stats-pending-oldest");
      if (oldestEl) {
        if (pendingOrders.length === 0) {
          oldestEl.textContent = "";
        } else {
          const oldest = pendingOrders.reduce((min, o) => {
            const t = new Date(o.order_timestamp || o.created_at || 0).getTime();
            return t < min ? t : min;
          }, Infinity);
          const days = Math.floor((Date.now() - oldest) / 86400000);
          oldestEl.textContent = days >= 1 ? `oldest ${days}d ago` : "all from today";
        }
      }
    }

    // Update hold panel using full cachedOrders list
    renderHoldPanel(cachedOrders);

  } catch (err) {
    const errMsg = emptyDiv(`Error loading orders: ${escapeHtml(err.message)}`, "error");
    if (listContainer) listContainer.innerHTML = errMsg;
    if (overviewContainer) overviewContainer.innerHTML = errMsg;
  }
}

// Draft 4 pending-orders table: d4-otbl with expandable inline detail rows.
// Expanded rows are tracked in a module-level Set of order ids so the periodic
// poll's re-render can restore them (the DOM is rebuilt from scratch each time).
const expandedOrderRowIds = new Set();

function d4OrderStatusMeta(order) {
  const s = (order.overall_order_status || "").toLowerCase();
  if (s === "printing") return "printing";
  if (s === "printed") return "printed";
  if (s === "pending") return "pending";
  if (s === "hold" || s === "on hold") return "hold";
  return "completed";
}

function d4WaybillChip(order) {
  const w = (order.waybill_processing_status || "pending").toLowerCase();
  let cls = "queue", label = w;
  if (w === "ready" || w === "ready to print") { cls = "done"; label = "ready"; }
  else if (w === "compiled") { cls = "done"; label = "compiled"; }
  else if (w === "printed") { cls = "print"; label = "printed"; }
  else if (w === "pending") { cls = "queue"; label = "pending"; }
  else if (w === "hold" || w === "on hold" || w === "failed") { cls = "err"; label = w; }
  return `<span class="d4-stchip ${cls}"><i></i>${escapeHtml(label)}</span>`;
}

function d4SkuPill(sku, qty) {
  const s = (sku || "").toUpperCase();
  const type = s.startsWith("FWM") ? "fwm" : s.startsWith("WM") ? "wm" : s.startsWith("DS") ? "ds" : "";
  const qtyHtml = qty > 1 ? ` ×${qty}` : "";
  return `<span class="d4-pill ${type}">${escapeHtml(sku || "?")}${qtyHtml}</span>`;
}

function d4JobChip(status) {
  const s = (status || "").toLowerCase();
  const cls = s === "printing" ? "print" : s === "completed" ? "done" : s === "failed" ? "err" : "queue";
  return `<span class="d4-stchip ${cls}"><i></i>${escapeHtml(status || "pending")}</span>`;
}

function renderOrdersTableToContainer(container, prefix, filtered) {
  const countEl = document.getElementById(`${prefix}orders-count`);
  if (countEl) countEl.textContent = String(filtered.length);

  if (filtered.length === 0) {
    container.innerHTML = emptyDiv("No matching orders found.", "receipt_long", `<button class="empty-action" onclick="document.getElementById('ctrl-trigger-scout')?.click()"><span class="material-symbols-outlined">mail</span>Trigger Gmail Scan</button>`);
    return;
  }

  const showBrand = currentShop === "all";
  const colCount = 9 + (showBrand ? 1 : 0);

  let html = `
    <table class="d4-otbl" id="${prefix}orders-table">
      <thead>
        <tr>
          <th>Order ID</th>
          ${showBrand ? `<th>Brand</th>` : ""}
          <th>Platform</th>
          <th id="${prefix}sort-date-col" style="cursor:pointer" title="Toggle date sort">Date <span class="sort">${ordersDateSortDirection === "asc" ? "▲" : "▼"}</span></th>
          <th>Customer</th>
          <th>Items</th>
          <th>Subtotal</th>
          <th>Waybill</th>
          <th>Status</th>
          <th style="width:26px"></th>
        </tr>
      </thead>
      <tbody>
  `;

  const now = Date.now();
  for (const order of filtered) {
    const orderDateVal = order.order_timestamp || order.created_at;
    const oDate = orderDateVal ? new Date(orderDateVal) : null;
    const dateStr = oDate
      ? `${oDate.toLocaleDateString([], { month: "short", day: "numeric" })}, ${oDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`
      : "N/A";
    const statusLower = (order.overall_order_status || "").toLowerCase();
    const isDone = statusLower === "completed";
    const isHot = !isDone && oDate && (now - oDate.getTime()) > 2 * 86400000;
    const statusClass = d4OrderStatusMeta(order);

    const itemsList = order.order_items || [];
    const itemsHtml = itemsList.length
      ? itemsList.map(item => d4SkuPill(item.variant_sku, item.purchased_quantity)).join(" ")
      : `<span style="color:var(--ink-4);font-size:11px">no items</span>`;

    const platformLower = (order.sales_platform || "").toLowerCase();
    const platClass = platformLower.includes("lazada") ? "plat lz" : "plat";
    const platLabel = platformLower.includes("shopee") ? "SHOPEE" : platformLower.includes("lazada") ? "LAZADA" : (order.sales_platform || "?").toUpperCase();

    const selectHtml = `
      <select class="d4-stsel ${statusClass} overall-status-select" data-order-id="${order.id}">
        <option value="pending" ${statusLower === "pending" ? "selected" : ""}>Pending</option>
        <option value="printing" ${statusLower === "printing" ? "selected" : ""}>Printing</option>
        <option value="printed" ${statusLower === "printed" ? "selected" : ""}>Printed</option>
        <option value="completed" ${statusLower === "completed" ? "selected" : ""}>Completed</option>
        <option value="hold" ${statusLower === "hold" || statusLower === "on hold" ? "selected" : ""}>Hold</option>
      </select>`;

    // ── Expansion strip: print jobs · shipping · actions ──
    let totalPrintMin = 0;
    let jobsCol = "";
    for (const item of itemsList) {
      const jobs = item.print_jobs || [];
      jobsCol += `<div style="margin-bottom:9px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          ${d4SkuPill(item.variant_sku, item.purchased_quantity)}
          <span style="font-size:11.5px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.variant_name || "")}</span>
        </div>`;
      if (jobs.length > 0) {
        jobsCol += jobs.map(j => {
          totalPrintMin += ((j.print_files?.print_time_m || 0) * (item.purchased_quantity || 1));
          let note = "";
          if (j.job_execution_status === "printing") note = `${escapeHtml(j.printer_name || "printing")} · ${j.percent_complete ?? 0}%`;
          else if (j.job_execution_status === "pending" && j.queue_position) note = `queue #${j.queue_position}`;
          else if (j.print_files?.print_time_m) note = `${j.print_files.print_time_m}m`;
          const spFileId = j.print_files?.simplyprint_file_id || "";
          const redispatchBtn = j.print_file_name
            ? `<button class="btn-redispatch-file d4-xbtn" style="padding:3px 9px;font-size:10px" data-sp-file-id="${escapeHtml(spFileId)}" data-file-name="${escapeHtml(j.print_file_name)}" data-job-id="${escapeHtml(j.id || "")}">↻</button>`
            : "";
          return `<div class="d4-xgc">
            <span class="fx">GC</span>
            <span class="f" title="${escapeHtml(j.print_file_name || "")}">${escapeHtml(j.print_file_name || "unnamed")}</span>
            ${note ? `<span class="note">${note}</span>` : ""}
            ${d4JobChip(j.job_execution_status)}
            ${redispatchBtn}
          </div>`;
        }).join("");
      } else {
        jobsCol += `<div class="d4-xgc"><span class="note">no print jobs dispatched yet</span></div>`;
      }
      jobsCol += `</div>`;
    }
    if (!jobsCol) jobsCol = `<div class="d4-xgc"><span class="note">no items in this order</span></div>`;

    const rawUrl = order.raw_waybill_gdrive_url ? sanitizeUrl(order.raw_waybill_gdrive_url) : "";
    const procUrl = order.processed_waybill_gdrive_url ? sanitizeUrl(order.processed_waybill_gdrive_url) : "";
    const shipCol = `
      <div class="d4-xkv"><b>Customer</b><span>${escapeHtml(order.customer_name || "N/A")}</span></div>
      <div class="d4-xkv"><b>Ordered</b><span class="mono2">${oDate ? oDate.toLocaleString() : "N/A"}</span></div>
      <div class="d4-xkv"><b>Waybill</b><span>${escapeHtml(order.waybill_processing_status || "pending")}</span></div>
      ${totalPrintMin > 0 ? `<div class="d4-xkv"><b>Print time</b><span class="mono2">${totalPrintMin}m total</span></div>` : ""}
      ${order.shop_id && showBrand ? `<div class="d4-xkv"><b>Shop</b><span>${escapeHtml(shopName(order.shop_id))}</span></div>` : ""}
    `;

    const stickerBtns = itemsList
      .filter(it => it.variants?.seal_sticker_gdrive_url)
      .map(it => `<a class="d4-xbtn" href="${escapeHtml(sanitizeUrl(it.variants.seal_sticker_gdrive_url))}" target="_blank" rel="noopener">Sticker · ${escapeHtml(it.variant_sku || "")}</a>`)
      .join("");
    const actsCol = `
      ${rawUrl ? `<a class="d4-xbtn" href="${escapeHtml(rawUrl)}" target="_blank" rel="noopener">Raw waybill</a>` : ""}
      ${procUrl ? `<a class="d4-xbtn pri" href="${escapeHtml(procUrl)}" target="_blank" rel="noopener">Waybill PDF</a>` : ""}
      ${stickerBtns}
      <button class="delete-order-btn d4-xbtn warn" data-order-id="${order.id}" data-platform-order-id="${escapeHtml(order.platform_order_id)}">Delete order</button>
    `;

    html += `
      <tr class="d4-orow" data-order-id="${order.id}">
        <td class="id" title="${escapeHtml(order.platform_order_id)}">${escapeHtml(order.platform_order_id)}</td>
        ${showBrand ? `<td class="brand">${escapeHtml(shopName(order.shop_id))}</td>` : ""}
        <td><span class="${platClass}">${escapeHtml(platLabel)}</span></td>
        <td class="dt${isHot ? " hot" : ""}">${dateStr}</td>
        <td class="buyer" title="${escapeHtml(order.customer_name || "")}">${escapeHtml(order.customer_name) || "N/A"}</td>
        <td>${itemsHtml}</td>
        <td class="sum">${escapeHtml(order.order_subtotal)} ${escapeHtml(order.order_currency)}</td>
        <td>${d4WaybillChip(order)}</td>
        <td>${selectHtml}</td>
        <td><span class="chev">▼</span></td>
      </tr>
      <tr class="d4-xrow" id="${prefix}details-${order.id}">
        <td colspan="${colCount}">
          <div class="d4-xin">
            <div><div class="d4-xt">Print Jobs</div>${jobsCol}</div>
            <div><div class="d4-xt">Shipping</div>${shipCol}</div>
            <div class="d4-xacts"><div class="d4-xt">Actions</div>${actsCol}</div>
          </div>
        </td>
      </tr>
    `;
  }

  html += `</tbody></table>`;
  container.innerHTML = html;

  // Restore rows that were expanded before this re-render.
  for (const id of expandedOrderRowIds) {
    const row = container.querySelector(`tr.d4-orow[data-order-id="${id}"]`);
    const details = document.getElementById(`${prefix}details-${id}`);
    if (row && details) { row.classList.add("open"); details.classList.add("show"); }
  }

  // Bind change listeners to overall status selectors
  container.querySelectorAll(".overall-status-select").forEach(select => {
    select.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    select.addEventListener("change", async (e) => {
      e.stopPropagation();
      const orderId = select.getAttribute("data-order-id");
      const newStatus = e.target.value;

      try {
        select.disabled = true;
        const { error } = await supabaseClient
          .from("orders")
          .update({ overall_order_status: newStatus })
          .eq("id", orderId);
        if (error) throw error;

        logAction(`Order status changed: ${orderId} → ${newStatus}`, "info", { order_id: orderId, new_status: newStatus });
        // Patch in place instead of a full refetch + re-render of up to 200 nested
        // orders — the periodic poll will resync anyway.
        patchOrderStatusLocally(orderId, newStatus);
      } catch (err) {
        showToast("Error updating order status: " + err.message, "error");
        fetchAndRenderOrders(); // Refresh to restore old value
      } finally {
        select.disabled = false;
      }
    });
  });

  // Attach click events for expansion
  container.querySelectorAll("tr.d4-orow").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("select") || e.target.closest("a") || e.target.closest("button") || window.getSelection().toString()) {
        return;
      }
      const orderId = row.getAttribute("data-order-id");
      toggleOrderDetails(orderId, row, prefix);
    });
  });

  // Bind click listeners to re-dispatch buttons (dataset values are already
  // HTML-escaped by escapeHtml() at render time).
  container.querySelectorAll(".btn-redispatch-file").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const spFileId = btn.getAttribute("data-sp-file-id");
      const fileName = btn.getAttribute("data-file-name");
      const jobId = btn.getAttribute("data-job-id");
      redispatchPrintFile(spFileId, fileName, jobId, btn);
    });
  });

  // Bind click listeners to delete buttons
  container.querySelectorAll(".delete-order-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const orderId = btn.getAttribute("data-order-id");
      const platformOrderId = btn.getAttribute("data-platform-order-id");

      const confirmed = await showConfirmModal(
        "Delete Order",
        `Are you sure you want to delete order ${platformOrderId}? This will cancel any associated SimplyPrint jobs and remove the order from the database.`,
        "Delete"
      );

      if (!confirmed) return;

      btn.disabled = true;
      btn.style.opacity = "0.5";

      try {
        // Fetch order item IDs first
        const { data: items, error: itemsErr } = await supabaseClient
          .from("order_items").select("id").eq("order_id", orderId);
        if (itemsErr) throw itemsErr;

        // Delete print jobs for those items
        if (items && items.length > 0) {
          const itemIds = items.map(i => i.id);
          const { error: pjErr } = await supabaseClient
            .from("print_jobs").delete().in("order_item_id", itemIds);
          if (pjErr) throw pjErr;
        }

        // Delete order items
        const { error: oiErr } = await supabaseClient
          .from("order_items").delete().eq("order_id", orderId);
        if (oiErr) throw oiErr;

        // Delete the order itself
        const { error: oErr } = await supabaseClient
          .from("orders").delete().eq("id", orderId);
        if (oErr) throw oErr;

        logAction(`Order deleted: ${platformOrderId}`, "warning", { order_id: orderId, platform_order_id: platformOrderId });
        expandedOrderRowIds.delete(orderId);
        patchOrderDeletedLocally(orderId);
      } catch (err) {
        showToast("Error deleting order: " + err.message, "error");
        btn.disabled = false;
        btn.style.opacity = "1";
      }
    });
  });

  const sortHeader = document.getElementById(`${prefix}sort-date-col`);
  if (sortHeader) {
    sortHeader.addEventListener("click", () => {
      ordersDateSortDirection = ordersDateSortDirection === "asc" ? "desc" : "asc";
      fetchAndRenderOrders(false);
    });
  }
}

// ==========================================================================
// Orders Master-Detail (Aurora Pro): compact list + persistent detail panel
// ==========================================================================

// Keeps the header action button in sync with checkbox selection: "Complete
// All" when nothing is checked (original behavior, untouched), "Complete
// Selected (N)" once the employee checks specific rows for a targeted action.
// Contextual bulk-action bar: visible only while rows are checked.
function updateBulkBar() {
  const bar = document.getElementById("orders-bulk-bar");
  if (!bar) return;
  const n = bulkSelectedOrderIds.size;
  bar.classList.toggle("hidden", n === 0);
  bar.classList.toggle("flex", n > 0);
  const countEl = document.getElementById("orders-bulk-count");
  if (countEl) countEl.textContent = `${n} selected`;
}
const updateBulkCompleteButton = updateBulkBar; // legacy call sites

// Map legacy badge status classes (pending/printing/printed/completed/hold)
// onto Draft 4 stchip variants.
function d4StatusChipCls(legacy) {
  return { pending: "queue", printing: "print", printed: "printed", completed: "done", hold: "err" }[legacy] || "mut";
}

function renderOrdersMasterDetail(filtered) {
  const headEl = document.getElementById("orders-list-head");
  const rowsEl = document.getElementById("orders-list");
  const panel = document.getElementById("order-detail-panel");
  lastRenderedOrdersList = filtered;
  if (!headEl || !rowsEl || !panel) return;

  headEl.className = "omd-list-head omd-orders-cols";
  headEl.innerHTML = `<span></span><span>Order</span><span>Customer</span><span>Items</span><span>Subtotal</span><span>Status</span><span>Waybill</span>`;

  // Bulk-select checkboxes reset on every render (search/filter/refresh) so a
  // stale hidden selection can never get bulk-completed by accident.
  bulkSelectedOrderIds.clear();
  updateBulkCompleteButton();

  if (filtered.length === 0) {
    rowsEl.innerHTML = emptyDiv("No matching orders found.", "receipt_long", `<button class="empty-action" onclick="document.getElementById('ctrl-trigger-scout')?.click()"><span class="material-symbols-outlined">mail</span>Trigger Gmail Scan</button>`);
    panel.innerHTML = `<div class="omd-empty-state"><span class="material-symbols-outlined">touch_app</span><p>Select an order to view details</p></div>`;
    selectedOrderId = null;
    return;
  }

  rowsEl.innerHTML = filtered.map(order => {
    const statusLower = (order.overall_order_status || "").toLowerCase();
    let statusClass = "completed";
    if (statusLower === "printing") statusClass = "printing";
    else if (statusLower === "printed") statusClass = "printed";
    else if (statusLower === "pending") statusClass = "pending";
    else if (statusLower === "hold" || statusLower === "on hold") statusClass = "hold";

    const waybillStatusLower = (order.waybill_processing_status || "pending").toLowerCase();
    let waybillStatusClass = "pending";
    if (waybillStatusLower === "ready" || waybillStatusLower === "ready to print" || waybillStatusLower === "compiled") waybillStatusClass = "completed";
    else if (waybillStatusLower === "printed") waybillStatusClass = "printing";
    else if (waybillStatusLower === "on hold" || waybillStatusLower === "hold" || waybillStatusLower === "failed") waybillStatusClass = "hold";
    let waybillStatusDisplay = order.waybill_processing_status || "pending";
    if (waybillStatusDisplay.toLowerCase() === "ready to print") waybillStatusDisplay = "ready";

    const itemsList = order.order_items || [];
    let itemsHtml = itemsList.map(item =>
      `<span class="omd-item-chip">${escapeHtml(item.variant_sku || "")}${item.purchased_quantity > 1 ? ` ×${item.purchased_quantity}` : ""}</span>`
    ).join("");
    if (!itemsHtml) itemsHtml = `<span class="omd-item-chip" style="opacity:.5;">No items</span>`;

    const platformLower = (order.sales_platform || "").toLowerCase();
    const platformBadgeClass = platformLower.includes("shopee") ? "shopee" : platformLower.includes("lazada") ? "lazada" : platformLower.includes("shopify") ? "shopify" : "";

    // Order age: surfaces stale actionable orders at a glance
    const ageMs = Date.now() - new Date(order.order_timestamp || order.created_at).getTime();
    const ageH = ageMs / 3600000;
    const ageLabel = ageH < 1 ? `${Math.max(1, Math.round(ageMs / 60000))}m` : ageH < 24 ? `${Math.round(ageH)}h` : `${Math.round(ageH / 24)}d`;
    const isDone = statusLower === "completed";
    const ageClass = isDone ? "" : ageH >= 48 ? " bad" : ageH >= 24 ? " warn" : "";

    const isSelected = order.id === selectedOrderId;

    return `
      <div class="omd-row omd-orders-cols${isSelected ? " selected" : ""}" data-order-id="${order.id}">
        <div class="omd-cb" data-order-id="${order.id}"></div>
        <div class="omd-oid-cell">
          <div class="omd-oid-num truncate" title="${escapeHtml(order.platform_order_id)}">${escapeHtml(order.platform_order_id)}</div>
          <span class="omd-plat ${platformBadgeClass}">${escapeHtml(order.sales_platform || "")}</span><span class="omd-age${ageClass}" title="Order age">${ageLabel}</span>
        </div>
        <div class="omd-cust truncate">${escapeHtml(order.customer_name) || "N/A"}</div>
        <div class="omd-items-cell">${itemsHtml}</div>
        <div class="omd-subtotal-cell">${escapeHtml(order.order_subtotal)} ${escapeHtml(order.order_currency)}</div>
        <div><span class="d4-stchip sm ${d4StatusChipCls(statusClass)}"><i></i>${escapeHtml(order.overall_order_status || "pending")}</span></div>
        <div><span class="d4-stchip sm ${d4StatusChipCls(waybillStatusClass)}"><i></i>${escapeHtml(waybillStatusDisplay)}</span></div>
      </div>
    `;
  }).join("");

  rowsEl.querySelectorAll(".omd-cb").forEach(cb => {
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      const orderId = cb.getAttribute("data-order-id");
      if (bulkSelectedOrderIds.has(orderId)) {
        bulkSelectedOrderIds.delete(orderId);
        cb.classList.remove("checked");
      } else {
        bulkSelectedOrderIds.add(orderId);
        cb.classList.add("checked");
      }
      updateBulkCompleteButton();
    });
  });

  rowsEl.querySelectorAll(".omd-row").forEach(row => {
    row.addEventListener("click", () => {
      selectOrderForDetail(row.getAttribute("data-order-id"), filtered);
    });
  });

  // Restore selection if it still exists in the filtered set, else default to the first row
  const stillExists = filtered.some(o => o.id === selectedOrderId);
  selectOrderForDetail(stillExists ? selectedOrderId : filtered[0].id, filtered);
}

function selectOrderForDetail(orderId, filtered) {
  selectedOrderId = orderId;
  const order = (filtered || cachedOrders).find(o => o.id === orderId);
  const panel = document.getElementById("order-detail-panel");
  if (!panel) return;

  if (!order) {
    panel.innerHTML = `<div class="omd-empty-state"><span class="material-symbols-outlined">touch_app</span><p>Select an order to view details</p></div>`;
    return;
  }

  panel.innerHTML = buildOrderDetailPanel(order);
  bindOrderDetailPanelEvents();

  document.querySelectorAll("#orders-list .omd-row").forEach(r => {
    r.classList.toggle("selected", r.getAttribute("data-order-id") === orderId);
  });
}

function buildOrderDetailPanel(order) {
  const orderDateVal = order.order_timestamp || order.created_at;
  const dateStr = orderDateVal ? new Date(orderDateVal).toLocaleString() : "N/A";

  const platformLower = (order.sales_platform || "").toLowerCase();
  const platformBadgeClass = platformLower.includes("shopee") ? "shopee" : platformLower.includes("lazada") ? "lazada" : platformLower.includes("shopify") ? "shopify" : "";

  const itemsList = order.order_items || [];
  let itemsHtml;
  if (itemsList.length === 0) {
    itemsHtml = `<div class="d4-mono10" style="text-align:center;padding:8px 0;">No items found in this order.</div>`;
  } else {
    itemsHtml = itemsList.map(item => {
      const dispatchedStr = item.sent_to_print_timestamp ? new Date(item.sent_to_print_timestamp).toLocaleString() : "Not dispatched";
      const stickerUrl = item.variants?.seal_sticker_gdrive_url || "";
      const stickerBtn = stickerUrl
        ? `<a href="${escapeHtml(sanitizeUrl(stickerUrl))}" target="_blank" rel="noopener" class="omd-tag-btn"><span class="material-symbols-outlined">label</span>Sticker</a>`
        : `<span class="omd-tag-btn off"><span class="material-symbols-outlined">label_off</span>Sticker</span>`;

      const jobs = item.print_jobs || [];
      const jobsHtml = jobs.length > 0 ? jobs.map(j => {
        let badgeClass = "pending";
        if (j.job_execution_status === "printing") badgeClass = "printing";
        else if (j.job_execution_status === "completed") badgeClass = "completed";
        else if (j.job_execution_status === "failed") badgeClass = "hold";

        const etaText = j.job_execution_status !== "completed" && j.estimated_finish_time ? formatEta(j.estimated_finish_time) : "";
        const spFileId = j.print_files?.simplyprint_file_id || "";
        const safeJobId = j.id || "";
        const redispatchBtn = j.print_file_name
          ? `<button class="omd-tag-btn btn-redispatch-file" data-sp-file-id="${escapeHtml(spFileId)}" data-file-name="${escapeHtml(j.print_file_name)}" data-job-id="${escapeHtml(safeJobId)}"><span class="material-symbols-outlined">refresh</span>Re-dispatch</button>`
          : "";
        const progressHtml = j.job_execution_status === "printing"
          ? `<div class="omd-job-bar"><i style="width:${j.percent_complete || 0}%"></i></div>`
          : "";

        return `
          <div class="omd-job-card">
            <div class="omd-row-between">
              <span class="d4-mono11 truncate" title="${escapeHtml(j.print_file_name || "")}">
                <span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px;color:var(--accent-blue);">code</span> ${escapeHtml(j.print_file_name || "")}
              </span>
              <span class="d4-stchip sm ${d4StatusChipCls(badgeClass)}" style="flex-shrink:0;"><i></i>${j.job_execution_status}</span>
            </div>
            ${progressHtml}
            <div class="omd-row-between" style="margin-top:6px;">
              <span class="d4-mono10">${j.printer_name || (etaText ? `ETA ${etaText}` : "")}</span>
              ${redispatchBtn}
            </div>
          </div>
        `;
      }).join("") : `<div class="text-[10px] text-outline font-data-mono mt-1">No print jobs dispatched yet.</div>`;

      return `
        <div class="omd-item-card">
          <div class="omd-row-between">
            <span class="omd-isku">${escapeHtml(item.variant_sku || "UNKNOWN")}</span>
            <span class="d4-stchip sm ${d4StatusChipCls(item.item_print_status?.toLowerCase() === "printing" ? "printing" : (item.item_print_status?.toLowerCase() === "pending" ? "pending" : "completed"))}"><i></i>${item.item_print_status}</span>
          </div>
          <div class="d4-body12">${escapeHtml(item.variant_name || "Generic Item")} · Qty ${item.purchased_quantity}</div>
          <div class="d4-mono10">Dispatched: ${dispatchedStr}</div>
          ${jobsHtml}
          <div style="display:flex; gap:6px; margin-top:2px;">${stickerBtn}</div>
        </div>
      `;
    }).join("");
  }

  // Waybill section — uses the real orders.raw_waybill_gdrive_url / processed_waybill_gdrive_url
  // columns (already fetched via the `orders.*` select), not fabricated data.
  const waybillStatusLower = (order.waybill_processing_status || "pending").toLowerCase();
  let waybillStatusClass = "pending";
  if (waybillStatusLower === "ready" || waybillStatusLower === "ready to print" || waybillStatusLower === "compiled") waybillStatusClass = "completed";
  else if (waybillStatusLower === "printed") waybillStatusClass = "printing";
  else if (waybillStatusLower === "on hold" || waybillStatusLower === "hold" || waybillStatusLower === "failed") waybillStatusClass = "hold";
  let waybillStatusDisplay = order.waybill_processing_status || "pending";
  if (waybillStatusDisplay.toLowerCase() === "ready to print") waybillStatusDisplay = "ready";

  const rawPdfBtn = order.raw_waybill_gdrive_url
    ? `<a href="${escapeHtml(sanitizeUrl(order.raw_waybill_gdrive_url))}" target="_blank" rel="noopener" class="omd-tag-btn"><span class="material-symbols-outlined">description</span>Raw PDF</a>`
    : `<span class="omd-tag-btn off"><span class="material-symbols-outlined">block</span>Raw PDF</span>`;
  const processedPdfBtn = order.processed_waybill_gdrive_url
    ? `<a href="${escapeHtml(sanitizeUrl(order.processed_waybill_gdrive_url))}" target="_blank" rel="noopener" class="omd-tag-btn"><span class="material-symbols-outlined">description</span>Processed</a>`
    : `<span class="omd-tag-btn off"><span class="material-symbols-outlined">block</span>Processed — n/a</span>`;

  // Timeline — derived entirely from real fields (created_at / order_timestamp,
  // order_items.sent_to_print_timestamp, waybill_processing_status). No fabricated data
  // (the orders table has no shipping-address columns, so that mockup section is dropped).
  const earliestDispatch = itemsList
    .map(i => i.sent_to_print_timestamp)
    .filter(Boolean)
    .sort()[0];
  const tlSteps = [{ done: true, label: `Order received via ${escapeHtml(order.sales_platform || "platform")}`, ts: dateStr }];
  if (earliestDispatch) {
    tlSteps.push({ done: true, label: "Sent to print", ts: new Date(earliestDispatch).toLocaleString() });
  } else {
    tlSteps.push({ pending: true, label: "Awaiting print dispatch", ts: "—" });
  }
  if (waybillStatusClass === "completed") {
    tlSteps.push({ done: true, label: `Waybill ${waybillStatusDisplay}`, ts: "" });
  } else if (waybillStatusClass === "hold") {
    tlSteps.push({ active: true, label: `Waybill ${waybillStatusDisplay} — needs attention`, ts: "" });
  } else {
    tlSteps.push({ pending: true, label: "Awaiting waybill compile", ts: "—" });
  }
  const tlHtml = tlSteps.map(s => `
    <div class="omd-tl-row">
      <div class="omd-tl-dot ${s.done ? "done" : s.active ? "active" : "pending"}"></div>
      <div class="omd-tl-body">
        <span class="omd-tl-t"${s.pending ? ' style="color:var(--text-muted);"' : ""}>${s.label}</span>
        <span class="omd-tl-ts">${s.ts}</span>
      </div>
    </div>
  `).join("");

  const statusLower = (order.overall_order_status || "").toLowerCase();
  const statusSelectClass = statusLower === "on hold" ? "hold" : (statusLower || "pending");

  return `
    <div class="omd-dp-head">
      <div>
        <div class="omd-oid">${escapeHtml(order.platform_order_id)}</div>
        <div class="omd-meta">
          <span class="omd-plat ${platformBadgeClass}">${escapeHtml(order.sales_platform || "")}</span>
          <span class="sep">·</span><span>${dateStr}</span>
          <span class="sep">·</span><span>${escapeHtml(order.customer_name) || "N/A"}</span>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
        <button class="d4-iconbtn copy-order-id-btn" data-copy="${escapeHtml(order.platform_order_id)}" title="Copy Order ID">
          <span class="material-symbols-outlined">content_copy</span>
        </button>
        <button class="d4-iconbtn danger delete-order-btn" data-order-id="${order.id}" data-platform-order-id="${escapeHtml(order.platform_order_id)}" title="Delete Order">
          <span class="material-symbols-outlined">delete</span>
        </button>
      </div>
    </div>

    <div>
      <div class="omd-section-title"><span class="material-symbols-outlined">inventory_2</span>Items (${itemsList.length})</div>
      ${itemsHtml}
    </div>

    <div>
      <div class="omd-section-title"><span class="material-symbols-outlined">local_shipping</span>Waybill</div>
      <div class="omd-item-card" style="flex-direction:row; align-items:center; justify-content:space-between; margin-bottom:0;">
        <span class="d4-stchip sm ${d4StatusChipCls(waybillStatusClass)}"><i></i>${escapeHtml(waybillStatusDisplay)}</span>
        <div style="display:flex; gap:6px;">${rawPdfBtn}${processedPdfBtn}</div>
      </div>
    </div>

    <div>
      <div class="omd-section-title"><span class="material-symbols-outlined">history</span>Order Timeline</div>
      ${tlHtml}
    </div>

    <div class="omd-dp-footer">
      <div class="omd-section-title" style="margin-bottom:2px;">Update Status</div>
      <div style="display:flex; gap:8px; align-items:stretch;">
      ${(() => {
        const nextMap = { pending: "printing", printing: "printed", printed: "completed", hold: "pending", "on hold": "pending" };
        const next = nextMap[statusLower];
        return next
          ? `<button class="status-advance-btn" data-next="${next}" title="Advance to ${next}"><span class="material-symbols-outlined text-sm">skip_next</span>${next.charAt(0).toUpperCase() + next.slice(1)}</button>`
          : "";
      })()}
      <select class="d4-stsel ${statusSelectClass} overall-status-select" data-order-id="${order.id}" style="flex:1;">
        <option value="pending" ${statusLower === "pending" ? "selected" : ""}>Pending</option>
        <option value="printing" ${statusLower === "printing" ? "selected" : ""}>Printing</option>
        <option value="printed" ${statusLower === "printed" ? "selected" : ""}>Printed</option>
        <option value="completed" ${statusLower === "completed" ? "selected" : ""}>Completed</option>
        <option value="hold" ${statusLower === "hold" || statusLower === "on hold" ? "selected" : ""}>Hold</option>
      </select>
      </div>
    </div>
  `;
}

function bindOrderDetailPanelEvents() {
  const panel = document.getElementById("order-detail-panel");
  if (!panel) return;

  const copyBtn = panel.querySelector(".copy-order-id-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(copyBtn.getAttribute("data-copy") || "").then(
        () => showToast("Order ID copied.", "success"),
        () => showToast("Copy failed.", "error")
      );
    });
  }

  // Re-dispatch buttons (one per print job). data-* values are HTML-escaped at
  // render time, so reading via dataset here avoids the inline onclick's
  // quote-breakout risk.
  panel.querySelectorAll(".btn-redispatch-file").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const spFileId = btn.getAttribute("data-sp-file-id");
      const fileName = btn.getAttribute("data-file-name");
      const jobId = btn.getAttribute("data-job-id");
      redispatchPrintFile(spFileId, fileName, jobId, btn);
    });
  });

  // One-click advance: sets the select to the next pipeline status and fires
  // its existing change handler (DB update + re-render + badge flash).
  const advanceBtn = panel.querySelector(".status-advance-btn");
  if (advanceBtn) {
    advanceBtn.addEventListener("click", () => {
      const sel = panel.querySelector(".overall-status-select");
      if (!sel) return;
      sel.value = advanceBtn.getAttribute("data-next");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  const select = panel.querySelector(".overall-status-select");
  if (select) {
    select.addEventListener("change", async (e) => {
      const orderId = select.getAttribute("data-order-id");
      const newStatus = e.target.value;
      try {
        select.disabled = true;
        const { error } = await supabaseClient
          .from("orders")
          .update({ overall_order_status: newStatus })
          .eq("id", orderId);
        if (error) throw error;
        logAction(`Order status changed: ${orderId} → ${newStatus}`, "info", { order_id: orderId, new_status: newStatus });
        // Patch the row in place instead of a full refetch + re-render of up to 200
        // nested orders — the periodic poll will resync anyway.
        patchOrderStatusLocally(orderId, newStatus);
        document.querySelector(`#orders-list .omd-row[data-order-id="${orderId}"] .badge`)?.classList.add("flash-update");
      } catch (err) {
        showToast("Error updating order status: " + err.message, "error");
        fetchAndRenderOrders();
      } finally {
        select.disabled = false;
      }
    });
  }

  const deleteBtn = panel.querySelector(".delete-order-btn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      const orderId = deleteBtn.getAttribute("data-order-id");
      const platformOrderId = deleteBtn.getAttribute("data-platform-order-id");

      const confirmed = await showConfirmModal(
        "Delete Order",
        `Are you sure you want to delete order ${platformOrderId}? This will cancel any associated SimplyPrint jobs and remove the order from the database.`,
        "Delete"
      );
      if (!confirmed) return;

      deleteBtn.disabled = true;
      try {
        const { data: items, error: itemsErr } = await supabaseClient
          .from("order_items").select("id").eq("order_id", orderId);
        if (itemsErr) throw itemsErr;

        if (items && items.length > 0) {
          const itemIds = items.map(i => i.id);
          const { error: pjErr } = await supabaseClient
            .from("print_jobs").delete().in("order_item_id", itemIds);
          if (pjErr) throw pjErr;
        }

        const { error: oiErr } = await supabaseClient
          .from("order_items").delete().eq("order_id", orderId);
        if (oiErr) throw oiErr;

        const { error: oErr } = await supabaseClient
          .from("orders").delete().eq("id", orderId);
        if (oErr) throw oErr;

        logAction(`Order deleted: ${platformOrderId}`, "warning", { order_id: orderId, platform_order_id: platformOrderId });
        selectedOrderId = null;
        patchOrderDeletedLocally(orderId);
      } catch (err) {
        showToast("Error deleting order: " + err.message, "error");
        deleteBtn.disabled = false;
      }
    });
  }
}

// Separate helper for on-hold panel to keep code clean
function renderHoldPanel(allOrdersList) {
  const holdOrders = allOrdersList.filter(o => o.overall_order_status.toLowerCase() === "hold" || o.overall_order_status.toLowerCase() === "on hold");
  const holdPanel = document.getElementById("on-hold-panel");
  const holdList = document.getElementById("on-hold-list");
  const holdCount = document.getElementById("on-hold-count");

  if (!holdPanel || !holdList || !holdCount) return;

  if (holdOrders.length > 0) {
    holdPanel.style.display = "flex";
    holdCount.innerText = holdOrders.length;
    
    let holdHtml = "";
    for (const order of holdOrders) {
      holdHtml += `
        <div class="hold-item" id="hold-item-${order.id}">
          <div style="display: flex; flex-direction: column; gap: 0.2rem;">
            <div style="font-weight: bold; font-family: monospace; font-size: 0.95rem;">Order #${escapeHtml(order.platform_order_id)}</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary);" id="discrepancy-${order.id}">Loading discrepancy details...</div>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <button class="d4-btn sm btn-reset-hold" data-order-id="${order.id}" data-platform-id="${escapeHtml(order.platform_order_id)}">
              <span class="material-symbols-outlined">rotate_left</span> Reset to Pending
            </button>
            <button class="d4-btn pri sm btn-force-approve" data-order-id="${order.id}" data-platform-id="${escapeHtml(order.platform_order_id)}">
              <span class="material-symbols-outlined">check</span> Force Release
            </button>
          </div>
        </div>
      `;
    }
    holdList.innerHTML = holdHtml;

    // Fetch discrepancy details
    holdOrders.forEach(async order => {
      try {
        const { data: logs, error } = await supabaseClient
          .from("system_logs")
          .select("log_message")
          .in("log_level", ["error", "warning"])
          .like("log_message", `%${order.platform_order_id}%`)
          .order("created_at", { ascending: false })
          .limit(1);
        
        const discEl = document.getElementById(`discrepancy-${order.id}`);
        if (discEl) {
          discEl.innerText = logs && logs.length > 0 ? logs[0].log_message : "No specific error details found in system logs.";
        }
      } catch (le) {
        console.error("Failed to load log discrepancy:", le);
      }
    });

    // Bind events
    holdList.querySelectorAll(".btn-reset-hold").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const orderId = btn.getAttribute("data-order-id");
        const pId = btn.getAttribute("data-platform-id");
        if (await showConfirmModal("Reset Order", `Reset order #${pId} to pending? The waybill agent will re-verify it on next scan.`, "Reset")) {
          await resetOrderHold(orderId);
        }
      });
    });

    holdList.querySelectorAll(".btn-force-approve").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const orderId = btn.getAttribute("data-order-id");
        const pId = btn.getAttribute("data-platform-id");
        if (await showConfirmModal("Force Release", `Force release order #${pId}? This skips verification and marks it ready.`, "Release")) {
          await forceReleaseOrder(orderId);
        }
      });
    });
  } else {
    holdPanel.style.display = "none";
  }
}

// Setup Orders Search and Filters
function setupOrderFilters() {
  const filterBox = document.getElementById("orders-status-filters");
  const searchInput = document.getElementById("orders-search-input");
  const dateStart = document.getElementById("orders-date-start");
  const dateEnd = document.getElementById("orders-date-end");
  const clearDateBtn = document.getElementById("orders-clear-date-btn");

  const updateClearDateBtnVisibility = () => {
    if (clearDateBtn) {
      if (ordersStartDate || ordersEndDate) {
        clearDateBtn.classList.remove("hidden");
      } else {
        clearDateBtn.classList.add("hidden");
      }
    }
  };

  if (filterBox) {
    filterBox.querySelectorAll(".filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        filterBox.querySelectorAll(".filter-btn").forEach(b => {
          b.classList.remove("active", "bg-primary/10", "text-primary");
          b.classList.add("text-on-surface-variant", "hover:bg-surface-container-high");
        });
        btn.classList.add("active", "bg-primary/10", "text-primary");
        btn.classList.remove("text-on-surface-variant", "hover:bg-surface-container-high");
        activeOrderFilter = btn.getAttribute("data-status");
        fetchAndRenderOrders(false); // Render from cache
      });
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", debounce((e) => {
      orderSearchQuery = e.target.value.trim();
      fetchAndRenderOrders(false); // Render from cache
    }, 250));
  }

  if (dateStart) {
    dateStart.addEventListener("change", (e) => {
      ordersStartDate = e.target.value;
      updateClearDateBtnVisibility();
      fetchAndRenderOrders(true);
    });
  }

  if (dateEnd) {
    dateEnd.addEventListener("change", (e) => {
      ordersEndDate = e.target.value;
      updateClearDateBtnVisibility();
      fetchAndRenderOrders(true);
    });
  }

  if (clearDateBtn) {
    clearDateBtn.addEventListener("click", () => {
      ordersStartDate = "";
      ordersEndDate = "";
      if (dateStart) dateStart.value = "";
      if (dateEnd) dateEnd.value = "";
      clearDateBtn.classList.add("hidden");
      fetchAndRenderOrders(true);
    });
  }

  const sortDateBtn = document.getElementById("orders-sort-date-btn");
  const sortDateIcon = document.getElementById("orders-sort-date-icon");
  if (sortDateBtn) {
    sortDateBtn.addEventListener("click", () => {
      ordersDateSortDirection = ordersDateSortDirection === "asc" ? "desc" : "asc";
      if (sortDateIcon) sortDateIcon.style.transform = ordersDateSortDirection === "asc" ? "rotate(180deg)" : "rotate(0deg)";
      fetchAndRenderOrders(false);
    });
  }

  const completeAllOrdersBtn = document.getElementById("orders-btn-complete-all");
  if (completeAllOrdersBtn) {
    completeAllOrdersBtn.addEventListener("click", async () => {
      if (!supabaseClient) return;

      // Count exactly what the scoped update below will affect (all orders in the
      // active shop scope, not just the current status/search filter) so the confirm
      // dialog never undersells/oversells the blast radius of this action.
      let affectedCount = null;
      try {
        const { count, error: countErr } = await scopeByShop(
          supabaseClient.from("orders").select("id", { count: "exact", head: true })
        );
        if (!countErr) affectedCount = count;
      } catch (_) { /* best-effort; fall back to generic wording below */ }

      const scopeLabel = currentShop === "all" ? "all shops" : currentShop === "unassigned" ? "unassigned orders" : shopName(currentShop);
      const countLabel = affectedCount === null ? "all" : affectedCount;
      const confirmed = await showConfirmModal(
        "Complete All Orders",
        `Are you sure you want to mark ${countLabel} order${affectedCount === 1 ? "" : "s"} (${scopeLabel}) as completed? This cannot be undone.`,
        "Complete All"
      );
      if (!confirmed) return;

      try {
        completeAllOrdersBtn.disabled = true;
        const { error } = await scopeByShop(
          supabaseClient.from("orders")
            .update({ overall_order_status: "completed" })
            .neq("id", "00000000-0000-0000-0000-000000000000")
        );
        if (error) throw error;
        showToast("All orders marked as completed.", "success");
        bulkSelectedOrderIds.clear();
        fetchSummaryStats();
        fetchAndRenderOrders();
      } catch (err) {
        showToast(`Failed to complete order(s): ${err.message}`, "error");
      } finally {
        completeAllOrdersBtn.disabled = false;
      }
    });
  }

  // --- Bulk-action bar handlers ---
  const bulkCompleteBtn = document.getElementById("orders-bulk-complete");
  if (bulkCompleteBtn) {
    bulkCompleteBtn.addEventListener("click", async () => {
      if (!supabaseClient) return;
      const ids = Array.from(bulkSelectedOrderIds);
      if (ids.length === 0) return;
      const confirmed = await showConfirmModal("Complete Selected Orders", `Mark ${ids.length} selected order${ids.length > 1 ? "s" : ""} as completed? This cannot be undone.`, "Complete Selected");
      if (!confirmed) return;
      try {
        bulkCompleteBtn.disabled = true;
        const { error } = await supabaseClient.from("orders")
          .update({ overall_order_status: "completed" })
          .in("id", ids);
        if (error) throw error;
        showToast(`${ids.length} order${ids.length > 1 ? "s" : ""} marked as completed.`, "success");
        bulkSelectedOrderIds.clear();
        updateBulkBar();
        fetchSummaryStats();
        fetchAndRenderOrders();
      } catch (err) {
        showToast(`Failed to complete order(s): ${err.message}`, "error");
      } finally {
        bulkCompleteBtn.disabled = false;
      }
    });
  }

  const bulkWaybillSelect = document.getElementById("orders-bulk-waybill-status");
  if (bulkWaybillSelect) {
    bulkWaybillSelect.addEventListener("change", async (e) => {
      const newStatus = e.target.value;
      const ids = Array.from(bulkSelectedOrderIds);
      if (!newStatus || ids.length === 0 || !supabaseClient) { bulkWaybillSelect.value = ""; return; }
      const confirmed = await showConfirmModal("Set Waybill Status", `Set waybill status of ${ids.length} selected order${ids.length > 1 ? "s" : ""} to '${newStatus}'?`, "Update");
      if (!confirmed) { bulkWaybillSelect.value = ""; return; }
      try {
        bulkWaybillSelect.disabled = true;
        const { error } = await supabaseClient.from("orders")
          .update({ waybill_processing_status: newStatus })
          .in("id", ids);
        if (error) throw error;
        showToast(`Waybill status set to '${newStatus}' for ${ids.length} order${ids.length > 1 ? "s" : ""}.`, "success");
        bulkSelectedOrderIds.clear();
        updateBulkBar();
        fetchAndRenderOrders();
      } catch (err) {
        showToast(`Failed to update waybill status: ${err.message}`, "error");
      } finally {
        bulkWaybillSelect.disabled = false;
        bulkWaybillSelect.value = "";
      }
    });
  }

  const bulkSelectAllBtn = document.getElementById("orders-bulk-select-all");
  if (bulkSelectAllBtn) {
    bulkSelectAllBtn.addEventListener("click", () => {
      lastRenderedOrdersList.forEach(o => bulkSelectedOrderIds.add(o.id));
      document.querySelectorAll("#orders-list .omd-cb").forEach(cb => cb.classList.add("checked"));
      updateBulkBar();
    });
  }

  const bulkClearBtn = document.getElementById("orders-bulk-clear");
  if (bulkClearBtn) {
    bulkClearBtn.addEventListener("click", () => {
      bulkSelectedOrderIds.clear();
      document.querySelectorAll("#orders-list .omd-cb").forEach(cb => cb.classList.remove("checked"));
      updateBulkBar();
    });
  }
}

// Toggle Order details row
function toggleOrderDetails(orderId, rowElement, prefix = "") {
  const details = rowElement.nextElementSibling || document.getElementById(`${prefix}details-${orderId}`);
  if (!details) return;
  const nowOpen = !details.classList.contains("show");
  details.classList.toggle("show", nowOpen);
  rowElement.classList.toggle("open", nowOpen);
  if (nowOpen) expandedOrderRowIds.add(orderId);
  else expandedOrderRowIds.delete(orderId);
}

// Fetch and Render System Logs
window.redispatchPrintFile = async function(simplyPrintFileId, printFileName, printJobId, btn) {
  if (!isSpDispatchEnabled()) {
    showToast("SimplyPrint dispatch is disabled in Settings.", "warning");
    return;
  }
  const icon = btn?.querySelector(".material-symbols-outlined");
  const originalIcon = icon?.textContent;
  if (btn) { btn.disabled = true; if (icon) icon.textContent = "sync"; }
  try {
    const res = await backendFetch(`/print-files/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        print_file_name: printFileName,
        ...(simplyPrintFileId && { simplyprint_file_id: simplyPrintFileId }),
        ...(printJobId && { print_job_id: printJobId })
      })
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail = JSON.parse(text).detail || detail; } catch (_) {}
      throw new Error(detail);
    }
    const data = JSON.parse(text);
    showToast(`Dispatched: ${printFileName}`, "success");
    logAction(`File dispatched to print queue: ${printFileName}`, "info", { simplyprint_file_id: simplyPrintFileId, job_id: data.simplyprint_job_id });
  } catch (err) {
    showToast(`Dispatch failed: ${err.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; if (icon) icon.textContent = originalIcon; }
  }
};

window.toggleLogDetails = function(logId, event) {
  if (event) {
    if (event.target.closest("pre") || event.target.closest(".log-details-pane")) {
      return;
    }
  }
  const pane = document.getElementById(`log-details-${logId}`);
  const btn = document.getElementById(`log-toggle-btn-${logId}`);
  const card = document.getElementById(`log-item-${logId}`);
  if (pane) {
    const isExpanded = pane.classList.contains("expanded");
    if (isExpanded) {
      pane.classList.remove("expanded");
      if (btn) btn.classList.remove("expanded");
      if (card) card.classList.remove("expanded");
    } else {
      pane.classList.add("expanded");
      if (btn) btn.classList.add("expanded");
      if (card) card.classList.add("expanded");
    }
  }
};

let activeStreamFilter = "all";

// Unified Activity stream (Aurora 3.0): merges system_logs + print_jobs into
// one chronological feed with level rails and expandable JSON details.
// Kept under the old fetchAndRenderLogs name so every existing call site
// (setupTabs, agent-trigger refreshes, clear buttons) keeps working.
async function fetchAndRenderLogs() {
  if (!supabaseClient) return;
  const box = document.getElementById("activity-stream");
  if (!box) return;

  try {
    const [logsRes, jobsRes] = await Promise.all([
      supabaseClient.from("system_logs").select("*").order("created_at", { ascending: false }).limit(60),
      supabaseClient.from("print_jobs").select("*, order_items(variant_sku, orders(platform_order_id, customer_name))").order("created_at", { ascending: false }).limit(50),
    ]);

    const events = [];
    (logsRes.data || []).forEach(log => {
      const level = (log.log_level || "info").toLowerCase();
      events.push({
        ts: new Date(log.created_at), kind: "system", level,
        title: log.log_message || "—",
        sub: log.agent_name || "system",
        details: log.additional_details || null,
      });
    });
    (jobsRes.data || []).forEach(j => {
      const status = (j.job_execution_status || "pending").toLowerCase();
      const level = status === "completed" ? "success"
        : status === "printing" ? "info"
        : (status === "cancelled" || status === "error" || status === "failed") ? "error"
        : "warning";
      const oi = Array.isArray(j.order_items) ? j.order_items[0] : j.order_items;
      const cust = oi?.orders?.customer_name || "";
      const sku = oi?.variant_sku || "";
      events.push({
        ts: new Date(j.created_at), kind: "printjob", level,
        title: `${j.print_file_name || "Print job"}${j.printer_name ? " on " + j.printer_name : ""}`,
        sub: [sku, cust].filter(Boolean).join(" · ") || "print job",
        chipExtra: status + (j.percent_complete != null ? ` · ${j.percent_complete}%` : ""),
        details: null,
      });
    });

    events.sort((a, b) => b.ts - a.ts);

    const filtered = events.filter(ev => {
      if (activeStreamFilter === "all") return true;
      if (activeStreamFilter === "error") return ev.level === "error";
      return ev.kind === activeStreamFilter;
    });

    const countEl = document.getElementById("activity-count");
    if (countEl) countEl.textContent = `${filtered.length} of ${events.length} events`;

    if (filtered.length === 0) {
      box.innerHTML = emptyDiv("No matching activity.", "update");
    } else {
      const railColor = { info: "#7ea6e8", warning: "#fbbf24", error: "#ff6666", success: "#3ecf8e" };
      box.innerHTML = filtered.map((ev, i) => {
        const color = railColor[ev.level] || "#7ea6e8";
        const hasDetails = !!ev.details;
        return `
          <div class="act-row${hasDetails ? " act-expandable" : ""}" data-act-idx="${i}">
            <div class="act-rail" style="background:${color};"></div>
            <span class="material-symbols-outlined act-icon" style="color:${color};">${ev.kind === "printjob" ? "print" : "terminal"}</span>
            <div class="act-main">
              <div class="act-title" title="${escapeHtml(ev.title)}">${escapeHtml(ev.title)}</div>
              <div class="act-sub">${escapeHtml(ev.sub)}${ev.chipExtra ? ` · <span style="color:${color};">${escapeHtml(ev.chipExtra)}</span>` : ""}</div>
            </div>
            <span class="act-time" title="${ev.ts.toLocaleString()}">${relativeTime(ev.ts.toISOString())}</span>
            ${hasDetails ? `<span class="material-symbols-outlined act-chevron">expand_more</span>` : ""}
          </div>
          ${hasDetails ? `<pre class="act-details hidden" id="act-det-${i}">${escapeHtml(JSON.stringify(ev.details, null, 2))}</pre>` : ""}
        `;
      }).join("");

      box.querySelectorAll(".act-expandable").forEach(row => {
        row.addEventListener("click", () => {
          const det = document.getElementById(`act-det-${row.getAttribute("data-act-idx")}`);
          if (det) det.classList.toggle("hidden");
          row.querySelector(".act-chevron")?.classList.toggle("act-chevron-open");
        });
      });
    }

    markFresh("activity");
  } catch (err) {
    box.innerHTML = emptyDiv(`Error loading activity: ${escapeHtml(err.message)}`, "error");
  }
}

async function fetchAndRenderLogsPagePrintJobs() {
  // Print jobs are folded into the unified Activity stream.
  return fetchAndRenderLogs();
}

async function fetchAndRenderCatalog() {
  if (!supabaseClient) return;
  const tbody = document.getElementById("catalog-tbody");
  const searchVal = document.getElementById("catalog-search").value.toLowerCase();

  const brandSelect = document.getElementById("catalog-filter-brand");
  const categorySelect = document.getElementById("catalog-filter-category");
  const clearFiltersBtn = document.getElementById("catalog-clear-filters-btn");

  const brandFilter = brandSelect ? brandSelect.value : "all";
  const categoryFilter = categorySelect ? categorySelect.value : "all";

  if (tbody && cachedVariants.length === 0) tbody.innerHTML = loadingDiv();

  try {
    if (cachedVariants.length === 0) {
      const { data, error } = await supabaseClient
        .from("variants")
        .select("*, products(*), print_files(*)");

      if (error) throw error;
      cachedVariants = data || [];
    }

    // Dynamic filters population
    const brands = [...new Set(cachedVariants.map(v => v.products?.brand_name).filter(Boolean))].sort();
    const categories = [...new Set(cachedVariants.map(v => v.products?.product_category).filter(Boolean))].sort();

    if (brandSelect && brandSelect.options.length <= 1) {
      brands.forEach(b => {
        const opt = document.createElement("option");
        opt.value = b;
        opt.innerText = b;
        brandSelect.appendChild(opt);
      });
    }

    if (categorySelect && categorySelect.options.length <= 1) {
      categories.forEach(c => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.innerText = c;
        categorySelect.appendChild(opt);
      });
    }

    if (clearFiltersBtn) {
      if (brandFilter !== "all" || categoryFilter !== "all") {
        clearFiltersBtn.classList.remove("hidden");
      } else {
        clearFiltersBtn.classList.add("hidden");
      }
    }

    let filtered = cachedVariants;

    // Apply active shop scope (header switcher)
    filtered = filtered.filter(v => passesShopScope(v.products?.shop_id));

    // Apply Brand filter
    if (brandFilter !== "all") {
      filtered = filtered.filter(v => v.products?.brand_name === brandFilter);
    }

    // Apply Category filter
    if (categoryFilter !== "all") {
      filtered = filtered.filter(v => v.products?.product_category === categoryFilter);
    }

    // Apply text search
    if (searchVal) {
      filtered = filtered.filter(v => 
        v.variant_sku.toLowerCase().includes(searchVal) || 
        v.variant_name.toLowerCase().includes(searchVal) ||
        (v.products?.product_base_name || "").toLowerCase().includes(searchVal) ||
        (v.products?.brand_name || "").toLowerCase().includes(searchVal)
      );
    }

    // Group variants by product
    const productsMap = {};
    filtered.forEach(v => {
      const p = v.products;
      if (!p) return;
      if (!productsMap[p.id]) {
        productsMap[p.id] = {
          id: p.id,
          brand_name: p.brand_name || "Unknown Brand",
          product_category: p.product_category || "General",
          master_sku: p.master_sku || "N/A",
          product_base_name: p.product_base_name || "Generic Product",
          variations: []
        };
      }
      productsMap[p.id].variations.push(v);
    });

    let productsList = Object.values(productsMap);
    productsList.sort((a, b) => {
      const cmp = a.product_base_name.localeCompare(b.product_base_name);
      return catalogSortOrder === "asc" ? cmp : -cmp;
    });

    updateProductsAttentionUI(productsList);

    if (catalogAttentionFilter !== "all") {
      productsList = productsList.filter(p => {
        const attn = computeProductAttention(p);
        if (catalogAttentionFilter === "needs_attention") return attn.hasIssue;
        if (catalogAttentionFilter === "full_coverage") return attn.platformCount === LISTING_PLATFORMS.length;
        if (catalogAttentionFilter === "low_stock") return attn.isLowStock;
        return true;
      });
    }

    if (productsList.length === 0) {
      tbody.innerHTML = emptyDiv("No catalog items found matching filters.", "inventory_2", `<button class="empty-action" onclick="document.getElementById('add-catalog-item-btn')?.click()"><span class="material-symbols-outlined">add_box</span>Add Product</button>`);
      const detailPanel = document.getElementById("product-detail-panel");
      if (detailPanel) detailPanel.innerHTML = `<div class="omd-empty-state"><span class="material-symbols-outlined">touch_app</span><p>Select a product to view details</p></div>`;
      selectedProductId = null;
      return;
    }

    renderProductsMasterDetail(productsList);
    markFresh("products");

  } catch (err) {
    if (tbody) tbody.innerHTML = emptyDiv(`Error loading catalog: ${escapeHtml(err.message)}`, "error");
  }
}

// ==========================================================================
// Products Master-Detail (Aurora Pro): compact list + persistent detail
// panel, with a Catalog <-> Listings cross-link (variation mapping table,
// platform coverage) built from cachedListings.
// ==========================================================================

// Find every listing tied to a product. A product can genuinely have more
// than one listing row — e.g. two separate marketplace product pages (one
// per bundled price point) that each offer the same set of physical variants.
function findListingsForProduct(productId) {
  return cachedListings.filter(l => l.products?.id === productId);
}

// Back-compat single-listing accessor for call sites that only need "a"
// representative listing (e.g. the compact list-row price column).
function findListingForProduct(productId) {
  return findListingsForProduct(productId)[0] || null;
}

// Shared classification used by both list-row rendering and the
// Needs Attention/Full Coverage/Low Stock filter tabs, so the tab counts
// always match what actually shows up when a tab is clicked.
function computeProductAttention(p) {
  const listings = findListingsForProduct(p.id);
  const listing = listings[0] || null;
  // Coverage is the union of platforms across every listing for this
  // product, since a platform can be live on one listing but not another.
  const platformCount = LISTING_PLATFORMS.filter(pl => listings.some(l => !!l[pl.key])).length;
  const hasUnmapped = listings.some(l => (l.listing_variations || []).some(lv => !lv.variant_id));
  const hasIssue = hasUnmapped || listings.length === 0;
  const isLowStock = p.variations.some(v => (v.stock_quantity || 0) <= 5);
  return { listing, listings, platformCount, hasUnmapped, hasIssue, isLowStock };
}

// Updates the unmapped-variations alert banner and the attention filter
// tab counts. Called every time the (brand/category/search-filtered, but
// not yet attention-filtered) product list is rebuilt.
function updateProductsAttentionUI(productsList) {
  const counts = { all: productsList.length, needs_attention: 0, full_coverage: 0, low_stock: 0 };
  productsList.forEach(p => {
    const attn = computeProductAttention(p);
    if (attn.hasIssue) counts.needs_attention++;
    if (attn.platformCount === LISTING_PLATFORMS.length) counts.full_coverage++;
    if (attn.isLowStock) counts.low_stock++;
  });

  Object.keys(counts).forEach(key => {
    const el = document.getElementById(`catalog-attn-count-${key}`);
    if (el) el.textContent = counts[key];
  });

  const navProductsBadge = document.getElementById("nav-badge-products");
  if (navProductsBadge) navProductsBadge.textContent = counts.needs_attention > 0 ? String(counts.needs_attention) : "";

  document.querySelectorAll(".catalog-attn-btn").forEach(btn => {
    const isActive = btn.getAttribute("data-attn") === catalogAttentionFilter;
    btn.classList.toggle("active", isActive);
  });

  const banner = document.getElementById("products-unmapped-banner");
  const bannerTitle = document.getElementById("products-unmapped-banner-title");
  if (banner && bannerTitle) {
    const unmappedVars = cachedListings.reduce((s, l) => s + (l.listing_variations || []).filter(v => !v.variant_id).length, 0);
    if (unmappedVars > 0) {
      bannerTitle.textContent = `${unmappedVars} listing variation${unmappedVars !== 1 ? "s" : ""} ${unmappedVars !== 1 ? "aren't" : "isn't"} linked to a catalog SKU`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }
}

function renderProductsMasterDetail(productsList) {
  const headEl = document.getElementById("catalog-list-head");
  const rowsEl = document.getElementById("catalog-tbody");
  const panel = document.getElementById("product-detail-panel");
  if (!headEl || !rowsEl || !panel) return;

  lastRenderedProductsList = productsList;

  headEl.className = "omd-list-head omd-products-cols";
  headEl.innerHTML = `<span>Product</span><span>Brand / Category</span><span>Variants</span><span>Platforms</span><span>Price</span><span></span>`;

  rowsEl.innerHTML = productsList.map(p => {
    const { listing, platformCount, hasIssue, isLowStock } = computeProductAttention(p);
    const dotsHtml = LISTING_PLATFORMS.map(pl =>
      `<div class="omd-pdot" style="${listing && listing[pl.key] ? `background:${pl.color}` : ""}" title="${pl.label}${listing && listing[pl.key] ? "" : ": not listed"}"></div>`
    ).join("");
    const priceText = listing && listing.price_myr != null ? `RM ${Number(listing.price_myr).toFixed(2)}` : "—";
    const issueIcon = hasIssue
      ? `<span class="material-symbols-outlined" title="${!listing ? "Not listed on any platform" : "Has unmapped listing variations"}">warning</span>`
      : "";

    const isSelected = p.id === selectedProductId;

    return `
      <div class="omd-row omd-products-cols${isSelected ? " selected" : ""}" data-product-id="${p.id}">
        <div>
          <span class="omd-msku">${escapeHtml(p.master_sku)}</span>
          <div class="omd-pname truncate" title="${escapeHtml(p.product_base_name)}">${escapeHtml(p.product_base_name)}</div>
        </div>
        <div class="omd-cat-cell"><b>${escapeHtml(p.brand_name)}</b><br>${escapeHtml(p.product_category)}</div>
        <div class="d4-mono10"${isLowStock ? ` style="color:var(--amber)" title="Has variant(s) with stock ≤ 5"` : ""}>${p.variations.length} var${p.variations.length !== 1 ? "s" : ""}${isLowStock ? ` <span class="material-symbols-outlined" style="font-size:11px; vertical-align:-2px;">inventory</span>` : ""}</div>
        <div class="omd-plat-dots"><div class="omd-plat-dots-row">${dotsHtml}</div><span class="omd-cov-label">${platformCount}/5</span></div>
        <div class="omd-subtotal-cell">${priceText}</div>
        <div class="omd-issue-cell">${issueIcon}</div>
      </div>
    `;
  }).join("");

  rowsEl.querySelectorAll(".omd-row").forEach(row => {
    row.addEventListener("click", () => {
      selectProductForDetail(row.getAttribute("data-product-id"), productsList);
    });
  });

  const stillExists = productsList.some(p => p.id === selectedProductId);
  selectProductForDetail(stillExists ? selectedProductId : productsList[0].id, productsList);
}

function selectProductForDetail(productId, productsList) {
  selectedProductId = productId;
  const product = (productsList || []).find(p => p.id === productId);
  const panel = document.getElementById("product-detail-panel");
  if (!panel) return;

  if (!product) {
    panel.innerHTML = `<div class="omd-empty-state"><span class="material-symbols-outlined">touch_app</span><p>Select a product to view details</p></div>`;
    return;
  }

  panel.innerHTML = buildProductDetailPanel(product);
  bindProductDetailPanelEvents(product);
  fetchRecentOrdersForProduct(product);

  document.querySelectorAll("#catalog-tbody .omd-row").forEach(r => {
    r.classList.toggle("selected", r.getAttribute("data-product-id") === productId);
    if (r.getAttribute("data-product-id") === productId) r.scrollIntoView({ block: "nearest" });
  });
}

// Arrow-key navigation through the products list. Ignores keystrokes while
// typing in a field or while any modal is open.
function setupProductsKeyboardNav() {
  document.addEventListener("keydown", (e) => {
    if (currentTab !== "products" && currentTab !== "orders") return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (document.querySelector(".modal-overlay.active")) return;

    const list = currentTab === "products" ? lastRenderedProductsList : lastRenderedOrdersList;
    const selectedId = currentTab === "products" ? selectedProductId : selectedOrderId;
    if (list.length === 0) return;

    e.preventDefault();
    const idx = list.findIndex(x => x.id === selectedId);
    const nextIdx = e.key === "ArrowDown"
      ? Math.min(idx + 1, list.length - 1)
      : Math.max(idx - 1, 0);
    if (nextIdx === idx) return;
    if (currentTab === "products") selectProductForDetail(list[nextIdx].id, list);
    else {
      selectOrderForDetail(list[nextIdx].id, list);
      document.querySelector(`#orders-list .omd-row[data-order-id="${list[nextIdx].id}"]`)?.scrollIntoView({ block: "nearest" });
    }
  });
}

// Pulls the last few orders that include a variant belonging to this
// product, using the real order_items.variant_id foreign key (no
// fabricated data). Runs after the panel is already painted since it
// needs its own DB round-trip; a stale-response guard drops the result
// if the user has since selected a different product.
async function fetchRecentOrdersForProduct(product) {
  const container = document.getElementById("product-detail-recent-orders");
  if (!container || !supabaseClient) return;

  const variantIds = product.variations.map(v => v.id);
  if (variantIds.length === 0) {
    container.innerHTML = `<div class="omd-item-card" style="align-items:center; text-align:center; color:var(--text-muted); font-size:11px;">No variants yet.</div>`;
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from("order_items")
      .select("variant_sku, created_at, orders(platform_order_id, customer_name, overall_order_status, order_timestamp, created_at)")
      .in("variant_id", variantIds)
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) throw error;

    if (selectedProductId !== product.id) return; // user moved on while this was in flight

    if (!data || data.length === 0) {
      container.innerHTML = `<div class="omd-item-card" style="align-items:center; text-align:center; color:var(--text-muted); font-size:11px;">No orders yet.</div>`;
      return;
    }

    container.innerHTML = data.map(item => {
      const order = item.orders;
      if (!order) return "";
      const statusLower = (order.overall_order_status || "").toLowerCase();
      let statusClass = "completed";
      if (statusLower === "printing") statusClass = "printing";
      else if (statusLower === "printed") statusClass = "printed";
      else if (statusLower === "pending") statusClass = "pending";
      else if (statusLower === "hold" || statusLower === "on hold") statusClass = "hold";

      return `
        <div class="omd-variant-row" style="justify-content:space-between;">
          <span class="omd-vsku" style="width:70px; flex-shrink:0;">${escapeHtml(order.platform_order_id || "—")}</span>
          <span class="omd-vname" style="flex:1;">${escapeHtml(order.customer_name || "—")} · ${escapeHtml(item.variant_sku || "")}</span>
          <span class="d4-stchip sm ${d4StatusChipCls(statusClass)}" style="flex-shrink:0;"><i></i>${escapeHtml(order.overall_order_status || "pending")}</span>
          <span class="omd-vfile" style="width:70px; text-align:right; flex-shrink:0;">${relativeTime(order.order_timestamp || order.created_at)}</span>
        </div>
      `;
    }).join("");
  } catch (err) {
    if (selectedProductId !== product.id) return;
    container.innerHTML = `<div class="omd-item-card" style="align-items:center; text-align:center; color:var(--error-color); font-size:11px;">Failed to load recent orders.</div>`;
  }
}

function buildProductDetailPanel(product) {
  const listings = findListingsForProduct(product.id);

  const variantsHtml = product.variations.map(v => {
    let typeClass = "omd-vtype-other";
    if (v.variant_type === "DS") typeClass = "omd-vtype-ds";
    else if (v.variant_type === "WM") typeClass = "omd-vtype-wm";
    else if (v.variant_type === "FWM") typeClass = "omd-vtype-fwm";

    const totalWeight = (v.print_files || []).reduce((sum, f) => sum + (f.weight_g || 0), 0);
    const totalTime = (v.print_files || []).reduce((sum, f) => sum + (f.print_time_m || 0), 0);
    const fileText = (v.print_files || []).length > 0 ? `${totalWeight}g · ${totalTime}m` : "no files";
    const isLow = (v.stock_quantity || 0) <= 5;

    return `
      <div class="omd-variant-row">
        <span class="omd-vtype ${typeClass}">${escapeHtml(v.variant_type || "")}</span>
        <span class="omd-vsku">${escapeHtml(v.variant_sku)}</span>
        <span class="omd-vname" title="${escapeHtml(v.variant_name)}">${escapeHtml(v.variant_name)}</span>
        <span class="omd-vfile">${fileText}</span>
        <button class="omd-print-btn btn-send-to-print" data-variant-id="${v.id}"
          title="${(v.print_files || []).length > 0 ? "Send print file to the SimplyPrint queue" : "No print files attached to this variant"}"
          ${(v.print_files || []).length > 0 ? "" : "disabled"}>
          <span class="material-symbols-outlined">print</span>Print
        </button>
        <div class="omd-stock-stepper${isLow ? " low" : ""}">
          <div class="sb btn-stock-dec" data-variant-id="${v.id}">–</div>
          <div class="sv">${v.stock_quantity || 0}</div>
          <div class="sb btn-stock-inc" data-variant-id="${v.id}">+</div>
        </div>
      </div>
    `;
  }).join("");

  let listingSectionHtml;
  if (listings.length > 0) {
    listingSectionHtml = listings.map(listing => {
      const platformCount = LISTING_PLATFORMS.filter(pl => !!listing[pl.key]).length;
      const SHOPEE_SELLER_DOMAINS = { shopee_my: "seller.shopee.com.my", shopee_sg: "seller.shopee.sg", shopee_ph: "seller.shopee.com.ph", shopee_th: "seller.shopee.co.th" };
      const platformCardsHtml = LISTING_PLATFORMS.map(pl => {
        const val = listing[pl.key];
        if (!val) {
          return `
            <div class="omd-pcard off">
              <div class="pcolor" style="background:${pl.color}"></div>
              <span class="plabel">${pl.label}</span>
              <span class="pval">not listed</span>
            </div>
          `;
        }
        if (SHOPEE_SELLER_DOMAINS[pl.key]) {
          const url = `https://${SHOPEE_SELLER_DOMAINS[pl.key]}/portal/product/${encodeURIComponent(val)}`;
          return `
            <a class="omd-pcard link" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Open in Shopee Seller Centre">
              <div class="pcolor" style="background:${pl.color}"></div>
              <span class="plabel">${pl.label}</span>
              <span class="pval">${escapeHtml(val)}</span>
              <span class="material-symbols-outlined pgo">open_in_new</span>
            </a>
          `;
        }
        // Lazada has no deterministic seller-centre URL from the item id — copy it instead.
        return `
          <button class="omd-pcard link btn-copy-platform-id" data-platform-id="${escapeHtml(val)}" title="Copy Lazada item ID" type="button">
            <div class="pcolor" style="background:${pl.color}"></div>
            <span class="plabel">${pl.label}</span>
            <span class="pval">${escapeHtml(val)}</span>
            <span class="material-symbols-outlined pgo">content_copy</span>
          </button>
        `;
      }).join("");

      const vars = listing.listing_variations || [];
      const rowsHtml = vars.map(lv => {
        const mapped = !!lv.variant_id;
        const sku = lv.variants?.variant_sku || "— unlinked";
        const vtype = lv.variants?.variant_type || "—";
        return `
          <tr class="${mapped ? "" : "unmapped"} btn-edit-mapping-row" style="cursor:pointer;"
            data-variation-id="${lv.id}"
            data-platform-name="${escapeHtml(lv.platform_variation_name || "")}"
            data-normalized="${escapeHtml(lv.normalized_variation_name || "")}"
            data-variant-id="${lv.variant_id || ""}"
            title="Click to edit mapping">
            <td>${mapped ? `<span class="material-symbols-outlined" style="font-size:13px; color:var(--success-color);">check_circle</span>` : `<span class="material-symbols-outlined" style="font-size:13px; color:var(--error-color);">error</span>`}</td>
            <td title="${escapeHtml(lv.platform_variation_name || "—")}">${escapeHtml(lv.platform_variation_name || "—")}</td>
            <td class="omd-sku-cell" title="${escapeHtml(sku)}">${escapeHtml(sku)}</td>
            <td title="${escapeHtml(vtype)}">${escapeHtml(vtype)}</td>
          </tr>
        `;
      }).join("");
      const mappingTableHtml = `
        <table class="omd-map-table">
          <thead><tr><th></th><th>Platform Variation</th><th>SKU</th><th>Type</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;

      return `
        <div>
          <div class="omd-section-title">
            <span class="material-symbols-outlined">storefront</span>
            <span class="truncate" title="${escapeHtml(listing.platform_listing_name || "")}">${escapeHtml(listing.platform_listing_name || "Platform Listing")}</span>
          </div>
          <div class="omd-listing-summary">
            <div class="omd-price-block">
              <div class="pb"><span class="pl">MYR</span><span class="pv">${listing.price_myr != null ? Number(listing.price_myr).toFixed(2) : "—"}</span></div>
              <div class="omd-price-div"></div>
              <div class="pb"><span class="pl">SGD</span><span class="pv">${listing.price_sgd != null ? Number(listing.price_sgd).toFixed(2) : "—"}</span></div>
            </div>
            <span class="d4-stchip sm ${listing.is_active ? "done" : "mut"}" style="margin-left:auto;"><i></i>${listing.is_active ? "Active" : "Off"}</span>
            <span class="omd-cov-label">${platformCount}/5 platforms</span>
          </div>
          <div class="omd-platform-grid">${platformCardsHtml}</div>
          <div class="omd-section-title" style="margin-top:10px;">
            <span class="material-symbols-outlined">link</span>Variation Mapping
            <button class="omd-tag-btn btn-add-variation-mapping" data-listing-id="${listing.id}" style="margin-left:auto;"><span class="material-symbols-outlined">add</span>Add Variation</button>
          </div>
          ${vars.length > 0 ? mappingTableHtml : `<div class="omd-item-card" style="align-items:center; text-align:center; color:var(--text-muted); font-size:11px;">No variations mapped yet.</div>`}
        </div>
      `;
    }).join("");
  } else {
    listingSectionHtml = `
      <div>
        <div class="omd-section-title"><span class="material-symbols-outlined">storefront</span>Platform Listing</div>
        <div class="omd-item-card" style="align-items:center; text-align:center; color:var(--text-muted); font-size:11px;">
          Not listed on any platform yet.
          <button class="omd-tag-btn btn-add-listing-for-product" data-product-id="${product.id}" style="margin-top:6px;"><span class="material-symbols-outlined">add</span>Add Listing</button>
        </div>
      </div>
    `;
  }

  const hasUnmappedVars = listings.some(l => (l.listing_variations || []).some(lv => !lv.variant_id));
  // First variant with a photos folder — Drive folder URLs can't be rendered as
  // thumbnails client-side, so link out instead.
  const picsUrl = (product.variations.find(v => v.pictures_gdrive_url) || {}).pictures_gdrive_url;

  return `
    <div class="omd-dp-head">
      <div>
        <span class="omd-msku">${escapeHtml(product.master_sku)}</span>
        <div class="omd-pname">${escapeHtml(product.product_base_name)}</div>
        <div class="omd-meta" style="margin-top:4px;">${escapeHtml(product.brand_name)} · ${escapeHtml(product.product_category)}</div>
      </div>
      <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
        ${picsUrl ? `<a href="${escapeHtml(sanitizeUrl(picsUrl))}" target="_blank" rel="noopener" class="d4-iconbtn" title="Open product photos (Google Drive)"><span class="material-symbols-outlined">photo_library</span></a>` : ""}
        <button class="d4-iconbtn btn-product-details" data-product-id="${product.id}" title="View Full Details">
          <span class="material-symbols-outlined">info</span>
        </button>
        <button class="d4-iconbtn btn-catalog-edit" data-product-id="${product.id}" title="Edit Product">
          <span class="material-symbols-outlined">edit</span>
        </button>
      </div>
    </div>

    <div>
      <div class="omd-section-title"><span class="material-symbols-outlined">inventory_2</span>Variants &amp; Stock (${product.variations.length})</div>
      ${variantsHtml}
    </div>

    ${listingSectionHtml}

    <div>
      <div class="omd-section-title"><span class="material-symbols-outlined">history</span>Recent Orders (this product)</div>
      <div id="product-detail-recent-orders">
        <div class="omd-item-card" style="align-items:center; text-align:center; color:var(--text-muted); font-size:11px;">Loading…</div>
      </div>
    </div>

    <div class="omd-dp-footer">
      <div class="omd-dp-footer-actions">
        <div class="d4-btn btn-add-variant-for-product" data-product-id="${product.id}"><span class="material-symbols-outlined">add</span>Add Variant</div>
        <div class="d4-btn ${hasUnmappedVars ? "pri" : ""} btn-fix-mapping${hasUnmappedVars ? "" : " off"}"><span class="material-symbols-outlined">link</span>Fix Mapping</div>
      </div>
    </div>
  `;
}

function bindProductDetailPanelEvents(product) {
  const panel = document.getElementById("product-detail-panel");
  if (!panel) return;

  // Stock stepper buttons — reuse the existing updateStockInDb() helper
  // (used elsewhere for the same field), just updating this panel's own
  // DOM node in place afterward instead of a legacy .input-stock-qty field.
  panel.querySelectorAll(".btn-stock-dec, .btn-stock-inc").forEach(btn => {
    btn.addEventListener("click", async () => {
      const variantId = btn.getAttribute("data-variant-id");
      const variant = product.variations.find(v => v.id === variantId);
      if (!variant) return;
      const delta = btn.classList.contains("btn-stock-inc") ? 1 : -1;
      const newQty = Math.max(0, (variant.stock_quantity || 0) + delta);
      variant.stock_quantity = newQty;
      const valEl = btn.parentElement.querySelector(".sv");
      if (valEl) valEl.textContent = newQty;
      try {
        await updateStockInDb(variantId, newQty);
      } catch (err) {
        showToast("Error updating stock: " + err.message, "error");
      }
    });
  });

  // Send-to-print buttons — confirm, then dispatch every print file on the
  // variant through the same /print-files/queue endpoint as re-dispatch.
  panel.querySelectorAll(".btn-send-to-print").forEach(btn => {
    btn.addEventListener("click", async () => {
      const variantId = btn.getAttribute("data-variant-id");
      const variant = product.variations.find(v => v.id === variantId);
      const files = (variant?.print_files || []).filter(f => f.print_file_name);
      if (!files.length) return;
      const fileList = files.map(f => f.print_file_name).join(", ");
      const confirmed = await showConfirmModal(
        "Send to Print Queue",
        `Send ${files.length > 1 ? `these ${files.length} files` : "this file"} to the SimplyPrint queue?\n\n${fileList}`,
        "Send to Queue"
      );
      if (!confirmed) return;
      for (const f of files) {
        await window.redispatchPrintFile(f.simplyprint_file_id, f.print_file_name, null, btn);
      }
    });
  });

  // Lazada platform tiles copy their raw item id (no deterministic seller URL).
  panel.querySelectorAll(".btn-copy-platform-id").forEach(btn => {
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(btn.getAttribute("data-platform-id") || "").then(
        () => showToast("Lazada item ID copied.", "success"),
        () => showToast("Copy failed.", "error")
      );
    });
  });

  const detailsBtn = panel.querySelector(".btn-product-details");
  if (detailsBtn) detailsBtn.addEventListener("click", () => openCatalogDetailModal(product.id));

  const editBtn = panel.querySelector(".btn-catalog-edit");
  if (editBtn) editBtn.addEventListener("click", () => openCatalogEditModal(product.id));

  const addListingBtn = panel.querySelector(".btn-add-listing-for-product");
  if (addListingBtn) {
    addListingBtn.addEventListener("click", async () => {
      await openAddListingModal();
      const filterEl = document.getElementById("add-listing-product-filter");
      const sel = document.getElementById("add-listing-product-id");
      if (filterEl) filterEl.value = product.master_sku || "";
      filterAddListingProducts(product.master_sku || "");
      if (sel) sel.value = product.id;
    });
  }

  const addVariantBtn = panel.querySelector(".btn-add-variant-for-product");
  if (addVariantBtn) {
    addVariantBtn.addEventListener("click", async () => {
      await populateProductsSelect();
      document.getElementById("modal-tab-existing-product")?.click();
      const select = document.getElementById("catalog-select-product");
      if (select) select.value = product.id;
      document.getElementById("add-catalog-modal")?.classList.add("active");
    });
  }

  const fixMappingBtn = panel.querySelector(".btn-fix-mapping");
  if (fixMappingBtn && !fixMappingBtn.classList.contains("off")) {
    fixMappingBtn.addEventListener("click", () => {
      // Search across every listing for this product — it's no longer
      // guaranteed to be just one.
      for (const listing of findListingsForProduct(product.id)) {
        const unmapped = (listing.listing_variations || []).find(lv => !lv.variant_id);
        if (unmapped) {
          openEditVariationModal({
            variationId: unmapped.id,
            platformName: unmapped.platform_variation_name || "",
            normalized: unmapped.normalized_variation_name || "",
            variantId: unmapped.variant_id || "",
          });
          break;
        }
      }
    });
  }

  panel.querySelectorAll(".btn-edit-mapping-row").forEach(row => {
    row.addEventListener("click", () => openEditVariationModal(row.dataset));
  });

  // Add a brand-new variation mapping row to an existing listing — e.g. a
  // listing that bundles two physical variants under one marketplace page
  // but only had one of them mapped.
  panel.querySelectorAll(".btn-add-variation-mapping").forEach(btn => {
    btn.addEventListener("click", () => {
      openEditVariationModal({ listingId: btn.getAttribute("data-listing-id") });
    });
  });
}

// Clear Database tables
async function clearDatabase() {
  if (!await showConfirmModal("Clear All Data", "Are you sure you want to clear all orders, order items, print jobs, and logs? This is irreversible!", "Clear All")) {
    return;
  }

  if (!supabaseClient) return;

  try {
    const button = document.getElementById("clear-db-btn");
    button.disabled = true;
    button.innerHTML = `<span class="material-symbols-outlined animate-spin" style="font-size:16px;vertical-align:middle;">progress_activity</span> Clearing...`;

    // Delete records from database directly using Cascade deletes
    const { error: pjError } = await supabaseClient.from("print_jobs").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    const { error: oiError } = await supabaseClient.from("order_items").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    const { error: oError } = await supabaseClient.from("orders").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    const { error: logError } = await supabaseClient.from("system_logs").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    if (pjError || oiError || oError || logError) {
      throw new Error(`Failed to clear database: ${pjError?.message || oiError?.message || oError?.message || logError?.message}`);
    }

    showToast("Database cleared successfully.", "success");

    // Re-render
    fetchSummaryStats();
    if (currentTab === "orders") fetchAndRenderOrders();
    if (currentTab === "logs") fetchAndRenderLogs();

  } catch (err) {
    showToast(`Error clearing database: ${err.message}`, "error");
  } finally {
    const button = document.getElementById("clear-db-btn");
    button.disabled = false;
    button.innerHTML = `<i class="fa-solid fa-trash-can"></i> Clear All Data`;
  }
}

// Tab navigation handler
function setupTabs() {
  const globalSearch = document.getElementById("global-search-input");
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

      btn.classList.add("active");
      const tabId = btn.getAttribute("data-tab");
      currentTab = tabId;
      
      const pane = document.getElementById(`pane-${tabId}`);
      if (pane) pane.classList.add("active");

      // Synchronize global search input with tab search query
      if (globalSearch) {
        if (tabId === "orders") {
          globalSearch.value = orderSearchQuery;
        } else if (tabId === "products") {
          const catalogSearch = document.getElementById("catalog-search");
          globalSearch.value = catalogSearch ? catalogSearch.value : "";
        } else if (tabId === "operations") {
          globalSearch.value = jobsSearchQuery;
          const jobsSearch = document.getElementById("jobs-search-input");
          if (jobsSearch) jobsSearch.value = jobsSearchQuery;
        } else {
          globalSearch.value = "";
        }
      }

      // Refresh data for the active tab
      if (tabId === "overview") {
        fetchAgentHeartbeats();
        fetchSummaryStats();
        fetchAndRenderPrintersAndQueue(); // still feeds the Queue Depth KPI
        fetchAndRenderMissionControl();
      }
      if (tabId === "orders") {
        // Merged Orders + Waybills tab
        fetchAndRenderOrders();
        fetchAgentHeartbeats();
        fetchAndRenderWaybillsArchive();
      }
      if (tabId === "logs") { fetchAndRenderLogs(); }
      if (tabId === "products") {
        // Merged Catalog + Listings tab
        fetchAndRenderCatalog();
        fetchAndRenderListings();
      }
      if (tabId === "operations") {
        // Merged Printers + Agents tab
        fetchAndRenderPrintersAndQueue();
        fetchAndRenderPrintJobs();
        fetchAgentHeartbeats();
        fetchAndRenderJobs();
        fetchAndRenderGeminiUsage();
      }
      if (tabId === "launch") {
        initLaunchTab();
      }
    });
  });
}

// ==========================================================================
// Command Palette (Aurora 3.0) — true global search + actions. Replaces the
// old header-search proxy that only filtered the active tab.
// ==========================================================================

const CP_RECENTS_KEY = "orbot_cp_recents";
let cpResults = [];
let cpActiveIdx = 0;
let cpQueryToken = 0;

function cpActions() {
  return [
    { icon: "mail", label: "Trigger Gmail Scan", type: "Action", run: () => document.getElementById("ctrl-trigger-scout")?.click() },
    { icon: "print", label: "Trigger Print Dispatch", type: "Action", run: () => document.getElementById("ctrl-trigger-foreman")?.click() },
    { icon: "local_shipping", label: "Compile Waybill Batch", type: "Action", run: () => document.getElementById("ctrl-trigger-compile")?.click() },
    { icon: "sync", label: "Sync SimplyPrint", type: "Action", run: () => document.getElementById("ctrl-trigger-sync-simplyprint")?.click() },
    { icon: "add_box", label: "Add Product", type: "Action", run: () => { navigateToTab("products"); document.getElementById("add-catalog-item-btn")?.click(); } },
    { icon: "storefront", label: "Add Listing", type: "Action", run: () => { navigateToTab("products"); document.getElementById("add-listing-header-btn")?.click(); } },
    { icon: "settings", label: "Open Settings", type: "Action", run: () => document.getElementById("settings-open-btn")?.click() },
    { icon: "dashboard", label: "Go to Overview", type: "Nav", run: () => navigateToTab("overview") },
    { icon: "receipt_long", label: "Go to Orders", type: "Nav", run: () => navigateToTab("orders") },
    { icon: "hub", label: "Go to Operations", type: "Nav", run: () => navigateToTab("operations") },
    { icon: "inventory_2", label: "Go to Products", type: "Nav", run: () => navigateToTab("products") },
    { icon: "rocket_launch", label: "Go to Launch", type: "Nav", run: () => navigateToTab("launch") },
    { icon: "description", label: "Go to Logs", type: "Nav", run: () => navigateToTab("logs") },
  ];
}

function cpScore(query, text) {
  const q = query.toLowerCase(), t = String(text || "").toLowerCase();
  if (!t) return -1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const wordStart = t.split(/[\s\-_/]+/).some(w => w.startsWith(q));
  if (wordStart) return 60;
  if (t.includes(q)) return 40;
  return -1;
}

function cpLoadRecents() {
  try { return JSON.parse(localStorage.getItem(CP_RECENTS_KEY)) || []; } catch (_) { return []; }
}

function cpPushRecent(item) {
  const recents = cpLoadRecents().filter(r => r.label !== item.label);
  recents.unshift({ icon: item.icon, label: item.label, type: item.type, orderId: item.orderId || null, productId: item.productId || null });
  localStorage.setItem(CP_RECENTS_KEY, JSON.stringify(recents.slice(0, 6)));
}

function cpItemFromRecent(r) {
  return {
    ...r,
    run: () => {
      if (r.orderId) { selectedOrderId = r.orderId; navigateToTab("orders"); }
      else if (r.productId) { selectedProductId = r.productId; navigateToTab("products"); }
      else {
        const act = cpActions().find(a => a.label === r.label);
        if (act) act.run();
      }
    },
  };
}

function cpCollect(query) {
  const q = query.trim();
  if (!q) {
    const recents = cpLoadRecents().map(cpItemFromRecent);
    return [
      ...(recents.length ? [{ section: "Recent" }, ...recents] : []),
      { section: "Actions" },
      ...cpActions(),
    ];
  }

  const scored = [];
  cpActions().forEach(a => {
    const s = cpScore(q, a.label);
    if (s > 0) scored.push({ ...a, _s: s + 5 });
  });
  cachedOrders.forEach(o => {
    const s = Math.max(cpScore(q, o.platform_order_id), cpScore(q, o.customer_name));
    if (s > 0) scored.push({
      icon: "receipt_long", type: "Order", _s: s,
      label: `${o.platform_order_id} — ${o.customer_name || "—"}`,
      sub: o.overall_order_status || "", orderId: o.id,
      run: () => { selectedOrderId = o.id; navigateToTab("orders"); },
    });
  });
  const seenProducts = new Set();
  cachedVariants.forEach(v => {
    const prod = v.products;
    if (!prod) return;
    const s = Math.max(cpScore(q, v.variant_sku), cpScore(q, prod.product_base_name), cpScore(q, prod.master_sku));
    if (s > 0 && !seenProducts.has(prod.id)) {
      seenProducts.add(prod.id);
      scored.push({
        icon: "inventory_2", type: "Product", _s: s,
        label: `${prod.master_sku || ""} — ${prod.product_base_name}`,
        sub: v.variant_sku, productId: prod.id,
        run: () => { selectedProductId = prod.id; navigateToTab("products"); },
      });
    }
  });
  cachedListings.forEach(l => {
    const s = cpScore(q, l.platform_listing_name);
    if (s > 0 && l.products && !seenProducts.has(l.products.id)) {
      seenProducts.add(l.products.id);
      scored.push({
        icon: "storefront", type: "Listing", _s: s - 5,
        label: l.platform_listing_name, productId: l.products.id,
        run: () => { selectedProductId = l.products.id; navigateToTab("products"); },
      });
    }
  });

  scored.sort((a, b) => b._s - a._s);
  return scored.slice(0, 14);
}

// Cold-cache fallback: when the local caches have nothing, hit the DB with a
// lightweight ilike search and merge the results in (token-guarded).
async function cpRemoteSearch(query, token) {
  if (!supabaseClient || query.length < 2) return;
  try {
    const [oRes, vRes] = await Promise.all([
      supabaseClient.from("orders").select("id, platform_order_id, customer_name, overall_order_status")
        .or(`platform_order_id.ilike.%${query}%,customer_name.ilike.%${query}%`).limit(6),
      supabaseClient.from("variants").select("id, variant_sku, products(id, master_sku, product_base_name)")
        .ilike("variant_sku", `%${query}%`).limit(6),
    ]);
    if (token !== cpQueryToken) return; // stale response
    const extra = [];
    (oRes.data || []).forEach(o => {
      if (!cpResults.some(r => r.orderId === o.id)) extra.push({
        icon: "receipt_long", type: "Order",
        label: `${o.platform_order_id} — ${o.customer_name || "—"}`,
        sub: o.overall_order_status || "", orderId: o.id,
        run: () => { selectedOrderId = o.id; navigateToTab("orders"); },
      });
    });
    (vRes.data || []).forEach(v => {
      const prod = v.products;
      if (prod && !cpResults.some(r => r.productId === prod.id)) extra.push({
        icon: "inventory_2", type: "Product",
        label: `${prod.master_sku || ""} — ${prod.product_base_name}`,
        sub: v.variant_sku, productId: prod.id,
        run: () => { selectedProductId = prod.id; navigateToTab("products"); },
      });
    });
    if (extra.length) {
      cpResults = [...cpResults.filter(r => !r.section), ...extra].slice(0, 14);
      cpRender();
    }
  } catch (_) { /* remote search is best-effort */ }
}

function cpRender() {
  const box = document.getElementById("cp-results");
  if (!box) return;
  const rows = cpResults;
  if (rows.length === 0) {
    box.innerHTML = `<div class="cp-empty">No matches. Try an order ID, SKU, product name, or action.</div>`;
    return;
  }
  // Clamp active index onto a non-section row
  const selectable = rows.map((r, i) => (r.section ? null : i)).filter(i => i !== null);
  if (!selectable.includes(cpActiveIdx)) cpActiveIdx = selectable[0] ?? 0;
  box.innerHTML = rows.map((r, i) => r.section
    ? `<div class="cp-section-label">${r.section}</div>`
    : `<div class="cp-result${i === cpActiveIdx ? " active" : ""}" data-cp-idx="${i}">
        <span class="material-symbols-outlined">${r.icon}</span>
        <span class="cp-label">${escapeHtml(r.label)}</span>
        ${r.sub ? `<span class="cp-sub">${escapeHtml(r.sub)}</span>` : ""}
        <span class="cp-type">${r.type}</span>
      </div>`).join("");
  box.querySelectorAll(".cp-result").forEach(el => {
    el.addEventListener("click", () => cpExecute(Number(el.getAttribute("data-cp-idx"))));
    el.addEventListener("mousemove", () => {
      const i = Number(el.getAttribute("data-cp-idx"));
      if (i !== cpActiveIdx) { cpActiveIdx = i; cpRender(); }
    });
  });
  box.querySelector(".cp-result.active")?.scrollIntoView({ block: "nearest" });
}

function cpExecute(idx) {
  const item = cpResults[idx];
  if (!item || item.section) return;
  cpPushRecent(item);
  cpClose();
  item.run();
}

function cpOpen() {
  const overlay = document.getElementById("command-palette");
  const input = document.getElementById("cp-input");
  if (!overlay || !input) return;
  overlay.classList.add("active");
  input.value = "";
  cpActiveIdx = 0;
  cpResults = cpCollect("");
  cpRender();
  setTimeout(() => input.focus(), 30);
}

function cpClose() {
  document.getElementById("command-palette")?.classList.remove("active");
}

function setupCommandPalette() {
  const overlay = document.getElementById("command-palette");
  const input = document.getElementById("cp-input");
  const trigger = document.getElementById("global-search-input");
  if (!overlay || !input) return;

  if (trigger) trigger.addEventListener("click", cpOpen);

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      overlay.classList.contains("active") ? cpClose() : cpOpen();
    }
  });

  overlay.addEventListener("click", (e) => { if (e.target === overlay) cpClose(); });

  const remoteDebounced = debounce((q, token) => cpRemoteSearch(q, token), 220);

  input.addEventListener("keydown", (e) => {
    const selectable = cpResults.map((r, i) => (r.section ? null : i)).filter(i => i !== null);
    const pos = selectable.indexOf(cpActiveIdx);
    if (e.key === "Escape") { e.preventDefault(); cpClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); cpActiveIdx = selectable[Math.min(pos + 1, selectable.length - 1)] ?? cpActiveIdx; cpRender(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cpActiveIdx = selectable[Math.max(pos - 1, 0)] ?? cpActiveIdx; cpRender(); }
    else if (e.key === "Enter") { e.preventDefault(); cpExecute(cpActiveIdx); }
    e.stopPropagation();
  });

  input.addEventListener("input", () => {
    const q = input.value;
    cpActiveIdx = 0;
    cpResults = cpCollect(q);
    cpRender();
    cpQueryToken++;
    if (q.trim().length >= 2 && (cachedOrders.length === 0 || cachedVariants.length === 0)) {
      remoteDebounced(q.trim(), cpQueryToken);
    }
  });
}

// Settings Page Handling (full nav tab — see pane-settings — not a modal)
function setupSettings() {
  const openBtn = document.getElementById("settings-open-btn");
  const saveBtn = document.getElementById("settings-save-btn");
  const prefsSaveBtn = document.getElementById("settings-prefs-save-btn");

  openBtn?.addEventListener("click", () => navigateToTab("settings"));

  saveBtn?.addEventListener("click", async () => {
    const url = document.getElementById("setting-supabase-url").value.trim();
    const key = document.getElementById("setting-supabase-key").value.trim();
    let backendUrl = document.getElementById("setting-backend-url").value.trim();
    if (backendUrl && !backendUrl.startsWith("http://") && !backendUrl.startsWith("https://")) {
      backendUrl = "https://" + backendUrl;
      document.getElementById("setting-backend-url").value = backendUrl;
    }
    const apiKeyField = document.getElementById("setting-orbot-api-key");
    const apiKey = apiKeyField ? apiKeyField.value.trim() : "";

    // These are local-dev overrides only (blank = defer to the backend's /config
    // defaults, which is what every browser uses out of the box). The Supabase key
    // is the anon key (RLS-gated) — safe to store like any other config value.
    localStorage.setItem("orbot_supabase_url", url);
    localStorage.setItem("orbot_supabase_key", key);
    localStorage.setItem("orbot_backend_url", backendUrl);
    if (apiKeyField) {
      if (apiKey) localStorage.setItem("orbot_api_key", apiKey);
      else localStorage.removeItem("orbot_api_key");
    }

    const savedAt = document.getElementById("settings-conn-saved-at");
    if (savedAt) savedAt.textContent = `Last saved ${new Date().toLocaleString()}`;

    if (await initSupabase()) {
      fetchSummaryStats();
      if (currentTab === "orders") {
        fetchAndRenderOrders();
        fetchAndRenderWaybillsArchive();
      }
      if (currentTab === "logs") fetchAndRenderLogs();
      if (currentTab === "products") {
        cachedVariants = [];
        fetchAndRenderCatalog();
        fetchAndRenderListings();
      }
      if (currentTab === "operations") {
        fetchAgentHeartbeats();
        fetchAndRenderJobs();
        fetchAndRenderPrintersAndQueue();
      }
    }
    showToast("Connections saved.", "success");
  });

  // The dispatch toggle is a shared feature flag, not a per-browser credential —
  // persist it on the backend so flipping it here applies on every device.
  prefsSaveBtn?.addEventListener("click", async () => {
    const spDispatchChecked = document.getElementById("setting-sp-dispatch").checked;
    try {
      const res = await backendFetch(`/config/sp-dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: spDispatchChecked }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (JSON.parse(await res.text())).detail || detail; } catch (_) {}
        throw new Error(detail);
      }
      showToast("Preferences saved.", "success");
    } catch (error) {
      console.error("Failed to persist SimplyPrint dispatch toggle:", error);
      showToast(`Failed to save preferences: ${error.message}`, "error");
    }
  });

  document.querySelectorAll(".settings-nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".settings-nav-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const section = btn.dataset.settingsSection;
      document.querySelectorAll(".settings-section").forEach(s => {
        s.classList.toggle("hidden", s.id !== `settings-section-${section}`);
      });
    });
  });

  setupLaunchTemplatesSettings();
}

const LAUNCH_TEMPLATE_TOKENS = ['{variant_types}', '{theme}', '{set_name}', '{set_number}', '{brand}', '{sku}'];
const LAUNCH_TEMPLATE_DESC_TOKENS = ['{variant_bullets}', '{variant_types_lower}', '{theme}', '{set_name}', '{set_number}', '{brand}'];
const LAUNCH_TEMPLATE_SAMPLE = {
  set_name: 'Millennium Falcon', set_number: '75389', theme: 'Star Wars', brand_name: 'Blocked Off',
  product_types: ['DS', 'WM'],
  variants: [
    { sku: 'BLO-SWR-75389-DS', platform_variation_name: 'Display Stand' },
    { sku: 'BLO-SWR-75389-WM', platform_variation_name: 'Wall Mount' },
  ],
};

// Settings > Launch Templates: token-insert editors + live preview, persisted to
// localStorage (orbot_launch_title_template / orbot_launch_desc_template) — read by
// applyLaunchCopy() during Launch preview generation.
function setupLaunchTemplatesSettings() {
  const titleEl = document.getElementById("setting-tpl-title");
  const descEl = document.getElementById("setting-tpl-desc");
  const saveBtn = document.getElementById("settings-tpl-save-btn");
  if (!titleEl || !descEl) return;

  titleEl.value = localStorage.getItem("orbot_launch_title_template") || "";
  descEl.value = localStorage.getItem("orbot_launch_desc_template") || "";

  const updatePreview = () => {
    document.getElementById("settings-tpl-preview-title").textContent =
      titleEl.value ? expandLaunchTemplate(titleEl.value, LAUNCH_TEMPLATE_SAMPLE) : "— no title template set, AI-generated copy will be used —";
    document.getElementById("settings-tpl-preview-desc").textContent =
      descEl.value ? expandLaunchTemplate(descEl.value, LAUNCH_TEMPLATE_SAMPLE) : "— no description template set, AI-generated copy will be used —";
  };

  const renderTokens = (containerId, fieldEl, tokens) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = tokens.map(t => `<span class="tpl-token" data-token="${t}">${t}</span>`).join("");
    container.querySelectorAll(".tpl-token").forEach(chip => {
      chip.addEventListener("click", () => {
        const tok = chip.dataset.token;
        const start = fieldEl.selectionStart ?? fieldEl.value.length;
        const end = fieldEl.selectionEnd ?? fieldEl.value.length;
        fieldEl.value = fieldEl.value.slice(0, start) + tok + fieldEl.value.slice(end);
        fieldEl.focus();
        fieldEl.selectionStart = fieldEl.selectionEnd = start + tok.length;
        updatePreview();
      });
    });
  };
  renderTokens("settings-tpl-title-tokens", titleEl, LAUNCH_TEMPLATE_TOKENS);
  renderTokens("settings-tpl-desc-tokens", descEl, LAUNCH_TEMPLATE_DESC_TOKENS);

  titleEl.addEventListener("input", updatePreview);
  descEl.addEventListener("input", updatePreview);
  updatePreview();

  saveBtn?.addEventListener("click", () => {
    localStorage.setItem("orbot_launch_title_template", titleEl.value.trim());
    localStorage.setItem("orbot_launch_desc_template", descEl.value.trim());
    const savedAt = document.getElementById("settings-tpl-saved-at");
    if (savedAt) savedAt.textContent = `Last saved ${new Date().toLocaleString()}`;
    showToast("Launch templates saved.", "success");
  });
}

// Setup logs filtering
function setupLogsFiltering() {
  document.querySelectorAll(".activity-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".activity-chip").forEach(c => {
        c.classList.remove("bg-primary/10", "text-primary", "active");
        c.classList.add("text-on-surface-variant");
      });
      chip.classList.add("bg-primary/10", "text-primary", "active");
      chip.classList.remove("text-on-surface-variant");
      activeStreamFilter = chip.getAttribute("data-stream");
      fetchAndRenderLogs();
    });
  });
}

// Generic "x" clear button for search/filter inputs. Delegated on document so it
// works for every input marked up with a sibling .search-clear-btn[data-clear-target],
// including ones inside modals that don't exist yet at page load.
function setupSearchClearButtons() {
  document.querySelectorAll(".search-clear-btn").forEach(btn => {
    const input = document.getElementById(btn.getAttribute("data-clear-target"));
    if (input) btn.classList.toggle("hidden", !input.value);
  });

  document.addEventListener("input", (e) => {
    if (!(e.target instanceof HTMLInputElement)) return;
    const clearBtn = e.target.parentElement?.querySelector(":scope > .search-clear-btn");
    if (clearBtn) clearBtn.classList.toggle("hidden", !e.target.value);
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".search-clear-btn");
    if (!btn) return;
    const input = document.getElementById(btn.getAttribute("data-clear-target"));
    if (!input) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  });
}

function setupCatalogSearch() {
  const searchInput = document.getElementById("catalog-search");
  if (searchInput) {
    searchInput.addEventListener("input", debounce(() => {
      fetchAndRenderCatalog();
    }, 250));
  }

  const brandSelect = document.getElementById("catalog-filter-brand");
  const categorySelect = document.getElementById("catalog-filter-category");
  const clearFiltersBtn = document.getElementById("catalog-clear-filters-btn");

  if (brandSelect) {
    brandSelect.addEventListener("change", () => {
      fetchAndRenderCatalog();
    });
  }
  if (categorySelect) {
    categorySelect.addEventListener("change", () => {
      fetchAndRenderCatalog();
    });
  }
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener("click", () => {
      if (brandSelect) brandSelect.value = "all";
      if (categorySelect) categorySelect.value = "all";
      fetchAndRenderCatalog();
    });
  }

  const sortSelect = document.getElementById("catalog-sort-order");
  if (sortSelect) {
    sortSelect.addEventListener("change", () => {
      catalogSortOrder = sortSelect.value;
      fetchAndRenderCatalog();
    });
  }

  document.querySelectorAll(".catalog-attn-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      catalogAttentionFilter = btn.getAttribute("data-attn");
      fetchAndRenderCatalog();
    });
  });

  document.getElementById("products-unmapped-banner-btn")?.addEventListener("click", () => {
    catalogAttentionFilter = "needs_attention";
    fetchAndRenderCatalog();
  });

  document.getElementById("add-listing-header-btn")?.addEventListener("click", () => {
    openAddListingModal();
  });

  // Platform Listings section is collapsed by default — the same data is
  // surfaced per-product in the detail panel, so the full list is an
  // on-demand drill-down rather than a permanent second page of scrolling.
  const listingsToggle = document.getElementById("listings-collapse-toggle");
  if (listingsToggle) {
    listingsToggle.addEventListener("click", () => {
      const chevron = document.getElementById("listings-collapse-chevron");
      const nowHidden = document.querySelector(".listings-body")?.classList.contains("hidden");
      document.querySelectorAll(".listings-body").forEach(el => el.classList.toggle("hidden", !nowHidden));
      if (chevron) chevron.style.transform = nowHidden ? "rotate(180deg)" : "";
    });
  }
}

// Hold Resolution Helper Functions
async function resetOrderHold(orderId) {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient
      .from("orders")
      .update({
        overall_order_status: "pending",
        waybill_processing_status: "pending",
        raw_waybill_gdrive_url: null,
        processed_waybill_gdrive_url: null
      })
      .eq("id", orderId);
    if (error) throw error;
    showToast("Order reset to pending.", "success");
    fetchAndRenderOrders();
  } catch (err) {
    showToast("Failed to reset order hold: " + err.message, "error");
  }
}

async function forceReleaseOrder(orderId) {
  if (!supabaseClient) return;
  try {
    const { data: order } = await supabaseClient
      .from("orders")
      .select("raw_waybill_gdrive_url")
      .eq("id", orderId)
      .single();
    
    const rawUrl = order?.raw_waybill_gdrive_url || null;
    
    const { error } = await supabaseClient
      .from("orders")
      .update({
        overall_order_status: "pending",
        waybill_processing_status: "ready",
        processed_waybill_gdrive_url: rawUrl
      })
      .eq("id", orderId);
    if (error) throw error;
    showToast("Order released. Ready to compile batch PDF.", "success");
    fetchAndRenderOrders();
  } catch (err) {
    showToast("Failed to force release order: " + err.message, "error");
  }
}

// Heartbeats & Agent Management
function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

async function fetchAgentHeartbeats() {
  if (!supabaseClient) return;
  try {
    const { data: heartbeats, error } = await supabaseClient
      .from("agent_heartbeats")
      .select("*");
    if (error) throw error;

    const now = Date.now();
    const isOnline = (hbTimeStr, thresholdMs = 120000) => {
      if (!hbTimeStr) return false;
      return (now - new Date(hbTimeStr).getTime()) < thresholdMs;
    };

    const hbMap = Object.fromEntries((heartbeats || []).map(h => [h.agent_name, h]));

    // --- orbot_service (legacy + header elements) ---
    const svcHb = hbMap["orbot_service"];
    const svcOnline = isOnline(svcHb?.last_heartbeat, 120000);
    const prefixes = ["", "waybill-", "overview-", "header-", "ops-strip-"];
    prefixes.forEach(prefix => {
      const dotEl = document.getElementById(`${prefix}hb-orbot_service-dot`);
      const textEl = document.getElementById(`${prefix}hb-orbot_service-text`);
      if (dotEl && textEl) {
        if (svcOnline) {
          dotEl.className = (prefix === "waybill-") ? "w-1.5 h-1.5 rounded-full bg-success" : (prefix === "header-") ? "d4-dot on" : "status-light-online";
          textEl.innerText = "Online";
          textEl.style.color = "#3ecf8e";
        } else {
          dotEl.className = (prefix === "waybill-") ? "w-1.5 h-1.5 rounded-full bg-error" : (prefix === "header-") ? "d4-dot off" : "status-light-offline";
          textEl.innerText = "Offline";
          textEl.style.color = "#ff6666";
        }
      }
    });

    // Logo core doubles as the service indicator: red ◆ when orbot_service is down.
    document.querySelector(".d4-logo .core")?.classList.toggle("offline", !svcOnline);

    // --- Agents page cards ---
    const agentConfigs = [
      { name: "orbot_service", threshold: 120000, color: "#3ecf8e", dotId: "agents-hb-service-dot", textId: "agents-hb-service-text", timeId: "agents-hb-service-time", fleetId: null },
      { name: "scout",         threshold: 600000, color: "#22d3ee", dotId: "agents-hb-scout-dot",   textId: "agents-hb-scout-text",   timeId: "agents-hb-scout-time",   fleetId: "overview-fleet-scout" },
      { name: "orbot_service", threshold: 120000, color: "#3ecf8e", dotId: "agents-hb-foreman-dot", textId: "agents-hb-foreman-text", timeId: "agents-hb-foreman-time", fleetId: "overview-fleet-foreman" },
      { name: "waybill_agent", threshold: 600000, color: "#ffaa6b", dotId: "agents-hb-waybill-dot",  textId: "agents-hb-waybill-text",  timeId: "agents-hb-waybill-time", fleetId: "overview-fleet-waybill" },
      { name: "orbot_service", threshold: 120000, color: "#7ea6e8", dotId: "agents-hb-spsync-dot",  textId: "agents-hb-spsync-text",  timeId: "agents-hb-spsync-time", fleetId: "overview-fleet-spsync" },
    ];
    agentConfigs.forEach(({ name, threshold, color, dotId, textId, timeId, fleetId }) => {
      const hb = hbMap[name];
      const online = isOnline(hb?.last_heartbeat, threshold);
      const dotEl = document.getElementById(dotId);
      const textEl = document.getElementById(textId);
      const timeEl = document.getElementById(timeId);
      if (dotEl) dotEl.style.background = online ? "#10b981" : "#ff6666";
      if (textEl) { textEl.innerText = online ? "Online" : "Offline"; textEl.style.color = online ? "#10b981" : "#ff6666"; }
      if (timeEl) timeEl.innerText = timeAgo(hb?.last_heartbeat);

      // Overview dashboard's Agent Fleet summary — same signal again, list form.
      if (fleetId) {
        const fleetDot = document.getElementById(`${fleetId}-dot`);
        const fleetText = document.getElementById(`${fleetId}-text`);
        if (fleetDot) fleetDot.style.background = online ? "#10b981" : "#ff6666";
        if (fleetText) { fleetText.innerText = online ? "Online" : "Offline"; fleetText.style.color = online ? "#10b981" : "#ff6666"; }
      }
    });

  } catch (err) {
    console.error("Error fetching heartbeats:", err);
  }
}

function writeWaybillConsole(text, type = "") {
  const consoleEl = document.getElementById("waybill-console");
  if (!consoleEl) return;
  const line = document.createElement("div");
  line.className = `terminal-line ${type}`;
  line.innerText = `[${new Date().toLocaleTimeString()}] ${text}`;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function pollWaybillJob(jobId, onComplete, onFailure) {
  const MAX_WAIT_MS = 5 * 60 * 1000; // 5-minute hard timeout
  const startTime = Date.now();
  let delay = 2000;
  let timeoutHandle = null;

  function schedule() {
    timeoutHandle = setTimeout(async () => {
      if (Date.now() - startTime > MAX_WAIT_MS) {
        onFailure("Job timed out after 5 minutes — check daemon status.");
        return;
      }
      try {
        const { data: job, error } = await supabaseClient
          .from("waybill_jobs")
          .select("status, result")
          .eq("id", jobId)
          .single();
        if (error) throw error;

        if (job.status === "completed") {
          onComplete(job.result);
        } else if (job.status === "failed") {
          onFailure(job.result?.error || "Unknown error during job execution");
        } else {
          // Still processing — back off up to 8s
          delay = Math.min(delay * 1.5, 8000);
          schedule();
        }
      } catch (err) {
        onFailure(err.message);
      }
    }, delay);
  }

  schedule();
}

// Catalog Add Items Dropdown Populate
async function populateProductsSelect() {
  if (!supabaseClient) return;
  try {
    const { data: products, error } = await supabaseClient
      .from("products")
      .select("id, brand_name, product_base_name, master_sku")
      .order("product_base_name", { ascending: true });
    if (error) throw error;
    const select = document.getElementById("catalog-select-product");
    if (select) {
      select.innerHTML = products.map(p => `
        <option value="${p.id}">${p.brand_name} - ${p.product_base_name} (${p.master_sku})</option>
      `).join("");
    }
  } catch (err) {
    console.error("Failed to fetch products:", err);
  }
}

// Catalog Modal Setup
let catalogModalActiveTab = "existing";
function setupCatalogModal() {
  const modal = document.getElementById("add-catalog-modal");
  const openBtn = document.getElementById("add-catalog-item-btn");
  const closeBtn = document.getElementById("add-catalog-close-btn");
  const cancelBtn = document.getElementById("add-catalog-cancel-btn");
  const saveBtn = document.getElementById("add-catalog-save-btn");

  const tabExisting = document.getElementById("modal-tab-existing-product");
  const tabNew = document.getElementById("modal-tab-new-product");
  
  const selectGroup = document.getElementById("group-select-product");
  const newGroup = document.getElementById("group-new-product-fields");

  if (!openBtn) return;

  openBtn.addEventListener("click", () => {
    populateProductsSelect();
    modal.classList.add("active");
  });

  const closeModal = () => {
    modal.classList.remove("active");
    document.getElementById("catalog-brand-name").value = "";
    document.getElementById("catalog-product-category").value = "";
    document.getElementById("catalog-master-sku").value = "";
    document.getElementById("catalog-product-base-name").value = "";
    document.getElementById("catalog-variant-sku").value = "";
    document.getElementById("catalog-variant-name").value = "";
    document.getElementById("catalog-sticker-url").value = "";
    document.getElementById("catalog-stock-quantity").value = "0";
  };

  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  tabExisting.addEventListener("click", () => {
    tabExisting.classList.add("active");
    tabNew.classList.remove("active");
    selectGroup.style.display = "block";
    newGroup.style.display = "none";
    catalogModalActiveTab = "existing";
  });

  tabNew.addEventListener("click", () => {
    tabNew.classList.add("active");
    tabExisting.classList.remove("active");
    newGroup.style.display = "flex";
    selectGroup.style.display = "none";
    catalogModalActiveTab = "new";
  });

  saveBtn.addEventListener("click", async () => {
    if (!supabaseClient) return;

    const variantSku = document.getElementById("catalog-variant-sku").value.trim();
    const variantName = document.getElementById("catalog-variant-name").value.trim();
    const variantType = document.getElementById("catalog-variant-type").value;
    const stickerUrl = document.getElementById("catalog-sticker-url").value.trim() || null;

    if (!variantSku || !variantName) {
      showToast("Please enter Variant SKU and Name.", "warning");
      return;
    }

    try {
      saveBtn.disabled = true;
      saveBtn.innerHTML = `<span class="material-symbols-outlined animate-spin" style="font-size:16px;vertical-align:middle;">progress_activity</span> Saving...`;

      let productId = null;

      if (catalogModalActiveTab === "new") {
        const brand = document.getElementById("catalog-brand-name").value.trim();
        const cat = document.getElementById("catalog-product-category").value.trim();
        const masterSku = document.getElementById("catalog-master-sku").value.trim();
        const baseName = document.getElementById("catalog-product-base-name").value.trim();

        if (!brand || !masterSku || !baseName) {
          showToast("Please fill in Brand Name, Master SKU, and Product Base Name.", "warning");
          saveBtn.disabled = false;
          saveBtn.innerHTML = "Add Product";
          return;
        }

        const { data: product, error: pError } = await supabaseClient
          .from("products")
          .insert({
            brand_name: brand,
            product_category: cat || null,
            master_sku: masterSku,
            product_base_name: baseName
          })
          .select("id")
          .single();

        if (pError) throw pError;
        productId = product.id;
      } else {
        productId = document.getElementById("catalog-select-product").value;
        if (!productId) {
          showToast("Please select a product.", "warning");
          saveBtn.disabled = false;
          saveBtn.innerHTML = "Add Product";
          return;
        }
      }

      const stockQty = parseInt(document.getElementById("catalog-stock-quantity").value) || 0;
      const { error: vError } = await supabaseClient
        .from("variants")
        .insert({
          product_id: productId,
          variant_sku: variantSku,
          variant_name: variantName,
          variant_type: variantType,
          seal_sticker_gdrive_url: stickerUrl,
          stock_quantity: stockQty
        });

      if (vError) throw vError;

      showToast("Variant added successfully.", "success");
      closeModal();
      cachedVariants = [];
      fetchAndRenderCatalog();
    } catch (err) {
      showToast("Failed to add catalog item: " + err.message, "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = "Add Product";
    }
  });
}

// Setup Waybills Tab Ingestion & Compilation
function setupWaybillProcessing() {
  const uploadZone = document.getElementById("waybill-upload-zone");
  const fileInput = document.getElementById("waybill-file-input");
  const browseBtn = document.getElementById("waybill-browse-btn");

  const overviewUploadZone = document.getElementById("overview-waybill-upload-zone");
  const overviewFileInput = document.getElementById("overview-waybill-file-input");
  const overviewBrowseBtn = document.getElementById("overview-waybill-browse-btn");

  const btnClearConsole = document.getElementById("console-clear-btn");
  const batchOutput = document.getElementById("batch-output-box");
  const batchDownload = document.getElementById("batch-download-link");

  const registerClick = (id1, id2, id3, callback) => {
    const b1 = document.getElementById(id1);
    const b2 = document.getElementById(id2);
    const b3 = document.getElementById(id3);
    if (b1) b1.addEventListener("click", callback);
    if (b2) b2.addEventListener("click", callback);
    if (b3) b3.addEventListener("click", callback);
  };

  const setButtonsDisabled = (id1, id2, id3, disabled) => {
    const b1 = document.getElementById(id1);
    const b2 = document.getElementById(id2);
    const b3 = document.getElementById(id3);
    if (b1) b1.disabled = disabled;
    if (b2) b2.disabled = disabled;
    if (b3) b3.disabled = disabled;
  };

  if (btnClearConsole) {
    btnClearConsole.addEventListener("click", () => {
      const consoleEl = document.getElementById("waybill-console");
      if (consoleEl) {
        consoleEl.innerHTML = `<div class="terminal-line">> Console cleared.</div>`;
      }
    });
  }

  // Setup main upload zone if it exists
  if (uploadZone && fileInput && browseBtn) {
    bindUploadEvents(uploadZone, fileInput, browseBtn, {
      uploadStatusId: "upload-status",
      progressTextId: "upload-status-text",
      progressPercentId: "upload-progress-percent",
      progressBarId: "upload-progress-bar"
    });
  }

  // Setup overview upload zone if it exists
  if (overviewUploadZone && overviewFileInput && overviewBrowseBtn) {
    bindUploadEvents(overviewUploadZone, overviewFileInput, overviewBrowseBtn, {
      uploadStatusId: "overview-upload-status",
      progressTextId: "overview-upload-status-text",
      progressPercentId: "overview-upload-progress-percent",
      progressBarId: "overview-upload-progress-bar"
    });
  }

  function bindUploadEvents(zone, input, btn, uiIds) {
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    });

    zone.addEventListener("dragleave", () => {
      zone.classList.remove("dragover");
    });

    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        handleWaybillFilesUpload(files, input, btn, uiIds);
      }
    });

    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      if (input.files.length > 0) {
        handleWaybillFilesUpload(input.files, input, btn, uiIds);
      }
    });
  }

  async function handleWaybillFilesUpload(files, input, btn, uiIds) {
    if (files.length === 0) return;
    
    if (input) input.disabled = true;
    if (btn) btn.disabled = true;
    
    writeWaybillConsole(`Starting upload batch of ${files.length} file(s)...`, "info");
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      writeWaybillConsole(`[Batch ${i+1}/${files.length}] Processing ${file.name}...`, "info");
      
      try {
        await handleSingleWaybillFileUpload(file, i + 1, files.length, uiIds);
      } catch (err) {
        writeWaybillConsole(`[Batch ${i+1}/${files.length}] Failed: ${err.message}`, "error");
      }
    }
    
    if (input) input.disabled = false;
    if (btn) btn.disabled = false;
    if (input) input.value = ""; // Reset file input to allow uploading same files again
    writeWaybillConsole("Batch processing completed.", "info");
  }

  async function handleSingleWaybillFileUpload(file, current, total, uiIds) {
    if (file.type !== "application/pdf") {
      writeWaybillConsole(`[${current}/${total}] Skip ${file.name}: Only PDF files are supported.`, "error");
      return;
    }

    if (!supabaseClient) {
      writeWaybillConsole(`[${current}/${total}] Skip ${file.name}: Supabase is not configured.`, "error");
      return;
    }

    const fileName = `${Date.now()}_${file.name.replace(/\s+/g, "_")}`;
    const uploadStatus = document.getElementById(uiIds.uploadStatusId);
    const progressText = document.getElementById(uiIds.progressTextId);
    const progressPercent = document.getElementById(uiIds.progressPercentId);
    const progressBar = document.getElementById(uiIds.progressBarId);

    if (uploadStatus) uploadStatus.style.display = "flex";
    if (progressText) progressText.innerText = `[${current}/${total}] Uploading ${file.name}...`;
    if (progressPercent) progressPercent.innerText = "0%";
    if (progressBar) progressBar.style.width = "0%";

    try {
      const { data, error } = await supabaseClient.storage
        .from("incoming-waybills")
        .upload(fileName, file, {
          cacheControl: "3600",
          upsert: false
        });

      if (error) throw error;

      if (progressPercent) progressPercent.innerText = "100%";
      if (progressBar) progressBar.style.width = "100%";
      if (progressText) progressText.innerText = `[${current}/${total}] PDF Uploaded! Queueing job...`;
      writeWaybillConsole(`[${current}/${total}] Uploaded successfully as '${fileName}'. Queueing job...`, "info");

      const { data: job, error: jobError } = await supabaseClient
        .from("waybill_jobs")
        .insert({
          job_type: "waybill_ingest",
          status: "pending",
          payload: { file_name: fileName }
        })
        .select()
        .single();

      if (jobError) throw jobError;

      writeWaybillConsole(`[${current}/${total}] Job ${job.id} queued. Polling daemon status...`, "info");
      
      return new Promise((resolve, reject) => {
        pollWaybillJob(job.id, 
          (result) => {
            if (uploadStatus) uploadStatus.style.display = "none";
            writeWaybillConsole(`[${current}/${total}] [SUCCESS] Waybill Ingestion complete!`, "info");
            fetchSummaryStats();
            if (currentTab === "orders") fetchAndRenderOrders();
            if (currentTab === "orders") fetchAndRenderWaybillsArchive();
            resolve();
          },
          (errMsg) => {
            if (uploadStatus) uploadStatus.style.display = "none";
            writeWaybillConsole(`[${current}/${total}] [ERROR] Waybill Ingestion failed: ${errMsg}`, "error");
            reject(new Error(errMsg));
          }
        );
      });

    } catch (err) {
      if (uploadStatus) uploadStatus.style.display = "none";
      writeWaybillConsole(`[${current}/${total}] Upload failed: ${err.message}`, "error");
      throw err;
    }
  }

  registerClick("ctrl-trigger-scout", "waybill-ctrl-trigger-scout", "overview-ctrl-trigger-scout", async () => {
    if (!supabaseClient) return;
    writeWaybillConsole("Queueing Scout Gmail scan job...", "info");
    setButtonsDisabled("ctrl-trigger-scout", "waybill-ctrl-trigger-scout", "overview-ctrl-trigger-scout", true);
    try {
      const { data: job, error } = await supabaseClient
        .from("waybill_jobs")
        .insert({
          job_type: "scout_gmail_scan",
          status: "pending"
        })
        .select()
        .single();
      if (error) throw error;
      writeWaybillConsole(`Scout job ${job.id} queued. Polling daemon status...`, "info");
      
      // Instantly update Overview queue if active
      if (currentTab === "overview") fetchAndRenderOverviewJobs();
      
      pollWaybillJob(job.id,
        () => {
          setButtonsDisabled("ctrl-trigger-scout", "waybill-ctrl-trigger-scout", "overview-ctrl-trigger-scout", false);
          writeWaybillConsole(`[SUCCESS] Scout Gmail scan completed.`, "info");
          fetchSummaryStats();
          if (currentTab === "orders") fetchAndRenderOrders();
          if (currentTab === "operations") fetchAndRenderJobs();
          if (currentTab === "orders") fetchAndRenderWaybillsArchive();
          if (currentTab === "overview") {
            fetchAndRenderOverviewJobs();
            fetchAndRenderOverviewLogs();
          }
        },
        (errMsg) => {
          setButtonsDisabled("ctrl-trigger-scout", "waybill-ctrl-trigger-scout", "overview-ctrl-trigger-scout", false);
          writeWaybillConsole(`[ERROR] Scout scan failed: ${errMsg}`, "error");
          if (currentTab === "operations") fetchAndRenderJobs();
          if (currentTab === "overview") {
            fetchAndRenderOverviewJobs();
            fetchAndRenderOverviewLogs();
          }
        }
      );
    } catch (err) {
      setButtonsDisabled("ctrl-trigger-scout", "waybill-ctrl-trigger-scout", "overview-ctrl-trigger-scout", false);
      writeWaybillConsole(`Scout dispatch failed: ${err.message}`, "error");
    }
  });

  registerClick("ctrl-trigger-foreman", "waybill-ctrl-trigger-foreman", "overview-ctrl-trigger-foreman", async () => {
    if (!supabaseClient) return;
    writeWaybillConsole("Triggering Foreman Print Dispatch...", "info");
    setButtonsDisabled("ctrl-trigger-foreman", "waybill-ctrl-trigger-foreman", "overview-ctrl-trigger-foreman", true);

    // Instantly update Overview queue if active
    if (currentTab === "overview") fetchAndRenderOverviewJobs();

    try {
      const spDispatch = isSpDispatchEnabled();
      if (!spDispatch) writeWaybillConsole("[DRY RUN] SimplyPrint dispatch is disabled — files will be processed but not sent to printers.", "warning");
      const response = await backendFetch(`/foreman/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: !spDispatch })
      });
      const rawText2 = await response.text();
      let resData;
      try { resData = JSON.parse(rawText2); } catch { throw new Error(`Backend error (HTTP ${response.status}): ${rawText2.substring(0, 120)}`); }
      if (!response.ok) throw new Error(resData.detail || resData.error || `HTTP ${response.status}`);

      writeWaybillConsole(`[SUCCESS] Foreman response: ${JSON.stringify(resData.status || resData)}`, "info");
      logAction(`Foreman dispatch triggered manually`, "info", { dispatched: resData.files_dispatched, processed: resData.processed_items_count });
      setTimeout(() => {
        fetchSummaryStats();
        if (currentTab === "orders") fetchAndRenderWaybillsArchive();
        if (currentTab === "overview") {
          fetchAndRenderOverviewJobs();
          fetchAndRenderOverviewLogs();
        }
      }, 1000);
    } catch (err) {
      writeWaybillConsole(`[ERROR] Foreman execution failed: ${err.message}`, "error");
      if (currentTab === "overview") {
        fetchAndRenderOverviewJobs();
        fetchAndRenderOverviewLogs();
      }
    } finally {
      setButtonsDisabled("ctrl-trigger-foreman", "waybill-ctrl-trigger-foreman", "overview-ctrl-trigger-foreman", false);
    }
  });

  registerClick("ctrl-trigger-compile", "waybill-ctrl-trigger-compile", "overview-ctrl-trigger-compile", async () => {
    if (!supabaseClient) return;
    writeWaybillConsole("Queueing Batch PDF Compilation job...", "info");
    setButtonsDisabled("ctrl-trigger-compile", "waybill-ctrl-trigger-compile", "overview-ctrl-trigger-compile", true);
    batchOutput.style.display = "none";
    try {
      const { data: job, error } = await supabaseClient
        .from("waybill_jobs")
        .insert({
          job_type: "waybill_batch_print",
          status: "pending"
        })
        .select()
        .single();
      if (error) throw error;
      writeWaybillConsole(`Batch job ${job.id} queued. Stitching waybills and stickers...`, "info");
      
      // Instantly update Overview queue if active
      if (currentTab === "overview") fetchAndRenderOverviewJobs();

      pollWaybillJob(job.id,
        (result) => {
          setButtonsDisabled("ctrl-trigger-compile", "waybill-ctrl-trigger-compile", "overview-ctrl-trigger-compile", false);
          writeWaybillConsole(`[SUCCESS] Master print batch compiled successfully.`, "info");
          if (result && result.url) {
            batchOutput.style.display = "flex";
            batchDownload.href = result.url;
            writeWaybillConsole(`Download Link: ${result.url}`, "info");
          }
          fetchSummaryStats();
          if (currentTab === "orders") fetchAndRenderOrders();
          if (currentTab === "operations") fetchAndRenderJobs();
          if (currentTab === "orders") {
            fetchAndRenderMasterPDFs();
            // Old #waybill-tab-pdfs panel is gone — expand the Waybill Tools
            // drawer so the freshly compiled PDF is visible.
            const drawerBody = document.querySelector(".waybill-tools-body");
            if (drawerBody && drawerBody.classList.contains("hidden")) {
              document.getElementById("waybill-tools-toggle")?.click();
            }
          }
          if (currentTab === "overview") {
            fetchAndRenderOverviewJobs();
            fetchAndRenderOverviewLogs();
          }
        },
        (errMsg) => {
          setButtonsDisabled("ctrl-trigger-compile", "waybill-ctrl-trigger-compile", "overview-ctrl-trigger-compile", false);
          writeWaybillConsole(`[ERROR] Batch compilation failed: ${errMsg}`, "error");
          if (currentTab === "operations") fetchAndRenderJobs();
          if (currentTab === "overview") {
            fetchAndRenderOverviewJobs();
            fetchAndRenderOverviewLogs();
          }
        }
      );
    } catch (err) {
      setButtonsDisabled("ctrl-trigger-compile", "waybill-ctrl-trigger-compile", "overview-ctrl-trigger-compile", false);
      writeWaybillConsole(`Batch compilation dispatch failed: ${err.message}`, "error");
    }
  });
}

// Fetch and Render Job Queue
async function fetchAndRenderJobs() {
  if (!supabaseClient) return;
  const tbody = document.getElementById("jobs-tbody");
  if (!tbody) return;

  tbody.innerHTML = loadingRow(6);

  const searchInput = document.getElementById("jobs-search-input");
  const statusSelect = document.getElementById("jobs-filter-status");
  const typeSelect = document.getElementById("jobs-filter-type");

  const searchVal = jobsSearchQuery ? jobsSearchQuery.toLowerCase().trim() : (searchInput ? searchInput.value.toLowerCase().trim() : "");
  const statusVal = statusSelect ? statusSelect.value : "all";
  const typeVal = typeSelect ? typeSelect.value : "all";

  try {
    const { data: jobs, error } = await supabaseClient
      .from("waybill_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    let filtered = jobs || [];

    // Apply Status filter
    if (statusVal !== "all") {
      filtered = filtered.filter(j => j.status === statusVal);
    }

    // Apply Job Type filter
    if (typeVal !== "all") {
      filtered = filtered.filter(j => j.job_type === typeVal);
    }

    // Apply Text search filter
    if (searchVal) {
      filtered = filtered.filter(j => {
        const idMatch = j.id.toLowerCase().includes(searchVal);
        const typeMatch = j.job_type.toLowerCase().includes(searchVal);
        const payloadMatch = j.payload ? JSON.stringify(j.payload).toLowerCase().includes(searchVal) : false;
        const resultMatch = j.result ? JSON.stringify(j.result).toLowerCase().includes(searchVal) : false;
        return idMatch || typeMatch || payloadMatch || resultMatch;
      });
    }

    if (filtered.length === 0) {
      tbody.innerHTML = emptyRow("No jobs found matching filters.", "history_toggle_off", 6);
      return;
    }

    tbody.innerHTML = filtered.map(j => {
      const dateStr = new Date(j.created_at).toLocaleString();
      let statusClass = "completed";
      if (j.status === "pending") statusClass = "pending";
      else if (j.status === "processing") statusClass = "printing";
      else if (j.status === "failed") statusClass = "hold";

      let payloadStr = j.payload ? JSON.stringify(j.payload) : "-";
      let resultStr = "-";
      if (j.result) {
        if (j.result.error) {
          resultStr = `<span style="color: var(--error-color); font-weight: 500;">Error: ${escapeHtml(j.result.error)}</span>`;
        } else if (j.result.url) {
          resultStr = `<a href="${escapeHtml(sanitizeUrl(j.result.url))}" target="_blank" class="px-2 py-1 bg-primary/10 hover:bg-primary/20 text-[#3ecf8e] rounded border border-primary/30 transition-all duration-150 inline-flex items-center gap-1.5 select-none no-underline text-[10px] font-semibold"><span class="material-symbols-outlined text-[12px] select-none">download</span> Download Batch</a>`;
        } else {
          resultStr = escapeHtml(JSON.stringify(j.result));
        }
      }
      const safePayloadStr = escapeHtml(payloadStr);

      return `
        <tr class="group transition-all duration-150">
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-l border-outline-variant/15 rounded-l-lg font-data-mono text-xs text-on-surface select-all" title="${escapeHtml(j.id)}">${escapeHtml(j.id.substring(0, 8))}...</td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15"><span class="badge secondary text-[10px] py-0.5 px-2 bg-white/5 uppercase select-none">${escapeHtml(j.job_type)}</span></td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15"><span class="badge ${statusClass} text-[10px] py-0.5 px-2 uppercase select-none">${escapeHtml(j.status)}</span></td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15 font-data-mono text-xs max-w-[150px] truncate text-on-surface-variant/70 select-all" title='${safePayloadStr}'>${safePayloadStr}</td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15 text-xs text-on-surface-variant/80 select-all">${resultStr}</td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-r border-outline-variant/15 rounded-r-lg font-data-mono text-xs text-on-surface-variant/60">${dateStr}</td>
        </tr>
      `;
    }).join("");

  } catch (err) {
    tbody.innerHTML = emptyRow(`Error loading jobs: ${escapeHtml(err.message)}`, "error", 6);
  }
}

// Setup Agent Controls (Sync, Purge, Filter Triggers)
function setupAgentControls() {
  const btnSync1 = document.getElementById("ctrl-trigger-sync-simplyprint");
  const btnSync3 = document.getElementById("overview-ctrl-trigger-sync-simplyprint");
  const btnPurge = document.getElementById("ctrl-purge-jobs");

  // Filter bindings
  const jobsSearch = document.getElementById("jobs-search-input");
  const jobsStatus = document.getElementById("jobs-filter-status");
  const jobsType = document.getElementById("jobs-filter-type");

  if (jobsSearch) {
    jobsSearch.addEventListener("input", (e) => {
      jobsSearchQuery = e.target.value.trim();
      fetchAndRenderJobs();
    });
  }
  if (jobsStatus) jobsStatus.addEventListener("change", () => fetchAndRenderJobs());
  if (jobsType) jobsType.addEventListener("change", () => fetchAndRenderJobs());

  const registerSyncClick = (btn) => {
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (!supabaseClient) return;
      writeWaybillConsole("Queueing SimplyPrint mappings sync job...", "info");
      if (btnSync1) btnSync1.disabled = true;
      if (btnSync3) btnSync3.disabled = true;
      
      // Instantly update Overview queue if active
      if (currentTab === "overview") fetchAndRenderOverviewJobs();

      try {
        const { data: job, error } = await supabaseClient
          .from("waybill_jobs")
          .insert({
            job_type: "sync_simplyprint_ids",
            status: "pending"
          })
          .select()
          .single();
        if (error) throw error;
        writeWaybillConsole(`Sync job ${job.id} queued. Polling daemon status...`, "info");
        pollWaybillJob(job.id,
          () => {
            if (btnSync1) btnSync1.disabled = false;
            if (btnSync3) btnSync3.disabled = false;
            writeWaybillConsole(`[SUCCESS] SimplyPrint mapping sync completed.`, "info");
            if (currentTab === "operations") fetchAndRenderJobs();
            if (currentTab === "overview") {
              fetchAndRenderOverviewJobs();
              fetchAndRenderOverviewLogs();
            }
          },
          (errMsg) => {
            if (btnSync1) btnSync1.disabled = false;
            if (btnSync3) btnSync3.disabled = false;
            writeWaybillConsole(`[ERROR] Sync failed: ${errMsg}`, "error");
            if (currentTab === "operations") fetchAndRenderJobs();
            if (currentTab === "overview") {
              fetchAndRenderOverviewJobs();
              fetchAndRenderOverviewLogs();
            }
          }
        );
      } catch (err) {
        if (btnSync1) btnSync1.disabled = false;
        if (btnSync3) btnSync3.disabled = false;
        writeWaybillConsole(`Sync dispatch failed: ${err.message}`, "error");
      }
    });
  };

  registerSyncClick(btnSync1);
  registerSyncClick(btnSync3);

  if (btnPurge) {
    btnPurge.addEventListener("click", async () => {
      if (!supabaseClient) return;
      if (!await showConfirmModal("Purge Job Queue", "Are you sure you want to cancel all pending/processing jobs and clear the job queue?", "Purge")) return;
      try {
        btnPurge.disabled = true;
        const { error } = await supabaseClient
          .from("waybill_jobs")
          .delete()
          .neq("status", "completed");
        if (error) throw error;
        showToast("Job queue cleared.", "success");
        fetchAndRenderJobs();
      } catch (err) {
        showToast("Failed to purge job queue: " + err.message, "error");
      } finally {
        btnPurge.disabled = false;
      }
    });
  }
}

// Fetch and Render Recent Activity (Overview Home page - unified Jobs & Logs)
async function fetchAndRenderOverviewJobs() {
  if (!supabaseClient) return;
  const tbody = document.getElementById("overview-jobs-tbody");
  if (!tbody) return;

  try {
    // Jobs and logs are independent queries — fetch concurrently instead of
    // sequentially (the second await previously only started after the first
    // resolved even though neither depends on the other).
    const [
      { data: jobs, error: jError },
      { data: logs, error: lError },
    ] = await Promise.all([
      supabaseClient.from("waybill_jobs").select("*").order("created_at", { ascending: false }).limit(10),
      supabaseClient.from("system_logs").select("*").order("created_at", { ascending: false }).limit(10),
    ]);

    if (jError) throw jError;
    if (lError) throw lError;

    const combined = [];
    if (jobs) {
      jobs.forEach(j => {
        combined.push({
          type: "job",
          created_at: j.created_at,
          source: `Job: ${j.job_type}`,
          badgeText: j.status,
          badgeClass: j.status === "pending" ? "pending" : (j.status === "processing" ? "printing" : (j.status === "failed" ? "hold" : "completed")),
          detail: j.result && j.result.error
            ? `Failed: ${escapeHtml(j.result.error)}`
            : (j.result && j.result.url ? `Batch compiled. <a href="${escapeHtml(sanitizeUrl(j.result.url))}" target="_blank" class="text-primary hover:underline font-bold">Download</a>` : `Job ${escapeHtml(j.status)}.`)
        });
      });
    }
    if (logs) {
      logs.forEach(l => {
        const lvl = l.log_level.toLowerCase();
        combined.push({
          type: "log",
          created_at: l.created_at,
          source: l.agent_name,
          badgeText: l.log_level,
          badgeClass: lvl === "error" || lvl === "failed" ? "hold" : (lvl === "warning" ? "pending" : "completed"),
          detail: escapeHtml(l.log_message)
        });
      });
    }

    // Sort descending by timestamp
    combined.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Limit to top 10 display items
    const displayItems = combined.slice(0, 10);

    if (displayItems.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">No recent activity.</td></tr>`;
      return;
    }

    tbody.innerHTML = displayItems.map(item => {
      const dateStr = new Date(item.created_at).toLocaleString();
      return `
        <tr class="group transition-all duration-150">
          <td class="py-2 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-l border-outline-variant/15 rounded-l-lg font-data-mono text-[11px] text-on-surface-variant/70">${dateStr}</td>
          <td class="py-2 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15 font-semibold text-on-surface">${escapeHtml(item.source)}</td>
          <td class="py-2 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15"><span class="badge ${item.badgeClass} text-[9px] py-0.5 px-2 uppercase select-none">${escapeHtml(item.badgeText)}</span></td>
          <td class="py-2 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-r border-outline-variant/15 rounded-r-lg text-on-surface-variant/80 text-[11px] max-w-[280px] truncate select-all" title="${escapeHtml(item.detail)}">${item.detail}</td>
        </tr>
      `;
    }).join("");

  } catch (err) {
    console.error("Error fetching overview activity:", err);
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--error-color); padding: 2rem;">Error loading activity: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// Dummy function to prevent errors from other components calling it
async function fetchAndRenderOverviewLogs() {
  // Integrated into fetchAndRenderOverviewJobs
}

// ==========================================================================
// Mission Control (Aurora 3.0): hand-rolled SVG analytics + attention feed.
// No chart library — inline SVG keeps the no-build vanilla stack.
// ==========================================================================

function chartPalette(i) {
  return ["#3ecf8e", "#7ea6e8", "#3ecf8e", "#fbbf24", "#ff6666", "#22d3ee"][i % 6];
}

function localDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Last-N-days buckets: returns { keys: ["2026-06-04",...], counts: Map }
function dayBuckets(n) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    keys.push(localDayKey(new Date(Date.now() - i * 86400000)));
  }
  return keys;
}

function svgSparkline(values, { color = "#ff8c00" } = {}) {
  if (!values.length) return "";
  const w = 140, h = 34;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${((i / Math.max(values.length - 1, 1)) * w).toFixed(1)},${(h - (v / max) * (h - 6) - 2).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:100%;display:block;">
    <polygon points="0,${h} ${pts} ${w},${h}" fill="${color}" opacity="0.10"></polygon>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.7"></polyline>
  </svg>`;
}

function svgBarChart(values, labels, { color = "#3ecf8e" } = {}) {
  const w = 600, h = 170, padB = 18, padT = 10, padL = 26, padR = 6;
  const max = Math.max(...values, 1);
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const bw = innerW / values.length;
  const grid = [0.5, 1].map(f => {
    const y = padT + innerH - innerH * f;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 4"></line>
      <text x="${padL - 5}" y="${(y + 3).toFixed(1)}" font-size="8" fill="rgba(255,255,255,0.3)" text-anchor="end" font-family="IBM Plex Mono, monospace">${Math.round(max * f)}</text>`;
  }).join("");
  const bars = values.map((v, i) => {
    const bh = (v / max) * innerH;
    const x = padL + i * bw + bw * 0.15;
    const y = padT + innerH - bh;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(bh, v > 0 ? 2 : 0).toFixed(1)}" rx="2" fill="${color}" opacity="${v > 0 ? 0.85 : 0.15}"><title>${labels[i]}: ${v}</title></rect>`;
  }).join("");
  const xLabels = values.map((_, i) => (i % 6 === 0 || i === values.length - 1)
    ? `<text x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${h - 4}" font-size="8" fill="rgba(255,255,255,0.35)" text-anchor="middle" font-family="IBM Plex Mono, monospace">${labels[i].slice(5)}</text>`
    : "").join("");
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%;display:block;">${grid}${bars}${xLabels}</svg>`;
}

function svgLineChart(values, labels, { color = "#22d3ee" } = {}) {
  const w = 420, h = 170, padB = 18, padT = 10, padL = 26, padR = 8;
  const max = Math.max(...values, 1);
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const px = i => padL + (i / Math.max(values.length - 1, 1)) * innerW;
  const py = v => padT + innerH - (v / max) * innerH;
  const pts = values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const grid = [0.5, 1].map(f => {
    const y = padT + innerH - innerH * f;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 4"></line>
      <text x="${padL - 5}" y="${(y + 3).toFixed(1)}" font-size="8" fill="rgba(255,255,255,0.3)" text-anchor="end" font-family="IBM Plex Mono, monospace">${Math.round(max * f)}</text>`;
  }).join("");
  const dots = values.map((v, i) => v > 0 ? `<circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="2" fill="${color}"><title>${labels[i]}: ${v}</title></circle>` : "").join("");
  const xLabels = values.map((_, i) => (i % 6 === 0 || i === values.length - 1)
    ? `<text x="${px(i).toFixed(1)}" y="${h - 4}" font-size="8" fill="rgba(255,255,255,0.35)" text-anchor="middle" font-family="IBM Plex Mono, monospace">${labels[i].slice(5)}</text>`
    : "").join("");
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%;display:block;">
    ${grid}
    <polygon points="${padL},${(padT + innerH).toFixed(1)} ${pts} ${(padL + innerW).toFixed(1)},${(padT + innerH).toFixed(1)}" fill="${color}" opacity="0.08"></polygon>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"></polyline>
    ${dots}${xLabels}
  </svg>`;
}

function svgDonut(segments) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0) return emptyDiv("No orders in the last 30 days.", "donut_small");
  const R = 44, C = 2 * Math.PI * R;
  let acc = 0;
  const rings = segments.map(s => {
    const frac = s.value / total;
    const ring = `<circle r="${R}" cx="60" cy="60" fill="none" stroke="${s.color}" stroke-width="14" stroke-dasharray="${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}" stroke-dashoffset="${(-acc * C).toFixed(2)}" transform="rotate(-90 60 60)" opacity="0.9"><title>${escapeHtml(s.label)}: ${s.value}</title></circle>`;
    acc += frac;
    return ring;
  }).join("");
  const legend = segments.map(s => `<div style="display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-secondary);"><span style="width:8px;height:8px;border-radius:50%;background:${s.color};flex-shrink:0;"></span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.label)}</span><span style="font-family:var(--font-mono);color:var(--text-muted);">${s.value}</span></div>`).join("");
  return `<div style="display:flex;align-items:center;gap:14px;height:100%;">
    <svg viewBox="0 0 120 120" style="width:120px;height:120px;flex-shrink:0;">${rings}
      <text x="60" y="57" text-anchor="middle" font-size="20" font-weight="700" fill="#f2f3f7" font-family="IBM Plex Mono, monospace">${total}</text>
      <text x="60" y="72" text-anchor="middle" font-size="8" fill="rgba(255,255,255,0.4)" font-family="IBM Plex Mono, monospace">ORDERS</text>
    </svg>
    <div style="display:flex;flex-direction:column;gap:5px;min-width:0;flex:1;">${legend}</div>
  </div>`;
}

function navigateToTab(tab) {
  document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.click();
}

async function fetchAndRenderMissionControl() {
  if (!supabaseClient) return;
  const barsEl = document.getElementById("chart-orders-daily");
  const donutEl = document.getElementById("chart-platform-donut");
  const lineEl = document.getElementById("chart-throughput");
  // The KPI sparkline lives on Overview even when the three big charts don't
  // (charts moved to the Logs pane) — keep fetching if either is mounted.
  if (!barsEl && !donutEl && !lineEl && !document.getElementById("spark-orders")) return;

  try {
    const sinceIso = new Date(Date.now() - 30 * 86400000).toISOString();
    const [ordersRes, jobsRes] = await Promise.all([
      supabaseClient.from("orders").select("order_timestamp, created_at, sales_platform, shop_id").gte("created_at", sinceIso),
      supabaseClient.from("print_jobs").select("created_at, job_execution_status").gte("created_at", sinceIso),
    ]);

    const orders = (ordersRes.data || []).filter(o => passesShopScope(o.shop_id));
    const jobs = jobsRes.data || [];

    const keys = dayBuckets(30);
    const orderCounts = Object.fromEntries(keys.map(k => [k, 0]));
    orders.forEach(o => {
      const k = localDayKey(new Date(o.order_timestamp || o.created_at));
      if (k in orderCounts) orderCounts[k]++;
    });
    const orderSeries = keys.map(k => orderCounts[k]);
    if (barsEl) barsEl.innerHTML = svgBarChart(orderSeries, keys, { color: "#3ecf8e" });

    const sparkEl = document.getElementById("spark-orders");
    if (sparkEl) sparkEl.innerHTML = svgSparkline(orderSeries.slice(-14), { color: "#ff8c00" });

    const platCounts = {};
    orders.forEach(o => {
      const plat = (o.sales_platform || "Unknown").trim() || "Unknown";
      platCounts[plat] = (platCounts[plat] || 0) + 1;
    });
    const segments = Object.entries(platCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label, value, color: chartPalette(i) }));
    if (donutEl) donutEl.innerHTML = svgDonut(segments);

    const jobCounts = Object.fromEntries(keys.map(k => [k, 0]));
    jobs.forEach(j => {
      if ((j.job_execution_status || "").toLowerCase() !== "completed") return;
      const k = localDayKey(new Date(j.created_at));
      if (k in jobCounts) jobCounts[k]++;
    });
    if (lineEl) lineEl.innerHTML = svgLineChart(keys.map(k => jobCounts[k]), keys, { color: "#22d3ee" });

    markFresh("analytics");
  } catch (err) {
    console.error("Mission Control fetch failed:", err);
  }
}

// Fetch and Render Waybills Archive
async function fetchAndRenderWaybillsArchive() {
  if (!supabaseClient) return;
  const tbody = document.getElementById("waybills-tbody");
  if (!tbody) return;

  tbody.innerHTML = loadingRow(6);

  try {
    let query = supabaseClient
      .from("orders")
      .select("id, platform_order_id, customer_name, raw_waybill_gdrive_url, processed_waybill_gdrive_url, waybill_processing_status, order_timestamp, created_at")
      .order("created_at", { ascending: false })
      .limit(200);

    if (activeWaybillFilter !== "all") {
      query = query.eq("waybill_processing_status", activeWaybillFilter);
    }

    // Push date range into the DB query so the 200-row limit doesn't mask results
    if (waybillsStartDate) {
      query = query.gte("order_timestamp", waybillsStartDate);
    }
    if (waybillsEndDate) {
      // Add one day so the end date is inclusive
      const endInclusive = new Date(waybillsEndDate);
      endInclusive.setDate(endInclusive.getDate() + 1);
      query = query.lt("order_timestamp", endInclusive.toISOString().split("T")[0]);
    }
    query = scopeByShop(query);

    const { data: orders, error } = await query;
    if (error) throw error;

    let filtered = orders || [];

    if (waybillSearchQuery) {
      const q = waybillSearchQuery.toLowerCase();
      filtered = filtered.filter(o => 
        (o.platform_order_id || "").toLowerCase().includes(q) ||
        (o.customer_name || "").toLowerCase().includes(q)
      );
    }

    // Apply date sorting
    filtered.sort((a, b) => {
      const dateA = new Date(a.order_timestamp || a.created_at || 0);
      const dateB = new Date(b.order_timestamp || b.created_at || 0);
      return waybillsDateSortDirection === "asc" ? dateA - dateB : dateB - dateA;
    });

    cachedFilteredWaybills = filtered;

    if (filtered.length === 0) {
      tbody.innerHTML = emptyRow("No waybills found matching query.", "local_shipping", 6);
      return;
    }

    tbody.innerHTML = filtered.map(order => {
      const dateStr = order.order_timestamp 
        ? new Date(order.order_timestamp).toLocaleString() 
        : new Date(order.created_at).toLocaleString();
      let statusClass = "pending";
      const statusLower = (order.waybill_processing_status || "pending").toLowerCase();
      
      if (statusLower === "ready" || statusLower === "ready to print") statusClass = "completed";
      else if (statusLower === "printed") statusClass = "printing";
      else if (statusLower === "pending") statusClass = "pending";
      else if (statusLower === "on hold" || statusLower === "hold" || statusLower === "failed") statusClass = "hold";

      const rawBtn = order.raw_waybill_gdrive_url
        ? `<a href="${escapeHtml(sanitizeUrl(order.raw_waybill_gdrive_url))}" target="_blank" class="px-2.5 py-1.5 rounded btn-archive-raw text-xs font-semibold transition-all duration-150 inline-flex items-center gap-1.5 select-none no-underline"><span class="material-symbols-outlined text-sm select-none">download</span> Download</a>`
        : `<span class="text-on-surface-variant/40 font-data-mono text-xs select-none">-</span>`;

      const processedBtn = order.processed_waybill_gdrive_url
        ? `<a href="${escapeHtml(sanitizeUrl(order.processed_waybill_gdrive_url))}" target="_blank" class="px-2.5 py-1.5 rounded btn-archive-processed text-xs font-bold transition-all duration-150 inline-flex items-center gap-1.5 select-none no-underline"><span class="material-symbols-outlined text-sm select-none">download</span> Download</a>`
        : `<span class="text-on-surface-variant/40 font-data-mono text-xs select-none">-</span>`;

      const selectHtml = `
        <select class="badge ${statusClass} status-select" data-order-id="${order.id}" style="text-transform: capitalize;">
          <option value="pending" ${statusLower === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="ready" ${statusLower === 'ready' || statusLower === 'ready to print' ? 'selected' : ''}>Ready</option>
          <option value="on hold" ${statusLower === 'on hold' || statusLower === 'hold' ? 'selected' : ''}>On Hold</option>
          <option value="failed" ${statusLower === 'failed' ? 'selected' : ''}>Failed</option>
          <option value="printed" ${statusLower === 'printed' ? 'selected' : ''}>Printed</option>
          <option value="compiled" ${statusLower === 'compiled' ? 'selected' : ''}>Compiled</option>
        </select>
      `;

      return `
        <tr class="group transition-all duration-150">
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-l border-outline-variant/15 rounded-l-lg font-data-mono text-xs text-on-surface font-semibold select-all">${escapeHtml(order.platform_order_id)}</td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15 text-sm text-on-surface font-medium">${escapeHtml(order.customer_name) || 'N/A'}</td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15">${selectHtml}</td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15">${rawBtn}</td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15">${processedBtn}</td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-r border-outline-variant/15 rounded-r-lg font-data-mono text-xs text-on-surface-variant/60">${dateStr}</td>
        </tr>
      `;
    }).join("");

    // Bind change listeners to status selectors
    tbody.querySelectorAll(".status-select").forEach(select => {
      select.addEventListener("change", async (e) => {
        const orderId = select.getAttribute("data-order-id");
        const newStatus = e.target.value;
        
        try {
          select.disabled = true;
          const { error } = await supabaseClient
            .from("orders")
            .update({ waybill_processing_status: newStatus })
            .eq("id", orderId);
          if (error) throw error;
          
          writeWaybillConsole(`Updated order status to '${newStatus}'.`, "info");
          fetchSummaryStats();
          if (currentTab === "orders") fetchAndRenderOrders();
          fetchAndRenderWaybillsArchive();
        } catch (err) {
          writeWaybillConsole(`Failed to update status: ${err.message}`, "error");
          showToast("Error updating status: " + err.message, "error");
          fetchAndRenderWaybillsArchive(); // Refresh to restore old value
        } finally {
          select.disabled = false;
        }
      });
    });

    // Update sort icon rotation
    const sortIcon = document.getElementById("waybill-sort-icon");
    if (sortIcon) {
      sortIcon.style.transform = waybillsDateSortDirection === "asc" ? "rotate(180deg)" : "rotate(0deg)";
    }

  } catch (err) {
    tbody.innerHTML = emptyRow(`Error loading waybills: ${escapeHtml(err.message)}`, "error", 6);
  }
}

function setupWaybillFilters() {
  const filterBox = document.getElementById("waybill-filters");
  const searchInput = document.getElementById("waybill-search-input");
  const dateStart = document.getElementById("waybills-date-start");
  const dateEnd = document.getElementById("waybills-date-end");
  const clearDateBtn = document.getElementById("waybills-clear-date-btn");

  const updateClearDateBtnVisibility = () => {
    if (clearDateBtn) {
      if (waybillsStartDate || waybillsEndDate) {
        clearDateBtn.classList.remove("hidden");
      } else {
        clearDateBtn.classList.add("hidden");
      }
    }
  };

  if (filterBox) {
    filterBox.querySelectorAll(".filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        filterBox.querySelectorAll(".filter-btn").forEach(b => {
          b.classList.remove("active", "bg-primary/10", "text-primary");
          b.classList.add("text-on-surface-variant", "hover:bg-surface-container-high");
        });
        btn.classList.add("active", "bg-primary/10", "text-primary");
        btn.classList.remove("text-on-surface-variant", "hover:bg-surface-container-high");
        activeWaybillFilter = btn.getAttribute("data-status");
        fetchAndRenderWaybillsArchive();
      });
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", debounce((e) => {
      waybillSearchQuery = e.target.value.trim();
      fetchAndRenderWaybillsArchive();
    }, 250));
  }

  if (dateStart) {
    dateStart.addEventListener("change", (e) => {
      waybillsStartDate = e.target.value;
      updateClearDateBtnVisibility();
      fetchAndRenderWaybillsArchive();
    });
  }

  if (dateEnd) {
    dateEnd.addEventListener("change", (e) => {
      waybillsEndDate = e.target.value;
      updateClearDateBtnVisibility();
      fetchAndRenderWaybillsArchive();
    });
  }

  if (clearDateBtn) {
    clearDateBtn.addEventListener("click", () => {
      waybillsStartDate = "";
      waybillsEndDate = "";
      if (dateStart) dateStart.value = "";
      if (dateEnd) dateEnd.value = "";
      clearDateBtn.classList.add("hidden");
      fetchAndRenderWaybillsArchive();
    });
  }

  const sortDateCol = document.getElementById("waybill-sort-date-col");
  if (sortDateCol) {
    sortDateCol.addEventListener("click", () => {
      waybillsDateSortDirection = waybillsDateSortDirection === "asc" ? "desc" : "asc";
      fetchAndRenderWaybillsArchive();
    });
  }

  const waybillSortDateBtn = document.getElementById("waybills-sort-date-btn");
  const waybillSortDateBtnIcon = document.getElementById("waybills-sort-date-icon");
  if (waybillSortDateBtn) {
    waybillSortDateBtn.addEventListener("click", () => {
      waybillsDateSortDirection = waybillsDateSortDirection === "asc" ? "desc" : "asc";
      const colIcon = document.getElementById("waybill-sort-icon");
      if (colIcon) colIcon.style.transform = waybillsDateSortDirection === "asc" ? "rotate(180deg)" : "rotate(0deg)";
      if (waybillSortDateBtnIcon) waybillSortDateBtnIcon.style.transform = waybillsDateSortDirection === "asc" ? "rotate(180deg)" : "rotate(0deg)";
      fetchAndRenderWaybillsArchive();
    });
  }

  const massEditSelect = document.getElementById("waybills-mass-edit-select");
  if (massEditSelect) {
    massEditSelect.addEventListener("change", async (e) => {
      const newStatus = e.target.value;
      if (!newStatus || cachedFilteredWaybills.length === 0) {
        massEditSelect.value = "";
        return;
      }

      const count = cachedFilteredWaybills.length;
      const confirmed = await showConfirmModal(
        "Mass Edit Waybills",
        `Are you sure you want to change the Waybill Status of ${count} order(s) to '${newStatus}'?`,
        "Update"
      );

      if (!confirmed) {
        massEditSelect.value = "";
        return;
      }

      try {
        massEditSelect.disabled = true;
        const orderIds = cachedFilteredWaybills.map(o => o.id);
        
        const { error } = await supabaseClient
          .from("orders")
          .update({ waybill_processing_status: newStatus })
          .in("id", orderIds);

        if (error) throw error;

        writeWaybillConsole(`[SUCCESS] Mass updated ${count} orders to '${newStatus}'.`, "info");
        fetchSummaryStats();
        if (currentTab === "orders") fetchAndRenderOrders();
        fetchAndRenderWaybillsArchive();
      } catch (err) {
        writeWaybillConsole(`[ERROR] Mass update failed: ${err.message}`, "error");
        showToast("Failed to mass update waybills: " + err.message, "error");
      } finally {
        massEditSelect.disabled = false;
        massEditSelect.value = "";
      }
    });
  }
}

// Initialize on page load
window.addEventListener("DOMContentLoaded", async () => {
  // Start system clock
  updateSystemClock();
  setInterval(updateSystemClock, 1000);

  setupIconObserver();
  updateDispatchIndicator();

  if (await initSupabase()) {
    // Load shops first so the header switcher + shop-scoped queries have data to work with.
    initShopSwitcher();
    fetchSummaryStats();
    fetchAgentHeartbeats();
    // Overview tab data — fetched eagerly since overview is the default tab
    fetchAndRenderPrintersAndQueue(); // feeds the Queue Depth KPI
    fetchAndRenderMissionControl();
    // Orders are heavy (nested items + print_jobs); defer until the Orders tab is active
    // fetchAndRenderOrders() is called by setupTabs when the user switches to that tab
    
    // Poll stats and heartbeats — skip entirely while the tab is backgrounded, same
    // guard as the 60s overview poll below (no point paying for network/render work
    // nobody's looking at).
    setInterval(() => {
      if (!document.hidden) fetchSummaryStats();
    }, 300000);
    setInterval(() => {
      if (document.hidden) return;
      if (currentTab === "operations") {
        fetchAgentHeartbeats();
        fetchAndRenderJobs();
        fetchAndRenderGeminiUsage();
        fetchAndRenderPrintersAndQueue();
        fetchAndRenderPrintJobs();
      } else if (currentTab === "orders") {
        fetchAgentHeartbeats();
        // fetchAndRenderWaybillsArchive is a dead no-op since the redesign —
        // refresh the orders list itself so the tab isn't frozen in time
        fetchAndRenderOrders();
      } else if (currentTab === "overview") {
        fetchAgentHeartbeats();
        fetchAndRenderPrintersAndQueue();
        fetchAndRenderMissionControl();
        fetchAndRenderOrders();
      }
    }, 300000);

    // Gantt zoom buttons click handler
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".gantt-zoom-btn");
      if (btn) {
        document.querySelectorAll(".gantt-zoom-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        ganttTimeWindow = parseInt(btn.getAttribute("data-hours")) || 24;
        fetchAndRenderPrintersAndQueue();
      }
    });
  }
});
// NOTE: the listener above was previously left unclosed here, which swallowed
// renderGanttChart / fetchAndRenderPrintersAndQueue / setupPrinterControls into
// its scope — making them invisible to setupTabs and every other outside
// caller (tab switches to Overview/Operations threw ReferenceError). The
// wiring half below now runs in its own DOMContentLoaded listener.

function renderGanttChart(printers, queue, jobs) {
  const container = document.getElementById("gantt-chart-container");
  if (!container) return;

  const allPrinters = printers || [];
  if (allPrinters.length === 0) {
    container.innerHTML = `<div class="font-data-mono text-xs text-outline text-center py-12">No printers registered.</div>`;
    return;
  }

  const MINI_IDS = [38959, 38960];
  const REG_IDS  = [38961, 39538];
  const nowMs = Date.now();

  // Which printer group a file belongs to (same logic as Foreman dispatch)
  function printerGroupFor(filename) {
    const n = (filename || '').toLowerCase();
    const isMini = (n.includes('a1m') || n.includes('mini')) && !/\bminifig\b/.test(n);
    return isMini ? MINI_IDS : REG_IDS;
  }

  // Strip weight/time/extension suffix for display: "SC-DS-F1-APX - 58g-90m-a1.gcode.3mf" → "SC-DS-F1-APX"
  function cleanName(name) {
    return (name || '')
      .replace(/\s*-\s*\d+g[-–]\d+[hm].*$/i, '')
      .replace(/\.(gcode|3mf|stl)(\.3mf)?$/i, '')
      .trim();
  }

  function fmtDur(ms) {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // 1. Build timeline per printer
  const tlById = {};
  allPrinters.forEach(p => {
    const offline = !p.online || (p.state || '').toLowerCase().includes('error');
    const isMini  = MINI_IDS.includes(p.id);
    const remSec  = p.remaining_seconds || 0;
    const busyEnd = offline ? nowMs : nowMs + remSec * 1000;
    const activeJob = (jobs || []).find(j => j.job_execution_status === 'printing' && j.printer_name === p.name);

    const tl = { printer: p, isMini, busyUntil: busyEnd, schedule: [], offline };
    tlById[p.id] = tl;

    if (!offline && (p.current_job_name || (p.state || '').toLowerCase() === 'printing')) {
      tl.schedule.push({
        type: 'active',
        name: p.current_job_name || 'Active Job',
        start: nowMs, end: busyEnd,
        percent: p.percent_complete || 0,
        job: activeJob
      });
    }
  });

  // 2. Assign queue items to correct printer group, earliest free first
  const sortedQ = [...(queue || [])].sort((a, b) => (a.position || 0) - (b.position || 0));
  sortedQ.forEach(q => {
    const allowed = printerGroupFor(q.name);
    const durMs   = (q.estimate_seconds || 3600) * 1000;
    const job     = (jobs || []).find(j => String(j.simplyprint_job_id) === String(q.id));

    // Pick earliest free printer in allowed group
    let best = null, bestT = Infinity;
    allowed.forEach(pid => {
      const tl = tlById[pid];
      if (tl && !tl.offline && tl.busyUntil < bestT) { bestT = tl.busyUntil; best = tl; }
    });
    // Fallback: any printer in group (even offline) so the block still renders
    if (!best) allowed.forEach(pid => {
      const tl = tlById[pid];
      if (tl && tl.busyUntil < bestT) { bestT = tl.busyUntil; best = tl; }
    });
    if (!best) return;

    const start = best.busyUntil, end = start + durMs;
    best.schedule.push({ type: 'queued', name: q.name, start, end, percent: 0, job });
    best.busyUntil = end;
  });

  // 3. Render
  const winMs  = ganttTimeWindow * 3600000;
  const winEnd = nowMs + winMs;

  // Time labels — 6 ticks
  const N = 6;
  let labelsHtml = '';
  for (let i = 0; i <= N; i++) {
    const pct   = (i / N) * 100;
    const xform = i === 0 ? 'translateX(0)' : i === N ? 'translateX(-100%)' : 'translateX(-50%)';
    labelsHtml += `<div style="position:absolute;left:${pct}%;transform:${xform};white-space:nowrap;">${fmtTime(nowMs + i * winMs / N)}</div>`;
  }

  // Grid lines
  let gridHtml = '<div class="gantt-grid-lines">';
  for (let i = 0; i <= N; i++) gridHtml += `<div class="gantt-grid-line" style="left:${(i/N)*100}%;"></div>`;
  gridHtml += '</div>';

  // Rows: mini first, then regular; offline at bottom within each group
  const sorted = Object.values(tlById).sort((a, b) => {
    if (a.offline !== b.offline) return a.offline ? 1 : -1;
    if (a.isMini !== b.isMini)   return a.isMini  ? -1 : 1;
    return (a.printer.name || '').localeCompare(b.printer.name || '');
  });

  let rowsHtml = '';
  sorted.forEach(tl => {
    const { printer: p, isMini, offline } = tl;
    let blocksHtml = '';

    tl.schedule.forEach(block => {
      if (block.end <= nowMs || block.start >= winEnd) return;
      let lp = ((block.start - nowMs) / winMs) * 100;
      let wp = ((block.end - block.start) / winMs) * 100;
      if (lp < 0) { wp += lp; lp = 0; }
      if (lp + wp > 100) wp = 100 - lp;
      if (wp <= 0) return;

      const sku  = block.job?.order_items?.variant_sku || '';
      const cust = block.job?.order_items?.orders?.customer_name || '';
      const oid  = block.job?.order_items?.orders?.platform_order_id || '';
      const disp = cleanName(block.name);
      const dur  = fmtDur(block.end - block.start);

      // Block colour
      let cls = 'gantt-block-queued-other';
      let bgStyle = '';
      const su = sku.toUpperCase();
      if (block.type === 'active') {
        const pct = block.percent || 0;
        bgStyle = `background:linear-gradient(to right,rgba(62, 207, 142,.28) ${pct}%,rgba(62, 207, 142,.07) ${pct}%);`;
        cls = 'gantt-block-active';
      } else if (su.includes('-DS') && !su.includes('-DS-NP')) {
        cls = 'gantt-block-queued-ds';
      } else if (su.includes('-FWM')) {
        cls = 'gantt-block-queued-fwm';
      } else if (su.includes('-WM')) {
        cls = 'gantt-block-queued-wm';
      }

      // Tooltip edge-clamping
      const ttPos = lp > 65
        ? 'right:0;left:auto;transform:none;'
        : lp < 10
          ? 'left:0;transform:none;'
          : 'left:50%;transform:translateX(-50%);';

      const tooltip = `
        <div class="gantt-tooltip" style="${ttPos}">
          <div class="text-primary font-bold text-[10px] border-b border-white/10 pb-1.5 mb-1.5 truncate">${escapeHtml(sku || disp)}</div>
          <div class="space-y-0.5 text-[9px] text-on-surface-variant">
            <div class="truncate"><span class="opacity-50">File</span>&nbsp;${escapeHtml(disp)}</div>
            ${oid  ? `<div><span class="opacity-50">Order</span>&nbsp;${escapeHtml(oid)}</div>` : ''}
            ${cust ? `<div><span class="opacity-50">Customer</span>&nbsp;${escapeHtml(cust)}</div>` : ''}
            <div><span class="opacity-50">Duration</span>&nbsp;${dur}</div>
            <div><span class="opacity-50">${block.type === 'active' ? 'Finishes' : 'Starts ~'}</span>&nbsp;${fmtTime(block.type === 'active' ? block.end : block.start)}</div>
            ${block.type === 'active' ? `<div class="text-primary font-bold mt-0.5">${block.percent}% complete</div>` : ''}
          </div>
        </div>`;

      blocksHtml += `
        <div class="gantt-block ${cls}" style="left:${lp.toFixed(2)}%;width:${wp.toFixed(2)}%;${bgStyle}">
          ${wp > 5 ? `<span class="gantt-block-title">${escapeHtml(disp)}</span>` : ''}
          ${tooltip}
        </div>`;
    });

    if (!blocksHtml && !offline) {
      blocksHtml = `<div class="gantt-idle-label">IDLE</div>`;
    }

    const badge = `<span class="gantt-printer-badge ${isMini ? 'badge-mini' : 'badge-reg'}">${isMini ? 'MINI' : 'A1'}</span>`;

    rowsHtml += `
      <div class="gantt-row ${offline ? 'gantt-row-offline' : ''}">
        <div class="gantt-printer-col">
          <div class="flex items-center gap-1.5 min-w-0">
            ${badge}
            <span class="truncate text-[11px] font-semibold" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
          </div>
          ${offline ? '<span class="text-[9px] text-error/60 mt-0.5 block">offline</span>' : ''}
        </div>
        <div class="gantt-timeline-col">
          ${gridHtml}
          ${blocksHtml}
        </div>
      </div>`;
  });

  container.innerHTML = `
    <div class="gantt-time-labels" style="position:relative;height:18px;margin-bottom:8px;">${labelsHtml}</div>
    <div class="flex flex-col">${rowsHtml}</div>`;
}

async function fetchAndRenderPrintersAndQueue() {
  if (!supabaseClient) return;

  const printersContainer = document.getElementById("printers-grid");
  const queueContainer = document.getElementById("printers-queue-list");
  const overviewPrintersContainer = document.getElementById("overview-printers-grid");
  const overviewQueueContainer = document.getElementById("overview-printers-queue-list");

  try {
    // Printers, queue, and active/pending print jobs are three independent queries
    // (none depends on another's result — renderGanttChart just needs all three
    // results together) so fetch them concurrently instead of sequentially.
    const [
      { data: printers, error: printersError },
      { data: queue, error: queueError },
      { data: activeJobs, error: jobsError },
    ] = await Promise.all([
      supabaseClient.from("simplyprint_printers").select("*").order("name", { ascending: true }),
      supabaseClient.from("simplyprint_queue").select("*").order("position", { ascending: true }),
      supabaseClient.from("print_jobs")
        .select("*, order_items(variant_sku, variant_name, orders(platform_order_id, customer_name)), print_files(print_time_m)")
        .in("job_execution_status", ["pending", "printing"]),
    ]);

    if (printersError) throw printersError;

    // Update printer error notification boxes
    const offlineOrErrorPrinters = (printers || []).filter(p => !p.online || (p.state && p.state.toLowerCase().includes("error")));
    const errorListHtml = offlineOrErrorPrinters.map(p => {
      const reason = !p.online ? "Printer is offline" : `Error state: ${escapeHtml(p.state)}`;
      return `<li><strong>${escapeHtml(p.name)}</strong>: ${reason}</li>`;
    }).join("");

    const ovErrorBox = document.getElementById("overview-printers-error-box");
    const ovErrorList = document.getElementById("overview-printers-error-list");
    const mainErrorBox = document.getElementById("printers-error-box");
    const mainErrorList = document.getElementById("printers-error-list");

    if (offlineOrErrorPrinters.length > 0) {
      if (ovErrorBox) ovErrorBox.classList.remove("hidden");
      if (ovErrorList) ovErrorList.innerHTML = errorListHtml;
      if (mainErrorBox) mainErrorBox.classList.remove("hidden");
      if (mainErrorList) mainErrorList.innerHTML = errorListHtml;
    } else {
      if (ovErrorBox) ovErrorBox.classList.add("hidden");
      if (mainErrorBox) mainErrorBox.classList.add("hidden");
    }

    // Aurora 3.0 printer card: state-tinted icon + circular progress ring.
    // Overview gets the compact variant; Operations adds temp chips + controls.
    // Control button classes/data-attrs are load-bearing — setupPrinterControls
    // binds via delegated grid click on .printer-btn-ready/pause/estop.
    const renderPrintersHtml = (prefix) => {
      if (!printers || printers.length === 0) {
        return `<div class="col-span-2">${emptyDiv("No printers configured in database.", "print_disabled")}</div>`;
      }

      const MINI_PRINTER_IDS = [38959, 38960];

      return printers.map(p => {
        const stateLower = (p.state || "").toLowerCase();
        const isPrinting = p.online && stateLower === "printing";
        const isPaused = p.online && stateLower === "paused";
        const stateColor = !p.online ? "#ff6666" : isPrinting ? "#3ecf8e" : isPaused ? "#fbbf24" : "#3ecf8e";
        let stateDisplay = p.online ? (p.state || "idle") : "offline";
        if (stateDisplay.toLowerCase() === "starting" || stateDisplay.toLowerCase() === "starting print") stateDisplay = "finishing";
        const statusClass = p.online ? "status-light-online" : "status-light-offline";
        const typeBadge = MINI_PRINTER_IDS.includes(p.id)
          ? `<span class="pt-type badge-mini">MINI</span>`
          : `<span class="pt-type badge-reg">A1</span>`;
        const cardAccentClass = !p.online ? "pcard-error" : (isPrinting ? "pcard-printing" : "pcard-idle");

        // --- Body: progress ring + job info, or idle/offline state ---
        let bodyHtml;
        if (p.online && (p.current_job_name || isPrinting || p.percent_complete !== null)) {
          const progress = Math.max(0, Math.min(100, p.percent_complete || 0));
          const jobName = p.current_job_name || "Active Print Job";
          const remainingMinutes = p.remaining_seconds ? Math.round(p.remaining_seconds / 60) : 0;
          const remainingStr = remainingMinutes > 0
            ? (remainingMinutes >= 60 ? `${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m left` : `${remainingMinutes}m left`)
            : "Finishing…";
          const C = 2 * Math.PI * 26;
          const offset = (C * (1 - progress / 100)).toFixed(1);
          bodyHtml = `
            <div class="pt-body">
              <div class="pt-ring${isPrinting ? " pt-ring-live" : ""}">
                <svg viewBox="0 0 64 64">
                  <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="5"></circle>
                  <circle cx="32" cy="32" r="26" fill="none" stroke="${stateColor}" stroke-width="5" stroke-linecap="round"
                    stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset}" transform="rotate(-90 32 32)"
                    style="transition: stroke-dashoffset 0.6s ease;"></circle>
                </svg>
                <span class="pt-ring-pct">${progress}%</span>
              </div>
              <div class="pt-job">
                <div class="pt-job-name" title="${escapeHtml(jobName)}">${escapeHtml(jobName)}</div>
                <div class="pt-job-eta"><span class="material-symbols-outlined">schedule</span>${remainingStr}</div>
              </div>
            </div>`;
        } else if (p.online) {
          bodyHtml = `
            <div class="pt-body pt-body-idle">
              <span class="material-symbols-outlined" style="color:#3ecf8e;">check_circle</span>
              Idle — ready for jobs
            </div>`;
        } else {
          bodyHtml = `
            <div class="pt-body pt-body-idle" style="color:var(--error-color);opacity:0.75;">
              <span class="material-symbols-outlined">wifi_off</span>
              Printer is offline
            </div>`;
        }

        // --- Temp chips (Operations only) ---
        const tempsHtml = (prefix === "overview-") ? "" : `
          <div class="pt-chips">
            <span class="pt-chip"><span class="material-symbols-outlined" style="color:#ebb2ff;">thermometer</span>${p.nozzle_temp !== null && p.nozzle_temp !== undefined ? Math.round(p.nozzle_temp) : "–"}${p.nozzle_target ? ` / ${Math.round(p.nozzle_target)}` : ""}°</span>
            <span class="pt-chip"><span class="material-symbols-outlined" style="color:#ffaa6b;">nest_heat_link_gen_3</span>${p.bed_temp !== null && p.bed_temp !== undefined ? Math.round(p.bed_temp) : "–"}${p.bed_target ? ` / ${Math.round(p.bed_target)}` : ""}°</span>
            ${p.autoprint ? `<span class="pt-chip" style="color:var(--primary-color);"><span class="material-symbols-outlined" style="color:var(--primary-color);">layers</span>${p.autoprint_current_jobs ?? 0}/${p.autoprint_max_jobs ?? 0}</span>` : ""}
          </div>`;

        // --- Controls (Operations only) ---
        const controlsHtml = (prefix === "overview-") ? "" : `
          <div class="pt-controls">
            <button class="printer-btn-ready pt-btn" data-printer-id="${p.id}" ${!p.online ? "disabled" : ""}>
              <span class="material-symbols-outlined">done</span> Ready
            </button>
            <button class="printer-btn-pause pt-btn" data-printer-id="${p.id}" data-state="${p.state}" ${!p.online ? "disabled" : ""}>
              <span class="material-symbols-outlined">${isPaused ? "play_arrow" : "pause"}</span> ${isPaused ? "Resume" : "Pause"}
            </button>
            <button class="printer-btn-estop pt-btn pt-btn-danger" data-printer-id="${p.id}" data-printer-name="${escapeHtml(p.name)}">
              <span class="material-symbols-outlined">emergency</span> E-Stop
            </button>
          </div>`;

        // Overview shows plates as a small header chip since it has no chips row
        const platesHeaderChip = (prefix === "overview-" && p.autoprint)
          ? `<span class="pt-chip" style="color:var(--primary-color);"><span class="material-symbols-outlined" style="color:var(--primary-color);">layers</span>${p.autoprint_current_jobs ?? 0}/${p.autoprint_max_jobs ?? 0}</span>`
          : "";

        return `
          <div class="d4-pcard ${cardAccentClass}${!p.online ? " pt-card-offline" : ""}">
            <div class="flex justify-between items-center gap-2">
              <div class="flex items-center gap-2.5 min-w-0">
                <div class="pt-icon" style="--pt-color:${stateColor}; --pt-soft:${stateColor}1f; --pt-line:${stateColor}47;">
                  <span class="material-symbols-outlined">print</span>
                </div>
                <h4 class="font-semibold text-on-surface text-[11.5px] truncate" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</h4>
                ${typeBadge}
              </div>
              <div class="flex items-center gap-2 flex-shrink-0">
                ${platesHeaderChip}
                <div class="flex items-center gap-1.5 bg-black/25 px-2 py-0.5 rounded-full border border-outline-variant/10">
                  <div class="${statusClass}"></div>
                  <span class="text-[9px] font-data-mono uppercase tracking-wider" style="color:${stateColor};">${escapeHtml(stateDisplay)}</span>
                </div>
              </div>
            </div>
            ${bodyHtml}
            ${tempsHtml}
            ${controlsHtml}
          </div>
        `;
      }).join("");
    };

    // Overview gets Draft 4 compact bays; the Operations pane keeps the full cards.
    const renderFleetBaysHtml = () => {
      if (!printers || printers.length === 0) {
        return `<div style="grid-column:1/-1">${emptyDiv("No printers configured in database.", "print")}</div>`;
      }
      return printers.map(p => {
        const stateLower = (p.state || "").toLowerCase();
        const isPrinting = p.online && stateLower === "printing";
        const bayClass = !p.online ? "err" : isPrinting ? "print" : "idle";
        let stateDisplay = p.online ? (p.state || "idle") : "offline";
        if (stateDisplay.toLowerCase() === "starting" || stateDisplay.toLowerCase() === "starting print") stateDisplay = "finishing";
        const progress = Math.max(0, Math.min(100, p.percent_complete || 0));
        const remainingMinutes = p.remaining_seconds ? Math.round(p.remaining_seconds / 60) : 0;
        const remainingStr = remainingMinutes > 0
          ? (remainingMinutes >= 60 ? `${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m` : `${remainingMinutes}m`)
          : "";
        const jobLine = p.online && p.current_job_name
          ? `<div class="jb" title="${escapeHtml(p.current_job_name)}">${escapeHtml(p.current_job_name)}</div>`
          : `<div class="jb">${p.online ? "idle — ready for jobs" : "printer offline"}</div>`;
        const meterAndFoot = isPrinting || (p.online && p.percent_complete !== null && p.current_job_name)
          ? `<div class="d4-meter"><i style="width:${progress}%"></i></div>
             <div class="ft"><span class="pc">${progress}%</span><span>${remainingStr}</span></div>`
          : "";
        return `
          <div class="d4-bay ${bayClass}">
            <div class="top"><span class="nm" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span><span class="tag">${escapeHtml(stateDisplay.toUpperCase())}</span></div>
            ${jobLine}
            ${meterAndFoot}
          </div>`;
      }).join("");
    };

    if (printersContainer) printersContainer.innerHTML = renderPrintersHtml("main-");
    if (overviewPrintersContainer) overviewPrintersContainer.innerHTML = renderFleetBaysHtml();

    if (queueError) throw queueError;

    // Render Queue
    const renderQueueHtml = (prefix) => {
      if (!queue || queue.length === 0) {
        return emptyDiv(
          "Queue is empty.",
          "done_all",
          `<button class="empty-action" onclick="document.getElementById('ctrl-trigger-foreman')?.click()"><span class="material-symbols-outlined">print</span>Trigger Dispatch</button>`
        );
      }
      return queue.map(q => {
        const minVal = q.estimate_seconds ? Math.round(q.estimate_seconds / 60) : 0;
        const durationStr = minVal > 0 ? (minVal >= 60 ? `${Math.floor(minVal/60)}h ${minVal%60}m` : `${minVal}m`) : "No estimate";

        return `
          <div class="d4-qitem">
            <span class="pos">#${q.position}</span>
            <div class="f">
              <div class="n" title="${escapeHtml(q.name)}">${escapeHtml(q.name)}</div>
              <div class="m">SimplyPrint ID: ${q.id}</div>
            </div>
            <span class="eta">${durationStr}</span>
          </div>
        `;
      }).join("");
    };

    if (queueContainer) queueContainer.innerHTML = renderQueueHtml("main-");
    if (overviewQueueContainer) overviewQueueContainer.innerHTML = renderQueueHtml("overview-");

    // Render Gantt timeline from the print jobs fetched above alongside printers/queue.
    try {
      if (jobsError) throw jobsError;
      renderGanttChart(printers, queue, activeJobs);
    } catch (jErr) {
      console.error("Failed to load Gantt data:", jErr);
    }

    // Update queue header stats labels
    const queueDepth = queue ? queue.length : 0;
    let totalSeconds = 0;
    if (queue) {
      queue.forEach(q => {
        totalSeconds += q.estimate_seconds || 0;
      });
    }
    let timeStr = "0m";
    if (totalSeconds > 0) {
      const totalMins = Math.round(totalSeconds / 60);
      if (totalMins >= 60) {
        const hours = Math.floor(totalMins / 60);
        const mins = totalMins % 60;
        timeStr = `${hours}h ${mins}m`;
      } else {
        timeStr = `${totalMins}m`;
      }
    }

    const queueHeaderStats = document.getElementById("overview-queue-header-stats");
    if (queueHeaderStats) {
      queueHeaderStats.innerText = `${queueDepth} (${timeStr})`;
    }
    const mainQueueHeaderStats = document.getElementById("printers-queue-header-stats");
    if (mainQueueHeaderStats) {
      mainQueueHeaderStats.innerText = `${queueDepth} (${timeStr})`;
    }

    const queueDepthEl = document.getElementById("stats-queue-depth");
    const queueTimeEl = document.getElementById("stats-queue-time");
    if (queueDepthEl) {
      tickStat(queueDepthEl, queueDepth);
    }
    if (queueTimeEl) {
      queueTimeEl.innerText = timeStr;
    }
    markFresh("printers");

  } catch (err) {
    console.error("Error in fetchAndRenderPrintersAndQueue:", err);
  }
}

function setupPrinterControls() {
  const syncButtons = [
    document.getElementById("overview-printers-btn-sync"),
    document.getElementById("printers-btn-sync")
  ];
  const readyAllButtons = [
    document.getElementById("overview-printers-btn-ready-all"),
    document.getElementById("printers-btn-ready-all")
  ];
  const clearCyclesButtons = [
    document.getElementById("overview-printers-btn-clear-cycles"),
    document.getElementById("printers-btn-clear-cycles")
  ];
  const estopAllButtons = [
    document.getElementById("overview-printers-btn-estop-all"),
    document.getElementById("printers-btn-estop-all")
  ];

  const triggerJob = async (jobType, payload = {}) => {
    if (!supabaseClient) return;
    try {
      const { data, error } = await supabaseClient
        .from("waybill_jobs")
        .insert({
          job_type: jobType,
          status: "pending",
          payload: payload
        })
        .select();
      if (error) throw error;

      if (currentTab === "overview") fetchAndRenderOverviewJobs();
      if (currentTab === "operations") fetchAndRenderJobs();
      
      setTimeout(fetchAndRenderPrintersAndQueue, 1500);
    } catch (err) {
      showToast(`Failed to queue action: ${err.message}`, "error");
    }
  };

  syncButtons.forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        triggerJob("sync_simplyprint_ids");
      });
    }
  });

  readyAllButtons.forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        triggerJob("ready_all_printers");
      });
    }
  });

  clearCyclesButtons.forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        triggerJob("clear_cycles");
      });
    }
  });

  estopAllButtons.forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        showConfirmModal("⚠ Emergency Stop All", "Are you sure you want to trigger EMERGENCY STOP for ALL printers? This will abort all active prints immediately!", "E-STOP ALL").then(ok => {
          if (ok) triggerJob("estop_all_printers");
        });
      });
    }
  });

  const grids = [
    document.getElementById("overview-printers-grid"),
    document.getElementById("printers-grid")
  ];

  grids.forEach(grid => {
    if (!grid) return;
    grid.addEventListener("click", async (e) => {
      const target = e.target.closest("button");
      if (!target) return;

      const printerId = target.getAttribute("data-printer-id");
      if (!printerId) return;

      if (target.classList.contains("printer-btn-ready")) {
        triggerJob("printer_control", { printer_id: parseInt(printerId), action: "ready" });
      } else if (target.classList.contains("printer-btn-pause")) {
        const currentState = target.getAttribute("data-state");
        const action = currentState === "paused" ? "resume" : "pause";
        triggerJob("printer_control", { printer_id: parseInt(printerId), action: action });
      } else if (target.classList.contains("printer-btn-estop")) {
        const printerName = target.getAttribute("data-printer-name") || "this printer";
        const stopOk = await showConfirmModal("⚠ Emergency Stop", `Trigger EMERGENCY STOP for printer [${printerName}]? This will abort the active print immediately.`, "E-STOP");
        if (stopOk) triggerJob("printer_control", { printer_id: parseInt(printerId), action: "estop" });
      }
    });
  });
}

// Floating command dock: the dock buttons delegate to the existing (hidden-pane)
// waybill control buttons so all disable/toast/refresh logic stays in one place.
function setupDock() {
  document.getElementById("dock-btn-scout")?.addEventListener("click", () => {
    document.getElementById("waybill-ctrl-trigger-scout")?.click();
  });
  document.getElementById("dock-btn-foreman")?.addEventListener("click", () => {
    document.getElementById("waybill-ctrl-trigger-foreman")?.click();
  });
  document.getElementById("dock-btn-waybills")?.addEventListener("click", () => {
    navigateToTab("orders");
    // Reveal the waybill tools drawer if it is collapsed.
    const body = document.querySelector(".waybill-tools-body");
    if (body?.classList.contains("hidden")) {
      document.getElementById("waybill-tools-toggle")?.click();
    }
    document.getElementById("waybill-upload-zone")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

window.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupDock();
  renderGreeting();
  setupSettings();
  setupLogsFiltering();
  setupCatalogSearch();
  setupProductsKeyboardNav();
  setupCatalogModal();
  setupCatalogStockListeners();
  setupWaybillProcessing();
  setupAgentControls();
  setupWaybillFilters();
  setupOrderFilters();
  setupPrinterControls();
  setupCommandPalette();
  setupCatalogDetailModal();
  setupCatalogEditModal();
  setupSystemErrorReset();
  setupListingsTab();
  setupSearchClearButtons();

  // Waybill panel toggle (Orders ↔ Compiled PDFs)
  const waybillTabOrders = document.getElementById("waybill-tab-orders");
  const waybillTabPdfs = document.getElementById("waybill-tab-pdfs");
  const waybillPanelOrders = document.getElementById("waybill-panel-orders");
  const waybillPanelPdfs = document.getElementById("waybill-panel-pdfs");
  function setWaybillTab(tab) {
    const isOrders = tab === "orders";
    waybillPanelOrders.classList.toggle("hidden", !isOrders);
    waybillPanelPdfs.classList.toggle("hidden", isOrders);
    waybillTabOrders.classList.toggle("bg-primary/15", isOrders);
    waybillTabOrders.classList.toggle("text-primary", isOrders);
    waybillTabOrders.classList.toggle("text-outline", !isOrders);
    waybillTabOrders.classList.toggle("hover:bg-white/5", !isOrders);
    waybillTabPdfs.classList.toggle("bg-primary/15", !isOrders);
    waybillTabPdfs.classList.toggle("text-primary", !isOrders);
    waybillTabPdfs.classList.toggle("text-outline", isOrders);
    waybillTabPdfs.classList.toggle("hover:bg-white/5", isOrders);
    if (!isOrders) fetchAndRenderMasterPDFs();
  }
  if (waybillTabOrders) waybillTabOrders.addEventListener("click", () => setWaybillTab("orders"));
  if (waybillTabPdfs) waybillTabPdfs.addEventListener("click", () => setWaybillTab("pdfs"));


  // Action Buttons Events
  const refreshOrdersBtn = document.getElementById("refresh-orders-btn");
  if (refreshOrdersBtn) refreshOrdersBtn.addEventListener("click", fetchAndRenderOrders);

  const overviewRefreshOrdersBtn = document.getElementById("overview-orders-btn-refresh");
  if (overviewRefreshOrdersBtn) overviewRefreshOrdersBtn.addEventListener("click", fetchAndRenderOrders);

  // Quick Operations: jump to the compiled Batch PDFs panel on the Orders tab
  // Toolbar "Upload Waybills": opens the file picker of the drawer's upload
  // zone (its change handler is already bound), and expands the drawer first
  // so the upload progress + daemon console are visible.
  const uploadWaybillsBtn = document.getElementById("orders-upload-waybills-btn");
  if (uploadWaybillsBtn) {
    uploadWaybillsBtn.addEventListener("click", () => {
      const body = document.querySelector(".waybill-tools-body");
      if (body && body.classList.contains("hidden")) {
        document.getElementById("waybill-tools-toggle")?.click();
      }
      document.getElementById("waybill-file-input")?.click();
    });
  }

  // Waybill Tools drawer (Orders tab): collapsed by default; fetch the
  // compiled master PDFs list on first expand.
  let waybillToolsLoaded = false;
  const waybillToolsToggle = document.getElementById("waybill-tools-toggle");
  if (waybillToolsToggle) {
    waybillToolsToggle.addEventListener("click", () => {
      const body = document.querySelector(".waybill-tools-body");
      const chevron = document.getElementById("waybill-tools-chevron");
      if (!body) return;
      const opening = body.classList.contains("hidden");
      body.classList.toggle("hidden", !opening);
      if (chevron) chevron.style.transform = opening ? "rotate(180deg)" : "";
      if (opening && !waybillToolsLoaded) {
        waybillToolsLoaded = true;
        fetchAndRenderMasterPDFs();
      }
    });
  }

  const qoBatchPdfsBtn = document.getElementById("overview-qo-batch-pdfs");
  if (qoBatchPdfsBtn) qoBatchPdfsBtn.addEventListener("click", () => {
    navigateToTab("orders");
    // The old #waybill-tab-pdfs panel is gone — the compiled PDFs list now
    // lives in the Waybill Tools drawer; expand it if collapsed.
    const body = document.querySelector(".waybill-tools-body");
    if (body && body.classList.contains("hidden")) {
      document.getElementById("waybill-tools-toggle")?.click();
    }
  });

  // Stat card navigation (uses the top-level navigateToTab)
  const statCardMap = {
    "stat-card-orders-today": "orders",
    "stat-card-pending": "orders",
    "stat-card-hold": "orders",
    "stat-card-queue": "operations",
    "stat-card-errors": "logs",
  };
  Object.entries(statCardMap).forEach(([id, tab]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => navigateToTab(tab));
  });

  // Auto-refresh pending orders table every 60s when on overview tab and the browser
  // tab is actually visible — no point re-fetching the full nested orders query (and
  // rebuilding the table) while the user isn't looking at it.
  setInterval(() => {
    if (currentTab === "overview" && !document.hidden) fetchAndRenderOrders();
  }, 60000);

  const clearDbBtn = document.getElementById("clear-db-btn");
  if (clearDbBtn) clearDbBtn.addEventListener("click", clearDatabase);

  const refreshLogsBtn = document.getElementById("refresh-logs-btn");
  if (refreshLogsBtn) refreshLogsBtn.addEventListener("click", fetchAndRenderLogs);

  const clearLogsBtn = document.getElementById("clear-logs-btn");
  if (clearLogsBtn) clearLogsBtn.addEventListener("click", async () => {
    if (!await showConfirmModal("Clear System Logs", "Delete all system log entries? This cannot be undone.", "Clear")) return;
    clearLogsBtn.disabled = true;
    try {
      const { error } = await supabaseClient.from("system_logs").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) throw error;
      showToast("System logs cleared.", "success");
      fetchAndRenderLogs();
    } catch (err) {
      showToast("Failed to clear logs: " + err.message, "error");
    } finally {
      clearLogsBtn.disabled = false;
    }
  });

  const refreshPrintJobsBtn = document.getElementById("refresh-print-jobs-btn");
  if (refreshPrintJobsBtn) refreshPrintJobsBtn.addEventListener("click", fetchAndRenderLogsPagePrintJobs);

  const clearPrintJobsBtn = document.getElementById("clear-print-jobs-btn");
  if (clearPrintJobsBtn) clearPrintJobsBtn.addEventListener("click", async () => {
    if (!await showConfirmModal("Clear Print Jobs", "Delete all print job records? This only removes the log entries — it does not cancel active prints in SimplyPrint.", "Clear")) return;
    clearPrintJobsBtn.disabled = true;
    try {
      const { error } = await supabaseClient.from("print_jobs").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) throw error;
      showToast("Print jobs cleared.", "success");
      fetchAndRenderLogsPagePrintJobs();
    } catch (err) {
      showToast("Failed to clear print jobs: " + err.message, "error");
    } finally {
      clearPrintJobsBtn.disabled = false;
    }
  });
});

async function updateStockInDb(variantId, newQty) {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient
      .from("variants")
      .update({ stock_quantity: newQty })
      .eq("id", variantId);

    if (error) throw error;

    const cached = cachedVariants.find(v => v.id === variantId);
    if (cached) {
      cached.stock_quantity = newQty;
    }

    // Sync input fields in main catalog view
    const mainInputs = document.querySelectorAll(`.input-stock-qty[data-variant-id="${variantId}"]`);
    mainInputs.forEach(input => { input.value = newQty; });

    // Sync input fields in details modal
    const modalInputs = document.querySelectorAll(`.input-modal-stock-qty[data-variant-id="${variantId}"]`);
    modalInputs.forEach(input => { input.value = newQty; });

    const sku = cached?.variant_sku || variantId;
    logAction(`Stock updated: ${sku} → ${newQty}`, "info", { variant_id: variantId, new_quantity: newQty });

  } catch (err) {
    showToast("Failed to update stock quantity: " + err.message, "error");
    // Callers (both the catalog table stepper and the product-detail-panel stepper)
    // optimistically write the failed value into cachedVariants / the DOM before this
    // update lands, so fetchAndRenderCatalog()'s "skip network if cache is warm" guard
    // would otherwise just re-render the same wrong value from cache. Force it to hit
    // the network for the real, authoritative value instead.
    cachedVariants = [];
    fetchAndRenderCatalog();
  }
}

function setupCatalogStockListeners() {
  const tbody = document.getElementById("catalog-tbody");
  if (!tbody) return;

  tbody.addEventListener("click", async (e) => {
    const decBtn = e.target.closest(".btn-stock-dec");
    const incBtn = e.target.closest(".btn-stock-inc");
    const detailsBtn = e.target.closest(".btn-product-details");
    const header = e.target.closest(".product-card-header");
    const sealBtn = e.target.closest(".btn-seal-sticker");
    const printFileBtn = e.target.closest(".btn-send-file-print");

    if (sealBtn) {
      e.stopPropagation();
      const url = sealBtn.getAttribute("data-url");
      const sku = sealBtn.getAttribute("data-sku");
      // Convert Drive view URL to direct download
      const fileIdMatch = url.match(/\/d\/([^/]+)\//);
      const downloadUrl = fileIdMatch
        ? `https://drive.google.com/uc?export=download&id=${fileIdMatch[1]}`
        : url;
      window.open(downloadUrl, "_blank");
      logAction(`Seal sticker downloaded: ${sku}`, "info", { variant_sku: sku });
      return;
    }

    if (printFileBtn) {
      e.stopPropagation();
      const spFileId = printFileBtn.getAttribute("data-sp-file-id");
      const fileName = printFileBtn.getAttribute("data-file-name");
      printFileBtn.disabled = true;
      printFileBtn.querySelector(".material-symbols-outlined").textContent = "sync";
      try {
        const res = await backendFetch(`/print-files/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ simplyprint_file_id: spFileId, print_file_name: fileName })
        });
        const rawText = await res.text();
        let data;
        try { data = JSON.parse(rawText); } catch { throw new Error(`Backend error (HTTP ${res.status}): ${rawText.substring(0, 120)}`); }
        if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
        showToast(`Queued: ${fileName}`, "success");
        logAction(`File sent to print queue: ${fileName}`, "info", { simplyprint_file_id: spFileId, job_id: data.simplyprint_job_id });
      } catch (err) {
        showToast(`Failed to queue ${fileName}: ${err.message}`, "error");
      } finally {
        printFileBtn.disabled = false;
        printFileBtn.querySelector(".material-symbols-outlined").textContent = "print";
      }
      return;
    }

    if (detailsBtn) {
      e.stopPropagation();
      const productId = detailsBtn.getAttribute("data-product-id");
      openCatalogDetailModal(productId);
      return;
    }

    const editBtn = e.target.closest(".btn-catalog-edit");
    if (editBtn) {
      e.stopPropagation();
      const productId = editBtn.getAttribute("data-product-id");
      openCatalogEditModal(productId);
      return;
    }

    if (decBtn) {
      const varId = decBtn.getAttribute("data-variant-id");
      const input = tbody.querySelector(`.input-stock-qty[data-variant-id="${varId}"]`);
      if (input) {
        let val = parseInt(input.value) || 0;
        if (val > 0) {
          val--;
          input.value = val;
          await updateStockInDb(varId, val);
        }
      }
    } else if (incBtn) {
      const varId = incBtn.getAttribute("data-variant-id");
      const input = tbody.querySelector(`.input-stock-qty[data-variant-id="${varId}"]`);
      if (input) {
        let val = parseInt(input.value) || 0;
        val++;
        input.value = val;
        await updateStockInDb(varId, val);
      }
    } else if (header) {
      const card = header.closest(".product-card");
      if (card) {
        const container = card.querySelector(".variations-container");
        const icon = header.querySelector(".toggle-icon");
        if (container && icon) {
          if (container.classList.contains("hidden")) {
            container.classList.remove("hidden");
            icon.style.transform = "rotate(180deg)";
          } else {
            container.classList.add("hidden");
            icon.style.transform = "rotate(0deg)";
          }
        }
      }
    }
  });

  tbody.addEventListener("change", async (e) => {
    if (e.target.classList.contains("input-stock-qty")) {
      const varId = e.target.getAttribute("data-variant-id");
      let val = parseInt(e.target.value);
      if (isNaN(val) || val < 0) {
        val = 0;
      }
      e.target.value = val;
      await updateStockInDb(varId, val);
    }
  });
}

async function fetchAndRenderPrintJobs() {
  if (!supabaseClient) return;
  const listContainer = document.getElementById("printers-jobs-list");
  if (!listContainer) return;

  try {
    const { data: jobs, error } = await supabaseClient
      .from("print_jobs")
      .select("*, order_items(variant_sku)")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    if (!jobs || jobs.length === 0) {
      listContainer.innerHTML = `<div class="font-data-mono text-xs text-outline text-center py-12">No print jobs found.</div>`;
      return;
    }

    let html = `
      <table class="w-full text-left border-collapse text-xs font-body-md" id="printers-jobs-table">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant/20 sticky top-0 z-20">
            <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Job ID</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">SKU</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Print File</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Printer</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10 w-44">Progress</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Est. Finish</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant">Status</th>
          </tr>
        </thead>
        <tbody>
    `;

    jobs.forEach(job => {
      const statusLower = (job.job_execution_status || "").toLowerCase();
      let statusClass = "pending";
      if (statusLower === "executing" || statusLower === "printing") {
        statusClass = "printing";
      } else if (statusLower === "completed" || statusLower === "finished") {
        statusClass = "completed";
      } else if (statusLower === "cancelled" || statusLower === "error") {
        statusClass = "hold";
      }

      let dispatchStr = "N/A";
      if (job.created_at) {
        const date = new Date(job.created_at);
        dispatchStr = date.toLocaleString();
      }

      let sku = "N/A";
      if (job.order_items) {
        if (Array.isArray(job.order_items)) {
          sku = job.order_items[0]?.variant_sku || "N/A";
        } else {
          sku = job.order_items.variant_sku || "N/A";
        }
      }
      const printer = job.printer_name || "N/A";
      let progressVal = 0;
      if (job.percent_complete !== undefined && job.percent_complete !== null) {
        progressVal = Math.round(Number(job.percent_complete));
        if (isNaN(progressVal)) progressVal = 0;
      }
      const progressHtml = `
        <div class="flex items-center gap-2">
          <div class="flex-grow bg-black/40 rounded-full h-1.5 overflow-hidden w-24">
            <div class="h-full bg-primary rounded-full" style="width: ${progressVal}%"></div>
          </div>
          <span class="text-[10px] text-outline">${progressVal}%</span>
        </div>
      `;
      let finishStr = "N/A";
      if (job.estimated_finish_time) {
        try {
          finishStr = new Date(job.estimated_finish_time).toLocaleString();
        } catch (e) {
          finishStr = String(job.estimated_finish_time);
        }
      }

      html += `
        <tr class="border-b border-outline-variant/10 hover:bg-surface-container/20 transition-colors font-data-mono">
          <td class="py-2 px-3 border-r border-outline-variant/10 font-bold text-on-surface">${escapeHtml(job.simplyprint_job_id) || "PENDING"}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-primary">${escapeHtml(sku)}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-on-surface-variant max-w-[200px] truncate" title="${escapeHtml(job.print_file_name || '')}">${escapeHtml(job.print_file_name) || 'N/A'}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-on-surface-variant">${escapeHtml(printer)}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10">${progressHtml}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-on-surface-variant">${finishStr}</td>
          <td class="py-2 px-3">
            <span class="badge ${statusClass}" style="text-transform: capitalize;">${escapeHtml(job.job_execution_status) || 'Pending'}</span>
          </td>
        </tr>
      `;
    });

    html += `
        </tbody>
      </table>
    `;

    listContainer.innerHTML = html;
    markFresh("printjobs");

  } catch (err) {
    console.error("Failed to render print jobs table:", err);
    listContainer.innerHTML = `<div class="font-data-mono text-xs text-error text-center py-12">Error loading print jobs: ${escapeHtml(err.message)}</div>`;
  }
}

// Promise-based Action Confirmation Modal.
// Only one confirmation can be live at a time: if a second request arrives while
// one is showing (e.g. a backdrop click firing the dirty-close guard mid-delete),
// the first resolves as cancelled and its listeners are detached — otherwise one
// button click would resolve both pending confirmations at once.
let activeConfirmCancel = null;
function showConfirmModal(title, message, confirmBtnText = "Delete") {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const titleEl = document.getElementById("confirm-title");
    const msgEl = document.getElementById("confirm-message");
    const cancelBtn = document.getElementById("confirm-cancel-btn");
    const okBtn = document.getElementById("confirm-ok-btn");

    if (!modal || !titleEl || !msgEl || !cancelBtn || !okBtn) {
      resolve(confirm(message));
      return;
    }

    if (activeConfirmCancel) activeConfirmCancel();

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmBtnText;

    const cleanup = () => {
      modal.classList.remove("active");
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onConfirm);
      activeConfirmCancel = null;
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    const onConfirm = () => {
      cleanup();
      resolve(true);
    };

    activeConfirmCancel = onCancel;
    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onConfirm);

    modal.classList.add("active");
  });
}

// System Log Error Reset Listener
function setupSystemErrorReset() {
  const resetErrorsBtn = document.getElementById("reset-errors-btn");
  if (resetErrorsBtn) {
    resetErrorsBtn.addEventListener("click", async () => {
      if (!supabaseClient) return;
      
      const confirmed = await showConfirmModal(
        "Reset System Errors",
        "Are you sure you want to reset the system errors count? This will delete all error logs from the system logs database.",
        "Reset"
      );
      if (!confirmed) return;
      
      try {
        resetErrorsBtn.disabled = true;
        const { error } = await supabaseClient
          .from("system_logs")
          .delete()
          .eq("log_level", "error");
        
        if (error) throw error;
        
        fetchSummaryStats();
        if (currentTab === "overview") {
          fetchAndRenderOverviewLogs();
        }
      } catch (err) {
        showToast("Failed to reset errors: " + err.message, "error");
      } finally {
        resetErrorsBtn.disabled = false;
      }
    });
  }
}

// Catalog Detail Popup Modal Setup
function setupCatalogDetailModal() {
  const modal = document.getElementById("catalog-detail-modal");
  const closeBtn = document.getElementById("catalog-detail-close-btn");
  const contentEl = document.getElementById("catalog-detail-content");
  if (!modal || !closeBtn || !contentEl) return;

  closeBtn.addEventListener("click", () => {
    modal.classList.remove("active");
  });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.remove("active");
    }
  });

  // Handle stock adjustments inside the details modal
  contentEl.addEventListener("click", async (e) => {
    const decBtn = e.target.closest(".btn-modal-stock-dec");
    const incBtn = e.target.closest(".btn-modal-stock-inc");
    const dispatchBtn = e.target.closest(".btn-dispatch-print-file");

    if (dispatchBtn) {
      redispatchPrintFile(dispatchBtn.getAttribute("data-sp-file-id") || null, dispatchBtn.getAttribute("data-file-name"), null, dispatchBtn);
    } else if (decBtn) {
      const varId = decBtn.getAttribute("data-variant-id");
      const input = contentEl.querySelector(`.input-modal-stock-qty[data-variant-id="${varId}"]`);
      if (input) {
        let val = parseInt(input.value) || 0;
        if (val > 0) {
          val--;
          input.value = val;
          await updateStockInDb(varId, val);
        }
      }
    } else if (incBtn) {
      const varId = incBtn.getAttribute("data-variant-id");
      const input = contentEl.querySelector(`.input-modal-stock-qty[data-variant-id="${varId}"]`);
      if (input) {
        let val = parseInt(input.value) || 0;
        val++;
        input.value = val;
        await updateStockInDb(varId, val);
      }
    }
  });

  contentEl.addEventListener("change", async (e) => {
    if (e.target.classList.contains("input-modal-stock-qty")) {
      const varId = e.target.getAttribute("data-variant-id");
      let val = parseInt(e.target.value);
      if (isNaN(val) || val < 0) {
        val = 0;
      }
      e.target.value = val;
      await updateStockInDb(varId, val);
    }
  });
}

// Catalog Detailed Popup View Renderer
function openCatalogDetailModal(productId) {
  const productVariants = cachedVariants.filter(v => v.products && v.products.id === productId);
  if (productVariants.length === 0) return;

  const product = productVariants[0].products;
  const modal = document.getElementById("catalog-detail-modal");
  const titleEl = document.getElementById("catalog-detail-title");
  const contentEl = document.getElementById("catalog-detail-content");

  if (!modal || !contentEl) return;

  titleEl.textContent = product.product_base_name || "Product Details";

  let html = `
    <!-- Base Info Grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 bg-surface-container-low/40 p-4 rounded-xl border border-outline-variant/10">
      <div>
        <div class="text-[10px] text-outline uppercase font-semibold">Product ID</div>
        <div class="font-data-mono text-xs text-on-surface font-semibold select-all mt-0.5">${product.id}</div>
      </div>
      <div>
        <div class="text-[10px] text-outline uppercase font-semibold">Master SKU</div>
        <div class="font-data-mono text-xs text-[#ebb2ff] font-semibold select-all mt-0.5">${product.master_sku || 'N/A'}</div>
      </div>
      <div>
        <div class="text-[10px] text-outline uppercase font-semibold">Brand Name</div>
        <div class="text-xs text-on-surface font-semibold mt-0.5">${product.brand_name || 'N/A'}</div>
      </div>
      <div>
        <div class="text-[10px] text-outline uppercase font-semibold">Category</div>
        <div class="text-xs text-on-surface font-semibold mt-0.5">${product.product_category || 'N/A'}</div>
      </div>
      <div>
        <div class="text-[10px] text-outline uppercase font-semibold">Created At</div>
        <div class="text-xs text-on-surface-variant mt-0.5">${product.created_at ? new Date(product.created_at).toLocaleString() : 'N/A'}</div>
      </div>
    </div>

    <!-- Variations Section -->
    <div class="space-y-3">
      <h4 class="text-xs font-bold text-on-surface uppercase tracking-wider">Variations (${productVariants.length})</h4>
      <div class="flex flex-col gap-2">
  `;

  productVariants.forEach(v => {
    let filesHtml = "";
    if (v.print_files && v.print_files.length > 0) {
      filesHtml = `
        <div class="flex flex-col gap-1.5 mt-2">
          ${v.print_files.map(f => `
            <div class="font-data-mono text-[10px] flex items-center justify-between bg-black/40 px-3 py-1.5 rounded border border-outline-variant/10">
              <div class="flex items-center gap-2 min-w-0">
                <span class="material-symbols-outlined text-[14px] text-surface-tint">description</span>
                <span class="text-on-surface font-medium truncate max-w-[200px]" title="${f.print_file_name}">${f.print_file_name}</span>
                <span class="text-on-surface-variant/40">(${f.simplyprint_file_id || 'No SP ID'})</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-on-surface-variant/70">${f.weight_g}g | ${f.print_time_m}m</span>
                <button type="button" class="btn-dispatch-print-file text-tertiary hover:underline flex items-center gap-0.5 cursor-pointer"
                  data-sp-file-id="${f.simplyprint_file_id || ''}" data-file-name="${String(f.print_file_name ?? '').replace(/"/g, '&quot;')}">
                  <span class="material-symbols-outlined text-xs">print</span> Dispatch
                </button>
                ${f.simplyprint_file_id ? `
                  <a href="https://simplyprint.io/panel/files?search=${encodeURIComponent(f.print_file_name)}" target="_blank" class="text-primary hover:underline flex items-center gap-0.5">
                    <span class="material-symbols-outlined text-xs">open_in_new</span> View
                  </a>
                ` : ''}
              </div>
            </div>
          `).join("")}
        </div>
      `;
    } else {
      filesHtml = `<div class="text-on-surface-variant/30 font-data-mono text-[10px] mt-1 italic">No print slices mapped.</div>`;
    }

    html += `
      <div class="p-3 bg-surface-container-low/20 border border-outline-variant/10 rounded-lg flex flex-col gap-1">
        <div class="flex justify-between items-center flex-wrap gap-2">
          <div class="flex items-center gap-2">
            <span class="px-2 py-0.5 text-[9px] font-bold rounded bg-[#ebb2ff]/10 text-[#ebb2ff] border border-[#ebb2ff]/20 uppercase">${v.variant_type || 'WM'}</span>
            <span class="font-data-mono text-xs font-bold text-on-surface select-all">${v.variant_sku}</span>
            <span class="text-xs text-on-surface-variant font-medium">${v.variant_name || 'N/A'}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-label-caps text-on-surface-variant/60 uppercase tracking-wider select-none">Stock:</span>
            <div class="flex items-center bg-black/30 border border-outline-variant/20 rounded-lg p-0.5 overflow-hidden">
              <button class="w-6 h-6 flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-white/10 rounded transition-all active:scale-95 btn-modal-stock-dec" data-variant-id="${v.id}" type="button">-</button>
              <input type="number" min="0" value="${v.stock_quantity || 0}" class="w-10 bg-transparent text-center text-xs font-bold text-on-surface border-0 p-0 outline-none select-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none input-modal-stock-qty" data-variant-id="${v.id}">
              <button class="w-6 h-6 flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-white/10 rounded transition-all active:scale-95 btn-modal-stock-inc" data-variant-id="${v.id}" type="button">+</button>
            </div>
          </div>
        </div>
        ${filesHtml}
      </div>
    `;
  });

  const rawProductJson = JSON.stringify({ product, variations: productVariants.map(({products, print_files, ...rest}) => rest) }, null, 2);

  html += `
      </div>
    </div>

    <!-- Raw JSON Collapsible -->
    <div class="border-t border-outline-variant/10 pt-3 mt-1">
      <details class="group">
        <summary class="text-xs font-semibold text-outline hover:text-on-surface cursor-pointer select-none flex items-center gap-1.5">
          <span class="material-symbols-outlined text-sm transition-transform group-open:rotate-180">expand_more</span>
          <span>View Raw JSON Data</span>
        </summary>
        <pre class="bg-black/40 border border-outline-variant/10 rounded-lg p-3 font-data-mono text-[10px] text-on-surface-variant/90 overflow-x-auto mt-2 select-all max-h-48 overflow-y-auto">${rawProductJson}</pre>
      </details>
    </div>
  `;

  contentEl.innerHTML = html;
  modal.classList.add("active");
}

// Catalog Edit Modal
// Dirty flag for the catalog edit modal: set on any input, checked before closing
// so employees don't silently lose edits by clicking the backdrop.
let catalogEditDirty = false;
// Counter for not-yet-saved variant blocks added via "Add Variant".
let catalogEditNewVariantSeq = 0;

const CATALOG_EDIT_INPUT_CLS = "w-full bg-black/30 border border-outline-variant/20 rounded-lg px-3 py-1.5 text-xs font-data-mono text-on-surface focus:border-primary/50 focus:outline-none transition-colors";
const CATALOG_EDIT_LABEL_CLS = "font-label-caps text-[10px] text-outline uppercase tracking-wider block mb-1";

// One labeled input. `attrs` carries either data-id (existing row) or data-new-idx
// (unsaved variant block). data-initial holds the original value so save can send
// only changed fields. type: "text" | "number" (float) | "int".
function catalogEditField(label, table, attrs, fieldName, value, type = "text", opts = {}) {
  const esc = String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const attrStr = Object.entries(attrs).map(([k, v]) => `data-${k}="${v}"`).join(" ");
  return `
    <div class="${opts.span2 ? "col-span-2" : ""}">
      <label class="${CATALOG_EDIT_LABEL_CLS}">${label}</label>
      <input type="${type === "text" ? "text" : "number"}" ${type === "number" ? `step="any"` : ""} ${type === "int" ? `step="1"` : ""}
        value="${esc}" ${opts.list ? `list="${opts.list}"` : ""} ${opts.placeholder ? `placeholder="${opts.placeholder}"` : ""}
        class="edit-field ${CATALOG_EDIT_INPUT_CLS}"
        ${attrStr} data-table="${table}" data-field="${fieldName}" data-type="${type}" data-initial="${esc}">
    </div>
  `;
}

// Full field set for one variant. Works for existing rows (attrs = {id}) and new
// unsaved blocks (attrs = {"new-idx": n}).
function catalogEditVariantFields(v, table, attrs) {
  const f = (label, fieldName, type, opts) => catalogEditField(label, table, attrs, fieldName, v[fieldName], type, opts);
  return `
    <div class="grid grid-cols-2 gap-3">
      ${f("Variant SKU *", "variant_sku")}
      ${f("Variant Name", "variant_name")}
      ${f("Variant Type", "variant_type", "text", { list: "variant-type-suggestions" })}
      ${f("Stock Quantity", "stock_quantity", "int")}
      ${f("Set Number", "set_number")}
      ${f("Plaque Count", "plaque_count", "int")}
      ${f("Reference Name", "reference_name")}
      ${f("File Checklist", "file_checklist")}
      ${f("Seal Sticker Drive URL", "seal_sticker_gdrive_url", "text", { span2: true })}
      ${f("Print Files Drive URL", "print_files_gdrive_url", "text", { span2: true })}
      ${f("Pictures Drive URL", "pictures_gdrive_url", "text", { span2: true })}
      ${f("Adobe Express URL", "adobe_express_url", "text", { span2: true })}
    </div>
  `;
}

function openCatalogEditModal(productId) {
  const productVariants = cachedVariants.filter(v => v.products && v.products.id === productId);
  if (productVariants.length === 0) return;

  const product = productVariants[0].products;
  const modal = document.getElementById("catalog-edit-modal");
  const titleEl = document.getElementById("catalog-edit-title");
  const contentEl = document.getElementById("catalog-edit-content");
  if (!modal || !contentEl) return;

  titleEl.textContent = product.product_base_name || "Edit Product";
  contentEl.dataset.productId = productId;
  catalogEditDirty = false;
  catalogEditNewVariantSeq = 0;

  const field = (label, table, id, fieldName, value, type = "text", opts = {}) =>
    catalogEditField(label, table, { id }, fieldName, value, type, opts);

  const fmtTs = (ts) => ts ? new Date(ts).toLocaleString() : "—";

  // Shop dropdown built from cachedShops (loaded at startup for the header switcher).
  const shopOptions = [
    `<option value="" ${!product.shop_id ? "selected" : ""}>— Unassigned —</option>`,
    ...cachedShops.map(s => `<option value="${s.id}" ${s.id === product.shop_id ? "selected" : ""}>${s.name}</option>`)
  ].join("");

  let html = `
    <!-- Product fields -->
    <div class="flex flex-col gap-3">
      <h4 class="font-label-caps text-[11px] text-primary uppercase tracking-widest flex items-center gap-2">
        <span class="material-symbols-outlined text-sm">inventory_2</span> Product
      </h4>
      <div class="grid grid-cols-2 gap-3 bg-black/20 border border-outline-variant/10 rounded-xl p-4">
        ${field("Product Base Name", "products", product.id, "product_base_name", product.product_base_name)}
        ${field("Master SKU *", "products", product.id, "master_sku", product.master_sku)}
        ${field("Brand Name", "products", product.id, "brand_name", product.brand_name)}
        ${field("Category", "products", product.id, "product_category", product.product_category)}
        <div>
          <label class="${CATALOG_EDIT_LABEL_CLS}">Shop</label>
          <select class="edit-field ${CATALOG_EDIT_INPUT_CLS}"
            data-table="products" data-id="${product.id}" data-field="shop_id" data-type="text"
            data-initial="${product.shop_id ?? ""}">${shopOptions}</select>
        </div>
        <div class="flex flex-col justify-end gap-0.5 text-[10px] font-data-mono text-on-surface-variant/40">
          <span>ID: ${product.id}</span>
          <span>Created: ${fmtTs(product.created_at)} · Updated: ${fmtTs(product.updated_at)}</span>
        </div>
      </div>
    </div>
    <div id="catalog-edit-variants-container" class="flex flex-col gap-5">
  `;

  productVariants.forEach((v, vi) => {
    const escSku = String(v.variant_sku ?? "").replace(/"/g, "&quot;");
    const filesHtml = (v.print_files || []).map(f => `
      <div class="flex flex-col gap-2 bg-black/20 border border-outline-variant/10 rounded-lg p-3">
        <div class="font-label-caps text-[9px] text-surface-tint uppercase tracking-widest flex items-center justify-between mb-1">
          <span class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[11px]">description</span> Print File</span>
          <div class="flex items-center gap-1">
            <button class="btn-dispatch-print-file flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold text-tertiary/70 hover:text-tertiary hover:bg-tertiary/10 transition-all cursor-pointer"
              data-sp-file-id="${f.simplyprint_file_id || ''}" data-file-name="${String(f.print_file_name ?? "").replace(/"/g, "&quot;")}">
              <span class="material-symbols-outlined text-[11px]">print</span> Dispatch
            </button>
            <button class="btn-remove-print-file flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold text-error/60 hover:text-error hover:bg-error/10 transition-all cursor-pointer"
              data-file-id="${f.id}" data-file-name="${String(f.print_file_name ?? "").replace(/"/g, "&quot;")}">
              <span class="material-symbols-outlined text-[11px]">delete</span> Remove
            </button>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          ${field("File Name", "print_files", f.id, "print_file_name", f.print_file_name)}
          ${field("SimplyPrint File ID", "print_files", f.id, "simplyprint_file_id", f.simplyprint_file_id)}
          ${field("Weight (g)", "print_files", f.id, "weight_g", f.weight_g, "number")}
          ${field("Print Time (min)", "print_files", f.id, "print_time_m", f.print_time_m, "int")}
          ${field("Reference Name", "print_files", f.id, "reference_name", f.reference_name)}
          ${field("Variant SKU (denorm)", "print_files", f.id, "variant_sku", f.variant_sku)}
        </div>
      </div>
    `).join("");

    html += `
      <div class="flex flex-col gap-3 variant-edit-block" data-variant-id="${v.id}">
        <div class="flex items-center justify-between">
          <h4 class="font-label-caps text-[11px] text-[#ebb2ff] uppercase tracking-widest flex items-center gap-2">
            <span class="material-symbols-outlined text-sm">layers</span> Variant ${vi + 1} of ${productVariants.length}
            <span class="font-data-mono normal-case tracking-normal text-on-surface-variant/50">${v.variant_sku || ""}</span>
          </h4>
          <div class="flex items-center gap-1.5">
            <button class="btn-duplicate-variant flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold text-on-surface-variant/70 hover:text-on-surface hover:bg-white/5 border border-transparent hover:border-outline-variant/30 transition-all cursor-pointer"
              data-variant-id="${v.id}" title="Copy this variant into a new unsaved variant form">
              <span class="material-symbols-outlined text-[13px]">content_copy</span> Duplicate
            </button>
            <button class="btn-remove-variant flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold text-error/70 hover:text-error hover:bg-error/10 border border-transparent hover:border-error/30 transition-all cursor-pointer"
              data-variant-id="${v.id}" data-variant-sku="${escSku}"
              data-file-count="${(v.print_files || []).length}" data-is-last="${productVariants.length === 1}">
              <span class="material-symbols-outlined text-[13px]">delete</span> Remove
            </button>
          </div>
        </div>
        <div class="flex flex-col gap-3 bg-black/20 border border-outline-variant/10 rounded-xl p-4">
          ${catalogEditVariantFields(v, "variants", { id: v.id })}
          <div class="flex flex-col gap-2">
            <div class="font-label-caps text-[10px] text-outline uppercase tracking-wider mt-1">Print Files (${(v.print_files || []).length})</div>
            ${filesHtml || `<div class="text-[10px] font-data-mono text-on-surface-variant/30 italic">No print files mapped.</div>`}
            <div class="new-files-container flex flex-col gap-2"></div>
            <button class="btn-add-print-file self-start flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold text-tertiary/80 hover:text-tertiary hover:bg-tertiary/10 border border-tertiary/20 transition-all cursor-pointer"
              data-variant-id="${v.id}" data-variant-sku="${escSku}">
              <span class="material-symbols-outlined text-[13px]">add</span> Add Print File
            </button>
          </div>
          <div class="text-[10px] font-data-mono text-on-surface-variant/40">ID: ${v.id} · Created: ${fmtTs(v.created_at)} · Updated: ${fmtTs(v.updated_at)}</div>
        </div>
      </div>
    `;
  });

  // Free-text input above with suggestions — variant_type isn't DB-constrained to LEGO
  // codes (DS/WM/etc.), since generic (non-LEGO) shops use their own type names.
  html += `
    </div>
    <datalist id="variant-type-suggestions">
      ${["DS-1","DS-2","DS-3","DS-4","DS-NP","WM","FWM","BASE"].map(t => `<option value="${t}">`).join("")}
    </datalist>
  `;

  contentEl.innerHTML = html;
  modal.classList.add("active");
}

// Append a blank variant form to the open edit modal. Saved on "Save Changes".
// `prefill` (optional) seeds the form fields — used by the Duplicate button.
function addCatalogEditNewVariantBlock(prefill) {
  const contentEl = document.getElementById("catalog-edit-content");
  const container = document.getElementById("catalog-edit-variants-container");
  if (!contentEl || !container) return;

  const productId = contentEl.dataset.productId;
  const productVariants = cachedVariants.filter(v => v.products && v.products.id === productId);
  const product = productVariants[0]?.products || {};

  const idx = ++catalogEditNewVariantSeq;
  // Prefill the SKU prefix and set number so employees only type the suffix.
  const draft = (prefill && typeof prefill === "object" && !(prefill instanceof Event)) ? prefill : {
    variant_sku: product.master_sku ? `${product.master_sku}-` : "",
    set_number: productVariants[0]?.set_number ?? "",
    stock_quantity: 0,
  };

  const block = document.createElement("div");
  block.className = "flex flex-col gap-3 variant-new-block";
  block.dataset.newIdx = idx;
  block.innerHTML = `
    <div class="flex items-center justify-between">
      <h4 class="font-label-caps text-[11px] text-tertiary uppercase tracking-widest flex items-center gap-2">
        <span class="material-symbols-outlined text-sm">add_circle</span> New Variant (unsaved)
      </h4>
      <button class="btn-discard-new-variant flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold text-on-surface-variant/60 hover:text-on-surface hover:bg-white/5 border border-transparent hover:border-outline-variant/30 transition-all cursor-pointer">
        <span class="material-symbols-outlined text-[13px]">close</span> Discard
      </button>
    </div>
    <div class="flex flex-col gap-3 bg-tertiary/5 border border-tertiary/20 rounded-xl p-4">
      ${catalogEditVariantFields(draft, "variants", { "new-idx": idx })}
    </div>
  `;
  container.appendChild(block);
  catalogEditDirty = true;
  block.querySelector(".edit-field")?.focus();
  block.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Counter for not-yet-saved print-file blocks added via "Add Print File".
let catalogEditNewFileSeq = 0;

// Append a blank print-file form under an existing variant. Saved on "Save Changes".
function addCatalogEditNewPrintFileBlock(variantId, variantSku) {
  const container = document.querySelector(`#catalog-edit-content .variant-edit-block[data-variant-id="${variantId}"] .new-files-container`);
  if (!container) return;

  const idx = ++catalogEditNewFileSeq;
  const draft = { variant_sku: variantSku || "" };
  const f = (label, fieldName, type, opts) =>
    catalogEditField(label, "print_files", { "new-file-idx": idx }, fieldName, draft[fieldName], type, opts);

  const block = document.createElement("div");
  block.className = "flex flex-col gap-2 bg-tertiary/5 border border-tertiary/20 rounded-lg p-3 print-file-new-block";
  block.dataset.variantId = variantId;
  block.innerHTML = `
    <div class="font-label-caps text-[9px] text-tertiary uppercase tracking-widest flex items-center justify-between mb-1">
      <span class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[11px]">note_add</span> New Print File (unsaved)</span>
      <button class="btn-discard-new-file flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold text-on-surface-variant/60 hover:text-on-surface hover:bg-white/5 transition-all cursor-pointer">
        <span class="material-symbols-outlined text-[11px]">close</span> Discard
      </button>
    </div>
    <div class="grid grid-cols-2 gap-2">
      ${f("File Name *", "print_file_name")}
      ${f("SimplyPrint File ID", "simplyprint_file_id")}
      ${f("Weight (g)", "weight_g", "number")}
      ${f("Print Time (min)", "print_time_m", "int")}
      ${f("Reference Name", "reference_name")}
      ${f("Variant SKU (denorm)", "variant_sku")}
    </div>
  `;
  container.appendChild(block);
  catalogEditDirty = true;
  block.querySelector(".edit-field")?.focus();
}

// Coerce an edit-field's string value for the DB. Empty string -> null.
function catalogEditCoerce(raw, type) {
  const val = raw.trim();
  if (val === "") return null;
  if (type === "int") { const n = parseInt(val, 10); return Number.isNaN(n) ? null : n; }
  if (type === "number") { const n = parseFloat(val); return Number.isNaN(n) ? null : n; }
  return val;
}

// SKU guardrails run before any write:
// 1. duplicate SKUs typed inside the modal itself,
// 2. SKUs that don't start with the shop's sku_prefix (warn, overridable),
// 3. SKUs already taken by another row in the DB (hard block — the DB would
//    reject them anyway, this just gives a readable message first).
// Returns true when the save may proceed.
async function catalogEditValidateSkus(contentEl, updates, inserts, productId) {
  const skuChecks = [];
  Object.values(updates).forEach(u => {
    if (u.table === "variants" && u.data.variant_sku) skuChecks.push({ sku: u.data.variant_sku, excludeId: u.id });
  });
  inserts.forEach(r => skuChecks.push({ sku: r.variant_sku }));

  // 1. In-modal duplicates (two fields with the same SKU)
  const allSkus = [...contentEl.querySelectorAll('.edit-field[data-table="variants"][data-field="variant_sku"]')]
    .map(el => el.value.trim()).filter(Boolean);
  const dupes = [...new Set(allSkus.filter((s, i) => allSkus.indexOf(s) !== i))];
  if (dupes.length) {
    showToast(`Duplicate variant SKU in this form: ${dupes.join(", ")}`, "error");
    return false;
  }

  // 2. Shop prefix warning (uses the shop currently selected in the modal)
  const shopSel = contentEl.querySelector('.edit-field[data-field="shop_id"]');
  const shop = cachedShops.find(s => s.id === (shopSel?.value || ""));
  const prefix = shop?.sku_prefix;
  if (prefix) {
    const bad = skuChecks.filter(c => !c.sku.startsWith(prefix + "-")).map(c => c.sku);
    const productUpd = Object.values(updates).find(u => u.table === "products" && u.data.master_sku);
    if (productUpd && !productUpd.data.master_sku.startsWith(prefix + "-")) bad.push(productUpd.data.master_sku);
    if (bad.length) {
      const ok = await showConfirmModal(
        "SKU prefix mismatch",
        `${shop.name} SKUs normally start with "${prefix}-". These don't: ${bad.join(", ")}. Save anyway?`,
        "Save Anyway"
      );
      if (!ok) return false;
    }
  }

  // 3. Already taken in the DB by a different row
  if (skuChecks.length) {
    const { data: existing, error } = await supabaseClient
      .from("variants").select("id, variant_sku")
      .in("variant_sku", skuChecks.map(c => c.sku));
    if (error) { showToast("SKU check failed: " + error.message, "error"); return false; }
    const conflict = (existing || []).find(row => {
      const c = skuChecks.find(k => k.sku === row.variant_sku);
      return c && row.id !== c.excludeId;
    });
    if (conflict) {
      showToast(`Variant SKU "${conflict.variant_sku}" already exists on another variant.`, "error");
      return false;
    }
  }
  const productUpd = Object.values(updates).find(u => u.table === "products" && u.data.master_sku);
  if (productUpd) {
    const { data: existing, error } = await supabaseClient
      .from("products").select("id").eq("master_sku", productUpd.data.master_sku).neq("id", productId);
    if (error) { showToast("SKU check failed: " + error.message, "error"); return false; }
    if ((existing || []).length) {
      showToast(`Master SKU "${productUpd.data.master_sku}" already exists on another product.`, "error");
      return false;
    }
  }
  return true;
}

function setupCatalogEditModal() {
  const modal = document.getElementById("catalog-edit-modal");
  if (!modal) return;

  const contentEl = document.getElementById("catalog-edit-content");
  const saveBtn = document.getElementById("catalog-edit-save-btn");

  const closeModal = async () => {
    if (catalogEditDirty) {
      const ok = await showConfirmModal("Discard changes?", "You have unsaved edits in this product. Close without saving?", "Discard");
      if (!ok) return;
    }
    catalogEditDirty = false;
    modal.classList.remove("active");
  };

  document.getElementById("catalog-edit-close-btn").addEventListener("click", closeModal);
  document.getElementById("catalog-edit-cancel-btn").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  // Any typing/selection marks the modal dirty (close then warns before discarding).
  contentEl.addEventListener("input", () => { catalogEditDirty = true; });

  document.getElementById("catalog-edit-add-variant-btn")?.addEventListener("click", addCatalogEditNewVariantBlock);

  // Delegated clicks: duplicate variant, add/discard/remove print files, remove
  // existing variant (DB deletes happen immediately after confirmation; discards
  // are DOM-only since those blocks were never saved).
  contentEl.addEventListener("click", async (e) => {
    const discardBtn = e.target.closest(".btn-discard-new-variant");
    if (discardBtn) {
      discardBtn.closest(".variant-new-block")?.remove();
      return;
    }

    const discardFileBtn = e.target.closest(".btn-discard-new-file");
    if (discardFileBtn) {
      discardFileBtn.closest(".print-file-new-block")?.remove();
      return;
    }

    const dupBtn = e.target.closest(".btn-duplicate-variant");
    if (dupBtn) {
      const src = cachedVariants.find(v => v.id === dupBtn.dataset.variantId);
      if (src) addCatalogEditNewVariantBlock({
        variant_sku: (src.variant_sku || "") + "-COPY",
        variant_name: src.variant_name,
        variant_type: src.variant_type,
        stock_quantity: src.stock_quantity,
        set_number: src.set_number,
        plaque_count: src.plaque_count,
        reference_name: src.reference_name,
        file_checklist: src.file_checklist,
        seal_sticker_gdrive_url: src.seal_sticker_gdrive_url,
        print_files_gdrive_url: src.print_files_gdrive_url,
        pictures_gdrive_url: src.pictures_gdrive_url,
        adobe_express_url: src.adobe_express_url,
      });
      return;
    }

    const addFileBtn = e.target.closest(".btn-add-print-file");
    if (addFileBtn) {
      addCatalogEditNewPrintFileBlock(addFileBtn.dataset.variantId, addFileBtn.dataset.variantSku);
      return;
    }

    const dispatchFileBtn = e.target.closest(".btn-dispatch-print-file");
    if (dispatchFileBtn) {
      redispatchPrintFile(dispatchFileBtn.getAttribute("data-sp-file-id") || null, dispatchFileBtn.getAttribute("data-file-name"), null, dispatchFileBtn);
      return;
    }

    const removeFileBtn = e.target.closest(".btn-remove-print-file");
    if (removeFileBtn) {
      const { fileId, fileName } = removeFileBtn.dataset;
      const ok = await showConfirmModal(
        "Remove Print File",
        `Remove print file "${fileName}"? The Foreman will no longer dispatch it for this variant. Past print jobs keep their history.`,
        "Remove"
      );
      if (!ok) return;
      try {
        await supabaseClient.from("print_files").delete().eq("id", fileId).throwOnError();
        removeFileBtn.closest(".rounded-lg")?.remove();
        cachedVariants.forEach(v => { if (v.print_files) v.print_files = v.print_files.filter(f => f.id !== fileId); });
        logAction(`Print file removed via product editor: ${fileName}`, "warning", { print_file_id: fileId });
        showToast(`Print file "${fileName}" removed.`, "success");
        fetchAndRenderCatalog();
      } catch (err) {
        showToast("Remove failed: " + err.message, "error");
      }
      return;
    }

    const removeBtn = e.target.closest(".btn-remove-variant");
    if (!removeBtn) return;

    const { variantId, variantSku, fileCount, isLast } = removeBtn.dataset;
    let msg = `Delete variant ${variantSku}? This also deletes its ${fileCount} linked print file record(s) and any listing variation mappings. Past order history is kept (unlinked).`;
    if (isLast === "true") msg += ` This is the LAST variant — the product will disappear from the catalog view until a new variant is added.`;
    const ok = await showConfirmModal("Delete Variant", msg, "Delete");
    if (!ok) return;

    try {
      await supabaseClient.from("variants").delete().eq("id", variantId).throwOnError();
      contentEl.querySelector(`.variant-edit-block[data-variant-id="${variantId}"]`)?.remove();
      cachedVariants = cachedVariants.filter(v => v.id !== variantId);
      logAction(`Variant deleted via product editor: ${variantSku}`, "warning", { variant_id: variantId, print_files_cascaded: Number(fileCount) });
      showToast(`Variant ${variantSku} deleted.`, "success");
      fetchAndRenderCatalog();
    } catch (err) {
      showToast("Delete failed: " + err.message, "error");
    }
  });

  saveBtn.addEventListener("click", async () => {
    const productId = contentEl.dataset.productId;

    // --- Updates to existing rows: only send fields whose value actually changed ---
    const updates = {};
    let invalid = null;
    contentEl.querySelectorAll(".edit-field[data-id]").forEach(el => {
      const { table, id, field, type, initial } = el.dataset;
      const val = catalogEditCoerce(el.value, type);
      const initialVal = catalogEditCoerce(initial ?? "", type);
      if (val === initialVal) return;
      if (val === null && (field === "master_sku" || field === "variant_sku")) {
        invalid = `${field.replace("_", " ")} cannot be empty.`;
        el.focus();
        return;
      }
      const key = `${table}::${id}`;
      if (!updates[key]) updates[key] = { table, id, data: {} };
      updates[key].data[field] = val;
    });
    if (invalid) { showToast(invalid, "error"); return; }

    // --- New variants from "Add Variant" blocks ---
    const inserts = [];
    for (const block of contentEl.querySelectorAll(".variant-new-block")) {
      const row = { product_id: productId };
      block.querySelectorAll(".edit-field").forEach(el => {
        row[el.dataset.field] = catalogEditCoerce(el.value, el.dataset.type);
      });
      if (!row.variant_sku) {
        showToast("New variant needs a Variant SKU before saving.", "error");
        block.querySelector(`.edit-field[data-field="variant_sku"]`)?.focus();
        return;
      }
      inserts.push(row);
    }

    // --- New print files from "Add Print File" blocks (attach to existing variants) ---
    const fileInserts = [];
    for (const block of contentEl.querySelectorAll(".print-file-new-block")) {
      const row = { variant_id: block.dataset.variantId };
      block.querySelectorAll(".edit-field").forEach(el => {
        row[el.dataset.field] = catalogEditCoerce(el.value, el.dataset.type);
      });
      if (!row.print_file_name) {
        showToast("New print file needs a File Name before saving.", "error");
        block.querySelector(`.edit-field[data-field="print_file_name"]`)?.focus();
        return;
      }
      fileInserts.push(row);
    }

    if (Object.keys(updates).length === 0 && inserts.length === 0 && fileInserts.length === 0) {
      showToast("No changes to save.", "info");
      catalogEditDirty = false;
      modal.classList.remove("active");
      return;
    }

    saveBtn.disabled = true;
    saveBtn.innerHTML = `<span class="material-symbols-outlined text-sm animate-spin">sync</span> Saving...`;

    try {
      if (!await catalogEditValidateSkus(contentEl, updates, inserts, productId)) return;

      await Promise.all([
        ...Object.values(updates).map(({ table, id, data }) =>
          supabaseClient.from(table).update(data).eq("id", id).throwOnError()
        ),
        ...(inserts.length ? [supabaseClient.from("variants").insert(inserts).throwOnError()] : []),
        ...(fileInserts.length ? [supabaseClient.from("print_files").insert(fileInserts).throwOnError()] : []),
      ]);
      cachedVariants = [];
      catalogEditDirty = false;
      const parts = [];
      if (Object.keys(updates).length) parts.push(`${Object.keys(updates).length} record(s) updated`);
      if (inserts.length) parts.push(`${inserts.length} variant(s) added`);
      if (fileInserts.length) parts.push(`${fileInserts.length} print file(s) added`);
      logAction(`Product edited via editor: ${parts.join(", ")}`, "info", {
        product_id: productId,
        updated: Object.values(updates).map(u => `${u.table}:${Object.keys(u.data).join("|")}`),
        variants_added: inserts.map(r => r.variant_sku),
        files_added: fileInserts.map(r => r.print_file_name),
      });
      showToast(`Saved: ${parts.join(", ")}.`, "success");
      modal.classList.remove("active");
      fetchAndRenderCatalog();
    } catch (err) {
      showToast("Save failed: " + err.message, "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = `<span class="material-symbols-outlined text-sm">save</span> Save Changes`;
    }
  });
}

// Fetch and Render Compiled Master PDFs list
async function fetchAndRenderMasterPDFs() {
  if (!supabaseClient) return;
  const container = document.getElementById("master-pdfs-container");
  if (!container) return;

  try {
    const { data: jobs, error } = await supabaseClient
      .from("waybill_jobs")
      .select("*")
      .eq("job_type", "waybill_batch_print")
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) throw error;

    if (!jobs || jobs.length === 0) {
      container.innerHTML = `
        <div class="text-center text-outline py-12 font-data-mono text-xs">
          No compiled master PDFs found.
        </div>
      `;
      return;
    }

    let html = `
      <table class="w-full text-left border-collapse text-xs font-body-md" id="master-pdfs-table">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant/20 sticky top-0 z-20">
            <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Date Compiled</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Job ID</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Details</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant text-center w-28">Action</th>
          </tr>
        </thead>
        <tbody>
    `;

    jobs.forEach(job => {
      const dateStr = new Date(job.created_at).toLocaleString();
      const resVal = job.result || {};
      const fileUrl = resVal.url || "#";
      const totalOrdersStr = resVal.total_orders !== undefined ? `${resVal.total_orders} orders` : "";
      const totalSheetsStr = resVal.total_sheets !== undefined ? `${resVal.total_sheets} pages` : "";
      const details = [totalOrdersStr, totalSheetsStr].filter(Boolean).join(", ") || "Compiled PDF Batch";

      html += `
        <tr class="border-b border-outline-variant/10 hover:bg-surface-container/20 transition-colors font-data-mono">
          <td class="py-2.5 px-3 border-r border-outline-variant/10 text-on-surface font-medium">${dateStr}</td>
          <td class="py-2.5 px-3 border-r border-outline-variant/10 text-on-surface-variant/70 text-xs">${escapeHtml(job.id)}</td>
          <td class="py-2.5 px-3 border-r border-outline-variant/10 text-on-surface-variant">${escapeHtml(details)}</td>
          <td class="py-2.5 px-3 text-center">
            <a href="${escapeHtml(sanitizeUrl(fileUrl))}" target="_blank" class="px-2.5 py-1 rounded bg-primary/10 hover:bg-primary/20 border border-primary/30 text-primary hover:scale-105 transition-transform flex items-center justify-center gap-1.5 cursor-pointer select-none mx-auto no-underline w-fit">
              <span class="material-symbols-outlined text-[14px]">download</span> Download
            </a>
          </td>
        </tr>
      `;
    });

    html += `
        </tbody>
      </table>
    `;

    container.innerHTML = html;
  } catch (err) {
    console.error("Failed to fetch master PDFs:", err);
    container.innerHTML = `
      <div class="font-data-mono text-xs text-error text-center py-12">
        Error loading compiled master PDFs: ${escapeHtml(err.message)}
      </div>
    `;
  }
}

// ─── Product Launch Tab ───────────────────────────────────────────────────────

let _launchImages = [];
let _launchTabReady = false;

// Launch flow stepper: reflects how far along the launch is.
function setLaunchStep(n) {
  document.querySelectorAll("#launch-stepper .launch-step").forEach(el => {
    const step = Number(el.getAttribute("data-step"));
    el.classList.toggle("done", step < n);
    el.classList.toggle("current", step === n);
  });
}

// Built-in product types. Each type's label doubles as the product category —
// the category sent to the backend is the label of the first selected type.
const LAUNCH_BUILTIN_TYPES = [
  { code: 'DS',    label: 'Display Stand with Nameplate', category: 'Display Stand' },
  { code: 'DS-NP', label: 'Display Stand, No Nameplate',  category: 'Display Stand (No Nameplate)' },
  { code: 'WM',    label: 'Wall Mount',                   category: 'Wall Mount' },
  { code: 'FWM',   label: 'Full Wall Mount',              category: 'Full Wall Mount' },
];

function getCustomLaunchTypes() {
  try { return JSON.parse(localStorage.getItem('orbot_custom_product_types')) || []; }
  catch { return []; }
}

function getAllLaunchTypes() {
  return [...LAUNCH_BUILTIN_TYPES, ...getCustomLaunchTypes()];
}

function renderLaunchTypes() {
  const list = document.getElementById('launch-types-list');
  if (!list) return;
  const checked = new Set([...list.querySelectorAll('input[data-ptype]:checked')].map(cb => cb.dataset.ptype));
  const plaqueVal = document.getElementById('launch-plaque-count')?.value || '1';
  list.innerHTML = getAllLaunchTypes().map(t => `
    <div class="flex items-center justify-between">
      <label class="flex items-center gap-3 cursor-pointer select-none">
        <input type="checkbox" data-ptype="${escapeHtml(t.code)}" ${checked.has(t.code) ? 'checked' : ''} style="accent-color:#3ecf8e" />
        <span class="text-sm text-white font-medium">${escapeHtml(t.code)}</span>
        <span class="text-xs text-[#6b7280]">${escapeHtml(t.label)}</span>
      </label>
      ${t.code === 'DS' ? `
        <div id="launch-plaque-row" class="${checked.has('DS') ? 'flex' : 'hidden'} items-center gap-2">
          <span class="text-xs text-[#9ca3af]">Plaques:</span>
          <input id="launch-plaque-count" type="text" value="${escapeHtml(plaqueVal)}" class="w-14 text-center" style="padding:0.375rem 0.5rem !important" />
        </div>` : ''}
      ${t.custom ? `
        <button data-remove-type="${escapeHtml(t.code)}" class="text-xs text-[#6b7280] hover:text-red-400 transition-colors" title="Remove custom type">
          <span class="material-symbols-outlined" style="font-size:14px">close</span>
        </button>` : ''}
    </div>`).join('');
}

function addCustomLaunchType() {
  const codeEl  = document.getElementById('launch-new-type-code');
  const labelEl = document.getElementById('launch-new-type-label');
  let code    = (codeEl?.value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const label = (labelEl?.value || '').trim();
  if (!label) { setLaunchStatus('error', 'Enter a category name, e.g. Light Kit.'); return; }
  if (!code) {
    // Derive a code from the name: initials for multi-word ("Light Kit" -> LK),
    // first 3 letters for single-word; suffix a number if taken.
    const words = label.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    let base = words.length > 1 ? words.map(w => w[0]).join('') : words[0]?.slice(0, 3) || '';
    if (!base) { setLaunchStatus('error', 'Enter a code (used in SKUs, e.g. LK) for this category.'); return; }
    code = base;
    for (let i = 2; getAllLaunchTypes().some(t => t.code === code); i++) code = `${base}${i}`;
  }
  if (getAllLaunchTypes().some(t => t.code === code)) { setLaunchStatus('error', `Type "${code}" already exists.`); return; }
  const custom = getCustomLaunchTypes();
  custom.push({ code, label, category: label, custom: true });
  localStorage.setItem('orbot_custom_product_types', JSON.stringify(custom));
  codeEl.value = ''; labelEl.value = '';
  renderLaunchTypes();
  document.querySelector(`#launch-types-list input[data-ptype="${code}"]`)?.click();
}

function initLaunchTab() {
  setLaunchStep(1);
  if (_launchTabReady) return;
  _launchTabReady = true;

  renderLaunchImageGrid();
  renderLaunchTypes();

  // Delegated: single-select enforcement; DS checkbox toggles plaque count row; X removes a custom type
  const typesList = document.getElementById('launch-types-list');
  typesList?.addEventListener('change', (e) => {
    if (!e.target.dataset?.ptype) return;
    if (e.target.checked) {
      typesList.querySelectorAll('input[data-ptype]:checked').forEach(cb => {
        if (cb !== e.target) cb.checked = false;
      });
    }
    const ds = typesList.querySelector('input[data-ptype="DS"]');
    const row = document.getElementById('launch-plaque-row');
    row?.classList.toggle('hidden', !ds?.checked);
    row?.classList.toggle('flex', !!ds?.checked);
  });
  typesList?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-type]');
    if (!btn) return;
    const custom = getCustomLaunchTypes().filter(t => t.code !== btn.dataset.removeType);
    localStorage.setItem('orbot_custom_product_types', JSON.stringify(custom));
    renderLaunchTypes();
  });
  document.getElementById('launch-add-type-btn')?.addEventListener('click', addCustomLaunchType);
  document.getElementById('launch-new-type-label')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCustomLaunchType();
  });

  // Image grid: click empty slot → open picker
  document.getElementById('launch-image-grid')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-empty]')) document.getElementById('launch-image-input')?.click();
  });

  // Image grid: drag & drop on the panel
  const panel = document.getElementById('launch-image-panel');
  panel?.addEventListener('dragover', (e) => { e.preventDefault(); panel.style.boxShadow = '0 0 0 1px #3ecf8e'; });
  panel?.addEventListener('dragleave', () => { panel.style.boxShadow = ''; });
  panel?.addEventListener('drop', (e) => {
    e.preventDefault(); panel.style.boxShadow = '';
    addLaunchImages([...e.dataTransfer.files]);
  });

  document.getElementById('launch-image-input')?.addEventListener('change', (e) => {
    addLaunchImages([...e.target.files]);
    e.target.value = '';
  });

  document.getElementById('launch-preview-btn')?.addEventListener('click', doLaunchPreview);
  document.getElementById('launch-download-btn')?.addEventListener('click', doLaunchDownload);
  document.getElementById('launch-regen-ai-btn')?.addEventListener('click', (e) => {
    document.getElementById('launch-listing-title').value = _launchAiTitle || '';
    document.getElementById('launch-description').value = _launchAiDescription || '';
    document.getElementById('launch-copy-source').textContent = '— AI-generated, edit as needed before downloading';
  });

  document.getElementById('launch-scrape-btn')?.addEventListener('click', doLaunchScrape);
  document.getElementById('launch-scrape-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLaunchScrape();
  });
  document.getElementById('launch-clean-btn')?.addEventListener('click', () => {
    const pending = _launchImages.filter(f => !f._cleaned && !f._cleaning);
    if (!pending.length) { setLaunchStatus('error', 'No images to clean — add some first.'); return; }
    setLaunchStatus('success', `Removing logos from ${pending.length} image(s)…`);
    cleanLaunchImages(pending);
  });
}

function renderLaunchImageGrid() {
  const grid = document.getElementById('launch-image-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const MAX = 9;
  _launchImages.forEach((file, i) => {
    const url = URL.createObjectURL(file);
    const slot = document.createElement('div');
    slot.className = 'relative aspect-square rounded-lg overflow-hidden border border-white/10 group cursor-pointer';
    slot.innerHTML = `
      <img src="${url}" class="w-full h-full object-cover" />
      <button class="launch-img-rm absolute top-1 right-1 bg-black/70 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity" data-idx="${i}">
        <span class="material-symbols-outlined text-white" style="font-size:13px">close</span>
      </button>
      <span class="absolute bottom-1 left-1 text-[10px] text-white/50 font-mono bg-black/40 px-1 rounded">${i + 1}</span>
      ${file._cleaning ? `<div class="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-1">
        <span class="material-symbols-outlined text-[#3ecf8e]" style="font-size:18px;animation:spin 1s linear infinite">sync</span>
        <span class="text-[9px] text-white/60">removing logos</span>
      </div>` : ''}
      ${file._cleaned ? `<span class="absolute top-1 left-1 bg-black/60 rounded-full p-0.5" title="Logos removed">
        <span class="material-symbols-outlined text-emerald-400" style="font-size:12px">auto_fix_high</span>
      </span>` : ''}`;
    slot.querySelector('.launch-img-rm').addEventListener('click', (e) => {
      e.stopPropagation();
      _launchImages.splice(parseInt(e.currentTarget.dataset.idx), 1);
      renderLaunchImageGrid();
    });
    grid.appendChild(slot);
  });
  for (let i = _launchImages.length; i < MAX; i++) {
    const slot = document.createElement('div');
    slot.className = 'aspect-square rounded-lg border border-dashed border-white/20 flex items-center justify-center cursor-pointer hover:border-[#3ecf8e]/60 transition-colors';
    slot.setAttribute('data-empty', '');
    slot.innerHTML = `<span class="material-symbols-outlined text-[#4b5563]" style="font-size:20px">add_photo_alternate</span>`;
    grid.appendChild(slot);
  }
}

function addLaunchImages(files) {
  setLaunchStep(2);
  const slots = 9 - _launchImages.length;
  _launchImages = [..._launchImages, ...files.filter(f => f.type.startsWith('image/')).slice(0, slots)];
  renderLaunchImageGrid();
}

// ─── Import from Link (scrape + logo removal) ────────────────────────────────

let _launchSourceUrl = null;
let _launchScrapedDescription = null;

function b64ToFile(b64, name, mime = 'image/jpeg') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function doLaunchScrape() {
  const url = document.getElementById('launch-scrape-url')?.value.trim();
  if (!/^https?:\/\//.test(url || '')) {
    setLaunchStatus('error', 'Paste a full product link (https://…).');
    return;
  }

  const btn = document.getElementById('launch-scrape-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined text-base" style="animation:spin 1s linear infinite">sync</span> Fetching...';
  document.getElementById('launch-status')?.classList.add('hidden');

  try {
    const res = await backendFetch(`/catalog/scrape-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = JSON.parse(await res.text());
    if (!res.ok) throw new Error(data.detail || JSON.stringify(data));

    _launchSourceUrl = data.source_url || url;
    _launchScrapedDescription = data.description || null;

    const setIf = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
    setIf('launch-set-name', data.set_name || data.product_name);
    setIf('launch-set-number', data.set_number);
    setIf('launch-theme', data.theme_code);

    const files = (data.images || []).map((img, i) => {
      const ext = img.format || 'jpg';
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      return b64ToFile(img.image_b64, `scraped_${i + 1}.${ext}`, mime);
    });
    if (files.length) addLaunchImages(files);

    setLaunchStatus('success', `Fetched "${data.product_name}"` +
      (data.note ? `. ${data.note}` : ` — ${files.length} image(s). Removing logos…`));
    logAction('scrape_product', 'info', { url, images: files.length });

    if (files.length) await cleanLaunchImages(files.filter(f => _launchImages.includes(f)));
  } catch (e) {
    setLaunchStatus('error', `Fetch failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined text-base">travel_explore</span> Fetch from Link';
  }
}

// Runs one /catalog/clean-image call per file in parallel; swaps each grid tile
// to the cleaned version as it lands. Files the user removed mid-flight are skipped.
async function cleanLaunchImages(files) {
  let lastReason = null;
  await Promise.all(files.map(async (file) => {
    file._cleaning = true;
    renderLaunchImageGrid();
    try {
      const res = await backendFetch(`/catalog/clean-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: await fileToB64(file) }),
      });
      const data = JSON.parse(await res.text());
      const idx = _launchImages.indexOf(file);
      if (res.ok && data.cleaned && idx !== -1) {
        const cleanedFile = b64ToFile(data.image_b64, file.name.replace(/\.[a-z0-9]+$/i, '') + '_clean.jpg');
        cleanedFile._cleaned = true;
        _launchImages[idx] = cleanedFile;
      } else if (data.reason) {
        lastReason = data.reason;
      }
    } catch (e) {
      console.error('clean-image failed:', e);
      lastReason = e.message;
    } finally {
      file._cleaning = false;
      renderLaunchImageGrid();
    }
  }));
  const cleanedCount = _launchImages.filter(f => f._cleaned).length;
  if (cleanedCount === 0 && files.length > 0) {
    setLaunchStatus('error', `Logo removal failed — images kept as-is. ${lastReason || ''}`);
  } else {
    setLaunchStatus('success', `Logo removal done — ${cleanedCount}/${_launchImages.length} image(s) cleaned. Review images, then Generate.`);
  }
  logAction('clean_images', 'info', { cleaned: cleanedCount, total: _launchImages.length });
}

let _launchVariants = [];
let _launchAiTitle = null;
let _launchAiDescription = null;

const LAUNCH_TYPE_NAMES = { DS: 'Display Stand', 'DS-NP': 'Display Stand', WM: 'Wall Mount', FWM: 'Floating Wall Mount', LK: 'Light Kit' };

// Fills {token} placeholders in a Launch Templates string (Settings > Launch Templates).
// Unknown tokens are left as-is rather than erased, so a typo is visible instead of silently
// producing blank output.
function expandLaunchTemplate(template, ctx) {
  if (!template) return '';
  const typeNames = (ctx.product_types || []).map(t => LAUNCH_TYPE_NAMES[t] || t);
  const variants = ctx.variants || [];
  const tokens = {
    '{variant_types}': typeNames.join(' / ') || '—',
    '{variant_types_lower}': (typeNames.join(' / ') || '—').toLowerCase(),
    '{theme}': ctx.theme || '',
    '{set_name}': ctx.set_name || '',
    '{set_number}': ctx.set_number || '',
    '{brand}': ctx.brand_name || 'Blocked Off',
    '{sku}': variants[0]?.sku || '',
    '{variant_bullets}': variants.map(v => `✅ ${v.sku} — ${v.platform_variation_name}`).join('\n') || '',
  };
  return Object.entries(tokens).reduce((s, [tok, val]) => s.split(tok).join(val), template);
}

// Applies the user's Launch Templates (Settings > Launch Templates) as the default listing
// copy when configured, falling back to the Gemini-generated copy from _launchAiTitle/
// _launchAiDescription otherwise. The "Regenerate with AI" button always restores the AI copy.
function applyLaunchCopy(formData, variants) {
  const titleTpl = localStorage.getItem('orbot_launch_title_template') || '';
  const descTpl = localStorage.getItem('orbot_launch_desc_template') || '';
  const ctx = { ...formData, variants };
  const titleEl = document.getElementById('launch-listing-title');
  const descEl = document.getElementById('launch-description');
  const sourceEl = document.getElementById('launch-copy-source');
  const regenBtn = document.getElementById('launch-regen-ai-btn');
  const usingTemplate = !!(titleTpl || descTpl);

  if (titleEl) titleEl.value = titleTpl ? expandLaunchTemplate(titleTpl, ctx) : (_launchAiTitle || '');
  if (descEl) descEl.value = descTpl ? expandLaunchTemplate(descTpl, ctx) : (_launchAiDescription || '');
  if (sourceEl) sourceEl.textContent = usingTemplate ? '— from your Launch Template, edit as needed' : '— AI-generated, edit as needed before downloading';
  if (regenBtn) regenBtn.classList.toggle('hidden', !usingTemplate);
  regenBtn?.setAttribute('data-ctx', JSON.stringify(ctx));
}

function getLaunchFormData() {
  const types = [...document.querySelectorAll('#launch-types-list input[data-ptype]:checked')].map(cb => cb.dataset.ptype);
  const platforms = [];
  if (document.getElementById('launch-plat-shopee')?.checked) platforms.push('shopee');
  if (document.getElementById('launch-plat-lazada')?.checked) platforms.push('lazada');
  return {
    set_name:         document.getElementById('launch-set-name')?.value.trim(),
    set_number:       document.getElementById('launch-set-number')?.value.trim(),
    theme:            document.getElementById('launch-theme')?.value,
    brand_name:       document.getElementById('launch-brand-name')?.value.trim() || 'Blocked Off',
    product_category: getAllLaunchTypes().find(t => t.code === types[0])?.category || '',
    product_types: types,
    plaque_count: parseInt(document.getElementById('launch-plaque-count')?.value, 10), // NaN when blank; 0 allowed (DS with no plaque)
    price_myr:    priceOrNull(document.getElementById('launch-price')?.value),
    price_sgd:    priceOrNull(document.getElementById('launch-price-sgd')?.value),
    platforms,
  };
}

function setLaunchStatus(type, msg) {
  const el = document.getElementById('launch-status');
  if (!el) return;
  el.className = `glass-panel px-5 py-3 text-sm ${type === 'error' ? 'text-red-400 border border-red-500/20' : 'text-[#3ecf8e]'}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearFieldHighlights() {
  document.querySelectorAll('.field-missing, .field-missing-container').forEach(el => {
    el.classList.remove('field-missing', 'field-missing-container');
  });
}

function highlightMissingFields(missing) {
  clearFieldHighlights();
  const fieldMap = {
    'set name': 'launch-set-name',
    'set number': 'launch-set-number',
    'theme': 'launch-theme',
    'brand name': 'launch-brand-name',
    'price (MYR)': 'launch-price',
    'price (SGD)': 'launch-price-sgd',
  };

  missing.forEach(field => {
    if (fieldMap[field]) {
      const el = document.getElementById(fieldMap[field]);
      if (el) {
        el.classList.add('field-missing');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    if (field === 'product type') {
      const el = document.getElementById('launch-types-list');
      if (el) el.classList.add('field-missing-container');
    }
    if (field === 'plaque count') {
      const el = document.getElementById('launch-plaque-count');
      if (el) el.classList.add('field-missing');
    }
    if (field === 'platform') {
      const checkboxes = document.querySelectorAll('#launch-plat-shopee, #launch-plat-lazada');
      checkboxes.forEach(cb => cb.closest('label')?.classList.add('field-missing'));
    }
    if (field === 'product images') {
      const el = document.getElementById('launch-image-panel');
      if (el) el.classList.add('field-missing-container');
    }
  });
}

async function doLaunchPreview() {
  const { set_name, set_number, theme, brand_name, product_types, plaque_count, price_myr, price_sgd, platforms } = getLaunchFormData();
  const missing = [];
  if (!set_name)                 missing.push('set name');
  if (!set_number)               missing.push('set number');
  if (!theme)                    missing.push('theme');
  if (!brand_name)               missing.push('brand name');
  if (product_types.length === 0) missing.push('product type');
  if (isNaN(plaque_count) || plaque_count < 0) missing.push('plaque count');
  if (price_myr == null)         missing.push('price (MYR)');
  if (price_sgd == null)         missing.push('price (SGD)');
  if (platforms.length === 0)    missing.push('platform');
  if (_launchImages.length === 0) missing.push('product images');
  if (missing.length > 0) {
    setLaunchStatus('error', `Cannot generate preview — missing: ${missing.join(', ')}.`);
    highlightMissingFields(missing);
    return;
  }
  clearFieldHighlights();

  const btn = document.getElementById('launch-preview-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined text-base" style="animation:spin 1s linear infinite">sync</span> Generating...';
  document.getElementById('launch-status')?.classList.add('hidden');

  try {
    const res = await backendFetch(`/catalog/preview-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set_name, set_number, theme, brand_name, product_types, plaque_count, price_myr, platforms }),
    });
    const data = JSON.parse(await res.text());
    if (!res.ok) throw new Error(data.detail || JSON.stringify(data));

    _launchAiTitle = data.listing_title;
    _launchAiDescription = data.description;
    applyLaunchCopy({ set_name, set_number, theme, brand_name, product_types }, data.variants);

    _launchVariants = data.variants;

    const tbody = document.getElementById('launch-variants-body');
    tbody.innerHTML = data.variants.map(v => `
      <tr>
        <td class="py-2 pr-6 text-[#3ecf8e]">${v.sku}</td>
        <td class="py-2 pr-6 text-[#9ca3af]">${v.platform_variation_name}</td>
        <td class="py-2 text-right text-white">${v.price_myr ? 'MYR ' + Number(v.price_myr).toFixed(2) : '—'}</td>
      </tr>`).join('');

    const detailsTbody = document.getElementById('launch-variant-details-body');
    detailsTbody.innerHTML = data.variants.map((v, i) => `
      <tr>
        <td class="py-2 pr-4 text-[#3ecf8e] font-mono text-xs">${v.sku}</td>
        <td class="py-2 pr-3"><input id="lv-${i}-stock" type="number" value="0" min="0" class="w-16 text-center" style="padding:0.25rem 0.375rem !important" /></td>
        <td class="py-2 pr-3"><input id="lv-${i}-seal" type="text" placeholder="https://drive.google.com/…" class="w-full" style="padding:0.25rem 0.5rem !important; font-size:0.7rem" /></td>
        <td class="py-2 pr-3"><input id="lv-${i}-files" type="text" placeholder="https://drive.google.com/…" class="w-full" style="padding:0.25rem 0.5rem !important; font-size:0.7rem" /></td>
        <td class="py-2 pr-3"><input id="lv-${i}-pics" type="text" placeholder="https://drive.google.com/…" class="w-full" style="padding:0.25rem 0.5rem !important; font-size:0.7rem" /></td>
        <td class="py-2"><input id="lv-${i}-adobe" type="text" placeholder="https://express.adobe.com/…" class="w-full" style="padding:0.25rem 0.5rem !important; font-size:0.7rem" /></td>
      </tr>`).join('');

    document.getElementById('launch-preview-section')?.classList.remove('hidden');
    document.getElementById('launch-preview-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setLaunchStep(3);
  } catch (e) {
    setLaunchStatus('error', `Preview failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined text-base">auto_awesome</span> Generate';
  }
}

async function doLaunchDownload() {
  const { set_name, set_number, theme, brand_name, product_category, product_types, plaque_count, price_myr, price_sgd, platforms } = getLaunchFormData();
  const listing_title = document.getElementById('launch-listing-title')?.value.trim();
  const description   = document.getElementById('launch-description')?.value.trim();
  if (!listing_title || !description) { setLaunchStatus('error', 'Run Preview first to generate listing copy.'); return; }

  const variantDetails = _launchVariants.map((v, i) => ({
    sku:                    v.sku,
    stock_quantity:         parseInt(document.getElementById(`lv-${i}-stock`)?.value) || 0,
    seal_sticker_gdrive_url: document.getElementById(`lv-${i}-seal`)?.value.trim() || null,
    print_files_gdrive_url:  document.getElementById(`lv-${i}-files`)?.value.trim() || null,
    pictures_gdrive_url:     document.getElementById(`lv-${i}-pics`)?.value.trim() || null,
    adobe_express_url:       document.getElementById(`lv-${i}-adobe`)?.value.trim() || null,
  }));

  const btn = document.getElementById('launch-download-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined text-base" style="animation:spin 1s linear infinite">sync</span> Building package...';
  document.getElementById('launch-status')?.classList.add('hidden');

  try {
    const fd = new FormData();
    fd.append('set_name', set_name);
    fd.append('set_number', set_number);
    fd.append('theme', theme);
    fd.append('brand_name', brand_name);
    fd.append('product_category', product_category);
    fd.append('product_types', JSON.stringify(product_types));
    fd.append('plaque_count', plaque_count);
    if (price_myr) fd.append('price_myr', price_myr);
    if (price_sgd) fd.append('price_sgd', price_sgd);
    fd.append('platforms', JSON.stringify(platforms));
    fd.append('listing_title', listing_title);
    fd.append('description', description);
    fd.append('variant_details', JSON.stringify(variantDetails));
    fd.append('shopee_my', document.getElementById('launch-shopee-my')?.value.trim() || '');
    fd.append('shopee_sg', document.getElementById('launch-shopee-sg')?.value.trim() || '');
    fd.append('shopee_ph', document.getElementById('launch-shopee-ph')?.value.trim() || '');
    fd.append('shopee_th', document.getElementById('launch-shopee-th')?.value.trim() || '');
    fd.append('lazada_my', document.getElementById('launch-lazada-my')?.value.trim() || '');
    if (_launchSourceUrl) fd.append('source_url', _launchSourceUrl);
    if (_launchScrapedDescription) fd.append('source_description', _launchScrapedDescription);
    _launchImages.forEach(f => fd.append('images', f));

    const res = await backendFetch(`/catalog/launch-product`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    const cd = res.headers.get('content-disposition') || '';
    a.download = cd.match(/filename=([^\s;]+)/)?.[1] || `launch_${set_number}.zip`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setLaunchStatus('success', `Done. ${product_types.length} variant type(s) inserted into DB. Package downloaded.`);
    setLaunchStep(4);
    logAction('launch_product', "info", { master_sku: `BLO-${theme}-${set_number}`, product_types, platforms });
  } catch (e) {
    setLaunchStatus('error', `Launch failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined text-base">download</span> Download Launch Package';
  }
}

// ─── LISTINGS PAGE ────────────────────────────────────────────────────────────

const LISTING_PLATFORMS = [
  { key: "shopee_my", label: "Shopee MY", color: "#ee4d2d", url: "https://shopee.com.my" },
  { key: "shopee_sg", label: "Shopee SG", color: "#ee4d2d", url: "https://shopee.sg" },
  { key: "shopee_ph", label: "Shopee PH", color: "#ee4d2d", url: "https://shopee.ph" },
  { key: "shopee_th", label: "Shopee TH", color: "#ee4d2d", url: "https://shopee.co.th" },
  { key: "lazada_my", label: "Lazada MY", color: "#1a56f0", url: "https://www.lazada.com.my" },
];

function relativeTime(isoStr) {
  if (!isoStr) return "—";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoStr).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

async function fetchAndRenderListings(useCache = false) {
  if (!supabaseClient) return;
  const tbody = document.getElementById("listings-tbody");
  if (!tbody) return;

  if (!useCache || cachedListings.length === 0) {
    tbody.innerHTML = loadingDiv();
    try {
      let allListings = [];
      let start = 0;
      while (true) {
        const { data, error } = await supabaseClient
          .from("listings")
          .select("*, products(id, master_sku, product_base_name, brand_name, shop_id), listing_variations(*, variants(id, variant_sku, variant_type))")
          .order("platform_listing_name", { ascending: true })
          .range(start, start + 999);
        if (error) throw error;
        allListings = allListings.concat(data || []);
        if ((data || []).length < 1000) break;
        start += 1000;
      }
      cachedListings = allListings;
      // Products master-detail cross-links catalog rows against cachedListings
      // (platform coverage dots, price, unmapped-variation warnings). Since this
      // fetch runs in parallel with fetchAndRenderCatalog() when the Products tab
      // opens, refresh the catalog list now that listings have actually arrived.
      if (currentTab === "products" && cachedVariants.length > 0) fetchAndRenderCatalog();
    } catch (err) {
      tbody.innerHTML = emptyDiv(`Error loading listings: ${escapeHtml(err.message)}`, "error");
      return;
    }
  }

  renderListingsFromCache();
}

function renderListingsFromCache() {
  const tbody = document.getElementById("listings-tbody");
  if (!tbody) return;
  const searchVal = (document.getElementById("listings-search")?.value || "").toLowerCase().trim();
  const countEl = document.getElementById("listings-count-display");
  const statsEl = document.getElementById("listings-stats-bar");

  const headerCountEl = document.getElementById("listings-collapse-count");
  if (headerCountEl) headerCountEl.textContent = `(${cachedListings.length})`;

  let filtered = [...cachedListings];

  // Active shop scope (header switcher)
  filtered = filtered.filter(l => passesShopScope(l.products?.shop_id));

  if (listingsActiveFilter === "active")   filtered = filtered.filter(l => l.is_active);
  if (listingsActiveFilter === "inactive") filtered = filtered.filter(l => !l.is_active);
  if (listingsPlatformFilter !== "all")    filtered = filtered.filter(l => !!l[listingsPlatformFilter]);
  if (listingsMissingFilter !== "all")     filtered = filtered.filter(l => !l[listingsMissingFilter]);

  if (searchVal) {
    filtered = filtered.filter(l =>
      (l.platform_listing_name || "").toLowerCase().includes(searchVal) ||
      (l.products?.master_sku || "").toLowerCase().includes(searchVal) ||
      (l.products?.product_base_name || "").toLowerCase().includes(searchVal)
    );
  }

  filtered.sort((a, b) => {
    switch (listingsSortOrder) {
      case "name_desc":      return (b.platform_listing_name || "").localeCompare(a.platform_listing_name || "");
      case "price_myr_asc":  return (a.price_myr || 0) - (b.price_myr || 0);
      case "price_myr_desc": return (b.price_myr || 0) - (a.price_myr || 0);
      case "vars_desc":      return (b.listing_variations?.length || 0) - (a.listing_variations?.length || 0);
      case "updated_desc":   return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
      default:               return (a.platform_listing_name || "").localeCompare(b.platform_listing_name || "");
    }
  });

  if (countEl) countEl.textContent = `${filtered.length} listing${filtered.length !== 1 ? "s" : ""}`;

  if (statsEl && cachedListings.length > 0) {
    const total = cachedListings.length;
    const active = cachedListings.filter(l => l.is_active).length;
    const fullCoverage = cachedListings.filter(l => LISTING_PLATFORMS.every(p => !!l[p.key])).length;
    const unmappedVars = cachedListings.reduce((s, l) => s + (l.listing_variations || []).filter(v => !v.variant_id).length, 0);
    statsEl.innerHTML =
      `<span class="font-data-mono text-[10px] text-outline/60">${total} total</span>` +
      `<span class="text-outline/20 mx-1">·</span>` +
      `<span class="font-data-mono text-[10px] text-primary">${active} active</span>` +
      `<span class="text-outline/20 mx-1">·</span>` +
      `<span class="font-data-mono text-[10px] text-on-surface-variant">${fullCoverage} on all 5 platforms</span>` +
      (unmappedVars > 0 ? `<span class="text-outline/20 mx-1">·</span><span class="font-data-mono text-[10px] text-error">⚠ ${unmappedVars} unmapped variation${unmappedVars !== 1 ? "s" : ""}</span>` : "");
  }

  if (filtered.length === 0) {
    tbody.innerHTML = emptyDiv("No listings found.", "storefront", `<button class="empty-action" onclick="document.getElementById('add-listing-header-btn')?.click()"><span class="material-symbols-outlined">storefront</span>Add Listing</button>`);
    return;
  }

  tbody.innerHTML = filtered.map(l => {
    const vars = l.listing_variations || [];
    const unmappedVars = vars.filter(v => !v.variant_id).length;

    const platformCount = LISTING_PLATFORMS.filter(p => !!l[p.key]).length;
    const coverageColor = platformCount === 5 ? "#3ecf8e" : platformCount >= 3 ? "#eab308" : "#ef4444";

    const platformDots = LISTING_PLATFORMS.map(p =>
      `<div class="w-2 h-2 rounded-full flex-shrink-0" style="background:${l[p.key] ? p.color : "rgba(100,116,139,0.2)"}" title="${p.label}: ${l[p.key] ? escapeHtml(l[p.key]) : "not listed"}"></div>`
    ).join("");

    let varBadge;
    if (vars.length === 0) {
      varBadge = `<span class="font-data-mono text-[9px] px-1.5 py-0.5 rounded bg-outline/10 text-outline/50 border border-outline/20">0 vars</span>`;
    } else if (unmappedVars === 0) {
      varBadge = `<span class="font-data-mono text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">✓ ${vars.length} var${vars.length !== 1 ? "s" : ""}</span>`;
    } else {
      varBadge = `<span class="font-data-mono text-[9px] px-1.5 py-0.5 rounded bg-error/10 text-error border border-error/20">⚠ ${unmappedVars} unlinked</span>`;
    }

    const platformIdCards = LISTING_PLATFORMS.map(p => {
      const id = l[p.key];
      if (!id) return `<div class="flex items-center gap-2 bg-black/20 px-3 py-2 rounded-lg border border-outline-variant/10 opacity-40">
        <span class="font-data-mono text-[10px] flex-shrink-0" style="color:${p.color}">${p.label}</span>
        <span class="font-data-mono text-[10px] text-outline/40 flex-1">not listed</span>
      </div>`;
      return `<div class="flex items-center gap-2 bg-black/20 hover:bg-black/30 px-3 py-2 rounded-lg border border-outline-variant/15 transition-all group">
        <span class="font-data-mono text-[10px] font-semibold flex-shrink-0" style="color:${p.color}">${p.label}</span>
        <span class="font-data-mono text-[11px] text-on-surface-variant flex-1 select-all">${escapeHtml(id)}</span>
        <button class="btn-copy-platform-id opacity-0 group-hover:opacity-100 p-0.5 rounded text-outline/60 hover:text-primary transition-all" data-id="${escapeHtml(id)}" data-label="${escapeHtml(p.label)}" type="button" title="Copy ${p.label} ID">
          <span class="material-symbols-outlined text-[14px] pointer-events-none">content_copy</span>
        </button>
        <a href="${p.url}" target="_blank" rel="noopener noreferrer" class="opacity-0 group-hover:opacity-100 p-0.5 rounded text-outline/60 hover:text-[#3ecf8e] transition-all" title="Open ${p.label}" onclick="event.stopPropagation()">
          <span class="material-symbols-outlined text-[14px]">open_in_new</span>
        </a>
      </div>`;
    }).join("");

    const desc = l.platform_listing_description || "";
    const descSection = desc ? `
      <div>
        <div class="flex items-center justify-between mb-2">
          <span class="font-data-mono text-[9px] text-outline/60 uppercase tracking-wider">Description</span>
          <button class="btn-copy-description flex items-center gap-1 font-data-mono text-[10px] text-outline/50 hover:text-primary transition-colors" data-description="${escapeHtml(desc)}" type="button">
            <span class="material-symbols-outlined text-[13px] pointer-events-none">content_copy</span> Copy
          </button>
        </div>
        <div class="font-data-mono text-[10px] text-on-surface-variant/70 bg-black/20 rounded-lg p-3 border border-outline-variant/10 whitespace-pre-line max-h-28 overflow-y-auto leading-relaxed">${escapeHtml(desc.slice(0, 500))}${desc.length > 500 ? "…" : ""}</div>
      </div>` : "";

    const varRows = vars.length > 0
      ? vars.map(v => {
          const sku = v.variants?.variant_sku || "—";
          const vtype = v.variants?.variant_type || "";
          let typePill = "";
          if (vtype === "DS")       typePill = `<span class="font-data-mono text-[9px] px-1.5 py-0.5 rounded bg-[#7ea6e8]/10 text-[#7ea6e8] border border-[#7ea6e8]/20">DS</span>`;
          else if (vtype === "WM")  typePill = `<span class="font-data-mono text-[9px] px-1.5 py-0.5 rounded bg-[#ffaa6b]/10 text-[#ffaa6b] border border-[#ffaa6b]/20">WM</span>`;
          else if (vtype === "FWM") typePill = `<span class="font-data-mono text-[9px] px-1.5 py-0.5 rounded bg-[#ff8c00]/10 text-[#ff8c00] border border-[#ff8c00]/20">FWM</span>`;
          else if (vtype)           typePill = `<span class="font-data-mono text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-outline border border-outline-variant/20">${escapeHtml(vtype)}</span>`;
          const mappedIcon = v.variant_id
            ? `<span class="material-symbols-outlined text-[13px] text-primary" title="Mapped">check_circle</span>`
            : `<span class="material-symbols-outlined text-[13px] text-error" title="No variant linked">error</span>`;
          return `<tr class="hover:bg-primary/[0.025] transition-colors border-b border-outline-variant/[0.06] last:border-0">
            <td class="py-2 px-3 w-6">${mappedIcon}</td>
            <td class="py-2 px-3 font-data-mono text-[11px] text-on-surface-variant">${escapeHtml(v.platform_variation_name || "—")}</td>
            <td class="py-2 px-3 font-data-mono text-[10px] text-outline/80">${escapeHtml(v.normalized_variation_name || "—")}</td>
            <td class="py-2 px-3 font-data-mono text-[10px] text-[#ebb2ff]">${escapeHtml(sku)}</td>
            <td class="py-2 px-3">${typePill}</td>
            <td class="py-2 px-3 text-right">
              <button class="btn-edit-variation p-1 rounded hover:bg-primary/10 text-outline/50 hover:text-primary transition-all active:scale-90"
                data-variation-id="${v.id}"
                data-platform-name="${escapeHtml(v.platform_variation_name || "")}"
                data-normalized="${escapeHtml(v.normalized_variation_name || "")}"
                data-variant-id="${v.variant_id || ""}"
                data-variant-sku="${escapeHtml(sku)}"
                type="button" title="Edit variation">
                <span class="material-symbols-outlined text-sm pointer-events-none">edit</span>
              </button>
            </td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="6" class="py-3 px-3 text-center font-data-mono text-[10px] text-outline/40 italic">No variations mapped</td></tr>`;

    return `<div class="glass-panel rounded-xl overflow-hidden transition-all duration-300 listing-card" data-listing-id="${l.id}">
      <div class="listing-card-header flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors" data-listing-id="${l.id}">
        <span class="flex-shrink-0 font-data-mono text-[9px] font-bold py-0.5 px-2 rounded-full border ${l.is_active ? "bg-primary/10 text-primary border-primary/30" : "bg-white/5 text-outline/50 border-outline-variant/20"}">${l.is_active ? "ACTIVE" : "OFF"}</span>
        <div class="flex-1 min-w-0">
          <div class="font-data-mono text-[10px] text-outline/60 mb-0.5">${escapeHtml(l.products?.master_sku || "")}</div>
          <div class="text-sm font-medium text-on-surface truncate" title="${escapeHtml(l.platform_listing_name)}">${escapeHtml(l.platform_listing_name)}</div>
        </div>
        <div class="hidden sm:flex items-center gap-1.5 flex-shrink-0">
          ${platformDots}
          <span class="font-data-mono text-[10px] ml-0.5" style="color:${coverageColor}">${platformCount}/5</span>
        </div>
        <div class="hidden md:flex flex-col items-end flex-shrink-0 min-w-[90px]">
          <span class="font-data-mono text-xs font-semibold text-on-surface">MYR ${l.price_myr != null ? Number(l.price_myr).toFixed(2) : "—"}</span>
          <span class="font-data-mono text-[10px] text-outline">SGD ${l.price_sgd != null ? Number(l.price_sgd).toFixed(2) : "—"}</span>
        </div>
        <div class="hidden lg:block flex-shrink-0">${varBadge}</div>
        <button class="btn-edit-listing flex-shrink-0 p-1.5 rounded-lg hover:bg-primary/10 text-outline/50 hover:text-primary transition-all active:scale-90" data-listing-id="${l.id}" type="button" title="Edit listing">
          <span class="material-symbols-outlined text-sm pointer-events-none">edit</span>
        </button>
        <span class="material-symbols-outlined text-outline/50 text-lg transition-transform duration-200 toggle-arrow flex-shrink-0">expand_more</span>
      </div>

      <div class="listing-card-body hidden border-t border-outline-variant/10 px-4 py-4 flex flex-col gap-4">
        <!-- Pricing + meta -->
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-3 bg-black/20 rounded-lg px-4 py-2 border border-outline-variant/10">
            <div class="flex flex-col items-center">
              <span class="font-data-mono text-[9px] text-outline/50 uppercase tracking-wider">MYR</span>
              <span class="font-data-mono text-base font-semibold text-on-surface">${l.price_myr != null ? Number(l.price_myr).toFixed(2) : "—"}</span>
            </div>
            <div class="h-8 w-px bg-outline-variant/20"></div>
            <div class="flex flex-col items-center">
              <span class="font-data-mono text-[9px] text-outline/50 uppercase tracking-wider">SGD</span>
              <span class="font-data-mono text-base font-semibold text-on-surface">${l.price_sgd != null ? Number(l.price_sgd).toFixed(2) : "—"}</span>
            </div>
          </div>
          <span class="font-data-mono text-[10px] text-outline/50">Updated ${relativeTime(l.updated_at)}</span>
          <div class="ml-auto">${varBadge}</div>
        </div>

        <!-- Platform IDs -->
        <div>
          <div class="font-data-mono text-[9px] text-outline/60 uppercase tracking-wider mb-2">Platform IDs <span class="normal-case text-outline/30">(hover to copy or open)</span></div>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">${platformIdCards}</div>
        </div>

        ${descSection}

        <!-- Variations -->
        <div>
          <div class="font-data-mono text-[9px] text-outline/60 uppercase tracking-wider mb-1.5">Variations (${vars.length})</div>
          <div class="bg-black/15 rounded-lg border border-outline-variant/10 overflow-hidden">
            <table class="w-full text-left">
              <thead>
                <tr class="border-b border-outline-variant/10">
                  <th class="py-2 px-3 w-6"></th>
                  <th class="font-data-mono text-[9px] text-outline/60 uppercase tracking-wider py-2 px-3">Platform Name</th>
                  <th class="font-data-mono text-[9px] text-outline/60 uppercase tracking-wider py-2 px-3">Normalized</th>
                  <th class="font-data-mono text-[9px] text-outline/60 uppercase tracking-wider py-2 px-3">Variant SKU</th>
                  <th class="font-data-mono text-[9px] text-outline/60 uppercase tracking-wider py-2 px-3">Type</th>
                  <th class="py-2 px-3"></th>
                </tr>
              </thead>
              <tbody>${varRows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
  }).join("");
}

function setupListingsTab() {
  document.getElementById("listings-search")?.addEventListener("input", debounce(() => renderListingsFromCache(), 200));

  document.querySelectorAll(".listings-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".listings-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      listingsActiveFilter = btn.dataset.filter;
      renderListingsFromCache();
    });
  });

  document.querySelectorAll(".listings-platform-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".listings-platform-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      listingsPlatformFilter = btn.dataset.platform;
      renderListingsFromCache();
    });
  });

  document.getElementById("listings-sort")?.addEventListener("change", e => {
    listingsSortOrder = e.target.value;
    renderListingsFromCache();
  });

  document.getElementById("listings-missing-filter")?.addEventListener("change", e => {
    listingsMissingFilter = e.target.value;
    renderListingsFromCache();
  });

  const tbody = document.getElementById("listings-tbody");
  if (tbody) {
    tbody.addEventListener("click", e => {
      const copyPlatformBtn = e.target.closest(".btn-copy-platform-id");
      if (copyPlatformBtn) {
        e.stopPropagation();
        navigator.clipboard.writeText(copyPlatformBtn.dataset.id).then(() =>
          showToast(`${copyPlatformBtn.dataset.label} ID copied`, "info")
        );
        return;
      }
      const copyDescBtn = e.target.closest(".btn-copy-description");
      if (copyDescBtn) {
        e.stopPropagation();
        navigator.clipboard.writeText(copyDescBtn.dataset.description).then(() =>
          showToast("Description copied", "success")
        );
        return;
      }
      const editListingBtn = e.target.closest(".btn-edit-listing");
      if (editListingBtn) {
        e.stopPropagation();
        const listing = cachedListings.find(l => l.id === editListingBtn.dataset.listingId);
        if (listing) openEditListingModal(listing);
        return;
      }
      const editVarBtn = e.target.closest(".btn-edit-variation");
      if (editVarBtn) {
        e.stopPropagation();
        openEditVariationModal(editVarBtn.dataset);
        return;
      }
      const header = e.target.closest(".listing-card-header");
      if (header) {
        const card = header.closest(".listing-card");
        const body = card?.querySelector(".listing-card-body");
        const arrow = card?.querySelector(".toggle-arrow");
        if (body) {
          body.classList.toggle("hidden");
          if (arrow) arrow.style.transform = body.classList.contains("hidden") ? "" : "rotate(180deg)";
        }
      }
    });
  }

  document.getElementById("edit-listing-close-btn")?.addEventListener("click", closeEditListingModal);
  document.getElementById("edit-listing-cancel-btn")?.addEventListener("click", closeEditListingModal);
  document.getElementById("edit-listing-save-btn")?.addEventListener("click", saveEditListing);
  document.getElementById("edit-listing-modal")?.addEventListener("click", e => { if (e.target === e.currentTarget) closeEditListingModal(); });

  document.getElementById("edit-variation-close-btn")?.addEventListener("click", closeEditVariationModal);
  document.getElementById("edit-variation-cancel-btn")?.addEventListener("click", closeEditVariationModal);
  document.getElementById("edit-variation-save-btn")?.addEventListener("click", saveEditVariation);
  document.getElementById("edit-variation-delete-btn")?.addEventListener("click", deleteEditVariation);
  document.getElementById("edit-variation-modal")?.addEventListener("click", e => { if (e.target === e.currentTarget) closeEditVariationModal(); });

  document.getElementById("btn-add-listing")?.addEventListener("click", openAddListingModal);
  document.getElementById("add-listing-close-btn")?.addEventListener("click", closeAddListingModal);
  document.getElementById("add-listing-cancel-btn")?.addEventListener("click", closeAddListingModal);
  document.getElementById("add-listing-save-btn")?.addEventListener("click", saveAddListing);
  document.getElementById("add-listing-modal")?.addEventListener("click", e => { if (e.target === e.currentTarget) closeAddListingModal(); });
  document.getElementById("add-listing-product-filter")?.addEventListener("input", e => filterAddListingProducts(e.target.value));
  document.getElementById("edit-listing-product-filter")?.addEventListener("input", e => filterProductSelect("edit-listing-product-id", e.target.value));
}

async function openEditListingModal(listing) {
  await populateProductSelect("edit-listing-product-id");
  const filterEl = document.getElementById("edit-listing-product-filter");
  if (filterEl) filterEl.value = "";
  filterProductSelect("edit-listing-product-id", "");
  const sel = document.getElementById("edit-listing-product-id");
  if (sel) sel.value = listing.products?.id || listing.product_id || "";

  document.getElementById("edit-listing-id").value          = listing.id;
  document.getElementById("edit-listing-name").value        = listing.platform_listing_name || "";
  document.getElementById("edit-listing-description").value = listing.platform_listing_description || "";
  document.getElementById("edit-listing-price-myr").value   = listing.price_myr ?? "";
  document.getElementById("edit-listing-price-sgd").value   = listing.price_sgd ?? "";
  document.getElementById("edit-listing-shopee-my").value   = listing.shopee_my || "";
  document.getElementById("edit-listing-shopee-sg").value   = listing.shopee_sg || "";
  document.getElementById("edit-listing-shopee-ph").value   = listing.shopee_ph || "";
  document.getElementById("edit-listing-shopee-th").value   = listing.shopee_th || "";
  document.getElementById("edit-listing-lazada-my").value   = listing.lazada_my || "";
  document.getElementById("edit-listing-is-active").checked = !!listing.is_active;
  document.getElementById("edit-listing-modal").classList.add("active");
}

function closeEditListingModal() {
  document.getElementById("edit-listing-modal").classList.remove("active");
}

async function saveEditListing() {
  if (!supabaseClient) return;
  const id = document.getElementById("edit-listing-id").value;
  const productId = document.getElementById("edit-listing-product-id")?.value || "";
  if (!productId) { showToast("Select a product first.", "error"); return; }
  const saveBtn = document.getElementById("edit-listing-save-btn");
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span class="material-symbols-outlined text-sm animate-spin">sync</span> Saving…`;

  const updates = {
    product_id:                    productId,
    platform_listing_name:        document.getElementById("edit-listing-name").value.trim(),
    platform_listing_description: document.getElementById("edit-listing-description").value,
    price_myr:   priceOrNull(document.getElementById("edit-listing-price-myr").value),
    price_sgd:   priceOrNull(document.getElementById("edit-listing-price-sgd").value),
    shopee_my:   document.getElementById("edit-listing-shopee-my").value.trim() || null,
    shopee_sg:   document.getElementById("edit-listing-shopee-sg").value.trim() || null,
    shopee_ph:   document.getElementById("edit-listing-shopee-ph").value.trim() || null,
    shopee_th:   document.getElementById("edit-listing-shopee-th").value.trim() || null,
    lazada_my:   document.getElementById("edit-listing-lazada-my").value.trim() || null,
    is_active:   document.getElementById("edit-listing-is-active").checked,
    updated_at:  new Date().toISOString(),
  };

  try {
    const { error } = await supabaseClient.from("listings").update(updates).eq("id", id);
    if (error) throw error;
    const idx = cachedListings.findIndex(l => l.id === id);
    if (idx !== -1) {
      const linkedProduct = cachedProducts.find(p => p.id === productId) || cachedListings[idx].products;
      cachedListings[idx] = { ...cachedListings[idx], ...updates, products: linkedProduct };
    }
    closeEditListingModal();
    renderListingsFromCache();
    logAction(`Listing updated: ${updates.platform_listing_name}`, "info", { listing_id: id, product_id: productId });
    showToast("Listing saved.", "success");
  } catch (err) {
    showToast(`Save failed: ${err.message}`, "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = `<span class="material-symbols-outlined text-sm">save</span> Save Changes`;
  }
}

// dataset.variationId present => edit that existing row.
// dataset.listingId present (no variationId) => add a brand-new mapping row to that listing.
async function openEditVariationModal(dataset) {
  const isNew = !dataset.variationId;
  document.getElementById("edit-variation-id").value             = dataset.variationId || "";
  document.getElementById("edit-variation-listing-id").value     = dataset.listingId || "";
  document.getElementById("edit-variation-platform-name").value  = dataset.platformName || "";
  document.getElementById("edit-variation-normalized-name").value = dataset.normalized || "";
  document.getElementById("edit-variation-modal-title").textContent = isNew ? "Add Variation" : "Edit Variation";

  const variantSelect = document.getElementById("edit-variation-variant-id");
  if (variantSelect.options.length <= 1) {
    let variants = cachedVariants;
    if (variants.length === 0 && supabaseClient) {
      const { data } = await supabaseClient
        .from("variants")
        .select("id, variant_sku, variant_type")
        .order("variant_sku", { ascending: true });
      variants = data || [];
    }
    variants.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = `${v.variant_sku} (${v.variant_type})`;
      variantSelect.appendChild(opt);
    });
  }
  variantSelect.value = dataset.variantId || "";
  // Remember the original link so save can stamp match_source='manual' only
  // when a human actually re-points the variation at a different variant.
  variantSelect.dataset.original = dataset.variantId || "";

  document.getElementById("edit-variation-delete-btn")?.classList.toggle("hidden", isNew);

  document.getElementById("edit-variation-modal").classList.add("active");
}

function closeEditVariationModal() {
  document.getElementById("edit-variation-modal").classList.remove("active");
}

// Delete a listing variation mapping from the edit modal. Orders already matched
// through it keep their variant links; only future Stage-1 matching is affected.
async function deleteEditVariation() {
  if (!supabaseClient) return;
  const id = document.getElementById("edit-variation-id").value;
  if (!id) return;
  const name = document.getElementById("edit-variation-platform-name").value.trim();

  const ok = await showConfirmModal(
    "Delete Mapping",
    `Delete the variation mapping "${name || "(unnamed)"}"? Scout will no longer exact-match incoming orders with this variation text — they'll fall through to fuzzy matching.`,
    "Delete"
  );
  if (!ok) return;

  try {
    const { error } = await supabaseClient.from("listing_variations").delete().eq("id", id);
    if (error) throw error;

    for (const l of cachedListings) {
      if (l.listing_variations) l.listing_variations = l.listing_variations.filter(v => v.id !== id);
    }
    logAction(`Listing variation mapping deleted: ${name}`, "warning", { listing_variation_id: id });
    closeEditVariationModal();
    renderListingsFromCache();
    if (selectedProductId) {
      const product = (lastRenderedProductsList || []).find(p => p.id === selectedProductId);
      if (product) {
        const panel = document.getElementById("product-detail-panel");
        if (panel) {
          panel.innerHTML = buildProductDetailPanel(product);
          bindProductDetailPanelEvents(product);
        }
      }
    }
    showToast("Mapping deleted.", "success");
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, "error");
  }
}

async function saveEditVariation() {
  if (!supabaseClient) return;
  const id = document.getElementById("edit-variation-id").value;
  const listingId = document.getElementById("edit-variation-listing-id").value;
  const saveBtn = document.getElementById("edit-variation-save-btn");
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span class="material-symbols-outlined text-sm animate-spin">sync</span> Saving…`;

  const variantId = document.getElementById("edit-variation-variant-id").value || null;
  const platformName = document.getElementById("edit-variation-platform-name").value.trim();
  const normalizedName = document.getElementById("edit-variation-normalized-name").value.trim();

  try {
    let savedRow;
    if (id) {
      const updates = {
        platform_variation_name:   platformName,
        normalized_variation_name: normalizedName,
        variant_id:  variantId,
        updated_at:  new Date().toISOString(),
      };
      // A human re-pointing the link overrides Scout's recorded provenance.
      const originalVariantId = document.getElementById("edit-variation-variant-id").dataset.original || null;
      if (variantId !== originalVariantId) updates.match_source = "manual";
      const { data, error } = await supabaseClient.from("listing_variations").update(updates).eq("id", id).select().single();
      if (error) throw error;
      savedRow = data;

      for (const l of cachedListings) {
        if (!l.listing_variations) continue;
        const vidx = l.listing_variations.findIndex(v => v.id === id);
        if (vidx === -1) continue;
        l.listing_variations[vidx] = { ...l.listing_variations[vidx], ...updates };
        if (variantId) {
          const src = cachedVariants.find(v => v.id === variantId);
          if (src) l.listing_variations[vidx].variants = { id: src.id, variant_sku: src.variant_sku, variant_type: src.variant_type };
        } else {
          l.listing_variations[vidx].variants = null;
        }
        break;
      }
    } else {
      if (!listingId) throw new Error("No listing selected for this new mapping.");
      const listing = cachedListings.find(l => l.id === listingId);
      const insertData = {
        listing_id: listingId,
        platform_variation_name:   platformName,
        normalized_variation_name: normalizedName,
        variant_id: variantId,
        reference_name: `${listing?.platform_listing_name || ""} [${platformName || "Base"}]`,
        match_source: "manual",
      };
      const { data, error } = await supabaseClient.from("listing_variations").insert(insertData).select().single();
      if (error) throw error;
      savedRow = data;

      if (listing) {
        if (variantId) {
          const src = cachedVariants.find(v => v.id === variantId);
          if (src) savedRow.variants = { id: src.id, variant_sku: src.variant_sku, variant_type: src.variant_type };
        }
        listing.listing_variations = [...(listing.listing_variations || []), savedRow];
      }
    }

    closeEditVariationModal();
    renderListingsFromCache();
    if (selectedProductId) {
      const product = (lastRenderedProductsList || []).find(p => p.id === selectedProductId);
      if (product) {
        const panel = document.getElementById("product-detail-panel");
        if (panel) {
          panel.innerHTML = buildProductDetailPanel(product);
          bindProductDetailPanelEvents(product);
        }
      }
    }
    logAction(`Listing variation ${id ? "updated" : "added"}: ${platformName || "(unnamed)"}`, "info", { listing_variation_id: savedRow?.id, variant_id: variantId });
    showToast("Variation saved.", "success");
  } catch (err) {
    showToast(`Save failed: ${err.message}`, "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = `<span class="material-symbols-outlined text-sm">save</span> Save`;
  }
}

// Shared by the Add Listing and Edit Listing product pickers — populates a
// <select> with every catalog product once (options persist across re-opens).
async function populateProductSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel || sel.options.length > 0) return;
  if (cachedProducts.length === 0 && supabaseClient) {
    const { data } = await supabaseClient
      .from("products")
      .select("id, master_sku, product_base_name, brand_name")
      .order("master_sku", { ascending: true });
    cachedProducts = data || [];
  }
  cachedProducts.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.master_sku} — ${p.product_base_name}`;
    opt.dataset.search = `${p.master_sku} ${p.product_base_name} ${p.brand_name || ""}`.toLowerCase();
    sel.appendChild(opt);
  });
}

function filterProductSelect(selectId, query) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const q = query.toLowerCase().trim();
  Array.from(sel.options).forEach(opt => {
    opt.style.display = !q || (opt.dataset.search || "").includes(q) ? "" : "none";
  });
}

async function openAddListingModal() {
  await populateProductSelect("add-listing-product-id");
  // Reset all fields
  ["add-listing-name", "add-listing-description", "add-listing-price-myr", "add-listing-price-sgd",
   "add-listing-shopee-my", "add-listing-shopee-sg", "add-listing-shopee-ph", "add-listing-shopee-th",
   "add-listing-lazada-my"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  document.getElementById("add-listing-is-active").checked = true;
  const filterEl = document.getElementById("add-listing-product-filter");
  if (filterEl) filterEl.value = "";
  filterAddListingProducts("");
  const sel = document.getElementById("add-listing-product-id");
  if (sel) sel.selectedIndex = -1;
  document.getElementById("add-listing-modal").classList.add("active");
}

function filterAddListingProducts(query) {
  filterProductSelect("add-listing-product-id", query);
}

function closeAddListingModal() {
  document.getElementById("add-listing-modal").classList.remove("active");
}

async function saveAddListing() {
  if (!supabaseClient) return;
  const sel = document.getElementById("add-listing-product-id");
  const productId = sel?.value || "";
  const name = document.getElementById("add-listing-name").value.trim();
  if (!productId) { showToast("Select a product first.", "error"); return; }
  if (!name)      { showToast("Listing name is required.", "error"); return; }

  const saveBtn = document.getElementById("add-listing-save-btn");
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span class="material-symbols-outlined text-sm animate-spin">sync</span> Saving…`;

  const now = new Date().toISOString();
  const payload = {
    product_id:                   productId,
    platform_listing_name:        name,
    platform_listing_description: document.getElementById("add-listing-description").value || null,
    price_myr:  priceOrNull(document.getElementById("add-listing-price-myr").value),
    price_sgd:  priceOrNull(document.getElementById("add-listing-price-sgd").value),
    shopee_my:  document.getElementById("add-listing-shopee-my").value.trim() || null,
    shopee_sg:  document.getElementById("add-listing-shopee-sg").value.trim() || null,
    shopee_ph:  document.getElementById("add-listing-shopee-ph").value.trim() || null,
    shopee_th:  document.getElementById("add-listing-shopee-th").value.trim() || null,
    lazada_my:  document.getElementById("add-listing-lazada-my").value.trim() || null,
    is_active:  document.getElementById("add-listing-is-active").checked,
    created_at: now,
    updated_at: now,
  };

  try {
    const { data, error } = await supabaseClient
      .from("listings")
      .insert(payload)
      .select("*, products(id, master_sku, product_base_name, brand_name)");
    if (error) throw error;
    const inserted = data[0];
    inserted.listing_variations = [];
    cachedListings.unshift(inserted);
    closeAddListingModal();
    renderListingsFromCache();
    showToast("Listing created.", "success");
  } catch (err) {
    showToast(`Failed to create listing: ${err.message}`, "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = `<span class="material-symbols-outlined text-sm">add</span> Create Listing`;
  }
}
