"""Structural diff of two pg_dump --schema-only files (tables, columns, enum values, constraints, indexes)."""
import re
import sys


def parse(path):
    sql = open(path, encoding="utf-8").read()
    tables = {}
    for m in re.finditer(r"CREATE TABLE public\.(\w+) \((.*?)\n\);", sql, re.S):
        cols = {}
        for line in m.group(2).strip().split(",\n"):
            line = line.strip()
            name, _, rest = line.partition(" ")
            cols[name] = re.sub(r"\s+", " ", rest)
        tables[m.group(1)] = cols
    enums = {m.group(1): re.findall(r"'([^']*)'", m.group(2))
             for m in re.finditer(r"CREATE TYPE public\.(\w+) AS ENUM \((.*?)\);", sql, re.S)}
    defaults = {(m.group(1), m.group(2)) for m in re.finditer(
        r"ALTER TABLE ONLY public\.(\w+) ALTER COLUMN (\w+) SET DEFAULT", sql)}
    constraints = {}
    for m in re.finditer(r"ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT (\w+) (.*?);", sql, re.S):
        constraints[m.group(2)] = (m.group(1), re.sub(r"\s+", " ", m.group(3)))
    indexes = {}
    for m in re.finditer(r"CREATE (UNIQUE )?INDEX (\w+) ON public\.(\w+) USING \w+ \((.*?)\);", sql):
        indexes[m.group(2)] = (m.group(3), bool(m.group(1)), m.group(4))
    return tables, enums, defaults, constraints, indexes


real = parse(sys.argv[1])
base = parse(sys.argv[2])
names = ("tables", "enums", "defaults", "constraints", "indexes")
rt, bt = real[0], base[0]
print("Tables only in REAL dump:     ", sorted(set(rt) - set(bt)))
print("Tables only in BASELINE:      ", sorted(set(bt) - set(rt)))
for t in sorted(set(rt) & set(bt)):
    for c in sorted(set(rt[t]) | set(bt[t])):
        a, b = rt[t].get(c), bt[t].get(c)
        if a != b:
            print(f"  column {t}.{c}: real={a!r} baseline={b!r}")
for e in sorted(set(real[1]) | set(base[1])):
    if real[1].get(e) != base[1].get(e):
        print(f"  enum {e}: real={real[1].get(e)} baseline={base[1].get(e)}")
common = set(rt) & set(bt)
d_real = {d for d in real[2] if d[0] in common}
d_base = {d for d in base[2] if d[0] in common}
if d_real != d_base:
    print("  defaults differ:", sorted(d_real ^ d_base))
for label, idx in (("constraints", 3), ("indexes", 4)):
    r = {k: v for k, v in real[idx].items() if v[0] in common}
    b = {k: v for k, v in base[idx].items() if v[0] in common}
    only_r = sorted(set(r) - set(b))
    only_b = sorted(set(b) - set(r))
    changed = sorted(k for k in set(r) & set(b) if r[k] != b[k])
    print(f"{label}: real={len(r)} baseline={len(b)} | only in real: {only_r} | only in baseline: {only_b} | same name, different definition: {changed}")
    for k in changed:
        print(f"     {k}: real={r[k]}\n     {' ' * len(k)}  base={b[k]}")
