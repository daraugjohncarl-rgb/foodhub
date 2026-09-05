import enum
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Numeric, UniqueConstraint, CheckConstraint, func, BigInteger, Enum, Text
from sqlalchemy.orm import relationship
from app.db import Base

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


class Tenant(Base):
    __tablename__ = "tenants"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    name = Column(String(100), unique=True, index=True, nullable=False)
    subdomain_or_code = Column(String(100), unique=True, index=True, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # Relationships
    users = relationship("User", back_populates="tenant", cascade="all, delete-orphan")
    categories = relationship("Category", back_populates="tenant", cascade="all, delete-orphan")
    products = relationship("Product", back_populates="tenant", cascade="all, delete-orphan")
    inventory_items = relationship("InventoryItem", back_populates="tenant", cascade="all, delete-orphan")
    shifts = relationship("Shift", back_populates="tenant", cascade="all, delete-orphan")
    transactions = relationship("Transaction", back_populates="tenant", cascade="all, delete-orphan")
    shift_cash_movements = relationship("ShiftCashMovement", back_populates="tenant", cascade="all, delete-orphan")
    incident_reports = relationship("IncidentReport", back_populates="tenant", cascade="all, delete-orphan")
    suppliers = relationship("Supplier", back_populates="tenant", cascade="all, delete-orphan")


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True)  # NULL for SUPER_ADMIN
    username = Column(String(50), unique=True, index=True, nullable=False)
    first_name = Column(String(50), nullable=True)
    last_name = Column(String(50), nullable=True)
    email = Column(String(100), unique=True, index=True, nullable=True)
    phone = Column(String(30), nullable=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(Enum(UserRole), default=UserRole.CASHIER, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    tenant = relationship("Tenant", back_populates="users")
    shifts = relationship("Shift", back_populates="user", cascade="all, delete-orphan")
    transactions = relationship("Transaction", back_populates="user", cascade="all, delete-orphan")
    shift_cash_movements = relationship("ShiftCashMovement", back_populates="user", cascade="all, delete-orphan")
    incident_reports = relationship("IncidentReport", back_populates="user", cascade="all, delete-orphan")


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
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class Category(Base):
    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    description = Column(String(255), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
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
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    tenant = relationship("Tenant", back_populates="products")
    category = relationship("Category", back_populates="products")
    recipes = relationship("ProductRecipe", back_populates="product", cascade="all, delete-orphan")
    transaction_items = relationship("TransactionItem", back_populates="product")

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
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    tenant = relationship("Tenant", back_populates="inventory_items")
    recipes = relationship("ProductRecipe", back_populates="inventory_item", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uix_tenant_inventory_name"),
    )


class ProductRecipe(Base):
    __tablename__ = "product_recipes"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    inventory_item_id = Column(Integer, ForeignKey("inventory_items.id", ondelete="CASCADE"), nullable=False)
    quantity = Column(Numeric(10, 2), nullable=False)

    # Relationships
    product = relationship("Product", back_populates="recipes")
    inventory_item = relationship("InventoryItem", back_populates="recipes")

    __table_args__ = (
        UniqueConstraint("product_id", "inventory_item_id", name="uix_product_inventory"),
    )


class Shift(Base):
    __tablename__ = "shifts"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    start_time = Column(DateTime, server_default=func.now(), nullable=False)
    end_time = Column(DateTime, nullable=True)
    start_cash = Column(Numeric(10, 2), default=0.0, nullable=False)
    end_cash = Column(Numeric(10, 2), nullable=True)
    status = Column(String(20), default="open", nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    tenant = relationship("Tenant", back_populates="shifts")
    user = relationship("User", back_populates="shifts")
    transactions = relationship("Transaction", back_populates="shift")
    shift_cash_movements = relationship("ShiftCashMovement", back_populates="shift", cascade="all, delete-orphan")


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    shift_id = Column(Integer, ForeignKey("shifts.id", ondelete="RESTRICT"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    client_tx_id = Column(String(36), unique=True, index=True, nullable=True)  # UUID for offline sync
    total_amount = Column(Numeric(10, 2), default=0.0, nullable=False)
    tax_amount = Column(Numeric(10, 2), default=0.0, nullable=False)
    discount_amount = Column(Numeric(10, 2), default=0.0, nullable=False)
    net_amount = Column(Numeric(10, 2), default=0.0, nullable=False)
    status = Column(String(20), default="completed", nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # Relationships
    tenant = relationship("Tenant", back_populates="transactions")
    shift = relationship("Shift", back_populates="transactions")
    user = relationship("User", back_populates="transactions")
    items = relationship("TransactionItem", back_populates="transaction", cascade="all, delete-orphan")
    payments = relationship("Payment", back_populates="transaction", cascade="all, delete-orphan")


class TransactionItem(Base):
    __tablename__ = "transaction_items"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    transaction_id = Column(Integer, ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="RESTRICT"), nullable=False)
    quantity = Column(Integer, default=1, nullable=False)
    unit_price = Column(Numeric(10, 2), nullable=False)
    total_price = Column(Numeric(10, 2), nullable=False)

    # Relationships
    transaction = relationship("Transaction", back_populates="items")
    product = relationship("Product", back_populates="transaction_items")


class Payment(Base):
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    transaction_id = Column(Integer, ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False)
    payment_method = Column(String(50), nullable=False)
    amount = Column(Numeric(10, 2), nullable=False)
    status = Column(String(20), default="completed", nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # Relationships
    transaction = relationship("Transaction", back_populates="payments")


class ShiftCashMovement(Base):
    __tablename__ = "shift_cash_movements"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    tenant_id = Column(BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    shift_id = Column(Integer, ForeignKey("shifts.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    type = Column(String(20), nullable=False)  # 'PAID_IN' or 'PAID_OUT'
    amount = Column(Numeric(10, 2), nullable=False)
    reason = Column(String(255), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # Relationships
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
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    tenant = relationship("Tenant", back_populates="incident_reports")
    user = relationship("User", back_populates="incident_reports")


class Supplier(Base):
    """Supplier model — maps to the existing `suppliers` table in PostgreSQL."""
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
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    tenant = relationship("Tenant", back_populates="suppliers")

    __table_args__ = (
        UniqueConstraint("tenant_id", "supplier_name", name="uix_tenant_supplier_name"),
    )
