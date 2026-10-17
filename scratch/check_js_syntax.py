with open('c:/pos/fastapi/static/js/views.js', 'r', encoding='utf-8') as f:
    code = f.read()

counts = {'{': 0, '(': 0, '[': 0}
pairs = {'}': '{', ')': '(', ']': '['}
in_str = False
str_char = ''
in_line_comment = False
in_block_comment = False

i = 0
n = len(code)
while i < n:
    c = code[i]
    if in_line_comment:
        if c == '\n': in_line_comment = False
    elif in_block_comment:
        if c == '*' and i + 1 < n and code[i+1] == '/':
            in_block_comment = False
            i += 1
    elif in_str:
        if c == '\\':
            i += 1
        elif c == str_char:
            in_str = False
    else:
        if c == '/' and i + 1 < n and code[i+1] == '/':
            in_line_comment = True
            i += 1
        elif c == '/' and i + 1 < n and code[i+1] == '*':
            in_block_comment = True
            i += 1
        elif c in ('"', "'", '`'):
            in_str = True
            str_char = c
        elif c in counts:
            counts[c] += 1
        elif c in pairs:
            counts[pairs[c]] -= 1
            if counts[pairs[c]] < 0:
                print(f"Unmatched {c} at index {i}")
    i += 1

print("views.js balance check:", counts)
