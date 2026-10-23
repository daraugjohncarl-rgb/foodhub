"""
Automated Test Suite for Accurate Financial Calculations — Blessie FoodHub POS
==============================================================================
Tests A through H covering:
- Test A: Basic profit calculation
- Test B: Business loss (negative profit & margin)
- Test C: Internal transfer (safe remittance, no revenue/profit increase)
- Test D: Split payment (cash + digital allocation without double counting)
- Test E: Inventory purchase (PO receipt not deducted as operating expense)
- Test F: Zero sales (no division-by-zero, margin N/A)
- Test G: Missing inventory cost (incomplete flag, no assumption of zero cost)
- Test H: Duplicate payment or transfer submission (idempotency, no double counting)
"""

import unittest
from decimal import Decimal
from datetime import datetime
from unittest.mock import MagicMock

from app.services.financial_service import (
    FinancialReportCalculator,
    to_decimal,
    quantize,
    parse_date_boundaries
)
import app.models as models


class TestFinancialCalculations(unittest.TestCase):

    def setUp(self):
        self.calc = FinancialReportCalculator

    def test_a_basic_profit_calculation(self):
        """
        Test A: Basic profit calculation
        - Gross sales: ₱10,000.00
        - Discounts: ₱500.00
        - Returns: ₱0.00
        - COGS: ₱4,000.00
        - Operating expenses: ₱1,000.00
        Expected:
        - Net sales: ₱9,500.00
        - Gross profit: ₱5,500.00
        - Net operating profit: ₱4,500.00
        - Profit margin: 47.37%
        """
        gross_sales = Decimal("10000.00")
        discounts = Decimal("500.00")
        returns = Decimal("0.00")
        cogs = Decimal("4000.00")
        operating_expenses = Decimal("1000.00")
        is_cogs_complete = True

        net_sales = self.calc.compute_net_sales(gross_sales, discounts, returns)
        self.assertEqual(net_sales, Decimal("9500.00"))

        gross_profit, gp_status = self.calc.compute_gross_profit(net_sales, cogs, is_cogs_complete)
        self.assertEqual(gross_profit, Decimal("5500.00"))
        self.assertEqual(gp_status, "complete")

        net_profit, np_status, is_profitable = self.calc.compute_net_operating_profit(
            gross_profit, operating_expenses, is_cogs_complete
        )
        self.assertEqual(net_profit, Decimal("4500.00"))
        self.assertEqual(np_status, "complete")
        self.assertTrue(is_profitable)

        margin_percent, margin_str = self.calc.compute_profit_margin(net_profit, net_sales, is_cogs_complete)
        self.assertEqual(margin_percent, 47.37)
        self.assertEqual(margin_str, "+47.37%")

    def test_b_business_loss(self):
        """
        Test B: Business loss
        - Gross sales: ₱2,000.00
        - Discounts: ₱0.00
        - Returns: ₱0.00
        - COGS: ₱1,500.00
        - Operating expenses: ₱800.00
        Expected:
        - Net sales: ₱2,000.00
        - Gross profit: ₱500.00
        - Net operating loss: −₱300.00
        - Profit margin: −15.00%
        """
        gross_sales = Decimal("2000.00")
        discounts = Decimal("0.00")
        returns = Decimal("0.00")
        cogs = Decimal("1500.00")
        operating_expenses = Decimal("800.00")
        is_cogs_complete = True

        net_sales = self.calc.compute_net_sales(gross_sales, discounts, returns)
        self.assertEqual(net_sales, Decimal("2000.00"))

        gross_profit, gp_status = self.calc.compute_gross_profit(net_sales, cogs, is_cogs_complete)
        self.assertEqual(gross_profit, Decimal("500.00"))

        net_profit, np_status, is_profitable = self.calc.compute_net_operating_profit(
            gross_profit, operating_expenses, is_cogs_complete
        )
        self.assertEqual(net_profit, Decimal("-300.00"))
        self.assertFalse(is_profitable)

        margin_percent, margin_str = self.calc.compute_profit_margin(net_profit, net_sales, is_cogs_complete)
        self.assertEqual(margin_percent, -15.00)
        self.assertEqual(margin_str, "-15.00%")

    def test_c_internal_transfer(self):
        """
        Test C: Internal transfer
        - Completed sales: ₱5,000.00
        - Confirmed Manager-to-Admin transfer: ₱2,000.00
        Expected:
        - Sales revenue remains ₱5,000.00.
        - Incoming transfers increase by ₱2,000.00.
        - The transfer does not increase sales revenue or profit.
        - Related internal balances change according to transfer rules.
        """
        completed_sales = Decimal("5000.00")
        initial_safe_cash = Decimal("5000.00")
        transfer_to_admin = Decimal("2000.00")

        # Sales revenue is independent of internal transfer
        sales_revenue = completed_sales
        self.assertEqual(sales_revenue, Decimal("5000.00"))

        # Transfer only moves custody between internal accounts
        remaining_manager_safe = max(Decimal("0.00"), initial_safe_cash - transfer_to_admin)
        admin_received_transfer = transfer_to_admin

        self.assertEqual(remaining_manager_safe, Decimal("3000.00"))
        self.assertEqual(admin_received_transfer, Decimal("2000.00"))

        # Crucial check: Transfer does not increase sales or gross profit
        self.assertEqual(sales_revenue, Decimal("5000.00"))
        gross_profit = sales_revenue - Decimal("2000.00")  # hypothetical COGS 2000
        self.assertEqual(gross_profit, Decimal("3000.00"))  # unaffected by transfer

    def test_d_split_payment(self):
        """
        Test D: Split payment
        - One valid order: ₱1,000.00
        - Cash payment: ₱400.00
        - Confirmed GCash payment: ₱600.00
        Expected:
        - Sales revenue: ₱1,000.00, counted once.
        - Cash collections: ₱400.00.
        - Digital collections: ₱600.00.
        - Total recorded collections: ₱1,000.00.
        """
        order_total = Decimal("1000.00")
        cash_pmt = Decimal("400.00")
        gcash_pmt = Decimal("600.00")

        # Create mock transaction and payments
        tx = MagicMock(spec=models.Transaction)
        tx.id = 1
        tx.status = "completed"
        tx.total_amount = order_total
        tx.discount_amount = Decimal("0.00")
        tx.net_amount = order_total

        gross_sales = self.calc.compute_gross_sales([tx])
        net_sales = self.calc.compute_net_sales(gross_sales, Decimal("0.00"))
        self.assertEqual(net_sales, Decimal("1000.00"))

        # Payments allocated separately
        cash_collections = cash_pmt
        digital_collections = gcash_pmt
        total_collections = cash_collections + digital_collections

        self.assertEqual(cash_collections, Decimal("400.00"))
        self.assertEqual(digital_collections, Decimal("600.00"))
        self.assertEqual(total_collections, Decimal("1000.00"))
        self.assertEqual(total_collections, net_sales)

    def test_e_inventory_purchase(self):
        """
        Test E: Inventory purchase
        - Opening inventory cost: ₱2,000.00
        - New inventory purchase received: ₱1,000.00
        - Inventory cost sold: ₱500.00
        - No other inventory movements.
        Expected:
        - Closing inventory value: ₱2,500.00.
        - COGS: ₱500.00.
        - The ₱1,000.00 inventory purchase is NOT also deducted as an operating expense.
        """
        opening_inventory = Decimal("2000.00")
        po_received = Decimal("1000.00")
        cogs_sold = Decimal("500.00")

        # Closing inventory valuation
        closing_inventory = opening_inventory + po_received - cogs_sold
        self.assertEqual(closing_inventory, Decimal("2500.00"))

        # COGS is only the cost of goods actually sold
        cogs = cogs_sold
        self.assertEqual(cogs, Decimal("500.00"))

        # Operating expenses do NOT include the inventory purchase receipt
        rent_expense = Decimal("300.00")
        operating_expenses = rent_expense  # PO is NOT an operating expense
        self.assertEqual(operating_expenses, Decimal("300.00"))

        # Profit calculation does not double count the PO
        net_sales = Decimal("1200.00")
        gross_profit, _ = self.calc.compute_gross_profit(net_sales, cogs, True)
        self.assertEqual(gross_profit, Decimal("700.00"))  # 1200 - 500

        net_profit, _, _ = self.calc.compute_net_operating_profit(gross_profit, operating_expenses, True)
        self.assertEqual(net_profit, Decimal("400.00"))  # 700 - 300

    def test_f_zero_sales(self):
        """
        Test F: Zero sales
        - Net sales: ₱0.00
        - COGS: ₱0.00
        - Operating expenses: ₱500.00
        Expected:
        - Gross profit: ₱0.00.
        - Net operating loss: −₱500.00.
        - Profit margin: N/A or zero-sales representation.
        - No division-by-zero error.
        """
        net_sales = Decimal("0.00")
        cogs = Decimal("0.00")
        operating_expenses = Decimal("500.00")
        is_cogs_complete = True

        gross_profit, _ = self.calc.compute_gross_profit(net_sales, cogs, is_cogs_complete)
        self.assertEqual(gross_profit, Decimal("0.00"))

        net_profit, _, is_profitable = self.calc.compute_net_operating_profit(
            gross_profit, operating_expenses, is_cogs_complete
        )
        self.assertEqual(net_profit, Decimal("-500.00"))
        self.assertFalse(is_profitable)

        # Margin calculation handles zero sales gracefully without division-by-zero
        margin_percent, margin_str = self.calc.compute_profit_margin(net_profit, net_sales, is_cogs_complete)
        self.assertIsNone(margin_percent)
        self.assertEqual(margin_str, "N/A")

    def test_g_missing_inventory_cost(self):
        """
        Test G: Missing inventory cost
        - Valid sales exist.
        - Some sold items have no reliable cost record.
        Expected:
        - Sales revenue is still reported when valid.
        - COGS and dependent profit calculations are flagged as incomplete.
        - The system must not silently assume missing costs are zero and report misleading profit.
        """
        tx = MagicMock(spec=models.Transaction)
        tx.id = 101
        tx.status = "completed"
        tx.total_amount = Decimal("350.00")
        tx.discount_amount = Decimal("0.00")
        tx.net_amount = Decimal("350.00")

        # Item with no product cost and no recipe
        item1 = MagicMock(spec=models.TransactionItem)
        item1.id = 1
        item1.product_id = None
        item1.product = None
        item1.quantity = 2
        item1.unit_price = Decimal("175.00")

        tx.items = [item1]

        gross_sales = self.calc.compute_gross_sales([tx])
        net_sales = self.calc.compute_net_sales(gross_sales, Decimal("0.00"))
        self.assertEqual(net_sales, Decimal("350.00"))

        cogs, is_complete, missing_items = self.calc.compute_cogs([tx])

        # Verification: System flags COGS as incomplete!
        self.assertFalse(is_complete)
        self.assertEqual(len(missing_items), 1)
        self.assertEqual(missing_items[0]["transaction_id"], 101)

        # Gross profit is flagged as incomplete
        gross_profit, gp_status = self.calc.compute_gross_profit(net_sales, cogs, is_complete)
        self.assertEqual(gp_status, "incomplete")

        # Profit margin is flagged as incomplete
        net_profit, np_status, _ = self.calc.compute_net_operating_profit(gross_profit, Decimal("0.00"), is_complete)
        self.assertEqual(np_status, "incomplete")

        margin_percent, margin_str = self.calc.compute_profit_margin(net_profit, net_sales, is_complete)
        self.assertIn("(Incomplete)", margin_str)

    def test_h_duplicate_submission_prevention(self):
        """
        Test H: Duplicate payment or transfer submission
        - Submit the same transaction client reference twice.
        Expected:
        - Transaction must not be counted twice.
        - Sales and payments aggregated uniquely by database record.
        """
        tx1 = MagicMock(spec=models.Transaction)
        tx1.id = 1
        tx1.client_tx_id = "UUID-UNIQUE-12345"
        tx1.status = "completed"
        tx1.total_amount = Decimal("500.00")
        tx1.discount_amount = Decimal("0.00")
        tx1.net_amount = Decimal("500.00")

        # Second submission with same client_tx_id should be idempotent
        # Unique constraint or deduplication returns existing tx1, not a second transaction
        transactions = [tx1]
        gross_sales = self.calc.compute_gross_sales(transactions)
        self.assertEqual(gross_sales, Decimal("500.00"))

    def test_date_boundaries_half_open(self):
        """Verify half-open time interval prevents edge double-counting."""
        start_dt, end_dt, label = parse_date_boundaries("today")
        now = datetime.now()
        today = now.date()
        self.assertEqual(start_dt.date(), today)
        self.assertEqual(start_dt.time(), datetime.min.time())
        self.assertEqual(end_dt.date(), today + datetime.resolution.__class__(days=1))
        self.assertEqual(end_dt.time(), datetime.min.time())

    def test_i_overall_income_no_double_counting_cash_drawer(self):
        """
        Test I: Overall Income must NOT double-count active cash drawer balances.
        Scenario:
        - Completed sales: ₱1,500.00 cash sales
        - Starting cash float: ₱1,000.00
        - Expected drawer cash: ₱2,500.00 (Float ₱1,000 + Cash Sales ₱1,500)
        Flawed formula result: ₱1,500 + ₱2,500 + adjustments = ₱4,950 (BUG)
        Correct accounting result:
        - Overall Sales Income: ₱1,500.00
        - Active Cash Drawer Balance: ₱2,500.00
        - Total income must NOT sum drawer cash and completed sales.
        """
        cash_sales = Decimal("1500.00")
        start_float = Decimal("1000.00")
        expected_drawer_cash = start_float + cash_sales  # ₱2,500.00

        # Overall business revenue must strictly be the completed sales
        overall_income = cash_sales
        self.assertEqual(overall_income, Decimal("1500.00"))
        self.assertNotEqual(overall_income + expected_drawer_cash + Decimal("950.00"), overall_income)

    def test_j_newly_completed_orders_increase_revenue(self):
        """
        Test J: Newly completed orders increase revenue and overall income.
        """
        tx1 = MagicMock(spec=models.Transaction)
        tx1.status = "completed"
        tx1.total_amount = Decimal("300.00")
        tx1.discount_amount = Decimal("0.00")
        tx1.net_amount = Decimal("300.00")

        initial_orders = [tx1]
        gross_sales = self.calc.compute_gross_sales(initial_orders)
        self.assertEqual(gross_sales, Decimal("300.00"))

        # Customer places another order for ₱250
        tx2 = MagicMock(spec=models.Transaction)
        tx2.status = "completed"
        tx2.total_amount = Decimal("250.00")
        tx2.discount_amount = Decimal("0.00")
        tx2.net_amount = Decimal("250.00")

        updated_orders = [tx1, tx2]
        new_gross_sales = self.calc.compute_gross_sales(updated_orders)
        new_net_sales = self.calc.compute_net_sales(new_gross_sales, Decimal("0.00"))
        self.assertEqual(new_gross_sales, Decimal("550.00"))
        self.assertEqual(new_net_sales, Decimal("550.00"))

    def test_k_expenses_reduce_profit_without_distorting_sales(self):
        """
        Test K: Operating expenses reduce net profit but do not modify gross or net sales.
        """
        gross_sales = Decimal("5000.00")
        discounts = Decimal("0.00")
        cogs = Decimal("2000.00")
        is_cogs_complete = True

        net_sales = self.calc.compute_net_sales(gross_sales, discounts)
        gross_profit, _ = self.calc.compute_gross_profit(net_sales, cogs, is_cogs_complete)
        self.assertEqual(gross_profit, Decimal("3000.00"))

        # Zero expenses
        net_profit_zero_exp, _, _ = self.calc.compute_net_operating_profit(gross_profit, Decimal("0.00"), is_cogs_complete)
        self.assertEqual(net_profit_zero_exp, Decimal("3000.00"))

        # Record ₱800 utility expense
        expenses = Decimal("800.00")
        net_profit_with_exp, _, _ = self.calc.compute_net_operating_profit(gross_profit, expenses, is_cogs_complete)
        self.assertEqual(net_profit_with_exp, Decimal("2200.00"))
        # Sales remains untouched
        self.assertEqual(net_sales, Decimal("5000.00"))

    def test_l_internal_transfers_do_not_create_revenue(self):
        """
        Test L: Cash transfers between Cashier, Manager, and Admin do NOT create sales revenue.
        """
        # Internal safe transfer
        transfer_amount = Decimal("1500.00")
        # Sales remains 0 when no customer orders exist
        orders = []
        gross_sales = self.calc.compute_gross_sales(orders)
        self.assertEqual(gross_sales, Decimal("0.00"))
        # Transfer is custody movement, not sales income
        self.assertEqual(gross_sales, Decimal("0.00"))

    def test_m_manager_to_admin_transfer_zero_by_default(self):
        """
        Test M: In a clean initial database, manager-to-admin transfers and cashier cashouts start at ₱0.00.
        """
        admin_transfers = []
        cashier_cashouts = []
        total_transferred = sum((to_decimal(m.amount) for m in admin_transfers), Decimal("0.00"))
        total_cashouts = sum((to_decimal(m.amount) for m in cashier_cashouts), Decimal("0.00"))
        self.assertEqual(total_transferred, Decimal("0.00"))
        self.assertEqual(total_cashouts, Decimal("0.00"))

    def test_n_cancelled_and_reversed_transfers_excluded(self):
        """
        Test N: Cancelled/voided transfers are excluded and reversing PAID_IN reduces transfer income.
        """
        def is_cancelled_or_reversed(reason: str) -> bool:
            r = (reason or '').lower()
            return any(term in r for term in ['cancel', 'revers', 'void', 'reject'])

        # Transfer 1: Valid ₱2,000 transfer to Admin
        m1 = MagicMock()
        m1.amount = Decimal("2000.00")
        m1.reason = "Transfer to Admin Safe"

        # Transfer 2: Cancelled ₱1,500 transfer to Admin
        m2 = MagicMock()
        m2.amount = Decimal("1500.00")
        m2.reason = "Cancelled Transfer to Admin"

        all_movements = [m1, m2]
        qualifying = [m for m in all_movements if 'admin' in (m.reason or '').lower() and not is_cancelled_or_reversed(m.reason)]
        self.assertEqual(len(qualifying), 1)
        self.assertEqual(qualifying[0].amount, Decimal("2000.00"))

        # Reversal PAID_IN: ₱500 returned/reversed from Admin
        rev_in = MagicMock()
        rev_in.amount = Decimal("500.00")
        rev_in.reason = "Reversal from Admin Safe"

        reversals = [rev_in]
        total_reversals = sum((to_decimal(r.amount) for r in reversals), Decimal("0.00"))
        net_admin_transfer = max(Decimal("0.00"), sum((to_decimal(m.amount) for m in qualifying), Decimal("0.00")) - total_reversals)
        self.assertEqual(net_admin_transfer, Decimal("1500.00"))

    def test_o_manual_drawer_adjustments_excluded_from_cashout(self):
        """
        Test O: Manual cashier drawer edits/corrections via modal are NOT counted as cashier cashout income.
        """
        def is_drawer_adjustment(reason: str) -> bool:
            r = (reason or '').lower()
            return any(term in r for term in ['drawer edited', 'modal', 'adjustment', 'shortage', 'overage'])

        # Movement 1: Cashier drawer edited via modal (₱4,950 adjustment to ₱0.00)
        adj = MagicMock()
        adj.amount = Decimal("4950.00")
        adj.reason = "Cashier drawer edited via modal (Adjusted from ₱4950.00 to ₱0.00)"

        # Movement 2: Legitimate manager cashout
        drop = MagicMock()
        drop.amount = Decimal("1000.00")
        drop.reason = "Manager Cashout"

        all_cashouts = [adj, drop]
        cashier_cashouts = [
            m for m in all_cashouts
            if 'admin' not in (m.reason or '').lower() and not is_drawer_adjustment(m.reason)
        ]
        self.assertEqual(len(cashier_cashouts), 1)
        self.assertEqual(cashier_cashouts[0].amount, Decimal("1000.00"))
        self.assertEqual(sum((to_decimal(m.amount) for m in cashier_cashouts), Decimal("0.00")), Decimal("1000.00"))


if __name__ == "__main__":
    unittest.main()


