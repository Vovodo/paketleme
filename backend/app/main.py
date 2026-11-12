import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .config import settings
from .database import engine, init_db
from .routers import settings as settings_router
from .routers import stock
from .telegram_service import telegram_bot_polling_loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    stop_event = asyncio.Event()
    polling_task = asyncio.create_task(telegram_bot_polling_loop(stop_event))
    try:
        yield
    finally:
        stop_event.set()
        polling_task.cancel()
        try:
            await polling_task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="Paketsiz Kılıf Stok & Etiket Takip Sistemi",
    version="1.3.0",
    lifespan=lifespan,
)

origins = (
    ["*"]
    if settings.CORS_ORIGINS.strip() == "*"
    else [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=800)

app.include_router(stock.router)
app.include_router(settings_router.router)


@app.get("/api/health")
def health_check():
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    return {"status": "ok", "database": "connected"}


STATIC_DIR = (Path(__file__).resolve().parent.parent.parent / "frontend" / "dist").resolve()

if STATIC_DIR.exists():
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str):
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="API endpoint not found")

        if full_path:
            try:
                target = (STATIC_DIR / full_path).resolve()
                if target.is_relative_to(STATIC_DIR) and target.is_file():
                    return FileResponse(str(target))
            except (ValueError, OSError):
                pass

        return FileResponse(
            str(STATIC_DIR / "index.html"),
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )
