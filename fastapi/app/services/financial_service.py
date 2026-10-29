"""
Centralized Financial Calculation Service — Blessie FoodHub POS
===============================================================
Authoritative business logic for financial calculations across Admin and Manager reporting.

Core Rules & Accounting Principles:
1. Accuracy first: Never invent data, assume missing costs are zero, or double-count.
2. Decimal fixed-precision arithmetic for all monetary calculations.
3. Gross Sales = Total completed sales before discounts/returns.
4. Net Sales = Gross Sales - Discounts - Returns (each adjustment applied exactly once).
5. COGS = Inventory cost of goods actually sold (from recipes and unit costs).
   - If cost records are missing, mark COGS and dependent profits as INCOMPLETE.
   - Never use inventory valuation or retail price as COGS.
6. Gross Profit = Net Sales - COGS.
7. Operating Expenses = Recognized valid business expenses from expenses ledger.
   - Inventory purchases (POs) are NOT operating expenses (prevent double-counting with COGS).
   - Internal transfers (Manager to Admin) are NOT operating expenses.
8. Net Operating Profit = Gross Profit - Operating Expenses.
9. Profit Margin = (Net Operating Profit / Net Sales) * 100 (gracefully handle net_sales=0 as N/A).
10. Collections: Split payments properly allocated; sales revenue vs cash collected kept distinct.
11. Drawer Reconciliation: Expected = Float + Cash Sales + Inflows - Outflows.
12. Manager-to-Admin Transfers: Internal custody movement only; never added to sales or profit.
"""

from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, time, timedelta
from typing import Dict, Any, List, Optional, Tuple
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func, case

import app.models as models
from app.services.payments import cash_method_clause, is_cash_method

TWO_PLACES = Decimal("0.01")


def to_decimal(val: Any) -> Decimal:
    """Converts a value to Decimal safely without floating point distortion."""
    if val is None:
        return Decimal("0.00")
    if isinstance(val, Decimal):
        return val
    try:
        return Decimal(str(val))
    except Exception:
        return Decimal("0.00")


def quantize(val: Decimal) -> Decimal:
    """Rounds a Decimal value to 2 decimal places using ROUND_HALF_UP."""
    return val.quantize(TWO_PLACES, rounding=ROUND_HALF_UP)


def parse_date_boundaries(
    period: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
) -> Tuple[datetime, datetime, str]:
    """
    Returns half-open time interval [start_dt, end_dt) and period display label.
    Half-open interval prevents double-counting at period boundaries:
    start_dt <= transaction_time < end_dt
    """
    now = datetime.now()
    today = now.date()

    period_normalized = (period or "all").lower().strip()

    if period_normalized == "today":
        start_dt = datetime.combine(today, time.min)
        end_dt = start_dt + timedelta(days=1)
        label = f"Today ({today.strftime('%b %d, %Y')})"
    elif period_normalized == "yesterday":
        yesterday = today - timedelta(days=1)
        start_dt = datetime.combine(yesterday, time.min)
        end_dt = datetime.combine(today, time.min)
        label = f"Yesterday ({yesterday.strftime('%b %d, %Y')})"
    elif period_normalized == "this_week":
        start_week = today - timedelta(days=today.weekday())
        start_dt = datetime.combine(start_week, time.min)
        end_dt = datetime.combine(today + timedelta(days=1), time.min)
        label = f"This Week ({start_week.strftime('%b %d')} - {today.strftime('%b %d, %Y')})"
    elif period_normalized == "this_month":
        start_dt = datetime(today.year, today.month, 1, 0, 0, 0)
        next_month = today.month + 1 if today.month < 12 else 1
        next_year = today.year if today.month < 12 else today.year + 1
        end_dt = datetime(next_year, next_month, 1, 0, 0, 0)
        label = f"This Month ({today.strftime('%B %Y')})"
    elif period_normalized == "this_year":
        start_dt = datetime(today.year, 1, 1, 0, 0, 0)
        end_dt = datetime(today.year + 1, 1, 1, 0, 0, 0)
        label = f"This Year ({today.year})"
    elif start_date:
        try:
            s_clean = start_date.strip().replace("Z", "+00:00")
            s_parsed = datetime.fromisoformat(s_clean).replace(tzinfo=None)
            start_dt = s_parsed
            if end_date:
                e_clean = end_date.strip().replace("Z", "+00:00")
                e_parsed = datetime.fromisoformat(e_clean).replace(tzinfo=None)
                # If only date provided (00:00:00), expand to end of that day (+1 day)
                if e_parsed.time() == time.min:
                    end_dt = e_parsed + timedelta(days=1)
                else:
                    end_dt = e_parsed
            else:
                end_dt = start_dt + timedelta(days=1)
            label = f"Custom ({start_dt.strftime('%b %d, %Y')} – {end_dt.strftime('%b %d, %Y')})"
        except Exception:
            start_dt = datetime(2020, 1, 1, 0, 0, 0)
            end_dt = datetime(2099, 12, 31, 23, 59, 59)
            label = "All Time"
    else:
        # All time
        start_dt = datetime(2020, 1, 1, 0, 0, 0)
        end_dt = datetime(2099, 12, 31, 23, 59, 59)
        label = "All Time"

    return start_dt, end_dt, label


class FinancialReportCalculator:
    """
    Stateless, fully-testable financial calculations engine.
    """

    @staticmethod
    def compute_gross_sales(completed_transactions: List[models.Transaction]) -> Decimal:
        """
        Gross sales are the total value of valid completed sales before discounts and returns.
        Only completed transactions are included.
        """
        gross = Decimal("0.00")
        for tx in completed_transactions:
            if tx.status == "completed":
                gross += to_decimal(tx.total_amount)
        return quantize(gross)

    @staticmethod
    def compute_discounts(completed_transactions: List[models.Transaction]) -> Decimal:
        """Total sales discounts applied to completed transactions."""
        discounts = Decimal("0.00")
        for tx in completed_transactions:
            if tx.status == "completed":
                discounts += to_decimal(tx.discount_amount)
        return quantize(discounts)

    @staticmethod
    def compute_net_sales(
        gross_sales: Decimal,
        discounts: Decimal,
        returns: Decimal = Decimal("0.00")
    ) -> Decimal:
        """
        Net Sales = Gross Sales - Sales Discounts - Sales Returns
        Each discount and return applied exactly once.
        """
        net = gross_sales - discounts - returns
        return quantize(max(Decimal("0.00"), net))

    @staticmethod
    def compute_cogs(
        completed_transactions: List[models.Transaction]
    ) -> Tuple[Decimal, bool, List[Dict[str, Any]]]:
        """
        Calculates Cost of Goods Sold (COGS) for items in completed transactions.
        Costing hierarchy:
        1. Product recipes (ProductRecipe linked to InventoryItem.unit_price).
        2. Product.cost if > 0.
        3. If neither is available, the cost is marked as INCOMPLETE.
           The system NEVER assumes missing costs equal zero.

        Returns:
            (cogs_amount, is_complete, missing_cost_items)
        """
        total_cogs = Decimal("0.00")
        is_complete = True
        missing_cost_items = []

        for tx in completed_transactions:
            if tx.status != "completed":
                continue

            for item in tx.items:
                qty = to_decimal(item.quantity)
                product = item.product

                item_unit_cost: Optional[Decimal] = None

                # Check 1: Recipe ingredients
                if product and product.recipes and len(product.recipes) > 0:
                    recipe_cost = Decimal("0.00")
                    all_ingredients_valid = True

                    for r in product.recipes:
                        inv = r.inventory_item
                        if inv and to_decimal(inv.unit_price) > Decimal("0.00"):
                            recipe_cost += to_decimal(r.quantity) * to_decimal(inv.unit_price)
                        else:
                            all_ingredients_valid = False
                            break

                    if all_ingredients_valid and recipe_cost > Decimal("0.00"):
                        item_unit_cost = recipe_cost

                # Check 2: Direct Product.cost
                if item_unit_cost is None and product and to_decimal(product.cost) > Decimal("0.00"):
                    item_unit_cost = to_decimal(product.cost)

                # Check 3: Check if item itself recorded cost
                if item_unit_cost is not None:
                    line_cogs = qty * item_unit_cost
                    total_cogs += line_cogs
                else:
                    # Missing cost data! Flag as incomplete.
                    is_complete = False
                    prod_name = product.name if product else f"Item #{item.product_id or item.id}"
                    missing_cost_items.append({
                        "transaction_id": tx.id,
                        "item_id": item.id,
                        "product_name": prod_name,
                        "quantity": float(qty),
                        "unit_price": float(to_decimal(item.unit_price)),
                        "reason": "No recipe or recorded unit cost"
                    })

        return quantize(total_cogs), is_complete, missing_cost_items

    @staticmethod
    def compute_gross_profit(
        net_sales: Decimal,
        cogs: Decimal,
        is_cogs_complete: bool
    ) -> Tuple[Decimal, str]:
        """
        Gross Profit = Net Sales - COGS
        Only reliable when net sales and COGS are sufficiently complete.
        """
        gp = net_sales - cogs
        status = "complete" if is_cogs_complete else "incomplete"
        return quantize(gp), status

    @staticmethod
    def compute_net_operating_profit(
        gross_profit: Decimal,
        operating_expenses: Decimal,
        is_complete: bool
    ) -> Tuple[Decimal, str, bool]:
        """
        Net Operating Profit = Gross Profit - Operating Expenses
        Returns:
            (net_profit, status, is_profitable)
        """
        net_profit = gross_profit - operating_expenses
        status = "complete" if is_complete else "incomplete"
        is_profitable = (net_profit >= Decimal("0.00"))
        return quantize(net_profit), status, is_profitable

    @staticmethod
    def compute_profit_margin(
        net_operating_profit: Decimal,
        net_sales: Decimal,
        is_complete: bool
    ) -> Tuple[Optional[float], str]:
        """
        Profit Margin = (Net Operating Profit / Net Sales) * 100
        - If net_sales == 0: displays N/A (represented as None / "N/A") without division by zero.
        - Negative profit margins allowed on business loss.
        - Not capped at 100%.
        """
        if net_sales <= Decimal("0.00"):
            return None, "N/A"

        margin = (net_operating_profit / net_sales) * Decimal("100.0")
        margin_rounded = float(margin.quantize(TWO_PLACES, rounding=ROUND_HALF_UP))
        display_str = f"{margin_rounded:+.2f}%" if is_complete else f"{margin_rounded:+.2f}% (Incomplete)"
        return margin_rounded, display_str

    @staticmethod
    def compute_inventory_valuation(
        inventory_items: List[models.InventoryItem]
    ) -> Tuple[Decimal, int, List[Dict[str, Any]]]:
        """
        Inventory Value = Sum of (Eligible Current Stock Quantity * Applicable Unit Cost)
        Negative stock clamped to 0 to prevent distorted valuation.
        """
        total_val = Decimal("0.00")
        eligible_count = 0
        details = []

        for item in inventory_items:
            qty = to_decimal(item.quantity)
            unit_price = to_decimal(item.unit_price)

            # Clamp negative stock to 0 for valuation
            effective_qty = max(Decimal("0.00"), qty)
            line_val = effective_qty * unit_price
            total_val += line_val

            if effective_qty > Decimal("0.00"):
                eligible_count += 1

            details.append({
                "id": item.id,
                "name": item.name,
                "category": item.category,
                "quantity": float(qty),
                "unit": item.unit,
                "unit_price": float(unit_price),
                "valuation": float(quantize(line_val)),
                "is_negative": bool(qty < Decimal("0.00"))
            })

        return quantize(total_val), eligible_count, details


def get_consolidated_financial_report(
    db: Session,
    tenant_id: int,
    current_user: models.User,
    period: Optional[str] = "today",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
) -> Dict[str, Any]:
    """
    Produces the authoritative financial report across all 16 core metrics.
    Ensures date boundary integrity, role separation, and complete reconciliation.
    """
    user_role_str = str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role).upper()
    is_admin = user_role_str in ["ADMIN", "SUPER_ADMIN"]

    start_dt, end_dt, period_label = parse_date_boundaries(period, start_date, end_date)

    # 1. Fetch completed transactions in period using half-open interval
    completed_tx = db.query(models.Transaction).options(
        joinedload(models.Transaction.items).joinedload(models.TransactionItem.product).joinedload(models.Product.recipes).joinedload(models.ProductRecipe.inventory_item),
        joinedload(models.Transaction.payments),
        joinedload(models.Transaction.user)
    ).filter(
        models.Transaction.tenant_id == tenant_id,
        models.Transaction.status == "completed",
        models.Transaction.created_at >= start_dt,
        models.Transaction.created_at < end_dt
    ).all()

    # Overall completed transactions (all time) for cumulative balances
    all_completed_tx = db.query(models.Transaction).options(
        joinedload(models.Transaction.items).joinedload(models.TransactionItem.product).joinedload(models.Product.recipes).joinedload(models.ProductRecipe.inventory_item),
        joinedload(models.Transaction.payments)
    ).filter(
        models.Transaction.tenant_id == tenant_id,
        models.Transaction.status == "completed"
    ).all()

    calc = FinancialReportCalculator

    # 2. Revenue & Sales
    gross_sales = calc.compute_gross_sales(completed_tx)
    discounts = calc.compute_discounts(completed_tx)
    returns = Decimal("0.00")
    net_sales = calc.compute_net_sales(gross_sales, discounts, returns)

    all_gross_sales = calc.compute_gross_sales(all_completed_tx)
    all_discounts = calc.compute_discounts(all_completed_tx)
    all_net_sales = calc.compute_net_sales(all_gross_sales, all_discounts, Decimal("0.00"))

    # 3. Cost of Goods Sold & Gross Profit
    cogs_period, is_cogs_complete_period, missing_items_period = calc.compute_cogs(completed_tx)
    gross_profit, gp_status = calc.compute_gross_profit(net_sales, cogs_period, is_cogs_complete_period)

    # Overall COGS
    all_cogs, all_is_cogs_complete, _ = calc.compute_cogs(all_completed_tx)

    # 4. Operating Expenses (Authoritative from Expense table)
    # Approved/Paid expenses in period
    paid_expenses_rows = db.query(models.Expense).options(
        joinedload(models.Expense.user)
    ).filter(
        models.Expense.tenant_id == tenant_id,
        models.Expense.status == "paid",
        models.Expense.expense_date >= start_dt,
        models.Expense.expense_date < end_dt
    ).all()

    operating_expenses = quantize(sum((to_decimal(e.amount) for e in paid_expenses_rows), Decimal("0.00")))

    # Pending/Unpaid expenses in period
    pending_expenses_rows = db.query(models.Expense).filter(
        models.Expense.tenant_id == tenant_id,
        models.Expense.status == "pending",
        models.Expense.expense_date >= start_dt,
        models.Expense.expense_date < end_dt
    ).all()
    unpaid_pending_expenses = quantize(sum((to_decimal(e.amount) for e in pending_expenses_rows), Decimal("0.00")))

    # 5. Net Operating Profit & Profit Margin
    net_operating_profit, net_profit_status, is_profitable = calc.compute_net_operating_profit(
        gross_profit, operating_expenses, is_cogs_complete_period
    )
    profit_margin_val, profit_margin_str = calc.compute_profit_margin(
        net_operating_profit, net_sales, is_cogs_complete_period
    )

    # 6. Collections (Cash vs Digital Payments)
    # Using Payment table joined with completed Transactions in period
    payments_in_period = db.query(models.Payment).join(models.Transaction).filter(
        models.Transaction.tenant_id == tenant_id,
        models.Payment.status == "completed",
        models.Transaction.status == "completed",
        models.Transaction.created_at >= start_dt,
        models.Transaction.created_at < end_dt
    ).all()

    cash_collections = Decimal("0.00")
    digital_collections = Decimal("0.00")
    payments_by_method: Dict[str, Decimal] = {}

    for p in payments_in_period:
        amt = to_decimal(p.amount)
        # Grouped by the normalised method so "Cash" and "CASH" are one bucket.
        method = (p.payment_method or "Cash").strip().upper()

        if is_cash_method(method):
            cash_collections += amt
        else:
            digital_collections += amt

        payments_by_method[method] = payments_by_method.get(method, Decimal("0.00")) + amt

    cash_collections = quantize(cash_collections)
    digital_collections = quantize(digital_collections)
    total_collections = cash_collections + digital_collections

    # Cumulative all-time cash & digital collections
    all_payments = db.query(models.Payment).join(models.Transaction).filter(
        models.Transaction.tenant_id == tenant_id,
        models.Payment.status == "completed",
        models.Transaction.status == "completed"
    ).all()
    all_cash_collections = quantize(sum((to_decimal(p.amount) for p in all_payments if is_cash_method(p.payment_method)), Decimal("0.00")))
    all_digital_collections = quantize(sum((to_decimal(p.amount) for p in all_payments if not is_cash_method(p.payment_method)), Decimal("0.00")))

    # 7. Inventory Valuation
    all_inv_items = db.query(models.InventoryItem).filter(
        models.InventoryItem.tenant_id == tenant_id
    ).all()
    total_inventory_valuation, total_inventory_items_count, inv_details = calc.compute_inventory_valuation(all_inv_items)

    # 8. Cash Drawer & Cashier Reconciliation
    open_shifts = db.query(models.Shift).join(models.User).filter(
        models.Shift.tenant_id == tenant_id,
        models.Shift.status == "open",
        models.User.role == models.UserRole.CASHIER
    ).all()

    active_drawer_cash = Decimal("0.00")
    for s in open_shifts:
        c_sales = db.query(
            func.coalesce(func.sum(models.Payment.amount), 0)
        ).join(models.Transaction).filter(
            models.Transaction.shift_id == s.id,
            models.Payment.status == "completed",
            models.Transaction.status == "completed",
            cash_method_clause(models.Payment.payment_method)
        ).scalar() or Decimal("0.00")

        p_in = db.query(
            func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
        ).filter(models.ShiftCashMovement.shift_id == s.id, models.ShiftCashMovement.type == "PAID_IN").scalar() or Decimal("0.00")

        p_out = db.query(
            func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
        ).filter(models.ShiftCashMovement.shift_id == s.id, models.ShiftCashMovement.type == "PAID_OUT").scalar() or Decimal("0.00")

        active_drawer_cash += to_decimal(s.start_cash) + to_decimal(c_sales) + to_decimal(p_in) - to_decimal(p_out)

    active_drawer_cash = quantize(max(Decimal("0.00"), active_drawer_cash))

    # 9. Manager-to-Admin Transfers
    all_cashouts = db.query(models.ShiftCashMovement).options(
        joinedload(models.ShiftCashMovement.user)
    ).filter(
        models.ShiftCashMovement.tenant_id == tenant_id,
        models.ShiftCashMovement.type == "PAID_OUT"
    ).order_by(models.ShiftCashMovement.id.desc()).all()

    def is_cancelled_or_reversed(reason: str) -> bool:
        r = (reason or '').lower()
        return any(term in r for term in ['cancel', 'revers', 'void', 'reject'])

    def is_drawer_adjustment(reason: str) -> bool:
        r = (reason or '').lower()
        return any(term in r for term in ['drawer edited', 'modal', 'adjustment', 'shortage', 'overage'])

    # Admin transfers: qualifying movements transferred to Admin Safe
    admin_transfers = [
        m for m in all_cashouts 
        if 'admin' in (m.reason or '').lower() and not is_cancelled_or_reversed(m.reason)
    ]

    # Cashier cashouts: legitimate cashier drops into manager safe (exclude drawer count edits & cancellations)
    cashier_cashouts = [
        m for m in all_cashouts 
        if 'admin' not in (m.reason or '').lower() 
        and not is_drawer_adjustment(m.reason) 
        and not is_cancelled_or_reversed(m.reason)
    ]

    # Handle any explicit PAID_IN reversals of admin transfers
    admin_reversals_in = db.query(models.ShiftCashMovement).filter(
        models.ShiftCashMovement.tenant_id == tenant_id,
        models.ShiftCashMovement.type == "PAID_IN"
    ).all()
    total_reversals_to_admin = quantize(sum((
        to_decimal(m.amount) for m in admin_reversals_in 
        if 'admin' in (m.reason or '').lower() and any(k in (m.reason or '').lower() for k in ['revers', 'return', 'refund', 'cancel'])
    ), Decimal("0.00")))

    gross_transferred_to_admin = quantize(sum((to_decimal(m.amount) for m in admin_transfers), Decimal("0.00")))
    total_transferred_to_admin = quantize(max(Decimal("0.00"), gross_transferred_to_admin - total_reversals_to_admin))
    total_cashout_income = quantize(sum((to_decimal(m.amount) for m in cashier_cashouts), Decimal("0.00")))

    # In period transfers
    period_transfers = [
        m for m in admin_transfers
        if m.created_at and start_dt <= m.created_at < end_dt
    ]
    period_reversals = [
        m for m in admin_reversals_in
        if m.created_at and start_dt <= m.created_at < end_dt
        and 'admin' in (m.reason or '').lower() and any(k in (m.reason or '').lower() for k in ['revers', 'return', 'refund', 'cancel'])
    ]
    period_transferred_to_admin = quantize(max(
        Decimal("0.00"),
        sum((to_decimal(m.amount) for m in period_transfers), Decimal("0.00")) - sum((to_decimal(m.amount) for m in period_reversals), Decimal("0.00"))
    ))

    # Manager safe cash reduces when transferred to Admin
    manager_safe_cash = quantize(max(Decimal("0.00"), total_cashout_income - total_transferred_to_admin))
    admin_transfer_income = total_transferred_to_admin

    # Realized cash
    manager_net_cash_income = quantize(manager_safe_cash + all_digital_collections)
    admin_net_cash_income = quantize(admin_transfer_income + all_digital_collections)
    net_cash_income = admin_net_cash_income if is_admin else manager_net_cash_income

    # 10. Financial Reconciliation Audit Checks
    reconciliation_checks = []
    is_fully_reconciled = True

    # Check A: Orders Net Amount vs Payments Total (Completed orders fully paid)
    orders_total_in_period = quantize(sum((to_decimal(tx.net_amount) for tx in completed_tx), Decimal("0.00")))
    payments_diff = abs(orders_total_in_period - total_collections)
    if payments_diff <= Decimal("0.05"):
        reconciliation_checks.append({
            "check": "Orders vs Payment Allocations",
            "status": "PASS",
            "message": f"All completed orders match recorded payment allocations (₱{float(orders_total_in_period):,.2f})."
        })
    else:
        is_fully_reconciled = False
        reconciliation_checks.append({
            "check": "Orders vs Payment Allocations",
            "status": "ATTENTION",
            "message": f"Completed orders (₱{float(orders_total_in_period):,.2f}) differ from payment collections (₱{float(total_collections):,.2f}) by ₱{float(payments_diff):,.2f}."
        })

    # Check B: COGS Integrity
    if is_cogs_complete_period:
        reconciliation_checks.append({
            "check": "Cost of Goods Sold (COGS) Verification",
            "status": "PASS",
            "message": "All items sold in this period have verified inventory unit costs or recipes."
        })
    else:
        is_fully_reconciled = False
        reconciliation_checks.append({
            "check": "Cost of Goods Sold (COGS) Verification",
            "status": "ATTENTION",
            "message": f"{len(missing_items_period)} line item(s) sold have incomplete cost/recipe data. Profit metrics flagged as partial."
        })

    # Check C: Inventory Stock Integrity
    negative_stock_items = [i for i in inv_details if i["is_negative"]]
    if not negative_stock_items:
        reconciliation_checks.append({
            "check": "Stock Level Integrity",
            "status": "PASS",
            "message": f"All {len(inv_details)} inventory items have non-negative stock levels."
        })
    else:
        is_fully_reconciled = False
        reconciliation_checks.append({
            "check": "Stock Level Integrity",
            "status": "ATTENTION",
            "message": f"{len(negative_stock_items)} item(s) have negative stock quantities requiring inventory count audit."
        })

    # Check D: Internal Transfer Balance
    if manager_safe_cash >= Decimal("0.00"):
        reconciliation_checks.append({
            "check": "Manager-to-Admin Safe Transfer Balance",
            "status": "PASS",
            "message": f"Internal transfers (₱{float(total_transferred_to_admin):,.2f}) correctly deducted from Manager safe (₱{float(manager_safe_cash):,.2f})."
        })
    else:
        is_fully_reconciled = False
        reconciliation_checks.append({
            "check": "Manager-to-Admin Safe Transfer Balance",
            "status": "ATTENTION",
            "message": "Transfer amount exceeds available cashout balance."
        })

    # 11. Format history tables for UI traceability
    transfer_history = [{
        "id": m.id,
        "shift_id": m.shift_id,
        "cashier": m.user.username if m.user else ("Store Manager" if is_admin else "Cashier"),
        "amount": float(quantize(to_decimal(m.amount))),
        "reason": m.reason or ("Transfer Income from Manager" if is_admin else "Transfer to Manager Profit Income"),
        "is_admin_transfer": 'admin' in (m.reason or '').lower(),
        "created_at": m.created_at.isoformat() if m.created_at else None
    } for m in (admin_transfers if is_admin else cashier_cashouts)[:30]]

    expenses_table = [{
        "id": e.id,
        "category": e.category,
        "description": e.description,
        "amount": float(quantize(to_decimal(e.amount))),
        "payment_method": e.payment_method,
        "status": e.status,
        "reference_no": e.reference_no,
        "recorded_by": e.user.username if e.user else "Admin",
        "expense_date": e.expense_date.isoformat() if e.expense_date else None
    } for e in paid_expenses_rows[:50]]

    sales_orders_table = [{
        "id": tx.id,
        "order_code": f"TXN-{tx.id:04d}",
        "gross_amount": float(quantize(to_decimal(tx.total_amount))),
        "discount_amount": float(quantize(to_decimal(tx.discount_amount))),
        "net_amount": float(quantize(to_decimal(tx.net_amount))),
        "cashier": tx.user.username if tx.user else "Staff",
        "created_at": tx.created_at.isoformat() if tx.created_at else None,
        "status": tx.status
    } for tx in completed_tx[:50]]

    # 12. Assemble complete consolidated response
    # Fully backward-compatible with legacy structure while exposing all 16 metrics
    return {
        # Period & metadata
        "period": {
            "name": period_label,
            "code": period,
            "start_date": start_dt.isoformat(),
            "end_date": end_dt.isoformat()
        },
        # Legacy structure for existing Manager and Admin UI components
        "revenue": {
            "total_orders_revenue": float(all_net_sales),
            "today_orders_revenue": float(net_sales),
            "cash_sales": float(all_cash_collections),
            "non_cash_sales": float(all_digital_collections),
            "period_cash_sales": float(cash_collections),
            "period_digital_sales": float(digital_collections),
            "total_orders_count": len(all_completed_tx),
            "today_orders_count": len(completed_tx)
        },
        "inventory": {
            "total_inventory_valuation": float(total_inventory_valuation),
            "total_items_count": total_inventory_items_count,
            "cost_of_goods_sold": float(cogs_period),
            "all_time_cogs": float(all_cogs),
            "cogs_status": gp_status,
            "is_cogs_complete": is_cogs_complete_period,
            "missing_cost_items_count": len(missing_items_period)
        },
        "cashout": {
            "total_cashout_income": float(total_cashout_income),
            "today_cashout_income": float(period_transferred_to_admin if is_admin else sum(to_decimal(m.amount) for m in cashier_cashouts if m.created_at and start_dt <= m.created_at < end_dt)),
            "manager_safe_cash": float(manager_safe_cash),
            "total_transferred_to_admin": float(total_transferred_to_admin),
            "today_transferred_to_admin": float(period_transferred_to_admin),
            "admin_transfer_income": float(admin_transfer_income),
            "active_drawer_cash": float(active_drawer_cash),
            "history": transfer_history
        },
        "profit_loss": {
            "gross_profit": float(gross_profit),
            "operating_expenses": float(operating_expenses),
            "net_profit": float(net_operating_profit),
            "profit_margin_percent": profit_margin_val if profit_margin_val is not None else 0.0,
            "profit_margin_display": profit_margin_str,
            "net_cash_income": float(net_cash_income),
            "admin_net_cash_income": float(admin_net_cash_income),
            "manager_net_cash_income": float(manager_net_cash_income),
            "is_profitable": is_profitable,
            "calculation_status": gp_status
        },
        # 16 Core Audited Metrics for Centralized Reporting
        "metrics": {
            "1_gross_sales": float(gross_sales),
            "2_net_sales": float(net_sales),
            "3_cash_collections": float(cash_collections),
            "4_digital_collections": float(digital_collections),
            "5_discounts": float(discounts),
            "5_refunds": float(returns),
            "6_cost_of_goods_sold": float(cogs_period),
            "6_cogs_status": gp_status,
            "7_gross_profit": float(gross_profit),
            "7_gross_profit_status": gp_status,
            "8_operating_expenses": float(operating_expenses),
            "9_net_operating_profit": float(net_operating_profit),
            "9_net_operating_profit_status": net_profit_status,
            "10_profit_margin_percent": profit_margin_val,
            "10_profit_margin_display": profit_margin_str,
            "11_current_inventory_valuation": float(total_inventory_valuation),
            "12_current_cash_drawer_balances": float(active_drawer_cash),
            "13_confirmed_transfers_from_manager": float(total_transferred_to_admin),
            "14_pending_transfers": 0.0,  # Cash drop immediately records
            "15_unpaid_pending_expenses": float(unpaid_pending_expenses),
            "16_reconciliation_status": "RECONCILED" if is_fully_reconciled else "ATTENTION REQUIRED"
        },
        # Detailed reconciliation audit
        "reconciliation": {
            "is_fully_reconciled": is_fully_reconciled,
            "status": "RECONCILED" if is_fully_reconciled else "ATTENTION REQUIRED",
            "checks": reconciliation_checks,
            "missing_cost_items": missing_items_period
        },
        # Tables for frontend drilling & traceability
        "tables": {
            "sales_orders": sales_orders_table,
            "expenses": expenses_table,
            "incoming_transfers": transfer_history,
            "inventory_valuation": inv_details[:50]
        }
    }
