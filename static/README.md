# 🍽️ Blessie FoodHub — Frontend Static UI Directory

This directory contains the entire frontend user interface for Blessie FoodHub (RestoTrack), organized for maximum readability, maintainability, and clean separation of concerns.

---

## 📁 Directory Structure

```
static/
├── index.html                    # 🚪 Central Login & Authentication Portal
│
├── pages/                        # 📄 Dedicated Role-Based Dashboard Shells
│   ├── admin.html                # 👑 Administrator Dashboard
│   ├── manager.html              # 📋 Operations & Metrics Dashboard
│   ├── inventory.html            # 📦 Stock & Inventory Control Dashboard
│   ├── cashier.html              # 💵 Point-of-Sale (POS) Checkout Terminal
│   └── kitchen.html              # 🍳 Kitchen Display System (KDS) Terminal
│
├── components/                   # 🧩 Modular HTML / View Partial Templates
│
├── assets/                       # 🎨 Frontend Core Assets
│   ├── css/
│   │   ├── style.css             # 🎨 Main Unified Design System (Light/Dark themes, POS grid, KDS cards)
│   │   └── login.css             # 🎨 Login specific styles
│   ├── js/
│   │   ├── auth.js               # 🔐 Centralized Auth & API Fetch wrapper (`POST /api/v1/auth/login`, `Auth.fetch`, `requireRole`)
│   │   ├── permissions.js        # 🛡️ Role-Based Access Control (RBAC) & Navigation builder
│   │   ├── utils.js              # 🛠️ UI Modals, Toast notifications, Receipt Printer, CSV Exporter
│   │   ├── views.js              # 📊 Async API View Renderers (Dashboard, Inventory, POS, Kitchen, Reports, Logs)
│   │   ├── admin.js              # 👑 Admin controller
│   │   ├── manager.js            # 📋 Manager controller
│   │   ├── inventory.js          # 📦 Inventory controller
│   │   ├── cashier.js            # 💵 Cashier controller
│   │   └── kitchen.js            # 🍳 Kitchen controller
│   └── images/                   # 🖼️ Brand logo & static graphic assets
│       └── blessie.png
│
└── super_admin/                  # 🌐 Super Admin management modules
```

---

## 🔌 FastAPI Routing Reference

| Page / Role | Endpoint | File Location |
|-------------|----------|---------------|
| **Login Portal** | `GET /` | `static/index.html` |
| **Admin** | `GET /admin` | `static/pages/admin.html` |
| **Manager** | `GET /manager` | `static/pages/manager.html` |
| **Inventory** | `GET /inventory` | `static/pages/inventory.html` |
| **Cashier POS** | `GET /cashier` | `static/pages/cashier.html` |
| **Kitchen KDS** | `GET /kitchen` | `static/pages/kitchen.html` |
| **Assets** | `GET /static/assets/*` | `static/assets/` |
