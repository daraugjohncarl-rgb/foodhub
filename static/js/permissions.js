/**
 * Role-Based Access Control (RBAC) & Navigation Config
 * Matches Super Admin layout styling with Font Awesome icons.
 */

const ROLE_NAV_CONFIG = {
  admin: [
    { id: "dashboard", label: "Dashboard", icon: "fas fa-chart-line" },
    { id: "cash_drawer", label: "Cash Drawer", icon: "fas fa-vault" },
    { id: "users", label: "User Management", icon: "fas fa-users-cog" },
    { id: "inventory", label: "Inventory", icon: "fas fa-boxes" },
    { id: "products", label: "Products & Menu", icon: "fas fa-utensils" },
    { id: "tables", label: "Table QRs", icon: "fas fa-qrcode" },
    { id: "suppliers", label: "Suppliers", icon: "fas fa-truck" },
    { id: "profit_loss", label: "Profit Loss and Income", icon: "fas fa-scale-balanced" },
    { id: "reports", label: "Reports & Analytics", icon: "fas fa-chart-bar" },
    { id: "logs", label: "Audit Logs", icon: "fas fa-history" },
    { id: "settings", label: "Settings", icon: "fas fa-cog" }
  ],
  manager: [
    { id: "dashboard", label: "Dashboard", icon: "fas fa-chart-line" },
    { id: "cash_drawer", label: "Cash Drawer", icon: "fas fa-vault" },
    { id: "users", label: "User Management", icon: "fas fa-users-cog" },
    { id: "inventory", label: "Inventory", icon: "fas fa-boxes" },
    { id: "products", label: "Products & Menu", icon: "fas fa-utensils" },
    { id: "tables", label: "Table QRs", icon: "fas fa-qrcode" },
    { id: "suppliers", label: "Suppliers", icon: "fas fa-truck" },
    { id: "profit_loss", label: "Profit Loss and Income", icon: "fas fa-scale-balanced" },
    { id: "reports", label: "Reports & Analytics", icon: "fas fa-chart-bar" },
    { id: "logs", label: "Audit Logs", icon: "fas fa-history" }
  ],
  inventory: [
    { id: "inventory", label: "Stock Overview", icon: "fas fa-boxes" },
    { id: "suppliers", label: "Suppliers", icon: "fas fa-truck" },
    { id: "profit_loss", label: "Profit Loss and Income", icon: "fas fa-scale-balanced" },
    { id: "wastage", label: "Wastage Track", icon: "fas fa-trash-alt" }
  ],
  cashier: [
    { id: "pos", label: "Point of Sale (POS)", icon: "fas fa-cash-register" },
    { id: "drinks", label: "Drinks Orders", icon: "fas fa-glass-water", badgeId: "cashier-drinks-badge" },
    { id: "customer_orders", label: "Customer Orders", icon: "fas fa-mobile-alt", badgeId: "cashier-orders-badge" },
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

  const currentSaved = (window.location.hash ? window.location.hash.replace("#", "") : "") || sessionStorage.getItem("active_feature") || "";
  const hasSavedItem = items.some(it => it.id === currentSaved);

  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "nav-item";
    li.id = `nav-item-${item.id}`;

    const a = document.createElement("a");
    a.href = `#${item.id}`;
    const isActive = hasSavedItem ? (item.id === currentSaved) : (index === 0);
    a.className = "nav-link" + (isActive ? " active" : "");
    a.setAttribute("data-title", item.label);
    a.innerHTML = `<i class="${item.icon}"></i><span>${item.label}</span>${item.badgeId ? `<span id="${item.badgeId}" style="margin-left:auto; background:#ef4444; color:#fff; font-size:10px; font-weight:700; padding:2px 7px; border-radius:10px; display:none;">0</span>` : ''}`;

    if (isActive) {
      const pageTitle = document.getElementById("current-page-title");
      if (pageTitle) pageTitle.innerText = item.label;
    }
    
    a.onclick = (e) => {
      e.preventDefault();
      document.querySelectorAll("aside.sidebar .nav-link").forEach(el => el.classList.remove("active"));
      a.classList.add("active");
      
      const pageTitle = document.getElementById("current-page-title");
      if (pageTitle) pageTitle.innerText = item.label;

      if (window.innerWidth <= 768) {
        document.getElementById("sidebar")?.classList.remove("open");
        document.getElementById("sidebarOverlay")?.classList.remove("open");
      }

      if (window.innerWidth <= 1024 && typeof window.toggleMobileSidebar === "function") {
        window.toggleMobileSidebar(false);
      }

      if (typeof onNavigate === "function") {
        onNavigate(item.id, item.label);
      }
    };

    li.appendChild(a);
    if (menuEl) menuEl.appendChild(li);
  });

  buildMobileBottomNav(role, onNavigate);
}

window.ROLE_NAV_CONFIG = ROLE_NAV_CONFIG;

function buildMobileBottomNav(role, onNavigate) {
  let nav = document.getElementById("mobileBottomNav");
  if (!nav) {
    nav = document.createElement("nav");
    nav.id = "mobileBottomNav";
    nav.className = "mobile-bottom-nav";
    document.body.appendChild(nav);
  }

  const r = (role || "").toLowerCase();
  const normalizedRole = r === "super_admin" ? "admin" : r;
  const items = ROLE_NAV_CONFIG[normalizedRole] || ROLE_NAV_CONFIG.admin;
  const primaryItems = items.slice(0, 4);

  const currentSaved = (window.location.hash ? window.location.hash.replace("#", "") : "") || sessionStorage.getItem("active_feature") || "";
  const activeId = items.some(it => it.id === currentSaved) ? currentSaved : (items[0] ? items[0].id : "");

  let html = "";
  primaryItems.forEach(item => {
    const isActive = item.id === activeId;
    const shortLabel = item.label.split(" ")[0].substring(0, 9);
    html += `
      <a href="#${item.id}" class="mobile-bottom-nav-item ${isActive ? 'active' : ''}" data-nav-id="${item.id}" data-title="${item.label}">
        <i class="${item.icon}"></i>
        <span>${shortLabel}</span>
      </a>
    `;
  });

  html += `
    <button type="button" class="mobile-bottom-nav-item" id="mobileNavMoreBtn" title="Open Full Menu">
      <i class="fas fa-bars"></i>
      <span>Menu</span>
    </button>
  `;

  nav.innerHTML = html;

  nav.querySelectorAll(".mobile-bottom-nav-item[data-nav-id]").forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const targetId = btn.getAttribute("data-nav-id");
      const targetTitle = btn.getAttribute("data-title") || targetId;

      nav.querySelectorAll(".mobile-bottom-nav-item").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      document.querySelectorAll("aside.sidebar .nav-link").forEach(el => {
        const h = (el.getAttribute("href") || "").replace("#", "");
        el.classList.toggle("active", h === targetId);
      });

      const pageTitle = document.getElementById("current-page-title");
      if (pageTitle) pageTitle.innerText = targetTitle;

      if (typeof window.toggleMobileSidebar === "function") {
        window.toggleMobileSidebar(false);
      }

      if (typeof onNavigate === "function") {
        onNavigate(targetId, targetTitle);
      }
    };
  });

  const moreBtn = document.getElementById("mobileNavMoreBtn");
  if (moreBtn) {
    moreBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof window.toggleMobileSidebar === "function") {
        window.toggleMobileSidebar();
      } else {
        const sidebar = document.getElementById("sidebar");
        const overlay = document.getElementById("sidebarOverlay");
        if (sidebar) {
          sidebar.classList.toggle("open");
          if (overlay) overlay.classList.toggle("open", sidebar.classList.contains("open"));
        }
      }
    };
  }

  if (typeof window.bindMobileNavTriggers === "function") {
    window.bindMobileNavTriggers();
  }
}

window.buildSidebarMenu = buildSidebarMenu;
window.buildMobileBottomNav = buildMobileBottomNav;
