import enum
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey, Numeric, UniqueConstraint, CheckConstraint, Index, func,
    BigInteger, Enum, Text,
)
from sqlalchemy.orm import relationship
from app.db import Base

# Every timestamp is timezone-aware and stored in UTC (see app/core/timeutils.py).
TimestampTZ = DateTime(timezone=True)


class UserRole(str, enum.Enum):
    SUPER_ADMIN = "SUPER_ADMIN"
    ADMIN = "ADMIN"
    MANAGER = "MANAGER"
    CASHIER = "CASHIER"
    INVENTORY = "INVENTORY"
    KITCHEN = "KITCHEN"


class ReportCategory(str, enum.Enum):
    BUG = "BUG"
    HARDWARE = "HARDWARE"
    INVENTORY_DISCREPANCY = "INVENTORY_DISCREPANCY"
    PAYMENT_ISSUE = "PAYMENT_ISSUE"
    OTHER = "OTHER"


class ReportPriority(str, enum.Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class ReportStatus(str, enum.Enum):
    OPEN = "OPEN"
    IN_PROGRESS = "IN_PROGRESS"
    RESOLVED = "RESOLVED"
    REJECTED = "REJECTED"


class PurchaseOrderStatus(str, enum.Enum):
    DRAFT = "Draft"
    PENDING = "Pending"
    ORDERED = "Ordered"
    PARTIALLY_RECEIVED = "Partially Received"
    RECEIVED = "Received"
    CANCELLED = "Cancelled"


class TransactionStatus(str, enum.Enum):
    """Payment state of a sale. Revenue = every sale that is not VOIDED."""
    COMPLETED = "completed"   # paid in full
    VOIDED = "voided"


# Legacy rows written before the payment/fulfilment split carry kitchen states in Transaction.status. They were all
# paid at creation (the old endpoint always wrote a completed Payment), so they count as revenue too.
NON_REVENUE_TRANSACTION_STATUSES = ("voided", "cancelled", "refunded")


class FulfillmentStatus(str, enum.Enum):
    """Kitchen / service state of a sale, independent of payment."""
    PENDING = "pending"
    PREPARING = "preparing"
    READY = "ready"
    COMPLETED = "completed"   # served / picked up
    CANCELLED = "cancelled"


class CustomerOrderStatus(str, enum.Enum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    COMPLETED = "completed"


class StockMovementType(str, enum.Enum):
    OPENING = "OPENING"
    RECEIPT = "RECEIPT"
    SALE = "SALE"
    ADJUSTMENT = "ADJUSTMENT"
    WASTAGE = "WASTAGE"
    REVERSAL = "REVERSAL"


class InventoryItemType(str, enum.Enum):
    CONSUMABLE = "consumable"
    EQUIPMENT = "equipment"


class Tenant(Base):
    __tablename__ = "tenants"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    name = Column(String(100), unique=True, index=True, nullable=False)
    subdomain_or_code = Column(String(100), unique=True, index=True, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)

    # No ORM delete cascades: deleting a tenant must never silently wipe its sales, shifts or audit history.
    # passive_deletes="all" leaves child rows to the database foreign keys.
    users = relationship("User", back_populates="tenant", passive_deletes="all")
    categories = relationship("Category", back_populates="tenant", passive_deletes="all")
    products = relationship("Product", back_populates="tenant", passive_deletes="all")
    inventory_items = relationship("InventoryItem", back_populates="tenant", passive_deletes="all")
    shifts = relationship("Shift", back_populates="tenant", passive_deletes="all")
    transactions = relationship("Transaction", back_populates="tenant", passive_deletes="all")
    shift_cash_movements = relationship("ShiftCashMovement", back_populates="tenant", passive_deletes="all")
    incident_reports = relationship("IncidentReport", back_populates="tenant", passive_deletes="all")
    suppliers = relationship("Supplier", back_populates="tenant", passive_deletes="all")
    purchase_orders = relationship("PurchaseOrder", back_populates="tenant", passive_deletes="all")


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True)  # NULL for SUPER_ADMIN
    username = Column(String(50), unique=True, index=True, nullable=False)   # stored lower-case
    first_name = Column(String(50), nullable=True)
    last_name = Column(String(50), nullable=True)
    email = Column(String(100), unique=True, index=True, nullable=True)
    phone = Column(String(30), nullable=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(Enum(UserRole), default=UserRole.CASHIER, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    # Incremented on password change/reset and deactivation; tokens carrying an older value are rejected.
    token_version = Column(Integer, default=0, server_default="0", nullable=False)
    must_change_password = Column(Boolean, default=False, server_default="false", nullable=False)
    failed_login_attempts = Column(Integer, default=0, server_default="0", nullable=False)
    locked_until = Column(TimestampTZ, nullable=True)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)
    updated_at = Column(TimestampTZ, server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships. Financial history is never cascaded away with the user (the FKs are RESTRICT).
    tenant = relationship("Tenant", back_populates="users")
    shifts = relationship("Shift", back_populates="user", passive_deletes="all")
    transactions = relationship("Transaction", back_populates="user", passive_deletes="all")
    shift_cash_movements = relationship("ShiftCashMovement", back_populates="user", passive_deletes="all")
    incident_reports = relationship("IncidentReport", back_populates="user", passive_deletes=True)
    purchase_orders = relationship("PurchaseOrder", back_populates="created_by_user", passive_deletes=True)

    __table_args__ = (
        Index("uix_users_username_lower", func.lower(username), unique=True),
    )


class ActivityLog(Base):
    __tablename__ = "activity_logs"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    action = Column(String(50), nullable=False)  # 'Login', 'Logout', 'User Created', etc.
    performed_by = Column(String(100), nullable=False)
    target_user = Column(String(100), nullable=True)
    role = Column(String(50), nullable=True)
    details = Column(String(255), nullable=True)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)


class Category(Base):
    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    description = Column(String(255), nullable=True)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)
    updated_at = Column(TimestampTZ, server_default=func.now(), onupdate=func.now(), nullable=False)

    tenant = relationship("Tenant", back_populates="categories")
    products = relationship("Product", back_populates="category")

    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uix_tenant_category_name"),
    )


class Product(Base):
    __tablename__ = "products"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    category_id = Column(Integer, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True)
    name = Column(String(100), nullable=False)
    sku = Column(String(50), nullable=False)
    barcode = Column(String(100), index=True, nullable=True)
    price = Column(Numeric(10, 2), nullable=False)
    cost = Column(Numeric(10, 2), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    image_url = Column(Text, nullable=True)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)
    updated_at = Column(TimestampTZ, server_default=func.now(), onupdate=func.now(), nullable=False)

    tenant = relationship("Tenant", back_populates="products")
    category = relationship("Category", back_populates="products")
    recipes = relationship("ProductRecipe", back_populates="product", cascade="all, delete-orphan")
    transaction_items = relationship("TransactionItem", back_populates="product", passive_deletes="all")

    __table_args__ = (
        UniqueConstraint("tenant_id", "sku", name="uix_tenant_product_sku"),
        UniqueConstraint("tenant_id", "name", name="uix_tenant_product_name"),
    )


class InventoryItem(Base):
    __tablename__ = "inventory_items"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    category = Column(String(100), nullable=True, default="Kitchen")
    sku = Column(String(50), nullable=True)
    quantity = Column(Numeric(10, 2), default=0.0, nullable=False)
    unit = Column(String(20), nullable=False)
    min_stock = Column(Numeric(10, 2), default=0.0, nullable=False)
    # Equipment (laptops, stoves, chairs) is tracked but excluded from low-stock alerts.
    item_type = Column(String(20), default=InventoryItemType.CONSUMABLE.value, server_default="consumable", nullable=False)
    # Items referenced by purchase orders or recipes are deactivated instead of deleted.
    is_active = Column(Boolean, default=True, server_default="true", nullable=False)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)
    updated_at = Column(TimestampTZ, server_default=func.now(), onupdate=func.now(), nullable=False)

    tenant = relationship("Tenant", back_populates="inventory_items")
    recipes = relationship("ProductRecipe", back_populates="inventory_item", passive_deletes="all")
    purchase_order_items = relationship("PurchaseOrderItem", back_populates="inventory_item", passive_deletes="all")
    stock_movements = relationship("StockMovement", back_populates="inventory_item", passive_deletes="all")

    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uix_tenant_inventory_name"),
        CheckConstraint("item_type IN ('consumable', 'equipment')", name="check_inventory_item_type"),
    )


class ProductRecipe(Base):
    __tablename__ = "product_recipes"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    inventory_item_id = Column(Integer, ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=False)
    quantity = Column(Numeric(10, 2), nullable=False)

    product = relationship("Product", back_populates="recipes")
    inventory_item = relationship("InventoryItem", back_populates="recipes")

    __table_args__ = (
        UniqueConstraint("product_id", "inventory_item_id", name="uix_product_inventory"),
    )


class Shift(Base):
    __tablename__ = "shifts"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    start_time = Column(TimestampTZ, server_default=func.now(), nullable=False)
    end_time = Column(TimestampTZ, nullable=True)
    start_cash = Column(Numeric(10, 2), default=0.0, nullable=False)
    end_cash = Column(Numeric(10, 2), nullable=True)
    # Cash reconciliation, computed when the shift is closed.
    expected_cash = Column(Numeric(10, 2), nullable=True)
    cash_variance = Column(Numeric(10, 2), nullable=True)
    status = Column(String(20), default="open", nullable=False)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)
    updated_at = Column(TimestampTZ, server_default=func.now(), onupdate=func.now(), nullable=False)

    tenant = relationship("Tenant", back_populates="shifts")
    user = relationship("User", back_populates="shifts")
    transactions = relationship("Transaction", back_populates="shift", passive_deletes="all")
    shift_cash_movements = relationship("ShiftCashMovement", back_populates="shift", passive_deletes="all")


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False)
    shift_id = Column(Integer, ForeignKey("shifts.id", ondelete="RESTRICT"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    client_tx_id = Column(String(36), index=True, nullable=True)  # UUID for offline sync, unique per tenant
    total_amount = Column(Numeric(10, 2), default=0.0, nullable=False)
    tax_amount = Column(Numeric(10, 2), default=0.0, nullable=False)
    discount_amount = Column(Numeric(10, 2), default=0.0, nullable=False)
    net_amount = Column(Numeric(10, 2), default=0.0, nullable=False)
    amount_tendered = Column(Numeric(10, 2), nullable=True)
    change_amount = Column(Numeric(10, 2), nullable=True)
    # Payment state (TransactionStatus). Kept separate from the kitchen state below.
    status = Column(String(20), default=TransactionStatus.COMPLETED.value, nullable=False)
    fulfillment_status = Column(String(20), default=FulfillmentStatus.PENDING.value, server_default="pending", nullable=False)
    order_type = Column(String(20), nullable=True)      # 'Dine In' / 'Take Out'
    table_number = Column(String(50), nullable=True)
    customer_order_id = Column(Integer, ForeignKey("customer_orders.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)

    tenant = relationship("Tenant", back_populates="transactions")
    shift = relationship("Shift", back_populates="transactions")
    user = relationship("User", back_populates="transactions")
    items = relationship("TransactionItem", back_populates="transaction", cascade="all, delete-orphan")
    payments = relationship("Payment", back_populates="transaction", cascade="all, delete-orphan")
    customer_order = relationship("CustomerOrder")

    __table_args__ = (
        UniqueConstraint("tenant_id", "client_tx_id", name="uix_tenant_client_tx_id"),
        Index("ix_transactions_tenant_created", "tenant_id", "created_at"),
        CheckConstraint(
            "fulfillment_status IN ('pending', 'preparing', 'ready', 'completed', 'cancelled')",
            name="check_transaction_fulfillment_status",
        ),
    )


class TransactionItem(Base):
    __tablename__ = "transaction_items"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    transaction_id = Column(Integer, ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="RESTRICT"), nullable=False)
    quantity = Column(Integer, default=1, nullable=False)
    unit_price = Column(Numeric(10, 2), nullable=False)
    total_price = Column(Numeric(10, 2), nullable=False)

    transaction = relationship("Transaction", back_populates="items")
    product = relationship("Product", back_populates="transaction_items")


class Payment(Base):
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    transaction_id = Column(Integer, ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False)
    payment_method = Column(String(50), nullable=False)
    amount = Column(Numeric(10, 2), nullable=False)
    status = Column(String(20), default="completed", nullable=False)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)

    transaction = relationship("Transaction", back_populates="payments")


class ShiftCashMovement(Base):
    __tablename__ = "shift_cash_movements"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False)
    shift_id = Column(Integer, ForeignKey("shifts.id", ondelete="RESTRICT"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    type = Column(String(20), nullable=False)  # 'PAID_IN' or 'PAID_OUT'
    amount = Column(Numeric(10, 2), nullable=False)
    reason = Column(String(255), nullable=True)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)

    tenant = relationship("Tenant", back_populates="shift_cash_movements")
    shift = relationship("Shift", back_populates="shift_cash_movements")
    user = relationship("User", back_populates="shift_cash_movements")

    __table_args__ = (
        CheckConstraint("type IN ('PAID_IN', 'PAID_OUT')", name="check_movement_type"),
    )


class IncidentReport(Base):
    """
    Stores bug/incident/issue reports submitted by tenant users.
    Super Admins can view, filter, update status, and add admin notes.
    """
    __tablename__ = "incident_reports"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    title = Column(String(150), nullable=False)
    category = Column(Enum(ReportCategory), nullable=False)
    priority = Column(Enum(ReportPriority), default=ReportPriority.MEDIUM, nullable=False)
    status = Column(Enum(ReportStatus), default=ReportStatus.OPEN, nullable=False)
    description = Column(Text, nullable=False)
    admin_notes = Column(Text, nullable=True)  # Filled in by Super Admin when responding
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)
    updated_at = Column(TimestampTZ, server_default=func.now(), onupdate=func.now(), nullable=False)

    tenant = relationship("Tenant", back_populates="incident_reports")
    user = relationship("User", back_populates="incident_reports")


class Supplier(Base):
    __tablename__ = "suppliers"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    supplier_name = Column(String(150), nullable=False)
    contact_number = Column(String(50), nullable=True)
    category = Column(String(100), nullable=True)
    contact_person = Column(String(100), nullable=True)
    email = Column(String(100), nullable=True)
    address = Column(Text, nullable=True)
    products_supplied = Column(String(255), nullable=True)
    status = Column(String(50), default="Active", nullable=False)
    notes = Column(Text, nullable=True)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)
    updated_at = Column(TimestampTZ, server_default=func.now(), onupdate=func.now(), nullable=False)

    tenant = relationship("Tenant", back_populates="suppliers")
    purchase_orders = relationship("PurchaseOrder", back_populates="supplier", passive_deletes="all")

    __table_args__ = (
        UniqueConstraint("tenant_id", "supplier_name", name="uix_tenant_supplier_name"),
    )


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    po_number = Column(String(50), nullable=False, index=True)
    supplier_id = Column(BigInteger, ForeignKey("suppliers.id", ondelete="RESTRICT"), nullable=False, index=True)
    order_date = Column(TimestampTZ, server_default=func.now(), nullable=False)
    expected_delivery_date = Column(TimestampTZ, nullable=True)
    received_date = Column(TimestampTZ, nullable=True)
    status = Column(Enum(PurchaseOrderStatus), default=PurchaseOrderStatus.DRAFT, nullable=False)
    subtotal = Column(Numeric(10, 2), default=0.0, nullable=False)
    total_amount = Column(Numeric(10, 2), default=0.0, nullable=False)
    notes = Column(Text, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)
    updated_at = Column(TimestampTZ, server_default=func.now(), onupdate=func.now(), nullable=False)

    tenant = relationship("Tenant", back_populates="purchase_orders")
    supplier = relationship("Supplier", back_populates="purchase_orders")
    created_by_user = relationship("User", back_populates="purchase_orders")
    items = relationship("PurchaseOrderItem", back_populates="purchase_order", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("tenant_id", "po_number", name="uix_tenant_po_number"),
    )


class PurchaseOrderItem(Base):
    __tablename__ = "purchase_order_items"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    po_id = Column(BigInteger, ForeignKey("purchase_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    inventory_item_id = Column(Integer, ForeignKey("inventory_items.id", ondelete="RESTRICT"), nullable=False)
    quantity_ordered = Column(Numeric(10, 2), nullable=False)
    quantity_received = Column(Numeric(10, 2), default=0.0, nullable=False)
    unit_cost = Column(Numeric(10, 2), nullable=False)
    total_cost = Column(Numeric(10, 2), nullable=False)

    purchase_order = relationship("PurchaseOrder", back_populates="items")
    inventory_item = relationship("InventoryItem", back_populates="purchase_order_items")


class StockMovement(Base):
    """Ledger of every stock change: receipts, sales deductions, adjustments, wastage and reversals."""
    __tablename__ = "stock_movements"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False, index=True)
    inventory_item_id = Column(Integer, ForeignKey("inventory_items.id", ondelete="RESTRICT"), nullable=False, index=True)
    movement_type = Column(String(20), nullable=False)
    quantity_delta = Column(Numeric(12, 3), nullable=False)
    quantity_after = Column(Numeric(12, 3), nullable=False)
    unit_cost = Column(Numeric(10, 2), nullable=True)
    reason = Column(String(255), nullable=True)
    reference_type = Column(String(30), nullable=True)   # 'transaction', 'purchase_order', ...
    reference_id = Column(BigInteger, nullable=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)

    inventory_item = relationship("InventoryItem", back_populates="stock_movements")
    user = relationship("User")

    __table_args__ = (
        CheckConstraint(
            "movement_type IN ('OPENING', 'RECEIPT', 'SALE', 'ADJUSTMENT', 'WASTAGE', 'REVERSAL')",
            name="check_stock_movement_type",
        ),
        Index("ix_stock_movements_tenant_type_created", "tenant_id", "movement_type", "created_at"),
    )


class CustomerOrder(Base):
    __tablename__ = "customer_orders"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    order_number = Column(String(50), index=True, nullable=False)   # unique per tenant
    # Unguessable token the customer's browser uses to track its own order. NULL for orders placed before it existed.
    tracking_token = Column(String(64), unique=True, nullable=True)
    customer_name = Column(String(100), nullable=False)
    order_type = Column(String(50), nullable=False)  # Dine In, Take Out
    table_number = Column(String(50), nullable=True)
    notes = Column(Text, nullable=True)
    total_amount = Column(Numeric(10, 2), default=0.0, nullable=False)
    status = Column(String(20), default=CustomerOrderStatus.PENDING.value, nullable=False)
    created_at = Column(TimestampTZ, server_default=func.now(), nullable=False)

    tenant = relationship("Tenant")
    items = relationship("CustomerOrderItem", back_populates="customer_order", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("tenant_id", "order_number", name="uix_tenant_customer_order_number"),
        CheckConstraint(
            "status IN ('pending', 'accepted', 'rejected', 'completed')", name="check_customer_order_status"
        ),
    )


class CustomerOrderItem(Base):
    __tablename__ = "customer_order_items"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    customer_order_id = Column(Integer, ForeignKey("customer_orders.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    variant = Column(String(100), nullable=True)
    price = Column(Numeric(10, 2), nullable=False)
    quantity = Column(Integer, default=1, nullable=False)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="SET NULL"), nullable=True)

    customer_order = relationship("CustomerOrder", back_populates="items")


class RestaurantTable(Base):
    __tablename__ = "restaurant_tables"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    table_number = Column(String(50), nullable=False)
    status = Column(String(20), default="active", nullable=False)   # 'active' / 'inactive'

    tenant = relationship("Tenant")

    __table_args__ = (
        UniqueConstraint("tenant_id", "table_number", name="uix_tenant_table_number"),
    )
