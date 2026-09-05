import urllib.request, json, urllib.error
import urllib.parse

login_data = urllib.parse.urlencode({'username': 'admin', 'password': 'admin123'}).encode()
req = urllib.request.Request(
    'http://127.0.0.1:8001/api/v1/auth/login',
    data=login_data,
    headers={'Content-Type': 'application/x-www-form-urlencoded'}
)
try:
    res = urllib.request.urlopen(req)
    token_data = json.loads(res.read())
    token = token_data.get('access_token')
    print('Login OK, token obtained')

    headers = {'Authorization': f'Bearer {token}'}

    req2 = urllib.request.Request('http://127.0.0.1:8001/api/v1/suppliers/stats', headers=headers)
    res2 = urllib.request.urlopen(req2)
    stats = json.loads(res2.read())
    print('STATS:', json.dumps(stats, indent=2))

    req3 = urllib.request.Request('http://127.0.0.1:8001/api/v1/suppliers', headers=headers)
    res3 = urllib.request.urlopen(req3)
    suppliers = json.loads(res3.read())
    print(f'SUPPLIERS count: {len(suppliers)}')
    for s in suppliers:
        print(f'  id={s["id"]} name={s["supplier_name"]} category={s["category"]} status={s["status"]}')

except urllib.error.HTTPError as e:
    print(f'HTTP Error: {e.code} {e.read().decode()}')
except Exception as e:
    print(f'Error: {e}')
