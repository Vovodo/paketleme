from datetime import datetime, timedelta, timezone
import io
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import Response
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from sqlalchemy import desc, func, or_, text
from sqlalchemy.orm import Session

from ..database import SessionLocal, get_db
from ..models import StockItem, StockMovement
from ..qr_utils import (
    build_qr_payload,
    escape_like,
    extract_label_code,
    format_standard_level,
    level_key,
    normalize_code,
    parse_level_segments,
)
from ..schemas import (
    ProductionMatchRequest,
    ProductionMatchResult,
    ReferenceLevelGroupOut,
    ScanAutoResponse,
    ScanDeductRequest,
    ScanIncreaseRequest,
    ScanRestoreRequest,
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


def resolve_canonical_level(
    db: Session, raw_level: str, exclude_id: Optional[int] = None
) -> str:
    """
    Level yazımını standartlaştırır:
    - Tek parçalı leveller ('1-AA', '1 aa', '1/aa', 'p 07') her zaman bitişik ('1AA', 'P07') olur.
    - Çok parçalı leveller ('1ADp02', '1aa p05' vb.) veritabanında aynı parmak iziyle (level_key)
      daha önce kaydedilmişse ilk kaydedilen formatı ('1AD P02', '1AA-P05') alır; ilk kez giriliyorsa
      standart boşluklu ('1AD P02') olarak biçimlendirilir.
    """
    segs = parse_level_segments(raw_level)
    std = " ".join(segs)
    k = level_key(std)
    if not k:
        return normalize_code(raw_level)

    if len(segs) <= 1:
        return std

    sql = """
        SELECT level
        FROM stock_items
        WHERE regexp_replace(level, '[^A-Z0-9]', '', 'g') = :k
    """
    q_params: dict = {"k": k}
    if exclude_id is not None:
        sql += " AND id <> :exclude_id"
        q_params["exclude_id"] = exclude_id
    sql += " ORDER BY created_at ASC, id ASC LIMIT 1"

    existing = db.execute(text(sql), q_params).scalar()
    if existing:
        return str(existing)
    return std


def _build_level_filter_sql(
    raw_level: str,
    params: dict,
    status_upper: str = "ACTIVE",
    param_prefix: str = "lvl",
) -> Optional[str]:
    lvl_k = level_key(raw_level)
    if not lvl_k:
        return None

    has_trailing_sep = bool(raw_level) and (
        raw_level[-1].isspace() or raw_level[-1] in "-/_."
    )
    key_param = f"{param_prefix}_key"
    pfx_param = f"{param_prefix}_pfx"
    params[key_param] = lvl_k
    params[pfx_param] = f"{escape_like(lvl_k)}%"

    expr = "regexp_replace(level, '[^A-Z0-9]', '', 'g')"
    if has_trailing_sep or len(lvl_k) < 2:
        return f"{expr} LIKE :{pfx_param} ESCAPE '\\'"

    if status_upper == "ACTIVE":
        scope_sql = "sx.status IN ('IN_STOCK', 'REQUESTED') AND "
    elif status_upper in ("IN_STOCK", "REQUESTED", "CONSUMED"):
        params[f"{param_prefix}_st"] = status_upper
        scope_sql = f"sx.status = :{param_prefix}_st AND "
    else:
        scope_sql = ""

    return (
        f"(CASE WHEN EXISTS (SELECT 1 FROM stock_items sx WHERE {scope_sql}"
        f"regexp_replace(sx.level, '[^A-Z0-9]', '', 'g') = :{key_param}) "
        f"THEN {expr} = :{key_param} "
        f"ELSE {expr} LIKE :{pfx_param} ESCAPE '\\' END)"
    )


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
        lvl_clause = _build_level_filter_sql(level, params, status_upper=status_upper, param_prefix="lvl")
        if lvl_clause:
            clauses.append(lvl_clause)

    if q and q.strip():
        raw_term = q.strip()
        norm_term = normalize_code(raw_term)
        q_lvl_k = level_key(raw_term)
        params["q_norm"] = f"%{escape_like(norm_term)}%"
        params["q_raw"] = f"%{escape_like(raw_term)}%"
        extracted_code = extract_label_code(raw_term)

        q_parts = [
            "reference ILIKE :q_norm ESCAPE '\\'",
            "label_code ILIKE :q_norm ESCAPE '\\'",
            "COALESCE(location_note, '') ILIKE :q_raw ESCAPE '\\'",
            "COALESCE(created_by, '') ILIKE :q_raw ESCAPE '\\'",
        ]
        if q_lvl_k:
            # Önek eşleşmesi: 'P07' arandığında '1AD P07' gelmez, ama '1adp02' veya '1-aa' arandığında eşleşir
            params["q_lvl_pfx"] = f"{escape_like(q_lvl_k)}%"
            q_parts.append("regexp_replace(level, '[^A-Z0-9]', '', 'g') LIKE :q_lvl_pfx ESCAPE '\\'")
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
        grp_lvl_k = level_key(q)
        if grp_lvl_k:
            params["grp_lvl_pfx"] = f"{escape_like(grp_lvl_k)}%"
            group_filter_sql = (
                " AND (reference ILIKE :grp_q ESCAPE '\\' "
                "OR regexp_replace(level, '[^A-Z0-9]', '', 'g') LIKE :grp_lvl_pfx ESCAPE '\\')"
            )
        else:
            group_filter_sql = " AND reference ILIKE :grp_q ESCAPE '\\'"

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
    lvl_segs = parse_level_segments(payload.level)
    default_level = " ".join(lvl_segs) if lvl_segs else format_standard_level(payload.level)
    lvl_k = level_key(default_level)
    allow_db_lookup = len(lvl_segs) > 1

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

    # Tek bir atomik SQL CTE ile:
    # 1) Daha önce kaydedilmiş eşdeğer level varsa onun yazımını çöz (0 ekstra round-trip)
    # 2) Sequence çek + stock_items ekle + stock_movements ekle + kaydı döndür
    row = (
        db.execute(
            text(
                """
                WITH canonical_lvl AS (
                    SELECT COALESCE(
                        (
                            SELECT s.level
                            FROM stock_items s
                            WHERE :allow_db_lookup
                              AND regexp_replace(s.level, '[^A-Z0-9]', '', 'g') = :lvl_key
                            ORDER BY s.created_at ASC, s.id ASC
                            LIMIT 1
                        ),
                        :default_level
                    ) AS resolved_level
                ),
                seq AS (
                    SELECT
                        'PKT-' || nextval('pkt_label_seq')::text AS code,
                        canonical_lvl.resolved_level AS lvl,
                        COALESCE(
                            NULLIF(
                                BTRIM(
                                    regexp_replace(canonical_lvl.resolved_level, '[^A-Z0-9._-]', '-', 'g'),
                                    '-'
                                ),
                                ''
                            ),
                            'LVL'
                        ) AS safe_lvl
                    FROM canonical_lvl
                ),
                ins_item AS (
                    INSERT INTO stock_items (
                        label_code, qr_payload, reference, level,
                        initial_quantity, remaining_quantity, status,
                        location_note, created_by
                    )
                    SELECT
                        seq.code,
                        'PKT/' || seq.code || '/R-' || :safe_ref || '/L-' || seq.safe_lvl || '/Q-' || (:qty)::text,
                        :reference,
                        seq.lvl,
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
                "allow_db_lookup": allow_db_lookup,
                "lvl_key": lvl_k,
                "default_level": default_level,
                "safe_ref": build_qr_payload("X", reference, default_level, payload.quantity)
                .split("/R-")[1]
                .split("/L-")[0],
                "reference": reference,
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
                    COALESCE(
                        (
                            SELECT json_agg(r)
                            FROM (
                                SELECT DISTINCT reference AS r
                                FROM stock_items
                                WHERE status IN ('IN_STOCK', 'REQUESTED')
                                  AND remaining_quantity > 0
                                ORDER BY reference ASC
                                LIMIT 500
                            ) sub_r
                        ),
                        '[]'::json
                    ) AS refs,
                    COALESCE(
                        (
                            SELECT json_agg(l)
                            FROM (
                                SELECT DISTINCT level AS l
                                FROM stock_items
                                WHERE status IN ('IN_STOCK', 'REQUESTED')
                                  AND remaining_quantity > 0
                                ORDER BY level ASC
                                LIMIT 200
                            ) sub_l
                        ),
                        '[]'::json
                    ) AS lvls,
                    COALESCE(
                        (
                            SELECT json_agg(loc_display)
                            FROM (
                                SELECT
                                    (ARRAY_AGG(BTRIM(location_note) ORDER BY LENGTH(location_note) - LENGTH(TRANSLATE(location_note, 'İÜÖÇĞŞA-Z', '')) DESC, created_at DESC, id DESC))[1] AS loc_display,
                                    COUNT(*) AS cnt,
                                    MAX(created_at) AS last_used
                                FROM stock_items
                                WHERE location_note IS NOT NULL
                                  AND BTRIM(location_note) <> ''
                                GROUP BY UPPER(TRANSLATE(BTRIM(location_note), 'iıİIşŞğĞüÜöÖçÇ', 'IIIISSGGUUOOCC'))
                                ORDER BY cnt DESC, last_used DESC
                                LIMIT 5
                            ) sub_loc
                        ),
                        '[]'::json
                    ) AS top_locs,
                    COALESCE(
                        (
                            SELECT json_agg(op_display)
                            FROM (
                                SELECT
                                    (ARRAY_AGG(BTRIM(created_by) ORDER BY created_at DESC, id DESC))[1] AS op_display,
                                    COUNT(*) AS cnt,
                                    MAX(created_at) AS last_used
                                FROM stock_items
                                WHERE created_by IS NOT NULL
                                  AND BTRIM(created_by) <> ''
                                GROUP BY UPPER(TRANSLATE(BTRIM(created_by), 'iıİIşŞğĞüÜöÖçÇ', 'IIIISSGGUUOOCC'))
                                ORDER BY cnt DESC, last_used DESC
                                LIMIT 5
                            ) sub_op
                        ),
                        '[]'::json
                    ) AS top_ops;
                """
            )
        )
        .mappings()
        .one()
    )
    return SuggestionsOut(
        references=list(row["refs"]),
        levels=list(row["lvls"]),
        top_locations=list(row["top_locs"]),
        top_operators=list(row["top_ops"]),
    )


def _set_str_cell(ws, row_idx: int, col_idx: int, val: Optional[str]):
    cell = ws.cell(row=row_idx, column=col_idx)
    text_val = "" if val is None else str(val)
    cell.value = text_val
    cell.data_type = "s"
    return cell


def _fmt_tr_dt(dt_val: Optional[datetime]) -> str:
    if not dt_val:
        return ""
    if dt_val.tzinfo is None:
        dt_val = dt_val.replace(tzinfo=timezone.utc)
    return dt_val.astimezone(TR_TZ).strftime("%d.%m.%Y %H:%M")


@router.get("/export.xlsx")
def export_stock_excel(
    q: Optional[str] = Query(default=None, description="Arama terimi"),
    reference: Optional[str] = Query(default=None),
    level: Optional[str] = Query(default=None),
    status: str = Query(
        default="ACTIVE",
        description="ACTIVE (Depoda+Talep Edilen), IN_STOCK, REQUESTED, CONSUMED, ALL",
    ),
    sort: str = Query(default="fifo", description="fifo, newest, qty_desc, ref_asc"),
    db: Session = Depends(get_db),
):
    now_utc = datetime.now(timezone.utc)
    now_tr = now_utc.astimezone(TR_TZ)

    where_sql, order_sql, params = _prepare_filter_clauses(
        q=q, reference=reference, level=level, status=status, sort=sort, limit=50000
    )
    item_rows = (
        db.execute(
            text(f"SELECT * FROM stock_items WHERE {where_sql} ORDER BY {order_sql} LIMIT :limit"),
            params,
        )
        .mappings()
        .all()
    )

    grp_params: dict = {}
    grp_filter_sql = ""
    if q and q.strip():
        grp_params["grp_q"] = f"%{escape_like(normalize_code(q))}%"
        grp_q_lvl_k = level_key(q)
        if grp_q_lvl_k:
            grp_params["grp_q_lvl_pfx"] = f"{escape_like(grp_q_lvl_k)}%"
            grp_filter_sql = (
                " AND (reference ILIKE :grp_q ESCAPE '\\' "
                "OR regexp_replace(level, '[^A-Z0-9]', '', 'g') LIKE :grp_q_lvl_pfx ESCAPE '\\')"
            )
        else:
            grp_filter_sql = " AND reference ILIKE :grp_q ESCAPE '\\'"
    if level and level.strip():
        grp_lvl_clause = _build_level_filter_sql(level, grp_params, status_upper="ACTIVE", param_prefix="grp_lvl")
        if grp_lvl_clause:
            grp_filter_sql += f" AND {grp_lvl_clause}"

    group_rows = (
        db.execute(
            text(
                f"""
                SELECT
                    reference,
                    level,
                    COALESCE(SUM(remaining_quantity), 0)::int AS total_quantity,
                    COUNT(*)::int AS label_count,
                    COUNT(*) FILTER (WHERE status = 'REQUESTED')::int AS requested_count,
                    COALESCE(SUM(remaining_quantity) FILTER (WHERE status = 'REQUESTED'), 0)::int AS requested_quantity,
                    MIN(created_at) AS oldest_created_at
                FROM stock_items
                WHERE status IN ('IN_STOCK', 'REQUESTED'){grp_filter_sql}
                GROUP BY reference, level
                ORDER BY reference ASC, level ASC
                """
            ),
            grp_params,
        )
        .mappings()
        .all()
    )

    wb = Workbook()

    header_fill = PatternFill(start_color="0F172A", end_color="0F172A", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    body_font = Font(name="Calibri", size=10, color="0F172A")
    bold_font = Font(name="Calibri", size=10, bold=True, color="0F172A")
    total_fill = PatternFill(start_color="E2E8F0", end_color="E2E8F0", fill_type="solid")
    thin_side = Side(style="thin", color="CBD5E1")
    cell_border = Border(left=thin_side, right=thin_side, top=thin_side, bottom=thin_side)

    status_tr_map = {
        "IN_STOCK": "Depoda",
        "REQUESTED": "Talep Edildi",
        "CONSUMED": "Kullanıldı (Arşiv)",
    }
    status_fill_map = {
        "IN_STOCK": PatternFill(start_color="DCFCE7", end_color="DCFCE7", fill_type="solid"),
        "REQUESTED": PatternFill(start_color="FEF3C7", end_color="FEF3C7", fill_type="solid"),
        "CONSUMED": PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid"),
    }

    # --- SAYFA 1: Stok Etiket Listesi ---
    ws_items = wb.active
    ws_items.title = "Stok Etiketleri"
    item_headers = [
        ("Etiket Kodu", 16),
        ("Referans", 24),
        ("Level", 16),
        ("Mevcut Adet", 14),
        ("İlk Basılan Adet", 16),
        ("Durum", 18),
        ("Konum / Not", 26),
        ("Talep Notu", 24),
        ("Kaydeden", 16),
        ("Depoya Giriş (TR)", 19),
        ("Bekleme (Gün)", 15),
        ("Stoktan Düşülme (TR)", 21),
    ]

    for col_idx, (title, width) in enumerate(item_headers, start=1):
        c = ws_items.cell(row=1, column=col_idx, value=title)
        c.font = header_font
        c.fill = header_fill
        c.alignment = Alignment(horizontal="center" if col_idx in (4, 5, 6, 11) else "left", vertical="center")
        c.border = cell_border
        ws_items.column_dimensions[get_column_letter(col_idx)].width = width
    ws_items.row_dimensions[1].height = 24
    ws_items.freeze_panes = "A2"

    for idx, r in enumerate(item_rows, start=2):
        created_dt = r["created_at"]
        if created_dt and created_dt.tzinfo is None:
            created_dt = created_dt.replace(tzinfo=timezone.utc)
        end_dt = r["consumed_at"] if r["status"] == "CONSUMED" and r["consumed_at"] else now_utc
        if end_dt and end_dt.tzinfo is None:
            end_dt = end_dt.replace(tzinfo=timezone.utc)
        age_days = max(0, int((end_dt - created_dt).total_seconds() // 86400)) if created_dt else 0

        st_code = r["status"]
        _set_str_cell(ws_items, idx, 1, r["label_code"]).font = bold_font
        _set_str_cell(ws_items, idx, 2, r["reference"]).font = bold_font
        _set_str_cell(ws_items, idx, 3, r["level"]).font = body_font

        c_rem = ws_items.cell(row=idx, column=4, value=int(r["remaining_quantity"]))
        c_rem.font = bold_font
        c_rem.number_format = "#,##0"
        c_rem.alignment = Alignment(horizontal="right")

        c_init = ws_items.cell(row=idx, column=5, value=int(r["initial_quantity"]))
        c_init.font = body_font
        c_init.number_format = "#,##0"
        c_init.alignment = Alignment(horizontal="right")

        c_st = _set_str_cell(ws_items, idx, 6, status_tr_map.get(st_code, st_code))
        c_st.font = bold_font
        c_st.alignment = Alignment(horizontal="center")
        if st_code in status_fill_map:
            c_st.fill = status_fill_map[st_code]

        _set_str_cell(ws_items, idx, 7, r["location_note"] or "").font = body_font
        _set_str_cell(ws_items, idx, 8, r["requested_note"] or "").font = body_font
        _set_str_cell(ws_items, idx, 9, r["created_by"] or "").font = body_font
        _set_str_cell(ws_items, idx, 10, _fmt_tr_dt(r["created_at"])).font = body_font

        c_age = ws_items.cell(row=idx, column=11, value=age_days)
        c_age.font = body_font
        c_age.alignment = Alignment(horizontal="center")

        _set_str_cell(ws_items, idx, 12, _fmt_tr_dt(r["consumed_at"])).font = body_font

        for col_i in range(1, 13):
            ws_items.cell(row=idx, column=col_i).border = cell_border

    last_item_row = max(1, len(item_rows) + 1)
    ws_items.auto_filter.ref = f"A1:L{last_item_row}"

    # --- SAYFA 2: Referans & Level Grup Özeti ---
    ws_grp = wb.create_sheet(title="Referans Level Özeti")
    grp_headers = [
        ("Referans", 26),
        ("Level", 18),
        ("Toplam Mevcut Adet", 20),
        ("Aktif Etiket Sayısı", 19),
        ("Talep Edilen Etiket", 19),
        ("Talep Edilen Adet", 19),
        ("En Eski Giriş (FIFO)", 21),
        ("En Eski Bekleme (Gün)", 21),
    ]

    for col_idx, (title, width) in enumerate(grp_headers, start=1):
        c = ws_grp.cell(row=1, column=col_idx, value=title)
        c.font = header_font
        c.fill = header_fill
        c.alignment = Alignment(horizontal="center" if col_idx in (3, 4, 5, 6, 8) else "left", vertical="center")
        c.border = cell_border
        ws_grp.column_dimensions[get_column_letter(col_idx)].width = width
    ws_grp.row_dimensions[1].height = 24
    ws_grp.freeze_panes = "A2"

    sum_qty = 0
    sum_labels = 0
    sum_req_labels = 0
    sum_req_qty = 0

    for idx, g in enumerate(group_rows, start=2):
        oldest_dt = g["oldest_created_at"]
        if oldest_dt and oldest_dt.tzinfo is None:
            oldest_dt = oldest_dt.replace(tzinfo=timezone.utc)
        oldest_days = max(0, int((now_utc - oldest_dt).total_seconds() // 86400)) if oldest_dt else 0

        tot_q = int(g["total_quantity"])
        lbl_c = int(g["label_count"])
        req_c = int(g["requested_count"])
        req_q = int(g["requested_quantity"])
        sum_qty += tot_q
        sum_labels += lbl_c
        sum_req_labels += req_c
        sum_req_qty += req_q

        _set_str_cell(ws_grp, idx, 1, g["reference"]).font = bold_font
        _set_str_cell(ws_grp, idx, 2, g["level"]).font = bold_font

        c3 = ws_grp.cell(row=idx, column=3, value=tot_q)
        c3.font = bold_font
        c3.number_format = "#,##0"
        c3.alignment = Alignment(horizontal="right")

        c4 = ws_grp.cell(row=idx, column=4, value=lbl_c)
        c4.font = body_font
        c4.alignment = Alignment(horizontal="center")

        c5 = ws_grp.cell(row=idx, column=5, value=req_c)
        c5.font = body_font
        c5.alignment = Alignment(horizontal="center")

        c6 = ws_grp.cell(row=idx, column=6, value=req_q)
        c6.font = body_font
        c6.number_format = "#,##0"
        c6.alignment = Alignment(horizontal="right")

        _set_str_cell(ws_grp, idx, 7, _fmt_tr_dt(oldest_dt)).font = body_font

        c8 = ws_grp.cell(row=idx, column=8, value=oldest_days)
        c8.font = body_font
        c8.alignment = Alignment(horizontal="center")

        for col_i in range(1, 9):
            ws_grp.cell(row=idx, column=col_i).border = cell_border

    last_grp_row = max(1, len(group_rows) + 1)
    ws_grp.auto_filter.ref = f"A1:H{last_grp_row}"

    if group_rows:
        tot_row = last_grp_row + 2
        _set_str_cell(ws_grp, tot_row, 1, "GENEL TOPLAM").font = bold_font
        _set_str_cell(ws_grp, tot_row, 2, f"{len(group_rows)} Grup").font = bold_font
        ct3 = ws_grp.cell(row=tot_row, column=3, value=sum_qty)
        ct3.font = bold_font
        ct3.number_format = "#,##0"
        ct4 = ws_grp.cell(row=tot_row, column=4, value=sum_labels)
        ct4.font = bold_font
        ct4.alignment = Alignment(horizontal="center")
        ct5 = ws_grp.cell(row=tot_row, column=5, value=sum_req_labels)
        ct5.font = bold_font
        ct5.alignment = Alignment(horizontal="center")
        ct6 = ws_grp.cell(row=tot_row, column=6, value=sum_req_qty)
        ct6.font = bold_font
        ct6.number_format = "#,##0"
        for col_i in range(1, 9):
            cell_t = ws_grp.cell(row=tot_row, column=col_i)
            cell_t.fill = total_fill
            cell_t.border = cell_border

    buf = io.BytesIO()
    wb.save(buf)
    filename = f"paketleme_stok_{now_tr.strftime('%Y-%m-%d_%H%M')}.xlsx"

    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


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
        raw_lvl = item.level.strip() if item.level and item.level.strip() else None
        lvl_display = resolve_canonical_level(db, raw_lvl) if raw_lvl else None
        lvl_k = level_key(raw_lvl) if raw_lvl else None

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

        if lvl_k:
            exact = [c for c in candidates if level_key(c.level) == lvl_k]
            other = [c for c in candidates if level_key(c.level) != lvl_k]
        else:
            exact = candidates
            other = []

        results.append(
            ProductionMatchResult(
                query_reference=ref_norm,
                query_level=lvl_display,
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


@router.post("/scan-increase", response_model=StockItemDetailOut)
def scan_and_increase_stock(
    payload: ScanIncreaseRequest,
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

    qty_before = item.remaining_quantity
    add_qty = payload.add_quantity
    qty_after = qty_before + add_qty

    if qty_after > 100000:
        raise HTTPException(
            status_code=400,
            detail=f"Toplam miktar 100.000 adedi aşamaz (Mevcut: {qty_before}, Eklenen: {add_qty}).",
        )

    now_utc = datetime.now(timezone.utc)
    item.remaining_quantity = qty_after
    if qty_after > item.initial_quantity:
        item.initial_quantity = qty_after
    if item.status == "CONSUMED":
        item.status = "IN_STOCK"
        item.consumed_at = None
    item.updated_at = now_utc
    item.qr_payload = build_qr_payload(item.label_code, item.reference, item.level, qty_after)

    default_note = f"Miktar artırıldı (+{add_qty} adet eklendi, yeni mevcut: {qty_after} adet)"
    db.add(
        StockMovement(
            stock_item_id=item.id,
            action="INCREASED",
            quantity_change=add_qty,
            quantity_before=qty_before,
            quantity_after=qty_after,
            note=_safe_note(payload.note) or default_note,
        )
    )
    db.commit()
    db.refresh(item)
    return item


def _restore_consumed_item_in_tx(
    db: Session, item: StockItem, note: Optional[str] = None
) -> int:
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
            note=_safe_note(note) or "Stok düşümü geri alındı (Stoğa iade)",
        )
    )
    return restore_qty


@router.post("/scan-restore", response_model=StockItemDetailOut)
def scan_and_restore_stock(
    payload: ScanRestoreRequest,
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

    if item.status != "CONSUMED":
        raise HTTPException(
            status_code=400,
            detail=(
                f"{item.label_code} ({item.reference} / Level {item.level}) etiketi zaten "
                f"depoda aktif ({item.remaining_quantity} adet). Sadece stoktan düşülmüş etiketler geri alınabilir."
            ),
        )

    _restore_consumed_item_in_tx(
        db,
        item,
        note=payload.note or "QR okutularak stok düşümü geri alındı (Stoğa iade)",
    )
    db.commit()
    db.refresh(item)
    return item


@router.post("/scan-auto", response_model=ScanAutoResponse)
def scan_auto_deduct_or_restore(
    payload: ScanRestoreRequest,
    db: Session = Depends(get_db),
):
    """
    Hızlı barkod modunda tek sorguda atomik işlem:
    - Etiket aktifse tamamını stoktan düşer (DEDUCTED).
    - Etiket daha önce düşülmüşse (CONSUMED) tekrar okutulduğunda stoğa geri alır (RESTORED).
    - 1.2 saniyelik çift okutma (barkod okuyucu tetik sekmesi) koruması içerir.
    """
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

    now_utc = datetime.now(timezone.utc)

    if item.status == "CONSUMED" or item.remaining_quantity <= 0:
        if item.consumed_at:
            cons_dt = (
                item.consumed_at
                if item.consumed_at.tzinfo is not None
                else item.consumed_at.replace(tzinfo=timezone.utc)
            )
            if (now_utc - cons_dt).total_seconds() < 1.2:
                raise HTTPException(
                    status_code=409,
                    detail="Çift okutma koruması: Etiket az önce stoktan düşüldü. Geri almak için 1 saniye bekleyip tekrar okutun.",
                )

        restored_qty = _restore_consumed_item_in_tx(
            db,
            item,
            note=payload.note or "Etiket tekrar okutularak stoğa geri alındı",
        )
        db.commit()
        db.refresh(item)
        return ScanAutoResponse(
            action_performed="RESTORED",
            quantity_changed=restored_qty,
            item=item,
        )

    # Yeni geri alınmış bir etiketin 1.2sn içinde kazara çift okutmayla tekrar düşülmesini önle
    last_mov = (
        db.query(StockMovement)
        .filter(StockMovement.stock_item_id == item.id)
        .order_by(desc(StockMovement.created_at), desc(StockMovement.id))
        .first()
    )
    if last_mov and last_mov.action == "RESTORED" and last_mov.created_at:
        mov_dt = (
            last_mov.created_at
            if last_mov.created_at.tzinfo is not None
            else last_mov.created_at.replace(tzinfo=timezone.utc)
        )
        if (now_utc - mov_dt).total_seconds() < 1.2:
            raise HTTPException(
                status_code=409,
                detail="Çift okutma koruması: Etiket az önce stoğa geri alındı. Tekrar düşmek için 1 saniye bekleyip okutun.",
            )

    deduct_qty = item.remaining_quantity
    item.remaining_quantity = 0
    item.status = "CONSUMED"
    item.consumed_at = now_utc
    item.requested_at = None
    item.updated_at = now_utc

    db.add(
        StockMovement(
            stock_item_id=item.id,
            action="DEDUCTED",
            quantity_change=-deduct_qty,
            quantity_before=deduct_qty,
            quantity_after=0,
            note=_safe_note(payload.note) or "QR okutularak tamamı stoktan düşüldü",
        )
    )
    db.commit()
    db.refresh(item)
    return ScanAutoResponse(
        action_performed="DEDUCTED",
        quantity_changed=deduct_qty,
        item=item,
    )


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
        new_lvl = resolve_canonical_level(db, payload.level, exclude_id=item.id)
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

    if payload.created_by is not None:
        new_op = payload.created_by.strip() or None
        if new_op != item.created_by:
            changes.append(f"Personel/Hat: {item.created_by or '-'}->{new_op or '-'}")
            item.created_by = new_op

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
        mov_lvl_k = level_key(raw_term)
        extracted = extract_label_code(raw_term)
        conds = [
            StockItem.reference.ilike(f"%{escaped_norm}%", escape="\\"),
            StockItem.label_code.ilike(f"%{escaped_norm}%", escape="\\"),
        ]
        if mov_lvl_k:
            conds.append(
                func.regexp_replace(StockItem.level, "[^A-Z0-9]", "", "g").like(
                    f"{escape_like(mov_lvl_k)}%", escape="\\"
                )
            )
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
