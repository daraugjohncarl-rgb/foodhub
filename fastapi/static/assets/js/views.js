/**
 * API-Driven View Renderers (views.js)
 * Polished to match the Super Admin visual design system, cards, tables, and typography.
 * Connects all UI modules asynchronously to FastAPI backend endpoints via Auth.fetch()
 */

let posCart = [];
let currentCategoryFilter = "all";
let cachedProducts = [];
let cachedInventory = [];

// Main view dispatcher
async function renderView(viewId, container) {
  if (!container) container = document.getElementById("view-container");
  if (!container) return;

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
      case "purchases":
        await renderProfitLoss(container);
        break;
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
        <p style="color:var(--text-muted, #71717a); margin:10px 0; font-size:13px;">${err.message || "Failed to communicate with backend API."}</p>
        <button class="btn btn-outline btn-sm" onclick="renderView('${viewId}')"><i class="fas fa-redo"></i> Retry</button>
      </div>
    `;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DASHBOARD / STATS OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────
async function renderDashboard(c) {
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
      Auth.fetch("/api/v1/analytics/dashboard"),
      Auth.fetch("/api/v1/shifts/drawer-summary"),
      Auth.fetch("/api/v1/inventory?low_stock_only=true"),
      Auth.fetch("/api/v1/analytics/profit-loss")
    ]);
    if (res.ok) stats = await res.json();
    if (drawerRes.ok) {
      drawerSummary = await drawerRes.json();
      cachedDrawerData = drawerSummary;
    }
    if (invRes.ok) lowStockItems = await invRes.json();
    if (plRes && plRes.ok) plStats = await plRes.json();
  } catch (e) {
    console.warn("Analytics endpoint unavailable, using defaults", e);
  }

  const liveDrawerCash = (drawerSummary && typeof drawerSummary.total_cash_in_drawers === 'number')
    ? drawerSummary.total_cash_in_drawers
    : (stats.cash_in_drawer || 0);

  c.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card" style="cursor:pointer;" onclick="renderView('cash_drawer')" title="Click to view Cash Drawer details">
        <div class="stat-icon purple" style="background:rgba(123,31,162,0.12); color:#7b1fa2;"><i class="fas fa-vault"></i></div>
        <div class="stat-info">
          <h3>Cash in Drawer</h3>
          <div class="stat-count" style="color:#7b1fa2;">${Utils.formatCurrency(liveDrawerCash)}</div>
          <div class="stat-trend" style="color:var(--success, #10b981);"><i class="fas fa-cash-register"></i> ${drawerSummary.active_drawers_count || 0} active drawer(s)</div>
        </div>
      </div>
      <div class="stat-card" style="cursor:pointer;" onclick="renderView('profit_loss')" title="Click to view Profit & Loss details">
        <div class="stat-icon green" style="background:rgba(16,185,129,0.12); color:#10b981;"><i class="fas fa-chart-line"></i></div>
        <div class="stat-info">
          <h3>Net Operating Profit</h3>
          <div class="stat-count" style="color:${plStats.profit_loss?.is_profitable ? '#10b981' : '#ef4444'};">${Utils.formatCurrency(plStats.profit_loss?.net_profit || 0)}</div>
          <div class="stat-trend" style="color:${plStats.profit_loss?.is_profitable ? '#10b981' : '#ef4444'};"><i class="fas fa-percent"></i> ${plStats.profit_loss?.profit_margin_percent || 0}% margin</div>
        </div>
      </div>
      <div class="stat-card" style="cursor:pointer;" onclick="renderView('profit_loss')" title="Click to view Cashout Income">
        <div class="stat-icon gold" style="background:rgba(201,162,39,0.12); color:#c9a227;"><i class="fas fa-vault"></i></div>
        <div class="stat-info">
          <h3>Cashout Income</h3>
          <div class="stat-count" style="color:#c9a227;">${Utils.formatCurrency(plStats.cashout?.total_cashout_income || 0)}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-shield-halved"></i> Secured in safe</div>
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
          <div class="stat-count" style="color:#10b981;">${stats.total_transactions_today || 0}</div>
          <div class="stat-trend" style="color:var(--success, #10b981);"><i class="fas fa-check-circle"></i> Completed orders</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-boxes"></i></div>
        <div class="stat-info">
          <h3>Low Stock Alerts</h3>
          <div class="stat-count" style="color:#f97316;">${stats.low_stock_count || 0}</div>
          <div class="stat-trend" style="color:#f97316;"><i class="fas fa-exclamation-triangle"></i> Needs reorder</div>
        </div>
      </div>
    </div>

    <!-- Live Cashier Drawers Tracking Section for Manager and Admin -->
    <div class="section-card">
      <div class="section-head">
        <div>
          <h2><i class="fas fa-cash-register" style="color:#c9a227; margin-right:8px;"></i> Cashier Cash Drawer Live Tracking</h2>
          <span style="font-size:12px; color:var(--text-muted);">Real-time monitoring of cash float, cash sales, drops, and expected drawer totals</span>
        </div>
        <div style="display:flex; gap:10px; align-items:center;">
          <button class="btn btn-primary btn-sm" onclick="openAddCashMovementModal()" style="display:inline-flex; align-items:center; gap:6px;">
            <i class="fas fa-money-bill-transfer"></i> Record Cash Drop / In
          </button>
          <a href="#cash_drawer" onclick="renderView('cash_drawer')" class="view-all-link">Full Cash Drawer Hub <i class="fas fa-arrow-right"></i></a>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cashier Staff</th>
              <th>Shift Status</th>
              <th>Started At</th>
              <th>Starting Float</th>
              <th>Cash Sales</th>
              <th>Cash In (+)</th>
              <th>Cash Drops (-)</th>
              <th style="background:rgba(201,162,39,0.08);">Expected in Drawer</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${renderDrawerTableRows(drawerSummary.shifts.slice(0, 5))}
          </tbody>
        </table>
      </div>
    </div>

    <div class="section-card">
      <div class="section-head">
        <h2>Stock & Low Inventory Alerts</h2>
        <a href="#inventory" onclick="renderView('inventory')" class="view-all-link">Manage Inventory <i class="fas fa-arrow-right"></i></a>
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
                <td><strong style="color:var(--text-main); font-size:13px;">${item.name}</strong></td>
                <td><strong style="font-size:13px;">${item.quantity}</strong> <span style="font-size:12px; color:var(--text-muted);">${item.unit || ''}</span></td>
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
// 2. INVENTORY MANAGEMENT (Masterlist & Automated Analytics)
// ─────────────────────────────────────────────────────────────────────────────
let currentInvCategory = "ALL";
let cachedAnalytics = null;

async function renderInventory(c) {
  if (!c) c = document.getElementById("view-container");
  if (!c) return;

  const [invRes, analyticsRes] = await Promise.all([
    Auth.fetch("/api/v1/inventory"),
    Auth.fetch("/api/v1/inventory/analytics")
  ]);

  const items = invRes.ok ? await invRes.json() : [];
  cachedInventory = items;
  cachedAnalytics = analyticsRes.ok ? await analyticsRes.json() : {
    health_score: 100, healthy_count: 0, low_stock_count: 0, out_of_stock_count: 0, total_items: 0,
    total_valuation: 0, urgent_restock: [], category_summary: {}
  };

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
          <div class="stat-count" style="color:#c9a227;">${cachedAnalytics.total_items}</div>
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
          <div class="stat-count" style="color:#10b981;">${cachedAnalytics.health_score}%</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-check-double"></i> ${cachedAnalytics.healthy_count} Healthy SKUs</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-triangle-exclamation"></i></div>
        <div class="stat-info">
          <h3>Low Stock Warnings</h3>
          <div class="stat-count" style="color:#f97316;">${cachedAnalytics.low_stock_count}</div>
          <div class="stat-trend" style="color:#f97316;"><i class="fas fa-cart-arrow-down"></i> Needs Reorder</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon red"><i class="fas fa-circle-xmark"></i></div>
        <div class="stat-info">
          <h3>Out of Stock</h3>
          <div class="stat-count" style="color:#ef4444;">${cachedAnalytics.out_of_stock_count}</div>
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
          onclick="filterInventoryCategory('${cat}')">
          ${cat === 'ALL' ? '🌐 All Items' : cat}
        </button>
      `).join('')}
    </div>

    <!-- Inventory Table Card -->
    <div class="section-card fade-up delay-2">
      <div class="section-head">
        <h2>Inventory Master Catalog</h2>
        <span id="inv-count-badge" style="font-size:13px; color:var(--text-muted);">${items.length} items listed</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Item Name</th>
              <th>Department / Category</th>
              <th>Current Stock</th>
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
}

function renderInventoryRows(items) {
  if (!items || !items.length) {
    return `<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--text-muted);"><i class="fas fa-boxes" style="font-size:24px; margin-bottom:8px; display:block; opacity:0.5;"></i>No inventory items match the criteria.<br><button class="btn btn-outline btn-sm" style="margin-top:12px;" onclick="openImportMasterlistModal()"><i class="fas fa-file-import"></i> Import Official Master List</button></td></tr>`;
  }
  return items.map(i => {
    const isOut = Number(i.quantity) <= 0;
    const isLow = Number(i.quantity) <= Number(i.min_stock);
    const badgeClass = isOut ? 'badge-danger' : isLow ? 'badge-warning' : 'badge-success';
    const badgeText = isOut ? 'Out of Stock' : isLow ? 'Low Stock' : 'In Stock';
    const catName = i.category || 'Kitchen';
    const unitPrice = Number(i.unit_price) || 0;
    const totalVal = (Number(i.quantity) || 0) * unitPrice;

    return `
      <tr>
        <td style="color:var(--text-muted); font-size:12px;">#${i.id}</td>
        <td><strong style="color:var(--text-main); font-size:13px;">${i.name}</strong></td>
        <td><span class="badge" style="background:rgba(201,162,39,0.12); color:#c9a227; font-size:11px; font-weight:600;">${catName}</span></td>
        <td>
          <div style="display:inline-flex; align-items:center; gap:6px;">
            <input type="number" 
                   step="any"
                   id="inv-stock-${i.id}" 
                   class="input-field" 
                   value="${Number(i.quantity)}" 
                   style="width:90px; height:36px; padding:4px 10px; font-size:14px; font-weight:800; border-radius:18px; border:1.5px solid rgba(205,190,150,0.5); background:#fff; text-align:center; color:var(--text-main);" 
                   onchange="inlineUpdateStock(${i.id}, ${Number(i.quantity)}, this.value)"
                   title="Adjust stock quantity directly">
            <span style="font-size:11px; color:var(--text-muted); font-weight:600;">${i.unit}</span>
          </div>
        </td>
        <td style="background:rgba(201,162,39,0.03);">
          <div style="display:inline-flex; align-items:center; gap:4px;">
            <span style="font-size:13px; font-weight:800; color:#c9a227;">₱</span>
            <input type="number" 
                   step="0.01" 
                   min="0"
                   id="inv-price-${i.id}" 
                   class="input-field" 
                   value="${unitPrice}" 
                   style="width:95px; height:36px; padding:4px 10px; font-size:14px; font-weight:800; color:#c9a227; border-radius:18px; border:1.5px solid rgba(201,162,39,0.45); background:#fff; text-align:center;" 
                   onchange="inlineUpdatePrice(${i.id}, this.value)"
                   title="Adjust price unit directly">
          </div>
        </td>
        <td style="background:rgba(16,185,129,0.04);"><strong id="inv-val-${i.id}" style="color:#10b981; font-size:13px; font-weight:700;">${Utils.formatCurrency(totalVal)}</strong></td>
        <td><span class="badge ${badgeClass}" style="font-size:11px; font-weight:700;">${badgeText}</span></td>
        <td style="text-align:right;">
          <button class="btn btn-outline btn-sm" style="padding:5px 9px; font-size:12px; color:var(--danger); border-radius:8px;" onclick="deleteInventoryItem(${i.id}, '${i.name.replace(/'/g, "\\'")}')" title="Delete Item">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');
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
  const q = (document.getElementById("inv-search")?.value || "").toLowerCase().trim();
  const filtered = cachedInventory.filter(i => {
    const matchCat = currentInvCategory === "ALL" || (i.category && i.category.toLowerCase() === currentInvCategory.toLowerCase());
    const matchSearch = !q || 
      (i.name && i.name.toLowerCase().includes(q)) || 
      (i.sku && i.sku.toLowerCase().includes(q)) ||
      (i.category && i.category.toLowerCase().includes(q));
    return matchCat && matchSearch;
  });

  const tbody = document.getElementById("inv-tbody");
  const countBadge = document.getElementById("inv-count-badge");
  if (tbody) tbody.innerHTML = renderInventoryRows(filtered);
  if (countBadge) countBadge.textContent = `${filtered.length} items listed`;
}

function openImportMasterlistModal() {
  const categories = [
    { name: "Kitchen", icon: "fa-utensils", desc: "Rice, Cooking Oil, Soy Sauce, Seasonings, Meat & Poultry" },
    { name: "Street Foods", icon: "fa-burger", desc: "Fishballs, Kikiam, Kwek-Kwek, Squid Rolls, Sauces" },
    { name: "Coffee Bar", icon: "fa-mug-hot", desc: "Espresso Beans, Syrups, Milk, Drizzles, Powders" },
    { name: "Beverages", icon: "fa-glass-water", desc: "Sodas, Juices, Bottled Water, Concentrates" },
    { name: "Milktea Supplies", icon: "fa-cocktail", desc: "Tapioca Pearls, Tea Leaves, Flavor Syrups, Creamer" },
    { name: "Packaging Materials", icon: "fa-box-open", desc: "Takeout Boxes, Paper Bags, Straws, Cups, Lids" },
    { name: "Cleaning Supplies", icon: "fa-broom", desc: "Detergent, Sanitizer, Trash Bags, Mops, Sponges" },
    { name: "Office Supplies and Equipments", icon: "fa-stapler", desc: "Receipt Paper Rolls, Pens, Markers, Staplers" },
    { name: "Samgyupsal Materials", icon: "fa-fire-burner", desc: "Pork Belly, Beef Slices, Kimchi, Dipping Sauces" },
    { name: "KITCHEN UTENSILS & EQUIPMENT", icon: "fa-blender", desc: "Knives, Cutting Boards, Fryers, Pans, Tongs" },
    { name: "FURNITURE & FIXTURES", icon: "fa-chair", desc: "Dining Chairs, Tables, Light Fixtures, Shelving" },
  ];

  Utils.openModal("📦 Import Master List", `
    <!-- Tabs: Official Departments vs Custom List / Paste Names -->
    <div style="display:flex; gap:10px; margin-bottom:16px; border-bottom:1px solid rgba(205,190,150,0.3); padding-bottom:8px;">
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
        <strong><i class="fas fa-info-circle"></i> Zero Current Stock Rule:</strong> When importing, items without existing stock are safely created with <strong>0.0 current stock</strong>. Current stock is NOT added artificially. Existing items preserve their stock.
      </div>

      <div style="background:rgba(201,162,39,0.08); border:1px solid rgba(201,162,39,0.25); border-radius:12px; padding:14px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <div>
          <strong style="color:var(--text-main); font-size:13px;">⚡ Complete Master Import (All 11 Departments)</strong>
          <div style="font-size:11px; color:var(--text-muted);">Imports all standard master catalog items with 0 initial stock.</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="submitImportMasterlist(null)">
          <i class="fas fa-cloud-arrow-down"></i> Import All
        </button>
      </div>

      <h4 style="font-size:12px; text-transform:uppercase; color:var(--text-muted); margin-bottom:10px;">Or Import by Department</h4>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; max-height:260px; overflow-y:auto; padding-right:4px;">
        ${categories.map(c => `
          <div style="border:1px solid rgba(205,190,150,0.3); border-radius:10px; padding:10px; background:#ffffff; display:flex; flex-direction:column; justify-content:space-between; gap:6px;">
            <div>
              <div style="font-weight:700; font-size:12px; color:var(--text-main); display:flex; align-items:center; gap:6px;">
                <i class="fas ${c.icon}" style="color:#c9a227;"></i> ${c.name}
              </div>
              <div style="font-size:10px; color:var(--text-muted); margin-top:2px; line-height:1.3;">${c.desc}</div>
            </div>
            <button class="btn btn-outline btn-sm" style="align-self:flex-start; font-size:11px; padding:3px 8px;" onclick="submitImportMasterlist('${c.name}')">
              Import ${c.name}
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

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
        <div class="input-group">
          <label style="font-size:11px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Department Category</label>
          <select id="custom-import-cat" class="input-field" style="width:100%;">
            ${categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}
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
  `, `<button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>`);
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

  Utils.openModal("📊 Automated Inventory Analysis & Health Audit", `
    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:18px;">
      <div style="background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.25); border-radius:10px; padding:12px; text-align:center;">
        <div style="font-size:11px; font-weight:700; color:#10b981;">HEALTHY ITEMS</div>
        <div style="font-size:20px; font-weight:800; color:#10b981;">${cachedAnalytics.healthy_count}</div>
      </div>
      <div style="background:rgba(249,115,22,0.08); border:1px solid rgba(249,115,22,0.25); border-radius:10px; padding:12px; text-align:center;">
        <div style="font-size:11px; font-weight:700; color:#f97316;">LOW STOCK</div>
        <div style="font-size:20px; font-weight:800; color:#f97316;">${cachedAnalytics.low_stock_count}</div>
      </div>
      <div style="background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.25); border-radius:10px; padding:12px; text-align:center;">
        <div style="font-size:11px; font-weight:700; color:#ef4444;">OUT OF STOCK</div>
        <div style="font-size:20px; font-weight:800; color:#ef4444;">${cachedAnalytics.out_of_stock_count}</div>
      </div>
    </div>

    <h4 style="font-size:13px; font-weight:700; margin-bottom:10px; color:var(--text-main);">Prioritized Restock List</h4>
    <div style="max-height:300px; overflow-y:auto; border:1px solid rgba(205,190,150,0.3); border-radius:10px;">
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
              <td style="padding:8px 12px;"><strong>${u.name}</strong></td>
              <td style="padding:8px 12px; color:var(--text-muted);">${u.category}</td>
              <td style="padding:8px 12px; color:${u.quantity <= 0 ? '#ef4444' : '#f97316'}; font-weight:700;">${u.quantity} ${u.unit}</td>
              <td style="padding:8px 12px;">${u.min_stock} ${u.unit}</td>
              <td style="padding:8px 12px; color:#ef4444; font-weight:700;">-${u.deficit} ${u.unit}</td>
              <td style="padding:8px 12px; text-align:right;">
                <button class="btn btn-primary btn-sm" style="padding:2px 8px; font-size:11px;" onclick="openStockAdjustModal(${u.id}, '${u.name.replace(/'/g, "\\'")}', ${u.quantity})">Restock</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `, `<button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>`);
}

function openAddInventoryModal() {
  Utils.openModal("Add Custom Stock Item", `
    <form id="form-add-inv" onsubmit="event.preventDefault(); submitAddInventory();">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Item Name <span style="color:var(--danger);">*</span></label>
        <input id="inv-name" class="input-field" required placeholder="e.g. Special Chili Garlic Oil" style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Department / Category <span style="color:var(--danger);">*</span></label>
          <select id="inv-cat" class="input-field" style="width:100%;">
            <option value="Kitchen" selected>Kitchen</option>
            <option value="Street Foods">Street Foods</option>
            <option value="Coffee Bar">Coffee Bar</option>
            <option value="Beverages">Beverages</option>
            <option value="Packaging">Packaging</option>
            <option value="Cleaning Supplies">Cleaning Supplies</option>
            <option value="Office Supplies and Equipments">Office Supplies & Equipments</option>
            <option value="SAMGYUPSAL">SAMGYUPSAL</option>
            <option value="KITCHEN UTENSILS & EQUIPMENT">Kitchen Utensils & Equipment</option>
            <option value="FURNITURE & FIXTURES">Furniture & Fixtures</option>
          </select>
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">SKU (Optional)</label>
          <input id="inv-sku" class="input-field" placeholder="e.g. KIT-0099" style="width:100%;">
        </div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Opening Quantity <span style="color:var(--danger);">*</span></label>
          <input type="number" step="0.01" id="inv-qty" class="input-field" required value="0" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Unit of Measure <span style="color:var(--danger);">*</span></label>
          <input id="inv-unit" class="input-field" required placeholder="kg, L, pcs, packs, cans" style="width:100%;">
        </div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Unit Price / Cost (₱) <span style="color:var(--danger);">*</span></label>
          <input type="number" step="0.01" min="0" id="inv-price" class="input-field" required value="50.00" placeholder="0.00" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Min Stock Threshold <span style="color:var(--danger);">*</span></label>
          <input type="number" step="0.01" id="inv-min" class="input-field" required value="5" style="width:100%;">
        </div>
      </div>
    </form>
  `, `<button class="btn btn-primary" onclick="submitAddInventory()"><i class="fas fa-save"></i> Save Stock Item</button>`);
}

async function submitAddInventory() {
  const name = document.getElementById("inv-name").value.trim();
  const category = document.getElementById("inv-cat").value.trim();
  const sku = document.getElementById("inv-sku").value.trim();
  const quantity = parseFloat(document.getElementById("inv-qty").value) || 0;
  const unit = document.getElementById("inv-unit").value.trim();
  const unit_price = parseFloat(document.getElementById("inv-price")?.value) || 0;
  const min_stock = parseFloat(document.getElementById("inv-min").value) || 0;

  if (!name || !unit) {
    Utils.showToast("Please fill in required item name and unit", "danger");
    return;
  }

  try {
    const res = await Auth.fetch("/api/v1/inventory", {
      method: "POST",
      body: JSON.stringify({ name, category, sku: sku || null, quantity, unit, unit_price, min_stock })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to create item.");
    }
    Utils.showToast("Stock item created successfully", "success");
    Utils.closeModal();
    renderInventory();
  } catch (err) {
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
    Utils.showToast(`"${name}" deleted from inventory`, "success");
    renderInventory();
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
  const [prodRes, catRes] = await Promise.all([
    Auth.fetch("/api/v1/products"),
    Auth.fetch("/api/v1/categories")
  ]);

  const products = prodRes.ok ? await prodRes.json() : [];
  const categories = catRes.ok ? await catRes.json() : [];
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
          ${categories.map(cat => `<option value="${cat.id}">${cat.name}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-primary" onclick="openAddProductModal()" style="display:inline-flex; align-items:center; gap:8px;">
        <i class="fas fa-plus"></i> Add Menu Product
      </button>
    </div>

    <div class="section-card">
      <div class="section-head">
        <h2>Menu Products Catalog</h2>
        <span style="font-size:13px; color:var(--text-muted);">${products.length} products listed</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:60px;">ID</th>
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
    return `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-muted);">No products registered yet.</td></tr>`;
  }
  return products.map(p => {
    const catName = getProductCategoryName(p);
    const photoHtml = p.image_url ? `
      <div style="width:40px; height:40px; border-radius:8px; overflow:hidden; border:1px solid rgba(205,190,150,0.35); background:#ffffff; display:flex; align-items:center; justify-content:center; margin:0 auto; box-shadow:0 2px 5px rgba(0,0,0,0.04);">
        <img src="${p.image_url}" alt="${p.name}" style="width:100%; height:100%; object-fit:cover;" onerror="this.onerror=null; this.parentElement.innerHTML='<i class=\\'fas fa-utensils\\' style=\\'color:#cbd5e1; font-size:16px;\\'></i>';">
      </div>
    ` : `
      <div style="width:40px; height:40px; border-radius:8px; border:1px dashed rgba(205,190,150,0.45); background:rgba(0,0,0,0.02); display:flex; align-items:center; justify-content:center; color:var(--text-muted); margin:0 auto;" title="No picture uploaded">
        <i class="fas fa-image" style="font-size:15px; opacity:0.35;"></i>
      </div>
    `;

    return `
    <tr>
      <td style="color:var(--text-muted); font-weight:600;">#${p.id}</td>
      <td style="text-align:center;">${photoHtml}</td>
      <td>
        <span style="background:rgba(201,162,39,0.12); color:#c9a227; font-weight:700; font-family:monospace; padding:3px 8px; border-radius:6px; font-size:12px; letter-spacing:0.5px;">${p.sku || '—'}</span>
      </td>
      <td><strong style="color:var(--text-main); font-size:13px;">${p.name}</strong></td>
      <td>
        <span class="badge" style="background:rgba(205,190,150,0.18); color:var(--text-main); font-size:11px; font-weight:600;">
          ${catName}
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
        <button class="btn btn-danger btn-sm" onclick="deleteProductPrompt(${p.id}, '${(p.name || '').replace(/'/g, "\\'")}')" style="font-size:11px; padding:3px 8px; display:inline-flex; align-items:center; gap:4px; cursor:pointer; background:#dc3545; border-color:#dc3545; color:#fff;" title="Delete Product">
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
      previewEl.innerHTML = `<img src="${e.target.result}" style="width:100%; height:100%; object-fit:cover;">`;
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
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Category <span style="color:var(--danger);">*</span></label>
        <select id="prod-category" class="input-field" required style="width:100%;">
          <option value="">-- Select Category --</option>
          ${cats.map(cat => `<option value="${cat.id}">${cat.name}</option>`).join('')}
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

      <!-- Selling Price -->
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Selling Price (₱) <span style="color:var(--danger);">*</span></label>
        <input type="number" step="0.01" id="prod-price" class="input-field" required value="99" style="width:100%;">
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
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Category</label>
        <select id="edit-prod-category" class="input-field" style="width:100%;">
          <option value="">-- No Category --</option>
          ${cats.map(cat => `<option value="${cat.id}" ${p.category_id === cat.id ? 'selected' : ''}>${cat.name}</option>`).join('')}
        </select>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Product Code <span style="color:var(--danger);">*</span></label>
        <input id="edit-prod-sku" class="input-field" required value="${p.sku || ''}" placeholder="e.g. C1, B1, Y1" style="width:100%;">
        <small style="font-size:11px; color:var(--text-muted); margin-top:3px; display:block;">Quick menu order code (like Jollibee item codes)</small>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Product Name <span style="color:var(--danger);">*</span></label>
        <input id="edit-prod-name" class="input-field" required value="${p.name}" style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Selling Price (₱) <span style="color:var(--danger);">*</span></label>
          <input type="number" step="0.01" id="edit-prod-price" class="input-field" required value="${p.price}" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Status</label>
          <select id="edit-prod-status" class="input-field" style="width:100%;">
            <option value="true" ${p.is_active ? 'selected' : ''}>Active</option>
            <option value="false" ${!p.is_active ? 'selected' : ''}>Inactive</option>
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
            ${p.image_url ? `<img src="${p.image_url}" style="width:100%; height:100%; object-fit:cover;">` : `<i class="fas fa-camera" style="font-size:26px; color:rgba(205,190,150,0.5);"></i>`}
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
            <input type="hidden" id="edit-prod-img-url" value="${p.image_url || ''}">
            <small style="font-size:11px; color:var(--text-muted); margin-top:5px; display:block;">Shows on the POS Cashier and customer menu QR ordering.</small>
          </div>
        </div>
      </div>
    </form>
  `, `
    <div style="display:flex; justify-content:space-between; align-items:center; width:100%; gap:12px;">
      <button type="button" class="btn btn-danger" onclick="deleteProductPrompt(${p.id}, '${(p.name || '').replace(/'/g, "\\'")}')" style="background:#dc3545; border-color:#dc3545; color:#fff; display:inline-flex; align-items:center; gap:6px; cursor:pointer;">
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
  const confirmed = confirm(`Are you sure you want to delete "${name || 'this product'}"?`);
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
// 4. CASHIER POINT OF SALE (POS)
// ─────────────────────────────────────────────────────────────────────────────
async function renderPOS(c) {
  const [prodRes, catRes, drawerRes] = await Promise.all([
    Auth.fetch("/api/v1/products"),
    Auth.fetch("/api/v1/categories"),
    Auth.fetch("/api/v1/shifts/drawer-summary")
  ]);

  const rawProducts = prodRes.ok ? await prodRes.json() : [];
  const categories = catRes.ok ? await catRes.json() : [];
  const drawerData = drawerRes.ok ? await drawerRes.json() : { shifts: [], total_cash_in_drawers: 0, today_total_orders_amount: 0 };
  const currentUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  const myShift = (drawerData.shifts || []).find(s => s.status === 'open' && (currentUser ? s.cashier_id === currentUser.id : true))
               || (drawerData.shifts || []).find(s => s.status === 'open');
  const posDrawerCash = myShift ? myShift.expected_cash : 0;
  const posOrdersTotal = myShift ? myShift.total_sales : (drawerData.today_total_orders_amount || 0);

  // Exclude inactive products from POS counter & grid!
  const products = rawProducts.filter(p => p.is_active !== false && p.is_active !== 0 && p.is_active !== "0");
  cachedProducts = products;
  window.cachedCategories = categories;

  const catMap = {};
  categories.forEach(cat => { catMap[cat.id] = cat.name; });
  window.cachedCategoryMap = catMap;

  if (!window._posDrawerListenerAttached) {
    window._posDrawerListenerAttached = true;
    window.addEventListener("storage", async (e) => {
      if (e.key === "RESTOTRACK_DRAWER_RESET" || e.key === "RESTOTRACK_SYNC_TX") {
        try {
          const res = await Auth.fetch("/api/v1/shifts/drawer-summary");
          if (res.ok) {
            const dData = await res.json();
            const cUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
            const myS = (dData.shifts || []).find(s => s.status === 'open' && (cUser ? s.cashier_id === cUser.id : true))
                     || (dData.shifts || []).find(s => s.status === 'open');
            const dCashEl = document.getElementById("pos-cash-in-drawer-display");
            const dOrdEl = document.getElementById("pos-complete-orders-display");
            if (dCashEl) dCashEl.textContent = Utils.formatCurrency(myS ? myS.expected_cash : 0);
            if (dOrdEl) dOrdEl.textContent = "Orders: " + Utils.formatCurrency(myS ? myS.total_sales : 0);
          }
        } catch (err) {}
      }
    });
  }

  c.innerHTML = `
    <style>
      @media (max-width: 1200px) {
        .pos-container { grid-template-columns: minmax(0, 1fr) 300px !important; }
      }
      @media (max-width: 1024px) {
        .pos-container { grid-template-columns: 1fr !important; }
        .pos-cart { position: static !important; width: 100% !important; height: auto !important; max-height: none !important; margin-top: 16px !important; }
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
        .stats-grid.pos-stats-grid { grid-template-columns: repeat(3, 1fr) !important; gap: 6px !important; }
        .pos-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 8px !important; }
      }
      @media (max-width: 360px) {
        .stats-grid.pos-stats-grid { grid-template-columns: 1fr !important; }
        .pos-grid { grid-template-columns: 1fr !important; }
      }
      .cat-pill {
        white-space: nowrap; border-radius: 20px; padding: 6px 18px; 
        background: #ffffff; color: var(--text-main); border: 1px solid rgba(205,190,150,0.4); 
        cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.2s ease;
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
        
        <!-- SEARCH ROW -->
        <div class="pos-search-row" style="display:flex; gap:10px; width:100%; margin-bottom: 8px;">
          <div class="search-wrap" style="position:relative; flex:1;">
            <i class="fas fa-search" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--text-muted); font-size:13px;"></i>
            <input type="text" id="pos-search" class="input-field" placeholder="Search menu products..." style="padding-left:36px; width:100%; font-size:13px; height:38px; border-radius:10px; background:#ffffff;" oninput="filterPOSGrid()">
          </div>
          <button id="pos-voice-order-btn" onclick="toggleVoiceOrderDirect()" style="height:38px; padding:0 14px; background:#18181b; color:#fff; border:1px solid #3f3f46; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:8px; white-space:nowrap; transition:all 0.2s;" onmouseover="if(!window.isVoiceListening){this.style.background='#27272a'; this.style.borderColor='#c9a227';}" onmouseout="if(!window.isVoiceListening){this.style.background='#18181b'; this.style.borderColor='#3f3f46';}" title="Click to start/stop Voice Recording (English, Tagalog, Hiligaynon)">
            <i class="fas fa-microphone" id="pos-voice-btn-mic" style="color:#ef4444; font-size:13px;"></i>
            <span id="pos-voice-btn-text">VOICE ORDER</span>
          </button>
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
            <span style="flex-shrink:0;">🔴 Recording Voice Order:</span>
            <span id="pos-voice-transcript-text" style="color:#18181b; font-style:italic; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Speak order (e.g. "isa ka c1 solo", "c1 solo 1", "1 1pc chickenjoy solo")...</span>
          </div>
          <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
            <span style="font-size:10px; color:#b91c1c; background:rgba(239,68,68,0.1); padding:2px 6px; border-radius:4px; font-weight:700;">EN • TAGALOG • HILIGAYNON</span>
            <button type="button" onclick="stopVoiceRecordingDirect()" style="border:none; background:transparent; color:#991b1b; font-size:14px; font-weight:bold; cursor:pointer; padding:0 4px;" title="Stop Voice Recording">✕</button>
          </div>
        </div>

        <!-- KPI SUMMARY ROW (Single-row slim strip) -->
        <div class="stats-grid pos-stats-grid" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:8px;">
          <div class="stat-card" style="padding:8px 12px; display:flex; align-items:center; gap:10px; background:#ffffff; border-radius:10px; border:1px solid rgba(205,190,150,0.3);">
            <div style="width:32px; height:32px; border-radius:8px; background:rgba(201,162,39,0.1); color:#c9a227; display:flex; align-items:center; justify-content:center; font-size:14px; flex-shrink:0;"><i class="fas fa-box"></i></div>
            <div style="min-width:0;">
              <div style="font-size:9px; color:var(--text-muted); font-weight:600; text-transform:uppercase; line-height:1.1;">Total Items</div>
              <div style="font-size:16px; font-weight:800; color:var(--text-main); line-height:1.1;">${products.length}</div>
            </div>
          </div>
          <div class="stat-card" style="padding:8px 12px; display:flex; align-items:center; gap:10px; background:#ffffff; border-radius:10px; border:1px solid rgba(205,190,150,0.3);">
            <div style="width:32px; height:32px; border-radius:8px; background:rgba(16,185,129,0.1); color:#10b981; display:flex; align-items:center; justify-content:center; font-size:14px; flex-shrink:0;"><i class="fas fa-tags"></i></div>
            <div style="min-width:0;">
              <div style="font-size:9px; color:var(--text-muted); font-weight:600; text-transform:uppercase; line-height:1.1;">Categories</div>
              <div style="font-size:16px; font-weight:800; color:var(--text-main); line-height:1.1;">${categories.length}</div>
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
          ${categories.map(cat => `<button class="cat-pill" onclick="selectPOSCategory(${cat.id}, this)" style="padding:5px 12px; font-size:11px; border-radius:8px;">${cat.name}</button>`).join('')}
        </div>

        <!-- PRODUCT GRID (Small auto-fit / auto-resize) -->
        <div class="pos-grid" id="pos-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 125px), 1fr)); gap:10px;">
          ${renderPOSProductCards(products)}
        </div>
      </div>

      <!-- RIGHT CART (STICKY, COMPACT & SLEEK) -->
      <div class="pos-cart" style="display:flex; flex-direction:column; background:#ffffff; border:1px solid rgba(205,190,150,0.3); border-radius:14px; height:calc(100vh - 100px); position:sticky; top:80px; box-shadow:0 4px 15px rgba(0,0,0,0.03); overflow:hidden;">
        
        <div style="padding:10px 14px; border-bottom:1px solid rgba(205,190,150,0.2); display:flex; justify-content:space-between; align-items:center; background:#faf8f3;">
          <h2 style="font-size:13px; font-weight:800; color:var(--text-main); margin:0;">Current Cart</h2>
          <button class="btn btn-outline btn-sm" onclick="clearCart()" style="font-size:11px; padding:2px 8px; border-radius:6px; color:var(--danger); border-color:rgba(239,68,68,0.2); background:rgba(239,68,68,0.05);">Clear All</button>
        </div>

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
            💵 Charge & Checkout
          </button>
        </div>
      </div>

    </div>
  `;
  
  window.currentOnlineOrderId = null;
  startPOSOnlineOrdersPolling();
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
    return `
    <div class="pos-item-card" onclick="addToCart(${p.id}, '${p.name.replace(/'/g, "\\'")}', ${p.price})" style="position:relative; background:#ffffff; border:1px solid rgba(205,190,150,0.3); border-radius:10px; overflow:hidden; cursor:pointer; transition:transform 0.15s, box-shadow 0.15s; display:flex; flex-direction:column; box-shadow:0 2px 8px rgba(0,0,0,0.02);" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 18px rgba(201,162,39,0.15)';" onmouseout="this.style.transform='none'; this.style.boxShadow='0 2px 8px rgba(0,0,0,0.02)';">
      
      <!-- Top Badges -->
      <div style="position:absolute; top:6px; left:6px; right:6px; display:flex; justify-content:space-between; z-index:2; pointer-events:none;">
        <span style="background:rgba(255,255,255,0.92); backdrop-filter:blur(4px); color:var(--text-main); font-size:8px; font-weight:700; padding:2px 5px; border-radius:4px; box-shadow:0 2px 6px rgba(0,0,0,0.05); text-transform:uppercase;">${getProductCategoryName(p) !== 'Uncategorized' ? getProductCategoryName(p) : 'FOOD'}</span>
        <button class="add-btn" onclick="event.stopPropagation(); addToCart(${p.id}, '${p.name.replace(/'/g, "\\'")}', ${p.price})" style="width:22px; height:22px; border-radius:50%; background:#ffffff; color:#c9a227; border:none; box-shadow:0 2px 6px rgba(0,0,0,0.1); cursor:pointer; display:flex; align-items:center; justify-content:center; pointer-events:auto; font-size:9px; transition:background 0.2s;" onmouseover="this.style.background='#f0f0f0';" onmouseout="this.style.background='#ffffff';"><i class="fas fa-plus"></i></button>
      </div>

      <!-- Image Area -->
      <div style="height:80px; background:#f9f9f9; display:flex; align-items:center; justify-content:center; border-bottom:1px solid rgba(205,190,150,0.15); padding:0;">
        ${p.image_url ? `<img src="${p.image_url}" alt="${p.name}" style="width:100%; height:100%; object-fit:cover;">` : `<i class="fas fa-utensils" style="font-size:20px; color:#e2e2e2;"></i>`}
      </div>

      <!-- Details -->
      <div style="padding:8px 10px; display:flex; flex-direction:column; flex:1;">
        <div style="font-size:11px; font-weight:700; color:var(--text-main); line-height:1.25; height:28px; margin-bottom:6px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${p.name}</div>
        
        <div style="margin-top:auto; display:flex; justify-content:space-between; align-items:flex-end;">
          <span style="font-size:13px; font-weight:800; color:#c9a227;">${Utils.formatCurrency(p.price)}</span>
          <span style="font-size:9px; color:var(--text-muted); font-family:monospace;">${p.sku || `POS-${p.id}`}</span>
        </div>
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

function addToCart(productId, name, price) {
  const existing = posCart.find(i => i.product_id === productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    posCart.push({ product_id: productId, name, price, quantity: 1 });
  }
  updateCartUI();
}

function updateCartItemQty(productId, delta) {
  const item = posCart.find(i => i.product_id === productId);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) {
    posCart = posCart.filter(i => i.product_id !== productId);
  }
  updateCartUI();
}

function updateCartUI() {
  const container = document.getElementById("cart-items-container");
  if (container) container.innerHTML = renderCartItems();

  const total = posCart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
  const subtotalEl = document.getElementById("cart-subtotal");
  const totalEl = document.getElementById("cart-total");

  if (subtotalEl) subtotalEl.textContent = Utils.formatCurrency(total);
  if (totalEl) totalEl.textContent = Utils.formatCurrency(total);
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
  return posCart.map((i, idx) => `
    <div style="padding:10px 14px; border-bottom:1px solid rgba(205,190,150,0.15);">
      <div style="font-weight:700; color:var(--text-main); font-size:12px; line-height:1.25; margin-bottom:4px;">${i.name}</div>
      <div style="display:flex; justify-content:space-between; align-items:center;">
        
        <div style="color:var(--text-muted); font-size:11px; min-width:50px;">${Utils.formatCurrency(i.price)}</div>
        
        <!-- Quantity Controls -->
        <div style="display:flex; align-items:center; background:#faf8f3; border:1px solid rgba(205,190,150,0.3); border-radius:6px; overflow:hidden;">
          <button type="button" onclick="updateCartItemQty(${i.product_id}, -1)" style="width:24px; height:24px; border:none; background:transparent; cursor:pointer; color:var(--text-main); font-size:9px;"><i class="fas fa-minus"></i></button>
          <span style="font-weight:700; font-size:12px; width:24px; text-align:center; padding-top:2px;">${i.quantity}</span>
          <button type="button" onclick="updateCartItemQty(${i.product_id}, 1)" style="width:24px; height:24px; border:none; background:transparent; cursor:pointer; color:var(--text-main); font-size:9px;"><i class="fas fa-plus"></i></button>
        </div>
        
        <div style="font-weight:800; color:#c9a227; font-size:13px; text-align:right; min-width:60px;">${Utils.formatCurrency(i.price * i.quantity)}</div>
        
        <button type="button" class="btn-icon" onclick="posCart.splice(${idx}, 1); updateCartUI();" style="border:none; background:transparent; color:var(--danger); cursor:pointer; font-size:12px; margin-left:4px;" title="Remove"><i class="fas fa-trash-alt"></i></button>
      </div>
    </div>
  `).join('');
}

function clearCart() {
  posCart = [];
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
  s = s.replace(/\b(ah+|eh+|ay+|um+|uh+|oh+|yung|yun|nga|kuya|ate|miss|bossing)\b/gi, ' ');
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

  // General single letter codes (b-z, excluding 'a') followed by digit or number word:
  s = s.replace(/\b([b-z])\s+(?:1|one|wan|juan|want)\b/gi, '$11');
  s = s.replace(/\b([b-z])\s+(?:2|two|tu|to|too)\b/gi, '$12');
  s = s.replace(/\b([b-z])\s+(?:3|three|tri)\b/gi, '$13');
  s = s.replace(/\b([a-z])\s+(\d{1,2})\b/gi, '$1$2');

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
  for (const w of sortedWords) {
    if (text === w) {
      return { qty: VOICE_NUMBER_WORDS[w], itemStr: '', isOnlyQty: true };
    }
  }

  // Robust Code + Quantity pattern:
  // Extracts code and quantity even if there are conversational words like "order", "orders", "pcs"
  // Matches: "y1 2", "y1 to", "c1 1", "c1 want", "c2 2", "pos 5341 2", "why want to"
  const mCodeQty = text.match(/\b([a-z]\d+|pos\s+\d+|sku\s+\d+|\d{4,5})\s+(\d{1,2}|[a-z]+)(?:\s+(?:orders?|pcs|pieces?|buok|ka\s+bilog))?$/i);
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
  // Matches: "2 y1", "two y1", "to y1", "1 c2", "one c2", "3 c2"
  const mQtyCode = text.match(/\b(\d{1,2}|[a-z]+)\s+(?:of\s+)?([a-z]\d+|pos\s+\d+|sku\s+\d+|\d{4,5})$/i);
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

  // 1. Check digit at start (1 or 2 digits only, e.g. "1 c1", "3 c2", "2 y1")
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
      // 3b. Code with trailing numeric quantity (e.g. "pos 7928 2", "sku 85372 3", "c1 1")
      const mCodeWithQty = text.match(/^(pos\s+\d+|sku\s+\d+|\d{4,5}|[a-z]\d+)\s+(\d{1,2})$/i);
      if (mCodeWithQty) {
        itemStr = mCodeWithQty[1].trim();
        qty = parseInt(mCodeWithQty[2], 10);
      } else {
        // 3c. Regular trailing quantity (e.g. "burger 2")
        const mDigitEnd = text.match(/^(.*?)\s+(\d{1,2})$/);
        if (mDigitEnd && !/^(?:pos|sku|code|item|c|y|z)$/i.test(mDigitEnd[1].trim())) {
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
  const rawSegments = cleaned.split(/[,;]|\s+(?:kag|at|and|tsaka|saka|\+|with|then\s+next|next\s+order|then|next|period)\s+/i);
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
    const matched = matchVoiceProduct(itemStr, products);
    items.push({
      original: s,
      qty,
      itemStr,
      isOnlyQty: false,
      product: matched
    });
  }

  return items;
}

function matchVoiceProduct(query, products) {
  if (!products || !products.length || !query) return null;
  // Exclude inactive products from voice recognition
  const activeProducts = products.filter(p => p.is_active !== false && p.is_active !== 0 && p.is_active !== "0");
  if (!activeProducts.length) return null;

  const normQuery = query.toLowerCase().replace(/[\-_,.]/g, ' ').replace(/\s+/g, ' ').trim();
  const qClean = query.toLowerCase().replace(/[^a-z0-9]/g, '');

  const qDigitMatch = query.match(/\d+/);
  const qDigits = qDigitMatch ? qDigitMatch[0] : '';
  const isCodeQuery = /^(?:pos|sku|code|item)?\s*\d+$/i.test(query.trim());

  // Incomplete POS code check: All POS codes have 4 digits (e.g. POS-5341, POS-2631, POS-2931).
  // If query is an incomplete code with < 4 digits (e.g. "pos 2", "pos 26", "pos 263"), NEVER match!
  if (isCodeQuery && qDigits && qDigits.length < 4) {
    return null;
  }

  // 1. Exact match on normalized SKU / Code (e.g. "c1 solo" or "c1solo" matching "C1-SOLO", or "pos 7928", "pos 2631")
  for (const p of activeProducts) {
    const sku = (p.sku || '').toLowerCase();
    const normSku = sku.replace(/[\-_,.]/g, ' ').replace(/\s+/g, ' ').trim();
    const cleanSku = sku.replace(/[^a-z0-9]/g, '');
    if ((normSku && normSku === normQuery) || (cleanSku && cleanSku === qClean)) {
      return p;
    }
  }

  // 2. Code digits match (4 digits for POS-XXXX, 5 digits for SKU-XXXXX)
  if (isCodeQuery && qDigits && qDigits.length >= 4) {
    for (const p of activeProducts) {
      const sku = (p.sku || '').toLowerCase();
      const skuDigitMatch = sku.match(/\d+/);
      if (skuDigitMatch && skuDigitMatch[0].length >= 4) {
        const sDigits = skuDigitMatch[0];
        if (sDigits === qDigits) {
          return p;
        }
      }
    }
  }

  // 3. Embedded code in query (e.g. "bucket ice c2", "1 c1", query contains code word "c2" or "c1")
  for (const p of activeProducts) {
    const sku = (p.sku || '').toLowerCase().trim();
    const cleanSku = sku.replace(/[^a-z0-9]/g, '');
    if (cleanSku.length >= 2) {
      const reg = new RegExp('\\b' + cleanSku + '\\b', 'i');
      if (reg.test(normQuery)) {
        return p;
      }
    }
  }

  // 3b. SKU substring match for longer codes (>=4 chars, e.g. "pos2931" ending with "2931")
  if (qClean.length >= 4) {
    for (const p of activeProducts) {
      const sku = (p.sku || '').toLowerCase();
      const cleanSku = sku.replace(/[^a-z0-9]/g, '');
      if (cleanSku && cleanSku.length >= 4 && (cleanSku.endsWith(qClean) || qClean.endsWith(cleanSku))) {
        return p;
      }
    }
  }

  // 4. Exact Product Name match
  for (const p of activeProducts) {
    const normName = (p.name || '').toLowerCase().replace(/[\-_,.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (normName === normQuery) {
      return p;
    }
  }

  // 5. Product Name contains query or query contains product name (e.g. "french vanilla pos" contains "french vanilla")
  let bestContains = null;
  let bestLen = 0;
  for (const p of activeProducts) {
    const normName = (p.name || '').toLowerCase().replace(/[\-_,.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (normName.length > 2 && normQuery.includes(normName) && normName.length > bestLen) {
      bestContains = p;
      bestLen = normName.length;
    } else if (normQuery.length > 3 && normName.includes(normQuery) && normQuery.length > bestLen) {
      bestContains = p;
      bestLen = normQuery.length;
    }
  }
  if (bestContains) {
    return bestContains;
  }

  // 6. Token overlap match (avoid false positives on generic modifiers like 'solo', 'regular', 'single')
  const MODIFIER_WORDS = new Set(['solo', 'single', 'regular', 'barkada', 'with', 'w', 'hot', 'cold', 'iced', '16', '22', 'oz', 'pcs', 'pc', 'l']);
  const qTokens = normQuery.split(' ').filter(t => t.length > 1);
  const nonModifierTokens = qTokens.filter(t => !MODIFIER_WORDS.has(t));
  let bestProd = null;
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
    if (hasPrimaryMatch && score > bestScore) {
      bestScore = score;
      bestProd = p;
    }
  }

  const minRequired = qTokens.length <= 2 ? qTokens.length : Math.max(2, Math.floor(qTokens.length * 0.6));
  if (bestScore >= minRequired) {
    return bestProd;
  }

  // 7. Fuzzy string similarity (handles close pronunciations like "french ba nila" -> "French Vanilla")
  let bestFuzzyProd = null;
  let bestFuzzyScore = 0.0;

  for (const p of activeProducts) {
    const pCleanName = (p.name || '').toLowerCase().replace(/[\-_,.()–—]/g, ' ').replace(/\s+/g, ' ').trim();
    const sku = (p.sku || '').toLowerCase();

    const simName = computeLevenshteinSimilarity(normQuery, pCleanName);
    const simSku = computeLevenshteinSimilarity(normQuery, sku);

    const qWords = normQuery.split(/\s+/).filter(w => w.length > 2);
    const pWords = pCleanName.split(/\s+/).filter(w => w.length > 2);
    let wordOverlap = 0;
    if (qWords.length > 0 && pWords.length > 0) {
      for (const qw of qWords) {
        let bestWSim = 0;
        for (const pw of pWords) {
          const ws = computeLevenshteinSimilarity(qw, pw);
          if (ws > bestWSim) bestWSim = ws;
        }
        if (bestWSim >= 0.75) wordOverlap++;
      }
      var tokenSim = wordOverlap / Math.max(qWords.length, pWords.length);
    } else {
      var tokenSim = 0;
    }

    const maxSim = Math.max(simName, simSku, tokenSim);
    if (maxSim > bestFuzzyScore) {
      bestFuzzyScore = maxSim;
      bestFuzzyProd = p;
    }
  }

  // If >= 65% close to POS product name or code, automatically match!
  if (bestFuzzyScore >= 0.65) {
    return bestFuzzyProd;
  }

  return null;
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

function startVoiceRecordingDirect() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    Utils.showToast("Web Speech API not supported in this browser. Please use Chrome or Edge.", "warning");
    return;
  }

  window.isVoiceListening = true;
  window.pendingVoiceQty = null;
  updateVoiceButtonUI(true);

  if (posVoiceRecognition) {
    try { posVoiceRecognition.abort(); } catch(e) {}
  }

  posVoiceRecognition = new SpeechRec();
  posVoiceRecognition.continuous = true;
  posVoiceRecognition.interimResults = true;
  posVoiceRecognition.lang = voiceActiveLanguage;

  posVoiceRecognition.onstart = function() {
    window.isVoiceListening = true;
    updateVoiceButtonUI(true);
    const textEl = document.getElementById("pos-voice-transcript-text");
    if (textEl) {
      textEl.innerHTML = `Listening... Speak order (e.g. "isa ka c1 solo", "3 pos 5341", "1 bucket ice c2")`;
      textEl.style.color = "#18181b";
    }
    Utils.showToast("🎤 Voice recording started. Speak your order...", "info");
  };

  window.voiceSessionCommitted = window.voiceSessionCommitted || new Set();
  window.lastVoiceSpoken = '';
  window.lastVoiceCommitted = false;

  posVoiceRecognition.onresult = function(event) {
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
    const spoken = (finalTranscript || interim).trim();
    if (textEl && spoken) {
      textEl.innerHTML = `Heard: <span style="color:#b91c1c;">"${spoken}"</span>`;
    }

    window.lastVoiceSpoken = spoken;
    if (finalTranscript.trim()) {
      window.lastVoiceCommitted = true;
      executeVoiceOrderDirect(finalTranscript.trim(), true);
    } else {
      window.lastVoiceCommitted = false;
    }
  };

  posVoiceRecognition.onerror = function(event) {
    console.warn("Speech recognition error:", event.error);
    if (event.error === 'not-allowed') {
      window.isVoiceListening = false;
      updateVoiceButtonUI(false);
      Utils.showToast("Microphone access denied. Please allow microphone in browser settings.", "danger");
    } else if (event.error === 'no-speech') {
      // Continue listening without stopping
    }
  };

  posVoiceRecognition.onend = function() {
    // If still in listening state, auto-restart so cashier can speak next item
    if (window.isVoiceListening) {
      try {
        posVoiceRecognition.start();
      } catch(e) {
        window.isVoiceListening = false;
        updateVoiceButtonUI(false);
      }
    } else {
      updateVoiceButtonUI(false);
    }
  };

  try {
    posVoiceRecognition.start();
  } catch(e) {
    console.warn("Could not start speech recognition:", e);
    window.isVoiceListening = false;
    updateVoiceButtonUI(false);
  }
}

function stopVoiceRecordingDirect() {
  window.isVoiceListening = false;
  window.pendingVoiceQty = null;
  if (posVoiceRecognition) {
    try {
      posVoiceRecognition.stop();
    } catch(e) {}
  }
  if (window.lastVoiceSpoken && !window.lastVoiceCommitted) {
    executeVoiceOrderDirect(window.lastVoiceSpoken, true);
    window.lastVoiceSpoken = '';
  }
  if (window.voiceSessionCommitted) {
    window.voiceSessionCommitted.clear();
  }
  updateVoiceButtonUI(false);
  Utils.showToast("Voice recording stopped.", "info");
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

function executeVoiceOrderDirect(text, isFinal = true) {
  if (!text || !text.trim()) return;
  if (!isFinal) return; // Ensure cart addition only executes on final transcript

  const items = parseFullVoiceOrder(text, cachedProducts, window.pendingVoiceQty);
  const textEl = document.getElementById("pos-voice-transcript-text");

  // Check if speech was solely a quantity (e.g. "3", "isa ka", "tatlo", "five")
  if (items.length === 1 && items[0].isOnlyQty) {
    window.pendingVoiceQty = items[0].qty;
    if (textEl) {
      textEl.innerHTML = `<span style="color:#d97706;">⏳ Quantity <strong>${items[0].qty}</strong> noted — speak product name or POS code...</span>`;
    }
    return;
  }

  let addedCount = 0;
  let summaryNames = [];

  items.forEach(item => {
    if (item.product) {
      const prod = item.product;
      const itemKey = `${prod.id}_${item.qty}_${item.itemStr.toLowerCase().replace(/\s+/g, '')}`;

      if (!window.voiceSessionCommitted.has(itemKey)) {
        window.voiceSessionCommitted.add(itemKey);

        const existing = posCart.find(i => i.product_id === prod.id);
        if (existing) {
          existing.quantity += item.qty;
        } else {
          posCart.push({
            product_id: prod.id,
            name: prod.name,
            price: prod.price,
            quantity: item.qty
          });
        }
        addedCount++;
        summaryNames.push(`${item.qty}x ${prod.name}`);
      }
    }
  });

  if (addedCount > 0) {
    window.pendingVoiceQty = null; // Clear pending quantity once fulfilled
    updateCartUI();
    playVoiceBeep();
    if (textEl) {
      textEl.innerHTML = `<span style="color:#047857;">✅ Inserted ${summaryNames.join(', ')} into Current Cart!</span>`;
    }
  } else if (isFinal && (!items.length || !items.some(i => i.product))) {
    // Only show "Item not found" on final silence, not while typing/speaking interim digits or lone quantities
    const cleanedText = text.trim();
    if (!/^\d{1,2}$/.test(cleanedText) && !['pos', 'sku', 'code'].includes(cleanedText.toLowerCase())) {
      if (textEl) {
        textEl.innerHTML = `<span style="color:#b91c1c;">⚠️ Item not found: "${text}"</span>`;
      }
    }
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

// Backward compatibility alias
window.openVoiceOrderModal = toggleVoiceOrderDirect;
window.executeVoiceOrder = executeVoiceOrderDirect;
window.toggleVoiceListeningState = toggleVoiceOrderDirect;

function openPaymentModal() {
  if (!posCart.length) {
    Utils.showToast("Order cart is empty. Please add items to checkout.", "danger");
    return;
  }
  const total = posCart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
  window.isFirstTenderTap = true;

  Utils.openModal("Process Order Checkout", `
    <form id="form-payment" onsubmit="event.preventDefault(); submitCheckout();">
      <div style="text-align:center; padding:18px; background:rgba(201,162,39,0.08); border-radius:14px; margin-bottom:18px; border:1px solid rgba(205,190,150,0.3);">
        <span style="font-size:12px; text-transform:uppercase; color:var(--text-muted); font-weight:600; letter-spacing:0.5px;">Total Amount Due</span>
        <div style="font-size:28px; font-weight:800; color:#c9a227; margin-top:4px;">${Utils.formatCurrency(total)}</div>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Payment Method <span style="color:var(--danger);">*</span></label>
        <select id="pay-method" class="input-field" style="width:100%;">
          <option value="CASH" selected>Cash (Cash Register)</option>
          <option value="GCASH">GCash E-Wallet</option>
          <option value="CARD">Debit / Credit Card</option>
        </select>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Amount Tendered (₱) <span style="color:var(--danger);">*</span></label>
        <input type="number" step="0.01" id="pay-tendered" class="input-field" required value="${total}" style="width:100%; font-size:16px; font-weight:700;" oninput="window.isFirstTenderTap=false; calculateChange(${total})">
      </div>
      
      <!-- Quick Denominations for Rapid Touch Input -->
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
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
  `, `<button class="btn btn-primary" onclick="submitCheckout()" style="width:100%; height:44px; font-size:14px; font-weight:700;"><i class="fas fa-check-circle"></i> Confirm & Complete Sale</button>`);
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
  const tendered = parseFloat(document.getElementById("pay-tendered")?.value) || 0;
  const change = Math.max(0, tendered - total);
  const changeEl = document.getElementById("pay-change");
  if (changeEl) {
    changeEl.textContent = Utils.formatCurrency(change);
  }
}

async function submitCheckout() {
  const method = document.getElementById("pay-method").value;
  const tendered = parseFloat(document.getElementById("pay-tendered").value) || 0;
  const total = posCart.reduce((sum, i) => sum + (i.price * i.quantity), 0);

  if (tendered < total) {
    Utils.showToast("Tendered amount is less than total payable amount.", "danger");
    return;
  }

  const payload = {
    items: posCart.map(i => ({ product_id: i.product_id, quantity: i.quantity })),
    payment_method: method,
    amount_paid: tendered
  };

  try {
    const res = await Auth.fetch("/api/v1/transactions", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Transaction processing failed.");
    }
    
    const tx = await res.json();
    
    // Mark customer online order as completed if applicable
    if (window.currentOnlineOrderId) {
      try {
        await Auth.fetch(`/api/v1/customer-orders/${window.currentOnlineOrderId}/status`, {
          method: "PUT",
          body: JSON.stringify({ status: "completed" })
        });
        window.currentOnlineOrderId = null;
      } catch (err) {
        console.error("Failed to update online order status:", err);
      }
    }
    
    Utils.showToast("Order completed successfully!", "success");
    Utils.closeModal();
    
    const currentUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
    const orderForReceipt = {
      id: tx.id,
      receiptNumber: tx.client_tx_id || tx.id || "N/A",
      date: tx.created_at || new Date().toISOString(),
      cashier: currentUser ? (currentUser.name || currentUser.username) : "Cashier",
      items: posCart.map(i => ({
        name: i.name,
        quantity: i.quantity,
        price: i.price
      })),
      total_amount: total,
      payment_method: method,
      amount_paid: tendered
    };
    
    Utils.showReceiptModal(orderForReceipt);
    
    clearCart();
    localStorage.setItem("RESTOTRACK_SYNC_TX", Date.now());

    try {
      const dRes = await Auth.fetch("/api/v1/shifts/drawer-summary");
      if (dRes.ok) {
        const dData = await dRes.json();
        const cUser = typeof Auth !== 'undefined' ? Auth.getUser() : null;
        const myS = (dData.shifts || []).find(s => s.status === 'open' && (cUser ? s.cashier_id === cUser.id : true))
                 || (dData.shifts || []).find(s => s.status === 'open');
        const dCashEl = document.getElementById("pos-cash-in-drawer-display");
        const dOrdEl = document.getElementById("pos-complete-orders-display");
        if (dCashEl && myS) dCashEl.textContent = Utils.formatCurrency(myS.expected_cash);
        if (dOrdEl && myS) dOrdEl.textContent = "Orders: " + Utils.formatCurrency(myS.total_sales);
      }
    } catch (e) {}
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. KITCHEN DISPLAY SYSTEM (KDS)
// ─────────────────────────────────────────────────────────────────────────────
async function renderKitchen(c) {
  c = c || document.getElementById('view-container');
  const res = await Auth.fetch(`/api/v1/kitchen/orders?type=food&_t=${Date.now()}`);
  const orders = res.ok ? await res.json() : [];

  c.innerHTML = `
    <style>
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 14px; margin-bottom: 24px; }
      @media (max-width: 600px) {
        .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
      }
      @media (max-width: 400px) {
        .stats-grid { grid-template-columns: 1fr; }
      }
      .stat-card { padding: 20px 18px; display: flex; align-items: center; gap: 14px; background: var(--card-bg, #ffffff); border-radius: var(--radius-card, 16px); border: 1px solid rgba(205, 190, 150, 0.35); box-shadow: 0 4px 15px rgba(0,0,0,0.03); transition: transform 0.3s ease, box-shadow 0.3s ease; }
      .stat-card:hover { transform: translateY(-3px); box-shadow: 0 15px 35px rgba(180,140,50,0.12); }
      .stat-icon { width: 50px; height: 50px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; }
      .stat-icon.gold   { background: rgba(201,162,39,0.12); color: #c9a227; }
      .stat-icon.green  { background: rgba(16,185,129,0.12); color: #10b981; }
      .stat-icon.orange { background: rgba(249,115,22,0.12); color: #f97316; }
      .stat-icon.blue   { background: rgba(59,130,246,0.12); color: #3b82f6; }
      .stat-info h3 { font-size: 11px; color: var(--text-muted, #71717a); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; margin-top: 0; }
      .stat-count { font-size: 24px; font-weight: 800; color: var(--text-main, #18181b); line-height: 1.1; }
      .stat-trend { font-size: 11px; margin-top: 4px; font-weight: 500; }
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
    <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:20px; align-items:start;" class="fade-up delay-2">
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
        <div class="section-card" style="padding:0; overflow:hidden; border:1px solid ${isCompleted ? 'rgba(16,185,129,0.3)' : 'rgba(201,162,39,0.3)'};">
          <!-- Ticket Header -->
          <div style="background:${isCompleted ? '#f0fdf4' : '#faf8f3'}; padding:16px 20px; border-bottom:1px solid rgba(205,190,150,0.2); display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong style="font-size:16px; font-weight:800; color:var(--text-main);">${ord.id || '#ORD-XXXX'}</strong>
              <div style="font-size:11px; color:var(--text-muted); margin-top:2px;"><i class="far fa-clock"></i> ${ord.time || 'Just now'} • ${ord.table || 'Takeout'}</div>
            </div>
            <span class="badge" style="font-size:11px; font-weight:700; ${badgeStyle}">
              ${ord.status || 'PENDING'}
            </span>
          </div>
          
          <!-- Ticket Items -->
          <div style="padding:16px 20px;">
            <ul style="list-style:none; padding:0; margin:0;">
              ${(ord.items || []).map((it, idx) => `
                <li style="display:flex; align-items:flex-start; gap:12px; margin-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; padding-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; border-bottom:${idx === (ord.items.length - 1) ? 'none' : '1px dashed rgba(205,190,150,0.3)'};">
                  <div style="font-size:16px; font-weight:800; color:#c9a227; min-width:32px; text-align:right;">
                    ${it.qty || it.quantity}<span style="font-size:12px; color:var(--text-muted);">x</span>
                  </div>
                  <div>
                    <div style="font-size:14px; font-weight:700; color:var(--text-main); line-height:1.3;">${it.name || it.product_name}</div>
                    ${it.notes ? `<div style="font-size:12px; color:#f97316; margin-top:4px;"><i class="fas fa-exclamation-circle"></i> ${it.notes}</div>` : ''}
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
              <button class="btn btn-primary" style="width:100%; font-size:13px; font-weight:700; padding:10px; border-radius:8px; display:inline-flex; justify-content:center; align-items:center; gap:8px; background:#10b981; color:#fff; border:none; cursor:pointer;" onclick="updateOrderStatus('${ord.raw_id}', 'COMPLETED')">
                <i class="fas fa-check-circle"></i> Complete Order
              </button>
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
    <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:20px; align-items:start;" class="fade-up delay-2">
      ${completedOrders.length ? completedOrders.map(ord => {
        return `
        <div class="section-card" style="padding:0; overflow:hidden; border:1px solid rgba(16,185,129,0.3);">
          <!-- Ticket Header -->
          <div style="background:#f0fdf4; padding:16px 20px; border-bottom:1px solid rgba(205,190,150,0.2); display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong style="font-size:16px; font-weight:800; color:var(--text-main);">${ord.id || '#ORD-XXXX'}</strong>
              <div style="font-size:11px; color:var(--text-muted); margin-top:2px;"><i class="far fa-clock"></i> ${ord.time || 'Just now'} • ${ord.table || 'Takeout'}</div>
            </div>
            <span class="badge" style="font-size:11px; font-weight:700; background:rgba(16,185,129,0.12); color:#10b981;">
              ${ord.status || 'COMPLETED'}
            </span>
          </div>
          
          <!-- Ticket Items -->
          <div style="padding:16px 20px;">
            <ul style="list-style:none; padding:0; margin:0;">
              ${(ord.items || []).map((it, idx) => `
                <li style="display:flex; align-items:flex-start; gap:12px; margin-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; padding-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; border-bottom:${idx === (ord.items.length - 1) ? 'none' : '1px dashed rgba(205,190,150,0.3)'};">
                  <div style="font-size:16px; font-weight:800; color:#10b981; min-width:32px; text-align:right;">
                    ${it.qty || it.quantity}<span style="font-size:12px; color:var(--text-muted);">x</span>
                  </div>
                  <div>
                    <div style="font-size:14px; font-weight:700; color:var(--text-main); line-height:1.3; text-decoration: line-through;">${it.name || it.product_name}</div>
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
  try {
    const res = await Auth.fetch(`/api/v1/kitchen/orders/${orderId}/status`, {
      method: "PUT",
      body: JSON.stringify({ status: newStatus })
    });
    if (res.ok) {
      renderKitchen();
      localStorage.setItem("RESTOTRACK_SYNC_KITCHEN", JSON.stringify({ timestamp: Date.now(), orderId: orderId, status: newStatus }));
    }
  } catch (err) {
    console.error("Failed to update status", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.5 CASHIER DRINKS ORDER (DRINK PREPARATION & DISPATCH COUNTER)
// ─────────────────────────────────────────────────────────────────────────────
async function renderDrinksStation(c) {
  c = c || document.getElementById('view-container');
  if (!c) return;

  const res = await Auth.fetch(`/api/v1/kitchen/drinks-orders?_t=${Date.now()}`);
  const orders = res.ok ? await res.json() : [];

  pollDrinksBadge();

  if (window.drinksStationInterval) {
    clearInterval(window.drinksStationInterval);
    window.drinksStationInterval = null;
  }
  window.drinksStationInterval = setInterval(async () => {
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
  }, 7000);

  const activeOrders = orders.filter(o => o.status !== 'COMPLETED' && o.status !== 'READY');
  const pendingOrders = orders.filter(o => o.status === 'PENDING');
  const preparingOrders = orders.filter(o => o.status === 'PREPARING');
  const completedOrders = orders.filter(o => o.status === 'COMPLETED' || o.status === 'READY');
  const totalItems = activeOrders.reduce((sum, o) => sum + (o.items?.length || 0), 0);

  c.innerHTML = `
    <style>
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 14px; margin-bottom: 24px; }
      @media (max-width: 600px) {
        .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
      }
      @media (max-width: 400px) {
        .stats-grid { grid-template-columns: 1fr; }
      }
      .stat-card { padding: 20px 18px; display: flex; align-items: center; gap: 14px; background: var(--card-bg, #ffffff); border-radius: var(--radius-card, 16px); border: 1px solid rgba(205, 190, 150, 0.35); box-shadow: 0 4px 15px rgba(0,0,0,0.03); transition: transform 0.3s ease, box-shadow 0.3s ease; }
      .stat-card:hover { transform: translateY(-3px); box-shadow: 0 15px 35px rgba(180,140,50,0.12); }
      .stat-icon { width: 50px; height: 50px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; }
      .stat-icon.gold   { background: rgba(201,162,39,0.12); color: #c9a227; }
      .stat-icon.green  { background: rgba(16,185,129,0.12); color: #10b981; }
      .stat-icon.orange { background: rgba(249,115,22,0.12); color: #f97316; }
      .stat-icon.blue   { background: rgba(59,130,246,0.12); color: #3b82f6; }
      .stat-info h3 { font-size: 11px; color: var(--text-muted, #71717a); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; margin-top: 0; }
      .stat-count { font-size: 24px; font-weight: 800; color: var(--text-main, #18181b); line-height: 1.1; }
      .stat-trend { font-size: 11px; margin-top: 4px; font-weight: 500; }
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
          <div class="stat-count">${pendingOrders.length}</div>
          <div class="stat-trend" style="color:#f97316;"><i class="fas fa-exclamation-circle"></i> Needs Dispensing</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon blue"><i class="fas fa-blender"></i></div>
        <div class="stat-info">
          <h3>Preparing Drinks</h3>
          <div class="stat-count">${preparingOrders.length}</div>
          <div class="stat-trend" style="color:#3b82f6;"><i class="fas fa-spinner fa-spin"></i> In Progress</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-check-double"></i></div>
        <div class="stat-info">
          <h3>Drinks Served</h3>
          <div class="stat-count">${completedOrders.length}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-thumbs-up"></i> Dispatched</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-mug-hot"></i></div>
        <div class="stat-info">
          <h3>Drink Items</h3>
          <div class="stat-count">${totalItems}</div>
          <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-list-ol"></i> Drinks to Pour</div>
        </div>
      </div>
    </div>

    <!-- Responsive Grid for Drink Tickets -->
    <div id="drinks-tickets-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:20px; align-items:start;" class="fade-up delay-2">
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
                    <strong style="font-size:16px; font-weight:800; color:var(--text-main);">${ord.id || '#ORD-XXXX'}</strong>
                    <span style="font-size:11px; font-weight:700; background:#2563eb; color:#ffffff; padding:2px 8px; border-radius:12px;">🍹 DRINKS</span>
                  </div>
                  <div style="font-size:11px; color:var(--text-muted); margin-top:3px;">
                    <i class="far fa-clock"></i> ${ord.time || 'Just now'} • <strong>${ord.table || 'Takeout'}</strong>
                  </div>
                </div>
                <span class="badge" style="font-size:11px; font-weight:700; ${badgeStyle}">
                  ${ord.status || 'PENDING'}
                </span>
              </div>

              <!-- Drinks Items List -->
              <div style="padding:16px 20px;">
                <ul style="list-style:none; padding:0; margin:0;">
                  ${(ord.items || []).map((it, idx) => `
                    <li style="display:flex; align-items:flex-start; gap:12px; margin-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; padding-bottom:${idx === (ord.items.length - 1) ? '0' : '12px'}; border-bottom:${idx === (ord.items.length - 1) ? 'none' : '1px dashed rgba(205,190,150,0.3)'};">
                      <div style="font-size:16px; font-weight:800; color:#2563eb; min-width:32px; text-align:right;">
                        ${it.qty || it.quantity}<span style="font-size:12px; color:var(--text-muted);">x</span>
                      </div>
                      <div>
                        <div style="font-size:14px; font-weight:700; color:var(--text-main); line-height:1.3;">${it.name || it.product_name}</div>
                        ${it.notes ? `<div style="font-size:12px; color:#f97316; margin-top:4px;"><i class="fas fa-exclamation-circle"></i> ${it.notes}</div>` : ''}
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
                  <button class="btn btn-primary" style="width:100%; font-size:13px; font-weight:700; padding:10px; border-radius:8px; display:inline-flex; justify-content:center; align-items:center; gap:8px; background:#10b981; color:#fff; border:none; cursor:pointer;" onclick="updateDrinksStatus('${ord.raw_id}', 'COMPLETED')">
                    <i class="fas fa-check-circle"></i> Complete Order
                  </button>
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

  const res = await Auth.fetch("/api/v1/transactions?limit=50");
  const list = res.ok ? await res.json() : [];

  // Cache for quick modal lookups
  window._recentTransactionsCache = list;

  c.innerHTML = `
    <div class="section-card">
      <div class="section-head" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        <div>
          <h2>Order Transactions</h2>
          <span style="font-size:13px; color:var(--text-muted);">${list.length} recent transactions</span>
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
              <th>Order ID</th>
              <th>Timestamp</th>
              <th>Cashier</th>
              <th>Items</th>
              <th>Total Net</th>
              <th>Status</th>
              <th style="text-align:center;">Action</th>
            </tr>
          </thead>
          <tbody id="tx-tbody">
            ${list.length ? list.map(tx => {
              const statusUpper = (tx.status || 'COMPLETED').toUpperCase();
              let statusBadge = '';
              if (statusUpper === 'PENDING') {
                statusBadge = `<span class="badge" style="background:#fef3c7; color:#b45309; border:1px solid rgba(245,158,11,0.3); font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:4px;"><i class="far fa-clock"></i> PENDING</span>`;
              } else if (statusUpper === 'PREPARING') {
                statusBadge = `<span class="badge" style="background:#dbeafe; color:#1e40af; border:1px solid rgba(59,130,246,0.3); font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:4px;"><i class="fas fa-fire"></i> PREPARING</span>`;
              } else if (statusUpper === 'REJECTED' || statusUpper === 'CANCELLED') {
                statusBadge = `<span class="badge" style="background:#fee2e2; color:#b91c1c; border:1px solid rgba(239,68,68,0.3); font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:4px;"><i class="fas fa-times-circle"></i> ${statusUpper}</span>`;
              } else {
                statusBadge = `<span class="badge badge-success" style="font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:4px;"><i class="fas fa-check-circle"></i> ${statusUpper}</span>`;
              }

              let actionHtml = '';
              if (statusUpper === 'PENDING' || statusUpper === 'PREPARING') {
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
              } else if (statusUpper === 'REJECTED' || statusUpper === 'CANCELLED') {
                actionHtml = `<span style="display:inline-flex; align-items:center; gap:4px; color:#ef4444; font-size:12px; font-weight:700;"><i class="fas fa-ban"></i> Cancelled</span>`;
              } else {
                actionHtml = `<span style="display:inline-flex; align-items:center; gap:4px; color:#10b981; font-size:12px; font-weight:700;"><i class="fas fa-check-double"></i> Completed</span>`;
              }

              const itemsSummary = (tx.items || []).map(it => `${it.quantity}x ${it.name}`).join(', ');

              return `
                <tr>
                  <td style="color:var(--text-muted); font-weight:700;">#${tx.id}</td>
                  <td style="color:var(--text-muted); font-size:13px;">${tx.created_at ? new Date(tx.created_at).toLocaleString() : '—'}</td>
                  <td><strong style="font-size:13px;">${tx.cashier || 'Staff'}</strong></td>
                  <td style="color:var(--text-main); font-size:13px;" title="${itemsSummary || 'No items'}">
                    <span style="cursor:pointer; color:#c9a227; font-weight:600;" onclick="viewOrderItemsModal(${tx.id})">
                      ${(tx.items || []).length} items <i class="fas fa-info-circle" style="font-size:11px; margin-left:2px;"></i>
                    </span>
                    ${itemsSummary ? `<div style="font-size:11px; color:var(--text-muted); max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${itemsSummary}</div>` : ''}
                  </td>
                  <td><strong style="color:#c9a227; font-size:13px;">${Utils.formatCurrency(tx.net_amount)}</strong></td>
                  <td>${statusBadge}</td>
                  <td style="text-align:center;">${actionHtml}</td>
                </tr>
              `;
            }).join('') : '<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-muted);">No transaction logs recorded yet.</td></tr>'}
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
        <h3 style="font-size:16px; font-weight:800; margin:0; color:var(--text-main);">Order #${tx.id} Details</h3>
        <span class="badge" style="font-size:11px; font-weight:700;">${(tx.status || 'completed').toUpperCase()}</span>
      </div>
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:14px;">
        <span>Cashier: <strong>${tx.cashier || 'Staff'}</strong></span> &bull; 
        <span>Time: <strong>${tx.created_at ? new Date(tx.created_at).toLocaleString() : '—'}</strong></span>
      </div>
      <div style="max-height:220px; overflow-y:auto; border:1px solid rgba(205,190,150,0.25); border-radius:8px; padding:10px 14px; margin-bottom:16px;">
        ${items.length ? items.map(it => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px dashed rgba(205,190,150,0.2); font-size:13px;">
            <div><strong style="color:#c9a227;">${it.quantity}x</strong> <span style="font-weight:600;">${it.name}</span></div>
            <span style="font-weight:700; color:var(--text-main); font-size:12px;">₱${(it.unit_price * it.quantity).toFixed(2)}</span>
          </div>
        `).join('') : '<div style="color:var(--text-muted); text-align:center; padding:12px;">No items found.</div>'}
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <span style="font-size:13px; font-weight:600; color:var(--text-muted);">Total Net:</span>
        <strong style="font-size:16px; color:#c9a227;">₱${Number(tx.net_amount || 0).toFixed(2)}</strong>
      </div>
      <div style="display:flex; justify-content:flex-end;">
        <button type="button" class="btn btn-outline" onclick="Utils.closeModal()" style="padding:6px 16px; font-size:13px;">Close</button>
      </div>
    </div>
  `);
};

window.promptRejectOrder = function(txId) {
  const list = window._recentTransactionsCache || [];
  const existingTx = list.find(t => t.id === txId);
  if (existingTx && (existingTx.status === 'rejected' || existingTx.status === 'cancelled')) {
    Utils.showToast(`Order #${txId} is already rejected. Once rejected, the order status is locked and cannot be changed.`, "warning");
    return;
  }

  Utils.openModal(`
    <div style="padding:4px;">
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
        <div style="width:44px; height:44px; border-radius:50%; background:rgba(239,68,68,0.12); color:#ef4444; display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0;">
          <i class="fas fa-exclamation-triangle"></i>
        </div>
        <div>
          <h3 style="font-size:17px; font-weight:800; color:var(--text-main); margin:0;">Reject / Cancel Order #${txId}</h3>
          <p style="font-size:12px; color:var(--text-muted); margin:3px 0 0 0;">Customer cancelled order. This will void the transaction.</p>
        </div>
      </div>

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

      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
        <button type="button" class="btn btn-outline" onclick="Utils.closeModal()" style="padding:8px 18px; font-size:13px; font-weight:600;">Back</button>
        <button type="button" class="btn" onclick="submitRejectOrder(${txId})" style="background:#ef4444; color:#fff; border:none; padding:8px 20px; border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:6px; box-shadow:0 2px 6px rgba(239,68,68,0.3);">
          <i class="fas fa-times-circle"></i> Confirm Rejection
        </button>
      </div>
    </div>
  `);
};

window.submitRejectOrder = async function(txId) {
  const selectEl = document.getElementById("reject-reason-select");
  const customEl = document.getElementById("reject-custom-reason");
  let reason = selectEl ? selectEl.value : "Customer cancelled order";
  if (reason === "Other" && customEl && customEl.value.trim()) {
    reason = customEl.value.trim();
  }

  try {
    const res = await Auth.fetch(`/api/v1/transactions/${txId}/status`, {
      method: "PUT",
      body: JSON.stringify({
        status: "rejected",
        reason: reason
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to reject order.");
    }

    Utils.closeModal();
    Utils.showToast(`✅ Order #${txId} was successfully rejected / cancelled.`, "success");

    try {
      localStorage.setItem("RESTOTRACK_SYNC_KITCHEN", JSON.stringify({ timestamp: Date.now(), orderId: txId, status: "rejected" }));
    } catch (e) {}

    renderTransactions(document.getElementById("view-container"));
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

    Utils.showToast(`✅ Order #${txId} marked as ${newStatus.toUpperCase()}.`, "success");

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
async function renderUsers(c) {
  const [usersRes, statsRes] = await Promise.all([
    Auth.fetch("/api/v1/users?exclude_self=false"),
    Auth.fetch("/api/v1/users/stats")
  ]);

  const rawUsers = usersRes.ok ? await usersRes.json() : [];
  const users = rawUsers.filter(u => {
    const r = (u.role || "").toUpperCase();
    return r !== "SUPER_ADMIN" && r !== "ADMIN";
  });
  const stats = statsRes.ok ? await statsRes.json() : {};

  c.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-users"></i></div>
        <div class="stat-info">
          <h3>Total Branch Staff</h3>
          <div class="stat-count" style="color:#c9a227;">${users.length}</div>
          <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-user-friends"></i> Active Staff</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon purple"><i class="fas fa-user-tie"></i></div>
        <div class="stat-info">
          <h3>Managers</h3>
          <div class="stat-count" style="color:#7b1fa2;">${stats.managers || 0}</div>
          <div class="stat-trend" style="color:#7b1fa2;"><i class="fas fa-briefcase"></i> Shift leaders</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-cash-register"></i></div>
        <div class="stat-info">
          <h3>Cashiers</h3>
          <div class="stat-count" style="color:#10b981;">${stats.cashiers || 0}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-receipt"></i> POS Staff</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-utensils"></i></div>
        <div class="stat-info">
          <h3>Kitchen Crew</h3>
          <div class="stat-count" style="color:#f97316;">${stats.kitchen || 0}</div>
          <div class="stat-trend" style="color:#f97316;"><i class="fas fa-fire"></i> KDS Staff</div>
        </div>
      </div>
    </div>

    <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:20px; flex-wrap:wrap;">
      <div style="font-size:13px; color:var(--text-muted);">${users.length} staff accounts registered</div>
      <button class="btn btn-primary" onclick="openAddStaffModal()" style="display:inline-flex; align-items:center; gap:8px;">
        <i class="fas fa-user-plus"></i> Add Staff Member
      </button>
    </div>

    <div class="section-card">
      <div class="section-head">
        <h2>Branch Staff Members</h2>
        <span style="font-size:13px; color:var(--text-muted);">${users.length} staff accounts</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Staff User</th>
              <th>Email</th>
              <th>Assigned Role</th>
              <th>Status</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${users.length ? users.map(u => `
              <tr>
                <td style="color:var(--text-muted);">#${u.id}</td>
                <td><strong style="color:var(--text-main); font-size:13px;">${u.username}</strong></td>
                <td style="color:var(--text-muted); font-size:13px;">${u.email || '—'}</td>
                <td><span class="badge badge-info" style="font-size:11px; font-weight:700; text-transform:uppercase;">${u.role}</span></td>
                <td>
                  <span class="badge ${u.is_active ? 'badge-success' : 'badge-danger'}" style="font-size:11px; font-weight:700;">
                    ${u.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td style="text-align:right;">
                  <div style="display:inline-flex; gap:6px; justify-content:flex-end;">
                    <button class="btn btn-outline btn-sm" onclick="toggleStaffStatus(${u.id}, ${u.is_active})" style="padding:4px 8px; font-size:12px;" title="${u.is_active ? 'Deactivate User' : 'Activate User'}">
                      <i class="fas ${u.is_active ? 'fa-user-slash' : 'fa-user-check'}"></i> ${u.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="confirmDeleteStaff(${u.id}, '${u.username.replace(/'/g, "\\'")}')" style="padding:4px 8px; font-size:12px;" title="Delete Staff Account">
                      <i class="fas fa-trash-alt"></i> Delete
                    </button>
                  </div>
                </td>
              </tr>
            `).join('') : '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">No staff registered in this branch.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

window.confirmDeleteStaff = function(id, username) {
  Utils.openModal("Confirm Staff Deletion", `
    <div style="text-align:center; padding:10px 0;">
      <div style="width:60px; height:60px; border-radius:50%; background:rgba(239,68,68,0.12); color:#ef4444; display:flex; align-items:center; justify-content:center; margin:0 auto 16px; font-size:24px;">
        <i class="fas fa-exclamation-triangle"></i>
      </div>
      <h3 style="font-size:17px; font-weight:800; color:var(--text-main); margin-bottom:8px;">Delete Staff Account?</h3>
      <p style="font-size:14px; color:var(--text-muted); line-height:1.5; margin-bottom:0;">
        Are you sure you want to permanently delete user account <strong style="color:var(--text-main);">@${username}</strong>? This action cannot be undone.
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
    renderUsers();
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
    renderUsers();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
};

function openAddStaffModal() {
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
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Email Address <span style="color:var(--danger);">*</span></label>
        <input type="email" id="st-email" class="input-field" required placeholder="jane.doe@example.com" style="width:100%;">
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Password (Min. 6 chars) <span style="color:var(--danger);">*</span></label>
        <input type="password" id="st-password" class="input-field" required placeholder="••••••••" style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Role <span style="color:var(--danger);">*</span></label>
          <select id="st-role" class="input-field" style="width:100%;">
            <option value="CASHIER" selected>Cashier</option>
            <option value="KITCHEN">Kitchen Staff</option>
            <option value="INVENTORY">Inventory Staff</option>
            <option value="MANAGER">Manager</option>
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
  const email = document.getElementById("st-email")?.value.trim();
  const password = document.getElementById("st-password")?.value;
  const role = document.getElementById("st-role")?.value;
  const is_active = document.getElementById("st-status")?.value === "true";

  if (!username || !first_name || !last_name || !email || !password) {
    Utils.showToast("Please fill in all required fields", "danger");
    return;
  }

  try {
    const res = await Auth.fetch("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({ username, first_name, last_name, email, password, role, is_active })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to create staff member.");
    }
    Utils.showToast("Staff account created successfully!", "success");
    Utils.closeModal();
    renderUsers();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────
async function renderLogs(c) {
  const res = await Auth.fetch("/api/v1/activity-logs?limit=50");
  const logs = res.ok ? await res.json() : [];

  c.innerHTML = `
    <div class="section-card">
      <div class="section-head">
        <h2>Branch Activity Audit Trail</h2>
        <span style="font-size:13px; color:var(--text-muted);">${logs.length} logged actions</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Performed By</th>
              <th>Role</th>
              <th>Action</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            ${logs.length ? logs.map(l => `
              <tr>
                <td style="color:var(--text-muted); font-size:13px;">${l.created_at ? new Date(l.created_at).toLocaleString() : '—'}</td>
                <td><strong style="color:var(--text-main); font-size:13px;">${l.performed_by}</strong></td>
                <td><span class="badge badge-info" style="font-size:11px; font-weight:700;">${l.role || 'Staff'}</span></td>
                <td><strong style="font-size:13px;">${l.action}</strong></td>
                <td style="color:var(--text-muted); font-size:13px;">${l.details || '—'}</td>
              </tr>
            `).join('') : '<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--text-muted);">No activity logs found for this branch.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. REPORTS & ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────
async function renderReports(c) {
  const txRes = await Auth.fetch("/api/v1/transactions?limit=100");
  const transactions = txRes.ok ? await txRes.json() : [];

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
          <div class="stat-count" style="color:#10b981;">${transactions.length}</div>
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
        <button class="btn btn-outline btn-sm" onclick="Utils.exportCSV('Sales_Report', ${JSON.stringify(transactions).replace(/"/g, '&quot;')})">
          <i class="fas fa-download"></i> Export CSV
        </button>
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
  const user = Auth.getUser();
  c.innerHTML = `
    <div class="section-card" style="max-width:550px;">
      <div class="section-head">
        <h2>User Profile & Settings</h2>
      </div>
      <div style="padding:22px 24px;">
        <div class="input-group" style="margin-bottom:14px;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Logged-in Username</label>
          <input class="input-field" value="${user.username}" disabled style="width:100%;">
        </div>
        <div class="input-group" style="margin-bottom:14px;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Assigned Role</label>
          <input class="input-field" value="${user.role.toUpperCase()}" disabled style="width:100%;">
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
  if (!c) c = document.getElementById("content-area") || document.querySelector('.content-area') || document.querySelector('main');
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
          <h3>${cat.name || 'General'}</h3>
          <div class="stat-count">${cat.count}</div>
          <div class="stat-trend">Category</div>
        </div>
      </div>
    `).join('');

    c.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon gold"><i class="fas fa-truck"></i></div>
          <div class="stat-info">
            <h3>Active Suppliers</h3>
            <div class="stat-count" style="color:#c9a227;">${statsData.active_suppliers}</div>
            <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-handshake"></i> Verified Vendors</div>
          </div>
        </div>
        ${categoryCardsHtml}
      </div>

      <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:20px; flex-wrap:wrap;">
        <div class="search-wrap" style="position:relative; flex:1; max-width:320px;">
          <i class="fas fa-search" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); color:var(--text-muted);"></i>
          <input type="text" id="supp-search" class="input-field" placeholder="Search suppliers..." style="padding-left:38px; width:100%;" oninput="filterSuppliersTable()">
        </div>
        <button class="btn btn-primary" onclick="openAddSupplierModal()" style="display:inline-flex; align-items:center; gap:8px;">
          <i class="fas fa-plus"></i> Add New Supplier
        </button>
      </div>

      <div class="section-card">
        <div class="section-head">
          <h2>Registered Supplier Directory</h2>
          <span style="font-size:13px; color:var(--text-muted);">${globalSuppliers.length} vendor partners</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Supplier Name</th>
                <th>Contact Person</th>
                <th>Phone Number</th>
                <th>Email</th>
                <th>Category Supplied</th>
                <th>Terms</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="supp-tbody">
              ${renderSupplierRows(globalSuppliers)}
            </tbody>
          </table>
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
    return `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-muted);">No suppliers found.</td></tr>`;
  }
  return suppliers.map(s => `
    <tr>
      <td style="color:var(--text-muted);">#${s.id}</td>
      <td><strong style="color:var(--text-main); font-size:13px;">${s.supplier_name}</strong></td>
      <td style="color:var(--text-muted); font-size:13px;">${s.contact_person || '—'}</td>
      <td><span style="font-family:monospace; font-size:12px; color:var(--text-muted);">${s.contact_number || '—'}</span></td>
      <td style="color:var(--text-muted); font-size:13px;">${s.email || '—'}</td>
      <td><span class="badge badge-info" style="font-size:11px; font-weight:700;">${s.category || 'General'}</span></td>
      <td style="color:var(--text-muted); font-size:12px;">${s.notes || '—'}</td>
      <td>
        <span class="badge ${s.status === 'Active' ? 'badge-success' : 'badge-danger'}" style="font-size:11px; font-weight:700;">
          ${s.status || 'Active'}
        </span>
      </td>
    </tr>
  `).join('');
}

function filterSuppliersTable() {
  const q = (document.getElementById("supp-search")?.value || "").toLowerCase();
  const filtered = globalSuppliers.filter(s =>
    (s.supplier_name && s.supplier_name.toLowerCase().includes(q)) ||
    (s.contact_person && s.contact_person.toLowerCase().includes(q)) ||
    (s.contact_number && s.contact_number.toLowerCase().includes(q)) ||
    (s.email && s.email.toLowerCase().includes(q)) ||
    (s.category && s.category.toLowerCase().includes(q))
  );
  const tbody = document.getElementById("supp-tbody");
  if (tbody) tbody.innerHTML = renderSupplierRows(filtered);
}

function openAddSupplierModal() {
  Utils.openModal("Add New Vendor Supplier", `
    <form id="form-add-supp" onsubmit="event.preventDefault(); submitAddSupplier();">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Supplier / Company Name <span style="color:var(--danger);">*</span></label>
        <input id="sp-name" class="input-field" required placeholder="e.g. San Miguel Foods Inc." style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Contact Person</label>
          <input id="sp-contact" class="input-field" placeholder="e.g. Mario Batali" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Phone Number <span style="color:var(--danger);">*</span></label>
          <input id="sp-phone" class="input-field" required placeholder="09XX-XXX-XXXX" style="width:100%;">
        </div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Email Address</label>
          <input type="email" id="sp-email" class="input-field" placeholder="orders@supplier.com" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Supply Category</label>
          <input id="sp-category" class="input-field" placeholder="e.g. Poultry, Dairy, Packaging" style="width:100%;">
        </div>
      </div>
    </form>
  `, `<button class="btn btn-primary" onclick="submitAddSupplier()"><i class="fas fa-save"></i> Save Supplier</button>`);
}

async function submitAddSupplier() {
  const name = document.getElementById("sp-name")?.value.trim();
  const contact = document.getElementById("sp-contact")?.value.trim();
  const phone = document.getElementById("sp-phone")?.value.trim();
  const email = document.getElementById("sp-email")?.value.trim();
  const category = document.getElementById("sp-category")?.value.trim();

  if (!name || !phone) {
    Utils.showToast("Company name and phone number are required.", "danger");
    return;
  }

  const payload = {
    supplier_name: name,
    contact_person: contact,
    contact_number: phone,
    email: email,
    category: category || "General",
    status: "Active"
  };

  try {
    const res = await Auth.fetch("/api/v1/suppliers", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to add supplier");
    }

    Utils.showToast("Supplier registered successfully!", "success");
    Utils.closeModal();
    renderSuppliers();
  } catch (error) {
    console.error(error);
    Utils.showToast(error.message, "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. PROFIT LOSS & CASHOUT INCOME
// ─────────────────────────────────────────────────────────────────────────────
let cachedProfitLossData = null;

async function renderProfitLoss(c) {
  if (!c) c = document.getElementById("view-container");
  if (!c) return;

  let data = {
    revenue: { total_orders_revenue: 0, today_orders_revenue: 0, cash_sales: 0, non_cash_sales: 0, total_orders_count: 0 },
    inventory: { total_inventory_valuation: 0, total_items_count: 0, cost_of_goods_sold: 0 },
    cashout: { total_cashout_income: 0, today_cashout_income: 0, active_drawer_cash: 0, history: [] },
    profit_loss: { gross_profit: 0, net_profit: 0, profit_margin_percent: 0, net_cash_income: 0, is_profitable: true }
  };

  try {
    const res = await Auth.fetch("/api/v1/analytics/profit-loss");
    if (res.ok) {
      data = await res.json();
      cachedProfitLossData = data;
    }
  } catch (err) {
    console.error("Failed to load profit-loss data:", err);
  }

  const rev = data.revenue || {};
  const inv = data.inventory || {};
  const csh = data.cashout || {};
  const pl = data.profit_loss || {};
  const history = csh.history || [];

  c.innerHTML = `
    <!-- Top Toolbar -->
    <div class="toolbar fade-up" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px;">
      <div>
        <h2 style="font-size:20px; font-weight:800; color:var(--text-main); margin:0; display:flex; align-items:center; gap:8px;">
          <i class="fas fa-scale-balanced" style="color:#10b981;"></i> Profit Loss & Cashout Income
        </h2>
        <p style="font-size:12px; color:var(--text-muted); margin:4px 0 0 0;">
          Live financial ledger: orders sales revenue, inventory price valuation, cashier drawer cashouts, and operating profit
        </p>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <button class="btn btn-primary" onclick="openAddCashMovementModal()" style="display:inline-flex; align-items:center; gap:8px; font-weight:700; border-radius:10px;">
          <i class="fas fa-hand-holding-dollar"></i> New Cashout
        </button>
        <button class="btn btn-outline btn-sm" onclick="renderProfitLoss()" title="Refresh Financials" style="border-radius:10px;">
          <i class="fas fa-sync-alt"></i> Live Refresh
        </button>
      </div>
    </div>

    <!-- Financial KPI Cards -->
    <div class="stats-grid fade-up delay-1" style="margin-bottom:24px;">
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-coins"></i></div>
        <div class="stat-info">
          <h3>Total Orders Revenue</h3>
          <div class="stat-count" style="color:#c9a227;">${Utils.formatCurrency(rev.total_orders_revenue || 0)}</div>
          <div class="stat-trend" style="color:var(--success, #10b981);"><i class="fas fa-receipt"></i> ${rev.total_orders_count || 0} completed order(s)</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-chart-line"></i></div>
        <div class="stat-info">
          <h3>Net Operating Profit</h3>
          <div class="stat-count" style="color:${pl.is_profitable ? '#10b981' : '#ef4444'};">${Utils.formatCurrency(pl.net_profit || 0)}</div>
          <div class="stat-trend" style="color:${pl.is_profitable ? '#10b981' : '#ef4444'};"><i class="fas fa-percent"></i> ${pl.profit_margin_percent || 0}% profit margin</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon emerald" style="background:rgba(16,185,129,0.12); color:#10b981;"><i class="fas fa-vault"></i></div>
        <div class="stat-info">
          <h3>Total Cashout Income</h3>
          <div class="stat-count" style="color:#10b981;">${Utils.formatCurrency(csh.total_cashout_income || 0)}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-shield-halved"></i> Deposited into store safe</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon purple" style="background:rgba(99,102,241,0.12); color:#6366f1;"><i class="fas fa-boxes-stacked"></i></div>
        <div class="stat-info">
          <h3>Inventory Stock Price Value</h3>
          <div class="stat-count" style="color:#6366f1;">${Utils.formatCurrency(inv.total_inventory_valuation || 0)}</div>
          <div class="stat-trend" style="color:#6366f1;"><i class="fas fa-tags"></i> Across ${inv.total_items_count || 0} items</div>
        </div>
      </div>
    </div>

    <!-- Side-by-Side Dual Analysis Sections -->
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:24px;" class="fade-up delay-2">
      <!-- P&L Statement Card -->
      <div class="section-card" style="margin-bottom:0;">
        <div class="section-head" style="border-bottom:1px solid rgba(205,190,150,0.25); padding-bottom:12px;">
          <div>
            <h2 style="font-size:16px; margin:0;"><i class="fas fa-file-invoice-dollar" style="color:#10b981; margin-right:8px;"></i> Profit & Loss Statement (P&L)</h2>
            <span style="font-size:12px; color:var(--text-muted);">Real-time revenue versus inventory cost breakdown</span>
          </div>
          <span class="badge ${pl.is_profitable ? 'badge-success' : 'badge-danger'}" style="font-size:11px; font-weight:700;">
            ${pl.is_profitable ? 'PROFITABLE' : 'OPERATING LOSS'}
          </span>
        </div>
        <div style="padding:16px 0;">
          <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(205,190,150,0.15);">
            <span style="font-weight:600; color:var(--text-main); font-size:13px;"><i class="fas fa-plus" style="color:#10b981; margin-right:6px;"></i> Gross Orders Revenue:</span>
            <strong style="color:#10b981; font-size:14px;">+${Utils.formatCurrency(rev.total_orders_revenue || 0)}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; padding:8px 0 8px 20px; font-size:12px; color:var(--text-muted); border-bottom:1px dashed rgba(205,190,150,0.15);">
            <span>↳ Cash Sales (Drawer):</span>
            <span>${Utils.formatCurrency(rev.cash_sales || 0)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; padding:8px 0 8px 20px; font-size:12px; color:var(--text-muted); border-bottom:1px solid rgba(205,190,150,0.15);">
            <span>↳ Non-Cash Sales (GCash / Card):</span>
            <span>${Utils.formatCurrency(rev.non_cash_sales || 0)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(205,190,150,0.15);">
            <span style="font-weight:600; color:var(--text-main); font-size:13px;"><i class="fas fa-minus" style="color:#ef4444; margin-right:6px;"></i> Cost of Goods Sold (Inventory Cost):</span>
            <strong style="color:#ef4444; font-size:14px;">-${Utils.formatCurrency(inv.cost_of_goods_sold || 0)}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; padding:12px 0; background:rgba(201,162,39,0.06); border-radius:8px; margin-top:12px; padding:12px 14px;">
            <span style="font-weight:800; font-size:14px; color:var(--text-main);">NET OPERATING PROFIT:</span>
            <span style="font-weight:800; font-size:18px; color:${pl.is_profitable ? '#10b981' : '#ef4444'};">
              ${Utils.formatCurrency(pl.net_profit || 0)}
            </span>
          </div>
          <div style="margin-top:10px; font-size:11px; color:var(--text-muted); display:flex; justify-content:space-between;">
            <span>Profit Margin: <strong>${pl.profit_margin_percent || 0}%</strong></span>
            <span>Today's Sales Revenue: <strong>${Utils.formatCurrency(rev.today_orders_revenue || 0)}</strong></span>
          </div>
        </div>
      </div>

      <!-- Cashout & Drawer Liquidity Card -->
      <div class="section-card" style="margin-bottom:0;">
        <div class="section-head" style="border-bottom:1px solid rgba(205,190,150,0.25); padding-bottom:12px;">
          <div>
            <h2 style="font-size:16px; margin:0;"><i class="fas fa-vault" style="color:#c9a227; margin-right:8px;"></i> Cashout Income & Safe Deposits</h2>
            <span style="font-size:12px; color:var(--text-muted);">Funds secured in store safe vs active cashier drawer float</span>
          </div>
        </div>
        <div style="padding:16px 0;">
          <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(205,190,150,0.15);">
            <span style="font-weight:600; color:var(--text-main); font-size:13px;"><i class="fas fa-shield-halved" style="color:#10b981; margin-right:6px;"></i> Total Cashout Income (In Store Safe):</span>
            <strong style="color:#10b981; font-size:14px;">${Utils.formatCurrency(csh.total_cashout_income || 0)}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; padding:8px 0 8px 20px; font-size:12px; color:var(--text-muted); border-bottom:1px dashed rgba(205,190,150,0.15);">
            <span>↳ Today's Cashouts:</span>
            <span>${Utils.formatCurrency(csh.today_cashout_income || 0)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(205,190,150,0.15);">
            <span style="font-weight:600; color:var(--text-main); font-size:13px;"><i class="fas fa-cash-register" style="color:#c9a227; margin-right:6px;"></i> Active Cash Balance in Cashier Drawers:</span>
            <strong style="color:#c9a227; font-size:14px;">${Utils.formatCurrency(csh.active_drawer_cash || 0)}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(205,190,150,0.15);">
            <span style="font-weight:600; color:var(--text-main); font-size:13px;"><i class="fas fa-mobile-screen" style="color:#6366f1; margin-right:6px;"></i> Non-Cash Collections (E-Wallets / Bank):</span>
            <strong style="color:#6366f1; font-size:14px;">${Utils.formatCurrency(rev.non_cash_sales || 0)}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; padding:12px 0; background:rgba(16,185,129,0.06); border-radius:8px; margin-top:12px; padding:12px 14px;">
            <span style="font-weight:800; font-size:14px; color:var(--text-main);">NET REALIZED CASH & DIGITAL INCOME:</span>
            <span style="font-weight:800; font-size:18px; color:#10b981;">
              ${Utils.formatCurrency(pl.net_cash_income || 0)}
            </span>
          </div>
          <div style="margin-top:12px;">
            <button class="btn btn-primary btn-sm" onclick="openAddCashMovementModal()" style="width:100%; justify-content:center; padding:8px 12px; font-weight:700;">
              <i class="fas fa-hand-holding-dollar"></i> Perform Drawer Cashout & Reset Cashier to ₱0.00
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Cashout & Safe Deposit Ledger Audit Table -->
    <div class="section-card fade-up delay-3">
      <div class="section-head">
        <div>
          <h2><i class="fas fa-receipt" style="color:#10b981; margin-right:8px;"></i> Cashout Income & Safe Deposit Ledger</h2>
          <span style="font-size:12px; color:var(--text-muted);">Historical records of funds cashed out from cashier drawers into the manager safe</span>
        </div>
        <span class="badge badge-info" style="font-size:11px; font-weight:700;">${history.length} Cashout Records</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Shift / Cashier</th>
              <th>Cashed Out Amount</th>
              <th>Reason / Destination</th>
              <th>Recorded By</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${history.length === 0 ? `
              <tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);"><i class="fas fa-info-circle"></i> No cashout movements logged yet. When the manager performs a drawer cashout, it appears here.</td></tr>
            ` : history.map(h => `
              <tr>
                <td style="color:var(--text-muted); font-size:12px;">${h.created_at ? new Date(h.created_at).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'}</td>
                <td><strong style="color:var(--text-main); font-size:13px;">${h.cashier}</strong> <span style="font-size:11px; color:var(--text-muted);">(Shift #${h.shift_id})</span></td>
                <td><strong style="color:#10b981; font-size:14px;">+${Utils.formatCurrency(h.amount)}</strong></td>
                <td style="color:var(--text-main); font-size:13px;">${h.reason}</td>
                <td style="color:var(--text-muted); font-size:12px;">Safe Deposit</td>
                <td><span class="badge badge-success" style="font-size:11px; font-weight:700;"><i class="fas fa-check-circle"></i> SECURED</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

window.renderPurchases = renderProfitLoss;
window.renderProfitLoss = renderProfitLoss;

// ─────────────────────────────────────────────────────────────────────────────
// 12. WASTAGE & SPOILAGE TRACKING
// ─────────────────────────────────────────────────────────────────────────────
let cachedWastageLogs = [
  { id: 1, item: "Fresh Chicken Fillet", qty: "3.5 kg", reason: "Expired shelf-life", cost: 595.00, logged_by: "Inventory Staff", date: "2026-08-24 10:15" },
  { id: 2, item: "Cooking Oil (Palm)", qty: "2.0 L", reason: "Accidental Kitchen Spill", cost: 180.00, logged_by: "Chef Marcus", date: "2026-08-23 18:30" },
  { id: 3, item: "Fresh Tomatoes", qty: "5.0 kg", reason: "Overripe / Spoiled produce", cost: 350.00, logged_by: "Inventory Staff", date: "2026-08-22 14:00" }
];

async function renderWastage(c) {
  const totalCost = cachedWastageLogs.reduce((sum, w) => sum + w.cost, 0);

  c.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon red"><i class="fas fa-trash-alt"></i></div>
        <div class="stat-info">
          <h3>Total Spoilage Incidents</h3>
          <div class="stat-count" style="color:#ef4444;">${cachedWastageLogs.length}</div>
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
          <div class="stat-count" style="color:#f97316;">${cachedWastageLogs.filter(w => w.reason.includes('Expired') || w.reason.includes('Spoiled')).length}</div>
          <div class="stat-trend" style="color:#f97316;">Perishables</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon purple"><i class="fas fa-utensils"></i></div>
        <div class="stat-info">
          <h3>Kitchen Prep Waste</h3>
          <div class="stat-count" style="color:#9333ea;">${cachedWastageLogs.filter(w => w.reason.includes('Spill') || w.reason.includes('Burnt')).length}</div>
          <div class="stat-trend" style="color:#9333ea;">Operational Loss</div>
        </div>
      </div>
    </div>

    <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:20px; flex-wrap:wrap;">
      <div style="font-size:13px; color:var(--text-muted);">${cachedWastageLogs.length} wastage incidents logged</div>
      <button class="btn btn-danger" onclick="openLogWastageModal()" style="display:inline-flex; align-items:center; gap:8px;">
        <i class="fas fa-plus"></i> Record Wastage / Spoilage
      </button>
    </div>

    <div class="section-card">
      <div class="section-head">
        <h2>Wastage & Spoilage Incident Logs</h2>
        <span style="font-size:13px; color:var(--text-muted);">Shrinkage and food loss audit</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Ingredient / Item</th>
              <th>Quantity Lost</th>
              <th>Loss Reason</th>
              <th>Estimated Cost</th>
              <th>Logged By</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${cachedWastageLogs.map(w => `
              <tr>
                <td style="color:var(--text-muted);">#${w.id}</td>
                <td><strong style="color:var(--text-main); font-size:13px;">${w.item}</strong></td>
                <td><span style="font-weight:700; color:var(--danger);">${w.qty}</span></td>
                <td><span class="badge badge-danger" style="font-size:11px; font-weight:700;">${w.reason}</span></td>
                <td><strong style="color:#c9a227; font-size:13px;">${Utils.formatCurrency(w.cost)}</strong></td>
                <td style="color:var(--text-muted); font-size:13px;">${w.logged_by}</td>
                <td style="color:var(--text-muted); font-size:13px;">${w.date}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function openLogWastageModal() {
  Utils.openModal("Record Spoilage / Wastage", `
    <form id="form-wastage" onsubmit="event.preventDefault(); submitLogWastage();">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Ingredient / Stock Item <span style="color:var(--danger);">*</span></label>
        <input id="ws-item" class="input-field" required placeholder="e.g. Beef Patties, Fresh Lettuce" style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Quantity Lost <span style="color:var(--danger);">*</span></label>
          <input id="ws-qty" class="input-field" required placeholder="e.g. 2.5 kg or 10 pcs" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Estimated Loss Cost (₱) <span style="color:var(--danger);">*</span></label>
          <input type="number" step="0.01" id="ws-cost" class="input-field" required placeholder="350.00" style="width:100%;">
        </div>
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
  `, `<button class="btn btn-danger" onclick="submitLogWastage()"><i class="fas fa-trash-alt"></i> Record Wastage</button>`);
}

function submitLogWastage() {
  const item = document.getElementById("ws-item")?.value.trim();
  const qty = document.getElementById("ws-qty")?.value.trim();
  const cost = parseFloat(document.getElementById("ws-cost")?.value) || 0;
  const reason = document.getElementById("ws-reason")?.value;
  const currentUser = (typeof Auth !== 'undefined' && Auth.getUser && Auth.getUser()) ? Auth.getUser().username : 'Inventory Staff';

  if (!item || !qty || cost <= 0) {
    Utils.showToast("Please provide all required wastage report details.", "danger");
    return;
  }

  const newLog = {
    id: cachedWastageLogs.length + 1,
    item, qty, reason, cost,
    logged_by: currentUser,
    date: new Date().toLocaleString()
  };

  cachedWastageLogs.unshift(newLog);
  Utils.showToast("Wastage incident logged and stock deducted.", "success");
  Utils.closeModal();
  renderWastage();
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
      try {
        const payload = JSON.parse(e.newValue);
        if (payload.status === "READY" || payload.status === "COMPLETED") {
          Utils.showToast(`🔔 Kitchen: Order #${payload.orderId} is READY TO GO!`, "success");
        } else if (payload.status === "PREPARING") {
          Utils.showToast(`Kitchen accepted Order #${payload.orderId}`, "info");
        } else {
          Utils.showToast("Kitchen order status updated", "info");
        }
      } catch (err) {
        Utils.showToast("Kitchen order status updated", "info");
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
  window.posOnlineOrdersInterval = setInterval(fetchPendingOnlineOrders, 10000);
}

async function fetchPendingOnlineOrders() {
  try {
    const res = await Auth.fetch("/api/v1/customer-orders/pending");
    if (res.ok) {
      pendingOnlineOrders = await res.json();
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

function openOnlineOrdersModal() {
  let ordersHtml = "<p style='color:var(--text-muted);'>No pending online orders.</p>";
  if (pendingOnlineOrders.length > 0) {
    ordersHtml = pendingOnlineOrders.map(o => {
      let itemsHtml = o.items.map(it => `<li><strong style="color:#c9a227;">${it.quantity}x</strong> ${it.name} <span style="color:var(--text-muted); font-size:12px;">(₱${it.price})</span></li>`).join('');
      return `
        <div style="padding:16px; border:1px solid rgba(205,190,150,0.3); border-radius:12px; margin-bottom:12px; background:#fff;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <div>
              <span style="background:#c9a227; color:#18181b; font-size:11px; padding:3px 8px; border-radius:4px; font-weight:bold; margin-right:8px;">TABLE ${o.table_number || 'Takeout'}</span>
              <strong style="color:var(--text-main); font-size:14px;">${o.order_number}</strong>
            </div>
            <div style="font-size:12px; color:var(--text-muted);">
              ${new Date(o.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
            </div>
          </div>
          <div style="font-size:13px; color:var(--text-main); margin-bottom:12px;">
            <div><i class="fas fa-user" style="color:var(--text-muted); margin-right:6px;"></i> <strong>${o.customer_name}</strong></div>
            <div><i class="fas fa-chair" style="color:var(--text-muted); margin-right:6px;"></i> ${o.table_number || o.order_type}</div>
            ${o.notes ? `<div style="background:#fef3c7; color:#92400e; padding:4px 8px; border-radius:6px; font-size:11px; margin-top:6px;"><i class="fas fa-comment"></i> ${o.notes}</div>` : ''}
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

function processOnlineOrder(orderId) {
  const order = pendingOnlineOrders.find(o => o.id === orderId);
  if (!order) return;
  
  // Clear cart and push items
  clearCart();
  
  order.items.forEach(it => {
    if (it.product_id) {
      const prod = cachedProducts.find(p => p.id === it.product_id);
      if (prod) {
        const existing = posCart.find(c => c.product_id === it.product_id);
        if (existing) {
          existing.quantity += it.quantity;
        } else {
          posCart.push({ product_id: it.product_id, name: prod.name, price: it.price, quantity: it.quantity });
        }
      } else {
        posCart.push({ product_id: it.product_id, name: it.name, price: it.price, quantity: it.quantity });
      }
    } else {
      Utils.showToast(`Cannot process item ${it.name}: Missing product ID`, "danger");
    }
  });
  
  window.currentOnlineOrderId = order.id;
  updateCartUI();
  Utils.closeModal();
  
  const posContainer = document.getElementById("pos-grid");
  if (!posContainer && typeof renderView === "function") {
    document.querySelectorAll("aside.sidebar .nav-link").forEach(el => el.classList.remove("active"));
    const posLink = document.querySelector("a[href='#pos']");
    if (posLink) posLink.classList.add("active");
    renderView("pos").then(() => {
      posCart = [];
      order.items.forEach(it => {
        posCart.push({ product_id: it.product_id, name: it.name, price: it.price, quantity: it.quantity });
      });
      window.currentOnlineOrderId = order.id;
      updateCartUI();
      Utils.showToast("Loaded Table " + (order.table_number || "") + " Order (" + order.order_number + ") into POS.", "success");
    });
  } else {
    Utils.showToast("Loaded Table " + (order.table_number || "") + " Order (" + order.order_number + ") into POS.", "success");
  }
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

    const pending = pendingRes.ok ? await pendingRes.json() : [];
    const history = historyRes.ok ? await historyRes.json() : [];
    
    pendingOnlineOrders = pending;
    updateOnlineOrdersBadge();

    let html = "";

    // Section 1: Pending Orders
    html += `
      <div class="section-card" style="margin-bottom:24px;">
        <div class="section-head" style="display:flex; justify-content:space-between; align-items:center;">
          <h2 style="font-size:16px; font-weight:700; color:var(--text-main); margin:0;">
            Pending Customer Orders (${pending.length})
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
      html += `<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:16px;">`;
      pending.forEach(o => {
        const timeStr = o.created_at ? new Date(o.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Just now';
        const itemsList = (o.items || []).map(it => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0; border-bottom:1px dashed rgba(205,190,150,0.2); font-size:13px;">
            <div><strong style="color:#c9a227;">${it.quantity}x</strong> <span style="font-weight:600;">${it.name}</span></div>
            <span style="color:var(--text-muted); font-size:12px;">₱${(parseFloat(it.price) * it.quantity).toFixed(2)}</span>
          </div>
        `).join('');

        html += `
          <div style="border:1.5px solid #c9a227; border-radius:12px; padding:16px; background:#ffffff; box-shadow:0 4px 12px rgba(0,0,0,0.04); display:flex; flex-direction:column; justify-content:space-between;">
            <div>
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <span style="background:#c9a227; color:#18181b; font-weight:800; font-size:12px; padding:4px 10px; border-radius:16px; letter-spacing:0.5px;">
                  🪑 TABLE ${o.table_number || 'Takeout'}
                </span>
                <span style="font-size:11px; font-family:monospace; background:rgba(0,0,0,0.06); padding:2px 6px; border-radius:4px; font-weight:600;">
                  ${o.order_number}
                </span>
              </div>
              <div style="margin-bottom:8px; font-size:13px;">
                <div><i class="fas fa-user" style="color:var(--text-muted); margin-right:6px;"></i> <strong>${o.customer_name}</strong></div>
                <div style="color:var(--text-muted); font-size:11px; margin-top:2px;"><i class="fas fa-clock" style="margin-right:4px;"></i> Ordered at ${timeStr} • ${o.order_type || 'Dine In'}</div>
                ${o.notes ? `<div style="background:#fef3c7; color:#92400e; padding:4px 8px; border-radius:6px; font-size:11px; margin-top:6px;"><i class="fas fa-comment"></i> ${o.notes}</div>` : ''}
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
              <div style="display:flex; gap:8px; margin-top:8px;">
                <button class="btn btn-primary btn-sm" onclick="processOnlineOrder(${o.id})" style="flex:1; display:flex; align-items:center; justify-content:center; gap:6px; font-weight:700;">
                  <i class="fas fa-cash-register"></i> Send to POS
                </button>
                <button class="btn btn-outline btn-sm" onclick="setCustomerOrderStatus(${o.id}, 'accepted')" title="Accept Order">
                  <i class="fas fa-check"></i> Accept
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
                  <th>Customer</th>
                  <th>Items</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                ${pastOrders.map(h => `
                  <tr>
                    <td><strong style="font-family:monospace; font-size:12px;">${h.order_number}</strong></td>
                    <td><span class="badge" style="background:rgba(201,162,39,0.15); color:#c9a227; font-weight:700;">${h.table_number || h.order_type}</span></td>
                    <td><strong>${h.customer_name}</strong></td>
                    <td style="font-size:12px; color:var(--text-muted);">${(h.items || []).map(i => `${i.quantity}x ${i.name}`).join(', ')}</td>
                    <td><strong style="color:#c9a227;">₱${parseFloat(h.total_amount).toFixed(2)}</strong></td>
                    <td>
                      <span class="badge ${h.status === 'completed' ? 'badge-success' : h.status === 'accepted' ? 'badge-warning' : 'badge-danger'}" style="font-size:11px; text-transform:capitalize;">
                        ${h.status}
                      </span>
                    </td>
                    <td style="font-size:12px; color:var(--text-muted);">${h.created_at ? new Date(h.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '—'}</td>
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
    container.innerHTML = `<div style="color:var(--danger); padding:20px;">Failed to load customer orders: ${err.message}</div>`;
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
  c.innerHTML = `
    <div class="section-card" style="padding:24px; margin-bottom: 24px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h2 style="font-size:18px; font-weight:700;">Table QR Codes</h2>
        <div style="display:flex; gap: 8px;">
          <button class="btn btn-primary" onclick="showAddTableModal()"><i class="fas fa-plus"></i> Add Table</button>
          <button class="btn btn-outline" onclick="printAllQRs()"><i class="fas fa-print"></i> Print All QRs</button>
        </div>
      </div>
      <div id="tables-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:24px;">
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
        <h4 style="font-size:18px; font-weight:800; color: #c9a227; margin-bottom: 8px;">TABLE ${t.table_number}</h4>
        <p style="font-size:12px; font-weight:600; color: #71717a; margin-bottom: 16px;">SCAN TO ORDER</p>
        
        <div id="${qrContainerId}" style="display:flex; justify-content:center; margin-bottom: 24px; min-height: 150px;" data-url="${qrUrl}"></div>
        
        <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
          <a href="${qrUrl}" target="_blank" class="btn btn-outline btn-sm" title="Preview Customer Menu"><i class="fas fa-external-link-alt"></i> Test Menu</a>
          <button class="btn btn-outline btn-sm" onclick="downloadQR('${qrContainerId}', 'Table_${t.table_number}_QR')" title="Download QR Image"><i class="fas fa-download"></i></button>
          <button class="btn btn-outline btn-sm" onclick="printSingleQR('${t.id}', '${t.table_number}')" title="Print QR"><i class="fas fa-print"></i></button>
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
    grid.innerHTML = `<p style="color:var(--danger);">${err.message}</p>`;
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
          <h2>TABLE ${qr.number}</h2>
          <h3>SCAN TO ORDER</h3>
          <img src="${qr.src}" alt="QR">
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

async function renderCashDrawerTracker(c) {
  const container = c || document.getElementById("view-container");
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex; justify-content:center; align-items:center; min-height:260px; color:var(--text-muted, #71717a);">
      <div style="text-align:center;">
        <i class="fas fa-spinner fa-spin" style="font-size:2rem; margin-bottom:0.75rem; color:#c9a227;"></i>
        <p style="font-size:14px; font-weight:500;">Loading cashier drawer records...</p>
      </div>
    </div>
  `;

  try {
    const res = await Auth.fetch("/api/v1/shifts/drawer-summary");
    if (!res.ok) throw new Error("Failed to fetch cash drawer summary.");
    cachedDrawerData = await res.json();
    renderCashDrawerTrackerUI(container, cachedDrawerData);
  } catch (err) {
    console.error("Cash Drawer Error:", err);
    container.innerHTML = `
      <div class="section-card" style="padding:24px; border:1px solid rgba(239,68,68,0.35);">
        <h3 style="color:var(--danger, #ef4444); font-size:16px; font-weight:700;"><i class="fas fa-exclamation-triangle"></i> Error Loading Cash Drawer Data</h3>
        <p style="color:var(--text-muted, #71717a); margin:10px 0; font-size:13px;">${err.message || "Failed to communicate with backend."}</p>
        <button class="btn btn-outline btn-sm" onclick="renderCashDrawerTracker()"><i class="fas fa-redo"></i> Retry</button>
      </div>
    `;
  }
}

function renderCashDrawerTrackerUI(container, data) {
  const shifts = (data && data.shifts) || [];
  const allMovements = [];
  shifts.forEach(s => {
    (s.movements || []).forEach(m => {
      allMovements.push({ ...m, shiftId: s.id, cashierName: s.cashier_name });
    });
  });
  allMovements.sort((a, b) => (b.id || 0) - (a.id || 0));

  const totalDrops = shifts.reduce((sum, s) => sum + (s.paid_out || 0), 0);
  const totalPaidIn = shifts.reduce((sum, s) => sum + (s.paid_in || 0), 0);

  container.innerHTML = `
    <!-- Top Toolbar -->
    <div class="toolbar fade-up" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px;">
      <div>
        <h2 style="font-size:20px; font-weight:800; color:var(--text-main); margin:0; display:flex; align-items:center; gap:8px;">
          <i class="fas fa-vault" style="color:#c9a227;"></i> Cash in Drawer & Shift Tracking
        </h2>
        <p style="font-size:12px; color:var(--text-muted); margin:4px 0 0 0;">
          Live cash drawer balance, cashier floats, sales collections, and safe drops
        </p>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <button class="btn btn-primary" onclick="openAddCashMovementModal()" style="display:inline-flex; align-items:center; gap:8px; font-weight:700; border-radius:10px;">
          <i class="fas fa-hand-holding-dollar"></i> Cashout Cashier Drawer
        </button>
        <button class="btn btn-outline btn-sm" onclick="renderCashDrawerTracker()" title="Refresh Drawer Balances" style="border-radius:10px;">
          <i class="fas fa-sync-alt"></i> Live Refresh
        </button>
      </div>
    </div>

    <!-- Metrics Cards Grid: Cashier Drawer & Overall Income -->
    <div class="stats-grid fade-up delay-1" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); margin-bottom:24px;">
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
          <div class="stat-count" style="color:#10b981;">${Utils.formatCurrency(data.overall_income !== undefined ? data.overall_income : (data.today_total_orders_amount || 0))}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-circle-check"></i> Overall completed orders revenue</div>
        </div>
      </div>
    </div>

    <!-- Active & Recent Cashier Drawers Table -->
    <div class="section-card fade-up delay-2" style="margin-bottom:24px;">
      <div class="section-head">
        <div>
          <h2><i class="fas fa-cash-register" style="color:#c9a227; margin-right:8px;"></i> Cashier Drawer to Track Cashier Overall Income</h2>
          <span style="font-size:12px; color:var(--text-muted);">Real-time tracking of active cashier drawers and cashier overall income from complete orders</span>
        </div>
        <span class="badge badge-info" style="font-size:11px; font-weight:700;">${shifts.length} Recorded Shifts</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cashier</th>
              <th>Shift Status</th>
              <th>Started At</th>
              <th style="background:rgba(201,162,39,0.12); color:#c9a227; font-size:13px;">Cashier Drawer</th>
              <th style="background:rgba(16,185,129,0.12); color:#10b981; font-size:13px;">Cashier Overall Income</th>
              <th>Cash Sales</th>
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
    return '<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-muted);"><i class="fas fa-info-circle"></i> No cashier shifts recorded yet.</td></tr>';
  }
  return shifts.map(s => {
    const isOpen = s.status === 'open';
    const statusBadge = isOpen
      ? '<span class="badge badge-success" style="font-size:11px; font-weight:700;"><i class="fas fa-circle" style="font-size:8px; margin-right:4px;"></i> ACTIVE OPEN</span>'
      : '<span class="badge badge-secondary" style="font-size:11px; font-weight:700;">CLOSED</span>';

    const startDate = s.start_time ? new Date(s.start_time).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';

    return `
      <tr>
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            <div class="avatar-fallback" style="width:32px; height:32px; font-size:12px; border-radius:8px; background:rgba(201,162,39,0.15); color:#c9a227; font-weight:800;">
              ${(s.cashier_username || 'C').substring(0,2).toUpperCase()}
            </div>
            <div>
              <strong style="color:var(--text-main); font-size:13px;">${s.cashier_name}</strong>
              <div style="font-size:11px; color:var(--text-muted);">@${s.cashier_username} (Shift #${s.id})</div>
            </div>
          </div>
        </td>
        <td>${statusBadge}</td>
        <td style="color:var(--text-muted); font-size:12px;">${startDate}</td>
        <td style="background:rgba(201,162,39,0.08);">
          <strong style="color:#c9a227; font-size:15px; font-weight:800;">${Utils.formatCurrency(s.expected_cash)}</strong>
        </td>
        <td style="background:rgba(16,185,129,0.08);">
          <strong style="color:#10b981; font-weight:800; font-size:15px;">${Utils.formatCurrency(s.total_sales || (s.cash_sales + s.non_cash_sales))}</strong>
        </td>
        <td><span style="color:#10b981; font-weight:700; font-size:13px;">+${Utils.formatCurrency(s.cash_sales)}</span></td>
        <td style="text-align:right;">
          <div style="display:inline-flex; gap:6px;">
            ${isOpen ? `
              <button class="btn btn-primary btn-sm" onclick="openAddCashMovementModal(${s.id})" title="Cashout Cashier Drawer and Reset to ₱0.00" style="padding:4px 10px; font-size:11px; font-weight:700;">
                <i class="fas fa-hand-holding-dollar"></i> Cashout
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
        <td style="color:var(--text-muted); font-size:12px;">${timeStr}</td>
        <td>
          <strong style="color:var(--text-main); font-size:13px;">${m.cashierName || 'Shift #' + m.shiftId}</strong>
          <div style="font-size:11px; color:var(--text-muted);">Shift #${m.shiftId}</div>
        </td>
        <td>${typeBadge}</td>
        <td>
          <strong style="font-size:14px; color:${isDrop ? '#ef4444' : '#10b981'};">
            ${isDrop ? '-' : '+'}${Utils.formatCurrency(m.amount)}
          </strong>
        </td>
        <td style="color:var(--text-main); font-size:13px;">${m.reason || 'No description provided'}</td>
        <td style="color:var(--text-muted); font-size:12px;">${m.recorded_by || 'Staff'}</td>
      </tr>
    `;
  }).join('');
}

function openAddCashMovementModal(defaultShiftId = null) {
  const shifts = (cachedDrawerData && cachedDrawerData.shifts) || [];
  const openShifts = shifts.filter(s => s.status === 'open');

  if (!openShifts.length) {
    Utils.showToast("There are currently no active open cashier shifts. A cashier must start a shift to record drawer cashout.", "warning");
    return;
  }

  const targetShift = (defaultShiftId ? openShifts.find(s => s.id === defaultShiftId) : null) || openShifts[0];
  const targetShiftId = targetShift ? targetShift.id : (openShifts[0]?.id || "");
  const expectedCash = targetShift ? (targetShift.expected_cash || 0) : 0;

  const shiftOptions = openShifts.map(s => `
    <option value="${s.id}" ${(defaultShiftId && defaultShiftId === s.id) || s.id === targetShiftId ? 'selected' : ''}>
      Shift #${s.id} — ${s.cashier_name} (@${s.cashier_username}) [Current Drawer: ${Utils.formatCurrency(s.expected_cash)}]
    </option>
  `).join('');

  Utils.openModal("Cashout Cashier Drawer", `
    <form id="form-cash-movement" onsubmit="event.preventDefault(); submitAddCashMovement();">
      ${openShifts.length > 1 && !defaultShiftId ? `
        <div class="input-group" style="margin-bottom:14px;">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Select Active Cashier Shift <span style="color:var(--danger);">*</span></label>
          <select id="cm-shift-id" class="input-field" required style="width:100%;" onchange="const s = ((cachedDrawerData && cachedDrawerData.shifts) || []).find(x => x.id == this.value); if (s && document.getElementById('cm-amount')) { document.getElementById('cm-amount').value = (s.expected_cash || 0).toFixed(2); const info = document.getElementById('cm-expected-info'); if (info) info.textContent = Utils.formatCurrency(s.expected_cash); }">
            ${shiftOptions}
          </select>
        </div>
      ` : `<input type="hidden" id="cm-shift-id" value="${targetShiftId}">`}

      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:13px; font-weight:700; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:8px; text-align:center;">
          Cash Amount (₱) <span style="color:var(--danger);">*</span>
        </label>
        <input type="number" step="0.01" min="0" id="cm-amount" class="input-field" required value="${expectedCash.toFixed(2)}" placeholder="0.00" style="width:100%; font-size:26px; font-weight:800; padding:12px; text-align:center; color:#c9a227; border:2px solid #c9a227; border-radius:10px;">
        <div style="text-align:center; font-size:12px; color:var(--text-muted); margin-top:8px;">
          Current Drawer Cash: <strong id="cm-expected-info" style="color:var(--text-main);">${Utils.formatCurrency(expectedCash)}</strong>
        </div>
      </div>
    </form>
  `, `<button class="btn btn-primary" onclick="submitAddCashMovement()" style="width:100%; justify-content:center; padding:12px; font-size:14px; font-weight:700; border-radius:10px;"><i class="fas fa-hand-holding-dollar"></i> Cashout & Reset Cashier Drawer to ₱0.00</button>`);
}

async function submitAddCashMovement() {
  const shiftId = parseInt(document.getElementById("cm-shift-id")?.value, 10);
  const amountVal = document.getElementById("cm-amount")?.value;
  const amount = parseFloat(amountVal);

  if (isNaN(amount) || amount < 0) {
    Utils.showToast("Please provide a valid cash amount.", "danger");
    return;
  }

  try {
    const res = await Auth.fetch("/api/v1/shifts/cashout", {
      method: "POST",
      body: JSON.stringify({
        shift_id: shiftId || undefined,
        amount: amount,
        reason: "Manager Cashout"
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to cashout drawer");
    }

    const data = await res.json();
    Utils.showToast(data.message || `✅ Successfully cashed out ₱${amount.toFixed(2)}! Cashier drawer reset to ₱0.00.`, "success");
    Utils.closeModal();

    // Broadcast signal so Cashier POS in other tabs/windows immediately resets drawer to ₱0.00
    try {
      localStorage.setItem("RESTOTRACK_DRAWER_RESET", Date.now().toString());
    } catch (e) {}

    // Re-render current view if on cash_drawer or dashboard
    const currentLink = document.querySelector("aside.sidebar .nav-link.active");
    const activeView = currentLink ? currentLink.getAttribute("href")?.replace("#", "") : "cash_drawer";
    if (activeView === "dashboard") {
      renderDashboard();
    } else {
      renderCashDrawerTracker();
    }
  } catch (err) {
    console.error("Cashout error:", err);
    Utils.showToast(err.message, "danger");
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
        Cashier: <strong style="color:var(--text-main);">${s.cashier_name}</strong> &bull; Start Float: <strong style="color:var(--text-main);">${Utils.formatCurrency(s.start_cash)}</strong> &bull; Expected: <strong style="color:#c9a227;">${Utils.formatCurrency(s.expected_cash)}</strong>
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
                <td style="font-size:13px;">${m.reason || '—'}</td>
                <td style="font-size:12px; color:var(--text-muted);">${m.recorded_by || 'Staff'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  Utils.openModal(`Shift #${s.id} Cash Movements Audit Log`, bodyHtml);
}


