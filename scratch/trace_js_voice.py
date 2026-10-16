import re

# Exact copy of the JavaScript functions from views.js
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

def compute_levenshtein_similarity(s1, s2):
    if not s1 or not s2: return 0.0
    if s1 == s2: return 1.0
    a = s1.lower().strip()
    b = s2.lower().strip()
    if a == b: return 1.0
    la = len(a); lb = len(b)
    dist = levenshtein_distance(a, b)
    max_len = max(la, lb)
    return (max_len - dist) / max_len

def normalize_voice_phonetics_js(str_val):
    if not str_val: return ''
    s = str_val.lower().strip()
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

print("Test normalize 'nine POS two nine three one':")
print(repr(normalize_voice_phonetics_js("nine POS two nine three one")))
