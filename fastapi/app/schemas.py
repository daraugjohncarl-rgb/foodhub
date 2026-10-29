from pydantic import BaseModel, Field, model_validator, ConfigDict, field_validator
from typing import List, Optional, Any, Literal
from decimal import Decimal
from datetime import datetime
from app.models import UserRole, ReportCategory, ReportPriority, ReportStatus, PurchaseOrderStatus

# Tenant Schemas
class TenantCreate(BaseModel):
    name: str = Field(..., max_length=100, description="Name of the tenant company")
    subdomain_or_code: str = Field(..., max_length=100, description="Unique subdomain or identifier code")

class TenantResponse(BaseModel):
    id: int
    name: str
    subdomain_or_code: str
    is_active: bool
    created_at: datetime

    model_config = {
        "from_attributes": True
    }


# User Schemas
class UserCreate(BaseModel):
    username: Optional[str] = Field(None, max_length=50)
    first_name: Optional[str] = Field(None, max_length=50)
    last_name: Optional[str] = Field(None, max_length=50)
    email: Optional[str] = Field(None, max_length=100)
    phone: Optional[str] = Field(None, max_length=30)
    password: str = Field(..., min_length=8, max_length=128, description="Plaintext password to hash")
    role: UserRole = Field(UserRole.ADMIN)
    tenant_id: Optional[int] = Field(None, description="Nullable. Required for non-superadmin users")
    is_active: Optional[bool] = Field(True)

class UserUpdate(BaseModel):
    username: Optional[str] = Field(None, max_length=50)
    first_name: Optional[str] = Field(None, max_length=50)
    last_name: Optional[str] = Field(None, max_length=50)
    email: Optional[str] = Field(None, max_length=100)
    phone: Optional[str] = Field(None, max_length=30)
    role: Optional[UserRole] = None
    is_active: Optional[bool] = None

class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8, max_length=128)

class PasswordResetRequest(BaseModel):
    new_password: str = Field(..., min_length=8, max_length=128)

class CustomerRegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50, description="Desired customer username")
    password: str = Field(..., min_length=8, max_length=128, description="Password (at least 8 characters)")
    first_name: Optional[str] = Field(None, max_length=50)
    last_name: Optional[str] = Field(None, max_length=50)
    email: Optional[str] = Field(None, max_length=100)
    phone: Optional[str] = Field(None, max_length=30)
    tenant_id: Optional[int] = Field(None)

class UserResponse(BaseModel):
    id: int
    tenant_id: Optional[int] = None
    username: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    role: Any
    is_active: bool = True
    token_version: Optional[int] = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True
    }


# Activity Log Schemas
class ActivityLogCreate(BaseModel):
    action: str = Field(..., max_length=50)
    # Actor identity fields are accepted for backward compatibility but ignored:
    # the server always derives them from the authenticated session.
    performed_by: Optional[str] = None
    target_user: Optional[str] = Field(None, max_length=100)
    role: Optional[str] = None
    details: Optional[str] = Field(None, max_length=255)

class ActivityLogResponse(BaseModel):
    id: int
    tenant_id: Optional[int] = None
    user_id: Optional[int] = None
    action: str
    performed_by: str
    target_user: Optional[str] = None
    role: Optional[str] = None
    details: Optional[str] = None
    created_at: datetime

    model_config = {
        "from_attributes": True
    }


# Product Schemas
class ProductCreate(BaseModel):
    tenant_id: int
    category_id: Optional[int] = None
    name: str = Field(..., max_length=100)
    sku: str = Field(..., max_length=50)
    barcode: Optional[str] = Field(None, max_length=100)
    price: Decimal = Field(..., ge=0.0)
    cost: Decimal = Field(..., ge=0.0)
    is_active: Optional[bool] = True
    preparation_station: Optional[str] = Field("kitchen", max_length=30)

class ProductResponse(BaseModel):
    id: int
    tenant_id: int
    category_id: Optional[int]
    name: str
    sku: str
    barcode: Optional[str]
    price: Decimal
    cost: Decimal
    is_active: bool
    image_url: Optional[str] = None
    preparation_station: Optional[str] = "kitchen"
    created_at: datetime
    updated_at: datetime

    model_config = {
        "from_attributes": True
    }


# Shift Cash Movement Schemas
# Drawer amounts are stored in Numeric(10, 2) columns: finite, at most 10 digits, 2 decimal places.
class ShiftCashMovementCreate(BaseModel):
    shift_id: int
    type: Literal["PAID_IN", "PAID_OUT"] = Field(..., description="Must be 'PAID_IN' or 'PAID_OUT'")
    amount: Decimal = Field(..., gt=0.0, max_digits=10, decimal_places=2, allow_inf_nan=False)
    reason: Optional[str] = Field(None, max_length=255)
    tenant_id: Optional[int] = None
    user_id: Optional[int] = None

    @field_validator("type", mode="before")
    @classmethod
    def _upper(cls, v):
        return v.strip().upper() if isinstance(v, str) else v

class ShiftCashoutRequest(BaseModel):
    """POST /shifts/cashout and /shifts/withdraw. shift_id is checked by the route (400 on a bad value)."""
    shift_id: Any = None
    amount: Optional[Decimal] = Field(None, ge=0, max_digits=10, decimal_places=2, allow_inf_nan=False)
    reason: Optional[str] = Field(None, max_length=255)

class ShiftDrawerCashRequest(BaseModel):
    """PUT/POST /shifts/{shift_id}/drawer-cash: the counted drawer amount the expected cash is set to."""
    amount: Decimal = Field(Decimal("0"), ge=0, max_digits=10, decimal_places=2, allow_inf_nan=False)
    reason: Optional[str] = Field(None, max_length=255)

class ShiftCashMovementResponse(BaseModel):
    id: int
    tenant_id: int
    shift_id: int
    user_id: int
    type: str
    amount: Decimal
    reason: Optional[str]
    created_at: datetime

    model_config = {
        "from_attributes": True
    }


# Shift Schemas
class ShiftCreate(BaseModel):
    start_cash: Decimal = Field(default=0.0, ge=0.0)

class ShiftEnd(BaseModel):
    end_cash: Decimal = Field(..., ge=0.0)

class ShiftResponse(BaseModel):
    id: int
    tenant_id: int
    user_id: int
    start_time: datetime
    end_time: Optional[datetime]
    start_cash: Decimal
    end_cash: Optional[Decimal]
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {
        "from_attributes": True
    }


# Transaction Item Schemas
class TransactionItemCreate(BaseModel):
    product_id: int
    quantity: int = Field(..., gt=0)
    unit_price: Decimal = Field(..., ge=0.0)

class TransactionItemResponse(BaseModel):
    id: int
    transaction_id: int
    product_id: int
    quantity: int
    unit_price: Decimal
    total_price: Decimal

    model_config = {
        "from_attributes": True
    }


# Payment Schemas
class PaymentCreate(BaseModel):
    payment_method: str = Field(..., max_length=50)
    amount: Decimal = Field(..., ge=0.0)
    status: Optional[str] = Field("completed", max_length=20)

class PaymentResponse(BaseModel):
    id: int
    transaction_id: int
    payment_method: str
    amount: Decimal
    status: str
    created_at: datetime

    model_config = {
        "from_attributes": True
    }


# Transaction Schemas
class TransactionCreate(BaseModel):
    tenant_id: int
    shift_id: int
    user_id: int
    client_tx_id: Optional[str] = Field(None, max_length=36, description="Idempotency UUID from offline tablet")
    total_amount: Decimal = Field(..., ge=0.0)
    tax_amount: Decimal = Field(0.0, ge=0.0)
    discount_amount: Decimal = Field(0.0, ge=0.0)
    net_amount: Decimal = Field(..., ge=0.0)
    status: Optional[str] = Field("completed", max_length=20)
    items: List[TransactionItemCreate] = Field(..., min_length=1)
    payments: List[PaymentCreate] = Field(..., min_length=1)

class TransactionResponse(BaseModel):
    id: int
    tenant_id: int
    shift_id: int
    user_id: int
    client_tx_id: Optional[str]
    total_amount: Decimal
    tax_amount: Decimal
    discount_amount: Decimal
    net_amount: Decimal
    status: str
    created_at: datetime
    items: List[TransactionItemResponse]
    payments: List[PaymentResponse]

    model_config = {
        "from_attributes": True
    }


# ─────────────────────────────────────────────
# Incident / Issue Report Schemas
# ─────────────────────────────────────────────

class ReportCreate(BaseModel):
    """Payload submitted by any authenticated tenant user to file a new incident report."""
    title: str = Field(..., max_length=150, description="Short descriptive title of the issue")
    category: ReportCategory = Field(..., description="Category of the issue")
    priority: ReportPriority = Field(ReportPriority.MEDIUM, description="Urgency level")
    description: str = Field(..., min_length=10, description="Detailed description of the issue")


class ReportUpdateStatus(BaseModel):
    """Payload used by Super Admin to update the status and optionally add admin notes."""
    status: ReportStatus = Field(..., description="New status for the report")
    admin_notes: Optional[str] = Field(None, description="Optional response / notes from Super Admin")


class ReportResponse(BaseModel):
    """Full report response including denormalized tenant name and reporter username."""
    id: int
    tenant_id: int
    tenant_name: Optional[str] = None
    user_id: Optional[int] = None
    username: Optional[str] = None
    title: str
    category: ReportCategory
    priority: ReportPriority
    status: ReportStatus
    description: str
    admin_notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {
        "from_attributes": True
    }

    @model_validator(mode="before")
    @classmethod
    def extract_related_names(cls, data: Any) -> Any:
        """
        When instantiated from an ORM object, eagerly pull tenant.name and user.username
        so callers receive denormalized fields without extra queries.
        """
        if hasattr(data, "__class__") and hasattr(data, "tenant"):
            # ORM object — extract relationship fields
            obj = data.__dict__.copy() if hasattr(data, "__dict__") else {}
            obj["tenant_name"] = data.tenant.name if data.tenant else None
            obj["username"] = data.user.username if data.user else None
            return obj
        return data


# ─────────────────────────────────────────────
# Category Schemas (Admin-scoped)
# ─────────────────────────────────────────────

class CategoryCreate(BaseModel):
    """Request body to create a product category. tenant_id is auto-injected from JWT."""
    name: str = Field(..., max_length=100, description="Category name (unique per tenant)")
    description: Optional[str] = Field(None, max_length=255)


class CategoryResponse(BaseModel):
    id: int
    tenant_id: int
    name: str
    description: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CategoryUpdate(BaseModel):
    """Request body to update a product category."""
    name: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = Field(None, max_length=255)


class ProductImportItem(BaseModel):
    name: str = Field(..., max_length=100)
    category_id: Optional[int] = None
    category_name: Optional[str] = None
    price: Decimal
    cost: Optional[Decimal] = Decimal("0.0")
    image_url: Optional[str] = None
    sku: Optional[str] = None
    barcode: Optional[str] = None
    is_active: Optional[bool] = True


class ProductImportBatchRequest(BaseModel):
    items: List[ProductImportItem]


# ─────────────────────────────────────────────
# Admin Product Schemas (tenant auto-injected)
# ─────────────────────────────────────────────

class AdminProductCreate(BaseModel):
    """
    Product creation payload for the Admin panel.
    tenant_id is NOT accepted from the client — it is injected from the JWT token.
    """
    category_id: Optional[int] = Field(None, description="Optional link to a Category")
    name: str = Field(..., max_length=100)
    sku: str = Field(..., max_length=50, description="Stock-Keeping Unit, unique per tenant")
    barcode: Optional[str] = Field(None, max_length=100)
    price: Decimal = Field(..., ge=0, description="Selling price")
    cost: Optional[Decimal] = Field(Decimal("0.0"), ge=0, description="Unit cost / COGS")
    image_url: Optional[str] = Field(None)
    is_active: Optional[bool] = Field(True)
    preparation_station: Optional[str] = Field("kitchen", max_length=30)


class AdminProductUpdate(BaseModel):
    """Partial update payload — all fields are optional."""
    category_id: Optional[int] = None
    name: Optional[str] = Field(None, max_length=100)
    sku: Optional[str] = Field(None, max_length=50)
    barcode: Optional[str] = Field(None, max_length=100)
    price: Optional[Decimal] = Field(None, ge=0)
    cost: Optional[Decimal] = Field(None, ge=0)
    image_url: Optional[str] = None
    is_active: Optional[bool] = None
    preparation_station: Optional[str] = Field(None, max_length=30)


class AdminProductResponse(BaseModel):
    id: int
    tenant_id: int
    category_id: Optional[int] = None
    category_name: Optional[str] = None   # Denormalized from Category relationship
    category: Optional[CategoryResponse] = None
    name: str
    sku: str
    barcode: Optional[str] = None
    price: Decimal
    cost: Decimal
    image_url: Optional[str] = None
    is_active: bool
    preparation_station: Optional[str] = "kitchen"
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def extract_category_name(cls, data: Any) -> Any:
        if hasattr(data, "category") and data.category is not None:
            obj = data.__dict__.copy() if hasattr(data, "__dict__") else {}
            obj["category_name"] = data.category.name
            return obj
        return data


class ProductListResponse(AdminProductResponse):
    """Product list shape: `cost` is optional so non-management callers can be served without it."""
    cost: Optional[Decimal] = None


# ─────────────────────────────────────────────
# Inventory Schemas (Admin-scoped)
# ─────────────────────────────────────────────

class InventoryItemCreate(BaseModel):
    """Request body to add a new raw ingredient or stock item."""
    name: str = Field(..., max_length=100, description="Item name (unique per tenant)")
    category: Optional[str] = Field("Kitchen", max_length=100, description="Department category")
    sku: Optional[str] = Field(None, max_length=50)
    quantity: Decimal = Field(0.0, ge=0, description="Opening stock quantity")
    unit: str = Field(..., max_length=20, description="Unit of measure, e.g. kg, pcs, L")
    min_stock: Decimal = Field(0.0, ge=0, description="Low-stock threshold")
    unit_price: Optional[Decimal] = Field(0.0, ge=0, description="Price or cost per unit")


class InventoryItemUpdate(BaseModel):
    """Request body to edit an existing inventory item."""
    name: Optional[str] = Field(None, max_length=100, description="Item name")
    category: Optional[str] = Field(None, max_length=100, description="Department category")
    sku: Optional[str] = Field(None, max_length=50)
    quantity: Optional[Decimal] = Field(None, ge=0, description="Stock quantity")
    unit: Optional[str] = Field(None, max_length=20, description="Unit of measure")
    min_stock: Optional[Decimal] = Field(None, ge=0, description="Low-stock threshold")
    unit_price: Optional[Decimal] = Field(None, ge=0, description="Price per unit")


class InventoryStockAdjust(BaseModel):
    """
    Delta-based stock adjustment.
    Positive quantity_delta = restock / receipt.
    Negative quantity_delta = consumption / correction.
    """
    quantity_delta: Decimal = Field(..., description="Amount to add (positive) or subtract (negative)")
    reason: Optional[str] = Field(None, max_length=255, description="Reason for adjustment (optional)")
    unit_price: Optional[Decimal] = Field(None, ge=0, description="Optional updated price per unit")


class InventoryItemResponse(BaseModel):
    id: int
    tenant_id: int
    name: str
    category: Optional[str] = "Kitchen"
    sku: Optional[str] = None
    quantity: Decimal
    unit: str
    min_stock: Decimal
    unit_price: Decimal = Decimal("0.0")
    total_value: Optional[Decimal] = None
    is_low_stock: bool = False   # Computed field: quantity <= min_stock
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def compute_low_stock(cls, data: Any) -> Any:
        if hasattr(data, "quantity") and hasattr(data, "min_stock"):
            obj = data.__dict__.copy() if hasattr(data, "__dict__") else {}
            obj["is_low_stock"] = float(data.quantity) <= float(data.min_stock)
            unit_p = float(getattr(data, "unit_price", 0) or 0)
            obj["unit_price"] = Decimal(str(unit_p))
            obj["total_value"] = Decimal(str(round(float(data.quantity) * unit_p, 2)))
            return obj
        return data


class BulkDeleteInventoryRequest(BaseModel):
    item_ids: List[int] = Field(..., min_length=1, description="List of inventory item IDs to delete")


class BulkDeleteInventoryResponse(BaseModel):
    success: bool
    deleted_ids: List[int]
    failed_ids: List[int] = []
    deleted_count: int
    message: str
    errors: List[dict] = []



# ─────────────────────────────────────────────
# Analytics Schemas
# ─────────────────────────────────────────────

class DashboardStats(BaseModel):
    """Summary stats for the Admin dashboard. All values are tenant-scoped."""
    today_sales: Decimal = Field(description="Sum of net_amount on completed transactions today")
    total_transactions_today: int = Field(description="Count of completed transactions today")
    low_stock_count: int = Field(description="Number of inventory items at or below min_stock")
    active_staff_count: int = Field(description="Number of active non-SUPER_ADMIN users in this tenant")
    cash_in_drawer: Optional[Decimal] = Field(default=Decimal("0.0"), description="Total cash currently in active cashier drawers")


# ─────────────────────────────────────────────
# Supplier Schemas
# ─────────────────────────────────────────────

class SupplierCreate(BaseModel):
    supplier_name: str = Field(..., max_length=150)
    contact_number: Optional[str] = Field(None, max_length=50)
    category: Optional[str] = Field(None, max_length=100)
    contact_person: Optional[str] = Field(None, max_length=100)
    email: Optional[str] = Field(None, max_length=100)
    address: Optional[str] = None
    products_supplied: Optional[str] = Field(None, max_length=255)
    status: Optional[str] = Field("Active", max_length=50)
    notes: Optional[str] = None

class SupplierUpdate(BaseModel):
    supplier_name: Optional[str] = Field(None, max_length=150)
    contact_number: Optional[str] = Field(None, max_length=50)
    category: Optional[str] = Field(None, max_length=100)
    contact_person: Optional[str] = Field(None, max_length=100)
    email: Optional[str] = Field(None, max_length=100)
    address: Optional[str] = None
    products_supplied: Optional[str] = Field(None, max_length=255)
    status: Optional[str] = Field(None, max_length=50)
    notes: Optional[str] = None

class SupplierResponse(BaseModel):
    id: int
    tenant_id: int
    supplier_name: str
    contact_number: Optional[str]
    category: Optional[str]
    contact_person: Optional[str]
    email: Optional[str]
    address: Optional[str]
    products_supplied: Optional[str]
    status: str
    notes: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ─────────────────────────────────────────────
# Purchase Order Schemas
# ─────────────────────────────────────────────

class PurchaseOrderItemCreate(BaseModel):
    inventory_item_id: int
    quantity: Decimal = Field(..., gt=0)
    unit_cost: Decimal = Field(..., ge=0.0)
    notes: Optional[str] = None

class PurchaseOrderItemResponse(BaseModel):
    id: int
    purchase_order_id: int
    inventory_item_id: int
    inventory_item_name: Optional[str] = None
    quantity: Decimal
    unit_cost: Decimal
    total_cost: Decimal
    notes: Optional[str]

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def extract_inventory_name(cls, data: Any) -> Any:
        if hasattr(data, "__class__"):
            obj = data.__dict__.copy() if hasattr(data, "__dict__") else {}
            if hasattr(data, "inventory_item") and data.inventory_item is not None:
                obj["inventory_item_name"] = data.inventory_item.name
            if hasattr(data, "po_id"):
                obj["purchase_order_id"] = data.po_id
            if hasattr(data, "quantity_ordered"):
                obj["quantity"] = data.quantity_ordered
            if not hasattr(data, "notes") and "notes" not in obj:
                obj["notes"] = None
            return obj
        return data

class PurchaseOrderCreate(BaseModel):
    supplier_id: int
    expected_delivery_date: Optional[datetime] = None
    notes: Optional[str] = None
    items: List[PurchaseOrderItemCreate] = Field(..., min_length=1)

class PurchaseOrderUpdate(BaseModel):
    expected_delivery_date: Optional[datetime] = None
    notes: Optional[str] = None
    status: Optional[PurchaseOrderStatus] = None

class PurchaseOrderResponse(BaseModel):
    id: int
    tenant_id: int
    po_number: str
    supplier_id: int
    supplier_name: Optional[str] = None
    order_date: datetime
    expected_delivery_date: Optional[datetime]
    received_date: Optional[datetime]
    status: PurchaseOrderStatus
    subtotal: Decimal
    total_amount: Decimal
    notes: Optional[str]
    created_by: Optional[int]
    created_by_username: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    items: List[PurchaseOrderItemResponse] = []

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def extract_related_names(cls, data: Any) -> Any:
        if hasattr(data, "__class__"):
            obj = data.__dict__.copy() if hasattr(data, "__dict__") else {}
            if hasattr(data, "supplier") and data.supplier is not None:
                obj["supplier_name"] = data.supplier.supplier_name
            if hasattr(data, "created_by_user") and data.created_by_user is not None:
                obj["created_by_username"] = data.created_by_user.username
            if hasattr(data, "items"):
                obj["items"] = data.items
            return obj
        return data


# ─────────────────────────────────────────────
# Customer QR orders & Tables
# ─────────────────────────────────────────────

CUSTOMER_ORDER_MAX_QUANTITY = 50
CUSTOMER_ORDER_MAX_ITEMS = 50

class CustomerOrderItemIn(BaseModel):
    product_id: int = Field(..., gt=0)
    quantity: int = Field(..., gt=0, le=CUSTOMER_ORDER_MAX_QUANTITY)
    variant: Optional[str] = Field(None, max_length=100)

class CustomerOrderCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    tenant_id: int = Field(1, gt=0, description="Branch from the QR code; defaults to the main branch")
    customer_name: str = Field(..., min_length=1, max_length=100)
    order_type: Literal["Dine In", "Take Out"] = "Dine In"
    table_number: Optional[str] = Field(None, max_length=50)
    notes: Optional[str] = Field(None, max_length=500)
    items: List[CustomerOrderItemIn] = Field(..., min_length=1, max_length=CUSTOMER_ORDER_MAX_ITEMS)

    @field_validator("customer_name", "table_number", "notes", mode="before")
    @classmethod
    def _strip(cls, v):
        if v is None:
            return None
        v = str(v).strip()
        return v or None

class CustomerOrderStatusUpdate(BaseModel):
    status: Literal["accepted", "rejected", "completed"]

    @field_validator("status", mode="before")
    @classmethod
    def _lower(cls, v):
        return v.strip().lower() if isinstance(v, str) else v

class TableCreate(BaseModel):
    table_number: str = Field(..., min_length=1, max_length=50)

    @field_validator("table_number", mode="before")
    @classmethod
    def _strip(cls, v):
        return str(v).strip() if v is not None else v

class TableUpdate(BaseModel):
    status: Literal["active", "inactive"]


# ─────────────────────────────────────────────
# Expense Schemas
# ─────────────────────────────────────────────
class ExpenseCreate(BaseModel):
    category: str = Field(..., max_length=50)
    description: str = Field(..., max_length=255)
    amount: Decimal = Field(..., gt=0)
    payment_method: str = Field("Cash", max_length=50)
    status: Literal["paid", "pending", "voided"] = "paid"
    reference_no: Optional[str] = Field(None, max_length=50)
    expense_date: Optional[datetime] = None

class ExpenseUpdate(BaseModel):
    category: Optional[str] = Field(None, max_length=50)
    description: Optional[str] = Field(None, max_length=255)
    amount: Optional[Decimal] = Field(None, gt=0)
    payment_method: Optional[str] = Field(None, max_length=50)
    status: Optional[Literal["paid", "pending", "voided"]] = None
    reference_no: Optional[str] = Field(None, max_length=50)
    expense_date: Optional[datetime] = None

class ExpenseResponse(BaseModel):
    id: int
    tenant_id: int
    category: str
    description: str
    amount: float
    payment_method: str
    status: str
    reference_no: Optional[str] = None
    expense_date: Optional[datetime] = None
    recorded_by: Optional[int] = None
    recorded_by_username: Optional[str] = None
    created_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True
    }



