export type ScanSoundType =
  | 'deduct_full'
  | 'deduct_partial'
  | 'increased'
  | 'restored'
  | 'lookup_active'
  | 'lookup_consumed'
  | 'error';

export const SOUND_STORAGE_KEY = 'pkt_scan_sound_enabled';

export const SCAN_SOUND_LABELS: { type: ScanSoundType; label: string; desc: string }[] = [
  {
    type: 'deduct_full',
    label: 'Tam Stok Düşümü',
    desc: 'Çift tonlu parlak onay sesi',
  },
  {
    type: 'deduct_partial',
    label: 'Kısmi Adet Düşümü',
    desc: 'Üçlü kısa ritmik bildirim sesi',
  },
  {
    type: 'increased',
    label: 'Miktar Artırma (+Adet)',
    desc: 'Çift kademeli yükselen ekleme sesi',
  },
  {
    type: 'restored',
    label: 'Stoğa Geri Alma (İade)',
    desc: 'Dört notalı yükselen geri alma melodisi',
  },
  {
    type: 'lookup_active',
    label: 'Aktif Etiket Sorgusu',
    desc: 'Tekli yumuşak okuma sinyali',
  },
  {
    type: 'lookup_consumed',
    label: 'Düşülmüş Etiket Uyarısı',
    desc: 'Dikkat çekici geri alma hazır sinyali',
  },
  {
    type: 'error',
    label: 'Hata / Geçersiz Kod',
    desc: 'Çift kalın uyarı ikazı',
  },
];

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

export function unlockScanAudio(): void {
  getAudioContext();
}

export function isScanSoundEnabled(): boolean {
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    return raw !== 'false';
  } catch {
    return true;
  }
}

export function setScanSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // ignore storage quota errors
  }
}

interface ToneSpec {
  freq: number;
  endFreq?: number;
  startOffset: number;
  duration: number;
  type: OscillatorType;
  gain: number;
}

function scheduleTones(ctx: AudioContext, tones: ToneSpec[]): void {
  const now = ctx.currentTime + 0.005;

  for (const t of tones) {
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.type = t.type;
    const t0 = now + t.startOffset;
    const tEnd = t0 + t.duration;

    osc.frequency.setValueAtTime(t.freq, t0);
    if (t.endFreq && t.endFreq !== t.freq) {
      osc.frequency.exponentialRampToValueAtTime(t.endFreq, tEnd);
    }

    // Yumuşak attack & release (çıtırtı önleyici)
    gainNode.gain.setValueAtTime(0.0001, t0);
    gainNode.gain.linearRampToValueAtTime(t.gain, t0 + Math.min(0.012, t.duration * 0.25));
    gainNode.gain.setValueAtTime(t.gain, Math.max(t0 + 0.015, tEnd - 0.025));
    gainNode.gain.exponentialRampToValueAtTime(0.0001, tEnd);

    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc.start(t0);
    osc.stop(tEnd + 0.01);
  }
}

export function playScanSound(type: ScanSoundType, opts?: { force?: boolean }): void {
  if (!opts?.force && !isScanSoundEnabled()) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  switch (type) {
    case 'deduct_full':
      // Parlak çift tonlu yükselen barkod onay sesi (A5 -> E6)
      scheduleTones(ctx, [
        { freq: 880, startOffset: 0, duration: 0.085, type: 'triangle', gain: 0.34 },
        { freq: 1318.5, startOffset: 0.09, duration: 0.17, type: 'triangle', gain: 0.38 },
        { freq: 2637, startOffset: 0.09, duration: 0.12, type: 'sine', gain: 0.08 },
      ]);
      break;

    case 'deduct_partial':
      // Üçlü kısa ritmik pip (E5 - E5 - B5) — kısmi düşümü net ayırır
      scheduleTones(ctx, [
        { freq: 659.25, startOffset: 0, duration: 0.065, type: 'sine', gain: 0.32 },
        { freq: 659.25, startOffset: 0.095, duration: 0.065, type: 'sine', gain: 0.32 },
        { freq: 987.77, startOffset: 0.19, duration: 0.13, type: 'triangle', gain: 0.35 },
      ]);
      break;

    case 'increased':
      // Yükselen çift oktav ekleme sinyali (D5 -> A5 -> D6)
      scheduleTones(ctx, [
        { freq: 587.33, startOffset: 0, duration: 0.075, type: 'sine', gain: 0.32 },
        { freq: 880, startOffset: 0.08, duration: 0.075, type: 'sine', gain: 0.34 },
        { freq: 1174.66, startOffset: 0.16, duration: 0.16, type: 'triangle', gain: 0.36 },
      ]);
      break;

    case 'restored':
      // 4 notalı sıcak yükselen geri alma / iade melodisi (C5 -> E5 -> G5 -> C6)
      scheduleTones(ctx, [
        { freq: 523.25, startOffset: 0, duration: 0.075, type: 'triangle', gain: 0.3 },
        { freq: 659.25, startOffset: 0.07, duration: 0.075, type: 'triangle', gain: 0.32 },
        { freq: 783.99, startOffset: 0.14, duration: 0.075, type: 'triangle', gain: 0.34 },
        { freq: 1046.5, startOffset: 0.21, duration: 0.19, type: 'sine', gain: 0.36 },
      ]);
      break;

    case 'lookup_active':
      // Tekli yumuşak okuma sinyali (F#5 -> A5 kayma)
      scheduleTones(ctx, [
        { freq: 739.99, endFreq: 880, startOffset: 0, duration: 0.095, type: 'sine', gain: 0.25 },
      ]);
      break;

    case 'lookup_consumed':
      // Yüksek-alçak-yüksek dikkat sinyali (G5 -> D5 -> G5) — kullanılmış etiket
      scheduleTones(ctx, [
        { freq: 783.99, startOffset: 0, duration: 0.085, type: 'triangle', gain: 0.3 },
        { freq: 587.33, startOffset: 0.095, duration: 0.085, type: 'triangle', gain: 0.3 },
        { freq: 783.99, startOffset: 0.19, duration: 0.12, type: 'triangle', gain: 0.32 },
      ]);
      break;

    case 'error':
      // Çift kalın ikaz buzzer sesi (220Hz -> 165Hz)
      scheduleTones(ctx, [
        { freq: 220, endFreq: 195, startOffset: 0, duration: 0.14, type: 'sawtooth', gain: 0.24 },
        { freq: 165, endFreq: 145, startOffset: 0.18, duration: 0.22, type: 'sawtooth', gain: 0.26 },
      ]);
      break;
  }
}
