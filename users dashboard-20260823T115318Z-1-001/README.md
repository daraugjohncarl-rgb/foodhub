# 🍽️ Blessie FoodHub — Users Dashboard (RestoTrack)

> **Role-Based Multi-User Dashboard System**
> Stack: Vanilla HTML · CSS · JavaScript (No Framework) | Storage: `localStorage`
> Archived: `2026-08-23`

---

## 📋 Table of Contents

- [Overview](#overview)
- [Project Structure](#project-structure)
- [How It Works](#how-it-works)
- [Roles & Access Control](#roles--access-control)
- [Pages / Entry Points](#pages--entry-points)
- [Available Modules / Views](#available-modules--views)
- [Data Layer — db.js](#data-layer--dbjs)
- [Seed Data](#seed-data)
- [Demo Accounts](#demo-accounts)
- [Assets Reference](#assets-reference)

---

## Overview

This is a **standalone, client-side-only** restaurant management dashboard prototype for **Blessie FoodHub**, internally codenamed **RestoTrack**. It simulates a full multi-role POS and management system entirely in the browser — no backend server required. All data is persisted in the browser's `localStorage`.

The system provides **5 distinct role-based dashboards**, each with its own tailored sidebar navigation, views, and permissions. A shared login screen handles authentication by matching credentials against seeded user data stored locally.

> ⚠️ This is a **frontend prototype / archive snapshot**. It is not connected to the FastAPI backend. It uses `localStorage` as a mock database. For the live production backend integration, refer to the main `PROJECT.md`.

---

## Project Structure

```
users dashboard-20260823T115318Z-1-001/
└── users dashboard/
    ├── index.html          # Login page — entry point for all users
    ├── admin.html          # Admin role dashboard shell
    ├── admin.js            # Admin dashboard controller
    ├── manager.html        # Manager role dashboard shell
    ├── manager.js          # Manager dashboard controller
    ├── inventory.html      # Inventory role dashboard shell
    ├── inventory.js        # Inventory dashboard controller
    ├── cashier.html        # Cashier role dashboard shell
    ├── cashier.js          # Cashier dashboard controller
    ├── kitchen.html        # Kitchen role dashboard shell
    ├── kitchen.js          # Kitchen dashboard controller
    ├── original.html       # Original single-file prototype (all-in-one reference)
    └── assets/
        ├── style.css       # Unified stylesheet (light + dark mode, all components)
        ├── db.js           # localStorage database engine + seed data
        ├── auth.js         # Login, logout, session management
        ├── permissions.js  # Role-based menu definitions (RBAC)
        ├── utils.js        # UI helpers — toast, modal, confirm dialog
        └── views.js        # All view renderers (1578 lines, 18 modules)
```

---

## How It Works

### Authentication Flow

```
1. User opens index.html
   └─► DOMContentLoaded fires
       └─► loadDB() initializes localStorage (seeds data if first run)
           └─► isAuthenticated() checks RESTOTRACK_USER in storage
               ├── If already logged in → redirect to role dashboard
               └── If not → show login form
                   └─► login(username, password, rememberMe)
                       ├── Matches credentials against DB.users
                       ├── Checks account status (Active/Deactivated)
                       ├── Saves session to localStorage or sessionStorage
                       ├── Logs "User Login" to activityLogs
                       └── Redirects to role-specific dashboard page
```

### Session Storage

| Storage Type | When Used           | Key                |
|--------------|---------------------|--------------------|
| `localStorage` | "Remember Me" checked | `RESTOTRACK_USER` |
| `sessionStorage` | Normal login | `RESTOTRACK_USER` |

### Dashboard Shell Pattern

Each role HTML page (`admin.html`, `cashier.html`, etc.) is a **thin shell** that:
1. Loads all shared scripts (`db.js`, `utils.js`, `auth.js`, `permissions.js`, `views.js`)
2. Calls `requireRole("rolename")` — redirects away if the wrong user is logged in
3. Calls `buildSidebarMenu("rolename", navigate)` — dynamically populates sidebar based on RBAC
4. Calls `navigate("dashboard", "Dashboard")` as the default first view
5. `navigate()` calls `renderView(viewId, container)` from `views.js` to inject the HTML

---

## Roles & Access Control

Defined in [`assets/permissions.js`](users%20dashboard/assets/permissions.js).

### Role Menu Permissions

| Module          | Admin | Manager | Inventory | Cashier | Kitchen |
|-----------------|:-----:|:-------:|:---------:|:-------:|:-------:|
| Dashboard       | ✅    | ✅      | ✅        | ✅      | ✅      |
| POS             | ✅    | ✅      | ❌        | ✅      | ❌      |
| Orders (Kitchen)| ✅    | ✅      | ❌        | ❌      | ✅      |
| Inventory       | ✅    | ✅      | ✅        | ❌      | ❌      |
| Employees       | ✅    | ✅      | ❌        | ❌      | ❌      |
| Reports         | ✅    | ✅      | ❌        | ❌      | ❌      |
| Attendance      | ✅    | ✅      | ❌        | ❌      | ❌      |
| Payroll         | ✅    | ❌      | ❌        | ❌      | ❌      |
| User Lists      | ✅    | ❌      | ❌        | ❌      | ❌      |
| Activity Logs   | ✅    | ❌      | ❌        | ❌      | ❌      |
| Profile         | ✅    | ✅      | ✅        | ✅      | ✅      |
| Settings        | ✅    | ✅      | ❌        | ❌      | ❌      |

---

## Pages / Entry Points

| File              | Role       | Title                          | Default View |
|-------------------|------------|--------------------------------|--------------|
| `index.html`      | All        | RestoTrack — Login             | Login screen |
| `admin.html`      | `admin`    | Blessie FoodHub — Admin        | Dashboard    |
| `manager.html`    | `manager`  | Blessie FoodHub — Manager      | Dashboard    |
| `inventory.html`  | `inventory`| Blessie FoodHub — Inventory    | Dashboard    |
| `cashier.html`    | `cashier`  | Blessie FoodHub — Cashier      | Dashboard    |
| `kitchen.html`    | `kitchen`  | Blessie FoodHub — Kitchen      | Dashboard    |
| `original.html`   | —          | RestoTrack (original prototype)| *(reference only — empty body)* |

---

## Available Modules / Views

All views are rendered by `renderView(viewId, container)` in [`assets/views.js`](users%20dashboard/assets/views.js).

| View ID       | Function              | Description                                              |
|---------------|-----------------------|----------------------------------------------------------|
| `dashboard`   | `renderDashboard()`   | Role-aware summary cards — sales, orders, stock, staff   |
| `pos`         | `renderPOS()`         | Point-of-Sale interface — product grid + cart + checkout |
| `kitchen`     | `renderKitchen()`     | Kitchen order board — Pending / Preparing / Completed    |
| `inventory`   | `renderInventory()`   | Stock list with quantity, expiry, and stock status badges |
| `products`    | `renderProducts()`    | Product/menu management with recipe linking              |
| `suppliers`   | `renderSuppliers()`   | Supplier directory with contact info                     |
| `purchases`   | `renderPurchases()`   | Purchase orders from suppliers                           |
| `income`      | `renderIncome()`      | Income records / revenue entries                         |
| `expenses`    | `renderExpenses()`    | Expense tracking by category                             |
| `profitloss`  | `renderProfitLoss()`  | Profit & loss summary report                             |
| `wastage`     | `renderWastage()`     | Inventory wastage / spoilage log                         |
| `employees`   | `renderEmployees()`   | Employee directory with daily rates and status           |
| `attendance`  | `renderAttendance()`  | Daily attendance tracker (Present / Late / Absent)       |
| `payroll`     | `renderPayroll()`     | Payroll computation by pay period                        |
| `users`       | `renderUsers()`       | System user account management                           |
| `reports`     | `renderReports()`     | Summary reports (sales, inventory, employees)            |
| `logs`        | `renderLogs()`        | Activity audit log viewer                                |
| `settings`    | `renderSettings()`    | Theme toggle, data reset                                 |
| `profile`     | `renderProfile()`     | Current user's profile view/edit                         |

---

## Data Layer — `db.js`

File: [`assets/db.js`](users%20dashboard/assets/db.js)

The entire application state lives in a single global `DB` object, persisted to `localStorage` under the key `RESTOTRACK_DB`.

### Key Functions

| Function | Description |
|---|---|
| `loadDB()` | Loads DB from localStorage; seeds `SEED_DATA` if no data found |
| `saveDB()` | Serializes `DB` to `localStorage` |
| `logActivity(action, module, details)` | Appends an entry to `DB.activityLogs` |
| `addNotification(text, type, link, targetRole)` | Pushes a notification and triggers badge update |
| `resetData()` | Wipes localStorage and reloads seed data (with confirm dialog) |

### DB Collections

| Collection       | Description                              |
|------------------|------------------------------------------|
| `DB.users`       | System accounts (login credentials)      |
| `DB.employees`   | HR employee records                      |
| `DB.attendance`  | Daily attendance entries                 |
| `DB.payroll`     | Payroll period records                   |
| `DB.inventory`   | Stock items with quantity & expiry       |
| `DB.products`    | Menu items with price, cost, recipe      |
| `DB.suppliers`   | Supplier contacts                        |
| `DB.purchases`   | Purchase orders                          |
| `DB.kitchenOrders` | Live kitchen order queue               |
| `DB.sales`       | Completed POS transactions               |
| `DB.income`      | Income / revenue records                 |
| `DB.expenses`    | Expense records                          |
| `DB.wastage`     | Inventory wastage log                    |
| `DB.activityLogs`| System audit trail                       |
| `DB.notifications`| In-app notification queue              |

---

## Seed Data

Loaded automatically on first run (or after reset). All amounts are in **Philippine Peso (₱)**.

### Users (Login Credentials)

| ID    | Name           | Username    | Password     | Role        | Status |
|-------|----------------|-------------|--------------|-------------|--------|
| U101  | System Admin   | `admin`     | `admin123`   | admin       | Active |
| U102  | Juan Dela Cruz | `manager`   | `manager123` | manager     | Active |
| U103  | Inventory Staff| `inventory` | `inv123`     | inventory   | Active |
| U104  | Cashier One    | `cashier`   | `cash123`    | cashier     | Active |
| U105  | Head Chef      | `kitchen`   | `kit123`     | kitchen     | Active |

### Sample Inventory Items

| ID     | Item              | Category | Qty  | Unit    | Min Stock | Unit Cost |
|--------|-------------------|----------|------|---------|-----------|-----------|
| INV-01 | Chicken Breast    | Meat     | 26   | kg      | 10        | ₱180      |
| INV-06 | Lettuce           | Produce  | 4    | kg      | 5         | ₱70       |
| INV-08 | Beer Bottles      | Beverage | 85   | bottles | 20        | ₱50       |
| INV-10 | Whiskey 750ml     | Liquor   | 2    | bottles | 3         | ₱650      |

> Whiskey is seeded **below** min stock — triggers a Low Stock notification on startup.

### Sample Products (Menu)

| ID     | Name            | Category  | Price | Cost |
|--------|-----------------|-----------|-------|------|
| PRD-01 | Chicken Burger  | Food      | ₱180  | ₱65  |
| PRD-02 | Beef Burger     | Food      | ₱220  | ₱85  |
| PRD-03 | Cold Beer       | Beer      | ₱90   | ₱50  |
| PRD-04 | Rum & Coke      | Cocktails | ₱150  | ₱45  |
| PRD-05 | Whiskey Sour    | Cocktails | ₱220  | ₱80  |

---

## Demo Accounts

Open `index.html` in a browser. Use any of the following:

| Role      | Username    | Password     |
|-----------|-------------|--------------|
| 👑 Admin  | `admin`     | `admin123`   |
| 👔 Manager| `manager`   | `manager123` |
| 📦 Inventory | `inventory` | `inv123`  |
| 💵 Cashier| `cashier`   | `cash123`    |
| 🍳 Kitchen| `kitchen`   | `kit123`     |

---

## Assets Reference

### `assets/style.css` — 31 KB
Unified stylesheet supporting **light** and **dark mode** (`[data-theme="dark"]`). Includes styles for:
- Login card
- Sidebar (collapsible, with active state)
- Top navigation bar
- Stat cards (`.card`, `.grid-4`)
- Data tables (`.table-container`, `table`, `th`, `td`)
- POS layout (`.pos-container`, `.pos-grid`, `.product-card`, `.pos-cart`)
- Kitchen board (`.kitchen-grid`, `.kitchen-card`, status borders)
- Modals (`.modal-overlay`, `.modal`)
- Toast notifications (`#toast-container`, `.toast`)
- Badges (`.badge-success`, `.badge-warning`, `.badge-danger`, `.badge-pending`, `.badge-preparing`, `.badge-completed`)
- Print styles for receipt (`@media print`)

### `assets/db.js` — 8 KB
Entire local database engine. Contains seed data, `loadDB()`, `saveDB()`, `logActivity()`, and `addNotification()`.

### `assets/auth.js` — 2 KB
Session management: `login()`, `logout()`, `requireAuth()`, `requireRole()`, `getDashboardUrl()`, `getCurrentUser()`.

### `assets/permissions.js` — 3 KB
RBAC menu definitions per role (`ROLE_MENUS`). `buildSidebarMenu()` dynamically constructs the sidebar `<ul>` from the allowed menu items for the logged-in role.

### `assets/utils.js` — 2 KB
Shared UI helpers:
- `showToast(msg, type)` — bottom-right toast notification (info / success / danger)
- `openModal(title, bodyHTML, footerHTML)` — generic modal dialog
- `closeModal()` — hides modal
- `confirmAction(title, msg, onConfirm)` — confirm dialog wrapper
- `getStockStatus(item)` — returns stock badge label/class for inventory items
- `getExpStatus(expDateStr)` — returns expiry badge (Safe / Expiring Soon / Expired)

### `assets/views.js` — 72 KB (1578 lines)
The largest file. Contains all 19 `render*()` functions that produce the HTML for each module. Dispatched through `renderView(viewId, container)` at the bottom of the file.

---

## Relationship to FastAPI Backend

This folder is a **prototype archive** — it was used as the UI/UX reference and design baseline for the production Blessie FoodHub system. The live production system replaces:

| Prototype (this folder)         | Production (FastAPI backend)                    |
|---------------------------------|-------------------------------------------------|
| `localStorage` DB               | MySQL via SQLAlchemy                            |
| `auth.js` credential match      | JWT tokens via `POST /api/v1/auth/login`        |
| `DB.users` array                | `users` table (FastAPI)                         |
| `DB.activityLogs` array         | `activity_logs` table + `/api/v1/activity-logs` |
| `DB.inventory` array            | `inventory_items` table                         |
| `buildSidebarMenu()` RBAC       | JWT role claims + FastAPI dependency guards     |
| `resetData()` function          | N/A — database is persistent                    |

---

*Documentation created: August 23, 2026*
