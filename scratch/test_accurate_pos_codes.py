import re
import sys

sys.path.insert(0, 'c:/pos/fastapi')
from app.db import SessionLocal
from app import models

db = SessionLocal()
active_products = [{
    'id': p.id,
    'sku': p.sku or f"POS-{p.id}",
    'name': p.name,
    'price': float(p.price) if p.price else 0.0,
    'is_active': p.is_active
} for p in db.query(models.Product).all() if p.is_active]
db.close()

DIGIT_WORD_MAP = {
    'zero': '0', 'sero': '0', 'oh': '0',
    'one': '1', 'wan': '1',
    'two': '2', 'tu': '2',
    'three': '3', 'tri': '3',
    'four': '4', 'for': '4',
    'five': '5', 'fayb': '5',
    'six': '6', 'siks': '6',
    'seven': '7', 'seben': '7',
    'eight': '8', 'eyt': '8',
    'nine': '9', 'nayn': '9',
    'isa': '1', 'dalawa': '2', 'tatlo': '3', 'apat': '4',
    'lima': '5', 'anim': '6', 'pito': '7', 'walo': '8', 'siyam': '9',
    'duha': '2', 'anum': '6'
}

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
    s = re.sub(r'[.,\/#!$%\^&\*;:{}=\-_`~()?]', ' ', s)
    s = re.sub(r'\b(ah+|eh+|ay+|um+|uh+|oh+|yung|yun|nga|po|kuya|ate|miss|bossing)\b', ' ', s, flags=re.I)
    s = re.sub(r'\b(pia\s*os|pi\s*os|pee\s*oh\s*ess|post|pause|pass|boss|fos|p\s*\.?\s*o\s*\.?\s*s\.?)\b', 'pos', s, flags=re.I)
    s = re.sub(r'\bpos\s*[-–—]?\s*(\d+)\b', r'pos \1', s, flags=re.I)
    s = re.sub(r'\bsku\s*[-–—]?\s*(\d+)\b', r'sku \1', s, flags=re.I)
    s = re.sub(r'\bcode\s*[-–—]?\s*(\d+)\b', r'pos \1', s, flags=re.I)

    s = re.sub(r'\b(ba\s*nila|banila|vanila)\b', 'vanilla', s, flags=re.I)
    s = re.sub(r'\b(makyato|makiyato|machiato)\b', 'macchiato', s, flags=re.I)
    s = re.sub(r'\b(karamel)\b', 'caramel', s, flags=re.I)
    s = re.sub(r'\b(amerikano)\b', 'americano', s, flags=re.I)
    s = re.sub(r'\b(matsa|macha)\b', 'matcha', s, flags=re.I)
    s = re.sub(r'\b(kropec|chicharon|tsitsaron)\b', 'kropek', s, flags=re.I)
    s = re.sub(r'\b(nachofry|nacho\s*fry)\b', 'nachofries', s, flags=re.I)
    s = re.sub(r'\b(espaghetti|spageti|spag)\b', 'spaghetti', s, flags=re.I)
    s = re.sub(r'\b(arozcaldo|arroz\s*caldo)\b', 'arrozcaldo', s, flags=re.I)

    s = re.sub(r'\b(see|si|sea)\s*1\b', 'c1', s, flags=re.I)
    s = re.sub(r'\b(see|si|sea)\s*2\b', 'c2', s, flags=re.I)
    s = re.sub(r'\b(see|si|sea)\s*3\b', 'c3', s, flags=re.I)
    s = re.sub(r'\bc\s+1\b', 'c1', s, flags=re.I)
    s = re.sub(r'\bc\s+2\b', 'c2', s, flags=re.I)
    s = re.sub(r'\bc\s+3\b', 'c3', s, flags=re.I)
    s = re.sub(r'\b([a-z])\s+(\d{1,2})\b', r'\1\2', s, flags=re.I)

    # Convert sequences of digit words to numbers (e.g. "two nine three one" -> "2931")
    words = [w for w in re.split(r'\s+', s) if w]
    converted = []
    digit_seq = []
    for i in range(len(words)):
        w = words[i]
        if w in DIGIT_WORD_MAP:
            digit_seq.append(DIGIT_WORD_MAP[w])
        else:
            if len(digit_seq) > 0:
                if len(digit_seq) >= 2 or (len(converted) > 0 and converted[-1] in ('pos', 'sku', 'code')):
                    converted.append(''.join(digit_seq))
                else:
                    converted.extend(digit_seq)
                digit_seq = []
            converted.append(w)
    if len(digit_seq) > 0:
        if len(digit_seq) >= 2 or (len(converted) > 0 and converted[-1] in ('pos', 'sku', 'code')):
            converted.append(''.join(digit_seq))
        else:
            converted.extend(digit_seq)

    s = ' '.join(converted)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def parse_voice_segment(seg):
    text = normalize_voice_phonetics(seg)
    qty = 1
    item_str = text
    matched_start = False

    sorted_words = sorted(VOICE_NUMBER_WORDS.keys(), key=lambda x: len(x), reverse=True)

    # 1. Number at start (1 or 2 digits, e.g. "9 pos 2931" or "1 bucket ice c2")
    m_digit_start = re.match(r'^(\d{1,2})\s+(.*)$', text)
    if m_digit_start:
        qty = int(m_digit_start.group(1))
        item_str = m_digit_start.group(2).strip()
        matched_start = True
    else:
        for w in sorted_words:
            m = re.match(r'^' + re.escape(w) + r'\s+(.*)$', text, flags=re.I)
            if m:
                qty = VOICE_NUMBER_WORDS[w]
                item_str = m.group(1).strip()
                matched_start = True
                break

    if not matched_start:
        matched_end = False
        for w in sorted_words:
            m = re.match(r'^(.*?)\s+' + re.escape(w) + r'$', text, flags=re.I)
            if m:
                qty = VOICE_NUMBER_WORDS[w]
                item_str = m.group(1).strip()
                matched_end = True
                break

        if not matched_end:
            m_code_with_qty = re.match(r'^(pos\s+\d+|sku\s+\d+|\d{3,5}|c\d+)\s+(\d{1,2})$', text, flags=re.I)
            if m_code_with_qty:
                item_str = m_code_with_qty.group(1).strip()
                qty = int(m_code_with_qty.group(2))
            else:
                m_digit_end = re.match(r'^(.*?)\s+(\d{1,2})$', text)
                if m_digit_end and not re.match(r'^(pos|sku|code|item|c)$', m_digit_end.group(1).strip(), flags=re.I):
                    qty = int(m_digit_end.group(2))
                    item_str = m_digit_end.group(1).strip()

    item_str = re.sub(r'^(ng|sang|ka|bilog|ka bilog|pcs|piece|buok)\s+', '', item_str, flags=re.I).strip()
    return max(1, qty), item_str

def match_voice_product(query):
    if not query: return None
    norm_query = re.sub(r'[\-_,.]', ' ', query.lower()).strip()
    norm_query = re.sub(r'\s+', ' ', norm_query)
    q_clean = re.sub(r'[^a-z0-9]', '', query.lower())

    q_digit_match = re.search(r'\d+', query)
    q_digits = q_digit_match.group(0) if q_digit_match else ''
    q_digits_num = str(int(q_digits)) if q_digits else ''
    is_code_query = bool(re.match(r'^(?:pos|sku|code|item)?\s*\d+$', query.strip(), flags=re.I))

    # 1. Exact match on normalized SKU / Code (e.g. "c1", "c2", "pos 2931")
    for p in active_products:
        sku = (p.get('sku') or '').lower()
        norm_sku = re.sub(r'[\-_,.]', ' ', sku).strip()
        norm_sku = re.sub(r'\s+', ' ', norm_sku)
        clean_sku = re.sub(r'[^a-z0-9]', '', sku)
        if (norm_sku and norm_sku == norm_query) or (clean_sku and clean_sku == q_clean):
            return p

    # 2. Code digits match (ONLY for >=3 digit codes like 2931, 7928, 0286; NEVER for bare single digit!)
    if is_code_query and len(q_digits) >= 3:
        for p in active_products:
            sku = (p.get('sku') or '').lower()
            sku_digit_match = re.search(r'\d+', sku)
            if sku_digit_match and len(sku_digit_match.group(0)) >= 3:
                s_digits = sku_digit_match.group(0)
                s_digits_num = str(int(s_digits))
                if s_digits == q_digits or s_digits_num == q_digits_num:
                    return p
            if norm_query.startswith('pos') and str(p.get('id')) == q_digits_num:
                return p

    # 3. Code embedded in query (e.g. "bucket ice c2", query contains word "c2")
    for p in active_products:
        sku = (p.get('sku') or '').lower()
        clean_sku = re.sub(r'[^a-z0-9]', '', sku)
        if len(clean_sku) >= 2 and re.search(r'\b' + re.escape(clean_sku) + r'\b', norm_query):
            return p

    # 4. Exact product name
    for p in active_products:
        p_norm = re.sub(r'[\-_,.]', ' ', (p.get('name') or '').lower()).strip()
        p_norm = re.sub(r'\s+', ' ', p_norm)
        if p_norm == norm_query:
            return p

    # 5. Product name contains query or query contains product name (e.g. "bucket ice" in "1 Bucket Ice")
    best_contains = None
    best_len = 0
    for p in active_products:
        p_norm = re.sub(r'[\-_,.]', ' ', (p.get('name') or '').lower()).strip()
        p_norm = re.sub(r'\s+', ' ', p_norm)
        if len(p_norm) > 2 and p_norm in norm_query and len(p_norm) > best_len:
            best_contains = p
            best_len = len(p_norm)
        elif len(norm_query) > 3 and norm_query in p_norm and len(norm_query) > best_len:
            best_contains = p
            best_len = len(norm_query)
    if best_contains:
        return best_contains

    return None

test_cases = [
    ("nine POS two nine three one", 9, "POS-2931"),
    ("9 pos 2931", 9, "POS-2931"),
    ("1 bucket ice c2", 1, "c2"),
    ("bucket ice c2", 1, "c2"),
    ("1 bucket ice", 1, "c2"),
    ("c2", 1, "c2"),
    ("1 c1", 1, "C1"),
    ("c1", 1, "C1"),
    ("two", 1, None),      # 'two' must NOT match 'c2'!
    ("one", 1, None),      # 'one' must NOT match 'C1'!
]

print("Running rigorous voice matching test...")
all_ok = True
for text, exp_qty, exp_sku in test_cases:
    qty, item_str = parse_voice_segment(text)
    prod = match_voice_product(item_str)
    matched_sku = prod.get('sku') if prod else None
    ok = (qty == exp_qty and matched_sku == exp_sku)
    if not ok: all_ok = False
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {text!r:30} -> Qty: {qty:2}, Matched: {matched_sku} (Expected: Qty: {exp_qty}, SKU: {exp_sku})")

if all_ok:
    print("\nALL TEST CASES PASSED WITH 100% ACCURACY!")
