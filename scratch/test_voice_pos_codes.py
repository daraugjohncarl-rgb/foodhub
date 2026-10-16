import re
import sys
import os

sys.path.insert(0, 'c:/pos/fastapi')
from app.db import SessionLocal
from app import models

db = SessionLocal()
prods = db.query(models.Product).all()
products = [{
    'id': p.id,
    'sku': p.sku or f"POS-{p.id}",
    'name': p.name,
    'price': float(p.price) if p.price else 0.0,
    'is_active': p.is_active
} for p in prods]
db.close()

VOICE_NUMBER_WORDS = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'isa': 1, 'isang': 1,
    'dalawa': 2, 'dalawang': 2,
    'tatlo': 3, 'tatlong': 3,
    'apat': 4, 'apat na': 4, 'apatna': 4,
    'lima': 5, 'limang': 5,
    'anim': 6, 'anim na': 6, 'animna': 6,
    'pito': 7, 'pitong': 7,
    'walo': 8, 'walong': 8,
    'siyam': 9, 'siyam na': 9, 'siyamna': 9,
    'sampu': 10, 'sampung': 10,
    'isa ka': 1, 'isaka': 1,
    'duha ka': 2, 'duhaka': 2, 'duha': 2,
    'tatlo ka': 3, 'tatloka': 3,
    'apat ka': 4, 'apatka': 4,
    'lima ka': 5, 'limaka': 5,
    'anum ka': 6, 'anumka': 6, 'anum': 6, 'anim ka': 6,
    'pito ka': 7, 'pitoka': 7,
    'walo ka': 8, 'waloka': 8,
    'siyam ka': 9, 'siyamka': 9,
    'napulo ka': 10, 'napuloka': 10, 'napulo': 10
}

def normalize_voice_phonetics(s):
    if not s: return ''
    s = s.lower().strip()
    # Normalize speech recognition variations for POS / SKU / Code
    s = re.sub(r'\b(post|pause|pass|boss|fos|p\s*\.?\s*o\s*\.?\s*s\.?)\s+(\d+)\b', r'pos \2', s, flags=re.I)
    s = re.sub(r'\bpos\s*[-–—]?\s*(\d+)\b', r'pos \1', s, flags=re.I)
    s = re.sub(r'\bsku\s*[-–—]?\s*(\d+)\b', r'sku \1', s, flags=re.I)
    s = re.sub(r'\bcode\s*[-–—]?\s*(\d+)\b', r'pos \1', s, flags=re.I)
    s = re.sub(r'\b(see|si|sea)\s*1\b', 'c1', s, flags=re.I)
    s = re.sub(r'\b(see|si|sea)\s*2\b', 'c2', s, flags=re.I)
    s = re.sub(r'\b(see|si|sea)\s*3\b', 'c3', s, flags=re.I)
    s = re.sub(r'\bc\s+1\b', 'c1', s, flags=re.I)
    s = re.sub(r'\bc\s+2\b', 'c2', s, flags=re.I)
    s = re.sub(r'\bc\s+3\b', 'c3', s, flags=re.I)
    s = re.sub(r'\b([a-z])\s+(\d{1,2})\b', r'\1\2', s, flags=re.I)
    return s

def parse_voice_segment(seg):
    text = normalize_voice_phonetics(seg)
    qty = 1
    item_str = text
    matched_start = False

    sorted_words = sorted(VOICE_NUMBER_WORDS.keys(), key=lambda x: len(x), reverse=True)

    # 1. Number at start (only 1 or 2 digits, so 3+ digit POS codes like 7928 are not treated as quantities)
    m_start_digit = re.match(r'^(\d{1,2})\s+(.*)$', text)
    if m_start_digit:
        qty = int(m_start_digit.group(1))
        item_str = m_start_digit.group(2).strip()
        matched_start = True
    else:
        # Check number word at start
        for w in sorted_words:
            m = re.match(r'^' + re.escape(w) + r'\s+(.*)$', text, flags=re.I)
            if m:
                qty = VOICE_NUMBER_WORDS[w]
                item_str = m.group(1).strip()
                matched_start = True
                break

    if not matched_start:
        # 2. Check number word at end (e.g., "pos 7928 isa", "pos 7928 dalawa", "7928 duha")
        matched_end = False
        for w in sorted_words:
            m = re.match(r'^(.*?)\s+' + re.escape(w) + r'$', text, flags=re.I)
            if m:
                qty = VOICE_NUMBER_WORDS[w]
                item_str = m.group(1).strip()
                matched_end = True
                break

        if not matched_end:
            # Check trailing digit at end (only 1 or 2 digits, e.g. "pos 7928 2", "c1 solo 1", "7928 2")
            # BUT do not treat the code as qty if it is preceded by pos/sku/code/item!
            m_code_with_qty = re.match(r'^(pos\s+\d+|sku\s+\d+|\d{3,5})\s+(\d{1,2})$', text, flags=re.I)
            if m_code_with_qty:
                item_str = m_code_with_qty.group(1).strip()
                qty = int(m_code_with_qty.group(2))
            else:
                m_digit_end = re.match(r'^(.*?)\s+(\d{1,2})$', text)
                if m_digit_end and not re.match(r'^(pos|sku|code|item)$', m_digit_end.group(1).strip(), flags=re.I):
                    qty = int(m_digit_end.group(2))
                    item_str = m_digit_end.group(1).strip()

    # Clean leftover connectors
    item_str = re.sub(r'^(ng|sang|ka|bilog|ka bilog|pcs|piece|buok)\s+', '', item_str, flags=re.I).strip()
    return max(1, qty), item_str

def match_voice_product(query, all_products):
    if not all_products or not query: return None
    # CRITICAL: Exclude inactive products
    active_products = [p for p in all_products if p.get('is_active') not in (False, 0, '0', None)]
    
    norm_query = re.sub(r'[\-_,.]', ' ', query.lower()).strip()
    norm_query = re.sub(r'\s+', ' ', norm_query)
    q_clean = re.sub(r'[^a-z0-9]', '', query.lower())

    q_digit_match = re.search(r'\d+', query)
    q_digits = q_digit_match.group(0) if q_digit_match else ''
    q_digits_num = str(int(q_digits)) if q_digits else ''
    is_code_query = bool(re.match(r'^(?:pos|sku|code|item)?\s*\d+$', query.strip(), flags=re.I))

    # 1. Exact match on normalized SKU / Code
    for p in active_products:
        sku = (p.get('sku') or '').lower()
        sku_clean = re.sub(r'[^a-z0-9]', '', sku)
        sku_norm = re.sub(r'[\-_,.]', ' ', sku).strip()
        sku_norm = re.sub(r'\s+', ' ', sku_norm)
        if (sku_norm and sku_norm == norm_query) or (sku_clean and sku_clean == q_clean):
            return p

    # 2. Code digits match (e.g. "pos 7928", "7928", "0286", "286" matching POS-7928 / POS-0286)
    if is_code_query and q_digits:
        for p in active_products:
            sku = (p.get('sku') or '').lower()
            sku_digit_match = re.search(r'\d+', sku)
            if sku_digit_match:
                s_digits = sku_digit_match.group(0)
                s_digits_num = str(int(s_digits))
                if s_digits == q_digits or s_digits_num == q_digits_num:
                    return p
            if norm_query.startswith('pos') and str(p.get('id')) == q_digits_num:
                return p

    # 3. SKU substring match
    if len(q_clean) >= 3:
        for p in active_products:
            sku = (p.get('sku') or '').lower()
            sku_clean = re.sub(r'[^a-z0-9]', '', sku)
            if sku_clean and (sku_clean.endswith(q_clean) or q_clean.endswith(sku_clean)):
                return p

    # 4. Exact product name
    for p in active_products:
        p_norm = re.sub(r'[\-_,.]', ' ', (p.get('name') or '').lower()).strip()
        p_norm = re.sub(r'\s+', ' ', p_norm)
        if p_norm == norm_query:
            return p

    # 5. Product name contains query or query contains name
    for p in active_products:
        p_norm = re.sub(r'[\-_,.]', ' ', (p.get('name') or '').lower()).strip()
        p_norm = re.sub(r'\s+', ' ', p_norm)
        if norm_query in p_norm or (len(p_norm) > 4 and p_norm in norm_query):
            return p

    # 6. Token overlap (avoid false positives on generic modifiers like 'solo', 'regular', 'single')
    MODIFIER_WORDS = {'solo', 'single', 'regular', 'barkada', 'with', 'w', 'hot', 'cold', 'iced', '16', '22', 'oz', 'pcs', 'pc', 'l'}
    q_tokens = [t for t in norm_query.split(' ') if len(t) > 1]
    best_p = None
    best_score = 0
    non_modifier_tokens = [t for t in q_tokens if t not in MODIFIER_WORDS]
    
    for p in active_products:
        p_norm = re.sub(r'[\-_,.]', ' ', (p.get('name') or '').lower())
        sku_norm = re.sub(r'[\-_,.]', ' ', (p.get('sku') or '').lower())
        target = f"{p_norm} {sku_norm}"
        score = sum(1 for t in q_tokens if t in target)
        # If there are non-modifier tokens, at least one MUST match
        has_primary_match = not non_modifier_tokens or any(t in target for t in non_modifier_tokens)
        if has_primary_match and score > best_score:
            best_score = score
            best_p = p

    # For short queries (<=2 words), require full match. For longer, require at least 60%
    min_required = len(q_tokens) if len(q_tokens) <= 2 else max(2, int(len(q_tokens) * 0.6))
    if best_score >= min_required:
        return best_p

    return None

test_cases = [
    # POS codes alone
    ("pos 7928", 1, "POS-7928"),
    ("pos-7928", 1, "POS-7928"),
    ("7928", 1, "POS-7928"),
    ("pos 2931", 1, "POS-2931"),
    ("2931", 1, "POS-2931"),
    ("pos 0286", 1, "POS-0286"),
    ("286", 1, "POS-0286"),
    ("pos 286", 1, "POS-0286"),
    ("pos 5341", 1, "POS-5341"),
    ("pos 2631", 1, "POS-2631"),
    ("pos 5933", 1, "POS-5933"),
    ("pos 9883", 1, "POS-9883"),
    # Speech variations
    ("post 7928", 1, "POS-7928"),
    ("pause 7928", 1, "POS-7928"),
    ("code 7928", 1, "POS-7928"),
    # Hiligaynon with POS codes
    ("isa ka pos 7928", 1, "POS-7928"),
    ("duha ka pos 7928", 2, "POS-7928"),
    ("tatlo ka 7928", 3, "POS-7928"),
    ("duha ka 286", 2, "POS-0286"),
    # Tagalog with POS codes
    ("isang pos 7928", 1, "POS-7928"),
    ("dalawang pos 7928", 2, "POS-7928"),
    ("pos 7928 dalawa", 2, "POS-7928"),
    ("pos 7928 isa", 1, "POS-7928"),
    # English with POS codes
    ("1 pos 7928", 1, "POS-7928"),
    ("2 pos 7928", 2, "POS-7928"),
    ("pos 7928 2", 2, "POS-7928"),
    ("7928 2", 2, "POS-7928"),
    # Product name matching
    ("1 bucket ice", 1, "POS-7928"),
    ("duha ka bucket ice", 2, "POS-7928"),
    ("kropek", 1, "POS-9883"),
    ("isa ka kropek", 1, "POS-9883"),
    ("red horse litro", 1, "POS-8523"),
    # Inactive product: Product 333 (C1-SOLO) is inactive!
    ("c1 solo", 1, None),
    ("1 c1 solo", 1, None),
]

passed = 0
failed = 0
for text, exp_qty, exp_sku in test_cases:
    qty, item_str = parse_voice_segment(text)
    prod = match_voice_product(item_str, products)
    matched_sku = prod.get('sku') if prod else None
    ok = (qty == exp_qty and matched_sku == exp_sku)
    if ok:
        passed += 1
        print(f"PASS: '{text}' -> Qty: {qty}, Item: '{item_str}' -> Matched: {matched_sku}")
    else:
        failed += 1
        print(f"FAIL: '{text}' -> Expected (Qty: {exp_qty}, SKU: {exp_sku}), Got (Qty: {qty}, Matched: {matched_sku}, Item: '{item_str}')")

print(f"\nTotal: {passed} passed, {failed} failed.")
