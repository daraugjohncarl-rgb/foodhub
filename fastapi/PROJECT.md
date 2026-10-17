# 🍽️ Blessie FoodHub — Inbox POS System

> **Multi-Tenant FastAPI Backend + Super Admin Web Panel**
> Version: `1.4.0` | Stack: FastAPI · SQLAlchemy · MySQL · Vanilla JS · HTML/CSS

---

## 📋 Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Database Models](#database-models)
- [API Endpoints](#api-endpoints)
- [Frontend Pages](#frontend-pages)
- [Authentication Flow](#authentication-flow)
- [🆕 Recent Updates](#-recent-updates)
- [Getting Started](#getting-started)
- [Default Credentials](#default-credentials)
- [Role Hierarchy](#role-hierarchy)

---

## Overview

**Blessie FoodHub** is a multi-tenant Point-of-Sale system with a FastAPI backend and a Super Admin web panel built in plain HTML/CSS/JS. The system supports multiple restaurant branches (tenants), each with their own users (Admins, Managers, Cashiers, Inventory, Kitchen staff).

The **Super Admin** has a global view — managing tenants, creating users, monitoring activity logs, viewing and resolving incident reports, and configuring system settings.

---

## Tech Stack

| Layer         | Technology                                      |
|---------------|-------------------------------------------------|
| Backend       | FastAPI (Python 3.12+)                          |
| ORM           | SQLAlchemy                                      |
| Database      | MySQL (via PyMySQL)                             |
| Auth          | JWT (python-jose) + bcrypt password hashing     |
| Frontend      | Vanilla HTML · CSS · JavaScript (no frameworks) |
| Fonts         | Google Fonts (Inter)                            |
| Icons         | Font Awesome 6.4.0                              |
| Server        | Uvicorn (ASGI)                                  |

---

## Project Structure

```
fastapi/
├── app/
│   ├── main.py               # FastAPI app entry, lifespan, route mounting
│   ├── models.py             # SQLAlchemy ORM models
│   ├── schemas.py            # Pydantic request/response schemas
│   ├── db.py                 # Database engine & session setup
│   ├── seed.py               # (stub) seeding handled in main.py
│   ├── core/
│   │   ├── security.py       # JWT creation, bcrypt hashing & verification
│   │   └── dependencies.py   # get_current_user dependency
│   └── routers/
│       ├── auth.py           # Login, /me profile, change-password
│       ├── users.py          # CRUD for user accounts + stats
│       ├── activity_logs.py  # Audit trail GET / POST / DELETE
│       └── reports.py        # Incident report submission & SA management
│
├── static/
│   ├── index.html            # Login page (root)
│   ├── auth/
│   │   └── login.html        # Alternate login entry (same UI)
│   ├── css/
│   │   ├── login.css         # Login page styles
│   │   ├── dashboard.css     # Dashboard-specific extras
│   │   └── style.css         # Unified admin panel stylesheet
│   ├── images/
│   │   └── blessie.png       # Brand logo
│   ├── js/
│   │   ├── storage.js        # localStorage helpers + showToast()
│   │   ├── auth.js           # Auth guard + authenticated fetch wrapper
│   │   ├── notifications.js  # Live clock + notification dropdown
│   │   ├── login.js          # Login form submission logic
│   │   ├── dashboard.js      # Dashboard stats + recent users table
│   │   ├── users.js          # User list CRUD with pagination & modals
│   │   ├── create_user.js    # New user creation form
│   │   ├── profile.js        # Profile view/edit + password change
│   │   ├── settings.js       # Theme, notifications, security settings
│   │   ├── logs.js           # Activity logs table + search/filter
│   │   └── reports.js        # Incident reports table + review modal
│   └── super_admin/
│       ├── dashboard.html    # Admin dashboard with stats cards
│       ├── users.html        # User management table page
│       ├── create_user.html  # New user creation form page
│       ├── activity_logs.html# Audit trail viewer
│       ├── profile.html      # Super admin profile editor
│       ├── settings.html     # Theme & security settings
│       └── reports.html      # Incident reports viewer & management
│
├── requirements.txt
├── .env                      # DB credentials, JWT secret
└── PROJECT.md                # This file
```

---

## Database Models

### `Tenant`
Represents a restaurant branch/company. All non-SUPER_ADMIN users are scoped to a tenant.

| Column            | Type         | Notes                            |
|-------------------|--------------|----------------------------------|
| id                | BIGINT PK    | Auto-increment                   |
| name              | VARCHAR(100) | Unique                           |
| subdomain_or_code | VARCHAR(100) | Unique tenant identifier         |
| is_active         | BOOLEAN      | Default: True                    |
| created_at        | DATETIME     | Server default                   |

---

### `User`
| Column        | Type         | Notes                                                         |
|---------------|--------------|---------------------------------------------------------------|
| id            | INT PK       | Auto-increment                                                |
| tenant_id     | BIGINT FK    | NULL for SUPER_ADMIN                                          |
| username      | VARCHAR(50)  | Unique                                                        |
| first_name    | VARCHAR(50)  | Optional                                                      |
| last_name     | VARCHAR(50)  | Optional                                                      |
| email         | VARCHAR(100) | Unique, optional                                              |
| phone         | VARCHAR(30)  | Optional                                                      |
| password_hash | VARCHAR(255) | bcrypt hashed                                                 |
| role          | ENUM         | SUPER_ADMIN / ADMIN / MANAGER / CASHIER / INVENTORY / KITCHEN |
| is_active     | BOOLEAN      | Default: True                                                 |
| created_at    | DATETIME     | Server default                                                |
| updated_at    | DATETIME     | Auto-updated on change                                        |

---

### `ActivityLog`
| Column       | Type         | Notes                          |
|--------------|--------------|--------------------------------|
| id           | BIGINT PK    | Auto-increment                 |
| tenant_id    | BIGINT FK    | Nullable (SUPER_ADMIN actions) |
| user_id      | INT FK       | SET NULL on delete             |
| action       | VARCHAR(50)  | e.g. "Login", "User Created"   |
| performed_by | VARCHAR(100) | Username of actor              |
| target_user  | VARCHAR(100) | Subject of the action          |
| role         | VARCHAR(50)  | Role at time of action         |
| details      | VARCHAR(255) | Human-readable description     |
| created_at   | DATETIME     | Server default                 |

---

### `IncidentReport` *(added v1.3.0)*
Stores bug/incident/issue reports submitted by tenant users. Super Admin can review, update status, and add response notes.

| Column      | Type         | Notes                                                              |
|-------------|--------------|--------------------------------------------------------------------|
| id          | BIGINT PK    | Auto-increment                                                     |
| tenant_id   | BIGINT FK    | Indexed; CASCADE on tenant delete                                  |
| user_id     | INT FK       | Indexed; SET NULL on user delete                                   |
| title       | VARCHAR(150) | Short summary of the issue                                         |
| category    | ENUM         | BUG / HARDWARE / INVENTORY_DISCREPANCY / PAYMENT_ISSUE / OTHER    |
| priority    | ENUM         | LOW / MEDIUM / HIGH / CRITICAL — default: MEDIUM                  |
| status      | ENUM         | OPEN / IN_PROGRESS / RESOLVED / REJECTED — default: OPEN          |
| description | TEXT         | Full details of the issue                                          |
| admin_notes | TEXT         | Optional Super Admin response (nullable)                           |
| created_at  | DATETIME     | Server default                                                     |
| updated_at  | DATETIME     | Auto-updated on change                                             |

---

### Other Models
- `Category`, `Product`, `InventoryItem`, `ProductRecipe`
- `Shift`, `ShiftCashMovement`
- `Transaction`, `TransactionItem`, `Payment`
- `Supplier`, `PurchaseOrder`, `PurchaseOrderItem`
- `CustomerOrder`, `CustomerOrderItem`

---

## API Endpoints

### Auth — `/api/v1/auth`

| Method | Endpoint           | Description                         |
|--------|--------------------|-------------------------------------|
| POST   | `/login`           | OAuth2 login, returns JWT token     |
| GET    | `/me`              | Get current user profile            |
| PUT    | `/me`              | Update current user profile         |
| PUT    | `/change-password` | Change own password                 |

---

### Users — `/api/v1/users`

| Method | Endpoint              | Description                         |
|--------|-----------------------|-------------------------------------|
| GET    | `/`                   | List users (search, filter, paging) |
| GET    | `/stats`              | Aggregated user count stats         |
| GET    | `/{user_id}`          | Get single user by ID               |
| POST   | `/`                   | Create new user                     |
| PUT    | `/{user_id}`          | Update user details                 |
| PUT    | `/{user_id}/password` | Admin reset of user password        |
| PUT    | `/{user_id}/status`   | Toggle user active/inactive status  |
| DELETE | `/{user_id}`          | Delete user account                 |

---

### Activity Logs — `/api/v1/activity-logs`

| Method | Endpoint | Description                                   |
|--------|----------|-----------------------------------------------|
| GET    | `/`      | List logs (search, action filter, pagination) |
| POST   | `/`      | Manually create a log entry                   |
| DELETE | `/`      | Clear all activity logs (Super Admin only)    |

---

### Incident Reports — `/api/v1` *(added v1.3.0)*

| Method | Endpoint                          | Access        | Description                                            |
|--------|-----------------------------------|---------------|--------------------------------------------------------|
| POST   | `/reports`                        | Any auth user | Submit a new incident/bug report (tenant-scoped)       |
| GET    | `/reports/my-reports`             | Any auth user | View own previously submitted reports                  |
| GET    | `/super-admin/reports`            | SUPER_ADMIN   | View all system-wide reports with optional filters     |
| PUT    | `/super-admin/reports/{report_id}`| SUPER_ADMIN   | Update report status and/or add admin response notes   |

**Query filters for `GET /super-admin/reports`:**
- `tenant_id` — filter by specific tenant
- `status` — `OPEN` / `IN_PROGRESS` / `RESOLVED` / `REJECTED`
- `priority` — `LOW` / `MEDIUM` / `HIGH` / `CRITICAL`
- `category` — `BUG` / `HARDWARE` / `INVENTORY_DISCREPANCY` / `PAYMENT_ISSUE` / `OTHER`
- `search` — partial match on report title

> All report mutation endpoints automatically write an `ActivityLog` entry (`"Report Submitted"` and `"Report Status Updated"`).

---

## Frontend Pages

| Page              | URL Path          | Description                                          |
|-------------------|-------------------|------------------------------------------------------|
| Login             | `/`               | Authentication form                                  |
| Super Admin Dash  | `/dashboard`      | Super Admin stats overview + recent users            |
| User Lists        | `/users`          | Full user management table with CRUD                 |
| Create User       | `/create-user`    | New user registration form                           |
| Activity Logs     | `/activity-logs`  | Audit trail viewer with search/filter                |
| Profile           | `/profile`        | Edit profile info + change password                  |
| Settings          | `/settings`       | Theme toggle, notifications, security                |
| Incident Reports  | `/reports`        | Super Admin report viewer & management               |
| Admin Panel       | `/admin`          | Branch Admin dashboard                               |
| Manager Panel     | `/manager`        | Shift and staff management UI                        |
| Cashier POS       | `/cashier`        | Point-of-Sale transaction interface                  |
| Kitchen Display   | `/kitchen`        | Kitchen order ticket display                         |
| Inventory Panel   | `/inventory`      | Stock and supplier management                        |
| Customer Ordering | `/customer`       | Customer-facing ordering interface                   |

---

## Authentication Flow

```
1. User submits login form (username + password)
   └─► POST /api/v1/auth/login (x-www-form-urlencoded)
       └─► Server verifies bcrypt hash
           └─► Returns JWT access_token
               └─► Stored in localStorage
                   └─► auth.js injects Bearer token into every API call
                       └─► 401 response → auto logout + redirect to /login
```

**JWT Payload:**
```json
{
  "sub": "1",
  "username": "superadmin",
  "role": "SUPER_ADMIN",
  "tenant_id": null,
  "exp": 1234567890
}
```

**Token Expiry:** 12 hours (`ACCESS_TOKEN_EXPIRE_MINUTES = 720`)

---

## 🆕 Recent Updates

---

### ✨ v1.4.0 — Role-Based POS Modules & Workflows *(August 26, 2026)*

A massive update introducing core POS functional modules and role-specific UI shells for the restaurant's daily operations.

#### Backend Changes

**`app/models.py`**
- Added `Supplier`, `PurchaseOrder`, `PurchaseOrderItem` models for inventory restocking and supplier management.
- Added `CustomerOrder`, `CustomerOrderItem` models to handle direct customer orders (Dine In / Take Out).
- Added `PurchaseOrderStatus` enum.

**New Routers (`app/routers/`)**
- `products.py`: Product and category management.
- `inventory.py`: Inventory tracking and recipe management.
- `analytics.py`: Sales and system analytics.
- `transactions.py`: Cashier POS transaction processing.
- `kitchen.py`: Kitchen display system (KDS) endpoints for order fulfillment.
- `suppliers.py`: Supplier CRUD.
- `purchase_orders.py`: Purchase order workflow.
- `customer_orders.py`: Customer-facing ordering endpoints.

#### Frontend Changes

**Role-Specific HTML Shells (`static/pages/`)**
- `/admin` (`admin.html`): Branch Admin dashboard.
- `/manager` (`manager.html`): Shift management.
- `/cashier` (`cashier.html`): Main POS interface.
- `/kitchen` (`kitchen.html`): Kitchen display.
- `/inventory` (`inventory.html`): Inventory management.
- `/customer` (`customer.html`): Customer menu and ordering.

---

### ✨ v1.3.0 — User Incident & Issue Reporting System *(August 23, 2026)*

A complete full-stack incident reporting feature allowing all authenticated tenant users to submit bug/issue reports, and giving the Super Admin full visibility to manage, filter, update status, and respond.

#### Backend Changes

**`app/models.py`**
- Added `ReportCategory` enum: `BUG`, `HARDWARE`, `INVENTORY_DISCREPANCY`, `PAYMENT_ISSUE`, `OTHER`
- Added `ReportPriority` enum: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`
- Added `ReportStatus` enum: `OPEN`, `IN_PROGRESS`, `RESOLVED`, `REJECTED`
- Added `IncidentReport` ORM model (`incident_reports` table) with FK to `tenants` and `users`
- Added bidirectional `incident_reports` relationship to both `Tenant` and `User` models

**`app/schemas.py`**
- Added `ReportCreate` — request schema for submitting a report (title, category, priority, description)
- Added `ReportUpdateStatus` — Super Admin update payload (status + admin_notes)
- Added `ReportResponse` — full response including denormalized `tenant_name` and `username` via `model_validator`

**`app/routers/reports.py`** *(new file)*
- `POST /api/v1/reports` — Any authenticated user submits a report auto-scoped to their `tenant_id`/`user_id`; logs `"Report Submitted"` to ActivityLog
- `GET /api/v1/reports/my-reports` — Authenticated user views their own reports, ordered by newest first
- `GET /api/v1/super-admin/reports` — Super Admin only; retrieves all reports with optional `tenant_id`, `status`, `priority`, `category`, and `search` filters
- `PUT /api/v1/super-admin/reports/{report_id}` — Super Admin only; updates status and admin notes; logs `"Report Status Updated"` to ActivityLog
- All read endpoints use `joinedload` for efficient ORM relationship loading

**`app/main.py`**
- Imported and registered `reports_router` under `/api/v1` prefix
- Added `GET /reports` (and alias paths) serving `static/super_admin/reports.html`

#### Frontend Changes

**`static/super_admin/reports.html`** *(new file)*
- Summary stat cards: Total Reports, Open/Pending, High/Critical Priority, Resolved
- Filter toolbar: Status dropdown, Priority dropdown, Category dropdown, debounced title search, refresh button
- Responsive data table: Tenant, Reporter (with avatar initials), Title, Category badge, Priority badge (color-coded), Status badge, Date, Review button
- Review Modal: Full description display + inline status selector + admin notes textarea
- Fully integrated with existing sidebar, header, dark mode, toast, and logout modal patterns

**`static/js/reports.js`** *(new file)*
- `loadReports()` — fetches from `/api/v1/super-admin/reports` with live query params
- `updateSummaryCards()` — animated counter fill for the 4 stat cards
- `renderTable()` — XSS-safe HTML rendering with priority/status color-coded badges
- `openReviewModal()` / save handler — `PUT` update with loading state on Save button
- Debounced search (350ms), instant filter dropdowns, backdrop-click modal dismiss

**All existing Super Admin sidebar pages updated:**
- `dashboard.html`, `users.html`, `create_user.html`, `activity_logs.html`, `profile.html`, `settings.html`
- All now include the **Incident Reports** nav link (`<i class="fas fa-flag">`) pointing to `reports.html`

#### Audit Trail Coverage after v1.3.0

| Action                 | Triggered By                                     |
|------------------------|--------------------------------------------------|
| Login                  | `POST /auth/login`                               |
| Profile Updated        | `PUT /auth/me`                                   |
| Password Reset (self)  | `PUT /auth/change-password`                      |
| Password Reset (admin) | `PUT /users/{id}/password`                       |
| User Created           | `POST /users/`                                   |
| User Edited            | `PUT /users/{id}`                                |
| User Deleted           | `DELETE /users/{id}`                             |
| User Activated         | `PUT /users/{id}/status`                         |
| User Deactivated       | `PUT /users/{id}/status`                         |
| **Report Submitted**   | **`POST /reports`**                              |
| **Report Status Updated** | **`PUT /super-admin/reports/{id}`**           |

---

### 🔴 v1.2.1 — Dashboard Stats & Table — Critical ID Mismatch *(August 23, 2026)*

**Files:** `static/super_admin/dashboard.html`, `static/js/dashboard.js`

**Problem:** The HTML stat card element IDs did not match what `dashboard.js` was querying with `getElementById()`. As a result, all three stat cards always showed `0` regardless of real data.

| Old HTML ID (broken)   | Correct ID (fixed)    |
|------------------------|-----------------------|
| `statTotalAdmins`      | `countAdmins`         |
| `statActiveAdmins`     | `countActiveAdmins`   |
| `statInactiveAdmins`   | `countInactiveAdmins` |

**Also fixed:**
- The recent users table `<tbody>` was `recentAdminsBody` but JS used `recentUsersBody` — fixed.
- Removed a mismatched 5th "Email" column from the table header (JS only renders 4 columns).
- `dashboard.js` corrected to read the right API response field names (`active_admins`, `inactive_admins`) from `/api/v1/users/stats`.

---

### 🟡 v1.2.1 — Missing Audit Logs for Login, Profile Update & Password Change *(August 23, 2026)*

**File:** `app/routers/auth.py`

**Problem:** The Activity Logs page was missing entries for the most common actions. The `login`, `PUT /me`, and `PUT /change-password` endpoints recorded nothing.

All three log writes are wrapped in `try/except` — a logging failure will **never block** the primary action.

---

### 🟢 v1.2.1 — Login Page — Logo Fallback & Credentials Hint *(August 23, 2026)*

**Files:** `static/index.html`, `static/css/login.css`

**Problem:** `static/index.html` was out of sync with `static/auth/login.html` — missing the `#logoFallback` div and default credentials hint.

**Changes:**
- `static/index.html` synced to include `#logoFallback` and `.demo-hint` section.
- `login.css` received `.logo-text-fallback` and `.demo-hint` styles.

---

## Getting Started

### 1. Set up the virtual environment

```bash
cd fastapi
python -m venv venv
.\venv\Scripts\activate         # Windows
source venv/bin/activate        # macOS/Linux
pip install -r requirements.txt
```

### 2. Configure environment variables

Edit `.env`:
```env
DB_HOST=localhost
DB_PORT=3306
DB_NAME=inbox_pos
DB_USER=root
DB_PASS=your_password
JWT_SECRET=your_jwt_secret_key
```

### 3. Start the server

```bash
.\venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The app will automatically:
- Create all database tables on first run (including `incident_reports`)
- Seed the default SUPER_ADMIN account if none exists
- Serve the frontend at `http://localhost:8000`
- Serve the interactive API docs at `http://localhost:8000/docs`

---

## Default Credentials

| Role        | Username     | Password        |
|-------------|--------------|-----------------|
| Super Admin | `superadmin` | `superadmin123` |

> ⚠️ **Change the default password immediately after first login in a production environment.**

---

## Role Hierarchy

```
SUPER_ADMIN  → Global access, no tenant scope
  └── ADMIN      → Branch-level admin (manages one tenant)
        ├── MANAGER    → Shift & staff management
        ├── CASHIER    → Transaction processing
        ├── INVENTORY  → Stock management
        └── KITCHEN    → Order fulfillment
```

> All roles except SUPER_ADMIN can submit incident reports via `POST /api/v1/reports`.

---

*Documentation last updated: August 26, 2026 — v1.4.0*
