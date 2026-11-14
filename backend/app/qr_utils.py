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
PURE_DIGITS_RE = re.compile(r"^\d+$")
PURE_ALPHA_RE = re.compile(r"^[A-Z]+$")
# Bitişik yazılmış iki parçalı level kalıbı: örn. 1ADP02 -> ('1AD', 'P02'), 1AAP05 -> ('1AA', 'P05')
LEVEL_COMPOUND_RE = re.compile(r"^(\d+[A-Z]{1,3})([A-Z]\d{1,4})$")


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


def level_key(value: str) -> str:
    """
    Level için tüm ayırıcılardan (boşluk, -, /, _, . vb.) arındırılmış
    büyük harf ASCII eşdeğerlik anahtarı (parmak izi) üretir.
    Örnekler:
      '1AA', '1 AA', '1-AA', '1/aa', '1Aa' -> '1AA'
      '1AD P02', '1ADp02', '1AD-P02'       -> '1ADP02'
      '1AA-P05', '1AA P05', '1AAP05'       -> '1AAP05'
      'P07' -> 'P07'  ('1ADP07' ile kesinlikle eşleşmez)
    """
    norm = normalize_code(value)
    return re.sub(r"[^A-Z0-9]", "", norm)


def parse_level_segments(value: str) -> list[str]:
    """
    Level bilgisini mantıksal revizyon/faz parçalarına ayırır:
    - Tek parçalı bir kodun içindeki hatalı boşluk/tire/taksimi birleştirir:
        '1 AA', '1-AA', '1/aa' -> ['1AA']
        'P 07', 'p-07'         -> ['P07']
    - Bitişik yazılmış iki parçalı kodları ayırır:
        '1ADp02', '1ADP02'     -> ['1AD', 'P02']
        '1AAP05'               -> ['1AA', 'P05']
    - Çok parçalı ayrı yazımları temizleyerek korur:
        '1 AD P 02'            -> ['1AD', 'P02']
        '1AA-P05'              -> ['1AA', 'P05']
    """
    norm = normalize_code(value)
    if not norm:
        return []

    raw_tokens = [t for t in re.split(r"[^A-Z0-9]+", norm) if t]
    if not raw_tokens:
        return []

    merged: list[str] = []
    i = 0
    while i < len(raw_tokens):
        cur = raw_tokens[i]
        if i + 1 < len(raw_tokens):
            nxt = raw_tokens[i + 1]
            # Örn: '1' + 'AA' -> '1AA' veya '1' + 'ADP' + '02' -> '1ADP02'
            if PURE_DIGITS_RE.fullmatch(cur) and re.match(r"^[A-Z]", nxt):
                merged_tok = cur + nxt
                i += 2
                if (
                    PURE_ALPHA_RE.fullmatch(nxt)
                    and len(nxt) >= 3
                    and i < len(raw_tokens)
                    and PURE_DIGITS_RE.fullmatch(raw_tokens[i])
                ):
                    merged_tok += raw_tokens[i]
                    i += 1
                merged.append(merged_tok)
                continue

            # Örn: 'P' + '07' -> 'P07'
            if PURE_ALPHA_RE.fullmatch(cur) and PURE_DIGITS_RE.fullmatch(nxt):
                merged.append(cur + nxt)
                i += 2
                continue

        merged.append(cur)
        i += 1

    segments: list[str] = []
    for tok in merged:
        m = LEVEL_COMPOUND_RE.fullmatch(tok)
        if m:
            segments.append(m.group(1))
            segments.append(m.group(2))
        else:
            segments.append(tok)

    return segments


def format_standard_level(value: str) -> str:
    """
    Daha önce veritabanında kaydı olmayan bir level için standart yazım üretir:
    - Tek parçalı leveller bitişik: '1AA', '1AD', 'P07', 'AA'
    - İki/çok parçalı leveller tek boşluklu: '1AD P02', '1AA P05'
    """
    segs = parse_level_segments(value)
    if not segs:
        return ""
    return " ".join(segs)


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
