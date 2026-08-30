function renderDashboard(c) {
  loadDB();
  const user = window.currentUser || { role: 'admin' };
  
  if (user.role === 'manager') {
    renderManagerDashboard(c);
  } else {
    renderAdminDashboard(c);
  }
}

function renderAdminDashboard(c) {
  const incTotal = DB.income.reduce((a, b) => a + Number(b.amount), 0);
  const activeOrders = DB.kitchenOrders.filter(o => o.status !== 'COMPLETED').length;
  const staffPresent = DB.attendance ? DB.attendance.filter(a => a.status === 'Present').length : 0;
  const lowStockCount = DB.inventory.filter(i => i.quantity <= i.minStock && i.quantity > 0).length;
  const totalUsers = DB.users.filter(u=>u.status==='Active').length;
  const totalInvItems = DB.inventory.length;

  c.innerHTML = `
    <div style="margin-bottom: 2rem;">
      <h2 style="font-size:1.8rem; font-weight:700; color:var(--text-main);">Admin Overview</h2>
      <p style="color:var(--text-muted);">Executive summary of restaurant performance.</p>
    </div>
    
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:1.5rem; margin-bottom:2rem;">
      <div class="card"><div class="card-title">Total Users</div><div class="card-value">${totalUsers}</div></div>
      <div class="card"><div class="card-title">Today's Sales</div><div class="card-value" style="color:var(--success);">₱${incTotal.toLocaleString()}</div></div>
      <div class="card"><div class="card-title">Pending Orders</div><div class="card-value" style="color:var(--info);">${activeOrders}</div></div>
      <div class="card"><div class="card-title">Inventory Items</div><div class="card-value">${totalInvItems}</div></div>
      <div class="card"><div class="card-title">Staff Present</div><div class="card-value" style="color:var(--success);">${staffPresent}</div></div>
      <div class="card"><div class="card-title">Low Stock</div><div class="card-value" style="color:var(--danger);">${lowStockCount}</div></div>
    </div>

    <div style="display:grid; grid-template-columns:2fr 1fr; gap:1.5rem;">
      <div class="card">
        <h3>Sales Overview</h3>
        <div style="height:250px; display:flex; align-items:flex-end; gap:20px; border-bottom:1px solid var(--border-glass); padding-bottom:10px; margin-top:20px;">
          <!-- Mock Chart -->
          <div style="flex:1; background:linear-gradient(to top, var(--accent-main), var(--accent-light)); height:40%; border-radius:4px 4px 0 0;"></div>
          <div style="flex:1; background:linear-gradient(to top, var(--accent-main), var(--accent-light)); height:60%; border-radius:4px 4px 0 0;"></div>
          <div style="flex:1; background:linear-gradient(to top, var(--accent-main), var(--accent-light)); height:30%; border-radius:4px 4px 0 0;"></div>
          <div style="flex:1; background:linear-gradient(to top, var(--accent-main), var(--accent-light)); height:80%; border-radius:4px 4px 0 0;"></div>
          <div style="flex:1; background:linear-gradient(to top, var(--accent-main), var(--accent-light)); height:50%; border-radius:4px 4px 0 0;"></div>
          <div style="flex:1; background:linear-gradient(to top, var(--accent-main), var(--accent-light)); height:90%; border-radius:4px 4px 0 0;"></div>
        </div>
        <div style="display:flex; justify-content:space-between; margin-top:10px; color:var(--text-muted); font-size:12px;">
          <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span>
        </div>
      </div>

      <div class="card">
        <h3>Recent Orders</h3>
        <div style="margin-top:1rem;">
          ${DB.sales.slice(0,4).map(s => `
            <div style="display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid var(--border-glass);">
              <div>
                <div style="font-weight:600;">${s.id}</div>
                <div style="font-size:12px; color:var(--text-muted);">${s.orderType} • ${s.cashierName || 'Cashier'}</div>
              </div>
              <div style="font-weight:700; color:var(--accent-dark);">₱${s.total}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderManagerDashboard(c) {
  const incTotal = DB.income.reduce((a, b) => a + Number(b.amount), 0);
  const totalOrders = DB.sales.length;
  const staffPresent = DB.attendance ? DB.attendance.filter(a => a.status === 'Present').length : 0;
  const staffAbsent = DB.attendance ? DB.attendance.filter(a => a.status === 'Absent').length : 0;
  const lowStockCount = DB.inventory.filter(i => i.quantity <= i.minStock && i.quantity > 0).length;
  
  const pending = DB.kitchenOrders.filter(o=>o.status==='PENDING').length;
  const preparing = DB.kitchenOrders.filter(o=>o.status==='PREPARING').length;
  const ready = 0; // if ready status exists, otherwise completed in last 1hr
  const completed = DB.kitchenOrders.filter(o=>o.status==='COMPLETED').length;
  const totalOps = pending + preparing + ready + completed || 1;

  c.innerHTML = `
    <div style="margin-bottom: 2rem;">
      <h2 style="font-size:1.8rem; font-weight:700; color:var(--text-main);">Manager Dashboard</h2>
      <p style="color:var(--text-muted);">Real-time operations & daily metrics.</p>
    </div>

    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:1.5rem; margin-bottom:2rem;">
      <div class="card"><div class="card-title">Today's Sales</div><div class="card-value" style="color:var(--success);">₱${incTotal.toLocaleString()}</div></div>
      <div class="card"><div class="card-title">Orders Today</div><div class="card-value">${totalOrders}</div></div>
      <div class="card"><div class="card-title">Pending Orders</div><div class="card-value" style="color:var(--warning);">${pending}</div></div>
      <div class="card"><div class="card-title">Low Stock</div><div class="card-value" style="color:var(--danger);">${lowStockCount}</div></div>
      <div class="card"><div class="card-title">Staff Present</div><div class="card-value" style="color:var(--success);">${staffPresent}</div></div>
      <div class="card"><div class="card-title">Staff Absent</div><div class="card-value" style="color:var(--danger);">${staffAbsent}</div></div>
    </div>

    <div class="card" style="margin-bottom:2rem;">
      <h3 style="margin-bottom:1.5rem; text-transform:uppercase; letter-spacing:1px; color:var(--text-muted);">Today's Operations</h3>
      
      <div class="op-row">
        <div class="op-label"><span>Pending</span><span style="color:var(--warning);">${pending}</span></div>
        <div class="progress-container"><div class="progress-bar progress-pending" style="width:${(pending/totalOps)*100}%"></div></div>
      </div>
      <div class="op-row">
        <div class="op-label"><span>Preparing</span><span style="color:var(--info);">${preparing}</span></div>
        <div class="progress-container"><div class="progress-bar progress-preparing" style="width:${(preparing/totalOps)*100}%"></div></div>
      </div>
      <div class="op-row">
        <div class="op-label"><span>Ready</span><span style="color:var(--success);">${ready}</span></div>
        <div class="progress-container"><div class="progress-bar progress-ready" style="width:${(ready/totalOps)*100}%"></div></div>
      </div>
      <div class="op-row">
        <div class="op-label"><span>Completed</span><span style="color:var(--accent-main);">${completed}</span></div>
        <div class="progress-container"><div class="progress-bar progress-completed" style="width:${(completed/totalOps)*100}%"></div></div>
      </div>
    </div>
  `;
}

// --- VIEW 2: INVENTORY MANAGEMENT ---
function renderInventory(c) {
  const totalProducts = DB.inventory.length;
  const lowStock = DB.inventory.filter(i => i.quantity <= i.minStock && i.quantity > 0).length;
  const outOfStock = DB.inventory.filter(i => i.quantity <= 0).length;
  const invValue = DB.inventory.reduce((a, i) => a + (i.quantity * i.unitCost), 0);
  
  // Mock data for stock in/out today
  const stockInToday = DB.purchases ? DB.purchases.filter(p => p.status === 'Received').length : 0;
  const stockOutToday = DB.wastage ? DB.wastage.length : 0; // rough proxy

  let html = `
    <div style="margin-bottom: 2rem;">
      <h2 style="font-size:1.8rem; font-weight:700; color:var(--text-main);">Inventory Management</h2>
      <p style="color:var(--text-muted);">Real-time stock levels and reorder alerts.</p>
    </div>

    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:1.5rem; margin-bottom:2rem;">
      <div class="card"><div class="card-title">Total Products</div><div class="card-value">${totalProducts}</div></div>
      <div class="card"><div class="card-title">Low Stock</div><div class="card-value" style="color:var(--warning);">${lowStock}</div></div>
      <div class="card"><div class="card-title">Out of Stock</div><div class="card-value" style="color:var(--danger);">${outOfStock}</div></div>
      <div class="card"><div class="card-title">Stock In Today</div><div class="card-value">${stockInToday}</div></div>
      <div class="card"><div class="card-title">Stock Out Today</div><div class="card-value">${stockOutToday}</div></div>
      <div class="card"><div class="card-title">Inventory Value</div><div class="card-value">₱${invValue.toLocaleString()}</div></div>
    </div>

    <div class="card">
      <div class="flex justify-between items-center" style="margin-bottom:1rem;">
        <input type="text" id="inv-search" class="form-control" placeholder="Search inventory..." style="max-width: 300px;" oninput="filterInventoryTable()">
        <div class="flex gap-2">
          <button class="btn btn-primary" onclick="openAddInventoryModal()">+ Add Product</button>
          <button class="btn btn-success" onclick="openStockInModal()">+ Stock In</button>
          <button class="btn btn-danger" onclick="openStockOutModal()">- Stock Out</button>
          <button class="btn btn-outline" onclick="openStockAdjustModal()">Adjust Stock</button>
        </div>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Category</th>
              <th>Current Stock</th>
              <th>Unit</th>
              <th>Reorder Level</th>
              <th>Status</th>
              <th>Last Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="inventory-tbody">
            ${generateInventoryRows(DB.inventory)}
          </tbody>
        </table>
      </div>
    </div>
  `;
  c.innerHTML = html;
}

function generateInventoryRows(items) {
  return items.map(i => {
    let status = "IN STOCK";
    let badgeClass = "badge-success";
    if (i.quantity <= 0) { status = "OUT OF STOCK"; badgeClass = "badge-danger"; }
    else if (i.quantity <= i.minStock) { status = "LOW STOCK"; badgeClass = "badge-warning"; }

    return `
      <tr>
        <td><strong>${i.name}</strong></td>
        <td>${i.category}</td>
        <td style="font-weight:700;">${i.quantity}</td>
        <td>${i.unit}</td>
        <td>${i.minStock}</td>
        <td><span class="badge ${badgeClass}">${status}</span></td>
        <td>Today</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="openEditInventoryModal('${i.id}')">Edit</button>
          <button class="btn btn-outline btn-sm" style="color:var(--danger); border-color:var(--danger);" onclick="deleteInventoryItem('${i.id}')">Del</button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterInventoryTable() {
  const q = document.getElementById("inv-search").value.toLowerCase();
  const filtered = DB.inventory.filter(i => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));
  document.getElementById("inventory-tbody").innerHTML = generateInventoryRows(filtered);
}

function openAddInventoryModal() {
  openModal("Add New Inventory Item", `
    <form id="form-add-inv">
      <div class="form-group"><label>Item Name</label><input id="inv-name" class="form-control" required></div>
      <div class="form-group"><label>Category</label><input id="inv-cat" class="form-control" required placeholder="Meat, Produce, Dairy..."></div>
      <div class="grid-4" style="grid-template-columns:1fr 1fr; gap:0.5rem;">
        <div class="form-group"><label>Quantity</label><input type="number" id="inv-qty" class="form-control" required min="0"></div>
        <div class="form-group"><label>Unit</label><input id="inv-unit" class="form-control" required placeholder="kg, pcs, bottles"></div>
      </div>
      <div class="grid-4" style="grid-template-columns:1fr 1fr; gap:0.5rem;">
        <div class="form-group"><label>Min Stock</label><input type="number" id="inv-min" class="form-control" required min="0"></div>
        <div class="form-group"><label>Max Stock</label><input type="number" id="inv-max" class="form-control" required min="1"></div>
      </div>
      <div class="form-group"><label>Unit Cost (₱)</label><input type="number" id="inv-cost" class="form-control" required min="0"></div>
      <div class="form-group"><label>Expiration Date</label><input type="date" id="inv-exp" class="form-control"></div>
    </form>
  `, `<button class="btn btn-primary" onclick="submitAddInventory()">Save Item</button>`);
}

function submitAddInventory() {
  const name = document.getElementById("inv-name").value.trim();
  if (!name) return showToast("Item Name is required", "danger");

  const newItem = {
    id: "INV-" + (DB.inventory.length + 1).toString().padStart(2, '0'),
    name,
    category: document.getElementById("inv-cat").value.trim() || "General",
    quantity: Number(document.getElementById("inv-qty").value),
    unit: document.getElementById("inv-unit").value.trim() || "pcs",
    minStock: Number(document.getElementById("inv-min").value),
    maxStock: Number(document.getElementById("inv-max").value),
    unitCost: Number(document.getElementById("inv-cost").value),
    expDate: document.getElementById("inv-exp").value
  };

  DB.inventory.push(newItem);
  saveDB();
  logActivity("Add Item", "Inventory", `Added ${newItem.name}`);
  showToast("Inventory item added successfully", "success");
  closeModal();
  renderInventory(document.getElementById("view-container"));
}

function openEditInventoryModal(id) {
  const item = DB.inventory.find(i => i.id === id);
  if (!item) return;

  openModal("Edit Item: " + item.name, `
    <form id="form-edit-inv">
      <div class="form-group"><label>Item Name</label><input id="e-inv-name" class="form-control" value="${item.name}"></div>
      <div class="form-group"><label>Category</label><input id="e-inv-cat" class="form-control" value="${item.category}"></div>
      <div class="grid-4" style="grid-template-columns:1fr 1fr; gap:0.5rem;">
        <div class="form-group"><label>Min Stock</label><input type="number" id="e-inv-min" class="form-control" value="${item.minStock}"></div>
        <div class="form-group"><label>Max Stock</label><input type="number" id="e-inv-max" class="form-control" value="${item.maxStock}"></div>
      </div>
      <div class="form-group"><label>Unit Cost (₱)</label><input type="number" id="e-inv-cost" class="form-control" value="${item.unitCost}"></div>
      <div class="form-group"><label>Expiration Date</label><input type="date" id="e-inv-exp" class="form-control" value="${item.expDate}"></div>
    </form>
  `, `<button class="btn btn-primary" onclick="submitEditInventory('${id}')">Update Item</button>`);
}

function submitEditInventory(id) {
  const item = DB.inventory.find(i => i.id === id);
  if (!item) return;

  item.name = document.getElementById("e-inv-name").value.trim();
  item.category = document.getElementById("e-inv-cat").value.trim();
  item.minStock = Number(document.getElementById("e-inv-min").value);
  item.maxStock = Number(document.getElementById("e-inv-max").value);
  item.unitCost = Number(document.getElementById("e-inv-cost").value);
  item.expDate = document.getElementById("e-inv-exp").value;

  saveDB();
  logActivity("Edit Item", "Inventory", `Updated details for ${item.name}`);
  showToast("Item updated successfully", "success");
  closeModal();
  renderInventory(document.getElementById("view-container"));
}

function deleteInventoryItem(id) {
  const item = DB.inventory.find(i => i.id === id);
  confirmAction("Delete Inventory Item", `Are you sure you want to delete ${item ? item.name : 'this item'}?`, () => {
    DB.inventory = DB.inventory.filter(i => i.id !== id);
    saveDB();
    logActivity("Delete Item", "Inventory", `Deleted ${id}`);
    showToast("Item deleted successfully", "success");
    renderInventory(document.getElementById("view-container"));
  });
}

function openStockInModal() {
  const opts = DB.inventory.map(i => `<option value="${i.id}">${i.name} (Current: ${i.quantity} ${i.unit})</option>`).join('');
  openModal("Stock In Movement", `
    <div class="form-group"><label>Select Item</label><select id="stk-id" class="form-control">${opts}</select></div>
    <div class="form-group"><label>Quantity to Add</label><input type="number" id="stk-qty" class="form-control" min="1" value="1"></div>
    <div class="form-group"><label>Notes / Supplier Reference</label><input id="stk-notes" class="form-control" placeholder="Optional notes"></div>
  `, `<button class="btn btn-success" onclick="submitStockIn()">Complete Stock In</button>`);
}

function submitStockIn() {
  const id = document.getElementById("stk-id").value;
  const qty = Number(document.getElementById("stk-qty").value);
  const item = DB.inventory.find(i => i.id === id);

  if (item && qty > 0) {
    item.quantity += qty;
    saveDB();
    logActivity("Stock-In", "Inventory", `+${qty} ${item.unit} to ${item.name}`);
    showToast(`Added ${qty} ${item.unit} to ${item.name}`, "success");
    closeModal();
    renderInventory(document.getElementById("view-container"));
  }
}

function openStockOutModal() {
  const opts = DB.inventory.map(i => `<option value="${i.id}">${i.name} (Current: ${i.quantity} ${i.unit})</option>`).join('');
  openModal("Stock Out Movement", `
    <div class="form-group"><label>Select Item</label><select id="stko-id" class="form-control">${opts}</select></div>
    <div class="form-group"><label>Quantity to Remove</label><input type="number" id="stko-qty" class="form-control" min="1" value="1"></div>
    <div class="form-group"><label>Reason</label>
      <select id="stko-reason" class="form-control">
        <option>Kitchen Usage</option><option>Bar Usage</option><option>Internal Consumption</option><option>Damaged</option>
      </select>
    </div>
  `, `<button class="btn btn-danger" onclick="submitStockOut()">Complete Stock Out</button>`);
}

function submitStockOut() {
  const id = document.getElementById("stko-id").value;
  const qty = Number(document.getElementById("stko-qty").value);
  const item = DB.inventory.find(i => i.id === id);

  if (!item) return;
  if (qty > item.quantity) return showToast("Stock-Out quantity exceeds current stock!", "danger");

  item.quantity -= qty;
  saveDB();
  logActivity("Stock-Out", "Inventory", `-${qty} ${item.unit} from ${item.name}`);
  showToast(`Removed ${qty} ${item.unit} from ${item.name}`, "success");
  closeModal();
  renderInventory(document.getElementById("view-container"));
}

function openStockAdjustModal() {
  const opts = DB.inventory.map(i => `<option value="${i.id}">${i.name} (Current: ${i.quantity} ${i.unit})</option>`).join('');
  openModal("Inventory Adjustment", `
    <div class="form-group"><label>Select Item</label><select id="adj-id" class="form-control">${opts}</select></div>
    <div class="form-group"><label>New Exact Quantity</label><input type="number" id="adj-qty" class="form-control" min="0"></div>
    <div class="form-group"><label>Adjustment Reason</label><input id="adj-reason" class="form-control" placeholder="e.g. Physical Audit Count"></div>
  `, `<button class="btn btn-primary" onclick="submitStockAdjust()">Save Adjustment</button>`);
}

function submitStockAdjust() {
  const id = document.getElementById("adj-id").value;
  const newQty = Number(document.getElementById("adj-qty").value);
  const item = DB.inventory.find(i => i.id === id);

  if (item && newQty >= 0) {
    const diff = newQty - item.quantity;
    item.quantity = newQty;
    saveDB();
    logActivity("Stock Adjust", "Inventory", `Adjusted ${item.name} (${diff >= 0 ? '+' + diff : diff})`);
    showToast(`Adjusted ${item.name} stock to ${newQty}`, "success");
    closeModal();
    renderInventory(document.getElementById("view-container"));
  }
}

// --- VIEW 3: PRODUCTS & RECIPES ---
function renderProducts(c) {
  let html = `
    <div class="flex justify-between items-center" style="margin-bottom:1rem;">
      <h3>Menu Items & Recipes</h3>
      <button class="btn btn-primary" onclick="openAddProductModal()">+ Add Product</button>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>ID</th><th>Product Name</th><th>Category</th><th>Selling Price</th><th>Est Cost</th><th>Recipe Ingredients</th><th>Actions</th></tr></thead>
        <tbody>
          ${DB.products.map(p => `
            <tr>
              <td>${p.id}</td>
              <td><strong>${p.name}</strong></td>
              <td>${p.category}</td>
              <td>₱${p.price}</td>
              <td>₱${p.cost}</td>
              <td>${p.recipe.map(r => {
                const ing = DB.inventory.find(i=>i.id === r.invId);
                return ing ? `${ing.name} (${r.qty}${ing.unit})` : '';
              }).join(', ')}</td>
              <td>
                <button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  c.innerHTML = html;
}

function openAddProductModal() {
  openModal("Add Product Menu Item", `
    <div class="form-group"><label>Product Name</label><input id="prd-name" class="form-control" required></div>
    <div class="form-group"><label>Category</label>
      <select id="prd-cat" class="form-control">
        <option>Food</option><option>Drinks</option><option>Beer</option><option>Cocktails</option><option>Liquor</option><option>Desserts</option>
      </select>
    </div>
    <div class="form-group"><label>Selling Price (₱)</label><input type="number" id="prd-price" class="form-control" required></div>
    <div class="form-group"><label>Estimated Direct Cost (₱)</label><input type="number" id="prd-cost" class="form-control" required></div>
  `, `<button class="btn btn-primary" onclick="submitAddProduct()">Save Product</button>`);
}

function submitAddProduct() {
  const name = document.getElementById("prd-name").value.trim();
  if (!name) return showToast("Product Name required", "danger");

  const newPrd = {
    id: "PRD-" + (DB.products.length + 1).toString().padStart(2, '0'),
    name,
    category: document.getElementById("prd-cat").value,
    price: Number(document.getElementById("prd-price").value),
    cost: Number(document.getElementById("prd-cost").value),
    recipe: [] // Default empty recipe
  };

  DB.products.push(newPrd);
  saveDB();
  logActivity("Add Product", "Products", `Created product ${newPrd.name}`);
  showToast("Product menu item created", "success");
  closeModal();
  renderProducts(document.getElementById("view-container"));
}

function deleteProduct(id) {
  confirmAction("Delete Product", "Are you sure you want to delete this menu item?", () => {
    DB.products = DB.products.filter(p => p.id !== id);
    saveDB();
    logActivity("Delete Product", "Products", `Deleted product ${id}`);
    showToast("Product deleted", "success");
    renderProducts(document.getElementById("view-container"));
  });
}

// --- VIEW 4: POS & AUTOMATIC RECIPE DEDUCTION ---
let posCart = [];

function renderPOS(c) {
  let html = `
    <div class="pos-container" style="display:grid; grid-template-columns: 2fr 1fr; gap:1.5rem; height:calc(100vh - 100px);">
      <!-- LEFT COLUMN -->
      <div class="pos-products" style="display:flex; flex-direction:column;">
        <div class="pos-categories flex gap-2" style="margin-bottom:1rem; overflow-x:auto; padding-bottom:8px;">
          <button class="btn btn-outline" style="border-radius:20px;" onclick="filterPOS('All')">All</button>
          <button class="btn btn-outline" style="border-radius:20px;" onclick="filterPOS('Food')">Food</button>
          <button class="btn btn-outline" style="border-radius:20px;" onclick="filterPOS('Drinks')">Drinks</button>
          <button class="btn btn-outline" style="border-radius:20px;" onclick="filterPOS('Beer')">Beer</button>
          <button class="btn btn-outline" style="border-radius:20px;" onclick="filterPOS('Cocktails')">Cocktails</button>
          <input type="text" id="pos-search" class="form-control" placeholder="Search..." style="max-width:200px; margin-left:auto;" oninput="searchPOS()">
        </div>
        <div class="pos-grid" id="pos-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:1rem; overflow-y:auto; padding-right:8px;">
          ${generatePOSCards(DB.products)}
        </div>
      </div>

      <!-- RIGHT COLUMN -->
      <div class="pos-cart card" style="display:flex; flex-direction:column; padding:0; overflow:hidden;">
        <div class="cart-header" style="padding:1.5rem; background:rgba(0,0,0,0.02); border-bottom:1px solid var(--border-glass);">
          <div class="flex justify-between items-center">
            <span style="font-weight:700; font-size:1.2rem;">Current Order</span>
            <button class="btn btn-outline btn-sm" onclick="clearCart()">Clear</button>
          </div>
          <div class="flex gap-2" style="margin-top:1rem;">
            <select id="pos-order-type" class="form-control" style="flex:1;"><option>Dine In</option><option>Take Out</option></select>
            <input type="text" id="pos-table" class="form-control" placeholder="Table #" style="flex:1;">
          </div>
        </div>
        <div class="cart-items" id="cart-items" style="flex:1; overflow-y:auto; padding:1.5rem;">
          <!-- Dynamic Cart Rendering -->
        </div>
        <div class="cart-footer" style="padding:1.5rem; background:var(--white); border-top:1px solid var(--border-glass);">
          <div class="flex justify-between" style="color:var(--text-muted); margin-bottom:0.5rem;">
            <span>Subtotal</span><span id="cart-subtotal">₱0.00</span>
          </div>
          <div class="flex justify-between" style="color:var(--text-muted); margin-bottom:1rem; padding-bottom:1rem; border-bottom:1px dashed var(--border-side);">
            <span>Discount (0%)</span><span>₱0.00</span>
          </div>
          <div class="flex justify-between" style="font-size:1.5rem; font-weight:700; color:var(--text-main); margin-bottom:1.5rem;">
            <span>Total</span><span id="cart-total">₱0.00</span>
          </div>
          <button class="btn btn-primary w-full" style="padding:1.25rem; font-size:1.1rem; border-radius:12px;" onclick="openPaymentModal()" id="btn-pay">
            PAY NOW — ₱0.00
          </button>
        </div>
      </div>
    </div>
  `;
  c.innerHTML = html;
  updateCartUI();
}

function generatePOSCards(products) {
  return products.map(p => {
    // Generate a beautiful placeholder using CSS gradients for food imagery
    const hue = (p.id.charCodeAt(p.id.length-1) * 37) % 360;
    return `
      <div class="product-card" style="padding:0; overflow:hidden; border:var(--border-glass); border-radius:var(--radius-card); background:var(--white); cursor:pointer; transition:var(--transition); display:flex; flex-direction:column;" onclick="addToCart('${p.id}')">
        <div style="height:120px; background:linear-gradient(135deg, hsl(${hue}, 40%, 90%), hsl(${hue}, 40%, 75%)); display:flex; align-items:center; justify-content:center; font-size:2rem; color:white;">🍽️</div>
        <div style="padding:1rem;">
          <div style="font-weight:700; font-size:14px; margin-bottom:4px; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.name}</div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div style="font-size:12px; color:var(--text-muted);">${p.category}</div>
            <div style="font-weight:700; color:var(--accent-dark);">₱${p.price.toFixed(2)}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function filterPOS(cat) {
  const items = cat === 'All' ? DB.products : DB.products.filter(p => p.category === cat);
  document.getElementById("pos-grid").innerHTML = generatePOSCards(items);
}

function searchPOS() {
  const q = document.getElementById("pos-search").value.toLowerCase();
  const filtered = DB.products.filter(p => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
  document.getElementById("pos-grid").innerHTML = generatePOSCards(filtered);
}

function addToCart(prdId) {
  const product = DB.products.find(p => p.id === prdId);
  if (!product) return;

  const existing = posCart.find(item => item.id === prdId);
  if (existing) {
    existing.qty += 1;
  } else {
    posCart.push({ id: product.id, name: product.name, price: product.price, qty: 1, recipe: product.recipe });
  }
  updateCartUI();
}

function updateCartUI() {
  const cartContainer = document.getElementById("cart-items");
  if (!cartContainer) return;

  if (posCart.length === 0) {
    cartContainer.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:var(--text-muted); opacity:0.5;">
        <span style="font-size:3rem; margin-bottom:1rem;">🛒</span>
        <p>Your cart is empty</p>
      </div>`;
    document.getElementById("cart-subtotal").innerText = "₱0.00";
    document.getElementById("cart-total").innerText = "₱0.00";
    if(document.getElementById("btn-pay")) document.getElementById("btn-pay").innerText = "PAY NOW — ₱0.00";
    return;
  }

  let subtotal = 0;
  cartContainer.innerHTML = posCart.map((item, idx) => {
    const itemTotal = item.price * item.qty;
    subtotal += itemTotal;
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid rgba(0,0,0,0.04);">
        <div style="flex:1;">
          <div style="font-weight:600; font-size:14px; color:var(--text-main);">${item.name}</div>
          <div style="font-size:12px; color:var(--accent-dark);">₱${item.price.toFixed(2)}</div>
        </div>
        <div style="display:flex; align-items:center; gap:12px; background:rgba(0,0,0,0.03); padding:4px 8px; border-radius:20px;">
          <button style="border:none; background:none; cursor:pointer; width:24px; height:24px; display:flex; align-items:center; justify-content:center; border-radius:50%; background:var(--white); box-shadow:var(--shadow-soft);" onclick="changeCartQty(${idx}, -1)">-</button>
          <span style="font-weight:700; font-size:14px; min-width:16px; text-align:center;">${item.qty}</span>
          <button style="border:none; background:none; cursor:pointer; width:24px; height:24px; display:flex; align-items:center; justify-content:center; border-radius:50%; background:var(--white); box-shadow:var(--shadow-soft);" onclick="changeCartQty(${idx}, 1)">+</button>
        </div>
        <div style="font-weight:700; font-size:14px; min-width:70px; text-align:right;">
          ₱${itemTotal.toFixed(2)}
        </div>
      </div>
    `;
  }).join('');

  document.getElementById("cart-subtotal").innerText = `₱${subtotal.toFixed(2)}`;
  document.getElementById("cart-total").innerText = `₱${subtotal.toFixed(2)}`;
  if(document.getElementById("btn-pay")) document.getElementById("btn-pay").innerText = `PAY NOW — ₱${subtotal.toFixed(2)}`;
}

function changeCartQty(index, delta) {
  posCart[index].qty += delta;
  if (posCart[index].qty <= 0) {
    posCart.splice(index, 1);
  }
  updateCartUI();
}

function clearCart() {
  posCart = [];
  updateCartUI();
}

function createKitchenOrderFromSale(sale, orderId) {
  if (!DB.kitchenOrders) DB.kitchenOrders = [];
  if (!DB.notifications) DB.notifications = [];

  const currentUser = window.currentUser || { name: 'Cashier' };

  const order = {
    id: orderId,
    createdAt: sale.date,
    cashier: sale.cashier,
    cashierName: currentUser.name,
    orderType: sale.orderType || "Dine In",
    tableNo: sale.tableNo || "",
    notes: sale.notes || "",
    items: JSON.parse(JSON.stringify(sale.items)),
    total: sale.total,
    transactionId: sale.id,
    status: "PENDING",
    acceptedAt: null,
    acceptedBy: null,
    completedAt: null,
    completedBy: null
  };

  DB.kitchenOrders.unshift(order);
  addNotification(
    `🍳 NEW ORDER #${orderId}: ${order.items.map(i => `${i.qty}x ${i.name}`).join(", ")}`,
    "warning", "kitchen", "kitchen", orderId
  );
  return order;
}

function openPaymentModal() {
  if (posCart.length === 0) return showToast("Cart is empty!", "danger");
  
  const total = posCart.reduce((a, b) => a + (b.price * b.qty), 0);
  
  openModal("Complete Payment", `
    <div style="text-align:center; margin-bottom:2rem;">
      <div style="font-size:14px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">TOTAL DUE</div>
      <div style="font-size:3rem; font-weight:700; color:var(--text-main); line-height:1;">₱${total.toFixed(2)}</div>
    </div>
    
    <div class="form-group">
      <label style="font-size:12px; text-transform:uppercase; letter-spacing:1px;">Payment Method</label>
      <div style="display:flex; gap:10px;">
        <label style="flex:1; border:1px solid var(--border-side); border-radius:8px; padding:12px; text-align:center; cursor:pointer; background:var(--white); box-shadow:var(--shadow-soft);">
          <input type="radio" name="payMethod" value="Cash" checked style="display:none;" onchange="updatePayMethod(this)">
          <div style="font-weight:600;">CASH</div>
        </label>
        <label style="flex:1; border:1px solid var(--border-side); border-radius:8px; padding:12px; text-align:center; cursor:pointer; background:var(--white); box-shadow:var(--shadow-soft);">
          <input type="radio" name="payMethod" value="GCash" style="display:none;" onchange="updatePayMethod(this)">
          <div style="font-weight:600;">GCASH</div>
        </label>
        <label style="flex:1; border:1px solid var(--border-side); border-radius:8px; padding:12px; text-align:center; cursor:pointer; background:var(--white); box-shadow:var(--shadow-soft);">
          <input type="radio" name="payMethod" value="Card" style="display:none;" onchange="updatePayMethod(this)">
          <div style="font-weight:600;">CARD</div>
        </label>
      </div>
    </div>
    
    <div class="form-group" style="margin-top:1.5rem;">
      <label style="font-size:12px; text-transform:uppercase; letter-spacing:1px;">Amount Received (₱)</label>
      <input type="number" id="pay-amount" class="form-control" style="font-size:1.5rem; text-align:center; height:60px;" value="${total}" oninput="calcChange(${total})">
    </div>
    
    <div class="flex justify-between items-center" style="background:rgba(0,0,0,0.02); padding:1rem; border-radius:8px; margin-top:1rem;">
      <span style="font-size:14px; font-weight:600; color:var(--text-muted);">CHANGE</span>
      <span id="pay-change" style="font-size:1.5rem; font-weight:700; color:var(--success);">₱0.00</span>
    </div>
  `, `
    <div class="flex gap-2 w-full">
      <button class="btn btn-outline" style="flex:1; height:50px; font-size:1rem;" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" style="flex:2; height:50px; font-size:1rem;" onclick="completeSale()">Complete Payment</button>
    </div>
  `);
}

function updatePayMethod(radio) {
  const labels = radio.closest('.form-group').querySelectorAll('label');
  labels.forEach(l => l.style.border = '1px solid var(--border-side)');
  radio.closest('label').style.border = '2px solid var(--accent-main)';
}

function calcChange(total) {
  const received = Number(document.getElementById("pay-amount").value);
  const change = received >= total ? received - total : 0;
  document.getElementById("pay-change").innerText = \`₱\${change.toFixed(2)}\`;
  document.getElementById("pay-change").style.color = received >= total ? 'var(--success)' : 'var(--danger)';
}

function completeSale() {
  if (posCart.length === 0) return showToast("Cart is empty!", "danger");

  const total = posCart.reduce((a, b) => a + (b.price * b.qty), 0);
  const tendered = Number(document.getElementById("pay-amount")?.value || total); // fallback to total if missing
  const payMethodRadio = document.querySelector('input[name="payMethod"]:checked');
  const payMethod = payMethodRadio ? payMethodRadio.value : "Cash";
  
  const orderType = document.getElementById("pos-order-type")?.value || "Dine In";
  const tableNo = document.getElementById("pos-table")?.value.trim() || "";
  const notes = "No notes"; // Simplified for now since we removed notes from modal to make it cleaner

  if (tendered < total) return showToast("Insufficient Payment Amount!", "danger");

  loadDB();
  if (!DB.sales) DB.sales = [];
  if (!DB.income) DB.income = [];
  if (!DB.kitchenOrders) DB.kitchenOrders = [];
  if (!DB.notifications) DB.notifications = [];
  if (!DB.inventory) DB.inventory = [];

  const change = tendered - total;
  const trxId = "TRX-" + Date.now().toString().slice(-6);
  const kitchenOrderId = "ORD-" + Date.now().toString().slice(-6);
  const transactionDate = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const saleItems = JSON.parse(JSON.stringify(posCart));

  // Validate all recipe ingredients before deducting any inventory.
  const requiredIngredients = {};
  saleItems.forEach(cartItem => {
    (cartItem.recipe || []).forEach(ingredient => {
      const required = Number(ingredient.qty) * Number(cartItem.qty);
      requiredIngredients[ingredient.invId] = (requiredIngredients[ingredient.invId] || 0) + required;
    });
  });

  for (const [invId, requiredQty] of Object.entries(requiredIngredients)) {
    const invItem = DB.inventory.find(i => i.id === invId);
    if (!invItem) return showToast(`Inventory item ${invId} is missing from the system.`, "danger");
    if (Number(invItem.quantity) < requiredQty) {
      return showToast(`Insufficient stock: ${invItem.name}. Required ${requiredQty}${invItem.unit}, available ${invItem.quantity}${invItem.unit}.`, "danger");
    }
  }

  // Deduct ingredients automatically when the cashier completes the sale.
  Object.entries(requiredIngredients).forEach(([invId, requiredQty]) => {
    const invItem = DB.inventory.find(i => i.id === invId);
    if (!invItem) return;
    invItem.quantity = Number(invItem.quantity) - Number(requiredQty);
    if (invItem.quantity <= invItem.minStock) {
      addNotification(
        `LOW STOCK ALERT: ${invItem.name} remaining (${invItem.quantity}${invItem.unit})`,
        "warning", "inventory", "admin"
      );
    }
  });

  const currentUser = window.currentUser || { username: 'cashier', name: 'Cashier' };
  const saleRecord = {
    id: trxId, date: transactionDate, items: saleItems, total, tendered, change,
    paymentMethod: payMethod, orderType, tableNo, notes,
    cashier: currentUser.username, cashierName: currentUser.name,
    kitchenOrderId, kitchenStatus: "PENDING"
  };

  DB.sales.unshift(saleRecord);
  DB.income.unshift({
    id: "INC-" + Date.now().toString().slice(-6),
    date: transactionDate.slice(0, 10), source: "POS Sales", ref: trxId,
    amount: total, recordedBy: currentUser.username
  });

  // IMPORTANT: completed cashier transaction automatically appears in Kitchen.
  createKitchenOrderFromSale(saleRecord, kitchenOrderId);

  saveDB();
  logActivity("Complete Sale & Send to Kitchen", "POS", `Completed Sale #${trxId} for ₱${total}; Kitchen Order #${kitchenOrderId} created automatically`);
  generateReceiptView(saleRecord);

  posCart = [];
  showToast(`Sale #${trxId} completed. Order #${kitchenOrderId} sent to Kitchen! Change: ₱${change.toFixed(2)}`, "success");
  renderPOS(document.getElementById("view-container"));
}

function generateReceiptView(sale) {
  let receiptEl = document.getElementById("printable-receipt");
  if (!receiptEl) {
    receiptEl = document.createElement("div");
    receiptEl.id = "printable-receipt";
    receiptEl.className = "hidden";
    receiptEl.style = "padding: 20px; font-family: monospace; max-width: 300px; margin: auto;";
    document.body.appendChild(receiptEl);
  }

  receiptEl.innerHTML = `
    <div style="text-align:center;">
      <h2>RestoTrack Restobar</h2>
      <p>Official Transaction Receipt</p>
      <hr style="margin:10px 0;">
    </div>
    <p>TRX ID: ${sale.id}</p>
    <p>Kitchen Order: ${sale.kitchenOrderId || 'N/A'}</p>
    <p>Date: ${sale.date}</p>
    <p>Cashier: ${sale.cashierName || sale.cashier}</p>
    <p>Order Type: ${sale.orderType || 'Dine In'}${sale.tableNo ? ` — Table ${sale.tableNo}` : ''}</p>
    <hr style="margin:10px 0;">
    ${sale.items.map(i => `<div style="display:flex; justify-content:space-between;"><span>${i.name} x${i.qty}</span><span>₱${i.price * i.qty}</span></div>`).join('')}
    <hr style="margin:10px 0;">
    <div style="display:flex; justify-content:space-between; font-weight:bold;"><span>Total:</span><span>₱${sale.total}</span></div>
    <div style="display:flex; justify-content:space-between;"><span>Paid (${sale.paymentMethod}):</span><span>₱${sale.tendered}</span></div>
    <div style="display:flex; justify-content:space-between;"><span>Change:</span><span>₱${sale.change}</span></div>
    <div style="text-align:center; margin-top:15px;"><p>Thank you for dining with us!</p></div>
  `;

  openModal("Receipt Preview", receiptEl.innerHTML, `<button class="btn btn-primary" onclick="window.print()">Print Receipt</button>`);
}

// --- VIEW 5: KITCHEN STAFF ORDER DASHBOARD ---
function renderKitchen(c) {
  loadDB();
  const pending = DB.kitchenOrders.filter(o => o.status === "PENDING");
  const preparing = DB.kitchenOrders.filter(o => o.status === "PREPARING");
  const ready = 0; // if ready logic exists, else 0
  const completed = DB.kitchenOrders.filter(o => o.status === "COMPLETED");

  const activeOrders = DB.kitchenOrders.filter(o => o.status === "PENDING" || o.status === "PREPARING");

  c.innerHTML = `
    <div class="kds-header">
      <div>
        <h2 style="font-size:2rem; font-weight:800; color:var(--text-main); letter-spacing:-0.5px;">KITCHEN DISPLAY</h2>
      </div>
      <button class="btn btn-outline" style="border-radius:20px; font-weight:700;" onclick="renderKitchen(document.getElementById('view-container'))">↻ REFRESH</button>
    </div>
    
    <div class="kds-status-bar">
      <div class="kds-stat-card"><div class="kds-stat-label">Pending</div><div class="kds-stat-value" style="color:var(--warning);">${pending.length}</div></div>
      <div class="kds-stat-card"><div class="kds-stat-label">Preparing</div><div class="kds-stat-value" style="color:var(--info);">${preparing.length}</div></div>
      <div class="kds-stat-card"><div class="kds-stat-label">Ready</div><div class="kds-stat-value" style="color:var(--success);">${ready}</div></div>
      <div class="kds-stat-card"><div class="kds-stat-label">Completed</div><div class="kds-stat-value" style="color:var(--accent-main);">${completed.length}</div></div>
    </div>
    
    <div class="kds-board">
      ${activeOrders.map(renderKitchenCard).join('') || `<div style="grid-column:1/-1; text-align:center; padding:5rem; color:var(--text-muted); font-size:1.2rem; font-weight:600; background:rgba(0,0,0,0.02); border-radius:12px; border:1px dashed var(--border-side);">NO ACTIVE ORDERS</div>`}
    </div>
  `;
}

function renderKitchenCard(order) {
  const isPending = order.status === "PENDING";
  
  return `
    <div class="kds-card ${order.status.toLowerCase()}">
      <div class="kds-card-header">
        <div>
          <div class="kds-order-num">ORDER #${order.id}</div>
          <div class="kds-table-num">${order.orderType === 'Dine In' && order.tableNo ? 'TABLE ' + order.tableNo : order.orderType.toUpperCase()}</div>
        </div>
        <div class="kds-time">${order.createdAt.slice(-8)}</div>
      </div>
      <div class="kds-card-body">
        ${order.items.map(item => `
          <div class="kds-item">
            <div class="kds-qty">${item.qty}×</div>
            <div>${item.name}</div>
          </div>
        `).join('')}
        
        ${order.notes ? `<div class="kds-notes">${order.notes}</div>` : ''}
      </div>
      <div class="kds-footer">
        ${isPending 
          ? `<button class="btn btn-warning btn-kds" onclick="acceptKitchenOrder('${order.id}')">[ START PREPARING ]</button>` 
          : `<button class="btn btn-success btn-kds" onclick="completeKitchenOrder('${order.id}')">[ MARK READY ]</button>`
        }
      </div>
    </div>
  `;
}

function acceptKitchenOrder(orderId) {
  loadDB();
  const order = DB.kitchenOrders.find(o => o.id === orderId);
  if (!order || order.status !== "PENDING") return;
  
  const currentUser = window.currentUser || { name: 'Kitchen Staff' };
  order.status = "PREPARING";
  order.acceptedAt = new Date().toLocaleString();
  order.acceptedBy = currentUser.name;
  
  saveDB();
  logActivity("Kitchen Order Accepted", "Kitchen", `Accepted Order #${orderId}`);
  showToast(`Order #${orderId} is now PREPARING`, "success");
  renderKitchen(document.getElementById("view-container"));
}

function completeKitchenOrder(orderId) {
  loadDB();
  const order = DB.kitchenOrders.find(o => o.id === orderId);
  if (!order || order.status !== "PREPARING") return;

  const currentUser = window.currentUser || { name: 'Kitchen Staff' };
  order.status = "COMPLETED";
  order.completedAt = new Date().toLocaleString();
  order.completedBy = currentUser.name;

  // Synchronize the related POS sale with the kitchen completion status.
  if (DB.sales) {
    const sale = DB.sales.find(s => s.kitchenOrderId === orderId);
    if (sale) {
      sale.kitchenStatus = "COMPLETED";
      sale.kitchenCompletedAt = order.completedAt;
      sale.kitchenCompletedBy = order.completedBy;
    }
  }

  addNotification(
    `🍽️ Order #${orderId} is ready for the customer.`,
    "success", "pos", "cashier", orderId
  );

  saveDB();
  logActivity("Kitchen Order Completed", "Kitchen", `Completed Order #${orderId}`);
  showToast(`Order #${orderId} completed and sent to cashier`, "success");
  renderKitchen(document.getElementById("view-container"));
}

// --- VIEW 6: SUPPLIERS ---
function renderSuppliers(c) {
  let html = `
    <div class="flex justify-between items-center" style="margin-bottom:1rem;">
      <h3>Supplier Directory</h3>
      <button class="btn btn-primary" onclick="openAddSupplierModal()">+ Add Supplier</button>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>ID</th><th>Company Name</th><th>Contact Person</th><th>Phone</th><th>Email</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${DB.suppliers.map(s => `
            <tr>
              <td>${s.id}</td>
              <td><strong>${s.name}</strong></td>
              <td>${s.contact}</td>
              <td>${s.phone}</td>
              <td>${s.email}</td>
              <td><span class="badge badge-success">${s.status}</span></td>
              <td>
                <button class="btn btn-danger btn-sm" onclick="deleteSupplier('${s.id}')">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  c.innerHTML = html;
}

function openAddSupplierModal() {
  openModal("Add Supplier", `
    <div class="form-group"><label>Company Name</label><input id="sup-name" class="form-control" required></div>
    <div class="form-group"><label>Contact Person</label><input id="sup-contact" class="form-control"></div>
    <div class="form-group"><label>Phone</label><input id="sup-phone" class="form-control"></div>
    <div class="form-group"><label>Email</label><input id="sup-email" class="form-control"></div>
  `, `<button class="btn btn-primary" onclick="submitAddSupplier()">Save Supplier</button>`);
}

function submitAddSupplier() {
  const name = document.getElementById("sup-name").value.trim();
  if (!name) return showToast("Company Name is required", "danger");

  DB.suppliers.push({
    id: "SUP-" + (DB.suppliers.length + 1).toString().padStart(2, '0'),
    name,
    contact: document.getElementById("sup-contact").value,
    phone: document.getElementById("sup-phone").value,
    email: document.getElementById("sup-email").value,
    status: "Active"
  });

  saveDB();
  logActivity("Add Supplier", "Suppliers", `Added supplier ${name}`);
  showToast("Supplier created", "success");
  closeModal();
  renderSuppliers(document.getElementById("view-container"));
}

function deleteSupplier(id) {
  confirmAction("Delete Supplier", "Remove supplier from directory?", () => {
    DB.suppliers = DB.suppliers.filter(s => s.id !== id);
    saveDB();
    showToast("Supplier removed", "success");
    renderSuppliers(document.getElementById("view-container"));
  });
}

// --- VIEW 7: PURCHASES ---
function renderPurchases(c) {
  let html = `
    <div class="flex justify-between items-center" style="margin-bottom:1rem;">
      <h3>Purchase Orders</h3>
      <button class="btn btn-primary" onclick="openCreatePOModal()">+ Create Purchase Order</button>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>PO Number</th><th>Supplier</th><th>Item</th><th>Qty</th><th>Total Cost</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${DB.purchases.map(p => {
            const sup = DB.suppliers.find(s=>s.id === p.supplierId);
            return `
              <tr>
                <td>${p.id}</td>
                <td>${sup ? sup.name : 'Unknown'}</td>
                <td>${p.itemName}</td>
                <td>${p.qty}</td>
                <td>₱${p.totalCost}</td>
                <td><span class="badge ${p.status === 'Received' ? 'badge-success' : 'badge-warning'}">${p.status}</span></td>
                <td>
                  ${p.status === 'Pending' ? `<button class="btn btn-success btn-sm" onclick="receivePO('${p.id}')">Receive & Stock-In</button>` : 'Complete'}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
  c.innerHTML = html;
}

function openCreatePOModal() {
  const supOpts = DB.suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  const invOpts = DB.inventory.map(i => `<option value="${i.name}">${i.name}</option>`).join('');
  
  openModal("New Purchase Order", `
    <div class="form-group"><label>Supplier</label><select id="po-sup" class="form-control">${supOpts}</select></div>
    <div class="form-group"><label>Item</label><select id="po-item" class="form-control">${invOpts}</select></div>
    <div class="form-group"><label>Quantity</label><input type="number" id="po-qty" class="form-control" value="10"></div>
    <div class="form-group"><label>Unit Cost (₱)</label><input type="number" id="po-cost" class="form-control" value="100"></div>
  `, `<button class="btn btn-primary" onclick="submitCreatePO()">Create PO</button>`);
}

function submitCreatePO() {
  const qty = Number(document.getElementById("po-qty").value);
  const cost = Number(document.getElementById("po-cost").value);

  const newPO = {
    id: "PO-" + Date.now().toString().slice(-4),
    supplierId: document.getElementById("po-sup").value,
    itemName: document.getElementById("po-item").value,
    qty,
    unitCost: cost,
    totalCost: qty * cost,
    status: "Pending",
    date: new Date().toISOString().slice(0, 10)
  };

  DB.purchases.unshift(newPO);
  saveDB();
  logActivity("Create PO", "Purchases", `Created ${newPO.id}`);
  showToast("Purchase order created", "success");
  closeModal();
  renderPurchases(document.getElementById("view-container"));
}

function receivePO(poId) {
  const po = DB.purchases.find(p => p.id === poId);
  if (!po) return;

  po.status = "Received";

  // Automatic Inventory Increase & Expense Recording
  const invItem = DB.inventory.find(i => i.name === po.itemName);
  if (invItem) {
    invItem.quantity += po.qty;
  }

  const currentUser = window.currentUser || { username: 'System' };
  DB.expenses.unshift({
    id: "EXP-" + Date.now().toString().slice(-4),
    date: new Date().toISOString().slice(0, 10),
    category: "Inventory Purchases",
    description: `PO ${po.id} - ${po.itemName}`,
    amount: po.totalCost,
    method: "Invoice",
    recordedBy: currentUser.username
  });

  saveDB();
  logActivity("Receive PO", "Purchases", `Received PO #${poId}, inventory updated.`);
  showToast("PO Received & Inventory Updated", "success");
  renderPurchases(document.getElementById("view-container"));
}

// --- VIEW 8: INCOME & EXPENSES ---
function renderIncome(c) {
  c.innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:1rem;">
      <h3>Income Tracker</h3>
      <button class="btn btn-primary" onclick="openAddIncomeModal()">+ Add Manual Income</button>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>ID</th><th>Date</th><th>Source</th><th>Reference</th><th>Amount</th><th>Recorded By</th></tr></thead>
        <tbody>
          ${DB.income.map(i => `
            <tr><td>${i.id}</td><td>${i.date}</td><td>${i.source}</td><td>${i.ref || 'N/A'}</td><td style="color:var(--success); font-weight:bold;">₱${i.amount.toLocaleString()}</td><td>${i.recordedBy}</td></tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function openAddIncomeModal() {
  openModal("Record Extra Income", `
    <div class="form-group"><label>Source</label><input id="inc-source" class="form-control" placeholder="Catering, Event Space, etc."></div>
    <div class="form-group"><label>Amount (₱)</label><input type="number" id="inc-amt" class="form-control"></div>
  `, `<button class="btn btn-primary" onclick="submitAddIncome()">Save Income</button>`);
}

function submitAddIncome() {
  const amt = Number(document.getElementById("inc-amt").value);
  if (amt <= 0) return;

  const currentUser = window.currentUser || { username: 'System' };
  DB.income.unshift({
    id: "INC-" + Date.now().toString().slice(-4),
    date: new Date().toISOString().slice(0, 10),
    source: document.getElementById("inc-source").value || "General Income",
    ref: "Manual",
    amount: amt,
    recordedBy: currentUser.username
  });

  saveDB();
  showToast("Income recorded", "success");
  closeModal();
  renderIncome(document.getElementById("view-container"));
}

function renderExpenses(c) {
  c.innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:1rem;">
      <h3>Expense Tracker</h3>
      <button class="btn btn-primary" onclick="openAddExpenseModal()">+ Add Expense</button>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>ID</th><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Method</th></tr></thead>
        <tbody>
          ${DB.expenses.map(e => `
            <tr><td>${e.id}</td><td>${e.date}</td><td>${e.category}</td><td>${e.description}</td><td style="color:var(--danger); font-weight:bold;">₱${e.amount.toLocaleString()}</td><td>${e.method}</td></tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function openAddExpenseModal() {
  openModal("Record Operating Expense", `
    <div class="form-group"><label>Category</label>
      <select id="exp-cat" class="form-control">
        <option>Salaries</option><option>Rent</option><option>Electricity</option><option>Water</option><option>Supplies</option><option>Maintenance</option>
      </select>
    </div>
    <div class="form-group"><label>Description</label><input id="exp-desc" class="form-control"></div>
    <div class="form-group"><label>Amount (₱)</label><input type="number" id="exp-amt" class="form-control"></div>
  `, `<button class="btn btn-primary" onclick="submitAddExpense()">Save Expense</button>`);
}

function submitAddExpense() {
  const amt = Number(document.getElementById("exp-amt").value);
  if (amt <= 0) return;

  const currentUser = window.currentUser || { username: 'System' };
  DB.expenses.unshift({
    id: "EXP-" + Date.now().toString().slice(-4),
    date: new Date().toISOString().slice(0, 10),
    category: document.getElementById("exp-cat").value,
    description: document.getElementById("exp-desc").value,
    amount: amt,
    method: "Cash",
    recordedBy: currentUser.username
  });

  saveDB();
  showToast("Expense recorded", "success");
  closeModal();
  renderExpenses(document.getElementById("view-container"));
}

// --- VIEW 9: PROFIT & LOSS ---
function renderProfitLoss(c) {
  const incTotal = DB.income.reduce((a, b) => a + Number(b.amount), 0);
  const expTotal = DB.expenses.reduce((a, b) => a + Number(b.amount), 0);
  const wstTotal = DB.wastage.reduce((a, b) => a + Number(b.totalCost), 0);
  const net = incTotal - expTotal - wstTotal;

  c.innerHTML = `
    <div class="card" style="max-width:600px; margin:auto;">
      <h2>Financial Statement</h2>
      <hr style="margin:1rem 0;">
      <div class="flex justify-between" style="font-size:1.2rem; margin-bottom:0.5rem;"><span>Gross Income:</span><span style="color:var(--success);">₱${incTotal.toLocaleString()}</span></div>
      <div class="flex justify-between" style="font-size:1.2rem; margin-bottom:0.5rem;"><span>Operating Expenses:</span><span style="color:var(--danger);">₱${expTotal.toLocaleString()}</span></div>
      <div class="flex justify-between" style="font-size:1.2rem; margin-bottom:0.5rem;"><span>Wastage Losses:</span><span style="color:var(--danger);">₱${wstTotal.toLocaleString()}</span></div>
      <hr style="margin:1rem 0;">
      <div class="flex justify-between" style="font-size:1.5rem; font-weight:bold;">
        <span>Net ${net >= 0 ? 'Profit' : 'Loss'}:</span>
        <span style="color:${net >= 0 ? 'var(--success)' : 'var(--danger)'}">₱${net.toLocaleString()}</span>
      </div>
    </div>
  `;
}

// --- VIEW 10: WASTAGE MANAGEMENT ---
function renderWastage(c) {
  c.innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:1rem;">
      <h3>Wastage & Loss Tracking</h3>
      <button class="btn btn-danger" onclick="openRecordWastageModal()">+ Record Wastage</button>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>ID</th><th>Date</th><th>Item</th><th>Qty</th><th>Loss Cost</th><th>Reason</th><th>Recorded By</th></tr></thead>
        <tbody>
          ${DB.wastage.map(w => `
            <tr><td>${w.id}</td><td>${w.date}</td><td>${w.itemName}</td><td>${w.qty}</td><td style="color:var(--danger); font-weight:bold;">₱${w.totalCost}</td><td>${w.reason}</td><td>${w.recordedBy}</td></tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function openRecordWastageModal() {
  const opts = DB.inventory.map(i => `<option value="${i.id}">${i.name} (${i.quantity} ${i.unit} available)</option>`).join('');
  openModal("Record Wastage", `
    <div class="form-group"><label>Select Item</label><select id="wst-id" class="form-control">${opts}</select></div>
    <div class="form-group"><label>Quantity Lost</label><input type="number" id="wst-qty" class="form-control" value="1"></div>
    <div class="form-group"><label>Reason</label>
      <select id="wst-reason" class="form-control">
        <option>Spoiled</option><option>Expired</option><option>Damaged</option><option>Spillage</option>
      </select>
    </div>
  `, `<button class="btn btn-danger" onclick="submitRecordWastage()">Record Loss</button>`);
}

function submitRecordWastage() {
  const invId = document.getElementById("wst-id").value;
  const qty = Number(document.getElementById("wst-qty").value);
  const invItem = DB.inventory.find(i => i.id === invId);

  if (!invItem || qty > invItem.quantity) return showToast("Invalid wastage quantity", "danger");

  invItem.quantity -= qty;
  const lossCost = qty * invItem.unitCost;

  const currentUser = window.currentUser || { username: 'System' };
  DB.wastage.unshift({
    id: "WST-" + Date.now().toString().slice(-4),
    date: new Date().toISOString().slice(0, 10),
    itemId: invItem.id,
    itemName: invItem.name,
    qty,
    unitCost: invItem.unitCost,
    totalCost: lossCost,
    reason: document.getElementById("wst-reason").value,
    recordedBy: currentUser.username
  });

  saveDB();
  logActivity("Record Wastage", "Wastage", `Wastage loss recorded for ${invItem.name} (-₱${lossCost})`);
  showToast("Wastage recorded & deducted from stock", "success");
  closeModal();
  renderWastage(document.getElementById("view-container"));
}

// --- VIEW 11: USER MANAGEMENT (ADMIN ONLY) ---
function renderUsers(c) {
  c.innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:1rem;">
      <h3>User Management</h3>
      <button class="btn btn-primary" onclick="openAddUserModal()">+ Add User</button>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>ID</th><th>Full Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last Login</th><th>Actions</th></tr></thead>
        <tbody>
          ${DB.users.map(u => `
            <tr>
              <td>${u.id}</td>
              <td><strong>${u.name}</strong></td>
              <td>${u.username}</td>
              <td><span class="badge badge-warning">${u.role}</span></td>
              <td><span class="badge ${u.status === 'Active' ? 'badge-success' : 'badge-danger'}">${u.status}</span></td>
              <td>${u.lastLogin || 'Never'}</td>
              <td>
                <button class="btn btn-outline btn-sm" onclick="toggleUserStatus('${u.id}')">${u.status === 'Active' ? 'Deactivate' : 'Activate'}</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function openAddUserModal() {
  openModal("Add System User", `
    <div class="form-group"><label>Full Name</label><input id="u-name" class="form-control" required></div>
    <div class="form-group"><label>Username</label><input id="u-user" class="form-control" required></div>
    <div class="form-group"><label>Password</label><input type="password" id="u-pass" class="form-control" required></div>
    <div class="form-group"><label>Role</label>
      <select id="u-role" class="form-control">
        <option value="admin">👑 Admin</option>
        <option value="manager">👔 Manager</option>
        <option value="inventory">📦 Inventory Staff</option>
        <option value="cashier">💵 Cashier</option>
        <option value="kitchen">🍳 Kitchen Staff</option>
      </select>
    </div>
  `, `<button class="btn btn-primary" onclick="submitAddUser()">Save User</button>`);
}

function submitAddUser() {
  const u = document.getElementById("u-user").value.trim();
  if (!u) return showToast("Username is required", "danger");

  DB.users.push({
    id: "U" + (DB.users.length + 101),
    name: document.getElementById("u-name").value,
    username: u,
    password: document.getElementById("u-pass").value,
    role: document.getElementById("u-role").value,
    status: "Active",
    lastLogin: ""
  });

  saveDB();
  logActivity("Add User", "Users", `Created user ${u}`);
  showToast("User account created", "success");
  closeModal();
  renderUsers(document.getElementById("view-container"));
}

function toggleUserStatus(id) {
  const u = DB.users.find(x => x.id === id);
  if (u) {
    u.status = u.status === 'Active' ? 'Inactive' : 'Active';
    saveDB();
    renderUsers(document.getElementById("view-container"));
  }
}

// --- VIEW 12: REPORTS & EXPORTS ---
function renderReports(c) {
  c.innerHTML = `
    <div class="card" style="margin-bottom:1rem;">
      <h3>Export System Reports</h3>
      <p style="color:var(--muted); margin-bottom:1rem;">Generate dynamic CSV downloads for offline auditing.</p>
      <div class="flex gap-2">
        <button class="btn btn-primary" onclick="exportCSV('inventory')">Export Inventory CSV</button>
        <button class="btn btn-success" onclick="exportCSV('sales')">Export Sales History CSV</button>
        <button class="btn btn-secondary" onclick="exportCSV('expenses')">Export Expenses CSV</button>
      </div>
    </div>
  `;
}

function exportCSV(type) {
  let csvContent = "data:text/csv;charset=utf-8,";
  let data = [];

  if (type === 'inventory') {
    data = DB.inventory.map(i => ({ ID: i.id, Name: i.name, Category: i.category, Quantity: i.quantity, UnitCost: i.unitCost }));
  } else if (type === 'sales') {
    data = DB.sales.map(s => ({ ID: s.id, Date: s.date, Total: s.total, PaymentMethod: s.paymentMethod, Cashier: s.cashier }));
  } else {
    data = DB.expenses.map(e => ({ ID: e.id, Date: e.date, Category: e.category, Amount: e.amount }));
  }

  if (data.length === 0) return showToast("No data to export", "danger");

  const headers = Object.keys(data[0]).join(",");
  csvContent += headers + "\r\n";

  data.forEach(row => {
    csvContent += Object.values(row).join(",") + "\r\n";
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `RestoTrack_${type}_Report.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast("CSV Downloaded successfully", "success");
}

// --- VIEW 13: ACTIVITY LOGS ---
function renderLogs(c) {
  c.innerHTML = `
    <h3>System Audit Activity Logs</h3>
    <div class="table-container">
      <table>
        <thead><tr><th>Timestamp</th><th>User</th><th>Role</th><th>Action</th><th>Module</th><th>Details</th></tr></thead>
        <tbody>
          ${DB.activityLogs.map(l => `
            <tr><td>${l.timestamp}</td><td>${l.user}</td><td>${l.role}</td><td><strong>${l.action}</strong></td><td>${l.module}</td><td>${l.details}</td></tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// --- VIEW 14: SETTINGS ---
function renderSettings(c) {
  c.innerHTML = `
    <div class="card" style="max-width:500px;">
      <h3>System Administrative Settings</h3>
      <p style="color:var(--muted); margin: 0.5rem 0 1.5rem 0;">Reset all prototype data back to original seed data.</p>
      <button class="btn btn-danger" onclick="resetData()">Reset Demo Data</button>
    </div>
  `;
}

// --- VIEW 15: EMPLOYEES ---
function renderEmployees(c) {
  loadDB();
  const emps = DB.employees || [];
  c.innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:1rem;">
      <h3>Employee Management</h3>
      <button class="btn btn-primary">+ Add Employee</button>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Role</th><th>Department</th><th>Status</th><th>Hire Date</th><th>Actions</th></tr></thead>
        <tbody>
          ${emps.map(e => `
            <tr>
              <td>${e.id}</td>
              <td><strong>${e.name}</strong></td>
              <td>${e.role}</td>
              <td>${e.department}</td>
              <td><span class="badge ${e.status === 'Active' ? 'badge-success' : 'badge-danger'}">${e.status}</span></td>
              <td>${e.hireDate}</td>
              <td><button class="btn btn-outline btn-sm">Edit</button></td>
            </tr>
          `).join('') || `<tr><td colspan="7" style="text-align:center;">No employees found</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

// --- VIEW 16: ATTENDANCE ---
function renderAttendance(c) {
  loadDB();
  const att = DB.attendance || [];
  c.innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:1rem;">
      <h3>Attendance Tracking</h3>
      <button class="btn btn-primary">Mark Attendance</button>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>Date</th><th>Employee ID</th><th>Employee Name</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
        <tbody>
          ${att.map(a => `
            <tr>
              <td>${a.date}</td>
              <td>${a.empId}</td>
              <td><strong>${a.empName}</strong></td>
              <td>${a.timeIn || '--'}</td>
              <td>${a.timeOut || '--'}</td>
              <td><span class="badge ${a.status === 'Present' ? 'badge-success' : (a.status === 'Late' ? 'badge-warning' : 'badge-danger')}">${a.status}</span></td>
            </tr>
          `).join('') || `<tr><td colspan="6" style="text-align:center;">No attendance records</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

// --- VIEW 17: PAYROLL ---
function renderPayroll(c) {
  loadDB();
  const pay = DB.payroll || [];
  c.innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:1rem;">
      <h3>Payroll Processing</h3>
      <button class="btn btn-primary">Generate Payroll</button>
    </div>
    <div class="table-container">
      <table>
        <thead><tr><th>Period</th><th>Employee</th><th>Base Pay</th><th>Deductions</th><th>Net Pay</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${pay.map(p => `
            <tr>
              <td>${p.period}</td>
              <td><strong>${p.empName}</strong></td>
              <td>₱${p.basePay.toLocaleString()}</td>
              <td>₱${p.deductions.toLocaleString()}</td>
              <td style="font-weight:700;">₱${p.netPay.toLocaleString()}</td>
              <td><span class="badge ${p.status === 'Paid' ? 'badge-success' : 'badge-warning'}">${p.status}</span></td>
              <td><button class="btn btn-outline btn-sm">Payslip</button></td>
            </tr>
          `).join('') || `<tr><td colspan="7" style="text-align:center;">No payroll records</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

// --- VIEW 18: PROFILE ---
function renderProfile(c) {
  const user = window.currentUser || { name: 'Admin User', role: 'admin', username: 'admin' };
  c.innerHTML = `
    <div class="card" style="max-width:600px; margin:0 auto;">
      <div style="display:flex; flex-direction:column; align-items:center; margin-bottom:2rem;">
        <div style="width:100px; height:100px; border-radius:50%; background:var(--accent-main); color:white; display:flex; align-items:center; justify-content:center; font-size:2.5rem; font-weight:bold; margin-bottom:1rem;">
          ${user.name.charAt(0).toUpperCase()}
        </div>
        <h2 style="margin-bottom:0.25rem;">${user.name}</h2>
        <span class="badge badge-warning" style="text-transform:uppercase;">${user.role}</span>
      </div>
      <div class="form-group">
        <label>Username</label>
        <input type="text" class="form-control" value="${user.username}" readonly>
      </div>
      <div class="form-group">
        <label>New Password</label>
        <input type="password" class="form-control" placeholder="Enter new password to change">
      </div>
      <button class="btn btn-primary w-full" style="margin-top:1rem;" onclick="showToast('Profile updated!', 'success')">Save Changes</button>
    </div>
  `;
}


function renderView(viewId, container) {
  if (!container) return;
  container.innerHTML = "";
  
  switch (viewId) {
    case "dashboard": renderDashboard(container); break;
    case "inventory": renderInventory(container); break;
    case "products": renderProducts(container); break;
    case "suppliers": renderSuppliers(container); break;
    case "purchases": renderPurchases(container); break;
    case "pos": renderPOS(container); break;
    case "kitchen": renderKitchen(container); break;
    case "income": renderIncome(container); break;
    case "expenses": renderExpenses(container); break;
    case "profitloss": renderProfitLoss(container); break;
    case "wastage": renderWastage(container); break;
    case "users": renderUsers(container); break;
    case "reports": renderReports(container); break;
    case "logs": renderLogs(container); break;
    case "settings": renderSettings(container); break;
    case "employees": renderEmployees(container); break;
    case "attendance": renderAttendance(container); break;
    case "payroll": renderPayroll(container); break;
    case "profile": renderProfile(container); break;
    default: container.innerHTML = "<h2>View Not Found</h2>";
  }
}

