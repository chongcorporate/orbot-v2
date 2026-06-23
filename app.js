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
let cachedVariants = [];
let cachedFilteredWaybills = [];
let ganttTimeWindow = 24;

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
    info:    { bg: "rgba(164,232,68,0.12)", border: "rgba(164,232,68,0.4)", text: "#a4e844", icon: "info" },
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
      log_data: Object.keys(meta).length ? meta : null
    });
  } catch (_) {}
}

function loadingDiv() {
  return `<div class="flex items-center justify-center gap-2 py-12 text-outline"><span class="material-symbols-outlined text-xl animate-spin">sync</span><span class="font-data-mono text-xs">Loading...</span></div>`;
}

function emptyDiv(message, icon = "search_off") {
  return `<div class="flex flex-col items-center justify-center gap-2 py-12 text-outline"><span class="material-symbols-outlined text-2xl">${icon}</span><span class="font-data-mono text-xs">${message}</span></div>`;
}

function loadingRow(colspan = 6) {
  return `<tr><td colspan="${colspan}" class="py-12 text-center"><div class="flex items-center justify-center gap-2 text-outline"><span class="material-symbols-outlined text-xl animate-spin">sync</span><span class="font-data-mono text-xs">Loading...</span></div></td></tr>`;
}

function emptyRow(message, icon = "search_off", colspan = 6) {
  return `<tr><td colspan="${colspan}" class="py-12 text-center"><div class="flex flex-col items-center gap-2 text-outline"><span class="material-symbols-outlined text-2xl">${icon}</span><span class="font-data-mono text-xs">${message}</span></div></td></tr>`;
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

  const statusDot = document.getElementById("db-status-dot");
  const statusText = document.getElementById("db-status-text");

  if (!supabaseUrl || !supabaseKey) {
    statusDot.className = "dot error pulse";
    statusText.innerText = "Settings Required";
    console.error("Supabase credentials not configured.");
    return false;
  }

  try {
    supabaseClient = supabase.createClient(supabaseUrl, supabaseKey);
    statusDot.className = "dot pulse";
    statusText.innerText = "Connected";
    return true;
  } catch (error) {
    statusDot.className = "dot error";
    statusText.innerText = "Connection Failed";
    console.error("Failed to initialize Supabase client:", error);
    return false;
  }
}

// Stats & General Refreshes
async function fetchSummaryStats() {
  if (!supabaseClient) return;

  try {
    // 1. Fetch orders timestamps for filtering
    const { data: ordersData, error: oError } = await supabaseClient
      .from("orders")
      .select("order_timestamp, created_at, overall_order_status");
    
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

    document.getElementById("stats-orders").innerText = ordersTodayCount;

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
    document.getElementById("stats-items").innerText = pendingOrdersCount;
    document.getElementById("stats-hold").innerText = ordersOnHoldCount;
    
    const errorEl = document.getElementById("stats-errors");
    errorEl.innerText = errorsCount ?? 0;
    if (errorsCount > 0) {
      errorEl.style.color = "var(--error-color)";
      errorEl.style.textShadow = "0 0 10px var(--error-glow)";
    } else {
      errorEl.style.color = "var(--text-primary)";
      errorEl.style.textShadow = "none";
    }
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
        .select("*, order_items(id, variant_sku, variant_name, purchased_quantity, item_print_status, sent_to_print_timestamp, print_jobs(id, print_file_name, simplyprint_job_id, job_execution_status, printer_name, queue_position, estimated_finish_time, percent_complete))")
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
      renderOrdersTableToContainer(listContainer, "", filtered);
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
    container.innerHTML = emptyDiv("No matching orders found.", "receipt_long");
    return;
  }

  let html = `
    <table class="w-full text-left border-collapse text-xs font-body-md" id="${prefix}orders-table">
      <thead>
        <tr class="bg-surface-container-low border-b border-outline-variant/20 sticky top-0 z-20">
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10 w-8 text-center"></th>
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Order ID</th>
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
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10">Printer / Queue</th>
          <th class="py-2 px-3 font-semibold text-on-surface-variant border-r border-outline-variant/10 text-center">ETA</th>
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
    
    // Calculate SimplyPrint live telemetry metrics
    const allJobs = [];
    itemsList.forEach(item => {
      if (item.print_jobs) {
        item.print_jobs.forEach(job => {
          allJobs.push({
            ...job,
            itemSku: item.variant_sku
          });
        });
      }
    });

    let printerQueueText = "-";
    const printingJobs = allJobs.filter(j => j.job_execution_status === 'printing');
    if (printingJobs.length > 0) {
      const printingPrinters = [...new Set(printingJobs.filter(j => j.printer_name).map(j => j.printer_name))];
      printerQueueText = printingPrinters.length > 0 
        ? printingPrinters.map(p => `[${p}]`).join(", ") 
        : "Printing";
    } else {
      const pendingJobs = allJobs.filter(j => j.job_execution_status === 'pending' && j.queue_position !== null && j.queue_position !== undefined);
      if (pendingJobs.length > 0) {
        const minQueue = Math.min(...pendingJobs.map(j => j.queue_position));
        printerQueueText = `Queue: #${minQueue}`;
      }
    }

    let etaHtmlCol = `<span class="text-on-surface-variant/40 font-data-mono text-[10px]">-</span>`;
    if (printingJobs.length > 0) {
      const finishTimes = printingJobs.map(j => j.estimated_finish_time).filter(t => t);
      let longestEta = "";
      if (finishTimes.length > 0) {
        const maxTime = new Date(Math.max(...finishTimes.map(t => new Date(t).getTime())));
        longestEta = formatEta(maxTime.toISOString());
      }
      
      if (longestEta) {
        const displayEta = longestEta.replace("ETA: ~", "~").replace("ETA: ", "");
        etaHtmlCol = `<span class="font-data-mono text-[10px] text-surface-tint font-bold">${displayEta}</span>`;
      } else {
        etaHtmlCol = `<span class="font-data-mono text-[10px] text-surface-tint font-semibold">Printing</span>`;
      }
    } else if (allJobs.length > 0) {
      const completedJobs = allJobs.filter(j => j.job_execution_status === 'completed');
      const failedJobs = allJobs.filter(j => j.job_execution_status === 'failed');
      
      if (completedJobs.length === allJobs.length) {
        etaHtmlCol = `<span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 font-data-mono text-[10px]">Done</span>`;
      } else if (failedJobs.length > 0) {
        etaHtmlCol = `<span class="px-2 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20 font-data-mono text-[10px]">Failed</span>`;
      } else {
        etaHtmlCol = `<span class="px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20 font-data-mono text-[10px]">Queued</span>`;
      }
    }

    // Build Details HTML (Pre-rendered for zero-latency toggle)
    let detailsHtml = "";
    if (itemsList.length === 0) {
      detailsHtml = `<div class="font-data-mono text-xs text-outline py-2 text-center">No items found in this order.</div>`;
    } else {
      detailsHtml = `<div class="flex flex-col gap-3">`;
      for (const item of itemsList) {
        const dateStr = item.sent_to_print_timestamp ? new Date(item.sent_to_print_timestamp).toLocaleString() : "Not Dispatched";
        
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

                return `
                  <div class="flex flex-col p-2.5 rounded bg-black/30 border border-outline-variant/10 text-xs w-full">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div class="flex items-center gap-1.5 min-w-0">
                        <span class="material-symbols-outlined text-surface-tint text-base flex-shrink-0">code</span>
                        <div class="font-data-mono text-on-surface-variant overflow-x-auto whitespace-nowrap scrollbar-thin max-w-[280px]" title="${j.print_file_name}">${j.print_file_name}</div>
                        <span class="text-on-surface-variant/40 font-data-mono text-[10px]">(${j.simplyprint_job_id})</span>
                      </div>
                      <div class="flex items-center gap-1.5 ml-auto">
                        ${extraStatus}
                        ${etaHtml}
                        <span class="badge ${badgeClass} text-[10px] py-0.5 px-2.5">${j.job_execution_status}</span>
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
        <td class="py-2.5 px-3 border-r border-outline-variant/10 font-data-mono font-bold text-on-surface select-all">${escapeHtml(order.platform_order_id)}</td>
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
        <td class="py-2.5 px-3 border-r border-outline-variant/10 font-data-mono font-medium text-on-surface-variant/85">${printerQueueText}</td>
        <td class="py-2.5 px-3 border-r border-outline-variant/10 text-center">${etaHtmlCol}</td>
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
        <td colspan="${prefix === "" ? "12" : "11"}" class="p-3 border-r border-outline-variant/10">
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
        const backendUrl = (localStorage.getItem("orbot_backend_url") || "").replace(/\/$/, "");
        if (!backendUrl) throw new Error("Backend URL not set. Add your Railway URL in Settings.");

        const spKey = localStorage.getItem("orbot_simplyprint_key") || "";
        const response = await fetch(`${backendUrl}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(spKey && { "X-SimplyPrint-Key": spKey }) },
          body: JSON.stringify({ order_id: orderId })
        });

        const rawText = await response.text();
        let resData;
        try { resData = JSON.parse(rawText); } catch { throw new Error(`Backend error (HTTP ${response.status}) calling ${backendUrl}/cancel: ${rawText.substring(0, 80)}`); }
        if (!response.ok) throw new Error(resData.detail || resData.error || `HTTP ${response.status}`);

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
      if (!await showConfirmModal("Complete All Orders", "Are you sure you want to mark all orders as completed? This cannot be undone.", "Complete All")) return;
      try {
        completeAllOrdersBtn.disabled = true;
        
        const { error } = await supabaseClient
          .from("orders")
          .update({ overall_order_status: "completed" })
          .neq("id", "00000000-0000-0000-0000-000000000000");
          
        if (error) throw error;
        
        showToast("All orders marked as completed.", "success");
        fetchSummaryStats();
        fetchAndRenderOrders();
      } catch (err) {
        showToast(`Failed to complete all orders: ${err.message}`, "error");
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

    if (productsList.length === 0) {
      tbody.innerHTML = emptyDiv("No catalog items found matching filters.", "inventory_2");
      return;
    }

    tbody.innerHTML = productsList.map(p => {
      // Calculate totals across variations
      let totalWeight = 0;
      let totalTime = 0;
      let totalSlices = 0;
      p.variations.forEach(v => {
        if (v.print_files) {
          totalWeight += v.print_files.reduce((sum, f) => sum + (f.weight_g || 0), 0);
          totalTime += v.print_files.reduce((sum, f) => sum + (f.print_time_m || 0), 0);
          totalSlices += v.print_files.length;
        }
      });

      let totalsText = "";
      if (totalSlices > 0) {
        totalsText = `<span class="text-[10px] font-semibold text-outline tracking-wider uppercase">${totalWeight}G | ${totalTime}M (${totalSlices} Slices)</span>`;
      } else {
        totalsText = `<span class="text-[10px] text-on-surface-variant/30 italic">No files mapped</span>`;
      }

      const variationsHtml = p.variations.map(v => {
        const filesHtml = v.print_files && v.print_files.length > 0
          ? `
            <div class="flex flex-wrap gap-1.5 mt-1.5">
              ${v.print_files.map(f => `
                <div class="font-data-mono text-[10px] flex items-center gap-2 bg-black/20 hover:bg-black/35 px-2.5 py-1 rounded border border-outline-variant/10 hover:border-outline-variant/25 transition-all duration-200 min-w-0">
                  <span class="material-symbols-outlined text-[12px] text-surface-tint/70 select-none">description</span>
                  <span class="text-on-surface-variant truncate font-medium max-w-[120px] sm:max-w-[180px] select-all" title="${f.print_file_name}">${f.print_file_name}</span>
                  <span class="text-on-surface-variant/40 text-[9px] font-semibold flex-shrink-0 tracking-wider border-l border-outline-variant/10 pl-2 ml-1">${f.weight_g}G | ${f.print_time_m}M</span>
                  ${f.simplyprint_file_id ? `<button class="btn-send-file-print flex-shrink-0 flex items-center justify-center w-5 h-5 rounded hover:bg-primary/20 text-primary/60 hover:text-primary transition-all active:scale-90" data-sp-file-id="${f.simplyprint_file_id}" data-file-name="${f.print_file_name}" title="Send to print queue" type="button"><span class="material-symbols-outlined text-[12px] pointer-events-none">print</span></button>` : ''}
                </div>
              `).join("")}
            </div>
          `
          : `<div class="text-on-surface-variant/30 font-data-mono text-[10px] mt-1.5 italic">No print slices mapped.</div>`;

        let typeBadgeClass = "bg-primary/5 text-primary border-primary/20";
        if (v.variant_type === "WM") {
          typeBadgeClass = "bg-[#bc13fe]/5 text-[#ebb2ff] border-[#bc13fe]/20";
        } else if (v.variant_type === "BASE") {
          typeBadgeClass = "bg-amber-500/5 text-amber-400 border-amber-500/20";
        } else if (v.variant_type === "DS-NP") {
          typeBadgeClass = "bg-emerald-500/5 text-emerald-400 border-emerald-500/20";
        }

        return `
          <div class="flex flex-col md:flex-row justify-between items-start md:items-center p-3 rounded-lg bg-surface-container-low/40 border border-outline-variant/10 gap-3">
            <div class="flex-grow min-w-0 w-full md:w-auto">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="badge text-[9px] font-bold py-0.5 px-2.5 rounded-full border ${typeBadgeClass} uppercase select-none flex-shrink-0">${v.variant_type}</span>
                <span class="font-data-mono text-xs font-semibold tracking-wider text-[#ebb2ff] break-all select-all">${v.variant_sku}</span>
                <span class="text-sm font-medium text-on-surface truncate ml-2" title="${v.variant_name}">${v.variant_name}</span>
              </div>
              ${filesHtml}
            </div>
            <div class="flex-shrink-0 flex items-center gap-2 self-stretch md:self-auto justify-end border-t md:border-t-0 border-outline-variant/5 pt-2 md:pt-0">
              ${v.seal_sticker_gdrive_url ? `<button class="btn-seal-sticker flex items-center gap-1 text-[10px] font-label-caps text-on-surface-variant/60 hover:text-amber-400 transition-colors active:scale-95 uppercase tracking-wider select-none" data-url="${v.seal_sticker_gdrive_url}" data-sku="${v.variant_sku}" title="Download seal sticker" type="button"><span class="material-symbols-outlined text-[13px] pointer-events-none">label</span>Seal</button>` : ''}
              <span class="text-[10px] font-label-caps text-on-surface-variant/60 uppercase tracking-wider select-none">Stock:</span>
              <div class="flex items-center bg-black/30 border border-outline-variant/20 rounded-lg p-0.5 overflow-hidden">
                <button class="w-6 h-6 flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-white/10 rounded transition-all active:scale-95 btn-stock-dec" data-variant-id="${v.id}" type="button">-</button>
                <input type="number" min="0" value="${v.stock_quantity || 0}" class="w-10 bg-transparent text-center text-xs font-bold text-on-surface border-0 p-0 outline-none select-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none input-stock-qty" data-variant-id="${v.id}">
                <button class="w-6 h-6 flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-white/10 rounded transition-all active:scale-95 btn-stock-inc" data-variant-id="${v.id}" type="button">+</button>
              </div>
            </div>
          </div>
        `;
      }).join("");

      return `
        <div class="glass-panel border border-outline-variant/10 hover:border-[#bc13fe]/30 rounded-xl p-4 transition-all duration-300 group relative overflow-hidden flex flex-col gap-3 product-card glow-hover-purple" data-product-id="${p.id}">
          <div class="absolute inset-0 bg-gradient-to-r from-secondary-container/0 via-secondary-container/[0.01] to-secondary-container/0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"></div>

          <!-- Product Card Header (clickable toggle) -->
          <div class="product-card-header flex justify-between items-center cursor-pointer select-none relative z-10 w-full" data-product-id="${p.id}">
            <div class="flex flex-col gap-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-data-mono text-[10px] font-semibold tracking-wider text-[#ebb2ff] select-all bg-surface-container/40 px-2 py-0.5 rounded">${p.master_sku}</span>
                <h4 class="text-sm font-semibold text-on-surface group-hover:text-surface-tint transition-colors duration-300 leading-snug truncate" title="${p.product_base_name}">${p.product_base_name}</h4>
              </div>
              <div class="flex items-center gap-1.5 text-[10px] font-medium text-on-surface-variant/50 uppercase tracking-wider mt-1">
                <span class="material-symbols-outlined text-[12px] select-none">sell</span>
                <span>${p.brand_name}</span>
                <span class="text-outline/40">•</span>
                <span>${p.product_category}</span>
              </div>
            </div>

            <!-- Right column: totals & arrow -->
            <div class="flex items-center gap-3">
              <div class="hidden sm:flex flex-col items-end gap-0.5 text-right">
                <span class="badge bg-[#bc13fe]/10 text-[#ebb2ff] text-[9px] font-bold py-0.5 px-2.5 rounded-full border border-[#bc13fe]/20 select-none">${p.variations.length} Variation${p.variations.length > 1 ? 's' : ''}</span>
                <div class="flex items-center gap-1 mt-0.5">
                  <span class="material-symbols-outlined text-[12px] text-on-surface-variant/40 select-none">layers</span>
                  ${totalsText}
                </div>
              </div>
              <button class="w-8 h-8 flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-white/10 rounded-full transition-all active:scale-95 btn-product-details cursor-pointer z-20" data-product-id="${p.id}" title="View Details" type="button">
                <span class="material-symbols-outlined text-lg">info</span>
              </button>
              <span class="material-symbols-outlined text-outline text-lg transition-transform duration-250 toggle-icon">expand_more</span>
            </div>
          </div>

          <!-- Variations Collapsible Container -->
          <div class="variations-container hidden mt-2 border-t border-outline-variant/10 pt-3 flex flex-col gap-2 relative z-10">
            <!-- Variation rows -->
            ${variationsHtml}
          </div>
        </div>
      `;
    }).join("");

  } catch (err) {
    if (tbody) tbody.innerHTML = emptyDiv(`Error loading catalog: ${err.message}`, "error");
  }
}

// Ingestion handling
async function runManualIngestion() {
  const emailBody = document.getElementById("email-body-input").value.trim();
  const consoleEl = document.getElementById("ingest-console");

  if (!emailBody) {
    showToast("Please paste an email body first.", "warning");
    return;
  }

  // Helper to log to console
  const writeConsole = (text, type = "") => {
    const line = document.createElement("div");
    line.className = `terminal-line ${type}`;
    line.innerText = `[${new Date().toLocaleTimeString()}] ${text}`;
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  };

  writeConsole("Starting manual ingestion...", "info");
  
  const supabaseUrl = document.getElementById("setting-supabase-url").value.trim();
  const supabaseKey = document.getElementById("setting-supabase-key").value.trim();

  const backendUrl = (localStorage.getItem("orbot_backend_url") || "").replace(/\/$/, "");
  if (!backendUrl) {
    writeConsole("Backend URL not set. Add your Railway URL in Settings.", "error");
    return;
  }

  try {
    writeConsole("Contacting backend at /scout/ingest-email...", "info");

    const response = await fetch(`${backendUrl}/scout/ingest-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email_body: emailBody })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend returned HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    writeConsole(`Success! Response: ${data.status || JSON.stringify(data)}`, "info");
    writeConsole("Order ingestion complete. Foreman has been triggered to dispatch print files.", "info");
    
    // Clean up input
    document.getElementById("email-body-input").value = "";
    
    // Refresh stats and orders
    setTimeout(() => {
      fetchSummaryStats();
      if (currentTab === "orders") fetchAndRenderOrders();
    }, 1500);

  } catch (err) {
    writeConsole(`Ingestion Error: ${err.message}`, "error");
    showToast(`Ingestion failed: ${err.message}`, "error");
  }
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
        } else if (tabId === "catalog") {
          const catalogSearch = document.getElementById("catalog-search");
          globalSearch.value = catalogSearch ? catalogSearch.value : "";
        } else if (tabId === "waybills") {
          globalSearch.value = waybillSearchQuery;
          const waybillSearch = document.getElementById("waybill-search-input");
          if (waybillSearch) waybillSearch.value = waybillSearchQuery;
        } else if (tabId === "agents") {
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
      if (tabId === "orders") fetchAndRenderOrders();
      if (tabId === "logs") { fetchAndRenderLogs(); fetchAndRenderLogsPagePrintJobs(); }
      if (tabId === "catalog") fetchAndRenderCatalog();
      if (tabId === "waybills") {
        fetchAgentHeartbeats();
        fetchAndRenderWaybillsArchive();
        fetchAndRenderMasterPDFs();
      }
      if (tabId === "agents") {
        fetchAgentHeartbeats();
        fetchAndRenderJobs();
        fetchAndRenderGeminiUsage();
      }
      if (tabId === "printers") {
        fetchAndRenderPrintersAndQueue();
        fetchAndRenderPrintJobs();
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
    } else if (currentTab === "catalog") {
      const catalogSearch = document.getElementById("catalog-search");
      if (catalogSearch) catalogSearch.value = query;
      fetchAndRenderCatalog(); // Filter from cache
    } else if (currentTab === "waybills") {
      const waybillSearch = document.getElementById("waybill-search-input");
      if (waybillSearch) waybillSearch.value = query;
      waybillSearchQuery = query.trim();
      fetchAndRenderWaybillsArchive();
    } else if (currentTab === "agents") {
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

    localStorage.setItem("orbot_supabase_url", url);
    localStorage.setItem("orbot_supabase_key", key);
    localStorage.setItem("orbot_backend_url", backendUrl);
    localStorage.setItem("orbot_simplyprint_key", spKey);

    closeModal();
    
    // Re-initialize
    if (initSupabase()) {
      fetchSummaryStats();
      if (currentTab === "orders") fetchAndRenderOrders();
      if (currentTab === "logs") fetchAndRenderLogs();
      if (currentTab === "catalog") {
        cachedVariants = [];
        fetchAndRenderCatalog();
      }
      if (currentTab === "agents") {
        fetchAgentHeartbeats();
        fetchAndRenderJobs();
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
async function fetchAgentHeartbeats() {
  if (!supabaseClient) return;
  try {
    const { data: heartbeats, error } = await supabaseClient
      .from("agent_heartbeats")
      .select("*");
    if (error) throw error;

    const now = new Date();
    const isOnline = (hbTimeStr) => {
      if (!hbTimeStr) return false;
      const hbTime = new Date(hbTimeStr);
      return (now - hbTime) < 15000; // Online if within 15 seconds
    };

    const hb = heartbeats.find(h => h.agent_name === "orbot_service");
    const online = hb && isOnline(hb.last_heartbeat);

    const prefixes = ["", "waybill-", "overview-", "header-"];
    prefixes.forEach(prefix => {
      const dotEl = document.getElementById(`${prefix}hb-orbot_service-dot`);
      const textEl = document.getElementById(`${prefix}hb-orbot_service-text`);
      
      if (dotEl && textEl) {
        if (online) {
          // Adjust class name/appearance depending on context
          if (prefix === "header-" || prefix === "waybill-") {
            dotEl.className = prefix === "waybill-" ? "w-1.5 h-1.5 rounded-full bg-success" : "w-2.5 h-2.5 rounded-full bg-success";
          } else {
            dotEl.className = "status-light-online";
          }
          textEl.innerText = "Online";
          textEl.style.color = "#10b981";
        } else {
          if (prefix === "header-" || prefix === "waybill-") {
            dotEl.className = prefix === "waybill-" ? "w-1.5 h-1.5 rounded-full bg-error" : "w-2.5 h-2.5 rounded-full bg-error";
          } else {
            dotEl.className = "status-light-offline";
          }
          textEl.innerText = "Offline";
          textEl.style.color = "#ff5252";
        }
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
          saveBtn.innerHTML = "Add Variant";
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
          saveBtn.innerHTML = "Add Variant";
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
      saveBtn.innerHTML = "Add Variant";
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
            if (currentTab === "waybills") fetchAndRenderWaybillsArchive();
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
          if (currentTab === "agents") fetchAndRenderJobs();
          if (currentTab === "waybills") fetchAndRenderWaybillsArchive();
          if (currentTab === "overview") {
            fetchAndRenderOverviewJobs();
            fetchAndRenderOverviewLogs();
          }
        },
        (errMsg) => {
          setButtonsDisabled("ctrl-trigger-scout", "waybill-ctrl-trigger-scout", "overview-ctrl-trigger-scout", false);
          writeWaybillConsole(`[ERROR] Scout scan failed: ${errMsg}`, "error");
          if (currentTab === "agents") fetchAndRenderJobs();
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
      const response = await fetch(`${backendUrl}/foreman/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(spKey && { "X-SimplyPrint-Key": spKey }) },
        body: JSON.stringify({})
      });
      const rawText2 = await response.text();
      let resData;
      try { resData = JSON.parse(rawText2); } catch { throw new Error(`Backend error (HTTP ${response.status}): ${rawText2.substring(0, 120)}`); }
      if (!response.ok) throw new Error(resData.detail || resData.error || `HTTP ${response.status}`);

      writeWaybillConsole(`[SUCCESS] Foreman response: ${JSON.stringify(resData.status || resData)}`, "info");
      logAction(`Foreman dispatch triggered manually`, "info", { dispatched: resData.files_dispatched, processed: resData.processed_items_count });
      setTimeout(() => {
        fetchSummaryStats();
        if (currentTab === "waybills") fetchAndRenderWaybillsArchive();
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
          if (currentTab === "agents") fetchAndRenderJobs();
          if (currentTab === "waybills") {
            fetchAndRenderWaybillsArchive();
            fetchAndRenderMasterPDFs();
          }
          if (currentTab === "overview") {
            fetchAndRenderOverviewJobs();
            fetchAndRenderOverviewLogs();
          }
        },
        (errMsg) => {
          setButtonsDisabled("ctrl-trigger-compile", "waybill-ctrl-trigger-compile", "overview-ctrl-trigger-compile", false);
          writeWaybillConsole(`[ERROR] Batch compilation failed: ${errMsg}`, "error");
          if (currentTab === "agents") fetchAndRenderJobs();
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
          resultStr = `<a href="${j.result.url}" target="_blank" class="px-2 py-1 bg-primary/10 hover:bg-primary/20 text-[#a4e844] rounded border border-primary/30 transition-all duration-150 inline-flex items-center gap-1.5 select-none no-underline text-[10px] font-semibold"><span class="material-symbols-outlined text-[12px] select-none">download</span> Download Batch</a>`;
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
            if (currentTab === "agents") fetchAndRenderJobs();
            if (currentTab === "overview") {
              fetchAndRenderOverviewJobs();
              fetchAndRenderOverviewLogs();
            }
          },
          (errMsg) => {
            if (btnSync1) btnSync1.disabled = false;
            if (btnSync3) btnSync3.disabled = false;
            writeWaybillConsole(`[ERROR] Sync failed: ${errMsg}`, "error");
            if (currentTab === "agents") fetchAndRenderJobs();
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

  if (initSupabase()) {
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
      if (currentTab === "agents") {
        fetchAgentHeartbeats();
        fetchAndRenderJobs();
        fetchAndRenderGeminiUsage();
      } else if (currentTab === "waybills") {
        fetchAgentHeartbeats();
        fetchAndRenderWaybillsArchive();
      } else if (currentTab === "overview") {
        fetchAgentHeartbeats();
        fetchAndRenderOverviewJobs();
        fetchAndRenderOverviewLogs();
        fetchAndRenderPrintersAndQueue();
        fetchAndRenderOrders();
      } else if (currentTab === "printers") {
        fetchAndRenderPrintersAndQueue();
        fetchAndRenderPrintJobs();
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
        bgStyle = `background:linear-gradient(to right,rgba(164,232,68,.28) ${pct}%,rgba(164,232,68,.07) ${pct}%);`;
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

        return `
          <div class="glass-panel rounded-xl p-4 flex flex-col justify-between hover:bg-surface-container-highest/10 transition-colors duration-300 ${p.online ? 'glow-hover-cyan' : 'glow-hover-red'}">
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
        return `
          <div class="flex flex-col items-center justify-center py-12 text-center text-outline font-data-mono bg-surface-container-low/20 rounded-xl border border-outline-variant/10 p-5">
            <span class="material-symbols-outlined text-2xl mb-1.5">done_all</span>
            Queue is empty.
          </div>
        `;
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
      queueDepthEl.innerText = queueDepth;
    }
    if (queueTimeEl) {
      queueTimeEl.innerText = timeStr;
    }

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
      if (currentTab === "agents") fetchAndRenderJobs();
      
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
  setupCatalogModal();
  setupCatalogStockListeners();
  setupWaybillProcessing();
  setupAgentControls();
  setupWaybillFilters();
  setupOrderFilters();
  setupPrinterControls();
  setupGlobalSearch();
  setupCatalogDetailModal();
  setupSystemErrorReset();

  // Action Buttons Events
  const refreshOrdersBtn = document.getElementById("refresh-orders-btn");
  if (refreshOrdersBtn) refreshOrdersBtn.addEventListener("click", fetchAndRenderOrders);

  const overviewRefreshOrdersBtn = document.getElementById("overview-orders-btn-refresh");
  if (overviewRefreshOrdersBtn) overviewRefreshOrdersBtn.addEventListener("click", fetchAndRenderOrders);

  const clearDbBtn = document.getElementById("clear-db-btn");
  if (clearDbBtn) clearDbBtn.addEventListener("click", clearDatabase);

  const ingestSubmitBtn = document.getElementById("ingest-submit-btn");
  if (ingestSubmitBtn) ingestSubmitBtn.addEventListener("click", runManualIngestion);

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
        const data = await res.json();
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
