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

        # 1. Aktif stoklar için FIFO ve En Yeni sıralamalı kısmi (partial) indeksler
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_stock_active_fifo "
                "ON stock_items (created_at ASC, id ASC) "
                "WHERE status IN ('IN_STOCK', 'REQUESTED');"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_stock_active_newest "
                "ON stock_items (created_at DESC, id DESC) "
                "WHERE status IN ('IN_STOCK', 'REQUESTED');"
            )
        )
        # 2. Grup özeti ve aktif referans/level aramaları için covering partial index
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_stock_active_ref_lvl_qty "
                "ON stock_items (reference, level, status) "
                "INCLUDE (remaining_quantity, created_at) "
                "WHERE status IN ('IN_STOCK', 'REQUESTED');"
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
