/**
 * Supplier Management Module (suppliers.js)
 * Polished to match the Super Admin visual design system.
 */

let cachedSuppliers = [];

async function renderSuppliers(container) {
  if (!container) container = document.getElementById("view-container");
  if (!container) return;

  try {
    const res = await Auth.fetch("/api/v1/suppliers");
    if (res.ok) {
      cachedSuppliers = await res.json();
    } else {
      cachedSuppliers = [];
    }
  } catch (err) {
    console.error("Failed to fetch suppliers:", err);
    cachedSuppliers = [];
  }

  // Calculate KPI values
  const total = cachedSuppliers.length;
  const active = cachedSuppliers.filter(s => s.status && s.status.toLowerCase() === 'active').length;
  const beverage = cachedSuppliers.filter(s => s.category && s.category.toLowerCase() === 'beverages').length;
  const inactive = cachedSuppliers.filter(s => s.status && (s.status.toLowerCase() === 'inactive' || s.status.toLowerCase() === 'pending')).length;

  container.innerHTML = `
    <!-- Top Header & KPI Cards -->
    <div class="stats-grid fade-up" style="margin-bottom:24px;">
      <div class="stat-card">
        <div class="stat-icon gold"><i class="fas fa-truck"></i></div>
        <div class="stat-info">
          <h3>Total Suppliers</h3>
          <div class="stat-count" style="color:#c9a227;" id="kpi-total">${total}</div>
          <div class="stat-trend" style="color:#c9a227;"><i class="fas fa-building"></i> Registered Partners</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-check-circle"></i></div>
        <div class="stat-info">
          <h3>Active Suppliers</h3>
          <div class="stat-count" style="color:#10b981;" id="kpi-active">${active}</div>
          <div class="stat-trend" style="color:#10b981;"><i class="fas fa-link"></i> Currently Supplying</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-wine-glass"></i></div>
        <div class="stat-info">
          <h3>Beverage Suppliers</h3>
          <div class="stat-count" style="color:#f97316;" id="kpi-beverage">${beverage}</div>
          <div class="stat-trend" style="color:#f97316;"><i class="fas fa-glass-water"></i> Drink Partners</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon red"><i class="fas fa-times-circle"></i></div>
        <div class="stat-info">
          <h3>Pending / Inactive</h3>
          <div class="stat-count" style="color:#ef4444;" id="kpi-inactive">${inactive}</div>
          <div class="stat-trend" style="color:#ef4444;"><i class="fas fa-pause"></i> Needs Attention</div>
        </div>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="toolbar fade-up delay-1" style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:18px; flex-wrap:wrap;">
      <div style="display:flex; gap:12px; align-items:center; flex:1; min-width:280px; max-width:480px;">
        <div class="search-wrap" style="position:relative; flex:1;">
          <i class="fas fa-search" style="position:absolute; left:14px; top:50%; transform:translateY(-50%); color:var(--text-muted);"></i>
          <input type="text" id="sup-search" class="input-field" placeholder="Search supplier, contact, category..." style="padding-left:38px; width:100%;" oninput="filterSuppliersList()">
        </div>
        <select id="sup-filter-status" class="input-field" style="width:140px;" onchange="filterSuppliersList()">
          <option value="ALL">All Status</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
        </select>
      </div>
      <button class="btn btn-primary" onclick="openAddSupplierModal()" style="display:inline-flex; align-items:center; gap:8px;">
        <i class="fas fa-plus"></i> Register Supplier
      </button>
    </div>

    <!-- Table -->
    <div class="section-card fade-up delay-2">
      <div class="section-head">
        <h2>Supplier Management</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Supplier</th>
              <th>Category</th>
              <th>Contact</th>
              <th>Products Supplied</th>
              <th>Status</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody id="sup-tbody">
            ${renderSupplierRows(cachedSuppliers)}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderSupplierRows(suppliers) {
  if (!suppliers || !suppliers.length) {
    return '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">No suppliers found.</td></tr>';
  }
  
  return suppliers.map(s => {
    const isActive = s.status === "Active";
    const badgeClass = isActive ? 'badge-success' : 'badge-danger';
    
    return \`
      <tr>
        <td>
          <strong style="color:var(--text-main); font-size:13px;">\${s.supplier_name}</strong>
        </td>
        <td>
          <span class="badge" style="background:rgba(201,162,39,0.12); color:#c9a227; font-size:11px; font-weight:600;">\${s.category || 'Uncategorized'}</span>
        </td>
        <td style="color:var(--text-muted); font-size:13px;">\${s.contact_number || 'Not provided'}</td>
        <td style="color:var(--text-muted); font-size:13px; max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="\${s.products_supplied || ''}">
          \${s.products_supplied || 'Not provided'}
        </td>
        <td>
          <span class="badge \${badgeClass}" style="font-size:11px; font-weight:700;">\${s.status}</span>
        </td>
        <td style="text-align:right;">
          <div style="display:inline-flex; gap:6px;">
            <button class="btn btn-outline btn-sm" style="padding:4px 8px; font-size:11px;" onclick="viewSupplierModal(\${s.id})" title="View Details">
              <i class="fas fa-eye"></i> View
            </button>
            <button class="btn btn-outline btn-sm" style="padding:4px 8px; font-size:11px;" onclick="editSupplierModal(\${s.id})" title="Edit Supplier">
              <i class="fas fa-edit"></i> Edit
            </button>
            <button class="btn btn-primary btn-sm" style="padding:4px 8px; font-size:11px;" onclick="renderView('purchases'); setTimeout(() => openCreatePOModal(\${s.id}), 500);" title="Create PO">
              <i class="fas fa-file-invoice"></i> Create PO
            </button>
            <button class="btn btn-outline btn-sm" style="padding:4px 8px; font-size:11px; color:var(--danger);" onclick="deactivateSupplier(\${s.id}, '\${s.supplier_name.replace(/'/g, "\\'")}', \${isActive})" title="Toggle Status">
              <i class="fas \${isActive ? 'fa-ban' : 'fa-check'}"></i>
            </button>
          </div>
        </td>
      </tr>
    \`;
  }).join('');
}

function filterSuppliersList() {
  const q = (document.getElementById("sup-search")?.value || "").toLowerCase().trim();
  const status = document.getElementById("sup-filter-status")?.value || "ALL";

  const filtered = cachedSuppliers.filter(s => {
    const matchStatus = status === "ALL" || s.status === status;
    const matchSearch = !q || 
      (s.supplier_name && s.supplier_name.toLowerCase().includes(q)) || 
      (s.contact_number && s.contact_number.toLowerCase().includes(q)) ||
      (s.category && s.category.toLowerCase().includes(q));
    return matchStatus && matchSearch;
  });

  const tbody = document.getElementById("sup-tbody");
  if (tbody) tbody.innerHTML = renderSupplierRows(filtered);
}

function openAddSupplierModal() {
  Utils.openModal("Register New Supplier", \`
    <form id="form-add-sup" onsubmit="event.preventDefault(); submitAddSupplier();">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Supplier Name <span style="color:var(--danger);">*</span></label>
        <input id="sup-name" class="input-field" required placeholder="e.g. San Miguel Corp." style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Category</label>
          <input id="sup-cat" class="input-field" placeholder="e.g. Beverages" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Contact Number</label>
          <input id="sup-contact" class="input-field" placeholder="e.g. +63 900 000 0000" style="width:100%;">
        </div>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Products Supplied</label>
        <input id="sup-products" class="input-field" placeholder="e.g. Red Horse, Pilsen, San Mig Light" style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Contact Person</label>
          <input id="sup-person" class="input-field" placeholder="e.g. John Doe" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Email</label>
          <input type="email" id="sup-email" class="input-field" placeholder="e.g. contact@supplier.com" style="width:100%;">
        </div>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Address</label>
        <input id="sup-address" class="input-field" placeholder="Supplier Address" style="width:100%;">
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Notes</label>
        <textarea id="sup-notes" class="input-field" placeholder="Additional notes..." style="width:100%; min-height:60px;"></textarea>
      </div>
    </form>
  \`, \`<button class="btn btn-primary" onclick="submitAddSupplier()"><i class="fas fa-save"></i> Save Supplier</button>\`);
}

async function submitAddSupplier() {
  const data = {
    supplier_name: document.getElementById("sup-name").value.trim(),
    category: document.getElementById("sup-cat").value.trim() || undefined,
    contact_number: document.getElementById("sup-contact").value.trim() || undefined,
    products_supplied: document.getElementById("sup-products").value.trim() || undefined,
    contact_person: document.getElementById("sup-person").value.trim() || undefined,
    email: document.getElementById("sup-email").value.trim() || undefined,
    address: document.getElementById("sup-address").value.trim() || undefined,
    notes: document.getElementById("sup-notes").value.trim() || undefined,
    status: "Active"
  };

  if (!data.supplier_name) {
    Utils.showToast("Supplier Name is required", "danger");
    return;
  }

  try {
    const res = await Auth.fetch("/api/v1/suppliers", {
      method: "POST",
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to create supplier");
    }
    Utils.showToast("Supplier created successfully", "success");
    Utils.closeModal();
    renderSuppliers();
  } catch (e) {
    Utils.showToast(e.message, "danger");
  }
}

function viewSupplierModal(id) {
  const s = cachedSuppliers.find(x => x.id === id);
  if (!s) return;

  Utils.openModal(\`Supplier Details: \${s.supplier_name}\`, \`
    <div style="font-size:13px; color:var(--text-main);">
      <div style="display:grid; grid-template-columns:120px 1fr; gap:10px; margin-bottom:10px; border-bottom:1px solid rgba(205,190,150,0.2); padding-bottom:10px;">
        <strong style="color:var(--text-muted);">Supplier Name:</strong>
        <span>\${s.supplier_name}</span>
        
        <strong style="color:var(--text-muted);">Category:</strong>
        <span><span class="badge" style="background:rgba(201,162,39,0.12); color:#c9a227; font-size:11px;">\${s.category || 'Not provided'}</span></span>
        
        <strong style="color:var(--text-muted);">Contact Number:</strong>
        <span>\${s.contact_number || 'Not provided'}</span>
        
        <strong style="color:var(--text-muted);">Products Supplied:</strong>
        <span>\${s.products_supplied || 'Not provided'}</span>
        
        <strong style="color:var(--text-muted);">Status:</strong>
        <span><span class="badge \${s.status === 'Active' ? 'badge-success' : 'badge-danger'}" style="font-size:11px;">\${s.status}</span></span>
        
        <strong style="color:var(--text-muted);">Contact Person:</strong>
        <span>\${s.contact_person || 'Not provided'}</span>
        
        <strong style="color:var(--text-muted);">Email:</strong>
        <span>\${s.email || 'Not provided'}</span>
        
        <strong style="color:var(--text-muted);">Address:</strong>
        <span>\${s.address || 'Not provided'}</span>
        
        <strong style="color:var(--text-muted);">Notes:</strong>
        <span>\${s.notes || 'Not provided'}</span>
      </div>
    </div>
  \`, \`<button class="btn btn-outline" onclick="Utils.closeModal()">Close</button>\`);
}

function editSupplierModal(id) {
  const s = cachedSuppliers.find(x => x.id === id);
  if (!s) return;

  Utils.openModal(\`Edit Supplier: \${s.supplier_name}\`, \`
    <form id="form-edit-sup" onsubmit="event.preventDefault(); submitEditSupplier(\${s.id});">
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Supplier Name <span style="color:var(--danger);">*</span></label>
        <input id="edit-sup-name" class="input-field" required value="\${s.supplier_name.replace(/"/g, '&quot;')}" style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Category</label>
          <input id="edit-sup-cat" class="input-field" value="\${s.category || ''}" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Contact Number</label>
          <input id="edit-sup-contact" class="input-field" value="\${s.contact_number || ''}" style="width:100%;">
        </div>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Products Supplied</label>
        <input id="edit-sup-products" class="input-field" value="\${s.products_supplied || ''}" style="width:100%;">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Contact Person</label>
          <input id="edit-sup-person" class="input-field" value="\${s.contact_person || ''}" style="width:100%;">
        </div>
        <div class="input-group">
          <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Email</label>
          <input type="email" id="edit-sup-email" class="input-field" value="\${s.email || ''}" style="width:100%;">
        </div>
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Address</label>
        <input id="edit-sup-address" class="input-field" value="\${s.address || ''}" style="width:100%;">
      </div>
      <div class="input-group" style="margin-bottom:14px;">
        <label style="font-size:12px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Notes</label>
        <textarea id="edit-sup-notes" class="input-field" style="width:100%; min-height:60px;">\${s.notes || ''}</textarea>
      </div>
    </form>
  \`, \`<button class="btn btn-primary" onclick="submitEditSupplier(\${s.id})"><i class="fas fa-save"></i> Save Changes</button>\`);
}

async function submitEditSupplier(id) {
  const data = {
    supplier_name: document.getElementById("edit-sup-name").value.trim(),
    category: document.getElementById("edit-sup-cat").value.trim() || undefined,
    contact_number: document.getElementById("edit-sup-contact").value.trim() || undefined,
    products_supplied: document.getElementById("edit-sup-products").value.trim() || undefined,
    contact_person: document.getElementById("edit-sup-person").value.trim() || undefined,
    email: document.getElementById("edit-sup-email").value.trim() || undefined,
    address: document.getElementById("edit-sup-address").value.trim() || undefined,
    notes: document.getElementById("edit-sup-notes").value.trim() || undefined,
  };

  if (!data.supplier_name) {
    Utils.showToast("Supplier Name is required", "danger");
    return;
  }

  try {
    const res = await Auth.fetch(\`/api/v1/suppliers/\${id}\`, {
      method: "PUT",
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to update supplier");
    }
    Utils.showToast("Supplier updated successfully", "success");
    Utils.closeModal();
    renderSuppliers();
  } catch (e) {
    Utils.showToast(e.message, "danger");
  }
}

async function deactivateSupplier(id, name, isActive) {
  const actionStr = isActive ? "deactivate" : "activate";
  if (!confirm(\`Are you sure you want to \${actionStr} "\${name}"?\`)) return;
  try {
    const res = await Auth.fetch(\`/api/v1/suppliers/\${id}\`, {
      method: "PUT",
      body: JSON.stringify({ status: isActive ? "Inactive" : "Active" })
    });
    if (!res.ok) throw new Error(\`Failed to \${actionStr} supplier.\`);
    Utils.showToast(\`Supplier \${actionStr}d successfully\`, "success");
    renderSuppliers();
  } catch (err) {
    Utils.showToast(err.message, "danger");
  }
}
