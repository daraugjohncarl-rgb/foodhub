import sys
sys.path.insert(0, 'c:/Users/User/Downloads/Inbox_POS/Inbox_POS/fastapi')
from app.db import SessionLocal
from sqlalchemy import text

db = SessionLocal()
result = db.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name = 'purchase_order_items'")).fetchall()
print(result)
