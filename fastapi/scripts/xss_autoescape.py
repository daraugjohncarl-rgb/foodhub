#!/usr/bin/env python3
"""
One-off codemod used for the frontend XSS remediation (kept for review / re-runs; idempotent).

For every JavaScript template literal that builds HTML (its literal text contains a tag), each top-level
`${...}` that is a plain data read (identifier / property chain, optionally with a literal default)
is wrapped in `Utils.escapeHtml(...)`. Expressions that call functions, build nested templates or
reference HTML-fragment variables (names such as ...Html, rows, badge, icon) are left alone and
reported so they can be reviewed by hand. Interpolations inside inline event handlers written as
'${x}' become Utils.jsArg(x) (JSON string literal, then HTML-escaped), because HTML escaping alone is not
enough inside JavaScript string context.

Usage: python scripts/xss_autoescape.py <file.js> [--write]
"""
import re
import sys

CHAIN = re.compile(
    r"""^[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*|\[[^\]\[]+\])*"""
    r"""(?:\s*(?:\|\||\?\?)\s*(?:'[^'\\]*'|"[^"\\]*"|[\w.]+))?$"""
)
FRAGMENT_NAME = re.compile(r"(btn|button|link|anchor|tooltip)$", re.I) if False else re.compile(
    r"(btn$|button$|link$|html|rows?$|markup|badge|icon|svg|cards?$|options$|buttons?$|actions$|tabs$|template|fragment|chip|pill|avatar|stars|"
    r"itemsList|list$|body$|content$|header$|footer$|spinner|thead|tbody|columns$|cells$|sections?$)", re.I)
TAG = re.compile(r"<[A-Za-z!/]")
HANDLER = re.compile(r"\bon[a-z]+\s*=\s*\"(?:[^\"]*)$")

skipped = []

LIT = "(?:'[^']*'|" + chr(34) + "[^" + chr(34) + "]*" + chr(34) + "|-?[0-9]+(?:[.][0-9]+)?)"
SAFE_EXPR = re.compile(
    "^(?:Utils[.]formatCurrency[(]|Utils[.]formatDate|Utils[.]formatId|Number[(]|parseInt[(]|parseFloat[(]|Math[.]|render[A-Z][A-Za-z0-9_]*[(]"
    "|[A-Za-z0-9_.!?()<>=&| +*/-]*[?]\s*" + LIT + "\s*:\s*" + LIT + "\s*$)"
)

PRE_JS_QUOTE = re.compile("'" + r"[$][{][(]?([A-Za-z0-9_$.\[\]]+)(?: [|][|] '')?[)]?[.]replace[(]/'/g, " + chr(34) + r"\\\\'" + chr(34) + r"[)][}]" + "'")
PRE_ATTR_QUOTE = re.compile(r"[$][{][(]?([A-Za-z0-9_$.\[\]]+)(?: [|][|] '')?[)]?[.]replace[(]/" + chr(34) + r"/g, '&quot;'[)][}]")


def prepass(src):
    src = PRE_JS_QUOTE.sub(lambda m: "${Utils.jsArg(" + m.group(1) + ")}", src)
    return PRE_ATTR_QUOTE.sub(lambda m: "${Utils.escapeHtml(" + m.group(1) + ")}", src)



def parse_template(src, i):
    """src[i] == '`'. Returns (end_index_after_closing_tick, parts) with parts = [('t', str) | ('e', str)]."""
    parts, buf, i = [], [], i + 1
    while i < len(src):
        c = src[i]
        if c == "\\":
            buf.append(src[i:i + 2]); i += 2; continue
        if c == "`":
            parts.append(("t", "".join(buf))); return i + 1, parts
        if c == "$" and src[i + 1:i + 2] == "{":
            parts.append(("t", "".join(buf))); buf = []
            j, expr = read_expr(src, i + 2)
            parts.append(("e", expr)); i = j; continue
        buf.append(c); i += 1
    raise ValueError("unterminated template")


def read_expr(src, i):
    """Read a ${ ... } body starting after '{'. Returns (index after '}', body)."""
    depth, start = 1, i
    while i < len(src):
        c = src[i]
        if c in "'\"":
            i = skip_string(src, i); continue
        if c == "`":
            i, _ = parse_template(src, i); continue
        if c == "/" and src[i + 1:i + 2] == "/":
            i = src.find(chr(10), i); continue
        if c == "/" and regex_allowed([src[start:i]]):
            try:
                i = skip_regex(src, i); continue
            except ValueError:
                pass
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1, src[start:i]
        i += 1
    raise ValueError("unterminated expression")


def skip_regex(src, i):
    """src[i] == '/' starting a regex literal; returns index after its flags."""
    i += 1; in_class = False
    while i < len(src):
        c = src[i]
        if c == "\\": i += 2; continue
        if c == "[": in_class = True
        elif c == "]": in_class = False
        elif c == "/" and not in_class:
            i += 1
            while i < len(src) and src[i].isalpha(): i += 1
            return i
        elif c == chr(10): raise ValueError("unterminated regex")
        i += 1
    raise ValueError("unterminated regex")


def regex_allowed(out_so_far):
    tail = "".join(out_so_far).rstrip()[-1:]
    return tail == "" or tail in "(,=:[!&|?{};+-*%<>~^" or "".join(out_so_far).rstrip().endswith(("return", "typeof", "=>"))


def skip_string(src, i):
    q = src[i]; i += 1
    while i < len(src):
        if src[i] == "\\": i += 2; continue
        if src[i] == q: return i + 1
        i += 1
    raise ValueError("unterminated string")


def transform_code(code, fname):
    """Transform every template literal found in a piece of code."""
    out, i = [], 0
    while i < len(code):
        c = code[i]
        if c in "'\"":
            j = skip_string(code, i); out.append(code[i:j]); i = j; continue
        if c == "/" and code[i + 1:i + 2] == "/":
            j = code.find("\n", i); j = len(code) if j < 0 else j; out.append(code[i:j]); i = j; continue
        if c == "/" and code[i + 1:i + 2] == "*":
            j = code.find("*/", i); j = len(code) if j < 0 else j + 2; out.append(code[i:j]); i = j; continue
        if c == "/" and regex_allowed(out):
            try:
                j = skip_regex(code, i); out.append(code[i:j]); i = j; continue
            except ValueError:
                pass
        if c == "`":
            j, parts = parse_template(code, i)
            out.append(transform_template(parts, fname)); i = j; continue
        out.append(c); i += 1
    return "".join(out)


def transform_template(parts, fname):
    is_html = any(k == "t" and TAG.search(v) for k, v in parts)
    res, preceding = ["`"], ""
    for idx, (kind, val) in enumerate(parts):
        if kind == "t":
            res.append(val); preceding += val; continue
        expr = transform_code(val, fname)  # nested templates first
        stripped = expr.strip()
        nxt = parts[idx + 1][1] if idx + 1 < len(parts) else ""
        replacement = "${" + expr + "}"
        if is_html and "escape" not in stripped and "jsArg" not in stripped and CHAIN.match(stripped):
            last = re.split(r"[.\[\]?|&\s]+", stripped.split("||")[0].split("??")[0].strip())[-1] or stripped
            in_handler = bool(HANDLER.search(preceding[-400:]))
            if in_handler and preceding.endswith("'") and nxt.startswith("'"):
                # '${x}' inside an inline handler -> JS string literal, HTML-escaped
                res[-1] = res[-1][:-1] if res[-1].endswith("'") else res[-1]
                parts[idx + 1] = ("t", nxt[1:])
                replacement = "${Utils.jsArg(" + stripped + ")}"
            elif in_handler:
                skipped.append((fname, "handler-unquoted", stripped))
            elif FRAGMENT_NAME.search(last):
                skipped.append((fname, "fragment?", stripped))
            else:
                replacement = "${Utils.escapeHtml(" + stripped + ")}"
        elif is_html and "escape" not in stripped and "jsArg" not in stripped and not SAFE_EXPR.match(stripped):
            skipped.append((fname, "complex", stripped[:100]))
        res.append(replacement)
        preceding += "\x00"
    res.append("`")
    return "".join(res)


def main():
    path = sys.argv[1]
    write = "--write" in sys.argv
    raw = open(path, encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    src = raw.replace("\r\n", "\n")
    out = transform_code(prepass(src), path)
    for fname, why, expr in skipped:
        print(f"REVIEW[{why}] {expr}", file=sys.stderr)
    if write and out != src:
        open(path, "w", encoding="utf-8", newline="").write(out.replace("\n", "\r\n") if crlf else out)
    print(f"{path}: {'changed' if out != src else 'unchanged'}; review items: {len(skipped)}", file=sys.stderr)


if __name__ == "__main__":
    main()
