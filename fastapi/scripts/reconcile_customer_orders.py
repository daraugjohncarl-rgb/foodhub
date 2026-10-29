"""
Find (and optionally repair) online customer orders whose state disagrees with their POS sale.

The old two-step flow saved the sale first and updated the order in a second request; if that second
request was lost the order stayed `pending`/`unpaid` although it had been sold. The POS repairs such an
order automatically when a cashier retries it; this script finds every remaining case at once.

Repaired (with --execute), using the SAME rule as the API (transactions.reconcile_order_with_sale):
  * order still `pending` with an active (not voided) sale         -> status `completed`
  * non-GCash order still `unpaid` with an active sale            -> payment `counter_paid`
Reported only (need a person to decide; never changed by this script):
  * rejected order whose sale still counts as income
  * GCash order with an active sale but a payment that is not `verified`
  * order whose only sale was voided while the order is still open
No sale is ever created or removed.

Usage (from the fastapi/ folder, with the same environment the app uses):
    python scripts/reconcile_customer_orders.py --confirm-host <db-host>             # dry run (default)
    python scripts/reconcile_customer_orders.py --confirm-host <db-host> --execute   # apply the repairs
Run it against a staging copy first.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db import SessionLocal, DB_HOST, DB_NAME  # noqa: E402
import app.models as models  # noqa: E402
from app.services import payments as pay  # noqa: E402
from app.routers.transactions import reconcile_order_with_sale  # noqa: E402


def scan(db):
    rows = db.query(models.CustomerOrder, models.Transaction).join(
        models.Transaction,
        (models.Transaction.customer_order_id == models.CustomerOrder.id)
        & (models.Transaction.tenant_id == models.CustomerOrder.tenant_id)
    ).order_by(models.CustomerOrder.id).all()
    repairs, review = [], []
    for order, sale in rows:
        active = sale.status not in pay.VOID_STATUSES
        if active and order.status == "rejected":
            review.append((order, sale, "rejected order with an active sale (income still counted)"))
        elif active and order.payment_method == pay.PAYMENT_GCASH and order.payment_status != pay.PS_VERIFIED:
            review.append((order, sale, f"GCash order sold while payment is '{order.payment_status}'"))
        elif not active and order.status not in ("completed", "rejected"):
            review.append((order, sale, f"sale voided but order still '{order.status}'"))
        if active and order.status != "rejected" and (
            order.status == "pending"
            or (order.payment_status == pay.PS_UNPAID and order.payment_method != pay.PAYMENT_GCASH)
        ):
            repairs.append((order, sale))
    return repairs, review


def main() -> int:
    parser = argparse.ArgumentParser(description="Reconcile customer orders with their POS sales.")
    parser.add_argument("--confirm-host", required=True, help="Database host you expect to be reading/modifying.")
    parser.add_argument("--execute", action="store_true", help="Apply the repairs (default: dry run).")
    args = parser.parse_args()

    print(f"Target database: host={DB_HOST} name={DB_NAME}")
    if args.confirm_host.strip().lower() != str(DB_HOST).strip().lower():
        print("ERROR: --confirm-host does not match the database host in DATABASE_URL. Nothing was changed.")
        return 2

    db = SessionLocal()
    try:
        repairs, review = scan(db)
        print(f"Orders to repair: {len(repairs)}")
        for order, sale in repairs:
            print(f"  order #{order.id} {order.order_number} (status={order.status}, payment={order.payment_status}) "
                  f"-> sale #{sale.id}")
        print(f"Orders needing a person to review: {len(review)}")
        for order, sale, why in review:
            print(f"  order #{order.id} {order.order_number}, sale #{sale.id}: {why}")
        if not args.execute:
            print("\nDry run only. Re-run with --execute to apply the repairs listed above.")
            return 0
        for order, sale in repairs:
            changes = reconcile_order_with_sale(order, sale)
            if changes:
                db.add(models.ActivityLog(
                    tenant_id=order.tenant_id, user_id=None, action="Order Reconciled",
                    performed_by="reconcile_customer_orders.py", role="SCRIPT",
                    details=f"Order {order.order_number} matched to existing sale #{sale.id}: {', '.join(changes)}."[:255],
                ))
        db.commit()
        print("Done.")
        return 0
    except Exception as exc:
        db.rollback()
        print(f"ERROR: reconciliation failed ({type(exc).__name__}). Nothing was changed.")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
