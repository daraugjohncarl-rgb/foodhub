import sys
sys.path.insert(0, 'c:/pos')
sys.path.insert(0, 'c:/pos/fastapi')
from app.db import SessionLocal
from app import models
db = SessionLocal()
prods = db.query(models.Product).all()
products = [{
    'id': p.id,
    'sku': p.sku or f'POS-{p.id}',
    'name': p.name,
    'price': float(p.price or 0),
    'is_active': p.is_active
} for p in prods if p.is_active]
db.close()

from scratch.test_accurate_pos_codes import match_voice_product

queries = [
    'pos five',
    'pos 5',
    'five',
    'three',
    'four',
    'one',
    'pos 534',
    '5341',
    'pos 5341',
    'POS-5341',
    '1.5 L — Gin, Ice, Juice',
    '1.5 L — Gin, Ice, Juice + Kropek'
]

for q in queries:
    m = match_voice_product(q)
    sku = m.get('sku') if m else None
    name = m.get('name') if m else None
    print(f"{q:35} -> {sku} : {name}")
