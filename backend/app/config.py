from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+psycopg://postgres:postgres@localhost:5432/paketleme"
    PORT: int = 8000
    APP_ENV: str = "production"
    CORS_ORIGINS: str = "*"
    ADMIN_PASSWORD: str = "twjsQ0_vay"
    TELEGRAM_BOT_TOKEN: str = ""
    TELEGRAM_CHAT_ID: str = ""

    model_config = SettingsConfigDict(
        env_file=[str(BASE_DIR / ".env"), str(BASE_DIR / "backend" / ".env")],
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def sqlalchemy_database_url(self) -> str:
        url = self.DATABASE_URL.strip()
        if url.startswith("postgres://"):
            return url.replace("postgres://", "postgresql+psycopg://", 1)
        if url.startswith("postgresql://") and "+psycopg" not in url:
            return url.replace("postgresql://", "postgresql+psycopg://", 1)
        return url


settings = Settings()
