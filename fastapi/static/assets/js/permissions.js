/**
 * Role-Based Access Control (RBAC) & Navigation Config
 * Matches Super Admin layout styling with Font Awesome icons.
 */

const ROLE_NAV_CONFIG = {
  admin: [
    { id: "dashboard", label: "Dashboard", icon: "fas fa-chart-line" },
    { id: "users", label: "User Management", icon: "fas fa-users-cog" },
    { id: "inventory", label: "Inventory", icon: "fas fa-boxes" },
    { id: "products", label: "Products & Menu", icon: "fas fa-utensils" },
    { id: "tables", label: "Table QRs", icon: "fas fa-qrcode" },
    { id: "suppliers", label: "Suppliers", icon: "fas fa-truck" },
    { id: "purchases", label: "Purchases", icon: "fas fa-shopping-cart" },
    { id: "reports", label: "Reports & Analytics", icon: "fas fa-chart-bar" },
    { id: "logs", label: "Audit Logs", icon: "fas fa-history" },
    { id: "settings", label: "Settings", icon: "fas fa-cog" }
  ],
  manager: [
    { id: "dashboard", label: "Dashboard", icon: "fas fa-chart-line" },
    { id: "users", label: "User Management", icon: "fas fa-users-cog" },
    { id: "inventory", label: "Inventory", icon: "fas fa-boxes" },
    { id: "products", label: "Products & Menu", icon: "fas fa-utensils" },
    { id: "tables", label: "Table QRs", icon: "fas fa-qrcode" },
    { id: "suppliers", label: "Suppliers", icon: "fas fa-truck" },
    { id: "purchases", label: "Purchases", icon: "fas fa-shopping-cart" },
    { id: "reports", label: "Reports & Analytics", icon: "fas fa-chart-bar" },
    { id: "logs", label: "Audit Logs", icon: "fas fa-history" }
  ],
  inventory: [
    { id: "inventory", label: "Stock Overview", icon: "fas fa-boxes" },
    { id: "suppliers", label: "Suppliers", icon: "fas fa-truck" },
    { id: "purchases", label: "Purchase Orders", icon: "fas fa-shopping-cart" },
    { id: "wastage", label: "Wastage Track", icon: "fas fa-trash-alt" }
  ],
  cashier: [
    { id: "pos", label: "Point of Sale (POS)", icon: "fas fa-cash-register" },
    { id: "transactions", label: "Today's Orders", icon: "fas fa-receipt" }
  ],
  kitchen: [
    { id: "kitchen", label: "Live KDS Orders", icon: "fas fa-fire-burner" }
  ]
};

function buildSidebarMenu(role, onNavigate) {
  let navEl = document.getElementById("sidebar-nav") || document.querySelector("aside.sidebar nav");
  let menuEl = document.getElementById("sidebar-menu");

  if (!navEl && !menuEl) return;

  const r = (role || "").toLowerCase();
  const normalizedRole = r === "super_admin" ? "admin" : r;
  const items = ROLE_NAV_CONFIG[normalizedRole] || ROLE_NAV_CONFIG.admin;

  if (navEl) {
    navEl.innerHTML = `
      <div class="nav-section-title">${normalizedRole === 'cashier' ? 'POS Counter' : 'Operations Menu'}</div>
      <ul class="nav-menu" id="sidebar-menu"></ul>
    `;
    menuEl = document.getElementById("sidebar-menu");
  } else if (menuEl) {
    menuEl.innerHTML = "";
  }

  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "nav-item";
    li.id = `nav-item-${item.id}`;

    const a = document.createElement("a");
    a.href = `#${item.id}`;
    a.className = "nav-link" + (index === 0 ? " active" : "");
    a.setAttribute("data-title", item.label);
    a.innerHTML = `<i class="${item.icon}"></i><span>${item.label}</span>`;
    
    a.onclick = (e) => {
      e.preventDefault();
      document.querySelectorAll("aside.sidebar .nav-link").forEach(el => el.classList.remove("active"));
      a.classList.add("active");
      
      const pageTitle = document.getElementById("current-page-title");
      if (pageTitle) pageTitle.innerText = item.label;

      if (typeof onNavigate === "function") {
        onNavigate(item.id, item.label);
      }
    };

    li.appendChild(a);
    if (menuEl) menuEl.appendChild(li);
  });
}

window.ROLE_NAV_CONFIG = ROLE_NAV_CONFIG;
window.buildSidebarMenu = buildSidebarMenu;
