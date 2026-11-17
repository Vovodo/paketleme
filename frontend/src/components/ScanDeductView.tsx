import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import {
  AlertCircle,
  Camera,
  CameraOff,
  CheckCircle2,
  MinusCircle,
  Music2,
  PlusCircle,
  Printer,
  QrCode,
  RotateCcw,
  ShieldCheck,
  Undo2,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import { extractLabelCodeClient } from './scanHelpers';
import {
  isScanSoundEnabled,
  playScanSound,
  SCAN_SOUND_LABELS,
  setScanSoundEnabled,
  unlockScanAudio,
} from '../sound';
import { StockStatusBadge } from '../statusStyles';
import { StockItem, StockItemDetail } from '../types';

type ScanMode = 'confirm' | 'instant' | 'restore_only';

const SCAN_MODE_KEY = 'pkt_scan_mode';

interface ScanDeductViewProps {
  onPrintItem: (item: StockItem) => void;
  onDeducted: () => void;
}

function getRestoreQuantityFromDetail(item: StockItemDetail): number {
  const lastDeduct = item.movements?.find((m) => m.action === 'DEDUCTED');
  if (lastDeduct && lastDeduct.quantity_change !== 0) {
    return Math.abs(lastDeduct.quantity_change);
  }
  return item.initial_quantity;
}

export const ScanDeductView: React.FC<ScanDeductViewProps> = ({
  onPrintItem,
  onDeducted,
}) => {
  const [scanInput, setScanInput] = useState('');
  const [scanMode, setScanMode] = useState<ScanMode>(() => {
    try {
      const saved = localStorage.getItem(SCAN_MODE_KEY);
      if (saved === 'confirm' || saved === 'instant' || saved === 'restore_only') {
        return saved;
      }
    } catch {
      // ignore
    }
    return 'confirm';
  });

  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => isScanSoundEnabled());
  const [showSoundPreview, setShowSoundPreview] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);

  const [foundItem, setFoundItem] = useState<StockItemDetail | null>(null);
  const [partialMode, setPartialMode] = useState(false);
  const [partialQty, setPartialQty] = useState('');
  const [increaseMode, setIncreaseMode] = useState(false);
  const [increaseQty, setIncreaseQty] = useState('');
  const [deductNote, setDeductNote] = useState('');

  const [lastCompleted, setLastCompleted] = useState<{
    kind: 'deduct_full' | 'deduct_partial' | 'increased' | 'restored';
    item: StockItemDetail;
    qty: number;
  } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const processingRef = useRef(false);
  const scanQueueRef = useRef<string[]>([]);
  const scanModeRef = useRef<ScanMode>(scanMode);
  const foundItemRef = useRef<StockItemDetail | null>(foundItem);

  useEffect(() => {
    scanModeRef.current = scanMode;
    try {
      localStorage.setItem(SCAN_MODE_KEY, scanMode);
    } catch {
      // ignore
    }
  }, [scanMode]);

  useEffect(() => {
    foundItemRef.current = foundItem;
  }, [foundItem]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    return () => {
      if (scannerRef.current) {
        scannerRef.current
          .stop()
          .catch(() => {})
          .finally(() => {
            scannerRef.current = null;
          });
      }
    };
  }, []);

  const handleToggleSound = () => {
    unlockScanAudio();
    const next = !soundEnabled;
    setSoundEnabled(next);
    setScanSoundEnabled(next);
    if (next) {
      playScanSound('lookup_active', { force: true });
    }
  };

  const toggleCamera = async () => {
    unlockScanAudio();
    if (cameraActive) {
      if (scannerRef.current) {
        try {
          await scannerRef.current.stop();
        } catch {
          // ignore
        }
        scannerRef.current = null;
      }
      setCameraActive(false);
      return;
    }

    setError(null);
    setCameraActive(true);

    setTimeout(async () => {
      let decodedOnce = false;
      try {
        const html5Qr = new Html5Qrcode('qr-camera-region');
        scannerRef.current = html5Qr;
        await html5Qr.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 240, height: 240 } },
          async (decodedText) => {
            if (decodedOnce) return;
            decodedOnce = true;
            try {
              await html5Qr.stop();
            } catch {
              // ignore
            }
            scannerRef.current = null;
            setCameraActive(false);
            enqueueScanCode(decodedText);
          },
          () => {}
        );
      } catch {
        setCameraActive(false);
        playScanSound('error');
        setError(
          'Kamera başlatılamadı. Tarayıcı kamera iznini kontrol edin veya barkod okuyucu / manuel kod kullanın.'
        );
      }
    }, 100);
  };

  const processSingleCode = async (trimmed: string) => {
    setError(null);
    setBusy(true);

    try {
      const mode = scanModeRef.current;

      if (mode === 'instant') {
        const res = await api.scanAuto({ qr_or_code: trimmed });
        setFoundItem(null);
        if (res.action_performed === 'RESTORED') {
          playScanSound('restored');
          setLastCompleted({
            kind: 'restored',
            item: res.item,
            qty: res.quantity_changed,
          });
        } else {
          playScanSound('deduct_full');
          setLastCompleted({
            kind: 'deduct_full',
            item: res.item,
            qty: res.quantity_changed,
          });
        }
        onDeducted();
        return;
      }

      if (mode === 'restore_only') {
        const restored = await api.scanRestore({ qr_or_code: trimmed });
        const latestMove = restored.movements?.[0];
        const restoredQty = latestMove
          ? Math.abs(latestMove.quantity_change)
          : restored.remaining_quantity;
        setFoundItem(null);
        playScanSound('restored');
        setLastCompleted({
          kind: 'restored',
          item: restored,
          qty: restoredQty,
        });
        onDeducted();
        return;
      }

      // Kontrollü (confirm) Mod:
      // Eğer ekranda zaten CONSUMED (silinmiş) bir etiket açıksa ve operatör AYNI etiketi tekrar okutursa -> direkt geri al!
      const currentFound = foundItemRef.current;
      const scannedCode = extractLabelCodeClient(trimmed);
      if (
        currentFound &&
        currentFound.status === 'CONSUMED' &&
        (currentFound.qr_payload === trimmed ||
          (scannedCode && currentFound.label_code === scannedCode))
      ) {
        const restored = await api.scanRestore({
          qr_or_code: currentFound.label_code,
          note: deductNote.trim() || undefined,
        });
        const latestMove = restored.movements?.[0];
        const restoredQty = latestMove
          ? Math.abs(latestMove.quantity_change)
          : restored.remaining_quantity;
        setFoundItem(null);
        setDeductNote('');
        playScanSound('restored');
        setLastCompleted({
          kind: 'restored',
          item: restored,
          qty: restoredQty,
        });
        onDeducted();
        return;
      }

      const detail = await api.lookupCode(trimmed);
      setFoundItem(detail);
      setPartialMode(false);
      setPartialQty('');
      setIncreaseMode(false);
      setIncreaseQty('');
      setDeductNote('');

      if (detail.status === 'CONSUMED' || detail.remaining_quantity <= 0) {
        playScanSound('lookup_consumed');
      } else {
        playScanSound('lookup_active');
      }
    } catch (err: any) {
      playScanSound('error');
      setError(err.message || 'Etiket bulunamadı.');
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  };

  const drainQueue = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (scanQueueRef.current.length > 0) {
        const nextCode = scanQueueRef.current.shift()!;
        await processSingleCode(nextCode);
      }
    } finally {
      processingRef.current = false;
    }
  };

  const enqueueScanCode = (rawCode: string) => {
    const trimmed = rawCode.trim();
    if (!trimmed) return;
    unlockScanAudio();
    scanQueueRef.current.push(trimmed);
    drainQueue();
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    unlockScanAudio();
    const current = scanInput.trim();
    if (!current) return;
    setScanInput('');
    enqueueScanCode(current);
  };

  const handleConfirmDeduct = async (deductAll: boolean) => {
    if (!foundItem || processingRef.current) return;
    unlockScanAudio();
    setError(null);

    let qtyToDeduct = foundItem.remaining_quantity;
    if (!deductAll) {
      const numVal = Number(partialQty);
      if (
        !partialQty.trim() ||
        !Number.isInteger(numVal) ||
        numVal <= 0 ||
        numVal >= foundItem.remaining_quantity
      ) {
        playScanSound('error');
        setError(
          `Lütfen 1 ile ${foundItem.remaining_quantity - 1} arasında geçerli bir tam sayı girin.`
        );
        return;
      }
      qtyToDeduct = numVal;
    }

    processingRef.current = true;
    setBusy(true);
    try {
      const updated = await api.scanDeduct({
        qr_or_code: foundItem.label_code,
        deduct_quantity: deductAll ? undefined : qtyToDeduct,
        note: deductNote.trim() || undefined,
      });
      setFoundItem(null);
      const isFull = updated.remaining_quantity === 0;
      playScanSound(isFull ? 'deduct_full' : 'deduct_partial');
      setLastCompleted({
        kind: isFull ? 'deduct_full' : 'deduct_partial',
        item: updated,
        qty: qtyToDeduct,
      });
      onDeducted();
      setTimeout(() => inputRef.current?.focus(), 80);
    } catch (err: any) {
      playScanSound('error');
      setError(err.message || 'Stoktan düşme işlemi başarısız.');
    } finally {
      processingRef.current = false;
      setBusy(false);
    }
  };

  const handleConfirmIncrease = async () => {
    if (!foundItem || processingRef.current) return;
    unlockScanAudio();
    setError(null);

    const numVal = Number(increaseQty);
    const maxAdd = 100000 - foundItem.remaining_quantity;
    if (!increaseQty.trim() || !Number.isInteger(numVal) || numVal <= 0 || numVal > maxAdd) {
      playScanSound('error');
      setError(`Lütfen 1 ile ${maxAdd} arasında geçerli bir eklenecek adet girin.`);
      return;
    }

    processingRef.current = true;
    setBusy(true);
    try {
      const updated = await api.scanIncrease({
        qr_or_code: foundItem.label_code,
        add_quantity: numVal,
        note: deductNote.trim() || undefined,
      });
      setFoundItem(null);
      setIncreaseMode(false);
      setIncreaseQty('');
      setDeductNote('');
      playScanSound('increased');
      setLastCompleted({
        kind: 'increased',
        item: updated,
        qty: numVal,
      });
      onDeducted();
      setTimeout(() => inputRef.current?.focus(), 80);
    } catch (err: any) {
      playScanSound('error');
      setError(err.message || 'Miktar artırma işlemi başarısız.');
    } finally {
      processingRef.current = false;
      setBusy(false);
    }
  };

  const handleRestoreLabel = async (labelCode: string, customNote?: string) => {
    if (processingRef.current) return;
    unlockScanAudio();
    setError(null);
    processingRef.current = true;
    setBusy(true);

    try {
      const restored = await api.scanRestore({
        qr_or_code: labelCode,
        note: customNote?.trim() || undefined,
      });
      const latestMove = restored.movements?.[0];
      const restoredQty = latestMove
        ? Math.abs(latestMove.quantity_change)
        : restored.remaining_quantity;

      setFoundItem(null);
      setDeductNote('');
      playScanSound('restored');
      setLastCompleted({
        kind: 'restored',
        item: restored,
        qty: restoredQty,
      });
      onDeducted();
      setTimeout(() => inputRef.current?.focus(), 80);
    } catch (err: any) {
      playScanSound('error');
      setError(err.message || 'Etiket stoğa geri alınamadı.');
    } finally {
      processingRef.current = false;
      setBusy(false);
    }
  };

  const restoreCandidateQty = foundItem ? getRestoreQuantityFromDetail(foundItem) : 0;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Ana Okutma Kartı */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
              <QrCode className="w-6 h-6 text-emerald-600" />
              QR Kod Okut — Stoktan Düş &amp; Geri Al
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Etiket QR kodunu okutarak stoktan düşebilir; yanlışlıkla düşülen etiketi tekrar
              okutarak yeniden basmadan stoğa geri alabilirsiniz.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                unlockScanAudio();
                setShowSoundPreview((v) => !v);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-extrabold transition cursor-pointer ${
                showSoundPreview
                  ? 'border-blue-300 bg-blue-50 text-blue-800'
                  : 'border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700'
              }`}
              title="İşlem seslerini dinle"
            >
              <Music2 className="w-4 h-4" />
              Sesleri Dinle
            </button>

            <button
              type="button"
              onClick={handleToggleSound}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border text-xs font-extrabold transition cursor-pointer ${
                soundEnabled
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border-slate-300 bg-slate-100 text-slate-500'
              }`}
            >
              {soundEnabled ? (
                <>
                  <Volume2 className="w-4 h-4 text-emerald-600" />
                  Ses Açık
                </>
              ) : (
                <>
                  <VolumeX className="w-4 h-4 text-slate-500" />
                  Sessiz
                </>
              )}
            </button>
          </div>
        </div>

        {/* Ses Önizleme Paneli */}
        {showSoundPreview && (
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold uppercase tracking-wider text-slate-600">
                İşlem Türüne Göre Sesli Bildirimler (Test Etmek İçin Tıklayın)
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {SCAN_SOUND_LABELS.map((s) => (
                <button
                  key={s.type}
                  type="button"
                  onClick={() => {
                    unlockScanAudio();
                    playScanSound(s.type, { force: true });
                  }}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white border border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 text-left transition cursor-pointer"
                >
                  <div>
                    <div className="text-xs font-extrabold text-slate-800">{s.label}</div>
                    <div className="text-[11px] text-slate-500">{s.desc}</div>
                  </div>
                  <Volume2 className="w-4 h-4 text-blue-600 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Okutma Modu Seçici */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 p-1.5 rounded-xl bg-slate-100 border border-slate-200">
          <button
            type="button"
            onClick={() => {
              setScanMode('confirm');
              setError(null);
              inputRef.current?.focus();
            }}
            className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-extrabold transition cursor-pointer ${
              scanMode === 'confirm'
                ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0" />
            <span>Kontrollü (Onaylı)</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setScanMode('instant');
              setFoundItem(null);
              setError(null);
              inputRef.current?.focus();
            }}
            className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-extrabold transition cursor-pointer ${
              scanMode === 'instant'
                ? 'bg-amber-500 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Zap className="w-4 h-4 shrink-0" />
            <span>Anında Düş / Tekrar Okut Geri Al</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setScanMode('restore_only');
              setFoundItem(null);
              setError(null);
              inputRef.current?.focus();
            }}
            className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-extrabold transition cursor-pointer ${
              scanMode === 'restore_only'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <RotateCcw className="w-4 h-4 shrink-0" />
            <span>Sadece Geri Alma Modu</span>
          </button>
        </div>

        <form onSubmit={handleFormSubmit} className="flex flex-col sm:flex-row gap-3">
          <input
            ref={inputRef}
            type="text"
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            placeholder={
              scanMode === 'restore_only'
                ? 'Geri alınacak silinmiş etiketin QR kodunu okutun...'
                : scanMode === 'instant'
                ? 'Okutun: Aktifse stoktan düşer, silinmişse stoğa geri alır...'
                : "QR kodu okutun veya PKT-100001 yazıp Enter'a basın..."
            }
            className={`flex-1 rounded-xl border-2 px-4 py-4 text-lg font-mono-code font-bold text-slate-900 outline-none ${
              scanMode === 'restore_only'
                ? 'border-indigo-500 focus:border-indigo-700 focus:ring-4 focus:ring-indigo-100'
                : scanMode === 'instant'
                ? 'border-amber-500 focus:border-amber-600 focus:ring-4 focus:ring-amber-100'
                : 'border-slate-500 focus:border-emerald-600 focus:ring-4 focus:ring-emerald-100'
            }`}
          />

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !scanInput.trim()}
              className={`flex-1 sm:flex-initial px-6 py-4 rounded-xl disabled:bg-slate-300 text-white font-extrabold text-sm transition cursor-pointer ${
                scanMode === 'restore_only'
                  ? 'bg-indigo-600 hover:bg-indigo-700'
                  : 'bg-slate-900 hover:bg-slate-800'
              }`}
            >
              {busy
                ? 'İşleniyor...'
                : scanMode === 'restore_only'
                ? 'Geri Al'
                : scanMode === 'instant'
                ? 'Anında İşle'
                : 'Sorgula / Okut'}
            </button>

            <button
              type="button"
              onClick={toggleCamera}
              className={`inline-flex items-center gap-2 px-4 py-4 rounded-xl border-2 font-bold text-sm transition cursor-pointer ${
                cameraActive
                  ? 'border-red-300 bg-red-50 text-red-700'
                  : 'border-slate-300 hover:bg-slate-50 text-slate-700'
              }`}
            >
              {cameraActive ? (
                <>
                  <CameraOff className="w-5 h-5" />
                  Kapat
                </>
              ) : (
                <>
                  <Camera className="w-5 h-5" />
                  Kamera
                </>
              )}
            </button>
          </div>
        </form>

        {cameraActive && (
          <div className="rounded-xl overflow-hidden border-2 border-slate-300 bg-black p-2">
            <div id="qr-camera-region" className="w-full max-w-sm mx-auto" />
          </div>
        )}

        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 p-4 flex items-center gap-3 text-red-800">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
            <span className="text-sm font-bold">{error}</span>
          </div>
        )}
      </div>

      {/* Okutulan Etiket Onay & Düşüm / Geri Alma Kartı */}
      {foundItem && (
        <div
          className={`bg-white rounded-2xl border-2 shadow-lg p-6 space-y-5 ${
            foundItem.status === 'CONSUMED' ? 'border-indigo-500' : 'border-blue-500'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono-code text-sm font-black bg-slate-900 text-white px-3 py-1 rounded-lg">
                {foundItem.label_code}
              </span>
              <StockStatusBadge
                status={foundItem.status}
                transferredTo={foundItem.transferred_to}
                size="sm"
              />
              {foundItem.status === 'CONSUMED' ? (
                <span className="px-3 py-1 rounded-full bg-indigo-100 text-indigo-800 text-xs font-extrabold">
                  STOĞA GERİ ALINABİLİR
                </span>
              ) : (
                <span className="px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-extrabold">
                  STOKTAN DÜŞÜME HAZIR
                </span>
              )}
            </div>
            <span className="text-xs text-slate-500 font-semibold">
              Giriş: {new Date(foundItem.created_at).toLocaleString('tr-TR')}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-1 rounded-xl bg-slate-50 border border-slate-200 p-4">
              <div className="text-xs font-bold uppercase text-slate-500">REFERANS</div>
              <div className="text-2xl font-black text-slate-900 mt-1 break-all">
                {foundItem.reference}
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
              <div className="text-xs font-bold uppercase text-slate-500">LEVEL</div>
              <div className="text-3xl font-black text-blue-700 mt-1 break-all">
                {foundItem.level}
              </div>
            </div>
            <div
              className={`rounded-xl text-white p-4 ${
                foundItem.status === 'CONSUMED' ? 'bg-indigo-900' : 'bg-slate-900'
              }`}
            >
              <div className="text-xs font-bold uppercase text-slate-300">
                {foundItem.status === 'CONSUMED' ? 'GERİ ALINACAK ADET' : 'MEVCUT ADET'}
              </div>
              <div className="text-4xl font-black mt-1">
                {foundItem.status === 'CONSUMED'
                  ? restoreCandidateQty
                  : foundItem.remaining_quantity}
              </div>
            </div>
          </div>

          {foundItem.status !== 'CONSUMED' && foundItem.remaining_quantity > 0 ? (
            <div className="space-y-4 pt-2">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">
                  İşlem Notu (İsteğe Bağlı)
                </label>
                <input
                  type="text"
                  maxLength={250}
                  value={deductNote}
                  onChange={(e) => setDeductNote(e.target.value)}
                  placeholder="Örn: Paketleme Hat-1'de pakete alındı"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-medium outline-none"
                />
              </div>

              {!partialMode && !increaseMode ? (
                <div className="flex flex-col sm:flex-row gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleConfirmDeduct(true)}
                    className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white font-extrabold text-lg py-4 px-6 shadow-md transition cursor-pointer"
                  >
                    <CheckCircle2 className="w-6 h-6" />
                    TAMAMINI STOKTAN DÜŞ ({foundItem.remaining_quantity} ADET)
                  </button>

                  {foundItem.remaining_quantity > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setIncreaseMode(false);
                        setPartialMode(true);
                      }}
                      className="px-4 py-4 rounded-xl border-2 border-slate-300 hover:bg-slate-50 text-slate-800 font-extrabold text-sm transition cursor-pointer whitespace-nowrap"
                    >
                      Kısmi Adet Düş
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setPartialMode(false);
                      setIncreaseMode(true);
                    }}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-4 rounded-xl border-2 border-blue-300 bg-blue-50 hover:bg-blue-100 text-blue-800 font-extrabold text-sm transition cursor-pointer whitespace-nowrap"
                  >
                    <PlusCircle className="w-4 h-4" />
                    Miktar Arttır
                  </button>
                </div>
              ) : partialMode ? (
                <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-3">
                  <div className="text-sm font-extrabold text-amber-900">
                    Kısmi Kullanım — Kaç Adet Pakete Alındı?
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <input
                      type="number"
                      step={1}
                      min={1}
                      max={foundItem.remaining_quantity - 1}
                      autoFocus
                      value={partialQty}
                      onChange={(e) => setPartialQty(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleConfirmDeduct(false);
                        }
                      }}
                      placeholder={`1 - ${foundItem.remaining_quantity - 1} arası adet`}
                      className="flex-1 rounded-xl border-2 border-amber-300 bg-white px-4 py-3 text-lg font-extrabold outline-none"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleConfirmDeduct(false)}
                      className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 text-white font-extrabold text-sm cursor-pointer"
                    >
                      <MinusCircle className="w-5 h-5" />
                      Seçilen Adedi Düş
                    </button>
                    <button
                      type="button"
                      onClick={() => setPartialMode(false)}
                      className="px-4 py-3 rounded-xl border border-amber-300 text-amber-900 text-xs font-bold cursor-pointer"
                    >
                      İptal
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 space-y-3">
                  <div className="text-sm font-extrabold text-blue-950">
                    Miktar Arttır — Mevcut {foundItem.remaining_quantity} Adedin Üzerine Kaç Adet
                    Eklenecek?
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <input
                      type="number"
                      step={1}
                      min={1}
                      max={100000 - foundItem.remaining_quantity}
                      autoFocus
                      value={increaseQty}
                      onChange={(e) => setIncreaseQty(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleConfirmIncrease();
                        }
                      }}
                      placeholder="Eklenecek adet (Örn: 5)"
                      className="flex-1 rounded-xl border-2 border-blue-300 bg-white px-4 py-3 text-lg font-extrabold text-slate-900 outline-none"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleConfirmIncrease}
                      className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-extrabold text-sm cursor-pointer"
                    >
                      <PlusCircle className="w-5 h-5" />
                      Adedi Ekle
                      {Number.isInteger(Number(increaseQty)) && Number(increaseQty) > 0
                        ? ` (Yeni: ${foundItem.remaining_quantity + Number(increaseQty)})`
                        : ''}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIncreaseMode(false);
                        setIncreaseQty('');
                      }}
                      className="px-4 py-3 rounded-xl border border-blue-300 text-blue-900 text-xs font-bold cursor-pointer"
                    >
                      İptal
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 pt-2">
              <div className="rounded-xl bg-indigo-50 border border-indigo-200 p-4 text-sm text-indigo-950 space-y-1">
                <div className="font-extrabold">
                  Bu etiket daha önce stoktan düşülmüş
                  {foundItem.consumed_at
                    ? ` (${new Date(foundItem.consumed_at).toLocaleString('tr-TR')})`
                    : ''}
                  .
                </div>
                <div className="text-xs font-semibold text-indigo-800">
                  Yanlışlıkla düşüldüyse yeni etiket basmanıza gerek yoktur — aşağıdaki butona
                  tıklayarak veya <strong>aynı etiketi bir kez daha okutarak</strong> elinizdeki
                  mevcut etiketle stoğa geri alabilirsiniz.
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">
                  Geri Alma Notu (İsteğe Bağlı)
                </label>
                <input
                  type="text"
                  maxLength={250}
                  value={deductNote}
                  onChange={(e) => setDeductNote(e.target.value)}
                  placeholder="Örn: Yanlışlıkla okutuldu, depoya iade edildi"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-medium outline-none"
                />
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleRestoreLabel(foundItem.label_code, deductNote)}
                  className="flex-1 inline-flex items-center justify-center gap-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-extrabold text-lg py-4 px-6 shadow-md transition cursor-pointer"
                >
                  <Undo2 className="w-6 h-6" />
                  ETİKETİ STOĞA GERİ AL ({restoreCandidateQty} ADET)
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Son İşlem Özeti (Tam Düşüm / Kısmi Düşüm / Miktar Artırma / Stoğa Geri Alma) */}
      {lastCompleted && !foundItem && (
        <div
          className={`rounded-2xl border-2 p-5 flex flex-wrap items-center justify-between gap-4 ${
            lastCompleted.kind === 'restored'
              ? 'bg-indigo-50 border-indigo-300'
              : lastCompleted.kind === 'increased'
              ? 'bg-blue-50 border-blue-300'
              : lastCompleted.kind === 'deduct_partial'
              ? 'bg-amber-50 border-amber-300'
              : 'bg-emerald-50 border-emerald-300'
          }`}
        >
          <div className="flex items-start gap-3.5">
            {lastCompleted.kind === 'restored' ? (
              <RotateCcw className="w-7 h-7 text-indigo-600 shrink-0 mt-0.5" />
            ) : lastCompleted.kind === 'increased' ? (
              <PlusCircle className="w-7 h-7 text-blue-600 shrink-0 mt-0.5" />
            ) : (
              <CheckCircle2
                className={`w-7 h-7 shrink-0 mt-0.5 ${
                  lastCompleted.kind === 'deduct_partial' ? 'text-amber-600' : 'text-emerald-600'
                }`}
              />
            )}

            <div>
              {lastCompleted.kind === 'restored' ? (
                <>
                  <div className="text-base font-black text-indigo-950">
                    Stoğa Geri Alındı: +{lastCompleted.qty} Adet — {lastCompleted.item.reference} (
                    Level {lastCompleted.item.level})
                  </div>
                  <div className="text-sm font-semibold text-indigo-800 mt-0.5">
                    Etiket: <span className="font-mono-code">{lastCompleted.item.label_code}</span>{' '}
                    • Mevcut basılı etiketiniz yeniden aktif edildi ({lastCompleted.item.remaining_quantity}{' '}
                    Adet depoda).
                  </div>
                </>
              ) : lastCompleted.kind === 'increased' ? (
                <>
                  <div className="text-base font-black text-blue-950">
                    Miktar Artırıldı: +{lastCompleted.qty} Adet Eklendi —{' '}
                    {lastCompleted.item.reference} (Level {lastCompleted.item.level})
                  </div>
                  <div className="text-sm font-semibold text-blue-800 mt-0.5">
                    Etiket: <span className="font-mono-code">{lastCompleted.item.label_code}</span>{' '}
                    • Etiketteki yeni toplam miktar:{' '}
                    <strong>{lastCompleted.item.remaining_quantity} Adet</strong>
                  </div>
                </>
              ) : (
                <>
                  <div
                    className={`text-base font-black ${
                      lastCompleted.kind === 'deduct_partial'
                        ? 'text-amber-950'
                        : 'text-emerald-950'
                    }`}
                  >
                    Stoktan Düşüldü: {lastCompleted.qty} Adet — {lastCompleted.item.reference} (
                    Level {lastCompleted.item.level})
                  </div>
                  <div
                    className={`text-sm font-semibold mt-0.5 ${
                      lastCompleted.kind === 'deduct_partial'
                        ? 'text-amber-800'
                        : 'text-emerald-800'
                    }`}
                  >
                    Etiket: <span className="font-mono-code">{lastCompleted.item.label_code}</span>{' '}
                    •{' '}
                    {lastCompleted.item.remaining_quantity === 0
                      ? 'Etiketin tamamı tüketildi. Yanlışlıkla düşüldüyse tekrar okutarak geri alabilirsiniz.'
                      : `Depoda kalan yeni miktar: ${lastCompleted.item.remaining_quantity} Adet`}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {lastCompleted.kind === 'deduct_full' && lastCompleted.item.status === 'CONSUMED' && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  handleRestoreLabel(
                    lastCompleted.item.label_code,
                    'Yanlış düşüm hemen geri alındı'
                  )
                }
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white hover:bg-indigo-50 border-2 border-indigo-300 text-indigo-800 text-xs font-extrabold shadow-sm cursor-pointer"
              >
                <Undo2 className="w-4 h-4" />
                Yanlışlıkla mı? Stoğa Geri Al
              </button>
            )}

            {lastCompleted.item.remaining_quantity > 0 && (
              <button
                type="button"
                onClick={() => onPrintItem(lastCompleted.item)}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-white text-xs font-extrabold shadow-sm cursor-pointer ${
                  lastCompleted.kind === 'restored'
                    ? 'bg-indigo-700 hover:bg-indigo-800'
                    : lastCompleted.kind === 'increased'
                    ? 'bg-blue-700 hover:bg-blue-800'
                    : 'bg-emerald-700 hover:bg-emerald-800'
                }`}
              >
                <Printer className="w-4 h-4" />
                {lastCompleted.kind === 'restored'
                  ? 'İsterseniz Etiketi Yazdır'
                  : lastCompleted.kind === 'increased'
                  ? `Yeni ${lastCompleted.item.remaining_quantity} Adet İçin Güncel Etiket Yazdır`
                  : `Kalan ${lastCompleted.item.remaining_quantity} Adet İçin Güncel Etiket Yazdır`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
