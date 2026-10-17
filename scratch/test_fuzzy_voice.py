import re
import sys

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

DIGIT_WORD_MAP = {
    'zero': '0', 'sero': '0',
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

def levenshtein_distance(s1, s2):
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)
    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    return previous_row[-1]

def string_similarity(s1, s2):
    s1 = s1.lower().strip()
    s2 = s2.lower().strip()
    if not s1 or not s2: return 0.0
    if s1 == s2: return 1.0
    max_len = max(len(s1), len(s2))
    dist = levenshtein_distance(s1, s2)
    return (max_len - dist) / max_len

def normalize_voice_phonetics(s):
    if not s: return ''
    s = s.lower().strip()
    # Strip punctuation (. , ! ? ; :)
    s = re.sub(r'[.,\/#!$%\^&\*;:{}=\-_`~()?]', ' ', s)

    # Conversational fillers in Tagalog/English/Filipino speech
    s = re.sub(r'\b(ah+|eh+|ay+|um+|uh+|oh+|yung|yun|nga|po|kuya|ate|miss|bossing)\b', ' ', s, flags=re.I)

    # POS / Code phonetics
    s = re.sub(r'\b(pia\s*os|pi\s*os|pee\s*oh\s*ess|post|pause|pass|boss|fos|p\s*\.?\s*o\s*\.?\s*s\.?)\b', 'pos', s, flags=re.I)
    s = re.sub(r'\bpos\s*[-–—]?\s*(\d+)\b', r'pos \1', s, flags=re.I)
    s = re.sub(r'\bsku\s*[-–—]?\s*(\d+)\b', r'sku \1', s, flags=re.I)
    s = re.sub(r'\bcode\s*[-–—]?\s*(\d+)\b', r'pos \1', s, flags=re.I)

    # Common misheard beverage and food words in Filipino English
    s = re.sub(r'\b(ba\s*nila|banila|vanila)\b', 'vanilla', s, flags=re.I)
    s = re.sub(r'\b(makyato|makiyato|machiato)\b', 'macchiato', s, flags=re.I)
    s = re.sub(r'\b(karamel)\b', 'caramel', s, flags=re.I)
    s = re.sub(r'\b(amerikano)\b', 'americano', s, flags=re.I)
    s = re.sub(r'\b(matsa|macha)\b', 'matcha', s, flags=re.I)
    s = re.sub(r'\b(kropec|chicharon|tsitsaron)\b', 'kropek', s, flags=re.I)
    s = re.sub(r'\b(nachofry|nacho\s*fry)\b', 'nachofries', s, flags=re.I)

    # Replace sequences of digit words with numeric digits
    # e.g. "nine nine four six" -> "9946"
    words = s.split()
    converted = []
    digit_seq = []
    for w in words:
        if w in DIGIT_WORD_MAP:
            digit_seq.append(DIGIT_WORD_MAP[w])
        else:
            if digit_seq:
                if len(digit_seq) >= 2 or (converted and converted[-1] in ('pos', 'sku', 'code')):
                    converted.append(''.join(digit_seq))
                else:
                    converted.extend(digit_seq)
                digit_seq = []
            converted.append(w)
    if digit_seq:
        if len(digit_seq) >= 2 or (converted and converted[-1] in ('pos', 'sku', 'code')):
            converted.append(''.join(digit_seq))
        else:
            converted.extend(digit_seq)

    s = ' '.join(converted)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def match_voice_product_fuzzy(query, all_products):
    if not all_products or not query: return None
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

    # 2. Code digits match (e.g. "pos 9946", "9946", "pos 7928", "7928", "0286", "286")
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

    # 5. Product name contains query or query contains name (e.g. "french vanilla pos" contains "french vanilla")
    best_contains = None
    best_len = 0
    for p in active_products:
        p_norm = re.sub(r'[\-_,.]', ' ', (p.get('name') or '').lower()).strip()
        p_norm = re.sub(r'\s+', ' ', p_norm)
        if p_norm in norm_query and len(p_norm) > best_len:
            best_contains = p
            best_len = len(p_norm)
        elif len(norm_query) > 3 and norm_query in p_norm and len(norm_query) > best_len:
            best_contains = p
            best_len = len(norm_query)
    if best_contains:
        return best_contains

    # 6. Fuzzy string similarity (handles close pronunciations and typos)
    # Check similarity against product name, SKU, and clean query
    best_sim_prod = None
    best_sim_score = 0.0

    for p in active_products:
        p_name = (p.get('name') or '').lower()
        # Clean special chars from name
        p_clean_name = re.sub(r'[\-_,.()–—]', ' ', p_name).strip()
        p_clean_name = re.sub(r'\s+', ' ', p_clean_name)
        sku = (p.get('sku') or '').lower()

        # Similarity to full name
        sim_name = string_similarity(norm_query, p_clean_name)
        # Similarity to SKU
        sim_sku = string_similarity(norm_query, sku)
        
        # Token-based match: if query words are in product name
        q_words = [w for w in norm_query.split() if len(w) > 2]
        p_words = [w for w in p_clean_name.split() if len(w) > 2]
        word_overlap = 0
        if q_words and p_words:
            for qw in q_words:
                best_w_sim = max((string_similarity(qw, pw) for pw in p_words), default=0)
                if best_w_sim >= 0.75:
                    word_overlap += 1
            token_sim = word_overlap / max(len(q_words), len(p_words))
        else:
            token_sim = 0.0

        max_score = max(sim_name, sim_sku, token_sim)
        if max_score > best_sim_score:
            best_sim_score = max_score
            best_sim_prod = p

    # Threshold for close match: >= 0.65 (65% similar)
    if best_sim_score >= 0.65:
        return best_sim_prod

    return None

test_cases = [
    # The exact phrase from the user's screenshot!
    ("ah french ba nila pia os", "French Vanilla"),
    ("french ba nila", "French Vanilla"),
    ("nine nine four six", "French Vanilla"),
    ("pos nine nine four six", "French Vanilla"),
    ("seven nine two eight", "1 Bucket Ice"),
    ("caramel makyato", "Caramel Macchiato"),
    ("hot matsa", "Hot Matcha Latte"),
    ("nachofry", "Nachofries"),
    ("amerikano", "Americano"),
    ("pos 7928", "1 Bucket Ice"),
    ("isa ka pos 2931", "1.5 L – Gin, Ice, Juice"),
]

for text, exp_name in test_cases:
    norm = normalize_voice_phonetics(text)
    matched = match_voice_product_fuzzy(norm, products)
    matched_name = matched.get('name') if matched else None
    
    # Normalize dashes and spaces for comparison
    def clean(n):
        return re.sub(r'[\-_–—\s]', '', n.lower()) if n else ''
    
    ok = (clean(matched_name) == clean(exp_name) or (matched_name and clean(exp_name) in clean(matched_name)))
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] '{text}' -> norm: '{norm}' -> Matched: '{matched_name}' (Expected: '{exp_name}')")
