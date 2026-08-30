// --- ROLE-BASED ACCESS CONTROL ---
const ROLE_MENUS = {
  admin: [
    { section: "MAIN MENU" },
    { id: "dashboard", label: "Dashboard", icon: "⌂" },
    { id: "pos", label: "POS", icon: "▣" },
    { id: "kitchen", label: "Orders", icon: "▤" },
    { id: "inventory", label: "Inventory", icon: "▦" },
    { id: "employees", label: "Employees", icon: "♟" },
    { id: "reports", label: "Reports", icon: "▥" },
    { section: "MANAGEMENT" },
    { id: "attendance", label: "Attendance", icon: "◉" },
    { id: "payroll", label: "Payroll", icon: "₱" },
    { id: "users", label: "User Lists", icon: "♙" },
    { id: "logs", label: "Activity Logs", icon: "◷" },
    { section: "ACCOUNT" },
    { id: "profile", label: "Profile", icon: "◎" },
    { id: "settings", label: "Settings", icon: "⚙" }
  ],
  manager: [
    { section: "MAIN MENU" },
    { id: "dashboard", label: "Dashboard", icon: "⌂" },
    { id: "pos", label: "POS", icon: "▣" },
    { id: "kitchen", label: "Orders", icon: "▤" },
    { id: "inventory", label: "Inventory", icon: "▦" },
    { id: "employees", label: "Employees", icon: "♟" },
    { id: "reports", label: "Reports", icon: "▥" },
    { section: "MANAGEMENT" },
    { id: "attendance", label: "Attendance", icon: "◉" },
    { section: "ACCOUNT" },
    { id: "profile", label: "Profile", icon: "◎" },
    { id: "settings", label: "Settings", icon: "⚙" }
  ],
  inventory: [
    { section: "MAIN MENU" },
    { id: "dashboard", label: "Dashboard", icon: "⌂" },
    { id: "inventory", label: "Inventory", icon: "▦" },
    { section: "ACCOUNT" },
    { id: "profile", label: "Profile", icon: "◎" }
  ],
  cashier: [
    { section: "MAIN MENU" },
    { id: "dashboard", label: "Dashboard", icon: "⌂" },
    { id: "pos", label: "POS", icon: "▣" },
    { section: "ACCOUNT" },
    { id: "profile", label: "Profile", icon: "◎" }
  ],
  kitchen: [
    { section: "MAIN MENU" },
    { id: "dashboard", label: "Dashboard", icon: "⌂" },
    { id: "kitchen", label: "Orders", icon: "▤" },
    { section: "ACCOUNT" },
    { id: "profile", label: "Profile", icon: "◎" }
  ]
};

function getRoleMenu(role) {
  return ROLE_MENUS[role] || [];
}

function buildSidebarMenu(role, onNavigate) {
  const menuEl = document.getElementById("sidebar-menu");
  if (!menuEl) return;
  menuEl.innerHTML = "";
  
  const allowedItems = getRoleMenu(role);
  allowedItems.forEach(item => {
    if (item.section) {
      const div = document.createElement("div");
      div.className = "nav-section-title";
      div.innerText = item.section;
      menuEl.appendChild(div);
      return;
    }

    const li = document.createElement("li");
    li.className = "nav-item";
    li.id = `nav-item-${item.id}`;
    li.innerHTML = `<a href="#" class="nav-link" data-view="${item.id}" data-title="${item.label}"><i>${item.icon}</i> <span>${item.label}</span></a>`;
    
    li.querySelector('a').addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof onNavigate === 'function') {
        onNavigate(item.id, item.label);
      }
    });
    
    menuEl.appendChild(li);
  });
}
