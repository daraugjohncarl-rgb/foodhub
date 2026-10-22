"""
Comprehensive API Integration Tests for Financial Calculations and Role Separation
==================================================================================
Tests:
1. Authentication & token retrieval for Admin, Manager, Cashier, Inventory, Kitchen.
2. Strict RBAC enforcement:
   - Cashier, Kitchen, Inventory -> 403 Forbidden on /api/v1/analytics/profit-loss
   - Cashier, Kitchen, Inventory -> 403 Forbidden on /api/v1/analytics/reconciliation
   - Cashier, Kitchen, Inventory -> 403 Forbidden on /api/v1/expenses
3. Admin financial reporting:
   - Returns all 16 metrics
   - Date filters: today, yesterday, this_week, this_month, this_year, all
   - Reconciliation audit checks
4. Manager financial reporting:
   - Returns preserved keys (revenue, inventory, cashout, profit_loss)
   - Proper safe balance and transfer values
5. Operating Expenses lifecycle:
   - Admin creates an expense -> 201 Created
   - Expense reflects in operating expenses of /api/v1/analytics/profit-loss
   - Clean up test expense -> 204 No Content
"""

import unittest
from fastapi.testclient import TestClient
from decimal import Decimal
from datetime import datetime

from app.main import app
from app.db import SessionLocal
import app.models as models


class TestFinancialAPIIntegration(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

        # Login helper
        def get_token(username, password):
            res = cls.client.post("/api/v1/auth/login", data={"username": username, "password": password})
            if res.status_code == 200:
                return res.json()["access_token"]
            return None

        cls.admin_token = get_token("admin", "admin123")
        cls.manager_token = get_token("manager", "manager123")
        cls.cashier_token = get_token("cashier", "cashier123")
        cls.inventory_token = get_token("inventory", "inventory123")
        cls.kitchen_token = get_token("kitchen", "kitchen123")

    def test_01_rbac_rejections(self):
        """Cashier, Kitchen, and Inventory must receive 403 Forbidden on financial endpoints."""
        endpoints = [
            "/api/v1/analytics/profit-loss",
            "/api/v1/analytics/reconciliation",
            "/api/v1/expenses"
        ]
        unauthorized_tokens = [
            ("Cashier", self.cashier_token),
            ("Kitchen", self.kitchen_token),
            ("Inventory", self.inventory_token)
        ]

        for role_name, token in unauthorized_tokens:
            if not token:
                continue
            headers = {"Authorization": f"Bearer {token}"}
            for ep in endpoints:
                res = self.client.get(ep, headers=headers)
                self.assertEqual(
                    res.status_code, 403,
                    f"Expected 403 Forbidden for {role_name} on {ep}, got {res.status_code}"
                )

    def test_02_admin_access_and_16_metrics(self):
        """Admin must receive 200 OK and all 16 required financial metrics."""
        self.assertIsNotNone(self.admin_token)
        headers = {"Authorization": f"Bearer {self.admin_token}"}
        res = self.client.get("/api/v1/analytics/profit-loss?period=today", headers=headers)
        self.assertEqual(res.status_code, 200)

        data = res.json()
        self.assertIn("metrics", data)
        self.assertIn("reconciliation", data)
        self.assertIn("tables", data)
        self.assertIn("period", data)

        metrics = data["metrics"]
        required_metric_keys = [
            "1_gross_sales",
            "2_net_sales",
            "3_cash_collections",
            "4_digital_collections",
            "5_discounts",
            "5_refunds",
            "6_cost_of_goods_sold",
            "6_cogs_status",
            "7_gross_profit",
            "7_gross_profit_status",
            "8_operating_expenses",
            "9_net_operating_profit",
            "9_net_operating_profit_status",
            "10_profit_margin_percent",
            "10_profit_margin_display",
            "11_current_inventory_valuation",
            "12_current_cash_drawer_balances",
            "13_confirmed_transfers_from_manager",
            "14_pending_transfers",
            "15_unpaid_pending_expenses",
            "16_reconciliation_status"
        ]

        for k in required_metric_keys:
            self.assertIn(k, metrics, f"Missing metric key: {k}")

    def test_03_admin_date_filters(self):
        """Admin date filters must return 200 OK for all standard periods."""
        headers = {"Authorization": f"Bearer {self.admin_token}"}
        periods = ["today", "yesterday", "this_week", "this_month", "this_year", "all"]

        for p in periods:
            res = self.client.get(f"/api/v1/analytics/profit-loss?period={p}", headers=headers)
            self.assertEqual(res.status_code, 200, f"Period {p} failed")
            self.assertIn("period", res.json())
            self.assertIn("start_date", res.json()["period"])
            self.assertIn("end_date", res.json()["period"])

    def test_04_manager_preserved_dashboard(self):
        """Manager must receive 200 OK with preserved keys (revenue, inventory, cashout, profit_loss)."""
        self.assertIsNotNone(self.manager_token)
        headers = {"Authorization": f"Bearer {self.manager_token}"}
        res = self.client.get("/api/v1/analytics/profit-loss", headers=headers)
        self.assertEqual(res.status_code, 200)

        data = res.json()
        self.assertIn("revenue", data)
        self.assertIn("inventory", data)
        self.assertIn("cashout", data)
        self.assertIn("profit_loss", data)

        # Manager specific fields
        csh = data["cashout"]
        self.assertIn("manager_safe_cash", csh)
        self.assertIn("total_transferred_to_admin", csh)
        self.assertIn("active_drawer_cash", csh)

    def test_05_operating_expense_lifecycle(self):
        """Admin can record, list, view impact in profit-loss, and delete an expense."""
        headers = {"Authorization": f"Bearer {self.admin_token}"}

        # Baseline
        initial_pl = self.client.get("/api/v1/analytics/profit-loss?period=today", headers=headers).json()
        initial_expenses = initial_pl["profit_loss"]["operating_expenses"]

        # Create expense
        payload = {
            "category": "Salaries",
            "description": "Weekly Kitchen Crew Wages",
            "amount": 3500.0,
            "payment_method": "Cash",
            "status": "paid"
        }
        create_res = self.client.post("/api/v1/expenses", json=payload, headers=headers)
        self.assertEqual(create_res.status_code, 201)
        exp_id = create_res.json()["id"]

        try:
            # Check impact in P&L
            new_pl = self.client.get("/api/v1/analytics/profit-loss?period=today", headers=headers).json()
            new_expenses = new_pl["profit_loss"]["operating_expenses"]
            self.assertEqual(round(new_expenses - initial_expenses, 2), 3500.0)

            # Check list
            list_res = self.client.get("/api/v1/expenses", headers=headers)
            self.assertEqual(list_res.status_code, 200)
            exp_ids = [e["id"] for e in list_res.json()]
            self.assertIn(exp_id, exp_ids)
        finally:
            # Cleanup
            del_res = self.client.delete(f"/api/v1/expenses/{exp_id}", headers=headers)
            self.assertEqual(del_res.status_code, 204)

    def test_06_admin_reconciliation_audit(self):
        """Admin reconciliation endpoint returns audit checks."""
        headers = {"Authorization": f"Bearer {self.admin_token}"}
        res = self.client.get("/api/v1/analytics/reconciliation", headers=headers)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("checks", data)
        self.assertIn("is_fully_reconciled", data)


if __name__ == "__main__":
    unittest.main()
