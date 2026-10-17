import urllib.request
import json

BASE_URL = "http://127.0.0.1:8000"

print("1. Testing Customer Menu Endpoint (/api/v1/customer-orders/menu)...")
req = urllib.request.urlopen(f"{BASE_URL}/api/v1/customer-orders/menu")
assert req.status == 200, f"Expected 200, got {req.status}"
categories = json.loads(req.read().decode("utf-8"))

all_menu_products = []
for cat in categories:
    for prod in cat.get("products", []):
        all_menu_products.append(prod)

print(f"Total active products in customer menu: {len(all_menu_products)}")
prod_ids = [p["id"] for p in all_menu_products]
prod_skus = [p.get("sku") for p in all_menu_products]

# Ensure product 333 (C1-SOLO, is_active=0) is NOT in customer menu
assert 333 not in prod_ids, "ERROR: Inactive product 333 was found in customer menu!"
assert "C1-SOLO" not in prod_skus, "ERROR: Inactive product C1-SOLO was found in customer menu!"
print("SUCCESS: Inactive product 333 (C1-SOLO) is completely excluded from Customer Menu!")

# Check that active POS codes like POS-7928, POS-2931, POS-0286 are in menu
for test_sku in ["POS-7928", "POS-2931", "POS-0286"]:
    assert test_sku in prod_skus, f"ERROR: Active product {test_sku} should be in customer menu!"
print("SUCCESS: Active POS code products (POS-7928, POS-2931, POS-0286, etc.) are present in Customer Menu!")

print("\nAll backend checks PASSED successfully!")
