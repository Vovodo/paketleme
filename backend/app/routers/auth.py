from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import threading
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..config import settings

router = APIRouter(prefix="/api/auth", tags=["auth"])

SAFE_BROWSER_COOKIE = "pkt_safe_browser"
SAFE_BROWSER_HEADER = "x-safe-browser-token"
COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10  # 10 yıl (kalıcı güvenli tarayıcı)

# Türkiye saati (UTC+3) — dinamik PIN her zaman Türkiye yerel gün/ay/saat/dakikasına göre hesaplanır
TR_TZ = timezone(timedelta(hours=3))

_PIN_LOCK = threading.Lock()
_PIN_FAILURES: dict[str, list[float]] = {}
MAX_PIN_FAILURES = 12
PIN_WINDOW_SECONDS = 300


class PinVerifyRequest(BaseModel):
    pin: str = Field(..., min_length=1, max_length=32)


class PinSessionOut(BaseModel):
    authenticated: bool
    safe_token: Optional[str] = None


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def compute_current_time_pin(now_dt: Optional[datetime] = None) -> str:
    """
    Türkiye saatine (UTC+3) göre 8 haneli dinamik PIN üretir: GGAAHHDD
    Örnek: 16 Kasım, saat 14:50 -> '16111450'
    Her yeni dakikada şifre otomatik değişir.
    """
    dt_tr = (now_dt or datetime.now(timezone.utc)).astimezone(TR_TZ)
    return dt_tr.strftime("%d%m%H%M")


def _signing_secret() -> bytes:
    # Deterministik HMAC anahtarı: PIN her dakika değişse bile daha önce PIN'i doğru girip
    # güvenli (safe) işaretlenmiş tarayıcılar kalıcı olarak açık kalmaya devam eder!
    material = f"pkt-safe-browser-v2::{settings.ADMIN_PASSWORD}"
    return hashlib.sha256(material.encode("utf-8")).digest()


def create_safe_browser_token() -> str:
    issued_at = str(int(time.time()))
    payload = f"v2.{issued_at}"
    sig = hmac.new(_signing_secret(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def verify_safe_browser_token(token: Optional[str]) -> bool:
    if not token or not isinstance(token, str):
        return False
    parts = token.strip().split(".")
    if len(parts) != 3 or parts[0] != "v2":
        return False
    if not parts[1].isdigit():
        return False
    payload = f"{parts[0]}.{parts[1]}"
    expected_sig = hmac.new(
        _signing_secret(), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(parts[2], expected_sig)


def extract_valid_token_from_request(request: Request) -> Optional[str]:
    header_tok = request.headers.get(SAFE_BROWSER_HEADER)
    if header_tok and verify_safe_browser_token(header_tok):
        return header_tok.strip()

    cookie_tok = request.cookies.get(SAFE_BROWSER_COOKIE)
    if cookie_tok and verify_safe_browser_token(cookie_tok):
        return cookie_tok.strip()

    return None


def require_safe_browser(request: Request) -> None:
    if extract_valid_token_from_request(request) is None:
        raise HTTPException(
            status_code=401,
            detail="Arayüz erişimi için PIN doğrulaması gereklidir.",
        )


def _is_https_request(request: Request) -> bool:
    proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    if proto == "https":
        return True
    return request.url.scheme == "https"


def _set_safe_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        key=SAFE_BROWSER_COOKIE,
        value=token,
        max_age=COOKIE_MAX_AGE_SECONDS,
        expires=COOKIE_MAX_AGE_SECONDS,
        path="/",
        httponly=True,
        samesite="lax",
        secure=_is_https_request(request),
    )


@router.get("/session", response_model=PinSessionOut)
def check_pin_session(request: Request, response: Response):
    valid_token = extract_valid_token_from_request(request)
    if not valid_token:
        raise HTTPException(status_code=401, detail="PIN doğrulaması gerekli.")
    _set_safe_cookie(response, request, valid_token)
    return PinSessionOut(authenticated=True, safe_token=valid_token)


@router.post("/pin", response_model=PinSessionOut)
def verify_pin_code(payload: PinVerifyRequest, request: Request, response: Response):
    ip = _client_ip(request)
    now = time.monotonic()
    entered = "".join(ch for ch in payload.pin.strip() if ch.isdigit())
    expected_pin = compute_current_time_pin()

    with _PIN_LOCK:
        attempts = [t for t in _PIN_FAILURES.get(ip, []) if now - t < PIN_WINDOW_SECONDS]
        if len(attempts) >= MAX_PIN_FAILURES:
            retry_after = max(1, int(PIN_WINDOW_SECONDS - (now - attempts[0])))
            raise HTTPException(
                status_code=429,
                detail=f"Çok fazla hatalı PIN denemesi yapıldı. Lütfen {retry_after} saniye bekleyin.",
                headers={"Retry-After": str(retry_after)},
            )

        if not entered or not hmac.compare_digest(entered, expected_pin):
            attempts.append(now)
            _PIN_FAILURES[ip] = attempts
            raise HTTPException(status_code=401, detail="PIN kodu hatalı veya süresi geçti.")

        _PIN_FAILURES.pop(ip, None)

    token = create_safe_browser_token()
    _set_safe_cookie(response, request, token)
    return PinSessionOut(authenticated=True, safe_token=token)
