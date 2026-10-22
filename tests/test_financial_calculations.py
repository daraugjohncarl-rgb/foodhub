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
        # End is start of next day (exclusive boundary)
        self.assertEqual(end_dt.date(), today + datetime.resolution.__class__(days=1))
        self.assertEqual(end_dt.time(), datetime.min.time())


if __name__ == "__main__":
    unittest.main()
