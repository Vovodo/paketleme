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

const PURE_DIGITS_RE = /^\d+$/;
const PURE_ALPHA_RE = /^[A-Z]+$/;
const LEVEL_COMPOUND_RE = /^(\d+[A-Z]{1,3})([A-Z]\d{1,4})$/;

export function normalizeCodeClient(value: string): string {
  return value
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/[\xa0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[İıŞşĞğÜüÖöÇç]/g, (ch) => TR_MAP[ch] || ch)
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function levelKey(value: string): string {
  return normalizeCodeClient(value).replace(/[^A-Z0-9]/g, '');
}

export function parseLevelSegments(value: string): string[] {
  const norm = normalizeCodeClient(value);
  if (!norm) return [];

  const rawTokens = norm.split(/[^A-Z0-9]+/).filter(Boolean);
  if (!rawTokens.length) return [];

  const merged: string[] = [];
  let i = 0;
  while (i < rawTokens.length) {
    const cur = rawTokens[i];
    if (i + 1 < rawTokens.length) {
      const nxt = rawTokens[i + 1];
      if (PURE_DIGITS_RE.test(cur) && /^[A-Z]/.test(nxt)) {
        let mergedTok = cur + nxt;
        i += 2;
        if (
          PURE_ALPHA_RE.test(nxt) &&
          nxt.length >= 3 &&
          i < rawTokens.length &&
          PURE_DIGITS_RE.test(rawTokens[i])
        ) {
          mergedTok += rawTokens[i];
          i += 1;
        }
        merged.push(mergedTok);
        continue;
      }

      if (PURE_ALPHA_RE.test(cur) && PURE_DIGITS_RE.test(nxt)) {
        merged.push(cur + nxt);
        i += 2;
        continue;
      }
    }

    merged.push(cur);
    i += 1;
  }

  const segments: string[] = [];
  for (const tok of merged) {
    const m = tok.match(LEVEL_COMPOUND_RE);
    if (m) {
      segments.push(m[1], m[2]);
    } else {
      segments.push(tok);
    }
  }

  return segments;
}

export function formatStandardLevel(value: string): string {
  const segs = parseLevelSegments(value);
  if (!segs.length) return '';
  return segs.join(' ');
}

export function resolveCanonicalLevelClient(
  rawValue: string,
  knownLevels: string[] = []
): string {
  const segs = parseLevelSegments(rawValue);
  if (!segs.length) return normalizeCodeClient(rawValue);

  const std = segs.join(' ');
  if (segs.length <= 1) {
    return std;
  }

  const k = levelKey(std);
  for (const known of knownLevels) {
    if (levelKey(known) === k) {
      return known;
    }
  }

  return std;
}
