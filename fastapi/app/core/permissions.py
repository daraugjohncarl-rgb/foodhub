"""
Single source of truth for who may do what (H11).

Every router uses `require_permission("<name>")` (or one of the aliases in app.core.dependencies) instead of ad-hoc
role checks. Tenant isolation is enforced separately by `get_tenant_scope`, so a permission never implies access to
another branch's data.

SUPER_ADMIN is the platform owner: it holds every permission and may act on any tenant by passing ?tenant_id=.
"""
from typing import Dict, FrozenSet

from app.models import UserRole

R = UserRole

ALL_ROLES: FrozenSet[UserRole] = frozenset(UserRole)
ADMINS = frozenset({R.SUPER_ADMIN, R.ADMIN})
MANAGEMENT = frozenset({R.SUPER_ADMIN, R.ADMIN, R.MANAGER})
POS_ROLES = frozenset({R.SUPER_ADMIN, R.ADMIN, R.MANAGER, R.CASHIER})
KITCHEN_ROLES = frozenset({R.SUPER_ADMIN, R.ADMIN, R.MANAGER, R.CASHIER, R.KITCHEN})
INVENTORY_ROLES = frozenset({R.SUPER_ADMIN, R.ADMIN, R.MANAGER, R.INVENTORY})

PERMISSIONS: Dict[str, FrozenSet[UserRole]] = {
    # Staff accounts
    "users.read": MANAGEMENT,              # managers may view their branch's staff (read-only)
    "users.write": ADMINS,                 # create / edit / reset password / (de)activate / delete
    # Sales
    "sales.create": POS_ROLES,
    "sales.read_all": MANAGEMENT,          # every cashier's sales in the branch
    "sales.read_own": POS_ROLES,           # cashiers see only their own sales
    "sales.discount": MANAGEMENT,          # applying a discount needs a manager or admin
    "shifts.own": POS_ROLES,
    # Kitchen display
    "kitchen.read": KITCHEN_ROLES,
    "kitchen.update": KITCHEN_ROLES,
    # Customer QR orders (staff side)
    "customer_orders.manage": POS_ROLES,
    # Catalogue
    "catalog.read": ALL_ROLES,
    "catalog.write": ADMINS,
    "recipes.write": ADMINS | {R.MANAGER},
    # Inventory, suppliers, purchasing, wastage
    "inventory.read": INVENTORY_ROLES | {R.KITCHEN},
    "inventory.write": INVENTORY_ROLES,
    "purchasing": INVENTORY_ROLES,
    # Tables / QR codes
    "tables.read": POS_ROLES,
    "tables.write": MANAGEMENT,
    # Reporting
    "analytics.read": MANAGEMENT,
    "audit.read": MANAGEMENT,
    "audit.purge": frozenset({R.SUPER_ADMIN}),
    "diagnostics.read": frozenset({R.SUPER_ADMIN}),
    "incidents.submit": ALL_ROLES - {R.SUPER_ADMIN},
    "incidents.manage": frozenset({R.SUPER_ADMIN}),
}


def has_permission(role: UserRole, permission: str) -> bool:
    if permission not in PERMISSIONS:
        raise KeyError(f"Unknown permission '{permission}'")
    return role in PERMISSIONS[permission]
