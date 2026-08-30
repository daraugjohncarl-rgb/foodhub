import os
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from app.main import app
from app.db import get_db, SessionLocal, engine
import app.models as models

# Override get_db to ensure we don't accidentally leave dangling sessions in testing
def override_get_db():
    try:
        db = SessionLocal()
        yield db
    finally:
        db.close()

app.dependency_overrides[get_db] = override_get_db
client = TestClient(app)

def run_tests():
    db = SessionLocal()
    
    # 1. Login as Super Admin to get token
    print("Testing Login...")
    response = client.post("/api/v1/auth/login", data={"username": "admin", "password": "admin123"})
    if response.status_code != 200:
        print("Admin login failed. Make sure DB is seeded.")
        return False
    
    token = response.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    
    # 2. Get current user info to find Tenant ID
    me = client.get("/api/v1/auth/me", headers=headers).json()
    tenant_id = 1  # Super admins might not have tenant_id in some apps, let's assume tenant 1 for test data
    
    # 3. Create a test product
    print("Testing Product CRUD and Image URL...")
    import random
    rand_id = random.randint(10000, 99999)
    product_data = {
        "name": f"Test Burger {rand_id}",
        "sku": f"SKU-{rand_id}",
        "barcode": "123456",
        "price": 100.50,
        "cost": 50.00,
        "is_active": True,
        "image_url": "https://example.com/burger.jpg"
    }
    prod_resp = client.post("/api/v1/products", json=product_data, headers=headers)
    assert prod_resp.status_code == 201, f"Product create failed: {prod_resp.text}"
    prod_id = prod_resp.json()["id"]
    
    # 4. Verify product price and image_url are set from creation response
    assert prod_resp.json()["image_url"] == "https://example.com/burger.jpg"
    assert prod_resp.json()["price"] == "100.50" or prod_resp.json()["price"] == 100.50
    
    # 5. Price Security Test (Manipulate unit_price)
    print("Testing Transaction Price Security...")
    # Start a shift first to avoid active shift error
    shift_resp = client.post("/api/v1/shifts/start", json={"start_cash": 100.0}, headers=headers)
    assert shift_resp.status_code in [200, 400], "Shift start failed" # 400 if already open
    
    tx_data = {
        "items": [
            {
                "product_id": prod_id,
                "quantity": 2,
                "unit_price": 1.00, # Fake price
                "total_price": 2.00 # Fake total
            }
        ],
        "payment_method": "Cash",
        "amount": 201.00 # Fake total
    }
    tx_resp = client.post("/api/v1/transactions", json=tx_data, headers=headers)
    assert tx_resp.status_code == 201, f"Transaction failed: {tx_resp.text}"
    
    # Verify the backend calculated the real total: 100.50 * 2 = 201.00
    tx_result = tx_resp.json()
    assert tx_result["net_amount"] == 201.00, f"Security fail: Expected 201.00, got {tx_result['net_amount']}"
    print("Transaction Price Security PASS: Backend enforced the DB price of 100.50 instead of 1.00")
    
    print("All tests passed!")
    db.close()
    return True

if __name__ == "__main__":
    run_tests()
