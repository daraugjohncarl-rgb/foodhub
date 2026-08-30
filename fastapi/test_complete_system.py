import sys
import uuid
import httpx
from decimal import Decimal

sys.stdout.reconfigure(encoding='utf-8')

BASE_URL = "http://127.0.0.1:8000"

def run_e2e_tests():
    client = httpx.Client(base_url=BASE_URL, timeout=15.0, follow_redirects=True)
    
    print("\n==========================================")
    print(" 🚀 STARTING FULL SYSTEM E2E VALIDATION")
    print("==========================================\n")
    
    # 1. Health and DB Connection Check
    print("▶ 1. Testing DB Connectivity (/test-db)...")
    db_res = client.get("/test-db")
    assert db_res.status_code == 200, f"DB test failed: {db_res.text}"
    db_data = db_res.json()
    print(f"  ✓ Database Online: {db_data.get('database_name')} | Active Tenants: {db_data['stats']['active_tenants']} | Users: {db_data['stats']['total_users']}")

    # 2. Authentication for all default roles
    print("\n▶ 2. Testing Authentication For All 6 Roles...")
    roles_credentials = [
        ("superadmin", "superadmin123", "SUPER_ADMIN"),
        ("admin", "admin123", "ADMIN"),
        ("manager", "manager123", "MANAGER"),
        ("cashier", "cashier123", "CASHIER"),
        ("inventory", "inventory123", "INVENTORY"),
        ("kitchen", "kitchen123", "KITCHEN")
    ]
    tokens = {}
    for username, password, expected_role in roles_credentials:
        res = client.post("/api/v1/auth/login", data={"username": username, "password": password})
        assert res.status_code == 200, f"Login failed for {username}: {res.text}"
        data = res.json()
        assert "access_token" in data
        tokens[username] = data["access_token"]
        print(f"  ✓ {username.capitalize():<12} logged in -> Role: {data['role']}, Tenant: {data['tenant_id']}")

    # 3. Super Admin Operations
    print("\n▶ 3. Testing Super Admin Endpoints...")
    sa_headers = {"Authorization": f"Bearer {tokens['superadmin']}"}
    
    # Check current profile
    me_res = client.get("/api/v1/auth/me", headers=sa_headers)
    assert me_res.status_code == 200 and me_res.json()["username"] == "superadmin"
    print("  ✓ /auth/me profile confirmed")

    # Check stats
    stats_res = client.get("/api/v1/users/stats", headers=sa_headers)
    assert stats_res.status_code == 200
    print(f"  ✓ /users/stats: {stats_res.json()}")

    # Check users list
    users_res = client.get("/api/v1/users", headers=sa_headers)
    assert users_res.status_code == 200
    user_list = users_res.json()
    print(f"  ✓ /users list retrieved: {len(user_list)} active accounts")

    # Check activity logs
    logs_res = client.get("/api/v1/activity-logs", headers=sa_headers)
    assert logs_res.status_code == 200
    logs_data = logs_res.json()
    logs_count = len(logs_data) if isinstance(logs_data, list) else len(logs_data.get('items', []))
    print(f"  ✓ /activity-logs: {logs_count} log entries recorded")

    # 4. Incident Reports Flow
    print("\n▶ 4. Testing Incident Reports Workflow...")
    # Manager submits a report
    mgr_headers = {"Authorization": f"Bearer {tokens['manager']}"}
    report_payload = {
        "title": "Kitchen Thermal Printer Paper Jam",
        "category": "HARDWARE",
        "priority": "HIGH",
        "description": "The kitchen receipt printer keeps jamming when printing takeout orders."
    }
    submit_res = client.post("/api/v1/reports", json=report_payload, headers=mgr_headers)
    assert submit_res.status_code == 201, f"Report submission failed: {submit_res.text}"
    report_id = submit_res.json()["id"]
    print(f"  ✓ Incident report #{report_id} submitted by manager")

    # Super Admin reviews and updates status
    update_res = client.put(
        f"/api/v1/super-admin/reports/{report_id}",
        json={"status": "IN_PROGRESS", "admin_notes": "Replacement printer cartridge dispatched to branch."},
        headers=sa_headers
    )
    assert update_res.status_code == 200, f"Report update failed: {update_res.text}"
    print(f"  ✓ Super Admin updated Report #{report_id} status to IN_PROGRESS")

    # 4.5 Branch Admin creates Customer Staff User
    print("\n▶ 4.5 Testing Branch Staff Creation with CUSTOMER Role...")
    admin_headers = {"Authorization": f"Bearer {tokens['admin']}"}
    cust_staff_payload = {
        "username": f"cust_user_{uuid.uuid4().hex[:4]}",
        "first_name": "Kiosk",
        "last_name": "Customer",
        "email": f"cust_{uuid.uuid4().hex[:4]}@inboxpos.com",
        "password": "customer123",
        "role": "CUSTOMER",
        "is_active": True
    }
    create_cust_res = client.post("/api/v1/users", json=cust_staff_payload, headers=admin_headers)
    assert create_cust_res.status_code == 201, f"Customer staff creation failed: {create_cust_res.text}"
    created_cust = create_cust_res.json()
    assert created_cust["role"] == "CUSTOMER", f"Expected role CUSTOMER, got {created_cust['role']}"
    print(f"  ✓ Branch Admin created user '{created_cust['username']}' with role '{created_cust['role']}'")

    # Verify status toggle and delete by Branch Admin
    toggle_res = client.put(f"/api/v1/users/{created_cust['id']}/status", headers=admin_headers)
    assert toggle_res.status_code == 200
    print(f"  ✓ Branch Admin toggled status of user '{created_cust['username']}'")

    del_res = client.delete(f"/api/v1/users/{created_cust['id']}", headers=admin_headers)
    assert del_res.status_code == 204, f"Delete failed: {del_res.status_code}"
    print(f"  ✓ Branch Admin successfully deleted staff account '{created_cust['username']}' (ID: {created_cust['id']})")

    # 5. Products, Inventory & Suppliers
    print("\n▶ 5. Testing Catalog, Inventory & Suppliers...")
    admin_headers = {"Authorization": f"Bearer {tokens['admin']}"}
    
    # Products
    prods_res = client.get("/api/v1/products", headers=admin_headers)
    assert prods_res.status_code == 200
    products = prods_res.json()
    assert len(products) > 0, "Expected seeded products in menu"
    test_product = products[0]
    print(f"  ✓ Products listed: {len(products)} products available (e.g. {test_product['name']} @ ₱{test_product['price']})")

    # Inventory
    inv_res = client.get("/api/v1/inventory", headers=admin_headers)
    assert inv_res.status_code == 200
    print(f"  ✓ Inventory listed: {len(inv_res.json())} stock items tracked")

    # Suppliers
    sup_res = client.get("/api/v1/suppliers", headers=admin_headers)
    assert sup_res.status_code == 200
    suppliers = sup_res.json()
    print(f"  ✓ Suppliers listed: {len(suppliers)} suppliers found")

    # 6. Cashier POS Shift & Transaction Lifecycle
    print("\n▶ 6. Testing POS Shift & Transaction Processing...")
    cashier_headers = {"Authorization": f"Bearer {tokens['cashier']}"}

    # Start Shift (or reuse if open)
    shift_res = client.post("/api/v1/shifts/start", json={"start_cash": 1000.0}, headers=cashier_headers)
    if shift_res.status_code == 200:
        print("  ✓ Cashier shift started with ₱1,000.00 cash drawer")
    elif shift_res.status_code == 400:
        print("  ✓ Cashier shift already active")
    else:
        assert False, f"Unexpected shift response: {shift_res.text}"

    # Process POS Transaction
    tx_payload = {
        "items": [
            {
                "product_id": test_product["id"],
                "quantity": 2,
                "unit_price": test_product["price"],
                "total_price": float(test_product["price"]) * 2
            }
        ],
        "payment_method": "Cash",
        "tax_amount": 0,
        "discount_amount": 0
    }
    tx_res = client.post("/api/v1/transactions", json=tx_payload, headers=cashier_headers)
    assert tx_res.status_code == 201, f"POS Transaction failed: {tx_res.text}"
    tx_data = tx_res.json()
    print(f"  ✓ POS Transaction #{tx_data['id']} completed for ₱{tx_data['net_amount']:,.2f}")

    # 7. Kitchen Display System (KDS)
    print("\n▶ 7. Testing Kitchen Display System (KDS)...")
    kitchen_headers = {"Authorization": f"Bearer {tokens['kitchen']}"}
    
    k_orders_res = client.get("/api/v1/kitchen/orders", headers=kitchen_headers)
    assert k_orders_res.status_code == 200
    k_orders = k_orders_res.json()
    assert len(k_orders) > 0, "Expected at least 1 order in kitchen queue"
    print(f"  ✓ Kitchen orders active: {len(k_orders)} tickets in queue")

    # Update Kitchen Order Status: PREPARING -> COMPLETED
    latest_order_id = k_orders[0]["raw_id"]
    k_upd = client.put(f"/api/v1/kitchen/orders/{latest_order_id}/status", json={"status": "completed"}, headers=kitchen_headers)
    assert k_upd.status_code == 200
    print(f"  ✓ Kitchen marked Order #{latest_order_id} as COMPLETED")

    # 8. Customer QR Menu & Ordering Workflow
    print("\n▶ 8. Testing Customer Menu & Ordering Workflow...")
    # Public customer menu
    menu_res = client.get("/api/v1/customer-orders/menu?tenant_id=1")
    assert menu_res.status_code == 200
    menu = menu_res.json()
    assert len(menu) > 0, "Expected public categories"
    print(f"  ✓ Public Customer Menu: {len(menu)} categories retrieved")

    # Customer submits order
    cust_order_no = f"CUST-{uuid.uuid4().hex[:6].upper()}"
    cust_payload = {
        "order_number": cust_order_no,
        "customer_name": "Maria Santos",
        "order_type": "Dine-in",
        "table_number": "Table 8",
        "notes": "Extra crispy fries please",
        "total": 240.0,
        "items": [
            {"name": test_product["name"], "variant": "Regular", "price": float(test_product["price"]), "quantity": 2}
        ]
    }
    cust_res = client.post("/api/v1/customer-orders", json=cust_payload)
    assert cust_res.status_code == 201, f"Customer order submission failed: {cust_res.text}"
    cust_data = cust_res.json()
    print(f"  ✓ Customer Order [{cust_order_no}] placed successfully (ID: {cust_data.get('order_id')})")

    # Cashier sees pending customer order
    pending_res = client.get("/api/v1/customer-orders/pending", headers=cashier_headers)
    assert pending_res.status_code == 200
    pending_list = pending_res.json()
    matched = [o for o in pending_list if o["order_number"] == cust_order_no]
    assert len(matched) > 0, f"Order {cust_order_no} not found in pending list"
    print(f"  ✓ Cashier received pending online order from '{matched[0]['customer_name']}' for Table 8")

    # Cashier accepts the customer order
    accept_res = client.put(f"/api/v1/customer-orders/{matched[0]['id']}/status", json={"status": "accepted"}, headers=cashier_headers)
    assert accept_res.status_code == 200
    print(f"  ✓ Cashier accepted customer order #{matched[0]['id']}")

    # 9. Frontend HTML Page Deliverability
    print("\n▶ 9. Validating All Frontend HTML Pages...")
    pages = [
        ("/", "Login"),
        ("/dashboard", "Super Admin Dashboard"),
        ("/users", "User Management"),
        ("/create-user", "Create User"),
        ("/activity-logs", "Activity Logs"),
        ("/reports", "Incident Reports"),
        ("/profile", "Profile"),
        ("/settings", "Settings"),
        ("/admin", "Branch Admin"),
        ("/manager", "Manager"),
        ("/cashier", "Cashier POS"),
        ("/inventory", "Inventory"),
        ("/kitchen", "Kitchen Display"),
        ("/customer", "Customer Menu")
    ]
    for path, title in pages:
        p_res = client.get(path)
        assert p_res.status_code == 200, f"Page {path} failed: {p_res.status_code}"
        print(f"  ✓ {path:<16} -> 200 OK ({title})")

    print("\n==========================================")
    print(" 🎉 ALL END-TO-END SYSTEM TESTS PASSED!")
    print("==========================================\n")
    return True

if __name__ == "__main__":
    run_e2e_tests()
