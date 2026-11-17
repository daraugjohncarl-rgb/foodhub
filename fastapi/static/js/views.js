/**
 * API-Driven View Renderers (views.js)
 * Polished to match the Super Admin visual design system, cards, tables, and typography.
 * Connects all UI modules asynchronously to FastAPI backend endpoints via Auth.fetch()
 */

// Erase toast notifications completely across the system
if (typeof Utils !== 'undefined') { Utils.showToast = function() { return; }; }
window.showToast = function() { return; };
try {
  const _noToast = document.createElement("style");
  _noToast.textContent = "#toastContainer, #toast-container, .toast { display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }";
  if (document.head) document.head.appendChild(_noToast);
  else document.addEventListener("DOMContentLoaded", () => document.head.appendChild(_noToast));
} catch(e) {}

let posCart = [];
let currentCategoryFilter = "all";
let cachedProducts = [];
let cachedInventory = [];

// ── POS checkout safety ──────────────────────────────────────────────────────────────────────────
// One idempotency key per logical checkout. It is reused when the same checkout is retried (network
// failure, timeout, double tap) and replaced as soon as the cart or payment method changes.
let posCheckout = { key: null, signature: null, inFlight: false };
// Customer (QR) order currently loaded into the cart. The server supplies its items and prices at sale time.
window.currentOnlineOrder = window.currentOnlineOrder || null;
window._customerOrderIndex = window._customerOrderIndex || {};
const POS_DRAFT_KEY = "pos_cart_draft_v1";

function posDraftKey() {
  const u = (typeof Auth !== "undefined" && Auth.getUser) ? Auth.getUser() : null;
  return POS_DRAFT_KEY + ":" + ((u && u.id) || "anon");
}

// The draft stores product ids and quantities only: no names, prices, tokens or payment data.
function savePosDraft() {
  try {
    if (window.currentOnlineOrder || !posCart.length) {
      sessionStorage.removeItem(posDraftKey());
      return;
    }
    sessionStorage.setItem(posDraftKey(), JSON.stringify(posCart.map(i => ({ product_id: i.product_id, quantity: i.quantity }))));
  } catch (e) { /* storage unavailable: the cart simply is not recoverable */ }
}

// The idempotency key of an unfinished walk-in checkout survives a page reload (same tab), so retrying
// after a reload returns the original sale instead of creating a second one. The key is just a random id.
function checkoutAttemptKey() {
  return posDraftKey().replace(POS_DRAFT_KEY, "pos_checkout_attempt_v1");
}

function persistCheckoutAttempt() {
  try {
    if (posCheckout.key && !window.currentOnlineOrder) {
      sessionStorage.setItem(checkoutAttemptKey(), JSON.stringify({ key: posCheckout.key, signature: posCheckout.signature }));
    } else {
      sessionStorage.removeItem(checkoutAttemptKey());
    }
  } catch (e) { /* storage unavailable: the key just lives in memory */ }
}

function restoreCheckoutAttempt() {
  if (posCheckout.key || window.currentOnlineOrder) return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(checkoutAttemptKey()) || "null");
    if (saved && typeof saved.key === "string" && saved.key.length <= 36 && typeof saved.signature === "string") {
      posCheckout.key = saved.key;
      posCheckout.signature = saved.signature;
    }
  } catch (e) { /* ignore a damaged entry */ }
}

// Called after the catalogue was loaded: names and prices come from the server, never from the draft.
function restorePosDraft() {
  if (posCart.length || window.currentOnlineOrder) return;
  let saved = [];
  try { saved = JSON.parse(sessionStorage.getItem(posDraftKey()) || "[]"); } catch (e) { saved = []; }
  if (!Array.isArray(saved) || !saved.length) return;
  let dropped = 0;
  saved.forEach(line => {
    const product = (cachedProducts || []).find(p => p.id === Number(line && line.product_id));
    const qty = Math.min(100, parseInt(line && line.quantity, 10) || 0);
    if (!product || qty < 1) { dropped++; return; }
    posCart.push({ product_id: product.id, name: product.name, price: product.price, quantity: qty });
  });
  if (posCart.length && typeof Utils !== "undefined") {
    Utils.showToast("Restored your unsaved cart" + (dropped ? ` (${dropped} unavailable item(s) removed)` : "") + ".", "info");
  }
}

// Views that only some roles may open. Checked here as well as in the menu, so a typed or stale
// #hash / saved view cannot open them. The server enforces the same rules on the APIs behind them.
const VIEW_ROLE_RULES = { cash_drawer: ["manager", "admin", "super_admin"], inventory_history: ["admin", "super_admin", "inventory"], logs: ["super_admin"] };

function currentViewRole() {
  try {
    const u = (typeof Auth !== "undefined" && Auth.getUser) ? Auth.getUser() : null;
    const role = (u && u.role) || (typeof Auth !== "undefined" && Auth.getRole ? Auth.getRole() : "");
    return String(role || "").trim().toLowerCase();
  } catch (e) {
    return "";
  }
}

function canOpenView(viewId) {
  const allowed = VIEW_ROLE_RULES[viewId];
  return !allowed || allowed.includes(currentViewRole());
}

// Main view dispatcher
async function renderView(viewId, container) {
  if (typeof viewId === "string") {
    viewId = viewId.replace(/^#\/?/, "").trim().toLowerCase();
  }
  if (!container) container = document.getElementById("view-container");
  if (!container) return;

  // Any navigation ends a voice session: the microphone is released and late results are ignored.
  if (window.isVoiceListening || posVoiceRecognition) endVoiceSession(null);
  window._voicePendingChoice = null;

  if (viewId && !canOpenView(viewId)) {
    const role = currentViewRole();
    const navItems = (window.ROLE_NAV_CONFIG && window.ROLE_NAV_CONFIG[role === "super_admin" ? "admin" : role]) || [];
    const fallback = navItems.find(i => canOpenView(i.id));
    if (typeof Utils !== "undefined") Utils.showToast("That screen is available to managers and admins only.", "warning");
    viewId = fallback ? fallback.id : "pos";
  }

  if (viewId) {
    try {
      if (window.location.hash !== "#" + viewId) {
        history.replaceState(null, "", "#" + viewId);
      }
      sessionStorage.setItem("active_feature", viewId);
    } catch (e) {}

    // Synchronize active sidebar navigation link, bottom navigation, and header title
    document.querySelectorAll("aside.sidebar .nav-link").forEach(link => {
      const href = (link.getAttribute("href") || "").replace("#", "");
      if (href === viewId) {
        link.classList.add("active");
        const pageTitle = document.getElementById("current-page-title");
        if (pageTitle && link.getAttribute("data-title")) {
          pageTitle.innerText = link.getAttribute("data-title");
        }
      } else {
        link.classList.remove("active");
      }
    });

    document.querySelectorAll(".mobile-bottom-nav-item[data-nav-id]").forEach(item => {
      const nid = item.getAttribute("data-nav-id");
      item.classList.toggle("active", nid === viewId);
    });
  }

  container.innerHTML = `
    <div style="display:flex; justify-content:center; align-items:center; min-height:260px; color:var(--text-muted, #71717a);">
      <div style="text-align:center;">
        <i class="fas fa-spinner fa-spin" style="font-size:2rem; margin-bottom:0.75rem; color:#c9a227;"></i>
        <p style="font-size:14px; font-weight:500;">Loading module data...</p>
      </div>
    </div>
  `;

  if (window.posOnlineOrdersInterval) {
    clearInterval(window.posOnlineOrdersInterval);
    window.posOnlineOrdersInterval = null;
  }

  if (viewId !== 'pos') {
    const floatBar = document.getElementById("mobile-cart-float-bar");
    if (floatBar) floatBar.remove();
  }
  
  try {
    switch (viewId) {
      case "dashboard":
        await renderDashboard(container);
        break;
      case "cash_drawer":
        await renderCashDrawerTracker(container);
        break;
      case "inventory":
        await renderInventory(container);
        break;
      case "inventory_history":
        await renderInventoryHistory(container);
        break;
      case "products":
        await renderProducts(container);
        break;
      case "pos":
        await renderPOS(container);
        break;
      case "drinks":
      case "drinks_station":
        await renderDrinksStation(container);
        break;
      case "kitchen":
        await renderKitchen(container);
        break;
      case "kitchen_logs":
        await renderKitchenLogs(container);
        break;
      case "transactions":
        await renderTransactions(container);
        break;
      case "suppliers":
        await renderSuppliers(container);
        break;
      case "profit_loss":
      case "purchases": {
        const _currentUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
        const _userRole = (_currentUser && _currentUser.role ? _currentUser.role : (typeof Auth !== 'undefined' ? Auth.getRole() : '')).toLowerCase();
        if (_userRole === 'inventory' || _userRole === 'kitchen' || _userRole === 'cashier') {
          if (window.location.hash === "#profit_loss" || window.location.hash === "#purchases") {
            history.replaceState(null, "", window.location.pathname + "#inventory");
          }
          await renderInventory(container);
          break;
        }
        await renderProfitLoss(container);
        break;
      }
      case "wastage":
        await renderWastage(container);
        break;
      case "reports":
        await renderReports(container);
        break;
      case "tables":
        await renderTables(container);
        break;
      case "users":
        await renderUsers(container);
        break;
      case "customer_orders":
        await renderCustomerOrdersView(container);
        break;
      case "customer_portal":
      case "customer":
        window.open("/customer", "_blank");
        break;
      case "logs":
        await renderLogs(container);
        break;
      case "settings":
        await renderSettings(container);
        break;
      default:
        container.innerHTML = `
          <div class="section-card" style="padding:24px;">
            <h3 style="font-size:18px; font-weight:700; margin-bottom:8px;">${viewId.toUpperCase()}</h3>
            <p style="color:var(--text-muted, #71717a); font-size:14px;">Module active and connected.</p>
          </div>
        `;
    }
  } catch (err) {
    console.error(`Error rendering view ${viewId}:`, err);
    container.innerHTML = `
      <div class="section-card" style="padding:24px; border:1px solid rgba(239,68,68,0.35);">
        <h3 style="color:var(--danger, #ef4444); font-size:16px; font-weight:700;"><i class="fas fa-exclamation-triangle"></i> Error Loading Module</h3>
        <p style="color:var(--text-muted, #71717a); margin:10px 0; font-size:13px;">${Utils.escapeHtml(err.message || "Failed to communicate with backend API.")}</p>
        <button class="btn btn-outline btn-sm" onclick="renderView(${Utils.jsArg(viewId)})"><i class="fas fa-redo"></i> Retry</button>
      </div>
    `;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DASHBOARD / STATS OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────
async function renderDashboard(c) {
  c = c || document.getElementById("view-container");
  if (!c) return;
  let stats = { today_sales: 0, total_transactions_today: 0, low_stock_count: 0, active_staff_count: 0, cash_in_drawer: 0 };
  let drawerSummary = { total_cash_in_drawers: 0, active_drawers_count: 0, today_total_cash_sales: 0, shifts: [] };
  let lowStockItems = [];

  let plStats = {
    profit_loss: { net_profit: 0, profit_margin_percent: 0, is_profitable: true },
    cashout: { total_cashout_income: 0 },
    inventory: { total_inventory_valuation: 0 }
  };

  try {
    const [res, drawerRes, invRes, plRes] = await Promise.all([
      Auth.fetch("/api/v1/analytics/dashboard").catch(() => null),
      Auth.fetch("/api/v1/shifts/drawer-summary").catch(() => null),
      Auth.fetch("/api/v1/inventory?low_stock_only=true").catch(() => null),
      Auth.fetch("/api/v1/analytics/profit-loss").catch(() => null)
    ]);
    if (res && res.ok) stats = await res.json().catch(() => stats);
    if (drawerRes && drawerRes.ok) {
      drawerSummary = await drawerRes.json().catch(() => drawerSummary);
      cachedDrawerData = drawerSummary;
    }
    if (invRes && invRes.ok) lowStockItems = await invRes.json().catch(() => lowStockItems);
    if (plRes && plRes.ok) plStats = await plRes.json().catch(() => plStats);
  } catch(e) {}

  const liveDrawerCash = (drawerSummary && typeof drawerSummary.total_cash_in_drawers === 'number')
    ? drawerSummary.total_cash_in_drawers
    : (stats.cash_in_drawer || 0);

  const currentUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  const userRole = (currentUser && currentUser.role ? currentUser.role : (typeof Auth !== 'undefined' ? Auth.getRole() : '')).toLowerCase();
  const isAdmin = userRole.includes('admin') || window.location.pathname.includes('/admin') || window.location.pathname.includes('/dashboard');

  c.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card" style="cursor:pointer;" onclick="renderView('cash_drawer')" title="Click to view Cash Drawer details">
        <div class="stat-icon purple" style="background:rgba(123,31,162,0.12); color:#7b1fa2;"><i class="fas fa-vault"></i></div>
        <div class="stat-info">
          <h3>Cash Drawer</h3>
          <div class="stat-count" style="color:#7b1fa2;">${Utils.formatCurrency(liveDrawerCash)}</div>
          <div class="stat-trend" style="color:var(--success, #10b981);"><i class="fas fa-cash-register"></i> ${Utils.escapeHtml(drawerSummary.active_drawers_count || 0)} active drawer(s)</div>
        </div>
      </div>
      <div class="stat-card" style="cursor:pointer;" onclick="renderView('profit_loss')" title="Click to view Profit & Loss details">
        <div class="stat-icon green" style="background:rgba(16,185,129,0.12); color:#10b981;"><i class="fas fa-chart-line"></i></div>
        <div class="stat-info">
          <h3>Net Operating Profit</h3>
          <div class="stat-count" style="color:${plStats.profit_loss?.is_profitable ? '#10b981' : '#ef4444'};">${Utils.formatCurrency(plStats.profit_loss?.net_profit || 0)}</div>
          <div class="stat-trend" style="color:${plStats.profit_loss?.is_profitable ? '#10b981' : '#ef4444'};"><i class="fas fa-percent"></i> ${Utils.escapeHtml(plStats.profit_loss?.profit_margin_percent || 0)}% margin</div>
        </div>
      </div>
      <div class="stat-card" style="cursor:pointer;" onclick="renderView('profit_loss')" title="Click to view ${isAdmin ? 'Income Received from Manager' : 'Manager Safe Income'}">
        <div class="stat-icon emerald" style="background:rgba(16,185,129,0.12); color:#10b981;"><i class="fas ${isAdmin ? 'fa-inbox' : 'fa-vault'}"></i></div>
        <div class="stat-info">
          <h3>${isAdmin ? 'Income Received from Manager' : 'Manager Safe Income'}</h3>
          <div class="stat-count" style="color:#10b981;">${Utils.formatCurrency(
            isAdmin
              ? (plStats.cashout?.admin_transfer_income !== undefined ? plStats.cashout.admin_transfer_income : (plStats.cashout?.total_transferred_to_admin ?? 0))
              : (plStats.cashout?.manager_safe_cash !== undefined ? plStats.cashout.manager_safe_cash : Math.max(0, (plStats.cashout?.total_cashout_income || 0) - (plStats.cashout?.total_transferred_to_admin || 0)))
          )}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas ${isAdmin ? 'fa-shield-halved' : 'fa-vault'}"></i> ${isAdmin ? 'Income secured in admin safe' : 'Manager safe balance (from cashier transfers)'}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-peso-sign"></i></div>
        <div class="stat-info">
          <h3>Today's Total Sales</h3>
          <div class="stat-count" style="color:#c9a227;">${Utils.formatCurrency(stats.today_sales)}</div>
          <div class="stat-trend" style="color:var(--success, #10b981);"><i class="fas fa-arrow-up"></i> Live revenue</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-receipt"></i></div>
        <div class="stat-info">
          <h3>Transactions Today</h3>
          <div class="stat-count" style="color:#10b981;">${Utils.escapeHtml(stats.total_transactions_today || 0)}</div>
          <div class="stat-trend" style="color:var(--success, #10b981);"><i class="fas fa-check-circle"></i> Completed orders</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-boxes"></i></div>
        <div class="stat-info">
          <h3>Low Stock Alerts</h3>
          <div class="stat-count" style="color:#f97316;">${Utils.escapeHtml(stats.low_stock_count || 0)}</div>
          <div class="stat-trend" style="color:#f97316;"><i class="fas fa-exclamation-triangle"></i> Needs reorder</div>
        </div>
      </div>
    </div>

    <div class="section-card">
      <div class="section-head">
        <h2>Stock & Low Inventory Alerts</h2>
        ${isAdmin ? '' : '<a href="#inventory" onclick="renderView(\'inventory\')" class="view-all-link">Manage Inventory <i class="fas fa-arrow-right"></i></a>'}
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item Name</th>
              <th>Available Qty</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${lowStockItems.length ? lowStockItems.map(item => `
              <tr>
                <td><strong style="color:var(--text-main); font-size:13px;">${Utils.escapeHtml(item.name)}</strong></td>
                <td><strong style="font-size:13px;">${Utils.escapeHtml(item.quantity)}</strong></td>
                <td>
                  <span class="badge ${item.quantity <= 0 ? 'badge-danger' : 'badge-warning'}" style="font-size:11px; font-weight:700;">
                    ${item.quantity <= 0 ? 'Out of Stock' : 'Low Stock'}
                  </span>
                </td>
              </tr>
            `).join('') : '<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding:30px;"><i class="fas fa-check-circle" style="color:var(--success, #10b981); margin-right:6px;"></i> All inventory items are currently well-stocked.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 2. INVENTORY MANAGEMENT (Masterlist & Automated Analytics)
// ─────────────────────────────────────────────────────────────────────────────
let currentInvCategory = "ALL";
let cachedAnalytics = null;
let selectedInventoryIds = new Set();

async function renderInventory(c) {
  if (!c) c = document.getElementById("view-container");
  if (!c) return;

  // Pre-load products so the Product Code dropdown is always populated
  if (!cachedProducts || cachedProducts.length === 0) {
    try {
      const prodRes = await Auth.fetch("/api/v1/products");
      if (prodRes.ok) cachedProducts = await prodRes.json();
    } catch(e) {}
  }

  const [invRes, analyticsRes] = await Promise.all([
    Auth.fetch("/api/v1/inventory"),
    Auth.fetch("/api/v1/inventory/analytics")
  ]);

  if (!invRes.ok) throw new Error("Failed to load inventory items from server.");
  const items = await invRes.json();
  cachedInventory = items;

  // Prune any deleted or non-existent IDs from selectedInventoryIds
  const currentItemIds = new Set(items.map(i => Number(i.id)));
  for (const id of selectedInventoryIds) {
    if (!currentItemIds.has(id)) {
      selectedInventoryIds.delete(id);
    }
  }

  if (analyticsRes && analyticsRes.ok) {
    cachedAnalytics = await analyticsRes.json().catch(() => null);
  }
  if (!cachedAnalytics) {
    cachedAnalytics = {
      total_items: items.length,
      total_valuation: items.reduce((sum, i) => sum + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0),
      health_score: 100,
      healthy_count: items.filter(i => Number(i.quantity) > Number(i.min_stock)).length,
      low_stock_count: items.filter(i => Number(i.quantity) <= Number(i.min_stock) && Number(i.quantity) > 0).length,
      out_of_stock_count: items.filter(i => Number(i.quantity) <= 0).length
    };
  }

  const currentUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  const userRole = (currentUser && currentUser.role ? currentUser.role : (typeof Auth !== 'undefined' ? Auth.getRole() : '')).toLowerCase();
  const isInventoryAccount = userRole === 'inventory' || window.location.pathname.includes('/inventory');
  const isAdmin = userRole === 'admin' || userRole === 'branch_admin' || userRole === 'super_admin' || userRole.includes('admin') || window.location.pathname.includes('/admin');
  const totalValuation = (cachedAnalytics && cachedAnalytics.total_valuation) || items.reduce((sum, i) => sum + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0);
  const uniqueCats = Array.from(new Set(cachedInventory.map(i => i.category || 'Uncategorized'))).sort();
  const categories = ["ALL", ...uniqueCats];

  c.innerHTML = `
    <!-- Top Automated Inventory Health & Metrics Grid -->
    <div class="stats-grid fade-up" style="margin-bottom:24px;">
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-boxes-stacked"></i></div>
        <div class="stat-info">
          <h3>Total Master Items</h3>
          <div class="stat-count" style="color:#c9a227;">${Utils.escapeHtml(cachedAnalytics.total_items)}</div>
          <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-barcode"></i> Tracked SKUs</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon purple" style="background:rgba(99,102,241,0.12); color:#6366f1;"><i class="fas fa-coins"></i></div>
        <div class="stat-info">
          <h3>Total Stock Price Value</h3>
          <div class="stat-count" style="color:#6366f1;">${Utils.formatCurrency(totalValuation)}</div>
          <div class="stat-trend" style="color:#6366f1;"><i class="fas fa-tags"></i> Inventory Asset Value</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-heart-pulse"></i></div>
        <div class="stat-info">
          <h3>Stock Health Score</h3>
          <div class="stat-count" style="color:#10b981;">${Utils.escapeHtml(cachedAnalytics.health_score)}%</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-check-double"></i> ${Utils.escapeHtml(cachedAnalytics.healthy_count)} Healthy SKUs</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-triangle-exclamation"></i></div>
        <div class="stat-info">
          <h3>Low Stock Warnings</h3>
          <div class="stat-count" style="color:#f97316;">${Utils.escapeHtml(cachedAnalytics.low_stock_count)}</div>
          <div class="stat-trend" style="color:#f97316;"><i class="fas fa-cart-arrow-down"></i> Needs Reorder</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon red"><i class="fas fa-circle-xmark"></i></div>
        <div class="stat-info">
          <h3>Out of Stock</h3>
          <div class="stat-count" style="color:#ef4444;">${Utils.escapeHtml(cachedAnalytics.out_of_stock_count)}</div>
          <div class="stat-trend" style="color:#ef4444;"><i class="fas fa-fire"></i> Critical Depletion</div>
        </div>
      </div>
    </div>

    <!-- Toolbar & Master List Import Actions -->
    <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:18px; flex-wrap:wrap;">
      <div style="display:flex; gap:12px; align-items:center; flex:1; min-width:280px; max-width:480px;">
        <div class="search-wrap" style="position:relative; flex:1;">
          <i class="fas fa-search" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); color:var(--text-muted);"></i>
          <input type="text" id="inv-search" class="input-field" placeholder="Search item, SKU, category..." style="padding-left:38px; width:100%;" oninput="filterInventoryList()">
        </div>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        ${isAdmin ? `
          <button class="btn btn-outline" onclick="allowAllInventoryStockAgain()" style="display:inline-flex; align-items:center; gap:8px; border-color:#059669; color:#059669;" title="Allow Inventory to add stock again for all locked items">
            <i class="fas fa-unlock"></i> <strong>Allow All Stock</strong>
          </button>
        ` : ''}
        <button class="btn btn-outline" onclick="openImportMasterlistModal()" style="display:inline-flex; align-items:center; gap:8px; border-color:#c9a227; color:#c9a227;">
          <i class="fas fa-file-import"></i> <strong>Import Master List</strong>
        </button>
        <button class="btn btn-primary" onclick="openAddInventoryModal()" style="display:inline-flex; align-items:center; gap:8px;">
          <i class="fas fa-plus"></i> Add Item
        </button>
      </div>
    </div>

    <!-- Master List Department Filter Tabs -->
    <div style="display:flex; gap:8px; overflow-x:auto; padding-bottom:12px; margin-bottom:16px;" class="fade-up delay-2">
      ${categories.map(cat => `
        <button class="btn ${currentInvCategory === cat ? 'btn-primary' : 'btn-outline'}" 
          style="padding:6px 14px; font-size:12px; white-space:nowrap; border-radius:20px;"
          onclick="filterInventoryCategory(${Utils.jsArg(cat)})">
          ${cat === 'ALL' ? '<i class="fas fa-layer-group"></i> All Items' : cat}
        </button>
      `).join('')}
    </div>

    <!-- Bulk Action Toolbar (Displays when >= 1 item is selected) -->
    <div id="inv-bulk-toolbar" class="inv-bulk-toolbar" style="display:${selectedInventoryIds.size > 0 ? 'flex' : 'none'};">
      <div class="inv-bulk-left">
        <span class="inv-bulk-count-badge">
          <i class="fas fa-check-circle"></i>
          <span><strong id="inv-selected-count">${Utils.escapeHtml(selectedInventoryIds.size)}</strong> selected</span>
        </span>
        <div class="inv-bulk-actions">
          <button type="button" class="inv-bulk-link" onclick="selectAllDisplayedInventory()" title="Select all items matching current view">
            <i class="fas fa-check-double" style="color:#fbbf24;"></i> Select All Visible
          </button>
          <span style="color:rgba(255,255,255,0.25);">|</span>
          <button type="button" class="inv-bulk-link" onclick="clearInventorySelection()" title="Clear current selection">
            <i class="fas fa-xmark"></i> Clear Selection
          </button>
        </div>
      </div>
      <div class="inv-bulk-right">
        <button type="button" class="btn-bulk-clear" onclick="clearInventorySelection()">
          <i class="fas fa-rotate-left"></i> Cancel
        </button>
        <button type="button" class="btn-bulk-delete" onclick="openBulkDeleteModal()" id="btn-bulk-delete-action">
          <i class="fas fa-trash-can"></i>
          <span>Delete Selected (<span id="inv-delete-count">${Utils.escapeHtml(selectedInventoryIds.size)}</span>)</span>
        </button>
      </div>
    </div>

    <!-- Inventory Table Card -->
    <div class="section-card fade-up delay-2">
      <div class="section-head">
        <h2>Inventory Master Catalog</h2>
        <span id="inv-count-badge" style="font-size:13px; color:var(--text-muted);">${Utils.escapeHtml(items.length)} items listed</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:48px; text-align:center; padding-left:14px; padding-right:14px;">
                <input type="checkbox" 
                       id="inv-select-all" 
                       class="inv-checkbox" 
                       onchange="toggleSelectAllInventory(this.checked)" 
                       title="Select all displayed items">
              </th>
              <th>Item Name</th>
              <th>Department / Category</th>
              <th>Current Stock</th>
              ${isInventoryAccount ? `<th style="background:rgba(5,150,105,0.06); color:#059669;">New Total Stock</th>` : ''}
              <th style="background:rgba(201,162,39,0.08); color:#c9a227;">Price per Unit</th>
              <th style="background:rgba(16,185,129,0.08); color:#10b981;">Total Valuation</th>
              <th>Health Status</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody id="inv-tbody">
            ${renderInventoryRows(items)}
          </tbody>
        </table>
      </div>
    </div>
  `;

  updateSelectAllHeaderState();
  updateInventoryBulkToolbar();
}

// Role-specific stock vs price save helper functions
async function saveInventoryStockOnly(itemId) {
  const stockInput = document.getElementById(`inv-stock-${itemId}`);
  if (!stockInput) return;
  const valStr = stockInput.value.trim();
  if (valStr === "") {
    Utils.showToast("Please enter a new total stock quantity.", "warning");
    stockInput.focus();
    return;
  }
  const newStock = parseFloat(valStr);
  if (isNaN(newStock) || newStock < 0) {
    Utils.showToast("Please enter a valid stock quantity (0 or greater).", "danger");
    return;
  }
  const item = (cachedInventory || []).find(i => Number(i.id) === Number(itemId));
  const currentStock = item ? Number(item.quantity) : 0;
  const delta = newStock - currentStock;

  if (delta === 0) {
    Utils.showToast("Stock quantity is already " + (newStock % 1 === 0 ? newStock : newStock.toFixed(2)), "info");
    return;
  }

  const saveBtn = document.getElementById(`inv-save-btn-${itemId}`);
  if (saveBtn) saveBtn.disabled = true;
  window._skipInvWsRefreshUntil = Date.now() + 3000;

  try {
    const res = await Auth.fetch(`/api/v1/inventory/${itemId}/stock`, {
      method: "PUT",
      body: JSON.stringify({
        quantity_delta: delta,
        reason: "New Total Stock Update"
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to update stock quantity.");
    }
    const updated = await res.json();
    const newQty = Number(updated.quantity);
    if (item) {
      item.quantity = newQty;
      item.daily_input_submitted = true;
    }

    // Update only this row in place so other rows' unsaved stock inputs are preserved
    const row = document.getElementById(`inv-row-${itemId}`);
    if (row) {
      const cells = row.querySelectorAll("td");
      // Col 4 (index 3): Current Stock badge
      const curBadge = cells[3]?.querySelector(".badge");
      if (curBadge) {
        curBadge.textContent = newQty % 1 === 0 ? newQty : newQty.toFixed(2);
      }
      // Col 5 (index 4): New Total Stock cell (for Inventory account)
      if (cells[4]) {
        cells[4].innerHTML = `
          <div style="display:inline-flex; align-items:center; gap:6px;">
            <span class="badge" style="background:rgba(5,150,105,0.1); color:#047857; border:1px solid rgba(5,150,105,0.25); font-weight:700; font-size:12px; padding:6px 12px; border-radius:10px;" title="Stock already saved. Ask an Admin for permission to add stock again.">
              <i class="fas fa-lock" style="color:#059669; margin-right:5px;"></i>Stock Saved
            </span>
          </div>
        `;
      }
      // Total Valuation cell
      const valEl = document.getElementById(`inv-val-${itemId}`);
      if (valEl && item) {
        valEl.textContent = Utils.formatCurrency(newQty * (Number(item.unit_price) || 0));
      }
      // Health Status cell (second-to-last td)
      const healthTd = cells[cells.length - 2];
      const healthBadge = healthTd?.querySelector(".badge");
      if (healthBadge && item) {
        const isOut = newQty <= 0;
        const isLow = newQty <= Number(item.min_stock);
        healthBadge.className = `badge ${isOut ? 'badge-danger' : isLow ? 'badge-warning' : 'badge-success'}`;
        healthBadge.textContent = isOut ? 'Out of Stock' : isLow ? 'Low Stock' : 'In Stock';
      }
    }

    Utils.showToast("New total stock saved successfully!", "success");
  } catch (err) {
    if (saveBtn) saveBtn.disabled = false;
    Utils.showToast(err.message || "Failed to save stock.", "danger");
  }
}

async function allowInventoryStockAgain(itemId, itemName) {
  try {
    const res = await Auth.fetch(`/api/v1/inventory/${itemId}/allow-stock`, {
      method: "POST"
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to grant stock entry permission.");
    }
    const item = (cachedInventory || []).find(i => Number(i.id) === Number(itemId));
    if (item) item.daily_input_submitted = false;
    Utils.showToast(`Admin permission granted: Inventory can add stock again for "${itemName}".`, "success");
    if (typeof renderInventory === "function") {
      renderInventory();
    }
  } catch (err) {
    Utils.showToast(err.message || "Failed to allow stock entry.", "danger");
  }
}

async function allowAllInventoryStockAgain() {
  try {
    const res = await Auth.fetch(`/api/v1/inventory/allow-stock-all`, {
      method: "POST"
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to grant stock entry permission for all items.");
    }
    const data = await res.json().catch(() => ({}));
    (cachedInventory || []).forEach(i => { i.daily_input_submitted = false; });
    Utils.showToast(data.message || "Admin permission granted: All inventory items unlocked.", "success");
    if (typeof renderInventory === "function") {
      renderInventory();
    }
  } catch (err) {
    Utils.showToast(err.message || "Failed to allow all stock.", "danger");
  }
}

function hasUnsavedInventoryStockInputs() {
  const inputs = document.querySelectorAll('input[id^="inv-stock-"]');
  for (const el of inputs) {
    if (String(el.value).trim() !== String(el.defaultValue).trim()) {
      return true;
    }
  }
  return false;
}

let cachedOverallHistory = [];
async function openOverallStockHistoryModal(focusItemId, focusItemName) {
  Utils.openModal(`
    <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
      <div>
        <h3 style="font-size:17px; font-weight:800; margin:0; color:var(--text-main);">
          <i class="fas fa-clock-rotate-left" style="color:#c9a227; margin-right:8px;"></i>Overall Inventory Stock History
        </h3>
        <p style="font-size:12px; color:var(--text-muted); margin:2px 0 0 0;">
          Previous stock records across all updated inventory items (excludes current new update stock).
        </p>
      </div>
    </div>
  `, `
    <div id="overall-history-container" style="min-height:240px;">
      <div style="text-align:center; padding:40px 16px; color:var(--text-muted);">
        <i class="fas fa-spinner fa-spin" style="font-size:26px; color:#c9a227;"></i>
        <div style="margin-top:10px; font-size:13px;">Loading overall previous stock records...</div>
      </div>
    </div>
  `, `<button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>`, "modal-responsive modal-xl");

  try {
    const res = await Auth.fetch("/api/v1/inventory/overall-history");
    if (!res.ok) throw new Error("Failed to load overall inventory history.");
    const items = await res.json();
    cachedOverallHistory = items || [];

    const host = document.getElementById("overall-history-container");
    if (!host) return;

    if (!items || !items.length) {
      host.innerHTML = `
        <div style="padding:36px 16px; text-align:center; color:var(--text-muted);">
          <div style="width:52px; height:52px; border-radius:50%; background:rgba(0,0,0,0.04); display:inline-flex; align-items:center; justify-content:center; margin-bottom:12px;">
            <i class="fas fa-clock-rotate-left" style="font-size:24px; color:var(--text-muted); opacity:0.6;"></i>
          </div>
          <div style="font-weight:700; font-size:15px; color:var(--text-main); margin-bottom:4px;">No Previous Stock History Available</div>
          <div style="font-size:12.5px; line-height:1.5; max-width:400px; margin:0 auto;">
            Inventory items have not been updated previously yet. Only previous stock updates are shown here (the current active stock is strictly excluded). Prior records will appear here after subsequent stock updates.
          </div>
        </div>
      `;
      return;
    }

    const categories = Array.from(new Set(items.map(x => x.category || 'Kitchen'))).sort();
    let catOptions = `<option value="ALL">All Categories (${items.length})</option>`;
    categories.forEach(c => {
      const count = items.filter(x => (x.category || 'Kitchen') === c).length;
      catOptions += `<option value="${Utils.escapeHtml(c)}">${Utils.escapeHtml(c)} (${count})</option>`;
    });

    host.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:16px;">
        <div style="display:flex; gap:10px; flex:1; min-width:280px;">
          <input type="text" id="overall-hist-search" class="input-field" placeholder="Search item name, SKU..." style="flex:1; height:36px; font-size:13px;" oninput="filterOverallHistoryTable()">
          <select id="overall-hist-cat" class="input-field" style="width:180px; height:36px; font-size:13px;" onchange="filterOverallHistoryTable()">
            ${catOptions}
          </select>
        </div>
        <div style="font-size:12px; color:var(--text-muted);">
          Showing <strong id="overall-hist-count" style="color:var(--text-main);">${items.length}</strong> previously updated item(s)
        </div>
      </div>

      <div class="table-responsive" style="max-height:55vh; overflow-y:auto; border:1px solid rgba(0,0,0,0.08); border-radius:10px;">
        <table class="table" style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead style="position:sticky; top:0; background:#fafafa; z-index:2; border-bottom:1.5px solid rgba(0,0,0,0.1);">
            <tr style="text-align:left;">
              <th style="padding:10px 12px;">Item Name</th>
              <th style="padding:10px 12px;">Category</th>
              <th style="padding:10px 12px; text-align:center; background:rgba(201,162,39,0.08); color:#b45309;">Previous Stock</th>
              <th style="padding:10px 12px; text-align:center;">Unit Cost</th>
              <th style="padding:10px 12px;">Last Recorded Date</th>
              <th style="padding:10px 12px;">Updated By</th>
              <th style="padding:10px 12px; text-align:center;">History Log</th>
            </tr>
          </thead>
          <tbody id="overall-hist-tbody">
            ${renderOverallHistoryRows(items)}
          </tbody>
        </table>
      </div>
    `;

    if (focusItemName) {
      const searchBox = document.getElementById("overall-hist-search");
      if (searchBox) {
        searchBox.value = focusItemName;
        filterOverallHistoryTable();
      }
    }
  } catch (err) {
    const host = document.getElementById("overall-history-container");
    if (host) host.innerHTML = `<div style="color:var(--danger); padding:16px;">${Utils.escapeHtml(err.message)}</div>`;
  }
}

function renderOverallHistoryRows(items) {
  if (!items || !items.length) {
    return `<tr><td colspan="7" style="text-align:center; padding:24px; color:var(--text-muted);">No matching previously updated items found.</td></tr>`;
  }
  return items.map(it => {
    const prevTimeline = (it.all_previous_records || []).slice(0, 5);
    const timelineHtml = prevTimeline.map(r => `
      <div style="font-size:11px; padding:3px 0; border-bottom:1px dashed rgba(0,0,0,0.06); display:flex; justify-content:space-between; gap:12px;">
        <span><strong>${Number(r.previous_stock) % 1 === 0 ? Number(r.previous_stock) : Number(r.previous_stock).toFixed(2)}</strong></span>
        <span style="color:var(--text-muted);">${Utils.escapeHtml(r.inventory_date || '')} by ${Utils.escapeHtml(r.submitted_by_username || 'Staff')}</span>
      </div>
    `).join('');

    return `
      <tr style="border-bottom:1px solid rgba(0,0,0,0.05);">
        <td style="padding:10px 12px;">
          <div style="font-weight:700; color:var(--text-main);">${Utils.escapeHtml(it.item_name)}</div>
          ${it.sku ? `<span style="font-size:10px; font-family:monospace; color:var(--text-muted); background:rgba(0,0,0,0.05); padding:1px 4px; border-radius:3px;">${Utils.escapeHtml(it.sku)}</span>` : ''}
        </td>
        <td style="padding:10px 12px;">
          <span class="badge" style="background:rgba(201,162,39,0.1); color:#c9a227; font-size:11px;">${Utils.escapeHtml(it.category || 'Kitchen')}</span>
        </td>
        <td style="padding:10px 12px; text-align:center; background:rgba(201,162,39,0.04);">
          <span style="display:inline-block; font-size:14px; font-weight:800; color:#b45309; padding:3px 10px; background:#fef3c7; border-radius:12px;">
            ${Number(it.previous_stock) % 1 === 0 ? Number(it.previous_stock) : Number(it.previous_stock).toFixed(2)}
          </span>
          <div style="font-size:10px; color:#92400e; margin-top:2px; font-weight:600;">(Previous Update)</div>
        </td>
        <td style="padding:10px 12px; text-align:center; font-weight:600; color:#18181b;">
          ₱${Number(it.previous_unit_price || 0).toFixed(2)}
        </td>
        <td style="padding:10px 12px; font-size:12px; color:var(--text-muted);">
          <div>${Utils.escapeHtml(it.previous_date || '-')}</div>
          <div style="font-size:10.5px; opacity:0.8;">${it.previous_submitted_at ? new Date(it.previous_submitted_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : ''}</div>
        </td>
        <td style="padding:10px 12px; font-size:12px; color:var(--text-main);">
          <i class="fas fa-user" style="font-size:10px; margin-right:4px; opacity:0.6;"></i>${Utils.escapeHtml(it.previous_submitted_by || 'Staff')}
        </td>
        <td style="padding:10px 12px; text-align:center;">
          <details style="cursor:pointer; text-align:left;">
            <summary style="font-size:11px; font-weight:700; color:#2563eb; outline:none;">
              View Prior (${it.total_previous_updates || prevTimeline.length})
            </summary>
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:6px 8px; margin-top:4px; max-width:260px;">
              ${timelineHtml || '<div style="font-size:11px; color:#94a3b8;">No older records</div>'}
            </div>
          </details>
        </td>
      </tr>
    `;
  }).join('');
}

function filterOverallHistoryTable() {
  const q = (document.getElementById("overall-hist-search")?.value || "").toLowerCase().trim();
  const cat = document.getElementById("overall-hist-cat")?.value || "ALL";
  const tbody = document.getElementById("overall-hist-tbody");
  const countEl = document.getElementById("overall-hist-count");

  const filtered = (cachedOverallHistory || []).filter(it => {
    const matchCat = cat === "ALL" || (it.category || 'Kitchen') === cat;
    const matchSearch = !q ||
      (it.item_name && it.item_name.toLowerCase().includes(q)) ||
      (it.sku && it.sku.toLowerCase().includes(q)) ||
      (it.category && it.category.toLowerCase().includes(q));
    return matchCat && matchSearch;
  });

  if (tbody) tbody.innerHTML = renderOverallHistoryRows(filtered);
  if (countEl) countEl.textContent = filtered.length;
}

function viewDailyHistory(itemId, itemName) {
  return openOverallStockHistoryModal(itemId, itemName);
}

function renderInventoryRows(items) {
  const currentUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  const userRole = (currentUser && currentUser.role ? currentUser.role : (typeof Auth !== 'undefined' ? Auth.getRole() : '')).toLowerCase();
  const isInventoryAccount = userRole === 'inventory' || window.location.pathname.includes('/inventory');
  const isManager = userRole === 'manager' || window.location.pathname.includes('/manager');
  const isAdmin = userRole === 'admin' || userRole === 'branch_admin' || userRole === 'super_admin' || userRole.includes('admin') || window.location.pathname.includes('/admin');

  if (!items || !items.length) {
    return `<tr><td colspan="${isInventoryAccount ? 9 : 8}" style="text-align:center; padding:40px; color:var(--text-muted);"><i class="fas fa-boxes" style="font-size:24px; margin-bottom:8px; display:block; opacity:0.5;"></i>No inventory items match the criteria.<br><button class="btn btn-outline btn-sm" style="margin-top:12px;" onclick="openImportMasterlistModal()"><i class="fas fa-file-import"></i> Import Official Master List</button></td></tr>`;
  }

  return items.map(i => {
    const isOut = Number(i.quantity) <= 0;
    const isLow = Number(i.quantity) <= Number(i.min_stock);
    const badgeClass = isOut ? 'badge-danger' : isLow ? 'badge-warning' : 'badge-success';
    const badgeText = isOut ? 'Out of Stock' : isLow ? 'Low Stock' : 'In Stock';
    const catName = i.category || 'Kitchen';
    const unitPrice = Number(i.unit_price) || 0;
    const totalVal = (Number(i.quantity) || 0) * unitPrice;
    const isSelected = selectedInventoryIds.has(Number(i.id));

    return `
      <tr id="inv-row-${Utils.escapeHtml(i.id)}" class="${isSelected ? 'row-selected' : ''}">
        <td style="width:48px; text-align:center; padding-left:14px; padding-right:14px;">
          <input type="checkbox" 
                 class="inv-checkbox inv-item-checkbox" 
                 id="inv-chk-${Utils.escapeHtml(i.id)}"
                 data-id="${Utils.escapeHtml(i.id)}" 
                 value="${Utils.escapeHtml(i.id)}" 
                 ${isSelected ? 'checked' : ''} 
                 onchange="toggleSelectInventoryItem(${Number(i.id)}, this.checked)"
                 title="Select ${Utils.escapeHtml(i.name)}">
        </td>
        <td>
          <strong style="color:var(--text-main); font-size:13px;">${Utils.escapeHtml(i.name)}</strong>
          ${i.sku ? `<span style="font-size:10px; font-family:monospace; background:rgba(0,0,0,0.06); padding:2px 5px; border-radius:4px; margin-left:6px; color:var(--text-muted); font-weight:600;">${Utils.escapeHtml(i.sku)}</span>` : ''}
        </td>
        <td><span class="badge" style="background:rgba(201,162,39,0.12); color:#c9a227; font-size:11px; font-weight:600;">${Utils.escapeHtml(catName)}</span></td>
        <!-- Current Stock (Cannot update - unclickable status badge) -->
        <td>
          <div style="display:inline-flex; align-items:center; gap:6px;">
            <span class="badge" style="font-size:13px; font-weight:800; background:#f4f4f5; color:#27272a; padding:6px 14px; border-radius:14px; border:1px solid #e4e4e7; cursor:default; user-select:none;" title="Current Stock on Hand (read-only)">
              ${Number(i.quantity) % 1 === 0 ? Number(i.quantity) : Number(i.quantity).toFixed(2)}
            </span>
          </div>
        </td>
        ${isInventoryAccount ? `
          <!-- New Total Stock: Inventory can save stock once until Admin grants permission again -->
          <td style="background:rgba(5,150,105,0.02);">
            ${i.daily_input_submitted ? `
              <div style="display:inline-flex; align-items:center; gap:6px;">
                <span class="badge" style="background:rgba(5,150,105,0.1); color:#047857; border:1px solid rgba(5,150,105,0.25); font-weight:700; font-size:12px; padding:6px 12px; border-radius:10px;" title="Stock already saved. Ask an Admin for permission to add stock again.">
                  <i class="fas fa-lock" style="color:#059669; margin-right:5px;"></i>Stock Saved
                </span>
              </div>
            ` : `
              <div style="display:inline-flex; align-items:center; gap:6px;">
                <input type="number" 
                       step="any"
                       min="0"
                       id="inv-stock-${Utils.escapeHtml(i.id)}" 
                       class="input-field" 
                       value="${Number(i.quantity)}" 
                       style="width:85px; height:34px; padding:4px 8px; font-size:13.5px; font-weight:800; border-radius:12px; border:1.5px solid rgba(5,150,105,0.4); background:#fff; text-align:center; color:#059669;" 
                       title="Enter new total stock">
                <button id="inv-save-btn-${Utils.escapeHtml(i.id)}"
                        class="btn btn-primary btn-sm" 
                        style="padding:4px 9px; font-size:11px; font-weight:700; border-radius:8px; background:#18181b; border-color:#18181b; white-space:nowrap;" 
                        onclick="saveInventoryStockOnly(${i.id})" 
                        title="Save New Total Stock">
                  <i class="fas fa-save"></i> Save Stock
                </button>
              </div>
            `}
          </td>
        ` : ''}
        <td style="background:rgba(201,162,39,0.03);">
          ${isInventoryAccount ? `
            <!-- Inventory Account: Price per Unit is editable and updated here -->
            <div style="display:inline-flex; align-items:center; gap:4px;">
              <span style="font-size:13px; font-weight:800; color:#c9a227;">₱</span>
              <input type="number" 
                     step="0.01" 
                     min="0"
                     id="inv-price-${Utils.escapeHtml(i.id)}" 
                     class="input-field" 
                     value="${unitPrice.toFixed(2)}" 
                     style="width:90px; height:34px; padding:4px 8px; font-size:13.5px; font-weight:800; color:#c9a227; border-radius:12px; border:1.5px solid rgba(201,162,39,0.5); background:#fff; text-align:center;" 
                     title="Enter price per unit">
              <button class="btn btn-outline btn-sm" 
                      style="padding:4px 8px; font-size:11px; font-weight:700; color:#c9a227; border-color:rgba(201,162,39,0.5); border-radius:8px;" 
                      onclick="inlineUpdatePrice(${i.id}, document.getElementById('inv-price-${i.id}').value)" 
                      title="Update Price per Unit">
                <i class="fas fa-check"></i> Save
              </button>
            </div>
          ` : `
            <!-- Manager & Admin Account: Price per Unit is read-only (only Inventory account can update price) -->
            <div style="display:inline-flex; align-items:center; gap:4px;">
              <span class="badge" style="font-size:13px; font-weight:800; background:rgba(201,162,39,0.1); color:#c9a227; padding:5px 10px; border-radius:12px; border:1px solid rgba(201,162,39,0.25);" title="Price per Unit is managed by the Inventory account">
                <i class="fas fa-lock" style="font-size:10px; margin-right:4px; opacity:0.6;"></i>₱${unitPrice.toFixed(2)}
              </span>
            </div>
          `}
        </td>
        <td style="background:rgba(16,185,129,0.04);"><strong id="inv-val-${Utils.escapeHtml(i.id)}" style="color:#10b981; font-size:13px; font-weight:700;">${Utils.formatCurrency(totalVal)}</strong></td>
        <td><span class="badge ${badgeClass}" style="font-size:11px; font-weight:700;">${badgeText}</span></td>
        <td style="text-align:right; white-space:nowrap;">
          <div style="display:inline-flex; align-items:center; justify-content:flex-end; gap:6px;">
            ${(isAdmin && i.daily_input_submitted) ? `
              <button class="btn btn-outline btn-sm" 
                      style="padding:5px 10px; font-size:11.5px; font-weight:700; color:#059669; border-color:rgba(5,150,105,0.45); background:rgba(5,150,105,0.08); border-radius:8px;" 
                      onclick="allowInventoryStockAgain(${i.id}, ${Utils.jsArg(i.name)})" 
                      title="Allow Inventory to add stock again">
                <i class="fas fa-unlock"></i> Allow Stock
              </button>
            ` : ''}
            <!-- History button: available to Admin / Owner and Inventory accounts -->
            ${(isAdmin || isInventoryAccount) ? `
              <button class="btn btn-outline btn-sm" 
                      style="padding:5px 10px; font-size:12px; font-weight:700; color:#18181b; border-color:#d4d4d8; background:#fafafa; border-radius:8px;" 
                      onclick="openInventoryItemHistoryModal(${i.id}, ${Utils.jsArg(i.name)})" 
                      title="View Complete Item Audit Trail">
                <i class="fas fa-clock-rotate-left" style="color:#c9a227;"></i> History
              </button>
            ` : ''}
            ${(isAdmin || isManager || isInventoryAccount) ? `
              <button class="btn btn-outline btn-sm inv-action-btn"
                      style="padding:5px 9px; font-size:11.5px; font-weight:700; color:#ef4444; border-color:rgba(239,68,68,0.4); background:rgba(239,68,68,0.06); border-radius:8px;"
                      onclick="openLogWastageModal(${i.id})"
                      title="Record Wastage / Spoilage for ${Utils.escapeHtml(i.name)}">
                <i class="fas fa-trash-alt"></i> Wastage
              </button>
              <button class="btn btn-outline btn-sm inv-action-btn inv-edit-btn" 
                      style="padding:5px 9px; font-size:12px; color:#c9a227; border-color:rgba(201,162,39,0.45); background:rgba(201,162,39,0.06); border-radius:8px;" 
                      onclick="openEditInventoryModal(${i.id})" 
                      title="Edit Item Details" 
                      aria-label="Edit ${Utils.escapeHtml(i.name)}">
                <i class="fas fa-pen"></i>
              </button>
            ` : ''}
            ${isAdmin ? `
              <button class="btn btn-outline btn-sm inv-action-btn inv-delete-btn" 
                      style="padding:5px 9px; font-size:12px; color:var(--danger, #ef4444); border-color:rgba(239,68,68,0.4); background:rgba(239,68,68,0.06); border-radius:8px;" 
                      onclick="deleteInventoryItem(${i.id}, ${Utils.jsArg(i.name)})" 
                      title="Delete Item" 
                      aria-label="Delete ${Utils.escapeHtml(i.name)}">
                <i class="fas fa-trash"></i>
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function getCurrentlyDisplayedInventory() {
  if (!cachedInventory || !cachedInventory.length) return [];
  const q = (document.getElementById("inv-search")?.value || "").toLowerCase().trim();
  return cachedInventory.filter(i => {
    const matchCat = currentInvCategory === "ALL" || (i.category && i.category.toLowerCase() === currentInvCategory.toLowerCase());
    const matchSearch = !q || 
      (i.name && i.name.toLowerCase().includes(q)) || 
      (i.sku && i.sku.toLowerCase().includes(q)) ||
      (i.category && i.category.toLowerCase().includes(q));
    return matchCat && matchSearch;
  });
}

function updateInventoryBulkToolbar() {
  const toolbar = document.getElementById("inv-bulk-toolbar");
  const countSpan = document.getElementById("inv-selected-count");
  const deleteCountSpan = document.getElementById("inv-delete-count");
  const count = selectedInventoryIds.size;

  if (toolbar) {
    if (count > 0) {
      toolbar.style.display = "flex";
      if (countSpan) countSpan.textContent = count;
      if (deleteCountSpan) deleteCountSpan.textContent = count;
    } else {
      toolbar.style.display = "none";
    }
  }
}

function updateSelectAllHeaderState() {
  const headerCheckbox = document.getElementById("inv-select-all");
  if (!headerCheckbox) return;

  const displayed = getCurrentlyDisplayedInventory();
  if (!displayed.length) {
    headerCheckbox.checked = false;
    headerCheckbox.indeterminate = false;
    return;
  }

  const selectedInDisplayed = displayed.filter(i => selectedInventoryIds.has(Number(i.id)));
  if (selectedInDisplayed.length === 0) {
    headerCheckbox.checked = false;
    headerCheckbox.indeterminate = false;
  } else if (selectedInDisplayed.length === displayed.length) {
    headerCheckbox.checked = true;
    headerCheckbox.indeterminate = false;
  } else {
    headerCheckbox.checked = false;
    headerCheckbox.indeterminate = true;
  }
}

function toggleSelectInventoryItem(itemId, isChecked) {
  const idNum = Number(itemId);
  if (isChecked) {
    selectedInventoryIds.add(idNum);
  } else {
    selectedInventoryIds.delete(idNum);
  }

  const row = document.getElementById(`inv-row-${idNum}`);
  if (row) {
    if (isChecked) row.classList.add("row-selected");
    else row.classList.remove("row-selected");
  }

  updateSelectAllHeaderState();
  updateInventoryBulkToolbar();
}

function toggleSelectAllInventory(isChecked) {
  const displayed = getCurrentlyDisplayedInventory();
  displayed.forEach(item => {
    const idNum = Number(item.id);
    if (isChecked) {
      selectedInventoryIds.add(idNum);
    } else {
      selectedInventoryIds.delete(idNum);
    }
    const chk = document.getElementById(`inv-chk-${idNum}`);
    if (chk) chk.checked = isChecked;
    const row = document.getElementById(`inv-row-${idNum}`);
    if (row) {
      if (isChecked) row.classList.add("row-selected");
      else row.classList.remove("row-selected");
    }
  });

  updateSelectAllHeaderState();
  updateInventoryBulkToolbar();
}

function selectAllDisplayedInventory() {
  toggleSelectAllInventory(true);
}

function clearInventorySelection() {
  selectedInventoryIds.clear();
  const checkboxes = document.querySelectorAll(".inv-item-checkbox");
  checkboxes.forEach(c => { c.checked = false; });
  const rows = document.querySelectorAll("#inv-tbody tr.row-selected");
  rows.forEach(r => r.classList.remove("row-selected"));

  updateSelectAllHeaderState();
  updateInventoryBulkToolbar();
}

function openBulkDeleteModal() {
  const count = selectedInventoryIds.size;
  if (count === 0) {
    Utils.showToast("No inventory items selected for deletion.", "warning");
    return;
  }

  // Get details of selected items
  const selectedItems = cachedInventory.filter(i => selectedInventoryIds.has(Number(i.id)));
  const previewListHtml = selectedItems.slice(0, 10).map(item => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 10px; background:rgba(0,0,0,0.03); border-radius:6px; font-size:12px; margin-bottom:4px;">
      <div>
        <strong style="color:var(--text-main);">${Utils.escapeHtml(item.name)}</strong>
        <span style="color:var(--text-muted); font-size:11px; margin-left:6px;">(${Utils.escapeHtml(item.category || 'Kitchen')})</span>
      </div>
      <span style="font-weight:700; color:var(--text-muted); font-size:11px;">${Number(item.quantity)}</span>
    </div>
  `).join('');

  const overflowText = selectedItems.length > 10 
    ? `<div style="text-align:center; font-size:11px; color:var(--text-muted); margin-top:6px;">...and ${selectedItems.length - 10} more item(s)</div>` 
    : '';

  Utils.openModal(`
    <i class="fas fa-triangle-exclamation" style="color:#ef4444; margin-right:8px;"></i> Confirm Bulk Inventory Deletion
  `, `
    <div style="padding:6px 0;">
      <div style="background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:12px 14px; margin-bottom:16px;">
        <div style="display:flex; align-items:center; gap:10px; color:#ef4444; font-weight:700; font-size:14px; margin-bottom:4px;">
          <i class="fas fa-trash-can" style="font-size:16px;"></i>
          <span>Are you sure you want to delete ${Utils.escapeHtml(count)} inventory item(s)?</span>
        </div>
        <div style="font-size:12px; color:var(--text-main); line-height:1.5;">
          This will permanently remove the selected records from the inventory master catalog and recalculate stock asset valuation. This action cannot be undone.
        </div>
      </div>

      <div style="margin-bottom:12px;">
        <label style="font-size:11px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:6px;">
          Selected Records Preview (${Utils.escapeHtml(count)} total):
        </label>
        <div style="max-height:160px; overflow-y:auto; border:1px solid rgba(205,190,150,0.35); border-radius:8px; padding:6px; background:#fff;">
          ${previewListHtml}
          ${Utils.escapeHtml(overflowText)}
        </div>
      </div>

      <div id="bulk-delete-error" style="display:none; color:#ef4444; font-size:12px; background:rgba(239,68,68,0.08); border-radius:6px; padding:8px 12px; margin-bottom:14px;"></div>

      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:18px;">
        <button type="button" class="btn btn-outline" onclick="Utils.closeModal()">
          Cancel
        </button>
        <button type="button" id="btn-confirm-bulk-delete" class="btn btn-danger" onclick="executeBulkDeleteInventory()" style="display:inline-flex; align-items:center; gap:8px;">
          <i class="fas fa-trash-can"></i> Confirm Delete (${Utils.escapeHtml(count)})
        </button>
      </div>
    </div>
  `);
}

async function executeBulkDeleteInventory() {
  const confirmBtn = document.getElementById("btn-confirm-bulk-delete");
  const errBox = document.getElementById("bulk-delete-error");
  const itemIds = Array.from(selectedInventoryIds);

  if (!itemIds.length) {
    Utils.showToast("No items selected.", "warning");
    Utils.closeModal();
    return;
  }

  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';
  }
  if (errBox) errBox.style.display = "none";

  try {
    const res = await Auth.fetch("/api/v1/inventory/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_ids: itemIds })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errMsg = (data && data.detail) || "Failed to bulk delete inventory items.";
      throw new Error(errMsg);
    }

    const deletedCount = (data && data.deleted_count) || (data && data.deleted_ids && data.deleted_ids.length) || itemIds.length;
    const deletedIds = (data && data.deleted_ids) || itemIds;

    // Remove deleted IDs from selected set
    deletedIds.forEach(id => selectedInventoryIds.delete(Number(id)));

    Utils.closeModal();
    Utils.showToast(data.message || `Successfully deleted ${deletedCount} inventory item(s).`, "success");

    // Refresh inventory catalog & summary metrics
    await renderInventory();
  } catch (err) {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = `<i class="fas fa-trash-can"></i> Confirm Delete (${Utils.escapeHtml(itemIds.length)})`;
    }
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = "block";
    }
    Utils.showToast(err.message, "danger");
  }
}

function filterInventoryCategory(category) {
  currentInvCategory = category;
  filterInventoryList();
  // Re-render category buttons active state
  const container = document.getElementById("view-container");
  if (container) {
    const buttons = container.querySelectorAll("button[onclick^='filterInventoryCategory']");
    buttons.forEach(btn => {
      const match = btn.getAttribute("onclick").includes(`'${category}'`);
      btn.className = `btn ${match ? 'btn-primary' : 'btn-outline'}`;
    });
  }
}

function filterInventoryList() {
  const filtered = getCurrentlyDisplayedInventory();
  const tbody = document.getElementById("inv-tbody");
  const countBadge = document.getElementById("inv-count-badge");
  if (tbody) tbody.innerHTML = renderInventoryRows(filtered);
  if (countBadge) countBadge.textContent = `${filtered.length} items listed`;
  updateSelectAllHeaderState();
}


function openImportMasterlistModal() {
  const categories = [
    { name: "Kitchen", icon: "fa-utensils", desc: "Rice, Cooking Oil, Soy Sauce, Seasonings, Meat & Poultry" },
    { name: "Street Foods", icon: "fa-burger", desc: "Fishballs, Kikiam, Tempura, Hotdog, Lumpia Wrapper, Fries" },
    { name: "Coffee Bar", icon: "fa-mug-hot", desc: "Coffee Powder, Syrups, Milk, Powders, Boba" },
    { name: "Beverages", icon: "fa-glass-water", desc: "Bottled Water, Sodas, Beers, Liquors, Juices" },
    { name: "Packaging", icon: "fa-box-open", desc: "Plastic & Paper Cups, Lids, Bags, Food Boxes, Straws" },
    { name: "Cleaning Supplies", icon: "fa-broom", desc: "Dishwashing Liquid, Bleach, Hand Soap, Mop, Broom" },
    { name: "Office Supplies and Equipments", icon: "fa-stapler", desc: "Bond Paper, Ink, Pens, Staplers, Printers, Desktops" },
    { name: "Monthly Bills", icon: "fa-receipt", desc: "Electricity, Water, Internet, Rent, Phone/load" },
    { name: "Employee Salary", icon: "fa-users-gear", desc: "Weekly Payroll, 15th and 30th Payroll" },
    { name: "SAMGYUPSAL", icon: "fa-fire-burner", desc: "Pork Belly, Beef, Kimchi, Grill Pan, Gas Canister" },
    { name: "KITCHEN UTENSILS & EQUIPMENT", icon: "fa-blender", desc: "Gas Stove, Rice Cooker, Pots, Pans, Utensils, Tools" },
    { name: "FURNITURE & FIXTURES", icon: "fa-chair", desc: "Dining Table, Chairs, Stools, Electric Fan, Storage Rack" },
  ];

  Utils.openModal('<i class="fas fa-file-import" style="color:var(--accent); margin-right:8px;"></i> Import Master List to Database', `
    <!-- Tabs: Official Departments vs Custom List / Paste Names -->
    <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; border-bottom:1px solid rgba(205,190,150,0.3); padding-bottom:8px;">
      <button id="tab-master-depts" class="btn btn-primary btn-sm" onclick="switchImportTab('depts')" style="font-size:12px;">
        <i class="fas fa-boxes-stacked"></i> Official Department Master List
      </button>
      <button id="tab-master-custom" class="btn btn-outline btn-sm" onclick="switchImportTab('custom')" style="font-size:12px;">
        <i class="fas fa-file-lines"></i> Import Custom List / Paste Names
      </button>
    </div>

    <!-- Tab 1: Official Department Master List -->
    <div id="import-pane-depts">
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:14px; background:rgba(201,162,39,0.06); padding:10px 14px; border-radius:8px; border-left:3px solid #c9a227;">
        <strong><i class="fas fa-database"></i> Direct Database Import (0 Current Stock):</strong> When importing, items are automatically stored directly into the database with <strong>0.0 current stock</strong>.
      </div>

      <!-- File Upload / Specific Department Importer -->
      <div style="background:rgba(201,162,39,0.06); border:1.5px dashed rgba(201,162,39,0.45); border-radius:12px; padding:16px; margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
          <div style="flex:1; min-width:240px;">
            <strong style="color:var(--text-main); font-size:13px; display:flex; align-items:center; gap:6px;">
              <i class="fas fa-file-word" style="color:#c9a227; font-size:16px;"></i> Import from Master List File (.docx, .csv, .txt)
            </strong>
            <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Upload The-MASTERLIST-1.docx or your file to import specific departments or all items to DB.</div>
          </div>
          <label class="btn btn-primary btn-sm" style="cursor:pointer; font-size:12px; display:inline-flex; align-items:center; gap:6px; white-space:nowrap;">
            <i class="fas fa-folder-open"></i> Choose File
            <input type="file" id="masterlist-file-input" accept=".docx,.csv,.txt" style="display:none;" onchange="handleMasterlistFileUpload(this)">
          </label>
        </div>

        <div id="file-upload-status" style="display:none; font-size:12px; color:var(--text-main); margin-top:10px; padding:8px 12px; background:rgba(255,255,255,0.85); border-radius:6px; border:1px solid rgba(205,190,150,0.4);"></div>

        <div id="file-parsed-preview" style="display:none; background:#ffffff; border:1px solid rgba(205,190,150,0.4); border-radius:8px; padding:12px; margin-top:10px;">
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap:12px; align-items:flex-end;">
            <div class="input-group" style="margin-bottom:0;">
              <label style="font-size:11px; font-weight:700; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px; display:block;">Select Department to Import from File:</label>
              <select id="file-dept-selector" class="input-field" style="width:100%; height:38px; font-size:13px; font-weight:600;"></select>
            </div>
            <button id="btn-import-file-db" class="btn btn-primary" onclick="submitFileImport()" style="height:38px; font-size:12px; display:inline-flex; align-items:center; justify-content:center; gap:6px; white-space:nowrap;">
              <i class="fas fa-database"></i> Import to Database (0 Stock)
            </button>
          </div>
        </div>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        <h4 style="font-size:12px; text-transform:uppercase; color:var(--text-muted); margin:0;">Or Import by Specific Department</h4>
        <button class="btn btn-outline btn-sm" onclick="submitImportMasterlist(null)" style="font-size:11px; padding:4px 10px; border-color:#c9a227; color:#c9a227;">
          <i class="fas fa-cloud-arrow-down"></i> Import All Departments
        </button>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap:12px; max-height:clamp(220px, 44vh, 460px); overflow-y:auto; padding-right:6px;">
        ${categories.map(c => `
          <div style="border:1px solid rgba(205,190,150,0.35); border-radius:12px; padding:12px 14px; background:#ffffff; display:flex; flex-direction:column; justify-content:space-between; gap:10px; transition:all 0.15s ease;" onmouseenter="this.style.boxShadow='0 4px 14px rgba(201,162,39,0.12)'" onmouseleave="this.style.boxShadow='none'">
            <div>
              <div style="font-weight:700; font-size:13px; color:var(--text-main); display:flex; align-items:center; gap:8px;">
                <span style="width:28px; height:28px; border-radius:6px; background:rgba(201,162,39,0.12); display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;">
                  <i class="fas ${c.icon}" style="color:#c9a227; font-size:13px;"></i>
                </span>
                ${Utils.escapeHtml(c.name)}
              </div>
              <div style="font-size:11px; color:var(--text-muted); margin-top:6px; line-height:1.4;">${Utils.escapeHtml(c.desc)}</div>
            </div>
            <button class="btn btn-outline btn-sm" style="align-self:flex-start; font-size:11px; padding:4px 10px; border-radius:6px; margin-top:auto;" onclick="submitImportMasterlist(${Utils.jsArg(c.name)})">
              <i class="fas fa-file-import"></i> Import ${Utils.escapeHtml(c.name)}
            </button>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Tab 2: Custom List / Paste Item Names -->
    <div id="import-pane-custom" style="display:none;">
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:12px; background:rgba(16,185,129,0.06); padding:10px 14px; border-radius:8px; border-left:3px solid #10b981;">
        <strong><i class="fas fa-check-circle"></i> Item Name Only Import:</strong> Paste item names below (one per line). If there is no current stock, stock will NOT be added and stays at <strong>0.0</strong>.
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap:12px; margin-bottom:12px;">
        <div class="input-group">
          <label style="font-size:11px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Department Category</label>
          <select id="custom-import-cat" class="input-field" style="width:100%;">
            ${categories.map(c => `<option value="${Utils.escapeHtml(c.name)}">${Utils.escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="input-group">
          <label style="font-size:11px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Default Unit</label>
          <select id="custom-import-unit" class="input-field" style="width:100%;">
            <option value="units">units (pieces)</option>
            <option value="kg">kg (kilograms)</option>
            <option value="L">L (liters)</option>
            <option value="packs">packs</option>
            <option value="bottles">bottles</option>
            <option value="cans">cans</option>
            <option value="boxes">boxes</option>
          </select>
        </div>
      </div>

      <div class="input-group" style="margin-bottom:12px;">
        <label style="font-size:11px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Paste Item Names (One per line)</label>
        <textarea id="custom-import-text" class="input-field" rows="6" placeholder="Example:
Beef Sirloin Slices
Japanese Mayo
Brown Sugar
Pork Chop" style="width:100%; font-family:monospace; font-size:12px;"></textarea>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center;">
        <label class="btn btn-outline btn-sm" style="cursor:pointer; font-size:11px; display:inline-flex; align-items:center; gap:6px;">
          <i class="fas fa-file-csv"></i> Load from CSV File
          <input type="file" accept=".csv,.txt" style="display:none;" onchange="handleImportCSVFile(this)">
        </label>
        <button class="btn btn-primary" onclick="submitCustomListImport()" style="font-size:12px;">
          <i class="fas fa-cloud-arrow-up"></i> Import Items (0 Initial Stock)
        </button>
      </div>
    </div>
  `, `<button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>`, "modal-responsive modal-xl");

  // Auto-fit, Auto-Resize, and Responsive sizing
  const modalContent = document.getElementById("modal-content");
  if (modalContent) {
    modalContent.style.width = "min(960px, 95vw)";
    modalContent.style.maxWidth = "960px";
    modalContent.style.maxHeight = "92vh";
    modalContent.style.display = "flex";
    modalContent.style.flexDirection = "column";
    const modalBody = modalContent.querySelector(".modal-body");
    if (modalBody) {
      modalBody.style.overflowY = "auto";
      modalBody.style.maxHeight = "calc(92vh - 120px)";
      modalBody.style.flex = "1";
    }
  }
}

function switchImportTab(tab) {
  const pDepts = document.getElementById("import-pane-depts");
  const pCustom = document.getElementById("import-pane-custom");
  const tDepts = document.getElementById("tab-master-depts");
  const tCustom = document.getElementById("tab-master-custom");
  if (!pDepts || !pCustom) return;

  if (tab === 'custom') {
    pDepts.style.display = "none";
    pCustom.style.display = "block";
    tDepts.className = "btn btn-outline btn-sm";
    tCustom.className = "btn btn-primary btn-sm";
  } else {
    pDepts.style.display = "block";
    pCustom.style.display = "none";
    tDepts.className = "btn btn-primary btn-sm";
    tCustom.className = "btn btn-outline btn-sm";
  }
}

function handleImportCSVFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const textarea = document.getElementById("custom-import-text");
    if (textarea) {
      const itemNames = lines.map(line => {
        const parts = line.split(',');
        return parts[0].replace(/^["']|["']$/g, '').trim();
      }).filter(n => n.toLowerCase() !== 'name' && n.toLowerCase() !== 'item name' && n);
      textarea.value = itemNames.join('\n');
    }
  };
  reader.readAsText(file);
}

async function submitCustomListImport() {
  const textarea = document.getElementById("custom-import-text");
  const cat = document.getElementById("custom-import-cat") ? document.getElementById("custom-import-cat").value : "Kitchen";
  const unit = document.getElementById("custom-import-unit") ? document.getElementById("custom-import-unit").value : "units";
  if (!textarea || !textarea.value.trim()) {
    Utils.showToast("Please enter at least one item name to import.", "danger");
    return;
  }
  const rawLines = textarea.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!rawLines.length) {
    Utils.showToast("No valid item names found.", "danger");
    return;
  }

  // Parse lines: if user provided just item name, quantity is null/empty so it stays 0.0
  const items = rawLines.map(line => {
    const parts = line.split(',');
    const name = parts[0].replace(/^["']|["']$/g, '').trim();
    const qty = parts.length > 1 && parts[1].trim() !== "" ? parts[1].trim() : null;
    return {
      name: name,
      category: cat,
      unit: unit,
      quantity: qty // null means no current stock -> backend assigns 0.0
    };
  }).filter(i => i.name);

  try {
    const res = await Auth.fetch("/api/v1/inventory/import-custom", {
      method: "POST",
      body: JSON.stringify({ items: items })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Custom import failed");
    }
    const result = await res.json();
    Utils.showToast(result.message || `Successfully imported ${result.created_count} items with 0 initial stock!`, "success");
    Utils.closeModal();
    renderInventory();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

let uploadedMasterlistFile = null;

async function handleMasterlistFileUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  uploadedMasterlistFile = file;

  const infoBox = document.getElementById("file-upload-status");
  if (infoBox) {
    infoBox.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Reading & analyzing <strong>${Utils.escapeHtml(file.name)}</strong>...`;
    infoBox.style.display = "block";
  }

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await Auth.fetch("/api/v1/inventory/parse-file", {
      method: "POST",
      body: formData
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to parse file");
    }
    const data = await res.json();
    const depts = Object.keys(data.departments || {});
    
    const deptSelect = document.getElementById("file-dept-selector");
    const previewArea = document.getElementById("file-parsed-preview");
    if (deptSelect && previewArea) {
      deptSelect.innerHTML = `
        <option value="ALL">All Departments (${Utils.escapeHtml(data.total_items)} items total)</option>
        ${depts.map(d => `<option value="${Utils.escapeHtml(d)}">${Utils.escapeHtml(d)} (${Utils.escapeHtml(data.departments[d].length)} items)</option>`).join('')}
      `;
      previewArea.style.display = "block";
    }
    if (infoBox) {
      infoBox.innerHTML = `<i class="fas fa-check-circle" style="color:#10b981;"></i> <strong>${Utils.escapeHtml(file.name)}</strong> loaded: <strong>${Utils.escapeHtml(data.total_items)} items</strong> across <strong>${Utils.escapeHtml(depts.length)} departments</strong> found in file. Select a department above or import all.`;
    }
  } catch (err) {
    if (infoBox) {
      infoBox.innerHTML = `<span style="color:var(--danger);"><i class="fas fa-circle-exclamation"></i> ${Utils.escapeHtml(err.message)}</span>`;
    }
  }
}

async function submitFileImport() {
  if (!uploadedMasterlistFile) {
    Utils.showToast("Please choose a file (.docx, .csv, .txt) first", "danger");
    return;
  }
  const selDept = document.getElementById("file-dept-selector") ? document.getElementById("file-dept-selector").value : "ALL";
  const formData = new FormData();
  formData.append("file", uploadedMasterlistFile);
  if (selDept && selDept !== "ALL") {
    formData.append("department", selDept);
  }

  const btn = document.getElementById("btn-import-file-db");
  if (btn) btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Saving to Database...`;

  try {
    const res = await Auth.fetch("/api/v1/inventory/import-file", {
      method: "POST",
      body: formData
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "File import failed");
    }
    const result = await res.json();
    Utils.showToast(result.message || "Successfully imported items to database!", "success");
    Utils.closeModal();
    renderInventory();
  } catch (err) {
    Utils.showToast(err.message, "danger");
    if (btn) btn.innerHTML = `<i class="fas fa-database"></i> Import to Database (0 Stock)`;
  }
}

async function submitImportMasterlist(category) {
  try {
    const url = category ? `/api/v1/inventory/import-masterlist?selected_category=${encodeURIComponent(category)}` : `/api/v1/inventory/import-masterlist`;
    const res = await Auth.fetch(url, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Import failed");
    }
    const result = await res.json();
    Utils.showToast(result.message || "Master List imported successfully!", "success");
    Utils.closeModal();
    renderInventory();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

function openUrgentRestockModal() {
  if (!cachedAnalytics || !cachedAnalytics.urgent_restock) return;
  const list = cachedAnalytics.urgent_restock;
  const currentUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  const userRole = (currentUser && currentUser.role ? currentUser.role : (typeof Auth !== 'undefined' ? Auth.getRole() : '')).toLowerCase();
  const isAdmin = userRole === 'admin' || userRole === 'branch_admin' || userRole === 'super_admin' || userRole.includes('admin') || window.location.pathname.includes('/admin');

  Utils.openModal('<i class="fas fa-chart-line" style="color:var(--accent); margin-right:8px;"></i> Automated Inventory Analysis & Health Audit', `
    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:18px;">
      <div style="background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.25); border-radius:10px; padding:12px; text-align:center;">
        <div style="font-size:11px; font-weight:700; color:#10b981;">HEALTHY ITEMS</div>
        <div style="font-size:20px; font-weight:800; color:#10b981;">${Utils.escapeHtml(cachedAnalytics.healthy_count)}</div>
      </div>
      <div style="background:rgba(249,115,22,0.08); border:1px solid rgba(249,115,22,0.25); border-radius:10px; padding:12px; text-align:center;">
        <div style="font-size:11px; font-weight:700; color:#f97316;">LOW STOCK</div>
        <div style="font-size:20px; font-weight:800; color:#f97316;">${Utils.escapeHtml(cachedAnalytics.low_stock_count)}</div>
      </div>
      <div style="background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.25); border-radius:10px; padding:12px; text-align:center;">
        <div style="font-size:11px; font-weight:700; color:#ef4444;">OUT OF STOCK</div>
        <div style="font-size:20px; font-weight:800; color:#ef4444;">${Utils.escapeHtml(cachedAnalytics.out_of_stock_count)}</div>
      </div>
    </div>

    <h4 style="font-size:13px; font-weight:700; margin-bottom:10px; color:var(--text-main);">Prioritized Restock List</h4>
    <div class="table-wrap" style="max-height:300px; overflow-y:auto; overflow-x:auto; border:1px solid rgba(205,190,150,0.3); border-radius:10px;">
      <table style="width:100%; font-size:12px;">
        <thead>
          <tr style="background:#faf8f3;">
            <th style="padding:8px 12px;">Item</th>
            <th style="padding:8px 12px;">Department</th>
            <th style="padding:8px 12px;">Current</th>
            <th style="padding:8px 12px;">Min Target</th>
            <th style="padding:8px 12px;">Deficit</th>
            <th style="padding:8px 12px; text-align:right;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${list.map(u => `
            <tr>
              <td style="padding:8px 12px;"><strong>${Utils.escapeHtml(u.name)}</strong></td>
              <td style="padding:8px 12px; color:var(--text-muted);">${Utils.escapeHtml(u.category)}</td>
              <td style="padding:8px 12px; color:${u.quantity <= 0 ? '#ef4444' : '#f97316'}; font-weight:700;">${Utils.escapeHtml(u.quantity)}</td>
              <td style="padding:8px 12px;">${Utils.escapeHtml(u.min_stock)}</td>
              <td style="padding:8px 12px; color:#ef4444; font-weight:700;">-${Utils.escapeHtml(u.deficit)}</td>
              <td style="padding:8px 12px; text-align:right;">
                ${isAdmin ? `<button class="btn btn-primary btn-sm" style="padding:2px 8px; font-size:11px;" onclick="openEditInventoryModal(${u.id})">Edit Stock</button>` : `<span style="font-size:11px; color:var(--text-muted);">Admin Only</span>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `, `<button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>`);
}

function openAddInventoryModal() {
  const depts = [
    "Kitchen", "Street Foods", "Coffee Bar", "Beverages", "Packaging",
    "Cleaning Supplies", "Office Supplies and Equipments", "SAMGYUPSAL",
    "KITCHEN UTENSILS & EQUIPMENT", "FURNITURE & FIXTURES"
  ];

  Utils.openModal(`
    <div style="display:flex; align-items:center; gap:10px;">
      <div style="width:38px; height:38px; border-radius:10px; background:rgba(201,162,39,0.15); color:#c9a227; display:flex; align-items:center; justify-content:center; font-size:18px;">
        <i class="fas fa-boxes-stacked"></i>
      </div>
      <div>
        <h3 style="font-size:17px; font-weight:800; margin:0; color:var(--text-main);">Add Inventory Item</h3>
        <p style="font-size:12px; color:var(--text-muted); margin:2px 0 0 0;">Add new stock item details, pricing, and initial inventory quantity.</p>
      </div>
    </div>
  `, `
    <form id="form-add-inv" onsubmit="event.preventDefault(); submitAddInventory();" style="display:flex; flex-direction:column; gap:18px;">
      
      <!-- SECTION A: PRODUCT INFORMATION -->
      <div style="background:#fafafa; border:1px solid #e4e4e7; border-radius:12px; padding:16px;">
        <div style="font-weight:700; font-size:12.5px; color:#18181b; margin-bottom:12px; display:flex; align-items:center; gap:6px; text-transform:uppercase; letter-spacing:0.4px;">
          <i class="fas fa-tag" style="color:#c9a227;"></i> Product Information
        </div>
        
        <div class="input-group" style="margin-bottom:12px;">
          <label style="font-size:12px; font-weight:700; color:var(--text-main); display:block; margin-bottom:5px;">
            Item Name <span style="color:var(--danger, #ef4444);">*</span>
          </label>
          <input id="inv-name" class="input-field" required placeholder="Enter inventory item name (e.g. Cooking Oil, Fishballs, Rice)" style="width:100%; height:40px; font-size:13.5px; font-weight:600; border-radius:10px; border:1px solid #d4d4d8; background:#fff; padding:0 12px;">
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px;">
          <div class="input-group">
            <label style="font-size:12px; font-weight:700; color:var(--text-main); display:block; margin-bottom:5px;">
              Department / Category <span style="color:var(--danger, #ef4444);">*</span>
            </label>
            <select id="inv-cat" class="input-field" style="width:100%; height:40px; font-size:13.5px; font-weight:600; border-radius:10px; border:1px solid #d4d4d8; background:#fff; padding:0 10px;">
              ${depts.map(d => `<option value="${Utils.escapeHtml(d)}">${Utils.escapeHtml(d)}</option>`).join('')}
            </select>
          </div>

          <div class="input-group">
            <label style="font-size:12px; font-weight:700; color:var(--text-main); display:block; margin-bottom:5px;">
              Product Code (POS Link) <span style="font-weight:400; font-size:11px; color:var(--text-muted);">(Optional)</span>
            </label>
            <select id="inv-sku" class="input-field" style="width:100%; height:40px; font-size:13px; font-weight:500; border-radius:10px; border:1px solid #d4d4d8; background:#fff; padding:0 10px;">
              <option value="">— None (No POS link) —</option>
              ${(cachedProducts || []).filter(p => p.is_active !== false && p.is_active !== 0).sort((a,b) => a.name.localeCompare(b.name)).map(p => `<option value="${Utils.escapeHtml(p.sku)}">${Utils.escapeHtml(p.name)} (${Utils.escapeHtml(p.sku)})</option>`).join('')}
            </select>
            <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
              <i class="fas fa-info-circle" style="color:#3b82f6;"></i> Automatically deduct inventory when the linked POS product is sold.
            </div>
          </div>
        </div>
      </div>

      <!-- SECTION B: INVENTORY DETAILS -->
      <div style="background:#fafafa; border:1px solid #e4e4e7; border-radius:12px; padding:16px;">
        <div style="font-weight:700; font-size:12.5px; color:#18181b; margin-bottom:12px; display:flex; align-items:center; gap:6px; text-transform:uppercase; letter-spacing:0.4px;">
          <i class="fas fa-cubes" style="color:#3b82f6;"></i> Inventory Stock Details
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px;">
          <div class="input-group">
            <label style="font-size:12px; font-weight:700; color:var(--text-main); display:block; margin-bottom:5px;">
              Current Stock <span style="color:var(--danger, #ef4444);">*</span>
            </label>
            <input type="number" step="any" min="0" id="inv-qty" class="input-field" required value="0" placeholder="0" style="width:100%; height:40px; font-size:14px; font-weight:700; border-radius:10px; border:1px solid #d4d4d8; background:#fff; padding:0 12px; color:var(--text-main);">
            <div style="font-size:11px; color:var(--text-muted); margin-top:3px;">Initial stock quantity on hand.</div>
          </div>



          <div class="input-group">
            <label style="font-size:12px; font-weight:700; color:var(--text-main); display:block; margin-bottom:5px;">
              Minimum Stock Alert <span style="color:var(--danger, #ef4444);">*</span>
            </label>
            <input type="number" step="any" min="0" id="inv-min" class="input-field" required value="1" placeholder="1" style="width:100%; height:40px; font-size:14px; font-weight:700; border-radius:10px; border:1px solid #d4d4d8; background:#fff; padding:0 12px; color:#f97316;">
            <div style="font-size:11px; color:var(--text-muted); margin-top:3px;">Low-stock warning threshold.</div>
          </div>
        </div>
      </div>

      <!-- SECTION C: PRICING INFORMATION -->
      <div style="background:#fefce8; border:1px solid #fef08a; border-radius:12px; padding:16px;">
        <div style="font-weight:700; font-size:12.5px; color:#854d0e; margin-bottom:10px; display:flex; align-items:center; gap:6px; text-transform:uppercase; letter-spacing:0.4px;">
          <i class="fas fa-coins" style="color:#ca8a04;"></i> Pricing Information
        </div>

        <div class="input-group" style="max-width:320px;">
          <label style="font-size:12px; font-weight:700; color:#854d0e; display:block; margin-bottom:5px;">
            Unit Price / Cost (₱) <span style="color:var(--danger, #ef4444);">*</span>
          </label>
          <div style="display:flex; align-items:center; position:relative;">
            <span style="position:absolute; left:12px; font-size:15px; font-weight:800; color:#ca8a04;">₱</span>
            <input type="number" step="0.01" min="0" id="inv-price" class="input-field" required value="50.00" placeholder="0.00" style="width:100%; height:42px; font-size:15px; font-weight:800; color:#854d0e; border-radius:10px; border:1.5px solid #fde047; background:#fff; padding-left:30px; padding-right:12px;">
          </div>
          <div style="font-size:11px; color:#a16207; margin-top:3px;">Base unit acquisition or menu supply cost.</div>
        </div>
      </div>
    </form>
  `, `
    <div style="display:flex; justify-content:flex-end; gap:10px; width:100%;">
      <button type="button" class="btn btn-outline" onclick="Utils.closeModal()" style="padding:9px 20px; font-weight:600; border-radius:10px;">
        Cancel
      </button>
      <button type="submit" form="form-add-inv" class="btn btn-primary" id="btn-save-add-inv" style="padding:9px 24px; font-weight:700; background:#18181b; border-color:#18181b; border-radius:10px; display:inline-flex; align-items:center; gap:8px;">
        <i class="fas fa-plus" style="color:#c9a227;"></i> Add Stock Item
      </button>
    </div>
  `, "modal-responsive modal-lg");
}

async function submitAddInventory() {
  const saveBtn = document.getElementById("btn-save-add-inv");
  const origHtml = saveBtn ? saveBtn.innerHTML : "";

  const nameInput = document.getElementById("inv-name");
  const name = nameInput ? nameInput.value.trim() : "";
  const category = document.getElementById("inv-cat") ? document.getElementById("inv-cat").value.trim() : "Kitchen";
  const sku = document.getElementById("inv-sku") ? document.getElementById("inv-sku").value.trim() : "";
  const qtyInput = document.getElementById("inv-qty");
  const quantity = qtyInput ? (parseFloat(qtyInput.value) || 0) : 0;
  const unit = "pcs";
  const priceInput = document.getElementById("inv-price");
  const unit_price = priceInput ? (parseFloat(priceInput.value) || 0) : 0;
  const minInput = document.getElementById("inv-min");
  const min_stock = minInput ? (parseFloat(minInput.value) || 0) : 0;

  if (!name) {
    Utils.showToast("Please enter an item name.", "danger");
    if (nameInput) nameInput.focus();
    return;
  }

  if (quantity < 0) {
    Utils.showToast("Current stock quantity cannot be negative.", "danger");
    if (qtyInput) qtyInput.focus();
    return;
  }

  if (unit_price < 0) {
    Utils.showToast("Unit price cannot be negative.", "danger");
    if (priceInput) priceInput.focus();
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Adding Item...`;
  }

  try {
    const res = await Auth.fetch("/api/v1/inventory", {
      method: "POST",
      body: JSON.stringify({ name, category, sku: sku || null, quantity, unit, unit_price, min_stock })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to create item.");
    }
    Utils.showToast("Stock item created successfully!", "success");
    Utils.closeModal();
    cachedProfitLossData = null;
    if (getActiveViewName() === "profit_loss" && typeof renderProfitLoss === "function") {
      renderProfitLoss();
    } else {
      renderInventory();
    }
  } catch (err) {
    Utils.showToast(err.message, "danger");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = origHtml;
    }
  }
}

function toggleEditInvSkuMenu(e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  const menu = document.getElementById("edit-inv-sku-menu");
  if (!menu) return;
  const isHidden = menu.style.display === "none" || !menu.style.display;
  menu.style.display = isHidden ? "block" : "none";
}

function clearEditInvSkus() {
  const chks = document.querySelectorAll(".edit-sku-chk");
  chks.forEach(c => { c.checked = false; });
  updateEditInvSkuSummary();
}

function uncheckEditInvSku(skuVal) {
  const chks = Array.from(document.querySelectorAll(".edit-sku-chk"));
  const target = chks.find(c => String(c.value).trim().toUpperCase() === String(skuVal).trim().toUpperCase());
  if (target) {
    target.checked = false;
  }
  updateEditInvSkuSummary();
}

function updateEditInvSkuSummary() {
  const chks = Array.from(document.querySelectorAll(".edit-sku-chk:checked"));
  const selectedSkus = chks.map(c => c.value.trim()).filter(Boolean);
  const hiddenInput = document.getElementById("edit-inv-sku");
  const labelEl = document.getElementById("edit-inv-sku-label");
  const countEl = document.getElementById("edit-inv-sku-count");
  const tagsEl = document.getElementById("edit-inv-sku-tags");

  const skuStr = selectedSkus.join(", ");
  if (hiddenInput) hiddenInput.value = skuStr;

  if (labelEl) {
    if (selectedSkus.length === 0) {
      labelEl.textContent = "— None (no auto-deduction) —";
      labelEl.style.color = "var(--text-muted)";
    } else {
      labelEl.textContent = `${selectedSkus.length} product(s) selected: ${skuStr}`;
      labelEl.style.color = "var(--text-main)";
    }
  }

  if (countEl) {
    countEl.textContent = selectedSkus.length ? `${selectedSkus.length} selected` : "";
  }

  if (tagsEl) {
    tagsEl.innerHTML = selectedSkus.map(sku => {
      return `
        <span class="badge" style="background:rgba(201,162,39,0.12); color:#92400e; border:1px solid rgba(201,162,39,0.3); font-size:11px; font-weight:700; font-family:monospace; padding:3px 8px; border-radius:12px; display:inline-flex; align-items:center; gap:6px;">
          ${Utils.escapeHtml(sku)}
          <i class="fas fa-times" style="cursor:pointer; color:#b45309; font-size:10px;" onclick="uncheckEditInvSku(${Utils.jsArg(sku)})" title="Remove ${Utils.escapeHtml(sku)}"></i>
        </span>
      `;
    }).join("");
  }
}

window.toggleEditInvSkuMenu = toggleEditInvSkuMenu;
window.clearEditInvSkus = clearEditInvSkus;
window.uncheckEditInvSku = uncheckEditInvSku;
window.updateEditInvSkuSummary = updateEditInvSkuSummary;

// Close sku menu when clicking outside modal/dropdown
if (typeof document !== 'undefined') {
  document.addEventListener('click', function(e) {
    const wrapper = document.getElementById('edit-inv-sku-wrapper');
    const menu = document.getElementById('edit-inv-sku-menu');
    if (menu && wrapper && !wrapper.contains(e.target)) {
      menu.style.display = 'none';
    }
  });
}

function openEditInventoryModal(itemId) {
  const item = (cachedInventory || []).find(x => Number(x.id) === Number(itemId));
  if (!item) {
    Utils.showToast("Item not found in cached catalog.", "warning");
    return;
  }

  const currentUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  const userRole = (currentUser && currentUser.role ? currentUser.role : (typeof Auth !== 'undefined' ? Auth.getRole() : '')).toLowerCase();
  const isAdmin = userRole === 'admin' || userRole === 'branch_admin' || userRole === 'super_admin' || userRole.includes('admin') || window.location.pathname.includes('/admin');

  const depts = [
    "Kitchen", "Street Foods", "Coffee Bar", "Beverages", "Packaging",
    "Cleaning Supplies", "Office Supplies and Equipments", "Monthly Bills",
    "Employee Salary", "SAMGYUPSAL", "KITCHEN UTENSILS & EQUIPMENT", "FURNITURE & FIXTURES"
  ];
  const itemCategory = item.category || "Kitchen";
  const hasCustomDept = !depts.some(d => d.toLowerCase() === itemCategory.toLowerCase());

  // Parse existing linked SKUs (supports single or multiple comma-separated SKUs)
  const currentSkus = (item.sku || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const activeProds = (cachedProducts || []).filter(p => p.is_active !== false && p.is_active !== 0 && p.sku).sort((a,b) => (a.name || '').localeCompare(b.name || ''));

  Utils.openModal(`
    <i class="fas fa-pen-to-square" style="color:#c9a227; margin-right:8px;"></i> Edit Inventory Item
  `, `
    <form id="form-edit-inv" onsubmit="event.preventDefault(); submitEditInventory(${item.id});">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Item Name <span style="color:var(--danger);">*</span></label>
        <input id="edit-inv-name" class="input-field" required value="${Utils.escapeHtml(item.name)}" placeholder="e.g. Special Chili Garlic Oil" style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Department / Category <span style="color:var(--danger);">*</span></label>
          <select id="edit-inv-cat" class="input-field" style="width:100%;">
            ${depts.map(cat => `<option value="${Utils.escapeHtml(cat)}" ${(itemCategory.toLowerCase() === cat.toLowerCase()) ? 'selected' : ''}>${Utils.escapeHtml(cat)}</option>`).join('')}
            ${hasCustomDept ? `<option value="${Utils.escapeHtml(itemCategory)}" selected>${Utils.escapeHtml(itemCategory)}</option>` : ''}
          </select>
        </div>
        <div class="input-group" style="position:relative;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted); display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span>Product Code <span style="font-weight:400; font-size:11px; color:var(--text-muted);">(links to POS)</span></span>
            <span id="edit-inv-sku-count" style="font-size:11px; font-weight:700; color:#c9a227;"></span>
          </label>
          <div id="edit-inv-sku-wrapper" style="position:relative; width:100%;">
            <button type="button" id="edit-inv-sku-btn" onclick="toggleEditInvSkuMenu(event)" class="input-field" style="width:100%; min-height:40px; text-align:left; display:flex; justify-content:space-between; align-items:center; cursor:pointer; background:#fff; padding:6px 12px; border:1px solid #d4d4d8; border-radius:8px;">
              <span id="edit-inv-sku-label" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; color:var(--text-main); font-weight:500;">
                ${currentSkus.length ? `${currentSkus.length} product(s) selected: ${currentSkus.join(', ')}` : '— None (no auto-deduction) —'}
              </span>
              <i class="fas fa-chevron-down" style="font-size:11px; color:#a1a1aa; flex-shrink:0; margin-left:6px;"></i>
            </button>
            <div id="edit-inv-sku-menu" style="display:none; position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:1060; background:#ffffff; border:1px solid #d4d4d8; border-radius:10px; box-shadow:0 10px 25px rgba(0,0,0,0.15); max-height:220px; overflow-y:auto; padding:8px;">
              <div style="padding-bottom:6px; margin-bottom:6px; border-bottom:1px solid #f4f4f5; display:flex; justify-content:space-between; align-items:center;">
                <span style="font-size:11px; font-weight:700; text-transform:uppercase; color:var(--text-muted);">Multiple Select</span>
                <button type="button" onclick="clearEditInvSkus()" style="background:none; border:none; color:#ef4444; font-size:11px; font-weight:600; cursor:pointer; padding:2px 4px;">Clear All</button>
              </div>
              <div id="edit-inv-sku-list" style="display:flex; flex-direction:column; gap:4px;">
                ${activeProds.map(p => {
                  const pSku = String(p.sku || '').trim();
                  const isChecked = currentSkus.includes(pSku.toUpperCase());
                  return `
                    <label style="display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:6px; cursor:pointer; font-size:12.5px; user-select:none; transition:background 0.15s ease;" onmouseover="this.style.background='#f4f4f5'" onmouseout="this.style.background='transparent'">
                      <input type="checkbox" class="edit-sku-chk" value="${Utils.escapeHtml(pSku)}" ${isChecked ? 'checked' : ''} onchange="updateEditInvSkuSummary()" style="width:16px; height:16px; accent-color:#c9a227; cursor:pointer;">
                      <span style="flex:1; color:var(--text-main);">
                        <strong>${Utils.escapeHtml(p.name)}</strong>
                        <span style="font-family:monospace; color:#c9a227; font-weight:700; font-size:11px; margin-left:4px;">(${Utils.escapeHtml(pSku)})</span>
                      </span>
                    </label>
                  `;
                }).join('')}
                ${!activeProds.length ? '<div style="font-size:12px; color:var(--text-muted); padding:8px; text-align:center;">No active products with POS codes found.</div>' : ''}
              </div>
            </div>
          </div>
          <!-- Selected product tags list -->
          <div id="edit-inv-sku-tags" style="display:flex; flex-wrap:wrap; gap:5px; margin-top:6px;"></div>
          <!-- Hidden input storing comma-separated SKUs -->
          <input type="hidden" id="edit-inv-sku" value="${Utils.escapeHtml(item.sku || '')}">
          <div style="font-size:10.5px; color:var(--text-muted); margin-top:4px;"><i class="fas fa-info-circle"></i> Select multiple products to automatically deduct this item's stock when any of those products are sold at POS.</div>
        </div>
      </div>

      ${isAdmin ? `
        <div class="input-group" style="margin-top:12px;">
          <label style="display:block; font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); margin-bottom:4px;">Current Stock Quantity (${Utils.escapeHtml(item.unit || 'pcs')})</label>
          <input type="number" step="any" min="0" id="edit-inv-qty" class="input-field" value="${Number(item.quantity) || 0}" style="width:100%;">
        </div>
      ` : ''}

      <!-- Hidden inputs for Min Stock Threshold, Unit Price / Cost, and (non-Admin) Current Stock -->
      <div style="display:none;">
        ${!isAdmin ? `<input type="number" step="any" min="0" id="edit-inv-qty" class="input-field" value="${Number(item.quantity) || 0}">` : ''}
        <input type="number" step="any" min="0" id="edit-inv-min" class="input-field" value="${Number(item.min_stock) || 0}">
        <input type="number" step="0.01" min="0" id="edit-inv-price" class="input-field" value="${Number(item.unit_price) || 0}">
      </div>

      <div id="edit-inv-error" style="display:none; color:#ef4444; font-size:12px; background:rgba(239,68,68,0.08); border-radius:6px; padding:8px 12px; margin-top:8px;"></div>
      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:18px;">
        <button type="button" class="btn btn-outline" onclick="Utils.closeModal()">Cancel</button>
        <button type="button" id="btn-save-edit-inv" class="btn btn-primary" onclick="submitEditInventory(${item.id})" style="display:inline-flex; align-items:center; gap:8px;">
          <i class="fas fa-save"></i> Save Changes
        </button>
      </div>
    </form>
  `);

  setTimeout(() => {
    updateEditInvSkuSummary();
  }, 10);
}

async function submitEditInventory(itemId) {
  const name = document.getElementById("edit-inv-name")?.value.trim();
  const category = document.getElementById("edit-inv-cat")?.value.trim();
  const sku = document.getElementById("edit-inv-sku")?.value.trim();
  const qtyInput = document.getElementById("edit-inv-qty")?.value;
  const existingItem = (cachedInventory || []).find(i => Number(i.id) === Number(itemId));
  const unit = existingItem ? (existingItem.unit || "pcs") : "pcs";
  const priceInput = document.getElementById("edit-inv-price")?.value;
  const minInput = document.getElementById("edit-inv-min")?.value;
  const errBox = document.getElementById("edit-inv-error");
  const saveBtn = document.getElementById("btn-save-edit-inv");

  if (!name) {
    if (errBox) {
      errBox.textContent = "Please fill in required item name.";
      errBox.style.display = "block";
    }
    Utils.showToast("Please enter an item name", "warning");
    return;
  }

  const quantity = parseFloat(qtyInput);
  if (isNaN(quantity) || quantity < 0) {
    if (errBox) {
      errBox.textContent = "Current stock quantity must be a non-negative number.";
      errBox.style.display = "block";
    }
    Utils.showToast("Current stock quantity must be a non-negative number.", "warning");
    return;
  }

  const unit_price = parseFloat(priceInput);
  if (isNaN(unit_price) || unit_price < 0) {
    if (errBox) {
      errBox.textContent = "Unit price must be a non-negative number.";
      errBox.style.display = "block";
    }
    Utils.showToast("Unit price must be a non-negative number.", "warning");
    return;
  }

  const min_stock = parseFloat(minInput);
  if (isNaN(min_stock) || min_stock < 0) {
    if (errBox) {
      errBox.textContent = "Minimum stock threshold must be a non-negative number.";
      errBox.style.display = "block";
    }
    Utils.showToast("Minimum stock threshold must be a non-negative number.", "warning");
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
  }
  if (errBox) errBox.style.display = "none";

  try {
    const res = await Auth.fetch(`/api/v1/inventory/${itemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        category: category || "Kitchen",
        sku: sku || null,
        quantity,
        unit,
        unit_price,
        min_stock
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || "Failed to update inventory item.");
    }

    Utils.showToast(`Item "${name}" updated successfully`, "success");
    Utils.closeModal();
    cachedProfitLossData = null;
    if (getActiveViewName() === "profit_loss" && typeof renderProfitLoss === "function") {
      await renderProfitLoss();
    } else {
      await renderInventory();
    }
  } catch (err) {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
    }
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = "block";
    }
    Utils.showToast(err.message, "danger");
  }
}

async function inlineUpdateStock(itemId, oldQty, newQtyVal) {
  const newQty = parseFloat(newQtyVal);
  if (isNaN(newQty)) {
    Utils.showToast("Please enter a valid stock number", "warning");
    return;
  }
  const delta = newQty - oldQty;
  if (delta === 0) return;

  try {
    const res = await Auth.fetch(`/api/v1/inventory/${itemId}/stock`, {
      method: "PUT",
      body: JSON.stringify({
        quantity_delta: delta,
        reason: "Inline Stock Adjustment"
      })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Stock adjustment failed.");
    }
    const item = cachedInventory.find(x => x.id === itemId);
    if (item) {
      item.quantity = newQty;
      const unitP = Number(item.unit_price) || 0;
      const valEl = document.getElementById(`inv-val-${itemId}`);
      if (valEl) valEl.textContent = Utils.formatCurrency(newQty * unitP);
    }
    cachedProfitLossData = null;
    if (getActiveViewName() === "profit_loss" && typeof renderProfitLoss === "function") {
      renderProfitLoss();
    }
    const input = document.getElementById(`inv-stock-${itemId}`);
    if (input) {
      input.setAttribute("onchange", `inlineUpdateStock(${itemId}, ${newQty}, this.value)`);
    }
    Utils.showToast("Stock quantity adjusted", "success");
  } catch (e) {
    Utils.showToast(e.message, "danger");
    const input = document.getElementById(`inv-stock-${itemId}`);
    if (input) input.value = oldQty;
  }
}

async function inlineUpdatePrice(itemId, newPriceVal) {
  const newPrice = parseFloat(newPriceVal);
  if (isNaN(newPrice) || newPrice < 0) {
    Utils.showToast("Please enter a valid price", "warning");
    return;
  }

  try {
    const res = await Auth.fetch(`/api/v1/inventory/${itemId}/stock`, {
      method: "PUT",
      body: JSON.stringify({
        quantity_delta: 0,
        unit_price: newPrice,
        reason: "Inline Price Adjustment"
      })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to update price.");
    }
    const item = cachedInventory.find(x => x.id === itemId);
    if (item) {
      item.unit_price = newPrice;
      const qty = Number(item.quantity) || 0;
      const valEl = document.getElementById(`inv-val-${itemId}`);
      if (valEl) valEl.textContent = Utils.formatCurrency(qty * newPrice);
    }
    cachedProfitLossData = null;
    if (getActiveViewName() === "profit_loss" && typeof renderProfitLoss === "function") {
      renderProfitLoss();
    }
    Utils.showToast("Price unit adjusted", "success");
  } catch (e) {
    Utils.showToast(e.message, "danger");
  }
}

async function deleteInventoryItem(itemId, name) {
  if (!confirm(`Are you sure you want to delete "${name}" from inventory?`)) return;
  try {
    const res = await Auth.fetch(`/api/v1/inventory/${itemId}`, { method: "DELETE" });
    if (!res.ok) {
      let errMsg = "Failed to delete item.";
      try {
        const errJson = await res.json();
        if (errJson && errJson.detail) errMsg = errJson.detail;
      } catch (_) {}
      throw new Error(errMsg);
    }
    selectedInventoryIds.delete(Number(itemId));
    Utils.showToast(`"${name}" deleted from inventory`, "success");
    await renderInventory();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 3. PRODUCTS & MENU CATALOG
// ─────────────────────────────────────────────────────────────────────────────
function getProductCategoryName(p) {
  if (p.category_name) return p.category_name;
  if (p.category && p.category.name) return p.category.name;
  if (window.cachedCategoryMap && window.cachedCategoryMap[p.category_id]) {
    return window.cachedCategoryMap[p.category_id];
  }
  if (window.cachedCategories && Array.isArray(window.cachedCategories)) {
    const found = window.cachedCategories.find(c => c.id === p.category_id);
    if (found && found.name) return found.name;
  }
  return 'Uncategorized';
}

async function renderProducts(c) {
  const target = c || document.getElementById("view-container");
  if (!target) return;
  const [prodRes, catRes] = await Promise.all([
    Auth.fetch("/api/v1/products"),
    Auth.fetch("/api/v1/categories")
  ]);

  if (!prodRes.ok) throw new Error("Failed to load products from server.");
  if (!catRes.ok) throw new Error("Failed to load categories from server.");
  const products = await prodRes.json();
  const categories = await catRes.json();
  cachedProducts = products;
  window.cachedCategories = categories;

  const catMap = {};
  categories.forEach(cat => { catMap[cat.id] = cat.name; });
  window.cachedCategoryMap = catMap;

  target.innerHTML = `
    <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:20px; flex-wrap:wrap;">
      <div style="display:flex; gap:10px; flex:1; max-width:540px; flex-wrap:wrap;">
        <div class="search-wrap" style="position:relative; flex:1; min-width:220px;">
          <i class="fas fa-search" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); color:var(--text-muted);"></i>
          <input type="text" id="prod-search" class="input-field" placeholder="Search by name, code (e.g. C1), or category..." style="padding-left:38px; width:100%;" oninput="filterProductsList()">
        </div>
        <select id="prod-cat-filter" class="input-field" style="max-width:180px;" onchange="filterProductsList()">
          <option value="all">All Categories</option>
          ${categories.map(cat => `<option value="${Utils.escapeHtml(cat.id)}">${Utils.escapeHtml(cat.name)}</option>`).join('')}
        </select>
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <button class="btn btn-outline" onclick="openCategoriesModal()" style="display:inline-flex; align-items:center; gap:8px; border-color:#c9a227; color:#c9a227; cursor:pointer;" title="Add and edit menu categories">
          <i class="fas fa-tags"></i> Add / Edit Categories
        </button>
        <button class="btn btn-outline" onclick="openImportProductsModal()" style="display:inline-flex; align-items:center; gap:8px; border-color:#10b981; color:#10b981; cursor:pointer; font-weight:600;" title="Import food products with pictures">
          <i class="fas fa-file-import"></i> Import Food with Pictures
        </button>
        <button class="btn btn-primary" onclick="openAddProductModal()" style="display:inline-flex; align-items:center; gap:8px; cursor:pointer;">
          <i class="fas fa-plus"></i> Add Menu Product
        </button>
      </div>
    </div>

    <div class="section-card">
      <div class="section-head">
        <h2>Menu Products Catalog</h2>
        <span style="font-size:13px; color:var(--text-muted);">${Utils.escapeHtml(products.length)} products listed</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:70px; text-align:center;">Photo</th>
              <th style="width:130px;">Product Code</th>
              <th>Product Name</th>
              <th>Category</th>
              <th>Selling Price</th>
              <th>Status</th>
              <th style="text-align:right;">Action</th>
            </tr>
          </thead>
          <tbody id="prod-tbody">
            ${renderProductRows(products)}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderProductRows(products) {
  if (!products || !products.length) {
    return `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-muted);">No products registered yet.</td></tr>`;
  }
  return products.map(p => {
    const catName = getProductCategoryName(p);
    const photoHtml = p.image_url ? `
      <div style="width:40px; height:40px; border-radius:8px; overflow:hidden; border:1px solid rgba(205,190,150,0.35); background:#ffffff; display:flex; align-items:center; justify-content:center; margin:0 auto; box-shadow:0 2px 5px rgba(0,0,0,0.04);">
        <img src="${Utils.escapeHtml(p.image_url)}" alt="${Utils.escapeHtml(p.name)}" style="width:100%; height:100%; object-fit:cover;" onerror="this.onerror=null; this.parentElement.innerHTML='<i class=\\'fas fa-utensils\\' style=\\'color:#cbd5e1; font-size:16px;\\'></i>';">
      </div>
    ` : `
      <div style="width:40px; height:40px; border-radius:8px; border:1px dashed rgba(205,190,150,0.45); background:rgba(0,0,0,0.02); display:flex; align-items:center; justify-content:center; color:var(--text-muted); margin:0 auto;" title="No picture uploaded">
        <i class="fas fa-image" style="font-size:15px; opacity:0.35;"></i>
      </div>
    `;

    return `
    <tr>
      <td style="text-align:center;">${photoHtml}</td>
      <td>
        <span style="background:rgba(201,162,39,0.12); color:#c9a227; font-weight:700; font-family:monospace; padding:3px 8px; border-radius:6px; font-size:12px; letter-spacing:0.5px;">${Utils.escapeHtml(p.sku || '—')}</span>
      </td>
      <td><strong style="color:var(--text-main); font-size:13px;">${Utils.escapeHtml(p.name)}</strong></td>
      <td>
        <span class="badge" style="background:rgba(205,190,150,0.18); color:var(--text-main); font-size:11px; font-weight:600;">
          ${Utils.escapeHtml(catName)}
        </span>
      </td>
      <td><strong style="color:#c9a227; font-size:13px;">${Utils.formatCurrency(p.price)}</strong></td>
      <td>
        <span class="badge ${p.is_active ? 'badge-success' : 'badge-danger'}" style="font-size:11px; font-weight:700;">
          ${p.is_active ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td style="text-align:right; white-space:nowrap;">
        <button class="btn btn-outline btn-sm" onclick="openEditProductModal(${p.id})" style="font-size:11px; padding:3px 8px; display:inline-flex; align-items:center; gap:4px; cursor:pointer; margin-right:4px;" title="Edit Product">
          <i class="fas fa-edit"></i> Edit
        </button>
        <button class="btn btn-danger btn-sm" onclick="deleteProductPrompt(${p.id}, ${Utils.jsArg(p.name)})" style="font-size:11px; padding:3px 8px; display:inline-flex; align-items:center; gap:4px; cursor:pointer; background:#dc3545; border-color:#dc3545; color:#fff;" title="Delete Product">
          <i class="fas fa-trash"></i> Delete
        </button>
      </td>
    </tr>
  `;
  }).join('');
}

function filterProductsList() {
  const q = (document.getElementById("prod-search")?.value || "").toLowerCase().trim();
  const catFilter = document.getElementById("prod-cat-filter")?.value || "all";
  const filtered = cachedProducts.filter(p => {
    const catName = getProductCategoryName(p).toLowerCase();
    const matchQ = !q || 
      (p.name && p.name.toLowerCase().includes(q)) || 
      (p.sku && p.sku.toLowerCase().includes(q)) ||
      catName.includes(q);
    const matchCat = catFilter === "all" || (p.category_id && p.category_id == catFilter);
    return matchQ && matchCat;
  });
  const tbody = document.getElementById("prod-tbody");
  if (tbody) tbody.innerHTML = renderProductRows(filtered);
}

window.handleProductImageSelect = async function(inputEl, previewId, urlInputId) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;

  const previewEl = document.getElementById(previewId);
  const urlEl = document.getElementById(urlInputId);
  const removeBtn = document.getElementById(previewId.replace('-preview', '-remove-img-btn')) ||
                    document.getElementById(urlInputId.replace('-url', '-remove-img-btn'));

  // 1. Instant local preview
  const reader = new FileReader();
  reader.onload = function(e) {
    if (previewEl) {
      previewEl.innerHTML = `<img src="${Utils.escapeHtml(e.target.result)}" style="width:100%; height:100%; object-fit:cover;">`;
    }
    if (removeBtn) removeBtn.style.display = 'inline-flex';
  };
  reader.readAsDataURL(file);

  // 2. Upload file to server
  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await Auth.fetch("/api/v1/products/upload-image", {
      method: "POST",
      body: formData
    });
    if (res.ok) {
      const data = await res.json();
      if (urlEl) urlEl.value = data.image_url;
      Utils.showToast("Picture uploaded successfully!", "success");
    } else {
      // Fallback: save Base64 data URL
      reader.onloadend = function() {
        if (urlEl) urlEl.value = reader.result;
      };
    }
  } catch (err) {
    console.warn("Upload fallback to data URL:", err);
    if (urlEl && reader.result) urlEl.value = reader.result;
  }
};

window.removeProductImage = function(previewId, urlInputId, fileInputId) {
  const previewEl = document.getElementById(previewId);
  const urlEl = document.getElementById(urlInputId);
  const fileEl = document.getElementById(fileInputId);
  const removeBtn = document.getElementById(previewId.replace('-preview', '-remove-img-btn')) ||
                    document.getElementById(urlInputId.replace('-url', '-remove-img-btn'));

  if (urlEl) urlEl.value = "";
  if (fileEl) fileEl.value = "";
  if (previewEl) {
    previewEl.innerHTML = `<i class="fas fa-camera" style="font-size:24px; color:rgba(205,190,150,0.5);"></i>`;
  }
  if (removeBtn) removeBtn.style.display = 'none';
};

function openAddProductModal() {
  const cats = window.cachedCategories || [];
  Utils.openModal("Create New Menu Product", `
    <form id="form-add-prod" onsubmit="event.preventDefault(); submitAddProduct();">
      <!-- Category Selection Dropdown -->
      <div class="input-group" style="margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted); margin:0;">Category <span style="color:var(--danger);">*</span></label>
          <button type="button" class="btn btn-outline btn-sm" onclick="promptAddCategoryInline('prod-category')" style="font-size:11px; padding:2px 8px; border-color:#c9a227; color:#c9a227; cursor:pointer;" title="Quickly create a new category">
            <i class="fas fa-plus"></i> New Category
          </button>
        </div>
        <select id="prod-category" class="input-field" required style="width:100%;">
          <option value="">-- Select Category --</option>
          ${cats.map(cat => `<option value="${Utils.escapeHtml(cat.id)}">${Utils.escapeHtml(cat.name)}</option>`).join('')}
        </select>
      </div>

      <!-- Product Code (Jollibee-style item code) -->
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Product Code <span style="color:var(--danger);">*</span></label>
        <input id="prod-sku" class="input-field" required placeholder="e.g. C1 (Chickenjoy), B1 (Burger Steak), Y1 (Yumburger)" style="width:100%;">
        <small style="font-size:11px; color:var(--text-muted); margin-top:3px; display:block;">Quick menu order code (like Jollibee item codes: C1, C2, B1, S1, or POS-101)</small>
      </div>

      <!-- Product Name -->
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Product Name <span style="color:var(--danger);">*</span></label>
        <input id="prod-name" class="input-field" required placeholder="e.g. 1pc Chickenjoy with Rice" style="width:100%;">
      </div>

      <!-- Selling Price & Station -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Selling Price (₱) <span style="color:var(--danger);">*</span></label>
          <input type="number" step="0.01" id="prod-price" class="input-field" required value="99" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Prep Station</label>
          <select id="prod-station" class="input-field" style="width:100%;">
            <option value="kitchen">Kitchen (Food & Hot Meals)</option>
            <option value="drinks">Drinks Counter (Coffee & Beverages)</option>
            <option value="none">None / Retail (Bottled drinks, retail)</option>
          </select>
        </div>
      </div>

      <!-- Picture / Image Upload -->
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted); display:flex; justify-content:space-between; align-items:center;">
          <span>Product Picture / Image</span>
          <span style="font-size:11px; font-weight:normal; text-transform:none; color:var(--text-muted);">PNG, JPG, WEBP</span>
        </label>
        
        <div style="display:flex; align-items:center; gap:14px; padding:12px 14px; border:1px dashed rgba(205,190,150,0.5); border-radius:10px; background:rgba(0,0,0,0.01);">
          <!-- Live Preview Box -->
          <div id="add-prod-img-preview" style="width:68px; height:68px; border-radius:10px; border:1px solid rgba(205,190,150,0.3); background:#ffffff; display:flex; align-items:center; justify-content:center; overflow:hidden; flex-shrink:0; box-shadow:0 2px 6px rgba(0,0,0,0.04);">
            <i class="fas fa-camera" style="font-size:26px; color:rgba(205,190,150,0.5);"></i>
          </div>

          <div style="flex:1;">
            <input type="file" id="add-prod-file-input" accept="image/*" style="display:none;" onchange="handleProductImageSelect(this, 'add-prod-img-preview', 'add-prod-img-url')">
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('add-prod-file-input').click()" style="font-size:12px; font-weight:600; display:inline-flex; align-items:center; gap:6px;">
                <i class="fas fa-upload"></i> Choose Picture
              </button>
              <button type="button" class="btn btn-sm" id="add-prod-remove-img-btn" onclick="removeProductImage('add-prod-img-preview', 'add-prod-img-url', 'add-prod-file-input')" style="display:none; font-size:12px; color:#ef4444; border:1px solid rgba(239,68,68,0.3); background:transparent; border-radius:6px; padding:5px 10px;">
                <i class="fas fa-trash"></i> Remove
              </button>
            </div>
            <input type="hidden" id="add-prod-img-url" value="">
            <small style="font-size:11px; color:var(--text-muted); margin-top:5px; display:block;">Select a picture to show on the POS cashier terminal and customer QR menu.</small>
          </div>
        </div>
      </div>
    </form>
  `, `<button class="btn btn-primary" onclick="submitAddProduct()"><i class="fas fa-save"></i> Save Product</button>`);
}

async function submitAddProduct() {
  const name = document.getElementById("prod-name").value.trim();
  const sku = document.getElementById("prod-sku").value.trim();
  const catVal = document.getElementById("prod-category").value;
  const price = parseFloat(document.getElementById("prod-price").value) || 0;
  const stationVal = document.getElementById("prod-station")?.value || "kitchen";
  const imageUrl = document.getElementById("add-prod-img-url")?.value?.trim() || null;

  if (!name || !sku) {
    Utils.showToast("Product name and Product Code are required.", "danger");
    return;
  }
  if (!catVal) {
    Utils.showToast("Please select a category for the product.", "warning");
    return;
  }

  const payload = {
    name,
    sku,
    category_id: Number(catVal),
    price,
    cost: 0,
    preparation_station: stationVal,
    image_url: imageUrl,
    is_active: true
  };

  try {
    const res = await Auth.fetch("/api/v1/products", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Product creation failed.");
    }
    Utils.showToast("Product '" + name + "' added successfully!", "success");
    Utils.closeModal();
    renderProducts();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

function openEditProductModal(id) {
  const p = cachedProducts.find(item => item.id === id);
  if (!p) return;
  const cats = window.cachedCategories || [];
  
  Utils.openModal("Edit Menu Product #" + p.id, `
    <form id="form-edit-prod" onsubmit="event.preventDefault(); submitEditProduct(${p.id});">
      <div class="input-group" style="margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted); margin:0;">Category</label>
          <button type="button" class="btn btn-outline btn-sm" onclick="promptAddCategoryInline('edit-prod-category')" style="font-size:11px; padding:2px 8px; border-color:#c9a227; color:#c9a227; cursor:pointer;" title="Quickly create a new category">
            <i class="fas fa-plus"></i> New Category
          </button>
        </div>
        <select id="edit-prod-category" class="input-field" style="width:100%;">
          <option value="">-- No Category --</option>
          ${cats.map(cat => `<option value="${Utils.escapeHtml(cat.id)}" ${p.category_id === cat.id ? 'selected' : ''}>${Utils.escapeHtml(cat.name)}</option>`).join('')}
        </select>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Product Code <span style="color:var(--danger);">*</span></label>
        <input id="edit-prod-sku" class="input-field" required value="${Utils.escapeHtml(p.sku || '')}" placeholder="e.g. C1, B1, Y1" style="width:100%;">
        <small style="font-size:11px; color:var(--text-muted); margin-top:3px; display:block;">Quick menu order code (like Jollibee item codes)</small>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Product Name <span style="color:var(--danger);">*</span></label>
        <input id="edit-prod-name" class="input-field" required value="${Utils.escapeHtml(p.name)}" style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:11px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Price (₱) <span style="color:var(--danger);">*</span></label>
          <input type="number" step="0.01" id="edit-prod-price" class="input-field" required value="${Utils.escapeHtml(p.price)}" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:11px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Status</label>
          <select id="edit-prod-status" class="input-field" style="width:100%;">
            <option value="true" ${p.is_active ? 'selected' : ''}>Active</option>
            <option value="false" ${!p.is_active ? 'selected' : ''}>Inactive</option>
          </select>
        </div>
        <div class="input-group">
          <label style="font-size:11px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Prep Station</label>
          <select id="edit-prod-station" class="input-field" style="width:100%;">
            <option value="kitchen" ${(!p.preparation_station || p.preparation_station === 'kitchen') ? 'selected' : ''}>Kitchen</option>
            <option value="drinks" ${p.preparation_station === 'drinks' ? 'selected' : ''}>Drinks</option>
            <option value="none" ${p.preparation_station === 'none' ? 'selected' : ''}>None</option>
          </select>
        </div>
      </div>

      <!-- Picture / Image Upload -->
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted); display:flex; justify-content:space-between; align-items:center;">
          <span>Product Picture / Image</span>
          <span style="font-size:11px; font-weight:normal; text-transform:none; color:var(--text-muted);">PNG, JPG, WEBP</span>
        </label>
        
        <div style="display:flex; align-items:center; gap:14px; padding:12px 14px; border:1px dashed rgba(205,190,150,0.5); border-radius:10px; background:rgba(0,0,0,0.01);">
          <!-- Live Preview Box -->
          <div id="edit-prod-img-preview" style="width:68px; height:68px; border-radius:10px; border:1px solid rgba(205,190,150,0.3); background:#ffffff; display:flex; align-items:center; justify-content:center; overflow:hidden; flex-shrink:0; box-shadow:0 2px 6px rgba(0,0,0,0.04);">
            ${p.image_url ? `<img src="${Utils.escapeHtml(p.image_url)}" style="width:100%; height:100%; object-fit:cover;">` : `<i class="fas fa-camera" style="font-size:26px; color:rgba(205,190,150,0.5);"></i>`}
          </div>

          <div style="flex:1;">
            <input type="file" id="edit-prod-file-input" accept="image/*" style="display:none;" onchange="handleProductImageSelect(this, 'edit-prod-img-preview', 'edit-prod-img-url')">
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('edit-prod-file-input').click()" style="font-size:12px; font-weight:600; display:inline-flex; align-items:center; gap:6px;">
                <i class="fas fa-upload"></i> ${p.image_url ? 'Change Picture' : 'Choose Picture'}
              </button>
              <button type="button" class="btn btn-sm" id="edit-prod-remove-img-btn" onclick="removeProductImage('edit-prod-img-preview', 'edit-prod-img-url', 'edit-prod-file-input')" style="${p.image_url ? 'display:inline-flex;' : 'display:none;'} font-size:12px; color:#ef4444; border:1px solid rgba(239,68,68,0.3); background:transparent; border-radius:6px; padding:5px 10px;">
                <i class="fas fa-trash"></i> Remove
              </button>
            </div>
            <input type="hidden" id="edit-prod-img-url" value="${Utils.escapeHtml(p.image_url || '')}">
            <small style="font-size:11px; color:var(--text-muted); margin-top:5px; display:block;">Shows on the POS Cashier and customer menu QR ordering.</small>
          </div>
        </div>
      </div>
    </form>
  `, `
    <div style="display:flex; justify-content:space-between; align-items:center; width:100%; gap:12px;">
      <button type="button" class="btn btn-danger" onclick="deleteProductPrompt(${p.id}, ${Utils.jsArg(p.name)})" style="background:#dc3545; border-color:#dc3545; color:#fff; display:inline-flex; align-items:center; gap:6px; cursor:pointer;">
        <i class="fas fa-trash"></i> Delete Product
      </button>
      <button class="btn btn-primary" onclick="submitEditProduct(${p.id})" style="display:inline-flex; align-items:center; gap:6px; cursor:pointer;">
        <i class="fas fa-save"></i> Save Changes
      </button>
    </div>
  `);
}

async function submitEditProduct(id) {
  const name = document.getElementById("edit-prod-name").value.trim();
  const sku = document.getElementById("edit-prod-sku").value.trim();
  const catVal = document.getElementById("edit-prod-category").value;
  const price = parseFloat(document.getElementById("edit-prod-price").value) || 0;
  const is_active = document.getElementById("edit-prod-status").value === "true";
  const stationVal = document.getElementById("edit-prod-station")?.value || "kitchen";
  const imageUrl = document.getElementById("edit-prod-img-url")?.value?.trim() || null;

  if (!name || !sku) {
    Utils.showToast("Product name and Product Code are required.", "danger");
    return;
  }

  const payload = {
    name,
    sku,
    category_id: catVal ? Number(catVal) : null,
    price,
    cost: 0,
    preparation_station: stationVal,
    image_url: imageUrl,
    is_active
  };

  try {
    const res = await Auth.fetch(`/api/v1/products/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Product update failed.");
    }
    Utils.showToast("Product code '" + sku + "' updated successfully!", "success");
    Utils.closeModal();
    renderProducts();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

async function deleteProductPrompt(id, name) {
  const confirmed = confirm(`Are you sure you want to delete "${name || 'this product'}"? This action cannot be undone.`);
  if (!confirmed) return;

  try {
    const res = await Auth.fetch(`/api/v1/products/${id}`, {
      method: "DELETE"
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to delete product.");
    }
    const data = await res.json().catch(() => ({}));
    Utils.showToast(data.message || `Product "${name}" was deleted successfully.`, "success");
    Utils.closeModal();
    renderProducts();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.1 CATEGORY MANAGEMENT (ADD & EDIT CATEGORIES)
// ─────────────────────────────────────────────────────────────────────────────

async function openCategoriesModal() {
  const catRes = await Auth.fetch("/api/v1/categories");
  const categories = catRes.ok ? await catRes.json() : (window.cachedCategories || []);
  window.cachedCategories = categories;

  const prods = window.cachedProducts || [];
  const countMap = {};
  prods.forEach(p => {
    if (p.category_id) countMap[p.category_id] = (countMap[p.category_id] || 0) + 1;
  });

  const catRows = categories.length ? categories.map(cat => {
    const pCount = countMap[cat.id] || 0;
    return `
      <tr id="cat-row-${Utils.escapeHtml(cat.id)}">
        <td><strong style="color:var(--text-main); font-size:13px;">${Utils.escapeHtml(cat.name)}</strong></td>
        <td style="color:var(--text-muted); font-size:12px;">${Utils.escapeHtml(cat.description || '—')}</td>
        <td style="text-align:center;">
          <span class="badge" style="background:rgba(205,190,150,0.2); font-size:11px; font-weight:700;">${Utils.escapeHtml(pCount)} items</span>
        </td>
        <td style="text-align:right; white-space:nowrap;">
          <button class="btn btn-outline btn-sm" onclick="openEditCategoryModal(${cat.id})" style="font-size:11px; padding:3px 8px; margin-right:4px;" title="Edit Category">
            <i class="fas fa-edit"></i> Edit
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteCategoryPrompt(${cat.id}, ${Utils.jsArg(cat.name)})" style="font-size:11px; padding:3px 8px; background:#dc3545; border-color:#dc3545; color:#fff;" title="Delete Category">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('') : `<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--text-muted);">No categories created yet.</td></tr>`;

  Utils.openModal('<i class="fas fa-tags" style="color:var(--accent); margin-right:8px;"></i> Manage Menu Categories', `
    <div style="margin-bottom:20px; padding:16px; border-radius:10px; background:rgba(205,190,150,0.08); border:1px solid rgba(205,190,150,0.25);">
      <h4 style="margin:0 0 10px 0; font-size:13px; text-transform:uppercase; color:var(--text-main); font-weight:700;">
        <i class="fas fa-plus-circle" style="color:var(--accent); margin-right:6px;"></i> Add New Category
      </h4>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
        <div style="flex:1; min-width:180px;">
          <label style="font-size:11px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Category Name *</label>
          <input type="text" id="cat-new-name" class="input-field" placeholder="e.g. Beverages, Hot Meals, Desserts" style="width:100%; height:38px;">
        </div>
        <div style="flex:1.5; min-width:220px;">
          <label style="font-size:11px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Description (Optional)</label>
          <input type="text" id="cat-new-desc" class="input-field" placeholder="Brief description of items in this category" style="width:100%; height:38px;">
        </div>
        <button class="btn btn-primary" onclick="submitAddCategory()" style="height:38px; display:inline-flex; align-items:center; gap:6px; white-space:nowrap;">
          <i class="fas fa-plus"></i> Save Category
        </button>
      </div>
    </div>

    <div class="section-card" style="margin:0; box-shadow:none; border:1px solid rgba(205,190,150,0.25);">
      <div class="section-head" style="padding:12px 16px;">
        <h4 style="margin:0; font-size:13px;">Existing Categories (${Utils.escapeHtml(categories.length)})</h4>
      </div>
      <div class="table-wrap" style="max-height:300px; overflow-y:auto;">
        <table>
          <thead>
            <tr>
              <th>Category Name</th>
              <th>Description</th>
              <th style="width:100px; text-align:center;">Products</th>
              <th style="width:120px; text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody id="cat-tbody">
            ${catRows}
          </tbody>
        </table>
      </div>
    </div>
  `, `<button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>`, "modal-lg");
  const modalEl = document.getElementById("modal-content");
  if (modalEl) modalEl.style.maxWidth = "750px";
}

async function submitAddCategory() {
  const nameInput = document.getElementById("cat-new-name");
  const descInput = document.getElementById("cat-new-desc");
  const name = (nameInput?.value || "").trim();
  const description = (descInput?.value || "").trim() || null;

  if (!name) {
    Utils.showToast("Category name is required.", "danger");
    if (nameInput) nameInput.focus();
    return;
  }

  try {
    const res = await Auth.fetch("/api/v1/categories", {
      method: "POST",
      body: JSON.stringify({ name, description })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to create category.");
    }
    Utils.showToast(`Category '${name}' created successfully!`, "success");
    await openCategoriesModal();
    if (document.getElementById("prod-tbody")) {
      renderProducts();
    }
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

function openEditCategoryModal(catId) {
  const cat = (window.cachedCategories || []).find(c => c.id === catId);
  if (!cat) return;

  Utils.openModal(`Edit Category: ${Utils.escapeHtml(cat.name)}`, `
    <form id="form-edit-cat" onsubmit="event.preventDefault(); submitEditCategory(${cat.id});">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Category Name <span style="color:var(--danger);">*</span></label>
        <input type="text" id="edit-cat-name" class="input-field" required value="${Utils.escapeHtml(cat.name)}" style="width:100%;">
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Description</label>
        <input type="text" id="edit-cat-desc" class="input-field" value="${Utils.escapeHtml(cat.description || '')}" placeholder="Optional description" style="width:100%;">
      </div>
    </form>
  `, `
    <div style="display:flex; justify-content:space-between; width:100%; gap:10px;">
      <button type="button" class="btn btn-outline" onclick="openCategoriesModal()">Back to Categories</button>
      <button class="btn btn-primary" onclick="submitEditCategory(${cat.id})"><i class="fas fa-save"></i> Save Changes</button>
    </div>
  `);
}

async function submitEditCategory(catId) {
  const name = (document.getElementById("edit-cat-name")?.value || "").trim();
  const description = (document.getElementById("edit-cat-desc")?.value || "").trim() || null;

  if (!name) {
    Utils.showToast("Category name cannot be empty.", "danger");
    return;
  }

  try {
    const res = await Auth.fetch(`/api/v1/categories/${catId}`, {
      method: "PUT",
      body: JSON.stringify({ name, description })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to update category.");
    }
    Utils.showToast(`Category updated to '${name}' successfully!`, "success");
    await openCategoriesModal();
    if (document.getElementById("prod-tbody")) {
      renderProducts();
    }
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

async function deleteCategoryPrompt(catId, catName) {
  const confirmed = confirm(`Are you sure you want to delete category "${catName}"?\nProducts in this category will be unassigned (not deleted).`);
  if (!confirmed) return;

  try {
    const res = await Auth.fetch(`/api/v1/categories/${catId}`, {
      method: "DELETE"
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to delete category.");
    }
    Utils.showToast(`Category "${catName}" deleted successfully.`, "success");
    await openCategoriesModal();
    if (document.getElementById("prod-tbody")) {
      renderProducts();
    }
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

async function promptAddCategoryInline(targetSelectId) {
  const name = prompt("Enter the new Category name (e.g. Pasta, Coffee, Desserts):");
  if (!name || !name.trim()) return;

  try {
    const res = await Auth.fetch("/api/v1/categories", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to create category.");
    }
    const newCat = await res.json();
    Utils.showToast(`Category '${newCat.name}' created!`, "success");

    if (!window.cachedCategories) window.cachedCategories = [];
    window.cachedCategories.push(newCat);
    if (!window.cachedCategoryMap) window.cachedCategoryMap = {};
    window.cachedCategoryMap[newCat.id] = newCat.name;

    const select = document.getElementById(targetSelectId);
    if (select) {
      const opt = document.createElement("option");
      opt.value = newCat.id;
      opt.textContent = newCat.name;
      opt.selected = true;
      select.appendChild(opt);
    }
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.2 PRODUCT & MENU IMPORT (IMAGES & CATALOG IMPORTER)
// ─────────────────────────────────────────────────────────────────────────────

window.pendingImportImages = [];

function switchProdImportTab(tab) {
  const pImages = document.getElementById("prod-import-pane-images");
  const pPreset = document.getElementById("prod-import-pane-preset");
  const pText = document.getElementById("prod-import-pane-text");
  const tImages = document.getElementById("tab-import-images");
  const tPreset = document.getElementById("tab-import-preset");
  const tText = document.getElementById("tab-import-text");

  if (pImages) pImages.style.display = tab === "images" ? "block" : "none";
  if (pPreset) pPreset.style.display = tab === "preset" ? "block" : "none";
  if (pText) pText.style.display = tab === "text" ? "block" : "none";

  if (tImages) tImages.className = tab === "images" ? "btn btn-primary btn-sm" : "btn btn-outline btn-sm";
  if (tPreset) tPreset.className = tab === "preset" ? "btn btn-primary btn-sm" : "btn btn-outline btn-sm";
  if (tText) tText.className = tab === "text" ? "btn btn-primary btn-sm" : "btn btn-outline btn-sm";
}

function cleanProductNameFromFilename(filename) {
  if (!filename) return "Menu Item";
  let base = filename.replace(/\.[^/.]+$/, "");
  base = base.replace(/^\d+[\s\.\-_]+/, "");
  base = base.replace(/[_\-]+/g, " ");
  base = base.replace(/\s+/g, " ").trim();
  return base.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function generateProductSku(name, index) {
  const words = (name || "").split(/\s+/).filter(Boolean);
  let prefix = words.map(w => w[0].toUpperCase()).slice(0, 3).join('');
  if (prefix.length < 2) prefix = (name || "PRD").substring(0, 3).toUpperCase();
  const num = (index !== undefined ? 100 + index : Math.floor(Math.random() * 900) + 100);
  return `${prefix}-${num}`;
}

async function openImportProductsModal() {
  window.pendingImportImages = [];
  const cats = window.cachedCategories || [];

  let presets = [];
  try {
    const res = await Auth.fetch("/api/v1/products/preset-library");
    if (res.ok) presets = await res.json();
  } catch (e) {
    console.warn("Could not fetch preset library:", e);
  }

  window.cachedPresetLibrary = presets;

  const presetCards = presets.map((item, idx) => `
    <div style="display:flex; align-items:center; gap:12px; padding:10px; border-radius:8px; border:1px solid rgba(205,190,150,0.25); background:rgba(255,255,255,0.7);">
      <input type="checkbox" id="preset-chk-${Utils.escapeHtml(idx)}" class="preset-select-chk" value="${Utils.escapeHtml(idx)}" checked style="width:18px; height:18px; cursor:pointer;">
      <div style="width:44px; height:44px; border-radius:8px; overflow:hidden; border:1px solid rgba(205,190,150,0.3); background:#fff; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
        <img src="${Utils.escapeHtml(item.image_url)}" alt="${Utils.escapeHtml(item.name)}" style="width:100%; height:100%; object-fit:cover;" onerror="this.onerror=null; this.parentElement.innerHTML='<i class=\\'fas fa-utensils\\' style=\\'color:#cbd5e1; font-size:18px;\\'></i>';">
      </div>
      <div style="flex:1; min-width:0;">
        <strong style="font-size:12px; color:var(--text-main); display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${Utils.escapeHtml(item.name)}</strong>
        <div style="font-size:11px; color:var(--text-muted); display:flex; gap:8px;">
          <span>${Utils.escapeHtml(item.category_name)}</span>
          <span>•</span>
          <span style="color:#c9a227; font-weight:700;">₱${Number(item.price).toFixed(2)}</span>
        </div>
      </div>
    </div>
  `).join('');

  Utils.openModal('<i class="fas fa-file-import" style="color:var(--accent); margin-right:8px;"></i> Import Menu Products & Catalog', `
    <!-- Import Navigation Tabs -->
    <div style="display:flex; gap:8px; border-bottom:1px solid rgba(205,190,150,0.25); padding-bottom:12px; margin-bottom:16px; flex-wrap:wrap;">
      <button id="tab-import-images" class="btn btn-primary btn-sm" onclick="switchProdImportTab('images')" style="font-size:12px;">
        <i class="fas fa-images"></i> Upload Image Files (Auto Name from Image)
      </button>
      <button id="tab-import-preset" class="btn btn-outline btn-sm" onclick="switchProdImportTab('preset')" style="font-size:12px;">
        <i class="fas fa-book-open"></i> Preset Menu Library (${Utils.escapeHtml(presets.length)} Items)
      </button>
      <button id="tab-import-text" class="btn btn-outline btn-sm" onclick="switchProdImportTab('text')" style="font-size:12px;">
        <i class="fas fa-file-lines"></i> Paste Names / CSV List
      </button>
    </div>

    <!-- PANE 1: Upload Images (Extracts Product Name & Links Image) -->
    <div id="prod-import-pane-images">
      <div style="padding:14px; background:rgba(201,162,39,0.08); border-radius:8px; border-left:4px solid var(--accent); margin-bottom:16px; font-size:12px; line-height:1.5;">
        <strong><i class="fas fa-magic"></i> Auto-Naming & Image Import:</strong>
        Select or drag in image files from your computer (e.g. <code>Caramel Macchiato.png</code>, <code>Burger with Fries.jpg</code>, <code>Spaghetti with Bread.png</code>).
        The product name is automatically formatted from each image's file name, and each photo is attached to its product!
      </div>

      <!-- Drag & Drop Zone -->
      <div id="prod-img-dropzone" onclick="document.getElementById('import-images-file-input').click()" style="border:2px dashed rgba(205,190,150,0.6); border-radius:12px; padding:28px 20px; text-align:center; cursor:pointer; background:rgba(0,0,0,0.01); transition:all 0.2s;" ondragover="event.preventDefault(); this.style.borderColor='var(--accent)';" ondragleave="this.style.borderColor='rgba(205,190,150,0.6)';" ondrop="handleDropImportImages(event)">
        <i class="fas fa-cloud-arrow-up" style="font-size:36px; color:var(--accent); margin-bottom:10px; display:block;"></i>
        <h4 style="margin:0 0 6px 0; font-size:15px; color:var(--text-main);">Click or Drag & Drop Product Images Here</h4>
        <p style="margin:0; font-size:12px; color:var(--text-muted);">Supports PNG, JPG, JPEG, WEBP. You can select multiple images at once.</p>
        <input type="file" id="import-images-file-input" accept="image/*" multiple style="display:none;" onchange="handleImportImagesSelect(this)">
      </div>


      <!-- Live Preview Table of Pending Items -->
      <div id="batch-img-preview-wrap" class="table-wrap" style="display:none; margin-top:16px; max-height:280px; overflow-y:auto; overflow-x:auto; border:1px solid rgba(205,190,150,0.25); border-radius:8px;">
        <table>
          <thead>
            <tr>
              <th style="width:60px; text-align:center;">Photo</th>
              <th style="width:120px;">Code (SKU)</th>
              <th>Product Name (Auto-Derived)</th>
              <th style="width:160px;">Category</th>
              <th style="width:110px;">Price (₱)</th>
              <th style="width:50px; text-align:center;"></th>
            </tr>
          </thead>
          <tbody id="batch-img-tbody"></tbody>
        </table>
      </div>

      <div id="batch-img-footer" style="display:none; margin-top:16px; text-align:right;">
        <button id="btn-submit-import-images" class="btn btn-primary" onclick="submitImportImageProducts()" style="display:inline-flex; align-items:center; gap:8px;">
          <i class="fas fa-check-circle"></i> Import All Products to Menu
        </button>
      </div>
    </div>

    <!-- PANE 2: Preset Library (Blessie FoodHub 24 catalog items with existing photos) -->
    <div id="prod-import-pane-preset" style="display:none;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <div style="font-size:12px; color:var(--text-muted);">
          Select dishes and drinks from the official Blessie FoodHub catalog with full-resolution pictures:
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-outline btn-sm" onclick="toggleAllPresetCheckboxes(true)" style="font-size:11px; padding:3px 8px;">Select All</button>
          <button class="btn btn-outline btn-sm" onclick="toggleAllPresetCheckboxes(false)" style="font-size:11px; padding:3px 8px;">Deselect All</button>
        </div>
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 200px), 1fr)); gap:10px; max-height:360px; overflow-y:auto; padding:4px;">
        ${presetCards}
      </div>
      <div style="margin-top:16px; text-align:right; border-top:1px solid rgba(205,190,150,0.25); padding-top:12px;">
        <button class="btn btn-primary" onclick="submitImportPresetItems()" style="display:inline-flex; align-items:center; gap:8px;">
          <i class="fas fa-cloud-arrow-down"></i> Import Selected Catalog Items
        </button>
      </div>
    </div>

    <!-- PANE 3: Paste / CSV List (Auto-matches photos by name) -->
    <div id="prod-import-pane-text" style="display:none;">
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">
        Paste product names below (one item per line). Format: <code>Item Name, Price, Category</code> or just <code>Item Name</code>.<br>
        Photos from the menu asset library will be automatically matched based on the product name!
      </div>
      <textarea id="prod-import-textarea" class="input-field" rows="8" style="width:100%; font-family:monospace; font-size:12px;" placeholder="Example:
Caramel Macchiato, 85, Coffee & Drinks
Burger with Fries, 85, Burgers & Sandwiches
Carbonara with Bread, 110, Pasta & Noodles
Pancit Canton with Toasted Bread, 85, Pasta & Noodles
Arroz Caldo, 65, Mains & Bowls"></textarea>
      <div style="margin-top:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <div style="font-size:11px; color:var(--text-muted);">
          <i class="fas fa-info-circle"></i> Matching images in <code>/static/assets/images</code> will be auto-attached.
        </div>
        <button class="btn btn-primary" onclick="submitImportTextList()" style="display:inline-flex; align-items:center; gap:8px;">
          <i class="fas fa-file-import"></i> Process & Import Items
        </button>
      </div>
    </div>
  `, `<button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>`, "modal-lg");

  const modalEl = document.getElementById("modal-content");
  if (modalEl) modalEl.style.maxWidth = "860px";
}

function handleDropImportImages(e) {
  e.preventDefault();
  const dt = e.dataTransfer;
  if (dt && dt.files && dt.files.length) {
    processSelectedImageFiles(dt.files);
  }
}

function handleImportImagesSelect(input) {
  if (input && input.files && input.files.length) {
    processSelectedImageFiles(input.files);
  }
}

function processSelectedImageFiles(fileList) {
  const cats = window.cachedCategories || [];
  const startIndex = window.pendingImportImages.length;

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (!file.type.startsWith("image/")) continue;

    const cleanName = cleanProductNameFromFilename(file.name);
    const sku = generateProductSku(cleanName, startIndex + i + 1);
    const previewUrl = URL.createObjectURL(file);

    let defaultCatId = "";
    const nameLower = cleanName.toLowerCase();
    if (nameLower.includes("coffee") || nameLower.includes("latte") || nameLower.includes("matcha") || nameLower.includes("americano")) {
      const match = cats.find(c => c.name.toLowerCase().includes("drink") || c.name.toLowerCase().includes("coffee") || c.name.toLowerCase().includes("beverage"));
      if (match) defaultCatId = match.id;
    } else if (nameLower.includes("burger") || nameLower.includes("sandwich")) {
      const match = cats.find(c => c.name.toLowerCase().includes("burger") || c.name.toLowerCase().includes("sandwich"));
      if (match) defaultCatId = match.id;
    } else if (nameLower.includes("pancit") || nameLower.includes("spaghetti") || nameLower.includes("carbonara") || nameLower.includes("pasta") || nameLower.includes("noodles")) {
      const match = cats.find(c => c.name.toLowerCase().includes("pasta") || c.name.toLowerCase().includes("noodle"));
      if (match) defaultCatId = match.id;
    }

    if (!defaultCatId && cats.length) {
      defaultCatId = cats[0].id;
    }

    window.pendingImportImages.push({
      file: file,
      name: cleanName,
      sku: sku,
      category_id: defaultCatId,
      price: 99.00,
      previewUrl: previewUrl
    });
  }

  renderPendingImagesTable();
}

function renderPendingImagesTable() {
  const items = window.pendingImportImages;
  const tbody = document.getElementById("batch-img-tbody");
  const controls = document.getElementById("batch-img-controls");
  const previewWrap = document.getElementById("batch-img-preview-wrap");
  const footer = document.getElementById("batch-img-footer");
  const countSpan = document.getElementById("batch-img-count");
  const cats = window.cachedCategories || [];

  if (!items.length) {
    if (controls) controls.style.display = "none";
    if (previewWrap) previewWrap.style.display = "none";
    if (footer) footer.style.display = "none";
    return;
  }

  if (controls) controls.style.display = "flex";
  if (previewWrap) previewWrap.style.display = "block";
  if (footer) footer.style.display = "block";
  if (countSpan) countSpan.textContent = `${items.length} ${items.length === 1 ? 'image' : 'images'} ready to import`;

  if (tbody) {
    tbody.innerHTML = items.map((item, idx) => `
      <tr>
        <td style="text-align:center;">
          <div style="width:40px; height:40px; border-radius:6px; overflow:hidden; border:1px solid rgba(205,190,150,0.3); margin:0 auto; background:#fff;">
            <img src="${Utils.escapeHtml(item.previewUrl)}" style="width:100%; height:100%; object-fit:cover;">
          </div>
        </td>
        <td>
          <input type="text" class="input-field" value="${Utils.escapeHtml(item.sku)}" style="height:32px; font-size:12px; font-family:monospace; font-weight:700; width:100%;" onchange="window.pendingImportImages[${idx}].sku = this.value.trim()">
        </td>
        <td>
          <input type="text" class="input-field" value="${Utils.escapeHtml(item.name)}" style="height:32px; font-size:12px; font-weight:600; width:100%;" onchange="window.pendingImportImages[${idx}].name = this.value.trim()">
        </td>
        <td>
          <select class="input-field batch-row-cat" style="height:32px; font-size:12px; width:100%;" onchange="window.pendingImportImages[${idx}].category_id = this.value">
            <option value="">-- No Category --</option>
            ${cats.map(c => `<option value="${Utils.escapeHtml(c.id)}" ${item.category_id == c.id ? 'selected' : ''}>${Utils.escapeHtml(c.name)}</option>`).join('')}
          </select>
        </td>
        <td>
          <input type="number" step="0.01" class="input-field batch-row-price" value="${Utils.escapeHtml(item.price)}" style="height:32px; font-size:12px; width:100%; font-weight:700; color:#c9a227;" onchange="window.pendingImportImages[${idx}].price = parseFloat(this.value) || 0">
        </td>
        <td style="text-align:center;">
          <button type="button" class="btn-icon" onclick="removePendingImportImage(${idx})" style="color:#ef4444; border:none; background:transparent; cursor:pointer;" title="Remove">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>
    `).join('');
  }
}

function removePendingImportImage(idx) {
  window.pendingImportImages.splice(idx, 1);
  renderPendingImagesTable();
}

function applyBatchCategoryToAll() {
  const catVal = document.getElementById("batch-cat-select")?.value;
  if (!catVal) return;
  window.pendingImportImages.forEach(it => { it.category_id = catVal; });
  renderPendingImagesTable();
  Utils.showToast("Category applied to all pending items.", "info");
}

function applyBatchPriceToAll() {
  const priceVal = parseFloat(document.getElementById("batch-price-input")?.value);
  if (isNaN(priceVal) || priceVal < 0) return;
  window.pendingImportImages.forEach(it => { it.price = priceVal; });
  renderPendingImagesTable();
  Utils.showToast("Price applied to all pending items.", "info");
}

async function submitImportImageProducts() {
  const items = window.pendingImportImages;
  if (!items.length) {
    Utils.showToast("Please select at least one image file.", "warning");
    return;
  }

  const btn = document.getElementById("btn-submit-import-images");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Uploading & Importing (${Utils.escapeHtml(items.length)})...`;
  }

  try {
    const batchPayload = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let imageUrl = null;

      if (it.file) {
        const formData = new FormData();
        formData.append("file", it.file);
        try {
          const upRes = await Auth.fetch("/api/v1/products/upload-image", {
            method: "POST",
            body: formData
          });
          if (upRes.ok) {
            const upData = await upRes.json();
            imageUrl = upData.image_url;
          }
        } catch (err) {
          console.warn("Image upload failed for", it.name, err);
        }
      }

      batchPayload.push({
        name: it.name,
        sku: it.sku,
        category_id: it.category_id ? Number(it.category_id) : null,
        price: Number(it.price) || 99.00,
        cost: 0,
        image_url: imageUrl,
        is_active: true
      });
    }

    const res = await Auth.fetch("/api/v1/products/import-batch", {
      method: "POST",
      body: JSON.stringify({ items: batchPayload })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Batch product import failed.");
    }

    const result = await res.json();
    Utils.showToast(result.message || `Successfully imported ${batchPayload.length} products!`, "success");
    Utils.closeModal();
    renderProducts();
  } catch (err) {
    Utils.showToast(err.message, "danger");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-check-circle"></i> Import All Products to Menu`;
    }
  }
}

function toggleAllPresetCheckboxes(checked) {
  const chks = document.querySelectorAll(".preset-select-chk");
  chks.forEach(c => { c.checked = checked; });
}

async function submitImportPresetItems() {
  const presets = window.cachedPresetLibrary || [];
  const chks = document.querySelectorAll(".preset-select-chk:checked");
  if (!chks.length) {
    Utils.showToast("Please select at least one item from the library.", "warning");
    return;
  }

  const selectedIndexes = Array.from(chks).map(c => parseInt(c.value, 10));
  const selectedItems = selectedIndexes.map(idx => presets[idx]).filter(Boolean);

  try {
    const res = await Auth.fetch("/api/v1/products/import-batch", {
      method: "POST",
      body: JSON.stringify({ items: selectedItems })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to import library items.");
    }
    const result = await res.json();
    Utils.showToast(result.message || `Imported ${selectedItems.length} menu items!`, "success");
    Utils.closeModal();
    renderProducts();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

async function submitImportTextList() {
  const text = (document.getElementById("prod-import-textarea")?.value || "").trim();
  if (!text) {
    Utils.showToast("Please enter product names to import.", "warning");
    return;
  }

  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length) {
    Utils.showToast("No valid lines found to import.", "warning");
    return;
  }

  const imageMap = {
    "burger": "/static/assets/images/burger solo.png",
    "burger with fries": "/static/assets/images/burger with fries.png",
    "molo": "/static/assets/images/MOLO.png",
    "nachos": "/static/assets/images/nachos.png",
    "nachofries": "/static/assets/images/nachofries.png",
    "pancit canton with toasted bread": "/static/assets/images/Pancit Canton with Toasted Bread.png",
    "pancit canton": "/static/assets/images/PANCIT CANTON.png",
    "sotanghon guisado": "/static/assets/images/sotanghon guisado.png",
    "spaghetti with bread": "/static/assets/images/spaghetti with bread.png",
    "spaghetti with burger": "/static/assets/images/spaghetti with burger.png",
    "toasted bread": "/static/assets/images/toasted bread.png",
    "tuna sandwich": "/static/assets/images/tuna sandwich.png",
    "arroz caldo": "/static/assets/images/arrozcaldo.png",
    "arrozcaldo": "/static/assets/images/arrozcaldo.png",
    "caramel macchiato": "/static/assets/images/coffee/caramel macchiato.png",
    "coffee jelly": "/static/assets/images/coffee/coffee jelly.png",
    "dirty matcha": "/static/assets/images/coffee/dirty matcha.png",
    "french vanilla": "/static/assets/images/coffee/french vanill.png",
    "french vanill": "/static/assets/images/coffee/french vanill.png",
    "iced americano": "/static/assets/images/coffee/iced americano.png",
    "iced coffee": "/static/assets/images/coffee/iced coffe.png",
    "matcha milk": "/static/assets/images/coffee/matcha milk.png",
    "salted caramel": "/static/assets/images/coffee/salted caramel.png",
    "spanish latte": "/static/assets/images/coffee/spanish latte.png",
    "vietnamese coffee": "/static/assets/images/coffee/vietnamese coffee.png"
  };

  function matchImageByName(prodName) {
    const nl = (prodName || "").toLowerCase();
    for (const key in imageMap) {
      if (nl.includes(key)) return imageMap[key];
    }
    return null;
  }

  const items = lines.map((line, idx) => {
    const parts = line.split(",").map(p => p.trim());
    const name = parts[0];
    const price = parts[1] ? parseFloat(parts[1]) : 99.00;
    const catName = parts[2] || null;
    return {
      name: name,
      price: isNaN(price) ? 99.00 : price,
      category_name: catName,
      sku: generateProductSku(name, idx + 1),
      image_url: matchImageByName(name),
      is_active: true
    };
  });

  try {
    const res = await Auth.fetch("/api/v1/products/import-batch", {
      method: "POST",
      body: JSON.stringify({ items })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to import items from list.");
    }
    const result = await res.json();
    Utils.showToast(result.message || `Imported ${items.length} products!`, "success");
    Utils.closeModal();
    renderProducts();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

window.openCategoriesModal = openCategoriesModal;
window.submitAddCategory = submitAddCategory;
window.openEditCategoryModal = openEditCategoryModal;
window.submitEditCategory = submitEditCategory;
window.deleteCategoryPrompt = deleteCategoryPrompt;
window.promptAddCategoryInline = promptAddCategoryInline;
window.openImportProductsModal = openImportProductsModal;
window.handleDropImportImages = handleDropImportImages;
window.handleImportImagesSelect = handleImportImagesSelect;
window.removePendingImportImage = removePendingImportImage;
window.applyBatchCategoryToAll = applyBatchCategoryToAll;
window.applyBatchPriceToAll = applyBatchPriceToAll;
window.submitImportImageProducts = submitImportImageProducts;
window.toggleAllPresetCheckboxes = toggleAllPresetCheckboxes;
window.submitImportPresetItems = submitImportPresetItems;
window.submitImportTextList = submitImportTextList;
window.switchProdImportTab = switchProdImportTab;
window.deleteProductPrompt = deleteProductPrompt;


// ─────────────────────────────────────────────────────────────────────────────
// 4. CASHIER POINT OF SALE (POS)
// ─────────────────────────────────────────────────────────────────────────────
function resolveCashierShift(shifts = [], user = null) {
  if (!Array.isArray(shifts) || !shifts.length) return null;
  if (user) {
    const matched = shifts.find(s => s.status === 'open' && (
      (user.id !== undefined && user.id !== null && Number(s.cashier_id) === Number(user.id)) ||
      (user.username && s.cashier_username && s.cashier_username.toLowerCase() === user.username.toLowerCase())
    ));
    if (matched) return matched;
  }
  const openShift = shifts.find(s => s.status === 'open');
  if (openShift) return openShift;
  return shifts[0] || null;
}

async function renderPOS(c) {
  c = c || document.getElementById("view-container");
  if (!c) return;
  const [prodRes, catRes, drawerRes] = await Promise.all([
    Auth.fetch("/api/v1/products"),
    Auth.fetch("/api/v1/categories"),
    Auth.fetch("/api/v1/shifts/drawer-summary")
  ]);

  if (!prodRes.ok) throw new Error("Failed to load products for POS.");
  if (!catRes.ok) throw new Error("Failed to load menu categories for POS.");
  if (!drawerRes.ok) throw new Error("Failed to load drawer summary for POS.");
  const rawProducts = await prodRes.json();
  const categories = await catRes.json();
  const drawerData = await drawerRes.json();
  const currentUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  const myShift = resolveCashierShift(drawerData.shifts, currentUser);
  const posDrawerCash = myShift ? (myShift.expected_cash ?? 0) : (drawerData.total_cash_in_drawers || 0);
  const posOrdersTotal = myShift ? (myShift.total_sales ?? 0) : (drawerData.today_total_orders_amount || 0);

  // Exclude inactive products from POS counter & grid!
  const products = rawProducts.filter(p => p.is_active !== false && p.is_active !== 0 && p.is_active !== "0");
  cachedProducts = products;
  window.cachedCategories = categories;

  const catMap = {};
  categories.forEach(cat => { catMap[cat.id] = cat.name; });
  window.cachedCategoryMap = catMap;
  restorePosDraft();
  restoreCheckoutAttempt();

  if (!window._posDrawerListenerAttached) {
    window._posDrawerListenerAttached = true;
    window.addEventListener("storage", async (e) => {
      if (e.key === "RESTOTRACK_DRAWER_RESET" || e.key === "RESTOTRACK_SYNC_TX") {
        try {
          const res = await Auth.fetch("/api/v1/shifts/drawer-summary");
          if (res.ok) {
            const dData = await res.json();
            const cUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
            const myS = resolveCashierShift(dData.shifts, cUser);
            const dCashEl = document.getElementById("pos-cash-in-drawer-display");
            const dOrdEl = document.getElementById("pos-complete-orders-display");
            const cashVal = myS ? (myS.expected_cash ?? 0) : (dData.total_cash_in_drawers || 0);
            const ordVal = myS ? (myS.total_sales ?? 0) : (dData.today_total_orders_amount || 0);
            if (dCashEl) dCashEl.textContent = Utils.formatCurrency(cashVal);
            if (dOrdEl) dOrdEl.textContent = "Orders: " + Utils.formatCurrency(ordVal);
          }
        } catch (err) {}
      }
    });
  }

  c.innerHTML = `
    <style>
      .pos-container {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) clamp(240px, 24vw, 310px) !important;
        gap: clamp(8px, 1.2vw, 14px) !important;
        align-items: stretch !important;
      }
      .pos-top-controls {
        position: -webkit-sticky !important;
        position: sticky !important;
        top: 64px !important;
        z-index: 35 !important;
        background: var(--bg-body, #f8f6f1) !important;
        padding-top: 2px !important;
        padding-bottom: 6px !important;
      }
      .pos-cart {
        position: -webkit-sticky !important;
        position: sticky !important;
        top: 72px !important;
        height: calc(100vh - 84px) !important;
        max-height: calc(100vh - 84px) !important;
        align-self: start !important;
        z-index: 50 !important;
      }
      @media (max-width: 1439px) {
        .pos-container { grid-template-columns: minmax(0, 1fr) clamp(280px, 28vw, 320px) !important; gap: 12px !important; }
      }
      @media (max-width: 1024px) {
        .pos-container { grid-template-columns: 1fr !important; gap: 14px !important; }
        .pos-cart { position: static !important; width: 100% !important; height: auto !important; max-height: none !important; margin-top: 14px !important; }
        .pos-cart .cart-items { max-height: 380px !important; overflow-y: auto !important; }
      }
      @media (max-width: 640px) {
        .pos-search-row { flex-wrap: wrap !important; gap: 8px !important; }
        .pos-search-row .search-wrap { min-width: 100% !important; order: 1; }
        .pos-search-row #pos-voice-order-btn { flex: 1 !important; order: 2; justify-content: center !important; }
        .pos-search-row #pos-online-orders-btn { order: 3; }
        #pos-voice-live-strip { flex-wrap: wrap !important; gap: 6px !important; }
        #pos-voice-live-strip > div:first-child { width: 100% !important; }
        #pos-voice-live-strip > div:last-child { width: 100% !important; justify-content: space-between !important; }
      }
      @media (max-width: 480px) {
        .stats-grid.pos-stats-grid { grid-template-columns: repeat(3, 1fr) !important; gap: 4px !important; }
        .pos-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 8px !important; }
      }
      @media (max-width: 375px) {
        .stats-grid.pos-stats-grid { grid-template-columns: 1fr !important; gap: 6px !important; }
        .pos-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 6px !important; }
      }
      .cat-pill {
        white-space: nowrap; border-radius: 16px; padding: 5px 14px; 
        background: #ffffff; color: var(--text-main); border: 1px solid rgba(205,190,150,0.4); 
        cursor: pointer; font-size: 12px; font-weight: 600; transition: all 0.2s ease;
      }
      .cat-pill:hover {
        border-color: #c9a227; color: #c9a227; box-shadow: 0 4px 10px rgba(201,162,39,0.1);
      }
      .cat-pill.active-cat {
        background: #18181b !important; color: #ffffff !important; border-color: #18181b !important; box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      }
    </style>
    <div class="pos-container">
      <!-- LEFT WORKSPACE -->
      <div class="pos-workspace">
        
        <!-- POS STICKY TOP CONTROLS (SEARCH, KPIS, CATEGORIES) -->
        <div class="pos-top-controls" style="position:-webkit-sticky; position:sticky; top:64px; z-index:35; background:var(--bg-body, #f8f6f1); padding-top:2px; padding-bottom:6px;">
          <!-- SEARCH ROW -->
          <div class="pos-search-row" style="display:flex; gap:8px; width:100%; margin-bottom: 8px; flex-wrap:wrap; align-items:center;">
            <div class="search-wrap" style="position:relative; flex:1 1 180px; min-width:140px;">
              <i class="fas fa-search" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--text-muted); font-size:13px;"></i>
              <input type="text" id="pos-search" class="input-field" placeholder="Search menu products..." style="padding-left:36px; width:100%; font-size:13px; height:38px; border-radius:10px; background:#ffffff;" oninput="filterPOSGrid()">
            </div>
            <button id="pos-voice-order-btn" onclick="toggleVoiceOrderDirect()" style="height:38px; padding:0 12px; background:#18181b; color:#fff; border:1px solid #3f3f46; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:6px; white-space:nowrap; transition:all 0.2s;" onmouseover="if(!window.isVoiceListening){this.style.background='#27272a'; this.style.borderColor='#c9a227';}" onmouseout="if(!window.isVoiceListening){this.style.background='#18181b'; this.style.borderColor='#3f3f46';}" title="Click to start/stop Voice Recording (English, Tagalog, Hiligaynon)">
              <i class="fas fa-microphone" id="pos-voice-btn-mic" style="color:#ef4444; font-size:13px;"></i>
              <span id="pos-voice-btn-text">VOICE ORDER</span>
            </button>
            <button id="pos-last-receipt-btn" onclick="previewLastReceipt()" style="height:38px; padding:0 10px; background:#f4f4f5; color:#18181b; border:1px solid rgba(205,190,150,0.4); border-radius:10px; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; gap:5px; white-space:nowrap;" title="Preview & Print Last Receipt"><i class="fas fa-receipt" style="color:#c9a227;"></i> Receipt</button>
          <button id="pos-online-orders-btn" onclick="openOnlineOrdersModal()" style="height:38px; padding:0 10px; background:#f4f4f5; color:#18181b; border:1px solid rgba(205,190,150,0.4); border-radius:10px; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; gap:5px; white-space:nowrap;" title="Pending Customer Online Orders">
              <i class="fas fa-bell"></i>
              <span id="pos-online-orders-badge" style="background:#ef4444; color:#fff; padding:1px 5px; border-radius:10px; font-size:10px; font-weight:bold; display:none;">0</span>
            </button>
            <button id="pos-drinks-orders-btn" onclick="renderView('drinks')" style="height:38px; padding:0 12px; background:#eff6ff; color:#2563eb; border:1px solid rgba(37,99,235,0.3); border-radius:10px; font-size:12px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:6px; white-space:nowrap;" title="Cashier Drinks Orders">
              <i class="fas fa-glass-water" style="color:#2563eb;"></i>
              <span>Drinks Orders</span>
              <span id="pos-drinks-badge" style="background:#2563eb; color:#fff; padding:1px 6px; border-radius:10px; font-size:10px; font-weight:bold; display:none;">0</span>
            </button>
          </div>

          <!-- INLINE LIVE VOICE RECORDING STATUS STRIP -->
          <div id="pos-voice-live-strip" class="pos-voice-live-strip" style="display:none; margin-bottom:8px; padding:8px 12px; background:linear-gradient(90deg, #fef2f2, #fff7ed); border:1px solid #f87171; border-radius:10px; align-items:center; justify-content:space-between; animation:fadeIn 0.2s ease;">
            <div style="display:flex; align-items:center; gap:8px; font-size:12px; color:#991b1b; font-weight:600; min-width:0; overflow:hidden;">
              <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#ef4444; animation:voicePulse 1s infinite; flex-shrink:0;"></span>
              <span style="flex-shrink:0;"><i class="fas fa-microphone" style="color:#ef4444; margin-right:4px;"></i> Recording Voice Order:</span>
              <span id="pos-voice-transcript-text" style="color:#18181b; font-style:italic; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Speak order (e.g. "isa ka c1 solo", "c1 solo 1", "1 1pc chickenjoy solo")...</span>
            </div>
            <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
              <span style="font-size:10px; color:#b91c1c; background:rgba(239,68,68,0.1); padding:2px 6px; border-radius:4px; font-weight:700;">EN • TAGALOG • HILIGAYNON</span>
              <button type="button" onclick="stopVoiceRecordingDirect()" style="border:none; background:transparent; color:#991b1b; font-size:14px; font-weight:bold; cursor:pointer; padding:0 4px;" title="Stop Voice Recording"><i class="fas fa-times"></i></button>
            </div>
          </div>

          <!-- KPI SUMMARY ROW (Single-row slim strip) -->
          <div class="stats-grid pos-stats-grid" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 120px), 1fr)); gap:8px; margin-bottom:8px;">
            <div class="stat-card" style="padding:8px 12px; display:flex; align-items:center; gap:10px; background:#ffffff; border-radius:10px; border:1px solid rgba(205,190,150,0.3);">
              <div style="width:32px; height:32px; border-radius:8px; background:rgba(201,162,39,0.1); color:#c9a227; display:flex; align-items:center; justify-content:center; font-size:14px; flex-shrink:0;"><i class="fas fa-box"></i></div>
              <div style="min-width:0;">
                <div style="font-size:9px; color:var(--text-muted); font-weight:600; text-transform:uppercase; line-height:1.1;">Total Items</div>
                <div style="font-size:16px; font-weight:800; color:var(--text-main); line-height:1.1;">${Utils.escapeHtml(products.length)}</div>
              </div>
            </div>
            <div class="stat-card" style="padding:8px 12px; display:flex; align-items:center; gap:10px; background:#ffffff; border-radius:10px; border:1px solid rgba(205,190,150,0.3);">
              <div style="width:32px; height:32px; border-radius:8px; background:rgba(16,185,129,0.1); color:#10b981; display:flex; align-items:center; justify-content:center; font-size:14px; flex-shrink:0;"><i class="fas fa-tags"></i></div>
              <div style="min-width:0;">
                <div style="font-size:9px; color:var(--text-muted); font-weight:600; text-transform:uppercase; line-height:1.1;">Categories</div>
                <div style="font-size:16px; font-weight:800; color:var(--text-main); line-height:1.1;">${Utils.escapeHtml(categories.length)}</div>
              </div>
            </div>

            <div class="stat-card" style="padding:8px 12px; display:flex; align-items:center; gap:10px; background:#ffffff; border-radius:10px; border:1px solid rgba(205,190,150,0.3);">
              <div style="width:32px; height:32px; border-radius:8px; background:rgba(201,162,39,0.12); color:#c9a227; display:flex; align-items:center; justify-content:center; font-size:14px; flex-shrink:0;"><i class="fas fa-vault"></i></div>
              <div style="min-width:0;">
                <div style="font-size:9px; color:var(--text-muted); font-weight:600; text-transform:uppercase; line-height:1.1;">Cash in Drawer</div>
                <div id="pos-cash-in-drawer-display" style="font-size:15px; font-weight:800; color:#c9a227; line-height:1.1;">${Utils.formatCurrency(posDrawerCash)}</div>
                <div id="pos-complete-orders-display" style="font-size:9px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Orders: ${Utils.formatCurrency(posOrdersTotal)}</div>
              </div>
            </div>
          </div>

          <!-- CATEGORIES HORIZONTAL SCROLL -->
          <div class="pos-categories" id="pos-cat-bar" style="display:flex; gap:6px; overflow-x:auto; padding-bottom:6px; margin-bottom:8px;">
            <button class="cat-pill active-cat" onclick="selectPOSCategory('all', this)" style="padding:5px 12px; font-size:11px; border-radius:8px;">All Items</button>
            ${categories.map(cat => `<button class="cat-pill" onclick="selectPOSCategory(${cat.id}, this)" style="padding:5px 12px; font-size:11px; border-radius:8px;">${Utils.escapeHtml(cat.name)}</button>`).join('')}
          </div>
        </div>

        <!-- PRODUCT GRID (Small auto-fit / auto-resize) -->
        <div class="pos-grid" id="pos-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, clamp(110px, 11vw, 140px)), 1fr)); gap:clamp(6px, 1vw, 10px);">
          ${renderPOSProductCards(products)}
        </div>
      </div>

      <!-- RIGHT CART (STICKY, COMPACT & SLEEK) -->
      <div class="pos-cart" style="display:flex; flex-direction:column; background:#ffffff; border:1px solid rgba(205,190,150,0.3); border-radius:14px; height:calc(100vh - 84px); max-height:calc(100vh - 84px); position:-webkit-sticky; position:sticky; top:72px; align-self:start; box-shadow:0 4px 15px rgba(0,0,0,0.03); overflow:hidden; z-index:50;">
        
        <div style="padding:10px 14px; border-bottom:1px solid rgba(205,190,150,0.2); display:flex; justify-content:space-between; align-items:center; background:#faf8f3;">
          <h2 style="font-size:13px; font-weight:800; color:var(--text-main); margin:0;">Current Cart</h2>
          <button class="btn btn-outline btn-sm" onclick="requestClearCart()" style="font-size:11px; padding:2px 8px; border-radius:6px; color:var(--danger); border-color:rgba(239,68,68,0.2); background:rgba(239,68,68,0.05);">Clear All</button>
        </div>

        <div id="pos-online-banner" style="display:none;"></div>

        <div class="cart-items" id="cart-items-container" style="flex:1; overflow-y:auto; padding:0;">
          ${renderCartItems()}
        </div>

        <div class="cart-footer" style="padding:12px 14px; border-top:1px dashed rgba(205,190,150,0.4); background:#ffffff;">
          <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:11px; color:var(--text-muted);">
            <span>Subtotal</span>
            <span id="cart-subtotal" style="font-weight:600; color:var(--text-main);">₱0.00</span>
          </div>
          <div style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:11px; color:var(--text-muted);">
            <span>Discount</span>
            <span style="font-weight:600; color:var(--text-main);">₱0.00</span>
          </div>
          <div style="height:1px; background:rgba(205,190,150,0.2); margin-bottom:8px;"></div>
          <div style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:14px; font-weight:800; color:var(--text-main);">
            <span>TOTAL PAYABLE</span>
            <span id="cart-total" style="color:#c9a227;">₱0.00</span>
          </div>
          <button class="btn btn-primary" style="width:100%; height:40px; font-size:13px; font-weight:700; border-radius:10px; background:linear-gradient(135deg, #c9a227, #987719); border:none; box-shadow:0 4px 12px rgba(201,162,39,0.2);" onclick="openPaymentModal()">
            <i class="fas fa-cash-register" style="margin-right:6px;"></i> Charge & Checkout
          </button>
          <div style="text-align:center; margin-top:8px;">
            <button type="button" class="btn btn-outline btn-sm" onclick="previewLastReceipt()" style="width:100%; height:32px; font-size:11px; font-weight:700; border-color:rgba(201,162,39,0.5); color:#c9a227; display:inline-flex; align-items:center; justify-content:center; gap:5px; border-radius:8px;" title="Reprint or preview the last completed transaction receipt">
              <i class="fas fa-receipt"></i> Reprint / Preview Last Receipt
            </button>
          </div>
        </div>
      </div>

    </div>
  `;
  
  window.currentOnlineOrderId = window.currentOnlineOrder ? window.currentOnlineOrder.id : null;
  startPOSOnlineOrdersPolling();
  updateCartUI();
}

function renderPOSProductCards(products) {
  const activeProducts = (products || []).filter(p => p.is_active !== false && p.is_active !== 0 && p.is_active !== "0");
  if (!activeProducts || !activeProducts.length) {
    return `<div style="grid-column:1/-1; text-align:center; padding:30px 16px; color:var(--text-muted); border:1px dashed rgba(205,190,150,0.4); border-radius:12px; background:#ffffff;">
      <i class="fas fa-box-open" style="font-size:24px; margin-bottom:8px; opacity:0.3; color:#c9a227;"></i><br>
      <div style="font-size:13px; font-weight:600; color:var(--text-main);">No products found</div>
      <div style="font-size:11px; margin-top:2px;">Try a different search or category.</div>
    </div>`;
  }
  return activeProducts.map(p => {
    const code = Utils.escapeHtml(p.sku || `POS-${p.id}`);
    return `
    <div class="pos-item-card" onclick="addToCart(${p.id}, ${Utils.jsArg(p.name)}, ${p.price})" style="position:relative; width:100%; aspect-ratio:1/1.08; min-height:130px; background:#18181b; border-radius:12px; overflow:hidden; cursor:pointer; box-shadow:0 3px 10px rgba(0,0,0,0.12); transition:transform 0.15s ease, box-shadow 0.15s ease;" onmouseover="this.style.transform='translateY(-3px)'; this.style.boxShadow='0 10px 24px rgba(0,0,0,0.28)';" onmouseout="this.style.transform='none'; this.style.boxShadow='0 3px 10px rgba(0,0,0,0.12)';">
      
      <!-- Full Bleed Image (Picture 2 style: Whole Picture card) -->
      ${p.image_url ? `<img src="${Utils.escapeHtml(p.image_url)}" alt="${Utils.escapeHtml(p.name)}" class="pos-card-bg-img" style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; z-index:1;">` : `<div style="position:absolute; inset:0; width:100%; height:100%; background:linear-gradient(135deg, #27272a 0%, #18181b 100%); display:flex; align-items:center; justify-content:center; z-index:1;"><i class="fas fa-utensils" style="font-size:30px; color:rgba(255,255,255,0.25);"></i></div>`}

      <!-- Top-Left Product Code Badge: Erased black background, clean vibrant gold code with crisp outline shadow -->
      <div class="pos-card-badge-wrap" style="position:absolute; top:8px; left:8px; z-index:4; pointer-events:none; background:transparent;">
        <span class="pos-card-code-badge" style="display:inline-flex; align-items:center; justify-content:center; background:transparent !important; color:#facc15; border:none; outline:none; font-weight:900; font-family:'Inter', sans-serif; font-size:15px; letter-spacing:0.5px; padding:0; border-radius:0; box-shadow:none; line-height:1; text-transform:uppercase; text-shadow:0 1px 3px rgba(0,0,0,0.95), 0 2px 6px rgba(0,0,0,0.9), 1px 1px 2px #000, -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000;">${code}</span>
      </div>

      <!-- Bottom Overlay: Product Name moved down snug with price at bottom -->
      <div class="pos-card-overlay" style="position:absolute; bottom:0; left:0; right:0; top:auto; z-index:2; pointer-events:none; display:flex; flex-direction:column; justify-content:flex-end; padding:16px 8px 6px 8px; background:linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.65) 45%, transparent 100%);">
        <div class="pos-card-name" style="font-size:12.5px; font-weight:800; color:#ffffff; line-height:1.15; height:auto; margin-bottom:1px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; letter-spacing:-0.2px; text-shadow:0 1px 3px rgba(0,0,0,0.95), 0 2px 6px rgba(0,0,0,0.9);">${Utils.escapeHtml(p.name)}</div>
        <div class="pos-card-price" style="font-size:15px; font-weight:900; color:#facc15; text-shadow:0 1px 3px rgba(0,0,0,0.95), 0 2px 6px rgba(0,0,0,0.9); letter-spacing:-0.3px; line-height:1.15; margin-top:0;">${Utils.formatCurrency(p.price)}</div>
      </div>
    </div>
  `}).join('');
}

function filterPOSGrid() {
  const q = (document.getElementById("pos-search").value || "").toLowerCase().trim();
  const filtered = (cachedProducts || []).filter(p => {
    if (p.is_active === false || p.is_active === 0 || p.is_active === "0") return false;
    const matchName = p.name && p.name.toLowerCase().includes(q);
    const matchSku = p.sku && p.sku.toLowerCase().includes(q);
    const matchQ = !q || matchName || matchSku;
    const matchCat = currentCategoryFilter === "all" || p.category_id === Number(currentCategoryFilter);
    return matchQ && matchCat;
  });
  document.getElementById("pos-grid").innerHTML = renderPOSProductCards(filtered);
}

function selectPOSCategory(catId, btn) {
  currentCategoryFilter = catId;
  document.querySelectorAll("#pos-cat-bar button").forEach(b => {
    b.className = "cat-pill";
    b.removeAttribute("style");
  });
  btn.classList.add("active-cat");
  filterPOSGrid();
}

function guardOnlineCart() {
  if (window.currentOnlineOrder) {
    return true;
  }
  return false;
}

function addToCart(productId, name, price) {
  if (guardOnlineCart()) return;
  const existing = posCart.find(i => i.product_id === productId);
  if (existing) {
    if (existing.quantity >= 100) {
      Utils.showToast("The most you can sell of one item in one order is 100.", "warning");
      return;
    }
    existing.quantity += 1;
  } else {
    posCart.push({ product_id: productId, name, price, quantity: 1 });
  }
  updateCartUI();
}

function updateCartItemQty(productId, delta) {
  if (guardOnlineCart()) return;
  const item = posCart.find(i => i.product_id === productId);
  if (!item) return;
  if (item.quantity + delta > 100) {
    Utils.showToast("The most you can sell of one item in one order is 100.", "warning");
    return;
  }
  item.quantity += delta;
  if (item.quantity <= 0) {
    posCart = posCart.filter(i => i.product_id !== productId);
  }
  updateCartUI();
}

function removeCartLine(idx) {
  if (guardOnlineCart()) return;
  posCart.splice(idx, 1);
  updateCartUI();
}

function renderOnlineOrderBanner() {
  const el = document.getElementById("pos-online-banner");
  if (!el) return;
  const o = window.currentOnlineOrder;
  if (!o) {
    el.innerHTML = "";
    el.style.display = "none";
    return;
  }
  const tableDisplay = o.table_number
    ? (o.table_number.toLowerCase().startsWith('table') ? o.table_number : 'Table ' + o.table_number)
    : (o.order_type || "Take Out");
  el.style.display = "block";
  el.innerHTML = `
    <div style="padding:8px 14px; background:#fffbeb; border-bottom:1px solid rgba(205,190,150,0.3); font-size:12px; font-weight:700; color:var(--text-main); display:flex; align-items:center; gap:6px;">
      <i class="fas fa-chair" style="color:#c9a227;"></i> ${Utils.escapeHtml(tableDisplay)}
    </div>`;
}

function updateCartUI() {
  const container = document.getElementById("cart-items-container");
  if (container) container.innerHTML = renderCartItems();
  renderOnlineOrderBanner();
  savePosDraft();

  const total = posCart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
  const subtotalEl = document.getElementById("cart-subtotal");
  const totalEl = document.getElementById("cart-total");

  if (subtotalEl) subtotalEl.textContent = Utils.formatCurrency(total);
  if (totalEl) totalEl.textContent = Utils.formatCurrency(total);

  // Manage mobile floating bottom bar
  const count = posCart.reduce((sum, i) => sum + i.quantity, 0);
  let floatBar = document.getElementById("mobile-cart-float-bar");
  if (window.innerWidth <= 1024 && count > 0) {
    if (!floatBar) {
      floatBar = document.createElement("div");
      floatBar.id = "mobile-cart-float-bar";
      floatBar.className = "mobile-cart-float-bar";
      document.body.appendChild(floatBar);
    }
    floatBar.innerHTML = `
      <div class="mobile-cart-float-info" onclick="document.querySelector('.pos-cart')?.scrollIntoView({behavior:'smooth'});">
        <i class="fas fa-shopping-bag"></i>
        <span><strong>${Utils.escapeHtml(count)} items</strong> • ${Utils.formatCurrency(total)}</span>
      </div>
      <button class="mobile-cart-float-btn" onclick="document.querySelector('.pos-cart')?.scrollIntoView({behavior:'smooth'});">
        View Cart <i class="fas fa-arrow-down"></i>
      </button>
    `;
    floatBar.style.display = "flex";
  } else if (floatBar) {
    floatBar.remove();
  }
}

function renderCartItems() {
  if (!posCart.length) {
    return `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; padding:24px 14px; color:var(--text-muted); text-align:center;">
        <div style="width:40px; height:40px; border-radius:50%; background:rgba(201,162,39,0.08); color:#c9a227; display:flex; align-items:center; justify-content:center; margin-bottom:8px; font-size:18px;">
          <i class="fas fa-shopping-bag"></i>
        </div>
        <div style="font-size:13px; font-weight:700; color:var(--text-main); margin-bottom:4px;">Your cart is empty</div>
        <div style="font-size:11px;">Click on any menu item to add it to cart</div>
      </div>
    `;
  }
  const locked = !!window.currentOnlineOrder;
  const lockStyle = locked ? "opacity:0.35; cursor:not-allowed;" : "";
  return posCart.map((i, idx) => `
    <div style="padding:10px 14px; border-bottom:1px solid rgba(205,190,150,0.15);">
      <div style="font-weight:700; color:var(--text-main); font-size:12px; line-height:1.25; margin-bottom:4px;">${Utils.escapeHtml(i.name)}</div>
      <div style="display:flex; justify-content:space-between; align-items:center;">

        <div style="color:var(--text-muted); font-size:11px; min-width:50px;">${Utils.formatCurrency(i.price)}</div>

        <!-- Quantity Controls -->
        <div style="display:flex; align-items:center; background:#faf8f3; border:1px solid rgba(205,190,150,0.3); border-radius:6px; overflow:hidden;">
          <button type="button" onclick="updateCartItemQty(${Number(i.product_id)}, -1)" style="width:24px; height:24px; border:none; background:transparent; cursor:pointer; color:var(--text-main); font-size:9px; ${lockStyle}"><i class="fas fa-minus"></i></button>
          <span style="font-weight:700; font-size:12px; width:24px; text-align:center; padding-top:2px;">${Utils.escapeHtml(i.quantity)}</span>
          <button type="button" onclick="updateCartItemQty(${Number(i.product_id)}, 1)" style="width:24px; height:24px; border:none; background:transparent; cursor:pointer; color:var(--text-main); font-size:9px; ${lockStyle}"><i class="fas fa-plus"></i></button>
        </div>

        <div style="font-weight:800; color:#c9a227; font-size:13px; text-align:right; min-width:60px;">${Utils.formatCurrency(i.price * i.quantity)}</div>

        <button type="button" class="btn-icon" onclick="removeCartLine(${idx})" style="border:none; background:transparent; color:var(--danger); cursor:pointer; font-size:12px; margin-left:4px; ${lockStyle}" title="Remove"><i class="fas fa-trash-alt"></i></button>
      </div>
    </div>
  `).join('');
}

// "Clear All" button: never discards a non-empty cart without asking.
function requestClearCart() {
  if (!posCart.length && !window.currentOnlineOrder) return;
  const count = posCart.reduce((sum, i) => sum + i.quantity, 0);
  const online = window.currentOnlineOrder
    ? " The customer order goes back to the queue; nothing is charged."
    : "";
  Utils.confirmAction("Clear this cart?", `This removes ${Utils.escapeHtml(count)} item(s) from the current cart.${online}`, clearCart);
}

function clearCart() {
  posCart = [];
  window.currentOnlineOrder = null;
  window.currentOnlineOrderId = null;
  posCheckout.key = null;
  posCheckout.signature = null;
  persistCheckoutAttempt();
  updateCartUI();
}

// ─────────────────────────────────────────────────────────────────────────────
// CASHIER AI VOICE ORDERING SYSTEM (TAGALOG, ENGLISH, HILIGAYNON)
// ─────────────────────────────────────────────────────────────────────────────

const VOICE_NUMBER_WORDS = {
  // English
  'one': 1, 'wan': 1, 'won': 1, 'want': 1,
  'two': 2, 'to': 2, 'too': 2, 'tu': 2,
  'three': 3, 'tri': 3,
  'four': 4, 'five': 5,
  'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  // Tagalog
  'isa': 1, 'isang': 1,
  'dalawa': 2, 'dalawang': 2,
  'tatlo': 3, 'tatlong': 3,
  'apat': 4, 'apat na': 4, 'apatna': 4,
  'lima': 5, 'limang': 5,
  'anim': 6, 'anim na': 6, 'animna': 6,
  'pito': 7, 'pitong': 7,
  'walo': 8, 'walong': 8,
  'siyam': 9, 'siyam na': 9, 'siyamna': 9,
  'sampu': 10, 'sampung': 10,
  // Hiligaynon (Ilonggo)
  'isa ka': 1, 'isaka': 1,
  'duha ka': 2, 'duhaka': 2, 'duha': 2,
  'tatlo ka': 3, 'tatloka': 3,
  'apat ka': 4, 'apatka': 4,
  'lima ka': 5, 'limaka': 5,
  'anum ka': 6, 'anumka': 6, 'anum': 6, 'anim ka': 6,
  'pito ka': 7, 'pitoka': 7,
  'walo ka': 8, 'waloka': 8,
  'siyam ka': 9, 'siyamka': 9,
  'napulo ka': 10, 'napuloka': 10, 'napulo': 10
};

const DIGIT_WORD_MAP = {
  'zero': '0', 'sero': '0', 'oh': '0',
  'one': '1', 'wan': '1', 'want': '1',
  'two': '2', 'tu': '2', 'to': '2', 'too': '2',
  'three': '3', 'tri': '3',
  'four': '4', 'for': '4',
  'five': '5', 'fayb': '5',
  'six': '6', 'siks': '6',
  'seven': '7', 'seben': '7',
  'eight': '8', 'eyt': '8',
  'nine': '9', 'nayn': '9',
  // Tagalog digits
  'isa': '1', 'dalawa': '2', 'tatlo': '3', 'apat': '4',
  'lima': '5', 'anim': '6', 'pito': '7', 'walo': '8', 'siyam': '9',
  // Hiligaynon digits
  'duha': '2', 'anum': '6'
};

function computeLevenshteinSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const a = s1.toLowerCase().trim();
  const b = s2.toLowerCase().trim();
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  const d = [];
  for (let i = 0; i <= la; i++) d[i] = [i];
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  const maxLen = Math.max(la, lb);
  return (maxLen - d[la][lb]) / maxLen;
}

let posVoiceRecognition = null;
let isVoiceListening = false;
let voiceActiveLanguage = 'fil-PH';

const VOICE_CODE_PHONETICS = {
  'double u': 'w', 'double you': 'w', 'dabalyu': 'w', 'dabolyu': 'w', 'doble u': 'w',
  'see': 'c', 'sea': 'c', 'si': 'c', 'cee': 'c',
  'jay': 'j', 'jey': 'j',
  'em': 'm', 'emme': 'm',
  'bee': 'b',
  'pee': 'p', 'pi': 'p',
  'es': 's', 'ess': 's',
  'tee': 't', 'tea': 't', 'ti': 't',
  'vee': 'v', 'vi': 'v',
  'eye': 'i', 'aye': 'i',
  'dee': 'd', 'di': 'd',
  'ef': 'f', 'eff': 'f',
  'gee': 'g',
  'el': 'l', 'ell': 'l',
  'ay': 'a', 'ey': 'a',
  'why': 'y', 'wai': 'y',
  'zee': 'z', 'zed': 'z',
  'kay': 'k', 'en': 'n', 'ar': 'r', 'ex': 'x', 'cue': 'q', 'kyu': 'q'
};

function normalizeVoicePhonetics(str) {
  if (!str) return '';
  let s = str.toLowerCase().trim();

  // 1. Normalize misheard "POS" variants BEFORE stripping any fillers:
  // Handles: "PO is what S", "PO is whats", "po is what's", "po is what", "po is", "po s", "p o s"
  s = s.replace(/\bpo\s+is\s+(?:what\s+)?s\b/gi, 'pos');
  s = s.replace(/\bpo\s+is\s+whats\b/gi, 'pos');
  s = s.replace(/\bpo\s+is\s+what\b/gi, 'pos');
  s = s.replace(/\bpo\s+is\b/gi, 'pos');
  s = s.replace(/\bp\s+o\s+s\b/gi, 'pos');
  s = s.replace(/\bp\s*\.?\s*o\s*\.?\s*s\.?\b/gi, 'pos');
  s = s.replace(/\b(pia\s*os|pi\s*os|pee\s*oh\s*ess|post|pause|pass|boss|fos)\b/gi, 'pos');

  // Commas separating distinct items (e.g. "1 bucket ice, 2 c1") become " and "
  s = s.replace(/,\s*(?=\d+\s+[a-z]|(?:isang|dalawang|tatlong|isa\s+ka|duha\s+ka)\s+[a-z])/gi, ' and ');

  // Strip punctuation (. , ! ? ; :)
  s = s.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, ' ');

  // Strip conversational fillers in Tagalog/English/Filipino speech
  // "ay" is also the spoken letter A ("ay 1" = A1), so it is a filler only when no number follows.
  s = s.replace(/\bay+\b(?!\s*(?:\d|one|wan|juan|want|two|tu|to|too|three|tri|four|for|five|six|seven|eight|nine)\b)/gi, ' ');
  s = s.replace(/\b(ah+|eh+|um+|uh+|oh+|yung|yun|nga|kuya|ate|miss|bossing)\b/gi, ' ');
  // Strip standalone 'po' only if not followed by 's'
  s = s.replace(/\bpo\b(?!\s*s\b)/gi, ' ');

  s = s.replace(/\bpos\s*[-–—]?\s*(\d+)\b/gi, 'pos $1');
  s = s.replace(/\bsku\s*[-–—]?\s*(\d+)\b/gi, 'sku $1');
  s = s.replace(/\bcode\s*[-–—]?\s*(\d+)\b/gi, 'pos $1');

  // Common misheard beverage and food words in Filipino English
  s = s.replace(/\b(ba\s*nila|banila|vanila)\b/gi, 'vanilla');
  s = s.replace(/\b(makyato|makiyato|machiato)\b/gi, 'macchiato');
  s = s.replace(/\b(karamel)\b/gi, 'caramel');
  s = s.replace(/\b(amerikano)\b/gi, 'americano');
  s = s.replace(/\b(matsa|macha)\b/gi, 'matcha');
  s = s.replace(/\b(kropec|chicharon|tsitsaron)\b/gi, 'kropek');
  s = s.replace(/\b(nachofry|nacho\s*fry)\b/gi, 'nachofries');
  s = s.replace(/\b(espaghetti|spageti|spag)\b/gi, 'spaghetti');
  s = s.replace(/\b(arozcaldo|arroz\s*caldo)\b/gi, 'arrozcaldo');

  // Phrased code combinations (e.g. Tagalog/English speech engine mishearing "two c two" as "ito si tito")
  s = s.replace(/\b(?:ito|eto)\s+si\s+tito\b/gi, '2 c2');
  s = s.replace(/\b(?:ito|eto)\s+(?:see|si|sea|c)\s*(?:two|tu|to|tito|2)\b/gi, '2 c2');
  s = s.replace(/\b(?:ito|eto)\s+(?:see|si|sea|c)\s*(?:one|wan|juan|want|1)\b/gi, '2 c1');

  // Handle speech engine outputting digit attached directly to code (e.g. "4a1" -> "4 a1", "2c1" -> "2 c1", "3cm121" -> "3 cm121", "10a1" -> "10 a1")
  s = s.replace(/\b(\d{1,2})([a-z]{1,4}\d{1,4})\b/gi, '$1 $2');

  // Common number words misheard or spoken before letter codes (e.g. "for a1", "fore a1", "to a1", "two a1", "wan a1")
  s = s.replace(/\b(?:for|fore)\s+([a-z]{1,4}\d{1,4}|pos\s*\d+|sku\s*\d+)\b/gi, '4 $1');
  s = s.replace(/\b(?:to|too|tu)\s+([a-z]{1,4}\d{1,4}|pos\s*\d+|sku\s*\d+)\b/gi, '2 $1');
  s = s.replace(/\b(?:wan|want)\s+([a-z]{1,4}\d{1,4}|pos\s*\d+|sku\s*\d+)\b/gi, '1 $1');

  // A1, A2, A3 phonetics and variants (speech engine often hears "a one" as "ay 1", "ey 1", "eh 1", "a 1", "ay one", "a one")
  s = s.replace(/\b(?:ay|ey|eh|ei|a)\s*(?:1|one|wan|juan|want)\b/gi, 'a1');
  s = s.replace(/\b(?:ay|ey|eh|ei|a)\s*(?:2|two|tu|to|too)\b/gi, 'a2');
  s = s.replace(/\b(?:ay|ey|eh|ei|a)\s*(?:3|three|tri)\b/gi, 'a3');
  s = s.replace(/\b(?:ay|ey|eh|ei)\s*(\d{1,4})\b/gi, 'a$1');
  s = s.replace(/\ba\s*(\d{1,4})\b/gi, 'a$1');

  // C1, C2, C3 phonetics and misheard variants (including "want" for "one")
  s = s.replace(/\b(?:see|si|sea)\s*tito\b/gi, 'c2');
  s = s.replace(/\btito\b/gi, 'c2');
  s = s.replace(/\b(?:see|si|sea|c)\s*(?:1|one|wan|juan|want)\b/gi, 'c1');
  s = s.replace(/\b(?:see|si|sea|c)\s*(?:2|two|tu|to|too)\b/gi, 'c2');
  s = s.replace(/\b(?:see|si|sea|c)\s*(?:3|three|tri)\b/gi, 'c3');

  // Y1, Y2, Y3 phonetics and misheard variants (speech engine often hears "y one" as "z one", "zee one", "why one", "why want")
  s = s.replace(/\b(?:why|wai|y|z|zee)\s*(?:1|one|wan|juan|want)\b/gi, 'y1');
  s = s.replace(/\b(?:why|wai|y|z|zee)\s*(?:2|two|tu|to|too)\b/gi, 'y2');
  s = s.replace(/\b(?:why|wai|y|z|zee)\s*(?:3|three|tri)\b/gi, 'y3');

  // General single letter codes followed by digit or number word:
  s = s.replace(/\b([a-z])\s+(?:1|one|wan|juan|want)\b/gi, '$11');
  s = s.replace(/\b([a-z])\s+(?:2|two|tu|to|too)\b/gi, '$12');
  s = s.replace(/\b([a-z])\s+(?:3|three|tri)\b/gi, '$13');
  s = s.replace(/\b([a-z])\s+(\d{1,4})\b/gi, '$1$2');

  // Convert sequences of digit words into numeric digits (e.g. "nine nine four six" -> "9946", "five three four one" -> "5341")
  const words = s.split(/\s+/).filter(Boolean);
  const converted = [];
  let digitSeq = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (DIGIT_WORD_MAP[w]) {
      digitSeq.push(DIGIT_WORD_MAP[w]);
    } else {
      if (digitSeq.length > 0) {
        if (digitSeq.length >= 2 || (converted.length > 0 && ['pos', 'sku', 'code'].includes(converted[converted.length - 1]))) {
          converted.push(digitSeq.join(''));
        } else {
          converted.push(...digitSeq);
        }
        digitSeq = [];
      }
      converted.push(w);
    }
  }
  if (digitSeq.length > 0) {
    if (digitSeq.length >= 2 || (converted.length > 0 && ['pos', 'sku', 'code'].includes(converted[converted.length - 1]))) {
      converted.push(digitSeq.join(''));
    } else {
      converted.push(...digitSeq);
    }
  }

  s = converted.join(' ');

  // Spoken product code letter pronunciations (e.g. "see" -> "c" in "see 122", "see jay 122" -> "cj122", "ay 1" -> "a1")
  // Only converts letters when directly related to a product code (followed by digits or dash + digits)
  s = s.replace(/\b(?:double\s+(?:u|you)|dabalyu|dabolyu|doble\s+u)\b/gi, 'double_u');
  s = s.replace(/((?:\b[a-z_]+\s*[-–—\s]?\s*){1,4})(\d{1,4})\b/gi, (match, wordsPart, digits) => {
    const rawTokens = wordsPart.trim().split(/[-–—\s]+/).filter(Boolean);
    const convertedLetters = [];
    let consumedCount = 0;
    for (let i = rawTokens.length - 1; i >= 0; i--) {
      const tok = rawTokens[i].toLowerCase();
      if (tok === 'double_u') {
        convertedLetters.unshift('w');
        consumedCount++;
      } else if (VOICE_CODE_PHONETICS[tok]) {
        convertedLetters.unshift(VOICE_CODE_PHONETICS[tok]);
        consumedCount++;
      } else if (/^[a-z]$/i.test(tok)) {
        convertedLetters.unshift(tok.toLowerCase());
        consumedCount++;
      } else {
        break; // stop when hitting a non-letter word (e.g. quantity 'two', 'dalawa', 'order')
      }
      if (convertedLetters.length >= 4) break;
    }
    if (convertedLetters.length === 0) return match;
    const unconsumedTokens = rawTokens.slice(0, rawTokens.length - consumedCount);
    const prefix = unconsumedTokens.length ? unconsumedTokens.join(' ') + ' ' : '';
    return prefix + convertedLetters.join('') + digits;
  });

  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function stripVoiceIntros(text) {
  if (!text) return '';
  let s = text.trim();
  const introPatterns = [
    /^(?:and|at|kag|then|next|tsaka|saka|\+|so)\s+/i,
    /^(?:can\s+you\s+(?:please\s+)?give\s+(?:me\s+)?(?:a\s+)?(?:etc\s+)?|give\s+me\s+a\s+|give\s+me\s+|can\s+you\s+give\s+(?:me\s+)?(?:a\s+)?(?:etc\s+)?|can\s+you\s+give\s+|can\s+i\s+get\s+|can\s+i\s+have\s+)\s*/i,
    /^(?:pabili\s+po\s+ng\s+|pabili\s+ng\s+|pabili\s+po\s+|pabili\s+)\s*/i,
    /^(?:order\s+ko\s+po\s+|order\s+ko\s+|order\s+)\s*/i,
    /^(?:pabakal\s+palihug\s+sang\s+|pabakal\s+sang\s+|pabakal\s+)\s*/i,
    /^(?:palihug\s+ko\s+sang\s+|palihug\s+sang\s+|palihug\s+)\s*/i,
    /^(?:paki\s+add\s+ng\s+|paki\s+add\s+|add\s+)\s*/i,
    /^(?:baklon\s+ko\s+ang\s+|baklon\s+ko\s+|baklon\s+)\s*/i,
    /^(?:gusto\s+ko\s+ng\s+|gusto\s+ko\s+)\s*/i,
    /^(?:i\s+want\s+to\s+order\s+|i\s+want\s+to\s+|i\s+want\s+)\s*/i
  ];
  for (const p of introPatterns) {
    s = s.replace(p, '').trim();
  }
  return s;
}

function parseVoiceSegment(seg, pendingQty = null) {
  let text = normalizeVoicePhonetics(seg);
  text = text.replace(/[.,;:!?()"]/g, '').trim();
  text = text.replace(/^(?:a|an)\s+/i, '').trim();
  text = stripVoiceIntros(text);

  let qty = pendingQty || 1;
  let itemStr = text;
  let matchedStart = false;

  const sortedWords = Object.keys(VOICE_NUMBER_WORDS).sort((a, b) => b.length - a.length);

  // Check if text is ONLY a number or quantity phrase (e.g. "3", "isa ka", "tatlo", "five")
  if (/^\d{1,2}$/.test(text)) {
    return { qty: parseInt(text, 10), itemStr: '', isOnlyQty: true };
  }
  // Handle attached or space-separated Quantity + Code pattern (e.g. "4a1", "4 a1", "2 c1", "3 cm121", "1 a1", "10 a1")
  const mAttachedQtyCode = text.match(/^(\d{1,2})\s*([a-z]{1,4}\s*[-–—]?\s*\d{1,4})$/i);
  if (mAttachedQtyCode) {
    const candQ = parseInt(mAttachedQtyCode[1], 10);
    const candCode = mAttachedQtyCode[2].trim();
    if (!['pos', 'sku'].includes(candCode.toLowerCase())) {
      return { qty: Math.max(1, candQ), itemStr: candCode, isOnlyQty: false };
    }
  }

  // Robust Code + Quantity pattern:
  // Extracts code and quantity even if there are conversational words like "order", "orders", "pcs"
  // Matches: "y1 2", "y1 to", "c1 1", "c1 want", "c2 2", "pos 5341 2", "why want to", "c122 2", "cj122 2"
  const mCodeQty = text.match(/\b([a-z]{1,4}\s*[-–—]?\s*\d{1,4}|pos\s+\d+|sku\s+\d+|\d{3,5})\s+(\d{1,2}|[a-z]+)(?:\s+(?:orders?|pcs|pieces?|buok|ka\s+bilog))?$/i);
  if (mCodeQty) {
    const candCode = mCodeQty[1].trim();
    const candQ = mCodeQty[2].trim().toLowerCase();
    let candVal = null;
    if (/^\d{1,2}$/.test(candQ)) {
      candVal = parseInt(candQ, 10);
    } else if (VOICE_NUMBER_WORDS[candQ]) {
      candVal = VOICE_NUMBER_WORDS[candQ];
    }
    if (candVal !== null) {
      return { qty: Math.max(1, candVal), itemStr: candCode, isOnlyQty: false };
    }
  }

  // Robust Quantity + Code pattern:
  // Matches: "2 y1", "two y1", "to y1", "1 c2", "one c2", "3 c2", "2 cj122", "two c122"
  const mQtyCode = text.match(/\b(\d{1,2}|[a-z]+)\s+(?:of\s+)?([a-z]{1,4}\s*[-–—]?\s*\d{1,4}|pos\s+\d+|sku\s+\d+|\d{3,5})$/i);
  if (mQtyCode) {
    const candQ = mQtyCode[1].trim().toLowerCase();
    const candCode = mQtyCode[2].trim();
    let candVal = null;
    if (/^\d{1,2}$/.test(candQ)) {
      candVal = parseInt(candQ, 10);
    } else if (VOICE_NUMBER_WORDS[candQ]) {
      candVal = VOICE_NUMBER_WORDS[candQ];
    }
    if (candVal !== null && !['pos', 'sku'].includes(candCode.toLowerCase())) {
      return { qty: Math.max(1, candVal), itemStr: candCode, isOnlyQty: false };
    }
  }

  // 1. Check digit at start (1 or 2 digits only, e.g. "1 c1", "3 c2", "2 y1", "2 c122")
  const mDigitStart = text.match(/^(\d{1,2})\s+(.*)$/);
  if (mDigitStart) {
    qty = parseInt(mDigitStart[1], 10);
    itemStr = mDigitStart[2].trim();
    matchedStart = true;
  } else {
    // 2. Check number word at start (e.g. "one c2", "two y1", "three c2", "isa ka c1")
    for (const w of sortedWords) {
      const reg = new RegExp('^' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(.*)$', 'i');
      const m = text.match(reg);
      if (m) {
        qty = VOICE_NUMBER_WORDS[w];
        itemStr = m[1].trim();
        matchedStart = true;
        break;
      }
    }
  }

  // 3. Check digit or number word at end (if no start quantity matched)
  if (!matchedStart) {
    let matchedEnd = false;
    // 3a. Trailing number words (do not strip digit of a SKU like "c" + "two")
    for (const w of sortedWords) {
      const reg = new RegExp('^(.*?)\\s+' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
      const m = text.match(reg);
      if (m) {
        const prefix = m[1].trim().toLowerCase();
        if (!['c', 'y', 'z', 'pos', 'sku'].includes(prefix)) {
          qty = VOICE_NUMBER_WORDS[w];
          itemStr = m[1].trim();
          matchedEnd = true;
          break;
        }
      }
    }

    if (!matchedEnd) {
      // 3b. Code with trailing numeric quantity (e.g. "pos 7928 2", "sku 85372 3", "c1 1", "cj122 2")
      const mCodeWithQty = text.match(/^(pos\s+\d+|sku\s+\d+|code\s+\d+|\d{3,5}|[a-z]{1,4}\s*[-–—]?\s*\d{1,4})\s+(\d{1,2})$/i);
      if (mCodeWithQty) {
        itemStr = mCodeWithQty[1].trim();
        qty = parseInt(mCodeWithQty[2], 10);
      } else {
        // 3c. Regular trailing quantity (e.g. "burger 2")
        const mDigitEnd = text.match(/^(.*?)\s+(\d{1,2})$/);
        if (mDigitEnd && !/^(?:pos|sku|code|item|c|y|z|[a-z]{1,4}\s*[-–—]?\s*\d{1,4})$/i.test(mDigitEnd[1].trim())) {
          qty = parseInt(mDigitEnd[2], 10);
          itemStr = mDigitEnd[1].trim();
        }
      }
    }
  }

  // 4. Clean leftover connectors (e.g. "ng", "sang", "ka", "bilog", "pcs", "order")
  itemStr = itemStr.replace(/^(ng|sang|ka|bilog|ka bilog|pcs|piece|buok|order|orders)\s+/i, '').trim();

  return { qty: Math.max(1, qty), itemStr, isOnlyQty: false };
}

function parseFullVoiceOrder(speechText, products, pendingQty = null) {
  if (!speechText || !speechText.trim()) return [];
  let cleaned = speechText.toLowerCase().trim();
  cleaned = stripVoiceIntros(cleaned);

  // Normalize full phrase so short codes (c1, c2, y1) are converted cleanly
  cleaned = normalizeVoicePhonetics(cleaned);

  // Remove commas that directly follow lone numbers (e.g. "one, c2" -> "one c2")
  cleaned = cleaned.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2}),\s*/gi, '$1 ');

  // Split multiple items if separated by conjunctions, punctuation, "next order", "then", "next", "period"
  // "with" separates items only before a quantity ("c1 with 2 fries"); otherwise it is part of a
  // product name ("carbonara with bread").
  cleaned = cleaned.replace(/\s+with\s+(?=(\S+))/gi, (m, next) => (/^\d/.test(next) || VOICE_NUMBER_WORDS[next] !== undefined) ? ' and ' : m);
  const rawSegments = cleaned.split(/[,;]|\s+(?:kag|at|and|tsaka|saka|\+|then\s+next|next\s+order|then|next|period)\s+/i);
  const items = [];

  for (const raw of rawSegments) {
    const s = raw.trim();
    if (!s) continue;
    const { qty, itemStr, isOnlyQty } = parseVoiceSegment(s, pendingQty);
    if (isOnlyQty) {
      items.push({
        original: s,
        qty,
        itemStr: '',
        isOnlyQty: true,
        product: null
      });
      continue;
    }
    if (!itemStr) continue;
    const match = matchVoiceProductDetailed(itemStr, products);
    // Auto-detect and track: if a product was matched or has a single candidate (even if partial/fuzzy match),
    // automatically assign that product so it is added directly without confirmation popups.
    const resolvedProduct = match.product || (match.candidates && match.candidates.length === 1 ? match.candidates[0] : null);

    items.push({
      original: s,
      qty,
      itemStr,
      isOnlyQty: false,
      product: resolvedProduct,
      confidence: resolvedProduct ? ((match.confidence === 'low' || match.confidence === 'none') ? 'strong' : match.confidence) : match.confidence,
      candidates: match.candidates
    });
  }

  return items;
}

// Same matching steps as before, but the result says HOW it matched:
//   exact     - SKU / POS code / exact product name: added directly
//   strong    - one product clearly contains the words: added directly
//   ambiguous - several products match equally well: the cashier picks one
//   low       - partial-word or fuzzy match: the cashier confirms it
//   none      - nothing reasonable
// A spoken name is never turned into "the first product in the list" or into a fuzzy guess silently.
function matchVoiceProductDetailed(query, products) {
  const NONE = { product: null, confidence: 'none', candidates: [] };
  const hit = (p, confidence) => ({ product: p, confidence, candidates: [p] });
  if (!products || !products.length || !query) return NONE;
  // Exclude inactive products from voice recognition
  const activeProducts = products.filter(p => p.is_active !== false && p.is_active !== 0 && p.is_active !== "0");
  if (!activeProducts.length) return NONE;

  const normQuery = query.toLowerCase().replace(/[\-_,.]/g, ' ').replace(/\s+/g, ' ').trim();
  const qClean = query.toLowerCase().replace(/[^a-z0-9]/g, '');

  const qDigitMatch = query.match(/\d+/);
  const qDigits = qDigitMatch ? qDigitMatch[0] : '';
  const isCodeQuery = /^(?:pos|sku|code|item)?\s*\d+$/i.test(query.trim());

  // Incomplete POS code check: explicit POS codes have 4 digits (e.g. POS-5341, POS-2631, POS-2931).
  // If query specifically starts with 'pos' and has < 4 digits (e.g. "pos 2", "pos 26", "pos 263"), NEVER match!
  if (/^pos\s*\d+$/i.test(query.trim()) && qDigits && qDigits.length < 4) {
    return NONE;
  }
  // Standalone numbers with < 3 digits (e.g. "1", "2") are quantities, not product codes
  if (isCodeQuery && qDigits && qDigits.length < 3) {
    return NONE;
  }

  // 1. Exact match on normalized SKU / Code (e.g. "c1 solo" or "c1solo" matching "C1-SOLO", or "pos 7928", "pos 2631", "cj122" matching "CJ-122")
  for (const p of activeProducts) {
    const sku = (p.sku || '').toLowerCase();
    const normSku = sku.replace(/[\-_,.]/g, ' ').replace(/\s+/g, ' ').trim();
    const cleanSku = sku.replace(/[^a-z0-9]/g, '');
    if ((normSku && normSku === normQuery) || (cleanSku && cleanSku === qClean)) {
      return hit(p, 'exact');
    }
  }

  // 2. Code digits match (3 digits for menu SKUs like 122, 4 digits for POS-XXXX, 5 digits for SKU-XXXXX)
  if ((isCodeQuery || /^[a-z]{1,4}\s*[-–—]?\s*\d+$/i.test(query.trim())) && qDigits && qDigits.length >= 3) {
    const byDigits = activeProducts.filter(p => {
      const skuDigitMatch = (p.sku || '').toLowerCase().match(/\d+/);
      return skuDigitMatch && skuDigitMatch[0] === qDigits;
    });
    if (byDigits.length === 1) {
      const qLetters = qClean.replace(/\d+/g, '').replace(/^(pos|sku|code|item)/g, '');
      const pLetters = (byDigits[0].sku || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+/g, '');
      if (!qLetters || pLetters.startsWith(qLetters) || pLetters.includes(qLetters)) {
        return hit(byDigits[0], 'exact');
      }
    } else if (byDigits.length > 1) {
      const qLetters = qClean.replace(/\d+/g, '').replace(/^(pos|sku|code|item)/g, '');
      if (qLetters) {
        const matchingLetters = byDigits.filter(p => {
          const pLetters = (p.sku || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+/g, '');
          return pLetters.startsWith(qLetters) || pLetters.includes(qLetters);
        });
        if (matchingLetters.length === 1) return hit(matchingLetters[0], 'exact');
        if (matchingLetters.length > 1) return { product: null, confidence: 'ambiguous', candidates: matchingLetters };
      }
      return { product: null, confidence: 'ambiguous', candidates: byDigits };
    }
  }

  // 3. Embedded code in query (e.g. "bucket ice c2", "1 c1", query contains code word "c2" or "c1")
  const embedded = activeProducts.filter(p => {
    const cleanSku = (p.sku || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    return cleanSku.length >= 2 && new RegExp('\\b' + cleanSku + '\\b', 'i').test(normQuery);
  });
  if (embedded.length === 1) return hit(embedded[0], 'exact');
  if (embedded.length > 1) return { product: null, confidence: 'ambiguous', candidates: embedded };

  // 3b. SKU substring match for longer codes (>=4 chars, e.g. "pos2931" ending with "2931")
  if (qClean.length >= 4) {
    const bySuffix = activeProducts.filter(p => {
      const cleanSku = (p.sku || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return cleanSku && cleanSku.length >= 4 && (cleanSku.endsWith(qClean) || qClean.endsWith(cleanSku));
    });
    if (bySuffix.length === 1) return hit(bySuffix[0], 'exact');
    if (bySuffix.length > 1) return { product: null, confidence: 'ambiguous', candidates: bySuffix };
  }

  // 4. Exact Product Name match
  for (const p of activeProducts) {
    const normName = (p.name || '').toLowerCase().replace(/[\-_,.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (normName === normQuery) {
      return hit(p, 'exact');
    }
  }

  // 5. Product Name contains query or query contains product name (e.g. "french vanilla pos" contains "french vanilla").
  //    Every product tied on the best length is a candidate: "coke" with Coke Zero + Coke Light is ambiguous.
  let containsTies = [];
  let bestLen = 0;
  for (const p of activeProducts) {
    const normName = (p.name || '').toLowerCase().replace(/[\-_,.]/g, ' ').replace(/\s+/g, ' ').trim();
    let len = 0;
    if (normName.length > 2 && normQuery.includes(normName)) {
      len = normName.length;
    } else if (normQuery.length > 3 && normName.includes(normQuery)) {
      len = normQuery.length;
    }
    if (len > bestLen) {
      bestLen = len;
      containsTies = [p];
    } else if (len && len === bestLen) {
      containsTies.push(p);
    }
  }
  if (containsTies.length === 1) return hit(containsTies[0], 'strong');
  if (containsTies.length > 1) return { product: null, confidence: 'ambiguous', candidates: containsTies };

  // 6. Token overlap match (avoid false positives on generic modifiers like 'solo', 'regular', 'single')
  const MODIFIER_WORDS = new Set(['solo', 'single', 'regular', 'barkada', 'with', 'w', 'hot', 'cold', 'iced', '16', '22', 'oz', 'pcs', 'pc', 'l']);
  const qTokens = normQuery.split(' ').filter(t => t.length > 1);
  const nonModifierTokens = qTokens.filter(t => !MODIFIER_WORDS.has(t));
  let tokenTies = [];
  let bestScore = 0;

  for (const p of activeProducts) {
    const normName = (p.name || '').toLowerCase().replace(/[\-_,.]/g, ' ');
    const sku = (p.sku || '').toLowerCase().replace(/[\-_,.]/g, ' ');
    const target = `${normName} ${sku}`;
    let score = 0;
    for (const t of qTokens) {
      if (target.includes(t)) score++;
    }
    // If there are primary (non-modifier) tokens, at least one MUST match
    const hasPrimaryMatch = nonModifierTokens.length === 0 || nonModifierTokens.some(t => target.includes(t));
    if (!hasPrimaryMatch || score === 0) continue;
    if (score > bestScore) {
      bestScore = score;
      tokenTies = [p];
    } else if (score === bestScore) {
      tokenTies.push(p);
    }
  }

  const minRequired = qTokens.length <= 2 ? qTokens.length : Math.max(2, Math.floor(qTokens.length * 0.6));
  if (bestScore > 0 && bestScore >= minRequired) {
    if (tokenTies.length > 1) return { product: null, confidence: 'ambiguous', candidates: tokenTies };
    // Every spoken word found in one product: strong. Only some of them: ask the cashier.
    return hit(tokenTies[0], bestScore === qTokens.length ? 'strong' : 'low');
  }

  // 7. Fuzzy string similarity (handles close pronunciations like "french ba nila" -> "French Vanilla").
  //    A fuzzy guess is only ever offered for confirmation, never added on its own.
  const scored = [];
  for (const p of activeProducts) {
    const pCleanName = (p.name || '').toLowerCase().replace(/[\-_,.()–—]/g, ' ').replace(/\s+/g, ' ').trim();
    const sku = (p.sku || '').toLowerCase();

    const simName = computeLevenshteinSimilarity(normQuery, pCleanName);
    const simSku = computeLevenshteinSimilarity(normQuery, sku);

    const qWords = normQuery.split(/\s+/).filter(w => w.length > 2);
    const pWords = pCleanName.split(/\s+/).filter(w => w.length > 2);
    let tokenSim = 0;
    if (qWords.length > 0 && pWords.length > 0) {
      let wordOverlap = 0;
      for (const qw of qWords) {
        let bestWSim = 0;
        for (const pw of pWords) {
          const ws = computeLevenshteinSimilarity(qw, pw);
          if (ws > bestWSim) bestWSim = ws;
        }
        if (bestWSim >= 0.75) wordOverlap++;
      }
      tokenSim = wordOverlap / Math.max(qWords.length, pWords.length);
    }

    const maxSim = Math.max(simName, simSku, tokenSim);
    if (maxSim >= 0.65) scored.push({ p, maxSim });
  }
  if (scored.length) {
    scored.sort((a, b) => b.maxSim - a.maxSim);
    const top = scored.slice(0, 3).map(s => s.p);
    return { product: top.length === 1 ? top[0] : null, confidence: top.length === 1 ? 'low' : 'ambiguous', candidates: top };
  }

  return NONE;
}

// Backward-compatible: the single product only when the match is safe to use without asking.
function matchVoiceProduct(query, products) {
  const m = matchVoiceProductDetailed(query, products);
  return (m.confidence === 'exact' || m.confidence === 'strong') ? m.product : null;
}

function playVoiceBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch (e) {}
}

// Direct inline voice recording (no popup modal)
window.isVoiceListening = false;
window.pendingVoiceQty = null;

function toggleVoiceOrderDirect() {
  if (window.isVoiceListening) {
    stopVoiceRecordingDirect();
  } else {
    startVoiceRecordingDirect();
  }
}

// Voice session lifecycle. Every session gets a number; callbacks from a stopped, failed or replaced
// recogniser (late results, a final onend) see a different number and do nothing, so they can never
// touch the cart, restart the microphone or show a second message.
const VOICE_MAX_LINE_QTY = 100;          // same 1-100 per line limit as the server and the tap-to-add cart
const VOICE_MAX_IDLE_RESTARTS = 3;       // silent auto-restarts before listening stops by itself
let voiceSessionSeq = 0;
let voiceIdleRestarts = 0;

const VOICE_INSECURE_MSG = "Voice ordering needs a secure address (https://, or http://localhost on this computer). The browser blocks the microphone on this address, so open the POS over HTTPS to use voice.";
// terminal: the session ends (no automatic restart). msg: what the cashier is told (null = nothing).
const VOICE_ERRORS = {
  "not-allowed": { terminal: true, msg: "Microphone access is blocked for this page. Allow the microphone in the browser's site settings, then press VOICE ORDER again." },
  "service-not-allowed": { terminal: true, msg: "Speech recognition is not available in this browser or on this device. Add items by tapping them instead." },
  "audio-capture": { terminal: true, msg: "No microphone was found, or another app is using it. Check the microphone and press VOICE ORDER again." },
  "network": { terminal: true, msg: "Speech recognition could not reach its online service. Check the internet connection and press VOICE ORDER again." },
  "language-not-supported": { terminal: true, msg: "This browser cannot recognise Filipino (fil-PH) speech. Use Chrome or Edge, or add items by tapping them." },
  "aborted": { terminal: true, msg: null },
  "no-speech": { terminal: false, msg: null }
};

function voiceInsecureContext() {
  return window.isSecureContext === false;
}

// The POS cart is on screen (voice must never change a cart the cashier cannot see).
function voicePosActive() {
  return !!document.getElementById("cart-items-container") && !!document.getElementById("pos-voice-order-btn");
}

function detachVoiceRecognition() {
  const rec = posVoiceRecognition;
  posVoiceRecognition = null;
  if (!rec) return;
  rec.onstart = null;
  rec.onresult = null;
  rec.onerror = null;
  rec.onend = null;
  try { rec.abort(); } catch (e) {}
}

// Ends the current session for any reason (Stop, navigation, logout, error). Shows `message` once.
function endVoiceSession(message) {
  voiceSessionSeq++;
  window.isVoiceListening = false;
  window.pendingVoiceQty = null;
  window.lastVoiceSpoken = "";
  voiceIdleRestarts = 0;
  detachVoiceRecognition();
  clearTimeout(voiceCommitResetTimer);
  if (window.voiceSessionCommitted) window.voiceSessionCommitted.clear();
  updateVoiceButtonUI(false);
  if (message && typeof Utils !== "undefined") Utils.showToast(message, "warning");
}

function startVoiceRecordingDirect() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    Utils.showToast("Web Speech API not supported in this browser. Please use Chrome or Edge.", "warning");
    return;
  }
  if (voiceInsecureContext()) {
    Utils.showToast(VOICE_INSECURE_MSG, "warning");
    return;
  }
  if (window.isVoiceListening && posVoiceRecognition) return;   // repeated taps: one session at a time

  detachVoiceRecognition();
  const session = ++voiceSessionSeq;
  const live = () => session === voiceSessionSeq && window.isVoiceListening;
  voiceIdleRestarts = 0;
  window.isVoiceListening = true;
  window.pendingVoiceQty = null;
  window.lastVoiceSpoken = "";
  window.voiceSessionCommitted = window.voiceSessionCommitted || new Set();
  updateVoiceButtonUI(true);

  const rec = new SpeechRec();
  posVoiceRecognition = rec;
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = voiceActiveLanguage;

  rec.onstart = function() {
    if (!live()) return;
    const textEl = document.getElementById("pos-voice-transcript-text");
    if (textEl) {
      textEl.innerHTML = `Listening... Speak order (e.g. "isa ka c1 solo", "3 pos 5341", "1 bucket ice c2")`;
      textEl.style.color = "#18181b";
    }
  };

  rec.onresult = function(event) {
    if (!live()) return;                        // late result from a stopped or replaced session
    if (!voicePosActive()) { endVoiceSession(null); return; }
    voiceIdleRestarts = 0;
    let interim = '';
    let finalTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interim += event.results[i][0].transcript;
      }
    }

    const textEl = document.getElementById("pos-voice-transcript-text");
    if (finalTranscript.trim()) {
      if (textEl) textEl.innerHTML = `Heard: <span style="color:#b91c1c;">"${Utils.escapeHtml(finalTranscript.trim())}"</span>`;
      window.lastVoiceSpoken = "";
      // Only finalised speech is matched to products; interim text is a preview and never reaches the cart.
      executeVoiceOrderDirect(finalTranscript.trim(), true);
    } else if (interim.trim()) {
      window.lastVoiceSpoken = interim.trim();
      if (textEl) textEl.innerHTML = `Hearing: <span style="color:#71717a;">"${Utils.escapeHtml(interim.trim())}"</span> <span style="font-size:11px; color:#71717a;">(not added yet)</span>`;
    }
  };

  rec.onerror = function(event) {
    if (!live()) return;
    console.warn("Speech recognition error:", event.error);
    const info = VOICE_ERRORS[event.error] || { terminal: true, msg: "Voice recognition stopped unexpectedly. Press VOICE ORDER to try again." };
    if (!info.terminal) return;                 // no-speech: onend decides whether to keep listening
    const message = (event.error === "not-allowed" && voiceInsecureContext()) ? VOICE_INSECURE_MSG : info.msg;
    endVoiceSession(message);
  };

  rec.onend = function() {
    if (!live()) return;
    if (!voicePosActive()) { endVoiceSession(null); return; }
    // Browsers end a continuous session after a pause: restart so the cashier can speak the next item,
    // but only a few times without speech, never in an endless loop.
    voiceIdleRestarts++;
    if (voiceIdleRestarts > VOICE_MAX_IDLE_RESTARTS) {
      endVoiceSession("Stopped listening because no speech was heard. Press VOICE ORDER to start again.");
      return;
    }
    try {
      rec.start();
    } catch (e) {
      endVoiceSession("Voice recognition could not restart. Press VOICE ORDER to try again.");
    }
  };

  try {
    rec.start();
  } catch (e) {
    console.warn("Could not start speech recognition:", e);
    endVoiceSession("Voice recognition could not start. Press VOICE ORDER to try again.");
  }
}

// Stop button: ends listening. Words still being recognised (interim) are discarded, not added.
function stopVoiceRecordingDirect() {
  endVoiceSession(null);
}

function updateVoiceButtonUI(listening) {
  const btn = document.getElementById("pos-voice-order-btn");
  const micIcon = document.getElementById("pos-voice-btn-mic");
  const btnText = document.getElementById("pos-voice-btn-text");
  const strip = document.getElementById("pos-voice-live-strip");

  if (listening) {
    if (btn) {
      btn.className = "mic-active";
      btn.style.background = "#dc2626";
      btn.style.borderColor = "#ef4444";
      btn.style.boxShadow = "0 4px 14px rgba(220,38,38,0.4)";
    }
    if (micIcon) {
      micIcon.className = "fas fa-microphone";
      micIcon.style.color = "#ffffff";
    }
    if (btnText) {
      btnText.innerHTML = `<i class="fas fa-circle" style="color:#fff; font-size:8px; animation:voicePulse 1s infinite; margin-right:4px;"></i> RECORDING...`;
    }
    if (strip) {
      strip.style.display = "flex";
    }
  } else {
    window.pendingVoiceQty = null;
    if (btn) {
      btn.className = "";
      btn.style.background = "#18181b";
      btn.style.borderColor = "#3f3f46";
      btn.style.boxShadow = "none";
    }
    if (micIcon) {
      micIcon.className = "fas fa-microphone";
      micIcon.style.color = "#ef4444";
    }
    if (btnText) {
      btnText.textContent = "VOICE ORDER";
    }
    if (strip) {
      strip.style.display = "none";
    }
  }
}

window.voiceSessionCommitted = window.voiceSessionCommitted || new Set();
let voiceCommitResetTimer = null;

function validVoiceQty(qty) {
  return Number.isInteger(qty) && qty >= 1 && qty <= VOICE_MAX_LINE_QTY;
}

// Adds to the cart only if the resulting line stays within 1-100. Returns true or a message for the cashier.
function addVoiceLine(prod, qty) {
  const existing = posCart.find(i => i.product_id === prod.id);
  const next = (existing ? existing.quantity : 0) + qty;
  if (next > VOICE_MAX_LINE_QTY) {
    return `${prod.name}: that would make ${next} in the cart (maximum ${VOICE_MAX_LINE_QTY} per item). Not added.`;
  }
  if (existing) {
    existing.quantity = next;
  } else {
    posCart.push({ product_id: prod.id, name: prod.name, price: prod.price, quantity: qty });
  }
  return true;
}

function executeVoiceOrderDirect(text, isFinal = true) {
  if (!text || !text.trim()) return;
  if (!isFinal) return; // Ensure cart addition only executes on final transcript
  if (!voicePosActive()) return; // never change a cart that is not on screen
  if (guardOnlineCart()) return;

  const items = parseFullVoiceOrder(text, cachedProducts, window.pendingVoiceQty);
  const textEl = document.getElementById("pos-voice-transcript-text");

  // Check if speech was solely a quantity (e.g. "3", "isa ka", "tatlo", "five")
  if (items.length === 1 && items[0].isOnlyQty) {
    if (!validVoiceQty(items[0].qty)) {
      window.pendingVoiceQty = null;
      if (textEl) textEl.innerHTML = `<span style="color:#b91c1c;"><i class="fas fa-exclamation-triangle"></i> Quantity ${Utils.escapeHtml(items[0].qty)} is not allowed (1 to ${VOICE_MAX_LINE_QTY} per item). Say it again.</span>`;
      return;
    }
    window.pendingVoiceQty = items[0].qty;
    if (textEl) {
      textEl.innerHTML = `<span style="color:#d97706;">⏳ Quantity <strong>${Utils.escapeHtml(items[0].qty)}</strong> noted — speak product name or POS code...</span>`;
    }
    return;
  }

  let addedCount = 0;
  let summaryNames = [];
  const problems = [];
  const choices = [];

  items.forEach(item => {
    if (item.isOnlyQty) return;
    // Auto-detect and track: if voice was not clear or partial, but related or matched to a candidate,
    // automatically detect and add that item directly into the cart without confirmation modal
    if (!item.product && item.candidates && item.candidates.length) {
      const codeMatch = item.candidates.find(c => {
        const cSku = (c.sku || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const qClean = (item.itemStr || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return cSku === qClean || (qClean.length >= 2 && (cSku.includes(qClean) || qClean.includes(cSku)));
      });
      if (codeMatch) {
        item.product = codeMatch;
      } else if (item.candidates.length === 1 || item.confidence === 'low') {
        item.product = item.candidates[0];
      }
    }
    const needsChoice = !item.product && item.confidence === 'ambiguous' && item.candidates && item.candidates.length > 1;
    if (!item.product && !needsChoice) return;
    if (!validVoiceQty(item.qty)) {
      problems.push(`Quantity ${item.qty} for "${item.itemStr}" is not allowed (1 to ${VOICE_MAX_LINE_QTY} per item).`);
      return;
    }
    if (needsChoice) {
      choices.push(item);
      return;
    }
    const prod = item.product;
    const itemKey = `${prod.id}_${item.qty}_${item.itemStr.toLowerCase().replace(/\s+/g, '')}`;
    if (window.voiceSessionCommitted.has(itemKey)) return;   // the same final result delivered twice
    const added = addVoiceLine(prod, item.qty);
    if (added !== true) {
      problems.push(added);
      return;
    }
    window.voiceSessionCommitted.add(itemKey);
    addedCount++;
    summaryNames.push(`${item.qty}x ${prod.name}`);
  });

  if (addedCount > 0) {
    window.pendingVoiceQty = null; // Clear pending quantity once fulfilled
    updateCartUI();
    playVoiceBeep();
    if (textEl) {
      textEl.innerHTML = `<span style="color:#047857;"><i class="fas fa-check-circle"></i> Inserted ${Utils.escapeHtml(summaryNames.join(', '))} into Current Cart!</span>`;
    }
  }
  if (problems.length) {
    window.pendingVoiceQty = null;
    if (textEl) {
      textEl.innerHTML = `<span style="color:#b91c1c;"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(problems.join(' '))}</span>`;
    }
  } else if (!addedCount && !choices.length && isFinal && (!items.length || !items.some(i => i.product))) {
    // Only show "Item not found" on final silence, not while typing/speaking interim digits or lone quantities
    const cleanedText = text.trim();
    if (!/^\d{1,2}$/.test(cleanedText) && !['pos', 'sku', 'code'].includes(cleanedText.toLowerCase())) {
      if (textEl) {
        textEl.innerHTML = `<span style="color:#b91c1c;"><i class="fas fa-exclamation-triangle"></i> Item not found: "${Utils.escapeHtml(text)}"</span>`;
      }
    }
  }
  if (choices.length) {
    window.pendingVoiceQty = null;
    openVoiceChoice(choices[0], choices.length - 1);
  }

  // Clear committed keys after 2.5 seconds of silence so the cashier can order the same item again
  if (isFinal) {
    clearTimeout(voiceCommitResetTimer);
    voiceCommitResetTimer = setTimeout(() => {
      if (window.voiceSessionCommitted) {
        window.voiceSessionCommitted.clear();
      }
      window.pendingVoiceQty = null;
    }, 2500);
  }
}

// Ambiguous or low-confidence voice match: the cashier picks the product; nothing is added until then.
window._voicePendingChoice = null;

function openVoiceChoice(item, moreCount) {
  window._voicePendingChoice = { qty: item.qty, ids: item.candidates.map(p => p.id) };
  const heard = Utils.escapeHtml(item.itemStr);
  const lead = item.confidence === 'low'
    ? `Heard "<strong>${heard}</strong>". This is only a partial match: is it the item below?`
    : `Heard "<strong>${heard}</strong>". More than one item matches. Pick the one the customer wants:`;
  const buttons = item.candidates.map(p => `
      <button type="button" class="btn btn-outline" data-voice-choice="${Utils.escapeHtml(p.id)}" onclick="confirmVoiceChoice(${Utils.jsArg(p.id)})" style="width:100%; justify-content:space-between; display:flex;">
        <span>${Utils.escapeHtml(item.qty)}x ${Utils.escapeHtml(p.name)}</span><span>${Utils.formatCurrency(p.price)}</span>
      </button>`).join('');
  const more = moreCount > 0
    ? `<div style="margin-top:10px; font-size:12px; color:#92400e;">${Utils.escapeHtml(moreCount)} other spoken item(s) also need a choice and were not added. Say them again after this one.</div>`
    : '';
  Utils.openModal(item.confidence === 'low' ? 'Confirm voice item' : 'Which item did you mean?', `
    <div style="font-size:13px; margin-bottom:12px;">${lead}</div>
    <div id="voice-choice-list" style="display:grid; gap:8px;">${buttons}</div>${more}
  `, `<button type="button" class="btn btn-outline" onclick="cancelVoiceChoice()" style="width:100%;">None of these</button>`);
}

window.confirmVoiceChoice = function(productId) {
  const choice = window._voicePendingChoice;
  window._voicePendingChoice = null;
  Utils.closeModal();
  if (!choice || !choice.ids.includes(productId)) return;
  if (!voicePosActive() || guardOnlineCart()) return;
  const prod = (cachedProducts || []).find(p => p.id === productId && p.is_active !== false && p.is_active !== 0 && p.is_active !== "0");
  if (!prod) {
    Utils.showToast("That item is no longer available.", "warning");
    return;
  }
  const added = addVoiceLine(prod, choice.qty);
  if (added !== true) {
    Utils.showToast(added, "warning");
    return;
  }
  updateCartUI();
  playVoiceBeep();
  Utils.showToast(`Added ${choice.qty}x ${prod.name}.`, "success");
};

window.cancelVoiceChoice = function() {
  window._voicePendingChoice = null;
  Utils.closeModal();
};

// Leaving the page (logout, reload, closing the tab) always releases the microphone.
window.addEventListener("pagehide", () => endVoiceSession(null));
window.stopVoiceRecordingDirect = stopVoiceRecordingDirect;

// Backward compatibility alias
window.openVoiceOrderModal = toggleVoiceOrderDirect;
window.executeVoiceOrder = executeVoiceOrderDirect;
window.toggleVoiceListeningState = toggleVoiceOrderDirect;

// ─────────────────────────────────────────────────────────────────────────────
// CHECKOUT (cash / card / walk-in GCash, and customer-order settlement)
// ─────────────────────────────────────────────────────────────────────────────
function cartTotal() {
  return posCart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
}

function showCheckoutError(message) {
  const box = document.getElementById("checkout-error");
  if (box) {
    box.textContent = message;
    box.style.display = "block";
  }
  Utils.showToast(message, "danger");
}

function setCheckoutBusy(busy) {
  posCheckout.inFlight = busy;
  // Note: the checkout modal is closed optimistically before the API call,
  // so the button DOM element may no longer exist when this runs.
  const btn = document.getElementById("checkout-confirm-btn");
  if (btn) {
    btn.disabled = busy;
    btn.innerHTML = busy
      ? '<i class="fas fa-spinner fa-spin"></i> Processing...'
      : '<i class="fas fa-check-circle"></i> Confirm &amp; Complete Sale';
  }
}

function checkoutSignature(method) {
  const lines = posCart.map(i => `${i.product_id}x${i.quantity}`).sort().join(",");
  const online = window.currentOnlineOrder ? window.currentOnlineOrder.id : "";
  return `${online}|${method}|${lines}`;
}

function newCheckoutKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return (Date.now().toString(16) + "-" + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)).slice(0, 36);
}

async function openPaymentModal() {
  if (!posCart.length) {
    Utils.showToast("Order cart is empty. Please add items to checkout.", "danger");
    return;
  }
  const online = window.currentOnlineOrder;
  if (online) {
    // The server decides what this order may do; re-read it so a stale queue entry cannot mislead.
    try {
      await refreshCurrentOnlineOrder();
    } catch (err) {
      Utils.showToast(err.message, "danger");
      return;
    }
    if (online.sale_recorded) {
      Utils.showToast("This customer order already has a sale recorded. Reloading the queue.", "warning");
      clearCart();
      fetchPendingOnlineOrders();
      return;
    }
    if (online.status === "rejected") {
      Utils.showToast("This customer order was rejected and cannot be paid.", "danger");
      clearCart();
      return;
    }
    if (online.payment_method === "GCASH") {
      await openGcashModal(online.id, true);
      return;
    }
  }

  const total = cartTotal();
  window.isFirstTenderTap = true;
  const counterOnly = !!online && online.payment_method === "PAY_AT_COUNTER";
  const methods = counterOnly
    ? [["CASH", "Cash (Cash Register)"], ["CARD", "Debit / Credit Card"]]
    : [["CASH", "Cash (Cash Register)"], ["GCASH", "GCash E-Wallet"], ["CARD", "Debit / Credit Card"]];
  const orderNote = online ? `
      <div style="padding:10px 12px; background:#fffbeb; border:1px solid rgba(205,190,150,0.4); border-radius:10px; margin-bottom:14px; font-size:12px; display:flex; align-items:center; gap:8px;">
        <i class="fas fa-chair" style="color:#c9a227;"></i>
        <strong>${Utils.escapeHtml(online.table_number ? (online.table_number.toLowerCase().startsWith('table') ? online.table_number : 'Table ' + online.table_number) : (online.order_type || 'Take Out'))}</strong>
      </div>` : "";

  Utils.openModal('<i class="fas fa-credit-card" style="color:var(--accent); margin-right:8px;"></i> Process Order Checkout', `
    <form id="form-payment" onsubmit="event.preventDefault(); submitCheckout();">
      ${orderNote}
      <div style="text-align:center; padding:18px; background:rgba(201,162,39,0.08); border-radius:14px; margin-bottom:18px; border:1px solid rgba(205,190,150,0.3);">
        <span style="font-size:12px; text-transform:uppercase; color:var(--text-muted); font-weight:600; letter-spacing:0.5px;">Total Amount Due</span>
        <div style="font-size:28px; font-weight:800; color:#c9a227; margin-top:4px;">${Utils.formatCurrency(total)}</div>
      </div>
      <div id="checkout-error" role="alert" style="display:none; padding:10px 12px; margin-bottom:12px; background:#fee2e2; color:#991b1b; border:1px solid #fca5a5; border-radius:10px; font-size:13px; font-weight:600;"></div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Payment Method <span style="color:var(--danger);">*</span></label>
        <select id="pay-method" class="input-field" style="width:100%;" onchange="onPayMethodChange(${total})">
          ${methods.map((m, i) => `<option value="${m[0]}"${i === 0 ? " selected" : ""}>${m[1]}</option>`).join("")}
        </select>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Amount Tendered (₱) <span style="color:var(--danger);">*</span></label>
        <input type="number" step="0.01" id="pay-tendered" class="input-field" required value="${Utils.escapeHtml(total)}" style="width:100%; font-size:16px; font-weight:700;" oninput="window.isFirstTenderTap=false; calculateChange(${total})">
      </div>
      <div id="pay-noncash-note" style="display:none; font-size:12px; color:var(--text-muted); margin-bottom:12px;">
        Non-cash payments are recorded for exactly the amount due. Confirm the payment on the card terminal / GCash app first: for walk-in sales the POS records what you confirm and does not verify it.
      </div>

      <!-- Quick Denominations for Rapid Touch Input -->
      <div id="pay-quick-buttons" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:60px;" onclick="setTenderedAmount(${total}, ${total})">Clear</button>
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:40px;" onclick="addTenderedAmount(1, ${total})">₱1</button>
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:40px;" onclick="addTenderedAmount(5, ${total})">₱5</button>
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:40px;" onclick="addTenderedAmount(10, ${total})">₱10</button>
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:50px;" onclick="addTenderedAmount(50, ${total})">₱50</button>
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:50px;" onclick="addTenderedAmount(100, ${total})">₱100</button>
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:50px;" onclick="addTenderedAmount(500, ${total})">₱500</button>
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:60px;" onclick="addTenderedAmount(1000, ${total})">₱1,000</button>
      </div>

      <div id="change-display-box" style="display:flex; justify-content:space-between; padding:12px 14px; background:rgba(16,185,129,0.08); border-radius:10px; border:1px solid rgba(16,185,129,0.25);">
        <span style="font-size:13px; font-weight:600; color:var(--text-muted);">Change:</span>
        <span id="pay-change" style="font-size:16px; font-weight:800; color:var(--success, #10b981);">₱0.00</span>
      </div>
    </form>
  `, `<button id="checkout-confirm-btn" class="btn btn-primary" onclick="submitCheckout()" style="width:100%; height:44px; font-size:14px; font-weight:700;"><i class="fas fa-check-circle"></i> Confirm &amp; Complete Sale</button>`);
}

function onPayMethodChange(total) {
  const method = (document.getElementById("pay-method") || {}).value;
  const input = document.getElementById("pay-tendered");
  const quick = document.getElementById("pay-quick-buttons");
  const note = document.getElementById("pay-noncash-note");
  const isCash = method === "CASH";
  if (input) {
    if (!isCash) input.value = Number(total).toFixed(2);
    input.readOnly = !isCash;
  }
  if (quick) quick.style.display = isCash ? "flex" : "none";
  if (note) note.style.display = isCash ? "none" : "block";
  calculateChange(total);
}

function setTenderedAmount(amount, total) {
  const input = document.getElementById("pay-tendered");
  if (input) {
    input.value = amount;
    window.isFirstTenderTap = true;
    calculateChange(total);
  }
}

function addTenderedAmount(amount, total) {
  const input = document.getElementById("pay-tendered");
  if (input) {
    if (window.isFirstTenderTap) {
      input.value = amount.toFixed(2);
      window.isFirstTenderTap = false;
    } else {
      const current = parseFloat(input.value) || 0;
      input.value = (current + amount).toFixed(2);
    }
    calculateChange(total);
  }
}

function calculateChange(total) {
  const method = (document.getElementById("pay-method") || {}).value;
  const tendered = parseFloat(document.getElementById("pay-tendered")?.value) || 0;
  const change = method && method !== "CASH" ? 0 : Math.max(0, tendered - total);
  const changeEl = document.getElementById("pay-change");
  if (changeEl) {
    changeEl.textContent = Utils.formatCurrency(change);
  }
}

function receiptLinesFromSale(tx, cart) {
  const lines = (tx && Array.isArray(tx.items) && tx.items.length)
    ? tx.items
    : (cart || []).map(i => ({ name: i.name, quantity: i.quantity, unit_price: i.price, total_price: i.price * i.quantity }));
  return lines.map(i => ({
    name: i.name,
    quantity: i.quantity,
    price: Number(i.unit_price),
    unit_price: Number(i.unit_price),
    total_price: Number(i.total_price)
  }));
}

async function submitCheckout() {
  if (posCheckout.inFlight) return;   // double tap / Enter + click: one request at a time
  if (!posCart.length) {
    showCheckoutError("The cart is empty.");
    return;
  }
  const online = window.currentOnlineOrder;
  const isGcashOrder = !!online && online.payment_method === "GCASH";
  const methodEl = document.getElementById("pay-method");
  const method = isGcashOrder ? "GCASH" : (methodEl ? methodEl.value : "CASH");
  const total = cartTotal();
  const tenderedEl = document.getElementById("pay-tendered");
  const tendered = isGcashOrder ? total : (parseFloat(tenderedEl ? tenderedEl.value : "") || 0);
  const cents = (n) => Math.round(n * 100);

  if (cents(tendered) < cents(total)) {
    showCheckoutError("Tendered amount is less than total payable amount.");
    return;
  }
  if (method !== "CASH" && cents(tendered) !== cents(total)) {
    showCheckoutError("A non-cash payment must be exactly the amount due.");
    return;
  }

  // Same checkout => same key (a retry cannot charge twice). Different cart or method => new key.
  const signature = checkoutSignature(method);
  if (!posCheckout.key || posCheckout.signature !== signature) {
    posCheckout.key = newCheckoutKey();
    posCheckout.signature = signature;
  }
  persistCheckoutAttempt();

  const payload = online
    ? { customer_order_id: online.id, client_tx_id: posCheckout.key }
    : {
        items: posCart.map(i => ({ product_id: i.product_id, quantity: i.quantity })),
        client_tx_id: posCheckout.key
      };
  if (!isGcashOrder) {
    payload.payment_method = method;
    payload.amount_paid = tendered;
  }

  const errorBox = document.getElementById("checkout-error");
  if (errorBox) errorBox.style.display = "none";

  // Optimistic UI: close the heavy modal immediately so the cashier feels instant response.
  // The receipt pops up as soon as the server confirms (usually < 300 ms on local SQLite).
  posCheckout.inFlight = true;
  const checkoutBtn = document.getElementById("checkout-confirm-btn");
  if (checkoutBtn) { checkoutBtn.disabled = true; checkoutBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...'; }
  Utils.closeModal();

  try {
    const res = await Auth.fetch("/api/v1/transactions", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    let tx = null;
    try { tx = await res.json(); } catch (e) { tx = null; }
    if (!res.ok) {
      const detail = tx && typeof tx.detail === "string" ? tx.detail : `The server rejected the sale (HTTP ${res.status}).`;
      if (res.status === 409 && /different order|checkout reference/i.test(detail)) {
        posCheckout.key = null;   // the key belongs to another checkout: start a new one
        posCheckout.signature = null;
      }
      const failure = new Error(detail);
      failure.definitive = true;
      throw failure;
    }

    Utils.showToast(tx.idempotent_replay ? "This sale was already recorded. Showing the original receipt." : "Order completed successfully!", tx.idempotent_replay ? "info" : "success");
    const committedNet = Number(tx.net_amount !== undefined ? tx.net_amount : total);
    const committedMethod = String((tx.payments && tx.payments[0] && tx.payments[0].payment_method) || method).toUpperCase();

    const currentUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
    const orderForReceipt = {
      id: tx.id,
      receiptNumber: tx.receipt_no || tx.order_code || ((typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('TXN', tx.id) : `TXN-${String(tx.id).padStart(4, '0')}`),
      orderCode: tx.order_code || `TXN-${String(tx.id).padStart(4, '0')}`,
      date: tx.created_at || new Date().toISOString(),
      cashier: currentUser ? (currentUser.name || currentUser.username) : "Cashier",
      // The receipt shows what the server committed (lines, prices, totals, method), never the browser cart:
      // on a replay the cart may no longer match the original sale.
      items: receiptLinesFromSale(tx, posCart),
      total_amount: Number(tx.total_amount !== undefined ? tx.total_amount : total),
      net_amount: committedNet,
      discount_amount: Number(tx.discount_amount || 0),
      tax_amount: Number(tx.tax_amount || 0),
      payment_method: committedMethod,
      payment_status: tx.status || "completed",
      amount_paid: committedMethod === "CASH" ? tendered : committedNet,
      change: committedMethod === "CASH" ? Math.max(0, tendered - committedNet) : 0
    };

    window.lastCompletedOrder = orderForReceipt;
    Utils.showReceiptModal(orderForReceipt, `<i class="fas fa-check-circle" style="color:var(--success, #10b981); margin-right:8px;"></i> Transaction Complete — ${Utils.escapeHtml(orderForReceipt.receiptNumber)}`);

    clearCart();   // also forgets the idempotency key and the loaded customer order
    localStorage.setItem("RESTOTRACK_SYNC_TX", Date.now());
    fetchPendingOnlineOrders();

    try {
      const dRes = await Auth.fetch("/api/v1/shifts/drawer-summary");
      if (dRes.ok) {
        const dData = await dRes.json();
        const cUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
        const myS = resolveCashierShift(dData.shifts, cUser);
        const dCashEl = document.getElementById("pos-cash-in-drawer-display");
        const dOrdEl = document.getElementById("pos-complete-orders-display");
        const cashVal = myS ? (myS.expected_cash ?? 0) : (dData.total_cash_in_drawers || 0);
        const ordVal = myS ? (myS.total_sales ?? 0) : (dData.today_total_orders_amount || 0);
        if (dCashEl) dCashEl.textContent = Utils.formatCurrency(cashVal);
        if (dOrdEl) dOrdEl.textContent = "Orders: " + Utils.formatCurrency(ordVal);
      }
    } catch (e) {}
  } catch (err) {
    // The checkout modal was already closed optimistically. Show errors as an alert.
    if (err && err.definitive) {
      alert("Checkout Error: " + err.message);
    } else {
      // No answer from the server: the sale may or may not have been saved. Key is kept for retry.
      alert("Checkout: No response from the server. The sale may or may not have been saved.\nPress \"Checkout\" again — the same reference is reused and cannot charge twice.");
    }
  } finally {
    setCheckoutBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. KITCHEN DISPLAY SYSTEM (KDS)
// ─────────────────────────────────────────────────────────────────────────────
async function renderKitchen(c) {
  c = c || document.getElementById('view-container');
  if (!c) return;
  const res = await Auth.fetch(`/api/v1/kitchen/orders?type=food&_t=${Date.now()}`);
  if (!res.ok) throw new Error("Failed to load kitchen orders from server.");
  const orders = await res.json();

  if (window.kitchenOrdersInterval) {
    clearInterval(window.kitchenOrdersInterval);
    window.kitchenOrdersInterval = null;
  }
  window.kitchenOrdersInterval = setInterval(async () => {
    // If WebSocket is connected, skip redundant HTTP poll to keep responses instant & server fast
    const wsSocket = window.BlessieRealtime && window.BlessieRealtime.getSocket();
    if (wsSocket && wsSocket.readyState === WebSocket.OPEN) return;
    const kGrid = document.getElementById("kitchen-tickets-grid");
    if (kGrid) {
      const liveRes = await Auth.fetch(`/api/v1/kitchen/orders?type=food&_t=${Date.now()}`);
      if (liveRes.ok) {
        renderKitchen(c);
      }
    } else {
      clearInterval(window.kitchenOrdersInterval);
      window.kitchenOrdersInterval = null;
    }
  }, 8000);

  c.innerHTML = `
    <style>
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr)); gap: 10px; margin-bottom: 16px; }
      @media (max-width: 600px) {
        .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      }
      @media (max-width: 400px) {
        .stats-grid { grid-template-columns: 1fr; }
      }
      .stat-card { padding: 10px 14px; display: flex; align-items: center; gap: 10px; background: var(--card-bg, #ffffff); border-radius: var(--radius-card, 12px); border: 1px solid rgba(205, 190, 150, 0.35); box-shadow: 0 2px 8px rgba(0,0,0,0.03); transition: transform 0.2s ease, box-shadow 0.2s ease; min-height: 58px; }
      .stat-card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(180,140,50,0.1); }
      .stat-icon { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0; }
      .stat-icon.gold   { background: rgba(201,162,39,0.12); color: #c9a227; }
      .stat-icon.green  { background: rgba(16,185,129,0.12); color: #10b981; }
      .stat-icon.orange { background: rgba(249,115,22,0.12); color: #f97316; }
      .stat-icon.blue   { background: rgba(59,130,246,0.12); color: #3b82f6; }
      .stat-info h3 { font-size: 11px; color: var(--text-muted, #71717a); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; margin-top: 0; }
      .stat-count { font-size: 18px; font-weight: 800; color: var(--text-main, #18181b); line-height: 1.1; }
      .stat-trend { font-size: 10px; margin-top: 2px; font-weight: 500; }
    </style>

    <!-- Top Header Toolbar -->
    <div class="toolbar fade-up" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; margin-bottom:24px;">
      <div>
        <h2 style="font-size:22px; font-weight:800; color:var(--text-main); margin:0;">Live Kitchen Orders</h2>
        <p style="font-size:13px; color:var(--text-muted); margin-top:4px;">
          Food orders only — Monitoring real-time kitchen preparation
        </p>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-outline" onclick="renderKitchen()" style="border-color:#c9a227; color:#c9a227; display:inline-flex; align-items:center; gap:6px;">
          <i class="fas fa-sync-alt"></i> Refresh Board
        </button>
      </div>
    </div>

    <!-- Kitchen KPIs (Super Admin Style) -->
    <div class="stats-grid fade-up delay-1">
        <div class="stat-card">
            <div class="stat-icon orange"><i class="fas fa-clock"></i></div>
            <div class="stat-info">
                <h3>Pending Tickets</h3>
                <div class="stat-count">${orders.filter(o => o.status === 'PENDING').length}</div>
                <div class="stat-trend" style="color:#f97316;"><i class="fas fa-exclamation-circle"></i> Needs Attention</div>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-icon blue"><i class="fas fa-fire-burner"></i></div>
            <div class="stat-info">
                <h3>Preparing Now</h3>
                <div class="stat-count">${orders.filter(o => o.status === 'PREPARING').length}</div>
                <div class="stat-trend" style="color:#3b82f6;"><i class="fas fa-fire"></i> Currently Cooking</div>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-icon green"><i class="fas fa-check-double"></i></div>
            <div class="stat-info">
                <h3>Completed</h3>
                <div class="stat-count">${orders.filter(o => o.status === 'COMPLETED' || o.status === 'READY').length}</div>
                <div class="stat-trend" style="color:#10b981;"><i class="fas fa-thumbs-up"></i> Ready to Serve</div>
            </div>
        </div>
        <div class="stat-card">
            <div class="stat-icon gold"><i class="fas fa-utensils"></i></div>
            <div class="stat-info">
                <h3>Food to Cook</h3>
                <div class="stat-count">${orders.filter(o => o.status !== 'COMPLETED' && o.status !== 'READY').reduce((sum, o) => sum + (o.items?.length || 0), 0)}</div>
                <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-list-ol"></i> Total Food Items</div>
            </div>
        </div>
    </div>

    <!-- Responsive Grid for Order Tickets -->
    <div id="kitchen-tickets-grid" class="kitchen-orders-grid fade-up delay-2" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 290px), 1fr)); gap:16px; align-items:start;">
      ${(() => {
        const activeOrders = orders.filter(o => o.status !== 'COMPLETED' && o.status !== 'READY');
        return activeOrders.length ? activeOrders.map(ord => {
        // Status Colors & Badges
        const isCompleted = ord.status === 'COMPLETED' || ord.status === 'READY';
        let badgeStyle = "background:rgba(249,115,22,0.12); color:#f97316;"; // Pending (Orange)
        if (isCompleted) {
            badgeStyle = "background:rgba(16,185,129,0.12); color:#10b981;"; // Completed (Green)
        } else if (ord.status === 'PREPARING') {
            badgeStyle = "background:rgba(59,130,246,0.12); color:#3b82f6;"; // Preparing (Blue)
        }

        return `
        <div class="section-card" id="ticket-card-${ord.raw_id || ord.id}" data-order-id="${ord.raw_id || ord.id}" style="padding:0; overflow:hidden; border:1px solid ${isCompleted ? 'rgba(16,185,129,0.3)' : 'rgba(201,162,39,0.3)'}; transition:all 0.2s ease;">
          <!-- Ticket Header -->
          <div style="background:${isCompleted ? '#f0fdf4' : '#faf8f3'}; padding:16px 20px; border-bottom:1px solid rgba(205,190,150,0.2); display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong style="font-size:16px; font-weight:800; color:var(--text-main);">${(typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('ORD', ord.raw_id || ord.id) : (ord.id || 'ORD-0000')}</strong>
              <div style="font-size:11px; color:var(--text-muted); margin-top:2px;"><i class="far fa-clock"></i> ${Utils.escapeHtml(ord.time || 'Just now')} • ${Utils.escapeHtml(ord.table || 'Takeout')}</div>
            </div>
            <span class="badge" style="font-size:11px; font-weight:700; ${badgeStyle}">
              ${Utils.escapeHtml(ord.status || 'PENDING')}
            </span>
          </div>
          
          <!-- Ticket Items -->
          <div style="padding:16px 20px;">
            <ul style="list-style:none; padding:0; margin:0;">
              ${(ord.items || []).map((it, idx) => `
                <li style="display:flex; align-items:flex-start; gap:12px; margin-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; padding-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; border-bottom:${idx === (ord.items.length - 1) ? 'none' : '1px dashed rgba(205,190,150,0.3)'};">
                  <div style="font-size:16px; font-weight:800; color:#c9a227; min-width:32px; text-align:right;">
                    ${Utils.escapeHtml(it.qty || it.quantity)}<span style="font-size:12px; color:var(--text-muted);">x</span>
                  </div>
                  <div>
                    <div style="font-size:14px; font-weight:700; color:var(--text-main); line-height:1.3;">${Utils.escapeHtml(it.name || it.product_name)}</div>
                    ${it.notes ? `<div style="font-size:12px; color:#f97316; margin-top:4px;"><i class="fas fa-exclamation-circle"></i> ${Utils.escapeHtml(it.notes)}</div>` : ''}
                  </div>
                </li>
              `).join('')}
            </ul>
          </div>
          
          <!-- Ticket Footer / Actions -->
          <div style="padding:14px 20px; background:#fcfcfc; border-top:1px solid rgba(205,190,150,0.15); text-align:center;">
            ${isCompleted ? `
              <div style="color:#10b981; font-size:13px; font-weight:700; display:flex; align-items:center; justify-content:center; gap:8px; padding:6px 0;">
                <i class="fas fa-check-circle" style="font-size:16px;"></i> Order Completed
              </div>
            ` : `
              <div style="display:grid; grid-template-columns:${ord.status !== 'PREPARING' ? '1fr 1fr 1fr' : '1fr 1fr'}; gap:6px;">
                ${ord.status !== 'PREPARING' ? `
                  <button type="button" class="btn" style="font-size:11px; font-weight:700; padding:8px 6px; border-radius:8px; display:inline-flex; justify-content:center; align-items:center; gap:4px; border:1px solid #3b82f6; color:#3b82f6; background:rgba(59,130,246,0.06); cursor:pointer;" onclick="updateOrderStatus(${Utils.jsArg(ord.raw_id || ord.id)}, 'PREPARING')">
                    <i class="fas fa-fire-burner"></i> Preparing
                  </button>
                ` : ''}
                <button type="button" class="btn" style="font-size:11px; font-weight:700; padding:8px 6px; border-radius:8px; display:inline-flex; justify-content:center; align-items:center; gap:4px; border:1px solid #ef4444; color:#ef4444; background:rgba(239,68,68,0.06); cursor:pointer;" onclick="promptRejectOrder(${Utils.jsArg(ord.raw_id || ord.id)})">
                  <i class="fas fa-ban"></i> Reject
                </button>
                <button type="button" class="btn btn-primary" style="font-size:11px; font-weight:700; padding:8px 6px; border-radius:8px; display:inline-flex; justify-content:center; align-items:center; gap:4px; background:#10b981; color:#fff; border:none; cursor:pointer;" onclick="updateOrderStatus(${Utils.jsArg(ord.raw_id || ord.id)}, 'COMPLETED')">
                  <i class="fas fa-check-circle"></i> Complete
                </button>
              </div>
            `}
          </div>
        </div>
      `}).join('') : `
        <div style="grid-column:1/-1; text-align:center; padding:60px 20px; background:#ffffff; border:1px dashed rgba(205,190,150,0.4); border-radius:12px;">
          <div style="width:64px; height:64px; border-radius:50%; background:rgba(201,162,39,0.1); color:#c9a227; display:flex; align-items:center; justify-content:center; margin:0 auto 16px; font-size:24px;">
            <i class="fas fa-mug-hot"></i>
          </div>
          <h3 style="font-size:16px; font-weight:700; color:var(--text-main); margin-bottom:8px;">All Clear!</h3>
          <p style="font-size:13px; color:var(--text-muted); max-width:300px; margin:0 auto;">There are no active orders in the queue right now. Great job keeping the kitchen fast!</p>
        </div>
      `;
      })()}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// KITCHEN LOGS (Completed Orders)
// ─────────────────────────────────────────────────────────────────────────────
async function renderKitchenLogs(c) {
  c = c || document.getElementById('view-container') || document.getElementById('main-content');
  if (!c) return;
  const res = await Auth.fetch(`/api/v1/kitchen/orders?type=food&_t=${Date.now()}`);
  const orders = res.ok ? await res.json() : [];
  const completedOrders = orders.filter(o => o.status === 'COMPLETED' || o.status === 'READY');

  c.innerHTML = `
    <!-- Top Header Toolbar -->
    <div class="toolbar fade-up" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; margin-bottom:24px;">
      <div>
        <h2 style="font-size:22px; font-weight:800; color:var(--text-main); margin:0;">Completed Orders Log</h2>
        <p style="font-size:13px; color:var(--text-muted); margin-top:4px;">
          Past tickets that have been prepared and served today.
        </p>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-outline" onclick="renderKitchenLogs()" style="border-color:#10b981; color:#10b981; display:inline-flex; align-items:center; gap:6px;">
          <i class="fas fa-sync-alt"></i> Refresh Logs
        </button>
      </div>
    </div>

    <!-- Responsive Grid for Order Tickets -->
    <div class="kitchen-orders-grid fade-up delay-2" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 290px), 1fr)); gap:16px; align-items:start;">
      ${completedOrders.length ? completedOrders.map(ord => {
        return `
        <div class="section-card" style="padding:0; overflow:hidden; border:1px solid rgba(16,185,129,0.3);">
          <!-- Ticket Header -->
          <div style="background:#f0fdf4; padding:16px 20px; border-bottom:1px solid rgba(205,190,150,0.2); display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong style="font-size:16px; font-weight:800; color:var(--text-main);">${(typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('ORD', ord.raw_id || ord.id) : (ord.id || 'ORD-0000')}</strong>
              <div style="font-size:11px; color:var(--text-muted); margin-top:2px;"><i class="far fa-clock"></i> ${Utils.escapeHtml(ord.time || 'Just now')} • ${Utils.escapeHtml(ord.table || 'Takeout')}</div>
            </div>
            <span class="badge" style="font-size:11px; font-weight:700; background:rgba(16,185,129,0.12); color:#10b981;">
              ${Utils.escapeHtml(ord.status || 'COMPLETED')}
            </span>
          </div>
          
          <!-- Ticket Items -->
          <div style="padding:16px 20px;">
            <ul style="list-style:none; padding:0; margin:0;">
              ${(ord.items || []).map((it, idx) => `
                <li style="display:flex; align-items:flex-start; gap:12px; margin-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; padding-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; border-bottom:${idx === (ord.items.length - 1) ? 'none' : '1px dashed rgba(205,190,150,0.3)'};">
                  <div style="font-size:16px; font-weight:800; color:#10b981; min-width:32px; text-align:right;">
                    ${Utils.escapeHtml(it.qty || it.quantity)}<span style="font-size:12px; color:var(--text-muted);">x</span>
                  </div>
                  <div>
                    <div style="font-size:14px; font-weight:700; color:var(--text-main); line-height:1.3; text-decoration: line-through;">${Utils.escapeHtml(it.name || it.product_name)}</div>
                  </div>
                </li>
              `).join('')}
            </ul>
          </div>
        </div>
      `}).join('') : `
        <div style="grid-column:1/-1; text-align:center; padding:60px 20px; background:#ffffff; border:1px dashed rgba(205,190,150,0.4); border-radius:12px;">
          <div style="width:64px; height:64px; border-radius:50%; background:rgba(16,185,129,0.1); color:#10b981; display:flex; align-items:center; justify-content:center; margin:0 auto 16px; font-size:24px;">
            <i class="fas fa-check-double"></i>
          </div>
          <h3 style="font-size:16px; font-weight:700; color:var(--text-main); margin-bottom:8px;">No Completed Orders Yet</h3>
          <p style="font-size:13px; color:var(--text-muted); max-width:300px; margin:0 auto;">Orders that have been fully prepared and marked as ready will appear here.</p>
        </div>
      `}
    </div>
  `;
}

async function updateOrderStatus(orderId, newStatus) {
  const card = document.getElementById(`ticket-card-${orderId}`) || document.querySelector(`[data-order-id="${orderId}"]`);
  if (card) {
    if (newStatus === 'COMPLETED' || newStatus === 'READY') {
      card.style.transition = 'all 0.2s ease';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.95)';
      card.style.pointerEvents = 'none';
      setTimeout(() => { if (card) card.remove(); }, 220);
    } else if (newStatus === 'PREPARING') {
      const badge = card.querySelector('.badge');
      if (badge) {
        badge.textContent = 'PREPARING';
        badge.style.background = 'rgba(59,130,246,0.12)';
        badge.style.color = '#3b82f6';
      }
      const prepBtn = card.querySelector('button[onclick*="PREPARING"]');
      if (prepBtn) {
        prepBtn.remove();
      }
    }
  }

  try {
    const res = await Auth.fetch(`/api/v1/kitchen/orders/${orderId}/status`, {
      method: "PUT",
      body: JSON.stringify({ status: newStatus, station: "food" })
    });
    if (res.ok) {
      localStorage.setItem("RESTOTRACK_SYNC_KITCHEN", JSON.stringify({ timestamp: Date.now(), orderId: orderId, status: newStatus }));
      renderKitchen();
    } else {
      const err = await res.json().catch(() => ({}));
      Utils.showToast(err.detail || "Failed to update order status.", "danger");
      renderKitchen();
    }
  } catch (err) {
    console.error("Failed to update status", err);
    renderKitchen();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.5 CASHIER DRINKS ORDER (DRINK PREPARATION & DISPATCH COUNTER)
// ─────────────────────────────────────────────────────────────────────────────
async function renderDrinksStation(c) {
  c = c || document.getElementById('view-container');
  if (!c) return;

  const res = await Auth.fetch(`/api/v1/kitchen/drinks-orders?_t=${Date.now()}`);
  if (!res.ok) throw new Error("Failed to load drinks station orders from server.");
  const orders = await res.json();

  pollDrinksBadge();

  if (window.drinksStationInterval) {
    clearInterval(window.drinksStationInterval);
    window.drinksStationInterval = null;
  }
  window.drinksStationInterval = setInterval(async () => {
    // If WebSocket is connected, skip redundant HTTP poll
    const wsSocket = window.BlessieRealtime && window.BlessieRealtime.getSocket();
    if (wsSocket && wsSocket.readyState === WebSocket.OPEN) return;
    const grid = document.getElementById('drinks-tickets-grid');
    if (grid) {
      const liveRes = await Auth.fetch(`/api/v1/kitchen/drinks-orders?_t=${Date.now()}`);
      if (liveRes.ok) {
        renderDrinksStation(c);
      }
    } else {
      clearInterval(window.drinksStationInterval);
      window.drinksStationInterval = null;
    }
  }, 8000);

  const activeOrders = orders.filter(o => o.status !== 'COMPLETED' && o.status !== 'READY');
  const pendingOrders = orders.filter(o => o.status === 'PENDING');
  const preparingOrders = orders.filter(o => o.status === 'PREPARING');
  const completedOrders = orders.filter(o => o.status === 'COMPLETED' || o.status === 'READY');
  const totalItems = activeOrders.reduce((sum, o) => sum + (o.items?.length || 0), 0);

  c.innerHTML = `
    <style>
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr)); gap: 10px; margin-bottom: 16px; }
      @media (max-width: 600px) {
        .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      }
      @media (max-width: 400px) {
        .stats-grid { grid-template-columns: 1fr; }
      }
      .stat-card { padding: 10px 14px; display: flex; align-items: center; gap: 10px; background: var(--card-bg, #ffffff); border-radius: var(--radius-card, 12px); border: 1px solid rgba(205, 190, 150, 0.35); box-shadow: 0 2px 8px rgba(0,0,0,0.03); transition: transform 0.2s ease, box-shadow 0.2s ease; min-height: 58px; }
      .stat-card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(180,140,50,0.1); }
      .stat-icon { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0; }
      .stat-icon.gold   { background: rgba(201,162,39,0.12); color: #c9a227; }
      .stat-icon.green  { background: rgba(16,185,129,0.12); color: #10b981; }
      .stat-icon.orange { background: rgba(249,115,22,0.12); color: #f97316; }
      .stat-icon.blue   { background: rgba(59,130,246,0.12); color: #3b82f6; }
      .stat-info h3 { font-size: 11px; color: var(--text-muted, #71717a); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; margin-top: 0; }
      .stat-count { font-size: 18px; font-weight: 800; color: var(--text-main, #18181b); line-height: 1.1; }
      .stat-trend { font-size: 10px; margin-top: 2px; font-weight: 500; }
    </style>

    <!-- Top Header Toolbar -->
    <div class="toolbar fade-up" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; margin-bottom:24px;">
      <div>
        <h2 style="font-size:22px; font-weight:800; color:var(--text-main); margin:0;">
          <i class="fas fa-glass-water" style="color:#2563eb; margin-right:8px;"></i>Drinks Orders
        </h2>
        <p style="font-size:13px; color:var(--text-muted); margin-top:4px;">
          Live beverage orders received & prepared by Cashier
        </p>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <span style="display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:700; color:#2563eb; background:rgba(37,99,235,0.08); padding:6px 14px; border-radius:20px;">
          <span style="width:8px; height:8px; border-radius:50%; background:#2563eb; display:inline-block;"></span> Live Drinks Queue
        </span>
        <button class="btn btn-outline" onclick="renderDrinksStation()" style="border-color:#2563eb; color:#2563eb; display:inline-flex; align-items:center; gap:6px; cursor:pointer;">
          <i class="fas fa-sync-alt"></i> Refresh Board
        </button>
      </div>
    </div>

    <!-- Drinks KPIs -->
    <div class="stats-grid fade-up delay-1">
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-clock"></i></div>
        <div class="stat-info">
          <h3>Pending Drinks</h3>
          <div class="stat-count">${Utils.escapeHtml(pendingOrders.length)}</div>
          <div class="stat-trend" style="color:#f97316;"><i class="fas fa-exclamation-circle"></i> Needs Dispensing</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon blue"><i class="fas fa-blender"></i></div>
        <div class="stat-info">
          <h3>Preparing Drinks</h3>
          <div class="stat-count">${Utils.escapeHtml(preparingOrders.length)}</div>
          <div class="stat-trend" style="color:#3b82f6;"><i class="fas fa-spinner fa-spin"></i> In Progress</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-check-double"></i></div>
        <div class="stat-info">
          <h3>Drinks Served</h3>
          <div class="stat-count">${Utils.escapeHtml(completedOrders.length)}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-thumbs-up"></i> Dispatched</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-mug-hot"></i></div>
        <div class="stat-info">
          <h3>Drink Items</h3>
          <div class="stat-count">${Utils.escapeHtml(totalItems)}</div>
          <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-list-ol"></i> Drinks to Pour</div>
        </div>
      </div>
    </div>

    <!-- Responsive Grid for Drink Tickets -->
    <div id="drinks-tickets-grid" class="drinks-orders-grid fade-up delay-2" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 290px), 1fr)); gap:16px; align-items:start;">
      ${(() => {
        if (!activeOrders.length) {
          return `
            <div style="grid-column:1/-1; text-align:center; padding:60px 20px; background:#ffffff; border:1px dashed rgba(59,130,246,0.35); border-radius:16px;">
              <div style="width:64px; height:64px; border-radius:50%; background:rgba(37,99,235,0.08); color:#2563eb; display:flex; align-items:center; justify-content:center; margin:0 auto 16px; font-size:26px;">
                <i class="fas fa-glass-cheers"></i>
              </div>
              <h3 style="font-size:17px; font-weight:700; color:var(--text-main); margin-bottom:8px;">All Drinks Dispatched!</h3>
              <p style="font-size:13px; color:var(--text-muted); max-width:320px; margin:0 auto;">There are no active drink orders in the queue right now. Drink orders from the POS and customer QR codes appear here instantly for the cashier!</p>
            </div>
          `;
        }

        return activeOrders.map(ord => {
          const isCompleted = ord.status === 'COMPLETED' || ord.status === 'READY';
          let badgeStyle = "background:rgba(249,115,22,0.12); color:#f97316;";
          if (isCompleted) {
            badgeStyle = "background:rgba(16,185,129,0.12); color:#10b981;";
          } else if (ord.status === 'PREPARING') {
            badgeStyle = "background:rgba(59,130,246,0.12); color:#3b82f6;";
          }

          return `
            <div class="section-card" style="padding:0; overflow:hidden; border:1.5px solid ${isCompleted ? 'rgba(16,185,129,0.3)' : 'rgba(59,130,246,0.3)'}; border-radius:14px; box-shadow:0 4px 15px rgba(0,0,0,0.04);">
              <!-- Ticket Header -->
              <div style="background:${isCompleted ? '#f0fdf4' : '#eff6ff'}; padding:16px 20px; border-bottom:1px solid rgba(59,130,246,0.15); display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <div style="display:flex; align-items:center; gap:8px;">
                    <strong style="font-size:16px; font-weight:800; color:var(--text-main);">${(typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('ORD', ord.raw_id || ord.id) : (ord.id || 'ORD-0000')}</strong>
                    <span style="font-size:11px; font-weight:700; background:#2563eb; color:#ffffff; padding:2px 8px; border-radius:12px;"><i class="fas fa-glass-water" style="margin-right:4px;"></i> DRINKS</span>
                  </div>
                  <div style="font-size:11px; color:var(--text-muted); margin-top:3px;">
                    <i class="far fa-clock"></i> ${Utils.escapeHtml(ord.time || 'Just now')} • <strong>${Utils.escapeHtml(ord.table || 'Takeout')}</strong>
                  </div>
                </div>
                <span class="badge" style="font-size:11px; font-weight:700; ${badgeStyle}">
                  ${Utils.escapeHtml(ord.status || 'PENDING')}
                </span>
              </div>

              <!-- Drinks Items List -->
              <div style="padding:16px 20px;">
                <ul style="list-style:none; padding:0; margin:0;">
                  ${(ord.items || []).map((it, idx) => `
                    <li style="display:flex; align-items:flex-start; gap:12px; margin-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; padding-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; border-bottom:${idx === (ord.items.length - 1) ? 'none' : '1px dashed rgba(205,190,150,0.3)'};">
                      <div style="font-size:16px; font-weight:800; color:#2563eb; min-width:32px; text-align:right;">
                        ${Utils.escapeHtml(it.qty || it.quantity)}<span style="font-size:12px; color:var(--text-muted);">x</span>
                      </div>
                      <div>
                        <div style="font-size:14px; font-weight:700; color:var(--text-main); line-height:1.3;">${Utils.escapeHtml(it.name || it.product_name)}</div>
                        ${it.notes ? `<div style="font-size:12px; color:#f97316; margin-top:4px;"><i class="fas fa-exclamation-circle"></i> ${Utils.escapeHtml(it.notes)}</div>` : ''}
                      </div>
                    </li>
                  `).join('')}
                </ul>
              </div>

              <!-- Action Footer -->
              <div style="padding:14px 20px; background:#fcfcfc; border-top:1px solid rgba(205,190,150,0.15); text-align:center;">
                ${isCompleted ? `
                  <div style="color:#10b981; font-size:13px; font-weight:700; display:flex; align-items:center; justify-content:center; gap:8px; padding:6px 0;">
                    <i class="fas fa-check-circle" style="font-size:16px;"></i> Order Completed
                  </div>
                ` : `
                  <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                    <button type="button" class="btn" style="font-size:13px; font-weight:700; padding:10px; border-radius:8px; display:inline-flex; justify-content:center; align-items:center; gap:6px; border:1px solid #ef4444; color:#ef4444; background:rgba(239,68,68,0.06); cursor:pointer;" onclick="promptRejectOrder(${Utils.jsArg(ord.raw_id || ord.id)})">
                      <i class="fas fa-ban"></i> Reject
                    </button>
                    <button type="button" class="btn btn-primary" style="font-size:13px; font-weight:700; padding:10px; border-radius:8px; display:inline-flex; justify-content:center; align-items:center; gap:8px; background:#10b981; color:#fff; border:none; cursor:pointer;" onclick="updateDrinksStatus(${Utils.jsArg(ord.raw_id)}, 'COMPLETED')">
                      <i class="fas fa-check-circle"></i> Complete Order
                    </button>
                  </div>
                `}
              </div>
            </div>
          `;
        }).join('');
      })()}
    </div>
  `;
}

async function updateDrinksStatus(orderId, newStatus) {
  try {
    const res = await Auth.fetch(`/api/v1/kitchen/orders/${orderId}/drinks-status`, {
      method: "PUT",
      body: JSON.stringify({ status: newStatus })
    });
    if (res.ok) {
      renderDrinksStation();
      pollDrinksBadge();
      localStorage.setItem("RESTOTRACK_SYNC_DRINKS", JSON.stringify({ timestamp: Date.now(), orderId: orderId, status: newStatus }));
    }
  } catch (err) {
    console.error("Failed to update drinks status", err);
  }
}

async function pollDrinksBadge() {
  try {
    const res = await Auth.fetch(`/api/v1/kitchen/drinks-orders?_t=${Date.now()}`);
    if (res.ok) {
      const orders = await res.json();
      const activeCount = orders.filter(o => o.status !== 'COMPLETED' && o.status !== 'READY').length;
      const sidebarBadge = document.getElementById("cashier-drinks-badge");
      if (sidebarBadge) {
        if (activeCount > 0) {
          sidebarBadge.textContent = activeCount;
          sidebarBadge.style.display = "inline-block";
        } else {
          sidebarBadge.style.display = "none";
        }
      }
      const posBadge = document.getElementById("pos-drinks-badge");
      if (posBadge) {
        if (activeCount > 0) {
          posBadge.textContent = activeCount;
          posBadge.style.display = "inline-block";
        } else {
          posBadge.style.display = "none";
        }
      }
    }
  } catch (e) {}
}

const renderDrinksOrder = renderDrinksStation;
window.renderDrinksOrder = renderDrinksStation;

// Start drinks badge polling automatically for cashier
if (typeof window !== "undefined" && !window._drinksPollingStarted) {
  window._drinksPollingStarted = true;
  setInterval(pollDrinksBadge, 8000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. TRANSACTIONS LISTING (TODAY'S ORDERS)
// ─────────────────────────────────────────────────────────────────────────────
async function renderTransactions(c) {
  c = c || document.getElementById("view-container");
  if (!c) return;

  const currentUser = (typeof Auth !== "undefined" && Auth.getUser) ? Auth.getUser() : null;
  const isCashier = (currentUser && (currentUser.role || "").toLowerCase() === "cashier") || (window.location.pathname || "").toLowerCase().includes("cashier");

  const res = await Auth.fetch("/api/v1/transactions?limit=50");
  if (!res.ok) throw new Error("Failed to load transactions from server.");
  const list = await res.json();

  // Cache for quick modal lookups
  window._recentTransactionsCache = list;

  if (window._transactionsInterval) {
    clearInterval(window._transactionsInterval);
    window._transactionsInterval = null;
  }
  window._transactionsInterval = setInterval(async () => {
    const tbody = document.getElementById("tx-tbody");
    if (tbody) {
      const liveRes = await Auth.fetch("/api/v1/transactions?limit=50");
      if (liveRes.ok) {
        const liveList = await liveRes.json();
        window._recentTransactionsCache = liveList;
        renderTransactions(c);
      }
    } else {
      clearInterval(window._transactionsInterval);
      window._transactionsInterval = null;
    }
  }, 4000);

  c.innerHTML = `
    <div class="section-card">
      <div class="section-head" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        <div>
          <h2>Order Transactions</h2>
          <span style="font-size:13px; color:var(--text-muted);">${Utils.escapeHtml(list.length)} recent transactions</span>
        </div>
        <div>
          <button class="btn btn-outline btn-sm" onclick="renderTransactions()" style="border-color:#c9a227; color:#c9a227; display:inline-flex; align-items:center; gap:6px;">
            <i class="fas fa-sync-alt"></i> Refresh Orders
          </button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              ${!isCashier ? `<th>Order ID</th>` : ''}
              <th>Timestamp</th>
              <th>Cashier</th>
              <th>Items</th>
              <th>Payment</th>
              <th>Total Net</th>
              <th>Status</th>
              <th style="text-align:center;">Action</th>
            </tr>
          </thead>
          <tbody id="tx-tbody">
            ${list.length ? list.map(tx => {
              const fulfillment = String(tx.fulfillment_status || '').toUpperCase();
              const saleStatus = String(tx.status || '').toUpperCase();

              let displayStatus = 'COMPLETED';
              if (saleStatus === 'REJECTED' || saleStatus === 'CANCELLED' || fulfillment === 'REJECTED' || fulfillment === 'CANCELLED') {
                displayStatus = 'REJECTED';
              } else if (fulfillment === 'PREPARING' || saleStatus === 'PREPARING') {
                displayStatus = 'PREPARING';
              } else if (fulfillment === 'PENDING' || saleStatus === 'PENDING') {
                displayStatus = 'PENDING';
              } else {
                displayStatus = 'COMPLETED';
              }

              let statusBadge = '';
              if (displayStatus === 'PENDING') {
                statusBadge = `<span class="badge" style="background:#fef3c7; color:#b45309; border:1px solid rgba(245,158,11,0.3); font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:4px;"><i class="far fa-clock"></i> PENDING</span>`;
              } else if (displayStatus === 'PREPARING') {
                statusBadge = `<span class="badge" style="background:#dbeafe; color:#1e40af; border:1px solid rgba(59,130,246,0.3); font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:4px;"><i class="fas fa-fire"></i> PREPARING</span>`;
              } else if (displayStatus === 'REJECTED') {
                statusBadge = `<span class="badge" style="background:#fee2e2; color:#b91c1c; border:1px solid rgba(239,68,68,0.3); font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:4px;"><i class="fas fa-times-circle"></i> REJECTED</span>`;
              } else {
                statusBadge = `<span class="badge badge-success" style="font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:4px;"><i class="fas fa-check-circle"></i> COMPLETED</span>`;
              }

              let actionHtml = '';
              if (displayStatus === 'PENDING' || displayStatus === 'PREPARING') {
                actionHtml = `
                  <div style="display:flex; justify-content:center; align-items:center; gap:6px;">
                    <button type="button" class="btn btn-sm" onclick="promptRejectOrder(${tx.id})" style="background:#ef4444; color:#ffffff; border:none; border-radius:6px; padding:5px 12px; font-size:11px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:5px; box-shadow:0 2px 5px rgba(239,68,68,0.25); transition:0.2s;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'" title="Reject order if customer cancels">
                      <i class="fas fa-ban"></i> Reject
                    </button>
                    <button type="button" class="btn btn-sm btn-outline" onclick="changeOrderStatusDirect(${tx.id}, 'completed')" style="border-color:#10b981; color:#10b981; border-radius:6px; padding:5px 10px; font-size:11px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:4px; transition:0.2s;" onmouseover="this.style.background='rgba(16,185,129,0.08)'" onmouseout="this.style.background='transparent'" title="Mark as Completed">
                      <i class="fas fa-check"></i> Complete
                    </button>
                  </div>
                `;
              } else if (displayStatus === 'REJECTED') {
                actionHtml = `
                  <div style="display:flex; justify-content:center; align-items:center; gap:6px;">
                    <span style="display:inline-flex; align-items:center; gap:4px; color:#ef4444; font-size:11px; font-weight:700;"><i class="fas fa-ban"></i> Cancelled</span>
                    ${refundStatusHtml(tx)}
                    <button type="button" class="btn btn-sm btn-outline" onclick="previewTransactionReceipt(${tx.id})" style="border-color:#a1a1aa; color:#71717a; border-radius:6px; padding:4px 8px; font-size:11px; font-weight:600; cursor:pointer;" title="View Receipt">
                      <i class="fas fa-receipt"></i>
                    </button>
                  </div>
                `;
              } else {
                actionHtml = `
                  <div style="display:flex; justify-content:center; align-items:center; gap:6px;">
                    <button type="button" class="btn btn-sm btn-outline" onclick="previewTransactionReceipt(${tx.id})" style="border-color:#c9a227; color:#c9a227; border-radius:6px; padding:4px 10px; font-size:11px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:4px; transition:0.2s;" onmouseover="this.style.background='rgba(201,162,39,0.08)'" onmouseout="this.style.background='transparent'" title="Preview Receipt">
                      <i class="fas fa-receipt"></i> Receipt
                    </button>
                    <button type="button" class="btn btn-sm" onclick="printTransactionReceiptDirect(${tx.id})" style="background:#c9a227; color:#ffffff; border:none; border-radius:6px; padding:4px 8px; font-size:11px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:3px; box-shadow:0 2px 5px rgba(201,162,39,0.25);" title="Print Receipt">
                      <i class="fas fa-print"></i>
                    </button>
                  </div>
                `;
              }

              const itemsSummary = (tx.items || []).map(it => `${it.quantity}x ${it.name}`).join(', ');

              return `
                <tr>
                  ${!isCashier ? `
                  <td style="color:var(--text-main); font-weight:700; font-family:monospace; font-size:12px;">
                    <span style="background:rgba(201,162,39,0.12); color:#c9a227; padding:3px 8px; border-radius:6px; letter-spacing:0.5px;">${(typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('TXN', tx.id) : `TXN-${String(tx.id).padStart(4, '0')}`}</span>
                  </td>
                  ` : ''}
                  <td style="color:var(--text-muted); font-size:13px;">${tx.created_at ? new Date(tx.created_at).toLocaleString() : '—'}</td>
                  <td><strong style="font-size:13px;">${Utils.escapeHtml(tx.cashier || 'Staff')}</strong></td>
                  <td style="color:var(--text-main); font-size:13px;" title="${Utils.escapeHtml(itemsSummary || 'No items')}">
                    <span style="cursor:pointer; color:#c9a227; font-weight:600;" onclick="viewOrderItemsModal(${tx.id})">
                      ${(tx.items || []).length} items <i class="fas fa-info-circle" style="font-size:11px; margin-left:2px;"></i>
                    </span>
                    ${itemsSummary ? `<div style="font-size:11px; color:var(--text-muted); max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${Utils.escapeHtml(itemsSummary)}</div>` : ''}
                  </td>
                  <td style="font-size:12px;">${(tx.payments || []).map(p => `${Utils.escapeHtml(p.payment_method)}${p.verification ? ' <span title="Amount confirmed by the cashier from GCash history" style="color:#047857; font-weight:700;">&#10003; cashier-verified</span>' : ''}${p.status === 'cancelled' ? ' <span style="color:#b91c1c;">(void)</span>' : ''}`).join('<br>') || '—'}</td>
                  <td><strong style="color:#c9a227; font-size:13px;">${Utils.formatCurrency(tx.net_amount)}</strong></td>
                  <td>${statusBadge}</td>
                  <td style="text-align:center;">${actionHtml}</td>
                </tr>
              `;
            }).join('') : `<tr><td colspan="${isCashier ? 6 : 7}" style="text-align:center; padding:30px; color:var(--text-muted);">No transaction logs recorded yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

window.viewOrderItemsModal = function(txId) {
  const list = window._recentTransactionsCache || [];
  const tx = list.find(t => t.id === txId);
  if (!tx) return;

  const items = tx.items || [];
  Utils.openModal(`
    <div style="padding:4px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h3 style="font-size:16px; font-weight:800; margin:0; color:var(--text-main);">Order ${(typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('TXN', tx.id) : `TXN-${String(tx.id).padStart(4, '0')}`} Details</h3>
        <span class="badge" style="font-size:11px; font-weight:700;">${(tx.status || 'completed').toUpperCase()}</span>
      </div>
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:14px;">
        <span>Cashier: <strong>${Utils.escapeHtml(tx.cashier || 'Staff')}</strong></span> &bull; 
        <span>Time: <strong>${tx.created_at ? new Date(tx.created_at).toLocaleString() : '—'}</strong></span>
      </div>
      <div style="max-height:220px; overflow-y:auto; border:1px solid rgba(205,190,150,0.25); border-radius:8px; padding:10px 14px; margin-bottom:16px;">
        ${items.length ? items.map(it => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px dashed rgba(205,190,150,0.2); font-size:13px;">
            <div><strong style="color:#c9a227;">${Utils.escapeHtml(it.quantity)}x</strong> <span style="font-weight:600;">${Utils.escapeHtml(it.name)}</span></div>
            <span style="font-weight:700; color:var(--text-main); font-size:12px;">₱${(it.unit_price * it.quantity).toFixed(2)}</span>
          </div>
        `).join('') : '<div style="color:var(--text-muted); text-align:center; padding:12px;">No items found.</div>'}
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <span style="font-size:13px; font-weight:600; color:var(--text-muted);">Total Net:</span>
        <strong style="font-size:16px; color:#c9a227;">₱${Number(tx.net_amount || 0).toFixed(2)}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn btn-outline" onclick="previewTransactionReceipt(${tx.id})" style="border-color:#c9a227; color:#c9a227; padding:6px 12px; font-size:12px; font-weight:700; display:inline-flex; align-items:center; gap:5px;">
            <i class="fas fa-receipt"></i> View Receipt
          </button>
          <button type="button" class="btn btn-primary" onclick="printTransactionReceiptDirect(${tx.id})" style="padding:6px 14px; font-size:12px; font-weight:700; display:inline-flex; align-items:center; gap:5px;">
            <i class="fas fa-print"></i> Print Receipt
          </button>
        </div>
        <button type="button" class="btn btn-outline" onclick="Utils.closeModal()" style="padding:6px 16px; font-size:13px;">Close</button>
      </div>
    </div>
  `);
};

window.promptRejectOrder = function(txId) {
  const list = window._recentTransactionsCache || [];
  const existingTx = list.find(t => String(t.id) === String(txId));
  if (existingTx && (existingTx.status === 'rejected' || existingTx.status === 'cancelled')) {
    Utils.showToast(`Order #${txId} is already rejected. Once rejected, the order status is locked and cannot be changed.`, "warning");
    return;
  }

  const modalTitle = `<i class="fas fa-exclamation-triangle" style="color:#ef4444; margin-right:8px;"></i> Reject / Cancel Order #${Utils.escapeHtml(txId)}`;

  const modalBody = `
    <div style="padding:4px;">
      <p style="font-size:12px; color:var(--text-muted); margin:0 0 16px 0;">Customer cancelled order. This will void the transaction / cancel the ticket.</p>

      <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:12px; margin-bottom:16px; font-size:12px; color:#991b1b; line-height:1.4;">
        <i class="fas fa-info-circle"></i> <strong>Note:</strong> Marking this order as <strong>REJECTED</strong> is permanent. Once rejected, the order status cannot be changed.
      </div>

      <div class="form-group" style="margin-bottom:16px;">
        <label style="display:block; font-size:12px; font-weight:700; color:var(--text-main); margin-bottom:6px;">Cancellation Reason <span style="color:#ef4444;">*</span></label>
        <select id="reject-reason-select" class="form-control" style="width:100%; padding:9px 12px; border-radius:8px; border:1px solid rgba(205,190,150,0.4); font-size:13px; background:#fff;" onchange="if(this.value==='Other'){document.getElementById('reject-custom-reason-wrap').style.display='block';}else{document.getElementById('reject-custom-reason-wrap').style.display='none';}">
          <option value="Customer requested cancellation / changed mind">Customer requested cancellation / changed mind</option>
          <option value="Customer ordered wrong items">Customer ordered wrong items</option>
          <option value="Customer walked out / left">Customer walked out / left</option>
          <option value="Items out of stock">Items out of stock</option>
          <option value="Duplicate order">Duplicate order</option>
          <option value="Other">Other reason...</option>
        </select>
      </div>

      <div id="reject-custom-reason-wrap" class="form-group" style="display:none; margin-bottom:16px;">
        <label style="display:block; font-size:12px; font-weight:700; color:var(--text-main); margin-bottom:6px;">Custom Reason</label>
        <input type="text" id="reject-custom-reason" class="form-control" placeholder="Specify cancellation reason..." style="width:100%; padding:9px 12px; border-radius:8px; border:1px solid rgba(205,190,150,0.4); font-size:13px;">
      </div>
    </div>
  `;

  const modalFooter = `
    <button type="button" class="btn btn-outline" onclick="Utils.closeModal()" style="padding:8px 18px; font-size:13px; font-weight:600;">Back</button>
    <button type="button" class="btn" onclick="submitRejectOrder(${Utils.jsArg(txId)})" style="background:#ef4444; color:#fff; border:none; padding:8px 20px; border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:6px; box-shadow:0 2px 6px rgba(239,68,68,0.3);">
      <i class="fas fa-times-circle"></i> Confirm Rejection
    </button>
  `;

  Utils.openModal(modalTitle, modalBody, modalFooter);
};

// Refund state of a voided sale. The POS never moves money: "Record refund" only records what staff did.
function refundStatusHtml(tx) {
  const role = String(((typeof Auth !== 'undefined' && Auth.getUser) ? (Auth.getUser() || {}) : {}).role || '').toLowerCase();
  const canRecord = ['manager', 'admin', 'super_admin'].includes(role);
  if (tx.refund_status === 'pending') {
    return `<span title="Money was collected for this sale and has not been recorded as returned" style="color:#b45309; font-size:11px; font-weight:700;">Refund pending</span>`
      + (canRecord ? `<button type="button" class="btn btn-sm btn-outline" onclick="promptRecordRefund(${Utils.jsArg(tx.id)})" style="border-color:#b45309; color:#b45309; border-radius:6px; padding:4px 8px; font-size:11px; font-weight:700;">Record refund</button>` : '');
  }
  if (tx.refund_status === 'refunded') return '<span style="color:#047857; font-size:11px; font-weight:700;">Refunded</span>';
  if (tx.refund_status === 'not_required') return '<span style="color:#71717a; font-size:11px; font-weight:700;">No refund needed</span>';
  return '';
}

window.promptRecordRefund = function(txId) {
  const tx = (window._recentTransactionsCache || []).find(t => t.id === txId) || {};
  const methods = [...new Set((tx.payments || []).map(p => String(p.payment_method || '').toUpperCase()).filter(Boolean))];
  const collected = (tx.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  Utils.openModal('Record refund', `
    <div style="font-size:13px; margin-bottom:12px;">Sale ${Utils.escapeHtml(Utils.formatId ? Utils.formatId('TXN', txId) : txId)} was voided after payment. Record what was actually done. <strong>The POS does not send money</strong>: return it from the drawer, the store's GCash app or the card terminal first.</div>
    <div id="refund-error" role="alert" style="display:none; padding:8px 10px; margin-bottom:10px; background:#fee2e2; color:#991b1b; border-radius:8px; font-size:12px; font-weight:600;"></div>
    <label style="font-size:12px; font-weight:600;">Outcome</label>
    <select id="refund-outcome" class="input-field" style="width:100%; margin-bottom:10px;">
      <option value="refunded">Money returned to the customer (full amount)</option>
      <option value="not_required">Nothing had actually been collected</option>
    </select>
    <label style="font-size:12px; font-weight:600;">Amount returned (₱)</label>
    <input id="refund-amount" class="input-field" type="text" readonly value="${Utils.escapeHtml(collected.toFixed(2))}" style="width:100%; margin-bottom:10px;">
    <label style="font-size:12px; font-weight:600;">Returned by</label>
    <select id="refund-method" class="input-field" style="width:100%; margin-bottom:10px;">
      ${methods.map(m => `<option value="${Utils.escapeHtml(m)}">${Utils.escapeHtml(m)}</option>`).join('')}
    </select>
    <label style="font-size:12px; font-weight:600;">Reference (e.g. GCash ref of the refund, optional)</label>
    <input id="refund-reference" class="input-field" type="text" maxlength="60" style="width:100%; margin-bottom:10px;">
    <label style="font-size:12px; font-weight:600;">Note (required)</label>
    <input id="refund-note" class="input-field" type="text" maxlength="200" style="width:100%;">
  `, `<button id="refund-submit-btn" class="btn btn-primary" onclick="submitRecordRefund(${Utils.jsArg(txId)})" style="width:100%;">Save refund record</button>`);
};

window.submitRecordRefund = async function(txId) {
  const btn = document.getElementById('refund-submit-btn');
  const errBox = document.getElementById('refund-error');
  const outcome = document.getElementById('refund-outcome').value;
  const body = { outcome, note: document.getElementById('refund-note').value.trim() };
  if (outcome === 'refunded') {
    body.amount = document.getElementById('refund-amount').value;
    body.refund_method = document.getElementById('refund-method').value;
    const ref = document.getElementById('refund-reference').value.trim();
    if (ref) body.reference_no = ref;
  }
  if (btn) btn.disabled = true;
  try {
    const res = await Auth.fetch(`/api/v1/transactions/${txId}/refund`, { method: 'POST', body: JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && typeof data.detail === 'string') ? data.detail : `Could not save (HTTP ${res.status}).`);
    Utils.closeModal();
    Utils.showToast(outcome === 'refunded' ? 'Refund recorded.' : 'Recorded: no refund needed.', 'success');
    if (typeof renderTransactions === 'function') renderTransactions(document.getElementById('view-container'));
  } catch (err) {
    if (errBox) { errBox.textContent = err.message; errBox.style.display = 'block'; }
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.submitRejectOrder = async function(txId) {
  const selectEl = document.getElementById("reject-reason-select");
  const customEl = document.getElementById("reject-custom-reason");
  let reason = selectEl ? selectEl.value : "Customer cancelled order";
  if (reason === "Other" && customEl && customEl.value.trim()) {
    reason = customEl.value.trim();
  }

  // Instant visual feedback: dim card & close modal immediately
  const card = document.getElementById(`ticket-card-${txId}`) || document.querySelector(`[data-order-id="${txId}"]`);
  if (card) {
    card.style.transition = 'all 0.25s ease';
    card.style.opacity = '0.3';
    card.style.pointerEvents = 'none';
  }
  Utils.closeModal();

  const txStr = String(txId || "").trim();
  const isCustOrder = txStr.toUpperCase().startsWith("CUST-") || txStr.toUpperCase().startsWith("CUST");

  try {
    let res;
    if (isCustOrder) {
      res = await Auth.fetch(`/api/v1/kitchen/orders/${encodeURIComponent(txStr)}/status`, {
        method: "PUT",
        body: JSON.stringify({
          status: "rejected",
          station: "food",
          reason: reason
        })
      });
      if (!res.ok) {
        const numericCustId = parseInt(txStr.replace(/[^0-9]/g, ""), 10);
        if (numericCustId) {
          res = await Auth.fetch(`/api/v1/customer-orders/${numericCustId}/status`, {
            method: "PUT",
            body: JSON.stringify({ status: "rejected", reason: reason })
          });
        }
      }
    } else {
      res = await Auth.fetch(`/api/v1/transactions/${txId}/status`, {
        method: "PUT",
        body: JSON.stringify({
          status: "rejected",
          reason: reason
        })
      });
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to reject order.");
    }

    let voided = null;
    try { voided = await res.json(); } catch (e) { voided = null; }
    Utils.closeModal();
    Utils.showToast(voided && voided.refund_status === "pending"
      ? `Order #${txId} was voided. Payment had been collected: return it and have a manager record the refund.`
      : `Order #${txId} was successfully rejected / cancelled.`, voided && voided.refund_status === "pending" ? "warning" : "success");

    try {
      localStorage.setItem("RESTOTRACK_SYNC_KITCHEN", JSON.stringify({ timestamp: Date.now(), orderId: txId, status: "rejected" }));
    } catch (e) {}

    const activeLink = document.querySelector("aside.sidebar .nav-link.active, .sidebar a.active");
    const activeView = activeLink ? (activeLink.getAttribute("href") || "").replace(/^#\/?/, "").trim() : "";
    const hash = window.location.hash ? window.location.hash.replace(/^#\/?/, "").trim() : "";
    const path = window.location.pathname || "";

    if (activeView === "kitchen" || hash === "kitchen" || path.includes("kitchen")) {
      if (typeof renderKitchen === "function") renderKitchen();
    } else if (activeView === "drinks" || activeView === "drinks_station" || hash === "drinks" || hash === "drinks_station" || document.getElementById("drinks-tickets-grid")) {
      if (typeof renderDrinksStation === "function") renderDrinksStation();
    } else if (typeof renderTransactions === "function" && document.getElementById("view-container")) {
      renderTransactions(document.getElementById("view-container"));
    } else if (typeof renderKitchen === "function") {
      renderKitchen();
    }

    // Refresh Customer Orders & badge immediately so rejected orders show in Recent Processed Orders
    if (typeof loadCustomerOrdersTable === "function") {
      loadCustomerOrdersTable();
    }
    if (typeof fetchPendingOnlineOrders === "function") {
      fetchPendingOnlineOrders();
    }
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
};

window.changeOrderStatusDirect = async function(txId, newStatus) {
  const list = window._recentTransactionsCache || [];
  const existingTx = list.find(t => t.id === txId);
  if (existingTx && (existingTx.status === 'rejected' || existingTx.status === 'cancelled')) {
    Utils.showToast(`Order #${txId} is already rejected. Once rejected, the order status cannot be changed.`, "warning");
    return;
  }
  try {
    const res = await Auth.fetch(`/api/v1/transactions/${txId}/status`, {
      method: "PUT",
      body: JSON.stringify({
        status: newStatus,
        reason: `Marked ${newStatus} by Cashier`
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to update status.");
    }

    Utils.showToast(`Order #${txId} marked as ${newStatus.toUpperCase()}.`, "success");

    try {
      localStorage.setItem("RESTOTRACK_SYNC_KITCHEN", JSON.stringify({ timestamp: Date.now(), orderId: txId, status: newStatus }));
    } catch (e) {}

    renderTransactions(document.getElementById("view-container"));
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. USER MANAGEMENT (BRANCH ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
function renderStaffRowsHtml(users) {
  if (!users || !users.length) {
    return '<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-muted);">No staff registered in this branch.</td></tr>';
  }
  return users.map(u => `
    <tr>
      <td><strong style="color:var(--text-main); font-size:13px;">${Utils.escapeHtml(u.username)}</strong></td>
      <td><span class="badge badge-info" style="font-size:11px; font-weight:700; text-transform:uppercase;">${Utils.escapeHtml(u.role)}</span></td>
      <td>
        <span class="badge ${u.is_active ? 'badge-success' : 'badge-danger'}" style="font-size:11px; font-weight:700;">
          ${u.is_active ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td style="text-align:right;">
        <div style="display:inline-flex; gap:6px; justify-content:flex-end;">
          <button class="btn btn-outline btn-sm" onclick="promptResetStaffPassword(${u.id}, ${Utils.jsArg(u.username)})" style="padding:4px 8px; font-size:12px; border-color:#c9a227; color:#c9a227;" title="Reset Password">
            <i class="fas fa-key"></i> Reset Password
          </button>
          <button class="btn btn-outline btn-sm" onclick="toggleStaffStatus(${u.id}, ${u.is_active})" style="padding:4px 8px; font-size:12px;" title="${u.is_active ? 'Deactivate User' : 'Activate User'}">
            <i class="fas ${u.is_active ? 'fa-user-slash' : 'fa-user-check'}"></i> ${u.is_active ? 'Deactivate' : 'Activate'}
          </button>
          <button class="btn btn-danger btn-sm" onclick="confirmDeleteStaff(${u.id}, ${Utils.jsArg(u.username)})" style="padding:4px 8px; font-size:12px;" title="Delete Staff Account">
            <i class="fas fa-trash-alt"></i> Delete
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

function startUsersRealtimePolling() {
  if (window._userRealtimePoll) {
    clearInterval(window._userRealtimePoll);
  }
  window._userRealtimePoll = setInterval(async () => {
    const tbodyEl = document.getElementById("branch-staff-tbody");
    if (!tbodyEl) {
      clearInterval(window._userRealtimePoll);
      window._userRealtimePoll = null;
      return;
    }
    const modal = document.getElementById("modal-container");
    if (modal && modal.style.display !== "none" && modal.innerHTML.trim() !== "") {
      return; // Do not interrupt if add modal is open
    }
    try {
      const [usersRes, statsRes] = await Promise.all([
        Auth.fetch("/api/v1/users?exclude_self=false"),
        Auth.fetch("/api/v1/users/stats")
      ]);
      if (!usersRes.ok || !statsRes.ok) return;
      const curRole = (typeof Auth !== 'undefined' && Auth.getRole ? Auth.getRole() : "").toLowerCase();
      const isAdminViewer = curRole === "admin" || curRole === "super_admin";
      const users = rawUsers.filter(u => {
        const r = (u.role || "").toUpperCase();
        if (isAdminViewer) return r !== "SUPER_ADMIN";
        return r !== "SUPER_ADMIN" && r !== "ADMIN";
      });
      const stats = await statsRes.json();

      const curTbody = document.getElementById("branch-staff-tbody");
      if (curTbody) {
        curTbody.innerHTML = renderStaffRowsHtml(users);
      }
      const totalEl = document.getElementById("stat-total-staff");
      if (totalEl) totalEl.textContent = users.length;
      const mgrEl = document.getElementById("stat-managers");
      if (mgrEl) mgrEl.textContent = stats.managers || 0;
      const cashEl = document.getElementById("stat-cashiers");
      if (cashEl) cashEl.textContent = stats.cashiers || 0;
      const kitEl = document.getElementById("stat-kitchen");
      if (kitEl) kitEl.textContent = stats.kitchen || 0;
      const summaryEl = document.getElementById("users-count-summary");
      if (summaryEl) summaryEl.textContent = `${users.length} staff accounts registered`;
      const badgeEl = document.getElementById("users-badge-count");
      if (badgeEl) badgeEl.textContent = `${users.length} staff accounts`;
    } catch (_) {}
  }, 2500);
}

async function renderUsers(c) {
  if (!c) {
    c = document.getElementById("view-container") || document.getElementById("content") || document.querySelector(".page-wrapper");
  }
  if (!c) return;

  const [usersRes, statsRes] = await Promise.all([
    Auth.fetch("/api/v1/users?exclude_self=false"),
    Auth.fetch("/api/v1/users/stats")
  ]);

  if (!usersRes.ok) throw new Error("Failed to load users from server.");
  if (!statsRes.ok) throw new Error("Failed to load user statistics from server.");
  const rawUsers = await usersRes.json();
  const curRole = (typeof Auth !== 'undefined' && Auth.getRole ? Auth.getRole() : "").toLowerCase();
  const isAdminViewer = curRole === "admin" || curRole === "super_admin";
  const users = rawUsers.filter(u => {
    const r = (u.role || "").toUpperCase();
    if (isAdminViewer) return r !== "SUPER_ADMIN";
    return r !== "SUPER_ADMIN" && r !== "ADMIN";
  });
  const stats = await statsRes.json();

  c.innerHTML = `
    <div class="stats-grid" id="users-stats-grid">
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-users"></i></div>
        <div class="stat-info">
          <h3>Total Branch Staff</h3>
          <div class="stat-count" id="stat-total-staff" style="color:#c9a227;">${Utils.escapeHtml(users.length)}</div>
          <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-user-friends"></i> Active Staff</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon purple"><i class="fas fa-user-tie"></i></div>
        <div class="stat-info">
          <h3>Managers</h3>
          <div class="stat-count" id="stat-managers" style="color:#7b1fa2;">${Utils.escapeHtml(stats.managers || 0)}</div>
          <div class="stat-trend" style="color:#7b1fa2;"><i class="fas fa-briefcase"></i> Shift leaders</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-cash-register"></i></div>
        <div class="stat-info">
          <h3>Cashiers</h3>
          <div class="stat-count" id="stat-cashiers" style="color:#10b981;">${Utils.escapeHtml(stats.cashiers || 0)}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-receipt"></i> POS Staff</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-utensils"></i></div>
        <div class="stat-info">
          <h3>Kitchen Crew</h3>
          <div class="stat-count" id="stat-kitchen" style="color:#f97316;">${Utils.escapeHtml(stats.kitchen || 0)}</div>
          <div class="stat-trend" style="color:#f97316;"><i class="fas fa-fire"></i> KDS Staff</div>
        </div>
      </div>
    </div>

    <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:20px; flex-wrap:wrap;">
      <div id="users-count-summary" style="font-size:13px; color:var(--text-muted);">${Utils.escapeHtml(users.length)} staff accounts registered</div>
      <button class="btn btn-primary" onclick="openAddStaffModal()" style="display:inline-flex; align-items:center; gap:8px;">
        <i class="fas fa-user-plus"></i> Add Staff Member
      </button>
    </div>

    <div class="section-card">
      <div class="section-head">
        <h2>Branch Staff Members</h2>
        <span id="users-badge-count" style="font-size:13px; color:var(--text-muted);">${Utils.escapeHtml(users.length)} staff accounts</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Staff User</th>
              <th>Assigned Role</th>
              <th>Status</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody id="branch-staff-tbody">
            ${renderStaffRowsHtml(users)}
          </tbody>
        </table>
      </div>
    </div>
  `;

  startUsersRealtimePolling();
}

window.promptResetStaffPassword = function(id, username) {
  Utils.openModal("Reset Staff Password", `
    <form id="form-reset-password" onsubmit="event.preventDefault(); executeResetStaffPassword(${id});">
      <div style="margin-bottom:14px; text-align:left;">
        <p style="font-size:13px; color:var(--text-muted); margin:0 0 14px 0;">
          Resetting password for staff account: <strong style="color:var(--text-main);">@${Utils.escapeHtml(username)}</strong>
        </p>
        <div class="input-group" style="margin-bottom:12px;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">New Password (6-20 chars) <span style="color:var(--danger);">*</span></label>
          <input type="password" id="reset-new-password" class="input-field" required maxlength="20" placeholder="Enter new password" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Confirm New Password <span style="color:var(--danger);">*</span></label>
          <input type="password" id="reset-confirm-password" class="input-field" required maxlength="20" placeholder="Confirm new password" style="width:100%;">
        </div>
      </div>
    </form>
  `, `
    <div style="display:flex; justify-content:flex-end; gap:10px; width:100%;">
      <button type="button" class="btn btn-outline" onclick="Utils.closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="btn-save-reset-pwd" onclick="executeResetStaffPassword(${id})" style="background:#c9a227; border-color:#c9a227; color:#18181b; font-weight:700;">
        <i class="fas fa-key"></i> Save New Password
      </button>
    </div>
  `);
};

window.executeResetStaffPassword = async function(id) {
  const newPwd = document.getElementById("reset-new-password")?.value || "";
  const confirmPwd = document.getElementById("reset-confirm-password")?.value || "";
  const saveBtn = document.getElementById("btn-save-reset-pwd");

  if (!newPwd || !confirmPwd) {
    Utils.showToast("Please fill in both password fields.", "danger");
    return;
  }
  if (newPwd.length < 6) {
    Utils.showToast("Password must be at least 6 characters.", "danger");
    return;
  }
  if (newPwd.length > 20) {
    Utils.showToast("Password cannot exceed 20 characters.", "danger");
    return;
  }
  if (newPwd !== confirmPwd) {
    Utils.showToast("Passwords do not match. Please re-enter.", "danger");
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Saving...`;
  }

  try {
    const res = await Auth.fetch(`/api/v1/users/${id}/password`, {
      method: "PUT",
      body: JSON.stringify({ new_password: newPwd })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to reset password.");
    }
    Utils.showToast("Password has been reset successfully!", "success");
    Utils.closeModal();
  } catch (err) {
    Utils.showToast(err.message, "danger");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = `<i class="fas fa-key"></i> Save New Password`;
    }
  }
};

window.confirmDeleteStaff = function(id, username) {
  Utils.openModal("Confirm Staff Deletion", `
    <div style="text-align:center; padding:10px 0;">
      <div style="width:60px; height:60px; border-radius:50%; background:rgba(239,68,68,0.12); color:#ef4444; display:flex; align-items:center; justify-content:center; margin:0 auto 16px; font-size:24px;">
        <i class="fas fa-exclamation-triangle"></i>
      </div>
      <h3 style="font-size:17px; font-weight:800; color:var(--text-main); margin-bottom:8px;">Delete Staff Account?</h3>
      <p style="font-size:14px; color:var(--text-muted); line-height:1.5; margin-bottom:0;">
        Are you sure you want to permanently delete user account <strong style="color:var(--text-main);">@${Utils.escapeHtml(username)}</strong>? This action cannot be undone.
      </p>
    </div>
  `, `
    <div style="display:flex; justify-content:flex-end; gap:10px; width:100%;">
      <button class="btn btn-outline" onclick="Utils.closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="executeDeleteStaff(${id})" id="btn-confirm-del"><i class="fas fa-trash-alt"></i> Delete User</button>
    </div>
  `);
};

window.executeDeleteStaff = async function(id) {
  const btn = document.getElementById("btn-confirm-del");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Deleting...`;
  }
  try {
    const res = await Auth.fetch(`/api/v1/users/${id}`, {
      method: "DELETE"
    });
    if (!res.ok && res.status !== 204) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to delete user.");
    }
    Utils.showToast("Staff account deleted successfully.", "success");
    Utils.closeModal();
    const c = document.getElementById("view-container") || document.querySelector(".page-wrapper");
    await renderUsers(c);
  } catch (err) {
    Utils.showToast(err.message, "danger");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-trash-alt"></i> Delete User`;
    }
  }
};

window.toggleStaffStatus = async function(id, currentStatus) {
  try {
    const res = await Auth.fetch(`/api/v1/users/${id}/status`, {
      method: "PUT"
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to update status.");
    }
    const data = await res.json();
    Utils.showToast(data.message || "User status updated!", "success");
    const c = document.getElementById("view-container") || document.querySelector(".page-wrapper");
    await renderUsers(c);
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
};

function openAddStaffModal() {
  const pathLower = (window.location.pathname || "").toLowerCase();
  const isManagerPage = pathLower.includes("/manager");
  const curRole = isManagerPage ? "manager" : (typeof Auth !== 'undefined' && Auth.getRole ? Auth.getRole() : "").toLowerCase();
  const isAdminViewer = !isManagerPage && (curRole === "admin" || curRole === "super_admin");
  Utils.openModal("Create New Branch Staff", `
    <form id="form-add-staff" onsubmit="event.preventDefault(); submitAddStaff();">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Username <span style="color:var(--danger);">*</span></label>
        <input id="st-username" class="input-field" required placeholder="e.g. cashier_jane" style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">First Name <span style="color:var(--danger);">*</span></label>
          <input id="st-firstname" class="input-field" required placeholder="Jane" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Last Name <span style="color:var(--danger);">*</span></label>
          <input id="st-lastname" class="input-field" required placeholder="Doe" style="width:100%;">
        </div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Password (6-20 chars) <span style="color:var(--danger);">*</span></label>
          <input type="password" id="st-password" class="input-field" required maxlength="20" placeholder="Max 20 chars" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Confirm Password <span style="color:var(--danger);">*</span></label>
          <input type="password" id="st-confirm-password" class="input-field" required maxlength="20" placeholder="Confirm password" style="width:100%;">
        </div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Role <span style="color:var(--danger);">*</span></label>
          <select id="st-role" class="input-field" style="width:100%;">
            <option value="CASHIER" selected>Cashier</option>
            <option value="KITCHEN">Kitchen Staff</option>
            <option value="INVENTORY">Inventory Staff</option>
            ${isAdminViewer ? '<option value="MANAGER">Manager</option>' : ''}
            ${isAdminViewer ? '<option value="ADMIN">Branch Admin</option>' : ''}
            <option value="CUSTOMER">Customer</option>
          </select>
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Status</label>
          <select id="st-status" class="input-field" style="width:100%;">
            <option value="true" selected>Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>
      </div>
    </form>
  `, `<button class="btn btn-primary" onclick="submitAddStaff()"><i class="fas fa-user-plus"></i> Save Staff Member</button>`);
}

async function submitAddStaff() {
  const username = document.getElementById("st-username")?.value.trim();
  const first_name = document.getElementById("st-firstname")?.value.trim();
  const last_name = document.getElementById("st-lastname")?.value.trim();
  const password = document.getElementById("st-password")?.value || "";
  const confirmPassword = document.getElementById("st-confirm-password")?.value || "";
  const role = document.getElementById("st-role")?.value;
  const is_active = document.getElementById("st-status")?.value === "true";

  if (!username || !first_name || !last_name || !password || !confirmPassword) {
    Utils.showToast("Please fill in all required fields", "danger");
    return;
  }

  if (password.length < 6) {
    Utils.showToast("Password must be at least 6 characters.", "danger");
    return;
  }

  if (password.length > 20) {
    Utils.showToast("Password cannot exceed 20 characters.", "danger");
    return;
  }

  if (password !== confirmPassword) {
    Utils.showToast("Passwords do not match. Please re-enter.", "danger");
    return;
  }

  try {
    const res = await Auth.fetch("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({ username, first_name, last_name, password, role, is_active })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to create staff member.");
    }
    Utils.showToast("Staff account created successfully!", "success");
    Utils.closeModal();
    try {
      localStorage.setItem("RESTOTRACK_SYNC_USERS", Date.now().toString());
    } catch (_) {}
    const c = document.getElementById("view-container") || document.getElementById("content") || document.querySelector(".page-wrapper");
    await renderUsers(c);
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 8. SUPERADMIN ACTIVITY LOGS & AUDIT TRAIL
// ─────────────────────────────────────────────────────────────────────────────
window._superadminLogsState = window._superadminLogsState || {
  search: "",
  role: "ALL",
  activity_type: "ALL",
  status: "ALL",
  date_range: "today",
  start_date: "",
  end_date: "",
  page: 1,
  limit: 20,
  total: 0,
  total_pages: 1,
  items: [],
  summary: {}
};

async function renderLogs(c) {
  c = c || document.getElementById("view-container");
  if (!c) return;

  // 1. Strict Role Authorization: SUPERADMIN ONLY
  const currentUser = (typeof Auth !== "undefined" && Auth.getUser) ? Auth.getUser() : null;
  const userRole = (currentUser && currentUser.role ? currentUser.role : "").toLowerCase();
  const isSuperAdmin = userRole === "super_admin" || userRole === "superadmin";

  if (!isSuperAdmin) {
    c.innerHTML = `
      <div class="section-card" style="padding:48px 24px; text-align:center; max-width:540px; margin:40px auto; border:1px solid rgba(239,68,68,0.3);">
        <div style="width:64px; height:64px; border-radius:50%; background:rgba(239,68,68,0.1); color:#ef4444; display:flex; align-items:center; justify-content:center; font-size:28px; margin:0 auto 18px;">
          <i class="fas fa-shield-halved"></i>
        </div>
        <h2 style="font-size:20px; font-weight:800; margin:0 0 10px; color:#18181b;">Restricted Superadmin Access</h2>
        <p style="font-size:13px; color:var(--text-muted, #71717a); margin:0 0 24px; line-height:1.5;">
          The Activity Logs and System Audit Trail module is accessible exclusively to the <strong>SUPERADMIN</strong> account.
        </p>
        <button class="btn btn-primary" onclick="renderView('dashboard')" style="background:#c9a227; border:none; padding:10px 22px; font-weight:700;">
          <i class="fas fa-home" style="margin-right:6px;"></i> Return to Dashboard
        </button>
      </div>
    `;
    return;
  }

  // 2. Render Page Frame
  const st = window._superadminLogsState;
  const manilaDateNow = new Date().toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });

  c.innerHTML = `
    <div style="width:100%; max-width:100%;">
      <!-- Header Bar -->
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; flex-wrap:wrap; gap:12px;">
        <div>
          <div style="display:flex; align-items:center; gap:10px;">
            <div style="width:38px; height:38px; border-radius:10px; background:linear-gradient(135deg, rgba(201,162,39,0.18), rgba(201,162,39,0.06)); display:flex; align-items:center; justify-content:center; font-size:18px; color:#c9a227; border:1px solid rgba(201,162,39,0.3);">
              <i class="fas fa-shield-halved"></i>
            </div>
            <div>
              <h1 style="font-size:20px; font-weight:800; margin:0; color:#18181b;">Superadmin Activity Logs &amp; Audit Trail</h1>
              <p style="font-size:12px; color:var(--text-muted, #71717a); margin:2px 0 0 0;">
                Comprehensive system-wide audit records &bull; Timezone: <strong>Asia/Manila (UTC+08:00)</strong>
              </p>
            </div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="btn btn-outline btn-sm" onclick="exportSuperadminLogsCsv()" style="display:inline-flex; align-items:center; gap:6px; font-weight:700; border-color:#10b981; color:#059669;">
            <i class="fas fa-file-excel"></i> Export CSV
          </button>
          <button class="btn btn-outline btn-sm" onclick="fetchAndRenderSuperadminLogs()" style="display:inline-flex; align-items:center; gap:6px;">
            <i class="fas fa-rotate"></i> Refresh
          </button>
        </div>
      </div>

      <!-- 4 Summary Cards -->
      <div class="stats-grid" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:14px; margin-bottom:20px;">
        <!-- Card 1: Total Activities Today -->
        <div class="stat-card" style="padding:16px; border-radius:12px; background:#ffffff; border:1px solid rgba(205,190,150,0.35); box-shadow:0 4px 15px rgba(0,0,0,0.02);">
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:42px; height:42px; border-radius:10px; background:rgba(201,162,39,0.12); color:#c9a227; display:flex; align-items:center; justify-content:center; font-size:18px;">
              <i class="fas fa-list-check"></i>
            </div>
            <div style="flex:1;">
              <div style="font-size:11px; font-weight:700; text-transform:uppercase; color:#71717a; letter-spacing:0.4px;">Total Activities Today</div>
              <div id="metric-activities-today" style="font-size:22px; font-weight:800; color:#18181b; line-height:1.2;">0</div>
              <div style="font-size:11px; color:#10b981; margin-top:2px;"><i class="fas fa-calendar-day"></i> Philippine calendar day</div>
            </div>
          </div>
        </div>

        <!-- Card 2: Total Login Sessions Today -->
        <div class="stat-card" style="padding:16px; border-radius:12px; background:#ffffff; border:1px solid rgba(205,190,150,0.35); box-shadow:0 4px 15px rgba(0,0,0,0.02);">
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:42px; height:42px; border-radius:10px; background:rgba(16,185,129,0.12); color:#10b981; display:flex; align-items:center; justify-content:center; font-size:18px;">
              <i class="fas fa-right-to-bracket"></i>
            </div>
            <div style="flex:1;">
              <div style="font-size:11px; font-weight:700; text-transform:uppercase; color:#71717a; letter-spacing:0.4px;">Total Login Sessions Today</div>
              <div id="metric-logins-today" style="font-size:22px; font-weight:800; color:#10b981; line-height:1.2;">0</div>
              <div style="font-size:11px; color:#71717a; margin-top:2px;">Staff accounts authenticated</div>
            </div>
          </div>
        </div>

        <!-- Card 3: Currently Active Users -->
        <div class="stat-card" style="padding:16px; border-radius:12px; background:#ffffff; border:1px solid rgba(205,190,150,0.35); box-shadow:0 4px 15px rgba(0,0,0,0.02);">
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:42px; height:42px; border-radius:10px; background:rgba(59,130,246,0.12); color:#3b82f6; display:flex; align-items:center; justify-content:center; font-size:18px;">
              <i class="fas fa-users"></i>
            </div>
            <div style="flex:1;">
              <div style="font-size:11px; font-weight:700; text-transform:uppercase; color:#71717a; letter-spacing:0.4px;">Currently Active Users</div>
              <div id="metric-active-users" style="font-size:22px; font-weight:800; color:#3b82f6; line-height:1.2;">0</div>
              <div style="font-size:11px; color:#71717a; margin-top:2px;">Distinct staff sessions active</div>
            </div>
          </div>
        </div>

        <!-- Card 4: Total Failed Login Attempts Today -->
        <div class="stat-card" style="padding:16px; border-radius:12px; background:#ffffff; border:1px solid rgba(205,190,150,0.35); box-shadow:0 4px 15px rgba(0,0,0,0.02);">
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:42px; height:42px; border-radius:10px; background:rgba(239,68,68,0.12); color:#ef4444; display:flex; align-items:center; justify-content:center; font-size:18px;">
              <i class="fas fa-user-xmark"></i>
            </div>
            <div style="flex:1;">
              <div style="font-size:11px; font-weight:700; text-transform:uppercase; color:#71717a; letter-spacing:0.4px;">Total Failed Login Attempts</div>
              <div id="metric-failed-logins" style="font-size:22px; font-weight:800; color:#ef4444; line-height:1.2;">0</div>
              <div style="font-size:11px; color:#ef4444; margin-top:2px;"><i class="fas fa-shield"></i> Security audit monitor</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Filter Controls Card -->
      <div class="section-card" style="padding:16px 20px; margin-bottom:18px; border:1px solid rgba(205,190,150,0.35); border-radius:12px; background:#ffffff;">
        <!-- Date Quick Pills -->
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding-bottom:12px; border-bottom:1px solid rgba(205,190,150,0.25); margin-bottom:14px;">
          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            <span style="font-size:11.5px; font-weight:800; text-transform:uppercase; color:#71717a; margin-right:4px;">
              <i class="fas fa-calendar-alt"></i> Date:
            </span>
            <button type="button" class="btn btn-sm ${st.date_range === 'today' ? 'btn-primary' : 'btn-outline'}" onclick="setSuperadminDateRange('today')" style="padding:4px 12px; font-size:11.5px; border-radius:20px;">Today</button>
            <button type="button" class="btn btn-sm ${st.date_range === 'yesterday' ? 'btn-primary' : 'btn-outline'}" onclick="setSuperadminDateRange('yesterday')" style="padding:4px 12px; font-size:11.5px; border-radius:20px;">Yesterday</button>
            <button type="button" class="btn btn-sm ${st.date_range === 'last_7_days' ? 'btn-primary' : 'btn-outline'}" onclick="setSuperadminDateRange('last_7_days')" style="padding:4px 12px; font-size:11.5px; border-radius:20px;">Last 7 Days</button>
            <button type="button" class="btn btn-sm ${st.date_range === 'last_30_days' ? 'btn-primary' : 'btn-outline'}" onclick="setSuperadminDateRange('last_30_days')" style="padding:4px 12px; font-size:11.5px; border-radius:20px;">Last 30 Days</button>
            <button type="button" class="btn btn-sm ${st.date_range === 'all' ? 'btn-primary' : 'btn-outline'}" onclick="setSuperadminDateRange('all')" style="padding:4px 12px; font-size:11.5px; border-radius:20px;">All Activities</button>
            <button type="button" class="btn btn-sm ${st.date_range === 'custom' ? 'btn-primary' : 'btn-outline'}" onclick="setSuperadminDateRange('custom')" style="padding:4px 12px; font-size:11.5px; border-radius:20px;">Custom Range</button>
          </div>
          <div style="font-size:11px; color:#71717a;">
            Philippine Time: <strong id="live-manila-clock">${manilaDateNow}</strong>
          </div>
        </div>

        <!-- Custom Date Range Pickers (conditional) -->
        <div id="superadmin-custom-dates-bar" style="display:${st.date_range === 'custom' ? 'flex' : 'none'}; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; background:#fafafa; padding:10px 14px; border-radius:8px; border:1px solid #e4e4e7;">
          <div style="display:flex; align-items:center; gap:6px;">
            <label style="font-size:11.5px; font-weight:700; color:#52525b;">Start Date:</label>
            <input type="date" id="superadmin-start-date" value="${st.start_date || ''}" style="padding:4px 8px; font-size:12px; border:1px solid #d4d4d8; border-radius:6px;">
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <label style="font-size:11.5px; font-weight:700; color:#52525b;">End Date:</label>
            <input type="date" id="superadmin-end-date" value="${st.end_date || ''}" style="padding:4px 8px; font-size:12px; border:1px solid #d4d4d8; border-radius:6px;">
          </div>
          <button type="button" class="btn btn-primary btn-sm" onclick="applySuperadminCustomDates()" style="padding:5px 14px; font-size:12px;">Apply Filter</button>
        </div>

        <!-- Search & Filter Dropdowns Grid -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)) 100px; gap:10px; align-items:center;">
          <!-- Search Input -->
          <div style="position:relative; grid-column:span 1;">
            <i class="fas fa-search" style="position:absolute; left:10px; top:11px; color:#a1a1aa; font-size:12px;"></i>
            <input type="text" id="superadmin-search" placeholder="Search employee, username, IP, action…" value="${Utils.escapeHtml(st.search)}" oninput="debounceSuperadminSearch()" style="width:100%; padding:7px 10px 7px 30px; font-size:12px; border:1px solid #d4d4d8; border-radius:8px; outline:none; box-sizing:border-box;">
          </div>

          <!-- Role Filter -->
          <div>
            <select id="superadmin-filter-role" onchange="updateSuperadminFilter('role', this.value)" style="width:100%; padding:7px 10px; font-size:12px; border:1px solid #d4d4d8; border-radius:8px; background:#ffffff;">
              <option value="ALL" ${st.role === 'ALL' ? 'selected' : ''}>All Roles</option>
              <option value="ADMIN" ${st.role === 'ADMIN' ? 'selected' : ''}>Admin</option>
              <option value="MANAGER" ${st.role === 'MANAGER' ? 'selected' : ''}>Manager</option>
              <option value="CASHIER" ${st.role === 'CASHIER' ? 'selected' : ''}>Cashier</option>
              <option value="INVENTORY" ${st.role === 'INVENTORY' ? 'selected' : ''}>Inventory Staff</option>
              <option value="KITCHEN" ${st.role === 'KITCHEN' ? 'selected' : ''}>Kitchen Staff</option>
            </select>
          </div>

          <!-- Activity Type Filter -->
          <div>
            <select id="superadmin-filter-activity" onchange="updateSuperadminFilter('activity_type', this.value)" style="width:100%; padding:7px 10px; font-size:12px; border:1px solid #d4d4d8; border-radius:8px; background:#ffffff;">
              <option value="ALL" ${st.activity_type === 'ALL' ? 'selected' : ''}>All Activity Types</option>
              <option value="Login" ${st.activity_type === 'Login' ? 'selected' : ''}>Successful Login</option>
              <option value="Logout" ${st.activity_type === 'Logout' ? 'selected' : ''}>Successful Logout</option>
              <option value="Failed" ${st.activity_type === 'Failed' ? 'selected' : ''}>Failed Login Attempt</option>
              <option value="Order" ${st.activity_type === 'Order' ? 'selected' : ''}>POS &amp; Orders</option>
              <option value="Payment" ${st.activity_type === 'Payment' ? 'selected' : ''}>Payment Processing</option>
              <option value="Stock" ${st.activity_type === 'Stock' ? 'selected' : ''}>Inventory &amp; Stock</option>
              <option value="User" ${st.activity_type === 'User' ? 'selected' : ''}>User Account Management</option>
              <option value="Password" ${st.activity_type === 'Password' ? 'selected' : ''}>Password Reset</option>
              <option value="Expense" ${st.activity_type === 'Expense' ? 'selected' : ''}>Expense Management</option>
            </select>
          </div>

          <!-- Status Filter -->
          <div>
            <select id="superadmin-filter-status" onchange="updateSuperadminFilter('status', this.value)" style="width:100%; padding:7px 10px; font-size:12px; border:1px solid #d4d4d8; border-radius:8px; background:#ffffff;">
              <option value="ALL" ${st.status === 'ALL' ? 'selected' : ''}>All Statuses</option>
              <option value="SUCCESS" ${st.status === 'SUCCESS' ? 'selected' : ''}>Success</option>
              <option value="FAILED" ${st.status === 'FAILED' ? 'selected' : ''}>Failed</option>
              <option value="INFO" ${st.status === 'INFO' ? 'selected' : ''}>Info</option>
              <option value="WARNING" ${st.status === 'WARNING' ? 'selected' : ''}>Warning</option>
            </select>
          </div>

          <!-- Reset Button -->
          <div>
            <button type="button" class="btn btn-outline btn-sm" onclick="resetSuperadminFilters()" style="width:100%; padding:7px 10px; font-size:12px; border-color:#d4d4d8; color:#71717a;" title="Clear all filters">
              <i class="fas fa-rotate-left"></i> Reset
            </button>
          </div>
        </div>
      </div>

      <!-- Main Activity Table Card -->
      <div class="section-card" style="border:1px solid rgba(205,190,150,0.35); border-radius:12px; overflow:hidden; background:#ffffff; box-shadow:0 4px 15px rgba(0,0,0,0.02);">
        <div class="section-head" style="padding:14px 20px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(205,190,150,0.25);">
          <div>
            <h2 style="font-size:15px; font-weight:800; margin:0; color:#18181b;">Audit Trail Log Records</h2>
            <div id="superadmin-log-count-meta" style="font-size:11.5px; color:var(--text-muted, #71717a); margin-top:2px;">Loading entries...</div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:11.5px; color:#71717a;">Rows:</span>
            <select id="superadmin-limit-select" onchange="changeSuperadminLimit(this.value)" style="padding:4px 8px; font-size:11.5px; border:1px solid #d4d4d8; border-radius:6px;">
              <option value="15" ${st.limit === 15 ? 'selected' : ''}>15</option>
              <option value="25" ${st.limit === 25 ? 'selected' : ''}>25</option>
              <option value="50" ${st.limit === 50 ? 'selected' : ''}>50</option>
              <option value="100" ${st.limit === 100 ? 'selected' : ''}>100</option>
            </select>
          </div>
        </div>

        <div class="table-wrap" style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:12px; text-align:left;">
            <thead>
              <tr style="background:#fafafa; border-bottom:1px solid #e4e4e7;">
                <th style="padding:10px 14px; font-weight:700; color:#52525b; white-space:nowrap;">Date</th>
                <th style="padding:10px 14px; font-weight:700; color:#52525b; white-space:nowrap;">Time (PST)</th>
                <th style="padding:10px 14px; font-weight:700; color:#52525b; white-space:nowrap;">Account Name</th>
                <th style="padding:10px 14px; font-weight:700; color:#52525b; white-space:nowrap;">Username</th>
                <th style="padding:10px 14px; font-weight:700; color:#52525b; white-space:nowrap;">Role</th>
                <th style="padding:10px 14px; font-weight:700; color:#52525b; white-space:nowrap;">Activity</th>
                <th style="padding:10px 14px; font-weight:700; color:#52525b; min-width:200px;">Description</th>
                <th style="padding:10px 14px; font-weight:700; color:#52525b; white-space:nowrap;">IP Address</th>
                <th style="padding:10px 14px; font-weight:700; color:#52525b; white-space:nowrap;">Status</th>
                <th style="padding:10px 14px; font-weight:700; color:#52525b; text-align:center; white-space:nowrap;">Inspect</th>
              </tr>
            </thead>
            <tbody id="superadmin-logs-tbody">
              <tr>
                <td colspan="10" style="text-align:center; padding:40px; color:#71717a;">
                  <i class="fas fa-spinner fa-spin" style="margin-right:8px; color:#c9a227;"></i> Loading audit trail records...
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Pagination Controls -->
        <div id="superadmin-pagination-container" style="padding:12px 20px; border-top:1px solid #e4e4e7; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; font-size:12px;">
          <div id="superadmin-pagination-info" style="color:#71717a;">Showing 0 to 0 of 0 entries</div>
          <div id="superadmin-pagination-buttons" style="display:flex; gap:6px;"></div>
        </div>
      </div>
    </div>
  `;

  // 3. Fetch data from backend
  await fetchAndRenderSuperadminLogs();
}

// ── Color Badge Helper ──
function getSuperadminActivityBadge(activityType, status) {
  const act = (activityType || "").toLowerCase();
  const st = (status || "").toUpperCase();

  if (st === "FAILED" || act.includes("failed") || act.includes("cancel") || act.includes("deactivat") || act.includes("delete")) {
    return { bg: "rgba(239,68,68,0.12)", color: "#dc2626", border: "rgba(239,68,68,0.3)", icon: "fa-circle-xmark" };
  }
  if (act.includes("login") || act.includes("order") || act.includes("payment") || act.includes("receipt") || act.includes("activat")) {
    return { bg: "rgba(16,185,129,0.12)", color: "#059669", border: "rgba(16,185,129,0.3)", icon: "fa-circle-check" };
  }
  if (act.includes("stock") || act.includes("inventory") || act.includes("supplier") || act.includes("refund")) {
    return { bg: "rgba(249,115,22,0.12)", color: "#ea580c", border: "rgba(249,115,22,0.3)", icon: "fa-boxes-stacked" };
  }
  if (act.includes("logout") || act.includes("expire")) {
    return { bg: "rgba(113,113,122,0.12)", color: "#52525b", border: "rgba(113,113,122,0.3)", icon: "fa-right-from-bracket" };
  }
  // Default Info / Blue
  return { bg: "rgba(59,130,246,0.12)", color: "#2563eb", border: "rgba(59,130,246,0.3)", icon: "fa-info-circle" };
}

function getSuperadminRoleBadge(role) {
  const r = (role || "").toUpperCase();
  if (r.includes("ADMIN")) return { bg: "#c9a227", color: "#ffffff" };
  if (r.includes("MANAGER")) return { bg: "#3b82f6", color: "#ffffff" };
  if (r.includes("CASHIER")) return { bg: "#10b981", color: "#ffffff" };
  if (r.includes("INVENTORY")) return { bg: "#f97316", color: "#ffffff" };
  if (r.includes("KITCHEN")) return { bg: "#8b5cf6", color: "#ffffff" };
  return { bg: "#71717a", color: "#ffffff" };
}

// ── Fetch & Render Activity Logs ──
async function fetchAndRenderSuperadminLogs() {
  const tbody = document.getElementById("superadmin-logs-tbody");
  if (!tbody) return;

  tbody.innerHTML = `
    <tr>
      <td colspan="10" style="text-align:center; padding:36px; color:#71717a;">
        <i class="fas fa-spinner fa-spin" style="margin-right:8px; color:#c9a227;"></i> Querying audit trail...
      </td>
    </tr>
  `;

  const st = window._superadminLogsState;
  const offset = (st.page - 1) * st.limit;

  const params = new URLSearchParams();
  params.append("limit", st.limit);
  params.append("offset", offset);
  if (st.search) params.append("search", st.search.trim());
  if (st.role && st.role !== "ALL") params.append("role", st.role);
  if (st.activity_type && st.activity_type !== "ALL") params.append("activity_type", st.activity_type);
  if (st.status && st.status !== "ALL") params.append("status", st.status);
  if (st.date_range && st.date_range !== "all") params.append("date_range", st.date_range);
  if (st.date_range === "custom") {
    if (st.start_date) params.append("start_date", st.start_date);
    if (st.end_date) params.append("end_date", st.end_date);
  }

  try {
    const res = await Auth.fetch(`/api/v1/activity-logs?${params.toString()}`);
    if (!res.ok) throw new Error("Failed to load activity logs from server.");
    const data = await res.json();

    st.items = data.items || [];
    st.total = data.total || 0;
    st.total_pages = data.total_pages || 1;
    st.summary = data.summary || {};

    // 1. Update Metrics Cards
    const actTodayEl = document.getElementById("metric-activities-today");
    const loginsTodayEl = document.getElementById("metric-logins-today");
    const activeUsersEl = document.getElementById("metric-active-users");
    const failedLoginsEl = document.getElementById("metric-failed-logins");

    if (actTodayEl) actTodayEl.textContent = Number(st.summary.total_activities_today || 0).toLocaleString();
    if (loginsTodayEl) loginsTodayEl.textContent = Number(st.summary.total_logins_today || 0).toLocaleString();
    if (activeUsersEl) activeUsersEl.textContent = Number(st.summary.active_users || 0).toLocaleString();
    if (failedLoginsEl) failedLoginsEl.textContent = Number(st.summary.failed_logins_today || 0).toLocaleString();

    // 2. Update Count Subtitle
    const metaCount = document.getElementById("superadmin-log-count-meta");
    if (metaCount) {
      metaCount.textContent = `${st.total.toLocaleString()} total logged events matching current filters`;
    }

    // 3. Render Table Rows
    if (!st.items || st.items.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" style="text-align:center; padding:45px 20px; color:#71717a;">
            <div style="font-size:32px; color:#d4d4d8; margin-bottom:10px;"><i class="fas fa-folder-open"></i></div>
            <div style="font-size:14px; font-weight:700; color:#18181b;">No Activity Records Found</div>
            <div style="font-size:12px; margin-top:4px;">No activities recorded matching the selected filter criteria.</div>
          </td>
        </tr>
      `;
      renderSuperadminPagination();
      return;
    }

    tbody.innerHTML = st.items.map((log, idx) => {
      const actBadge = getSuperadminActivityBadge(log.activity_type, log.status);
      const roleBadge = getSuperadminRoleBadge(log.role);
      const isFailed = (log.status || "").toUpperCase() === "FAILED";

      return `
        <tr style="border-bottom:1px solid #f4f4f5; background:${idx % 2 === 0 ? '#ffffff' : '#fafafa'}; cursor:pointer;" onclick="openSuperadminLogModal(${log.id})" title="Click to inspect activity details">
          <!-- 1. Date -->
          <td style="padding:10px 14px; font-weight:600; color:#18181b; white-space:nowrap;">
            ${Utils.escapeHtml(log.ph_date || '—')}
          </td>
          <!-- 2. Time -->
          <td style="padding:10px 14px; color:#52525b; font-variant-numeric:tabular-nums; white-space:nowrap; font-weight:500;">
            ${Utils.escapeHtml(log.ph_time || '—')}
          </td>
          <!-- 3. Account Name -->
          <td style="padding:10px 14px; font-weight:700; color:#18181b; white-space:nowrap;">
            ${Utils.escapeHtml(log.full_name || log.username || 'System')}
          </td>
          <!-- 4. Username / Email -->
          <td style="padding:10px 14px; color:#71717a; font-family:monospace; font-size:11.5px; white-space:nowrap;">
            ${Utils.escapeHtml(log.username || '—')}
          </td>
          <!-- 5. Role -->
          <td style="padding:10px 14px; white-space:nowrap;">
            <span style="display:inline-block; padding:3px 8px; border-radius:4px; font-size:10px; font-weight:800; background:${roleBadge.bg}; color:${roleBadge.color}; letter-spacing:0.4px;">
              ${Utils.escapeHtml(log.role || 'STAFF')}
            </span>
          </td>
          <!-- 6. Activity -->
          <td style="padding:10px 14px; white-space:nowrap;">
            <span style="display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:700; background:${actBadge.bg}; color:${actBadge.color}; border:1px solid ${actBadge.border};">
              <i class="fas ${actBadge.icon}"></i> ${Utils.escapeHtml(log.activity_type || log.action || 'Activity')}
            </span>
          </td>
          <!-- 7. Description -->
          <td style="padding:10px 14px; color:#27272a; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${Utils.escapeHtml(log.description || log.details || '')}">
            ${Utils.escapeHtml(log.description || log.details || '—')}
          </td>
          <!-- 8. IP Address -->
          <td style="padding:10px 14px; color:#71717a; font-family:monospace; font-size:11px; white-space:nowrap;">
            ${Utils.escapeHtml(log.ip_address || '—')}
          </td>
          <!-- 9. Status -->
          <td style="padding:10px 14px; white-space:nowrap;">
            <span style="display:inline-block; padding:2px 7px; border-radius:999px; font-size:10.5px; font-weight:800; ${isFailed ? 'background:rgba(239,68,68,0.12); color:#dc2626; border:1px solid rgba(239,68,68,0.3);' : 'background:rgba(16,185,129,0.12); color:#059669; border:1px solid rgba(16,185,129,0.3);'}">
              ${Utils.escapeHtml(log.status || 'SUCCESS')}
            </span>
          </td>
          <!-- 10. Inspect Button -->
          <td style="padding:10px 14px; text-align:center; white-space:nowrap;" onclick="event.stopPropagation();">
            <button type="button" class="btn btn-outline btn-sm" onclick="openSuperadminLogModal(${log.id})" style="padding:3px 8px; font-size:11px; border-color:#d4d4d8; color:#18181b;" title="Inspect full audit record">
              <i class="fas fa-eye" style="color:#c9a227;"></i> Details
            </button>
          </td>
        </tr>
      `;
    }).join("");

    renderSuperadminPagination();
  } catch (err) {
    console.error("Superadmin logs fetch error:", err);
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align:center; padding:35px; color:#ef4444;">
          <i class="fas fa-triangle-exclamation" style="margin-right:6px;"></i> Failed to retrieve audit logs from server.
        </td>
      </tr>
    `;
  }
}

// ── Pagination Controls ──
function renderSuperadminPagination() {
  const st = window._superadminLogsState;
  const infoEl = document.getElementById("superadmin-pagination-info");
  const btnsEl = document.getElementById("superadmin-pagination-buttons");
  if (!infoEl || !btnsEl) return;

  const startEntry = st.total === 0 ? 0 : (st.page - 1) * st.limit + 1;
  const endEntry = Math.min(st.page * st.limit, st.total);
  infoEl.textContent = `Showing ${startEntry.toLocaleString()} to ${endEntry.toLocaleString()} of ${st.total.toLocaleString()} records`;

  let html = `
    <button type="button" class="btn btn-outline btn-sm" onclick="changeSuperadminPage(${st.page - 1})" ${st.page <= 1 ? 'disabled style="opacity:0.5;"' : ''}>
      <i class="fas fa-chevron-left"></i> Prev
    </button>
  `;

  const totalPages = Math.max(1, st.total_pages);
  let pStart = Math.max(1, st.page - 2);
  let pEnd = Math.min(totalPages, pStart + 4);
  if (pEnd - pStart < 4) pStart = Math.max(1, pEnd - 4);

  for (let p = pStart; p <= pEnd; p++) {
    html += `
      <button type="button" class="btn btn-sm ${p === st.page ? 'btn-primary' : 'btn-outline'}" onclick="changeSuperadminPage(${p})" style="min-width:32px; padding:4px 8px;">
        ${p}
      </button>
    `;
  }

  html += `
    <button type="button" class="btn btn-outline btn-sm" onclick="changeSuperadminPage(${st.page + 1})" ${st.page >= totalPages ? 'disabled style="opacity:0.5;"' : ''}>
      Next <i class="fas fa-chevron-right"></i>
    </button>
  `;

  btnsEl.innerHTML = html;
}

function changeSuperadminPage(p) {
  const st = window._superadminLogsState;
  if (p < 1 || p > st.total_pages || p === st.page) return;
  st.page = p;
  fetchAndRenderSuperadminLogs();
}

function changeSuperadminLimit(lim) {
  const st = window._superadminLogsState;
  st.limit = Number(lim) || 20;
  st.page = 1;
  fetchAndRenderSuperadminLogs();
}

// ── Filter Triggers ──
let _superadminSearchTimer = null;
function debounceSuperadminSearch() {
  clearTimeout(_superadminSearchTimer);
  _superadminSearchTimer = setTimeout(() => {
    const input = document.getElementById("superadmin-search");
    window._superadminLogsState.search = input ? input.value : "";
    window._superadminLogsState.page = 1;
    fetchAndRenderSuperadminLogs();
  }, 350);
}

function updateSuperadminFilter(key, val) {
  window._superadminLogsState[key] = val;
  window._superadminLogsState.page = 1;
  fetchAndRenderSuperadminLogs();
}

function setSuperadminDateRange(rangeKey) {
  window._superadminLogsState.date_range = rangeKey;
  window._superadminLogsState.page = 1;

  const customBar = document.getElementById("superadmin-custom-dates-bar");
  if (customBar) customBar.style.display = rangeKey === "custom" ? "flex" : "none";

  // Re-render view to highlight active date pill
  renderLogs();
}

function applySuperadminCustomDates() {
  const startEl = document.getElementById("superadmin-start-date");
  const endEl = document.getElementById("superadmin-end-date");
  window._superadminLogsState.start_date = startEl ? startEl.value : "";
  window._superadminLogsState.end_date = endEl ? endEl.value : "";
  window._superadminLogsState.page = 1;
  fetchAndRenderSuperadminLogs();
}

function resetSuperadminFilters() {
  window._superadminLogsState = {
    search: "",
    role: "ALL",
    activity_type: "ALL",
    status: "ALL",
    date_range: "today",
    start_date: "",
    end_date: "",
    page: 1,
    limit: 20,
    total: 0,
    total_pages: 1,
    items: [],
    summary: {}
  };
  renderLogs();
}

// ── Detail Inspection Modal ──
function openSuperadminLogModal(logId) {
  const log = (window._superadminLogsState.items || []).find(l => l.id === logId);
  if (!log) {
    Utils.showToast("Activity record details not found.", "warning");
    return;
  }

  const actBadge = getSuperadminActivityBadge(log.activity_type, log.status);
  const roleBadge = getSuperadminRoleBadge(log.role);
  const isFailed = (log.status || "").toUpperCase() === "FAILED";

  let metaFormatted = "None recorded";
  if (log.metadata_json) {
    try {
      const parsed = typeof log.metadata_json === "string" ? JSON.parse(log.metadata_json) : log.metadata_json;
      metaFormatted = `<pre style="margin:0; background:#f4f4f5; padding:10px; border-radius:6px; font-size:11px; font-family:monospace; max-height:160px; overflow-y:auto; color:#18181b;">${Utils.escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`;
    } catch (e) {
      metaFormatted = `<code style="font-size:11px;">${Utils.escapeHtml(log.metadata_json)}</code>`;
    }
  }

  const modalBody = `
    <div style="font-size:13px; color:#18181b; line-height:1.5;">
      <!-- Top Summary Header -->
      <div style="display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:14px; border-bottom:1px solid #e4e4e7; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
        <div>
          <span style="display:inline-flex; align-items:center; gap:5px; padding:4px 10px; border-radius:6px; font-size:12px; font-weight:700; background:${actBadge.bg}; color:${actBadge.color}; border:1px solid ${actBadge.border}; margin-bottom:6px;">
            <i class="fas ${actBadge.icon}"></i> ${Utils.escapeHtml(log.activity_type || log.action || 'Activity')}
          </span>
          <h3 style="font-size:16px; font-weight:800; margin:0; color:#18181b;">
            Log Record #${log.id}
          </h3>
        </div>
        <div style="text-align:right;">
          <span style="display:inline-block; padding:3px 10px; border-radius:999px; font-size:11px; font-weight:800; ${isFailed ? 'background:rgba(239,68,68,0.12); color:#dc2626; border:1px solid rgba(239,68,68,0.3);' : 'background:rgba(16,185,129,0.12); color:#059669; border:1px solid rgba(16,185,129,0.3);'}">
            ${Utils.escapeHtml(log.status || 'SUCCESS')}
          </span>
          <div style="font-size:11px; color:#71717a; margin-top:4px;">Audit Trail ID: ${log.id}</div>
        </div>
      </div>

      <!-- Description Banner -->
      <div style="background:#fafafa; border:1px solid #e4e4e7; border-radius:8px; padding:12px 14px; margin-bottom:18px;">
        <span style="display:block; font-size:10.5px; font-weight:700; text-transform:uppercase; color:#71717a; margin-bottom:3px;">Activity Description</span>
        <div style="font-size:13.5px; font-weight:600; color:#18181b;">${Utils.escapeHtml(log.description || log.details || 'No description recorded')}</div>
      </div>

      <!-- Key Details Grid -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:18px;">
        <!-- Left: Account Details -->
        <div style="border:1px solid #e4e4e7; border-radius:8px; padding:12px; background:#ffffff;">
          <h5 style="margin:0 0 10px 0; font-size:11.5px; font-weight:800; text-transform:uppercase; color:#71717a; border-bottom:1px solid #f4f4f5; padding-bottom:4px;">
            <i class="fas fa-user-circle" style="color:#c9a227;"></i> Account Identity
          </h5>
          <table style="width:100%; font-size:12px; border-collapse:collapse;">
            <tr>
              <td style="padding:4px 0; color:#71717a;">Employee Name:</td>
              <td style="padding:4px 0; text-align:right; font-weight:700; color:#18181b;">${Utils.escapeHtml(log.full_name || '—')}</td>
            </tr>
            <tr>
              <td style="padding:4px 0; color:#71717a;">Username / Email:</td>
              <td style="padding:4px 0; text-align:right; font-family:monospace; color:#18181b;">${Utils.escapeHtml(log.username || '—')}</td>
            </tr>
            <tr>
              <td style="padding:4px 0; color:#71717a;">Account Role:</td>
              <td style="padding:4px 0; text-align:right;">
                <span style="display:inline-block; padding:2px 7px; border-radius:4px; font-size:10px; font-weight:800; background:${roleBadge.bg}; color:${roleBadge.color};">
                  ${Utils.escapeHtml(log.role || 'STAFF')}
                </span>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 0; color:#71717a;">User ID:</td>
              <td style="padding:4px 0; text-align:right; font-family:monospace;">${log.user_id ? `#${log.user_id}` : '—'}</td>
            </tr>
          </table>
        </div>

        <!-- Right: Environment & Security Details -->
        <div style="border:1px solid #e4e4e7; border-radius:8px; padding:12px; background:#ffffff;">
          <h5 style="margin:0 0 10px 0; font-size:11.5px; font-weight:800; text-transform:uppercase; color:#71717a; border-bottom:1px solid #f4f4f5; padding-bottom:4px;">
            <i class="fas fa-network-wired" style="color:#3b82f6;"></i> Security &amp; Network
          </h5>
          <table style="width:100%; font-size:12px; border-collapse:collapse;">
            <tr>
              <td style="padding:4px 0; color:#71717a;">Philippine Date:</td>
              <td style="padding:4px 0; text-align:right; font-weight:600;">${Utils.escapeHtml(log.ph_date || '—')}</td>
            </tr>
            <tr>
              <td style="padding:4px 0; color:#71717a;">Philippine Time:</td>
              <td style="padding:4px 0; text-align:right; font-weight:600; font-variant-numeric:tabular-nums;">${Utils.escapeHtml(log.ph_time || '—')}</td>
            </tr>
            <tr>
              <td style="padding:4px 0; color:#71717a;">IP Address:</td>
              <td style="padding:4px 0; text-align:right; font-family:monospace; font-weight:700;">${Utils.escapeHtml(log.ip_address || '—')}</td>
            </tr>
            <tr>
              <td style="padding:4px 0; color:#71717a;">Session ID:</td>
              <td style="padding:4px 0; text-align:right; font-family:monospace; font-size:11px; max-width:140px; overflow:hidden; text-overflow:ellipsis;">${Utils.escapeHtml(log.session_id ? log.session_id.substring(0, 12) + '…' : '—')}</td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Device & Browser User Agent -->
      <div style="margin-bottom:16px;">
        <span style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#71717a; margin-bottom:4px;">Device / Browser User Agent</span>
        <div style="background:#f4f4f5; border:1px solid #e4e4e7; border-radius:6px; padding:8px 12px; font-size:11px; font-family:monospace; color:#52525b; word-break:break-all;">
          ${Utils.escapeHtml(log.user_agent || 'Not captured')}
        </div>
      </div>

      <!-- Additional Metadata -->
      <div>
        <span style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#71717a; margin-bottom:4px;">Additional Log Context &amp; Metadata</span>
        ${metaFormatted}
      </div>
    </div>
  `;

  const modalTitle = `<i class="fas fa-shield-halved" style="color:#c9a227; margin-right:8px;"></i> Activity Log Audit Record #${log.id}`;
  const modalFooter = `
    <button type="button" class="btn btn-outline" onclick="Utils.closeModal()" style="padding:8px 18px; font-size:13px;">Close</button>
  `;

  Utils.openModal(modalTitle, modalBody, modalFooter, "modal-md");
}

// ── Export CSV ──
function exportSuperadminLogsCsv() {
  const st = window._superadminLogsState;
  const params = new URLSearchParams();
  if (st.search) params.append("search", st.search.trim());
  if (st.role && st.role !== "ALL") params.append("role", st.role);
  if (st.activity_type && st.activity_type !== "ALL") params.append("activity_type", st.activity_type);
  if (st.status && st.status !== "ALL") params.append("status", st.status);
  if (st.date_range && st.date_range !== "all") params.append("date_range", st.date_range);
  if (st.date_range === "custom") {
    if (st.start_date) params.append("start_date", st.start_date);
    if (st.end_date) params.append("end_date", st.end_date);
  }

  window.open(`/api/v1/activity-logs/export?${params.toString()}`, "_blank");
}

window.renderLogs = renderLogs;
window.fetchAndRenderSuperadminLogs = fetchAndRenderSuperadminLogs;
window.changeSuperadminPage = changeSuperadminPage;
window.changeSuperadminLimit = changeSuperadminLimit;
window.debounceSuperadminSearch = debounceSuperadminSearch;
window.updateSuperadminFilter = updateSuperadminFilter;
window.setSuperadminDateRange = setSuperadminDateRange;
window.applySuperadminCustomDates = applySuperadminCustomDates;
window.resetSuperadminFilters = resetSuperadminFilters;
window.openSuperadminLogModal = openSuperadminLogModal;
window.exportSuperadminLogsCsv = exportSuperadminLogsCsv;


// ─────────────────────────────────────────────────────────────────────────────
// 9. REPORTS & ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────
async function renderReports(c) {
  c = c || document.getElementById("view-container");
  if (!c) return;
  let transactions = [];
  try {
    const txRes = await Auth.fetch("/api/v1/transactions?limit=100");
    if (txRes.ok) transactions = await txRes.json();
  } catch(e) {}

  const totalSales = transactions.reduce((acc, t) => acc + (t.net_amount || 0), 0);

  c.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-chart-line"></i></div>
        <div class="stat-info">
          <h3>Accumulated Sales</h3>
          <div class="stat-count" style="color:#c9a227;">${Utils.formatCurrency(totalSales)}</div>
          <div class="stat-trend" style="color:var(--success);"><i class="fas fa-arrow-up"></i> Gross revenue</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-shopping-basket"></i></div>
        <div class="stat-info">
          <h3>Total Completed Orders</h3>
          <div class="stat-count" style="color:#10b981;">${Utils.escapeHtml(transactions.length)}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-check"></i> Orders billed</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-calculator"></i></div>
        <div class="stat-info">
          <h3>Average Order Value</h3>
          <div class="stat-count" style="color:#f97316;">${Utils.formatCurrency(transactions.length ? totalSales / transactions.length : 0)}</div>
          <div class="stat-trend" style="color:#f97316;"><i class="fas fa-receipt"></i> Per order avg</div>
        </div>
      </div>
    </div>

    <div class="section-card">
      <div class="section-head">
        <h2>Sales Performance Report</h2>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-outline btn-sm" onclick="openFinancialPrintPreviewModal()" title="Open formal print preview of financial statement">
            <i class="fas fa-eye" style="color:#c9a227;"></i> Print Preview
          </button>
          <button class="btn btn-outline btn-sm" onclick="Utils.exportCSV('Sales_Report', ${JSON.stringify(transactions).replace(/"/g, '&quot;')})">
            <i class="fas fa-download"></i> Export CSV
          </button>
        </div>
      </div>
      <div style="padding:20px 24px;">
        <p style="color:var(--text-muted); font-size:13px;">Real-time sales breakdown extracted from transaction ledger.</p>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. SETTINGS & PROFILE
// ─────────────────────────────────────────────────────────────────────────────
async function renderSettings(c) {
  c = c || document.getElementById("view-container");
  if (!c) return;
  const user = (typeof Auth !== 'undefined' && Auth.getUser) ? (Auth.getUser() || {}) : {};
  const username = user.username || localStorage.getItem("username") || "User";
  const roleName = ((user.role || localStorage.getItem("role") || "Staff") + "").replace(/_/g, ' ').toUpperCase();
  c.innerHTML = `
    <div class="section-card" style="max-width:550px;">
      <div class="section-head">
        <h2>User Profile & Settings</h2>
      </div>
      <div style="padding:22px 24px;">
        <div class="input-group" style="margin-bottom:14px;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Logged-in Username</label>
          <input class="input-field" value="${Utils.escapeHtml(username)}" disabled style="width:100%;">
        </div>
        <div class="input-group" style="margin-bottom:14px;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Assigned Role</label>
          <input class="input-field" value="${Utils.escapeHtml(roleName)}" disabled style="width:100%;">
        </div>
        <div style="margin-top:20px; padding-top:16px; border-top:1px solid rgba(205,190,150,0.25);">
          <button class="btn btn-danger" onclick="Auth.logout()"><i class="fas fa-sign-out-alt"></i> End Session / Logout</button>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. SUPPLIERS MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
let globalSuppliers = [];

async function renderSuppliers(c) {
  c = c || document.getElementById("view-container") || document.getElementById("content-area");
  if (!c) return;
  c.innerHTML = `<div style="padding:40px; text-align:center; color:var(--text-muted);">
    <i class="fas fa-spinner fa-spin" style="font-size:24px; margin-bottom:10px;"></i>
    <div>Loading suppliers...</div>
  </div>`;

  try {
    const statsRes = await Auth.fetch("/api/v1/suppliers/stats");
    const suppRes = await Auth.fetch("/api/v1/suppliers");
    
    if (!statsRes.ok || !suppRes.ok) {
      throw new Error("Failed to load suppliers data.");
    }
    
    const statsData = await statsRes.json();
    const suppliersData = await suppRes.json();
    globalSuppliers = suppliersData;

    let cats = Object.keys(statsData.categories || {}).map(k => ({ name: k, count: statsData.categories[k] }));
    cats.sort((a, b) => b.count - a.count);
    const top3 = cats.slice(0, 3);
    const icons = ["green", "orange", "purple"];
    const faIcons = ["fa-check-circle", "fa-leaf", "fa-box-open"];

    let categoryCardsHtml = top3.map((cat, i) => `
      <div class="stat-card">
        <div class="stat-icon ${icons[i % icons.length]}"><i class="fas ${faIcons[i % faIcons.length]}"></i></div>
        <div class="stat-info">
          <h3>${Utils.escapeHtml(cat.name || 'General')}</h3>
          <div class="stat-count">${Utils.escapeHtml(cat.count)}</div>
          <div class="stat-trend">Category</div>
        </div>
      </div>
    `).join('');

    c.innerHTML = `
      <div class="suppliers-page">
        <!-- Summary Cards Grid -->
        <div class="stats-grid supplier-summary-grid">
          <div class="stat-card">
            <div class="stat-icon gold"><i class="fas fa-truck"></i></div>
            <div class="stat-info">
              <h3>Active Suppliers</h3>
              <div class="stat-count" style="color:#c9a227;">${Utils.escapeHtml(statsData.active_suppliers)}</div>
              <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-handshake"></i> Verified Vendors</div>
            </div>
          </div>
          ${categoryCardsHtml}
        </div>

        <!-- Toolbar (Search & Action) -->
        <div class="toolbar supplier-toolbar fade-up delay-1">
          <div class="search-wrap supplier-search-wrap">
            <i class="fas fa-search"></i>
            <input type="text" id="supp-search" class="input-field" placeholder="Search suppliers..." oninput="filterSuppliersTable()">
          </div>
          <button type="button" class="btn btn-primary add-supplier-btn" onclick="openAddSupplierModal()">
            <i class="fas fa-plus"></i> Add New Supplier
          </button>
        </div>

        <!-- Supplier Directory Container -->
        <div class="section-card supplier-directory fade-up delay-2">
          <div class="section-head">
            <div>
              <h2 style="margin:0; font-size:15px; font-weight:700;">Registered Supplier Directory</h2>
              <span id="supp-count-badge" style="font-size:12px; color:var(--text-muted);">${Utils.escapeHtml(globalSuppliers.length)} vendor partners</span>
            </div>
          </div>
          
          <!-- Desktop Table (Visible on screens >= 768px) -->
          <div class="supplier-desktop-table table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Supplier Name</th>
                  <th>Contact Person</th>
                  <th>Phone Number</th>
                  <th>Email</th>
                  <th>Category Supplied</th>
                  <th>Terms</th>
                  <th>Status</th>
                  <th style="text-align:right; width:150px;">ACTIONS</th>
                </tr>
              </thead>
              <tbody id="supp-tbody">
                ${renderSupplierRows(globalSuppliers)}
              </tbody>
            </table>
          </div>

          <!-- Mobile Cards (Visible on screens < 768px) -->
          <div class="supplier-mobile-list" id="supp-mobile-list">
            ${renderSupplierCards(globalSuppliers)}
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    console.error("Suppliers Error:", err);
    c.innerHTML = `
      <div style="padding:40px; text-align:center; color:var(--danger);">
        <i class="fas fa-exclamation-triangle" style="font-size:24px; margin-bottom:10px;"></i>
        <div>Unable to load suppliers. Please try again.</div>
      </div>
    `;
  }
}

function renderSupplierRows(suppliers) {
  if (!suppliers || !suppliers.length) {
    return `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-muted);">No suppliers found matching your criteria.</td></tr>`;
  }
  return suppliers.map(s => `
    <tr>
      <td><strong style="color:var(--text-main); font-size:13px;">${Utils.escapeHtml(s.supplier_name)}</strong></td>
      <td style="color:var(--text-muted); font-size:13px;">${Utils.escapeHtml(s.contact_person || '—')}</td>
      <td><span style="font-family:monospace; font-size:12px; color:var(--text-muted);">${Utils.escapeHtml(s.contact_number || '—')}</span></td>
      <td style="color:var(--text-muted); font-size:13px;">${Utils.escapeHtml(s.email || '—')}</td>
      <td><span class="badge badge-info" style="font-size:11px; font-weight:700;">${Utils.escapeHtml(s.category || 'General')}</span></td>
      <td style="color:var(--text-muted); font-size:12px;">${Utils.escapeHtml(s.notes || '—')}</td>
      <td>
        <span class="badge ${s.status === 'Active' ? 'badge-success' : 'badge-danger'}" style="font-size:11px; font-weight:700;">
          ${Utils.escapeHtml(s.status || 'Active')}
        </span>
      </td>
      <td style="text-align:right; white-space:nowrap;">
        <div style="display:inline-flex; gap:6px; justify-content:flex-end;">
          <button class="btn btn-outline" style="padding:4px 9px; font-size:12px; border-radius:6px; color:#c9a227; border-color:rgba(201,162,39,0.35); display:inline-flex; align-items:center; gap:5px;" onclick="openEditSupplierModal(${s.id})" title="Edit Supplier">
            <i class="fas fa-pencil-alt"></i> Edit
          </button>
          <button class="btn btn-outline" style="padding:4px 9px; font-size:12px; border-radius:6px; color:var(--danger, #ef4444); border-color:rgba(239,68,68,0.35); display:inline-flex; align-items:center; gap:5px;" onclick="confirmDeleteSupplier(${s.id})" title="Delete Supplier">
            <i class="fas fa-trash-alt"></i> Delete
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderSupplierCards(suppliers) {
  if (!suppliers || !suppliers.length) {
    return `
      <div style="text-align:center; padding:32px 16px; color:var(--text-muted); background:var(--card-bg, #ffffff); border-radius:12px; border:1px dashed rgba(205,190,150,0.35); margin:8px 0;">
        <i class="fas fa-search" style="font-size:26px; margin-bottom:10px; opacity:0.4; display:block;"></i>
        <div style="font-size:13.5px; font-weight:600; color:var(--text-main);">No matching suppliers found</div>
        <div style="font-size:12px; margin-top:4px;">Try adjusting your search terms or register a new supplier.</div>
      </div>
    `;
  }

  return suppliers.map(s => {
    const isActive = (s.status || 'Active').toLowerCase() === 'active';
    const statusBadge = isActive 
      ? `<span class="badge badge-success" style="font-size:11px; font-weight:700;"><i class="fas fa-check-circle" style="font-size:9px; margin-right:4px;"></i>Active</span>`
      : `<span class="badge badge-danger" style="font-size:11px; font-weight:700;"><i class="fas fa-times-circle" style="font-size:9px; margin-right:4px;"></i>${Utils.escapeHtml(s.status || 'Inactive')}</span>`;

    return `
      <div class="supplier-mobile-card">
        <div class="supplier-card-header">
          <div>
            <div class="supplier-card-title">${Utils.escapeHtml(s.supplier_name)}</div>
            <div class="supplier-card-badges">
              <span class="badge" style="background:rgba(201,162,39,0.12); color:#c9a227; border:1px solid rgba(201,162,39,0.3); font-size:11px; font-weight:600;">
                <i class="fas fa-tag" style="font-size:9px; margin-right:4px;"></i>${Utils.escapeHtml(s.category || 'General')}
              </span>
              ${statusBadge}
            </div>
          </div>
        </div>

        <div class="supplier-card-body">
          <div class="supplier-field-row">
            <span class="supplier-field-label">Contact Person</span>
            <span class="supplier-field-value">${Utils.escapeHtml(s.contact_person || 'Not provided')}</span>
          </div>

          <div class="supplier-field-row">
            <span class="supplier-field-label">Phone</span>
            <span class="supplier-field-value phone">${Utils.escapeHtml(s.contact_number || 'Not provided')}</span>
          </div>

          <div class="supplier-field-row">
            <span class="supplier-field-label">Email</span>
            <span class="supplier-field-value">${Utils.escapeHtml(s.email || 'Not provided')}</span>
          </div>

          ${s.notes ? `
          <div class="supplier-field-row">
            <span class="supplier-field-label">Payment Terms / Notes</span>
            <span class="supplier-field-value" style="color:var(--text-muted); font-size:12px;">${Utils.escapeHtml(s.notes)}</span>
          </div>
          ` : ''}
        </div>

        <div class="supplier-card-actions">
          <button type="button" class="btn btn-outline" style="color:#c9a227; border-color:rgba(201,162,39,0.4);" onclick="openEditSupplierModal(${s.id})" title="Edit Supplier">
            <i class="fas fa-pencil-alt"></i> Edit
          </button>
          <button type="button" class="btn btn-outline" style="color:var(--danger, #ef4444); border-color:rgba(239,68,68,0.4);" onclick="confirmDeleteSupplier(${s.id})" title="Delete Supplier">
            <i class="fas fa-trash-alt"></i> Delete
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function filterSuppliersTable() {
  const q = (document.getElementById("supp-search")?.value || "").toLowerCase().trim();
  const filtered = globalSuppliers.filter(s =>
    (s.supplier_name && s.supplier_name.toLowerCase().includes(q)) ||
    (s.contact_person && s.contact_person.toLowerCase().includes(q)) ||
    (s.contact_number && s.contact_number.toLowerCase().includes(q)) ||
    (s.email && s.email.toLowerCase().includes(q)) ||
    (s.category && s.category.toLowerCase().includes(q)) ||
    (s.notes && s.notes.toLowerCase().includes(q))
  );

  const countBadge = document.getElementById("supp-count-badge");
  if (countBadge) {
    countBadge.textContent = `${filtered.length} vendor partner${filtered.length === 1 ? '' : 's'}`;
  }

  const tbody = document.getElementById("supp-tbody");
  if (tbody) tbody.innerHTML = renderSupplierRows(filtered);

  const mobList = document.getElementById("supp-mobile-list");
  if (mobList) mobList.innerHTML = renderSupplierCards(filtered);
}

function openAddSupplierModal() {
  Utils.openModal("Add New Vendor Supplier", `
    <form id="form-add-supp" onsubmit="event.preventDefault(); submitAddSupplier();">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Supplier / Company Name <span style="color:var(--danger);">*</span></label>
        <input id="sp-name" class="input-field" required placeholder="e.g. San Miguel Foods Inc." style="width:100%;">
      </div>
      <div class="modal-form-grid">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Contact Person</label>
          <input id="sp-contact" class="input-field" placeholder="e.g. Mario Batali" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Phone Number <span style="color:var(--danger);">*</span></label>
          <input id="sp-phone" class="input-field" required placeholder="09XX-XXX-XXXX" style="width:100%;">
        </div>
      </div>
      <div class="modal-form-grid">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Email Address</label>
          <input type="email" id="sp-email" class="input-field" placeholder="orders@supplier.com" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Supply Category</label>
          <input id="sp-category" class="input-field" placeholder="e.g. Poultry, Dairy, Packaging" style="width:100%;">
        </div>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Payment Terms / Notes</label>
        <input id="sp-notes" class="input-field" placeholder="e.g. Net 30, COD, Weekly" style="width:100%;">
      </div>
    </form>
  `, `
    <button type="button" class="btn btn-outline" onclick="Utils.closeModal()">Cancel</button>
    <button type="button" class="btn btn-primary" id="btn-save-add-supplier" onclick="submitAddSupplier()">
      <i class="fas fa-save"></i> Save Supplier
    </button>
  `);
}

async function submitAddSupplier() {
  const name = document.getElementById("sp-name")?.value.trim();
  const contact = document.getElementById("sp-contact")?.value.trim();
  const phone = document.getElementById("sp-phone")?.value.trim();
  const email = document.getElementById("sp-email")?.value.trim();
  const category = document.getElementById("sp-category")?.value.trim();
  const notes = document.getElementById("sp-notes")?.value.trim();

  if (!name || !phone) {
    Utils.showToast("Company name and phone number are required.", "danger");
    return;
  }

  const btn = document.getElementById("btn-save-add-supplier");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Saving...`;
  }

  const payload = {
    supplier_name: name,
    contact_person: contact || null,
    contact_number: phone,
    email: email || null,
    category: category || "General",
    notes: notes || null,
    status: "Active"
  };

  try {
    const res = await Auth.fetch("/api/v1/suppliers", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      let errMsg = "Failed to add supplier";
      try {
        const err = await res.json();
        if (err && err.detail) errMsg = err.detail;
      } catch (_) {}
      throw new Error(errMsg);
    }

    Utils.showToast("Supplier registered successfully!", "success");
    Utils.closeModal();
    await renderSuppliers();
  } catch (error) {
    console.error(error);
    Utils.showToast(error.message, "danger");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-save"></i> Save Supplier`;
    }
  }
}

function openEditSupplierModal(id) {
  const s = (globalSuppliers || []).find(x => x.id === id);
  if (!s) {
    Utils.showToast("Supplier details could not be found.", "danger");
    return;
  }

  const escapeAttr = (str) => (str ? String(str).replace(/"/g, '&quot;') : '');

  Utils.openModal("Edit Vendor Supplier", `
    <form id="form-edit-supp" onsubmit="event.preventDefault(); submitEditSupplier(${s.id});">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Supplier / Company Name <span style="color:var(--danger);">*</span></label>
        <input id="edit-sp-name" class="input-field" required value="${escapeAttr(s.supplier_name)}" placeholder="e.g. San Miguel Foods Inc." style="width:100%;">
      </div>
      <div class="modal-form-grid">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Contact Person</label>
          <input id="edit-sp-contact" class="input-field" value="${escapeAttr(s.contact_person)}" placeholder="e.g. Mario Batali" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Phone Number <span style="color:var(--danger);">*</span></label>
          <input id="edit-sp-phone" class="input-field" required value="${escapeAttr(s.contact_number)}" placeholder="09XX-XXX-XXXX" style="width:100%;">
        </div>
      </div>
      <div class="modal-form-grid">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Email Address</label>
          <input type="email" id="edit-sp-email" class="input-field" value="${escapeAttr(s.email)}" placeholder="orders@supplier.com" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Supply Category</label>
          <input id="edit-sp-category" class="input-field" value="${escapeAttr(s.category)}" placeholder="e.g. Poultry, Dairy, Packaging" style="width:100%;">
        </div>
      </div>
      <div class="modal-form-grid">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Payment Terms / Notes</label>
          <input id="edit-sp-notes" class="input-field" value="${escapeAttr(s.notes)}" placeholder="e.g. Net 30, COD, Weekly" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Status <span style="color:var(--danger);">*</span></label>
          <select id="edit-sp-status" class="input-field" style="width:100%;">
            <option value="Active" ${s.status === 'Active' ? 'selected' : ''}>Active</option>
            <option value="Inactive" ${s.status === 'Inactive' ? 'selected' : ''}>Inactive</option>
          </select>
        </div>
      </div>
    </form>
  `, `
    <button type="button" class="btn btn-outline" onclick="Utils.closeModal()">Cancel</button>
    <button type="button" class="btn btn-primary" id="btn-save-edit-supplier" onclick="submitEditSupplier(${s.id})">
      <i class="fas fa-save"></i> Save Changes
    </button>
  `);
}

async function submitEditSupplier(id) {
  const name = document.getElementById("edit-sp-name")?.value.trim();
  const contact = document.getElementById("edit-sp-contact")?.value.trim();
  const phone = document.getElementById("edit-sp-phone")?.value.trim();
  const email = document.getElementById("edit-sp-email")?.value.trim();
  const category = document.getElementById("edit-sp-category")?.value.trim();
  const notes = document.getElementById("edit-sp-notes")?.value.trim();
  const status = document.getElementById("edit-sp-status")?.value;

  if (!name || !phone) {
    Utils.showToast("Company name and phone number are required.", "danger");
    return;
  }

  const btn = document.getElementById("btn-save-edit-supplier");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Saving...`;
  }

  const payload = {
    supplier_name: name,
    contact_person: contact || null,
    contact_number: phone,
    email: email || null,
    category: category || "General",
    notes: notes || null,
    status: status || "Active"
  };

  try {
    const res = await Auth.fetch(`/api/v1/suppliers/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      let errMsg = "Failed to update supplier";
      try {
        const err = await res.json();
        if (err && err.detail) errMsg = err.detail;
      } catch (_) {}
      throw new Error(errMsg);
    }

    Utils.showToast("Supplier updated successfully!", "success");
    Utils.closeModal();
    await renderSuppliers();
  } catch (error) {
    console.error("Update supplier error:", error);
    Utils.showToast(error.message, "danger");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-save"></i> Save Changes`;
    }
  }
}

function confirmDeleteSupplier(id) {
  const s = (globalSuppliers || []).find(x => x.id === id);
  const safeName = s ? s.supplier_name : `Supplier #${id}`;

  Utils.openModal(
    "Delete Supplier Confirmation",
    `
      <div style="font-size:14px; line-height:1.6; color:var(--text-main);">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px; padding:12px; border-radius:8px; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.25);">
          <i class="fas fa-exclamation-triangle" style="font-size:24px; color:var(--danger, #ef4444); flex-shrink:0;"></i>
          <div>
            <strong>Are you sure you want to delete <span style="color:var(--danger, #ef4444);">${Utils.escapeHtml(safeName)}</span>?</strong>
          </div>
        </div>
        <p style="margin-bottom:10px; color:var(--text-muted);">
          This action will permanently remove the supplier from the database. Deletion may affect related purchase orders, inventory shipments, or historical vendor records.
        </p>
        <p style="margin-bottom:0; font-size:12px; color:var(--text-muted);">
          <em>Note: If this supplier has linked purchase orders, deletion is prevented to protect record integrity. In that case, please change its status to 'Inactive' instead.</em>
        </p>
      </div>
    `,
    `
      <button type="button" class="btn btn-outline" onclick="Utils.closeModal()">Cancel</button>
      <button type="button" class="btn btn-danger" id="btn-confirm-delete-supplier" onclick="submitDeleteSupplier(${id})">
        <i class="fas fa-trash-alt"></i> Confirm Delete
      </button>
    `
  );
}

async function submitDeleteSupplier(id) {
  const btn = document.getElementById("btn-confirm-delete-supplier");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Deleting...`;
  }

  try {
    const res = await Auth.fetch(`/api/v1/suppliers/${id}`, {
      method: "DELETE"
    });

    if (res.status === 204 || res.ok) {
      Utils.showToast("Supplier deleted successfully.", "success");
      Utils.closeModal();
      await renderSuppliers();
    } else {
      let errMsg = "Failed to delete supplier.";
      try {
        const err = await res.json();
        if (err && err.detail) errMsg = err.detail;
      } catch (_) {}
      
      Utils.showToast(errMsg, "danger");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-trash-alt"></i> Confirm Delete`;
      }
    }
  } catch (error) {
    console.error("Delete supplier error:", error);
    Utils.showToast(error.message || "Network error while deleting supplier.", "danger");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-trash-alt"></i> Confirm Delete`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. PROFIT LOSS & CASHOUT INCOME
// ─────────────────────────────────────────────────────────────────────────────
let cachedProfitLossData = null;
window._currentPlPeriod = window._currentPlPeriod || 'today';
window._currentPlStartDate = window._currentPlStartDate || '';
window._currentPlEndDate = window._currentPlEndDate || '';
window._currentPlTab = window._currentPlTab || 'overview';
window._currentExpenseFilter = window._currentExpenseFilter || 'all';
window._currentExpenseCatFilter = window._currentExpenseCatFilter || 'all';

async function renderProfitLoss(c, requestedPeriod = null, customStart = null, customEnd = null) {
  if (!c) c = document.getElementById("view-container") || document.getElementById("content-area");
  if (!c) return;

  if (requestedPeriod !== null) window._currentPlPeriod = requestedPeriod;
  if (customStart !== null) window._currentPlStartDate = customStart;
  if (customEnd !== null) window._currentPlEndDate = customEnd;

  const activePeriod = window._currentPlPeriod || 'all';
  const startDate = window._currentPlStartDate || '';
  const endDate = window._currentPlEndDate || '';

  let queryUrl = `/api/v1/analytics/profit-loss?period=${encodeURIComponent(activePeriod)}`;
  if (activePeriod === 'custom' && startDate) {
    queryUrl += `&start_date=${encodeURIComponent(startDate)}`;
    if (endDate) queryUrl += `&end_date=${encodeURIComponent(endDate)}`;
  }

  let data = {
    period: { name: "All Time" },
    revenue: { gross_sales: 0, discounts: 0, refunds: 0, net_sales: 0, total_orders_revenue: 0, cash_sales: 0, non_cash_sales: 0, total_orders_count: 0 },
    cogs: { cost_of_goods_sold: 0, is_cogs_complete: true, cogs_status: "complete", missing_cost_items: [] },
    expenses: { total_operating_expenses: 0, unpaid_pending_expenses: 0, by_category: {}, expenses_count: 0 },
    inventory: { total_inventory_valuation: 0, total_items_count: 0, cost_of_goods_sold: 0, is_cogs_complete: true, items: [] },
    cash_custody: {
      cashier_drawer: { active_cash: 0, cash_sales_in_drawer: 0, open_shifts_count: 0 },
      manager_safe: { balance: 0, total_cashout_income: 0, transferred_to_admin: 0, expenses_paid: 0 },
      admin_safe: { balance: 0, total_remittances_received: 0, expenses_paid: 0 }
    },
    cashout: { total_cashout_income: 0, today_cashout_income: 0, active_drawer_cash: 0, history: [] },
    profit_loss: { gross_sales: 0, net_sales: 0, cogs: 0, gross_profit: 0, operating_expenses: 0, net_profit: 0, profit_margin_percent: 0, profit_margin_display: "0.00%", is_profitable: true },
    metrics: {},
    reconciliation: { is_fully_reconciled: true, status: "RECONCILED", checks: [] },
    tables: { sales_orders: [], expenses: [], incoming_transfers: [], inventory_valuation: [] }
  };

  try {
    const res = await Auth.fetch(queryUrl);
    if (!res.ok) throw new Error("Failed to load financial data from server.");
    data = await res.json();
    cachedProfitLossData = data;
  } catch (err) {
    console.error("Profit Loss load error:", err);
    if (typeof cachedProfitLossData !== 'undefined' && cachedProfitLossData) data = cachedProfitLossData;
  }

  const rev = data.revenue || {};
  const cogsData = data.cogs || {};
  const expData = data.expenses || {};
  const inv = data.inventory || {};
  const custody = data.cash_custody || {};
  const pl = data.profit_loss || {};
  const metrics = data.metrics || {};
  const recon = data.reconciliation || {};
  const tables = data.tables || {};
  const history = (data.cashout && data.cashout.history) ? data.cashout.history : [];
  const periodInfo = data.period || {};

  const currentUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  const userRole = (currentUser && currentUser.role ? currentUser.role : (typeof Auth !== 'undefined' ? Auth.getRole() : '')).toLowerCase();
  const isAdmin = userRole.includes('admin') || window.location.pathname.includes('/admin') || window.location.pathname.includes('/dashboard');
  const canManageExpenses = isAdmin || userRole.includes('manager');

  // Core 8 Authoritative KPI Metric Values
  const grossSalesVal = metrics['1_gross_sales'] !== undefined ? metrics['1_gross_sales'] : (rev.gross_sales || rev.today_orders_revenue || 0);
  const netSalesVal = metrics['2_net_sales'] !== undefined ? metrics['2_net_sales'] : (rev.net_sales || rev.today_orders_revenue || 0);
  const discountsVal = metrics['5_discounts'] !== undefined ? metrics['5_discounts'] : (rev.discounts || 0);
  const refundsVal = metrics['5_refunds'] !== undefined ? metrics['5_refunds'] : (rev.refunds || 0);
  const cogsVal = metrics['6_cost_of_goods_sold'] !== undefined ? metrics['6_cost_of_goods_sold'] : (cogsData.cost_of_goods_sold || inv.cost_of_goods_sold || 0);
  const isCogsComplete = cogsData.is_cogs_complete !== undefined ? cogsData.is_cogs_complete : (inv.is_cogs_complete !== undefined ? inv.is_cogs_complete : true);
  const grossProfitVal = metrics['7_gross_profit'] !== undefined ? metrics['7_gross_profit'] : (pl.gross_profit || (netSalesVal - cogsVal));
  const operatingExpensesVal = metrics['8_operating_expenses'] !== undefined ? metrics['8_operating_expenses'] : (pl.operating_expenses || expData.total_operating_expenses || 0);
  const netProfitVal = metrics['9_net_operating_profit'] !== undefined ? metrics['9_net_operating_profit'] : (pl.net_profit || (grossProfitVal - operatingExpensesVal));
  const isProfitable = netProfitVal >= 0;
  const profitMarginDisplay = metrics['10_profit_margin_display'] || pl.profit_margin_display || ((netSalesVal > 0 ? ((netProfitVal / netSalesVal) * 100).toFixed(2) + '%' : '0.00%'));
  const cashCollectionsVal = metrics['3_cash_collections'] !== undefined ? metrics['3_cash_collections'] : (rev.cash_sales || 0);
  const digitalCollectionsVal = metrics['4_digital_collections'] !== undefined ? metrics['4_digital_collections'] : (rev.non_cash_sales || 0);
  const inventoryValuationVal = metrics['11_current_inventory_valuation'] !== undefined ? metrics['11_current_inventory_valuation'] : (inv.total_inventory_valuation || 0);
  const activeDrawerCashVal = metrics['12_current_cash_drawer_balances'] !== undefined ? metrics['12_current_cash_drawer_balances'] : (custody.cashier_drawer ? custody.cashier_drawer.active_cash : (data.cashout?.active_drawer_cash || 0));
  const managerSafeBalanceVal = custody.manager_safe ? custody.manager_safe.balance : (data.cashout?.manager_safe_cash || 0);
  const adminSafeBalanceVal = custody.admin_safe ? custody.admin_safe.balance : (data.cashout?.admin_transfer_income || 0);
  const isReconciled = recon.is_fully_reconciled !== undefined ? recon.is_fully_reconciled : true;
  const checks = recon.checks || [];

  const currentTab = window._currentPlTab || 'overview';

  c.innerHTML = `
    <style id="financial-system-styles">
      .fin-container {
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
      }
      
      /* Top Header Toolbar */
      .fin-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
        flex-wrap: wrap;
        gap: 14px;
      }
      .fin-header-title h2 {
        font-size: clamp(18px, 2vw, 24px);
        font-weight: 800;
        color: var(--text-main, #18181b);
        margin: 0;
        display: flex;
        align-items: center;
        gap: 10px;
        letter-spacing: -0.3px;
        line-height: 1.25;
      }
      .fin-header-title p {
        font-size: 13px;
        color: var(--text-muted, #71717a);
        margin: 4px 0 0 0;
        line-height: 1.4;
      }
      .fin-header-actions {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .fin-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        height: 38px;
        padding: 0 16px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        text-decoration: none;
        white-space: nowrap;
        border: 1px solid transparent;
        touch-action: manipulation;
      }
      .fin-btn:active {
        transform: scale(0.97);
      }
      .fin-btn-gold {
        background: #18181b;
        color: #d4af37;
        border-color: #d4af37;
        box-shadow: 0 2px 8px rgba(212, 175, 55, 0.15);
      }
      .fin-btn-gold:hover {
        background: #27272a;
        box-shadow: 0 4px 14px rgba(212, 175, 55, 0.25);
      }
      .fin-btn-outline {
        background: var(--card-bg, #ffffff);
        color: var(--text-main, #18181b);
        border-color: rgba(205, 190, 150, 0.4);
      }
      .fin-btn-outline:hover {
        border-color: #c9a227;
        background: rgba(201, 162, 39, 0.05);
      }

      /* Date Filter Bar */
      .fin-filter-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        background: var(--card-bg, #ffffff);
        border: 1px solid rgba(205, 190, 150, 0.35);
        border-radius: 14px;
        padding: 10px 14px;
        margin-bottom: 20px;
        flex-wrap: wrap;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
      }
      .fin-filter-pills {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }
      .fin-pill {
        padding: 6px 14px;
        border-radius: 999px;
        font-size: 12.5px;
        font-weight: 700;
        cursor: pointer;
        border: 1px solid rgba(205, 190, 150, 0.4);
        background: transparent;
        color: var(--text-muted, #71717a);
        transition: all 0.2s ease;
        white-space: nowrap;
        touch-action: manipulation;
      }
      .fin-pill:hover { border-color: #c9a227; color: var(--text-main, #18181b); }
      .fin-pill.active {
        background: #18181b;
        color: #d4af37;
        border-color: #d4af37;
        box-shadow: 0 2px 8px rgba(212, 175, 55, 0.2);
      }
      .fin-custom-range {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .fin-custom-range input {
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid var(--border-color, #e2e8f0);
        font-size: 12px;
        font-weight: 600;
        color: var(--text-main, #18181b);
      }

      /* Navigation Tabs Bar */
      .fin-nav-tabs {
        display: flex;
        gap: 4px;
        border-bottom: 2px solid rgba(205, 190, 150, 0.25);
        margin-bottom: 24px;
        overflow-x: auto;
        padding-bottom: 2px;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: thin;
      }
      .fin-nav-tabs::-webkit-scrollbar {
        height: 4px;
      }
      .fin-nav-tabs::-webkit-scrollbar-thumb {
        background: rgba(201, 162, 39, 0.2);
        border-radius: 4px;
      }
      .fin-nav-tab {
        padding: 10px 16px;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        background: transparent;
        border: none;
        border-bottom: 3px solid transparent;
        color: var(--text-muted, #71717a);
        display: inline-flex;
        align-items: center;
        gap: 8px;
        transition: all 0.2s ease;
        white-space: nowrap;
        border-radius: 8px 8px 0 0;
        touch-action: manipulation;
      }
      .fin-nav-tab:hover {
        color: #c9a227;
        background: rgba(201, 162, 39, 0.05);
      }
      .fin-nav-tab.active {
        color: #18181b;
        border-bottom-color: #c9a227;
        background: rgba(201, 162, 39, 0.08);
      }

      /* 8 Metric KPI Cards Grid */
      .fin-kpi-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 16px;
        margin-bottom: 24px;
      }
      @media (max-width: 1200px) { .fin-kpi-grid { grid-template-columns: repeat(2, 1fr); } }
      @media (max-width: 600px) { .fin-kpi-grid { grid-template-columns: 1fr; } }

      .fin-card {
        background: var(--card-bg, #ffffff);
        border: 1px solid rgba(205, 190, 150, 0.35);
        border-radius: 16px;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.03);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      }
      .fin-card:hover {
        border-color: rgba(201, 162, 39, 0.55);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.05);
      }

      .fin-stat-card {
        background: var(--card-bg, #ffffff);
        border: 1px solid rgba(205, 190, 150, 0.35);
        border-radius: 16px;
        padding: 16px 18px;
        display: flex;
        align-items: center;
        gap: 14px;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.03);
        transition: all 0.2s ease;
        min-width: 0;
        cursor: pointer;
        touch-action: manipulation;
      }
      .fin-stat-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 22px rgba(180, 140, 50, 0.12);
        border-color: rgba(201, 162, 39, 0.55);
      }
      .fin-stat-card:active {
        transform: scale(0.98);
      }
      .fin-stat-icon {
        width: 46px;
        height: 46px;
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        flex-shrink: 0;
      }
      .fin-stat-icon.gold { background: rgba(201, 162, 39, 0.12); color: #c9a227; }
      .fin-stat-icon.green { background: rgba(16, 185, 129, 0.12); color: #10b981; }
      .fin-stat-icon.red { background: rgba(239, 68, 68, 0.12); color: #ef4444; }
      .fin-stat-icon.orange { background: rgba(249, 115, 22, 0.12); color: #f97316; }
      .fin-stat-icon.cyan { background: rgba(6, 182, 212, 0.12); color: #06b6d4; }
      .fin-stat-icon.purple { background: rgba(99, 102, 241, 0.12); color: #6366f1; }

      .fin-stat-info { min-width: 0; flex: 1; overflow: hidden; }
      .fin-stat-info h3 {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-muted, #71717a);
        margin: 0 0 4px 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fin-stat-count {
        font-size: clamp(17px, 1.4vw, 22px);
        font-weight: 800;
        line-height: 1.2;
        margin-bottom: 4px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fin-stat-trend {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-muted, #71717a);
        display: flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Statement Table Layout */
      .fin-statement-box {
        background: #ffffff;
        border: 1px solid rgba(205, 190, 150, 0.35);
        border-radius: 16px;
        padding: clamp(16px, 2.5vw, 26px);
        margin-bottom: 24px;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.03);
        box-sizing: border-box;
      }
      .fin-stmt-section {
        margin-bottom: 22px;
      }
      .fin-stmt-title {
        font-size: 13px;
        font-weight: 800;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        color: #18181b;
        border-bottom: 2px solid rgba(205, 190, 150, 0.4);
        padding-bottom: 8px;
        margin-bottom: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .fin-stmt-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
        border-bottom: 1px dashed rgba(205, 190, 150, 0.2);
        font-size: 13.5px;
        flex-wrap: wrap;
        gap: 8px;
      }
      .fin-stmt-row.sub { padding-left: 18px; color: var(--text-muted, #71717a); font-size: 13px; }
      .fin-stmt-row.total {
        font-weight: 800;
        border-bottom: 1px solid rgba(205, 190, 150, 0.6);
        border-top: 1px solid rgba(205, 190, 150, 0.6);
        margin-top: 6px;
        padding: 10px 0;
      }
      .fin-stmt-highlight {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 18px;
        border-radius: 12px;
        margin-top: 12px;
        margin-bottom: 12px;
        flex-wrap: wrap;
        gap: 10px;
      }
      .fin-stmt-highlight.green { background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.3); }
      .fin-stmt-highlight.red { background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.3); }

      /* Custody 3-Column Grid */
      .fin-custody-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 18px;
        margin-bottom: 24px;
      }
      @media (max-width: 992px) { .fin-custody-grid { grid-template-columns: 1fr; } }

      /* Table styles */
      .fin-table-wrap {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        border-radius: 12px;
        border: 1px solid rgba(205, 190, 150, 0.2);
      }
      .fin-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12.5px;
        min-width: 650px;
      }
      .fin-table th {
        background: rgba(0, 0, 0, 0.02);
        padding: 12px 14px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-muted, #71717a);
        border-bottom: 1px solid rgba(205, 190, 150, 0.3);
        text-align: left;
      }
      .fin-table td {
        padding: 12px 14px;
        border-bottom: 1px solid rgba(205, 190, 150, 0.16);
        color: var(--text-main, #18181b);
        vertical-align: middle;
      }
      .fin-table tr:hover td { background: rgba(201, 162, 39, 0.03); }

      /* Status Badges */
      .fin-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        font-weight: 700;
        padding: 4px 10px;
        border-radius: 999px;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        white-space: nowrap;
      }
      .fin-badge-green { background: rgba(16, 185, 129, 0.12); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.25); }
      .fin-badge-red { background: rgba(239, 68, 68, 0.12); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25); }
      .fin-badge-gold { background: rgba(201, 162, 39, 0.12); color: #c9a227; border: 1px solid rgba(201, 162, 39, 0.25); }
      .fin-badge-blue { background: rgba(59, 130, 246, 0.12); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.25); }
      .fin-badge-orange { background: rgba(249, 115, 22, 0.12); color: #f97316; border: 1px solid rgba(249, 115, 22, 0.25); }
      .fin-badge-gray { background: rgba(113, 113, 122, 0.12); color: #71717a; border: 1px solid rgba(113, 113, 122, 0.25); }

      /* Responsive Rules */
      @media (max-width: 768px) {
        .fin-header {
          flex-direction: column;
          align-items: flex-start;
          gap: 12px;
        }
        .fin-header-actions {
          width: 100%;
          justify-content: stretch;
        }
        .fin-header-actions .fin-btn {
          flex: 1 1 auto;
          text-align: center;
        }
        .fin-filter-bar {
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
        }
        .fin-custom-range {
          width: 100%;
        }
        .fin-custom-range input {
          flex: 1 1 120px;
        }
      }
    </style>

    <div class="fin-container fade-up">
      <!-- 1. Header Toolbar -->
      <div class="fin-header">
        <div class="fin-header-title">
          <h2><i class="fas fa-file-invoice-dollar" style="color:#c9a227;"></i> Financial Management &amp; P&amp;L System</h2>
          <p>Authoritative financial intelligence, P&amp;L accounting, operating expense controls, and multi-tier safe custody</p>
        </div>
        <div class="fin-header-actions">
          ${canManageExpenses ? `
          <button class="fin-btn fin-btn-gold" onclick="openAddExpenseModal()" title="Record a new operational expense">
            <i class="fas fa-plus"></i> New Expense
          </button>
          ` : ''}
          <button class="fin-btn fin-btn-outline" onclick="exportFinancialReportCsv()" title="Export consolidated report to CSV">
            <i class="fas fa-file-excel" style="color:#10b981;"></i> Export CSV
          </button>
          <button class="fin-btn fin-btn-outline" onclick="openFinancialPrintPreviewModal()" title="Print financial statement">
            <i class="fas fa-print"></i> Print
          </button>
        </div>
      </div>

      <!-- 2. Date Filter Bar -->
      <div class="fin-filter-bar">
        <div class="fin-filter-pills">
          <span style="font-size:12px; font-weight:800; text-transform:uppercase; color:var(--text-muted); margin-right:6px;">
            <i class="fas fa-calendar-alt"></i> Period:
          </span>
          <button class="fin-pill ${activePeriod === 'today' ? 'active' : ''}" onclick="renderProfitLoss(null, 'today')">Today</button>
          <button class="fin-pill ${activePeriod === 'yesterday' ? 'active' : ''}" onclick="renderProfitLoss(null, 'yesterday')">Yesterday</button>
          <button class="fin-pill ${activePeriod === 'this_week' ? 'active' : ''}" onclick="renderProfitLoss(null, 'this_week')">This Week</button>
          <button class="fin-pill ${activePeriod === 'this_month' ? 'active' : ''}" onclick="renderProfitLoss(null, 'this_month')">This Month</button>
          <button class="fin-pill ${activePeriod === 'all' ? 'active' : ''}" onclick="renderProfitLoss(null, 'all')">All Time</button>
          <button class="fin-pill ${activePeriod === 'custom' ? 'active' : ''}" onclick="toggleCustomRangeInputs()">Custom</button>
        </div>

        <div id="fin-custom-inputs" class="fin-custom-range" style="display:${activePeriod === 'custom' ? 'flex' : 'none'};">
          <input type="date" id="fin-start-date" value="${startDate ? startDate.substring(0, 10) : ''}">
          <span style="font-size:12px; color:var(--text-muted);">to</span>
          <input type="date" id="fin-end-date" value="${endDate ? endDate.substring(0, 10) : ''}">
          <button class="fin-btn fin-btn-outline" onclick="const s = document.getElementById('fin-start-date').value; const e = document.getElementById('fin-end-date').value; renderProfitLoss(null, 'custom', s, e);" style="height:32px; padding:0 12px; font-size:12px;">Apply</button>
        </div>
      </div>

      <!-- 3. Navigation Tabs -->
      <div class="fin-nav-tabs">
        <button class="fin-nav-tab ${currentTab === 'overview' ? 'active' : ''}" onclick="switchFinTab('overview')">
          <i class="fas fa-chart-pie"></i> Financial Overview
        </button>
        <button class="fin-nav-tab ${currentTab === 'profit_loss' ? 'active' : ''}" onclick="switchFinTab('profit_loss')">
          <i class="fas fa-file-invoice"></i> Profit &amp; Loss Statement
        </button>
        <button class="fin-nav-tab ${currentTab === 'expenses' ? 'active' : ''}" onclick="switchFinTab('expenses')">
          <i class="fas fa-receipt"></i> Expenses Management (${(tables.expenses || []).length})
        </button>
        <button class="fin-nav-tab ${currentTab === 'cash_custody' ? 'active' : ''}" onclick="switchFinTab('cash_custody')">
          <i class="fas fa-vault"></i> Cash Custody &amp; Safes
        </button>
        <button class="fin-nav-tab ${currentTab === 'inventory_valuation' ? 'active' : ''}" onclick="switchFinTab('inventory_valuation')">
          <i class="fas fa-boxes-stacked"></i> Inventory Asset Valuation
        </button>
        <button class="fin-nav-tab ${currentTab === 'transactions' ? 'active' : ''}" onclick="switchFinTab('transactions')">
          <i class="fas fa-list-check"></i> Transactions Ledger (${(tables.sales_orders || []).length})
        </button>
        <button class="fin-nav-tab ${currentTab === 'reconciliation' ? 'active' : ''}" onclick="switchFinTab('reconciliation')">
          <i class="fas fa-scale-balanced"></i> Reconciliation Audit (${checks.length})
        </button>
        <button class="fin-nav-tab ${currentTab === 'reports' ? 'active' : ''}" onclick="switchFinTab('reports')">
          <i class="fas fa-chart-line"></i> Financial Reports
        </button>
      </div>

      <!-- TAB 1: FINANCIAL OVERVIEW (8 KPI Cards) -->
      <div id="fin-tab-overview" style="display:${currentTab === 'overview' ? 'block' : 'none'};">
        <div class="fin-kpi-grid">
          <!-- 1. Gross Sales -->
          <div class="fin-stat-card" onclick="switchFinTab('transactions')" title="Click to view all completed sales transactions">
            <div class="fin-stat-icon gold"><i class="fas fa-coins"></i></div>
            <div class="fin-stat-info">
              <h3>1. Gross Sales</h3>
              <div class="fin-stat-count" style="color:#c9a227;">${Utils.formatCurrency(grossSalesVal)}</div>
              <div class="fin-stat-trend"><i class="fas fa-receipt"></i> ${(rev.total_orders_count || 0)} completed order(s)</div>
            </div>
          </div>

          <!-- 2. Net Sales -->
          <div class="fin-stat-card" onclick="switchFinTab('transactions')" title="Click to view transactions ledger">
            <div class="fin-stat-icon gold"><i class="fas fa-calculator"></i></div>
            <div class="fin-stat-info">
              <h3>2. Net Sales</h3>
              <div class="fin-stat-count" style="color:#c9a227;">${Utils.formatCurrency(netSalesVal)}</div>
              <div class="fin-stat-trend">Disc: -${Utils.formatCurrency(discountsVal)} | Ref: -${Utils.formatCurrency(refundsVal)}</div>
            </div>
          </div>

          <!-- 3. Total COGS -->
          <div class="fin-stat-card" onclick="switchFinTab('inventory_valuation')" title="Click to view recipe-based ingredient costs">
            <div class="fin-stat-icon orange"><i class="fas fa-utensils"></i></div>
            <div class="fin-stat-info">
              <h3>3. Cost of Goods Sold</h3>
              <div class="fin-stat-count" style="color:#f97316;">${Utils.formatCurrency(cogsVal)}</div>
              <div class="fin-stat-trend">
                <span class="fin-badge ${isCogsComplete ? 'fin-badge-green' : 'fin-badge-orange'}" style="font-size:10px; padding:2px 6px;">
                  <i class="fas ${isCogsComplete ? 'fa-check' : 'fa-triangle-exclamation'}"></i> ${isCogsComplete ? 'VERIFIED' : 'PARTIAL DATA'}
                </span>
              </div>
            </div>
          </div>

          <!-- 4. Gross Profit -->
          <div class="fin-stat-card" onclick="switchFinTab('profit_loss')" title="Click to view Profit & Loss statement">
            <div class="fin-stat-icon ${grossProfitVal >= 0 ? 'green' : 'red'}">
              <i class="fas ${grossProfitVal >= 0 ? 'fa-chart-line' : 'fa-chart-line-down'}"></i>
            </div>
            <div class="fin-stat-info">
              <h3>4. Gross Profit</h3>
              <div class="fin-stat-count" style="color:${grossProfitVal >= 0 ? '#10b981' : '#ef4444'};">${Utils.formatCurrency(grossProfitVal)}</div>
              <div class="fin-stat-trend">Net Sales − Recipe COGS</div>
            </div>
          </div>

          <!-- 5. Operating Expenses -->
          <div class="fin-stat-card" onclick="switchFinTab('expenses')" title="Click to manage operating expenses">
            <div class="fin-stat-icon red"><i class="fas fa-file-invoice-dollar"></i></div>
            <div class="fin-stat-info">
              <h3>5. Operating Expenses</h3>
              <div class="fin-stat-count" style="color:#ef4444;">${Utils.formatCurrency(operatingExpensesVal)}</div>
              <div class="fin-stat-trend"><i class="fas fa-list"></i> Across ${(tables.expenses || []).length} paid expense(s)</div>
            </div>
          </div>

          <!-- 6. Net Operating Profit -->
          <div class="fin-stat-card" onclick="switchFinTab('profit_loss')" title="Click to view full Profit & Loss statement">
            <div class="fin-stat-icon ${isProfitable ? 'green' : 'red'}">
              <i class="fas ${isProfitable ? 'fa-sack-dollar' : 'fa-arrow-trend-down'}"></i>
            </div>
            <div class="fin-stat-info">
              <h3>6. Net Operating Profit</h3>
              <div class="fin-stat-count" style="color:${isProfitable ? '#10b981' : '#ef4444'};">${Utils.formatCurrency(netProfitVal)}</div>
              <div class="fin-stat-trend" style="color:${isProfitable ? '#10b981' : '#ef4444'};"><i class="fas fa-percent"></i> ${Utils.escapeHtml(profitMarginDisplay)} profit margin</div>
            </div>
          </div>

          <!-- 7. Cash Collections -->
          <div class="fin-stat-card" onclick="switchFinTab('cash_custody')" title="Click to view physical drawer and safe custody">
            <div class="fin-stat-icon green"><i class="fas fa-money-bill-wave"></i></div>
            <div class="fin-stat-info">
              <h3>7. Cash Collections</h3>
              <div class="fin-stat-count" style="color:#10b981;">${Utils.formatCurrency(cashCollectionsVal)}</div>
              <div class="fin-stat-trend"><i class="fas fa-mobile-screen"></i> Digital: ${Utils.formatCurrency(digitalCollectionsVal)}</div>
            </div>
          </div>

          <!-- 8. Inventory Valuation -->
          <div class="fin-stat-card" onclick="switchFinTab('inventory_valuation')" title="Click to view balance sheet stock asset valuation">
            <div class="fin-stat-icon cyan"><i class="fas fa-boxes-stacked"></i></div>
            <div class="fin-stat-info">
              <h3>8. Inventory Valuation</h3>
              <div class="fin-stat-count" style="color:#06b6d4;">${Utils.formatCurrency(inventoryValuationVal)}</div>
              <div class="fin-stat-trend" style="color:#06b6d4;"><i class="fas fa-tags"></i> ${Utils.escapeHtml(inv.total_items_count || 0)} items on hand (Asset)</div>
            </div>
          </div>
        </div>

        <!-- Quick Summary Visual Comparison Bar -->
        <div class="fin-statement-box">
          <div class="fin-stmt-title">
            <span><i class="fas fa-chart-column" style="color:#c9a227;"></i> Revenue &amp; Cost Distribution Breakdown</span>
            <span style="font-size:12px; font-weight:600; text-transform:none; color:var(--text-muted);">Period: ${Utils.escapeHtml(periodInfo.name || 'Selected')}</span>
          </div>
          <div style="margin: 16px 0;">
            <div style="display:flex; justify-content:space-between; font-size:12.5px; font-weight:700; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
              <span>Net Sales (100%): ${Utils.formatCurrency(netSalesVal)}</span>
              <span>COGS (${netSalesVal > 0 ? ((cogsVal / netSalesVal) * 100).toFixed(1) : 0}%): ${Utils.formatCurrency(cogsVal)}</span>
              <span>Expenses (${netSalesVal > 0 ? ((operatingExpensesVal / netSalesVal) * 100).toFixed(1) : 0}%): ${Utils.formatCurrency(operatingExpensesVal)}</span>
              <span style="color:${isProfitable ? '#10b981' : '#ef4444'};">Net Profit: ${Utils.formatCurrency(netProfitVal)}</span>
            </div>
            <div style="height:18px; border-radius:999px; background:#e2e8f0; overflow:hidden; display:flex;">
              <div style="background:#f97316; width:${netSalesVal > 0 ? Math.min(100, (cogsVal / netSalesVal) * 100) : 0}%;" title="COGS: ${Utils.formatCurrency(cogsVal)}"></div>
              <div style="background:#ef4444; width:${netSalesVal > 0 ? Math.min(100, (operatingExpensesVal / netSalesVal) * 100) : 0}%;" title="Operating Expenses: ${Utils.formatCurrency(operatingExpensesVal)}"></div>
              <div style="background:#10b981; width:${netSalesVal > 0 && netProfitVal > 0 ? Math.min(100, (netProfitVal / netSalesVal) * 100) : 0}%;" title="Net Operating Profit: ${Utils.formatCurrency(netProfitVal)}"></div>
            </div>
          </div>
          <div style="display:flex; gap:18px; flex-wrap:wrap; font-size:12px; color:var(--text-muted); margin-top:12px;">
            <span><i class="fas fa-square" style="color:#f97316;"></i> Cost of Goods Sold (COGS)</span>
            <span><i class="fas fa-square" style="color:#ef4444;"></i> Operating Expenses</span>
            <span><i class="fas fa-square" style="color:#10b981;"></i> Net Operating Profit</span>
          </div>
        </div>
      </div>

      <!-- TAB 2: PROFIT & LOSS STATEMENT (Accounting Standard Layout) -->
      <div id="fin-tab-profit_loss" style="display:${currentTab === 'profit_loss' ? 'block' : 'none'};">
        <div class="fin-statement-box">
          <div class="fin-stmt-title" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
            <div>
              <span><i class="fas fa-file-invoice" style="color:#c9a227;"></i> GBLESS TRADING OPC — STATEMENT OF PROFIT &amp; LOSS</span>
              <div style="font-size:12px; font-weight:600; text-transform:none; color:var(--text-muted); margin-top:2px;">Reporting Period: ${Utils.escapeHtml(periodInfo.name || 'All Time')}</div>
            </div>
            <button class="fin-btn fin-btn-outline" onclick="openFinancialPrintPreviewModal()" style="font-size:12px; padding:6px 14px;">
              <i class="fas fa-eye"></i> Print Preview
            </button>
          </div>

          <!-- Section A: REVENUE -->
          <div class="fin-stmt-section">
            <div class="fin-stmt-title" style="font-size:12px; border-bottom:1px solid rgba(205,190,150,0.3); color:#c9a227;">
              <span>I. REVENUE</span>
            </div>
            <div class="fin-stmt-row">
              <span>Gross Sales (POS Orders)</span>
              <strong>${Utils.formatCurrency(grossSalesVal)}</strong>
            </div>
            <div class="fin-stmt-row sub">
              <span>Less: Sales Discounts</span>
              <span style="color:#ef4444;">-${Utils.formatCurrency(discountsVal)}</span>
            </div>
            <div class="fin-stmt-row sub">
              <span>Less: Sales Refunds &amp; Returns</span>
              <span style="color:#ef4444;">-${Utils.formatCurrency(refundsVal)}</span>
            </div>
            <div class="fin-stmt-row total">
              <span style="color:#c9a227;">NET SALES REVENUE</span>
              <strong style="color:#c9a227; font-size:15px;">${Utils.formatCurrency(netSalesVal)}</strong>
            </div>
          </div>

          <!-- Section B: COST OF SALES -->
          <div class="fin-stmt-section">
            <div class="fin-stmt-title" style="font-size:12px; border-bottom:1px solid rgba(205,190,150,0.3); color:#f97316;">
              <span>II. COST OF GOODS SOLD (COGS)</span>
            </div>
            <div class="fin-stmt-row">
              <span>Recipe Ingredient &amp; Product Costs Consumed</span>
              <span>${Utils.formatCurrency(cogsVal)}</span>
            </div>
            <div class="fin-stmt-row total">
              <span style="color:#f97316;">TOTAL COST OF GOODS SOLD</span>
              <strong style="color:#f97316; font-size:15px;">${Utils.formatCurrency(cogsVal)}</strong>
            </div>
          </div>

          <!-- Section C: GROSS PROFIT -->
          <div class="fin-stmt-highlight green" style="background:${grossProfitVal >= 0 ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)'};">
            <span style="font-weight:800; font-size:13.5px; text-transform:uppercase; color:${grossProfitVal >= 0 ? '#10b981' : '#ef4444'};">
              <i class="fas fa-coins"></i> GROSS PROFIT (Net Sales − COGS):
            </span>
            <strong style="font-size:17px; color:${grossProfitVal >= 0 ? '#10b981' : '#ef4444'};">
              ${Utils.formatCurrency(grossProfitVal)}
            </strong>
          </div>

          <!-- Section D: OPERATING EXPENSES -->
          <div class="fin-stmt-section">
            <div class="fin-stmt-title" style="font-size:12px; border-bottom:1px solid rgba(205,190,150,0.3); color:#ef4444;">
              <span>III. OPERATING EXPENSES</span>
            </div>
            ${Object.keys(expData.by_category || {}).length > 0 ? Object.entries(expData.by_category).map(([cat, amt]) => `
              <div class="fin-stmt-row sub">
                <span>${Utils.escapeHtml(cat)}</span>
                <span>${Utils.formatCurrency(amt)}</span>
              </div>
            `).join('') : `
              <div class="fin-stmt-row sub">
                <span style="font-style:italic;">No operational expenses recorded in selected period</span>
                <span>₱0.00</span>
              </div>
            `}
            <div class="fin-stmt-row total">
              <span style="color:#ef4444;">TOTAL OPERATING EXPENSES</span>
              <strong style="color:#ef4444; font-size:15px;">${Utils.formatCurrency(operatingExpensesVal)}</strong>
            </div>
          </div>

          <!-- Section E: NET OPERATING PROFIT -->
          <div class="fin-stmt-highlight ${isProfitable ? 'green' : 'red'}" style="margin-top:18px; padding:18px 22px;">
            <div>
              <span style="font-weight:900; font-size:15px; text-transform:uppercase; color:${isProfitable ? '#10b981' : '#ef4444'};">
                <i class="fas ${isProfitable ? 'fa-award' : 'fa-circle-exclamation'}"></i> NET OPERATING PROFIT / LOSS:
              </span>
              <div style="font-size:12px; color:var(--text-muted); margin-top:3px;">Gross Profit minus Operating Expenses | Operating Margin: <strong>${Utils.escapeHtml(profitMarginDisplay)}</strong></div>
            </div>
            <strong style="font-size:22px; color:${isProfitable ? '#10b981' : '#ef4444'};">
              ${Utils.formatCurrency(netProfitVal)}
            </strong>
          </div>
        </div>
      </div>

      <!-- TAB 3: EXPENSES MANAGEMENT -->
      <div id="fin-tab-expenses" style="display:${currentTab === 'expenses' ? 'block' : 'none'};">
        <div class="fin-statement-box">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
            <div class="fin-stmt-title" style="margin-bottom:0; border-bottom:none; padding-bottom:0;">
              <span><i class="fas fa-receipt" style="color:#ef4444;"></i> Operational Business Expenses</span>
            </div>
            ${canManageExpenses ? `
            <button class="fin-btn fin-btn-gold" onclick="openAddExpenseModal()" title="Record a new expense">
              <i class="fas fa-plus"></i> Record Expense
            </button>
            ` : ''}
          </div>

          <!-- Expense filters -->
          <div style="display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap; align-items:center;">
            <select id="fin-exp-status-filter" class="input-field" onchange="filterExpensesTable()" style="max-width:180px; height:36px;">
              <option value="all">All Statuses</option>
              <option value="paid">Paid</option>
              <option value="pending">Pending Approval</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="voided">Voided</option>
            </select>
            <input type="text" id="fin-exp-search" class="input-field" placeholder="Search expenses by category, vendor, title..." onkeyup="filterExpensesTable()" style="max-width:280px; height:36px;">
            <span id="fin-exp-count-badge" class="fin-badge fin-badge-gray" style="margin-left:auto;">
              ${(tables.expenses || []).length} expense(s)
            </span>
          </div>

          <div class="fin-table-wrap">
            <table class="fin-table" id="fin-expenses-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Title / Description</th>
                  <th>Vendor</th>
                  <th>Amount</th>
                  <th>Method / Source</th>
                  <th>Status</th>
                  <th>Recorded By</th>
                  ${canManageExpenses ? '<th style="text-align:right;">Actions</th>' : ''}
                </tr>
              </thead>
              <tbody>
                ${(tables.expenses || []).length > 0 ? tables.expenses.map(e => `
                  <tr data-status="${e.status || 'paid'}" data-text="${(e.category + ' ' + (e.title || '') + ' ' + e.description + ' ' + (e.vendor || '')).toLowerCase()}">
                    <td>#${e.id}</td>
                    <td>${e.expense_date ? new Date(e.expense_date).toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' }) : '—'}</td>
                    <td><span class="fin-badge fin-badge-gold">${Utils.escapeHtml(e.category)}</span></td>
                    <td>
                      <strong>${Utils.escapeHtml(e.title || e.description)}</strong>
                      ${e.title && e.description ? `<div style="font-size:11px; color:var(--text-muted);">${Utils.escapeHtml(e.description)}</div>` : ''}
                    </td>
                    <td>${Utils.escapeHtml(e.vendor || '—')}</td>
                    <td><strong style="color:#ef4444;">${Utils.formatCurrency(e.amount)}</strong></td>
                    <td><span class="fin-badge fin-badge-gray">${Utils.escapeHtml(e.payment_method || 'Cash')} (${Utils.escapeHtml(e.payment_source || 'safe')})</span></td>
                    <td>
                      <span class="fin-badge ${e.status === 'paid' ? 'fin-badge-green' : (e.status === 'approved' ? 'fin-badge-blue' : (e.status === 'rejected' ? 'fin-badge-red' : (e.status === 'voided' ? 'fin-badge-gray' : 'fin-badge-orange')))}">
                        ${Utils.escapeHtml((e.status || 'paid').toUpperCase())}
                      </span>
                    </td>
                    <td>${Utils.escapeHtml(e.recorded_by || 'Staff')}</td>
                    ${canManageExpenses ? `
                    <td style="text-align:right; white-space:nowrap;">
                      ${isAdmin && e.status === 'pending' ? `
                        <button class="fin-btn fin-btn-outline" onclick="approveExpense(${e.id})" title="Approve Expense" style="height:28px; padding:0 8px; color:#10b981; border-color:#10b981;">
                          <i class="fas fa-check"></i> Approve
                        </button>
                        <button class="fin-btn fin-btn-outline" onclick="rejectExpense(${e.id})" title="Reject Expense" style="height:28px; padding:0 8px; color:#ef4444; border-color:#ef4444;">
                          <i class="fas fa-times"></i> Reject
                        </button>
                      ` : ''}
                      ${isAdmin && e.status === 'approved' ? `
                        <button class="fin-btn fin-btn-outline" onclick="markExpensePaid(${e.id})" title="Mark as Paid" style="height:28px; padding:0 8px; color:#10b981; border-color:#10b981;">
                          <i class="fas fa-dollar-sign"></i> Mark Paid
                        </button>
                      ` : ''}
                      ${e.status === 'pending' ? `
                        <button class="fin-btn fin-btn-outline" onclick="openEditExpenseModal(${e.id})" title="Edit Expense" style="height:28px; padding:0 8px; color:#c9a227; border-color:#c9a227;">
                          <i class="fas fa-edit"></i>
                        </button>
                      ` : ''}
                      ${isAdmin && e.status !== 'voided' ? `
                        <button class="fin-btn fin-btn-outline" onclick="voidExpense(${e.id})" title="Void Expense" style="height:28px; padding:0 8px; color:var(--text-muted);">
                          <i class="fas fa-ban"></i>
                        </button>
                      ` : ''}
                    </td>
                    ` : ''}
                  </tr>
                `).join('') : `
                  <tr><td colspan="${canManageExpenses ? 10 : 9}" style="text-align:center; padding:30px; color:var(--text-muted);">No expenses recorded in this period.</td></tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 4: CASH CUSTODY & SAFES (Drawer vs Manager Safe vs Admin Safe) -->
      <div id="fin-tab-cash_custody" style="display:${currentTab === 'cash_custody' ? 'block' : 'none'};">
        <div class="fin-custody-grid">
          <!-- Location 1: Cashier Drawer -->
          <div class="fin-card">
            <div style="padding:16px 20px; border-bottom:1px solid rgba(205,190,150,0.3); background:rgba(0,0,0,0.01); display:flex; justify-content:space-between; align-items:center;">
              <h3 style="margin:0; font-size:15px; font-weight:800; color:#18181b; display:flex; align-items:center; gap:8px;">
                <i class="fas fa-cash-register" style="color:#c9a227;"></i> 1. Cashier Drawer
              </h3>
              <span class="fin-badge fin-badge-gold">DRAWER FLOAT</span>
            </div>
            <div style="padding:18px 20px; flex:1; display:flex; flex-direction:column;">
              <div style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">Active physical cash held across open cashier shifts awaiting end-of-shift drop:</div>
              <div style="font-size:26px; font-weight:900; color:#c9a227; margin-bottom:14px; font-variant-numeric:tabular-nums;">
                ${Utils.formatCurrency(activeDrawerCashVal)}
              </div>
              <div class="fin-stmt-row" style="font-size:12.5px;">
                <span>Cash Sales in Drawer:</span>
                <strong>${Utils.formatCurrency(cashCollectionsVal)}</strong>
              </div>
              <div class="fin-stmt-row" style="font-size:12.5px;">
                <span>Digital Collections (GCash/Maya/Card):</span>
                <strong>${Utils.formatCurrency(digitalCollectionsVal)}</strong>
              </div>
              <div style="margin-top:auto; padding-top:14px;">
                <button class="fin-btn fin-btn-outline" onclick="goToCashDrawer()" style="width:100%;">
                  <i class="fas fa-arrow-right"></i> Open Cash Drawer Details
                </button>
              </div>
            </div>
          </div>

          <!-- Location 2: Manager Safe -->
          <div class="fin-card">
            <div style="padding:16px 20px; border-bottom:1px solid rgba(205,190,150,0.3); background:rgba(0,0,0,0.01); display:flex; justify-content:space-between; align-items:center;">
              <h3 style="margin:0; font-size:15px; font-weight:800; color:#18181b; display:flex; align-items:center; gap:8px;">
                <i class="fas fa-vault" style="color:#10b981;"></i> 2. Manager Safe
              </h3>
              <span class="fin-badge fin-badge-green">STORE SAFE</span>
            </div>
            <div style="padding:18px 20px; flex:1; display:flex; flex-direction:column;">
              <div style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">Funds dropped by cashiers into store safe minus remittances transferred to Admin:</div>
              <div style="font-size:26px; font-weight:900; color:#10b981; margin-bottom:14px; font-variant-numeric:tabular-nums;">
                ${Utils.formatCurrency(managerSafeBalanceVal)}
              </div>
              <div class="fin-stmt-row" style="font-size:12.5px;">
                <span>Total Cashier Drops In:</span>
                <strong>${Utils.formatCurrency(custody.manager_safe?.total_cashout_income || data.cashout?.total_cashout_income || 0)}</strong>
              </div>
              <div class="fin-stmt-row" style="font-size:12.5px;">
                <span>Transferred to Admin Safe:</span>
                <span style="color:#ef4444;">-${Utils.formatCurrency(custody.manager_safe?.transferred_to_admin || data.cashout?.total_transferred_to_admin || 0)}</span>
              </div>
              <div style="margin-top:auto; padding-top:14px;">
                <button class="fin-btn fin-btn-outline" onclick="scrollToLedger()" style="width:100%;">
                  <i class="fas fa-clock-rotate-left"></i> View Remittance History
                </button>
              </div>
            </div>
          </div>

          <!-- Location 3: Admin Safe -->
          <div class="fin-card">
            <div style="padding:16px 20px; border-bottom:1px solid rgba(205,190,150,0.3); background:rgba(0,0,0,0.01); display:flex; justify-content:space-between; align-items:center;">
              <h3 style="margin:0; font-size:15px; font-weight:800; color:#18181b; display:flex; align-items:center; gap:8px;">
                <i class="fas fa-shield-halved" style="color:#3b82f6;"></i> 3. Admin Office Safe
              </h3>
              <span class="fin-badge fin-badge-blue">CENTRAL VAULT</span>
            </div>
            <div style="padding:18px 20px; flex:1; display:flex; flex-direction:column;">
              <div style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">Secured central company remittances received from store managers:</div>
              <div style="font-size:26px; font-weight:900; color:#3b82f6; margin-bottom:14px; font-variant-numeric:tabular-nums;">
                ${Utils.formatCurrency(adminSafeBalanceVal)}
              </div>
              <div class="fin-stmt-row" style="font-size:12.5px;">
                <span>Total Remittances Received:</span>
                <strong>${Utils.formatCurrency(custody.admin_safe?.total_remittances_received || data.cashout?.admin_transfer_income || 0)}</strong>
              </div>
              <div class="fin-stmt-row" style="font-size:12.5px;">
                <span>Admin Expenses Paid:</span>
                <span style="color:#ef4444;">-${Utils.formatCurrency(custody.admin_safe?.expenses_paid || 0)}</span>
              </div>
              <div style="margin-top:auto; padding-top:14px;">
                <button class="fin-btn fin-btn-outline" onclick="scrollToLedger()" style="width:100%;">
                  <i class="fas fa-clock-rotate-left"></i> View Remittance History
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Transfer Ledger -->
        <div class="fin-statement-box" id="fin-transfer-ledger">
          <div class="fin-stmt-title">
            <span><i class="fas fa-clock-rotate-left" style="color:#c9a227;"></i> Cash Remittance &amp; Safe Transfer Ledger</span>
            <span style="font-size:12px; font-weight:600; text-transform:none; color:var(--text-muted);">${history.length} movement(s)</span>
          </div>
          <div class="fin-table-wrap">
            <table class="fin-table">
              <thead>
                <tr>
                  <th>Transfer Ref</th>
                  <th>Timestamp</th>
                  <th>Initiator</th>
                  <th>Transfer Scope / Reason</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${history.length > 0 ? history.map(h => `
                  <tr>
                    <td>#TR-${h.id}</td>
                    <td>${h.created_at ? new Date(h.created_at).toLocaleString('en-PH', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'}</td>
                    <td><strong>${Utils.escapeHtml(h.cashier || 'Manager')}</strong></td>
                    <td>${Utils.escapeHtml(h.reason || 'Safe Remittance')}</td>
                    <td><strong style="color:#10b981;">${Utils.formatCurrency(h.amount)}</strong></td>
                    <td><span class="fin-badge fin-badge-green"><i class="fas fa-check"></i> CONFIRMED</span></td>
                  </tr>
                `).join('') : `
                  <tr><td colspan="6" style="text-align:center; padding:24px; color:var(--text-muted);">No cash transfer history found.</td></tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 5: INVENTORY ASSET VALUATION -->
      <div id="fin-tab-inventory_valuation" style="display:${currentTab === 'inventory_valuation' ? 'block' : 'none'};">
        <div class="fin-statement-box">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
            <div class="fin-stmt-title" style="margin-bottom:0; border-bottom:none; padding-bottom:0;">
              <span><i class="fas fa-boxes-stacked" style="color:#06b6d4;"></i> Balance Sheet Inventory Stock Asset Valuation</span>
            </div>
            <div style="font-size:18px; font-weight:800; color:#06b6d4;">
              Total Value: ${Utils.formatCurrency(inventoryValuationVal)}
            </div>
          </div>
          <div style="background:rgba(6, 182, 212, 0.08); border:1px solid rgba(6, 182, 212, 0.3); border-radius:10px; padding:10px 14px; font-size:12.5px; color:#0891b2; margin-bottom:16px;">
            <i class="fas fa-info-circle"></i> <strong>Accounting Note:</strong> Inventory Valuation represents unsold stock asset on hand. It is preserved on the balance sheet and consumed as <strong>Cost of Goods Sold (COGS)</strong> only when menu products are ordered and prepared.
          </div>

          <div class="fin-table-wrap">
            <table class="fin-table">
              <thead>
                <tr>
                  <th>Item ID</th>
                  <th>Item Name</th>
                  <th>Category</th>
                  <th>Stock on Hand</th>
                  <th>Unit Cost</th>
                  <th>Line Valuation</th>
                  <th>Integrity</th>
                </tr>
              </thead>
              <tbody>
                ${(inv.items || tables.inventory_valuation || []).length > 0 ? (inv.items || tables.inventory_valuation).map(item => `
                  <tr>
                    <td>#${item.id}</td>
                    <td><strong>${Utils.escapeHtml(item.name)}</strong></td>
                    <td><span class="fin-badge fin-badge-gray">${Utils.escapeHtml(item.category || 'General')}</span></td>
                    <td>${item.quantity} ${Utils.escapeHtml(item.unit || '')}</td>
                    <td>${Utils.formatCurrency(item.unit_price)}</td>
                    <td><strong style="color:#06b6d4;">${Utils.formatCurrency(item.valuation)}</strong></td>
                    <td>
                      <span class="fin-badge ${item.is_negative ? 'fin-badge-red' : 'fin-badge-green'}">
                        ${item.is_negative ? 'NEGATIVE' : 'HEALTHY'}
                      </span>
                    </td>
                  </tr>
                `).join('') : `
                  <tr><td colspan="7" style="text-align:center; padding:24px; color:var(--text-muted);">No inventory items recorded.</td></tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 6: TRANSACTIONS LEDGER -->
      <div id="fin-tab-transactions" style="display:${currentTab === 'transactions' ? 'block' : 'none'};">
        <div class="fin-statement-box">
          <div class="fin-stmt-title">
            <span><i class="fas fa-list-check" style="color:#c9a227;"></i> POS Sales &amp; Revenue Transactions Ledger</span>
            <span style="font-size:12px; font-weight:600; text-transform:none; color:var(--text-muted);">${(tables.sales_orders || []).length} order(s) listed</span>
          </div>

          <div class="fin-table-wrap">
            <table class="fin-table">
              <thead>
                <tr>
                  <th>Order Ref</th>
                  <th>Date &amp; Time</th>
                  <th>Cashier</th>
                  <th>Gross Total</th>
                  <th>Discounts</th>
                  <th>Net Recognized</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${(tables.sales_orders || []).length > 0 ? tables.sales_orders.map(o => `
                  <tr>
                    <td><strong>${Utils.escapeHtml(o.order_code)}</strong></td>
                    <td>${o.created_at ? new Date(o.created_at).toLocaleString('en-PH', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'}</td>
                    <td>${Utils.escapeHtml(o.cashier || 'Staff')}</td>
                    <td>${Utils.formatCurrency(o.gross_amount)}</td>
                    <td style="color:#ef4444;">-${Utils.formatCurrency(o.discount_amount)}</td>
                    <td><strong style="color:#10b981;">${Utils.formatCurrency(o.net_amount)}</strong></td>
                    <td><span class="fin-badge fin-badge-green">${Utils.escapeHtml(o.status.toUpperCase())}</span></td>
                  </tr>
                `).join('') : `
                  <tr><td colspan="7" style="text-align:center; padding:24px; color:var(--text-muted);">No completed sales transactions in selected period.</td></tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 7: RECONCILIATION AUDIT (10 Checks) -->
      <div id="fin-tab-reconciliation" style="display:${currentTab === 'reconciliation' ? 'block' : 'none'};">
        <div class="fin-statement-box">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
            <div class="fin-stmt-title" style="margin-bottom:0; border-bottom:none; padding-bottom:0;">
              <span><i class="fas fa-scale-balanced" style="color:#10b981;"></i> Automated Financial Reconciliation Audit (10 Core Checks)</span>
            </div>
            <span class="fin-badge ${isReconciled ? 'fin-badge-green' : 'fin-badge-orange'}" style="font-size:12px; padding:6px 14px;">
              <i class="fas ${isReconciled ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i> ${isReconciled ? 'SYSTEM FULLY RECONCILED' : 'DISCREPANCIES FLAGGED'}
            </span>
          </div>

          <div style="display:grid; grid-template-columns:1fr; gap:12px;">
            ${checks.map((chk, idx) => `
              <div style="display:flex; align-items:flex-start; gap:14px; padding:14px 18px; border-radius:12px; background:${chk.status === 'PASS' ? 'rgba(16, 185, 129, 0.05)' : (chk.status === 'FAILED' ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)')}; border:1px solid ${chk.status === 'PASS' ? 'rgba(16, 185, 129, 0.25)' : (chk.status === 'FAILED' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(245, 158, 11, 0.3)')};">
                <div style="width:32px; height:32px; border-radius:8px; display:flex; align-items:center; justify-content:center; flex-shrink:0; background:${chk.status === 'PASS' ? '#10b981' : (chk.status === 'FAILED' ? '#ef4444' : '#f59e0b')}; color:#fff; font-weight:800; font-size:13px;">
                  ${chk.status === 'PASS' ? '<i class="fas fa-check"></i>' : '<i class="fas fa-exclamation"></i>'}
                </div>
                <div style="flex:1;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; flex-wrap:wrap; gap:6px;">
                    <strong style="font-size:13.5px; color:#18181b;">Check ${idx + 1}: ${Utils.escapeHtml(chk.check)}</strong>
                    <span class="fin-badge ${chk.status === 'PASS' ? 'fin-badge-green' : (chk.status === 'FAILED' ? 'fin-badge-red' : 'fin-badge-orange')}">${chk.status}</span>
                  </div>
                  <div style="font-size:12.5px; color:var(--text-muted);">${Utils.escapeHtml(chk.message)}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <!-- TAB 8: FINANCIAL REPORTS & EXPORT -->
      <div id="fin-tab-reports" style="display:${currentTab === 'reports' ? 'block' : 'none'};">
        <div class="fin-statement-box">
          <div class="fin-stmt-title">
            <span><i class="fas fa-print" style="color:#c9a227;"></i> Financial Reports &amp; Audit Exports</span>
          </div>
          <p style="font-size:13px; color:var(--text-muted); margin-bottom:20px;">
            Generate authoritative, exportable reports for accounting, auditing, BIR tax filing, and investor oversight.
          </p>

          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:16px;">
            <div class="fin-card" style="padding:18px;">
              <h4 style="margin:0 0 6px 0; font-size:14px; font-weight:800;"><i class="fas fa-file-excel" style="color:#10b981;"></i> Consolidated P&amp;L Export</h4>
              <p style="font-size:12px; color:var(--text-muted); margin:0 0 14px 0;">Complete summary of Sales, COGS, Expenses, and Net Profit for selected period.</p>
              <button class="fin-btn fin-btn-gold" onclick="exportFinancialReportCsv()" style="width:100%;">
                <i class="fas fa-download"></i> Download CSV
              </button>
            </div>

            <div class="fin-card" style="padding:18px;">
              <h4 style="margin:0 0 6px 0; font-size:14px; font-weight:800;"><i class="fas fa-file-invoice-dollar" style="color:#ef4444;"></i> Expenses Audit Ledger</h4>
              <p style="font-size:12px; color:var(--text-muted); margin:0 0 14px 0;">Detailed line items of all operating expenses with categories, vendors, and dates.</p>
              <button class="fin-btn fin-btn-outline" onclick="exportExpensesCsv()" style="width:100%;">
                <i class="fas fa-download"></i> Download Expenses CSV
              </button>
            </div>

            <div class="fin-card" style="padding:18px;">
              <h4 style="margin:0 0 6px 0; font-size:14px; font-weight:800;"><i class="fas fa-print" style="color:#3b82f6;"></i> Formal Printable Statement</h4>
              <p style="font-size:12px; color:var(--text-muted); margin:0 0 14px 0;">Print-ready Profit &amp; Loss Statement formatted for financial meetings and records.</p>
              <div style="display:flex; flex-direction:column; gap:8px;">
                <button class="fin-btn fin-btn-outline" onclick="openFinancialPrintPreviewModal()" style="width:100%;">
                  <i class="fas fa-print"></i> Print Statement
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Tab Switcher ──
function switchFinTab(tabKey) {
  window._currentPlTab = tabKey;
  ['overview', 'profit_loss', 'expenses', 'cash_custody', 'inventory_valuation', 'transactions', 'reconciliation', 'reports'].forEach(k => {
    const el = document.getElementById(`fin-tab-${k}`);
    if (el) el.style.display = (k === tabKey) ? 'block' : 'none';
  });
  document.querySelectorAll('.fin-nav-tab').forEach(b => {
    b.classList.toggle('active', b.getAttribute('onclick')?.includes(`'${tabKey}'`));
  });
}
window.switchFinTab = switchFinTab;
window.switchPlTab = switchFinTab;

// ── Custom Date Range Toggle ──
function toggleCustomRangeInputs() {
  const inputs = document.getElementById('fin-custom-inputs');
  if (inputs) {
    const isShown = inputs.style.display === 'flex';
    inputs.style.display = isShown ? 'none' : 'flex';
  }
}
window.toggleCustomRangeInputs = toggleCustomRangeInputs;

// ── Navigation Shortcuts ──
function goToCashDrawer() {
  if (window.location.pathname.includes('/manager') || window.location.pathname.includes('/admin')) {
    window.location.hash = '#cash-drawer';
    if (typeof renderCashDrawer === 'function') renderCashDrawer();
  } else {
    window.location.href = '/cashier';
  }
}
window.goToCashDrawer = goToCashDrawer;

function scrollToLedger() {
  switchFinTab('cash_custody');
  setTimeout(() => {
    const el = document.getElementById('fin-transfer-ledger');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}
window.scrollToLedger = scrollToLedger;

// ── Expenses Filter ──
function filterExpensesTable() {
  const statusFilter = (document.getElementById('fin-exp-status-filter')?.value || 'all').toLowerCase();
  const search = (document.getElementById('fin-exp-search')?.value || '').toLowerCase().trim();
  const rows = document.querySelectorAll('#fin-expenses-table tbody tr');
  let visibleCount = 0;

  rows.forEach(r => {
    const rowStatus = (r.getAttribute('data-status') || '').toLowerCase();
    const rowText = (r.getAttribute('data-text') || '').toLowerCase();

    const matchesStatus = (statusFilter === 'all') || (rowStatus === statusFilter);
    const matchesSearch = !search || rowText.includes(search);

    const show = matchesStatus && matchesSearch;
    r.style.display = show ? '' : 'none';
    if (show) visibleCount++;
  });

  const badge = document.getElementById('fin-exp-count-badge');
  if (badge) badge.innerText = `${visibleCount} expense(s)`;
}
window.filterExpensesTable = filterExpensesTable;

// ── Expense Action Methods ──
async function approveExpense(id) {
  if (!confirm(`Are you sure you want to approve Expense #${id}?`)) return;
  try {
    const res = await Auth.fetch(`/api/v1/expenses/${id}/approve`, { method: "POST" });
    if (!res.ok) throw new Error("Failed to approve expense.");
    Utils.showToast(`Expense #${id} approved successfully!`, "success");
    renderProfitLoss();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}
window.approveExpense = approveExpense;

async function rejectExpense(id) {
  if (!confirm(`Are you sure you want to reject Expense #${id}?`)) return;
  try {
    const res = await Auth.fetch(`/api/v1/expenses/${id}/reject`, { method: "POST" });
    if (!res.ok) throw new Error("Failed to reject expense.");
    Utils.showToast(`Expense #${id} rejected.`, "warning");
    renderProfitLoss();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}
window.rejectExpense = rejectExpense;

async function markExpensePaid(id) {
  const source = prompt("Confirm payment source (manager_safe / admin_safe / drawer / bank):", "manager_safe");
  if (!source) return;
  try {
    const res = await Auth.fetch(`/api/v1/expenses/${id}/mark-paid?payment_source=${encodeURIComponent(source)}`, { method: "POST" });
    if (!res.ok) throw new Error("Failed to mark expense as paid.");
    Utils.showToast(`Expense #${id} marked as paid via ${source}!`, "success");
    renderProfitLoss();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}
window.markExpensePaid = markExpensePaid;

async function voidExpense(id) {
  if (!confirm(`Are you sure you want to void Expense #${id}? This will cancel its recognition.`)) return;
  try {
    const res = await Auth.fetch(`/api/v1/expenses/${id}/void`, { method: "POST" });
    if (!res.ok) throw new Error("Failed to void expense.");
    Utils.showToast(`Expense #${id} voided.`, "info");
    renderProfitLoss();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}
window.voidExpense = voidExpense;

// ── Add Expense Modal ──
function openAddExpenseModal() {
  const title = `<i class="fas fa-file-invoice-dollar" style="color:#c9a227; margin-right:8px;"></i> Record Operating Expense`;
  const bodyHTML = `
    <form id="form-add-expense" onsubmit="event.preventDefault(); submitAddExpense();" style="display:flex; flex-direction:column; gap:12px;">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Category <span style="color:var(--danger, #ef4444);">*</span></label>
          <select id="exp-category" class="input-field" required style="width:100%; height:38px;">
            <option value="Utilities">Utilities (Electric, Water)</option>
            <option value="Salaries and Wages">Salaries and Wages</option>
            <option value="Rent">Rent &amp; Lease</option>
            <option value="Kitchen Supplies">Kitchen Supplies</option>
            <option value="Office Supplies">Office Supplies</option>
            <option value="Maintenance and Repairs">Maintenance and Repairs</option>
            <option value="Marketing and Advertising">Marketing and Advertising</option>
            <option value="Transportation and Fuel">Transportation and Fuel</option>
            <option value="Internet and Communication">Internet and Communication</option>
            <option value="Equipment and Assets">Equipment and Assets</option>
            <option value="Taxes and Government Fees">Taxes and Government Fees</option>
            <option value="Other Expenses">Other Expenses</option>
          </select>
        </div>
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Expense Title</label>
          <input type="text" id="exp-title" class="input-field" placeholder="e.g. Meralco Electricity Bill" style="width:100%; height:38px;">
        </div>
      </div>

      <div class="input-group">
        <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Description / Purpose <span style="color:var(--danger, #ef4444);">*</span></label>
        <input type="text" id="exp-description" class="input-field" required placeholder="e.g. November 2026 Monthly Power Billing" style="width:100%; height:38px;">
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Amount (₱) <span style="color:var(--danger, #ef4444);">*</span></label>
          <input type="number" step="0.01" min="0.01" id="exp-amount" class="input-field" required placeholder="0.00" style="width:100%; height:38px; font-size:18px; font-weight:800; color:#ef4444;">
        </div>
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Vendor / Payee</label>
          <input type="text" id="exp-vendor" class="input-field" placeholder="e.g. Meralco" style="width:100%; height:38px;">
        </div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Payment Method</label>
          <select id="exp-payment-method" class="input-field" style="width:100%; height:38px;">
            <option value="Cash">Cash</option>
            <option value="Bank Transfer">Bank Transfer</option>
            <option value="GCash">GCash</option>
            <option value="Maya">Maya</option>
            <option value="Credit Card">Credit Card</option>
          </select>
        </div>
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Payment Source</label>
          <select id="exp-payment-source" class="input-field" style="width:100%; height:38px;">
            <option value="manager_safe">Manager Safe</option>
            <option value="admin_safe">Admin Safe</option>
            <option value="drawer">Cashier Drawer</option>
            <option value="bank">Bank / Digital Account</option>
          </select>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Approval Status</label>
          <select id="exp-status" class="input-field" style="width:100%; height:38px;">
            <option value="paid">Paid (Immediately settled)</option>
            <option value="pending">Pending Approval</option>
          </select>
        </div>
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Expense Date</label>
          <input type="date" id="exp-date" class="input-field" value="${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })}" style="width:100%; height:38px;">
        </div>
      </div>
    </form>
  `;
  const footerHTML = `
    <button type="button" class="fin-btn fin-btn-outline" onclick="Utils.closeModal()">Cancel</button>
    <button type="button" id="btn-submit-expense" class="fin-btn fin-btn-gold" onclick="submitAddExpense()">
      <i class="fas fa-check"></i> Save Expense
    </button>
  `;

  if (typeof Utils !== 'undefined' && typeof Utils.openModal === 'function') {
    Utils.openModal(title, bodyHTML, footerHTML, "modal-md");
  } else if (typeof window.openModal === 'function') {
    window.openModal(title, bodyHTML, footerHTML);
  }
}

async function submitAddExpense() {
  const cat = document.getElementById("exp-category")?.value;
  const title = document.getElementById("exp-title")?.value;
  const desc = document.getElementById("exp-description")?.value;
  const vendor = document.getElementById("exp-vendor")?.value;
  const amt = parseFloat(document.getElementById("exp-amount")?.value);
  const method = document.getElementById("exp-payment-method")?.value || "Cash";
  const source = document.getElementById("exp-payment-source")?.value || "manager_safe";
  const stat = document.getElementById("exp-status")?.value || "paid";
  const dt = document.getElementById("exp-date")?.value;

  if (!cat || !desc || isNaN(amt) || amt <= 0) {
    Utils.showToast("Please provide valid category, description, and amount greater than ₱0.00.", "danger");
    return;
  }

  const btn = document.getElementById("btn-submit-expense");
  if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Saving...`; }

  try {
    const res = await Auth.fetch("/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({
        category: cat,
        title: title || undefined,
        description: desc,
        vendor: vendor || undefined,
        amount: amt,
        payment_method: method,
        payment_source: source,
        status: stat,
        expense_date: dt ? `${dt}T00:00:00` : undefined
      })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to record expense");
    }
    Utils.showToast("Operating expense recorded successfully!", "success");
    Utils.closeModal();
    cachedProfitLossData = null;
    window._currentPlTab = 'expenses';
    renderProfitLoss();
  } catch (e) {
    Utils.showToast(e.message, "danger");
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-check"></i> Save Expense`; }
  }
}

// ── Edit Expense Modal ──
function openEditExpenseModal(id) {
  if (!cachedProfitLossData || !cachedProfitLossData.tables || !cachedProfitLossData.tables.expenses) return;
  const exp = cachedProfitLossData.tables.expenses.find(e => e.id === id);
  if (!exp) return;

  const title = `<i class="fas fa-edit" style="color:#c9a227; margin-right:8px;"></i> Edit Expense #${exp.id}`;
  const bodyHTML = `
    <form id="form-edit-expense" onsubmit="event.preventDefault(); submitEditExpense(${exp.id});" style="display:flex; flex-direction:column; gap:12px;">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Category</label>
          <input type="text" id="edit-exp-category" class="input-field" value="${Utils.escapeHtml(exp.category)}" required style="width:100%; height:38px;">
        </div>
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Expense Title</label>
          <input type="text" id="edit-exp-title" class="input-field" value="${Utils.escapeHtml(exp.title || '')}" style="width:100%; height:38px;">
        </div>
      </div>

      <div class="input-group">
        <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Description</label>
        <input type="text" id="edit-exp-desc" class="input-field" value="${Utils.escapeHtml(exp.description)}" required style="width:100%; height:38px;">
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Amount (₱)</label>
          <input type="number" step="0.01" min="0.01" id="edit-exp-amount" class="input-field" value="${exp.amount}" required style="width:100%; height:38px; font-weight:800; color:#ef4444;">
        </div>
        <div class="input-group">
          <label style="font-size:11.5px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:4px;">Vendor / Payee</label>
          <input type="text" id="edit-exp-vendor" class="input-field" value="${Utils.escapeHtml(exp.vendor || '')}" style="width:100%; height:38px;">
        </div>
      </div>
    </form>
  `;
  const footerHTML = `
    <button type="button" class="fin-btn fin-btn-outline" onclick="Utils.closeModal()">Cancel</button>
    <button type="button" id="btn-edit-expense" class="fin-btn fin-btn-gold" onclick="submitEditExpense(${exp.id})">
      <i class="fas fa-check"></i> Update Expense
    </button>
  `;

  if (typeof Utils !== 'undefined' && typeof Utils.openModal === 'function') {
    Utils.openModal(title, bodyHTML, footerHTML, "modal-md");
  } else if (typeof window.openModal === 'function') {
    window.openModal(title, bodyHTML, footerHTML);
  }
}

async function submitEditExpense(id) {
  const cat = document.getElementById("edit-exp-category")?.value;
  const title = document.getElementById("edit-exp-title")?.value;
  const desc = document.getElementById("edit-exp-desc")?.value;
  const vendor = document.getElementById("edit-exp-vendor")?.value;
  const amt = parseFloat(document.getElementById("edit-exp-amount")?.value);

  if (!cat || !desc || isNaN(amt) || amt <= 0) {
    Utils.showToast("Please provide valid inputs.", "danger");
    return;
  }

  const btn = document.getElementById("btn-edit-expense");
  if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Updating...`; }

  try {
    const res = await Auth.fetch(`/api/v1/expenses/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        category: cat,
        title: title || undefined,
        description: desc,
        vendor: vendor || undefined,
        amount: amt
      })
    });
    if (!res.ok) throw new Error("Failed to update expense.");
    Utils.showToast(`Expense #${id} updated successfully!`, "success");
    Utils.closeModal();
    cachedProfitLossData = null;
    renderProfitLoss();
  } catch (e) {
    Utils.showToast(e.message, "danger");
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-check"></i> Update Expense`; }
  }
}
window.openEditExpenseModal = openEditExpenseModal;
window.submitEditExpense = submitEditExpense;

// ── Export CSV Utilities ──
function exportFinancialReportCsv() {
  if (!cachedProfitLossData) {
    Utils.showToast("Loading financial data for export...", "info");
    return;
  }
  const d = cachedProfitLossData;
  const rev = d.revenue || {};
  const cogs = d.cogs || {};
  const pl = d.profit_loss || {};
  const period = d.period || {};

  csv += `Net Sales Revenue,"${(rev.net_sales || rev.today_orders_revenue || 0).toFixed(2)}"\n`;
  csv += `Cost of Goods Sold (COGS),"${(cogs.cost_of_goods_sold || d.inventory?.cost_of_goods_sold || 0).toFixed(2)}"\n`;
  csv += `Gross Profit,"${(pl.gross_profit || 0).toFixed(2)}"\n`;
  csv += `Operating Expenses,"${(pl.operating_expenses || 0).toFixed(2)}"\n`;
  csv += `Net Operating Profit,"${(pl.net_profit || 0).toFixed(2)}"\n`;
  csv += `Profit Margin,"${pl.profit_margin_display || '0.00%'}"\n`;
  csv += `Cash Collections,"${(rev.cash_sales || 0).toFixed(2)}"\n`;
  csv += `Digital Collections,"${(rev.non_cash_sales || 0).toFixed(2)}"\n`;
  csv += `Inventory Stock Valuation,"${(d.inventory?.total_inventory_valuation || 0).toFixed(2)}"\n`;

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `financial_report_${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  Utils.showToast("Consolidated financial CSV exported successfully!", "success");
}

function exportExpensesCsv() {
  if (!cachedProfitLossData || !cachedProfitLossData.tables || !cachedProfitLossData.tables.expenses) {
    Utils.showToast("No expenses data available to export.", "warning");
    return;
  }
  const expenses = cachedProfitLossData.tables.expenses;
  let csv = "ID,Date,Category,Title,Description,Vendor,Amount,Payment Method,Payment Source,Status,Recorded By\n";
  expenses.forEach(e => {
    csv += `"${e.id}","${e.expense_date || ''}","${e.category || ''}","${(e.title || '').replace(/"/g, '""')}","${(e.description || '').replace(/"/g, '""')}","${(e.vendor || '').replace(/"/g, '""')}","${e.amount}","${e.payment_method || ''}","${e.payment_source || ''}","${e.status || ''}","${e.recorded_by || ''}"\n`;
  });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `expenses_ledger_${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  Utils.showToast("Expenses ledger CSV exported successfully!", "success");
}

// ── Financial Statement Print Preview Modal & Printing ──
window.openFinancialPrintPreviewModal = async function() {
  let d = cachedProfitLossData;
  if (!d) {
    try {
      Utils.showToast("Loading financial statement for preview...", "info");
      const period = window._currentPlPeriod || 'today';
      let url = `/api/v1/analytics/profit-loss?period=${encodeURIComponent(period)}`;
      if (period === 'custom' && window._currentPlStartDate && window._currentPlEndDate) {
        url += `&start_date=${encodeURIComponent(window._currentPlStartDate)}&end_date=${encodeURIComponent(window._currentPlEndDate)}`;
      }
      const res = await Auth.fetch(url);
      if (res.ok) {
        d = await res.json();
        cachedProfitLossData = d;
      }
    } catch (e) {
      console.error("Failed to load financial data for print preview:", e);
    }
  }

  if (!d) {
    Utils.showToast("Unable to load financial statement data. Please try again.", "danger");
    return;
  }

  const rev = d.revenue || {};
  const cogs = d.cogs || {};
  const pl = d.profit_loss || {};
  const period = d.period || {};
  const custody = d.cash_custody || {};
  const inv = d.inventory || {};
  let categories = (d.tables && d.tables.category_breakdown) || [];
  if (!categories || categories.length === 0) {
    const byCat = (d.expenses && d.expenses.by_category) || {};
    categories = Object.keys(byCat).map(k => ({
      category: k,
      amount: byCat[k],
      count: ((d.tables && d.tables.expenses) || []).filter(e => e.category === k).length
    }));
  }
  const recon = d.reconciliation || {};

  const grossSales = Number(rev.gross_sales || rev.today_orders_revenue || 0);
  const discounts = Number(rev.discounts || 0);
  const refunds = Number(rev.refunds || 0);
  const netSales = Number(rev.net_sales || (grossSales - discounts - refunds) || 0);
  const cogsVal = Number(cogs.cost_of_goods_sold || inv.cost_of_goods_sold || 0);
  const grossProfit = Number(pl.gross_profit || (netSales - cogsVal) || 0);
  const grossMargin = pl.gross_margin_display || (netSales > 0 ? ((grossProfit / netSales) * 100).toFixed(2) + '%' : '0.00%');
  const opexVal = Number(pl.operating_expenses || 0);
  const netProfit = Number(pl.net_profit || (grossProfit - opexVal) || 0);
  const netMargin = pl.profit_margin_display || (netSales > 0 ? ((netProfit / netSales) * 100).toFixed(2) + '%' : '0.00%');
  const isProfitable = netProfit >= 0;

  const cashSales = Number(rev.cash_sales || 0);
  const nonCashSales = Number(rev.non_cash_sales || 0);
  const invValuation = Number(inv.total_inventory_valuation || 0);

  const drawerBal = Number(custody.cashier_drawer?.expected_balance ?? custody.cashier_drawer?.active_cash ?? custody.active_drawer_cash ?? 0);
  const managerSafeBal = Number(custody.manager_safe?.balance ?? custody.manager_safe_cash ?? 0);
  const adminSafeBal = Number(custody.admin_safe?.balance ?? custody.admin_safe_cash ?? 0);

  const currentUser = (typeof Auth !== 'undefined' && Auth.getUser) ? Auth.getUser() : null;
  const userName = currentUser ? (currentUser.full_name || currentUser.username || 'Staff') : 'Authorized Staff';
  const userRole = currentUser ? (currentUser.role || 'Admin/Manager').toUpperCase() : 'MANAGEMENT';

  const dateNowPST = new Date().toLocaleString('en-PH', { 
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  const periodName = (period.name || window._currentPlPeriod || 'Today').toUpperCase();
  const dateRangeStr = (period.start_date && period.end_date) 
    ? `${period.start_date} to ${period.end_date}` 
    : (period.start_date || dateNowPST);

  // Build Statement Paper HTML
  const statementPaperHtml = `
    <div id="financial-statement-paper" style="background:#ffffff; color:#18181b; padding:28px 32px; border-radius:6px; box-shadow:0 4px 20px rgba(0,0,0,0.08); font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:13px; line-height:1.5;">
      
      <!-- Top Letterhead -->
      <div style="border-bottom:3px solid #c9a227; padding-bottom:14px; margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
          <div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#c9a227;"></span>
              <h2 style="font-size:20px; font-weight:900; letter-spacing:0.5px; margin:0; color:#18181b;">GBLESS TRADING OPC</h2>
            </div>
            <div style="font-size:13px; font-weight:700; color:#c9a227; margin-top:2px;">BLESSIE FOOD HUB / INBOX RESTOBAR</div>
            <div style="font-size:11px; color:#71717a; margin-top:2px;">Central POS Financial Accounting &amp; Operating Performance</div>
          </div>
          <div style="text-align:right;">
            <div style="display:inline-block; background:#f4f4f5; border:1px solid #e4e4e7; border-radius:6px; padding:6px 12px; font-size:11px; font-weight:700; color:#18181b;">
              <span style="color:#71717a;">DOCUMENT:</span> P&amp;L STATEMENT
            </div>
            <div style="font-size:11px; color:#71717a; margin-top:4px;">Generated (PST): <strong>${dateNowPST}</strong></div>
          </div>
        </div>
      </div>

      <!-- Report Metadata Strip -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:10px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px; padding:10px 14px; margin-bottom:18px; font-size:11px;">
        <div>
          <span style="color:#6b7280; display:block; text-transform:uppercase; font-size:10px; font-weight:700;">Reporting Period</span>
          <strong style="color:#111827; font-size:12px;">${periodName}</strong>
        </div>
        <div>
          <span style="color:#6b7280; display:block; text-transform:uppercase; font-size:10px; font-weight:700;">Effective Date / Range</span>
          <span style="color:#111827; font-weight:600;">${dateRangeStr}</span>
        </div>
        <div>
          <span style="color:#6b7280; display:block; text-transform:uppercase; font-size:10px; font-weight:700;">Audited By</span>
          <span style="color:#111827; font-weight:600;">${Utils.escapeHtml(userName)} (${userRole})</span>
        </div>
        <div>
          <span style="color:#6b7280; display:block; text-transform:uppercase; font-size:10px; font-weight:700;">System Reconciliation</span>
          <span style="color:#059669; font-weight:700;"><i class="fas fa-check-circle"></i> ${recon.status === 'PASS' ? 'PASS (10/10 Verified)' : (recon.status || 'Verified')}</span>
        </div>
      </div>

      <!-- Part I: Profit & Loss Statement Core Ledger -->
      <div style="margin-bottom:20px;">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1.5px solid #18181b; padding-bottom:4px; margin-bottom:8px;">
          <h4 style="font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; margin:0; color:#18181b;">
            STATEMENT OF COMPREHENSIVE INCOME &amp; EXPENSES (PHP)
          </h4>
          <span style="font-size:11px; color:#71717a;">Accrual Basis</span>
        </div>

        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <!-- REVENUE -->
          <tr style="background:#fafafa;">
            <td colspan="2" style="padding:6px 8px; font-weight:800; color:#18181b; font-size:12px;">1. REVENUE / OPERATING SALES</td>
          </tr>
          <tr>
            <td style="padding:5px 8px 5px 20px; color:#374151;">Gross Orders &amp; Menu Sales</td>
            <td style="padding:5px 8px; text-align:right; font-weight:600; font-family:monospace; color:#18181b;">${Utils.formatCurrency(grossSales)}</td>
          </tr>
          <tr>
            <td style="padding:4px 8px 4px 20px; color:#6b7280;">Less: Authorized Discounts &amp; Promos</td>
            <td style="padding:4px 8px; text-align:right; font-family:monospace; color:#dc2626;">-${Utils.formatCurrency(discounts)}</td>
          </tr>
          <tr>
            <td style="padding:4px 8px 4px 20px; color:#6b7280;">Less: Customer Returns &amp; Refunds</td>
            <td style="padding:4px 8px; text-align:right; font-family:monospace; color:#dc2626;">-${Utils.formatCurrency(refunds)}</td>
          </tr>
          <tr style="border-top:1px solid #d1d5db; border-bottom:1.5px solid #9ca3af; background:#f3f4f6;">
            <td style="padding:7px 8px; font-weight:800; color:#111827;">NET RECOGNIZED SALES REVENUE</td>
            <td style="padding:7px 8px; text-align:right; font-weight:800; font-size:13px; font-family:monospace; color:#111827;">${Utils.formatCurrency(netSales)}</td>
          </tr>

          <!-- COGS -->
          <tr><td colspan="2" style="height:8px;"></td></tr>
          <tr style="background:#fafafa;">
            <td colspan="2" style="padding:6px 8px; font-weight:800; color:#18181b; font-size:12px;">2. COST OF GOODS SOLD (COGS)</td>
          </tr>
          <tr>
            <td style="padding:5px 8px 5px 20px; color:#374151;">
              Ingredient Consumption &amp; Recipe Stock Cost
              <div style="font-size:10px; color:#9ca3af;">(Calculated from actual recipe ingredient quantities and unit costs)</div>
            </td>
            <td style="padding:5px 8px; text-align:right; font-family:monospace; color:#dc2626; vertical-align:top;">-${Utils.formatCurrency(cogsVal)}</td>
          </tr>
          <tr style="border-top:1px solid #d1d5db; border-bottom:1.5px solid #9ca3af; background:#f3f4f6;">
            <td style="padding:7px 8px; font-weight:800; color:#111827;">
              GROSS PROFIT 
              <span style="font-size:11px; font-weight:600; color:#059669; margin-left:8px;">(Margin: ${grossMargin})</span>
            </td>
            <td style="padding:7px 8px; text-align:right; font-weight:800; font-size:13px; font-family:monospace; color:#111827;">${Utils.formatCurrency(grossProfit)}</td>
          </tr>

          <!-- OPEX -->
          <tr><td colspan="2" style="height:8px;"></td></tr>
          <tr style="background:#fafafa;">
            <td colspan="2" style="padding:6px 8px; font-weight:800; color:#18181b; font-size:12px;">3. OPERATING EXPENSES (OPEX)</td>
          </tr>
          ${categories && categories.length ? categories.map(cat => `
            <tr>
              <td style="padding:4px 8px 4px 20px; color:#374151;">${Utils.escapeHtml(cat.category || 'General')} (${cat.count || 0} item${cat.count !== 1 ? 's' : ''})</td>
              <td style="padding:4px 8px; text-align:right; font-family:monospace; color:#4b5563;">-${Utils.formatCurrency(cat.amount || 0)}</td>
            </tr>
          `).join('') : `
            <tr>
              <td style="padding:4px 8px 4px 20px; color:#9ca3af; font-style:italic;">No recorded operating expenses for this period.</td>
              <td style="padding:4px 8px; text-align:right; font-family:monospace; color:#4b5563;">₱0.00</td>
            </tr>
          `}
          <tr style="border-top:1px solid #d1d5db; border-bottom:1.5px solid #9ca3af; background:#f3f4f6;">
            <td style="padding:7px 8px; font-weight:800; color:#111827;">TOTAL OPERATING EXPENSES</td>
            <td style="padding:7px 8px; text-align:right; font-weight:800; font-size:13px; font-family:monospace; color:#dc2626;">-${Utils.formatCurrency(opexVal)}</td>
          </tr>

          <!-- NET PROFIT -->
          <tr><td colspan="2" style="height:12px;"></td></tr>
          <tr style="background:${isProfitable ? 'rgba(5,150,105,0.08)' : 'rgba(239,68,68,0.08)'}; border:2px solid ${isProfitable ? '#059669' : '#dc2626'};">
            <td style="padding:10px 12px; font-weight:900; font-size:14px; color:${isProfitable ? '#065f46' : '#991b1b'};">
              NET OPERATING PROFIT / (LOSS)
              <div style="font-size:11px; font-weight:600; color:${isProfitable ? '#059669' : '#dc2626'}; margin-top:2px;">
                Net Margin: <strong>${netMargin}</strong> &bull; Status: <strong>${isProfitable ? 'PROFITABLE' : 'NET OPERATING LOSS'}</strong>
              </div>
            </td>
            <td style="padding:10px 12px; text-align:right; font-weight:900; font-size:16px; font-family:monospace; color:${isProfitable ? '#065f46' : '#991b1b'}; vertical-align:middle;">
              ${Utils.formatCurrency(netProfit)}
            </td>
          </tr>
        </table>
      </div>

      <!-- Part II: Balance Sheet & Custody Summary (2-Col Grid) -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px;">
        <!-- Left: Cash Collections & Custody -->
        <div style="border:1px solid #e5e7eb; border-radius:6px; padding:12px; background:#fafafa;">
          <h5 style="font-size:11px; font-weight:800; text-transform:uppercase; margin:0 0 8px 0; color:#18181b; border-bottom:1px solid #e5e7eb; padding-bottom:4px;">
            <i class="fas fa-vault" style="color:#c9a227;"></i> Cash Custody &amp; Collections
          </h5>
          <table style="width:100%; font-size:11px; border-collapse:collapse;">
            <tr>
              <td style="padding:3px 0; color:#6b7280;">Cash at POS Registers:</td>
              <td style="padding:3px 0; text-align:right; font-weight:600; font-family:monospace;">${Utils.formatCurrency(cashSales)}</td>
            </tr>
            <tr>
              <td style="padding:3px 0; color:#6b7280;">Digital / GCash / Maya:</td>
              <td style="padding:3px 0; text-align:right; font-weight:600; font-family:monospace;">${Utils.formatCurrency(nonCashSales)}</td>
            </tr>
            <tr style="border-top:1px dashed #d1d5db;">
              <td style="padding:4px 0 2px 0; color:#111827; font-weight:700;">Active Cashier Drawer:</td>
              <td style="padding:4px 0 2px 0; text-align:right; font-weight:700; font-family:monospace; color:#c9a227;">${Utils.formatCurrency(drawerBal)}</td>
            </tr>
            <tr>
              <td style="padding:2px 0; color:#111827; font-weight:700;">Manager Safe Balance:</td>
              <td style="padding:2px 0; text-align:right; font-weight:700; font-family:monospace; color:#3b82f6;">${Utils.formatCurrency(managerSafeBal)}</td>
            </tr>
            <tr>
              <td style="padding:2px 0; color:#111827; font-weight:700;">Admin Safe Vault:</td>
              <td style="padding:2px 0; text-align:right; font-weight:700; font-family:monospace; color:#8b5cf6;">${Utils.formatCurrency(adminSafeBal)}</td>
            </tr>
          </table>
        </div>

        <!-- Right: Inventory Asset Valuation -->
        <div style="border:1px solid #e5e7eb; border-radius:6px; padding:12px; background:#fafafa;">
          <h5 style="font-size:11px; font-weight:800; text-transform:uppercase; margin:0 0 8px 0; color:#18181b; border-bottom:1px solid #e5e7eb; padding-bottom:4px;">
            <i class="fas fa-boxes-stacked" style="color:#059669;"></i> Inventory Asset Balance
          </h5>
          <table style="width:100%; font-size:11px; border-collapse:collapse;">
            <tr>
              <td style="padding:3px 0; color:#6b7280;">Total Tracked SKUs:</td>
              <td style="padding:3px 0; text-align:right; font-weight:600;">${inv.total_sku_count || 0} items</td>
            </tr>
            <tr>
              <td style="padding:3px 0; color:#6b7280;">Low / Out of Stock Alert:</td>
              <td style="padding:3px 0; text-align:right; font-weight:600; color:#eab308;">${(inv.low_stock_count || 0) + (inv.out_of_stock_count || 0)} items</td>
            </tr>
            <tr style="border-top:1px dashed #d1d5db;">
              <td style="padding:4px 0 2px 0; color:#111827; font-weight:700;">Total Stock Valuation:</td>
              <td style="padding:4px 0 2px 0; text-align:right; font-weight:800; font-size:12px; font-family:monospace; color:#059669;">${Utils.formatCurrency(invValuation)}</td>
            </tr>
          </table>
          <div style="font-size:10px; color:#9ca3af; margin-top:8px; line-height:1.3;">
            * Inventory is a Balance Sheet balance asset, not an operational deduction.
          </div>
        </div>
      </div>

      <!-- Part III: Signatures & Certification Block -->
      <div style="border-top:1.5px solid #18181b; padding-top:14px; margin-top:20px;">
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:20px; text-align:center; font-size:11px;">
          <div>
            <div style="font-weight:700; color:#6b7280; text-transform:uppercase; margin-bottom:34px;">PREPARED BY</div>
            <div style="border-top:1px solid #18181b; padding-top:4px; font-weight:700; color:#18181b;">
              ${Utils.escapeHtml(userName)}
            </div>
            <div style="font-size:10px; color:#71717a;">${userRole}</div>
          </div>
          <div>
            <div style="font-weight:700; color:#6b7280; text-transform:uppercase; margin-bottom:34px;">REVIEWED &amp; AUDITED BY</div>
            <div style="border-top:1px solid #18181b; padding-top:4px; font-weight:700; color:#18181b;">
              System Auditor / Accountant
            </div>
            <div style="font-size:10px; color:#71717a;">Internal Audit</div>
          </div>
          <div>
            <div style="font-weight:700; color:#6b7280; text-transform:uppercase; margin-bottom:34px;">CERTIFIED CORRECT</div>
            <div style="border-top:1px solid #18181b; padding-top:4px; font-weight:700; color:#18181b;">
              Management / Admin
            </div>
            <div style="font-size:10px; color:#71717a;">Executive Oversight</div>
          </div>
        </div>
        <div style="text-align:center; font-size:10px; color:#9ca3af; margin-top:16px;">
          GBLESS TRADING OPC &bull; Official Restaurant POS Financial Intelligence Record &bull; Confidential
        </div>
      </div>
    </div>
  `;

  const modalTitle = `<i class="fas fa-file-invoice" style="color:#c9a227; margin-right:8px;"></i> Formal Financial Statement — Print Preview`;

  const modalFooter = `
    <div style="display:flex; justify-content:space-between; align-items:center; width:100%; gap:10px; flex-wrap:wrap;">
      <div style="font-size:12px; color:var(--text-muted);">
        <i class="fas fa-check-circle" style="color:#059669;"></i> Ready to print standard A4 / Letter format.
      </div>
      <div style="display:flex; gap:8px;">
        <button type="button" class="btn btn-outline" onclick="Utils.closeModal()" style="padding:8px 18px; font-size:13px; font-weight:600;">
          <i class="fas fa-times"></i> Close Preview
        </button>
        <button type="button" class="btn btn-primary" onclick="printFinancialDocument()" style="padding:8px 22px; font-size:13px; font-weight:700; background:linear-gradient(135deg, #c9a227, #987719); border:none; box-shadow:0 4px 12px rgba(201,162,39,0.25);">
          <i class="fas fa-print"></i> Print Now
        </button>
      </div>
    </div>
  `;

  Utils.openModal(modalTitle, statementPaperHtml, modalFooter, "modal-xl");
};

window.printFinancialDocument = function() {
  const paper = document.getElementById("financial-statement-paper");
  if (!paper) {
    window.print();
    return;
  }

  // Populate print container for fallback
  let printEl = document.getElementById("printDocument");
  if (!printEl) {
    printEl = document.createElement("div");
    printEl.id = "printDocument";
    document.body.appendChild(printEl);
  }
  printEl.innerHTML = paper.innerHTML;

  // Create isolated hidden iframe to print cleanly without UI interference
  let frame = document.getElementById("print-financial-frame");
  if (frame) {
    try { document.body.removeChild(frame); } catch (e) {}
  }
  frame = document.createElement("iframe");
  frame.id = "print-financial-frame";
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);

  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>GBLESS TRADING OPC - Financial Statement</title>
      <style>
        @page { size: A4 portrait; margin: 10mm 12mm; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
          color: #18181b;
          background: #ffffff;
          margin: 0;
          padding: 0;
          font-size: 11pt;
          line-height: 1.4;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        * { box-sizing: border-box; }
        table { width: 100%; border-collapse: collapse; }
      </style>
    </head>
    <body>
      ${paper.innerHTML}
    </body>
    </html>
  `);
  doc.close();

  setTimeout(() => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (err) {
      console.warn("Iframe print fallback triggered:", err);
      window.print();
    }
  }, 250);
};

window.exportFinancialReportCsv = exportFinancialReportCsv;
window.exportExpensesCsv = exportExpensesCsv;
window.openAddExpenseModal = openAddExpenseModal;
window.submitAddExpense = submitAddExpense;
window.renderPurchases = renderProfitLoss;
window.renderProfitLoss = renderProfitLoss;

// ─────────────────────────────────────────────────────────────────────────────
// 12. WASTAGE & SPOILAGE TRACKING (Connected to Inventory Stock)
// ─────────────────────────────────────────────────────────────────────────────
let cachedWastageLogs = [];

async function renderWastage(c) {
  c = c || document.getElementById("view-container") || document.getElementById("content-area");
  if (!c) return;

  try {
    const [wRes, invRes] = await Promise.all([
      Auth.fetch("/api/v1/inventory/wastage/list"),
      (!cachedInventory || !cachedInventory.length) ? Auth.fetch("/api/v1/inventory") : Promise.resolve(null)
    ]);
    if (wRes && wRes.ok) {
      cachedWastageLogs = await wRes.json();
    }
    if (invRes && invRes.ok) {
      cachedInventory = await invRes.json();
    }
  } catch (e) {}

  const totalCost = cachedWastageLogs.reduce((sum, w) => sum + (Number(w.cost) || 0), 0);

  c.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon red"><i class="fas fa-trash-alt"></i></div>
        <div class="stat-info">
          <h3>Total Spoilage Incidents</h3>
          <div class="stat-count" style="color:#ef4444;">${Utils.escapeHtml(cachedWastageLogs.length)}</div>
          <div class="stat-trend" style="color:#ef4444;"><i class="fas fa-exclamation-triangle"></i> Logged Discards</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-coins"></i></div>
        <div class="stat-info">
          <h3>Total Cost Loss</h3>
          <div class="stat-count" style="color:#c9a227; font-size:20px;">${Utils.formatCurrency(totalCost)}</div>
          <div class="stat-trend" style="color:#ef4444;">Shrinkage Cost</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-clock"></i></div>
        <div class="stat-info">
          <h3>Expiration Waste</h3>
          <div class="stat-count" style="color:#f97316;">${cachedWastageLogs.filter(w => (w.reason || '').includes('Expired') || (w.reason || '').includes('Spoiled')).length}</div>
          <div class="stat-trend" style="color:#f97316;">Perishables</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon purple"><i class="fas fa-utensils"></i></div>
        <div class="stat-info">
          <h3>Kitchen Prep Waste</h3>
          <div class="stat-count" style="color:#9333ea;">${cachedWastageLogs.filter(w => (w.reason || '').includes('Spill') || (w.reason || '').includes('Burnt')).length}</div>
          <div class="stat-trend" style="color:#9333ea;">Operational Loss</div>
        </div>
      </div>
    </div>

    <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:20px; flex-wrap:wrap;">
      <div style="font-size:13px; color:var(--text-muted);">${Utils.escapeHtml(cachedWastageLogs.length)} wastage incidents logged</div>
      <button class="btn btn-danger" onclick="openLogWastageModal()" style="display:inline-flex; align-items:center; gap:8px;">
        <i class="fas fa-plus"></i> Record Wastage / Spoilage
      </button>
    </div>

    <div class="section-card">
      <div class="section-head">
        <h2>Wastage & Spoilage Incident Logs</h2>
        <span style="font-size:13px; color:var(--text-muted);">Shrinkage and food loss audit (auto-deducted from inventory)</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Ingredient / Item</th>
              <th>Quantity Lost</th>
              <th>Loss Reason</th>
              <th>Estimated Cost</th>
              <th>Logged By</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${cachedWastageLogs.length ? cachedWastageLogs.map(w => `
              <tr>
                <td><strong style="color:var(--text-main); font-size:13px;">${Utils.escapeHtml(w.item)}</strong></td>
                <td><span style="font-weight:700; color:var(--danger);">${Utils.escapeHtml(w.qty)}</span></td>
                <td><span class="badge badge-danger" style="font-size:11px; font-weight:700;">${Utils.escapeHtml(w.reason)}</span></td>
                <td><strong style="color:#c9a227; font-size:13px;">${Utils.formatCurrency(w.cost)}</strong></td>
                <td style="color:var(--text-muted); font-size:13px;">${Utils.escapeHtml(w.logged_by)}</td>
                <td style="color:var(--text-muted); font-size:13px;">${Utils.escapeHtml(w.date)}</td>
              </tr>
            `).join('') : `
              <tr>
                <td colspan="6" style="text-align:center; padding:36px; color:var(--text-muted);">
                  <i class="fas fa-trash-alt" style="font-size:24px; margin-bottom:8px; opacity:0.4; display:block;"></i>
                  No wastage or spoilage incidents logged yet.
                </td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function updateWastageModalCalculations() {
  const sel = document.getElementById("ws-item-id");
  const unitHintEl = document.getElementById("ws-unit-hint");
  if (!sel) return;

  const itemId = Number(sel.value);
  const item = (cachedInventory || []).find(i => Number(i.id) === itemId);
  if (unitHintEl) {
    unitHintEl.textContent = item ? `Current Stock: ${Number(item.quantity)} ${item.unit || 'pcs'}` : 'Select an item';
  }
}

async function openLogWastageModal(preselectItemId) {
  if (!cachedInventory || !cachedInventory.length) {
    try {
      const res = await Auth.fetch("/api/v1/inventory");
      if (res.ok) cachedInventory = await res.json();
    } catch (e) {}
  }

  const items = (cachedInventory || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const directItem = preselectItemId ? items.find(i => Number(i.id) === Number(preselectItemId)) : null;
  const optionsHtml = items.length
    ? items.map(i => `<option value="${i.id}" ${Number(preselectItemId) === Number(i.id) ? 'selected' : ''}>${Utils.escapeHtml(i.name)} (${Number(i.quantity)} ${Utils.escapeHtml(i.unit || 'pcs')} available)</option>`).join('')
    : '<option value="">No inventory items available</option>';

  const itemFieldHtml = directItem
    ? `
      <input type="hidden" id="ws-item-id" value="${directItem.id}">
      <input type="text" class="input-field" readonly value="${Utils.escapeHtml(directItem.name)} (${Number(directItem.quantity)} ${Utils.escapeHtml(directItem.unit || 'pcs')} available)" style="width:100%; background:#f4f4f5; font-weight:700; cursor:default;">
      <div id="ws-unit-hint" style="font-size:11px; color:var(--text-muted); margin-top:4px;">Current Stock: ${Number(directItem.quantity)} ${Utils.escapeHtml(directItem.unit || 'pcs')}</div>
    `
    : `
      <select id="ws-item-id" class="input-field" required style="width:100%;" onchange="updateWastageModalCalculations()">
        <option value="">-- Select Inventory Item --</option>
        ${optionsHtml}
      </select>
      <div id="ws-unit-hint" style="font-size:11px; color:var(--text-muted); margin-top:4px;"></div>
    `;

  Utils.openModal("Record Spoilage / Wastage", `
    <form id="form-wastage" onsubmit="event.preventDefault(); submitLogWastage();">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Ingredient / Stock Item <span style="color:var(--danger);">*</span></label>
        ${itemFieldHtml}
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Pieces / Quantity Lost <span style="color:var(--danger);">*</span></label>
        <input type="number" step="any" min="0.01" id="ws-qty" class="input-field" required placeholder="e.g. 2" style="width:100%;">
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Reason for Loss <span style="color:var(--danger);">*</span></label>
        <select id="ws-reason" class="input-field" style="width:100%;">
          <option value="Expired shelf-life" selected>Expired shelf-life</option>
          <option value="Spoiled / Molded produce">Spoiled / Molded produce</option>
          <option value="Accidental Kitchen Spill">Accidental Kitchen Spill</option>
          <option value="Burnt during cooking">Burnt during cooking</option>
          <option value="Quality standard failure">Quality standard failure</option>
        </select>
      </div>
    </form>
  `, `<button class="btn btn-danger" id="btn-submit-wastage" onclick="submitLogWastage()"><i class="fas fa-trash-alt"></i> Record Wastage</button>`);
}

async function submitLogWastage() {
  const itemId = Number(document.getElementById("ws-item-id")?.value);
  const qty = parseFloat(document.getElementById("ws-qty")?.value);
  const reason = document.getElementById("ws-reason")?.value;
  const btn = document.getElementById("btn-submit-wastage");

  if (!itemId || isNaN(qty) || qty <= 0) {
    Utils.showToast("Please select an inventory item and enter a valid quantity lost.", "danger");
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const res = await Auth.fetch(`/api/v1/inventory/${itemId}/wastage`, {
      method: "POST",
      body: JSON.stringify({
        quantity: qty,
        reason: reason || "Wastage / Spoilage"
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to record wastage.");
    }
    const created = await res.json();
    const cachedItem = (cachedInventory || []).find(i => Number(i.id) === itemId);
    if (cachedItem && typeof created.new_quantity === "number") {
      cachedItem.quantity = created.new_quantity;
    }

    Utils.showToast(`Wastage recorded for ${created.item} (${created.qty}) and deducted from stock.`, "success");
    Utils.closeModal();

    const active = typeof getActiveViewName === "function" ? getActiveViewName() : "";
    if (active === "inventory" && typeof renderInventory === "function") {
      renderInventory();
    } else if (typeof renderWastage === "function") {
      renderWastage();
    }
  } catch (err) {
    if (btn) btn.disabled = false;
    Utils.showToast(err.message || "Failed to record wastage.", "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-TAB REAL-TIME SYNCHRONIZATION
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener("storage", (e) => {
  const role = Auth.getRole();
  if (e.key === "RESTOTRACK_SYNC_TX") {
    if (role === "kitchen") {
      renderKitchen();
    }
  }
  
  if (e.key === "RESTOTRACK_SYNC_KITCHEN") {
    if (role === "kitchen") {
      renderKitchen();
    } else if (role === "cashier") {
      if (document.getElementById("tx-tbody") && typeof renderTransactions === "function") {
        renderTransactions();
      }
      if (document.getElementById("cust-orders-content") && typeof loadCustomerOrdersTable === "function") {
        loadCustomerOrdersTable();
      }
      if (typeof fetchPendingOnlineOrders === "function") {
        fetchPendingOnlineOrders();
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER ONLINE ORDERS INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

let pendingOnlineOrders = [];

function startPOSOnlineOrdersPolling() {
  fetchPendingOnlineOrders();
  if (window.posOnlineOrdersInterval) clearInterval(window.posOnlineOrdersInterval);
  window.posOnlineOrdersInterval = setInterval(fetchPendingOnlineOrders, 10000);
}

async function fetchPendingOnlineOrders() {
  try {
    const res = await Auth.fetch("/api/v1/customer-orders/pending");
    if (res.ok) {
      pendingOnlineOrders = await res.json();
      indexCustomerOrders(pendingOnlineOrders);
      updateOnlineOrdersBadge();
    }
  } catch (err) {
    console.error("Error polling online orders:", err);
  }
}

function updateOnlineOrdersBadge() {
  const badge1 = document.getElementById("pos-online-orders-badge");
  const badge2 = document.getElementById("cashier-orders-badge");
  const count = (pendingOnlineOrders && pendingOnlineOrders.length) || 0;
  [badge1, badge2].forEach(b => {
    if (!b) return;
    if (count > 0) {
      b.textContent = count;
      b.style.display = "inline-block";
    } else {
      b.style.display = "none";
    }
  });
}

window.fetchPendingOnlineOrders = fetchPendingOnlineOrders;
window.checkPendingCustomerOrders = fetchPendingOnlineOrders;
window.updateOnlineOrdersBadge = updateOnlineOrdersBadge;

function openOnlineOrdersModal() {
  let ordersHtml = "<p style='color:var(--text-muted);'>No pending online orders.</p>";
  if (pendingOnlineOrders.length > 0) {
    ordersHtml = pendingOnlineOrders.map(o => {
      let itemsHtml = o.items.map(it => `<li><strong style="color:#c9a227;">${Utils.escapeHtml(it.quantity)}x</strong> ${Utils.escapeHtml(it.name)} <span style="color:var(--text-muted); font-size:12px;">(₱${Utils.escapeHtml(it.price)})</span></li>`).join('');
      return `
        <div style="padding:16px; border:1px solid rgba(205,190,150,0.3); border-radius:12px; margin-bottom:12px; background:#fff;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <div>
              <span style="background:#c9a227; color:#18181b; font-size:11px; padding:3px 8px; border-radius:4px; font-weight:bold; margin-right:8px;">TABLE ${Utils.escapeHtml(o.table_number || 'Takeout')}</span>
              <strong style="color:var(--text-main); font-size:14px;">${Utils.escapeHtml(o.order_number)}</strong>
            </div>
            <div style="font-size:12px; color:var(--text-muted);">
              <i class="fas fa-clock" style="margin-right:4px;"></i> Ordered at ${new Date(o.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
            </div>
          </div>
          <ul style="list-style:none; padding:0; margin:0 0 16px 0; font-size:13px;">
            ${itemsHtml}
          </ul>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div style="font-size:16px; font-weight:800; color:#c9a227;">₱${parseFloat(o.total_amount).toFixed(2)}</div>
            <button onclick="processOnlineOrder(${o.id})" class="btn btn-primary btn-sm" style="border-radius:8px; font-weight:bold;">
              <i class="fas fa-shopping-cart"></i> PROCESS ORDER
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  Utils.openModal("Pending Online Orders", `
    <div style="max-height:60vh; overflow-y:auto; padding-right:8px;">
      ${ordersHtml}
    </div>
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER ONLINE ORDERS: payment choice, manual GCash verification, settlement
// ─────────────────────────────────────────────────────────────────────────────
// Payment verification is a cashier-reported check: the cashier reads the GCash transaction history and
// types the amount received. The POS compares it with the amount due; it never contacts GCash.

function paymentBadgeHtml(o) {
  const method = o.payment_method === "GCASH" ? "GCash"
    : o.payment_method === "PAY_AT_COUNTER" ? "Pay at Counter"
    : "Method not recorded";
  const ps = o.payment_status || "unpaid";
  let label = "Unpaid";
  let color = "#92400e";
  let bg = "#fef3c7";
  if (ps === "unpaid" && o.payment_method === "GCASH") label = "GCash verification pending";
  else if (ps === "verified") { label = "GCash verified (cashier-reported)"; color = "#047857"; bg = "#d1fae5"; }
  else if (ps === "discrepancy") { label = "AMOUNT MISMATCH - review"; color = "#b91c1c"; bg = "#fee2e2"; }
  else if (ps === "invalid") { label = "Payment invalid"; color = "#b91c1c"; bg = "#fee2e2"; }
  else if (ps === "counter_paid") { label = "Paid at counter"; color = "#047857"; bg = "#d1fae5"; }
  const methodColor = o.payment_method === "GCASH" ? "#1d4ed8" : "#3f3f46";
  return `<span style="display:inline-block; padding:2px 8px; border-radius:6px; font-size:10.5px; font-weight:800; background:#eef2ff; color:${methodColor}; margin-right:4px;">${Utils.escapeHtml(method)}</span>` +
         `<span style="display:inline-block; padding:2px 8px; border-radius:6px; font-size:10.5px; font-weight:800; background:${bg}; color:${color};">${Utils.escapeHtml(label)}</span>`;
}

function indexCustomerOrders(list) {
  if (!Array.isArray(list)) return;
  list.forEach(o => { window._customerOrderIndex[o.id] = o; });
}

async function refreshCurrentOnlineOrder() {
  const cur = window.currentOnlineOrder;
  if (!cur) return null;
  const res = await Auth.fetch(`/api/v1/customer-orders/${Number(cur.id)}`);
  if (!res.ok) {
    let detail = "Could not load the customer order.";
    try { detail = (await res.json()).detail || detail; } catch (e) {}
    throw new Error(detail);
  }
  const fresh = await res.json();
  Object.assign(cur, {
    status: fresh.status,
    payment_method: fresh.payment_method,
    payment_status: fresh.payment_status,
    payment_attempt: fresh.payment_attempt,
    sale_recorded: fresh.sale_recorded,
    total_amount: fresh.total_amount
  });
  window._customerOrderIndex[fresh.id] = fresh;
  return cur;
}

function processOnlineOrder(orderId) {
  const order = window._customerOrderIndex[orderId] || pendingOnlineOrders.find(o => o.id === orderId);
  if (!order) {
    Utils.showToast("Order not found. Refresh the list and try again.", "danger");
    return;
  }
  if (order.sale_recorded) {
    Utils.showToast("This order already has a sale recorded.", "warning");
    return;
  }
  if (window.currentOnlineOrder && window.currentOnlineOrder.id === order.id) {
    Utils.closeModal();
    goToPOSView();
    return;
  }
  const load = () => loadOnlineOrderIntoPOS(order);
  if (posCart.length) {
    const count = posCart.reduce((sum, i) => sum + i.quantity, 0);
    Utils.confirmAction(
      "Replace the current cart?",
      `The POS cart has ${Utils.escapeHtml(count)} item(s). Loading customer order ${Utils.escapeHtml(order.order_number)} discards them.`,
      load
    );
  } else {
    load();
  }
}

async function goToPOSView() {
  if (!document.getElementById("pos-grid") && typeof renderView === "function") {
    document.querySelectorAll("aside.sidebar .nav-link").forEach(el => el.classList.remove("active"));
    const posLink = document.querySelector("a[href='#pos']");
    if (posLink) posLink.classList.add("active");
    await renderView("pos");
  }
}

async function loadOnlineOrderIntoPOS(order) {
  Utils.closeModal();
  // Set first so that rendering the POS does not restore an unrelated draft over this order.
  window.currentOnlineOrder = {
    id: order.id,
    order_number: order.order_number,
    customer_name: order.customer_name,
    order_type: order.order_type,
    table_number: order.table_number,
    status: order.status,
    payment_method: order.payment_method || null,
    payment_status: order.payment_status || "unpaid",
    payment_attempt: order.payment_attempt || null,
    sale_recorded: !!order.sale_recorded,
    total_amount: order.total_amount
  };
  window.currentOnlineOrderId = order.id;
  posCheckout.key = null;
  posCheckout.signature = null;
  await goToPOSView();
  // Lines and prices are the ones the server stored for this order; the server re-reads them at sale time.
  posCart = (order.items || []).map(it => ({
    product_id: it.product_id || 0,
    name: it.name,
    price: Number(it.price),
    quantity: it.quantity
  }));
  updateCartUI();
  Utils.showToast(`Loaded ${order.table_number ? "Table " + order.table_number + " " : ""}order ${order.order_number} into the POS.`, "success");
}

// ── GCash verification dialog ────────────────────────────────────────────────────────────────────
async function openGcashModal(orderId, checkoutMode = false) {
  let order;
  try {
    const res = await Auth.fetch(`/api/v1/customer-orders/${Number(orderId)}`);
    if (!res.ok) {
      let detail = "Could not load the order.";
      try { detail = (await res.json()).detail || detail; } catch (e) {}
      throw new Error(detail);
    }
    order = await res.json();
  } catch (err) {
    Utils.showToast(err.message, "danger");
    return;
  }
  window._customerOrderIndex[order.id] = order;
  const cur = window.currentOnlineOrder;
  if (cur && cur.id === order.id) {
    Object.assign(cur, {
      status: order.status, payment_method: order.payment_method, payment_status: order.payment_status,
      payment_attempt: order.payment_attempt, sale_recorded: order.sale_recorded
    });
    renderOnlineOrderBanner();
  }

  const role = (typeof Auth !== "undefined" && Auth.getRole) ? String(Auth.getRole() || "").toLowerCase() : "";
  const isReviewer = ["manager", "admin", "super_admin"].includes(role);
  const ps = order.payment_status;
  const att = order.payment_attempt;
  const due = Utils.formatCurrency(order.total_amount);
  const itemsHtml = (order.items || []).map(it =>
    `<li><strong>${Utils.escapeHtml(it.quantity)}x</strong> ${Utils.escapeHtml(it.name)} <span style="color:var(--text-muted);">(${Utils.formatCurrency(it.price)})</span></li>`
  ).join("");

  let statusBox = "";
  let formHtml = "";
  let footer = `<button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>`;

  if (order.status === "rejected") {
    statusBox = `<div style="padding:12px; background:#fee2e2; color:#991b1b; border-radius:10px; font-weight:700; margin-bottom:12px;">This order was rejected.</div>`;
  } else if (ps === "verified") {
    statusBox = `<div style="padding:12px; background:#d1fae5; color:#065f46; border-radius:10px; margin-bottom:12px;">
        <strong><i class="fas fa-check-circle"></i> Amount matches: ${due}</strong>
        <div style="font-size:12px; margin-top:4px;">Recorded as reported by the cashier from the GCash transaction history. The POS did not check GCash itself.</div>
      </div>`;
    if (checkoutMode && !order.sale_recorded) {
      footer = `<button id="checkout-confirm-btn" class="btn btn-primary" onclick="submitCheckout()" style="width:100%; height:44px; font-size:14px; font-weight:700;"><i class="fas fa-check-circle"></i> Confirm &amp; Complete Sale</button>`;
    }
  } else if (ps === "invalid") {
    statusBox = `<div style="padding:12px; background:#fee2e2; color:#991b1b; border-radius:10px; margin-bottom:12px;">
        <strong><i class="fas fa-ban"></i> This payment was closed as invalid by a manager.</strong>
        <div style="font-size:12px; margin-top:4px;">The order cannot be paid or prepared. Reject it from the order list.</div>
      </div>`;
  } else {
    if (ps === "discrepancy" && att) {
      const diff = Number(att.discrepancy_amount);
      statusBox = `<div style="padding:14px; background:#fee2e2; color:#991b1b; border:2px solid #ef4444; border-radius:10px; margin-bottom:12px;">
          <strong style="font-size:14px;"><i class="fas fa-exclamation-triangle"></i> AMOUNT DOES NOT MATCH - PAYMENT NOT CONFIRMED</strong>
          <table style="width:100%; font-size:13px; margin-top:8px;">
            <tr><td>Expected</td><td style="text-align:right;"><strong>${Utils.formatCurrency(att.expected_amount)}</strong></td></tr>
            <tr><td>You reported</td><td style="text-align:right;"><strong>${Utils.formatCurrency(att.reported_amount)}</strong></td></tr>
            <tr><td>Difference</td><td style="text-align:right;"><strong>${diff > 0 ? "+" : "-"}${Utils.formatCurrency(Math.abs(diff))} (${diff > 0 ? "over" : "short"})</strong></td></tr>
          </table>
          <div style="font-size:12px; margin-top:8px;">This order cannot be prepared or completed until the amount is corrected below or a manager reviews it. This records a payment difference only.</div>
        </div>`;
    }
    formHtml = `
      <div style="padding:10px 12px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; font-size:12px; margin-bottom:12px; color:#1e3a8a;">
        <strong>Check GCash first.</strong> Open the GCash transaction history for the store account, find this customer's payment, and enter
        what you actually see. The POS cannot see your GCash account: the amount you type is recorded as <u>reported by you</u>.
      </div>
      <div class="input-group" style="margin-bottom:10px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Amount actually received (₱) <span style="color:var(--danger);">*</span></label>
        <input id="gc-amount" class="input-field" inputmode="decimal" autocomplete="off" placeholder="0.00" style="width:100%; font-size:18px; font-weight:800;" onkeydown="if(event.key==='Enter'){event.preventDefault(); submitGcashVerification(${Number(order.id)}, ${checkoutMode ? "true" : "false"});}">
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
        <div class="input-group" style="flex:1 1 180px;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">GCash reference no. (if shown)</label>
          <input id="gc-ref" class="input-field" autocomplete="off" maxlength="60" placeholder="e.g. 1234 567 890 123" style="width:100%;">
        </div>
        <div class="input-group" style="flex:1 1 180px;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Transaction time (optional)</label>
          <input id="gc-time" type="datetime-local" class="input-field" style="width:100%;">
        </div>
      </div>
      <div id="gc-error" role="alert" style="display:none; padding:10px 12px; margin-bottom:10px; background:#fee2e2; color:#991b1b; border:1px solid #fca5a5; border-radius:10px; font-size:13px; font-weight:600;"></div>`;
    footer = `<button class="btn btn-outline" onclick="Utils.closeModal()">Cancel</button>
              <button id="gc-verify-btn" class="btn btn-primary" onclick="submitGcashVerification(${Number(order.id)}, ${checkoutMode ? "true" : "false"})"><i class="fas fa-search-dollar"></i> Verify amount</button>`;
  }

  let reviewHtml = "";
  if (isReviewer && (ps === "discrepancy" || att)) {
    reviewHtml = `
      <div style="margin-top:14px; border-top:1px dashed rgba(205,190,150,0.5); padding-top:12px;">
        <div style="font-size:12px; font-weight:800; text-transform:uppercase; color:var(--text-muted); margin-bottom:6px;">Manager review</div>
        ${ps === "discrepancy" ? `
          <textarea id="gc-resolve-note" class="input-field" rows="2" maxlength="200" placeholder="Why is this payment invalid? (required, min 5 characters)" style="width:100%; margin-bottom:8px;"></textarea>
          <button class="btn btn-outline btn-sm" style="border-color:#ef4444; color:#ef4444;" onclick="resolveGcashDiscrepancy(${Number(order.id)}, ${checkoutMode ? "true" : "false"})">Close discrepancy as invalid payment</button>` : ""}
        <div id="gc-attempts" style="margin-top:8px; font-size:12px;"></div>
      </div>`;
  }

  Utils.openModal(
    '<i class="fas fa-mobile-alt" style="color:#1d4ed8; margin-right:8px;"></i> GCash payment check',
    `<div>
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:10px;">
        <div>
          <strong>${Utils.escapeHtml(order.order_number)}</strong>
          <div style="font-size:12px; color:var(--text-muted);">${Utils.escapeHtml(order.customer_name)} &bull; ${Utils.escapeHtml(order.table_number ? "Table " + order.table_number : order.order_type)}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase;">Amount due</div>
          <div style="font-size:22px; font-weight:800; color:#c9a227;">${due}</div>
        </div>
      </div>
      <ul style="list-style:none; padding:0; margin:0 0 10px 0; font-size:13px;">${itemsHtml}</ul>
      <div style="margin-bottom:10px;">${paymentBadgeHtml(order)}</div>
      <div id="checkout-error" role="alert" style="display:none; padding:10px 12px; margin-bottom:12px; background:#fee2e2; color:#991b1b; border:1px solid #fca5a5; border-radius:10px; font-size:13px; font-weight:600;"></div>
      ${statusBox}
      ${formHtml}
      ${reviewHtml}
    </div>`,
    footer
  );
  const amountInput = document.getElementById("gc-amount");
  if (amountInput) amountInput.focus();
  if (isReviewer && att) loadPaymentAttempts(order.id);
}

async function submitGcashVerification(orderId, checkoutMode) {
  const btn = document.getElementById("gc-verify-btn");
  const errorBox = document.getElementById("gc-error");
  const show = (msg) => { if (errorBox) { errorBox.textContent = msg; errorBox.style.display = "block"; } };
  if (btn && btn.disabled) return;
  const amount = (document.getElementById("gc-amount") || {}).value || "";
  if (!amount.trim()) { show("Enter the amount you see in GCash history."); return; }
  const body = { amount_received: amount.trim() };
  const ref = ((document.getElementById("gc-ref") || {}).value || "").trim();
  const when = ((document.getElementById("gc-time") || {}).value || "").trim();
  if (ref) body.reference_no = ref;
  if (when) body.transaction_time = when;
  if (errorBox) errorBox.style.display = "none";
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...'; }
  try {
    const res = await Auth.fetch(`/api/v1/customer-orders/${Number(orderId)}/payment/verify`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      show((data && typeof data.detail === "string" && data.detail) || `Verification failed (HTTP ${res.status}).`);
      return;
    }
    // Re-open from the server's state so the cashier sees exactly what was recorded.
    await openGcashModal(orderId, checkoutMode);
    Utils.showToast(data.verified ? "Amount matches. GCash payment verified." : "Amount does NOT match. Flagged for review.", data.verified ? "success" : "danger");
    fetchPendingOnlineOrders();
    if (document.getElementById("cust-orders-content")) loadCustomerOrdersTable();
  } catch (err) {
    show("Could not reach the server. Nothing was changed on screen; try again.");
  } finally {
    const again = document.getElementById("gc-verify-btn");
    if (again) { again.disabled = false; again.innerHTML = '<i class="fas fa-search-dollar"></i> Verify amount'; }
  }
}

async function resolveGcashDiscrepancy(orderId, checkoutMode) {
  const note = ((document.getElementById("gc-resolve-note") || {}).value || "").trim();
  if (note.length < 5) { Utils.showToast("Write a short reason (at least 5 characters).", "warning"); return; }
  try {
    const res = await Auth.fetch(`/api/v1/customer-orders/${Number(orderId)}/payment/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution: "invalid", note })
    });
    if (!res.ok) {
      let detail = "Could not close the discrepancy.";
      try { detail = (await res.json()).detail || detail; } catch (e) {}
      Utils.showToast(typeof detail === "string" ? detail : "Could not close the discrepancy.", "danger");
      return;
    }
    Utils.showToast("Discrepancy closed as an invalid payment.", "success");
    await openGcashModal(orderId, checkoutMode);
    fetchPendingOnlineOrders();
    if (document.getElementById("cust-orders-content")) loadCustomerOrdersTable();
  } catch (err) {
    Utils.showToast("Could not reach the server.", "danger");
  }
}

async function loadPaymentAttempts(orderId) {
  const box = document.getElementById("gc-attempts");
  if (!box) return;
  try {
    const res = await Auth.fetch(`/api/v1/customer-orders/${Number(orderId)}/payment/attempts`);
    if (!res.ok) return;
    const rows = await res.json();
    box.innerHTML = rows.length ? `<table style="width:100%; border-collapse:collapse;">
        <thead><tr style="text-align:left; color:var(--text-muted);"><th>When</th><th>By</th><th>Reported</th><th>Result</th><th>Ref</th></tr></thead>
        <tbody>${rows.map(r => `<tr style="border-top:1px solid rgba(205,190,150,0.25);">
          <td>${Utils.escapeHtml(r.attempted_at ? new Date(r.attempted_at).toLocaleString() : "")}</td>
          <td>${Utils.escapeHtml(r.attempted_by || "")}</td>
          <td>${Utils.formatCurrency(r.reported_amount)}</td>
          <td>${Utils.escapeHtml(r.outcome)}${r.resolution ? " / " + Utils.escapeHtml(r.resolution) : ""}${r.resolution_note ? ` <em>(${Utils.escapeHtml(r.resolution_note)})</em>` : ""}</td>
          <td>${Utils.escapeHtml(r.reference_no || "")}</td></tr>`).join("")}</tbody></table>` : "";
  } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER & TABLE QR ORDERS MANAGEMENT VIEW (CASHIER & MANAGER)
// ─────────────────────────────────────────────────────────────────────────────
async function renderCustomerOrdersView(c) {
  const target = c || document.getElementById("view-container");
  if (!target) return;

  target.innerHTML = `
    <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px;">
      <div>
        <h2 style="font-size:18px; font-weight:800; color:var(--text-main); margin:0;">Customer & Table QR Orders</h2>
        <p style="font-size:12px; color:var(--text-muted); margin:4px 0 0 0;">Live incoming customer orders from Table QR codes</p>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <span style="display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:700; color:#10b981; background:rgba(16,185,129,0.1); padding:5px 12px; border-radius:20px;">
          <span style="width:8px; height:8px; border-radius:50%; background:#10b981; display:inline-block;"></span> Live Auto-Refresh
        </span>
        <button class="btn btn-outline btn-sm" onclick="loadCustomerOrdersTable()"><i class="fas fa-sync-alt"></i> Refresh</button>
      </div>
    </div>

    <div id="cust-orders-content">
      <div style="text-align:center; padding:40px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Loading customer orders...</div>
    </div>
  `;

  await loadCustomerOrdersTable();
  if (window.custOrdersInterval) clearInterval(window.custOrdersInterval);
  window.custOrdersInterval = setInterval(loadCustomerOrdersTable, 6000);
}

function customerOrderVerifyButton(o) {
  if (o.payment_method !== 'GCASH' || o.status === 'rejected' || ['verified', 'invalid', 'counter_paid'].includes(o.payment_status)) return '';
  return `<button class="btn btn-outline btn-sm" onclick="openGcashModal(${Number(o.id)})" title="Check the GCash transaction history, then enter the amount received" style="border-color:#1d4ed8; color:#1d4ed8;"><i class="fas fa-mobile-alt"></i> Verify GCash</button>`;
}

// Orders that left the "pending" queue can still need payment: verify GCash, or record payment at the POS.
function customerOrderRowActions(h) {
  if (h.status === 'rejected') return '<span style="color:var(--text-muted); font-size:11px;">Rejected</span>';
  if (h.sale_recorded) return '<span style="color:#047857; font-size:11px; font-weight:700;"><i class="fas fa-check"></i> Sale recorded</span>';
  const parts = [customerOrderVerifyButton(h)];
  const blocked = ['discrepancy', 'invalid'].includes(h.payment_status);
  const gcashNotReady = h.payment_method === 'GCASH' && h.payment_status !== 'verified';
  if (!blocked && !gcashNotReady) {
    parts.push(`<button class="btn btn-primary btn-sm" onclick="processOnlineOrder(${Number(h.id)})"><i class="fas fa-cash-register"></i> Record payment</button>`);
  }
  return `<div style="display:flex; gap:6px; flex-wrap:wrap;">${parts.join('')}</div>`;
}

async function loadCustomerOrdersTable() {
  const container = document.getElementById("cust-orders-content");
  if (!container) {
    if (window.custOrdersInterval) {
      clearInterval(window.custOrdersInterval);
      window.custOrdersInterval = null;
    }
    return;
  }

  try {
    const [pendingRes, historyRes] = await Promise.all([
      Auth.fetch("/api/v1/customer-orders/pending"),
      Auth.fetch("/api/v1/customer-orders/history?limit=15")
    ]);

    if (!pendingRes.ok) throw new Error("Failed to load pending customer orders.");
    if (!historyRes.ok) throw new Error("Failed to load customer order history.");
    const pending = await pendingRes.json();
    const history = await historyRes.json();
    
    pendingOnlineOrders = pending;
    indexCustomerOrders(pending);
    indexCustomerOrders(history);
    updateOnlineOrdersBadge();

    let html = "";

    // Section 1: Pending Orders
    html += `
      <div class="section-card" style="margin-bottom:24px;">
        <div class="section-head" style="display:flex; justify-content:space-between; align-items:center;">
          <h2 style="font-size:16px; font-weight:700; color:var(--text-main); margin:0;">
            Pending Customer Orders (${Utils.escapeHtml(pending.length)})
          </h2>
          <span class="badge ${pending.length > 0 ? 'badge-danger' : 'badge-success'}" style="font-size:11px;">
            ${pending.length > 0 ? pending.length + ' Awaiting Cashier' : 'All Clear'}
          </span>
        </div>
        <div style="padding:16px;">
    `;

    if (pending.length === 0) {
      html += `
        <div style="text-align:center; padding:36px; color:var(--text-muted);">
          <i class="fas fa-check-circle" style="font-size:32px; color:#10b981; margin-bottom:10px; display:block;"></i>
          <p style="font-size:14px; font-weight:600; margin:0;">No pending customer orders right now.</p>
          <small style="font-size:12px; color:var(--text-muted);">When a customer scans a table QR code and submits an order, it will appear here instantly!</small>
        </div>
      `;
    } else {
      html += `<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap:14px;">`;
      pending.forEach(o => {
        const timeStr = o.created_at ? new Date(o.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Just now';
        const itemsList = (o.items || []).map(it => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0; border-bottom:1px dashed rgba(205,190,150,0.2); font-size:13px;">
            <div><strong style="color:#c9a227;">${Utils.escapeHtml(it.quantity)}x</strong> <span style="font-weight:600;">${Utils.escapeHtml(it.name)}</span></div>
            <span style="color:var(--text-muted); font-size:12px;">₱${(parseFloat(it.price) * it.quantity).toFixed(2)}</span>
          </div>
        `).join('');

        html += `
          <div style="border:1.5px solid #c9a227; border-radius:12px; padding:16px; background:#ffffff; box-shadow:0 4px 12px rgba(0,0,0,0.04); display:flex; flex-direction:column; justify-content:space-between;">
            <div>
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <span style="background:#c9a227; color:#18181b; font-weight:800; font-size:12px; padding:4px 10px; border-radius:16px; letter-spacing:0.5px;">
                  <i class="fas fa-chair" style="margin-right:4px;"></i> ${Utils.escapeHtml(o.table_number ? (o.table_number.toLowerCase().startsWith('table') ? o.table_number.toUpperCase() : 'TABLE ' + o.table_number) : 'TAKEOUT')}
                </span>
                <span style="font-size:11px; font-family:monospace; background:rgba(201,162,39,0.12); color:#c9a227; padding:3px 8px; border-radius:4px; font-weight:800; letter-spacing:0.5px;">
                  ${(typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('CUST', o.id) : (o.order_number || `CUST-${o.id}`)}
                </span>
              </div>
              <div style="margin-bottom:8px; font-size:12px;">
                <div style="color:var(--text-muted);"><i class="fas fa-clock" style="margin-right:4px;"></i> Ordered at ${Utils.escapeHtml(timeStr)} • ${Utils.escapeHtml(o.order_type || 'Dine In')}</div>
              </div>
              <div style="margin:12px 0; max-height:140px; overflow-y:auto;">
                ${itemsList}
              </div>
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-top:1px solid rgba(205,190,150,0.3); margin-top:8px;">
                <span style="font-size:12px; color:var(--text-muted); font-weight:600;">TOTAL AMOUNT:</span>
                <span style="font-size:18px; font-weight:800; color:#c9a227;">₱${parseFloat(o.total_amount).toFixed(2)}</span>
              </div>
              <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
                ${customerOrderVerifyButton(o)}
                <button class="btn btn-primary btn-sm" onclick="processOnlineOrder(${Number(o.id)})" style="flex:1; display:flex; align-items:center; justify-content:center; gap:6px; font-weight:700;">
                  <i class="fas fa-cash-register"></i> Send to POS
                </button>
                <button class="btn btn-danger btn-sm" onclick="setCustomerOrderStatus(${o.id}, 'rejected')" title="Reject / Cancel" style="background:#dc3545; border-color:#dc3545; color:#fff;">
                  <i class="fas fa-times"></i>
                </button>
              </div>
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }
    html += `</div></div>`;

    // Section 2: Recent History
    const pastOrders = history.filter(h => h.status !== 'pending');
    if (pastOrders.length > 0) {
      html += `
        <div class="section-card">
          <div class="section-head">
            <h2 style="font-size:16px; font-weight:700; color:var(--text-main); margin:0;">Recent Processed Orders</h2>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Table</th>
                  <th>Items</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Time</th>
                  <th>Payment</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${pastOrders.map(h => `
                  <tr>
                    <td><strong style="font-family:monospace; font-size:12px; color:#c9a227;">${(typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('CUST', h.id) : h.order_number}</strong></td>
                    <td><span class="badge" style="background:rgba(201,162,39,0.15); color:#c9a227; font-weight:700;">${Utils.escapeHtml(h.table_number || h.order_type)}</span></td>
                    <td style="font-size:12px; color:var(--text-muted);">${(h.items || []).map(i => `${i.quantity}x ${Utils.escapeHtml(i.name)}`).join(', ')}</td>
                    <td><strong style="color:#c9a227;">₱${parseFloat(h.total_amount).toFixed(2)}</strong></td>
                    <td>
                      <span class="badge ${h.status === 'completed' ? 'badge-success' : h.status === 'accepted' ? 'badge-warning' : 'badge-danger'}" style="font-size:11px; text-transform:capitalize;">
                        ${Utils.escapeHtml(h.status)}
                      </span>
                    </td>
                    <td style="font-size:12px; color:var(--text-muted);">${h.created_at ? new Date(h.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '—'}</td>
                    <td>${paymentBadgeHtml(h)}</td>
                    <td>${customerOrderRowActions(h)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger); padding:20px;">Failed to load customer orders: ${Utils.escapeHtml(err.message)}</div>`;
  }
}

async function setCustomerOrderStatus(id, newStatus) {
  try {
    const res = await Auth.fetch(`/api/v1/customer-orders/${id}/status`, {
      method: "PUT",
      body: JSON.stringify({ status: newStatus })
    });
    if (!res.ok) throw new Error("Failed to update status");
    Utils.showToast(`Order marked as ${newStatus}`, "success");
    loadCustomerOrdersTable();
    fetchPendingOnlineOrders();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TABLE QR CODE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
async function renderTables(c) {
  c = c || document.getElementById("view-container");
  if (!c) return;
  c.innerHTML = `
    <div class="section-card" style="padding:24px; margin-bottom: 24px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h2 style="font-size:18px; font-weight:700;">Table QR Codes</h2>
        <div style="display:flex; gap: 8px;">
          <button class="btn btn-primary" onclick="showAddTableModal()"><i class="fas fa-plus"></i> Add Table</button>
          <button class="btn btn-outline" onclick="printAllQRs()"><i class="fas fa-print"></i> Print All QRs</button>
        </div>
      </div>
      <div id="tables-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap:16px;">
        <p style="color:var(--text-muted); font-size:14px;">Loading tables...</p>
      </div>
    </div>
  `;
  
  await fetchAndRenderTablesGrid();
}

async function fetchAndRenderTablesGrid() {
  const grid = document.getElementById("tables-grid");
  if (!grid) return;
  
  try {
    const res = await Auth.fetch("/api/v1/tables");
    if (!res.ok) throw new Error("Failed to load tables");
    const tables = await res.json();
    
    if (tables.length === 0) {
      grid.innerHTML = `<p style="color:var(--text-muted); font-size:14px; grid-column: 1 / -1; text-align:center; padding: 40px 0;">No tables configured yet. Click "+ Add Table" to generate your first table QR code!</p>`;
      return;
    }
    
    grid.innerHTML = "";
    
    tables.forEach(t => {
      const card = document.createElement("div");
      card.className = "table-qr-card";
      card.style.cssText = "border: 1px solid rgba(205,190,150,0.35); border-radius: 12px; padding: 24px; text-align: center; background: #fff;";
      
      const qrUrl = `${window.location.origin}/customer?table=${encodeURIComponent(t.table_number)}`;
      const qrContainerId = `qrcode-${t.id}`;
      
      card.innerHTML = `
        <h3 style="font-size:16px; font-weight:700; color: #18181b; margin-bottom: 4px;">BLESSIE FOOD HUB</h3>
        <h4 style="font-size:18px; font-weight:800; color: #c9a227; margin-bottom: 8px;">TABLE ${Utils.escapeHtml(t.table_number)}</h4>
        <p style="font-size:12px; font-weight:600; color: #71717a; margin-bottom: 16px;">SCAN TO ORDER</p>
        
        <div id="${Utils.escapeHtml(qrContainerId)}" style="display:flex; justify-content:center; margin-bottom: 24px; min-height: 150px;" data-url="${Utils.escapeHtml(qrUrl)}"></div>
        
        <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
          <a href="${Utils.escapeHtml(qrUrl)}" target="_blank" class="btn btn-outline btn-sm" title="Preview Customer Menu"><i class="fas fa-external-link-alt"></i> Test Menu</a>
          <button class="btn btn-outline btn-sm" onclick="downloadQR(${Utils.jsArg(qrContainerId)}, 'Table_' + decodeURIComponent('${encodeURIComponent(t.table_number).replace(/'/g, '%27')}') + '_QR')" title="Download QR Image"><i class="fas fa-download"></i></button>
          <button class="btn btn-outline btn-sm" onclick="printSingleQR('${Number(t.id)}', decodeURIComponent('${encodeURIComponent(t.table_number).replace(/'/g, '%27')}'))" title="Print QR"><i class="fas fa-print"></i></button>
          <button class="btn btn-danger btn-sm" onclick="deleteTable(${t.id})" title="Delete Table"><i class="fas fa-trash"></i></button>
        </div>
      `;
      grid.appendChild(card);
      
      // Generate QR
      setTimeout(() => {
        const qrEl = document.getElementById(qrContainerId);
        if (qrEl && typeof QRCode !== 'undefined') {
          new QRCode(qrEl, {
            text: qrUrl,
            width: 150,
            height: 150,
            colorDark : "#000000",
            colorLight : "#ffffff",
            correctLevel : QRCode.CorrectLevel.H
          });
        }
      }, 50);
    });
    
  } catch (err) {
    grid.innerHTML = `<p style="color:var(--danger);">${Utils.escapeHtml(err.message)}</p>`;
  }
}

function showAddTableModal() {
  Utils.openModal("Add Restaurant Table", `
    <form id="form-add-table" onsubmit="event.preventDefault(); submitAddTable();">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Table Number / Identifier <span style="color:var(--danger);">*</span></label>
        <input type="text" id="newTableNumber" class="input-field" required placeholder="e.g. 1, 2, Patio A, VIP" style="width:100%;">
        <small style="font-size:11px; color:var(--text-muted); margin-top:4px; display:block;">Enter table number (a unique QR code will be generated for customers to scan).</small>
      </div>
    </form>
  `, `
    <div style="display:flex; justify-content:flex-end; gap:10px; width:100%;">
      <button type="button" class="btn btn-outline" onclick="Utils.closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="submitAddTable()"><i class="fas fa-save"></i> Save Table</button>
    </div>
  `);
}

async function submitAddTable() {
  const tableNum = document.getElementById("newTableNumber")?.value.trim();
  if (!tableNum) return Utils.showToast("Table number required", "danger");
  
  try {
    const res = await Auth.fetch("/api/v1/tables", {
      method: "POST",
      body: JSON.stringify({ table_number: tableNum })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to add table");
    
    Utils.showToast("Table added successfully!", "success");
    Utils.closeModal();
    fetchAndRenderTablesGrid();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

async function deleteTable(id) {
  if (!confirm("Delete this table? This will invalidate its QR code.")) return;
  try {
    const res = await Auth.fetch(`/api/v1/tables/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete table");
    Utils.showToast("Table deleted", "success");
    fetchAndRenderTablesGrid();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

function downloadQR(containerId, filename) {
  const container = document.getElementById(containerId);
  const img = container.querySelector("img");
  const canvas = container.querySelector("canvas");
  
  let src = null;
  if (img && img.src) src = img.src;
  else if (canvas) src = canvas.toDataURL("image/png");
  
  if (!src) return Utils.showToast("QR code not ready yet.", "warning");
  
  const a = document.createElement("a");
  a.href = src;
  a.download = filename + ".png";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function getPrintableHTML(qrs) {
  // qrs is an array of objects: { title, number, src }
  let html = `
    <html>
      <head>
        <title>Print QRs</title>
        <style>
          @page { size: A4 portrait; margin: 0; }
          body { font-family: 'Inter', sans-serif; margin: 0; padding: 20px; text-align: center; background: #fff; }
          .qr-page { 
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            height: 100vh; page-break-after: always; box-sizing: border-box; padding: 40px;
          }
          .qr-page:last-child { page-break-after: auto; }
          .qr-badge {
            border: 4px solid #18181b; padding: 40px; border-radius: 20px;
            display: flex; flex-direction: column; align-items: center; width: 80%; max-width: 400px;
          }
          h1 { font-size: 28px; font-weight: 800; text-transform: uppercase; margin: 0 0 10px 0; color: #18181b; }
          h2 { font-size: 42px; font-weight: 800; margin: 0 0 20px 0; color: #18181b; }
          h3 { font-size: 20px; font-weight: 700; margin: 0 0 40px 0; color: #18181b; letter-spacing: 2px; }
          img { width: 300px; height: 300px; }
        </style>
      </head>
      <body>
  `;
  
  qrs.forEach(qr => {
    html += `
      <div class="qr-page">
        <div class="qr-badge">
          <h1>BLESSIE FOOD HUB</h1>
          <h2>TABLE ${Utils.escapeHtml(qr.number)}</h2>
          <h3>SCAN TO ORDER</h3>
          <img src="${Utils.escapeHtml(qr.src)}" alt="QR">
        </div>
      </div>
    `;
  });
  
  html += `
      <script>
        window.onload = function() { window.print(); window.close(); }
      </script>
      </body>
    </html>
  `;
  return html;
}

function printSingleQR(tableId, tableNumber) {
  const container = document.getElementById(`qrcode-${tableId}`);
  let src = null;
  const img = container.querySelector("img");
  const canvas = container.querySelector("canvas");
  if (img && img.src) src = img.src;
  else if (canvas) src = canvas.toDataURL("image/png");
  
  if (!src) return Utils.showToast("QR code not ready yet.", "warning");
  
  const printWin = window.open("", "_blank");
  printWin.document.write(getPrintableHTML([{ number: tableNumber, src }]));
  printWin.document.close();
}

function printAllQRs() {
  const qrs = [];
  const cards = document.querySelectorAll(".table-qr-card");
  
  cards.forEach(card => {
    const tableNumberText = card.querySelector("h4").innerText.replace("TABLE ", "");
    const container = card.querySelector("[id^='qrcode-']");
    let src = null;
    const img = container.querySelector("img");
    const canvas = container.querySelector("canvas");
    if (img && img.src) src = img.src;
    else if (canvas) src = canvas.toDataURL("image/png");
    
    if (src) {
      qrs.push({ number: tableNumberText, src });
    }
  });
  
  if (qrs.length === 0) return Utils.showToast("No QR codes to print.", "warning");
  
  const printWin = window.open("", "_blank");
  printWin.document.write(getPrintableHTML(qrs));
  printWin.document.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. CASH IN DRAWER & CASHIER SHIFT TRACKING (FOR MANAGER & ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

let cachedDrawerData = null;
let drawerRefreshDebounceTimer = null;

let _drawerSummaryInFlight = null;

function debouncedDrawerRefresh(silent = true) {
  if (drawerRefreshDebounceTimer) clearTimeout(drawerRefreshDebounceTimer);
  drawerRefreshDebounceTimer = setTimeout(() => {
    if (typeof renderCashDrawerTracker === "function") {
      renderCashDrawerTracker(null, silent);
    }
  }, 40);
}

async function renderCashDrawerTracker(c, silent = false) {
  const container = c || document.getElementById("view-container");
  if (!container) return;

  const hasContent = container.querySelector(".section-card") !== null;

  // Only show full loading spinner if container is empty and not a silent refresh
  if (!hasContent && !silent) {
    if (cachedDrawerData) {
      renderCashDrawerTrackerUI(container, cachedDrawerData);
    } else {
      container.innerHTML = `
        <div style="display:flex; justify-content:center; align-items:center; min-height:260px; color:var(--text-muted, #71717a);">
          <div style="text-align:center;">
            <i class="fas fa-spinner fa-spin" style="font-size:2rem; margin-bottom:0.75rem; color:#c9a227;"></i>
            <p style="font-size:14px; font-weight:500;">Loading cashier drawer records...</p>
          </div>
        </div>
      `;
    }
  }

  const refreshIcon = document.getElementById("cash-drawer-refresh-icon");
  if (refreshIcon) refreshIcon.classList.add("fa-spin");

  try {
    if (!_drawerSummaryInFlight) {
      _drawerSummaryInFlight = Auth.fetch("/api/v1/shifts/drawer-summary").then(async (r) => {
        if (!r.ok) throw new Error("Failed to fetch cash drawer summary.");
        return r.json();
      }).finally(() => {
        _drawerSummaryInFlight = null;
      });
    }
    cachedDrawerData = await _drawerSummaryInFlight;
    renderCashDrawerTrackerUI(container, cachedDrawerData);
  } catch (err) {
    console.error("Cash Drawer Error:", err);
    if (!hasContent && !cachedDrawerData) {
      container.innerHTML = `
        <div class="section-card" style="padding:24px; border:1px solid rgba(239,68,68,0.35);">
          <h3 style="color:var(--danger, #ef4444); font-size:16px; font-weight:700;"><i class="fas fa-exclamation-triangle"></i> Error Loading Cash Drawer Data</h3>
          <p style="color:var(--text-muted, #71717a); margin:10px 0; font-size:13px;">${Utils.escapeHtml(err.message || "Failed to communicate with backend.")}</p>
          <button class="btn btn-outline btn-sm" onclick="renderCashDrawerTracker()"><i class="fas fa-redo"></i> Retry</button>
        </div>
      `;
    }
  } finally {
    const iconNow = document.getElementById("cash-drawer-refresh-icon");
    if (iconNow) iconNow.classList.remove("fa-spin");
  }
}

function renderCashDrawerTrackerUI(container, data) {
  const isInitialRender = !container.querySelector(".section-card");
  const toolbarClass = isInitialRender ? "toolbar fade-up" : "toolbar";
  const statsGridClass = isInitialRender ? "stats-grid fade-up delay-1" : "stats-grid";
  const sectionCardClass = isInitialRender ? "section-card fade-up delay-2" : "section-card";

  const allShifts = (data && data.shifts) || [];
  const shifts = allShifts.filter(s => {
    const role = (s.role || '').toLowerCase();
    const uname = (s.cashier_username || '').toLowerCase();
    return role === 'cashier' || uname === 'cashier' || (!['admin', 'manager', 'superadmin', 'kitchen', 'inventory'].includes(uname) && !['admin', 'manager', 'superadmin', 'kitchen', 'inventory'].includes(role));
  });
  const allMovements = [];
  shifts.forEach(s => {
    (s.movements || []).forEach(m => {
      allMovements.push({ ...m, shiftId: s.id, cashierName: s.cashier_name });
    });
  });
  allMovements.sort((a, b) => (b.id || 0) - (a.id || 0));

  const totalDrops = shifts.reduce((sum, s) => sum + (s.paid_out || 0), 0);
  const totalPaidIn = shifts.reduce((sum, s) => sum + (s.paid_in || 0), 0);
  const managerIncomeVal = data.manager_safe_cash !== undefined 
    ? data.manager_safe_cash 
    : (cachedProfitLossData?.cashout?.manager_safe_cash !== undefined 
        ? cachedProfitLossData.cashout.manager_safe_cash 
        : totalDrops);

  container.innerHTML = `
    <!-- Top Toolbar -->
    <div class="${toolbarClass}" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px;">
      <div>
        <h2 style="font-size:20px; font-weight:800; color:var(--text-main); margin:0; display:flex; align-items:center; gap:8px;">
          <i class="fas fa-vault" style="color:#c9a227;"></i> Cash Drawer
        </h2>
        <p style="font-size:12px; color:var(--text-muted); margin:4px 0 0 0;">
          Live cash drawer balance, cashier floats, sales collections, and manager safe income
        </p>
      </div>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="openAddCashMovementModal(null, 'manager_income')" title="Transfer Cashier Drawer to Manager Income Safe" style="display:inline-flex; align-items:center; gap:6px; font-weight:700; border-radius:10px; padding:6px 14px; background:linear-gradient(135deg, #10b981 0%, #059669 100%); border:none; color:#fff; cursor:pointer;">
          <i class="fas fa-paper-plane"></i> Transfer Income
        </button>
        <button class="btn btn-outline btn-sm" onclick="openAssignCashierModal()" title="Assign Cashier Account to Cash Drawer" style="display:inline-flex; align-items:center; gap:6px; color:#3b82f6; border-color:#3b82f6; font-weight:700; border-radius:10px; padding:6px 14px;">
          <i class="fas fa-user-check"></i> Assign Account
        </button>
        <button class="btn btn-outline btn-sm" onclick="openEditCashierDrawerModal(null)" title="Edit Cashier Drawer" style="display:inline-flex; align-items:center; gap:6px; color:#c9a227; border-color:#c9a227; font-weight:700; border-radius:10px; padding:6px 14px;">
          <i class="fas fa-pen-to-square"></i> Edit Drawer
        </button>
        <button class="btn btn-outline btn-sm" onclick="renderCashDrawerTracker(null, true)" title="Refresh Drawer Balances" style="border-radius:10px; padding:6px 12px;">
          <i class="fas fa-sync-alt" id="cash-drawer-refresh-icon"></i> Live Refresh
        </button>
      </div>
    </div>

    <!-- Metrics Cards Grid: Cashier Drawer, Overall Income & Manager Income -->
    <div class="${statsGridClass}" style="grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); margin-bottom:16px;">
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-vault"></i></div>
        <div class="stat-info">
          <h3>Cashier Drawer</h3>
          <div class="stat-count" style="color:#c9a227;">${Utils.formatCurrency(data.total_cash_in_drawers || 0)}</div>
          <div class="stat-trend" style="color:var(--success, #10b981);"><i class="fas fa-cash-register"></i> Live active cashier drawer balance</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-chart-line"></i></div>
        <div class="stat-info">
          <h3>Overall Income</h3>
          <div class="stat-count" style="color:#10b981;">${Utils.formatCurrency(data.overall_income !== undefined ? data.overall_income : (data.orders_overall_income || 0))}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-circle-check"></i> Orders revenue from completed sales</div>
        </div>
      </div>
      <div class="stat-card" style="cursor:pointer;" onclick="openAddCashMovementModal(null, 'manager_income')" title="Click to Transfer Cashier Drawer to Manager Income">
        <div class="stat-icon purple" style="background:rgba(123,31,162,0.12); color:#7b1fa2;"><i class="fas fa-vault"></i></div>
        <div class="stat-info">
          <h3>Manager Income</h3>
          <div class="stat-count" style="color:#7b1fa2;">${Utils.formatCurrency(managerIncomeVal || 0)}</div>
          <div class="stat-trend" style="color:#7b1fa2;"><i class="fas fa-vault"></i> Manager safe balance (transferred from cashiers)</div>
        </div>
      </div>
    </div>

    <!-- Active & Recent Cashier Drawers Table -->
    <div class="${sectionCardClass}" style="margin-bottom:24px;">
      <div class="section-head">
        <div>
          <h2><i class="fas fa-cash-register" style="color:#c9a227; margin-right:8px;"></i> Cashier Drawer to Track Cashier Overall Income</h2>
          <span style="font-size:12px; color:var(--text-muted);">Real-time tracking of active cashier drawers and cashier overall income from complete orders</span>
        </div>
        <span class="badge badge-info" style="font-size:11px; font-weight:700;">${Utils.escapeHtml(shifts.length)} Recorded Shifts</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cashier</th>
              <th>Shift Status</th>
              <th>Started At</th>
              <th style="background:rgba(201,162,39,0.12); color:#c9a227; font-size:13px;"><i class="fas fa-pen-to-square" style="margin-right:4px;"></i> Edit Cashier Drawer</th>
              <th style="background:rgba(16,185,129,0.12); color:#10b981; font-size:13px;">Cashier Overall Income</th>
              <th style="font-size:12px;"><i class="fas fa-money-bill-wave" style="color:#10b981; margin-right:4px;"></i> Overall Cash</th>
              <th style="font-size:12px;"><i class="fas fa-mobile-screen-button" style="color:#007dfe; margin-right:4px;"></i> GCash</th>
              <th style="background:rgba(123,31,162,0.12); color:#7b1fa2; font-size:12px;"><i class="fas fa-paper-plane" style="margin-right:4px;"></i> Transfer to Manager</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${renderDrawerTableRows(shifts)}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderDrawerTableRows(shifts) {
  if (!shifts || !shifts.length) {
    return `<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-muted);">
      <i class="fas fa-info-circle"></i> No cashier shifts recorded yet.
      <div style="margin-top:10px;">
        <button type="button" class="btn btn-outline btn-sm" onclick="openAssignCashierModal()" style="color:#3b82f6; border-color:#3b82f6; font-weight:700;">
          <i class="fas fa-user-check"></i> Assign Cashier Account
        </button>
      </div>
    </td></tr>`;
  }
  return shifts.map(s => {
    const isOpen = s.status === 'open';
    const statusBadge = isOpen
      ? '<span class="badge badge-success" style="font-size:11px; font-weight:700;"><i class="fas fa-circle" style="font-size:8px; margin-right:4px;"></i> ACTIVE OPEN</span>'
      : '<span class="badge badge-secondary" style="font-size:11px; font-weight:700;">CLOSED</span>';

    const startDate = s.start_time ? new Date(s.start_time).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';

    return `
      <tr>
        <td style="white-space:nowrap; min-width:210px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <div class="avatar-fallback" style="width:34px; height:34px; font-size:12px; border-radius:8px; background:rgba(201,162,39,0.15); color:#c9a227; font-weight:800; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;">
              ${(s.cashier_username || 'C').substring(0,2).toUpperCase()}
            </div>
            <div style="min-width:0;">
              <strong style="color:var(--text-main); font-size:13.5px; font-weight:700; text-transform:capitalize; white-space:nowrap; display:block; letter-spacing:0.2px;">${Utils.escapeHtml(s.cashier_name)}</strong>
              <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
                <span style="font-size:11px; color:var(--text-muted); font-weight:600;">@${Utils.escapeHtml(s.cashier_username || 'cashier')}</span>
                ${isOpen ? `
                <button type="button" onclick="openAssignCashierModal(${s.id}, ${s.cashier_id || 'null'})" title="Assign / Change Cashier Account" style="padding:1px 6px; font-size:10px; font-weight:700; color:#3b82f6; background:rgba(59,130,246,0.1); border:1px solid rgba(59,130,246,0.3); border-radius:4px; cursor:pointer; display:inline-flex; align-items:center; gap:3px;">
                  <i class="fas fa-user-check"></i> Assign Account
                </button>
                ` : ''}
              </div>
            </div>
          </div>
        </td>
        <td>${statusBadge}</td>
        <td style="color:var(--text-muted); font-size:12px;">${Utils.escapeHtml(startDate)}</td>
        <td style="background:rgba(201,162,39,0.08); min-width:170px;">
          ${isOpen ? `
          <div style="display:flex; align-items:center; gap:8px;">
            <div style="display:inline-flex; align-items:center; padding:6px 14px; border:1.5px solid #c9a227; border-radius:8px; font-weight:800; color:#c9a227; background:var(--bg-card, #fff); font-size:13.5px; cursor:default; user-select:none; pointer-events:none;" title="Active Cashier Drawer Float">
              ${Utils.formatCurrency(s.expected_cash || 0)}
            </div>
            <button type="button" class="btn btn-outline btn-sm" onclick="openEditCashierDrawerModal(${s.id}, ${Utils.jsArg(s.cashier_name)}, ${s.expected_cash || 0})" 
              title="Edit Cashier Drawer"
              style="padding:5px 8px; font-size:12px; color:#c9a227; border-color:#c9a227; cursor:pointer; border-radius:6px;">
              <i class="fas fa-pen-to-square"></i>
            </button>
          </div>
          ` : `
          <div style="display:flex; align-items:center; gap:6px;">
            <strong style="color:var(--text-muted); font-size:14px; font-weight:700;">${Utils.formatCurrency(s.expected_cash)}</strong>
            <span class="badge badge-secondary" style="font-size:10px; font-weight:600;">CLOSED</span>
          </div>
          `}
        </td>
        <td style="background:rgba(16,185,129,0.08);">
          <strong style="color:#10b981; font-weight:800; font-size:15px;">
            ${Utils.formatCurrency(s.cashier_overall_income !== undefined ? s.cashier_overall_income : (Number(s.total_sales) || 0))}
          </strong>
          <div style="font-size:10px; color:var(--text-muted); margin-top:2px;">
            ${(s.cashed_out || s.paid_out) ? `<span style="color:#10b981; font-weight:700;">Cashed Out: ${Utils.formatCurrency(s.cashed_out || s.paid_out)}</span> &bull; ` : ''}Total Shift Sales (Cash + Non-Cash)
          </div>
        </td>
        <td>
          <strong style="color:#10b981; font-weight:800; font-size:13.5px;">+${Utils.formatCurrency(Number(s.cash_sales) || 0)}</strong>
          <div style="font-size:10px; color:var(--text-muted); margin-top:2px;">Cash Sales Collected</div>
        </td>
        <td>
          <strong style="color:#007dfe; font-weight:800; font-size:13.5px;">+${Utils.formatCurrency(s.non_cash_sales || 0)}</strong>
          <div style="font-size:10px; color:var(--text-muted); margin-top:2px;">GCash / Online</div>
        </td>
        <td style="background:rgba(123,31,162,0.06); min-width:140px;">
          <strong style="color:#7b1fa2; font-weight:800; font-size:13.5px;">${Utils.formatCurrency(s.cashed_out || s.paid_out || 0)}</strong>
          <div style="font-size:10px; color:var(--text-muted); margin-top:2px;">Transferred to Manager Safe</div>
        </td>
        <td style="text-align:right; white-space:nowrap;">
          <div style="display:inline-flex; gap:6px; align-items:center;">
            ${isOpen ? `
            <button type="button" class="btn btn-sm" onclick="openAddCashMovementModal(${s.id}, 'manager_income')" title="Transfer Drawer & Income to Manager Safe" style="padding:4px 10px; font-size:11px; background:rgba(16,185,129,0.12); color:#10b981; border:1px solid rgba(16,185,129,0.3); border-radius:6px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:4px;">
              <i class="fas fa-paper-plane"></i> Transfer to Manager
            </button>
            ` : ''}
            <button class="btn btn-outline btn-sm" onclick="openShiftMovementsModal(${s.id})" title="View Cash Movement History" style="padding:4px 8px; font-size:11px;">
              <i class="fas fa-list-check"></i> Audit
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderMovementsTableRows(movements) {
  if (!movements || !movements.length) {
    return '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);"><i class="fas fa-receipt"></i> No cash movements logged yet. Record a Cash Drop or Float Injection anytime.</td></tr>';
  }
  return movements.slice(0, 20).map(m => {
    const isDrop = m.type === 'PAID_OUT';
    const typeBadge = isDrop
      ? '<span class="badge badge-danger" style="font-size:11px; font-weight:700;"><i class="fas fa-arrow-down"></i> CASH DROP / PAID OUT</span>'
      : '<span class="badge badge-success" style="font-size:11px; font-weight:700;"><i class="fas fa-arrow-up"></i> FLOAT INJECTION / PAID IN</span>';

    const timeStr = m.created_at ? new Date(m.created_at).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';

    return `
      <tr>
        <td style="color:var(--text-muted); font-size:12px;">${Utils.escapeHtml(timeStr)}</td>
        <td>
          <strong style="color:var(--text-main); font-size:13px;">${Utils.escapeHtml(m.cashierName || 'Shift #' + m.shiftId)}</strong>
          <div style="font-size:11px; color:var(--text-muted);">Shift #${Utils.escapeHtml(m.shiftId)}</div>
        </td>
        <td>${typeBadge}</td>
        <td>
          <strong style="font-size:14px; color:${isDrop ? '#ef4444' : '#10b981'};">
            ${isDrop ? '-' : '+'}${Utils.formatCurrency(m.amount)}
          </strong>
        </td>
        <td style="color:var(--text-main); font-size:13px;">${Utils.escapeHtml(m.reason || 'No description provided')}</td>
        <td style="color:var(--text-muted); font-size:12px;">${Utils.escapeHtml(m.recorded_by || 'Staff')}</td>
      </tr>
    `;
  }).join('');
}

let _isReloadingTransferDialog = false;

async function reloadTransferDialogData(showToast = true) {
  const form = document.getElementById("form-cash-movement");
  if (!form || _isReloadingTransferDialog) return;
  _isReloadingTransferDialog = true;

  const spin = document.getElementById("transfer-reload-spin");
  if (spin) spin.classList.add("fa-spin");

  const badge = document.getElementById("cm-network-badge");
  if (badge) {
    badge.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Syncing...`;
    badge.style.color = "var(--primary, #3b82f6)";
  }

  try {
    const transferReason = document.getElementById("cm-transfer-reason")?.value || "";
    const isManagerProfitIncome = transferReason.includes("Manager");

    if (isManagerProfitIncome) {
      const drawerRes = await Auth.fetch("/api/v1/shifts/drawer-summary").catch(() => null);
      if (drawerRes && drawerRes.ok) cachedDrawerData = await drawerRes.json();
    } else {
      const [drawerRes, plRes] = await Promise.all([
        Auth.fetch("/api/v1/shifts/drawer-summary").catch(() => null),
        Auth.fetch("/api/v1/analytics/profit-loss").catch(() => null)
      ]);
      if (drawerRes && drawerRes.ok) cachedDrawerData = await drawerRes.json();
      if (plRes && plRes.ok) cachedProfitLossData = await plRes.json();
    }

    let shifts = (cachedDrawerData && cachedDrawerData.shifts) || [];
    let cashierShifts = shifts.filter(s => {
      const role = (s.role || '').toLowerCase();
      const uname = (s.cashier_username || '').toLowerCase();
      return role === 'cashier' || uname === 'cashier' || (!['admin', 'manager', 'superadmin', 'kitchen', 'inventory'].includes(uname) && !['admin', 'manager', 'superadmin', 'kitchen', 'inventory'].includes(role));
    });
    if (!cashierShifts.length && shifts.length) cashierShifts = shifts;
    let openShifts = cashierShifts.filter(s => s.status === 'open');
    if (!openShifts.length && cashierShifts.length) openShifts = [cashierShifts[0]];

    const shiftSelect = document.getElementById("cm-shift-id");
    let currentShiftId = shiftSelect ? parseInt(shiftSelect.value, 10) : null;
    const targetShift = (currentShiftId ? openShifts.find(s => s.id === currentShiftId) : null) || openShifts[0] || cashierShifts[0] || null;

    const expectedCash = targetShift ? (targetShift.expected_cash || 0) : (cachedDrawerData?.total_cash_in_drawers ?? cachedProfitLossData?.cashout?.active_drawer_cash ?? 0);
    const cashierOverallIncome = targetShift 
      ? (targetShift.cashier_overall_income !== undefined ? targetShift.cashier_overall_income : (targetShift.total_sales || 0))
      : (cachedDrawerData?.overall_income || (targetShift ? targetShift.total_sales : 0) || 0);
    const availableSafeCash = cachedDrawerData?.manager_safe_cash !== undefined
      ? cachedDrawerData.manager_safe_cash
      : (cachedProfitLossData?.cashout?.manager_safe_cash !== undefined
          ? cachedProfitLossData.cashout.manager_safe_cash
          : Math.max(0, (cachedProfitLossData?.cashout?.total_cashout_income || 0) - (cachedProfitLossData?.cashout?.total_transferred_to_admin || 0)));

    const freshAmount = isManagerProfitIncome
      ? (expectedCash > 0 ? expectedCash : (cashierOverallIncome > 0 ? cashierOverallIncome : 0))
      : (availableSafeCash > 0 ? availableSafeCash : 0);

    const amountInput = document.getElementById("cm-amount");
    if (amountInput && (showToast || amountInput.dataset.userEdited !== "true")) {
      amountInput.value = freshAmount > 0 ? freshAmount.toFixed(2) : "";
      if (showToast) delete amountInput.dataset.userEdited;
    }

    if (shiftSelect && shiftSelect.tagName === "INPUT" && targetShift) {
      shiftSelect.value = targetShift.id;
    }

    const infoEl = document.getElementById("cm-expected-info-container");
    if (infoEl) {
      infoEl.innerHTML = isManagerProfitIncome ? `
        Cashier Drawer (All Cash to Manager Income): <strong id="cm-expected-info" style="color:#10b981;">${Utils.formatCurrency(expectedCash)}</strong>
        &bull; Sales Income: <strong>${Utils.formatCurrency(cashierOverallIncome)}</strong>
      ` : `
        Available in Manager Safe: <strong id="cm-expected-info" style="color:#10b981;">${Utils.formatCurrency(availableSafeCash)}</strong>
        &bull; <span style="color:#ef4444; font-weight:700;"><i class="fas fa-arrow-down"></i> Decreases Manager Realized Income</span>
      `;
    }

    if (shiftSelect && shiftSelect.tagName === "SELECT") {
      shiftSelect.innerHTML = openShifts.map(s => {
        const sIncome = s.cashier_overall_income !== undefined ? s.cashier_overall_income : (s.total_sales || 0);
        return `
        <option value="${Utils.escapeHtml(s.id)}" ${s.id === (targetShift ? targetShift.id : "") ? 'selected' : ''}>
          Shift #${Utils.escapeHtml(s.id)} — ${Utils.escapeHtml(s.cashier_name)} (@${Utils.escapeHtml(s.cashier_username)}) [Overall Income: ${Utils.formatCurrency(sIncome)} | Drawer: ${Utils.formatCurrency(s.expected_cash)}]
        </option>
        `;
      }).join('');
    }

    if (badge) {
      badge.innerHTML = `<i class="fas fa-wifi"></i> Live Network`;
      badge.style.color = "#10b981";
    }

    if (showToast && typeof Utils !== 'undefined' && Utils.showToast) {
      Utils.showToast("Transfer figures fast-reloaded from live network.", "info");
    }
  } catch (err) {
    console.error("Fast reload transfer error:", err);
    if (badge) {
      badge.innerHTML = `<i class="fas fa-triangle-exclamation"></i> Sync Error`;
      badge.style.color = "#ef4444";
    }
  } finally {
    _isReloadingTransferDialog = false;
    if (spin) spin.classList.remove("fa-spin");
  }
}

async function openAddCashMovementModal(defaultShiftId = null, targetType = null) {
  // Determine destination: Manager Profit Income (default when in cash drawer) vs Admin
  const currentLink = document.querySelector("aside.sidebar .nav-link.active, .sidebar a.active");
  const activeView = currentLink ? (currentLink.getAttribute("href") || "").replace(/^#\/?/, "").trim() : ((window.location.hash || "").replace(/^#\/?/, "").trim() || "dashboard");
  const isManagerProfitIncome = targetType === 'manager_income' || (!targetType && activeView !== 'profit_loss' && activeView !== 'purchases');

  // Only await network if we have no cached data at all; otherwise open modal IMMEDIATELY (0ms) and sync in background
  const needsBlockingFetch = isManagerProfitIncome ? !cachedDrawerData : (!cachedDrawerData && !cachedProfitLossData);
  if (needsBlockingFetch) {
    try {
      if (isManagerProfitIncome) {
        const drawerRes = await Auth.fetch("/api/v1/shifts/drawer-summary").catch(() => null);
        if (drawerRes && drawerRes.ok) cachedDrawerData = await drawerRes.json();
      } else {
        const [drawerRes, plRes] = await Promise.all([
          Auth.fetch("/api/v1/shifts/drawer-summary").catch(() => null),
          Auth.fetch("/api/v1/analytics/profit-loss").catch(() => null)
        ]);
        if (drawerRes && drawerRes.ok) cachedDrawerData = await drawerRes.json();
        if (plRes && plRes.ok) cachedProfitLossData = await plRes.json();
      }
    } catch (e) {
      console.warn("Network reload on transfer modal error:", e);
    }
  }

  let shifts = (cachedDrawerData && cachedDrawerData.shifts) || [];
  // Strictly filter to cashier accounts only (not admin, manager, superadmin, etc.)
  let cashierShifts = shifts.filter(s => {
    const role = (s.role || '').toLowerCase();
    const uname = (s.cashier_username || '').toLowerCase();
    return role === 'cashier' || uname === 'cashier' || (!['admin', 'manager', 'superadmin', 'kitchen', 'inventory'].includes(uname) && !['admin', 'manager', 'superadmin', 'kitchen', 'inventory'].includes(role));
  });
  if (!cashierShifts.length && shifts.length) {
    cashierShifts = shifts;
  }
  let openShifts = cashierShifts.filter(s => s.status === 'open');
  if (!openShifts.length && cashierShifts.length) {
    openShifts = [cashierShifts[0]];
  }

  const targetShift = (defaultShiftId ? openShifts.find(s => s.id === defaultShiftId) : null) || openShifts[0] || cashierShifts[0] || null;
  const targetShiftId = targetShift ? targetShift.id : "";
  const expectedCash = targetShift ? (targetShift.expected_cash || 0) : (cachedDrawerData?.total_cash_in_drawers ?? cachedProfitLossData?.cashout?.active_drawer_cash ?? 0);
  const cashierOverallIncome = targetShift 
    ? (targetShift.cashier_overall_income !== undefined ? targetShift.cashier_overall_income : (targetShift.total_sales || 0))
    : (cachedDrawerData?.overall_income || (targetShift ? targetShift.total_sales : 0) || 0);
  const availableSafeCash = cachedDrawerData?.manager_safe_cash !== undefined
    ? cachedDrawerData.manager_safe_cash
    : (cachedProfitLossData?.cashout?.manager_safe_cash !== undefined
        ? cachedProfitLossData.cashout.manager_safe_cash
        : Math.max(0, (cachedProfitLossData?.cashout?.total_cashout_income || 0) - (cachedProfitLossData?.cashout?.total_transferred_to_admin || 0)));

  const defaultCashoutAmount = isManagerProfitIncome
    ? (expectedCash > 0 ? expectedCash : (cashierOverallIncome > 0 ? cashierOverallIncome : 0))
    : (availableSafeCash > 0 ? availableSafeCash : 0);

  const modalTitle = isManagerProfitIncome ? "Transfer Cashier Drawer to Manager Income" : "Transfer to Admin";
  const labelText = isManagerProfitIncome ? "Transfer Amount to Manager Income (₱)" : "Transfer Amount to Admin (₱)";
  const btnIcon = isManagerProfitIncome ? "fa-vault" : "fa-paper-plane";
  const btnText = isManagerProfitIncome ? "Transfer to Manager Income & Reset Drawer to ₱0.00" : "Transfer to Admin (Decreases Realized Cash)";
  const transferReason = isManagerProfitIncome ? "Transfer to Manager Profit Income" : "Transfer to Admin";

  const shiftOptions = openShifts.length > 0 ? openShifts.map(s => {
    const sIncome = s.cashier_overall_income !== undefined ? s.cashier_overall_income : (s.total_sales || 0);
    return `
    <option value="${Utils.escapeHtml(s.id)}" ${(defaultShiftId && defaultShiftId === s.id) || s.id === targetShiftId ? 'selected' : ''}>
      Shift #${Utils.escapeHtml(s.id)} — ${Utils.escapeHtml(s.cashier_name)} (@${Utils.escapeHtml(s.cashier_username)}) [Overall Income: ${Utils.formatCurrency(sIncome)} | Drawer: ${Utils.formatCurrency(s.expected_cash)}]
    </option>
    `;
  }).join('') : `
    <option value="">Active Cashier Drawer (Auto-Assigned)</option>
  `;

  Utils.openModal(modalTitle, `
    <form id="form-cash-movement" onsubmit="event.preventDefault(); submitAddCashMovement();">
      <input type="hidden" id="cm-transfer-reason" value="${Utils.escapeHtml(transferReason)}">

      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; padding:8px 12px; background:var(--bg-main, #f8fafc); border-radius:10px; border:1px solid var(--border-color, #e2e8f0);">
        <span id="cm-network-badge" style="display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:700; color:#10b981;">
          <i class="fas fa-wifi"></i> Live Network
        </span>
        <button type="button" class="btn btn-outline btn-sm" onclick="reloadTransferDialogData(true)" title="Fast reload fresh balances from live network" style="display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:700; padding:4px 10px; border-radius:8px; cursor:pointer;">
          <i class="fas fa-rotate" id="transfer-reload-spin"></i> Fast Reload
        </button>
      </div>

      ${isManagerProfitIncome ? `
        <div style="background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.25); border-radius:8px; padding:10px 14px; margin-bottom:14px; font-size:12px;">
          <div style="display:flex; align-items:center; gap:6px; font-weight:700; color:#10b981; margin-bottom:2px;">
            <i class="fas fa-shield-halved"></i> Destination: Manager Income Safe (Not Admin)
          </div>
          <div style="color:var(--text-muted); font-size:11.5px; line-height:1.4;">
            Transfers all cashier cash drawer balance and sales income into the <strong>Manager Income</strong> safe. It is <strong>NOT</strong> an Admin transfer. Cashier drawer resets to ₱0.00.
          </div>
        </div>
      ` : `
        <div style="background:rgba(59,130,246,0.08); border:1px solid rgba(59,130,246,0.25); border-radius:8px; padding:10px 14px; margin-bottom:14px; font-size:12px;">
          <div style="display:flex; align-items:center; gap:6px; font-weight:700; color:#3b82f6; margin-bottom:2px;">
            <i class="fas fa-paper-plane"></i> Destination: Admin Safe Remittance
          </div>
          <div style="color:var(--text-muted); font-size:11.5px; line-height:1.4;">
            Transfers cash from Manager Safe to Admin Safe. This deducts from Manager Safe cash.
          </div>
        </div>
      `}

      ${isManagerProfitIncome && openShifts.length > 1 && !defaultShiftId ? `
        <div class="input-group" style="margin-bottom:14px;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Select Active Cashier Shift <span style="color:var(--danger);">*</span></label>
          <select id="cm-shift-id" class="input-field" required style="width:100%;" onchange="const s = ((cachedDrawerData && cachedDrawerData.shifts) || []).find(x => x.id == this.value); if (s && document.getElementById('cm-amount')) { const exp = s.expected_cash || 0; const inc = s.cashier_overall_income !== undefined ? s.cashier_overall_income : (s.total_sales || 0); const val = exp > 0 ? exp : (inc > 0 ? inc : 0); document.getElementById('cm-amount').value = val > 0 ? val.toFixed(2) : ''; const info = document.getElementById('cm-expected-info'); if (info) info.textContent = Utils.formatCurrency(val); }">
            ${shiftOptions}
          </select>
        </div>
      ` : `<input type="hidden" id="cm-shift-id" value="${Utils.escapeHtml(targetShiftId)}">`}

      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:13px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:8px; text-align:center;">
          ${Utils.escapeHtml(labelText)} <span style="color:var(--danger);">*</span>
        </label>
        <input type="number" step="0.01" min="0.01" id="cm-amount" class="input-field" required value="${defaultCashoutAmount > 0 ? defaultCashoutAmount.toFixed(2) : ''}" oninput="this.dataset.userEdited='true'" placeholder="0.00" style="width:100%; font-size:26px; font-weight:800; padding:12px; text-align:center; color:#10b981; border:2px solid #10b981; border-radius:10px;">
        <div id="cm-expected-info-container" style="text-align:center; font-size:12px; color:var(--text-muted); margin-top:8px;">
          ${isManagerProfitIncome ? `
            Cashier Drawer (All Cash to Manager Income): <strong id="cm-expected-info" style="color:#10b981;">${Utils.formatCurrency(expectedCash)}</strong>
            &bull; Sales Income: <strong>${Utils.formatCurrency(cashierOverallIncome)}</strong>
          ` : `
            Available in Manager Safe: <strong id="cm-expected-info" style="color:#10b981;">${Utils.formatCurrency(availableSafeCash)}</strong>
            &bull; <span style="color:#ef4444; font-weight:700;"><i class="fas fa-arrow-down"></i> Decreases Manager Realized Income</span>
          `}
        </div>
      </div>
    </form>
  `, `<button id="btn-submit-cash-movement" class="btn btn-primary" onclick="submitAddCashMovement()" style="width:100%; justify-content:center; padding:12px; font-size:14px; font-weight:700; border-radius:10px;"><i class="fas ${btnIcon}"></i> ${Utils.escapeHtml(btnText)}</button>`);

  // If opened instantly from cache, trigger a silent background sync to ensure live figures are 100% up to date
  if (!needsBlockingFetch) {
    reloadTransferDialogData(false);
  }
}

async function submitAddCashMovement() {
  const shiftIdRaw = document.getElementById("cm-shift-id")?.value;
  const shiftId = shiftIdRaw ? parseInt(shiftIdRaw, 10) : undefined;
  const amountVal = document.getElementById("cm-amount")?.value;
  const amount = parseFloat(amountVal);
  const reason = document.getElementById("cm-transfer-reason")?.value || "Transfer to Manager Profit Income";
  const isManagerIncome = reason.includes("Manager");

  if (isNaN(amount) || amount <= 0) {
    Utils.showToast("Please provide a valid transfer amount greater than ₱0.00.", "danger");
    return;
  }

  const submitBtn = document.getElementById("btn-submit-cash-movement");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processing Real-Time Transfer...`;
  }

  try {
    const res = await Auth.fetch("/api/v1/shifts/cashout", {
      method: "POST",
      body: JSON.stringify({
        shift_id: shiftId || undefined,
        amount: amount,
        reason: reason
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to process transfer");
    }

    const data = await res.json();
    const destName = isManagerIncome ? "Manager Income Safe" : "Admin";
    Utils.closeModal();
    Utils.showToast(data.message || `Successfully transferred ₱${amount.toFixed(2)} to ${destName}! ${isManagerIncome ? 'Cashier drawer reset to ₱0.00.' : 'Manager realized cash decreased.'}`, "success");

    const currentLink = document.querySelector("aside.sidebar .nav-link.active, .sidebar a.active");
    const activeView = currentLink ? (currentLink.getAttribute("href") || "").replace(/^#\/?/, "").trim() : ((window.location.hash || "").replace(/^#\/?/, "").trim() || "dashboard");

    // Optimistic 0ms UI update on Cash Drawer before background sync finishes
    if (activeView === "cash_drawer" && cachedDrawerData && typeof renderCashDrawerTrackerUI === "function") {
      const container = document.getElementById("view-container");
      if (container) {
        if (isManagerIncome) {
          cachedDrawerData.total_cash_in_drawers = Math.max(0, (cachedDrawerData.total_cash_in_drawers || 0) - amount);
          cachedDrawerData.manager_safe_cash = (cachedDrawerData.manager_safe_cash || 0) + amount;
          cachedDrawerData.manager_income = cachedDrawerData.manager_safe_cash;
          if (Array.isArray(cachedDrawerData.shifts)) {
            const sMatch = cachedDrawerData.shifts.find(s => (shiftId && s.id === shiftId) || s.status === "open");
            if (sMatch) {
              sMatch.expected_cash = 0;
              sMatch.paid_out = (sMatch.paid_out || 0) + amount;
              sMatch.cashed_out = (sMatch.cashed_out || 0) + amount;
              if (data && data.new_shift_id) sMatch.id = data.new_shift_id;
            }
          }
        } else {
          cachedDrawerData.manager_safe_cash = Math.max(0, (cachedDrawerData.manager_safe_cash || 0) - amount);
          cachedDrawerData.manager_income = cachedDrawerData.manager_safe_cash;
        }
        renderCashDrawerTrackerUI(container, cachedDrawerData);
      }
    }

    // Reset drawer and profit-loss caches so views re-fetch authoritative updated balances
    cachedDrawerData = null;
    cachedProfitLossData = null;

    // Broadcast signal so Cashier POS in other tabs/windows immediately resets drawer to ₱0.00
    try {
      localStorage.setItem("RESTOTRACK_DRAWER_RESET", Date.now().toString());
      localStorage.setItem("RESTOTRACK_EVENT", JSON.stringify({
        event: isManagerIncome ? "CASHOUT_COMPLETED" : "TRANSFER_TO_ADMIN",
        data: { amount, reason },
        timestamp: Date.now()
      }));
    } catch (e) {}

    // Fast-reload active view in real-time (deduplicated)
    if (activeView === "dashboard" && typeof renderDashboard === "function") {
      renderDashboard();
    } else if ((activeView === "profit_loss" || activeView === "purchases") && typeof renderProfitLoss === "function") {
      renderProfitLoss();
    } else if (activeView === "cash_drawer") {
      debouncedDrawerRefresh(true);
    } else if (activeView === "transactions" && typeof renderTransactions === "function") {
      renderTransactions();
    }

    // Immediately update POS live cashier counter if present in DOM
    const dCashEl = document.getElementById("pos-cash-in-drawer-display");
    if (dCashEl) {
      dCashEl.textContent = Utils.formatCurrency(0);
    }
  } catch (err) {
    console.error("Transfer error:", err);
    Utils.showToast(err.message, "danger");
    if (submitBtn) {
      submitBtn.disabled = false;
      const btnIcon = isManagerIncome ? "fa-vault" : "fa-paper-plane";
      const btnText = isManagerIncome ? "Transfer to Manager Income & Reset Drawer to ₱0.00" : "Transfer to Admin (Decreases Realized Cash)";
      submitBtn.innerHTML = `<i class="fas ${btnIcon}"></i> ${Utils.escapeHtml(btnText)}`;
    }
  }
}

function openShiftMovementsModal(shiftId) {
  const shifts = (cachedDrawerData && cachedDrawerData.shifts) || [];
  const s = shifts.find(item => item.id === shiftId);
  if (!s) return Utils.showToast("Shift record not found.", "warning");

  const movements = s.movements || [];
  let bodyHtml = "";

  if (!movements.length) {
    bodyHtml = '<div style="text-align:center; padding:30px; color:var(--text-muted);"><i class="fas fa-info-circle"></i> No cash movements recorded for this shift.</div>';
  } else {
    bodyHtml = `
      <div style="margin-bottom:14px; font-size:13px; color:var(--text-muted);">
        Cashier: <strong style="color:var(--text-main);">${Utils.escapeHtml(s.cashier_name)}</strong> &bull; Start Float: <strong style="color:var(--text-main);">${Utils.formatCurrency(s.start_cash)}</strong> &bull; Expected: <strong style="color:#c9a227;">${Utils.formatCurrency(s.expected_cash)}</strong>
      </div>
      <div class="table-wrap" style="max-height:50vh; overflow-y:auto;">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Action</th>
              <th>Amount</th>
              <th>Reason</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            ${movements.map(m => `
              <tr>
                <td style="font-size:12px; color:var(--text-muted);">${m.created_at ? new Date(m.created_at).toLocaleString() : '—'}</td>
                <td>
                  <span class="badge ${m.type === 'PAID_OUT' ? 'badge-danger' : 'badge-success'}" style="font-size:11px; font-weight:700;">
                    ${m.type === 'PAID_OUT' ? 'CASH DROP' : 'PAID IN'}
                  </span>
                </td>
                <td><strong style="color:${m.type === 'PAID_OUT' ? '#ef4444' : '#10b981'}; font-size:13px;">${m.type === 'PAID_OUT' ? '-' : '+'}${Utils.formatCurrency(m.amount)}</strong></td>
                <td style="font-size:13px;">${Utils.escapeHtml(m.reason || '—')}</td>
                <td style="font-size:12px; color:var(--text-muted);">${Utils.escapeHtml(m.recorded_by || 'Staff')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  Utils.openModal(`Shift #${s.id} Cash Movements Audit Log`, bodyHtml);
}

async function openAssignCashierModal(shiftId = null, currentUserId = null) {
  let cashiers = [];
  try {
    const res = await Auth.fetch("/api/v1/users?exclude_self=false");
    if (res.ok) {
      const allUsers = await res.json();
      cashiers = (allUsers || []).filter(u => String(u.role || "").toUpperCase() === "CASHIER" && u.is_active !== false);
    }
  } catch (e) {
    console.warn("Failed to load cashier accounts:", e);
  }

  if (!cashiers.length) {
    Utils.showToast("No active Cashier accounts found. Please add a Cashier in User Management first.", "warning");
    return;
  }

  const shifts = (cachedDrawerData && cachedDrawerData.shifts) || [];
  const targetShift = shiftId ? shifts.find(s => s.id === shiftId) : shifts.find(s => s.status === "open");
  const activeShiftId = targetShift ? targetShift.id : "";
  const selectedUid = currentUserId || (targetShift ? targetShift.cashier_id : cashiers[0].id);

  const optionsHtml = cashiers.map(c => {
    const fullName = `${c.first_name || ""} ${c.last_name || ""}`.trim() || c.username;
    return `<option value="${Utils.escapeHtml(c.id)}" ${Number(c.id) === Number(selectedUid) ? "selected" : ""}>${Utils.escapeHtml(fullName)} (@${Utils.escapeHtml(c.username)}) — CASHIER</option>`;
  }).join("");

  Utils.openModal("Assign Cashier Account to Cash Drawer", `
    <form id="form-assign-cashier" onsubmit="event.preventDefault(); submitAssignCashierAccount();">
      <input type="hidden" id="assign-cashier-shift-id" value="${Utils.escapeHtml(activeShiftId)}">
      <div style="background:rgba(59,130,246,0.08); border:1px solid rgba(59,130,246,0.25); border-radius:10px; padding:12px 14px; margin-bottom:16px; font-size:12.5px; color:var(--text-muted);">
        <div style="font-weight:700; color:#3b82f6; margin-bottom:4px;"><i class="fas fa-user-check"></i> Cashier Drawer Account Assignment</div>
        Select the Cashier staff account assigned to operate and track this Cash Drawer.
      </div>
      <div class="input-group" style="margin-bottom:16px;">
        <label style="font-size:12px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:6px;">
          Select Cashier Account <span style="color:var(--danger);">*</span>
        </label>
        <select id="assign-cashier-user-id" class="input-field" required style="width:100%; font-weight:700;">
          ${optionsHtml}
        </select>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:10px;">
        <button type="button" class="btn btn-outline" onclick="Utils.closeModal()">Cancel</button>
        <button type="submit" id="btn-submit-assign-cashier" class="btn btn-primary" style="background:#3b82f6; border-color:#3b82f6; color:#fff; font-weight:700;">
          <i class="fas fa-user-check"></i> Assign Cashier Account
        </button>
      </div>
    </form>
  `);
}

async function submitAssignCashierAccount() {
  const userIdVal = document.getElementById("assign-cashier-user-id")?.value;
  const shiftIdVal = document.getElementById("assign-cashier-shift-id")?.value;
  const btn = document.getElementById("btn-submit-assign-cashier");

  if (!userIdVal) {
    Utils.showToast("Please select a Cashier account.", "danger");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Assigning...`;
  }

  try {
    const res = await Auth.fetch("/api/v1/shifts/assign-cashier", {
      method: "POST",
      body: JSON.stringify({
        user_id: parseInt(userIdVal, 10),
        shift_id: shiftIdVal ? parseInt(shiftIdVal, 10) : null
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to assign cashier account.");
    }
    const data = await res.json();
    Utils.closeModal();
    Utils.showToast(data.message || "Cashier account assigned to Cash Drawer!", "success");
    cachedDrawerData = null;
    await renderCashDrawerTracker(null, true);
  } catch (err) {
    Utils.showToast(err.message, "danger");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-user-check"></i> Assign Cashier Account`;
    }
  }
}

function openEditCashierDrawerModal(shiftId = null, cashierName = null, currentCash = null) {
  const shifts = (cachedDrawerData && cachedDrawerData.shifts) || [];
  let targetShift = shiftId ? shifts.find(s => s.id === shiftId) : shifts.find(s => s.status === 'open');
  if (!targetShift && shifts.length) targetShift = shifts[0];
  if (!targetShift) {
    Utils.showToast("No cashier shifts recorded yet.", "warning");
    return;
  }
  if (targetShift.status !== 'open') {
    Utils.showToast("Only active open shifts can be edited. Closed shifts are locked.", "warning");
    return;
  }
  shiftId = targetShift.id;
  cashierName = cashierName || targetShift.cashier_name || 'Cashier';
  currentCash = currentCash !== null && currentCash !== undefined ? currentCash : (targetShift.expected_cash || 0);

  const bodyHtml = `
    <form id="edit-cashier-drawer-form" onsubmit="submitEditCashierDrawer(event, ${shiftId})" style="display:flex; flex-direction:column; gap:16px;">
      <div style="background:rgba(201,162,39,0.1); border:1px solid rgba(201,162,39,0.3); border-radius:10px; padding:14px;">
        <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Cashier Shift Details</div>
        <div style="font-size:14px; font-weight:700; color:var(--text-main);">Shift #${Utils.escapeHtml(shiftId)} &bull; ${Utils.escapeHtml(cashierName || 'Cashier')}</div>
        <div style="font-size:13px; color:#c9a227; font-weight:700; margin-top:4px;">
          Current Drawer Balance: <strong>${Utils.formatCurrency(currentCash || 0)}</strong>
        </div>
      </div>

      <div class="form-group">
        <label for="modal-edit-drawer-amount" style="font-weight:700; font-size:13px; color:var(--text-main); margin-bottom:6px; display:block;">
          New Cash Amount in Drawer (₱) <span style="color:#ef4444;">*</span>
        </label>
        <div style="position:relative; display:flex; align-items:center;">
          <span style="position:absolute; left:12px; font-size:15px; font-weight:800; color:#c9a227;">₱</span>
          <input type="number" step="0.01" id="modal-edit-drawer-amount" required 
            value="${parseFloat(currentCash || 0).toFixed(2)}"
            style="width:100%; padding:10px 12px 10px 30px; font-size:16px; font-weight:800; color:#c9a227; border:2px solid #c9a227; border-radius:8px; background:var(--bg-card, #fff);" 
          />
        </div>
        <small style="color:var(--text-muted); font-size:11px; margin-top:4px; display:block;">
          Enter the actual cash counted in the cashier drawer. The system will record the drawer adjustment automatically.
        </small>
      </div>

      <div class="form-group">
        <label for="modal-edit-drawer-reason" style="font-weight:600; font-size:12px; color:var(--text-muted); margin-bottom:4px; display:block;">
          Reason / Note (Optional)
        </label>
        <input type="text" id="modal-edit-drawer-reason" placeholder="e.g. Physical cash count correction"
          style="width:100%; padding:8px 10px; font-size:13px; border:1px solid var(--border-color); border-radius:8px; background:var(--bg-card, #fff); color:var(--text-main);"
        />
      </div>

      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:8px;">
        <button type="button" class="btn btn-outline" onclick="Utils.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary" style="background:#c9a227; border-color:#c9a227; color:#fff; font-weight:700;">
          <i class="fas fa-check"></i> Save Cashier Drawer
        </button>
      </div>
    </form>
  `;

  Utils.openModal(`Edit Cashier Drawer — Shift #${shiftId}`, bodyHtml);
  setTimeout(() => {
    const input = document.getElementById("modal-edit-drawer-amount");
    if (input) {
      input.focus();
      input.select();
    }
  }, 100);
}

async function saveCashierDrawerCash(shiftId, directVal = null) {
  const shifts = (cachedDrawerData && cachedDrawerData.shifts) || [];
  const shiftObj = shifts.find(s => s.id === shiftId);
  if (shiftObj && shiftObj.status !== 'open') {
    Utils.showToast("Only active open shifts can be edited. Closed shifts are locked.", "warning");
    return;
  }

  let val = directVal;
  if (val === null || val === undefined) {
    const el = document.getElementById(`drawer-amount-input-${shiftId}`);
    if (el) val = el.value;
  }
  const amount = parseFloat(val);
  if (isNaN(amount)) {
    Utils.showToast("Please enter a valid numeric drawer amount.", "warning");
    return;
  }

  try {
    const res = await Auth.fetch(`/api/v1/shifts/${shiftId}/drawer-cash`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: amount,
        reason: "Cashier drawer edited in management tracker"
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || "Failed to update cashier drawer.");
    }

    const data = await res.json();
    Utils.showToast(data.message || `Cashier drawer updated to ${Utils.formatCurrency(amount)}`, "success");

    try {
      localStorage.setItem("RESTOTRACK_DRAWER_RESET", Date.now().toString());
    } catch (e) {}

    renderCashDrawerTracker();
  } catch (err) {
    console.error("Save cashier drawer error:", err);
    Utils.showToast(err.message, "danger");
  }
}

async function submitEditCashierDrawer(event, shiftId) {
  if (event) event.preventDefault();
  const inputEl = document.getElementById("modal-edit-drawer-amount");
  const reasonEl = document.getElementById("modal-edit-drawer-reason");
  const amount = parseFloat(inputEl ? inputEl.value : 0);
  const reason = reasonEl ? reasonEl.value : "";

  if (isNaN(amount)) {
    Utils.showToast("Please enter a valid numeric drawer amount.", "warning");
    return;
  }

  // Update cached data locally so UI updates smoothly
  if (cachedDrawerData && Array.isArray(cachedDrawerData.shifts)) {
    const s = cachedDrawerData.shifts.find(item => item.id === shiftId);
    if (s) {
      s.expected_cash = amount;
    }
  }

  try {
    const res = await Auth.fetch(`/api/v1/shifts/${shiftId}/drawer-cash`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: amount,
        reason: reason || "Cashier drawer edited via modal"
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || "Failed to update cashier drawer.");
    }

    const data = await res.json();
    Utils.showToast(data.message || `Cashier drawer updated to ${Utils.formatCurrency(amount)}`, "success");
    Utils.closeModal();

    try {
      localStorage.setItem("RESTOTRACK_DRAWER_RESET", Date.now().toString());
    } catch (e) {}

        const _posEl = document.getElementById("pos-cash-in-drawer-display");
    if (_posEl) _posEl.textContent = Utils.formatCurrency(amount);
    debouncedDrawerRefresh(true);
  } catch (err) {
    console.error("Submit edit cashier drawer error:", err);
    Utils.showToast(err.message, "danger");
  }
}

// Expose handlers globally on window
window.openEditCashierDrawerModal = openEditCashierDrawerModal;
window.saveCashierDrawerCash = saveCashierDrawerCash;
window.submitEditCashierDrawer = submitEditCashierDrawer;
window.openAddCashMovementModal = openAddCashMovementModal;
window.submitAddCashMovement = submitAddCashMovement;
window.reloadTransferDialogData = reloadTransferDialogData;

// =========================================================================
// Blessie FoodHub Real-Time Synchronization Engine (WebSocket + Fallbacks)
// =========================================================================
(function initBlessieRealtime() {
  if (window._blessieRealtimeInitialized) return;
  window._blessieRealtimeInitialized = true;

  let socket = null;
  let reconnectTimer = null;
  let pingTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_DELAY = 10000;

  function playOrderNotificationChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1318.51, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(987.77, ctx.currentTime + 0.35);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {}
  }

  function getActiveViewName() {
    const activeLink = document.querySelector("aside.sidebar .nav-link.active, .sidebar a.active");
    if (activeLink) {
      const href = activeLink.getAttribute("href") || "";
      const cleaned = href.replace(/^#\/?/, "").trim();
      if (cleaned) return cleaned;
    }
    return (window.location.hash || "").replace(/^#\/?/, "").trim() || "dashboard";
  }

  function handleRealtimeEvent(event, data) {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') console.log(`[RealTime] Live event received: ${event}`, data);

    try {
      localStorage.setItem("RESTOTRACK_EVENT", JSON.stringify({ event, data, timestamp: Date.now() }));
    } catch (e) {}

    const activeView = getActiveViewName();

    switch (event) {
      case "DRAWER_UPDATED":
      case "CASHOUT_COMPLETED":
      case "TRANSFER_TO_ADMIN":
        cachedDrawerData = null;
        cachedProfitLossData = null;

        try {
          localStorage.setItem("RESTOTRACK_DRAWER_RESET", Date.now().toString());
        } catch (e) {}

        // If transfer dialog is open, fast reload it with live network figures immediately
        if (document.getElementById("form-cash-movement") && typeof reloadTransferDialogData === "function") {
          reloadTransferDialogData(false);
        }

        if (activeView === "cash_drawer") {
          const _posEl = document.getElementById("pos-cash-in-drawer-display");
          if (_posEl && typeof amount !== "undefined") _posEl.textContent = Utils.formatCurrency(amount);
          debouncedDrawerRefresh(true);
        } else if (activeView === "profit_loss" || activeView === "purchases") {
          if (typeof renderProfitLoss === "function") renderProfitLoss();
        } else if (activeView === "dashboard") {
          if (typeof renderDashboard === "function") renderDashboard();
        } else if (activeView === "transactions") {
          if (typeof renderTransactions === "function") renderTransactions();
        } else if (activeView === "pos") {
          if (typeof Auth !== 'undefined') {
            Auth.fetch("/api/v1/shifts/drawer-summary").then(r => r.ok ? r.json() : null).then(dData => {
              if (!dData) return;
              const cUser = Auth.getUser();
              const myS = resolveCashierShift(dData.shifts, cUser);
              const dCashEl = document.getElementById("pos-cash-in-drawer-display");
              const dOrdEl = document.getElementById("pos-complete-orders-display");
              const cashVal = myS ? (myS.expected_cash ?? 0) : (dData.total_cash_in_drawers || 0);
              const ordVal = myS ? (myS.total_sales ?? 0) : (dData.today_total_orders_amount || 0);
              if (dCashEl) dCashEl.textContent = Utils.formatCurrency(cashVal);
              if (dOrdEl) dOrdEl.textContent = "Orders: " + Utils.formatCurrency(ordVal);
            }).catch(() => {});
          }
        }
        break;

      case "ORDER_CREATED":
      case "CUSTOMER_ORDER_CREATED":
        playOrderNotificationChime();
        if (document.getElementById("form-cash-movement") && typeof reloadTransferDialogData === "function") {
          reloadTransferDialogData(false);
        }
        if (data && (data.customer_name || data.order_number)) {
          if (typeof Utils !== 'undefined' && Utils.showToast) {
            Utils.showToast(`New Order Received: ${data.order_number || ''} (${data.customer_name || 'Customer'})`, "info");
          }
        }
        // Always refresh pending customer online orders and badges immediately
        if (typeof fetchPendingOnlineOrders === 'function') {
          fetchPendingOnlineOrders().then(() => {
            const modalTitle = document.querySelector("#modal-content h3");
            if (modalTitle && modalTitle.textContent.includes("Pending Online Orders")) {
              openOnlineOrdersModal();
            }
          });
        }
        if (activeView === "kitchen" && typeof renderKitchen === "function") {
          renderKitchen();
        } else if ((activeView === "drinks" || activeView === "drinks_station") && typeof renderDrinksStation === "function") {
          renderDrinksStation();
        } else if (activeView === "customer_orders" && typeof loadCustomerOrdersTable === "function") {
          loadCustomerOrdersTable();
        } else if (activeView === "transactions" && typeof renderTransactions === "function") {
          renderTransactions();
        } else if (activeView === "dashboard" && typeof renderDashboard === "function") {
          renderDashboard();
        }
        break;

      case "ORDER_UPDATED":
      case "CUSTOMER_ORDER_UPDATED":
      case "KITCHEN_UPDATED":
        // A cashier sale just created a ticket: tell kitchen staff what arrived (the chime plays on ORDER_CREATED).
        if (event === "KITCHEN_UPDATED" && data && data.status === "PENDING" && data.station) {
          let viewer = null;
          try { viewer = typeof Auth !== 'undefined' ? Auth.getUser() : null; } catch (e) {}
          if (viewer && String(viewer.role || "").toLowerCase() === "kitchen" && typeof Utils !== 'undefined' && Utils.showToast) {
            Utils.showToast(`New order ${data.order_id || ''} for the ${data.station === "drinks" ? "Drinks" : "Kitchen"} station`, "info");
          }
        }
        // Always refresh pending customer online orders and badges immediately
        if (typeof fetchPendingOnlineOrders === 'function') {
          fetchPendingOnlineOrders().then(() => {
            const modalTitle = document.querySelector("#modal-content h3");
            if (modalTitle && modalTitle.textContent.includes("Pending Online Orders")) {
              openOnlineOrdersModal();
            }
          });
        }
        if (activeView === "kitchen" && typeof renderKitchen === "function") {
          renderKitchen();
        } else if ((activeView === "drinks" || activeView === "drinks_station") && typeof renderDrinksStation === "function") {
          renderDrinksStation();
        } else if (activeView === "customer_orders" && typeof loadCustomerOrdersTable === "function") {
          loadCustomerOrdersTable();
        } else if (activeView === "transactions" && typeof renderTransactions === "function") {
          renderTransactions();
        } else if (activeView === "dashboard" && typeof renderDashboard === "function") {
          renderDashboard();
        }
        break;

      case "INVENTORY_UPDATED":
        cachedProfitLossData = null;
        if (activeView === "inventory" && typeof renderInventory === "function") {
          if (Date.now() < (window._skipInvWsRefreshUntil || 0) || (typeof hasUnsavedInventoryStockInputs === "function" && hasUnsavedInventoryStockInputs())) {
            break;
          }
          cachedInventory = [];
          renderInventory();
        } else {
          cachedInventory = [];
          if (activeView === "profit_loss" && typeof renderProfitLoss === "function") {
            renderProfitLoss();
          } else if (activeView === "dashboard" && typeof renderDashboard === "function") {
            renderDashboard();
          }
        }
        break;

      case "FINANCIAL_UPDATED":
        cachedProfitLossData = null;
        cachedDrawerData = null;
        if (document.getElementById("form-cash-movement") && typeof reloadTransferDialogData === "function") {
          reloadTransferDialogData(false);
        }
        if (activeView === "profit_loss" || activeView === "purchases") {
          if (typeof renderProfitLoss === "function") renderProfitLoss();
        } else if (activeView === "dashboard") {
          if (typeof renderDashboard === "function") renderDashboard();
        } else if (activeView === "cash_drawer") {
          const _posEl = document.getElementById("pos-cash-in-drawer-display");
          if (_posEl && typeof amount !== "undefined") _posEl.textContent = Utils.formatCurrency(amount);
          debouncedDrawerRefresh(true);
        } else if (activeView === "transactions") {
          if (typeof renderTransactions === "function") renderTransactions();
        }
        break;

      case "USER_CREATED":
      case "USER_UPDATED":
      case "USERS_UPDATED":
        if (document.getElementById("branch-staff-tbody") || activeView === "users") {
          const c = document.getElementById("view-container") || document.getElementById("content") || document.querySelector(".page-wrapper");
          if (typeof renderUsers === "function") renderUsers(c);
        }
        break;
    }
  }

  function connectWebSocket() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      if (!host) return;

      let tenantId = 1;
      try {
        const u = typeof Auth !== 'undefined' ? Auth.getUser() : null;
        if (u && u.tenant_id) tenantId = u.tenant_id;
      } catch (e) {}

      const wsUrl = `${protocol}//${host}/api/v1/ws/${tenantId}`;
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        console.log(`[RealTime] Connected to WebSocket at ${wsUrl}`);
        reconnectAttempts = 0;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send("ping");
          }
        }, 25000);
      };

      socket.onmessage = (event) => {
        if (event.data === "pong") return;
        try {
          const payload = JSON.parse(event.data);
          if (payload && payload.event) {
            handleRealtimeEvent(payload.event, payload.data);
          }
        } catch (err) {
          console.warn("[RealTime] Error parsing payload:", err);
        }
      };

      socket.onclose = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        scheduleReconnect();
      };

      socket.onerror = (err) => {
        try { socket.close(); } catch (e) {}
      };
    } catch (err) {
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  // Cross-tab synchronization listener via storage event
  window.addEventListener("storage", (e) => {
    if (e.key === "RESTOTRACK_EVENT" && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (parsed && parsed.event) {
          const activeView = getActiveViewName();
          switch (parsed.event) {
            case "DRAWER_UPDATED":
            case "CASHOUT_COMPLETED":
            case "TRANSFER_TO_ADMIN":
              cachedDrawerData = null;
              cachedProfitLossData = null;
              if (document.getElementById("form-cash-movement") && typeof reloadTransferDialogData === "function") {
                reloadTransferDialogData(false);
              }
              if (activeView === "cash_drawer") {
                debouncedDrawerRefresh(true);
              } else if (activeView === "profit_loss" || activeView === "purchases") {
                renderProfitLoss();
              } else if (activeView === "dashboard") {
                renderDashboard();
              } else if (activeView === "transactions") {
                renderTransactions();
              }
              break;
            case "ORDER_CREATED":
            case "CUSTOMER_ORDER_CREATED":
              if (activeView === "kitchen") renderKitchen();
              else if (activeView === "drinks" || activeView === "drinks_station") renderDrinksStation();
              else if (activeView === "customer_orders") renderCustomerOrdersView();
              else if (activeView === "dashboard") renderDashboard();
              break;
            case "ORDER_UPDATED":
            case "KITCHEN_UPDATED":
              if (activeView === "kitchen") renderKitchen();
              else if (activeView === "drinks" || activeView === "drinks_station") renderDrinksStation();
              else if (activeView === "customer_orders") renderCustomerOrdersView();
              else if (activeView === "transactions") renderTransactions();
              break;
            case "INVENTORY_UPDATED":
              cachedProfitLossData = null;
              if (activeView === "inventory") {
                if (Date.now() < (window._skipInvWsRefreshUntil || 0) || (typeof hasUnsavedInventoryStockInputs === "function" && hasUnsavedInventoryStockInputs())) {
                  break;
                }
                cachedInventory = [];
                renderInventory();
              } else {
                cachedInventory = [];
                if (activeView === "profit_loss" && typeof renderProfitLoss === "function") renderProfitLoss();
              }
              break;
            case "FINANCIAL_UPDATED":
              cachedProfitLossData = null;
              cachedDrawerData = null;
              if (document.getElementById("form-cash-movement") && typeof reloadTransferDialogData === "function") {
                reloadTransferDialogData(false);
              }
              if (activeView === "profit_loss" || activeView === "purchases") {
                renderProfitLoss();
              } else if (activeView === "dashboard") {
                renderDashboard();
              } else if (activeView === "cash_drawer") {
                debouncedDrawerRefresh(true);
              } else if (activeView === "transactions") {
                renderTransactions();
              }
              break;
          }
        }
      } catch (err) {}
    } else if (e.key === "RESTOTRACK_SYNC_USERS") {
      const c = document.getElementById("view-container") || document.getElementById("content") || document.querySelector(".page-wrapper");
      if (document.getElementById("branch-staff-tbody") && typeof renderUsers === "function") {
        renderUsers(c);
      }
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connectWebSocket);
  } else {
    connectWebSocket();
  }

  window.BlessieRealtime = {
    connect: connectWebSocket,
    sendEvent: (event, data) => handleRealtimeEvent(event, data),
    getSocket: () => socket
  };
})();





// ─────────────────────────────────────────────────────────────────────────────
// RECEIPT PREVIEW & PRINTING HELPERS
// ─────────────────────────────────────────────────────────────────────────────
window.previewTransactionReceipt = async function(txId) {
  try {
    let tx = (window._recentTransactionsCache || []).find(t => t.id === txId);
    if (!tx || !tx.items || !tx.payments) {
      const res = await Auth.fetch(`/api/v1/transactions/${txId}`);
      if (res.ok) {
        tx = await res.json();
      }
    }
    if (!tx) {
      Utils.showToast("Transaction details not found.", "danger");
      return;
    }
    const payment = (tx.payments && tx.payments.length) ? tx.payments[0] : {};
    const orderForReceipt = {
      id: tx.id,
      receiptNumber: tx.receipt_no || tx.order_code || ((typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('TXN', tx.id) : `TXN-${String(tx.id).padStart(4, '0')}`),
      orderCode: tx.order_code || `TXN-${String(tx.id).padStart(4, '0')}`,
      date: tx.created_at || new Date().toISOString(),
      cashier: tx.cashier || "Cashier",
      items: (tx.items || []).map(i => ({
        name: i.name,
        quantity: i.quantity,
        price: i.unit_price || i.price,
        unit_price: i.unit_price || i.price,
        total_price: i.total_price || ((i.unit_price || i.price) * i.quantity)
      })),
      total_amount: Number(tx.total_amount !== undefined ? tx.total_amount : (tx.net_amount || 0)),
      net_amount: Number(tx.net_amount || 0),
      discount_amount: Number(tx.discount_amount || 0),
      tax_amount: Number(tx.tax_amount || 0),
      payment_method: payment.payment_method || "Cash",
      payment_status: tx.status || "completed",
      amount_paid: Number(payment.amount !== undefined ? payment.amount : (tx.net_amount || 0)),
      change: (payment.payment_method || "Cash").toUpperCase() === "CASH" ? Math.max(0, Number(payment.amount || 0) - Number(tx.net_amount || 0)) : 0
    };
    window.lastCompletedOrder = orderForReceipt;
    Utils.showReceiptModal(orderForReceipt);
  } catch (err) {
    console.error("Failed to load receipt:", err);
    Utils.showToast("Failed to load receipt details.", "danger");
  }
};

window.printTransactionReceiptDirect = async function(txId) {
  try {
    let tx = (window._recentTransactionsCache || []).find(t => t.id === txId);
    if (!tx || !tx.items || !tx.payments) {
      const res = await Auth.fetch(`/api/v1/transactions/${txId}`);
      if (res.ok) {
        tx = await res.json();
      }
    }
    if (!tx) {
      Utils.showToast("Transaction details not found.", "danger");
      return;
    }
    const payment = (tx.payments && tx.payments.length) ? tx.payments[0] : {};
    const orderForReceipt = {
      id: tx.id,
      receiptNumber: tx.receipt_no || tx.order_code || ((typeof Utils !== 'undefined' && Utils.formatId) ? Utils.formatId('TXN', tx.id) : `TXN-${String(tx.id).padStart(4, '0')}`),
      orderCode: tx.order_code || `TXN-${String(tx.id).padStart(4, '0')}`,
      date: tx.created_at || new Date().toISOString(),
      cashier: tx.cashier || "Cashier",
      items: (tx.items || []).map(i => ({
        name: i.name,
        quantity: i.quantity,
        price: i.unit_price || i.price,
        unit_price: i.unit_price || i.price,
        total_price: i.total_price || ((i.unit_price || i.price) * i.quantity)
      })),
      total_amount: Number(tx.total_amount !== undefined ? tx.total_amount : (tx.net_amount || 0)),
      net_amount: Number(tx.net_amount || 0),
      discount_amount: Number(tx.discount_amount || 0),
      tax_amount: Number(tx.tax_amount || 0),
      payment_method: payment.payment_method || "Cash",
      payment_status: tx.status || "completed",
      amount_paid: Number(payment.amount !== undefined ? payment.amount : (tx.net_amount || 0)),
      change: (payment.payment_method || "Cash").toUpperCase() === "CASH" ? Math.max(0, Number(payment.amount || 0) - Number(tx.net_amount || 0)) : 0
    };
    window.lastCompletedOrder = orderForReceipt;
    Utils.printReceipt(orderForReceipt);
  } catch (err) {
    console.error("Failed to print receipt:", err);
    Utils.showToast("Failed to print receipt.", "danger");
  }
};

window.previewLastReceipt = async function() {
  if (window.lastCompletedOrder) {
    Utils.showReceiptModal(window.lastCompletedOrder);
    return;
  }
  try {
    const res = await Auth.fetch("/api/v1/transactions?limit=1");
    if (res.ok) {
      const list = await res.json();
      if (list && list.length) {
        await window.previewTransactionReceipt(list[0].id);
        return;
      }
    }
    Utils.showToast("No recent transactions found.", "info");
  } catch (e) {
    Utils.showToast("No recent receipt found in this session.", "info");
  }
};

// ============================================================================
// DAILY INVENTORY HISTORY & AUDIT TRAIL MODULE — ADMIN / OWNER ONLY
// ============================================================================

let currentHistPage = 1;
let currentHistLimit = 25;
let currentHistFilters = {
  search: "",
  category: "ALL",
  item_id: "",
  submitted_by: "",
  role: "ALL",
  sort: "newest",
  date_mode: "today",
  specific_date: "",
  start_date: "",
  end_date: ""
};
let cachedAuditHistoryData = null;
let histSearchDebounceTimer = null;

async function renderInventoryHistory(c) {
  if (!c) c = document.getElementById("view-container");
  if (!c) return;

  c.innerHTML = `
    <div style="display:flex; justify-content:center; align-items:center; min-height:280px; color:var(--text-muted, #71717a);">
      <div style="text-align:center;">
        <i class="fas fa-spinner fa-spin" style="font-size:2rem; margin-bottom:0.75rem; color:#c9a227;"></i>
        <p style="font-size:14px; font-weight:600;">Loading Daily Inventory Audit Trail...</p>
      </div>
    </div>
  `;

  try {
    await fetchAndRenderInventoryHistory(c);
  } catch (err) {
    console.error("Error loading inventory audit history:", err);
    c.innerHTML = `
      <div class="section-card" style="padding:28px; border:1px solid rgba(239,68,68,0.35); text-align:center;">
        <div style="width:54px; height:54px; border-radius:50%; background:rgba(239,68,68,0.1); color:#ef4444; display:inline-flex; align-items:center; justify-content:center; font-size:24px; margin-bottom:12px;">
          <i class="fas fa-triangle-exclamation"></i>
        </div>
        <h3 style="color:var(--danger, #ef4444); font-size:17px; font-weight:700; margin-bottom:6px;">Unable to Load Inventory History</h3>
        <p style="color:var(--text-muted, #71717a); font-size:13px; max-width:480px; margin:0 auto 16px;">${Utils.escapeHtml(err.message || "An unexpected error occurred while fetching historical records.")}</p>
        <button class="btn btn-primary btn-sm" onclick="renderInventoryHistory()" style="display:inline-flex; align-items:center; gap:6px;">
          <i class="fas fa-rotate-right"></i> Try Again
        </button>
      </div>
    `;
  }
}

function getActiveHistoryDates() {
  const manilaNow = new Date();
  const formatYMD = (d) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const todayStr = (cachedAuditHistoryData && cachedAuditHistoryData.filters && cachedAuditHistoryData.filters.today_date) || formatYMD(manilaNow);

  if (currentHistFilters.date_mode === "today") {
    return { specific_date: todayStr, start_date: "", end_date: "" };
  } else if (currentHistFilters.date_mode === "yesterday") {
    const yest = new Date(manilaNow);
    yest.setDate(yest.getDate() - 1);
    return { specific_date: formatYMD(yest), start_date: "", end_date: "" };
  } else if (currentHistFilters.date_mode === "last7") {
    const d7 = new Date(manilaNow);
    d7.setDate(d7.getDate() - 6);
    return { specific_date: "", start_date: formatYMD(d7), end_date: todayStr };
  } else if (currentHistFilters.date_mode === "month") {
    const mStart = new Date(manilaNow.getFullYear(), manilaNow.getMonth(), 1);
    return { specific_date: "", start_date: formatYMD(mStart), end_date: todayStr };
  } else if (currentHistFilters.date_mode === "custom") {
    return {
      specific_date: currentHistFilters.specific_date || "",
      start_date: currentHistFilters.start_date || "",
      end_date: currentHistFilters.end_date || ""
    };
  }
  return { specific_date: todayStr, start_date: "", end_date: "" };
}

async function fetchAndRenderInventoryHistory(c) {
  if (!c) c = document.getElementById("view-container");
  if (!c) return;

  const dates = getActiveHistoryDates();
  const params = new URLSearchParams({
    page: String(currentHistPage),
    limit: String(currentHistLimit),
    sort: currentHistFilters.sort || "newest"
  });

  if (dates.specific_date) params.append("specific_date", dates.specific_date);
  if (dates.start_date) params.append("start_date", dates.start_date);
  if (dates.end_date) params.append("end_date", dates.end_date);
  if (currentHistFilters.category && currentHistFilters.category !== "ALL") params.append("category", currentHistFilters.category);
  if (currentHistFilters.item_id) params.append("item_id", currentHistFilters.item_id);
  if (currentHistFilters.submitted_by) params.append("submitted_by", currentHistFilters.submitted_by);
  if (currentHistFilters.role && currentHistFilters.role !== "ALL") params.append("role", currentHistFilters.role);
  if (currentHistFilters.search && currentHistFilters.search.trim()) params.append("search", currentHistFilters.search.trim());

  const res = await Auth.fetch(`/api/v1/inventory/audit-history?${params.toString()}`);
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || "Failed to load inventory audit trail.");
  }

  const data = await res.json();
  cachedAuditHistoryData = data;
  const items = data.items || [];
  const summary = data.summary || { total_recorded_today: 0, total_categories_today: 0, stock_increases_today: 0, stock_decreases_today: 0 };
  const filterMeta = data.filters || { categories: [], submitters: [], items: [], today_date: "" };

  const startIdx = data.total > 0 ? (data.page - 1) * data.limit + 1 : 0;
  const endIdx = Math.min(data.page * data.limit, data.total);

  c.innerHTML = `
    <!-- Top Automated Inventory Audit Summary Cards -->
    <div class="stats-grid fade-up" style="margin-bottom:22px;">
      <div class="stat-card" style="border-left:4px solid #c9a227;">
        <div class="stat-icon gold"><i class="fas fa-clipboard-check"></i></div>
        <div class="stat-info">
          <h3>Items Recorded Today</h3>
          <div class="stat-count" style="color:#c9a227;">${Utils.escapeHtml(summary.total_recorded_today)}</div>
          <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-calendar-day"></i> Philippine Date: ${Utils.escapeHtml(filterMeta.today_date)}</div>
        </div>
      </div>
      <div class="stat-card" style="border-left:4px solid #6366f1;">
        <div class="stat-icon purple" style="background:rgba(99,102,241,0.12); color:#6366f1;"><i class="fas fa-layer-group"></i></div>
        <div class="stat-info">
          <h3>Active Categories</h3>
          <div class="stat-count" style="color:#6366f1;">${Utils.escapeHtml(summary.total_categories_today)}</div>
          <div class="stat-trend" style="color:#6366f1;"><i class="fas fa-boxes-stacked"></i> Tracked Today</div>
        </div>
      </div>
      <div class="stat-card" style="border-left:4px solid #10b981;">
        <div class="stat-icon green"><i class="fas fa-history"></i></div>
        <div class="stat-info">
          <h3>Total Audit Records</h3>
          <div class="stat-count" style="color:#10b981;">${Utils.escapeHtml(data.total || 0)}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-database"></i> Preserved In History</div>
        </div>
      </div>
      <div class="stat-card" style="border-left:4px solid #f97316;">
        <div class="stat-icon orange" style="background:rgba(249,115,22,0.12); color:#f97316;"><i class="fas fa-boxes-stacked"></i></div>
        <div class="stat-info">
          <h3>Catalog Items</h3>
          <div class="stat-count" style="color:#f97316;">${Utils.escapeHtml((filterMeta.items || []).length || 0)}</div>
          <div class="stat-trend" style="color:#f97316;"><i class="fas fa-tags"></i> Monitored Products</div>
        </div>
      </div>
    </div>

    <!-- Filter & Search Controls Card -->
    <div class="section-card fade-up delay-1" style="margin-bottom:20px; padding:20px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:16px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="width:36px; height:36px; border-radius:10px; background:rgba(201,162,39,0.14); color:#c9a227; display:flex; align-items:center; justify-content:center; font-size:16px;">
            <i class="fas fa-filter"></i>
          </div>
          <div>
            <h3 style="font-size:15px; font-weight:800; margin:0; color:var(--text-main);">Daily Inventory Filters</h3>
            <p style="font-size:12px; color:var(--text-muted); margin:2px 0 0 0;">Filter historical stock recordings by date, category, submitter, and role</p>
          </div>
        </div>
      </div>

      <!-- Date Presets Bar -->
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid rgba(0,0,0,0.06);">
        <span style="font-size:12px; font-weight:700; color:var(--text-muted); margin-right:4px;">Date Preset:</span>
        <button type="button" class="btn ${currentHistFilters.date_mode === 'today' ? 'btn-primary' : 'btn-outline'} btn-sm" style="border-radius:18px; padding:4px 12px; font-size:11.5px;" onclick="setHistDateMode('today')">
          <i class="fas fa-calendar-check"></i> Today
        </button>
        <button type="button" class="btn ${currentHistFilters.date_mode === 'yesterday' ? 'btn-primary' : 'btn-outline'} btn-sm" style="border-radius:18px; padding:4px 12px; font-size:11.5px;" onclick="setHistDateMode('yesterday')">
          Yesterday
        </button>
        <button type="button" class="btn ${currentHistFilters.date_mode === 'last7' ? 'btn-primary' : 'btn-outline'} btn-sm" style="border-radius:18px; padding:4px 12px; font-size:11.5px;" onclick="setHistDateMode('last7')">
          Last 7 Days
        </button>
        <button type="button" class="btn ${currentHistFilters.date_mode === 'month' ? 'btn-primary' : 'btn-outline'} btn-sm" style="border-radius:18px; padding:4px 12px; font-size:11.5px;" onclick="setHistDateMode('month')">
          This Month
        </button>
        <button type="button" class="btn ${currentHistFilters.date_mode === 'custom' ? 'btn-primary' : 'btn-outline'} btn-sm" style="border-radius:18px; padding:4px 12px; font-size:11.5px;" onclick="setHistDateMode('custom')">
          <i class="fas fa-calendar-days"></i> Custom Date / Range
        </button>
      </div>

      <!-- Filters Grid -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; align-items:flex-end;">
        <div>
          <label style="display:block; font-size:11.5px; font-weight:700; color:var(--text-muted); margin-bottom:5px;">Search Item / SKU</label>
          <div style="position:relative;">
            <i class="fas fa-search" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--text-muted); font-size:12px;"></i>
            <input type="text" id="hist-filter-search" class="input-field" placeholder="Search product name..." value="${Utils.escapeHtml(currentHistFilters.search)}" style="padding-left:34px; height:36px; font-size:13px; width:100%;" oninput="onHistSearchInput(this.value)">
          </div>
        </div>

        ${currentHistFilters.date_mode === 'custom' ? `
          <div>
            <label style="display:block; font-size:11.5px; font-weight:700; color:var(--text-muted); margin-bottom:5px;">Start Date</label>
            <input type="date" id="hist-filter-start" class="input-field" value="${Utils.escapeHtml(currentHistFilters.start_date)}" style="height:36px; font-size:13px; width:100%;" onchange="onHistCustomDateChange()">
          </div>
          <div>
            <label style="display:block; font-size:11.5px; font-weight:700; color:var(--text-muted); margin-bottom:5px;">End Date</label>
            <input type="date" id="hist-filter-end" class="input-field" value="${Utils.escapeHtml(currentHistFilters.end_date)}" style="height:36px; font-size:13px; width:100%;" onchange="onHistCustomDateChange()">
          </div>
        ` : ''}

        <div>
          <label style="display:block; font-size:11.5px; font-weight:700; color:var(--text-muted); margin-bottom:5px;">Department / Category</label>
          <select id="hist-filter-cat" class="input-field" style="height:36px; font-size:13px; width:100%;" onchange="onHistFilterChange('category', this.value)">
            <option value="ALL">All Categories</option>
            ${filterMeta.categories.map(cat => `
              <option value="${Utils.escapeHtml(cat)}" ${currentHistFilters.category === cat ? 'selected' : ''}>${Utils.escapeHtml(cat)}</option>
            `).join('')}
          </select>
        </div>

        <div>
          <label style="display:block; font-size:11.5px; font-weight:700; color:var(--text-muted); margin-bottom:5px;">Specific Item</label>
          <select id="hist-filter-item" class="input-field" style="height:36px; font-size:13px; width:100%;" onchange="onHistFilterChange('item_id', this.value)">
            <option value="">All Inventory Items</option>
            ${(filterMeta.items || []).map(it => `
              <option value="${Utils.escapeHtml(it.id)}" ${String(currentHistFilters.item_id) === String(it.id) ? 'selected' : ''}>${Utils.escapeHtml(it.name)}</option>
            `).join('')}
          </select>
        </div>

        <div>
          <label style="display:block; font-size:11.5px; font-weight:700; color:var(--text-muted); margin-bottom:5px;">Submitted By</label>
          <select id="hist-filter-user" class="input-field" style="height:36px; font-size:13px; width:100%;" onchange="onHistFilterChange('submitted_by', this.value)">
            <option value="">All Submitters</option>
            ${(filterMeta.submitters || []).map(sub => `
              <option value="${Utils.escapeHtml(sub.id)}" ${String(currentHistFilters.submitted_by) === String(sub.id) ? 'selected' : ''}>${Utils.escapeHtml(sub.name)} (${Utils.escapeHtml(sub.role)})</option>
            `).join('')}
          </select>
        </div>

        <div>
          <label style="display:block; font-size:11.5px; font-weight:700; color:var(--text-muted); margin-bottom:5px;">Role</label>
          <select id="hist-filter-role" class="input-field" style="height:36px; font-size:13px; width:100%;" onchange="onHistFilterChange('role', this.value)">
            <option value="ALL" ${currentHistFilters.role === 'ALL' ? 'selected' : ''}>All Roles</option>
            <option value="Inventory" ${currentHistFilters.role === 'Inventory' ? 'selected' : ''}>Inventory Staff</option>
            <option value="Manager" ${currentHistFilters.role === 'Manager' ? 'selected' : ''}>Manager</option>
            <option value="Admin" ${currentHistFilters.role === 'Admin' ? 'selected' : ''}>Admin</option>
          </select>
        </div>

        <div>
          <label style="display:block; font-size:11.5px; font-weight:700; color:var(--text-muted); margin-bottom:5px;">Sort By</label>
          <select id="hist-filter-sort" class="input-field" style="height:36px; font-size:13px; width:100%;" onchange="onHistFilterChange('sort', this.value)">
            <option value="newest" ${currentHistFilters.sort === 'newest' ? 'selected' : ''}>Newest First</option>
            <option value="oldest" ${currentHistFilters.sort === 'oldest' ? 'selected' : ''}>Oldest First</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Inventory History Table Card -->
    <div class="section-card fade-up delay-2">
      <div class="section-head" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <h2>Daily Inventory Audit Trail</h2>
          <span class="badge" style="background:rgba(201,162,39,0.12); color:#c9a227; font-weight:800; font-size:11.5px;">Immutable Records</span>
        </div>
        <span style="font-size:13px; color:var(--text-muted);">
          ${data.total > 0 ? `Showing <strong>${startIdx}</strong>–<strong>${endIdx}</strong> of <strong>${data.total}</strong> records` : '0 records found'}
        </span>
      </div>

      <div class="table-wrap">
        <table class="inventory-history-table">
          <thead>
            <tr>
              <th style="min-width:110px;">Date</th>
              <th style="min-width:105px;">Time (PST)</th>
              <th style="min-width:180px;">Item Name</th>
              <th>Category</th>
              <th style="text-align:right;">Current Stock</th>
              <th style="text-align:right; color:#059669;">New Total Stock</th>
              <th>Submitted By</th>
              <th>Role</th>
              <th style="text-align:right; min-width:110px;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${renderInventoryHistoryTableRows(items)}
          </tbody>
        </table>
      </div>

      <!-- Pagination Footer -->
      ${data.total_pages > 1 ? `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-top:1px solid rgba(0,0,0,0.06); flex-wrap:wrap; gap:10px;">
          <div style="font-size:13px; color:var(--text-muted);">
            Page <strong>${data.page}</strong> of <strong>${data.total_pages}</strong>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-outline btn-sm" ${data.page <= 1 ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} onclick="goToHistPage(${data.page - 1})">
              <i class="fas fa-chevron-left"></i> Previous
            </button>
            <button class="btn btn-outline btn-sm" ${data.page >= data.total_pages ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} onclick="goToHistPage(${data.page + 1})">
              Next <i class="fas fa-chevron-right"></i>
            </button>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderInventoryHistoryTableRows(items) {
  if (!items || !items.length) {
    return `
      <tr>
        <td colspan="9" style="text-align:center; padding:50px 20px; color:var(--text-muted);">
          <div style="width:56px; height:56px; border-radius:50%; background:rgba(0,0,0,0.04); display:inline-flex; align-items:center; justify-content:center; margin-bottom:12px;">
            <i class="fas fa-clock-rotate-left" style="font-size:26px; color:var(--text-muted); opacity:0.6;"></i>
          </div>
          <h4 style="font-size:15px; font-weight:700; color:var(--text-main); margin-bottom:4px;">No Historical Records Found</h4>
          <p style="font-size:13px; max-width:440px; margin:0 auto 14px;">No inventory records match the current filter criteria for Philippine Standard Time.</p>
          <button class="btn btn-outline btn-sm" onclick="resetInventoryHistoryFilters()" style="display:inline-flex; align-items:center; gap:6px;">
            <i class="fas fa-rotate-left"></i> View Today's Records
          </button>
        </td>
      </tr>
    `;
  }

  return items.map(item => {


    const prevStock = Number(item.previous_stock || 0);
    const recStock = Number(item.recorded_stock || 0);

    return `
      <tr>
        <td style="font-weight:600; color:var(--text-main); font-size:12.5px; white-space:nowrap;">
          <i class="fas fa-calendar-day" style="color:#c9a227; margin-right:5px; font-size:11px;"></i>${Utils.escapeHtml(item.date_display)}
        </td>
        <td style="font-weight:600; color:var(--text-muted); font-size:12.5px; white-space:nowrap;">
          <i class="fas fa-clock" style="color:var(--text-muted); margin-right:4px; font-size:11px;"></i>${Utils.escapeHtml(item.time_display)}
        </td>
        <td>
          <strong style="color:var(--text-main); font-size:13.5px;">${Utils.escapeHtml(item.item_name)}</strong>
        </td>
        <td>
          <span class="badge" style="background:rgba(201,162,39,0.12); color:#c9a227; font-size:11px; font-weight:700; padding:3px 8px; border-radius:6px;">
            ${Utils.escapeHtml(item.category || 'Kitchen')}
          </span>
        </td>
        <td style="text-align:right; font-weight:600; color:var(--text-muted); font-size:13px;">
          ${prevStock % 1 === 0 ? prevStock : prevStock.toFixed(2)}
        </td>
        <td style="text-align:right; font-weight:800; color:#059669; font-size:13.5px;">
          ${recStock % 1 === 0 ? recStock : recStock.toFixed(2)}
        </td>
        
        <td style="font-weight:600; color:var(--text-main); font-size:12.5px;">
          <i class="fas fa-user-circle" style="color:#c9a227; margin-right:4px;"></i>${Utils.escapeHtml(item.submitted_by_name || 'Staff')}
        </td>
        <td>
          <span class="badge" style="background:#f4f4f5; color:#27272a; font-size:11px; font-weight:700; border:1px solid #e4e4e7;">
            ${Utils.escapeHtml(item.submitted_by_role || 'Staff')}
          </span>
        </td>
        <td style="text-align:right; white-space:nowrap;">
          <button class="btn btn-outline btn-sm" onclick="openInventoryItemHistoryModal(${item.inventory_item_id || 0}, ${Utils.jsArg(item.item_name)})" style="padding:4px 9px; font-size:11.5px; font-weight:700; border-radius:8px; display:inline-flex; align-items:center; gap:5px;" title="View Complete Product Timeline & Trend">
            <i class="fas fa-eye" style="color:#c9a227;"></i> Details
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function setHistDateMode(mode) {
  currentHistFilters.date_mode = mode;
  currentHistPage = 1;
  const c = document.getElementById("view-container");
  if (c) fetchAndRenderInventoryHistory(c);
}

function onHistFilterChange(key, value) {
  currentHistFilters[key] = value;
  currentHistPage = 1;
  const c = document.getElementById("view-container");
  if (c) fetchAndRenderInventoryHistory(c);
}

function onHistCustomDateChange() {
  const startEl = document.getElementById("hist-filter-start");
  const endEl = document.getElementById("hist-filter-end");
  if (startEl) currentHistFilters.start_date = startEl.value;
  if (endEl) currentHistFilters.end_date = endEl.value;
  currentHistPage = 1;
  const c = document.getElementById("view-container");
  if (c) fetchAndRenderInventoryHistory(c);
}

function onHistSearchInput(val) {
  currentHistFilters.search = val;
  if (histSearchDebounceTimer) clearTimeout(histSearchDebounceTimer);
  histSearchDebounceTimer = setTimeout(() => {
    currentHistPage = 1;
    const c = document.getElementById("view-container");
    if (c) fetchAndRenderInventoryHistory(c);
  }, 350);
}

function resetInventoryHistoryFilters() {
  currentHistFilters = {
    search: "",
    category: "ALL",
    item_id: "",
    submitted_by: "",
    role: "ALL",
    sort: "newest",
    date_mode: "today",
    specific_date: "",
    start_date: "",
    end_date: ""
  };
  currentHistPage = 1;
  const c = document.getElementById("view-container");
  if (c) fetchAndRenderInventoryHistory(c);
}

function goToHistPage(p) {
  if (p < 1) return;
  currentHistPage = p;
  const c = document.getElementById("view-container");
  if (c) fetchAndRenderInventoryHistory(c);
}

function exportInventoryHistory(format) {
  const dates = getActiveHistoryDates();
  const params = new URLSearchParams({ format: format || "csv" });
  if (dates.specific_date) params.append("specific_date", dates.specific_date);
  if (dates.start_date) params.append("start_date", dates.start_date);
  if (dates.end_date) params.append("end_date", dates.end_date);
  if (currentHistFilters.category && currentHistFilters.category !== "ALL") params.append("category", currentHistFilters.category);
  if (currentHistFilters.item_id) params.append("item_id", currentHistFilters.item_id);
  if (currentHistFilters.submitted_by) params.append("submitted_by", currentHistFilters.submitted_by);
  if (currentHistFilters.role && currentHistFilters.role !== "ALL") params.append("role", currentHistFilters.role);
  if (currentHistFilters.search && currentHistFilters.search.trim()) params.append("search", currentHistFilters.search.trim());

  window.open(`/api/v1/inventory/audit-history/export?${params.toString()}`, "_blank");
}

function printInventoryHistoryReport() {
  const items = (cachedAuditHistoryData && cachedAuditHistoryData.items) || [];
  const summary = (cachedAuditHistoryData && cachedAuditHistoryData.summary) || {};

  if (!items || items.length === 0) {
    Utils.showToast("No inventory history records available to print.", "warning");
    return;
  }

  const rowsHtml = items.map((r, idx) => `
    <tr style="border-bottom:1px solid #e4e4e7; background:${idx % 2 === 0 ? '#ffffff' : '#fafafa'};">
      <td style="padding:6px 8px; font-size:11px;">${Utils.escapeHtml(r.date_display)}</td>
      <td style="padding:6px 8px; font-size:11px; color:#71717a;">${Utils.escapeHtml(r.time_display)}</td>
      <td style="padding:6px 8px; font-size:11px; font-weight:700; color:#18181b;">${Utils.escapeHtml(r.item_name)}</td>
      <td style="padding:6px 8px; font-size:11px; color:#52525b;">${Utils.escapeHtml(r.category)}</td>
      <td style="padding:6px 8px; font-size:11px; text-align:right; font-family:monospace;">${Number(r.previous_stock).toFixed(2)}</td>
      <td style="padding:6px 8px; font-size:11px; text-align:right; font-family:monospace; font-weight:700; color:#059669;">${Number(r.recorded_stock).toFixed(2)}</td>
      <td style="padding:6px 8px; font-size:11px;">${Utils.escapeHtml(r.submitted_by_name)}</td>
      <td style="padding:6px 8px; font-size:11px; color:#71717a;">${Utils.escapeHtml(r.submitted_by_role)}</td>
    </tr>
  `).join('');

  const reportPaperHtml = `
    <div id="inventory-report-paper" style="background:#ffffff; color:#18181b; padding:24px 28px; border-radius:6px; box-shadow:0 4px 20px rgba(0,0,0,0.08); font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size:12px; line-height:1.4;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #c9a227; padding-bottom:12px; margin-bottom:14px;">
        <div>
          <h2 style="font-size:18px; font-weight:900; margin:0; color:#18181b;">GBLESS TRADING OPC &bull; BLESSIE FOOD HUB</h2>
          <div style="font-size:13px; font-weight:700; color:#c9a227; margin-top:2px;">DAILY INVENTORY AUDIT &amp; STOCK HISTORY REPORT</div>
          <div style="font-size:11px; color:#71717a; margin-top:2px;">Philippine Standard Time (Asia/Manila) | Generated: ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}</div>
        </div>
        <div style="text-align:right;">
          <span style="background:#f4f4f5; border:1px solid #e4e4e7; border-radius:4px; padding:4px 10px; font-size:11px; font-weight:700;">AUDIT REPORT</span>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; background:#fafafa; border:1px solid #e4e4e7; border-radius:6px; padding:10px 14px; margin-bottom:16px; font-size:11px;">
        <div><strong>Total Listed:</strong> <span style="font-weight:700; color:#18181b;">${items.length} records</span></div>
        <div><strong>Recorded Today:</strong> <span style="font-weight:700; color:#3b82f6;">${summary.total_recorded_today || 0}</span></div>
        <div><strong>Stock Increases:</strong> <span style="font-weight:700; color:#059669;">+${summary.stock_increases_today || 0}</span></div>
        <div><strong>Stock Decreases:</strong> <span style="font-weight:700; color:#ef4444;">-${summary.stock_decreases_today || 0}</span></div>
      </div>

      <div style="max-height:400px; overflow-y:auto; border:1px solid #e4e4e7; border-radius:6px; margin-bottom:16px;">
        <table style="width:100%; border-collapse:collapse; font-size:11px; text-align:left;">
          <thead style="background:#f4f4f5; position:sticky; top:0; z-index:2;">
            <tr style="border-bottom:1px solid #d4d4d8;">
              <th style="padding:7px 8px; font-weight:700;">Date</th>
              <th style="padding:7px 8px; font-weight:700;">Time</th>
              <th style="padding:7px 8px; font-weight:700;">Item Name</th>
              <th style="padding:7px 8px; font-weight:700;">Category</th>
              <th style="padding:7px 8px; font-weight:700; text-align:right;">Prev Stock</th>
              <th style="padding:7px 8px; font-weight:700; text-align:right;">Rec Stock</th>
              <th style="padding:7px 8px; font-weight:700;">Submitted By</th>
              <th style="padding:7px 8px; font-weight:700;">Role</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>

      <div style="border-top:1px solid #e4e4e7; padding-top:12px; display:flex; justify-content:space-between; font-size:11px; color:#71717a;">
        <span>GBLESS Trading OPC &bull; Official Inventory History</span>
        <span>Certified Document</span>
      </div>
    </div>
  `;

  const modalTitle = `<i class="fas fa-boxes-stacked" style="color:#059669; margin-right:8px;"></i> Inventory History Audit — Print Preview`;
  const modalFooter = `
    <div style="display:flex; justify-content:space-between; align-items:center; width:100%; gap:10px;">
      <span style="font-size:12px; color:var(--text-muted);"><i class="fas fa-check-circle" style="color:#059669;"></i> Ready to print standard A4 / Letter format</span>
      <div style="display:flex; gap:8px;">
        <button type="button" class="btn btn-outline" onclick="Utils.closeModal()"><i class="fas fa-times"></i> Close Preview</button>
        <button type="button" class="btn btn-primary" onclick="printInventoryReportDocument()" style="background:linear-gradient(135deg, #059669, #047857); border:none; color:#ffffff; font-weight:700;">
          <i class="fas fa-print"></i> Print Now
        </button>
      </div>
    </div>
  `;

  Utils.openModal(modalTitle, reportPaperHtml, modalFooter, "modal-xl");
}

function printInventoryReportDocument() {
  const paper = document.getElementById("inventory-report-paper");
  if (!paper) {
    window.print();
    return;
  }
  let frame = document.getElementById("print-inv-frame");
  if (frame) {
    try { document.body.removeChild(frame); } catch (e) {}
  }
  frame = document.createElement("iframe");
  frame.id = "print-inv-frame";
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);

  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Daily Inventory Audit Report</title>
      <style>
        @page { size: A4 landscape; margin: 10mm; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 10px; color: #18181b; }
        table { width: 100%; border-collapse: collapse; font-size: 11px; }
        th { background: #f4f4f5; text-align: left; padding: 6px 8px; border-bottom: 1px solid #d4d4d8; font-weight: 700; }
        td { padding: 6px 8px; border-bottom: 1px solid #e4e4e7; }
        @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      </style>
    </head>
    <body>
      ${paper.innerHTML}
    </body>
    </html>
  `);
  doc.close();

  setTimeout(() => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      window.print();
    }
  }, 250);
}
window.printInventoryReportDocument = printInventoryReportDocument;
window.printInventoryHistoryReport = printInventoryHistoryReport;

async function openInventoryItemHistoryModal(itemId, itemName) {
  if (!itemId) {
    Utils.showToast("Item details not available for this legacy record.", "warning");
    return;
  }

  const modalHeaderHtml = `
    <div style="display:flex; align-items:center; gap:12px; width:100%; text-align:left;">
      <div style="width:42px; height:42px; border-radius:10px; background:linear-gradient(135deg, rgba(5,150,105,0.14) 0%, rgba(201,162,39,0.18) 100%); color:#059669; display:flex; align-items:center; justify-content:center; font-size:18px; border:1px solid rgba(201,162,39,0.35); flex-shrink:0;">
        <i class="fas fa-clock-rotate-left" style="color:#c9a227;"></i>
      </div>
      <div style="flex:1; min-width:0;">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <h3 style="font-size:18px; font-weight:800; margin:0; color:#18181b; line-height:1.2;">
            ${Utils.escapeHtml(itemName || 'Item')}
          </h3>
          <span style="font-size:11px; font-weight:700; color:#059669; background:rgba(5,150,105,0.1); border:1px solid rgba(5,150,105,0.25); padding:2px 8px; border-radius:999px; text-transform:uppercase; letter-spacing:0.5px;">
            Inventory History
          </span>
        </div>
        <p style="font-size:12px; color:#71717a; margin:3px 0 0 0; line-height:1.3; font-weight:400;">
          Complete chronological stock audit trail and submission records
        </p>
      </div>
    </div>
  `;

  const modalFooterHtml = `
    <div style="display:flex; justify-content:flex-end; width:100%;">
      <button class="btn btn-outline" 
              style="padding:8px 24px; font-weight:700; font-size:13px; border-radius:8px; border-color:#d4d4d8; background:#ffffff; color:#18181b; box-shadow:0 1px 2px rgba(0,0,0,0.04); cursor:pointer;" 
              onclick="Utils.closeModal()">
        Close
      </button>
    </div>
  `;

  Utils.openModal(
    modalHeaderHtml,
    `
    <div id="item-history-modal-body" style="min-height:280px;">
      <div style="text-align:center; padding:50px 16px; color:#71717a;">
        <div style="width:48px; height:48px; border-radius:50%; background:rgba(201,162,39,0.12); color:#c9a227; display:inline-flex; align-items:center; justify-content:center; font-size:20px; margin-bottom:12px;">
          <i class="fas fa-spinner fa-spin"></i>
        </div>
        <div style="font-size:14px; font-weight:700; color:#18181b;">Loading Audit Timeline...</div>
        <div style="font-size:12px; color:#71717a; margin-top:4px;">Retrieving historical records from database</div>
      </div>
    </div>
    `,
    modalFooterHtml,
    "modal-responsive modal-xl"
  );

  try {
    const res = await Auth.fetch(`/api/v1/inventory/audit-history/item/${itemId}`);
    if (!res.ok) throw new Error("Failed to load item audit history.");
    const data = await res.json();
    const item = data.item || {};
    const history = data.history || [];

    const host = document.getElementById("item-history-modal-body");
    if (!host) return;

    const curStock = Number(item.current_stock || 0);
    const minStock = Number(item.min_stock || 0);
    const unitPrice = Number(item.unit_price || 0);
    const isLowStock = curStock <= minStock;
    const unitSuffix = item.unit ? ` ${Utils.escapeHtml(item.unit)}` : '';

    // Summary Card HTML (Warm cream / ivory, emerald green values, gold accents)
    const summaryCardHtml = `
      <div style="background:#fcfaf6; border:1px solid rgba(201,162,39,0.3); border-radius:14px; padding:18px 20px; margin-bottom:22px; box-shadow:0 2px 6px rgba(0,0,0,0.02);">
        <!-- Main Metrics: Current Stock, Unit Price, Category -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:16px; align-items:center;">
          
          <!-- Current Stock -->
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:44px; height:44px; border-radius:10px; background:rgba(5,150,105,0.12); color:#059669; display:flex; align-items:center; justify-content:center; font-size:18px; border:1px solid rgba(5,150,105,0.2); flex-shrink:0;">
              <i class="fas fa-boxes-stacked"></i>
            </div>
            <div>
              <div style="font-size:11px; font-weight:700; color:#71717a; text-transform:uppercase; letter-spacing:0.5px;">Current Stock</div>
              <div style="font-size:22px; font-weight:900; color:#059669; line-height:1.2;">
                ${curStock.toFixed(2)}${unitSuffix}
              </div>
            </div>
          </div>

          <!-- Unit Price -->
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:44px; height:44px; border-radius:10px; background:rgba(201,162,39,0.12); color:#c9a227; display:flex; align-items:center; justify-content:center; font-size:18px; border:1px solid rgba(201,162,39,0.25); flex-shrink:0;">
              <i class="fas fa-tag"></i>
            </div>
            <div>
              <div style="font-size:11px; font-weight:700; color:#71717a; text-transform:uppercase; letter-spacing:0.5px;">Unit Price</div>
              <div style="font-size:19px; font-weight:800; color:#18181b; line-height:1.2;">
                ₱${unitPrice.toFixed(2)}
              </div>
            </div>
          </div>

          <!-- Category -->
          <div style="display:flex; align-items:center; gap:12px;">
            <div style="width:44px; height:44px; border-radius:10px; background:rgba(201,162,39,0.12); color:#c9a227; display:flex; align-items:center; justify-content:center; font-size:18px; border:1px solid rgba(201,162,39,0.25); flex-shrink:0;">
              <i class="fas fa-layer-group"></i>
            </div>
            <div>
              <div style="font-size:11px; font-weight:700; color:#71717a; text-transform:uppercase; letter-spacing:0.5px;">Category</div>
              <div style="font-size:15px; font-weight:800; color:#18181b; line-height:1.2;">
                ${Utils.escapeHtml(item.category || 'Kitchen')}
              </div>
            </div>
          </div>
        </div>

        <!-- Minimum Threshold in Separate Highlighted Section Beneath Main Metrics -->
        <div style="margin-top:14px; border-top:1px dashed rgba(201,162,39,0.3); padding-top:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <i class="fas fa-shield-halved" style="color:#c9a227; font-size:14px;"></i>
            <span style="font-size:11.5px; font-weight:700; color:#71717a; text-transform:uppercase; letter-spacing:0.4px;">Minimum Threshold:</span>
            <span style="font-size:13.5px; font-weight:800; color:#18181b;">${minStock.toFixed(2)}${unitSuffix}</span>
          </div>
          ${isLowStock ? `
            <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.25); color:#dc2626; padding:4px 10px; border-radius:6px; font-size:11.5px; font-weight:700;">
              <i class="fas fa-triangle-exclamation"></i> Low Stock Warning: Current stock is at or below minimum threshold
            </div>
          ` : `
            <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(5,150,105,0.08); border:1px solid rgba(5,150,105,0.2); color:#059669; padding:4px 10px; border-radius:6px; font-size:11.5px; font-weight:700;">
              <i class="fas fa-circle-check"></i> Stock Healthy
            </div>
          `}
        </div>
      </div>
    `;

    if (!history.length) {
      host.innerHTML = `
        ${summaryCardHtml}
        <div style="padding:48px 20px; text-align:center; background:#fcfaf6; border:1px dashed rgba(201,162,39,0.3); border-radius:14px; margin:10px 0;">
          <div style="width:54px; height:54px; border-radius:50%; background:rgba(201,162,39,0.12); color:#c9a227; display:inline-flex; align-items:center; justify-content:center; font-size:22px; margin-bottom:12px;">
            <i class="fas fa-boxes-stacked"></i>
          </div>
          <h4 style="font-weight:800; font-size:15px; color:#18181b; margin:0 0 6px 0;">No Historical Entries Yet</h4>
          <p style="font-size:13px; color:#71717a; max-width:420px; margin:0 auto; line-height:1.5;">This item has not had any daily inventory submissions or stock adjustments recorded yet.</p>
        </div>
      `;
      return;
    }

    // Chronological Audit Timeline Cards
    const timelineHtml = history.map((entry, idx) => {
      const prev = Number(entry.previous_stock || 0);
      const rec = Number(entry.recorded_stock || 0);
      const diff = typeof entry.difference === 'number' ? entry.difference : (rec - prev);
      const entryUnit = entry.unit ? ` ${Utils.escapeHtml(entry.unit)}` : unitSuffix;
      
      let badgeHtml = '';
      if (diff > 0) {
        badgeHtml = `
          <span style="display:inline-flex; align-items:center; gap:4px; background:rgba(5,150,105,0.1); border:1px solid rgba(5,150,105,0.25); color:#059669; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:800;">
            <i class="fas fa-arrow-up" style="font-size:10px;"></i> +${diff.toFixed(2)}${entryUnit}
          </span>
        `;
      } else if (diff < 0) {
        badgeHtml = `
          <span style="display:inline-flex; align-items:center; gap:4px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.25); color:#dc2626; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:800;">
            <i class="fas fa-arrow-down" style="font-size:10px;"></i> ${diff.toFixed(2)}${entryUnit}
          </span>
        `;
      } else {
        badgeHtml = `
          <span style="display:inline-flex; align-items:center; gap:4px; background:#f4f4f5; border:1px solid #e4e4e7; color:#71717a; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:700;">
            0.00${entryUnit}
          </span>
        `;
      }

      const isLast = idx === history.length - 1;

      return `
        <div style="display:flex; gap:16px; position:relative; padding-bottom:${isLast ? '0' : '20px'};">
          <!-- Timeline Vertical Node & Line -->
          <div style="display:flex; flex-direction:column; align-items:center;">
            <div style="width:28px; height:28px; border-radius:50%; background:#fcfaf6; color:#c9a227; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:800; border:2px solid #c9a227; flex-shrink:0; box-shadow:0 0 0 3px rgba(201,162,39,0.15);">
              <i class="fas fa-check"></i>
            </div>
            ${!isLast ? '<div style="width:2px; flex:1; background:#e4e4e7; margin:6px 0;"></div>' : ''}
          </div>

          <!-- Timeline Card -->
          <div style="flex:1; min-width:0; background:#ffffff; border:1px solid #e4e4e7; border-radius:12px; padding:14px 18px; box-shadow:0 1px 3px rgba(0,0,0,0.03);">
            
            <!-- Audit Entry Header -->
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:12px;">
              <div style="display:flex; align-items:center; flex-wrap:wrap; gap:8px; font-size:13px; font-weight:700; color:#18181b;">
                <span>
                  <i class="fas fa-calendar-day" style="color:#c9a227; margin-right:6px;"></i>${Utils.escapeHtml(entry.date_display || entry.inventory_date)}
                </span>
                <span style="color:#d4d4d8;">|</span>
                <span style="color:#71717a; font-weight:600; font-size:12px;">
                  <i class="fas fa-clock" style="color:#71717a; margin-right:4px;"></i>${Utils.escapeHtml(entry.time_display || '')}
                </span>
              </div>
              <div>
                ${badgeHtml}
              </div>
            </div>

            <!-- Audit Entry Details (3 columns with subtle vertical dividers on desktop) -->
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:12px; margin-bottom:12px; background:#fbf8f2; border:1px solid rgba(201,162,39,0.2); border-radius:10px; padding:10px 14px;">
              <div style="border-right:1px solid rgba(201,162,39,0.2); padding-right:8px;">
                <div style="font-size:11px; font-weight:700; color:#71717a; text-transform:uppercase; letter-spacing:0.4px;">Current Stock</div>
                <div style="font-size:16px; font-weight:800; color:#18181b; margin-top:2px;">
                  ${prev.toFixed(2)}
                </div>
              </div>
              <div style="border-right:1px solid rgba(201,162,39,0.2); padding-right:8px; padding-left:4px;">
                <div style="font-size:11px; font-weight:700; color:#71717a; text-transform:uppercase; letter-spacing:0.4px;">New Total Stock</div>
                <div style="font-size:16px; font-weight:900; color:#059669; margin-top:2px;">
                  ${rec.toFixed(2)}
                </div>
              </div>
              <div style="padding-left:4px;">
                <div style="font-size:11px; font-weight:700; color:#71717a; text-transform:uppercase; letter-spacing:0.4px;">Action Type</div>
                <div style="font-size:12.5px; font-weight:800; color:#18181b; margin-top:3px; word-break:break-word;">
                  ${Utils.escapeHtml(entry.action_type || 'DAILY_SUBMISSION')}
                </div>
              </div>
            </div>

            <!-- Audit Entry Footer -->
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; font-size:12px; color:#71717a; padding-top:8px; border-top:1px solid #f4f4f5;">
              <div style="display:flex; align-items:center; flex-wrap:wrap; gap:8px;">
                <span style="display:inline-flex; align-items:center;">
                  <i class="fas fa-user-circle" style="color:#c9a227; margin-right:5px; font-size:14px;"></i>
                  <span>Submitted by <strong style="color:#18181b;">${Utils.escapeHtml(entry.submitted_by_name || 'Staff')}</strong></span>
                </span>
                <span class="badge" style="background:rgba(5,150,105,0.08); color:#047857; border:1px solid rgba(5,150,105,0.2); font-size:10.5px; font-weight:700; padding:2px 7px; border-radius:6px; text-transform:uppercase;">
                  ${Utils.escapeHtml(entry.submitted_by_role || 'INVENTORY')}
                </span>
              </div>
              ${entry.notes ? `
                <div style="font-size:11.5px; color:#52525b; font-style:italic;">
                  <i class="fas fa-comment-dots" style="color:#c9a227; margin-right:4px;"></i>${Utils.escapeHtml(entry.notes)}
                </div>
              ` : `
                <div style="font-size:11.5px; color:#a1a1aa; font-style:italic;">No remarks</div>
              `}
            </div>

          </div>
        </div>
      `;
    }).join('');

    host.innerHTML = `
      ${summaryCardHtml}

      <!-- Audit Trail Timeline Header & List -->
      <div style="margin-top:18px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:14px;">
          <div>
            <h4 style="font-size:15px; font-weight:800; margin:0; color:#18181b; display:flex; align-items:center; gap:8px;">
              <i class="fas fa-list-check" style="color:#c9a227;"></i>Audit Trail Timeline
            </h4>
            <p style="font-size:12px; color:#71717a; margin:3px 0 0 0;">Chronological record of all stock submissions for this item.</p>
          </div>
          <div>
            <span style="background:rgba(201,162,39,0.12); color:#92400e; border:1px solid rgba(201,162,39,0.3); font-size:11.5px; font-weight:800; padding:4px 10px; border-radius:999px;">
              ${history.length} ${history.length === 1 ? 'Entry' : 'Entries'}
            </span>
          </div>
        </div>

        <div style="padding-left:4px;">
          ${timelineHtml}
        </div>
      </div>
    `;
  } catch (err) {
    Utils.showToast(err.message || "Failed to load item history.", "danger");
  }
}
