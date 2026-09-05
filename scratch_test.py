import urllib.request, urllib.error
try:
    req = urllib.request.Request('http://127.0.0.1:8001/api/v1/users')
    urllib.request.urlopen(req)
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode())
