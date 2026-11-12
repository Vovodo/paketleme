import re
from typing import Optional

TR_CHAR_MAP = str.maketrans(
    {
        "İ": "I",
        "ı": "I",
        "Ş": "S",
        "ş": "S",
        "Ğ": "G",
        "ğ": "G",
        "Ü": "U",
        "ü": "U",
        "Ö": "O",
        "ö": "O",
        "Ç": "C",
        "ç": "C",
    }
)

ZERO_WIDTH_RE = re.compile(r"[\u200b-\u200f\u202a-\u202e\ufeff]")
NBSP_RE = re.compile(r"[\xa0\u2000-\u200a\u202f\u205f\u3000]")


def normalize_code(value: str) -> str:
    """
    Referans ve Level değerlerini sıfır genişlikli görünmez karakterlerden arındırır,
    özel boşlukları standart boşluğa çevirir ve Türkçe karakterleri ASCII büyük harfe dönüştürür.
    """
    no_zw = ZERO_WIDTH_RE.sub("", value)
    norm_space = NBSP_RE.sub(" ", no_zw)
    translated = norm_space.translate(TR_CHAR_MAP).upper()
    cleaned = re.sub(r"\s+", " ", translated).strip()
    return cleaned


def escape_like(value: str) -> str:
    """SQL LIKE / ILIKE sorgularında %, _ ve \\ joker karakterlerini güvenli hale getirir."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def build_qr_payload(label_code: str, reference: str, level: str, quantity: int) -> str:
    """
    Etiket köşesindeki QR kodda yer alacak veri.
    Örnek: PKT/PKT-100001/R-6683876-HZE-1/L-PO6/Q-20
    """
    norm_ref = normalize_code(reference)
    norm_lvl = normalize_code(level)
    safe_ref = re.sub(r"[^A-Z0-9._-]", "-", norm_ref).strip("-") or "REF"
    safe_lvl = re.sub(r"[^A-Z0-9._-]", "-", norm_lvl).strip("-") or "LVL"
    return f"PKT/{label_code}/R-{safe_ref}/L-{safe_lvl}/Q-{quantity}"


def extract_label_code(raw_input: str) -> Optional[str]:
    """
    Barkod/QR okuyucudan (USB HID Türkçe Q / Türkçe F / İngilizce klavye modları dahil),
    kamera okuyucusundan veya manuel girişten gelen veriden 'PKT-XXXXXX' kodunu çözer.
    """
    if not raw_input:
        return None

    text = ZERO_WIDTH_RE.sub("", raw_input)
    text = NBSP_RE.sub(" ", text).strip().translate(TR_CHAR_MAP).upper()
    if not text:
        return None

    # 1) İçinde PKT + (herhangi ayırıcı: -, *, ?, _, ., /, Ç, boşluk vb.) + rakamlar varsa yakala
    match = re.search(r"PKT[^A-Z0-9]{0,3}(\d{4,10})(?!\d)", text)
    if match:
        return f"PKT-{match.group(1)}"

    # 2) Kullanıcı sadece etiket numarasını girdiyse (örn: 100001)
    if re.fullmatch(r"\d{4,10}", text):
        return f"PKT-{text}"

    return text
