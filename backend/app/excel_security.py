import hashlib
import io
import re
import xml.etree.ElementTree as ET
import zipfile
from typing import Optional


class ExcelSecurityError(ValueError):
    """Üretilen veya indirilecek Excel (.xlsx) dosyasında güvenlik ihlali tespit edildiğinde fırlatılır."""


# Sadece standart, makrosuz, dış bağlantısız 2 sayfalı openpyxl OOXML dosyalarına izin verilir
ALLOWED_OOXML_PATHS = frozenset(
    {
        "[Content_Types].xml",
        "_rels/.rels",
        "docProps/app.xml",
        "docProps/core.xml",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
        "xl/sharedStrings.xml",
        "xl/theme/theme1.xml",
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/sheet2.xml",
    }
)

MAX_ARCHIVE_BYTES = 15 * 1024 * 1024  # 15 MB
MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024  # 40 MB
MAX_COMPRESSION_RATIO = 120

# Kontrol karakterleri ve dosya adı / hücre görünümü sahtekarlığında kullanılan Unicode Bidi Override karakterleri
UNSAFE_CONTROL_AND_BIDI_RE = re.compile(
    r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]"
)

# DDE, komut satırı veya protokol tetikleyicileri
DANGEROUS_DDE_OR_SCHEME_RE = re.compile(
    r"(cmd\s*\||powershell|pwsh|mshta|wscript|cscript|rundll32|regsvr32|certutil|bitsadmin|"
    r"msexcel\||ms-msdt:|ms-officecmd:|mhtml:|javascript:|vbscript:|file://|\\\\)",
    re.IGNORECASE,
)

FORMULA_TRIGGER_PREFIXES = ("=", "+", "-", "@", "|")

FORBIDDEN_BINARY_MAGICS = (
    (b"MZ", "Windows çalıştırılabilir ikili dosya (PE/EXE/DLL) imzası"),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "Eski tip OLE2 / Makro konteyner imzası"),
    (b"\x7fELF", "Linux ELF ikili dosya imzası"),
    (b"{\\rtf", "RTF istismar belgesi imzası"),
    (b"L\x00\x00\x00\x01\x14\x02\x00", "Windows kısayol (.lnk) imzası"),
)

FORBIDDEN_CONTENT_TYPE_TOKENS = (
    "macroenabled",
    "vbaproject",
    "xlm",
    "macrosheet",
    "activex",
    "oleobject",
    "externallink",
)

FORBIDDEN_XML_LOCAL_TAGS = frozenset(
    {
        "f",  # Hücre içi formül (<f>) — dışa aktarımda tüm toplamlar Python'da hesaplanır, formül yasaktır!
        "oleObjects",
        "oleObject",
        "oleLink",
        "ddeLink",
        "ddeItems",
        "externalReferences",
        "externalReference",
        "externalBook",
        "hyperlinks",
        "hyperlink",
        "webPublishObjects",
        "webPublishObject",
        "controls",
        "control",
        "customPr",
        "queryTable",
        "connections",
        "connection",
    }
)

SAFE_FILTER_RANGE_RE = re.compile(r"^'?[^'!=+|]+'?!\$[A-Z]{1,3}\$\d+:\$[A-Z]{1,3}\$\d+$")

SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.xlsx$")


def sanitize_excel_filename(filename: str) -> str:
    cleaned = UNSAFE_CONTROL_AND_BIDI_RE.sub("", (filename or "").strip())
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", cleaned)
    if not cleaned.lower().endswith(".xlsx"):
        cleaned = f"{cleaned}.xlsx"
    # Çift uzantı (örn: .exe.xlsx) tehlikesine karşı gövdedeki noktaları temizle
    stem = cleaned[:-5].replace(".", "_")
    safe = f"{stem}.xlsx"
    if not SAFE_FILENAME_RE.fullmatch(safe):
        return "paketleme_stok_guvenli.xlsx"
    return safe


def sanitize_excel_cell_text(val: Optional[str]) -> tuple[str, bool]:
    """
    Excel hücresine yazılacak metni kontrol/bidi karakterlerinden ve DDE/komut
    enjeksiyonlarından temizler.
    Dönüş: (temiz_metin, quote_prefix_gerekli_mi)
    """
    if val is None:
        return "", False

    cleaned = UNSAFE_CONTROL_AND_BIDI_RE.sub("", str(val))
    stripped_lead = cleaned.lstrip(" \t\r\n")
    needs_quote_prefix = stripped_lead.startswith(FORMULA_TRIGGER_PREFIXES)

    # Eğer DDE borusu (|) veya tehlikeli protokol/komut kalıbı varsa metni tamamen etkisizleştir
    if DANGEROUS_DDE_OR_SCHEME_RE.search(cleaned) or (
        needs_quote_prefix and ("|" in cleaned or "!" in cleaned)
    ):
        neutralized = cleaned.replace("|", "/").replace("!", "_")
        return f"'[METİN] {neutralized.lstrip('=+-@| ')}", True

    return cleaned, needs_quote_prefix


def _local_tag_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    if ":" in tag:
        return tag.rsplit(":", 1)[1]
    return tag


def inspect_and_verify_xlsx_bytes(data: bytes) -> str:
    """
    Üretilen .xlsx bayt dizisini sıfır-güven (zero-trust) prensibiyle bellekte tarar:
    1) ZIP sihirli baytı (PK\\x03\\x04), polyglot ekleri, PE/OLE/RTF/LNK ikili imzalar
    2) ZIP bombası, şifreli girdi, path traversal (../) ve katı OOXML dosya beyaz listesi
    3) VBA makroları (vbaProject.bin), XLM makroları, ActiveX, gömülü OLE paketleri
    4) XXE / DTD bildirimleri (<!DOCTYPE / <!ENTITY)
    5) Hücre formülleri (<f>), DDE, dış bağlantılar (TargetMode="External", SMB/UNC, ms-msdt:)
    Başarılıysa dosyanın SHA-256 özetini (hex) döndürür; aksi halde ExcelSecurityError fırlatır.
    """
    if not data or len(data) < 128:
        raise ExcelSecurityError("Oluşturulan Excel dosyası boş veya geçersiz boyutta.")

    if len(data) > MAX_ARCHIVE_BYTES:
        raise ExcelSecurityError("Excel dosyası izin verilen güvenli boyut sınırını aşıyor.")

    for sig, desc in FORBIDDEN_BINARY_MAGICS:
        if data.startswith(sig):
            raise ExcelSecurityError(f"Güvenlik engeli: {desc} tespit edildi.")

    if not data.startswith(b"PK\x03\x04"):
        raise ExcelSecurityError("Geçersiz dosya başlığı: Standart OOXML (ZIP) imzası bulunamadı.")

    # Polyglot kontrolü: EOCD sonunda fazladan eklenmiş veri (trailing payload) olmamalı
    eocd_pos = data.rfind(b"PK\x05\x06")
    if eocd_pos < 0 or eocd_pos + 22 > len(data):
        raise ExcelSecurityError("Bozuk veya değiştirilmiş ZIP sonlandırma kaydı (EOCD).")
    comment_len = int.from_bytes(data[eocd_pos + 20 : eocd_pos + 22], "little")
    if eocd_pos + 22 + comment_len != len(data):
        raise ExcelSecurityError("Dosya sonunda yetkisiz ek veri (polyglot payload) tespit edildi.")

    try:
        zf = zipfile.ZipFile(io.BytesIO(data), mode="r")
    except zipfile.BadZipFile as exc:
        raise ExcelSecurityError("Geçersiz ZIP arşiv yapısı.") from exc

    with zf:
        infos = zf.infolist()
        if not infos or len(infos) > 24:
            raise ExcelSecurityError(f"Beklenmeyen iç dosya sayısı ({len(infos)}).")

        seen_names: set[str] = set()
        total_uncompressed = 0

        for info in infos:
            fname = info.filename
            if fname in seen_names:
                raise ExcelSecurityError(f"Arşiv içinde mükerrer dosya tespit edildi: {fname}")
            seen_names.add(fname)

            if (
                ".." in fname
                or "\\" in fname
                or fname.startswith("/")
                or ":" in fname
                or UNSAFE_CONTROL_AND_BIDI_RE.search(fname)
            ):
                raise ExcelSecurityError(f"Güvensiz arşiv dosya yolu (Zip-Slip): {fname}")

            if info.flag_bits & 0x1:
                raise ExcelSecurityError("Şifrelenmiş arşiv içeriğine izin verilmiyor.")

            if fname not in ALLOWED_OOXML_PATHS:
                raise ExcelSecurityError(
                    f"Excel paketi içinde izin verilmeyen yabancı bileşen tespit edildi: {fname}"
                )

            if info.file_size < 0 or info.file_size > MAX_UNCOMPRESSED_BYTES:
                raise ExcelSecurityError(f"Bileşen boyutu sınırı aşıldı: {fname}")

            if info.compress_size > 0 and (info.file_size / info.compress_size) > MAX_COMPRESSION_RATIO:
                raise ExcelSecurityError(f"Anormal sıkıştırma oranı (Zip-Bomb şüphesi): {fname}")

            total_uncompressed += info.file_size
            if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
                raise ExcelSecurityError("Toplam açılmış Excel boyutu güvenli sınırı aşıyor.")

            raw_member = zf.read(fname)

            for sig, desc in FORBIDDEN_BINARY_MAGICS:
                if raw_member.startswith(sig):
                    raise ExcelSecurityError(f"İç bileşende ({fname}) {desc} tespit edildi.")

            if raw_member.startswith(b"PK\x03\x04"):
                raise ExcelSecurityError(f"İç içe arşiv (nested archive) tespit edildi: {fname}")

            try:
                xml_text = raw_member.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ExcelSecurityError(f"İç bileşen geçerli UTF-8 XML değil: {fname}") from exc

            xml_upper = xml_text[:4096].upper()
            if "<!DOCTYPE" in xml_upper or "<!ENTITY" in xml_upper:
                raise ExcelSecurityError(f"Yasaklı XML DTD / XXE bildirimi tespit edildi: {fname}")

            if fname == "[Content_Types].xml":
                lower_ct = xml_text.lower()
                for bad_tok in FORBIDDEN_CONTENT_TYPE_TOKENS:
                    if bad_tok in lower_ct:
                        raise ExcelSecurityError(
                            f"Yasaklı makro / aktif içerik türü tespit edildi: {bad_tok}"
                        )

            try:
                root = ET.fromstring(xml_text)
            except ET.ParseError as exc:
                raise ExcelSecurityError(f"Bozuk XML yapısı tespit edildi: {fname}") from exc

            for elem in root.iter():
                ltag = _local_tag_name(elem.tag)
                if ltag in FORBIDDEN_XML_LOCAL_TAGS:
                    raise ExcelSecurityError(
                        f"Excel içinde yasaklı aktif/formül bileşeni (<{ltag}>) tespit edildi: {fname}"
                    )

                if ltag == "definedName":
                    dn_name = (elem.attrib.get("name") or "").strip()
                    dn_val = (elem.text or "").strip()
                    if dn_name != "_xlnm._FilterDatabase" or not SAFE_FILTER_RANGE_RE.fullmatch(dn_val):
                        raise ExcelSecurityError(
                            f"Excel içinde yetkisiz adlandırılmış makro/formül tanımı ({dn_name}) engellendi!"
                        )

                if fname.endswith(".rels") and ltag == "Relationship":
                    target_mode = (elem.attrib.get("TargetMode") or "").strip().lower()
                    target_val = (elem.attrib.get("Target") or "").strip()
                    if target_mode == "external":
                        raise ExcelSecurityError(
                            f"Excel içinde dış ağ/şablon bağlantısı (External Relationship) engellendi: {target_val}"
                        )
                    if (
                        ":" in target_val
                        or target_val.startswith("//")
                        or target_val.startswith("\\\\")
                        or ".." in target_val
                    ):
                        raise ExcelSecurityError(
                            f"Excel içinde şüpheli ilişki hedefi engellendi: {target_val}"
                        )

        required_core = {"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/worksheets/sheet1.xml"}
        if not required_core.issubset(seen_names):
            raise ExcelSecurityError("Eksik çekirdek OOXML bileşenleri tespit edildi.")

    return hashlib.sha256(data).hexdigest()
