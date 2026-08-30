import sys
import os
import httpx
import re

BASE_URL = "http://127.0.0.1:8000"

def test_system():
    client = httpx.Client(base_url=BASE_URL, timeout=10.0, follow_redirects=True)
    
    print("=== 1. TESTING HTML ROUTES AND STATIC ASSETS ===")
    pages = [
        "/",
        "/dashboard",
        "/users",
        "/create-user",
        "/activity-logs",
        "/reports",
        "/profile",
        "/settings",
        "/admin",
        "/manager",
        "/cashier",
        "/inventory",
        "/kitchen",
        "/customer"
    ]
    
    missing_assets = []
    
    for page in pages:
        res = client.get(page)
        print(f"Page: {page} -> Status: {res.status_code}")
        if res.status_code != 200:
            print(f"  [ERROR] Failed to load {page}: {res.status_code}")
            continue
        
        # Parse HTML for linked CSS and JS
        html = res.text
        # Find all script src
        scripts = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', html)
        # Find all link href (css)
        css_links = re.findall(r'<link[^>]+href=["\']([^"\']+)["\']', html)
        
        for asset in scripts + css_links:
            if asset.startswith("http://") or asset.startswith("https://") or asset.startswith("//"):
                continue
            # Strip query params
            clean_asset = asset.split("?")[0]
            if not clean_asset.startswith("/"):
                # relative to page
                clean_asset = "/" + clean_asset
            
            asset_res = client.get(clean_asset)
            if asset_res.status_code != 200:
                print(f"  [404 ASSET] Page {page} references missing asset: {asset} (status: {asset_res.status_code})")
                missing_assets.append((page, asset))
    
    print("\n=== 2. TESTING AUTHENTICATION FOR ALL SEEDED ROLES ===")
    roles = [
        ("superadmin", "superadmin123", "SUPER_ADMIN"),
        ("admin", "admin123", "ADMIN"),
        ("manager", "manager123", "MANAGER"),
        ("cashier", "cashier123", "CASHIER"),
        ("inventory", "inventory123", "INVENTORY"),
        ("kitchen", "kitchen123", "KITCHEN")
    ]
    
    tokens = {}
    for username, password, expected_role in roles:
        login_res = client.post("/api/v1/auth/login", data={"username": username, "password": password})
        if login_res.status_code == 200:
            data = login_res.json()
            tokens[username] = data["access_token"]
            print(f"  [OK] Login {username}: role={data.get('role')} tenant_id={data.get('tenant_id')}")
        else:
            print(f"  [FAIL] Login {username} ({password}): Status {login_res.status_code} - {login_res.text}")

    print("\n=== 3. TESTING API ENDPOINTS PER ROLE ===")
    # Super admin endpoints
    if "superadmin" in tokens:
        h = {"Authorization": f"Bearer {tokens['superadmin']}"}
        res = client.get("/api/v1/users", headers=h)
        print(f"  SuperAdmin /users/stats: {res.status_code}")
        users_data = res.json()
        users_count = len(users_data) if isinstance(users_data, list) else len(users_data.get('items', []))
        print(f"  SuperAdmin /users/: {res.status_code} ({users_count} users)")
        res = client.get("/api/v1/activity-logs/", headers=h)
        print(f"  SuperAdmin /activity-logs/: {res.status_code}")
        res = client.get("/api/v1/super-admin/reports", headers=h)
        print(f"  SuperAdmin /super-admin/reports: {res.status_code}")

    # Admin endpoints
    if "admin" in tokens:
        h = {"Authorization": f"Bearer {tokens['admin']}"}
        res = client.get("/api/v1/analytics/dashboard", headers=h)
        print(f"  Admin /analytics/dashboard: {res.status_code} -> {res.text[:100]}")
        res = client.get("/api/v1/products", headers=h)
        print(f"  Admin /products: {res.status_code}")
        res = client.get("/api/v1/inventory", headers=h)
        print(f"  Admin /inventory: {res.status_code}")
        res = client.get("/api/v1/suppliers", headers=h)
        print(f"  Admin /suppliers: {res.status_code}")
        res = client.get("/api/v1/purchase-orders", headers=h)
        print(f"  Admin /purchase-orders: {res.status_code}")
        res = client.get("/api/v1/transactions", headers=h)
        print(f"  Admin /transactions: {res.status_code}")

    # Customer menu & order
    print("\n=== 4. TESTING CUSTOMER ORDER WORKFLOW ===")
    menu_res = client.get("/api/v1/customer-orders/menu?tenant_id=1")
    print(f"  Customer menu (tenant_id=1): {menu_res.status_code}, {len(menu_res.json()) if menu_res.status_code==200 else menu_res.text} categories")
    
    order_payload = {
        "order_number": "CUST-TEST01",
        "customer_name": "Test Customer",
        "order_type": "Dine-in",
        "table_number": "5",
        "notes": "No onions",
        "total": 150.0,
        "items": [
            {"name": "Burger", "variant": "Regular", "price": 75.0, "quantity": 2}
        ]
    }
    order_res = client.post("/api/v1/customer-orders", json=order_payload)
    print(f"  Customer order submission: {order_res.status_code} -> {order_res.text}")
    
    # Check pending customer orders
    pending_res = client.get("/api/v1/customer-orders/pending")
    print(f"  Customer pending orders: {pending_res.status_code} -> {len(pending_res.json()) if pending_res.status_code==200 else pending_res.text} pending")

    print("\n=== SUMMARY OF ISSUES FOUND ===")
    if missing_assets:
        print(f"Total missing assets: {len(missing_assets)}")
        for page, asset in set(missing_assets):
            print(f"  - {page} -> {asset}")
    else:
        print("No 404 assets found!")

if __name__ == "__main__":
    test_system()
