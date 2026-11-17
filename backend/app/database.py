import logging
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from psycopg import connect

from .config import settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


def ensure_database_exists() -> None:
    """Hedef PostgreSQL veritabanı henüz mevcut değilse otomatik oluşturur."""
    url = make_url(settings.sqlalchemy_database_url)
    target_db = url.database
    if not target_db or target_db == "postgres":
        return

    admin_dsn = (
        f"postgresql://{url.username}:{url.password}@{url.host}:{url.port or 5432}/postgres"
    )
    try:
        with connect(admin_dsn, autocommit=True, connect_timeout=10) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM pg_database WHERE datname = %s",
                    (target_db,),
                )
                exists = cur.fetchone()
                if not exists:
                    safe_db_name = target_db.replace('"', '""')
                    cur.execute(f'CREATE DATABASE "{safe_db_name}" ENCODING \'UTF8\'')
                    logger.info("PostgreSQL veritabanı oluşturuldu: %s", target_db)
    except Exception as exc:
        logger.warning("Veritabanı varlık kontrolü atlandı (%s): %s", target_db, exc)


# Yüksek performanslı kalıcı bağlantı havuzu:
# pool_pre_ping kapalı tutularak her API isteğinde ekstra uzak sunucu ping turu (RTT) engellenir,
# pool_recycle ile bayat bağlantılar otomatik yenilenir.
engine = create_engine(
    settings.sqlalchemy_database_url,
    pool_pre_ping=False,
    pool_size=12,
    max_overflow=24,
    pool_recycle=600,
    pool_timeout=15,
    connect_args={"connect_timeout": 8},
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _normalize_existing_levels(conn) -> None:
    """
    Mevcut tablodaki yazım farklılığı olan level kayıtlarını tekilleştirir:
    - Tek parçalı levellerde ('1 AA', '1-AA' -> '1AA'; '1 AD' -> '1AD') standart bitişik formu uygular.
    - Çok parçalı levellerde ('1AA-P05', '1AD P02' vb.) aynı parmak izine sahip en eski kaydın formatını korur.
    """
    from .qr_utils import build_qr_payload, format_standard_level, level_key, parse_level_segments

    rows = (
        conn.execute(
            text(
                """
                SELECT id, label_code, reference, level, remaining_quantity, initial_quantity
                FROM stock_items
                ORDER BY created_at ASC, id ASC
                """
            )
        )
        .mappings()
        .all()
    )
    if not rows:
        return

    canonical_by_key: dict[str, str] = {}
    updates: list[dict] = []

    for r in rows:
        raw_lvl = r["level"] or ""
        k = level_key(raw_lvl)
        if not k:
            continue

        if k not in canonical_by_key:
            segs = parse_level_segments(raw_lvl)
            if len(segs) <= 1:
                canonical_by_key[k] = format_standard_level(raw_lvl)
            else:
                # İlk kaydedilen çok parçalı level tek parçalı iç boşluk içeriyorsa temizle (örn. '1 AD P 02' -> '1AD P02'),
                # aksi halde tireli/boşluklu ilk tercihi ('1AA-P05' veya '1AD P02') koru
                norm_first = raw_lvl.strip()
                if "-" in norm_first and len(segs) == 2 and norm_first == f"{segs[0]}-{segs[1]}":
                    canonical_by_key[k] = norm_first
                elif norm_first == "".join(segs):
                    canonical_by_key[k] = norm_first
                else:
                    canonical_by_key[k] = " ".join(segs)

        target_lvl = canonical_by_key[k]
        if raw_lvl != target_lvl:
            qty_for_qr = (
                int(r["remaining_quantity"])
                if int(r["remaining_quantity"]) > 0
                else int(r["initial_quantity"])
            )
            new_qr = build_qr_payload(r["label_code"], r["reference"], target_lvl, qty_for_qr)
            updates.append({"id": r["id"], "lvl": target_lvl, "qr": new_qr})

    if updates:
        conn.execute(
            text("UPDATE stock_items SET level = :lvl, qr_payload = :qr WHERE id = :id"),
            updates,
        )
        logger.info("Mevcut %d stok kaydının Level bilgisi standartlaştırıldı.", len(updates))


def init_db() -> None:
    from . import models  # noqa: F401

    ensure_database_exists()
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        conn.execute(
            text("CREATE SEQUENCE IF NOT EXISTS pkt_label_seq START WITH 100001 INCREMENT BY 1;")
        )
        conn.execute(
            text("ALTER TABLE stock_items ALTER COLUMN qr_payload TYPE VARCHAR(512);")
        )
        conn.execute(
            text("ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS transferred_to VARCHAR(120);")
        )
        conn.execute(
            text("ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ;")
        )

        # Mevcut veritabanındaki bölünmüş Level kayıtlarını (örn: '1 AA' -> '1AA', '1 AD' -> '1AD') birleştir
        _normalize_existing_levels(conn)

        # 1. Aktif stoklar (Depoda + Talep + Transfer) için FIFO ve En Yeni sıralamalı kısmi indeksler
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_stock_active_v2_fifo "
                "ON stock_items (created_at ASC, id ASC) "
                "WHERE status IN ('IN_STOCK', 'REQUESTED', 'TRANSFERRED');"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_stock_active_v2_newest "
                "ON stock_items (created_at DESC, id DESC) "
                "WHERE status IN ('IN_STOCK', 'REQUESTED', 'TRANSFERRED');"
            )
        )
        # 2. Grup özeti ve aktif referans/level aramaları için covering partial index
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_stock_active_v2_ref_lvl_qty "
                "ON stock_items (reference, level, status) "
                "INCLUDE (remaining_quantity, created_at) "
                "WHERE status IN ('IN_STOCK', 'REQUESTED', 'TRANSFERRED');"
            )
        )
        # 3. Hızlı önek aramaları için text_pattern_ops indeksleri
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_stock_ref_pattern "
                "ON stock_items (reference varchar_pattern_ops);"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_stock_lvl_pattern "
                "ON stock_items (level varchar_pattern_ops);"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_stock_level_key "
                "ON stock_items ((regexp_replace(level, '[^A-Z0-9]', '', 'g')) varchar_pattern_ops);"
            )
        )
        # 4. Bugün düşülenler ve geçmiş sıralaması için composite indeksler
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_movements_action_created "
                "ON stock_movements (action, created_at DESC);"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_movements_created_id_desc "
                "ON stock_movements (created_at DESC, id DESC);"
            )
        )

    # Opsiyonel: pg_trgm uzantısı desteklenen sunucularda ayrı transaction ile dene
    try:
        with engine.begin() as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm;"))
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_stock_ref_trgm "
                    "ON stock_items USING gin (reference gin_trgm_ops);"
                )
            )
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_stock_lvl_trgm "
                    "ON stock_items USING gin (level gin_trgm_ops);"
                )
            )
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_stock_note_trgm "
                    "ON stock_items USING gin (location_note gin_trgm_ops);"
                )
            )
    except Exception as exc:
        logger.info("Opsiyonel pg_trgm indeksi atlandı (standart B-tree/partial indeksler aktif): %s", exc)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
