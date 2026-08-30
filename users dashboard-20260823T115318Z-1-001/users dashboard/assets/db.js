// --- INITIAL SEED DATA ---
const SEED_DATA = {
  users: [
    { id: "U101", name: "System Admin", username: "admin", password: "admin123", role: "admin", status: "Active", lastLogin: "2026-08-23 08:00" },
    { id: "U102", name: "Juan Dela Cruz", username: "manager", password: "manager123", role: "manager", status: "Active", lastLogin: "2026-08-23 08:30" },
    { id: "U103", name: "Inventory Staff", username: "inventory", password: "inv123", role: "inventory", status: "Active", lastLogin: "2026-08-23 07:45" },
    { id: "U104", name: "Cashier One", username: "cashier", password: "cash123", role: "cashier", status: "Active", lastLogin: "2026-08-23 09:00" },
    { id: "U105", name: "Head Chef", username: "kitchen", password: "kit123", role: "kitchen", status: "Active", lastLogin: "2026-08-23 08:15" }
  ],
  employees: [
    { id: "EMP-001", name: "Juan Dela Cruz", position: "Manager", department: "Management", dailyRate: 1500, status: "Active", attendance: "Present" },
    { id: "EMP-002", name: "Cashier One", position: "Senior Cashier", department: "FOH", dailyRate: 800, status: "Active", attendance: "Present" },
    { id: "EMP-003", name: "Head Chef", position: "Head Chef", department: "Kitchen", dailyRate: 1200, status: "Active", attendance: "Present" },
    { id: "EMP-004", name: "Reynan", position: "Line Cook", department: "Kitchen", dailyRate: 650, status: "Active", attendance: "Late" },
    { id: "EMP-005", name: "Isabel", position: "Server", department: "FOH", dailyRate: 600, status: "Active", attendance: "Absent" }
  ],
  attendance: [
    { date: "2026-08-23", employeeId: "EMP-001", name: "Juan Dela Cruz", timeIn: "08:00 AM", timeOut: "—", hours: 0, ot: 0, status: "Present" },
    { date: "2026-08-23", employeeId: "EMP-002", name: "Cashier One", timeIn: "08:02 AM", timeOut: "—", hours: 0, ot: 0, status: "Present" },
    { date: "2026-08-23", employeeId: "EMP-004", name: "Reynan", timeIn: "08:25 AM", timeOut: "—", hours: 0, ot: 0, status: "Late" },
    { date: "2026-08-23", employeeId: "EMP-005", name: "Isabel", timeIn: "—", timeOut: "—", hours: 0, ot: 0, status: "Absent" }
  ],
  payroll: [
    { period: "August 1-15, 2026", employeeId: "EMP-001", name: "Juan Dela Cruz", dailyRate: 1500, daysWorked: 13, absences: 0, otHours: 5, grossPay: 20437.50, deductions: 500, netPay: 19937.50, status: "Paid" },
    { period: "August 1-15, 2026", employeeId: "EMP-002", name: "Cashier One", dailyRate: 800, daysWorked: 13, absences: 0, otHours: 10, grossPay: 11400.00, deductions: 250, netPay: 11150.00, status: "Paid" }
  ],
  inventory: [
    { id: "INV-01", name: "Chicken Breast", category: "Meat", quantity: 26, unit: "kg", minStock: 10, maxStock: 50, unitCost: 180, expDate: "2026-08-25" },
    { id: "INV-02", name: "Beef Patty", category: "Meat", quantity: 18, unit: "kg", minStock: 5, maxStock: 40, unitCost: 250, expDate: "2026-08-20" },
    { id: "INV-03", name: "Pork Ribs", category: "Meat", quantity: 20, unit: "kg", minStock: 8, maxStock: 30, unitCost: 220, expDate: "2026-08-22" },
    { id: "INV-04", name: "Burger Buns", category: "Bakery", quantity: 80, unit: "pcs", minStock: 30, maxStock: 150, unitCost: 10, expDate: "2026-08-18" },
    { id: "INV-05", name: "Cheese Slices", category: "Dairy", quantity: 12, unit: "packs", minStock: 5, maxStock: 30, unitCost: 120, expDate: "2026-09-01" },
    { id: "INV-06", name: "Lettuce", category: "Produce", quantity: 4, unit: "kg", minStock: 5, maxStock: 20, unitCost: 70, expDate: "2026-08-17" },
    { id: "INV-07", name: "Tomato", category: "Produce", quantity: 10, unit: "kg", minStock: 3, maxStock: 15, unitCost: 60, expDate: "2026-08-19" },
    { id: "INV-08", name: "Beer Bottles", category: "Beverage", quantity: 85, unit: "bottles", minStock: 20, maxStock: 200, unitCost: 50, expDate: "2027-01-01" },
    { id: "INV-09", name: "Rum 750ml", category: "Liquor", quantity: 12, unit: "bottles", minStock: 3, maxStock: 20, unitCost: 350, expDate: "2028-01-01" },
    { id: "INV-10", name: "Whiskey 750ml", category: "Liquor", quantity: 2, unit: "bottles", minStock: 3, maxStock: 15, unitCost: 650, expDate: "2028-01-01" }
  ],
  products: [
    { id: "PRD-01", name: "Chicken Burger", category: "Food", price: 180, cost: 65, recipe: [{ invId: "INV-01", qty: 0.15 }, { invId: "INV-04", qty: 1 }, { invId: "INV-05", qty: 0.1 }] },
    { id: "PRD-02", name: "Beef Burger", category: "Food", price: 220, cost: 85, recipe: [{ invId: "INV-02", qty: 0.2 }, { invId: "INV-04", qty: 1 }, { invId: "INV-05", qty: 0.1 }] },
    { id: "PRD-03", name: "Cold Beer", category: "Beer", price: 90, cost: 50, recipe: [{ invId: "INV-08", qty: 1 }] },
    { id: "PRD-04", name: "Rum & Coke", category: "Cocktails", price: 150, cost: 45, recipe: [{ invId: "INV-09", qty: 0.05 }] },
    { id: "PRD-05", name: "Whiskey Sour", category: "Cocktails", price: 220, cost: 80, recipe: [{ invId: "INV-10", qty: 0.05 }] }
  ],
  suppliers: [
    { id: "SUP-01", name: "MeatMaster Supply Co.", contact: "John Doe", phone: "09171234567", email: "meat@supply.com", address: "City Center", status: "Active" },
    { id: "SUP-02", name: "Global Beverage Distributors", contact: "Jane Smith", phone: "09187654321", email: "bev@distrib.com", address: "Industrial Zone", status: "Active" }
  ],
  purchases: [
    { id: "PO-1001", supplierId: "SUP-01", itemName: "Chicken Breast", qty: 20, unitCost: 180, totalCost: 3600, status: "Received", date: "2026-08-10" }
  ],
  kitchenOrders: [],
  sales: [],
  income: [
    { id: "INC-01", date: "2026-08-15", source: "Food & Beverage Sales", ref: "TRX-1000", amount: 12500, recordedBy: "cashier" }
  ],
  expenses: [
    { id: "EXP-01", date: "2026-08-12", category: "Rent", description: "Monthly Store Rent", amount: 15000, method: "Bank Transfer", recordedBy: "admin" },
    { id: "EXP-02", date: "2026-08-14", category: "Electricity", description: "Power Bill", amount: 4200, method: "Cash", recordedBy: "manager" }
  ],
  wastage: [
    { id: "WST-01", itemId: "INV-06", itemName: "Lettuce", qty: 1, unitCost: 70, totalCost: 70, reason: "Spoiled", date: "2026-08-15", recordedBy: "inventory" }
  ],
  activityLogs: [
    { id: "LOG-01", timestamp: "2026-08-16 08:00", user: "admin", role: "admin", action: "System Initialized", module: "System", details: "Loaded default schema" }
  ],
  notifications: [
    { id: "NT-01", text: "Whiskey 750ml is Low in Stock!", read: false, type: "warning", link: "inventory" }
  ]
};

// --- APPLICATION STATE ---
let DB = {};

// --- LOCAL STORAGE ENGINE ---
function loadDB() {
  const stored = localStorage.getItem("RESTOTRACK_DB");
  if (stored) {
    try {
      DB = JSON.parse(stored);
      if (!DB.kitchenOrders) DB.kitchenOrders = [];
      if (!DB.users) DB.users = [];
      if (!DB.users.find(u => u.username === "kitchen")) {
        DB.users.push({ id: "U105", name: "Kitchen Staff", username: "kitchen", password: "kitchen123", role: "kitchen", status: "Active", lastLogin: "" });
      }
      saveDB();
    } catch(e) { 
      DB = JSON.parse(JSON.stringify(SEED_DATA)); 
      saveDB(); 
    }
  } else {
    DB = JSON.parse(JSON.stringify(SEED_DATA));
    saveDB();
  }
}

function saveDB() {
  localStorage.setItem("RESTOTRACK_DB", JSON.stringify(DB));
}

function logActivity(action, module, details) {
  const currentUser = window.currentUser || { username: "System", role: "System" };
  const log = {
    id: "LOG-" + Date.now().toString().slice(-4),
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
    user: currentUser.username,
    role: currentUser.role,
    action,
    module,
    details
  };
  DB.activityLogs.unshift(log);
  saveDB();
}

function addNotification(text, type = "info", link = "dashboard", targetRole = null, orderId = null) {
  DB.notifications.unshift({ id: "NT-" + Date.now(), text, read: false, type, link, targetRole, orderId });
  saveDB();
  if (typeof updateNotifBadge === 'function') {
    updateNotifBadge();
  }
}

function resetData() {
  if (typeof confirmAction === 'function') {
    confirmAction("Reset All Data", "Are you sure? This will wipe all changes and restore original seed data.", () => {
      localStorage.removeItem("RESTOTRACK_DB");
      loadDB();
      if (typeof showToast === 'function') showToast("System reset to original state", "success");
      setTimeout(() => {
         window.location.reload();
      }, 500);
    });
  }
}
