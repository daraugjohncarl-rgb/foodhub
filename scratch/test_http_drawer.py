import urllib.request
import json

try:
    # Login as admin
    req = urllib.request.Request(
        'http://127.0.0.1:8000/api/v1/auth/login',
        data=b'username=admin&password=admin123&grant_type=password',
        headers={'Content-Type': 'application/x-www-form-urlencoded'}
    )
    res = urllib.request.urlopen(req)
    token = json.loads(res.read())['access_token']
    headers = {'Authorization': f'Bearer {token}'}

    # Test /analytics/dashboard
    req2 = urllib.request.Request('http://127.0.0.1:8000/api/v1/analytics/dashboard', headers=headers)
    res2 = urllib.request.urlopen(req2)
    dash = json.loads(res2.read())
    print("Dashboard cash_in_drawer:", dash.get('cash_in_drawer'))

    # Test /shifts/drawer-summary
    req3 = urllib.request.Request('http://127.0.0.1:8000/api/v1/shifts/drawer-summary', headers=headers)
    res3 = urllib.request.urlopen(req3)
    drawer = json.loads(res3.read())
    print("Drawer summary total:", drawer.get('total_cash_in_drawers'))
    print("Active shifts count:", drawer.get('active_drawers_count'))
    for s in drawer.get('shifts', []):
        print(f" - Shift #{s['id']} {s['cashier_name']} (@{s['cashier_username']}): status={s['status']}, float=P{s['start_cash']}, expected=P{s['expected_cash']}")
    print("\nALL HTTP ENDPOINTS WORKING 100%!")
except Exception as e:
    print("Error:", e)
