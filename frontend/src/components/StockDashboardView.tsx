import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Clock,
  Edit3,
  Layers,
  ListChecks,
  PackageSearch,
  Printer,
  Search,
  Send,
  Undo2,
  X,
} from 'lucide-react';
import { api } from '../api';
import {
  ProductionMatchResult,
  StockDashboardSummary,
  StockItem,
} from '../types';

interface StockDashboardViewProps {
  refreshKey: number;
  onPrintItem: (item: StockItem) => void;
  onDataChanged: () => void;
  onActiveCountChange?: (count: number) => void;
}

function formatAgeDays(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return 'Az önce';
  if (hours < 24) return `${hours} saat önce`;
  const days = Math.floor(hours / 24);
  return `${days} gün önce`;
}

export const StockDashboardView: React.FC<StockDashboardViewProps> = ({
  refreshKey,
  onPrintItem,
  onDataChanged,
  onActiveCountChange,
}) => {
  const [subTab, setSubTab] = useState<'labels' | 'grouped' | 'matcher'>('labels');
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'ACTIVE' | 'IN_STOCK' | 'REQUESTED' | 'CONSUMED'
  >('ACTIVE');
  const [sortBy, setSortBy] = useState<'newest' | 'fifo' | 'qty_desc' | 'ref_asc'>('fifo');

  const [summary, setSummary] = useState<StockDashboardSummary | null>(null);
  const [items, setItems] = useState<StockItem[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [toastBanner, setToastBanner] = useState<{
    kind: 'success' | 'warn';
    message: string;
  } | null>(null);

  const [requestingItem, setRequestingItem] = useState<StockItem | null>(null);
  const [requestNote, setRequestNote] = useState('');
  const [sendingRequest, setSendingRequest] = useState(false);

  const [editingItem, setEditingItem] = useState<StockItem | null>(null);
  const [editRef, setEditRef] = useState('');
  const [editLevel, setEditLevel] = useState('');
  const [editQty, setEditQty] = useState('');
  const [editNote, setEditNote] = useState('');

  const [matchInput, setMatchInput] = useState('');
  const [matchResults, setMatchResults] = useState<ProductionMatchResult[] | null>(null);
  const [matching, setMatching] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);
  const reqSeqRef = React.useRef(0);

  const parseMatchQueries = (raw: string) => {
    const lines = raw
      .split(/\r?\n|;/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 200);

    return lines
      .map((line) => {
        const parts = line.split(/[\t|,]+|\s+/).filter(Boolean);
        if (parts.length >= 2) {
          return { reference: parts[0], level: parts.slice(1).join(' ') };
        }
        return { reference: parts[0] };
      })
      .filter((q) => q.reference.length > 0);
  };

  const fetchAll = async (silent = false) => {
    const mySeq = ++reqSeqRef.current;
    if (!silent && summary === null && items.length === 0) {
      setInitialLoading(true);
    } else if (!silent) {
      setRefreshing(true);
    }

    try {
      const data = await api.getDashboard({
        q: search || undefined,
        level: levelFilter || undefined,
        status: statusFilter,
        sort: sortBy,
      });
      if (mySeq !== reqSeqRef.current) return;
      setSummary(data.summary);
      setItems(data.items);
      onActiveCountChange?.(data.summary.active_label_count);
    } catch (err) {
      if (mySeq === reqSeqRef.current) {
        console.error(err);
      }
    } finally {
      if (mySeq === reqSeqRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  };

  useEffect(() => {
    const delay = search || levelFilter ? 140 : 0;
    const timer = setTimeout(() => {
      fetchAll(summary !== null);
    }, delay);
    return () => clearTimeout(timer);
  }, [search, levelFilter, statusFilter, sortBy, refreshKey]);

  const showRequestFeedback = (labelCode: string, tgSent: boolean, tgError?: string | null) => {
    if (tgSent) {
      setToastBanner({
        kind: 'success',
        message: `${labelCode} için depo talebi oluşturuldu ve Telegram grubuna bildirim gönderildi.`,
      });
    } else {
      setToastBanner({
        kind: 'warn',
        message: `${labelCode} talep durumuna alındı ancak Telegram bildirimi gönderilemedi: ${
          tgError || 'Ayarlar bölümünden Chat ID / Bot Token kontrol edin.'
        }`,
      });
    }
  };

  const applyItemPatchInMemory = (updatedItem: StockItem) => {
    setItems((prev) => {
      if (statusFilter === 'IN_STOCK' && updatedItem.status !== 'IN_STOCK') {
        return prev.filter((x) => x.id !== updatedItem.id);
      }
      if (statusFilter === 'REQUESTED' && updatedItem.status !== 'REQUESTED') {
        return prev.filter((x) => x.id !== updatedItem.id);
      }
      if (statusFilter === 'CONSUMED' && updatedItem.status !== 'CONSUMED') {
        return prev.filter((x) => x.id !== updatedItem.id);
      }
      return prev.map((x) => (x.id === updatedItem.id ? updatedItem : x));
    });
  };

  const handleConfirmRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!requestingItem) return;
    setSendingRequest(true);
    try {
      const res = await api.requestFromWarehouse(
        requestingItem.id,
        requestNote.trim() || undefined
      );
      applyItemPatchInMemory(res.item);
      showRequestFeedback(requestingItem.label_code, res.telegram_sent, res.telegram_error);
      setRequestingItem(null);
      setRequestNote('');
      onDataChanged();
    } catch (err: any) {
      alert(err.message || 'Talep oluşturulamadı.');
    } finally {
      setSendingRequest(false);
    }
  };

  const handleCancelRequest = async (item: StockItem) => {
    if (actionBusyId === item.id) return;
    setActionBusyId(item.id);
    try {
      const updated = await api.cancelWarehouseRequest(item.id);
      applyItemPatchInMemory(updated);
      setToastBanner({
        kind: 'success',
        message: `${item.label_code} depo talebi iptal edildi.`,
      });
      onDataChanged();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionBusyId(null);
    }
  };

  const handleRestore = async (item: StockItem) => {
    if (actionBusyId === item.id) return;
    if (
      !confirm(
        `${item.label_code} (${item.reference}) etiketini tekrar stoğa geri almak istiyor musunuz?`
      )
    ) {
      return;
    }
    setActionBusyId(item.id);
    try {
      const restored = await api.restoreStock(item.id);
      applyItemPatchInMemory(restored);
      onDataChanged();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionBusyId(null);
    }
  };

  const openEditModal = (item: StockItem) => {
    setEditingItem(item);
    setEditRef(item.reference);
    setEditLevel(item.level);
    setEditQty(String(item.remaining_quantity > 0 ? item.remaining_quantity : item.initial_quantity));
    setEditNote(item.location_note || '');
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem) return;
    const numQty = Number(editQty);
    if (!editQty.trim() || !Number.isInteger(numQty) || numQty <= 0 || numQty > 100000) {
      alert('Lütfen 1 ile 100.000 arasında geçerli bir tam sayı girin.');
      return;
    }
    try {
      const updated = await api.updateStock(editingItem.id, {
        reference: editRef.trim(),
        level: editLevel.trim(),
        remaining_quantity: numQty,
        location_note: editNote,
      });
      applyItemPatchInMemory(updated);
      setEditingItem(null);
      onDataChanged();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRunProductionMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    const queries = parseMatchQueries(matchInput);
    if (queries.length === 0) return;

    setMatching(true);
    try {
      const res = await api.matchProduction(queries);
      setMatchResults(res);
    } catch (err: any) {
      alert(err.message || 'Eşleştirme yapılamadı.');
    } finally {
      setMatching(false);
    }
  };

  const handleQuickRequestDirect = async (item: StockItem) => {
    if (actionBusyId === item.id) return;
    setActionBusyId(item.id);
    try {
      const res = await api.requestFromWarehouse(item.id, 'Üretim Eşleştirmeden Talep');
      applyItemPatchInMemory(res.item);
      showRequestFeedback(item.label_code, res.telegram_sent, res.telegram_error);
      if (matchResults) {
        setMatchResults((prev) =>
          prev
            ? prev.map((mr) => ({
                ...mr,
                exact_level_matches: mr.exact_level_matches.map((m) =>
                  m.id === item.id ? res.item : m
                ),
                other_level_matches: mr.other_level_matches.map((m) =>
                  m.id === item.id ? res.item : m
                ),
              }))
            : prev
        );
      }
      onDataChanged();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {toastBanner && (
        <div
          className={`rounded-xl px-4 py-3 flex items-center justify-between gap-3 border text-sm font-semibold ${
            toastBanner.kind === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {toastBanner.kind === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            )}
            <span>{toastBanner.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setToastBanner(null)}
            className="text-slate-400 hover:text-slate-700 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* KPI Kartları */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Depodaki Etiket Sayısı
          </div>
          <div className="text-3xl font-black text-slate-900 mt-1">
            {summary ? summary.active_label_count : '-'}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {summary ? `${summary.distinct_reference_count} farklı referans` : '...'}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Toplam Paketsiz Kılıf
          </div>
          <div className="text-3xl font-black text-blue-600 mt-1">
            {summary ? `${summary.active_total_quantity}` : '-'}{' '}
            <span className="text-sm font-bold text-slate-500">Adet</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">Depoda mevcut toplam stok</div>
        </div>

        <div className="bg-white rounded-2xl border border-amber-200 bg-amber-50/40 p-4 shadow-sm">
          <div className="text-xs font-bold uppercase tracking-wider text-amber-700">
            Talep Durumundakiler
          </div>
          <div className="text-3xl font-black text-amber-600 mt-1">
            {summary ? summary.requested_label_count : '-'}{' '}
            <span className="text-sm font-bold text-amber-700">Etiket</span>
          </div>
          <div className="text-xs text-amber-700/80 mt-1">
            {summary ? `Toplam ${summary.requested_total_quantity} adet talep edildi` : '...'}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 shadow-sm">
          <div className="text-xs font-bold uppercase tracking-wider text-emerald-700">
            Bugün Pakete Alınan
          </div>
          <div className="text-3xl font-black text-emerald-600 mt-1">
            {summary ? summary.consumed_today_quantity : '-'}{' '}
            <span className="text-sm font-bold text-emerald-700">Adet</span>
          </div>
          <div className="text-xs text-emerald-700/80 mt-1">
            {summary ? `${summary.consumed_today_count} işlem ile stoktan düşüldü` : '...'}
          </div>
        </div>
      </div>

      {/* Alt Sekme Seçici */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white rounded-2xl border border-slate-200 p-2 shadow-sm">
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setSubTab('labels')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition cursor-pointer ${
              subTab === 'labels'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Boxes className="w-4 h-4" />
            Tekil Etiketler ({items.length})
          </button>

          <button
            type="button"
            onClick={() => setSubTab('grouped')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition cursor-pointer ${
              subTab === 'grouped'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Layers className="w-4 h-4" />
            Referans &amp; Level Özeti ({summary?.groups.length || 0})
          </button>

          <button
            type="button"
            onClick={() => setSubTab('matcher')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition cursor-pointer ${
              subTab === 'matcher'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-blue-700 bg-blue-50 hover:bg-blue-100'
            }`}
          >
            <ListChecks className="w-4 h-4" />
            Üretim &amp; Level Eşleştirme Kontrolü
          </button>
        </div>
      </div>

      {/* ÜRETİM EŞLEŞTİRME MODÜLÜ */}
      {subTab === 'matcher' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-5">
          <div>
            <h3 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
              <PackageSearch className="w-5 h-5 text-blue-600" />
              Üretimde Çalışan Referanslar Depoda Var mı? (Level Eşleştirme)
            </h3>
            <p className="text-sm text-slate-500 mt-1">
              Üretim yeniden çalıştığında kontrol etmek istediğiniz referansları (veya{' '}
              <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono-code text-xs">
                REFERANS LEVEL
              </code>{' '}
              şeklinde) alt alta yazın veya Excel&apos;den yapıştırın.
            </p>
          </div>

          <form onSubmit={handleRunProductionMatch} className="space-y-3">
            <textarea
              rows={4}
              value={matchInput}
              onChange={(e) => setMatchInput(e.target.value.toUpperCase())}
              placeholder={`Örnek (Her satıra bir referans veya Referans + Level):\n6683876 HZE-1\n6035992 G\n7881859`}
              className="w-full rounded-xl border-2 border-slate-300 focus:border-blue-600 p-3.5 font-mono-code text-sm font-bold text-slate-900 outline-none"
            />
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={matching || !matchInput.trim()}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-sm font-extrabold transition cursor-pointer"
              >
                <Search className="w-4 h-4" />
                {matching ? 'Kontrol Ediliyor...' : 'Depodaki Stoklarla Eşleştir'}
              </button>
              {matchResults && (
                <button
                  type="button"
                  onClick={() => {
                    setMatchInput('');
                    setMatchResults(null);
                  }}
                  className="px-4 py-3 rounded-xl border border-slate-300 hover:bg-slate-50 text-sm font-bold text-slate-600 cursor-pointer"
                >
                  Temizle
                </button>
              )}
            </div>
          </form>

          {matchResults && (
            <div className="space-y-4 pt-2">
              {matchResults.map((res, idx) => {
                const hasExact = res.exact_level_matches.length > 0;
                const hasOther = res.other_level_matches.length > 0;
                return (
                  <div
                    key={`${res.query_reference}-${idx}`}
                    className={`rounded-xl border-2 p-4 ${
                      hasExact
                        ? 'border-emerald-300 bg-emerald-50/40'
                        : hasOther
                        ? 'border-amber-300 bg-amber-50/40'
                        : 'border-slate-200 bg-slate-50'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2.5">
                        <span className="text-lg font-black text-slate-900">
                          {res.query_reference}
                        </span>
                        {res.query_level && (
                          <span className="px-2.5 py-0.5 rounded-md bg-slate-900 text-white text-xs font-extrabold">
                            Aranan Level: {res.query_level}
                          </span>
                        )}
                      </div>

                      <div>
                        {hasExact ? (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-600 text-white text-xs font-extrabold">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            DEPODA VAR — Toplam {res.total_exact_quantity} Adet (
                            {res.exact_level_matches.length} Etiket)
                          </span>
                        ) : hasOther ? (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500 text-white text-xs font-extrabold">
                            FARKLI LEVEL MEVCUT ({res.total_other_quantity} Adet)
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-3 py-1 rounded-full bg-slate-200 text-slate-600 text-xs font-bold">
                            Depoda Yok
                          </span>
                        )}
                      </div>
                    </div>

                    {hasExact && (
                      <div className="space-y-2">
                        {res.exact_level_matches.map((it) => (
                          <div
                            key={it.id}
                            className="bg-white rounded-lg border border-emerald-200 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3"
                          >
                            <div className="flex flex-wrap items-center gap-3">
                              <span className="font-mono-code text-xs font-black bg-slate-900 text-white px-2.5 py-1 rounded">
                                {it.label_code}
                              </span>
                              <span className="font-extrabold text-slate-900">{it.reference}</span>
                              <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 text-xs font-extrabold">
                                Level: {it.level}
                              </span>
                              <span className="text-sm font-black text-emerald-700">
                                {it.remaining_quantity} Adet
                              </span>
                              {it.location_note && (
                                <span className="text-xs text-slate-500 font-medium">
                                  ({it.location_note})
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-2">
                              {it.status === 'REQUESTED' ? (
                                <span className="px-2.5 py-1 rounded-lg bg-amber-100 text-amber-800 text-xs font-extrabold">
                                  Talep Edildi
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handleQuickRequestDirect(it)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-extrabold cursor-pointer"
                                >
                                  <Send className="w-3.5 h-3.5" />
                                  Talep Et
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {hasOther && (
                      <div className="mt-2 pt-2 border-t border-amber-200/70">
                        <div className="text-xs font-bold text-amber-800 mb-1.5">
                          Aynı referansın depodaki diğer Level stokları:
                        </div>
                        <div className="space-y-1.5">
                          {res.other_level_matches.map((it) => (
                            <div
                              key={it.id}
                              className="bg-white/90 rounded-lg border border-amber-200 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                            >
                              <div className="flex items-center gap-2.5">
                                <span className="font-mono-code font-bold text-slate-700">
                                  {it.label_code}
                                </span>
                                <span className="font-bold text-slate-900">{it.reference}</span>
                                <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-extrabold">
                                  Level: {it.level}
                                </span>
                                <span className="font-extrabold text-slate-800">
                                  {it.remaining_quantity} Adet
                                </span>
                              </div>
                              {it.status === 'IN_STOCK' && (
                                <button
                                  type="button"
                                  onClick={() => handleQuickRequestDirect(it)}
                                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-900 text-white font-bold cursor-pointer"
                                >
                                  Talep Et
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ARAMA & FİLTRE ÇUBUĞU */}
      {subTab !== 'matcher' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Referans, Etiket No (PKT-...) veya Not ara..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 focus:border-blue-600 text-sm font-semibold outline-none"
            />
          </div>

          {subTab === 'labels' && (
            <>
              <input
                type="text"
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value.toUpperCase())}
                placeholder="Level Filtrele..."
                className="w-36 px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-blue-600 text-sm font-semibold uppercase outline-none"
              />

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
                className="px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-bold text-slate-700 outline-none"
              >
                <option value="ACTIVE">Aktif Stoklar (Depoda + Talep)</option>
                <option value="IN_STOCK">Sadece Depoda Bekleyen</option>
                <option value="REQUESTED">Talep Edilenler</option>
                <option value="CONSUMED">Stoktan Düşülenler (Arşiv)</option>
              </select>

              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-bold text-slate-700 outline-none"
              >
                <option value="fifo">FIFO (En Eski Önce)</option>
                <option value="newest">En Yeni Eklenen</option>
                <option value="qty_desc">Miktar (Çoktan Aza)</option>
                <option value="ref_asc">Referans (A-Z)</option>
              </select>
            </>
          )}

          {(search || levelFilter) && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setLevelFilter('');
              }}
              className="px-3 py-2.5 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100 cursor-pointer"
            >
              Filtreyi Temizle
            </button>
          )}
        </div>
      )}

      {/* REFERANS & LEVEL GRUP ÖZETİ */}
      {subTab === 'grouped' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {!summary || summary.groups.length === 0 ? (
            <div className="p-10 text-center text-slate-500 font-medium">
              Depoda aktif paketsiz stok kaydı bulunamadı.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-extrabold uppercase tracking-wider text-slate-500">
                    <th className="py-3.5 px-4">Referans</th>
                    <th className="py-3.5 px-4">Level</th>
                    <th className="py-3.5 px-4 text-right">Toplam Miktar</th>
                    <th className="py-3.5 px-4 text-center">Etiket / Paket Sayısı</th>
                    <th className="py-3.5 px-4">En Eski Giriş (FIFO)</th>
                    <th className="py-3.5 px-4 text-right">İşlem</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {summary.groups.map((grp) => (
                    <tr
                      key={`${grp.reference}__${grp.level}`}
                      className="hover:bg-slate-50/80 transition"
                    >
                      <td className="py-3.5 px-4 font-black text-base text-slate-900">
                        {grp.reference}
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-800 font-extrabold text-xs border border-blue-200">
                          {grp.level}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right font-black text-lg text-slate-900">
                        {grp.total_quantity}{' '}
                        <span className="text-xs font-semibold text-slate-500">Adet</span>
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span className="font-bold text-slate-700">{grp.label_count} Etiket</span>
                        {grp.requested_count > 0 && (
                          <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-bold">
                            {grp.requested_count} Talepde
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600 font-medium">
                        {new Date(grp.oldest_created_at).toLocaleDateString('tr-TR')} (
                        {formatAgeDays(grp.oldest_created_at)})
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setSearch(grp.reference);
                            setLevelFilter(grp.level);
                            setSubTab('labels');
                          }}
                          className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold cursor-pointer"
                        >
                          Etiketleri Gör
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TEKİL ETİKETLER TABLOSU */}
      {subTab === 'labels' && (
        <div
          className={`bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden transition-opacity duration-150 ${
            refreshing ? 'opacity-90' : 'opacity-100'
          }`}
        >
          {initialLoading ? (
            <div className="p-10 text-center text-slate-500 font-medium">Yükleniyor...</div>
          ) : items.length === 0 ? (
            <div className="p-10 text-center text-slate-500 font-medium">
              Arama kriterlerine uygun etiket bulunamadı.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-extrabold uppercase tracking-wider text-slate-500">
                    <th className="py-3.5 px-4">Etiket Kodu</th>
                    <th className="py-3.5 px-4">Referans</th>
                    <th className="py-3.5 px-4">Level</th>
                    <th className="py-3.5 px-4 text-right">Miktar</th>
                    <th className="py-3.5 px-4">Konum / Not</th>
                    <th className="py-3.5 px-4">Depo Süresi</th>
                    <th className="py-3.5 px-4">Durum</th>
                    <th className="py-3.5 px-4 text-right">İşlemler</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {items.map((it) => (
                    <tr key={it.id} className="hover:bg-slate-50/80 transition">
                      <td className="py-3.5 px-4 font-mono-code font-bold text-xs text-slate-700">
                        {it.label_code}
                      </td>
                      <td className="py-3.5 px-4 font-black text-base text-slate-900">
                        {it.reference}
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-800 font-extrabold text-xs">
                          {it.level}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <span className="font-black text-lg text-slate-900">
                          {it.remaining_quantity}
                        </span>
                        {it.initial_quantity !== it.remaining_quantity && (
                          <span className="text-xs text-slate-400 ml-1">
                            / {it.initial_quantity}
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600 max-w-[180px] truncate">
                        {it.location_note || '-'}
                        {it.requested_note && (
                          <div className="text-amber-700 font-bold mt-0.5">
                            Talep: {it.requested_note}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-500">
                        <div className="inline-flex items-center gap-1 font-semibold text-slate-700">
                          <Clock className="w-3.5 h-3.5 text-slate-400" />
                          {formatAgeDays(it.created_at)}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {new Date(it.created_at).toLocaleString('tr-TR', {
                            day: '2-digit',
                            month: '2-digit',
                            year: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        {it.status === 'IN_STOCK' && (
                          <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-extrabold">
                            Depoda
                          </span>
                        )}
                        {it.status === 'REQUESTED' && (
                          <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 text-xs font-extrabold">
                            Talep Edildi
                          </span>
                        )}
                        {it.status === 'CONSUMED' && (
                          <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-slate-200 text-slate-600 text-xs font-bold">
                            Kullanıldı
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {it.status === 'IN_STOCK' && (
                            <button
                              type="button"
                              onClick={() => {
                                setRequestingItem(it);
                                setRequestNote('');
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold transition cursor-pointer"
                            >
                              <Send className="w-3.5 h-3.5" />
                              Talep Et
                            </button>
                          )}

                          {it.status === 'REQUESTED' && (
                            <button
                              type="button"
                              onClick={() => handleCancelRequest(it)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 text-xs font-bold transition cursor-pointer"
                            >
                              Talebi İptal
                            </button>
                          )}

                          {it.status !== 'CONSUMED' && (
                            <>
                              <button
                                type="button"
                                onClick={() => onPrintItem(it)}
                                title="Etiketi Tekrar Yazdır"
                                className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-100 text-slate-700 transition cursor-pointer"
                              >
                                <Printer className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => openEditModal(it)}
                                title="Düzenle"
                                className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-100 text-slate-700 transition cursor-pointer"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                            </>
                          )}

                          {it.status === 'CONSUMED' && (
                            <button
                              type="button"
                              onClick={() => handleRestore(it)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold cursor-pointer"
                            >
                              <Undo2 className="w-3.5 h-3.5" />
                              Stoğa Geri Al
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Depodan Talep Et Modalı (Telegram Bildirimli) */}
      {requestingItem && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-extrabold text-slate-900">Depodan Ürün Talep Et</h3>
              <button
                type="button"
                onClick={() => setRequestingItem(null)}
                className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 mb-4">
              <div className="text-xs font-mono-code font-bold text-slate-500">
                {requestingItem.label_code}
              </div>
              <div className="text-xl font-black text-slate-900">{requestingItem.reference}</div>
              <div className="text-sm font-bold text-slate-700 mt-0.5">
                Level: {requestingItem.level} • Miktar: {requestingItem.remaining_quantity} Adet
              </div>
            </div>

            <form onSubmit={handleConfirmRequest} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  İsteyen Hat / Talep Notu (Telegram mesajında görünür)
                </label>
                <input
                  type="text"
                  autoFocus
                  value={requestNote}
                  onChange={(e) => setRequestNote(e.target.value)}
                  placeholder="Örn: Paketleme Hat-2'ye gelsin"
                  className="w-full rounded-xl border border-slate-300 focus:border-amber-500 px-3.5 py-2.5 text-sm font-medium outline-none"
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRequestingItem(null)}
                  className="px-4 py-2.5 rounded-xl border border-slate-300 text-sm font-bold text-slate-700 cursor-pointer"
                >
                  Vazgeç
                </button>
                <button
                  type="submit"
                  disabled={sendingRequest}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white text-sm font-extrabold cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                  {sendingRequest ? 'Gönderiliyor...' : 'Talep Oluştur & Bildir'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Düzenleme Modalı */}
      {editingItem && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-extrabold text-slate-900">
                Etiket Düzenle ({editingItem.label_code})
              </h3>
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Referans</label>
                <input
                  type="text"
                  required
                  value={editRef}
                  onChange={(e) => setEditRef(e.target.value.toUpperCase())}
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-base font-extrabold uppercase outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Level</label>
                  <input
                    type="text"
                    required
                    value={editLevel}
                    onChange={(e) => setEditLevel(e.target.value.toUpperCase())}
                    className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-base font-extrabold uppercase outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Kalan Adet</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={editQty}
                    onChange={(e) => setEditQty(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-base font-extrabold outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Konum / Not</label>
                <input
                  type="text"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-medium outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingItem(null)}
                  className="px-4 py-2.5 rounded-xl border border-slate-300 text-sm font-bold text-slate-700 cursor-pointer"
                >
                  Vazgeç
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-extrabold cursor-pointer"
                >
                  Kaydet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
