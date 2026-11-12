from datetime import datetime
from typing import Optional
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class StockItem(Base):
    __tablename__ = "stock_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    label_code: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    qr_payload: Mapped[str] = mapped_column(String(512), unique=True, index=True, nullable=False)

    reference: Mapped[str] = mapped_column(String(120), index=True, nullable=False)
    level: Mapped[str] = mapped_column(String(80), index=True, nullable=False)

    initial_quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    remaining_quantity: Mapped[int] = mapped_column(Integer, nullable=False)

    # Durumlar: IN_STOCK (Depoda), REQUESTED (Depodan Talep Edildi), CONSUMED (Stoktan Düşüldü)
    status: Mapped[str] = mapped_column(
        String(32), index=True, nullable=False, default="IN_STOCK"
    )

    location_note: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    created_by: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    requested_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    requested_note: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)

    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    movements: Mapped[list["StockMovement"]] = relationship(
        "StockMovement",
        back_populates="stock_item",
        cascade="all, delete-orphan",
        order_by="desc(StockMovement.created_at), desc(StockMovement.id)",
    )

    __table_args__ = (
        Index("ix_stock_items_ref_level_status", "reference", "level", "status"),
        CheckConstraint("initial_quantity > 0", name="ck_stock_items_initial_qty_pos"),
        CheckConstraint("remaining_quantity >= 0", name="ck_stock_items_remaining_qty_nonneg"),
    )


class StockMovement(Base):
    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    stock_item_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("stock_items.id", ondelete="CASCADE"), index=True, nullable=False
    )

    # CREATED, REQUESTED, CANCEL_REQUEST, DEDUCTED, PARTIAL_DEDUCTED, RESTORED, UPDATED
    action: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    quantity_change: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    quantity_before: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    quantity_after: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    note: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    stock_item: Mapped["StockItem"] = relationship("StockItem", back_populates="movements")


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
