let supabaseClient = null;
let currentTab = "overview";
let activeLogFilter = "all";
let activeWaybillFilter = "all";
let activeOrderFilter = "all";
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
let selectedOrderId = null; // Master-detail: which order's detail panel is showing
let bulkSelectedOrderIds = new Set(); // Orders list: checkbox-selected rows for bulk actions
let selectedProductId = null; // Master-detail: which product's detail panel is showing
let catalogAttentionFilter = "all"; // "all" | "needs_attention" | "full_coverage" | "low_stock"
let lastRenderedProductsList = []; // Snapshot of the currently rendered product list, for keyboard nav
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
    info:    { bg: "rgba(139,124,246,0.12)", border: "rgba(139,124,246,0.4)", text: "#8b7cf6", icon: "info" },
  };
  const c = palette[type] || palette.info;
  const toast = document.createElement("div");
  toast.style.cssText = `background:${c.bg};border:1px solid ${c.border};color:${c.text};padding:0.65rem 0.875rem;border-radius:8px;font-family:'JetBrains Mono',monospace;font-size:0.78rem;backdrop-filter:blur(12px);pointer-events:auto;opacity:0;transform:translateX(12px);transition:all 0.22s ease;display:flex;align-items:flex-start;gap:0.5rem;word-break:break-word;`;
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
  } catch (_) {}
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
  return localStorage.getItem("orbot_sp_dispatch_enabled") !== "false";
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

// Initialize configuration
function initSupabase() {
  const localUrl = localStorage.getItem("orbot_supabase_url");
  const localKey = localStorage.getItem("orbot_supabase_key");
  
  const supabaseUrl = localUrl || (window.ENV ? window.ENV.SUPABASE_URL : "");
  const supabaseKey = localKey || (window.ENV ? window.ENV.SUPABASE_SERVICE_ROLE_KEY : "");

  document.getElementById("setting-supabase-url").value = supabaseUrl;
  document.getElementById("setting-supabase-key").value = supabaseKey;
  const backendUrl = localStorage.getItem("orbot_backend_url") || "";
  document.getElementById("setting-backend-url").value = backendUrl;
  const spKey = localStorage.getItem("orbot_simplyprint_key") || "";
  document.getElementById("setting-simplyprint-key").value = spKey;
  const spDispatch = localStorage.getItem("orbot_sp_dispatch_enabled");
  document.getElementById("setting-sp-dispatch").checked = spDispatch !== "false";

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
      .select("id, name, slug, is_active")
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

  sel.addEventListener("change", () => {
    currentShop = sel.value;
    localStorage.setItem("orbot_current_shop", currentShop);
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
    fetchAndRenderOverviewJobs();
    fetchAndRenderOverviewLogs();
  }
}

// Stats & General Refreshes
async function fetchSummaryStats() {
  if (!supabaseClient) return;

  try {
    // 1. Fetch orders timestamps for filtering (scoped to the active shop)
    const { data: ordersData, error: oError } = await scopeByShop(supabaseClient
      .from("orders")
      .select("order_timestamp, created_at, overall_order_status"));
    
    // 2. System Errors
    const { count: errorsCount, error: eError } = await supabaseClient
      .from("system_logs")
      .select("*", { count: "exact", head: true })
      .eq("log_level", "error");

    if (oError || eError) throw new Error("Stats query failed");

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const startOfYesterday = new Date(startOfToday.getTime() - 86400000);

    const ordersTodayCount = (ordersData || []).filter(o => {
      const ts = new Date(o.order_timestamp || o.created_at);
      return ts >= startOfToday && ts <= endOfToday;
    }).length;

    const ordersYesterdayCount = (ordersData || []).filter(o => {
      const ts = new Date(o.order_timestamp || o.created_at);
      return ts >= startOfYesterday && ts < startOfToday;
    }).length;

    const pendingOrdersCount = (ordersData || []).filter(o => o.overall_order_status !== 'completed').length;
    const ordersOnHoldCount = (ordersData || []).filter(o => o.overall_order_status === 'hold').length;

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
    markFresh("stats");
  } catch (err) {
    console.error("Error fetching stats:", err);
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

// Fetch and Render Orders
async function fetchAndRenderOrders(forceFetch = true) {
  if (!supabaseClient) return;
  const listContainer = document.getElementById("orders-list");
  const overviewContainer = document.getElementById("overview-orders-list");
  if (!listContainer && !overviewContainer) return;

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
      if (error) throw error;
      cachedOrders = orders || [];
    }

    let filtered = cachedOrders;

    // Apply status filter
    if (activeOrderFilter !== "all") {
      filtered = filtered.filter(o => {
        const statusLower = (o.overall_order_status || "").toLowerCase();
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
    }

    // Update hold panel using full cachedOrders list
    renderHoldPanel(cachedOrders);

  } catch (err) {
    const errMsg = emptyDiv(`Error loading orders: ${err.message}`, "error");
    if (listContainer) listContainer.innerHTML = errMsg;
    if (overviewContainer) overviewContainer.innerHTML = errMsg;
  }
}

// Reusable spreadsheet orders table rendering helper
function renderOrdersTableToContainer(container, prefix, filtered) {
  if (filtered.length === 0) {
    container.innerHTML = emptyDiv("No matching orders found.", "receipt_long", `<button class="empty-action" onclick="document.getElementById('ctrl-trigger-scout')?.click()"><span class="material-symbols-outlined">mail</span>Trigger Gmail Scan</button>`);
    return;
  }

  let html = `
    <table class="w-full text-left border-collapse text-xs font-body-md" id="${prefix}orders-table">
      <thead>
        <tr class="bg-surface-container-low border-b border-outline-variant/20 sticky top-0 z-20">
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10 w-8 text-center"></th>
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Order ID</th>
          ${currentShop === "all" ? `<th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Brand</th>` : ""}
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Platform</th>
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10 cursor-pointer select-none hover:bg-surface-container-high transition-colors" id="${prefix}sort-date-col">
            <span class="flex items-center gap-1 justify-between">
              Date of Order
              <span class="material-symbols-outlined text-sm transform transition-transform select-none ${ordersDateSortDirection === "asc" ? "rotate-180" : ""}">arrow_drop_down</span>
            </span>
          </th>
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Customer Name</th>
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Items</th>
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Subtotal</th>
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10 text-center">Waybill Status</th>
          <th class="py-2 px-3 font-semibold text-on-surface-variant${prefix === "" ? " border-r border-outline-variant/10" : ""}">Status</th>
          ${prefix === "" ? `<th class="py-2 px-3 font-semibold text-on-surface-variant text-center w-12">Action</th>` : ""}
        </tr>
      </thead>
      <tbody>
  `;

  for (const order of filtered) {
    const orderDateVal = order.order_timestamp || order.created_at;
    const dateStr = orderDateVal ? new Date(orderDateVal).toLocaleString() : "N/A";
    let statusClass = "completed";
    let statusLower = (order.overall_order_status || "").toLowerCase();
    
    if (statusLower === "printing") {
      statusClass = "printing";
    } else if (statusLower === "printed") {
      statusClass = "printed";
    } else if (statusLower === "pending") {
      statusClass = "pending";
    } else if (statusLower === "hold" || statusLower === "on hold") {
      statusClass = "hold";
    }

    let waybillStatusClass = "pending";
    const waybillStatusLower = (order.waybill_processing_status || "pending").toLowerCase();
    if (waybillStatusLower === "ready" || waybillStatusLower === "ready to print") waybillStatusClass = "completed";
    else if (waybillStatusLower === "compiled") waybillStatusClass = "completed";
    else if (waybillStatusLower === "printed") waybillStatusClass = "printing";
    else if (waybillStatusLower === "pending") waybillStatusClass = "pending";
    else if (waybillStatusLower === "on hold" || waybillStatusLower === "hold" || waybillStatusLower === "failed") waybillStatusClass = "hold";
    
    let waybillStatusDisplay = order.waybill_processing_status || 'pending';
    if (waybillStatusDisplay.toLowerCase() === 'ready to print' || waybillStatusDisplay.toLowerCase() === 'ready') {
      waybillStatusDisplay = 'ready';
    }

    const itemsList = order.order_items || [];
    
    // Build inline items representation
    let itemsHtml = itemsList.map(item => {
      const qty = item.purchased_quantity;
      const qtyHtml = qty > 1 
        ? `<span class="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-[#ffaa00] font-bold border border-amber-500/30">x${qty}</span>`
        : `<span class="ml-1 opacity-50 text-[11px]">x${qty}</span>`;
      return `
        <span class="order-item-inline flex items-center gap-1 select-none" title="${item.variant_name || item.variant_sku} (${item.variant_sku})">
          <span class="font-medium">${item.variant_sku}</span>${qtyHtml}
        </span>
      `;
    }).join("");
    if (!itemsHtml) {
      itemsHtml = `<span style="color: var(--text-muted); font-size: 0.85rem;">No items</span>`;
    }
    
    // Build Details HTML (Pre-rendered for zero-latency toggle)
    let detailsHtml = "";
    if (itemsList.length === 0) {
      detailsHtml = `<div class="font-data-mono text-xs text-outline py-2 text-center">No items found in this order.</div>`;
    } else {
      // Total print time across all items
      let totalPrintMin = 0;
      for (const item of itemsList) {
        for (const j of (item.print_jobs || [])) {
          totalPrintMin += ((j.print_files?.print_time_m || 0) * (item.purchased_quantity || 1));
        }
      }
      const totalTimeHtml = totalPrintMin > 0
        ? `<div class="flex items-center gap-1.5 text-[11px] text-on-surface-variant/60 font-data-mono mb-1">
             <span class="material-symbols-outlined text-xs select-none">schedule</span>
             <span>Total print time: <span class="text-on-surface-variant">${totalPrintMin}m</span></span>
           </div>`
        : "";

      detailsHtml = `<div class="flex flex-col gap-3">${totalTimeHtml}`;
      for (const item of itemsList) {
        const dateStr = item.sent_to_print_timestamp ? new Date(item.sent_to_print_timestamp).toLocaleString() : "Not Dispatched";
        const stickerUrl = item.variants?.seal_sticker_gdrive_url || "";
        const stickerBtn = stickerUrl
          ? `<a href="${stickerUrl}" target="_blank" rel="noopener"
               class="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors font-semibold whitespace-nowrap">
               <span class="material-symbols-outlined text-xs">label</span> Sticker
             </a>`
          : `<span class="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-outline/40 border border-outline/10 whitespace-nowrap cursor-not-allowed select-none" title="No seal sticker configured for this variant">
               <span class="material-symbols-outlined text-xs">label_off</span> Sticker
             </span>`;

        const jobs = item.print_jobs || [];
        let jobsHtml = "";
        if (jobs.length > 0) {
          jobsHtml = `
            <div class="flex flex-col gap-2 mt-2 w-full">
              ${jobs.map(j => {
                let badgeClass = "pending";
                let extraStatus = "";
                let progressHtml = "";

                if (j.job_execution_status === "printing") {
                  badgeClass = "printing";
                  extraStatus = `
                    <span class="px-2 py-0.5 rounded bg-surface-tint/10 text-surface-tint border border-surface-tint/20 font-data-mono text-[10px]">
                      ${j.printer_name || "Printing"}
                    </span>
                    <span class="text-surface-tint/80 font-data-mono text-[10px] ml-1">
                      ${j.percent_complete}%
                    </span>
                  `;
                  progressHtml = `
                    <div class="w-full bg-black/40 rounded-full h-1.5 mt-2 border border-outline-variant/10 overflow-hidden">
                      <div class="bg-surface-tint h-full transition-all duration-500" style="width: ${j.percent_complete}%"></div>
                    </div>
                  `;
                } else if (j.job_execution_status === "completed") {
                  badgeClass = "completed";
                } else if (j.job_execution_status === "failed") {
                  badgeClass = "hold";
                } else if (j.job_execution_status === "pending" && j.queue_position) {
                  extraStatus = `
                    <span class="px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20 font-data-mono text-[10px]">
                      Queue Pos: #${j.queue_position}
                    </span>
                  `;
                }

                const etaText = j.job_execution_status !== "completed" && j.estimated_finish_time ? formatEta(j.estimated_finish_time) : "";
                const etaHtml = etaText ? `<span class="text-on-surface-variant/60 font-data-mono text-[10px] ml-auto">${etaText}</span>` : "";
                const spFileId = j.print_files?.simplyprint_file_id || "";
                const safeFileName = (j.print_file_name || "").replace(/'/g, "\\'");
                const safeJobId = j.id || "";
                const redispatchBtn = j.print_file_name
                  ? `<button onclick="redispatchPrintFile('${spFileId}','${safeFileName}','${safeJobId}',this)"
                       class="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors font-semibold whitespace-nowrap">
                       <span class="material-symbols-outlined text-xs">refresh</span> Re-dispatch
                     </button>`
                  : "";
                const printTimeHtml = j.print_files?.print_time_m
                  ? `<span class="text-on-surface-variant/40 font-data-mono text-[10px]">${j.print_files.print_time_m}m</span>`
                  : "";

                return `
                  <div class="flex flex-col p-2.5 rounded bg-black/30 border border-outline-variant/10 text-xs w-full">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div class="flex items-center gap-1.5 min-w-0 flex-1">
                        <span class="material-symbols-outlined text-surface-tint text-base flex-shrink-0">code</span>
                        <div class="font-data-mono text-on-surface-variant break-all" title="${j.print_file_name}">${j.print_file_name}</div>
                        ${printTimeHtml}
                      </div>
                      <div class="flex items-center gap-1.5 flex-wrap">
                        ${extraStatus}
                        ${etaHtml}
                        <span class="badge ${badgeClass} text-[10px] py-0.5 px-2.5">${j.job_execution_status}</span>
                        ${redispatchBtn}
                      </div>
                    </div>
                    ${progressHtml}
                  </div>
                `;
              }).join("")}
            </div>
          `;
        } else {
          jobsHtml = `
            <div class="flex items-center gap-1.5 text-[11px] text-on-surface-variant/40 mt-2 font-data-mono">
              <span class="material-symbols-outlined text-xs">info</span>
              <span>No print jobs dispatched yet.</span>
            </div>
          `;
        }

        detailsHtml += `
          <div class="flex flex-col md:flex-row justify-between items-start md:items-center p-3 rounded-lg bg-surface-container-low/40 border border-outline-variant/10 gap-3">
            <div class="flex-grow flex flex-col gap-1 min-w-0 w-full">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-data-mono text-xs text-primary bg-primary/10 px-2 py-0.5 rounded font-bold">${item.variant_sku || 'UNKNOWN'}</span>
                <span class="text-sm font-medium text-on-surface truncate">${item.variant_name || 'Generic Item'}</span>
              </div>
              <div class="flex items-center gap-1.5 text-[11px] text-on-surface-variant/60 font-data-mono mt-0.5">
                <span class="material-symbols-outlined text-xs select-none">local_shipping</span>
                <span>Dispatched: ${dateStr}</span>
              </div>
              ${jobsHtml}
            </div>
            <div class="flex flex-row md:flex-col items-center md:items-end justify-between w-full md:w-auto border-t md:border-t-0 border-outline-variant/5 pt-2 md:pt-0 mt-1 md:mt-0 gap-3">
              <span class="text-sm font-bold text-on-surface font-data-mono">Qty: ${item.purchased_quantity}</span>
              <span class="badge ${item.item_print_status.toLowerCase() === 'printing' ? 'printing' : (item.item_print_status.toLowerCase() === 'pending' ? 'pending' : 'completed')}">${item.item_print_status}</span>
              ${stickerBtn}
            </div>
          </div>
        `;
      }
      detailsHtml += `</div>`;
    }
    
    const selectHtml = `
      <select class="badge ${statusClass} overall-status-select" data-order-id="${order.id}" style="text-transform: capitalize;">
        <option value="pending" ${statusLower === 'pending' ? 'selected' : ''}>Pending</option>
        <option value="printing" ${statusLower === 'printing' ? 'selected' : ''}>Printing</option>
        <option value="printed" ${statusLower === 'printed' ? 'selected' : ''}>Printed</option>
        <option value="completed" ${statusLower === 'completed' ? 'selected' : ''}>Completed</option>
        <option value="hold" ${statusLower === 'hold' || statusLower === 'on hold' ? 'selected' : ''}>Hold</option>
      </select>
    `;

    const platformLower = (order.sales_platform || "").toLowerCase();
    let platformBadgeClass = "bg-surface-container text-on-surface-variant/80";
    if (platformLower.includes("shopee")) {
      platformBadgeClass = "bg-orange-500/15 text-orange-400 border border-orange-500/20";
    } else if (platformLower.includes("lazada")) {
      platformBadgeClass = "bg-blue-600/15 text-blue-400 border border-blue-600/20";
    } else if (platformLower.includes("shopify")) {
      platformBadgeClass = "bg-green-600/15 text-green-400 border border-green-600/20";
    }

    html += `
      <tr class="order-row border-b border-outline-variant/10 hover:bg-surface-container/20 transition-colors cursor-pointer" data-order-id="${order.id}">
        <td class="py-2.5 px-3 border-r border-outline-variant/10 text-center select-none">
          <span class="material-symbols-outlined text-outline text-base transition-transform duration-250 toggle-icon">expand_more</span>
        </td>
        <td class="py-2.5 px-3 border-r border-outline-variant/10 font-data-mono font-bold text-on-surface select-all max-w-[200px] truncate" title="${escapeHtml(order.platform_order_id)}">${escapeHtml(order.platform_order_id)}</td>
        ${currentShop === "all" ? `
        <td class="py-2.5 px-3 border-r border-outline-variant/10">
          <span class="px-1.5 py-0.5 rounded text-[9px] font-body-md font-bold uppercase tracking-wide ${order.shop_id ? 'bg-surface-tint/15 text-surface-tint border border-surface-tint/25' : 'bg-amber-500/15 text-amber-400 border border-amber-500/25'}">${escapeHtml(shopName(order.shop_id))}</span>
        </td>` : ""}
        <td class="py-2.5 px-3 border-r border-outline-variant/10">
          <span class="px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wide ${platformBadgeClass}">${escapeHtml(order.sales_platform)}</span>
        </td>
        <td class="py-2.5 px-3 border-r border-outline-variant/10 text-on-surface-variant/70 font-data-mono">${dateStr}</td>
        <td class="py-2.5 px-3 border-r border-outline-variant/10 text-on-surface font-medium">${escapeHtml(order.customer_name) || 'N/A'}</td>
        <td class="py-2.5 px-3 border-r border-outline-variant/10">
          <div class="flex flex-wrap gap-1">${itemsHtml}</div>
        </td>
        <td class="py-2.5 px-3 border-r border-outline-variant/10 font-data-mono text-on-surface-variant/80">${order.order_subtotal} ${order.order_currency}</td>
        <td class="py-2.5 px-3 border-r border-outline-variant/10 text-center">
          <span class="badge ${waybillStatusClass} text-[10px] py-0.5 px-2.5 uppercase font-bold tracking-wide">${waybillStatusDisplay}</span>
        </td>
        <td class="py-2.5 px-3${prefix === "" ? " border-r border-outline-variant/10" : ""}">
          <div class="overall-status-select-container">${selectHtml}</div>
        </td>
        ${prefix === "" ? `
        <td class="py-2.5 px-3 text-center">
          <button class="delete-order-btn p-1 rounded hover:bg-error/20 border border-transparent hover:border-error/30 text-error hover:scale-105 transition-transform flex items-center justify-center cursor-pointer select-none mx-auto" data-order-id="${order.id}" data-platform-order-id="${escapeHtml(order.platform_order_id)}" title="Delete Order">
            <span class="material-symbols-outlined text-[16px]">delete</span>
          </button>
        </td>` : ""}
      </tr>
      <tr class="hidden border-b border-outline-variant/10 bg-black/10 order-details-row" id="${prefix}details-${order.id}">
        <td colspan="${prefix === "" ? (currentShop === "all" ? "11" : "10") : (currentShop === "all" ? "10" : "9")}" class="p-3 border-r border-outline-variant/10">
          <div class="order-items-detail" id="${prefix}items-container-${order.id}">
            ${detailsHtml}
          </div>
        </td>
      </tr>
    `;
  }

  html += `
      </tbody>
    </table>
  `;
  container.innerHTML = html;

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
        fetchSummaryStats();
        fetchAndRenderOrders();
      } catch (err) {
        showToast("Error updating order status: " + err.message, "error");
        fetchAndRenderOrders(); // Refresh to restore old value
      } finally {
        select.disabled = false;
      }
    });
  });

  // Attach click events for expansion
  container.querySelectorAll(".order-row").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("select") || e.target.closest("a") || e.target.closest("button") || window.getSelection().toString()) {
        return;
      }
      const orderId = row.getAttribute("data-order-id");
      toggleOrderDetails(orderId, row, prefix);
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
      const icon = btn.querySelector(".material-symbols-outlined");
      if (icon) icon.textContent = "sync";
      
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
        fetchSummaryStats();
        fetchAndRenderOrders();
      } catch (err) {
        showToast("Error deleting order: " + err.message, "error");
        btn.disabled = false;
        btn.style.opacity = "1";
        if (icon) icon.textContent = "delete";
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
function updateBulkCompleteButton() {
  const btn = document.getElementById("orders-btn-complete-all");
  if (!btn) return;
  const n = bulkSelectedOrderIds.size;
  btn.innerHTML = n > 0
    ? `<span class="material-symbols-outlined text-sm">done_all</span> Complete Selected (${n})`
    : `<span class="material-symbols-outlined text-sm">done_all</span> Complete All`;
}

function renderOrdersMasterDetail(filtered) {
  const headEl = document.getElementById("orders-list-head");
  const rowsEl = document.getElementById("orders-list");
  const panel = document.getElementById("order-detail-panel");
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
    let platformBadgeClass = "bg-surface-container text-on-surface-variant/80";
    if (platformLower.includes("shopee")) platformBadgeClass = "bg-orange-500/15 text-orange-400";
    else if (platformLower.includes("lazada")) platformBadgeClass = "bg-blue-600/15 text-blue-400";
    else if (platformLower.includes("shopify")) platformBadgeClass = "bg-green-600/15 text-green-400";

    const isSelected = order.id === selectedOrderId;

    return `
      <div class="omd-row omd-orders-cols${isSelected ? " selected" : ""}" data-order-id="${order.id}">
        <div class="omd-cb" data-order-id="${order.id}"></div>
        <div class="omd-oid-cell">
          <div class="omd-oid-num truncate" title="${escapeHtml(order.platform_order_id)}">${escapeHtml(order.platform_order_id)}</div>
          <span class="omd-plat ${platformBadgeClass}">${escapeHtml(order.sales_platform || "")}</span>
        </div>
        <div class="text-xs font-medium text-on-surface truncate">${escapeHtml(order.customer_name) || "N/A"}</div>
        <div class="omd-items-cell">${itemsHtml}</div>
        <div class="omd-subtotal-cell">${order.order_subtotal} ${order.order_currency}</div>
        <div><span class="badge ${statusClass}" style="font-size:9.5px; padding:3px 9px;">${escapeHtml(order.overall_order_status || "pending")}</span></div>
        <div><span class="badge ${waybillStatusClass}" style="font-size:9.5px; padding:3px 9px;">${escapeHtml(waybillStatusDisplay)}</span></div>
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
  let platformBadgeClass = "bg-surface-container text-on-surface-variant/80";
  if (platformLower.includes("shopee")) platformBadgeClass = "bg-orange-500/15 text-orange-400";
  else if (platformLower.includes("lazada")) platformBadgeClass = "bg-blue-600/15 text-blue-400";
  else if (platformLower.includes("shopify")) platformBadgeClass = "bg-green-600/15 text-green-400";

  const itemsList = order.order_items || [];
  let itemsHtml;
  if (itemsList.length === 0) {
    itemsHtml = `<div class="font-data-mono text-xs text-outline py-2 text-center">No items found in this order.</div>`;
  } else {
    itemsHtml = itemsList.map(item => {
      const dispatchedStr = item.sent_to_print_timestamp ? new Date(item.sent_to_print_timestamp).toLocaleString() : "Not dispatched";
      const stickerUrl = item.variants?.seal_sticker_gdrive_url || "";
      const stickerBtn = stickerUrl
        ? `<a href="${stickerUrl}" target="_blank" rel="noopener" class="omd-tag-btn"><span class="material-symbols-outlined">label</span>Sticker</a>`
        : `<span class="omd-tag-btn off"><span class="material-symbols-outlined">label_off</span>Sticker</span>`;

      const jobs = item.print_jobs || [];
      const jobsHtml = jobs.length > 0 ? jobs.map(j => {
        let badgeClass = "pending";
        if (j.job_execution_status === "printing") badgeClass = "printing";
        else if (j.job_execution_status === "completed") badgeClass = "completed";
        else if (j.job_execution_status === "failed") badgeClass = "hold";

        const etaText = j.job_execution_status !== "completed" && j.estimated_finish_time ? formatEta(j.estimated_finish_time) : "";
        const spFileId = j.print_files?.simplyprint_file_id || "";
        const safeFileName = (j.print_file_name || "").replace(/'/g, "\\'");
        const safeJobId = j.id || "";
        const redispatchBtn = j.print_file_name
          ? `<button onclick="redispatchPrintFile('${spFileId}','${safeFileName}','${safeJobId}',this)" class="omd-tag-btn"><span class="material-symbols-outlined">refresh</span>Re-dispatch</button>`
          : "";
        const progressHtml = j.job_execution_status === "printing"
          ? `<div class="omd-job-bar"><i style="width:${j.percent_complete || 0}%"></i></div>`
          : "";

        return `
          <div class="omd-job-card">
            <div class="omd-row-between">
              <span class="font-data-mono text-[10px] text-on-surface-variant/80 truncate" title="${escapeHtml(j.print_file_name || "")}">
                <span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px;color:var(--accent-blue);">code</span> ${escapeHtml(j.print_file_name || "")}
              </span>
              <span class="badge ${badgeClass}" style="font-size:9px; padding:2px 8px; flex-shrink:0;">${j.job_execution_status}</span>
            </div>
            ${progressHtml}
            <div class="omd-row-between" style="margin-top:6px;">
              <span class="font-data-mono text-[9.5px] text-outline">${j.printer_name || (etaText ? `ETA ${etaText}` : "")}</span>
              ${redispatchBtn}
            </div>
          </div>
        `;
      }).join("") : `<div class="text-[10px] text-outline font-data-mono mt-1">No print jobs dispatched yet.</div>`;

      return `
        <div class="omd-item-card">
          <div class="omd-row-between">
            <span class="omd-isku">${escapeHtml(item.variant_sku || "UNKNOWN")}</span>
            <span class="badge ${item.item_print_status?.toLowerCase() === "printing" ? "printing" : (item.item_print_status?.toLowerCase() === "pending" ? "pending" : "completed")}" style="font-size:9px; padding:2px 8px;">${item.item_print_status}</span>
          </div>
          <div class="text-xs font-medium text-on-surface">${escapeHtml(item.variant_name || "Generic Item")} · Qty ${item.purchased_quantity}</div>
          <div class="text-[10px] text-outline font-data-mono">Dispatched: ${dispatchedStr}</div>
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
    ? `<a href="${order.raw_waybill_gdrive_url}" target="_blank" rel="noopener" class="omd-tag-btn"><span class="material-symbols-outlined">description</span>Raw PDF</a>`
    : `<span class="omd-tag-btn off"><span class="material-symbols-outlined">block</span>Raw PDF</span>`;
  const processedPdfBtn = order.processed_waybill_gdrive_url
    ? `<a href="${order.processed_waybill_gdrive_url}" target="_blank" rel="noopener" class="omd-tag-btn"><span class="material-symbols-outlined">description</span>Processed</a>`
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
          <span class="px-2 py-0.5 rounded text-[9px] uppercase font-bold tracking-wide ${platformBadgeClass}">${escapeHtml(order.sales_platform || "")}</span>
          <span class="sep">·</span><span>${dateStr}</span>
          <span class="sep">·</span><span>${escapeHtml(order.customer_name) || "N/A"}</span>
        </div>
      </div>
      <button class="delete-order-btn p-1.5 rounded hover:bg-error/20 border border-transparent hover:border-error/30 text-error transition-transform flex items-center justify-center cursor-pointer flex-shrink-0" data-order-id="${order.id}" data-platform-order-id="${escapeHtml(order.platform_order_id)}" title="Delete Order">
        <span class="material-symbols-outlined text-[16px]">delete</span>
      </button>
    </div>

    <div>
      <div class="omd-section-title"><span class="material-symbols-outlined">inventory_2</span>Items (${itemsList.length})</div>
      ${itemsHtml}
    </div>

    <div>
      <div class="omd-section-title"><span class="material-symbols-outlined">local_shipping</span>Waybill</div>
      <div class="omd-item-card" style="flex-direction:row; align-items:center; justify-content:space-between; margin-bottom:0;">
        <span class="badge ${waybillStatusClass}" style="font-size:9.5px; padding:3px 9px;">${escapeHtml(waybillStatusDisplay)}</span>
        <div style="display:flex; gap:6px;">${rawPdfBtn}${processedPdfBtn}</div>
      </div>
    </div>

    <div style="flex:1; min-height:0;">
      <div class="omd-section-title"><span class="material-symbols-outlined">history</span>Order Timeline</div>
      ${tlHtml}
    </div>

    <div class="omd-dp-footer">
      <div class="omd-section-title" style="margin-bottom:2px;">Update Status</div>
      <select class="badge ${statusSelectClass} overall-status-select" data-order-id="${order.id}" style="width:100%; text-align:center; text-transform:capitalize; padding:8px;">
        <option value="pending" ${statusLower === "pending" ? "selected" : ""}>Pending</option>
        <option value="printing" ${statusLower === "printing" ? "selected" : ""}>Printing</option>
        <option value="printed" ${statusLower === "printed" ? "selected" : ""}>Printed</option>
        <option value="completed" ${statusLower === "completed" ? "selected" : ""}>Completed</option>
        <option value="hold" ${statusLower === "hold" || statusLower === "on hold" ? "selected" : ""}>Hold</option>
      </select>
    </div>
  `;
}

function bindOrderDetailPanelEvents() {
  const panel = document.getElementById("order-detail-panel");
  if (!panel) return;

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
        fetchSummaryStats();
        fetchAndRenderOrders();
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
        fetchSummaryStats();
        fetchAndRenderOrders();
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
    holdPanel.style.display = "block";
    holdCount.innerText = holdOrders.length;
    
    let holdHtml = "";
    for (const order of holdOrders) {
      holdHtml += `
        <div class="hold-item" id="hold-item-${order.id}">
          <div style="display: flex; flex-direction: column; gap: 0.2rem;">
            <div style="font-weight: bold; font-family: monospace; font-size: 0.95rem;">Order #${order.platform_order_id}</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary);" id="discrepancy-${order.id}">Loading discrepancy details...</div>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <button class="btn-secondary rounded-lg px-3 py-1.5 flex items-center gap-1.5 text-xs btn-reset-hold" data-order-id="${order.id}" data-platform-id="${order.platform_order_id}">
              <span class="material-symbols-outlined text-xs select-none">rotate_left</span> Reset to Pending
            </button>
            <button class="btn-primary rounded-lg px-3 py-1.5 flex items-center gap-1.5 text-xs btn-force-approve" data-order-id="${order.id}" data-platform-id="${order.platform_order_id}">
              <span class="material-symbols-outlined text-xs select-none">check</span> Force Release
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

      const bulkIds = Array.from(bulkSelectedOrderIds);
      const isBulk = bulkIds.length > 0;

      const confirmed = isBulk
        ? await showConfirmModal("Complete Selected Orders", `Are you sure you want to mark ${bulkIds.length} selected order${bulkIds.length > 1 ? "s" : ""} as completed? This cannot be undone.`, "Complete Selected")
        : await showConfirmModal("Complete All Orders", "Are you sure you want to mark all orders as completed? This cannot be undone.", "Complete All");
      if (!confirmed) return;

      try {
        completeAllOrdersBtn.disabled = true;

        const query = supabaseClient.from("orders").update({ overall_order_status: "completed" });
        const { error } = isBulk
          ? await query.in("id", bulkIds)
          : await query.neq("id", "00000000-0000-0000-0000-000000000000");

        if (error) throw error;

        showToast(isBulk ? `${bulkIds.length} order${bulkIds.length > 1 ? "s" : ""} marked as completed.` : "All orders marked as completed.", "success");
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
}

// Toggle Order details row
function toggleOrderDetails(orderId, cardElement, prefix = "") {
  const detailsContainer = cardElement.nextElementSibling || document.getElementById(`${prefix}details-${orderId}`);
  const icon = cardElement.querySelector(".toggle-icon");

  if (!detailsContainer || !icon) return;

  if (!detailsContainer.classList.contains("hidden")) {
    detailsContainer.classList.add("hidden");
    icon.style.transform = "rotate(0deg)";
  } else {
    detailsContainer.classList.remove("hidden");
    icon.style.transform = "rotate(180deg)";
  }
}

// Fetch and Render System Logs
window.redispatchPrintFile = async function(simplyPrintFileId, printFileName, printJobId, btn) {
  if (!isSpDispatchEnabled()) {
    showToast("SimplyPrint dispatch is disabled in Settings.", "warning");
    return;
  }
  const backendUrl = (localStorage.getItem("orbot_backend_url") || "").replace(/\/$/, "");
  if (!backendUrl) { showToast("Backend URL not set in Settings.", "warning"); return; }
  const spKey = localStorage.getItem("orbot_simplyprint_key") || "";
  if (btn) { btn.disabled = true; btn.querySelector(".material-symbols-outlined").textContent = "sync"; }
  try {
    const res = await fetch(`${backendUrl}/print-files/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(spKey && { "X-SimplyPrint-Key": spKey }) },
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
    showToast(`Re-dispatched: ${printFileName}`, "success");
    logAction(`File re-dispatched to print queue: ${printFileName}`, "info", { simplyprint_file_id: simplyPrintFileId, job_id: data.simplyprint_job_id });
  } catch (err) {
    showToast(`Re-dispatch failed: ${err.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector(".material-symbols-outlined").textContent = "refresh"; }
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

async function fetchAndRenderLogs() {
  if (!supabaseClient) return;
  const listContainer = document.getElementById("logs-list");
  if (!listContainer) return;

  listContainer.innerHTML = loadingDiv();

  const escapeHtml = (str) => {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  try {
    let query = supabaseClient.from("system_logs").select("*").order("created_at", { ascending: false }).limit(60);
    
    if (activeLogFilter !== "all") {
      query = query.eq("log_level", activeLogFilter);
    }

    const { data: logs, error } = await query;
    if (error) throw error;

    if (!logs || logs.length === 0) {
      listContainer.innerHTML = emptyDiv("No system logs found.", "description");
      return;
    }

    listContainer.innerHTML = logs.map(log => {
      const logDate = new Date(log.created_at);
      const timeStr = logDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const fullDateStr = logDate.toLocaleString();
      
      const agentRaw = log.agent_name || 'System';
      const agentLower = agentRaw.toLowerCase().replace("agent", "");
      const hasDetails = !!log.additional_details;

      let glowClass = "glow-hover-cyan";
      if (log.log_level.toLowerCase() === "warning") {
        glowClass = "glow-hover-yellow";
      } else if (log.log_level.toLowerCase() === "error") {
        glowClass = "glow-hover-red";
      }
      
      return `
        <div class="glass-panel border border-outline-variant/10 rounded-xl p-4 transition-all duration-300 group relative overflow-hidden flex flex-col gap-3 log-item ${log.log_level.toLowerCase()} ${hasDetails ? 'cursor-pointer has-details ' + glowClass : ''}" id="log-item-${log.id}" ${hasDetails ? `onclick="toggleLogDetails('${log.id}', event)"` : ''}>
          <div class="absolute inset-0 bg-gradient-to-r from-secondary-container/0 via-secondary-container/[0.01] to-secondary-container/0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"></div>
          
          <div class="log-item-header relative z-10">
            <div class="log-timestamp" title="${fullDateStr}">
              ${timeStr} 
              <span class="text-[10px] opacity-40 ml-1.5">${logDate.toLocaleDateString([], {month: 'short', day: 'numeric'})}</span>
            </div>
            <div class="log-level-badge ${log.log_level.toLowerCase()}">${log.log_level}</div>
            <div class="log-agent-badge ${agentLower}">${agentRaw}</div>
            <div class="log-msg">${log.log_message}</div>
            ${hasDetails ? `
              <button class="log-toggle-btn pointer-events-none" id="log-toggle-btn-${log.id}" title="Toggle detailed payload">
                <span class="material-symbols-outlined">expand_more</span>
              </button>
            ` : `<div class="w-8"></div>`}
          </div>
          ${hasDetails ? `
            <div class="log-details-pane relative z-10" id="log-details-${log.id}">
              <pre class="font-mono text-[11px] p-4 rounded-lg bg-[#02040a]/80 border border-outline-variant/10 text-slate-300 max-h-[300px] overflow-y-auto select-text">${escapeHtml(JSON.stringify(log.additional_details, null, 2))}</pre>
            </div>
          ` : ''}
        </div>
      `;
    }).join("");

  } catch (err) {
    listContainer.innerHTML = emptyDiv(`Error loading logs: ${err.message}`, "error");
  }
}

async function fetchAndRenderLogsPagePrintJobs() {
  if (!supabaseClient) return;
  const container = document.getElementById("logs-print-jobs-list");
  if (!container) return;

  container.innerHTML = `<div class="text-center text-outline py-12 font-data-mono text-xs"><span class="material-symbols-outlined animate-spin text-xl mb-1 block">autorenew</span>Loading print jobs...</div>`;

  try {
    const { data: jobs, error } = await supabaseClient
      .from("print_jobs")
      .select("*, order_items(variant_sku, variant_name, orders(platform_order_id, customer_name))")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;

    if (!jobs || jobs.length === 0) {
      container.innerHTML = `<div class="font-data-mono text-xs text-outline text-center py-12">No print jobs found.</div>`;
      return;
    }

    let html = `
      <table class="w-full text-left border-collapse text-xs">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant/20 sticky top-0 z-10">
            <th class="py-2 px-3 font-semibold text-on-surface-variant font-data-mono text-[10px] uppercase tracking-wider border-r border-outline-variant/10">SP Job ID</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant font-data-mono text-[10px] uppercase tracking-wider border-r border-outline-variant/10">SKU</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant font-data-mono text-[10px] uppercase tracking-wider border-r border-outline-variant/10">Print File</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant font-data-mono text-[10px] uppercase tracking-wider border-r border-outline-variant/10">Customer</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant font-data-mono text-[10px] uppercase tracking-wider border-r border-outline-variant/10">Printer</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant font-data-mono text-[10px] uppercase tracking-wider border-r border-outline-variant/10 w-36">Progress</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant font-data-mono text-[10px] uppercase tracking-wider border-r border-outline-variant/10">Created</th>
            <th class="py-2 px-3 font-semibold text-on-surface-variant font-data-mono text-[10px] uppercase tracking-wider">Status</th>
          </tr>
        </thead>
        <tbody>
    `;

    jobs.forEach(job => {
      const statusLower = (job.job_execution_status || "").toLowerCase();
      let statusColor = "text-outline border-outline/30 bg-outline/10";
      if (statusLower === "printing" || statusLower === "executing") {
        statusColor = "text-primary border-primary/30 bg-primary/10";
      } else if (statusLower === "completed" || statusLower === "finished") {
        statusColor = "text-success border-success/30 bg-success/10";
      } else if (statusLower === "cancelled" || statusLower === "error") {
        statusColor = "text-error border-error/30 bg-error/10";
      } else if (statusLower === "pending") {
        statusColor = "text-warning border-warning/30 bg-warning/10";
      }

      const oi = job.order_items;
      const sku = oi?.variant_sku || "—";
      const customer = oi?.orders?.customer_name || "—";
      const orderId = oi?.orders?.platform_order_id || "";
      const printer = job.printer_name || "—";
      const progress = Math.min(100, Math.max(0, Math.round(Number(job.percent_complete) || 0)));
      const created = job.created_at ? new Date(job.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
      const spJobId = job.simplyprint_job_id || "PENDING";

      html += `
        <tr class="border-b border-outline-variant/10 hover:bg-primary/[0.03] transition-colors font-data-mono">
          <td class="py-2 px-3 border-r border-outline-variant/10 text-on-surface-variant">${spJobId}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-primary font-bold">${sku}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-on-surface-variant max-w-[180px] truncate" title="${job.print_file_name || ''}">${job.print_file_name || "—"}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-on-surface-variant" title="${orderId}">${customer}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-on-surface-variant">${printer}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10">
            <div class="flex items-center gap-2">
              <div class="flex-grow bg-black/40 rounded-full h-1.5 overflow-hidden w-20">
                <div class="h-full rounded-full ${progress === 100 ? 'bg-success' : 'bg-primary'}" style="width:${progress}%"></div>
              </div>
              <span class="text-[10px] text-outline w-7 text-right">${progress}%</span>
            </div>
          </td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-on-surface-variant">${created}</td>
          <td class="py-2 px-3">
            <span class="px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider ${statusColor}">${job.job_execution_status || "pending"}</span>
          </td>
        </tr>
      `;
    });

    html += `</tbody></table>`;
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="font-data-mono text-xs text-error text-center py-12">Error loading print jobs: ${err.message}</div>`;
  }
}

// Fetch and Render Catalog
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
    if (tbody) tbody.innerHTML = emptyDiv(`Error loading catalog: ${err.message}`, "error");
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

  document.querySelectorAll(".catalog-attn-btn").forEach(btn => {
    const isActive = btn.getAttribute("data-attn") === catalogAttentionFilter;
    btn.classList.toggle("bg-primary/15", isActive);
    btn.classList.toggle("text-primary", isActive);
    btn.classList.toggle("text-outline", !isActive);
  });

  const banner = document.getElementById("products-unmapped-banner");
  const bannerTitle = document.getElementById("products-unmapped-banner-title");
  if (banner && bannerTitle) {
    const unmappedVars = cachedListings.reduce((s, l) => s + (l.listing_variations || []).filter(v => !v.variant_id).length, 0);
    if (unmappedVars > 0) {
      bannerTitle.textContent = `${unmappedVars} listing variation${unmappedVars !== 1 ? "s" : ""} ${unmappedVars !== 1 ? "aren't" : "isn't"} linked to a catalog SKU`;
      banner.classList.remove("hidden");
      banner.classList.add("flex");
    } else {
      banner.classList.add("hidden");
      banner.classList.remove("flex");
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
        <div class="text-[10.5px] font-data-mono ${isLowStock ? "text-warning" : "text-on-surface-variant/70"}"${isLowStock ? ` title="Has variant(s) with stock ≤ 5"` : ""}>${p.variations.length} var${p.variations.length !== 1 ? "s" : ""}${isLowStock ? ` <span class="material-symbols-outlined" style="font-size:11px; vertical-align:-2px;">inventory</span>` : ""}</div>
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
    if (currentTab !== "products") return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (document.querySelector(".modal-overlay.active")) return;
    if (lastRenderedProductsList.length === 0) return;

    e.preventDefault();
    const idx = lastRenderedProductsList.findIndex(p => p.id === selectedProductId);
    const nextIdx = e.key === "ArrowDown"
      ? Math.min(idx + 1, lastRenderedProductsList.length - 1)
      : Math.max(idx - 1, 0);
    if (nextIdx === idx) return;
    selectProductForDetail(lastRenderedProductsList[nextIdx].id, lastRenderedProductsList);
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
          <span class="badge ${statusClass}" style="font-size:9px; padding:2px 8px; flex-shrink:0;">${escapeHtml(order.overall_order_status || "pending")}</span>
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
      const platformCardsHtml = LISTING_PLATFORMS.map(pl => {
        const val = listing[pl.key];
        return `
          <div class="omd-pcard${val ? "" : " off"}">
            <div class="pcolor" style="background:${pl.color}"></div>
            <span class="plabel">${pl.label}</span>
            <span class="pval">${val ? escapeHtml(val) : "not listed"}</span>
          </div>
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
            <span class="badge ${listing.is_active ? "completed" : "hold"}" style="margin-left:auto; font-size:9px; padding:3px 9px;">${listing.is_active ? "Active" : "Off"}</span>
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

  return `
    <div class="omd-dp-head">
      <div>
        <span class="omd-msku">${escapeHtml(product.master_sku)}</span>
        <div class="omd-pname">${escapeHtml(product.product_base_name)}</div>
        <div class="omd-meta" style="margin-top:4px;">${escapeHtml(product.brand_name)} · ${escapeHtml(product.product_category)}</div>
      </div>
      <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
        <button class="btn-product-details p-1.5 rounded hover:bg-primary/10 border border-transparent hover:border-primary/30 text-on-surface-variant hover:text-primary transition-all flex items-center justify-center cursor-pointer" data-product-id="${product.id}" title="View Full Details">
          <span class="material-symbols-outlined text-[16px]">info</span>
        </button>
        <button class="btn-catalog-edit p-1.5 rounded hover:bg-primary/10 border border-transparent hover:border-primary/30 text-on-surface-variant hover:text-primary transition-all flex items-center justify-center cursor-pointer" data-product-id="${product.id}" title="Edit Product">
          <span class="material-symbols-outlined text-[16px]">edit</span>
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
        <div class="btn-secondary btn-add-variant-for-product" data-product-id="${product.id}" style="cursor:pointer;"><span class="material-symbols-outlined text-sm">add</span>Add Variant</div>
        <div class="btn-primary btn-fix-mapping${hasUnmappedVars ? "" : " off"}" style="cursor:pointer;"><span class="material-symbols-outlined text-sm">link</span>Fix Mapping</div>
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

  const detailsBtn = panel.querySelector(".btn-product-details");
  if (detailsBtn) detailsBtn.addEventListener("click", () => openCatalogDetailModal(product.id));

  const editBtn = panel.querySelector(".btn-catalog-edit");
  if (editBtn) editBtn.addEventListener("click", () => openCatalogEditModal(product.id));

  const addListingBtn = panel.querySelector(".btn-add-listing-for-product");
  if (addListingBtn) {
    addListingBtn.addEventListener("click", () => {
      const modal = document.getElementById("add-listing-modal");
      if (modal) modal.classList.add("active");
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
    button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Clearing...`;

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
      pane.classList.add("active");

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
        fetchAndRenderOverviewJobs();
        fetchAndRenderOverviewLogs();
        fetchSummaryStats();
        fetchAndRenderPrintersAndQueue();
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

// Global search input handling
function setupGlobalSearch() {
  const globalSearch = document.getElementById("global-search-input");
  if (!globalSearch) return;

  globalSearch.addEventListener("input", debounce((e) => {
    const query = e.target.value;
    
    if (currentTab === "orders") {
      const ordersSearch = document.getElementById("orders-search-input");
      if (ordersSearch) ordersSearch.value = query;
      orderSearchQuery = query.trim();
      fetchAndRenderOrders(false); // Filter from cache
    } else if (currentTab === "products") {
      const catalogSearch = document.getElementById("catalog-search");
      if (catalogSearch) catalogSearch.value = query;
      fetchAndRenderCatalog(); // Filter from cache
    } else if (currentTab === "operations") {
      const jobsSearch = document.getElementById("jobs-search-input");
      if (jobsSearch) jobsSearch.value = query;
      jobsSearchQuery = query.trim();
      fetchAndRenderJobs();
    }
  }, 250));
}

// Settings Modal Handling
function setupSettings() {
  const modal = document.getElementById("settings-modal");
  const openBtn = document.getElementById("settings-open-btn");
  const closeBtn = document.getElementById("settings-close-btn");
  const cancelBtn = document.getElementById("settings-cancel-btn");
  const saveBtn = document.getElementById("settings-save-btn");

  openBtn.addEventListener("click", () => modal.classList.add("active"));
  
  const closeModal = () => modal.classList.remove("active");
  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  saveBtn.addEventListener("click", () => {
    const url = document.getElementById("setting-supabase-url").value.trim();
    const key = document.getElementById("setting-supabase-key").value.trim();
    let backendUrl = document.getElementById("setting-backend-url").value.trim();
    if (backendUrl && !backendUrl.startsWith("http://") && !backendUrl.startsWith("https://")) {
      backendUrl = "https://" + backendUrl;
      document.getElementById("setting-backend-url").value = backendUrl;
    }
    const spKey = document.getElementById("setting-simplyprint-key").value.trim();

    const spDispatchEnabled = document.getElementById("setting-sp-dispatch").checked;
    localStorage.setItem("orbot_supabase_url", url);
    localStorage.setItem("orbot_supabase_key", key);
    localStorage.setItem("orbot_backend_url", backendUrl);
    localStorage.setItem("orbot_simplyprint_key", spKey);
    localStorage.setItem("orbot_sp_dispatch_enabled", spDispatchEnabled ? "true" : "false");
    updateDispatchIndicator();

    closeModal();
    
    // Re-initialize
    if (initSupabase()) {
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
  });
}

// Setup logs filtering
function setupLogsFiltering() {
  document.querySelectorAll("#logs-filters .filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#logs-filters .filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeLogFilter = btn.getAttribute("data-level");
      fetchAndRenderLogs();
    });
  });
}

// Catalog Search & Filters
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
          dotEl.className = (prefix === "waybill-") ? "w-1.5 h-1.5 rounded-full bg-success" : (prefix === "header-") ? "w-2.5 h-2.5 rounded-full bg-success" : "status-light-online";
          textEl.innerText = "Online";
          textEl.style.color = "#10b981";
        } else {
          dotEl.className = (prefix === "waybill-") ? "w-1.5 h-1.5 rounded-full bg-error" : (prefix === "header-") ? "w-2.5 h-2.5 rounded-full bg-error" : "status-light-offline";
          textEl.innerText = "Offline";
          textEl.style.color = "#ff5252";
        }
      }
    });

    // --- Agents page cards ---
    const agentConfigs = [
      { name: "orbot_service", threshold: 120000, color: "#8b7cf6", dotId: "agents-hb-service-dot", textId: "agents-hb-service-text", timeId: "agents-hb-service-time", fleetId: null },
      { name: "scout",         threshold: 600000, color: "#22d3ee", dotId: "agents-hb-scout-dot",   textId: "agents-hb-scout-text",   timeId: "agents-hb-scout-time",   fleetId: "overview-fleet-scout" },
      { name: "orbot_service", threshold: 120000, color: "#8b7cf6", dotId: "agents-hb-foreman-dot", textId: "agents-hb-foreman-text", timeId: "agents-hb-foreman-time", fleetId: "overview-fleet-foreman" },
      { name: "waybill_agent", threshold: 600000, color: "#ffaa6b", dotId: "agents-hb-waybill-dot",  textId: "agents-hb-waybill-text",  timeId: "agents-hb-waybill-time", fleetId: "overview-fleet-waybill" },
      { name: "orbot_service", threshold: 120000, color: "#7ea6e8", dotId: "agents-hb-spsync-dot",  textId: "agents-hb-spsync-text",  timeId: "agents-hb-spsync-time", fleetId: "overview-fleet-spsync" },
    ];
    agentConfigs.forEach(({ name, threshold, color, dotId, textId, timeId, fleetId }) => {
      const hb = hbMap[name];
      const online = isOnline(hb?.last_heartbeat, threshold);
      const dotEl = document.getElementById(dotId);
      const textEl = document.getElementById(textId);
      const timeEl = document.getElementById(timeId);
      if (dotEl) dotEl.style.background = online ? "#10b981" : "#ff5252";
      if (textEl) { textEl.innerText = online ? "Online" : "Offline"; textEl.style.color = online ? "#10b981" : "#ff5252"; }
      if (timeEl) timeEl.innerText = timeAgo(hb?.last_heartbeat);

      // Overview dashboard's Agent Fleet summary — same signal again, list form.
      if (fleetId) {
        const fleetDot = document.getElementById(`${fleetId}-dot`);
        const fleetText = document.getElementById(`${fleetId}-text`);
        if (fleetDot) fleetDot.style.background = online ? "#10b981" : "#ff5252";
        if (fleetText) { fleetText.innerText = online ? "Online" : "Offline"; fleetText.style.color = online ? "#10b981" : "#ff5252"; }
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
      saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

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

    const backendUrl = (localStorage.getItem("orbot_backend_url") || "").replace(/\/$/, "");

    try {
      if (!backendUrl) throw new Error("Backend URL not set. Add your Railway URL in Settings.");
      const spKey = localStorage.getItem("orbot_simplyprint_key") || "";
      const spDispatch = isSpDispatchEnabled();
      if (!spDispatch) writeWaybillConsole("[DRY RUN] SimplyPrint dispatch is disabled — files will be processed but not sent to printers.", "warning");
      const response = await fetch(`${backendUrl}/foreman/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(spKey && { "X-SimplyPrint-Key": spKey }) },
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
            fetchAndRenderWaybillsArchive();
            fetchAndRenderMasterPDFs();
            document.getElementById("waybill-tab-pdfs")?.click();
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
          resultStr = `<span style="color: var(--error-color); font-weight: 500;">Error: ${j.result.error}</span>`;
        } else if (j.result.url) {
          resultStr = `<a href="${j.result.url}" target="_blank" class="px-2 py-1 bg-primary/10 hover:bg-primary/20 text-[#8b7cf6] rounded border border-primary/30 transition-all duration-150 inline-flex items-center gap-1.5 select-none no-underline text-[10px] font-semibold"><span class="material-symbols-outlined text-[12px] select-none">download</span> Download Batch</a>`;
        } else {
          resultStr = JSON.stringify(j.result);
        }
      }

      return `
        <tr class="group transition-all duration-150">
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-l border-outline-variant/15 rounded-l-lg font-data-mono text-xs text-on-surface select-all" title="${j.id}">${j.id.substring(0, 8)}...</td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15"><span class="badge secondary text-[10px] py-0.5 px-2 bg-white/5 uppercase select-none">${j.job_type}</span></td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15"><span class="badge ${statusClass} text-[10px] py-0.5 px-2 uppercase select-none">${j.status}</span></td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15 font-data-mono text-xs max-w-[150px] truncate text-on-surface-variant/70 select-all" title='${payloadStr}'>${payloadStr}</td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15 text-xs text-on-surface-variant/80 select-all">${resultStr}</td>
          <td class="py-2.5 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-r border-outline-variant/15 rounded-r-lg font-data-mono text-xs text-on-surface-variant/60">${dateStr}</td>
        </tr>
      `;
    }).join("");

  } catch (err) {
    tbody.innerHTML = emptyRow(`Error loading jobs: ${err.message}`, "error", 6);
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
    // Fetch 10 most recent jobs
    const { data: jobs, error: jError } = await supabaseClient
      .from("waybill_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10);

    // Fetch 10 most recent logs
    const { data: logs, error: lError } = await supabaseClient
      .from("system_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10);

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
            ? `Failed: ${j.result.error}` 
            : (j.result && j.result.url ? `Batch compiled. <a href="${j.result.url}" target="_blank" class="text-primary hover:underline font-bold">Download</a>` : `Job ${j.status}.`)
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
          detail: l.log_message
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
          <td class="py-2 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15 font-semibold text-on-surface">${item.source}</td>
          <td class="py-2 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-outline-variant/15"><span class="badge ${item.badgeClass} text-[9px] py-0.5 px-2 uppercase select-none">${item.badgeText}</span></td>
          <td class="py-2 px-4 bg-surface-container-low/40 group-hover:bg-surface-container/60 border-t border-b border-r border-outline-variant/15 rounded-r-lg text-on-surface-variant/80 text-[11px] max-w-[280px] truncate select-all" title="${item.detail.replace(/"/g, '&quot;')}">${item.detail}</td>
        </tr>
      `;
    }).join("");

  } catch (err) {
    console.error("Error fetching overview activity:", err);
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--error-color); padding: 2rem;">Error loading activity: ${err.message}</td></tr>`;
  }
}

// Dummy function to prevent errors from other components calling it
async function fetchAndRenderOverviewLogs() {
  // Integrated into fetchAndRenderOverviewJobs
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
        ? `<a href="${order.raw_waybill_gdrive_url}" target="_blank" class="px-2.5 py-1.5 rounded btn-archive-raw text-xs font-semibold transition-all duration-150 inline-flex items-center gap-1.5 select-none no-underline"><span class="material-symbols-outlined text-sm select-none">download</span> Download</a>`
        : `<span class="text-on-surface-variant/40 font-data-mono text-xs select-none">-</span>`;
 
      const processedBtn = order.processed_waybill_gdrive_url 
        ? `<a href="${order.processed_waybill_gdrive_url}" target="_blank" class="px-2.5 py-1.5 rounded btn-archive-processed text-xs font-bold transition-all duration-150 inline-flex items-center gap-1.5 select-none no-underline"><span class="material-symbols-outlined text-sm select-none">download</span> Download</a>`
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
    tbody.innerHTML = emptyRow(`Error loading waybills: ${err.message}`, "error", 6);
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
window.addEventListener("DOMContentLoaded", () => {
  // Start system clock
  updateSystemClock();
  setInterval(updateSystemClock, 1000);

  updateDispatchIndicator();

  if (initSupabase()) {
    // Load shops first so the header switcher + shop-scoped queries have data to work with.
    initShopSwitcher();
    fetchSummaryStats();
    fetchAgentHeartbeats();
    // Overview tab data — fetched eagerly since overview is the default tab
    fetchAndRenderOverviewJobs();
    fetchAndRenderOverviewLogs();
    fetchAndRenderPrintersAndQueue();
    // Orders are heavy (nested items + print_jobs); defer until the Orders tab is active
    // fetchAndRenderOrders() is called by setupTabs when the user switches to that tab
    
    // Poll stats and heartbeats
    setInterval(fetchSummaryStats, 300000);
    setInterval(() => {
      if (currentTab === "operations") {
        fetchAgentHeartbeats();
        fetchAndRenderJobs();
        fetchAndRenderGeminiUsage();
        fetchAndRenderPrintersAndQueue();
        fetchAndRenderPrintJobs();
      } else if (currentTab === "orders") {
        fetchAgentHeartbeats();
        fetchAndRenderWaybillsArchive();
      } else if (currentTab === "overview") {
        fetchAgentHeartbeats();
        fetchAndRenderOverviewJobs();
        fetchAndRenderOverviewLogs();
        fetchAndRenderPrintersAndQueue();
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
        bgStyle = `background:linear-gradient(to right,rgba(139,124,246,.28) ${pct}%,rgba(139,124,246,.07) ${pct}%);`;
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
          <div class="text-primary font-bold text-[10px] border-b border-white/10 pb-1.5 mb-1.5 truncate">${sku || disp}</div>
          <div class="space-y-0.5 text-[9px] text-on-surface-variant">
            <div class="truncate"><span class="opacity-50">File</span>&nbsp;${disp}</div>
            ${oid  ? `<div><span class="opacity-50">Order</span>&nbsp;${oid}</div>` : ''}
            ${cust ? `<div><span class="opacity-50">Customer</span>&nbsp;${cust}</div>` : ''}
            <div><span class="opacity-50">Duration</span>&nbsp;${dur}</div>
            <div><span class="opacity-50">${block.type === 'active' ? 'Finishes' : 'Starts ~'}</span>&nbsp;${fmtTime(block.type === 'active' ? block.end : block.start)}</div>
            ${block.type === 'active' ? `<div class="text-primary font-bold mt-0.5">${block.percent}% complete</div>` : ''}
          </div>
        </div>`;

      blocksHtml += `
        <div class="gantt-block ${cls}" style="left:${lp.toFixed(2)}%;width:${wp.toFixed(2)}%;${bgStyle}">
          ${wp > 5 ? `<span class="gantt-block-title">${disp}</span>` : ''}
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
            <span class="truncate text-[11px] font-semibold" title="${p.name}">${p.name}</span>
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
    // 1. Fetch Printers
    const { data: printers, error: printersError } = await supabaseClient
      .from("simplyprint_printers")
      .select("*")
      .order("name", { ascending: true });

    if (printersError) throw printersError;

    // Update printer error notification boxes
    const offlineOrErrorPrinters = (printers || []).filter(p => !p.online || (p.state && p.state.toLowerCase().includes("error")));
    const errorListHtml = offlineOrErrorPrinters.map(p => {
      const reason = !p.online ? "Printer is offline" : `Error state: ${p.state}`;
      return `<li><strong>${p.name}</strong>: ${reason}</li>`;
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

    const renderPrintersHtml = (prefix) => {
      if (!printers || printers.length === 0) {
        return `
          <div class="col-span-12 text-center py-12 text-outline font-data-mono">
            <span class="material-symbols-outlined text-3xl mb-2 block">print_disabled</span>
            No printers configured in database.
          </div>
        `;
      }

      return printers.map(p => {
        const statusClass = p.online ? "status-light-online" : "status-light-offline";
        let stateDisplay = p.online ? (p.state || 'unknown') : 'offline';
        const stateDisplayLower = stateDisplay.toLowerCase();
        if (stateDisplayLower === 'starting' || stateDisplayLower === 'starting print') {
          stateDisplay = 'finishing';
        }
        const stateClass = p.online ? (((p.state || '').toLowerCase() === "printing") ? "text-primary" : "text-outline") : "text-error";
        
        let printDetailsHtml = "";
        if (p.online && (p.current_job_name || (p.state || '').toLowerCase() === "printing" || p.percent_complete !== null)) {
          const progress = p.percent_complete || 0;
          const remainingMinutes = p.remaining_seconds ? Math.round(p.remaining_seconds / 60) : 0;
          const jobName = p.current_job_name || "Active Print Job";
          
          let remainingStr = "Finishing...";
          if (remainingMinutes > 0) {
            if (remainingMinutes >= 60) {
              const hours = Math.floor(remainingMinutes / 60);
              const mins = remainingMinutes % 60;
              remainingStr = `${hours}h ${mins}m remaining`;
            } else {
              remainingStr = `${remainingMinutes}m remaining`;
            }
          }
          
          printDetailsHtml = `
            <div class="mt-4 pt-3 border-t border-outline-variant/10 flex flex-col gap-2">
              <div class="flex justify-between items-center text-xs">
                <div class="text-on-surface font-semibold overflow-hidden text-ellipsis whitespace-nowrap max-w-[200px] cursor-help" 
                     interestfor="tooltip-${prefix}printer-${p.id}" 
                     id="trigger-${prefix}printer-${p.id}" 
                     tabindex="0" 
                     style="anchor-name: --tooltip-${prefix}printer-${p.id};">${jobName}</div>
                <span class="font-data-mono text-primary">${progress}%</span>
              </div>
              <div popover="hint" id="tooltip-${prefix}printer-${p.id}" style="position-anchor: --tooltip-${prefix}printer-${p.id}; top: anchor(bottom); left: anchor(left); margin: unset;">
                ${jobName}
              </div>
              <div class="w-full h-1.5 bg-black/40 rounded-full overflow-hidden border border-outline-variant/5">
                <div class="h-full bg-primary rounded-full transition-all duration-300" style="width: ${progress}%"></div>
              </div>
              <div class="flex items-center gap-1.5 text-[10px] text-outline mt-0.5">
                <span class="material-symbols-outlined text-xs">schedule</span>
                <span>${remainingStr}</span>
              </div>
            </div>
          `;
        } else if (p.online) {
          printDetailsHtml = `
            <div class="mt-4 pt-3 border-t border-outline-variant/10 flex items-center justify-center py-3 text-xs text-outline font-medium">
              <span class="material-symbols-outlined text-sm mr-1.5">hourglass_empty</span> Idle - Ready for jobs
            </div>
          `;
        } else {
          printDetailsHtml = `
            <div class="mt-4 pt-3 border-t border-outline-variant/10 flex items-center justify-center py-3 text-xs text-error/60 font-medium">
              <span class="material-symbols-outlined text-sm mr-1.5">wifi_off</span> Printer is offline
            </div>
          `;
        }

        const nozzleTempStr = p.nozzle_temp !== null ? `${Math.round(p.nozzle_temp)}°C` : "-";
        const nozzleTargetStr = p.nozzle_target ? ` / ${Math.round(p.nozzle_target)}°C` : "";
        const bedTempStr = p.bed_temp !== null ? `${Math.round(p.bed_temp)}°C` : "-";
        const bedTargetStr = p.bed_target ? ` / ${Math.round(p.bed_target)}°C` : "";

        const controlButtonsHtml = (prefix === "overview-") ? "" : `
          <div class="flex items-center gap-1.5 mt-3 pt-3 border-t border-outline-variant/10">
            <button class="printer-btn-ready flex-1 py-1 px-2 rounded bg-surface-container hover:bg-surface-container-high text-xs font-semibold text-on-surface border border-outline-variant/30 flex items-center justify-center gap-1 transition-all active:scale-95 disabled:opacity-50 whitespace-nowrap" data-printer-id="${p.id}" ${!p.online ? 'disabled' : ''}>
              <span class="material-symbols-outlined text-sm">done</span> Ready
            </button>
            <button class="printer-btn-pause flex-1 py-1 px-2 rounded bg-surface-container hover:bg-surface-container-high text-xs font-semibold text-on-surface border border-outline-variant/30 flex items-center justify-center gap-1 transition-all active:scale-95 disabled:opacity-50 whitespace-nowrap" data-printer-id="${p.id}" data-state="${p.state}" ${!p.online ? 'disabled' : ''}>
              <span class="material-symbols-outlined text-sm">${p.state === 'paused' ? 'play_arrow' : 'pause'}</span> ${p.state === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button class="printer-btn-estop flex-1 py-1 px-2 rounded bg-error/15 hover:bg-error/25 text-xs font-bold text-error border border-error/30 flex items-center justify-center gap-1 transition-all active:scale-95 whitespace-nowrap" data-printer-id="${p.id}" data-printer-name="${p.name}">
              <span class="material-symbols-outlined text-sm">emergency</span> E-Stop
            </button>
          </div>
        `;
        const temperaturesGridHtml = (prefix === "overview-") ? "" : `
              <!-- Temperatures Grid -->
              <div class="grid grid-cols-2 gap-2 mt-4 text-xs">
                <div class="bg-surface-container-lowest/40 border border-outline-variant/10 rounded-lg p-2 flex items-center gap-2">
                  <span class="material-symbols-outlined text-secondary text-sm">thermometer</span>
                  <div>
                    <div class="text-[9px] text-outline uppercase font-semibold">Nozzle</div>
                    <div class="font-data-mono text-on-surface mt-0.5">${nozzleTempStr}${nozzleTargetStr}</div>
                  </div>
                </div>
                <div class="bg-surface-container-lowest/40 border border-outline-variant/10 rounded-lg p-2 flex items-center gap-2">
                  <span class="material-symbols-outlined text-[#ffaa6b] text-sm">nest_heat_link_gen_3</span>
                  <div>
                    <div class="text-[9px] text-outline uppercase font-semibold">Bed</div>
                    <div class="font-data-mono text-on-surface mt-0.5">${bedTempStr}${bedTargetStr}</div>
                  </div>
                </div>
              </div>
        `;

        const cardAccentClass = !p.online ? "pcard-error" : ((p.state || "").toLowerCase() === "printing" ? "pcard-printing" : "pcard-idle");

        return `
          <div class="glass-panel rounded-xl p-4 flex flex-col justify-between hover:bg-surface-container-highest/10 transition-colors duration-300 ${cardAccentClass} ${p.online ? 'glow-hover-cyan' : 'glow-hover-red'}">
            <div>
              <div class="flex justify-between items-start">
                <div class="flex items-center gap-2.5">
                  <div class="w-8 h-8 rounded-lg bg-surface-container-highest border border-outline-variant/15 flex items-center justify-center">
                    <span class="material-symbols-outlined text-outline text-lg">print</span>
                  </div>
                  <div>
                    <h4 class="font-bold text-on-surface text-sm">${p.name}</h4>
                    <p class="text-[10px] font-data-mono mt-0.5">
                      ${p.autoprint 
                        ? `<span class="text-primary font-semibold">Plates: ${p.autoprint_current_jobs !== null ? p.autoprint_current_jobs : 0}/${p.autoprint_max_jobs !== null ? p.autoprint_max_jobs : 0}</span>` 
                        : `<span class="text-outline/60">Autoprint: Off</span>`
                      }
                    </p>
                  </div>
                </div>
                <div class="flex items-center gap-1.5 bg-black/25 px-2 py-0.5 rounded border border-outline-variant/10">
                  <div class="${statusClass}"></div>
                  <span class="text-[9px] font-data-mono uppercase tracking-wider ${stateClass}">${stateDisplay}</span>
                </div>
              </div>
              
              ${temperaturesGridHtml}
            </div>
            
            ${printDetailsHtml}
            
            ${controlButtonsHtml}
          </div>
        `;
      }).join("");
    };

    if (printersContainer) printersContainer.innerHTML = renderPrintersHtml("main-");
    if (overviewPrintersContainer) overviewPrintersContainer.innerHTML = renderPrintersHtml("overview-");

    // 2. Fetch Queue
    const { data: queue, error: queueError } = await supabaseClient
      .from("simplyprint_queue")
      .select("*")
      .order("position", { ascending: true });

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
          <div class="bg-surface-container-lowest/40 border border-outline-variant/10 p-3 rounded-lg flex items-center justify-between gap-3 hover:border-surface-tint/20 transition-all duration-200">
            <div class="flex items-center gap-3 min-w-0">
              <span class="w-6 h-6 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center font-data-mono text-[10px] text-primary font-bold shrink-0">#${q.position}</span>
              <div class="min-w-0">
                <p class="text-xs text-on-surface font-medium overflow-hidden text-ellipsis whitespace-nowrap max-w-[180px] cursor-help" 
                   interestfor="tooltip-${prefix}queue-${q.id}" 
                   id="trigger-${prefix}queue-${q.id}" 
                   tabindex="0" 
                   style="anchor-name: --tooltip-${prefix}queue-${q.id};">${q.name}</p>
                <div popover="hint" id="tooltip-${prefix}queue-${q.id}" style="position-anchor: --tooltip-${prefix}queue-${q.id}; top: anchor(bottom); left: anchor(left); margin: unset;">
                  ${q.name}
                </div>
                <p class="text-[9px] text-outline font-data-mono mt-0.5">SimplyPrint ID: ${q.id}</p>
              </div>
            </div>
            <span class="text-[10px] font-data-mono text-primary bg-primary/5 px-2 py-0.5 rounded border border-primary/10 shrink-0">${durationStr}</span>
          </div>
        `;
      }).join("");
    };

    if (queueContainer) queueContainer.innerHTML = renderQueueHtml("main-");
    if (overviewQueueContainer) overviewQueueContainer.innerHTML = renderQueueHtml("overview-");

    // Fetch active/pending print jobs for Gantt timeline
    try {
      const { data: activeJobs, error: jobsError } = await supabaseClient
        .from("print_jobs")
        .select("*, order_items(variant_sku, variant_name, orders(platform_order_id, customer_name)), print_files(print_time_m)")
        .in("job_execution_status", ["pending", "printing"]);

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

  setupTabs();
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
  setupGlobalSearch();
  setupCatalogDetailModal();
  setupCatalogEditModal();
  setupSystemErrorReset();
  setupListingsTab();

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

  // Logs panel toggle (System Logs ↔ Print Jobs)
  const logsTabSystem = document.getElementById("logs-tab-system");
  const logsTabPrintjobs = document.getElementById("logs-tab-printjobs");
  const logsPanelSystem = document.getElementById("logs-panel-system");
  const logsPanelPrintjobs = document.getElementById("logs-panel-printjobs");
  const logsActionsSystem = document.getElementById("logs-actions-system");
  const logsActionsPrintjobs = document.getElementById("logs-actions-printjobs");
  function setLogsTab(tab) {
    const isSystem = tab === "system";
    logsPanelSystem.classList.toggle("hidden", !isSystem);
    logsPanelPrintjobs.classList.toggle("hidden", isSystem);
    logsActionsSystem.classList.toggle("hidden", !isSystem);
    logsActionsPrintjobs.classList.toggle("hidden", isSystem);
    logsTabSystem.classList.toggle("bg-primary/15", isSystem);
    logsTabSystem.classList.toggle("text-primary", isSystem);
    logsTabSystem.classList.toggle("text-outline", !isSystem);
    logsTabSystem.classList.toggle("hover:bg-white/5", !isSystem);
    logsTabPrintjobs.classList.toggle("bg-primary/15", !isSystem);
    logsTabPrintjobs.classList.toggle("text-primary", !isSystem);
    logsTabPrintjobs.classList.toggle("text-outline", isSystem);
    logsTabPrintjobs.classList.toggle("hover:bg-white/5", isSystem);
    const titleEl = document.getElementById("logs-panel-title");
    const iconEl = document.getElementById("logs-panel-icon");
    if (titleEl) titleEl.textContent = isSystem ? "System Logs" : "Print Jobs";
    if (iconEl) iconEl.textContent = isSystem ? "description" : "print";
    if (!isSystem) fetchAndRenderLogsPagePrintJobs();
  }
  if (logsTabSystem) logsTabSystem.addEventListener("click", () => setLogsTab("system"));
  if (logsTabPrintjobs) logsTabPrintjobs.addEventListener("click", () => setLogsTab("printjobs"));

  // Action Buttons Events
  const refreshOrdersBtn = document.getElementById("refresh-orders-btn");
  if (refreshOrdersBtn) refreshOrdersBtn.addEventListener("click", fetchAndRenderOrders);

  const overviewRefreshOrdersBtn = document.getElementById("overview-orders-btn-refresh");
  if (overviewRefreshOrdersBtn) overviewRefreshOrdersBtn.addEventListener("click", fetchAndRenderOrders);

  // Stat card navigation
  function navigateToTab(tabId) {
    const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    if (btn) btn.click();
  }
  const statCardMap = {
    "stat-card-orders-today": "orders",
    "stat-card-pending": "orders",
    "stat-card-hold": "orders",
    "stat-card-queue": "printers",
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
      const backendUrl = (localStorage.getItem("orbot_backend_url") || "").replace(/\/$/, "");
      if (!backendUrl) { showToast("Backend URL not set in Settings.", "warning"); return; }
      const spKey = localStorage.getItem("orbot_simplyprint_key") || "";
      printFileBtn.disabled = true;
      printFileBtn.querySelector(".material-symbols-outlined").textContent = "sync";
      try {
        const res = await fetch(`${backendUrl}/print-files/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(spKey && { "X-SimplyPrint-Key": spKey }) },
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
          <td class="py-2 px-3 border-r border-outline-variant/10 font-bold text-on-surface">${job.simplyprint_job_id || "PENDING"}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-primary">${sku}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-on-surface-variant max-w-[200px] truncate" title="${job.print_file_name || ''}">${job.print_file_name || 'N/A'}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-on-surface-variant">${printer}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10">${progressHtml}</td>
          <td class="py-2 px-3 border-r border-outline-variant/10 text-on-surface-variant">${finishStr}</td>
          <td class="py-2 px-3">
            <span class="badge ${statusClass}" style="text-transform: capitalize;">${job.job_execution_status || 'Pending'}</span>
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
    listContainer.innerHTML = `<div class="font-data-mono text-xs text-error text-center py-12">Error loading print jobs: ${err.message}</div>`;
  }
}

// Promise-based Action Confirmation Modal
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

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmBtnText;

    const cleanup = () => {
      modal.classList.remove("active");
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onConfirm);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    const onConfirm = () => {
      cleanup();
      resolve(true);
    };

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

    if (decBtn) {
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
          <button class="btn-remove-print-file flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold text-error/60 hover:text-error hover:bg-error/10 transition-all cursor-pointer"
            data-file-id="${f.id}" data-file-name="${String(f.print_file_name ?? "").replace(/"/g, "&quot;")}">
            <span class="material-symbols-outlined text-[11px]">delete</span> Remove
          </button>
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
          <td class="py-2.5 px-3 border-r border-outline-variant/10 text-on-surface-variant/70 text-xs">${job.id}</td>
          <td class="py-2.5 px-3 border-r border-outline-variant/10 text-on-surface-variant">${details}</td>
          <td class="py-2.5 px-3 text-center">
            <a href="${fileUrl}" target="_blank" class="px-2.5 py-1 rounded bg-primary/10 hover:bg-primary/20 border border-primary/30 text-primary hover:scale-105 transition-transform flex items-center justify-center gap-1.5 cursor-pointer select-none mx-auto no-underline w-fit">
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
        Error loading compiled master PDFs: ${err.message}
      </div>
    `;
  }
}

// ─── Product Launch Tab ───────────────────────────────────────────────────────

let _launchImages = [];
let _launchTabReady = false;

function initLaunchTab() {
  if (_launchTabReady) return;
  _launchTabReady = true;

  renderLaunchImageGrid();

  // DS checkbox toggles plaque count row
  document.getElementById('launch-type-ds')?.addEventListener('change', (e) => {
    const row = document.getElementById('launch-plaque-row');
    if (row) row.classList.toggle('hidden', !e.target.checked);
    if (!e.target.checked) row?.classList.remove('flex');
    else row?.classList.add('flex');
  });

  // Image grid: click empty slot → open picker
  document.getElementById('launch-image-grid')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-empty]')) document.getElementById('launch-image-input')?.click();
  });

  // Image grid: drag & drop on the panel
  const panel = document.getElementById('launch-image-panel');
  panel?.addEventListener('dragover', (e) => { e.preventDefault(); panel.style.boxShadow = '0 0 0 1px #8b7cf6'; });
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
        <span class="material-symbols-outlined text-[#8b7cf6]" style="font-size:18px;animation:spin 1s linear infinite">sync</span>
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
    slot.className = 'aspect-square rounded-lg border border-dashed border-white/20 flex items-center justify-center cursor-pointer hover:border-[#8b7cf6]/60 transition-colors';
    slot.setAttribute('data-empty', '');
    slot.innerHTML = `<span class="material-symbols-outlined text-[#4b5563]" style="font-size:20px">add_photo_alternate</span>`;
    grid.appendChild(slot);
  }
}

function addLaunchImages(files) {
  const slots = 9 - _launchImages.length;
  _launchImages = [..._launchImages, ...files.filter(f => f.type.startsWith('image/')).slice(0, slots)];
  renderLaunchImageGrid();
}

// ─── Import from Link (scrape + logo removal) ────────────────────────────────

let _launchSourceUrl = null;
let _launchScrapedDescription = null;

function b64ToFile(b64, name) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: 'image/jpeg' });
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
    const backendUrl = localStorage.getItem('orbot_backend_url') || '';
    const res = await fetch(`${backendUrl}/catalog/scrape-product`, {
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

    const files = (data.images || []).map((img, i) => b64ToFile(img.image_b64, `scraped_${i + 1}.jpg`));
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
  const backendUrl = localStorage.getItem('orbot_backend_url') || '';
  let lastReason = null;
  await Promise.all(files.map(async (file) => {
    file._cleaning = true;
    renderLaunchImageGrid();
    try {
      const res = await fetch(`${backendUrl}/catalog/clean-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: await fileToB64(file) }),
      });
      const data = JSON.parse(await res.text());
      const idx = _launchImages.indexOf(file);
      if (res.ok && data.cleaned && idx !== -1) {
        const cleanedFile = b64ToFile(data.image_b64, file.name.replace('.jpg', '_clean.jpg'));
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
    setLaunchStatus('success', `Logo removal done — ${cleanedCount}/${_launchImages.length} image(s) cleaned. Review images, then Preview Listing.`);
  }
  logAction('clean_images', 'info', { cleaned: cleanedCount, total: _launchImages.length });
}

let _launchVariants = [];

function getLaunchFormData() {
  const types = [];
  if (document.getElementById('launch-type-ds')?.checked)   types.push('DS');
  if (document.getElementById('launch-type-dsnp')?.checked) types.push('DS-NP');
  if (document.getElementById('launch-type-wm')?.checked)   types.push('WM');
  if (document.getElementById('launch-type-fwm')?.checked)  types.push('FWM');
  const platforms = [];
  if (document.getElementById('launch-plat-shopee')?.checked) platforms.push('shopee');
  if (document.getElementById('launch-plat-lazada')?.checked) platforms.push('lazada');
  return {
    set_name:         document.getElementById('launch-set-name')?.value.trim(),
    set_number:       document.getElementById('launch-set-number')?.value.trim(),
    theme:            document.getElementById('launch-theme')?.value,
    brand_name:       document.getElementById('launch-brand-name')?.value.trim() || 'Blocked Off',
    product_category: document.getElementById('launch-product-category')?.value.trim() || '',
    product_types: types,
    plaque_count: parseInt(document.getElementById('launch-plaque-count')?.value) || 1,
    price_myr:    parseFloat(document.getElementById('launch-price')?.value) || null,
    price_sgd:    parseFloat(document.getElementById('launch-price-sgd')?.value) || null,
    platforms,
  };
}

function setLaunchStatus(type, msg) {
  const el = document.getElementById('launch-status');
  if (!el) return;
  el.className = `glass-panel px-5 py-3 text-sm ${type === 'error' ? 'text-red-400 border border-red-500/20' : 'text-[#8b7cf6]'}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function doLaunchPreview() {
  const { set_name, set_number, theme, brand_name, product_types, plaque_count, price_myr, platforms } = getLaunchFormData();
  if (!set_name || !set_number || !theme || product_types.length === 0) {
    setLaunchStatus('error', 'Fill in set name, set number, theme, and select at least one product type.');
    return;
  }
  if (platforms.length === 0) { setLaunchStatus('error', 'Select at least one platform.'); return; }

  const btn = document.getElementById('launch-preview-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined text-base" style="animation:spin 1s linear infinite">sync</span> Generating...';
  document.getElementById('launch-status')?.classList.add('hidden');

  try {
    const backendUrl = localStorage.getItem('orbot_backend_url') || '';
    const res = await fetch(`${backendUrl}/catalog/preview-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set_name, set_number, theme, brand_name, product_types, plaque_count, price_myr, platforms }),
    });
    const data = JSON.parse(await res.text());
    if (!res.ok) throw new Error(data.detail || JSON.stringify(data));

    document.getElementById('launch-listing-title').value = data.listing_title;
    document.getElementById('launch-description').value   = data.description;

    _launchVariants = data.variants;

    const tbody = document.getElementById('launch-variants-body');
    tbody.innerHTML = data.variants.map(v => `
      <tr>
        <td class="py-2 pr-6 text-[#8b7cf6]">${v.sku}</td>
        <td class="py-2 pr-6 text-[#9ca3af]">${v.platform_variation_name}</td>
        <td class="py-2 text-right text-white">${v.price_myr ? 'MYR ' + Number(v.price_myr).toFixed(2) : '—'}</td>
      </tr>`).join('');

    const detailsTbody = document.getElementById('launch-variant-details-body');
    detailsTbody.innerHTML = data.variants.map((v, i) => `
      <tr>
        <td class="py-2 pr-4 text-[#8b7cf6] font-mono text-xs">${v.sku}</td>
        <td class="py-2 pr-3"><input id="lv-${i}-stock" type="number" value="0" min="0" class="w-16 text-center" style="padding:0.25rem 0.375rem !important" /></td>
        <td class="py-2 pr-3"><input id="lv-${i}-seal" type="text" placeholder="https://drive.google.com/…" class="w-full" style="padding:0.25rem 0.5rem !important; font-size:0.7rem" /></td>
        <td class="py-2 pr-3"><input id="lv-${i}-files" type="text" placeholder="https://drive.google.com/…" class="w-full" style="padding:0.25rem 0.5rem !important; font-size:0.7rem" /></td>
        <td class="py-2 pr-3"><input id="lv-${i}-pics" type="text" placeholder="https://drive.google.com/…" class="w-full" style="padding:0.25rem 0.5rem !important; font-size:0.7rem" /></td>
        <td class="py-2"><input id="lv-${i}-adobe" type="text" placeholder="https://express.adobe.com/…" class="w-full" style="padding:0.25rem 0.5rem !important; font-size:0.7rem" /></td>
      </tr>`).join('');

    document.getElementById('launch-preview-section')?.classList.remove('hidden');
    document.getElementById('launch-preview-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setLaunchStatus('error', `Preview failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined text-base">auto_awesome</span> Preview Listing';
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
    const backendUrl = localStorage.getItem('orbot_backend_url') || '';
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

    const res = await fetch(`${backendUrl}/catalog/launch-product`, { method: 'POST', body: fd });
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
      tbody.innerHTML = emptyDiv(`Error loading listings: ${err.message}`, "error");
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
    const coverageColor = platformCount === 5 ? "#8b7cf6" : platformCount >= 3 ? "#eab308" : "#ef4444";

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
        <a href="${p.url}" target="_blank" rel="noopener noreferrer" class="opacity-0 group-hover:opacity-100 p-0.5 rounded text-outline/60 hover:text-[#8b7cf6] transition-all" title="Open ${p.label}" onclick="event.stopPropagation()">
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
      document.querySelectorAll(".listings-filter-btn").forEach(b => {
        b.classList.remove("bg-primary/15", "text-primary");
        b.classList.add("text-outline");
      });
      btn.classList.add("bg-primary/15", "text-primary");
      btn.classList.remove("text-outline");
      listingsActiveFilter = btn.dataset.filter;
      renderListingsFromCache();
    });
  });

  document.querySelectorAll(".listings-platform-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".listings-platform-btn").forEach(b => {
        b.classList.remove("bg-primary/15", "text-primary");
        b.classList.add("text-outline");
      });
      btn.classList.add("bg-primary/15", "text-primary");
      btn.classList.remove("text-outline");
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
  document.getElementById("edit-variation-modal")?.addEventListener("click", e => { if (e.target === e.currentTarget) closeEditVariationModal(); });

  document.getElementById("btn-add-listing")?.addEventListener("click", openAddListingModal);
  document.getElementById("add-listing-close-btn")?.addEventListener("click", closeAddListingModal);
  document.getElementById("add-listing-cancel-btn")?.addEventListener("click", closeAddListingModal);
  document.getElementById("add-listing-save-btn")?.addEventListener("click", saveAddListing);
  document.getElementById("add-listing-modal")?.addEventListener("click", e => { if (e.target === e.currentTarget) closeAddListingModal(); });
  document.getElementById("add-listing-product-filter")?.addEventListener("input", e => filterAddListingProducts(e.target.value));
}

function openEditListingModal(listing) {
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
  const saveBtn = document.getElementById("edit-listing-save-btn");
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span class="material-symbols-outlined text-sm animate-spin">sync</span> Saving…`;

  const updates = {
    platform_listing_name:        document.getElementById("edit-listing-name").value.trim(),
    platform_listing_description: document.getElementById("edit-listing-description").value,
    price_myr:   parseFloat(document.getElementById("edit-listing-price-myr").value) || null,
    price_sgd:   parseFloat(document.getElementById("edit-listing-price-sgd").value) || null,
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
    if (idx !== -1) cachedListings[idx] = { ...cachedListings[idx], ...updates };
    closeEditListingModal();
    renderListingsFromCache();
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

  document.getElementById("edit-variation-modal").classList.add("active");
}

function closeEditVariationModal() {
  document.getElementById("edit-variation-modal").classList.remove("active");
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
    showToast("Variation saved.", "success");
  } catch (err) {
    showToast(`Save failed: ${err.message}`, "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = `<span class="material-symbols-outlined text-sm">save</span> Save`;
  }
}

async function openAddListingModal() {
  const sel = document.getElementById("add-listing-product-id");
  // Load products once
  if (sel && sel.options.length === 0) {
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
  if (sel) sel.selectedIndex = -1;
  document.getElementById("add-listing-modal").classList.add("active");
}

function filterAddListingProducts(query) {
  const sel = document.getElementById("add-listing-product-id");
  if (!sel) return;
  const q = query.toLowerCase().trim();
  Array.from(sel.options).forEach(opt => {
    opt.style.display = !q || (opt.dataset.search || "").includes(q) ? "" : "none";
  });
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
    price_myr:  parseFloat(document.getElementById("add-listing-price-myr").value) || null,
    price_sgd:  parseFloat(document.getElementById("add-listing-price-sgd").value) || null,
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
