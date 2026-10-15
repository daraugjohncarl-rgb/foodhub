import re
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator
from typing import List, Literal, Optional, Any
from decimal import Decimal
from datetime import datetime
from app.models import UserRole, ReportCategory, ReportPriority, ReportStatus, PurchaseOrderStatus
from app.core.config import (
    PASSWORD_MIN_LENGTH, POS_MAX_LINE_QUANTITY, CUSTOMER_ORDER_MAX_ITEMS, CUSTOMER_ORDER_MAX_QUANTITY,
    PRODUCT_IMAGE_MAX_BYTES,
)

USERNAME_PATTERN = re.compile(r"^[a-z0-9._@+-]{3,50}$")
Money = Decimal


def _normalize_username(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip().lower()
    if not USERNAME_PATTERN.match(value):
        raise ValueError("Username must be 3-50 characters: letters, digits and . _ @ + - only.")
    return value


def _blank_to_none(value: Any) -> Any:
    if isinstance(value, str) and value.strip() == "":
        return None
    return value


def reject_explicit_nulls(payload: dict, fields) -> None:
    """For PATCH-style updates: an omitted field means 'leave unchanged', an explicit null is invalid."""
    bad = [name for name in fields if name in payload and payload[name] is None]
    if bad:
        raise ValueError(f"These fields cannot be null: {', '.join(bad)}")

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
class _UserFields(BaseModel):
    @field_validator("username", mode="before", check_fields=False)
    @classmethod
    def _username(cls, v):
        return _normalize_username(_blank_to_none(v))

    @field_validator("email", "phone", "first_name", "last_name", mode="before", check_fields=False)
    @classmethod
    def _blank(cls, v):
        v = _blank_to_none(v)
        return v.strip() if isinstance(v, str) else v


class UserCreate(_UserFields):
    username: Optional[str] = Field(None, max_length=50)
    first_name: Optional[str] = Field(None, max_length=50)
    last_name: Optional[str] = Field(None, max_length=50)
    email: Optional[EmailStr] = Field(None, max_length=100)
    phone: Optional[str] = Field(None, max_length=30)
    password: str = Field(..., min_length=PASSWORD_MIN_LENGTH, max_length=128, description="Plaintext password to hash")
    role: UserRole = Field(UserRole.CASHIER)
    tenant_id: Optional[int] = Field(None, description="SUPER_ADMIN only: branch for the new account")
    is_active: Optional[bool] = Field(True)

class UserUpdate(_UserFields):
    username: Optional[str] = Field(None, max_length=50)
    first_name: Optional[str] = Field(None, max_length=50)
    last_name: Optional[str] = Field(None, max_length=50)
    email: Optional[EmailStr] = Field(None, max_length=100)
    phone: Optional[str] = Field(None, max_length=30)
    role: Optional[UserRole] = None
    is_active: Optional[bool] = None

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data):
        if isinstance(data, dict):
            reject_explicit_nulls(data, ("username", "role", "is_active"))
        return data

class SelfProfileUpdate(_UserFields):
    """Fields a user may change on their own profile. Username/email changes need current_password."""
    username: Optional[str] = Field(None, max_length=50)
    first_name: Optional[str] = Field(None, max_length=50)
    last_name: Optional[str] = Field(None, max_length=50)
    email: Optional[EmailStr] = Field(None, max_length=100)
    phone: Optional[str] = Field(None, max_length=30)
    current_password: Optional[str] = Field(None, max_length=128)

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data):
        if isinstance(data, dict):
            reject_explicit_nulls(data, ("username",))
        return data

class PasswordChangeRequest(BaseModel):
    current_password: str = Field(..., max_length=128)
    new_password: str = Field(..., min_length=PASSWORD_MIN_LENGTH, max_length=128)

class PasswordResetRequest(BaseModel):
    new_password: str = Field(..., min_length=PASSWORD_MIN_LENGTH, max_length=128)

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
    must_change_password: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True
    }


# Activity Log Schemas
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
    created_at: datetime
    updated_at: datetime

    model_config = {
        "from_attributes": True
    }


# Shift Cash Movement Schemas
class ShiftCashMovementCreate(BaseModel):
    shift_id: Optional[int] = Field(None, description="Defaults to your open shift")
    type: Literal["PAID_IN", "PAID_OUT"]
    amount: Decimal = Field(..., gt=0, max_digits=10, decimal_places=2)
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
    start_cash: Decimal = Field(default=Decimal("0"), ge=0, max_digits=10, decimal_places=2)

class ShiftEnd(BaseModel):
    end_cash: Decimal = Field(..., ge=0, max_digits=10, decimal_places=2)

class ShiftResponse(BaseModel):
    id: int
    tenant_id: int
    user_id: int
    start_time: datetime
    end_time: Optional[datetime]
    start_cash: Decimal
    end_cash: Optional[Decimal]
    expected_cash: Optional[Decimal] = None
    cash_variance: Optional[Decimal] = None
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {
        "from_attributes": True
    }


# ─────────────────────────────────────────────
# POS sale request (C7). Prices, tax and totals are always computed by the server.
# ─────────────────────────────────────────────
PAYMENT_METHODS = ("CASH", "GCASH", "CARD")


def _payment_method(value: Any) -> Any:
    if isinstance(value, str):
        value = value.strip().upper()
    return value


class SaleItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_id: int = Field(..., gt=0)
    quantity: int = Field(..., gt=0, le=POS_MAX_LINE_QUANTITY)


class SalePaymentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    payment_method: Literal["CASH", "GCASH", "CARD"]
    amount: Decimal = Field(..., gt=0, max_digits=10, decimal_places=2)

    _norm = field_validator("payment_method", mode="before")(classmethod(lambda cls, v: _payment_method(v)))


class SaleCreate(BaseModel):
    """
    Either a single payment (payment_method + amount_tendered/amount_paid) or an explicit split `payments` list.
    Client-supplied totals, tax or net amounts are rejected (extra="forbid").
    """
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    items: List[SaleItemIn] = Field(..., min_length=1, max_length=100)
    client_tx_id: Optional[str] = Field(None, min_length=1, max_length=36, pattern=r"^[A-Za-z0-9_-]+$")
    payment_method: Literal["CASH", "GCASH", "CARD"] = "CASH"
    amount_tendered: Optional[Decimal] = Field(None, alias="amount_paid", ge=0, max_digits=10, decimal_places=2)
    payments: Optional[List[SalePaymentIn]] = Field(None, min_length=1, max_length=5)
    discount_amount: Decimal = Field(Decimal("0"), ge=0, max_digits=10, decimal_places=2)
    order_type: Optional[Literal["Dine In", "Take Out"]] = None
    table_number: Optional[str] = Field(None, max_length=50)
    customer_order_id: Optional[int] = Field(None, gt=0)

    _norm = field_validator("payment_method", mode="before")(classmethod(lambda cls, v: _payment_method(v)))


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


# ─────────────────────────────────────────────
# Admin Product Schemas (tenant auto-injected)
# ─────────────────────────────────────────────

_DATA_URL = re.compile(r"^data:image/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$")
_RELATIVE_IMAGE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_ ./()&'-]*\.(png|jpe?g|webp|gif|svg)$", re.IGNORECASE)


def validate_image_url(value: Optional[str]) -> Optional[str]:
    """
    Accepts http(s) URLs, site-relative /static/ paths, or small inline data: images (M8).
    Inline images are capped at PRODUCT_IMAGE_MAX_BYTES (decoded) because they are returned in every product list.
    """
    if value is None or value.strip() == "":
        return None
    value = value.strip()
    if value.startswith("data:"):
        match = _DATA_URL.match(value)
        if not match:
            raise ValueError("Image must be a PNG, JPEG, WebP or GIF data URL.")
        decoded_size = len(re.sub(r"\s", "", match.group(2))) * 3 // 4
        if decoded_size > PRODUCT_IMAGE_MAX_BYTES:
            raise ValueError(f"Image is too large (max {PRODUCT_IMAGE_MAX_BYTES // 1024} KB). Compress it first.")
        return value
    if len(value) > 2048:
        raise ValueError("Image URL is too long.")
    if value.startswith(("https://", "http://", "/static/", "/assets/")):
        return value
    # Legacy relative forms the customer page resolves ("x.png", "images/x.png", "assets/images/x.png").
    if _RELATIVE_IMAGE.match(value) and ".." not in value:
        return value
    raise ValueError("Image must be an http(s) URL, a /static/ path, an image file name or a data:image URL.")


class AdminProductCreate(BaseModel):
    """
    Product creation payload for the Admin panel.
    tenant_id is NOT accepted from the client — it is injected from the JWT token.
    """
    category_id: Optional[int] = Field(None, description="Optional link to a Category")
    name: str = Field(..., min_length=1, max_length=100)
    sku: str = Field(..., min_length=1, max_length=50, description="Stock-Keeping Unit, unique per tenant")
    barcode: Optional[str] = Field(None, max_length=100)
    price: Decimal = Field(..., ge=0, max_digits=10, decimal_places=2, description="Selling price")
    cost: Decimal = Field(..., ge=0, max_digits=10, decimal_places=2, description="Unit cost / COGS")
    image_url: Optional[str] = Field(None)
    is_active: Optional[bool] = Field(True)

    _image = field_validator("image_url")(classmethod(lambda cls, v: validate_image_url(v)))


class AdminProductUpdate(BaseModel):
    """
    Partial update payload. Omit a field to leave it unchanged; an explicit null is rejected for fields that cannot
    be empty (name, sku, price, cost, is_active). category_id, barcode and image_url may be cleared with null.
    """
    category_id: Optional[int] = None
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    sku: Optional[str] = Field(None, min_length=1, max_length=50)
    barcode: Optional[str] = Field(None, max_length=100)
    price: Optional[Decimal] = Field(None, ge=0, max_digits=10, decimal_places=2)
    cost: Optional[Decimal] = Field(None, ge=0, max_digits=10, decimal_places=2)
    image_url: Optional[str] = None
    is_active: Optional[bool] = None

    _image = field_validator("image_url")(classmethod(lambda cls, v: validate_image_url(v)))

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data):
        if isinstance(data, dict):
            reject_explicit_nulls(data, ("name", "sku", "price", "cost", "is_active"))
        return data


class AdminProductResponse(BaseModel):
    id: int
    tenant_id: int
    category_id: Optional[int] = None
    category_name: Optional[str] = None   # Denormalized from Category relationship
    name: str
    sku: str
    barcode: Optional[str] = None
    price: Decimal
    cost: Decimal
    image_url: Optional[str] = None
    is_active: bool
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


# ─────────────────────────────────────────────
# Inventory Schemas (Admin-scoped)
# ─────────────────────────────────────────────

class InventoryItemCreate(BaseModel):
    """Request body to add a new raw ingredient or stock item."""
    name: str = Field(..., min_length=1, max_length=100, description="Item name (unique per tenant)")
    category: Optional[str] = Field("Kitchen", max_length=100, description="Department category")
    sku: Optional[str] = Field(None, max_length=50, description="Generated from the name when omitted")
    quantity: Decimal = Field(Decimal("0"), ge=0, max_digits=10, decimal_places=2, description="Opening stock quantity")
    unit: str = Field(..., min_length=1, max_length=20, description="Unit of measure, e.g. kg, pcs, L")
    min_stock: Decimal = Field(Decimal("0"), ge=0, max_digits=10, decimal_places=2, description="Low-stock threshold")
    item_type: Literal["consumable", "equipment"] = "consumable"

    @field_validator("name", "unit", mode="before")
    @classmethod
    def _strip(cls, v):
        return v.strip() if isinstance(v, str) else v


class InventoryStockAdjust(BaseModel):
    """
    Delta-based stock adjustment.
    Positive quantity_delta = restock / receipt.
    Negative quantity_delta = consumption / correction.
    """
    quantity_delta: Decimal = Field(..., max_digits=10, decimal_places=2,
                                    description="Amount to add (positive) or subtract (negative)")
    reason: Optional[str] = Field(None, max_length=255, description="Reason for adjustment (optional)")

    @field_validator("quantity_delta")
    @classmethod
    def _non_zero(cls, v):
        if v == 0:
            raise ValueError("quantity_delta must not be zero.")
        return v


WASTAGE_REASONS = (
    "Expired shelf-life",
    "Spoiled / Molded produce",
    "Accidental Kitchen Spill",
    "Burnt during cooking",
    "Quality standard failure",
    "Other",
)


class WastageCreate(BaseModel):
    inventory_item_id: int = Field(..., gt=0)
    quantity: Decimal = Field(..., gt=0, max_digits=10, decimal_places=2)
    reason: Literal[WASTAGE_REASONS]  # type: ignore[valid-type]
    estimated_cost: Optional[Decimal] = Field(None, ge=0, max_digits=10, decimal_places=2)
    notes: Optional[str] = Field(None, max_length=150)


class WastageResponse(BaseModel):
    id: int
    inventory_item_id: int
    item: str
    unit: str
    quantity: Decimal
    reason: str
    estimated_cost: Optional[Decimal] = None
    logged_by: Optional[str] = None
    created_at: datetime


class StockMovementResponse(BaseModel):
    id: int
    inventory_item_id: int
    movement_type: str
    quantity_delta: Decimal
    quantity_after: Decimal
    unit_cost: Optional[Decimal] = None
    reason: Optional[str] = None
    reference_type: Optional[str] = None
    reference_id: Optional[int] = None
    user_id: Optional[int] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class RecipeLineIn(BaseModel):
    inventory_item_id: int = Field(..., gt=0)
    quantity: Decimal = Field(..., gt=0, max_digits=10, decimal_places=2, description="Stock used per one product sold")


class RecipeSet(BaseModel):
    """Replaces the product's whole recipe. An empty list removes it (the product then deducts no stock)."""
    lines: List[RecipeLineIn] = Field(default_factory=list, max_length=50)


class RecipeLineResponse(BaseModel):
    inventory_item_id: int
    inventory_item_name: str
    unit: str
    quantity: Decimal


class InventoryItemResponse(BaseModel):
    id: int
    tenant_id: int
    name: str
    category: Optional[str] = "Kitchen"
    sku: Optional[str] = None
    quantity: Decimal
    unit: str
    min_stock: Decimal
    item_type: str = "consumable"
    is_active: bool = True
    is_low_stock: bool = False   # Computed: consumable and quantity <= min_stock
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def compute_low_stock(cls, data: Any) -> Any:
        if hasattr(data, "quantity") and hasattr(data, "min_stock"):
            obj = data.__dict__.copy() if hasattr(data, "__dict__") else {}
            obj["is_low_stock"] = (
                getattr(data, "item_type", "consumable") != "equipment" and data.quantity <= data.min_stock
            )
            return obj
        return data


# ─────────────────────────────────────────────
# Analytics Schemas
# ─────────────────────────────────────────────

class DashboardStats(BaseModel):
    """Summary stats for the Admin dashboard. All values are tenant-scoped."""
    today_sales: Decimal = Field(description="Sum of net_amount on completed transactions today")
    total_transactions_today: int = Field(description="Count of completed transactions today")
    low_stock_count: int = Field(description="Number of inventory items at or below min_stock")
    active_staff_count: int = Field(description="Number of active non-SUPER_ADMIN users in this tenant")


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
    quantity_received: Decimal = Decimal("0")
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
            if getattr(data, "quantity_received", None) is not None:
                obj["quantity_received"] = data.quantity_received
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
    """
    Received / Partially Received can only be reached through POST /purchase-orders/{id}/receive, which also adds
    the stock. Allowed here: Draft -> Pending/Ordered, Pending -> Ordered, and any open order -> Cancelled.
    """
    expected_delivery_date: Optional[datetime] = None
    notes: Optional[str] = None
    status: Optional[PurchaseOrderStatus] = None


class PurchaseOrderReceiveLine(BaseModel):
    item_id: int = Field(..., gt=0, description="purchase_order_items.id")
    quantity: Decimal = Field(..., gt=0, max_digits=10, decimal_places=2)


class PurchaseOrderReceive(BaseModel):
    """Omit `lines` to receive everything still outstanding."""
    lines: Optional[List[PurchaseOrderReceiveLine]] = Field(None, min_length=1, max_length=200)


# ─────────────────────────────────────────────
# Customer QR orders (H2)
# ─────────────────────────────────────────────

class CustomerOrderItemIn(BaseModel):
    product_id: int = Field(..., gt=0)
    quantity: int = Field(..., gt=0, le=CUSTOMER_ORDER_MAX_QUANTITY)
    variant: Optional[str] = Field(None, max_length=100)


class CustomerOrderCreate(BaseModel):
    # Unknown keys (e.g. an old client sending its own order_number) are ignored: the server always generates it.
    model_config = ConfigDict(extra="ignore")

    tenant_id: int = Field(1, gt=0, description="Branch from the QR code; defaults to the main branch")
    customer_name: str = Field(..., min_length=1, max_length=100)
    order_type: Literal["Dine In", "Take Out"] = "Dine In"
    table_number: Optional[str] = Field(None, max_length=20)
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


class KitchenStatusUpdate(BaseModel):
    status: Literal["pending", "preparing", "ready", "completed", "cancelled"]

    @field_validator("status", mode="before")
    @classmethod
    def _lower(cls, v):
        return v.strip().lower() if isinstance(v, str) else v


class TableCreate(BaseModel):
    table_number: str = Field(..., min_length=1, max_length=20)

    @field_validator("table_number", mode="before")
    @classmethod
    def _strip(cls, v):
        return str(v).strip() if v is not None else v


class TableUpdate(BaseModel):
    status: Literal["active", "inactive"]

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

