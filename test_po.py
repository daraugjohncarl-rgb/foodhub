import httpx

client = httpx.Client(base_url='http://127.0.0.1:8001')
res = client.post('/api/v1/auth/login', data={'username':'inventory','password':'inventory123'})
token = res.json()['access_token']
headers = {'Authorization': f'Bearer {token}'}

# Create PO
po_data = {
    "supplier_id": 4,
    "expected_date": "2026-09-10",
    "notes": "Test PO",
    "items": [
        {
            "inventory_item_id": 1,
            "quantity": 10,
            "unit_cost": 5.0
        }
    ]
}
po_res = client.post('/api/v1/purchase-orders', json=po_data, headers=headers)
print("PO Create:", po_res.status_code, po_res.text)

if po_res.status_code == 201:
    po_id = po_res.json()['id']
    # Read PO
    po_read = client.get(f'/api/v1/purchase-orders/{po_id}', headers=headers)
    print("PO Read:", po_read.status_code, "items count:", len(po_read.json()['items']))

    # Update PO
    po_update = client.put(f'/api/v1/purchase-orders/{po_id}', json={"status": "ORDERED"}, headers=headers)
    print("PO Update:", po_update.status_code)
