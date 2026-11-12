from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import desc, or_, text
from sqlalchemy.orm import Session

from ..database import SessionLocal, get_db
from ..models import StockItem, StockMovement
from ..qr_utils import build_qr_payload, escape_like, extract_label_code, normalize_code
from ..schemas import (
    ProductionMatchRequest,
    ProductionMatchResult,
    ReferenceLevelGroupOut,
    ScanDeductRequest,
    StockCreateRequest,
    StockDashboardSummary,
    StockDashboardViewOut,
    StockItemDetailOut,
    StockItemOut,
    StockMovementWithItemOut,
    StockUpdateRequest,
    SuggestionsOut,
    WarehouseRequestPayload,
    WarehouseRequestResponse,
)
from ..telegram_service import (
    format_warehouse_cancel_message,
    format_warehouse_request_message,
    get_telegram_credentials,
    send_telegram_message,
)

router = APIRouter(prefix="/api/stock", tags=["stock"])

TR_TZ = timezone(timedelta(hours=3))


def _safe_note(text_val: Optional[str]) -> Optional[str]:
    if not text_val:
        return None
    cleaned = text_val.strip()
    if not cleaned:
        return None
    return cleaned[:250]


def _send_telegram_and_mark_movement(
    bot_token: str,
    chat_id: str,
    msg_html: str,
    movement_id: Optional[int] = None,
) -> None:
    ok, _ = send_telegram_message(bot_token, chat_id, msg_html)
    if ok and movement_id is not None:
        db = SessionLocal()
        try:
            mov = db.query(StockMovement).filter(StockMovement.id == movement_id).first()
            if mov:
                mov.note = _safe_note(f"{mov.note or ''} [Telegram iletildi]")
                db.commit()
        except Exception:
            db.rollback()
        finally:
            db.close()


def _prepare_filter_clauses(
    q: Optional[str] = None,
    reference: Optional[str] = None,
    level: Optional[str] = None,
    status: str = "ACTIVE",
    sort: str = "fifo",
    limit: int = 300,
) -> tuple[str, str, dict]:
    clauses: list[str] = []
    params: dict = {"limit": limit}

    status_upper = status.upper()
    if status_upper == "ACTIVE":
        clauses.append("status IN ('IN_STOCK', 'REQUESTED')")
    elif status_upper in ("IN_STOCK", "REQUESTED", "CONSUMED"):
        clauses.append("status = :status_val")
        params["status_val"] = status_upper

    if reference and reference.strip():
        params["ref_pat"] = f"%{escape_like(normalize_code(reference))}%"
        clauses.append("reference ILIKE :ref_pat ESCAPE '\\'")

    if level and level.strip():
        params["lvl_pat"] = f"%{escape_like(normalize_code(level))}%"
        clauses.append("level ILIKE :lvl_pat ESCAPE '\\'")

    if q and q.strip():
        raw_term = q.strip()
        norm_term = normalize_code(raw_term)
        params["q_norm"] = f"%{escape_like(norm_term)}%"
        params["q_raw"] = f"%{escape_like(raw_term)}%"
        extracted_code = extract_label_code(raw_term)

        q_parts = [
            "reference ILIKE :q_norm ESCAPE '\\'",
            "level ILIKE :q_norm ESCAPE '\\'",
            "label_code ILIKE :q_norm ESCAPE '\\'",
            "COALESCE(location_note, '') ILIKE :q_raw ESCAPE '\\'",
        ]
        if extracted_code and extracted_code != norm_term:
            params["q_code"] = extracted_code
            q_parts.append("label_code = :q_code")
        clauses.append("(" + " OR ".join(q_parts) + ")")

    where_sql = " AND ".join(clauses) if clauses else "TRUE"

    if sort == "fifo":
        order_sql = "created_at ASC, id ASC"
    elif sort == "qty_desc":
        order_sql = "remaining_quantity DESC, created_at ASC"
    elif sort == "ref_asc":
        order_sql = "reference ASC, level ASC, created_at ASC"
    else:
        order_sql = "created_at DESC, id DESC"

    return where_sql, order_sql, params


def _compute_dashboard_single_roundtrip(
    db: Session,
    q: Optional[str] = None,
    reference: Optional[str] = None,
    level: Optional[str] = None,
    status: str = "ACTIVE",
    sort: str = "fifo",
    limit: int = 300,
    include_items: bool = True,
) -> tuple[StockDashboardSummary, list[StockItemOut]]:
    """
    KPI sayaçlarını, Referans+Level grup özetini VE filtrelenmiş etiket listesini
    PostgreSQL'den YALNIZCA TEK BİR SQL SORGUSU (1 network round-trip) ile getirir!
    """
    now_tr = datetime.now(TR_TZ)
    start_of_day_tr = now_tr.replace(hour=0, minute=0, second=0, microsecond=0)

    where_sql, order_sql, params = _prepare_filter_clauses(
        q=q, reference=reference, level=level, status=status, sort=sort, limit=limit
    )
    params["start_of_day"] = start_of_day_tr

    group_filter_sql = ""
    if q and q.strip():
        params["grp_q"] = f"%{escape_like(normalize_code(q))}%"
        group_filter_sql = (
            " AND (reference ILIKE :grp_q ESCAPE '\\' OR level ILIKE :grp_q ESCAPE '\\')"
        )

    items_cte_sql = (
        f"""
        , filtered_items AS (
            SELECT
                id, label_code, qr_payload, reference, level,
                initial_quantity, remaining_quantity, status,
                location_note, created_by, requested_at, requested_note,
                consumed_at, created_at, updated_at
            FROM stock_items
            WHERE {where_sql}
            ORDER BY {order_sql}
            LIMIT :limit
        )
        """
        if include_items
        else ""
    )

    items_select_sql = (
        "COALESCE((SELECT json_agg(filtered_items) FROM filtered_items), '[]'::json) AS items_json"
        if include_items
        else "'[]'::json AS items_json"
    )

    sql = text(
        f"""
        WITH active_items AS (
            SELECT reference, level, remaining_quantity, status, created_at
            FROM stock_items
            WHERE status IN ('IN_STOCK', 'REQUESTED')
        ),
        kpis AS (
            SELECT
                COUNT(*)::int AS active_label_count,
                COALESCE(SUM(remaining_quantity), 0)::int AS active_total_quantity,
                COUNT(DISTINCT reference)::int AS distinct_reference_count,
                COUNT(*) FILTER (WHERE status = 'REQUESTED')::int AS requested_label_count,
                COALESCE(SUM(remaining_quantity) FILTER (WHERE status = 'REQUESTED'), 0)::int AS requested_total_quantity
            FROM active_items
        ),
        consumed AS (
            SELECT
                COUNT(*)::int AS consumed_today_count,
                COALESCE(SUM(ABS(quantity_change)), 0)::int AS consumed_today_quantity
            FROM stock_movements
            WHERE action IN ('DEDUCTED', 'PARTIAL_DEDUCTED')
              AND created_at >= :start_of_day
        ),
        grouped AS (
            SELECT
                reference,
                level,
                COALESCE(SUM(remaining_quantity), 0)::int AS total_quantity,
                COUNT(*)::int AS label_count,
                COUNT(*) FILTER (WHERE status = 'REQUESTED')::int AS requested_count,
                COALESCE(SUM(remaining_quantity) FILTER (WHERE status = 'REQUESTED'), 0)::int AS requested_quantity,
                MIN(created_at) AS oldest_created_at
            FROM active_items
            WHERE 1=1 {group_filter_sql}
            GROUP BY reference, level
            ORDER BY reference ASC, level ASC
        )
        {items_cte_sql}
        SELECT
            k.active_label_count,
            k.active_total_quantity,
            k.distinct_reference_count,
            k.requested_label_count,
            k.requested_total_quantity,
            c.consumed_today_count,
            c.consumed_today_quantity,
            COALESCE((SELECT json_agg(grouped) FROM grouped), '[]'::json) AS groups_json,
            {items_select_sql}
        FROM kpis k
        CROSS JOIN consumed c;
        """
    )

    row = db.execute(sql, params).mappings().one()
    raw_groups = row["groups_json"] or []
    raw_items = row["items_json"] or []

    groups = [
        ReferenceLevelGroupOut(
            reference=g["reference"],
            level=g["level"],
            total_quantity=int(g["total_quantity"]),
            label_count=int(g["label_count"]),
            requested_count=int(g["requested_count"]),
            requested_quantity=int(g["requested_quantity"]),
            oldest_created_at=g["oldest_created_at"],
        )
        for g in raw_groups
    ]

    summary = StockDashboardSummary(
        active_label_count=int(row["active_label_count"]),
        active_total_quantity=int(row["active_total_quantity"]),
        distinct_reference_count=int(row["distinct_reference_count"]),
        requested_label_count=int(row["requested_label_count"]),
        requested_total_quantity=int(row["requested_total_quantity"]),
        consumed_today_count=int(row["consumed_today_count"]),
        consumed_today_quantity=int(row["consumed_today_quantity"]),
        groups=groups,
    )

    items = [StockItemOut.model_validate(it) for it in raw_items]
    return summary, items


@router.post("", response_model=StockItemOut, status_code=201)
def create_stock_item(payload: StockCreateRequest, db: Session = Depends(get_db)):
    reference = normalize_code(payload.reference)
    level = normalize_code(payload.level)
    clean_loc = (
        payload.location_note.strip()
        if payload.location_note and payload.location_note.strip()
        else None
    )
    clean_by = (
        payload.created_by.strip()
        if payload.created_by and payload.created_by.strip()
        else None
    )
    mov_note = _safe_note(f"Depoya kaldırıldı ({clean_by or 'Paketleme'})")

    # Tek bir atomik SQL CTE ile sequence çek + stock_items ekle + stock_movements ekle + kaydı döndür (1 round-trip!)
    row = (
        db.execute(
            text(
                """
                WITH seq AS (
                    SELECT 'PKT-' || nextval('pkt_label_seq')::text AS code
                ),
                ins_item AS (
                    INSERT INTO stock_items (
                        label_code, qr_payload, reference, level,
                        initial_quantity, remaining_quantity, status,
                        location_note, created_by
                    )
                    SELECT
                        seq.code,
                        'PKT/' || seq.code || '/R-' || :safe_ref || '/L-' || :safe_lvl || '/Q-' || (:qty)::text,
                        :reference,
                        :level,
                        :qty,
                        :qty,
                        'IN_STOCK',
                        :loc_note,
                        :created_by
                    FROM seq
                    RETURNING *
                ),
                ins_mov AS (
                    INSERT INTO stock_movements (
                        stock_item_id, action, quantity_change, quantity_before, quantity_after, note
                    )
                    SELECT id, 'CREATED', :qty, 0, :qty, :mov_note
                    FROM ins_item
                )
                SELECT * FROM ins_item;
                """
            ),
            {
                "safe_ref": build_qr_payload("X", reference, level, payload.quantity)
                .split("/R-")[1]
                .split("/L-")[0],
                "safe_lvl": build_qr_payload("X", reference, level, payload.quantity)
                .split("/L-")[1]
                .split("/Q-")[0],
                "reference": reference,
                "level": level,
                "qty": payload.quantity,
                "loc_note": clean_loc,
                "created_by": clean_by,
                "mov_note": mov_note,
            },
        )
        .mappings()
        .one()
    )
    db.commit()
    return StockItemOut.model_validate(dict(row))


@router.get("/dashboard", response_model=StockDashboardViewOut)
def get_dashboard_combined(
    q: Optional[str] = Query(default=None),
    reference: Optional[str] = Query(default=None),
    level: Optional[str] = Query(default=None),
    status: str = Query(default="ACTIVE"),
    sort: str = Query(default="fifo"),
    limit: int = Query(default=300, ge=1, le=2000),
    db: Session = Depends(get_db),
):
    summary, items = _compute_dashboard_single_roundtrip(
        db,
        q=q,
        reference=reference,
        level=level,
        status=status,
        sort=sort,
        limit=limit,
        include_items=True,
    )
    return StockDashboardViewOut(summary=summary, items=items)


@router.get("", response_model=list[StockItemOut])
def list_stock_items(
    q: Optional[str] = Query(default=None, description="Referans, Level veya Etiket Kodu ara"),
    reference: Optional[str] = Query(default=None),
    level: Optional[str] = Query(default=None),
    status: str = Query(
        default="ACTIVE",
        description="ACTIVE (Depoda+Talep Edilen), IN_STOCK, REQUESTED, CONSUMED, ALL",
    ),
    sort: str = Query(default="newest", description="newest, fifo, qty_desc, ref_asc"),
    limit: int = Query(default=300, ge=1, le=2000),
    db: Session = Depends(get_db),
):
    where_sql, order_sql, params = _prepare_filter_clauses(
        q=q, reference=reference, level=level, status=status, sort=sort, limit=limit
    )
    rows = (
        db.execute(
            text(f"SELECT * FROM stock_items WHERE {where_sql} ORDER BY {order_sql} LIMIT :limit"),
            params,
        )
        .mappings()
        .all()
    )
    return [StockItemOut.model_validate(dict(r)) for r in rows]


@router.get("/summary", response_model=StockDashboardSummary)
def get_stock_summary(
    q: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    summary, _ = _compute_dashboard_single_roundtrip(db, q=q, include_items=False)
    return summary


@router.get("/suggestions", response_model=SuggestionsOut)
def get_suggestions(db: Session = Depends(get_db)):
    row = (
        db.execute(
            text(
                """
                SELECT
                    COALESCE((SELECT json_agg(r) FROM (SELECT DISTINCT reference AS r FROM stock_items ORDER BY reference ASC LIMIT 500) sub_r), '[]'::json) AS refs,
                    COALESCE((SELECT json_agg(l) FROM (SELECT DISTINCT level AS l FROM stock_items ORDER BY level ASC LIMIT 200) sub_l), '[]'::json) AS lvls;
                """
            )
        )
        .mappings()
        .one()
    )
    return SuggestionsOut(references=list(row["refs"]), levels=list(row["lvls"]))


@router.post("/match", response_model=list[ProductionMatchResult])
def match_production_references(
    payload: ProductionMatchRequest,
    db: Session = Depends(get_db),
):
    active_items = (
        db.query(StockItem)
        .filter(StockItem.status.in_(["IN_STOCK", "REQUESTED"]))
        .order_by(StockItem.created_at.asc(), StockItem.id.asc())
        .all()
    )

    results: list[ProductionMatchResult] = []

    for item in payload.queries:
        ref_norm = normalize_code(item.reference)
        if not ref_norm:
            continue
        lvl_norm = normalize_code(item.level) if item.level and item.level.strip() else None

        exact_ref_candidates = [c for c in active_items if c.reference == ref_norm]
        if exact_ref_candidates:
            candidates = exact_ref_candidates
        elif len(ref_norm) >= 4:
            candidates = [
                c
                for c in active_items
                if c.reference.startswith(ref_norm) or ref_norm in c.reference
            ]
        else:
            candidates = []

        if lvl_norm:
            exact = [c for c in candidates if c.level == lvl_norm]
            other = [c for c in candidates if c.level != lvl_norm]
        else:
            exact = candidates
            other = []

        results.append(
            ProductionMatchResult(
                query_reference=ref_norm,
                query_level=lvl_norm,
                exact_level_matches=exact,
                other_level_matches=other,
                total_exact_quantity=sum(c.remaining_quantity for c in exact),
                total_other_quantity=sum(c.remaining_quantity for c in other),
            )
        )

    return results


@router.get("/lookup", response_model=StockItemDetailOut)
def lookup_by_qr_or_code(
    code: str = Query(..., min_length=1, max_length=512, description="QR verisi veya etiket numarası"),
    db: Session = Depends(get_db),
):
    raw = code.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Okutulan kod boş olamaz.")
    extracted = extract_label_code(raw)

    item = (
        db.query(StockItem)
        .filter(
            or_(
                StockItem.qr_payload == raw,
                StockItem.label_code == extracted,
                StockItem.label_code == raw.upper(),
            )
        )
        .first()
    )

    if not item:
        raise HTTPException(
            status_code=404,
            detail=f"'{raw}' koduna ait etiket bulunamadı.",
        )

    return item


@router.post("/scan-deduct", response_model=StockItemDetailOut)
def scan_and_deduct_stock(
    payload: ScanDeductRequest,
    db: Session = Depends(get_db),
):
    raw = payload.qr_or_code.strip()
    extracted = extract_label_code(raw)

    item = (
        db.query(StockItem)
        .filter(
            or_(
                StockItem.qr_payload == raw,
                StockItem.label_code == extracted,
                StockItem.label_code == raw.upper(),
            )
        )
        .with_for_update()
        .first()
    )

    if not item:
        raise HTTPException(
            status_code=404,
            detail=f"Okutulan kod ({raw}) sistemde bulunamadı.",
        )

    if item.status == "CONSUMED" or item.remaining_quantity <= 0:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{item.label_code} ({item.reference} / Level {item.level}) etiketi zaten "
                f"daha önce stoktan düşülmüş!"
            ),
        )

    qty_before = item.remaining_quantity
    deduct_qty = payload.deduct_quantity if payload.deduct_quantity is not None else qty_before

    if deduct_qty > qty_before:
        raise HTTPException(
            status_code=400,
            detail=f"Etikette kalan miktar {qty_before} adet. {deduct_qty} adet düşülemez.",
        )

    qty_after = qty_before - deduct_qty
    item.remaining_quantity = qty_after

    now_utc = datetime.now(timezone.utc)
    if qty_after == 0:
        item.status = "CONSUMED"
        item.consumed_at = now_utc
        item.requested_at = None
        action_name = "DEDUCTED"
        default_note = "QR okutularak tamamı stoktan düşüldü"
    else:
        item.status = "IN_STOCK"
        item.requested_at = None
        item.requested_note = None
        item.qr_payload = build_qr_payload(item.label_code, item.reference, item.level, qty_after)
        action_name = "PARTIAL_DEDUCTED"
        default_note = f"Kısmi düşüm yapıldı ({deduct_qty} adet kullanıldı, {qty_after} adet kaldı)"

    movement = StockMovement(
        stock_item_id=item.id,
        action=action_name,
        quantity_change=-deduct_qty,
        quantity_before=qty_before,
        quantity_after=qty_after,
        note=_safe_note(payload.note) or default_note,
    )
    db.add(movement)
    db.commit()
    db.refresh(item)
    return item


@router.post("/{item_id}/request", response_model=WarehouseRequestResponse)
def request_from_warehouse(
    item_id: int,
    payload: WarehouseRequestPayload,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    item = (
        db.query(StockItem)
        .filter(StockItem.id == item_id)
        .with_for_update()
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Stok etiketi bulunamadı.")
    if item.status == "CONSUMED" or item.remaining_quantity <= 0:
        raise HTTPException(status_code=400, detail="Bu etiket zaten stoktan düşülmüş.")
    if item.status == "REQUESTED":
        raise HTTPException(status_code=400, detail="Bu etiket zaten talep edilmiş durumda.")

    now_utc = datetime.now(timezone.utc)
    item.status = "REQUESTED"
    item.requested_at = now_utc
    item.updated_at = now_utc
    item.requested_note = (
        payload.requested_note.strip()
        if payload.requested_note and payload.requested_note.strip()
        else None
    )

    bot_token, chat_id = get_telegram_credentials(db)
    has_tg_config = bool(bot_token and chat_id)

    msg_html = format_warehouse_request_message(
        label_code=item.label_code,
        reference=item.reference,
        level=item.level,
        remaining_quantity=item.remaining_quantity,
        location_note=item.location_note,
        requested_note=item.requested_note,
    )

    mov = StockMovement(
        stock_item_id=item.id,
        action="REQUESTED",
        quantity_change=0,
        quantity_before=item.remaining_quantity,
        quantity_after=item.remaining_quantity,
        note=_safe_note(
            f"Depodan talep edildi{f' ({item.requested_note})' if item.requested_note else ''}"
        ),
    )
    db.add(mov)
    db.flush()
    mov_id = mov.id
    resp_item = StockItemOut.model_validate(item)
    db.commit()

    if has_tg_config:
        background_tasks.add_task(
            _send_telegram_and_mark_movement,
            bot_token,
            chat_id,
            msg_html,
            mov_id,
        )
        tg_err = None
    else:
        tg_err = (
            "Telegram Bot Token tanımlanmamış."
            if not bot_token
            else "Telegram Grup Chat ID tanımlanmamış."
        )

    return WarehouseRequestResponse(
        item=resp_item,
        telegram_sent=has_tg_config,
        telegram_error=tg_err,
    )


@router.post("/{item_id}/cancel-request", response_model=StockItemOut)
def cancel_warehouse_request(
    item_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    item = (
        db.query(StockItem)
        .filter(StockItem.id == item_id)
        .with_for_update()
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Stok etiketi bulunamadı.")
    if item.status != "REQUESTED":
        raise HTTPException(status_code=400, detail="Bu etiket şu an talep durumunda değil.")

    item.status = "IN_STOCK"
    item.requested_at = None
    item.requested_note = None
    item.updated_at = datetime.now(timezone.utc)

    bot_token, chat_id = get_telegram_credentials(db)
    cancel_html = format_warehouse_cancel_message(
        label_code=item.label_code,
        reference=item.reference,
        level=item.level,
        remaining_quantity=item.remaining_quantity,
    )

    db.add(
        StockMovement(
            stock_item_id=item.id,
            action="CANCEL_REQUEST",
            quantity_change=0,
            quantity_before=item.remaining_quantity,
            quantity_after=item.remaining_quantity,
            note="Depo talebi iptal edildi, depoda bekliyor",
        )
    )
    resp_item = StockItemOut.model_validate(item)
    db.commit()

    if bot_token and chat_id:
        background_tasks.add_task(_send_telegram_and_mark_movement, bot_token, chat_id, cancel_html)

    return resp_item


@router.post("/{item_id}/restore", response_model=StockItemOut)
def restore_consumed_item(item_id: int, db: Session = Depends(get_db)):
    item = (
        db.query(StockItem)
        .filter(StockItem.id == item_id)
        .with_for_update()
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Stok etiketi bulunamadı.")
    if item.status != "CONSUMED":
        raise HTTPException(status_code=400, detail="Sadece stoktan düşülmüş etiketler geri alınabilir.")

    last_deduct = (
        db.query(StockMovement)
        .filter(
            StockMovement.stock_item_id == item.id,
            StockMovement.action == "DEDUCTED",
        )
        .order_by(desc(StockMovement.created_at), desc(StockMovement.id))
        .first()
    )
    restore_qty = (
        abs(last_deduct.quantity_change)
        if last_deduct and last_deduct.quantity_change != 0
        else item.initial_quantity
    )

    item.remaining_quantity = restore_qty
    item.status = "IN_STOCK"
    item.consumed_at = None
    item.requested_at = None
    item.requested_note = None
    item.updated_at = datetime.now(timezone.utc)
    item.qr_payload = build_qr_payload(item.label_code, item.reference, item.level, restore_qty)

    db.add(
        StockMovement(
            stock_item_id=item.id,
            action="RESTORED",
            quantity_change=restore_qty,
            quantity_before=0,
            quantity_after=restore_qty,
            note="Stok düşümü geri alındı (Stoğa iade)",
        )
    )
    resp_item = StockItemOut.model_validate(item)
    db.commit()
    return resp_item


@router.put("/{item_id}", response_model=StockItemOut)
def update_stock_item(
    item_id: int,
    payload: StockUpdateRequest,
    db: Session = Depends(get_db),
):
    item = (
        db.query(StockItem)
        .filter(StockItem.id == item_id)
        .with_for_update()
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Stok etiketi bulunamadı.")

    qty_before = item.remaining_quantity
    changes: list[str] = []

    if payload.reference is not None:
        new_ref = normalize_code(payload.reference)
        if new_ref != item.reference:
            changes.append(f"Ref: {item.reference}->{new_ref}")
            item.reference = new_ref

    if payload.level is not None:
        new_lvl = normalize_code(payload.level)
        if new_lvl != item.level:
            changes.append(f"Level: {item.level}->{new_lvl}")
            item.level = new_lvl

    if (
        payload.remaining_quantity is not None
        and payload.remaining_quantity != item.remaining_quantity
    ):
        changes.append(f"Adet: {item.remaining_quantity}->{payload.remaining_quantity}")
        item.remaining_quantity = payload.remaining_quantity
        if item.remaining_quantity > item.initial_quantity:
            item.initial_quantity = item.remaining_quantity
        if item.status == "CONSUMED" and item.remaining_quantity > 0:
            item.status = "IN_STOCK"
            item.consumed_at = None

    if payload.location_note is not None:
        new_loc = payload.location_note.strip() or None
        if new_loc != item.location_note:
            changes.append(f"Not: {item.location_note or '-'}->{new_loc or '-'}")
            item.location_note = new_loc

    item.updated_at = datetime.now(timezone.utc)
    item.qr_payload = build_qr_payload(
        item.label_code, item.reference, item.level, item.remaining_quantity
    )

    if changes:
        db.add(
            StockMovement(
                stock_item_id=item.id,
                action="UPDATED",
                quantity_change=item.remaining_quantity - qty_before,
                quantity_before=qty_before,
                quantity_after=item.remaining_quantity,
                note=_safe_note("Düzenlendi: " + ", ".join(changes)),
            )
        )

    resp_item = StockItemOut.model_validate(item)
    db.commit()
    return resp_item


@router.get("/movements", response_model=list[StockMovementWithItemOut])
def list_movements(
    limit: int = Query(default=150, ge=1, le=1000),
    q: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    query = db.query(StockMovement, StockItem).join(
        StockItem, StockMovement.stock_item_id == StockItem.id
    )

    if q and q.strip():
        raw_term = q.strip()
        escaped_norm = escape_like(normalize_code(raw_term))
        extracted = extract_label_code(raw_term)
        conds = [
            StockItem.reference.ilike(f"%{escaped_norm}%", escape="\\"),
            StockItem.level.ilike(f"%{escaped_norm}%", escape="\\"),
            StockItem.label_code.ilike(f"%{escaped_norm}%", escape="\\"),
        ]
        if extracted and extracted != escaped_norm:
            conds.append(StockItem.label_code == extracted)
        query = query.filter(or_(*conds))

    rows = (
        query.order_by(StockMovement.created_at.desc(), StockMovement.id.desc())
        .limit(limit)
        .all()
    )

    return [
        StockMovementWithItemOut(
            id=mov.id,
            stock_item_id=mov.stock_item_id,
            action=mov.action,
            quantity_change=mov.quantity_change,
            quantity_before=mov.quantity_before,
            quantity_after=mov.quantity_after,
            note=mov.note,
            created_at=mov.created_at,
            label_code=item.label_code,
            reference=item.reference,
            level=item.level,
        )
        for mov, item in rows
    ]
