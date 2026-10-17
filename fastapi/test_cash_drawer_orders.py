import sys
import json
import urllib.request

sys.stdout.reconfigure(encoding='utf-8')

def post_json(url, payload, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode())

def get_json(url, token=None):
    headers = {}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode())

# 1. Login as cashier
login_data = 'username=cashier&password=cashier123'.encode('utf-8')
login_req = urllib.request.Request('http://127.0.0.1:8000/api/v1/auth/login', data=login_data, headers={'Content-Type': 'application/x-www-form-urlencoded'})
with urllib.request.urlopen(login_req) as res:
    cashier_token = json.loads(res.read().decode())['access_token']
print('✓ Cashier logged in')

# 2. Check initial drawer summary
drawer_before = get_json('http://127.0.0.1:8000/api/v1/shifts/drawer-summary', cashier_token)
initial_cash = drawer_before['total_cash_in_drawers']
print(f'✓ Initial Drawer Cash: ₱{initial_cash:.2f}')

# 3. Create a PENDING transaction (not completed)
pending_tx = post_json('http://127.0.0.1:8000/api/v1/transactions', {
    'items': [{'product_id': 214, 'quantity': 1}],
    'status': 'pending',
    'payment_method': 'Cash'
}, cashier_token)
tx_id = pending_tx['id']
print(f'✓ Created Pending Transaction #{tx_id}, status={pending_tx["status"]}')

# Check drawer - pending order must NOT be saved in drawer!
drawer_pending = get_json('http://127.0.0.1:8000/api/v1/shifts/drawer-summary', cashier_token)
cash_after_pending = drawer_pending['total_cash_in_drawers']
print(f'✓ Drawer Cash while Pending: ₱{cash_after_pending:.2f}')
assert cash_after_pending == initial_cash, f'Error: Pending order changed cash in drawer! Before={initial_cash}, After={cash_after_pending}'
print('✓ SUCCESS: Pending order did NOT save into cash drawer!')

# 4. Now COMPLETE the transaction
req_put = urllib.request.Request(
    f'http://127.0.0.1:8000/api/v1/transactions/{tx_id}/status',
    data=json.dumps({'status': 'completed'}).encode('utf-8'),
    headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {cashier_token}'},
    method='PUT'
)
with urllib.request.urlopen(req_put) as res:
    res_completed = json.loads(res.read().decode())
print(f'✓ Transaction #{tx_id} marked as COMPLETED')

# Check drawer - now completed order MUST be saved in drawer!
drawer_completed = get_json('http://127.0.0.1:8000/api/v1/shifts/drawer-summary', cashier_token)
cash_after_completed = drawer_completed['total_cash_in_drawers']
print(f'✓ Drawer Cash after Completed: ₱{cash_after_completed:.2f}')
assert cash_after_completed > initial_cash, 'Error: Completed order was not saved in drawer!'
print('✓ SUCCESS: Completed order saved into cash drawer!')

# 5. Test Customer Order placement and cashier visibility:
cust_order = post_json('http://127.0.0.1:8000/api/v1/customer-orders', {
    'tenant_id': 1,
    'customer_name': 'Juan Dela Cruz',
    'table_number': '5',
    'order_type': 'Dine In',
    'items': [{'product_id': 214, 'quantity': 1}]
})
order_number = cust_order['order_number']
print(f'✓ Placed customer order: {order_number}')

# Check pending list for cashier
pending_orders = get_json('http://127.0.0.1:8000/api/v1/customer-orders/pending', cashier_token)
found = any(o['order_number'] == order_number for o in pending_orders)
assert found, f'Error: Customer order {order_number} not found in pending orders!'
print(f'✓ SUCCESS: Order {order_number} appears dynamically in cashier pending list!')

# Track customer order
track = get_json(f'http://127.0.0.1:8000/api/v1/customer-orders/track/{order_number}')
print(f'✓ SUCCESS: Customer can track order {order_number}, live status = {track["status"]}')

print('\n🎉 ALL CASH DRAWER & REAL-TIME ORDER TESTS PASSED!')
