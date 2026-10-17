import sys
sys.path.insert(0, 'c:/pos/fastapi')
from app.db import SessionLocal
from app import models
from app.routers.shifts import get_drawer_summary

db = SessionLocal()
try:
    admin_user = db.query(models.User).filter(models.User.username == 'admin').first()
    summary = get_drawer_summary(db=db, current_user=admin_user)
    print("SUCCESS!")
    print("Total cash in drawers:", summary['total_cash_in_drawers'])
    print("Active drawers count:", summary['active_drawers_count'])
    print("Shifts returned:", len(summary['shifts']))
    for s in summary['shifts']:
        print(f" - Shift {s['id']} ({s['cashier_username']}): status={s['status']}, float={s['start_cash']}, expected={s['expected_cash']}")
finally:
    db.close()
