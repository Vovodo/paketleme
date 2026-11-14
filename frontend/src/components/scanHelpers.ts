const TR_MAP: Record<string, string> = {
  İ: 'I',
  ı: 'I',
  Ş: 'S',
  ş: 'S',
  Ğ: 'G',
  ğ: 'G',
  Ü: 'U',
  ü: 'U',
  Ö: 'O',
  ö: 'O',
  Ç: 'C',
  ç: 'C',
};

export function extractLabelCodeClient(rawInput: string): string | null {
  if (!rawInput) return null;
  const cleaned = rawInput
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .trim()
    .replace(/[İıŞşĞğÜüÖöÇç]/g, (ch) => TR_MAP[ch] || ch)
    .toUpperCase();

  if (!cleaned) return null;

  const m = cleaned.match(/PKT[^A-Z0-9]{0,3}(\d{4,10})(?!\d)/);
  if (m) {
    return `PKT-${m[1]}`;
  }

  if (/^\d{4,10}$/.test(cleaned)) {
    return `PKT-${cleaned}`;
  }

  return cleaned;
}
