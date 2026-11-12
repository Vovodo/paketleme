from datetime import datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .qr_utils import normalize_code


class StockCreateRequest(BaseModel):
    reference: str = Field(..., min_length=1, max_length=120, description="Ürün / Kılıf Referans Kodu")
    quantity: int = Field(..., gt=0, le=100000, description="Paketsiz Kılıf Adedi")
    level: str = Field(..., min_length=1, max_length=80, description="Level / Revizyon Bilgisi")
    location_note: Optional[str] = Field(default=None, max_length=200, description="Opsiyonel Raf / Konum / Not")
    created_by: Optional[str] = Field(default=None, max_length=100, description="Opsiyonel Personel / Hat Adı")

    @field_validator("reference", "level")
    @classmethod
    def must_not_be_blank(cls, v: str) -> str:
        norm = normalize_code(v)
        if not norm:
            raise ValueError("Bu alan boş bırakılamaz.")
        return norm


class StockUpdateRequest(BaseModel):
    reference: Optional[str] = Field(default=None, min_length=1, max_length=120)
    level: Optional[str] = Field(default=None, min_length=1, max_length=80)
    remaining_quantity: Optional[int] = Field(default=None, gt=0, le=100000)
    location_note: Optional[str] = Field(default=None, max_length=200)

    @field_validator("reference", "level")
    @classmethod
    def optional_must_not_be_blank(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        norm = normalize_code(v)
        if not norm:
            raise ValueError("Referans ve Level alanı boş bırakılamaz.")
        return norm


class WarehouseRequestPayload(BaseModel):
    requested_note: Optional[str] = Field(default=None, max_length=200, description="İsteyen Hat / Not")


class ScanDeductRequest(BaseModel):
    qr_or_code: str = Field(..., min_length=1, max_length=512, description="QR Kod içeriği veya Etiket Kodu")
    deduct_quantity: Optional[int] = Field(
        default=None,
        gt=0,
        le=100000,
        description="Belirtilmezse kalan miktarın tamamı stoktan düşülür",
    )
    note: Optional[str] = Field(default=None, max_length=255)

    @field_validator("qr_or_code")
    @classmethod
    def qr_not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Okutulan kod boş olamaz.")
        return v.strip()


class ProductionMatchItem(BaseModel):
    reference: str = Field(..., min_length=1, max_length=120)
    level: Optional[str] = Field(default=None, max_length=80)


class ProductionMatchRequest(BaseModel):
    queries: list[ProductionMatchItem] = Field(..., min_length=1, max_length=200)


class StockMovementOut(BaseModel):
    id: int
    stock_item_id: int
    action: str
    quantity_change: int
    quantity_before: int
    quantity_after: int
    note: Optional[str] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class StockMovementWithItemOut(StockMovementOut):
    label_code: str
    reference: str
    level: str


class StockItemOut(BaseModel):
    id: int
    label_code: str
    qr_payload: str
    reference: str
    level: str
    initial_quantity: int
    remaining_quantity: int
    status: str
    location_note: Optional[str] = None
    created_by: Optional[str] = None
    requested_at: Optional[datetime] = None
    requested_note: Optional[str] = None
    consumed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class WarehouseRequestResponse(BaseModel):
    item: StockItemOut
    telegram_sent: bool
    telegram_error: Optional[str] = None


class StockItemDetailOut(StockItemOut):
    movements: list[StockMovementOut] = []


class ReferenceLevelGroupOut(BaseModel):
    reference: str
    level: str
    total_quantity: int
    label_count: int
    requested_count: int
    requested_quantity: int
    oldest_created_at: datetime


class StockDashboardSummary(BaseModel):
    active_label_count: int
    active_total_quantity: int
    distinct_reference_count: int
    requested_label_count: int
    requested_total_quantity: int
    consumed_today_count: int
    consumed_today_quantity: int
    groups: list[ReferenceLevelGroupOut]


class StockDashboardViewOut(BaseModel):
    summary: StockDashboardSummary
    items: list[StockItemOut]


class ProductionMatchResult(BaseModel):
    query_reference: str
    query_level: Optional[str] = None
    exact_level_matches: list[StockItemOut]
    other_level_matches: list[StockItemOut]
    total_exact_quantity: int
    total_other_quantity: int


class SuggestionsOut(BaseModel):
    references: list[str]
    levels: list[str]


class AdminAuthRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=200)


class TelegramSettingsOut(BaseModel):
    telegram_chat_id: str
    has_bot_token: bool
    masked_bot_token: str


class TelegramSettingsUpdateRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=200)
    telegram_chat_id: str = Field(default="", max_length=100)
    telegram_bot_token: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Boş bırakılırsa mevcut token korunur, yeni token girilirse güncellenir",
    )
    clear_bot_token: bool = Field(default=False)


class TelegramTestRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=200)
    telegram_chat_id: Optional[str] = Field(default=None, max_length=100)
    telegram_bot_token: Optional[str] = Field(default=None, max_length=200)
