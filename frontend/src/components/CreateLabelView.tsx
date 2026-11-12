import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Eye, PlusCircle, Printer, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { PaperFormat, StockItem, Suggestions } from '../types';
import { AutocompleteInput } from './AutocompleteInput';
import { PrintableLabel } from './PrintableLabel';

interface CreateLabelViewProps {
  paperFormat: PaperFormat;
  onPaperFormatChange: (fmt: PaperFormat) => void;
  onPrintItem: (item: StockItem) => void;
  onCreated: () => void;
}

export const CreateLabelView: React.FC<CreateLabelViewProps> = ({
  paperFormat,
  onPaperFormatChange,
  onPrintItem,
  onCreated,
}) => {
  const [reference, setReference] = useState('');
  const [quantity, setQuantity] = useState('');
  const [level, setLevel] = useState('');
  const [locationNote, setLocationNote] = useState('');
  const [createdBy, setCreatedBy] = useState(() => localStorage.getItem('pkt_operator') || '');
  const [autoPrint, setAutoPrint] = useState<boolean>(() => {
    const saved = localStorage.getItem('pkt_autoprint');
    return saved === null ? true : saved === 'true';
  });

  const [suggestions, setSuggestions] = useState<Suggestions>({ references: [], levels: [] });
  const [recentItems, setRecentItems] = useState<StockItem[]>([]);
  const [lastCreated, setLastCreated] = useState<StockItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const loadContext = async () => {
    try {
      const [sugg, recent] = await Promise.all([
        api.getSuggestions(),
        api.listStock({ status: 'ACTIVE', sort: 'newest' }),
      ]);
      setSuggestions(sugg);
      setRecentItems(recent.slice(0, 6));
    } catch {
      // ignore initial fetch error
    }
  };

  useEffect(() => {
    loadContext();
    refInputRef.current?.focus();
  }, []);

  const handleToggleAutoPrint = (checked: boolean) => {
    setAutoPrint(checked);
    localStorage.setItem('pkt_autoprint', String(checked));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setError(null);

    const numQty = Number(quantity);
    if (!reference.trim()) {
      setError('Lütfen Referans bilgisini girin.');
      return;
    }
    if (!level.trim()) {
      setError('Lütfen Level bilgisini girin.');
      return;
    }
    if (!quantity.trim() || !Number.isInteger(numQty) || numQty <= 0 || numQty > 100000) {
      setError('Lütfen 1 ile 100.000 arasında geçerli bir tam sayı miktar girin.');
      return;
    }

    if (createdBy.trim()) {
      localStorage.setItem('pkt_operator', createdBy.trim());
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const created = await api.createStock({
        reference: reference.trim(),
        quantity: numQty,
        level: level.trim(),
        location_note: locationNote.trim() || undefined,
        created_by: createdBy.trim() || undefined,
      });

      setLastCreated(created);
      setReference('');
      setQuantity('');
      setLevel('');
      setLocationNote('');
      onCreated();
      loadContext();

      if (autoPrint) {
        onPrintItem(created);
      } else {
        setTimeout(() => {
          refInputRef.current?.focus();
        }, 80);
      }
    } catch (err: any) {
      setError(err.message || 'Kayıt sırasında bir hata oluştu.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const previewItem = {
    label_code:
      lastCreated && !reference && !level && !quantity ? lastCreated.label_code : 'PKT-YENİ',
    qr_payload:
      lastCreated && !reference && !level && !quantity
        ? lastCreated.qr_payload
        : `PKT/PKT-YENI/R-${reference.trim().toUpperCase() || 'REFERANS'}/L-${
            level.trim().toUpperCase() || 'LEVEL'
          }/Q-${parseInt(quantity, 10) || 0}`,
    reference:
      lastCreated && !reference && !level && !quantity
        ? lastCreated.reference
        : reference.trim() || '6683876-HZE-1',
    level:
      lastCreated && !reference && !level && !quantity
        ? lastCreated.level
        : level.trim() || 'HZE-1',
    remaining_quantity:
      lastCreated && !reference && !level && !quantity
        ? lastCreated.remaining_quantity
        : parseInt(quantity, 10) || 20,
    location_note:
      lastCreated && !reference && !level && !quantity
        ? lastCreated.location_note
        : locationNote.trim() || null,
    created_at:
      lastCreated && !reference && !level && !quantity ? lastCreated.created_at : undefined,
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* SOL: Hızlı Giriş Formu */}
        <div className="lg:col-span-6 bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          <div className="mb-5">
            <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
              <PlusCircle className="w-6 h-6 text-blue-600" />
              Paketsiz Kılıf Depoya Kaldır
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Referans, miktar ve level bilgisini girerek stok kaydı oluşturun ve depo etiketini
              yazdırın.
            </p>
          </div>

          {error && (
            <div className="mb-4 rounded-xl bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm font-semibold">
              {error}
            </div>
          )}

          {lastCreated && (
            <div className="mb-5 rounded-xl bg-emerald-50 border border-emerald-200 p-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
                <div>
                  <div className="text-sm font-bold text-emerald-900">
                    Kaydedildi: {lastCreated.label_code} — {lastCreated.reference}
                  </div>
                  <div className="text-xs text-emerald-700 font-medium">
                    Level: <strong>{lastCreated.level}</strong> • Miktar:{' '}
                    <strong>{lastCreated.remaining_quantity} Adet</strong>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onPrintItem(lastCreated)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold shadow-sm transition cursor-pointer shrink-0"
              >
                <Printer className="w-4 h-4" />
                Tekrar Yazdır
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-bold text-slate-800 mb-1.5">
                REFERANS KODU <span className="text-red-500">*</span>
              </label>
              <AutocompleteInput
                inputRef={refInputRef}
                value={reference}
                onChange={setReference}
                options={suggestions.references}
                placeholder="Örn: 6683876-HZE-1"
                required
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-bold text-slate-800 mb-1.5">
                  MİKTAR (ADET) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="Örn: 20"
                  required
                  className="w-full rounded-xl border-2 border-slate-300 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 px-4 py-3.5 text-xl font-extrabold text-slate-900 outline-none transition"
                />
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-800 mb-1.5">
                  LEVEL BİLGİSİ <span className="text-red-500">*</span>
                </label>
                <AutocompleteInput
                  value={level}
                  onChange={setLevel}
                  options={suggestions.levels}
                  placeholder="Örn: PO6 / HZE-1"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">
                  KONUM / RAF / NOT (İsteğe Bağlı)
                </label>
                <input
                  type="text"
                  value={locationNote}
                  onChange={(e) => setLocationNote(e.target.value)}
                  placeholder="Örn: Raf B-3 / Koli 2"
                  className="w-full rounded-xl border border-slate-300 focus:border-blue-600 px-3.5 py-2.5 text-sm font-medium text-slate-800 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">
                  PERSONEL / HAT (İsteğe Bağlı)
                </label>
                <input
                  type="text"
                  value={createdBy}
                  onChange={(e) => setCreatedBy(e.target.value)}
                  placeholder="Örn: Paketleme Hat-1"
                  className="w-full rounded-xl border border-slate-300 focus:border-blue-600 px-3.5 py-2.5 text-sm font-medium text-slate-800 outline-none"
                />
              </div>
            </div>

            {/* Yazdırma Ayarları Barı */}
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoPrint}
                  onChange={(e) => handleToggleAutoPrint(e.target.checked)}
                  className="w-4 h-4 rounded accent-blue-600"
                />
                <span className="text-sm font-bold text-slate-800">
                  Kayıt sonrası etiketi otomatik yazdır
                </span>
              </label>

              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-500">Kağıt Boyutu:</span>
                <select
                  value={paperFormat}
                  onChange={(e) => onPaperFormatChange(e.target.value as PaperFormat)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-800 outline-none"
                >
                  <option value="a4-landscape">A4 Yatay (Tam Sayfa)</option>
                  <option value="a5-landscape">A5 Yatay</option>
                  <option value="thermal-150x100">Termal Etiket (150x100mm)</option>
                </select>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 inline-flex items-center justify-center gap-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-extrabold text-base py-4 px-6 shadow-md shadow-blue-600/20 transition cursor-pointer"
              >
                <Printer className="w-5 h-5" />
                {submitting
                  ? 'Kaydediliyor...'
                  : autoPrint
                  ? 'KAYDET VE ETİKET YAZDIR'
                  : 'STOK KAYDI OLUŞTUR'}
              </button>

              {(reference || quantity || level || locationNote) && (
                <button
                  type="button"
                  onClick={() => {
                    setReference('');
                    setQuantity('');
                    setLevel('');
                    setLocationNote('');
                    refInputRef.current?.focus();
                  }}
                  title="Formu Temizle"
                  className="p-4 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-600 transition cursor-pointer"
                >
                  <RotateCcw className="w-5 h-5" />
                </button>
              )}
            </div>
          </form>
        </div>

        {/* SAĞ: Canlı Etiket Önizleme */}
        <div className="lg:col-span-6 space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-700">
                  Etiket Baskı Önizlemesi
                </h3>
              </div>
              <span className="text-xs font-semibold text-slate-400">
                {!reference && !level && !quantity && !lastCreated ? 'Örnek Görünüm' : 'Canlı Veri'}
              </span>
            </div>

            <PrintableLabel item={previewItem} paperFormat={paperFormat} isPreview />

            <p className="text-xs text-slate-500 mt-3 leading-relaxed">
              Yazıcı çıktısında referans, level ve miktar bilgileri kağıt boyutuna uygun yüksek
              okunabilirlikte basılır. Sağ alt köşedeki QR kod stok düşüm işlemlerinde kullanılır.
            </p>
          </div>

          {/* Son Depoya Kaldırılanlar */}
          {recentItems.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-700 mb-3">
                Son Depoya Kaldırılan Etiketler
              </h3>
              <div className="divide-y divide-slate-100">
                {recentItems.map((it) => (
                  <div
                    key={it.id}
                    className="py-2.5 flex items-center justify-between gap-3 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono-code text-xs font-bold bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
                          {it.label_code}
                        </span>
                        <span className="font-extrabold text-slate-900 truncate">
                          {it.reference}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        Level: <strong className="text-slate-700">{it.level}</strong> • Adet:{' '}
                        <strong className="text-slate-700">{it.remaining_quantity}</strong>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onPrintItem(it)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-bold text-slate-700 transition cursor-pointer shrink-0"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      Yazdır
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
