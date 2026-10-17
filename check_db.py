import os
import sys

current_dir = os.path.dirname(os.path.abspath(__file__))
fastapi_dir = os.path.join(current_dir, "fastapi")
if fastapi_dir not in sys.path:
    sys.path.insert(0, fastapi_dir)

from app.db import SessionLocal
from sqlalchemy import text

db = SessionLocal()
result = db.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name = 'purchase_order_items' AND table_schema = DATABASE()")).fetchall()
print("Columns in purchase_order_items:")
for r in result:
    print(f" - {r[0]}")
db.close()
