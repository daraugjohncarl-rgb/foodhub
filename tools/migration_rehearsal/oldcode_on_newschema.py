"""Runs the ORIGINAL (git HEAD) ORM code against a database already migrated to 0002 (disposable)."""
import os
import sys
from datetime import datetime
from decimal import Decimal

sys.dont_write_bytecode = True
url = sys.argv[1]
assert url.rstrip("/").endswith("_test")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "legacy", "fastapi"))
os.environ["DATABASE_URL"] = url
from sqlalchemy.exc import IntegrityError  # noqa: E402
from app.db import SessionLocal, Base, engine  # noqa: E402
import app.models as m  # noqa: E402

assert "legacy" in m.__file__
Base.metadata.create_all(engine)          # old start-up: must be a no-op on the new schema
db = SessionLocal()
ok = True


def step(name, fn):
    global ok
    try:
        fn()
        db.commit()
        print("OK  ", name)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        ok = False
        print("FAIL", name, type(exc).__name__, str(exc).splitlines()[0][:160])


user = db.query(m.User).filter_by(username="cashier").one()
tenant = db.query(m.Tenant).first()
product = db.query(m.Product).first()
step("read users/products/transactions", lambda: (db.query(m.User).all(), db.query(m.Product).all(), db.query(m.Transaction).all()))


def sale():
    shift = m.Shift(tenant_id=tenant.id, user_id=user.id, start_cash=0, status="open")
    db.add(shift); db.flush()
    tx = m.Transaction(tenant_id=tenant.id, shift_id=shift.id, user_id=user.id, client_tx_id="old-code-1",
                       total_amount=25, net_amount=25, status="pending")
    db.add(tx); db.flush()
    db.add(m.TransactionItem(transaction_id=tx.id, product_id=product.id, quantity=1, unit_price=25, total_price=25))
    db.add(m.Payment(transaction_id=tx.id, payment_method="Cash", amount=Decimal("25")))
    shift.end_time = datetime.utcnow(); shift.status = "closed"


step("old checkout writes a sale (naive datetimes into timestamptz)", sale)
step("old kitchen status update", lambda: setattr(db.query(m.Transaction).filter_by(client_tx_id="old-code-1").one(), "status", "completed"))
step("old customer order insert", lambda: db.add(m.CustomerOrder(order_number="OLD-1", customer_name="A", order_type="Dine In",
                                                                    tenant_id=tenant.id, total_amount=1)))


def delete_user_with_sales():
    db.delete(user)
    try:
        db.flush()
        raise AssertionError("user with sales was deleted")
    except IntegrityError:
        db.rollback()   # the new FK RESTRICT now protects history even from the old code


step("old user delete is blocked by FK RESTRICT (history kept)", delete_user_with_sales)
print("OLD CODE COMPATIBLE" if ok else "OLD CODE INCOMPATIBLE")
