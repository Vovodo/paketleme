const ALLOWED_OOXML_PATHS = new Set<string>([
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/app.xml',
  'docProps/core.xml',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/styles.xml',
  'xl/sharedStrings.xml',
  'xl/theme/theme1.xml',
  'xl/worksheets/sheet1.xml',
  'xl/worksheets/sheet2.xml',
]);

const REQUIRED_CORE_PATHS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/worksheets/sheet1.xml',
];

const FORBIDDEN_XML_TAGS = new Set<string>([
  'f',
  'oleObjects',
  'oleObject',
  'oleLink',
  'ddeLink',
  'ddeItems',
  'externalReferences',
  'externalReference',
  'externalBook',
  'hyperlinks',
  'hyperlink',
  'webPublishObjects',
  'webPublishObject',
  'controls',
  'control',
  'customPr',
  'queryTable',
  'connections',
  'connection',
]);

const SAFE_FILTER_RANGE_RE = /^'?[^'!=+|]+'?!\$[A-Z]{1,3}\$\d+:\$[A-Z]{1,3}\$\d+$/;

const FORBIDDEN_CONTENT_TYPES = [
  'macroenabled',
  'vbaproject',
  'xlm',
  'macrosheet',
  'activex',
  'oleobject',
  'externallink',
];

const MAX_ARCHIVE_BYTES = 15 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 120;

export interface VerifiedExcelResult {
  sha256: string;
  inspectedFiles: number;
  safeFilename: string;
}

export function sanitizeExcelFilenameClient(rawName: string): string {
  const noCtrl = (rawName || '')
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  let cleaned = noCtrl.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!cleaned.toLowerCase().endsWith('.xlsx')) {
    cleaned = `${cleaned}.xlsx`;
  }
  const stem = cleaned.slice(0, -5).replace(/\./g, '_') || 'paketleme_stok';
  return `${stem}.xlsx`;
}

function startsWithBytes(buf: Uint8Array, prefix: number[]): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix[i]) return false;
  }
  return true;
}

function checkForbiddenBinaryMagic(buf: Uint8Array, contextLabel: string): void {
  if (startsWithBytes(buf, [0x4d, 0x5a])) {
    throw new Error(`Güvenlik Engeli (${contextLabel}): Çalıştırılabilir EXE/DLL (MZ) imzası tespit edildi!`);
  }
  if (startsWithBytes(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    throw new Error(`Güvenlik Engeli (${contextLabel}): Eski tip makro/OLE2 konteyneri tespit edildi!`);
  }
  if (startsWithBytes(buf, [0x7f, 0x45, 0x4c, 0x46])) {
    throw new Error(`Güvenlik Engeli (${contextLabel}): ELF ikili çalıştırılabilir dosya imzası tespit edildi!`);
  }
  if (startsWithBytes(buf, [0x7b, 0x5c, 0x72, 0x74, 0x66])) {
    throw new Error(`Güvenlik Engeli (${contextLabel}): RTF belgesi imzası tespit edildi!`);
  }
  if (startsWithBytes(buf, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) {
    throw new Error(`Güvenlik Engeli (${contextLabel}): Windows kısayol (.lnk) zararlısı tespit edildi!`);
  }
}

// HTTP (non-HTTPS IP) ortamlarında bile çalışması için saf TS SHA-256 yedek hesaplayıcı
function sha256Fallback(bytes: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const bitLen = bytes.length * 8;
  const padLen = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(padLen - 4, bitLen >>> 0, false);

  const W = new Uint32Array(64);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof window !== 'undefined' && window.crypto?.subtle) {
    const digest = await window.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return sha256Fallback(new Uint8Array(buffer));
}

async function inflateRawBounded(compressed: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Tarayıcınız güvenli arşiv taramasını (DecompressionStream) desteklemiyor.');
  }
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(compressed).catch(() => {});
  writer.close().catch(() => {});

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Güvenlik Engeli: Aşırı sıkıştırılmış veri (Zip-Bomb) tespit edildi!');
      }
      chunks.push(value);
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function findEocdOffset(bytes: Uint8Array, dv: DataView): number {
  const minPos = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      return i;
    }
  }
  return -1;
}

function inspectXmlDocument(fileName: string, xmlText: string): void {
  const headUpper = xmlText.slice(0, 4096).toUpperCase();
  if (headUpper.includes('<!DOCTYPE') || headUpper.includes('<!ENTITY')) {
    throw new Error(`Güvenlik Engeli (${fileName}): Yasaklı XXE / DTD bildirimi tespit edildi!`);
  }

  if (fileName === '[Content_Types].xml') {
    const lower = xmlText.toLowerCase();
    for (const bad of FORBIDDEN_CONTENT_TYPES) {
      if (lower.includes(bad)) {
        throw new Error(`Güvenlik Engeli: Excel içinde makro / aktif bileşen türü (${bad}) tespit edildi!`);
      }
    }
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error(`Güvenlik Engeli (${fileName}): Bozuk veya manipüle edilmiş XML yapısı!`);
  }

  const allNodes = doc.getElementsByTagName('*');
  for (let i = 0; i < allNodes.length; i++) {
    const el = allNodes[i];
    const localName = el.localName || el.tagName.split(':').pop() || '';

    if (FORBIDDEN_XML_TAGS.has(localName)) {
      throw new Error(
        `Güvenlik Engeli (${fileName}): Excel içinde yasaklı aktif/formül etiketi (<${localName}>) tespit edildi!`
      );
    }

    if (localName === 'definedName') {
      const dnName = (el.getAttribute('name') || '').trim();
      const dnVal = (el.textContent || '').trim();
      if (dnName !== '_xlnm._FilterDatabase' || !SAFE_FILTER_RANGE_RE.test(dnVal)) {
        throw new Error(
          `Güvenlik Engeli (${fileName}): Yetkisiz adlandırılmış makro/formül tanımı (${dnName}) tespit edildi!`
        );
      }
    }

    if (fileName.endsWith('.rels') && localName === 'Relationship') {
      const targetMode = (el.getAttribute('TargetMode') || '').trim().toLowerCase();
      const target = (el.getAttribute('Target') || '').trim();
      if (targetMode === 'external') {
        throw new Error(`Güvenlik Engeli: Excel içinde dış ağ bağlantısı (${target}) tespit edildi!`);
      }
      if (
        target.includes(':') ||
        target.startsWith('//') ||
        target.startsWith('\\\\') ||
        target.includes('..')
      ) {
        throw new Error(`Güvenlik Engeli: Şüpheli iç referans hedefi (${target}) engellendi!`);
      }
    }
  }
}

/**
 * İndirilen Excel (.xlsx) dosyasını KULLANICININ DİSKİNE KAYDETMEDEN ÖNCE
 * tarayıcı belleğinde (ArrayBuffer) açıp tüm bileşenlerini bağımsız olarak tarar.
 * Sunucu veya aradaki ağ ele geçirilmiş olsa dahi makro, formül, OLE, EXE veya dış bağlantı içeren
 * hiçbir dosyanın bilgisayara inmesine izin vermez.
 */
export async function verifyExcelBufferInBrowser(
  buffer: ArrayBuffer,
  rawFilename: string,
  expectedServerSha256?: string | null
): Promise<VerifiedExcelResult> {
  if (!buffer || buffer.byteLength < 128) {
    throw new Error('Güvenlik Engeli: İndirilen dosya boş veya geçersiz.');
  }
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Güvenlik Engeli: İndirilen dosya güvenli boyut sınırını (15 MB) aşıyor.');
  }

  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  checkForbiddenBinaryMagic(bytes, 'Dosya Başlığı');

  // İlk 4 bayt kesinlikle ZIP Local File Header (PK\x03\x04) olmalı (polyglot önlemi)
  if (dv.getUint32(0, true) !== 0x04034b50) {
    throw new Error('Güvenlik Engeli: Dosya geçerli bir OOXML (.xlsx) paketi değil!');
  }

  const eocdOffset = findEocdOffset(bytes, dv);
  if (eocdOffset < 0) {
    throw new Error('Güvenlik Engeli: ZIP merkezi dizin sonu (EOCD) bulunamadı.');
  }

  const commentLen = dv.getUint16(eocdOffset + 20, true);
  if (eocdOffset + 22 + commentLen !== bytes.length) {
    throw new Error('Güvenlik Engeli: Dosya sonuna gizlenmiş ek veri (polyglot payload) tespit edildi!');
  }

  const totalEntries = dv.getUint16(eocdOffset + 10, true);
  const cdSize = dv.getUint32(eocdOffset + 12, true);
  const cdOffset = dv.getUint32(eocdOffset + 16, true);

  if (totalEntries === 0 || totalEntries > 24) {
    throw new Error(`Güvenlik Engeli: Beklenmeyen iç dosya sayısı (${totalEntries}).`);
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw new Error('Güvenlik Engeli: Bozuk ZIP merkezi dizin tablosu.');
  }

  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
  const seenNames = new Set<string>();
  let totalUncompressed = 0;
  let ptr = cdOffset;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (ptr + 46 > eocdOffset || dv.getUint32(ptr, true) !== 0x02014b50) {
      throw new Error('Güvenlik Engeli: Bozuk ZIP dizin kaydı.');
    }

    const flags = dv.getUint16(ptr + 8, true);
    const compressionMethod = dv.getUint16(ptr + 10, true);
    const compressedSize = dv.getUint32(ptr + 20, true);
    const uncompressedSize = dv.getUint32(ptr + 24, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const entryCommentLen = dv.getUint16(ptr + 32, true);
    const localHeaderOffset = dv.getUint32(ptr + 42, true);

    if (flags & 0x1) {
      throw new Error('Güvenlik Engeli: Şifrelenmiş arşiv içeriği tespit edildi!');
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(`Güvenlik Engeli: Desteklenmeyen sıkıştırma yöntemi (${compressionMethod}).`);
    }

    const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
    let fileName: string;
    try {
      fileName = utf8Decoder.decode(nameBytes);
    } catch {
      throw new Error('Güvenlik Engeli: Geçersiz kodlamalı arşiv dosya adı.');
    }

    if (seenNames.has(fileName)) {
      throw new Error(`Güvenlik Engeli: Arşiv içinde mükerrer dosya (${fileName}).`);
    }
    seenNames.add(fileName);

    if (
      fileName.includes('..') ||
      fileName.includes('\\') ||
      fileName.startsWith('/') ||
      fileName.includes(':') ||
      /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(fileName)
    ) {
      throw new Error(`Güvenlik Engeli: Zararlı arşiv dosya yolu (${fileName})!`);
    }

    if (!ALLOWED_OOXML_PATHS.has(fileName)) {
      throw new Error(
        `Güvenlik Engeli: Excel içinde izin verilmeyen yabancı/zararlı dosya tespit edildi (${fileName})!`
      );
    }

    if (uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`Güvenlik Engeli: Aşırı büyük iç bileşen (${fileName}).`);
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
      throw new Error(`Güvenlik Engeli: Zip-Bomb sıkıştırma oranı tespit edildi (${fileName}).`);
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('Güvenlik Engeli: Toplam açılmış boyut sınırı aşıldı.');
    }

    if (localHeaderOffset + 30 > cdOffset || dv.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`Güvenlik Engeli: Bozuk yerel dosya başlığı (${fileName}).`);
    }
    const localNameLen = dv.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = dv.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > cdOffset) {
      throw new Error(`Güvenlik Engeli: Taşan sıkıştırılmış veri bloğu (${fileName}).`);
    }

    const rawSlice = bytes.subarray(dataStart, dataEnd);
    const contentBytes =
      compressionMethod === 0
        ? rawSlice
        : await inflateRawBounded(rawSlice, MAX_UNCOMPRESSED_BYTES);

    checkForbiddenBinaryMagic(contentBytes, fileName);
    if (startsWithBytes(contentBytes, [0x50, 0x4b, 0x03, 0x04])) {
      throw new Error(`Güvenlik Engeli: İç içe gizlenmiş arşiv (${fileName}) tespit edildi!`);
    }

    let xmlText: string;
    try {
      xmlText = utf8Decoder.decode(contentBytes);
    } catch {
      throw new Error(`Güvenlik Engeli: İkili/bozuk veri içeren sözde XML dosyası (${fileName})!`);
    }

    inspectXmlDocument(fileName, xmlText);

    ptr += 46 + nameLen + extraLen + entryCommentLen;
  }

  for (const reqPath of REQUIRED_CORE_PATHS) {
    if (!seenNames.has(reqPath)) {
      throw new Error(`Güvenlik Engeli: Eksik çekirdek OOXML bileşeni (${reqPath}).`);
    }
  }

  const sha256 = await computeSha256Hex(buffer);
  if (expectedServerSha256 && expectedServerSha256.trim().toLowerCase() !== sha256.toLowerCase()) {
    throw new Error(
      'Güvenlik Engeli: İndirilen dosyanın SHA-256 bütünlük imzası sunucu imzasıyla uyuşmuyor (Ağ/Proxy müdahalesi tespit edildi)!'
    );
  }

  return {
    sha256,
    inspectedFiles: seenNames.size,
    safeFilename: sanitizeExcelFilenameClient(rawFilename),
  };
}
