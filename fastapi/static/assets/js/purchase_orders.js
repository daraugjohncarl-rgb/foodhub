/**
 * Purchase Orders Module (purchase_orders.js)
 * Interacts with Suppliers and Inventory.
 */

let cachedPurchaseOrders = [];
let availableSuppliers = [];
let inventoryCatalog = [];
let poItemRows = [];

async function renderPurchases(container) {
  if (!container) container = document.getElementById("view-container");
  if (!container) return;

  try {
    const res = await Auth.fetch("/api/v1/purchase-orders");
    if (res.ok) {
      cachedPurchaseOrders = await res.json();
    } else {
      cachedPurchaseOrders = [];
    }
  } catch (err) {
    console.error("Failed to fetch purchase orders:", err);
    cachedPurchaseOrders = [];
  }

  container.innerHTML = \`
    <!-- Toolbar -->
    <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:18px; flex-wrap:wrap;">
      <div style="display:flex; gap:12px; align-items:center; flex:1; min-width:280px; max-width:480px;">
        <div class="search-wrap" style="position:relative; flex:1;">
          <i class="fas fa-search" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); color:var(--text-muted);"></i>
          <input type="text" id="po-search" class="input-field" placeholder="Search PO number, supplier..." style="padding-left:38px; width:100%;" oninput="filterPOList()">
        </div>
      </div>
      <button class="btn btn-primary" onclick="openCreatePOModal()" style="display:inline-flex; align-items:center; gap:8px;">
        <i class="fas fa-plus"></i> Create Purchase Order
      </button>
    </div>

    <!-- Table -->
    <div class="section-card fade-up delay-2">
      <div class="section-head">
        <h2>Purchase Orders</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>PO Number</th>
              <th>Supplier</th>
              <th>Order Date</th>
              <th>Status</th>
              <th>Total Amount</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody id="po-tbody">
            \${renderPORows(cachedPurchaseOrders)}
          </tbody>
        </table>
      </div>
    </div>
  \`;
}

function renderPORows(orders) {
  if (!orders || !orders.length) {
    return '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">No purchase orders found.</td></tr>';
  }
  
  return orders.map(po => {
    let badgeClass = 'badge-secondary';
    if (po.status === 'Received') badgeClass = 'badge-success';
    else if (po.status === 'Cancelled') badgeClass = 'badge-danger';
    else if (po.status === 'Pending' || po.status === 'Ordered') badgeClass = 'badge-warning';

    return \`
      <tr>
        <td>
          <strong style="color:var(--text-main); font-size:13px;">\${po.po_number}</strong>
        </td>
        <td>
          <span style="color:var(--text-main); font-size:13px;">\${po.supplier_name || 'Unknown'}</span>
        </td>
        <td style="color:var(--text-muted); font-size:13px;">\${new Date(po.order_date).toLocaleDateString()}</td>
        <td>
          <span class="badge \${badgeClass}" style="font-size:11px; font-weight:700;">\${po.status}</span>
        </td>
        <td>
          <strong style="color:#c9a227; font-size:13px;">\${Utils.formatCurrency(po.total_amount)}</strong>
        </td>
        <td style="text-align:right;">
          <div style="display:inline-flex; gap:6px;">
            <button class="btn btn-outline btn-sm" style="padding:4px 8px; font-size:11px;" onclick="viewPOModal(\${po.id})" title="View Details">
              <i class="fas fa-eye"></i> View
            </button>
            \${po.status !== 'Received' && po.status !== 'Cancelled' ? \`
            <button class="btn btn-primary btn-sm" style="padding:4px 8px; font-size:11px;" onclick="receivePO(\${po.id}, '\${po.po_number}')" title="Receive PO">
              <i class="fas fa-box-open"></i> Receive
            </button>
            \` : ''}
          </div>
        </td>
      </tr>
    \`;
  }).join('');
}

function filterPOList() {
  const q = (document.getElementById("po-search")?.value || "").toLowerCase().trim();
  const filtered = cachedPurchaseOrders.filter(po => {
    return !q || 
      (po.po_number && po.po_number.toLowerCase().includes(q)) || 
      (po.supplier_name && po.supplier_name.toLowerCase().includes(q));
  });

  const tbody = document.getElementById("po-tbody");
  if (tbody) tbody.innerHTML = renderPORows(filtered);
}

async function openCreatePOModal(preselectedSupplierId = null) {
  // Fetch suppliers and inventory catalog for the dropdowns
  try {
    const [supRes, invRes] = await Promise.all([
      Auth.fetch("/api/v1/suppliers?status=Active"),
      Auth.fetch("/api/v1/inventory")
    ]);
    if (supRes.ok) availableSuppliers = await supRes.json();
    if (invRes.ok) inventoryCatalog = await invRes.json();
  } catch (e) {
    console.error("Failed to load dependencies for PO:", e);
  }

  poItemRows = [];

  Utils.openModal("Create Purchase Order", \`
    <form id="form-create-po" onsubmit="event.preventDefault(); submitCreatePO();">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Supplier <span style="color:var(--danger);">*</span></label>
          <select id="po-supplier" class="input-field" required style="width:100%;">
            <option value="" disabled \${!preselectedSupplierId ? 'selected' : ''}>Select a supplier...</option>
            \${availableSuppliers.map(s => \`<option value="\${s.id}" \${s.id === preselectedSupplierId ? 'selected' : ''}>\${s.supplier_name} (\${s.category || 'N/A'})</option>\`).join('')}
          </select>
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Expected Delivery Date</label>
          <input type="date" id="po-delivery-date" class="input-field" style="width:100%;">
        </div>
      </div>

      <div style="margin-top:20px; margin-bottom:10px; border-bottom:1px solid rgba(205,190,150,0.25); padding-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
        <strong style="color:var(--text-main); font-size:14px;">Order Items</strong>
        <button type="button" class="btn btn-outline btn-sm" onclick="addPOItemRow()" style="font-size:11px;">
          <i class="fas fa-plus"></i> Add Row
        </button>
      </div>

      <div id="po-items-container" style="max-height:200px; overflow-y:auto; overflow-x:hidden; padding-right:5px; margin-bottom:15px;">
        <!-- Rows will be injected here -->
      </div>

      <div style="display:flex; justify-content:flex-end; border-top:1px solid rgba(205,190,150,0.25); padding-top:10px; margin-bottom:14px;">
        <div style="text-align:right;">
          <div style="font-size:12px; color:var(--text-muted);">Subtotal: <span id="po-subtotal">₱0.00</span></div>
          <div style="font-size:16px; font-weight:700; color:var(--text-main);">Total: <span id="po-total" style="color:#c9a227;">₱0.00</span></div>
        </div>
      </div>

      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Notes</label>
        <textarea id="po-notes" class="input-field" placeholder="Optional notes for this purchase order..." style="width:100%; min-height:50px;"></textarea>
      </div>
    </form>
  \`, \`<button class="btn btn-primary" onclick="submitCreatePO()"><i class="fas fa-save"></i> Submit Order</button>\`);

  // Add one initial row
  addPOItemRow();
}

function addPOItemRow() {
  const rowId = Date.now() + Math.random().toString(36).substring(7);
  poItemRows.push({ id: rowId, invId: "", qty: 1, cost: 0 });
  renderPOItemRows();
}

function removePOItemRow(rowId) {
  poItemRows = poItemRows.filter(r => r.id !== rowId);
  renderPOItemRows();
  calculatePOTotals();
}

function updatePOItemRow(rowId, field, value) {
  const row = poItemRows.find(r => r.id === rowId);
  if (row) {
    row[field] = value;
    calculatePOTotals();
  }
}

function renderPOItemRows() {
  const container = document.getElementById("po-items-container");
  if (!container) return;

  if (poItemRows.length === 0) {
    container.innerHTML = \`<div style="text-align:center; color:var(--text-muted); font-size:12px; padding:10px;">No items added yet.</div>\`;
    return;
  }

  container.innerHTML = poItemRows.map((r, index) => \`
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; background:#faf8f3; padding:8px; border-radius:8px; border:1px solid rgba(205,190,150,0.2);">
      <div style="flex:2;">
        <select class="input-field" style="width:100%; font-size:12px;" onchange="updatePOItemRow('\${r.id}', 'invId', this.value)" required>
          <option value="" disabled \${!r.invId ? 'selected' : ''}>Select Inventory Item</option>
          \${inventoryCatalog.map(i => \`<option value="\${i.id}" \${r.invId == i.id ? 'selected' : ''}>\${i.name} (\${i.unit})</option>\`).join('')}
        </select>
      </div>
      <div style="flex:1;">
        <input type="number" step="0.01" min="0.01" class="input-field" placeholder="Qty" style="width:100%; font-size:12px;" value="\${r.qty}" oninput="updatePOItemRow('\${r.id}', 'qty', parseFloat(this.value) || 0)" required>
      </div>
      <div style="flex:1;">
        <input type="number" step="0.01" min="0" class="input-field" placeholder="Unit Cost (₱)" style="width:100%; font-size:12px;" value="\${r.cost}" oninput="updatePOItemRow('\${r.id}', 'cost', parseFloat(this.value) || 0)" required>
      </div>
      <div style="width:70px; text-align:right; font-weight:700; font-size:12px; color:var(--text-main);">
        \${Utils.formatCurrency(r.qty * r.cost)}
      </div>
      <button type="button" class="btn btn-outline btn-sm" style="padding:4px; color:var(--danger); border:none;" onclick="removePOItemRow('\${r.id}')" title="Remove">
        <i class="fas fa-times"></i>
      </button>
    </div>
  \`).join('');
}

function calculatePOTotals() {
  let subtotal = 0;
  poItemRows.forEach(r => {
    subtotal += (r.qty * r.cost);
  });
  
  const subEl = document.getElementById("po-subtotal");
  const totEl = document.getElementById("po-total");
  
  if (subEl) subEl.textContent = Utils.formatCurrency(subtotal);
  if (totEl) totEl.textContent = Utils.formatCurrency(subtotal);
}

async function submitCreatePO() {
  const supplierId = document.getElementById("po-supplier")?.value;
  const expectedDate = document.getElementById("po-delivery-date")?.value;
  const notes = document.getElementById("po-notes")?.value.trim();

  if (!supplierId) {
    Utils.showToast("Please select a supplier", "danger");
    return;
  }
  
  if (poItemRows.length === 0) {
    Utils.showToast("Please add at least one item to the order", "danger");
    return;
  }

  const items = [];
  for (const r of poItemRows) {
    if (!r.invId) {
      Utils.showToast("Please select an inventory item for all rows", "danger");
      return;
    }
    if (r.qty <= 0) {
      Utils.showToast("Quantities must be greater than 0", "danger");
      return;
    }
    if (r.cost < 0) {
      Utils.showToast("Costs cannot be negative", "danger");
      return;
    }
    items.push({
      inventory_item_id: parseInt(r.invId),
      quantity: r.qty,
      unit_cost: r.cost
    });
  }

  const payload = {
    supplier_id: parseInt(supplierId),
    items: items
  };

  if (expectedDate) payload.expected_delivery_date = new Date(expectedDate).toISOString();
  if (notes) payload.notes = notes;

  try {
    const res = await Auth.fetch("/api/v1/purchase-orders", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to create Purchase Order");
    }
    Utils.showToast("Purchase Order created successfully", "success");
    Utils.closeModal();
    renderPurchases();
  } catch (e) {
    Utils.showToast(e.message, "danger");
  }
}

function viewPOModal(id) {
  const po = cachedPurchaseOrders.find(x => x.id === id);
  if (!po) return;

  const itemRows = po.items.map(item => \`
    <tr>
      <td style="padding:6px; border-bottom:1px solid rgba(205,190,150,0.15);">\${item.inventory_item_name || 'Item #'+item.inventory_item_id}</td>
      <td style="padding:6px; border-bottom:1px solid rgba(205,190,150,0.15); text-align:right;">\${item.quantity}</td>
      <td style="padding:6px; border-bottom:1px solid rgba(205,190,150,0.15); text-align:right;">\${Utils.formatCurrency(item.unit_cost)}</td>
      <td style="padding:6px; border-bottom:1px solid rgba(205,190,150,0.15); text-align:right; font-weight:700;">\${Utils.formatCurrency(item.total_cost)}</td>
    </tr>
  \`).join('');

  Utils.openModal(\`Purchase Order: \${po.po_number}\`, \`
    <div style="font-size:13px; color:var(--text-main);">
      <div style="display:grid; grid-template-columns:140px 1fr; gap:10px; margin-bottom:16px;">
        <strong style="color:var(--text-muted);">Supplier:</strong>
        <span>\${po.supplier_name}</span>
        
        <strong style="color:var(--text-muted);">Status:</strong>
        <span><span class="badge" style="font-size:11px;">\${po.status}</span></span>
        
        <strong style="color:var(--text-muted);">Order Date:</strong>
        <span>\${new Date(po.order_date).toLocaleString()}</span>
        
        <strong style="color:var(--text-muted);">Expected Delivery:</strong>
        <span>\${po.expected_delivery_date ? new Date(po.expected_delivery_date).toLocaleDateString() : 'Not set'}</span>
        
        <strong style="color:var(--text-muted);">Received Date:</strong>
        <span>\${po.received_date ? new Date(po.received_date).toLocaleString() : 'Not received'}</span>
        
        <strong style="color:var(--text-muted);">Notes:</strong>
        <span>\${po.notes || 'None'}</span>
        
        <strong style="color:var(--text-muted);">Created By:</strong>
        <span>\${po.created_by_username || 'Unknown'}</span>
      </div>
      
      <strong style="color:var(--text-main); font-size:14px;">Items</strong>
      <div style="border:1px solid rgba(205,190,150,0.3); border-radius:8px; overflow:hidden; margin-top:8px;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead style="background:rgba(205,190,150,0.1);">
            <tr>
              <th style="padding:8px; text-align:left;">Item</th>
              <th style="padding:8px; text-align:right;">Qty</th>
              <th style="padding:8px; text-align:right;">Unit Cost</th>
              <th style="padding:8px; text-align:right;">Total Cost</th>
            </tr>
          </thead>
          <tbody>
            \${itemRows}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3" style="padding:8px; text-align:right; font-weight:700;">Subtotal:</td>
              <td style="padding:8px; text-align:right; font-weight:700;">\${Utils.formatCurrency(po.subtotal)}</td>
            </tr>
            <tr>
              <td colspan="3" style="padding:8px; text-align:right; font-weight:800; color:var(--text-main);">Total Amount:</td>
              <td style="padding:8px; text-align:right; font-weight:800; color:#c9a227; font-size:14px;">\${Utils.formatCurrency(po.total_amount)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  \`, \`<button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>\`);
}

async function receivePO(id, poNumber) {
  if (!confirm(\`Are you sure you want to receive PO \${poNumber}? This will automatically increase your inventory stock quantities and cannot be reversed.\`)) return;
  
  try {
    const res = await Auth.fetch(\`/api/v1/purchase-orders/\${id}/receive\`, {
      method: "POST"
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to receive Purchase Order");
    }
    Utils.showToast(\`Purchase Order \${poNumber} successfully received! Inventory updated.\`, "success");
    renderPurchases();
  } catch (e) {
    Utils.showToast(e.message, "danger");
  }
}

