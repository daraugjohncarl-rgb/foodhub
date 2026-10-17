import re
import sys

sys.path.insert(0, 'c:/pos')
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
    # Tagalog digits
    'isa': '1', 'dalawa': '2', 'tatlo': '3', 'apat': '4',
    'lima': '5', 'anim': '6', 'pito': '7', 'walo': '8', 'siyam': '9',
    # Hiligaynon digits
    'duha': '2', 'anum': '6'
}

VOICE_NUMBER_WORDS = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'isa': 1, 'isang': 1, 'isa ka': 1, 'isaka': 1,
    'dalawa': 2, 'dalawang': 2, 'duha': 2, 'duha ka': 2, 'duhaka': 2,
    'tatlo': 3, 'tatlong': 3, 'tatlo ka': 3, 'tatloka': 3,
    'apat': 4, 'apat na': 4, 'apatna': 4, 'apat ka': 4,
    'lima': 5, 'limang': 5, 'lima ka': 5,
    'anim': 6, 'anim na': 6, 'animna': 6, 'anum': 6, 'anum ka': 6,
    'pito': 7, 'pitong': 7, 'pito ka': 7,
    'walo': 8, 'walong': 8, 'walo ka': 8,
    'siyam': 9, 'siyam na': 9, 'siyamna': 9, 'siyam ka': 9,
    'sampu': 10, 'sampung': 10, 'pulo': 10
}

def normalize_voice_phonetics(s):
    if not s: return ''
    s = s.lower().strip()

    # 1. First normalize Web Speech misheard POS variants (BEFORE stripping fillers)
    # Handles: "PO is what S", "PO is whats", "po is what's", "po is", "po s", "p o s"
    s = re.sub(r'\bpo\s+is\s+(?:what\s+)?s\b', 'pos', s, flags=re.I)
    s = re.sub(r'\bpo\s+is\s+whats\b', 'pos', s, flags=re.I)
    s = re.sub(r'\bpo\s+is\s+what\b', 'pos', s, flags=re.I)
    s = re.sub(r'\bpo\s+is\b', 'pos', s, flags=re.I)
    s = re.sub(r'\bp\s+o\s+s\b', 'pos', s, flags=re.I)
    s = re.sub(r'\bp\s*\.?\s*o\s*\.?\s*s\.?\b', 'pos', s, flags=re.I)
    s = re.sub(r'\b(pia\s*os|pi\s*os|pee\s*oh\s*ess|post|pause|pass|boss|fos)\b', 'pos', s, flags=re.I)

    # 2. Strip punctuation (. , ! ? ; : etc)
    s = re.sub(r'[.,\/#!$%\^&\*;:{}=\-_`~()?]', ' ', s)

    # 3. Strip conversational fillers
    s = re.sub(r'\b(ah+|eh+|ay+|um+|uh+|oh+|yung|yun|nga|kuya|ate|miss|bossing)\b', ' ', s, flags=re.I)
    # Strip standalone 'po' only if not followed by 's'
    s = re.sub(r'\bpo\b(?!\s*s\b)', ' ', s, flags=re.I)

    s = re.sub(r'\bpos\s*[-–—]?\s*(\d+)\b', r'pos \1', s, flags=re.I)
    s = re.sub(r'\bsku\s*[-–—]?\s*(\d+)\b', r'sku \1', s, flags=re.I)
    s = re.sub(r'\bcode\s*[-–—]?\s*(\d+)\b', r'pos \1', s, flags=re.I)

    # Common misheard beverage and food words
    s = re.sub(r'\b(ba\s*nila|banila|vanila)\b', 'vanilla', s, flags=re.I)
    s = re.sub(r'\b(makyato|makiyato|machiato)\b', 'macchiato', s, flags=re.I)
    s = re.sub(r'\b(karamel)\b', 'caramel', s, flags=re.I)
    s = re.sub(r'\b(amerikano)\b', 'americano', s, flags=re.I)
    s = re.sub(r'\b(matsa|macha)\b', 'matcha', s, flags=re.I)
    s = re.sub(r'\b(kropec|chicharon|tsitsaron)\b', 'kropek', s, flags=re.I)
    s = re.sub(r'\b(nachofry|nacho\s*fry)\b', 'nachofries', s, flags=re.I)
    s = re.sub(r'\b(espaghetti|spageti|spag)\b', 'spaghetti', s, flags=re.I)
    s = re.sub(r'\b(arozcaldo|arroz\s*caldo)\b', 'arrozcaldo', s, flags=re.I)

    # Phrased code combinations (e.g. Tagalog/English speech engine mishearing "two c two" as "ito si tito")
    s = re.sub(r'\b(?:ito|eto|to)\s+si\s+tito\b', '2 c2', s, flags=re.I)
    s = re.sub(r'\b(?:ito|eto|to)\s+(?:see|si|sea|c)\s*(?:two|tu|to|tito|2)\b', '2 c2', s, flags=re.I)
    s = re.sub(r'\b(?:ito|eto|to)\s+(?:see|si|sea|c)\s*(?:one|wan|juan|1)\b', '2 c1', s, flags=re.I)

    # C1, C2, C3 phonetics and misheard variants
    s = re.sub(r'\b(?:see|si|sea)\s*tito\b', 'c2', s, flags=re.I)
    s = re.sub(r'\btito\b', 'c2', s, flags=re.I)
    s = re.sub(r'\b(?:see|si|sea)\s*(?:1|one|wan|juan)\b', 'c1', s, flags=re.I)
    s = re.sub(r'\b(?:see|si|sea)\s*(?:2|two|tu|to)\b', 'c2', s, flags=re.I)
    s = re.sub(r'\b(?:see|si|sea)\s*(?:3|three|tri)\b', 'c3', s, flags=re.I)
    s = re.sub(r'\bc\s*(?:1|one|wan|juan)\b', 'c1', s, flags=re.I)
    s = re.sub(r'\bc\s*(?:2|two|tu|to)\b', 'c2', s, flags=re.I)
    s = re.sub(r'\bc\s*(?:3|three|tri)\b', 'c3', s, flags=re.I)
    s = re.sub(r'\b([a-z])\s+(\d{1,2})\b', r'\1\2', s, flags=re.I)

    # Convert digit words to numbers (e.g. "two nine three one" -> "2931")
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

def parse_voice_segment(seg, pending_qty=None):
    text = normalize_voice_phonetics(seg)
    qty = pending_qty if pending_qty else 1
    item_str = text
    matched_start = False

    sorted_words = sorted(VOICE_NUMBER_WORDS.keys(), key=lambda x: len(x), reverse=True)

    # Check if the entire segment is JUST a number/quantity word
    if re.match(r'^\d{1,2}$', text):
        return int(text), "", True  # is_only_qty = True

    for w in sorted_words:
        if text == w:
            return VOICE_NUMBER_WORDS[w], "", True

    # 1. Number at start (1 or 2 digits, e.g. "9 pos 2931", NOT 3+ digit POS codes)
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
            m_code_with_qty = re.match(r'^(pos\s+\d+|sku\s+\d+|\d{4,5}|c\d+)\s+(\d{1,2})$', text, flags=re.I)
            if m_code_with_qty:
                item_str = m_code_with_qty.group(1).strip()
                qty = int(m_code_with_qty.group(2))
            else:
                m_digit_end = re.match(r'^(.*?)\s+(\d{1,2})$', text)
                if m_digit_end and not re.match(r'^(pos|sku|code|item|c)$', m_digit_end.group(1).strip(), flags=re.I):
                    qty = int(m_digit_end.group(2))
                    item_str = m_digit_end.group(1).strip()

    item_str = re.sub(r'^(ng|sang|ka|bilog|ka bilog|pcs|piece|buok)\s+', '', item_str, flags=re.I).strip()
    return max(1, qty), item_str, False

def match_voice_product(query):
    if not query: return None
    norm_query = re.sub(r'[\-_,.]', ' ', query.lower()).strip()
    norm_query = re.sub(r'\s+', ' ', norm_query)
    q_clean = re.sub(r'[^a-z0-9]', '', query.lower())

    q_digit_match = re.search(r'\d+', query)
    q_digits = q_digit_match.group(0) if q_digit_match else ''
    is_code_query = bool(re.match(r'^(?:pos|sku|code|item)?\s*\d+$', query.strip(), flags=re.I))

    # Incomplete POS code check: POS codes in this store have 4 digits.
    # If a code query has fewer than 4 digits (e.g. "pos 2", "pos 26", "pos 263"), NEVER match!
    if is_code_query and len(q_digits) < 4:
        return None

    # 1. Exact match on normalized SKU / Code (e.g. "c1", "c2", "pos 2931")
    for p in active_products:
        sku = (p.get('sku') or '').lower()
        norm_sku = re.sub(r'[\-_,.]', ' ', sku).strip()
        norm_sku = re.sub(r'\s+', ' ', norm_sku)
        clean_sku = re.sub(r'[^a-z0-9]', '', sku)
        if (norm_sku and norm_sku == norm_query) or (clean_sku and clean_sku == q_clean):
            return p

    # 2. Code digits match (4 digits for POS-XXXX, 5 digits for SKU-XXXXX)
    if is_code_query and len(q_digits) >= 4:
        for p in active_products:
            sku = (p.get('sku') or '').lower()
            sku_digit_match = re.search(r'\d+', sku)
            if sku_digit_match and len(sku_digit_match.group(0)) >= 4:
                s_digits = sku_digit_match.group(0)
                if s_digits == q_digits:
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

    # 5. Product name contains query or query contains product name
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
    # Image 1 case:
    ("POS five, three, four, one.", 1, "POS-5341"),
    # Image 2 case:
    ("POS two six, three, one.", 1, "POS-2631"),
    # Image 3 case:
    ("Isa ka PO is what S two six, three, one.", 1, "POS-2631"),
    # New Image case: "Ito si Tito" -> 2 c2 (1 Bucket Ice)
    ("Ito si Tito.", 2, "c2"),
    ("ito si tito", 2, "c2"),
    ("tito", 1, "c2"),
    ("si tito", 1, "c2"),
    ("two c two", 2, "c2"),
    ("two c one", 2, "C1"),
    # Cashier speaking with quantity:
    ("3 pos 5341", 3, "POS-5341"),
    ("three pos five three four one", 3, "POS-5341"),
    ("9 pos 2931", 9, "POS-2931"),
    ("nine POS two nine three one", 9, "POS-2931"),
    # Product name & code equivalents:
    ("1 bucket ice c2", 1, "c2"),
    ("bucket ice c2", 1, "c2"),
    ("1 bucket ice", 1, "c2"),
    ("c2", 1, "c2"),
    ("1 c1 solo", 1, "C1"),
    ("c1", 1, "C1"),
    # Incomplete interim speech should NOT match:
    ("pos 263", 1, None),
    ("pos 534", 1, None),
    ("pos 2", 1, None)
]

print("Running Comprehensive Voice Matcher Test...\n")
all_passed = True
for phrase, expected_qty, expected_sku in test_cases:
    qty, item_str, is_only_qty = parse_voice_segment(phrase)
    if is_only_qty:
        matched = None
    else:
        matched = match_voice_product(item_str)

    matched_sku = matched.get('sku') if matched else None
    matched_name = matched.get('name') if matched else None

    pass_status = (matched_sku == expected_sku and (expected_sku is None or qty == expected_qty))
    if not pass_status:
        all_passed = False
        print(f"[FAIL] '{phrase}' -> Qty: {qty}, SKU: {matched_sku} ({matched_name}) [Expected: Qty: {expected_qty}, SKU: {expected_sku}]")
    else:
        print(f"[PASS] '{phrase:40}' -> Qty: {qty:2}, SKU: {str(matched_sku):10} ({str(matched_name)})")

if all_passed:
    print("\n>>> ALL TEST CASES PASSED WITH 100% SUCCESS! <<<")
else:
    print("\n>>> SOME TESTS FAILED <<<")
