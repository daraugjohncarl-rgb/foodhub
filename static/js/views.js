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

  try {
    switch (viewId) {
      case "dashboard":
        await renderDashboard(container);
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
      case "kitchen":
        await renderKitchen(container);
        break;
      case "transactions":
        await renderTransactions(container);
        break;
      case "suppliers":
        await renderSuppliers(container);
        break;
      case "purchases":
        await renderPurchases(container);
        break;
      case "wastage":
        await renderWastage(container);
        break;
      case "reports":
        await renderReports(container);
        break;
      case "users":
        await renderUsers(container);
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
  let stats = { today_sales: 0, total_transactions_today: 0, low_stock_count: 0, active_staff_count: 0 };
  let lowStockItems = [];

  try {
    const res = await Auth.fetch("/api/v1/analytics/dashboard");
    if (res.ok) stats = await res.json();
  } catch (e) {
    console.warn("Analytics endpoint unavailable, using defaults", e);
  }

  try {
    const invRes = await Auth.fetch("/api/v1/inventory?low_stock_only=true");
    if (invRes.ok) lowStockItems = await invRes.json();
  } catch (e) {}

  c.innerHTML = `
    <div class="stats-grid">
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
      <div class="stat-card">
        <div class="stat-icon red"><i class="fas fa-users"></i></div>
        <div class="stat-info">
          <h3>Active Branch Staff</h3>
          <div class="stat-count" style="color:#3b82f6;">${stats.active_staff_count || 0}</div>
          <div class="stat-trend" style="color:#3b82f6;"><i class="fas fa-user-check"></i> On shift / active</div>
        </div>
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
              <th>SKU</th>
              <th>Available Qty</th>
              <th>Min Stock Threshold</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${lowStockItems.length ? lowStockItems.map(item => `
              <tr>
                <td><strong style="color:var(--text-main); font-size:13px;">${item.name}</strong></td>
                <td style="color:var(--text-muted); font-size:13px;">${item.sku || 'N/A'}</td>
                <td><strong style="font-size:13px;">${item.quantity}</strong> <span style="font-size:12px; color:var(--text-muted);">${item.unit || ''}</span></td>
                <td style="color:var(--text-muted); font-size:13px;">${item.min_stock} ${item.unit || ''}</td>
                <td>
                  <span class="badge ${item.quantity <= 0 ? 'badge-danger' : 'badge-warning'}" style="font-size:11px; font-weight:700;">
                    ${item.quantity <= 0 ? 'Out of Stock' : 'Low Stock'}
                  </span>
                </td>
              </tr>
            `).join('') : '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:30px;"><i class="fas fa-check-circle" style="color:var(--success, #10b981); margin-right:6px;"></i> All inventory items are currently well-stocked.</td></tr>'}
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
    urgent_restock: [], category_summary: {}
  };

  const categories = [
    "ALL", "Kitchen", "Street Foods", "Coffee Bar", "Beverages", 
    "Packaging", "Cleaning Supplies", "Office Supplies and Equipments",
    "SAMGYUPSAL", "KITCHEN UTENSILS & EQUIPMENT", "FURNITURE & FIXTURES"
  ];

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

    <!-- Automated Analysis Banner & Urgent Restock Alerts -->
    ${cachedAnalytics.urgent_restock && cachedAnalytics.urgent_restock.length > 0 ? `
      <div class="section-card fade-up delay-1" style="margin-bottom:24px; border-left: 4px solid #f97316;">
        <div class="section-head" style="background:rgba(249,115,22,0.05); padding:14px 20px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <i class="fas fa-chart-pie" style="color:#f97316; font-size:18px;"></i>
            <h2 style="font-size:15px; margin:0;">Automated Restock & Shortage Analysis (${cachedAnalytics.urgent_restock.length} items prioritized)</h2>
          </div>
          <button class="btn btn-outline btn-sm" onclick="openUrgentRestockModal()" style="font-size:12px;">
            <i class="fas fa-list-check"></i> View Full Audit
          </button>
        </div>
        <div style="padding:16px 20px; overflow-x:auto;">
          <div style="display:flex; gap:12px; flex-wrap:wrap;">
            ${cachedAnalytics.urgent_restock.slice(0, 6).map(u => `
              <div style="background:#ffffff; border:1px solid rgba(205,190,150,0.3); border-radius:12px; padding:10px 14px; min-width:180px; flex:1; display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <div style="font-weight:700; font-size:13px; color:var(--text-main);">${u.name}</div>
                  <div style="font-size:11px; color:var(--text-muted);">${u.category} • Current: <strong style="color:#ef4444;">${u.quantity} ${u.unit}</strong></div>
                </div>
                <button class="btn btn-primary btn-sm" style="padding:4px 8px; font-size:11px;" onclick="openStockAdjustModal(${u.id}, '${u.name.replace(/'/g, "\\'")}', ${u.quantity})">
                  <i class="fas fa-plus"></i> Restock
                </button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    ` : ''}

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
              <th>SKU</th>
              <th>Current Stock</th>
              <th>Min Threshold</th>
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

    return `
      <tr>
        <td style="color:var(--text-muted); font-size:12px;">#${i.id}</td>
        <td><strong style="color:var(--text-main); font-size:13px;">${i.name}</strong></td>
        <td><span class="badge" style="background:rgba(201,162,39,0.12); color:#c9a227; font-size:11px; font-weight:600;">${catName}</span></td>
        <td style="color:var(--text-muted); font-size:12px; font-family:monospace;">${i.sku || '—'}</td>
        <td><strong style="font-size:14px; color:${isOut ? '#ef4444' : isLow ? '#f97316' : 'var(--text-main)'};">${i.quantity}</strong> <span style="font-size:11px; color:var(--text-muted);">${i.unit}</span></td>
        <td style="color:var(--text-muted); font-size:13px;">${i.min_stock} ${i.unit}</td>
        <td><span class="badge ${badgeClass}" style="font-size:11px; font-weight:700;">${badgeText}</span></td>
        <td style="text-align:right;">
          <div style="display:inline-flex; gap:6px;">
            <button class="btn btn-primary btn-sm" style="padding:4px 8px; font-size:11px;" onclick="openStockAdjustModal(${i.id}, '${i.name.replace(/'/g, "\\'")}', ${i.quantity})" title="Quick Restock / Adjust">
              <i class="fas fa-sliders-h"></i> Adjust
            </button>
            <button class="btn btn-outline btn-sm" style="padding:4px 8px; font-size:11px; color:var(--danger);" onclick="deleteInventoryItem(${i.id}, '${i.name.replace(/'/g, "\\'")}')" title="Delete Item">
              <i class="fas fa-trash"></i>
            </button>
          </div>
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
    { name: "Kitchen", icon: "fa-utensils", desc: "Rice, cooking oil, sauces, seasonings, meats, spices, burger buns" },
    { name: "Street Foods", icon: "fa-fire", desc: "Fish balls, squid balls, kikiam, hotdogs, lumpia wrappers, seasoning powders" },
    { name: "Coffee Bar", icon: "fa-mug-hot", desc: "Coffee powders, syrups, condense, creamer, matcha, boba, fruit powders" },
    { name: "Beverages", icon: "fa-wine-bottle", desc: "Bottled water, soft drinks, beers, spirits, liquor, canned beverages" },
    { name: "Packaging", icon: "fa-box", desc: "Cups, lids, plastic & paper bags, food containers, straws, cutlery" },
    { name: "Cleaning Supplies", icon: "fa-soap", desc: "Dishwashing liquid, bleach, disinfectant, alcohol, sponges, mops, trash bags" },
    { name: "Office Supplies and Equipments", icon: "fa-laptop", desc: "Paper, printer ink, office tools, stationery, desks, appliances, tech" },
    { name: "SAMGYUPSAL", icon: "fa-drumstick-bite", desc: "Pork belly, beef, kimchi, gochujang, grill pans, portable stoves, side dishes" },
    { name: "KITCHEN UTENSILS & EQUIPMENT", icon: "fa-kitchen-set", desc: "Gas stoves, fryers, pots, pans, knives, cutting boards, food processors" },
    { name: "FURNITURE & FIXTURES", icon: "fa-chair", desc: "Dining tables, chairs, stools, lighting, shelving racks, cabinets" }
  ];

  Utils.openModal("📦 Import Official Master List", `
    <div style="font-size:13px; color:var(--text-muted); margin-bottom:16px;">
      Select which department modules you want to import into your inventory. Existing items will have their categories and default thresholds synchronized safely.
    </div>

    <div style="background:rgba(201,162,39,0.08); border:1px solid rgba(201,162,39,0.25); border-radius:12px; padding:16px; margin-bottom:18px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <strong style="color:var(--text-main); font-size:14px;">⚡ Complete Master Import (All 10 Departments)</strong>
        <div style="font-size:12px; color:var(--text-muted);">Includes over 150+ standard foodhub items, ingredients, supplies & equipment.</div>
      </div>
      <button class="btn btn-primary" onclick="submitImportMasterlist(null)">
        <i class="fas fa-cloud-arrow-down"></i> Import All
      </button>
    </div>

    <h4 style="font-size:13px; text-transform:uppercase; color:var(--text-muted); margin-bottom:12px;">Or Import by Department</h4>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; max-height:280px; overflow-y:auto; padding-right:4px;">
      ${categories.map(c => `
        <div style="border:1px solid rgba(205,190,150,0.3); border-radius:10px; padding:12px; background:#ffffff; display:flex; flex-direction:column; justify-content:space-between; gap:8px;">
          <div>
            <div style="font-weight:700; font-size:13px; color:var(--text-main); display:flex; align-items:center; gap:8px;">
              <i class="fas ${c.icon}" style="color:#c9a227;"></i> ${c.name}
            </div>
            <div style="font-size:11px; color:var(--text-muted); margin-top:3px; line-height:1.3;">${c.desc}</div>
          </div>
          <button class="btn btn-outline btn-sm" style="align-self:flex-start; font-size:11px;" onclick="submitImportMasterlist('${c.name}')">
            Import ${c.name}
          </button>
        </div>
      `).join('')}
    </div>
  `, `<button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>`);
}

async function submitImportMasterlist(category) {
  try {
    const url = category ? `/api/v1/inventory/import-masterlist?selected_category=${encodeURIComponent(category)}` : `/api/v1/inventory/import-masterlist`;
    const res = await Auth.fetch(url, { method: "POST" });
    if (!res.ok) {
      const err = await res.json();
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
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Min Stock Threshold <span style="color:var(--danger);">*</span></label>
        <input type="number" step="0.01" id="inv-min" class="input-field" required value="5" style="width:100%;">
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
  const min_stock = parseFloat(document.getElementById("inv-min").value) || 0;

  if (!name || !unit) {
    Utils.showToast("Please fill in required item name and unit", "danger");
    return;
  }

  try {
    const res = await Auth.fetch("/api/v1/inventory", {
      method: "POST",
      body: JSON.stringify({ name, category, sku: sku || null, quantity, unit, min_stock })
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

function openStockAdjustModal(id, name, currentQty) {
  Utils.openModal(`Adjust Stock — ${name}`, `
    <form id="form-stock-adj" onsubmit="event.preventDefault(); submitStockAdjust(${id});">
      <p style="color:var(--text-muted); font-size:13px; margin-bottom:16px;">Current Stock Balance: <strong>${currentQty}</strong></p>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Quantity Delta (+ Restock, - Deduct) <span style="color:var(--danger);">*</span></label>
        <input type="number" step="0.01" id="adj-delta" class="input-field" required placeholder="e.g. 20 (Restock) or -5 (Deduction)" style="width:100%;">
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Reason / Notes</label>
        <input type="text" id="adj-reason" class="input-field" placeholder="e.g. Supplier delivery, Weekly audit, Kitchen consumption" style="width:100%;">
      </div>
    </form>
  `, `<button class="btn btn-primary" onclick="submitStockAdjust(${id})"><i class="fas fa-check"></i> Apply Adjustment</button>`);
}

async function submitStockAdjust(itemId) {
  const delta = parseFloat(document.getElementById("adj-delta").value);
  const reason = document.getElementById("adj-reason").value.trim();
  if (isNaN(delta) || delta === 0) {
    Utils.showToast("Please enter a non-zero delta quantity", "danger");
    return;
  }

  try {
    const res = await Auth.fetch(`/api/v1/inventory/${itemId}/stock`, {
      method: "PUT",
      body: JSON.stringify({ quantity_delta: delta, reason: reason || undefined })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Stock adjustment failed.");
    }
    Utils.showToast("Stock quantity updated successfully", "success");
    Utils.closeModal();
    renderInventory();
  } catch (e) {
    Utils.showToast(e.message, "danger");
  }
}

async function deleteInventoryItem(itemId, name) {
  if (!confirm(`Are you sure you want to delete "${name}" from inventory?`)) return;
  try {
    const res = await Auth.fetch(`/api/v1/inventory/${itemId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete item.");
    Utils.showToast(`"${name}" deleted from inventory`, "success");
    renderInventory();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. PRODUCTS & MENU CATALOG
// ─────────────────────────────────────────────────────────────────────────────
async function renderProducts(c) {
  const [prodRes, catRes] = await Promise.all([
    Auth.fetch("/api/v1/products"),
    Auth.fetch("/api/v1/categories")
  ]);

  const products = prodRes.ok ? await prodRes.json() : [];
  const categories = catRes.ok ? await catRes.json() : [];
  cachedProducts = products;

  c.innerHTML = `
    <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:20px; flex-wrap:wrap;">
      <div class="search-wrap" style="position:relative; flex:1; max-width:320px;">
        <i class="fas fa-search" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); color:var(--text-muted);"></i>
        <input type="text" id="prod-search" class="input-field" placeholder="Search menu products..." style="padding-left:38px; width:100%;" oninput="filterProductsList()">
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
              <th>ID</th>
              <th>Product Name</th>
              <th>Category</th>
              <th>SKU</th>
              <th>Selling Price</th>
              <th>Estimated Cost</th>
              <th>Status</th>
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
  return products.map(p => `
    <tr>
      <td style="color:var(--text-muted);">#${p.id}</td>
      <td><strong style="color:var(--text-main); font-size:13px;">${p.name}</strong></td>
      <td style="color:var(--text-muted); font-size:13px;">${p.category ? p.category.name : '—'}</td>
      <td style="color:var(--text-muted); font-size:13px;">${p.sku || '—'}</td>
      <td><strong style="color:#c9a227; font-size:13px;">${Utils.formatCurrency(p.price)}</strong></td>
      <td style="color:var(--text-muted); font-size:13px;">${Utils.formatCurrency(p.cost)}</td>
      <td>
        <span class="badge ${p.is_active ? 'badge-success' : 'badge-danger'}" style="font-size:11px; font-weight:700;">
          ${p.is_active ? 'Active' : 'Inactive'}
        </span>
      </td>
    </tr>
  `).join('');
}

function filterProductsList() {
  const q = (document.getElementById("prod-search").value || "").toLowerCase();
  const filtered = cachedProducts.filter(p => 
    (p.name && p.name.toLowerCase().includes(q)) || 
    (p.sku && p.sku.toLowerCase().includes(q))
  );
  document.getElementById("prod-tbody").innerHTML = renderProductRows(filtered);
}

function openAddProductModal() {
  Utils.openModal("Create New Menu Product", `
    <form id="form-add-prod" onsubmit="event.preventDefault(); submitAddProduct();">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Product Name <span style="color:var(--danger);">*</span></label>
        <input id="prod-name" class="input-field" required placeholder="e.g. Crispy Fried Chicken Platter" style="width:100%;">
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">SKU <span style="color:var(--danger);">*</span></label>
        <input id="prod-sku" class="input-field" required placeholder="e.g. FOOD-CFC-01" style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Selling Price (₱) <span style="color:var(--danger);">*</span></label>
          <input type="number" step="0.01" id="prod-price" class="input-field" required value="150" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Estimated Cost (₱) <span style="color:var(--danger);">*</span></label>
          <input type="number" step="0.01" id="prod-cost" class="input-field" required value="75" style="width:100%;">
        </div>
      </div>
    </form>
  `, `<button class="btn btn-primary" onclick="submitAddProduct()"><i class="fas fa-save"></i> Save Product</button>`);
}

async function submitAddProduct() {
  const name = document.getElementById("prod-name").value.trim();
  const sku = document.getElementById("prod-sku").value.trim();
  const price = parseFloat(document.getElementById("prod-price").value) || 0;
  const cost = parseFloat(document.getElementById("prod-cost").value) || 0;

  if (!name || !sku) {
    Utils.showToast("Product name and SKU are required.", "danger");
    return;
  }

  try {
    const res = await Auth.fetch("/api/v1/products", {
      method: "POST",
      body: JSON.stringify({ name, sku, price, cost, is_active: true })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Product creation failed.");
    }
    Utils.showToast("Product added successfully", "success");
    Utils.closeModal();
    renderProducts();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CASHIER POINT OF SALE (POS) - RESPONSIVE & FLUID
// ─────────────────────────────────────────────────────────────────────────────
async function renderPOS(c) {
  if (!c) c = document.getElementById("view-container");
  if (!c) return;

  const [prodRes, catRes] = await Promise.all([
    Auth.fetch("/api/v1/products"),
    Auth.fetch("/api/v1/categories")
  ]);

  const products = prodRes.ok ? await prodRes.json() : [];
  const categories = catRes.ok ? await catRes.json() : [];
  cachedProducts = products;

  c.innerHTML = `
    <div class="pos-container fade-up">
      <!-- Left Column: Menu Catalog -->
      <div class="pos-products">
        
        <!-- Header Toolbar & Search -->
        <div class="pos-header-bar">
          <div class="search-wrap" style="position:relative; flex:1; min-width:240px; max-width:380px;">
            <i class="fas fa-search" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); color:var(--text-muted);"></i>
            <input type="text" id="pos-search" class="input-field" placeholder="Search menu items..." style="padding-left:38px; width:100%;" oninput="filterPOSGrid()">
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span id="pos-product-count" class="badge badge-info" style="font-size:12px; padding:6px 12px;">
              ${products.length} Products
            </span>
          </div>
        </div>

        <!-- Horizontal Scrollable Category Bar -->
        <div class="pos-categories" id="pos-cat-bar">
          <button class="btn btn-primary btn-sm pos-cat-pill" onclick="selectPOSCategory('all', this)">
            <i class="fas fa-layer-group"></i> All Items
          </button>
          ${categories.map(cat => `
            <button class="btn btn-outline btn-sm pos-cat-pill" onclick="selectPOSCategory(${cat.id}, this)">
              ${cat.name}
            </button>
          `).join('')}
        </div>

        <!-- Responsive Products Grid -->
        <div class="pos-grid" id="pos-grid">
          ${renderPOSProductCards(products)}
        </div>
      </div>

      <!-- Right Column: Sticky Cart -->
      <div class="pos-cart section-card" id="pos-cart-panel">
        <div class="section-head" style="padding:14px 18px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <i class="fas fa-shopping-cart" style="color:#c9a227; font-size:16px;"></i>
            <h2 style="font-size:15px; margin:0;">Order Cart</h2>
            <span id="cart-badge-count" class="badge badge-info" style="font-size:10px; padding:2px 6px;">0</span>
          </div>
          <button class="btn btn-outline btn-sm" onclick="clearCart()" style="font-size:11px; padding:4px 10px;">
            <i class="fas fa-trash-can"></i> Clear
          </button>
        </div>

        <div class="cart-items" id="cart-items-container">
          ${renderCartItems()}
        </div>

        <div class="cart-footer">
          <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:13px; color:var(--text-muted);">
            <span>Subtotal:</span>
            <span id="cart-subtotal" style="font-weight:600; color:var(--text-main);">₱0.00</span>
          </div>
          <div style="display:flex; justify-content:space-between; margin-bottom:14px; font-size:18px; font-weight:800; color:var(--text-main);">
            <span>Total Payable:</span>
            <span id="cart-total" style="color:#c9a227;">₱0.00</span>
          </div>
          <button class="btn btn-primary" style="width:100%; height:46px; font-size:15px; font-weight:700; display:flex; justify-content:center; align-items:center; gap:8px;" onclick="openPaymentModal()">
            <i class="fas fa-cash-register"></i> Charge & Checkout
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderPOSProductCards(products) {
  if (!products || !products.length) {
    return `<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--text-muted);"><i class="fas fa-utensils" style="font-size:32px; margin-bottom:10px; opacity:0.3; display:block;"></i>No menu items found.</div>`;
  }
  return products.map(p => `
    <div class="pos-item-card" onclick="addToCart(${p.id}, '${p.name.replace(/'/g, "\\'")}', ${p.price})">
      <div class="card-top">
        <span class="badge" style="background:rgba(201,162,39,0.12); color:#c9a227; font-size:10px; padding:2px 8px; font-weight:700;">
          ${p.category ? p.category.name : 'Food'}
        </span>
        <span style="width:24px; height:24px; border-radius:50%; background:rgba(201,162,39,0.12); color:#c9a227; display:flex; align-items:center; justify-content:center; font-size:11px; flex-shrink:0;">
          <i class="fas fa-plus"></i>
        </span>
      </div>
      <div class="card-title" title="${p.name}">${p.name}</div>
      <div class="card-bottom">
        <span class="card-price">${Utils.formatCurrency(p.price)}</span>
        <span style="font-size:10px; color:var(--text-muted); font-family:monospace;">${p.sku || ''}</span>
      </div>
    </div>
  `).join('');
}

function filterPOSGrid() {
  const q = (document.getElementById("pos-search")?.value || "").toLowerCase().trim();
  const filtered = cachedProducts.filter(p => {
    const matchQ = !q || (p.name && p.name.toLowerCase().includes(q)) || (p.sku && p.sku.toLowerCase().includes(q));
    const matchCat = currentCategoryFilter === "all" || p.category_id === Number(currentCategoryFilter);
    return matchQ && matchCat;
  });

  const grid = document.getElementById("pos-grid");
  const countEl = document.getElementById("pos-product-count");
  if (grid) grid.innerHTML = renderPOSProductCards(filtered);
  if (countEl) countEl.textContent = `${filtered.length} Products`;
}

function selectPOSCategory(catId, btn) {
  currentCategoryFilter = catId;
  document.querySelectorAll("#pos-cat-bar button").forEach(b => {
    b.className = "btn btn-outline btn-sm pos-cat-pill";
  });
  btn.className = "btn btn-primary btn-sm pos-cat-pill";
  filterPOSGrid();
}

function addToCart(productId, name, price) {
  const existing = posCart.find(i => i.product_id === productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    posCart.push({ product_id: productId, name, price: Number(price), quantity: 1 });
  }
  updateCartUI();
  
  // Subtle toast or vibration on mobile
  if (navigator.vibrate) navigator.vibrate(30);
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
  const totalCount = posCart.reduce((sum, i) => sum + i.quantity, 0);

  const subtotalEl = document.getElementById("cart-subtotal");
  const totalEl = document.getElementById("cart-total");
  const badgeEl = document.getElementById("cart-badge-count");

  if (subtotalEl) subtotalEl.textContent = Utils.formatCurrency(total);
  if (totalEl) totalEl.textContent = Utils.formatCurrency(total);
  if (badgeEl) badgeEl.textContent = totalCount;
}

function renderCartItems() {
  if (!posCart.length) {
    return `<div style="text-align:center; padding:36px 12px; color:var(--text-muted); font-size:13px;"><i class="fas fa-shopping-basket" style="font-size:32px; margin-bottom:10px; opacity:0.3; display:block;"></i>Cart is currently empty.<br><span style="font-size:11px;">Click on any menu item to add.</span></div>`;
  }
  return posCart.map((i, idx) => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid rgba(205,190,150,0.18); font-size:13px;">
      <div style="flex:1; padding-right:8px; min-width:0;">
        <div style="font-weight:600; color:var(--text-main); font-size:13px; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${i.name}</div>
        <div style="color:#c9a227; font-weight:700; font-size:12px; margin-top:2px;">${Utils.formatCurrency(i.price * i.quantity)} <span style="color:var(--text-muted); font-weight:400; font-size:11px;">(₱${i.price} ea)</span></div>
      </div>
      <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
        <button type="button" class="btn btn-outline btn-sm" style="padding:2px 8px; font-size:12px; border-radius:6px; min-width:26px;" onclick="updateCartItemQty(${i.product_id}, -1)">-</button>
        <span style="font-weight:800; min-width:20px; text-align:center; font-size:13px;">${i.quantity}</span>
        <button type="button" class="btn btn-outline btn-sm" style="padding:2px 8px; font-size:12px; border-radius:6px; min-width:26px;" onclick="updateCartItemQty(${i.product_id}, 1)">+</button>
        <button type="button" class="btn-icon" onclick="posCart.splice(${idx}, 1); updateCartUI();" style="border:none; background:transparent; color:var(--danger); cursor:pointer; font-size:13px; padding:4px;" title="Remove"><i class="fas fa-trash-can"></i></button>
      </div>
    </div>
  `).join('');
}

function clearCart() {
  posCart = [];
  updateCartUI();
}

function openPaymentModal() {
  if (!posCart.length) {
    Utils.showToast("Order cart is empty. Please add items to checkout.", "danger");
    return;
  }
  const total = posCart.reduce((sum, i) => sum + (i.price * i.quantity), 0);

  Utils.openModal("💳 Process Order Payment & Checkout", `
    <form id="form-payment" onsubmit="event.preventDefault(); submitCheckout();">
      <!-- Total Payable Banner -->
      <div style="text-align:center; padding:18px; background:rgba(201,162,39,0.08); border-radius:14px; margin-bottom:18px; border:1px solid rgba(205,190,150,0.3);">
        <span style="font-size:12px; text-transform:uppercase; color:var(--text-muted); font-weight:600; letter-spacing:0.5px;">Total Amount Due</span>
        <div style="font-size:32px; font-weight:800; color:#c9a227; margin-top:4px;">${Utils.formatCurrency(total)}</div>
      </div>

      <!-- Payment Method Selection -->
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Payment Method <span style="color:var(--danger);">*</span></label>
        <select id="pay-method" class="input-field" style="width:100%;">
          <option value="CASH" selected>💵 Cash (Cash Register)</option>
          <option value="GCASH">📱 GCash E-Wallet</option>
          <option value="CARD">💳 Debit / Credit Card</option>
        </select>
      </div>

      <!-- Amount Tendered Input -->
      <div class="input-group" style="margin-bottom:12px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Amount Tendered (₱) <span style="color:var(--danger);">*</span></label>
        <input type="number" step="0.01" id="pay-tendered" class="input-field" required value="${total}" style="width:100%; font-size:18px; font-weight:800;" oninput="calculateChange(${total})">
      </div>

      <!-- Quick Denominations for Rapid Touch Input -->
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:60px;" onclick="setTenderedAmount(${total}, ${total})">Exact</button>
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:60px;" onclick="setTenderedAmount(100, ${total})">₱100</button>
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:60px;" onclick="setTenderedAmount(200, ${total})">₱200</button>
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:60px;" onclick="setTenderedAmount(500, ${total})">₱500</button>
        <button type="button" class="btn btn-outline btn-sm" style="flex:1; min-width:60px;" onclick="setTenderedAmount(1000, ${total})">₱1,000</button>
      </div>

      <!-- Change Calculation Box -->
      <div id="change-display-box" style="display:flex; justify-content:space-between; align-items:center; padding:14px 18px; background:rgba(16,185,129,0.08); border-radius:12px; border:1px solid rgba(16,185,129,0.25);">
        <span style="font-size:14px; font-weight:700; color:var(--text-main);">Change to Return:</span>
        <span id="pay-change" style="font-size:22px; font-weight:800; color:var(--success, #10b981);">₱0.00</span>
      </div>
    </form>
  `, `<button class="btn btn-primary" onclick="submitCheckout()" style="width:100%; height:46px; font-size:15px; font-weight:700;"><i class="fas fa-check-circle"></i> Confirm & Complete Sale</button>`);
}

function setTenderedAmount(amount, total) {
  const input = document.getElementById("pay-tendered");
  if (input) {
    input.value = amount;
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
    Utils.showToast("Order completed successfully!", "success");
    Utils.closeModal();
    clearCart();
    localStorage.setItem("RESTOTRACK_SYNC_TX", Date.now());
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. KITCHEN DISPLAY SYSTEM (KDS)
// ─────────────────────────────────────────────────────────────────────────────
async function renderKitchen(c) {
  const res = await Auth.fetch("/api/v1/kitchen/orders");
  const orders = res.ok ? await res.json() : [];

  c.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
      <h2 style="font-size:18px; font-weight:700;">Live Kitchen Orders</h2>
      <button class="btn btn-outline btn-sm" onclick="renderKitchen()"><i class="fas fa-sync"></i> Refresh Orders</button>
    </div>

    <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:16px;">
      ${orders.length ? orders.map(ord => `
        <div class="section-card" style="padding:16px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
            <strong style="font-size:15px;">#ORD-${ord.id}</strong>
            <span class="badge badge-warning" style="font-size:11px;">${ord.status || 'PENDING'}</span>
          </div>
          <ul style="list-style:none; padding:0; margin:10px 0; font-size:13px; color:var(--text-main);">
            ${(ord.items || []).map(it => `<li>• ${it.quantity}x ${it.product_name}</li>`).join('')}
          </ul>
          <button class="btn btn-primary btn-sm" style="width:100%; margin-top:10px;" onclick="updateOrderStatus(${ord.id}, 'READY')">
            <i class="fas fa-check"></i> Mark Ready
          </button>
        </div>
      `).join('') : '<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--text-muted);"><i class="fas fa-utensils" style="font-size:32px; margin-bottom:10px; opacity:0.4;"></i><br>No pending orders in the kitchen.</div>'}
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
      Utils.showToast(`Order #${orderId} marked as ${newStatus}`, "success");
      renderKitchen();
      localStorage.setItem("RESTOTRACK_SYNC_KITCHEN", Date.now());
    }
  } catch (err) {
    Utils.showToast("Failed to update status", "danger");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. TRANSACTIONS LISTING
// ─────────────────────────────────────────────────────────────────────────────
async function renderTransactions(c) {
  const res = await Auth.fetch("/api/v1/transactions?limit=50");
  const list = res.ok ? await res.json() : [];

  c.innerHTML = `
    <div class="section-card">
      <div class="section-head">
        <h2>Order Transactions</h2>
        <span style="font-size:13px; color:var(--text-muted);">${list.length} recent transactions</span>
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
            </tr>
          </thead>
          <tbody id="tx-tbody">
            ${list.length ? list.map(tx => `
              <tr>
                <td style="color:var(--text-muted);">#${tx.id}</td>
                <td style="color:var(--text-muted); font-size:13px;">${tx.created_at ? new Date(tx.created_at).toLocaleString() : '—'}</td>
                <td><strong style="font-size:13px;">${tx.cashier || 'Staff'}</strong></td>
                <td style="color:var(--text-muted); font-size:13px;">${(tx.items || []).length} items</td>
                <td><strong style="color:#c9a227; font-size:13px;">${Utils.formatCurrency(tx.net_amount)}</strong></td>
                <td><span class="badge badge-success" style="font-size:11px; font-weight:700;">${tx.status || 'COMPLETED'}</span></td>
              </tr>
            `).join('') : '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">No transaction logs recorded yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

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
              </tr>
            `).join('') : '<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--text-muted);">No staff registered in this branch.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

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
let cachedSuppliers = [
  { id: 1, name: "San Miguel Foods Inc.", contact: "Mario Batali", phone: "0917-889-2311", email: "orders@sanmiguelfoods.ph", category: "Poultry & Meat", terms: "Net 15", status: "Active" },
  { id: 2, name: "Magnolia Fresh Farm", contact: "Elena Ramos", phone: "0920-554-1290", email: "sales@magnoliadairy.com", category: "Dairy & Eggs", terms: "Net 30", status: "Active" },
  { id: 3, name: "Baguio Greens Produce", contact: "Carlos Tan", phone: "0918-332-9011", email: "carlos@baguiogreens.ph", category: "Fresh Produce", terms: "COD", status: "Active" },
  { id: 4, name: "Golden Cup Packaging", contact: "Sarah Chua", phone: "0922-811-4432", email: "inquiry@goldencup.com.ph", category: "Packaging & Disposables", terms: "Net 15", status: "Active" }
];

async function renderSuppliers(c) {
  c.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-truck"></i></div>
        <div class="stat-info">
          <h3>Active Suppliers</h3>
          <div class="stat-count" style="color:#c9a227;">${cachedSuppliers.length}</div>
          <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-handshake"></i> Verified Vendors</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-check-circle"></i></div>
        <div class="stat-info">
          <h3>Poultry & Meat</h3>
          <div class="stat-count" style="color:#10b981;">1</div>
          <div class="stat-trend" style="color:#10b981;">Primary Vendor</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-leaf"></i></div>
        <div class="stat-info">
          <h3>Fresh Produce</h3>
          <div class="stat-count" style="color:#f97316;">1</div>
          <div class="stat-trend" style="color:#f97316;">Farm Direct</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon purple"><i class="fas fa-box-open"></i></div>
        <div class="stat-info">
          <h3>Packaging & Misc</h3>
          <div class="stat-count" style="color:#9333ea;">2</div>
          <div class="stat-trend" style="color:#9333ea;">Disposables</div>
        </div>
      </div>
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
        <span style="font-size:13px; color:var(--text-muted);">${cachedSuppliers.length} vendor partners</span>
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
            ${renderSupplierRows(cachedSuppliers)}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderSupplierRows(suppliers) {
  if (!suppliers || !suppliers.length) {
    return `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-muted);">No suppliers found.</td></tr>`;
  }
  return suppliers.map(s => `
    <tr>
      <td style="color:var(--text-muted);">#${s.id}</td>
      <td><strong style="color:var(--text-main); font-size:13px;">${s.name}</strong></td>
      <td style="color:var(--text-muted); font-size:13px;">${s.contact || '—'}</td>
      <td><span style="font-family:monospace; font-size:12px; color:var(--text-muted);">${s.phone || '—'}</span></td>
      <td style="color:var(--text-muted); font-size:13px;">${s.email || '—'}</td>
      <td><span class="badge badge-info" style="font-size:11px; font-weight:700;">${s.category || 'General'}</span></td>
      <td style="color:var(--text-muted); font-size:12px;">${s.terms || 'COD'}</td>
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
  const filtered = cachedSuppliers.filter(s =>
    (s.name && s.name.toLowerCase().includes(q)) ||
    (s.contact && s.contact.toLowerCase().includes(q)) ||
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

function submitAddSupplier() {
  const name = document.getElementById("sp-name")?.value.trim();
  const contact = document.getElementById("sp-contact")?.value.trim();
  const phone = document.getElementById("sp-phone")?.value.trim();
  const email = document.getElementById("sp-email")?.value.trim();
  const category = document.getElementById("sp-category")?.value.trim();

  if (!name || !phone) {
    Utils.showToast("Company name and phone number are required.", "danger");
    return;
  }

  const newSupplier = {
    id: cachedSuppliers.length + 1,
    name, contact, phone, email,
    category: category || "General",
    terms: "Net 30",
    status: "Active"
  };

  cachedSuppliers.push(newSupplier);
  Utils.showToast("Supplier registered successfully!", "success");
  Utils.closeModal();
  renderSuppliers();
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. PURCHASE ORDERS
// ─────────────────────────────────────────────────────────────────────────────
let cachedPurchases = [
  { id: "PO-2026-001", supplier: "San Miguel Foods Inc.", items: "50kg Whole Chicken, 20kg Pork Belly", total_cost: 14500, status: "RECEIVED", date: "2026-08-23" },
  { id: "PO-2026-002", supplier: "Magnolia Fresh Farm", items: "100 Trays Fresh Eggs, 30L Cooking Oil", total_cost: 9800, status: "PENDING", date: "2026-08-24" },
  { id: "PO-2026-003", supplier: "Baguio Greens Produce", items: "40kg Onions, 30kg Garlic, 50kg Potatoes", total_cost: 6200, status: "RECEIVED", date: "2026-08-22" }
];

async function renderPurchases(c) {
  const totalSpend = cachedPurchases.reduce((sum, p) => sum + p.total_cost, 0);
  const pendingCount = cachedPurchases.filter(p => p.status === 'PENDING').length;

  c.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-file-invoice-dollar"></i></div>
        <div class="stat-info">
          <h3>Total Purchase Orders</h3>
          <div class="stat-count" style="color:#c9a227;">${cachedPurchases.length}</div>
          <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-shopping-cart"></i> PO Records</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-clock"></i></div>
        <div class="stat-info">
          <h3>Pending Shipments</h3>
          <div class="stat-count" style="color:#f97316;">${pendingCount}</div>
          <div class="stat-trend" style="color:#f97316;">Awaiting Delivery</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-truck-loading"></i></div>
        <div class="stat-info">
          <h3>Received Shipments</h3>
          <div class="stat-count" style="color:#10b981;">${cachedPurchases.length - pendingCount}</div>
          <div class="stat-trend" style="color:#10b981;">Stock Ingested</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon purple"><i class="fas fa-coins"></i></div>
        <div class="stat-info">
          <h3>Total Procurement</h3>
          <div class="stat-count" style="color:#9333ea; font-size:20px;">${Utils.formatCurrency(totalSpend)}</div>
          <div class="stat-trend" style="color:#9333ea;">Month-to-Date</div>
        </div>
      </div>
    </div>

    <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:20px; flex-wrap:wrap;">
      <div style="font-size:13px; color:var(--text-muted);">${cachedPurchases.length} purchase orders recorded</div>
      <button class="btn btn-primary" onclick="openCreatePOModal()" style="display:inline-flex; align-items:center; gap:8px;">
        <i class="fas fa-plus-circle"></i> Create Purchase Order
      </button>
    </div>

    <div class="section-card">
      <div class="section-head">
        <h2>Purchase Orders & Deliveries</h2>
        <span style="font-size:13px; color:var(--text-muted);">Track supplier receipts</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>PO Number</th>
              <th>Supplier Name</th>
              <th>Item Description</th>
              <th>Total Cost</th>
              <th>Order Date</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${cachedPurchases.map(p => `
              <tr>
                <td><strong style="color:var(--text-main); font-size:13px;">${p.id}</strong></td>
                <td style="font-size:13px; font-weight:600;">${p.supplier}</td>
                <td style="color:var(--text-muted); font-size:13px;">${p.items}</td>
                <td><strong style="color:#c9a227; font-size:13px;">${Utils.formatCurrency(p.total_cost)}</strong></td>
                <td style="color:var(--text-muted); font-size:13px;">${p.date}</td>
                <td>
                  <span class="badge ${p.status === 'RECEIVED' ? 'badge-success' : 'badge-warning'}" style="font-size:11px; font-weight:700;">
                    ${p.status}
                  </span>
                </td>
                <td>
                  ${p.status === 'PENDING' ? `
                    <button class="btn btn-primary btn-sm" onclick="markPOReceived('${p.id}')" style="font-size:11px; padding:4px 10px;">
                      <i class="fas fa-check"></i> Receive
                    </button>
                  ` : `
                    <span style="color:var(--text-muted); font-size:12px;"><i class="fas fa-check-double" style="color:var(--success);"></i> Completed</span>
                  `}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function openCreatePOModal() {
  Utils.openModal("Create Purchase Order", `
    <form id="form-create-po" onsubmit="event.preventDefault(); submitCreatePO();">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Supplier <span style="color:var(--danger);">*</span></label>
        <select id="po-supplier" class="input-field" style="width:100%;">
          ${cachedSuppliers.map(s => `<option value="${s.name}">${s.name} (${s.category})</option>`).join('')}
        </select>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Items & Quantities Description <span style="color:var(--danger);">*</span></label>
        <textarea id="po-items" class="input-field" required rows="3" placeholder="e.g. 50kg Whole Chicken, 10 Bags Jasmine Rice" style="width:100%;"></textarea>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Estimated Total Cost (₱) <span style="color:var(--danger);">*</span></label>
        <input type="number" step="0.01" id="po-cost" class="input-field" required placeholder="12500" style="width:100%;">
      </div>
    </form>
  `, `<button class="btn btn-primary" onclick="submitCreatePO()"><i class="fas fa-paper-plane"></i> Submit Purchase Order</button>`);
}

function submitCreatePO() {
  const supplier = document.getElementById("po-supplier")?.value;
  const items = document.getElementById("po-items")?.value.trim();
  const cost = parseFloat(document.getElementById("po-cost")?.value) || 0;

  if (!supplier || !items || cost <= 0) {
    Utils.showToast("Please provide all required purchase order details.", "danger");
    return;
  }

  const newPO = {
    id: `PO-${new Date().getFullYear()}-${String(cachedPurchases.length + 1).padStart(3, '0')}`,
    supplier, items, total_cost: cost,
    status: "PENDING",
    date: new Date().toISOString().split('T')[0]
  };

  cachedPurchases.unshift(newPO);
  Utils.showToast("Purchase Order created successfully!", "success");
  Utils.closeModal();
  renderPurchases();
}

function markPOReceived(poId) {
  const po = cachedPurchases.find(p => p.id === poId);
  if (!po) return;
  po.status = "RECEIVED";
  Utils.showToast(`Purchase order ${poId} marked as RECEIVED into inventory!`, "success");
  renderPurchases();
}

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
  if (e.key === "RESTOTRACK_SYNC_TX" || e.key === "RESTOTRACK_SYNC_KITCHEN") {
    const role = Auth.getRole();
    if (role === "kitchen") {
      renderKitchen();
      Utils.showToast("New order received in kitchen!", "info");
    } else if (role === "cashier") {
      Utils.showToast("Kitchen order status updated", "info");
    }
  }
});
