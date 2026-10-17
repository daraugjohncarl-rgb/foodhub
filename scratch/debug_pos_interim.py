import sys
import re
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

from scratch.test_accurate_pos_codes import match_voice_product, parse_voice_segment, normalize_voice_phonetics

def parse_full_voice_order(speech_text):
    if not speech_text or not speech_text.strip(): return []
    cleaned = speech_text.lower().strip()
    intro_patterns = [
        r'^(pabili\s+po\s+ng|pabili\s+ng|pabili\s+po|pabili)\s+',
        r'^(order\s+ko\s+po|order\s+ko|order)\s+',
        r'^(pabakal\s+palihug\s+sang|pabakal\s+sang|pabakal)\s+',
        r'^(palihug\s+ko\s+sang|palihug\s+sang|palihug)\s+',
        r'^(paki\s+add\s+ng|paki\s+add|add)\s+',
        r'^(baklon\s+ko\s+ang|baklon\s+ko|baklon)\s+',
        r'^(gusto\s+ko\s+ng|gusto\s+ko)\s+',
        r'^(i\s+want\s+to\s+order|i\s+want|can\s+i\s+get|give\s+me)\s+'
    ]
    for p in intro_patterns:
        cleaned = re.sub(p, '', cleaned, flags=re.I).strip()

    raw_segments = re.split(r'\s+(?:kag|at|and|tsaka|saka|\+|with)\s+|[,;]+', cleaned, flags=re.I)
    items = []
    for raw in raw_segments:
        s = raw.strip()
        if not s: continue
        qty, item_str = parse_voice_segment(s)
        if not item_str: continue
        matched = match_voice_product(item_str)
        items.append({
            'original': s,
            'qty': qty,
            'itemStr': item_str,
            'product': matched
        })
    return items

test_phrases = [
    'pos',
    'pos 5',
    'pos 53',
    'pos 534',
    'pos 5341',
    'pos five',
    'pos five, three',
    'pos five, three, four, one.',
    'pos 2',
    'pos 26',
    'pos 263',
    'pos 2631',
    'POS two six, three, one.',
    'Isa ka PO is what S two six, three, one.'
]

for phrase in test_phrases:
    print(f"\n=== Testing: '{phrase}' ===")
    items = parse_full_voice_order(phrase)
    for it in items:
        p = it.get('product')
        sku = p.get('sku') if p else None
        name = p.get('name') if p else None
        print(f"   Original: '{it.get('original')}' -> Parsed: '{it.get('itemStr')}', Qty: {it.get('qty')} ==> Matched: {sku} ({name})")
