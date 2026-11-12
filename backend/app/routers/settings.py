import hmac
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..schemas import (
    AdminAuthRequest,
    TelegramSettingsOut,
    TelegramSettingsUpdateRequest,
    TelegramTestRequest,
)
from ..telegram_service import (
    get_telegram_credentials,
    send_telegram_message,
    set_setting_value,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])

TR_TZ = timezone(timedelta(hours=3))

# Brute-force koruması: IP başına 5 dakikada en fazla 10 başarısız şifre denemesi
_RATE_LOCK = threading.Lock()
_FAILED_ATTEMPTS: dict[str, list[float]] = {}
MAX_FAILED_ATTEMPTS = 10
WINDOW_SECONDS = 300


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def verify_admin_password(password: str, request: Request) -> None:
    ip = _client_ip(request)
    now = time.monotonic()

    with _RATE_LOCK:
        attempts = [t for t in _FAILED_ATTEMPTS.get(ip, []) if now - t < WINDOW_SECONDS]
        if len(attempts) >= MAX_FAILED_ATTEMPTS:
            retry_after = max(1, int(WINDOW_SECONDS - (now - attempts[0])))
            raise HTTPException(
                status_code=429,
                detail=f"Çok fazla hatalı şifre denemesi yapıldı. Lütfen {retry_after} saniye bekleyin.",
                headers={"Retry-After": str(retry_after)},
            )

        if not hmac.compare_digest(password, settings.ADMIN_PASSWORD):
            attempts.append(now)
            _FAILED_ATTEMPTS[ip] = attempts
            raise HTTPException(status_code=401, detail="Yönetici şifresi hatalı.")

        _FAILED_ATTEMPTS.pop(ip, None)


def mask_token(token: str) -> str:
    if not token:
        return ""
    if len(token) <= 10:
        return "••••••••"
    return f"{token[:6]}••••••••{token[-4:]}"


@router.post("/verify", response_model=TelegramSettingsOut)
def verify_and_get_settings(
    payload: AdminAuthRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    verify_admin_password(payload.password, request)
    bot_token, chat_id = get_telegram_credentials(db)
    return TelegramSettingsOut(
        telegram_chat_id=chat_id,
        has_bot_token=bool(bot_token),
        masked_bot_token=mask_token(bot_token),
    )


@router.put("/telegram", response_model=TelegramSettingsOut)
def update_telegram_settings(
    payload: TelegramSettingsUpdateRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    verify_admin_password(payload.password, request)

    set_setting_value(db, "telegram_chat_id", payload.telegram_chat_id.strip())

    if payload.clear_bot_token:
        set_setting_value(db, "telegram_bot_token", "")
    elif payload.telegram_bot_token is not None and payload.telegram_bot_token.strip() != "":
        set_setting_value(db, "telegram_bot_token", payload.telegram_bot_token.strip())

    db.commit()

    bot_token, chat_id = get_telegram_credentials(db)
    return TelegramSettingsOut(
        telegram_chat_id=chat_id,
        has_bot_token=bool(bot_token),
        masked_bot_token=mask_token(bot_token),
    )


@router.post("/telegram/test")
def test_telegram_notification(
    payload: TelegramTestRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    verify_admin_password(payload.password, request)

    saved_token, saved_chat_id = get_telegram_credentials(db)
    use_token = (
        payload.telegram_bot_token.strip()
        if payload.telegram_bot_token and payload.telegram_bot_token.strip()
        else saved_token
    )
    use_chat_id = (
        payload.telegram_chat_id.strip()
        if payload.telegram_chat_id is not None
        else saved_chat_id
    )

    now_tr = datetime.now(TR_TZ).strftime("%d.%m.%Y %H:%M")
    test_html = (
        "✅ <b>TELEGRAM BAĞLANTI TESTİ BAŞARILI</b>\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "Paketsiz Kılıf Stok &amp; Etiket Sistemi bildirimleri bu gruba iletilecektir.\n"
        f"🕒 Zaman: {now_tr}"
    )

    ok, err = send_telegram_message(use_token, use_chat_id, test_html)
    if not ok:
        raise HTTPException(status_code=400, detail=err or "Telegram mesajı gönderilemedi.")

    return {"ok": True, "message": "Test mesajı Telegram grubuna başarıyla gönderildi."}
