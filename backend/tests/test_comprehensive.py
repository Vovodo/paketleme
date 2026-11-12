import concurrent.futures
import json
import re
import sys
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import text  # noqa: E402
from app.database import engine  # noqa: E402
from app.qr_utils import extract_label_code, normalize_code  # noqa: E402
from app.telegram_service import (  # noqa: E402
    POLLING_ADVISORY_LOCK_KEY,
    format_warehouse_request_message,
    handle_telegram_update,
)

BASE_URL = "http://127.0.0.1:8000"


def api_call(method: str, path: str, body=None, headers=None):
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        headers=req_headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            raw = resp.read().decode("utf-8")
            lower_headers = {k.lower(): v for k, v in resp.headers.items()}
            content_type = lower_headers.get("content-type", "")
            parsed = json.loads(raw) if "application/json" in content_type else raw
            return resp.status, lower_headers, parsed
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        lower_headers = {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}
        content_type = lower_headers.get("content-type", "")
        try:
            parsed = json.loads(raw) if "application/json" in content_type else raw
        except Exception:
            parsed = raw
        return exc.code, lower_headers, parsed


class ComprehensiveSystemTests(unittest.TestCase):
    created_ids: list[int] = []
    saved_settings: dict[str, str] = {}

    @classmethod
    def setUpClass(cls):
        cls.created_ids = []
        with engine.begin() as conn:
            rows = conn.execute(text("SELECT key, value FROM app_settings")).fetchall()
            cls.saved_settings = {r[0]: r[1] for r in rows}
            # Test süresince gerçek Telegram grubuna test mesajı gitmemesi için geçici temizle
            conn.execute(text("DELETE FROM app_settings"))

    @classmethod
    def tearDownClass(cls):
        with engine.begin() as conn:
            if cls.created_ids:
                conn.execute(
                    text("DELETE FROM stock_items WHERE id = ANY(:ids)"),
                    {"ids": cls.created_ids},
                )
            # Ayarları test öncesi haline döndür
            conn.execute(text("DELETE FROM app_settings"))
            for k, v in cls.saved_settings.items():
                conn.execute(
                    text("INSERT INTO app_settings (key, value) VALUES (:k, :v)"),
                    {"k": k, "v": v},
                )
            # Sequence değerini mevcut en yüksek PKT koduna göre hizala
            max_code = conn.execute(
                text(
                    "SELECT COALESCE(MAX(CAST(SUBSTRING(label_code FROM 5) AS BIGINT)), 100000) "
                    "FROM stock_items WHERE label_code ~ '^PKT-[0-9]+$'"
                )
            ).scalar_one()
            next_val = max(100001, int(max_code) + 1)
            conn.execute(text(f"ALTER SEQUENCE pkt_label_seq RESTART WITH {next_val}"))

    def _track_create(self, payload: dict) -> dict:
        st, _, body = api_call("POST", "/api/stock", payload)
        self.assertEqual(st, 201, f"Create failed: {body}")
        self.created_ids.append(body["id"])
        return body

    # ------------------------------------------------------------------
    # 1. Sağlık, Statik SPA ve Path Traversal Güvenlik Testleri
    # ------------------------------------------------------------------
    def test_01_health_and_headers(self):
        st, headers, body = api_call("GET", "/api/health")
        self.assertEqual(st, 200)
        self.assertEqual(body, {"status": "ok", "database": "connected"})
        self.assertIn("application/json", headers.get("content-type", "").lower())

        st_root, root_headers, html_doc = api_call("GET", "/")
        self.assertEqual(st_root, 200)
        self.assertIn("no-store", root_headers.get("cache-control", "").lower())
        self.assertIn("<div id=\"root\"></div>", html_doc)

        st_404, _, _ = api_call("GET", "/api/unknown-route")
        self.assertEqual(st_404, 404)

        # Bozuk JSON gönderildiğinde 500 değil 422 dönmeli
        req = urllib.request.Request(
            f"{BASE_URL}/api/stock",
            data=b"{broken-json",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=5)
            self.fail("Malformed JSON should fail")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 422)

        # Var olmayan ID'ler üzerinde işlemler 404 dönmeli
        for ep in ["/api/stock/99999999/request", "/api/stock/99999999/cancel-request", "/api/stock/99999999/restore"]:
            st_nf, _, _ = api_call("POST", ep, {})
            self.assertEqual(st_nf, 404)

    def test_02_path_traversal_blocked(self):
        traversal_paths = [
            "/..%2f..%2f.env",
            "/..%5c..%5c.env",
            "/..%2f..%2fbackend%2fapp%2fconfig.py",
            "/../requirements.txt",
        ]
        for p in traversal_paths:
            st, _, content = api_call("GET", p)
            self.assertEqual(st, 200)
            # Hassas dosya içeriği yerine yalnızca SPA index.html dönmeli
            self.assertNotIn("DATABASE_URL", str(content))
            self.assertNotIn("ADMIN_PASSWORD", str(content))
            self.assertIn("<div id=\"root\"></div>", str(content))

    # ------------------------------------------------------------------
    # 2. Doğrulama, Görünmez Karakterler, Türkçe Normalizasyon & Sınırlar
    # ------------------------------------------------------------------
    def test_03_input_validation_and_unicode_edge_cases(self):
        # Sadece boşluk veya zero-width karakterler 422 dönmeli
        for bad_val in ["   ", "\u200b\ufeff\xa0", ""]:
            st, _, _ = api_call(
                "POST",
                "/api/stock",
                {"reference": bad_val, "quantity": 10, "level": "PO6"},
            )
            self.assertEqual(st, 422)

        # Geçersiz miktar değerleri
        for bad_qty in [0, -1, -999, 100001]:
            st, _, _ = api_call(
                "POST",
                "/api/stock",
                {"reference": "QA-REF-1", "quantity": bad_qty, "level": "L1"},
            )
            self.assertEqual(st, 422)

        # Türkçe karakterler ve görünmez boşluklarla oluşturma
        created = self._track_create(
            {
                "reference": "  \u200bqa-şğüöçıİ-99\xa0 ",
                "quantity": 15,
                "level": "  rev\u200b-ğüşiöç ",
                "location_note": "  Raf Özel Bölge  ",
            }
        )
        self.assertEqual(created["reference"], "QA-SGUOCII-99")
        self.assertEqual(created["level"], "REV-GUSIOC")
        self.assertEqual(created["location_note"], "Raf Özel Bölge")

    def test_04_max_length_boundary_no_truncation_500(self):
        # Maksimum uzunlukta (120 ref + 80 level + 200 not + 100 personel) oluşturma ve güncelleme
        max_ref = "R" * 120
        max_lvl = "L" * 80
        max_note = "N" * 200
        max_by = "P" * 100

        created = self._track_create(
            {
                "reference": max_ref,
                "quantity": 99999,
                "level": max_lvl,
                "location_note": max_note,
                "created_by": max_by,
            }
        )
        self.assertEqual(len(created["reference"]), 120)
        self.assertGreater(len(created["qr_payload"]), 220)

        # Şimdi tekrar 120 karakterlik başka bir referansa ve 200 karakterlik yeni nota güncelle
        # (StockMovement.note 255 karakter sınırını aşmadan güvenli kesilmeli, 500 vermemeli!)
        st, _, updated = api_call(
            "PUT",
            f"/api/stock/{created['id']}",
            {
                "reference": "X" * 120,
                "level": "Y" * 80,
                "remaining_quantity": 100000,
                "location_note": "Z" * 200,
            },
        )
        self.assertEqual(st, 200, f"Update failed on max lengths: {updated}")
        self.assertEqual(updated["remaining_quantity"], 100000)

    # ------------------------------------------------------------------
    # 3. Barkod / QR Okuyucu Klavye Düzeni Simülasyonları
    # ------------------------------------------------------------------
    def test_05_scanner_keyboard_layout_variations(self):
        item = self._track_create(
            {"reference": "QA-SCAN-6683", "quantity": 40, "level": "HZE-1"}
        )
        code_num = item["label_code"].split("-")[1]
        qr = item["qr_payload"]

        # Türkçe Q klavyede US HID barkod okuyucu simülasyonları
        scanner_variants = [
            qr,
            qr.lower().replace("/", "ç").replace("-", "*"),
            qr.upper().replace("/", "Ç").replace("-", "?"),
            f"PKT*{code_num}",
            f"pkt.{code_num}",
            f"  pkt {code_num}  ",
            code_num,
        ]

        for variant in scanner_variants:
            self.assertEqual(extract_label_code(variant), item["label_code"])
            encoded = urllib.parse.quote(variant)
            st, _, looked = api_call("GET", f"/api/stock/lookup?code={encoded}")
            self.assertEqual(st, 200, f"Lookup failed for variant {variant!r}: {looked}")
            self.assertEqual(looked["id"], item["id"])

    # ------------------------------------------------------------------
    # 4. SQL LIKE Wildcard (% ve _) İzolasyon Testi
    # ------------------------------------------------------------------
    def test_06_sql_wildcard_escaping(self):
        item_underscore = self._track_create(
            {"reference": "QAWILD_100", "quantity": 5, "level": "W1"}
        )
        item_plain = self._track_create(
            {"reference": "QAWILDX100", "quantity": 5, "level": "W1"}
        )

        # 'QAWILD_100' arandığında '_' tek karakterlik joker olarak çalışıp QAWILDX100 getirmemeli
        st, _, rows = api_call(
            "GET",
            "/api/stock?q=" + urllib.parse.quote("QAWILD_100") + "&status=ALL",
        )
        self.assertEqual(st, 200)
        returned_ids = {r["id"] for r in rows}
        self.assertIn(item_underscore["id"], returned_ids)
        self.assertNotIn(item_plain["id"], returned_ids)

        # '%' arandığında rastgele kayıtlar gelmemeli
        st_pct, _, rows_pct = api_call(
            "GET",
            "/api/stock?q=" + urllib.parse.quote("%%%") + "&status=ALL",
        )
        self.assertEqual(st_pct, 200)
        self.assertEqual(len(rows_pct), 0)

    # ------------------------------------------------------------------
    # 5. Eşzamanlılık (Concurrency & Race Condition) Stres Testleri
    # ------------------------------------------------------------------
    def test_07_concurrent_full_deduct_race_condition(self):
        item = self._track_create(
            {"reference": "QA-RACE-FULL", "quantity": 25, "level": "R1"}
        )
        qr = item["qr_payload"]

        def attempt_deduct(_):
            st, _, body = api_call("POST", "/api/stock/scan-deduct", {"qr_or_code": qr})
            return st

        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            statuses = list(pool.map(attempt_deduct, range(12)))

        # Yalnızca TAM OLARAK 1 istek 200 dönmeli, diğer 11 istek 400 dönmeli!
        self.assertEqual(statuses.count(200), 1, f"Unexpected statuses: {statuses}")
        self.assertEqual(statuses.count(400), 11, f"Unexpected statuses: {statuses}")

        st, _, detail = api_call("GET", f"/api/stock/lookup?code={item['label_code']}")
        self.assertEqual(st, 200)
        self.assertEqual(detail["remaining_quantity"], 0)
        self.assertEqual(detail["status"], "CONSUMED")

    def test_08_concurrent_partial_deduct_never_goes_negative(self):
        item = self._track_create(
            {"reference": "QA-RACE-PART", "quantity": 30, "level": "R2"}
        )
        code = item["label_code"]

        def attempt_partial(_):
            st, _, _ = api_call(
                "POST",
                "/api/stock/scan-deduct",
                {"qr_or_code": code, "deduct_quantity": 7},
            )
            return st

        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            statuses = list(pool.map(attempt_partial, range(10)))

        # 30 adet içinden en fazla 4 kez 7 adet düşülebilir (4 * 7 = 28, geriye 2 kalır)
        self.assertEqual(statuses.count(200), 4, f"Statuses: {statuses}")
        self.assertEqual(statuses.count(400), 6, f"Statuses: {statuses}")

        st, _, detail = api_call("GET", f"/api/stock/lookup?code={code}")
        self.assertEqual(st, 200)
        self.assertEqual(detail["remaining_quantity"], 2)
        self.assertEqual(detail["status"], "IN_STOCK")

    def test_09_concurrent_warehouse_request_no_duplicate_spam(self):
        item = self._track_create(
            {"reference": "QA-RACE-REQ", "quantity": 18, "level": "PO6"}
        )
        item_id = item["id"]

        def attempt_req(i):
            st, _, _ = api_call(
                "POST",
                f"/api/stock/{item_id}/request",
                {"requested_note": f"Hat-{i}"},
            )
            return st

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(attempt_req, range(8)))

        # Sadece 1 istek başarılı olmalı, diğer 7 istek 'zaten talep edilmiş' (400) dönmeli!
        self.assertEqual(statuses.count(200), 1, f"Statuses: {statuses}")
        self.assertEqual(statuses.count(400), 7, f"Statuses: {statuses}")

    def test_10_concurrent_label_creation_unique_codes(self):
        def create_one(i):
            st, _, body = api_call(
                "POST",
                "/api/stock",
                {"reference": f"QA-PAR-{i}", "quantity": 10 + i, "level": "P1"},
            )
            return st, body

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(create_one, range(8)))

        codes = set()
        for st, body in results:
            self.assertEqual(st, 201)
            self.created_ids.append(body["id"])
            codes.add(body["label_code"])

        self.assertEqual(len(codes), 8)

    # ------------------------------------------------------------------
    # 6. Üretim Eşleştirme, Stoğa Geri Alma & Yönetici Brute-Force Koruması
    # ------------------------------------------------------------------
    def test_11_production_match_precision_and_restore_cycle(self):
        it1 = self._track_create({"reference": "QA-998877", "quantity": 12, "level": "PO6"})
        it2 = self._track_create({"reference": "QA-998877", "quantity": 8, "level": "PO9"})

        st, _, match_res = api_call(
            "POST",
            "/api/stock/match",
            {
                "queries": [
                    {"reference": "QA-998877", "level": "PO6"},
                    {"reference": "1", "level": "PO6"},  # Çok kısa referans yanlış eşleşmemeli
                ]
            },
        )
        self.assertEqual(st, 200)
        self.assertEqual(match_res[0]["total_exact_quantity"], 12)
        self.assertEqual(match_res[0]["total_other_quantity"], 8)
        self.assertEqual(match_res[1]["total_exact_quantity"], 0)

        # Kısmi düşüm (12 -> 5 kaldı) sonra kalan 5 adedi tam düş (5 -> 0 CONSUMED),
        # ardından Restore yapıldığında tüm ilk 12 değil, son düşülen 5 adet geri gelmeli!
        api_call("POST", "/api/stock/scan-deduct", {"qr_or_code": it1["label_code"], "deduct_quantity": 7})
        api_call("POST", "/api/stock/scan-deduct", {"qr_or_code": it1["label_code"]})

        st_rest, _, restored = api_call("POST", f"/api/stock/{it1['id']}/restore")
        self.assertEqual(st_rest, 200)
        self.assertEqual(restored["status"], "IN_STOCK")
        self.assertEqual(restored["remaining_quantity"], 5)

        # Zaten IN_STOCK olan kaydı tekrar restore etmek 400 dönmeli
        st_rest_again, _, _ = api_call("POST", f"/api/stock/{it1['id']}/restore")
        self.assertEqual(st_rest_again, 400)
        _ = it2

    def test_12_admin_password_rate_limit_and_settings_persistence(self):
        fake_ip_header = {"X-Forwarded-For": "203.0.113.177"}

        # 10 hatalı deneme -> 401
        for _ in range(10):
            st, _, _ = api_call(
                "POST",
                "/api/settings/verify",
                {"password": "wrong-password"},
                headers=fake_ip_header,
            )
            self.assertEqual(st, 401)

        # 11. deneme (doğru şifre bile olsa bu IP kilitlendiği için) -> 429 + Retry-After
        st_locked, hdrs, _ = api_call(
            "POST",
            "/api/settings/verify",
            {"password": "twjsQ0_vay"},
            headers=fake_ip_header,
        )
        self.assertEqual(st_locked, 429)
        self.assertTrue(
            any(k.lower() == "retry-after" for k in hdrs.keys()),
            f"Missing Retry-After header in {hdrs}",
        )

        # Başka temiz IP'den doğru şifreyle ayar kaydetme & silme testi
        clean_ip = {"X-Forwarded-For": "198.51.100.42"}
        st_put, _, saved = api_call(
            "PUT",
            "/api/settings/telegram",
            {
                "password": "twjsQ0_vay",
                "telegram_chat_id": "-100555666777",
                "telegram_bot_token": "123456789:ABCDEF_TEST_TOKEN_9876",
            },
            headers=clean_ip,
        )
        self.assertEqual(st_put, 200)
        self.assertEqual(saved["telegram_chat_id"], "-100555666777")
        self.assertTrue(saved["has_bot_token"])
        self.assertIn("••••", saved["masked_bot_token"])

        # Chat ID'yi boşaltarak kaydettiğinde gerçekten temizlenmeli
        st_clr, _, cleared = api_call(
            "PUT",
            "/api/settings/telegram",
            {
                "password": "twjsQ0_vay",
                "telegram_chat_id": "",
                "clear_bot_token": True,
            },
            headers=clean_ip,
        )
        self.assertEqual(st_clr, 200)
        self.assertEqual(cleared["telegram_chat_id"], "")
        self.assertFalse(cleared["has_bot_token"])

    # ------------------------------------------------------------------
    # 7. Telegram HTML Escape & Advisory Lock & /id Komut Testleri
    # ------------------------------------------------------------------
    def test_13_telegram_xss_escape_and_advisory_lock(self):
        msg = format_warehouse_request_message(
            label_code="PKT-100001",
            reference="REF<script>&1",
            level="L<b>2",
            remaining_quantity=10,
            location_note="Raf <A & B>",
            requested_note="Hat <1>",
        )
        self.assertNotIn("<script>", msg)
        self.assertIn("&lt;script&gt;&amp;1", msg)
        self.assertIn("Raf &lt;A &amp; B&gt;", msg)

        # Advisory lock testi: İki bağlantıdan sadece biri liderliği alabilmeli
        c1 = engine.connect()
        c2 = engine.connect()
        try:
            l1 = c1.execute(
                text("SELECT pg_try_advisory_lock(:k)"), {"k": POLLING_ADVISORY_LOCK_KEY}
            ).scalar()
            if l1:
                l2 = c2.execute(
                    text("SELECT pg_try_advisory_lock(:k)"), {"k": POLLING_ADVISORY_LOCK_KEY}
                ).scalar()
                self.assertFalse(l2, "Second connection must NOT acquire the advisory lock!")
                c1.execute(
                    text("SELECT pg_advisory_unlock(:k)"), {"k": POLLING_ADVISORY_LOCK_KEY}
                )
            else:
                # Arka plandaki çalışan uvicorn sunucusu zaten kilidi tutuyor demektir!
                # Bu da çalışan sunucunun liderlik kilidini başarıyla aldığını kanıtlar!
                self.assertFalse(
                    l1, "Running server holds the advisory lock, preventing duplicate pollers!"
                )
        finally:
            c1.close()
            c2.close()

        # /id komutu konulu süper grup + özel karakterli başlık testi
        captured = []
        with patch(
            "app.telegram_service.send_telegram_message",
            side_effect=lambda **kw: (captured.append(kw), (True, None))[1],
        ):
            handle_telegram_update(
                "TOK",
                {
                    "update_id": 99,
                    "message": {
                        "message_id": 77,
                        "message_thread_id": 5,
                        "chat": {
                            "id": -100777888999,
                            "title": "Depo & Paketleme <Hat>",
                            "type": "supergroup",
                        },
                        "text": "/id@DepoBot   ",
                    },
                },
            )
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0]["chat_id"], -100777888999)
        self.assertEqual(captured[0]["message_thread_id"], 5)
        self.assertIn("Depo &amp; Paketleme &lt;Hat&gt;", captured[0]["html_text"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
