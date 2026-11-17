import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import {
  AlertCircle,
  ArrowRight,
  ArrowRightLeft,
  Camera,
  CameraOff,
  CheckCircle2,
  MapPin,
  Printer,
  QrCode,
  Search,
  Undo2,
  Volume2,
  VolumeX,
  Warehouse,
  X,
} from 'lucide-react';
import { api } from '../api';
import {
  isScanSoundEnabled,
  playScanSound,
  setScanSoundEnabled,
  unlockScanAudio,
} from '../sound';
import { getRowStatusClasses, StockStatusBadge } from '../statusStyles';
import { StockItem, StockItemDetail } from '../types';

const SAVED_TARGET_KEY = 'pkt_last_transfer_target';

const DEFAULT_QUICK_TARGETS = [
  'PAKETLEME HAT-1',
  'PAKETLEME HAT-2',
  'ÜRETİM BANDI',
  'KALİTE KONTROL',
];

interface TransferViewProps {
  refreshKey: number;
  onPrintItem: (item: StockItem) => void;
  onTransferred: () => void;
}

export const TransferView: React.FC<TransferViewProps> = ({
  refreshKey,
  onPrintItem,
  onTransferred,
}) => {
  const [targetLocation, setTargetLocation] = useState<string>(() => {
    try {
      return localStorage.getItem(SAVED_TARGET_KEY) || '';
    } catch {
      return '';
    }
  });
  const [transferNote, setTransferNote] = useState('');
  const [scanInput, setScanInput] = useState('');
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => isScanSoundEnabled());
  const [cameraActive, setCameraActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lastTransferred, setLastTransferred] = useState<{
    item: StockItemDetail;
    destinationLabel: string;
    returnedToWarehouse: boolean;
  } | null>(null);

  const [transferredItems, setTransferredItems] = useState<StockItem[]>([]);
  const [knownTargets, setKnownTargets] = useState<string[]>([]);
  const [placeFilter, setPlaceFilter] = useState<string>('ALL');
  const [tableSearch, setTableSearch] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [rowBusyId, setRowBusyId] = useState<number | null>(null);

  const targetInputRef = useRef<HTMLInputElement>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const processingRef = useRef(false);
  const scanQueueRef = useRef<string[]>([]);
  const targetRef = useRef(targetLocation);
  const noteRef = useRef(transferNote);

  useEffect(() => {
    targetRef.current = targetLocation;
    try {
      localStorage.setItem(SAVED_TARGET_KEY, targetLocation);
    } catch {
      // ignore
    }
  }, [targetLocation]);

  useEffect(() => {
    noteRef.current = transferNote;
  }, [transferNote]);

  const loadTransferData = async () => {
    try {
      const [itemsRes, suggRes] = await Promise.all([
        api.listStock({ status: 'TRANSFERRED', sort: 'newest' }),
        api.getSuggestions(),
      ]);
      setTransferredItems(itemsRes);
      setKnownTargets(suggRes.top_transfer_targets || []);
    } catch {
      // ignore
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    loadTransferData();
  }, [refreshKey]);

  useEffect(() => {
    if (targetLocation.trim()) {
      scanInputRef.current?.focus();
    } else {
      targetInputRef.current?.focus();
    }
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

  const quickButtons = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of [...knownTargets, ...DEFAULT_QUICK_TARGETS]) {
      const clean = t.trim().toLocaleUpperCase('tr-TR');
      if (!clean || clean === 'DEPO' || clean === 'ANA DEPO') continue;
      if (!map.has(clean)) {
        map.set(clean, clean);
      }
    }
    return Array.from(map.values()).slice(0, 8);
  }, [knownTargets]);

  const selectQuickTarget = (dest: string) => {
    setTargetLocation(dest);
    setError(null);
    setTimeout(() => {
      scanInputRef.current?.focus();
    }, 40);
  };

  const handleToggleSound = () => {
    unlockScanAudio();
    const next = !soundEnabled;
    setSoundEnabled(next);
    setScanSoundEnabled(next);
    if (next) {
      playScanSound('transferred', { force: true });
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

    if (!targetRef.current.trim()) {
      playScanSound('error');
      setError('Önce 1. Adımdan ürünün gideceği yeri seçin veya yazın.');
      targetInputRef.current?.focus();
      return;
    }

    setError(null);
    setCameraActive(true);

    setTimeout(async () => {
      let decodedOnce = false;
      try {
        const html5Qr = new Html5Qrcode('qr-transfer-camera-region');
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
        setError('Kamera başlatılamadı. Kamera iznini kontrol edin veya barkod okuyucu kullanın.');
      }
    }, 100);
  };

  const processSingleTransfer = async (code: string) => {
    const dest = targetRef.current.trim();
    if (!dest) {
      playScanSound('error');
      setError('Lütfen önce 1. Adımda ürünün transfer edileceği yeri seçin veya yazın!');
      setTimeout(() => targetInputRef.current?.focus(), 40);
      return;
    }

    setError(null);
    setBusy(true);

    try {
      const updated = await api.scanTransfer({
        qr_or_code: code,
        target_location: dest,
        note: noteRef.current.trim() || undefined,
      });

      const returned = updated.status === 'IN_STOCK';
      playScanSound('transferred');
      setLastTransferred({
        item: updated,
        destinationLabel: returned ? 'Depoda' : updated.transferred_to || dest.toLocaleUpperCase('tr-TR'),
        returnedToWarehouse: returned,
      });

      onTransferred();
      loadTransferData();
    } catch (err: any) {
      playScanSound('error');
      setError(err.message || 'Transfer işlemi yapılamadı.');
    } finally {
      setBusy(false);
      setTimeout(() => scanInputRef.current?.focus(), 60);
    }
  };

  const drainQueue = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (scanQueueRef.current.length > 0) {
        const nextCode = scanQueueRef.current.shift()!;
        await processSingleTransfer(nextCode);
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
    if (!targetLocation.trim()) {
      playScanSound('error');
      setError('Lütfen önce 1. Adımda ürünün transfer edileceği yeri yazın veya aşağıdan seçin!');
      targetInputRef.current?.focus();
      return;
    }
    const current = scanInput.trim();
    if (!current) {
      scanInputRef.current?.focus();
      return;
    }
    setScanInput('');
    enqueueScanCode(current);
  };

  const handleReturnToWarehouse = async (labelCode: string, rowId?: number) => {
    unlockScanAudio();
    if (rowId) setRowBusyId(rowId);
    setError(null);
    try {
      const updated = await api.scanTransfer({
        qr_or_code: labelCode,
        target_location: 'DEPO',
        note: 'Tek tıkla depoya geri alındı',
      });
      playScanSound('restored');
      setLastTransferred({
        item: updated,
        destinationLabel: 'Depoda',
        returnedToWarehouse: true,
      });
      onTransferred();
      loadTransferData();
    } catch (err: any) {
      playScanSound('error');
      setError(err.message || 'Depoya geri alınamadı.');
    } finally {
      if (rowId) setRowBusyId(null);
    }
  };

  const distinctPlacesInField = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of transferredItems) {
      const p = (it.transferred_to || 'Transferde').trim();
      counts.set(p, (counts.get(p) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [transferredItems]);

  const visibleTransferredItems = useMemo(() => {
    return transferredItems.filter((it) => {
      if (placeFilter !== 'ALL' && (it.transferred_to || '') !== placeFilter) {
        return false;
      }
      if (!tableSearch.trim()) return true;
      const q = tableSearch.trim().toLocaleUpperCase('tr-TR');
      return (
        it.reference.toLocaleUpperCase('tr-TR').includes(q) ||
        it.label_code.toLocaleUpperCase('tr-TR').includes(q) ||
        it.level.toLocaleUpperCase('tr-TR').includes(q) ||
        (it.transferred_to || '').toLocaleUpperCase('tr-TR').includes(q) ||
        (it.created_by || '').toLocaleUpperCase('tr-TR').includes(q)
      );
    });
  }, [transferredItems, placeFilter, tableSearch]);

  const isReturnMode = ['DEPO', 'ANA DEPO', 'DEPOYA'].includes(
    targetLocation.trim().toLocaleUpperCase('tr-TR')
  );

  return (
    <div className="space-y-6">
      {/* ÜST AÇIKLAMA BANNERI */}
      <div className="bg-violet-600 text-white rounded-2xl p-5 shadow-md flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-white/15 flex items-center justify-center shrink-0">
            <ArrowRightLeft className="w-7 h-7 text-white" />
          </div>
          <div>
            <h2 className="text-xl font-black tracking-tight">
              Ürün Transfer Ekranı (2 Adımda Kolay Konum Değiştir)
            </h2>
            <p className="text-sm text-violet-100 font-semibold mt-0.5">
              1) Önce ürünün gideceği yeri seçin • 2) Etiketi okutun — ürün stok tablosunda anında o
              yerde görünür!
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleToggleSound}
          className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 text-xs font-extrabold transition cursor-pointer ${
            soundEnabled
              ? 'border-white bg-white text-violet-900 shadow-xs'
              : 'border-white/40 bg-violet-700 text-violet-100'
          }`}
        >
          {soundEnabled ? (
            <>
              <Volume2 className="w-4 h-4 text-violet-700" />
              Sesli Uyarı Açık
            </>
          ) : (
            <>
              <VolumeX className="w-4 h-4" />
              Sessiz Mod
            </>
          )}
        </button>
      </div>

      {/* 2 ADIMLI ANA TRANSFER KARTI */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* 1. ADIM: NEREYE TRANSFER EDİLECEK? */}
        <div className="lg:col-span-6 bg-white rounded-2xl border-2 border-violet-300 shadow-sm p-6 flex flex-col justify-between space-y-4">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl bg-violet-600 text-white font-black text-lg flex items-center justify-center shadow-xs shrink-0">
                1
              </span>
              <div>
                <h3 className="text-base sm:text-lg font-black text-slate-900 uppercase">
                  Ürün Nereye Gidecek?
                </h3>
                <p className="text-xs font-semibold text-slate-500">
                  Aşağıdaki hazır yerlerden birine tıklayın veya istediğiniz yeri kutuya yazın.
                </p>
              </div>
            </div>

            <div className="relative">
              <MapPin className="w-5 h-5 text-violet-600 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={targetInputRef}
                type="text"
                maxLength={120}
                value={targetLocation}
                onChange={(e) => {
                  setTargetLocation(e.target.value.toLocaleUpperCase('tr-TR'));
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    scanInputRef.current?.focus();
                  }
                }}
                placeholder="Örn: PAKETLEME HAT-1, BANT-2, KALİTE..."
                className="w-full pl-12 pr-10 py-4 rounded-xl border-2 border-slate-500 focus:border-violet-600 focus:ring-4 focus:ring-violet-100 text-lg font-black uppercase text-slate-900 placeholder:text-slate-400 placeholder:font-semibold outline-none transition"
              />
              {targetLocation && (
                <button
                  type="button"
                  onClick={() => {
                    setTargetLocation('');
                    targetInputRef.current?.focus();
                  }}
                  title="Hedef yeri temizle"
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            {/* Tek Tıkla Hazır Hedef Butonları */}
            <div className="space-y-2">
              <div className="text-xs font-extrabold uppercase tracking-wider text-slate-500">
                Tek Tıkla Hızlı Yer Seçimi:
              </div>
              <div className="flex flex-wrap gap-2">
                {quickButtons.map((place) => {
                  const active = targetLocation.trim().toLocaleUpperCase('tr-TR') === place;
                  return (
                    <button
                      key={place}
                      type="button"
                      onClick={() => selectQuickTarget(place)}
                      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border-2 text-xs font-extrabold transition cursor-pointer ${
                        active
                          ? 'border-violet-600 bg-violet-600 text-white shadow-sm'
                          : 'border-violet-200 bg-violet-50 hover:bg-violet-100 text-violet-900'
                      }`}
                    >
                      <MapPin className="w-3.5 h-3.5 shrink-0" />
                      {place}
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={() => selectQuickTarget('DEPO')}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border-2 text-xs font-extrabold transition cursor-pointer ${
                    isReturnMode
                      ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm'
                      : 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-900'
                  }`}
                >
                  <Warehouse className="w-3.5 h-3.5 shrink-0" />
                  DEPO (Depoya Geri Al)
                </button>
              </div>
            </div>
          </div>

          {/* İsteğe Bağlı Açıklama Notu */}
          <div className="pt-2 border-t border-slate-100">
            <label className="block text-xs font-extrabold uppercase tracking-wide text-slate-600 mb-1">
              Transfer Notu (İsteğe Bağlı)
            </label>
            <input
              type="text"
              maxLength={200}
              value={transferNote}
              onChange={(e) => setTransferNote(e.target.value)}
              placeholder="Örn: Sabah vardiyası için hatta verildi"
              className="w-full px-3.5 py-2.5 rounded-xl border-2 border-slate-300 focus:border-violet-600 text-sm font-semibold text-slate-800 outline-none"
            />
          </div>
        </div>

        {/* 2. ADIM: ETİKETİ OKUTUN */}
        <div className="lg:col-span-6 bg-white rounded-2xl border-2 border-slate-300 shadow-sm p-6 flex flex-col justify-between space-y-4">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl bg-slate-900 text-white font-black text-lg flex items-center justify-center shadow-xs shrink-0">
                2
              </span>
              <div>
                <h3 className="text-base sm:text-lg font-black text-slate-900 uppercase">
                  Etiketi Okutun ve Aktarın
                </h3>
                <p className="text-xs font-semibold text-slate-500">
                  Barkod tabancasıyla QR kodu okutun, kamerayı açın veya PKT kodunu yazıp Enter'a
                  basın.
                </p>
              </div>
            </div>

            {/* Seçili Hedef Durum Kutusu */}
            {targetLocation.trim() ? (
              <div
                className={`rounded-xl border-2 p-3.5 flex items-center justify-between gap-3 ${
                  isReturnMode
                    ? 'border-emerald-400 bg-emerald-50 text-emerald-950'
                    : 'border-violet-400 bg-violet-50 text-violet-950'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {isReturnMode ? (
                    <Warehouse className="w-5 h-5 text-emerald-700 shrink-0" />
                  ) : (
                    <MapPin className="w-5 h-5 text-violet-700 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="text-[11px] font-extrabold uppercase opacity-75">
                      Okutulan Etiketlerin Gideceği Yer:
                    </div>
                    <div className="text-lg font-black truncate">
                      {isReturnMode ? 'DEPO (Depoda Bekliyor)' : targetLocation.trim()}
                    </div>
                  </div>
                </div>
                <span className="px-2.5 py-1 rounded-lg bg-white/90 border border-black/10 text-[11px] font-extrabold shrink-0">
                  Okutmaya Hazır
                </span>
              </div>
            ) : (
              <div className="rounded-xl border-2 border-dashed border-amber-400 bg-amber-50 p-3.5 text-amber-950 text-sm font-extrabold flex items-center gap-2.5">
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
                <span>Önce sol taraftaki 1. Adımdan ürünün gideceği yeri seçin!</span>
              </div>
            )}

            <form onSubmit={handleFormSubmit} className="space-y-3">
              <div className="relative">
                <QrCode className="w-5 h-5 text-slate-500 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  ref={scanInputRef}
                  type="text"
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  placeholder="QR kodu okutun veya PKT-100001 yazın..."
                  className="w-full pl-12 pr-4 py-4 rounded-xl border-2 border-slate-500 focus:border-violet-600 focus:ring-4 focus:ring-violet-100 text-lg font-mono-code font-bold text-slate-900 placeholder:text-slate-400 placeholder:font-sans outline-none transition"
                />
              </div>

              <div className="flex flex-col sm:flex-row gap-2.5">
                <button
                  type="submit"
                  disabled={busy || !scanInput.trim()}
                  className={`flex-1 inline-flex items-center justify-center gap-2 py-4 px-6 rounded-xl text-white font-black text-base shadow-md transition cursor-pointer disabled:bg-slate-300 ${
                    isReturnMode
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : 'bg-violet-600 hover:bg-violet-700'
                  }`}
                >
                  <ArrowRight className="w-5 h-5" />
                  {busy
                    ? 'Transfer Ediliyor...'
                    : isReturnMode
                    ? 'DEPOYA GERİ AKTAR'
                    : `${targetLocation.trim() || 'SEÇİLİ YERE'} TRANSFER ET`}
                </button>

                <button
                  type="button"
                  onClick={toggleCamera}
                  className={`inline-flex items-center justify-center gap-2 px-5 py-4 rounded-xl border-2 font-extrabold text-sm transition cursor-pointer ${
                    cameraActive
                      ? 'border-red-400 bg-red-50 text-red-700'
                      : 'border-slate-400 bg-white hover:bg-slate-50 text-slate-800'
                  }`}
                >
                  {cameraActive ? (
                    <>
                      <CameraOff className="w-5 h-5" />
                      Kamerayı Kapat
                    </>
                  ) : (
                    <>
                      <Camera className="w-5 h-5" />
                      Kamera ile Okut
                    </>
                  )}
                </button>
              </div>
            </form>

            {cameraActive && (
              <div className="rounded-xl overflow-hidden border-2 border-slate-400 bg-black p-2">
                <div id="qr-transfer-camera-region" className="w-full max-w-sm mx-auto" />
              </div>
            )}

            {error && (
              <div className="rounded-xl bg-red-50 border-2 border-red-300 p-4 flex items-center gap-3 text-red-900">
                <AlertCircle className="w-6 h-6 text-red-600 shrink-0" />
                <span className="text-sm font-extrabold">{error}</span>
              </div>
            )}
          </div>

          {/* Son Yapılan Transfer Onay Kartı */}
          {lastTransferred && (
            <div
              className={`rounded-2xl border-2 p-4 flex flex-wrap items-center justify-between gap-3 ${
                lastTransferred.returnedToWarehouse
                  ? 'border-emerald-400 bg-emerald-50'
                  : 'border-violet-400 bg-violet-50'
              }`}
            >
              <div className="flex items-start gap-3">
                <CheckCircle2
                  className={`w-7 h-7 shrink-0 mt-0.5 ${
                    lastTransferred.returnedToWarehouse ? 'text-emerald-600' : 'text-violet-600'
                  }`}
                />
                <div>
                  <div className="text-xs font-extrabold uppercase tracking-wider text-slate-600">
                    Transfer Tamamlandı
                  </div>
                  <div className="text-base font-black text-slate-900 mt-0.5">
                    {lastTransferred.item.reference} (Level {lastTransferred.item.level} •{' '}
                    {lastTransferred.item.remaining_quantity} Adet)
                  </div>
                  <div className="text-xs font-bold text-slate-700 mt-1 flex flex-wrap items-center gap-2">
                    <span className="font-mono-code bg-slate-900 text-white px-2 py-0.5 rounded">
                      {lastTransferred.item.label_code}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                    <StockStatusBadge
                      status={lastTransferred.item.status}
                      transferredTo={lastTransferred.item.transferred_to}
                      size="sm"
                    />
                  </div>
                </div>
              </div>

              {!lastTransferred.returnedToWarehouse && (
                <button
                  type="button"
                  onClick={() => handleReturnToWarehouse(lastTransferred.item.label_code)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white hover:bg-emerald-50 border-2 border-emerald-400 text-emerald-900 text-xs font-extrabold cursor-pointer"
                >
                  <Undo2 className="w-4 h-4" />
                  Yanlış mı? Depoya Geri Al
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ŞU AN TRANSFERDE (SAHADA / HATLARDA) BULUNAN ÜRÜNLER LİSTESİ */}
      <div className="bg-white rounded-2xl border-2 border-slate-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-slate-200 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-black text-slate-900 flex items-center gap-2">
                <MapPin className="w-5 h-5 text-violet-600" />
                Şu An Transferde / Hatlarda Bulunan Ürünler ({transferredItems.length})
              </h3>
              <p className="text-xs font-semibold text-slate-500 mt-0.5">
                Depodan çıkarılıp üretim hattı, kalite veya başka bölümlere aktarılmış aktif
                etiketler.
              </p>
            </div>

            {/* Görünür Kalın Çerçeveli Arama Kutusu */}
            <div className="relative w-full sm:w-80">
              <Search className="w-5 h-5 text-violet-700 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
                placeholder="Referans, PKT Kodu veya Yer ara..."
                className="w-full pl-11 pr-9 py-2.5 rounded-xl border-[3px] border-slate-800 bg-violet-50/25 focus:bg-white focus:border-violet-600 focus:ring-4 focus:ring-violet-200 text-sm font-extrabold text-slate-900 placeholder:text-slate-500 outline-none"
              />
              {tableSearch && (
                <button
                  type="button"
                  onClick={() => setTableSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Bulunduğu Yere Göre Tek Tıkla Filtre Butonları */}
          {distinctPlacesInField.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setPlaceFilter('ALL')}
                className={`px-3.5 py-1.5 rounded-xl border-2 text-xs font-extrabold transition cursor-pointer ${
                  placeFilter === 'ALL'
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-700'
                }`}
              >
                Tüm Transfer Yerleri ({transferredItems.length})
              </button>
              {distinctPlacesInField.map(([place, cnt]) => (
                <button
                  key={place}
                  type="button"
                  onClick={() => setPlaceFilter(place)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl border-2 text-xs font-extrabold transition cursor-pointer ${
                    placeFilter === place
                      ? 'border-violet-600 bg-violet-600 text-white'
                      : 'border-violet-300 bg-violet-50 hover:bg-violet-100 text-violet-900'
                  }`}
                >
                  <MapPin className="w-3.5 h-3.5" />
                  {place} ({cnt})
                </button>
              ))}
            </div>
          )}
        </div>

        {loadingList ? (
          <div className="p-10 text-center text-slate-500 font-semibold">Yükleniyor...</div>
        ) : visibleTransferredItems.length === 0 ? (
          <div className="p-10 text-center text-slate-500 font-semibold">
            {transferredItems.length === 0
              ? 'Şu an dış bir bölüme transfer edilmiş ürün bulunmuyor (tüm aktif ürünler Depoda).'
              : 'Arama filtresine uygun transfer kaydı bulunamadı.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-100 border-b-2 border-slate-200 text-xs font-black uppercase tracking-wider text-slate-600">
                  <th className="py-3.5 px-4 whitespace-nowrap">Bulunduğu Yer (Durum)</th>
                  <th className="py-3.5 px-4 whitespace-nowrap">Etiket No</th>
                  <th className="py-3.5 px-4 whitespace-nowrap">Referans</th>
                  <th className="py-3.5 px-4 whitespace-nowrap">Level</th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">Miktar</th>
                  <th className="py-3.5 px-4 whitespace-nowrap">Transfer Zamanı</th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">Hızlı İşlem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {visibleTransferredItems.map((it) => (
                  <tr
                    key={it.id}
                    className={`transition ${getRowStatusClasses(it.status, it.transferred_to)}`}
                  >
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <StockStatusBadge status={it.status} transferredTo={it.transferred_to} />
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-mono-code font-bold text-xs text-slate-800">
                      {it.label_code}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-black text-base text-slate-900">
                      {it.reference}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <span className="inline-flex items-center whitespace-nowrap px-2.5 py-1 rounded-lg bg-white border border-slate-300 text-slate-800 font-extrabold text-xs">
                        {it.level}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap font-black text-lg text-slate-900">
                      {it.remaining_quantity}{' '}
                      <span className="text-xs font-bold text-slate-500">Adet</span>
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap text-xs font-semibold text-slate-600">
                      {it.transferred_at
                        ? new Date(it.transferred_at).toLocaleString('tr-TR', {
                            day: '2-digit',
                            month: '2-digit',
                            year: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '-'}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <div className="inline-flex items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={rowBusyId === it.id}
                          onClick={() => handleReturnToWarehouse(it.label_code, it.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300 text-white text-xs font-extrabold shadow-xs transition cursor-pointer"
                        >
                          <Warehouse className="w-3.5 h-3.5" />
                          Depoya Geri Al
                        </button>
                        <button
                          type="button"
                          onClick={() => onPrintItem(it)}
                          title="Etiketi Yazdır"
                          className="p-2 rounded-xl border-2 border-slate-300 bg-white hover:bg-slate-100 text-slate-700 cursor-pointer"
                        >
                          <Printer className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
