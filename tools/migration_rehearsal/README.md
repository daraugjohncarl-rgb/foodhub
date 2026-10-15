# Migration rehearsal tools (disposable databases only)

Used to verify migrations 0001/0002 without touching any real database. Every script refuses a database whose
name does not end in `_test`. None of them imports a dump.

1. Extract the pre-audit application code (the last commit before the audit fixes) next to these scripts:
   `git archive b420672 fastapi/app | tar -x -C <dir>/legacy` (the scripts expect `legacy/fastapi/app` beside them).
2. `rehearsal_reallike.py <url> truth.json` builds a database the way the old code and the pre-Alembic scripts did
   (FK names, extra `CUSTOMER` enum value, server timezone UTC+8, rows written by all three legacy clocks).
   Add `snapshot` to build the older 2026-09-05 shape instead; migration 0002 must refuse it.
3. Stamp + upgrade it with explicit `LEGACY_DB_TIMEZONE` / `LEGACY_APP_TIMEZONE`, then compare the migrated
   instants with `truth.json`.
4. `oldcode_on_newschema.py <url>` shows what the old code does on the migrated schema (it can still delete a user
   with their sales — the reason the old service must stay stopped after migrating).
5. `schema_diff.py real_schema.sql baseline_schema.sql` compares two `pg_dump --schema-only` files, e.g. a
   schema-only extract of a backup (`pg_restore --schema-only -f real_schema.sql backup.dump`, no data) with a
   database upgraded to `0001_baseline`.
