import asyncio
import html
import json
import logging
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings
from .database import SessionLocal, engine
from .models import AppSetting

logger = logging.getLogger(__name__)

TR_TZ = timezone(timedelta(hours=3))
ID_COMMAND_RE = re.compile(r"^/(id|chatid)(?:@[a-zA-Z0-9_]+)?(?:\s|$)", re.IGNORECASE)
POLLING_ADVISORY_LOCK_KEY = 84729104


def get_setting_value(db: Session, key: str, fallback: str = "") -> str:
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row is not None:
        return row.value.strip()
    return fallback.strip()


def set_setting_value(db: Session, key: str, value: str) -> None:
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row is not None:
        row.value = value.strip()
    else:
        db.add(AppSetting(key=key, value=value.strip()))


def get_telegram_credentials(db: Session) -> tuple[str, str]:
    bot_token = get_setting_value(db, "telegram_bot_token", settings.TELEGRAM_BOT_TOKEN)
    chat_id = get_setting_value(db, "telegram_chat_id", settings.TELEGRAM_CHAT_ID)
    return bot_token, chat_id


def _telegram_api_call(
    bot_token: str,
    method: str,
    payload: dict[str, Any],
    timeout: int = 10,
) -> tuple[bool, Any, Optional[str]]:
    url = f"https://api.telegram.org/bot{bot_token}/{method}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            if body.get("ok"):
                return True, body.get("result"), None
            return False, None, body.get("description", "Telegram API bilinmeyen yanıt döndürdü.")
    except urllib.error.HTTPError as exc:
        try:
            err_body = json.loads(exc.read().decode("utf-8"))
            desc = err_body.get("description") or str(exc)
        except Exception:
            desc = str(exc)
        return False, None, f"Telegram hatası ({exc.code}): {desc}"
    except Exception as exc:
        return False, None, f"Telegram bağlantı hatası: {exc}"


def send_telegram_message(
    bot_token: str,
    chat_id: str | int,
    html_text: str,
    message_thread_id: Optional[int] = None,
    reply_to_message_id: Optional[int] = None,
) -> tuple[bool, Optional[str]]:
    if not bot_token:
        return False, "Telegram Bot Token tanımlanmamış (Ayarlar bölümünden girin)."
    if chat_id is None or str(chat_id).strip() == "":
        return False, "Telegram Grup Chat ID tanımlanmamış (Ayarlar bölümünden girin)."

    payload: dict[str, Any] = {
        "chat_id": str(chat_id).strip(),
        "text": html_text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if message_thread_id is not None:
        payload["message_thread_id"] = message_thread_id
    if reply_to_message_id is not None:
        payload["reply_to_message_id"] = reply_to_message_id

    ok, _, err = _telegram_api_call(bot_token, "sendMessage", payload, timeout=8)
    if not ok:
        logger.warning("Telegram mesaj gönderilemedi: %s", err)
    return ok, err


def format_warehouse_request_message(
    label_code: str,
    reference: str,
    level: str,
    remaining_quantity: int,
    location_note: Optional[str],
    requested_note: Optional[str],
) -> str:
    now_tr = datetime.now(TR_TZ).strftime("%d.%m.%Y %H:%M")
    lines = [
        "📦 <b>DEPO ÜRÜN TALEBİ</b>",
        "━━━━━━━━━━━━━━━━━━━━",
        f"🔖 <b>Etiket Kodu:</b> <code>{html.escape(label_code)}</code>",
        f"📌 <b>Referans:</b> <code>{html.escape(reference)}</code>",
        f"🏷 <b>Level:</b> <b>{html.escape(level)}</b>",
        f"🔢 <b>Miktar:</b> <b>{remaining_quantity} Adet</b>",
    ]
    if location_note:
        lines.append(f"📍 <b>Depo Konum / Not:</b> {html.escape(location_note)}")
    if requested_note:
        lines.append(f"👤 <b>Talep Eden / Açıklama:</b> {html.escape(requested_note)}")
    lines.append(f"🕒 <b>Talep Zamanı:</b> {now_tr}")
    return "\n".join(lines)


def format_warehouse_cancel_message(
    label_code: str,
    reference: str,
    level: str,
    remaining_quantity: int,
) -> str:
    now_tr = datetime.now(TR_TZ).strftime("%d.%m.%Y %H:%M")
    return (
        "⚠️ <b>DEPO TALEBİ İPTAL EDİLDİ</b>\n"
        f"🔖 Etiket: <code>{html.escape(label_code)}</code>\n"
        f"📌 Referans: <code>{html.escape(reference)}</code> (Level: <b>{html.escape(level)}</b>)\n"
        f"🔢 Miktar: {remaining_quantity} Adet\n"
        f"🕒 Zaman: {now_tr}"
    )


def _read_active_bot_token() -> str:
    db = SessionLocal()
    try:
        return get_setting_value(db, "telegram_bot_token", settings.TELEGRAM_BOT_TOKEN)
    except Exception:
        return settings.TELEGRAM_BOT_TOKEN.strip()
    finally:
        db.close()


def _prepare_bot_for_polling(bot_token: str) -> None:
    """Webhook varsa temizler ve /id komutunu Telegram menüsüne kaydeder."""
    _telegram_api_call(
        bot_token,
        "deleteWebhook",
        {"drop_pending_updates": False},
        timeout=8,
    )
    _telegram_api_call(
        bot_token,
        "setMyCommands",
        {
            "commands": [
                {
                    "command": "id",
                    "description": "Bu grubun veya kanalın Chat ID bilgisini paylaşır",
                }
            ]
        },
        timeout=8,
    )


def handle_telegram_update(bot_token: str, update: dict[str, Any]) -> None:
    msg = (
        update.get("message")
        or update.get("channel_post")
        or update.get("edited_message")
        or update.get("edited_channel_post")
    )
    if not msg:
        return

    text_val = (msg.get("text") or msg.get("caption") or "").strip()
    if not text_val or not ID_COMMAND_RE.match(text_val):
        return

    chat = msg.get("chat") or {}
    chat_id = chat.get("id")
    if chat_id is None:
        return

    chat_title = (
        chat.get("title")
        or chat.get("username")
        or " ".join(filter(None, [chat.get("first_name"), chat.get("last_name")]))
        or "Sohbet"
    )
    chat_type = chat.get("type", "group")
    type_labels = {
        "group": "Grup",
        "supergroup": "Süper Grup",
        "channel": "Kanal",
        "private": "Özel Sohbet",
    }
    readable_type = type_labels.get(chat_type, str(chat_type))

    thread_id = msg.get("message_thread_id")
    message_id = msg.get("message_id")

    reply_lines = [
        "🆔 <b>Grup / Kanal Chat ID Bilgisi</b>",
        "━━━━━━━━━━━━━━━━━━━━",
        f"📌 <b>Ad:</b> {html.escape(str(chat_title))}",
        f"🔢 <b>Chat ID:</b> <code>{chat_id}</code>",
        f"📂 <b>Tür:</b> {html.escape(readable_type)}",
    ]
    if thread_id is not None:
        reply_lines.append(f"💬 <b>Konu (Thread) ID:</b> <code>{thread_id}</code>")

    reply_lines.append("")
    reply_lines.append(
        "<i>Chat ID değerini kopyalamak için numaranın üzerine dokunun ve uygulamanın Ayarlar bölümüne yapıştırın.</i>"
    )

    send_telegram_message(
        bot_token=bot_token,
        chat_id=chat_id,
        html_text="\n".join(reply_lines),
        message_thread_id=thread_id if chat_type == "supergroup" else None,
        reply_to_message_id=message_id,
    )


async def telegram_bot_polling_loop(stop_event: asyncio.Event) -> None:
    """
    PostgreSQL session advisory lock ile aynı anda yalnızca TEK bir uygulama örneğinin
    Telegram getUpdates dinlemesini garanti eder (rolling deploy / çoklu worker 409 koruması).
    """
    active_token = ""
    offset: Optional[int] = None
    lock_conn = None
    has_lock = False

    try:
        while not stop_event.is_set():
            try:
                current_token = await asyncio.to_thread(_read_active_bot_token)
                if not current_token:
                    active_token = ""
                    offset = None
                    try:
                        await asyncio.wait_for(stop_event.wait(), timeout=4.0)
                    except asyncio.TimeoutError:
                        pass
                    continue

                # Tekil polling liderliği için PostgreSQL advisory lock al
                if not has_lock or lock_conn is None or lock_conn.closed:
                    def _acquire_leader_lock():
                        nonlocal lock_conn, has_lock
                        if lock_conn is not None:
                            try:
                                lock_conn.close()
                            except Exception:
                                pass
                        lock_conn = engine.connect()
                        acquired = lock_conn.execute(
                            text("SELECT pg_try_advisory_lock(:k)"),
                            {"k": POLLING_ADVISORY_LOCK_KEY},
                        ).scalar()
                        has_lock = bool(acquired)
                        if not has_lock:
                            lock_conn.close()
                            lock_conn = None
                        return has_lock

                    got_lock = await asyncio.to_thread(_acquire_leader_lock)
                    if not got_lock:
                        try:
                            await asyncio.wait_for(stop_event.wait(), timeout=6.0)
                        except asyncio.TimeoutError:
                            pass
                        continue

                if current_token != active_token:
                    active_token = current_token
                    offset = None
                    await asyncio.to_thread(_prepare_bot_for_polling, active_token)
                    logger.info("Telegram bot /id dinleyicisi aktif edildi.")

                poll_payload: dict[str, Any] = {
                    "timeout": 10,
                    "allowed_updates": [
                        "message",
                        "channel_post",
                        "edited_message",
                        "edited_channel_post",
                    ],
                }
                if offset is not None:
                    poll_payload["offset"] = offset

                ok, updates, err = await asyncio.to_thread(
                    _telegram_api_call,
                    active_token,
                    "getUpdates",
                    poll_payload,
                    16,
                )

                if not ok:
                    if err and "401" in err:
                        logger.warning("Telegram Bot Token geçersiz görünüyor: %s", err)
                    try:
                        await asyncio.wait_for(stop_event.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        pass
                    continue

                if isinstance(updates, list):
                    for upd in updates:
                        upd_id = upd.get("update_id")
                        if isinstance(upd_id, int):
                            offset = upd_id + 1
                        await asyncio.to_thread(handle_telegram_update, active_token, upd)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("Telegram polling döngüsü hatası: %s", exc)
                has_lock = False
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    pass
    finally:
        if lock_conn is not None:
            try:
                lock_conn.execute(
                    text("SELECT pg_advisory_unlock(:k)"),
                    {"k": POLLING_ADVISORY_LOCK_KEY},
                )
                lock_conn.close()
            except Exception:
                pass
