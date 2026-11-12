import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import {
  AlertCircle,
  Camera,
  CameraOff,
  CheckCircle2,
  MinusCircle,
  Printer,
  QrCode,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import { StockItem, StockItemDetail } from '../types';

interface ScanDeductViewProps {
  onPrintItem: (item: StockItem) => void;
  onDeducted: () => void;
}

export const ScanDeductView: React.FC<ScanDeductViewProps> = ({
  onPrintItem,
  onDeducted,
}) => {
  const [scanInput, setScanInput] = useState('');
  const [instantMode, setInstantMode] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);

  const [foundItem, setFoundItem] = useState<StockItemDetail | null>(null);
  const [partialMode, setPartialMode] = useState(false);
  const [partialQty, setPartialQty] = useState('');
  const [deductNote, setDeductNote] = useState('');

  const [lastCompleted, setLastCompleted] = useState<{
    item: StockItemDetail;
    deductedQty: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const processingRef = useRef(false);
  const scanQueueRef = useRef<string[]>([]);
  const instantModeRef = useRef(instantMode);

  useEffect(() => {
    instantModeRef.current = instantMode;
  }, [instantMode]);

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

  const toggleCamera = async () => {
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
            // Aynı QR kodun stop() tamamlanana kadar birden fazla karede tetiklenmesini engelle
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
      if (instantModeRef.current) {
        // Tek atomik API çağrısıyla düşüm yap (yarış durumu olmaz)
        const updated = await api.scanDeduct({ qr_or_code: trimmed });
        const latestMove = updated.movements?.[0];
        const deductedQty = latestMove ? Math.abs(latestMove.quantity_change) : 0;
        setFoundItem(null);
        setLastCompleted({ item: updated, deductedQty });
        onDeducted();
      } else {
        const detail = await api.lookupCode(trimmed);
        setFoundItem(detail);
        setPartialMode(false);
        setPartialQty('');
        setDeductNote('');
      }
    } catch (err: any) {
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
    scanQueueRef.current.push(trimmed);
    drainQueue();
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const current = scanInput.trim();
    if (!current) return;
    // Hemen temizle ki peş peşe barkod okutulduğunda ikinci okutma silinmesin
    setScanInput('');
    enqueueScanCode(current);
  };

  const handleConfirmDeduct = async (deductAll: boolean) => {
    if (!foundItem || processingRef.current) return;
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
      setLastCompleted({ item: updated, deductedQty: qtyToDeduct });
      onDeducted();
      setTimeout(() => inputRef.current?.focus(), 80);
    } catch (err: any) {
      setError(err.message || 'Stoktan düşme işlemi başarısız.');
    } finally {
      processingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Ana Okutma Kartı */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
              <QrCode className="w-6 h-6 text-emerald-600" />
              QR Kod Okut ve Stoktan Düş
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Etiket köşesindeki QR kodu barkod okuyucuyla okutun, kamerayı açın veya etiket
              numarasını yazın.
            </p>
          </div>

          <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-amber-50 border border-amber-200 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={instantMode}
              onChange={(e) => setInstantMode(e.target.checked)}
              className="w-4 h-4 rounded accent-amber-600"
            />
            <Zap className="w-4 h-4 text-amber-600" />
            <span className="text-xs font-extrabold text-amber-900">
              Okutunca Anında Tamamını Düş
            </span>
          </label>
        </div>

        <form onSubmit={handleFormSubmit} className="flex flex-col sm:flex-row gap-3">
          <input
            ref={inputRef}
            type="text"
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            placeholder="QR kodu okutun veya PKT-100001 yazıp Enter'a basın..."
            className="flex-1 rounded-xl border-2 border-slate-300 focus:border-emerald-600 focus:ring-4 focus:ring-emerald-100 px-4 py-4 text-lg font-mono-code font-bold text-slate-900 outline-none"
          />

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !scanInput.trim()}
              className="flex-1 sm:flex-initial px-6 py-4 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white font-extrabold text-sm transition cursor-pointer"
            >
              {busy ? 'İşleniyor...' : 'Sorgula / Okut'}
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
          <div className="mt-4 rounded-xl overflow-hidden border-2 border-slate-300 bg-black p-2">
            <div id="qr-camera-region" className="w-full max-w-sm mx-auto" />
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl bg-red-50 border border-red-200 p-4 flex items-center gap-3 text-red-800">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
            <span className="text-sm font-bold">{error}</span>
          </div>
        )}
      </div>

      {/* Okutulan Etiket Onay & Düşüm Kartı */}
      {foundItem && (
        <div className="bg-white rounded-2xl border-2 border-blue-500 shadow-lg p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-2.5">
              <span className="font-mono-code text-sm font-black bg-slate-900 text-white px-3 py-1 rounded-lg">
                {foundItem.label_code}
              </span>
              {foundItem.status === 'CONSUMED' ? (
                <span className="px-3 py-1 rounded-full bg-red-100 text-red-800 text-xs font-extrabold">
                  BU ETİKET ZATEN KULLANILMIŞ
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
            <div className="rounded-xl bg-slate-900 text-white p-4">
              <div className="text-xs font-bold uppercase text-slate-300">MEVCUT ADET</div>
              <div className="text-4xl font-black mt-1">{foundItem.remaining_quantity}</div>
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

              {!partialMode ? (
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
                      onClick={() => setPartialMode(true)}
                      className="px-5 py-4 rounded-xl border-2 border-slate-300 hover:bg-slate-50 text-slate-800 font-extrabold text-sm transition cursor-pointer"
                    >
                      Kısmi Adet Düş
                    </button>
                  )}
                </div>
              ) : (
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
              )}
            </div>
          ) : (
            <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm font-bold text-red-800">
              Bu etiket daha önce tamamen kullanılmış ve stoktan düşülmüş.
            </div>
          )}
        </div>
      )}

      {/* Başarılı Düşüm Özeti */}
      {lastCompleted && !foundItem && (
        <div className="bg-emerald-50 rounded-2xl border-2 border-emerald-300 p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <CheckCircle2 className="w-7 h-7 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <div className="text-base font-black text-emerald-950">
                Stoktan Düşüldü: {lastCompleted.deductedQty} Adet — {lastCompleted.item.reference} (
                Level {lastCompleted.item.level})
              </div>
              <div className="text-sm font-semibold text-emerald-800 mt-0.5">
                Etiket: <span className="font-mono-code">{lastCompleted.item.label_code}</span> •{' '}
                {lastCompleted.item.remaining_quantity === 0
                  ? 'Etiketin tamamı tüketildi.'
                  : `Depoda kalan yeni miktar: ${lastCompleted.item.remaining_quantity} Adet`}
              </div>
            </div>
          </div>

          {lastCompleted.item.remaining_quantity > 0 && (
            <button
              type="button"
              onClick={() => onPrintItem(lastCompleted.item)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-extrabold shadow-sm cursor-pointer"
            >
              <Printer className="w-4 h-4" />
              Kalan {lastCompleted.item.remaining_quantity} Adet İçin Güncel Etiket Yazdır
            </button>
          )}
        </div>
      )}
    </div>
  );
};
