import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  BellRing,
  Boxes,
  CheckCircle2,
  ChevronDown,
  Clock,
  Edit3,
  FileSpreadsheet,
  Layers,
  ListChecks,
  MapPin,
  PackageSearch,
  Printer,
  Search,
  Send,
  Undo2,
  Warehouse,
  X,
} from 'lucide-react';
import { api } from '../api';
import { resolveCanonicalLevelClient } from '../levelUtils';
import { getRowStatusClasses, StockStatusBadge } from '../statusStyles';
import {
  ProductionMatchResult,
  StockDashboardSummary,
  StockItem,
} from '../types';

const QUICK_MODAL_TARGETS = [
  'PAKETLEME HAT-1',
  'PAKETLEME HAT-2',
  'ÜRETİM BANDI',
  'KALİTE KONTROL',
];

interface StockDashboardViewProps {
  refreshKey: number;
  onPrintItem: (item: StockItem) => void;
  onDataChanged: () => void;
  onActiveCountChange?: (count: number, transferredCount?: number) => void;
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
    'ACTIVE' | 'IN_STOCK' | 'TRANSFERRED' | 'REQUESTED' | 'CONSUMED'
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

  const [transferringItem, setTransferringItem] = useState<StockItem | null>(null);
  const [transferTarget, setTransferTarget] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [sendingTransfer, setSendingTransfer] = useState(false);

  const [editingItem, setEditingItem] = useState<StockItem | null>(null);
  const [editRef, setEditRef] = useState('');
  const [editLevel, setEditLevel] = useState('');
  const [editQty, setEditQty] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editCreatedBy, setEditCreatedBy] = useState('');

  const [matchInput, setMatchInput] = useState('');
  const [matchResults, setMatchResults] = useState<ProductionMatchResult[] | null>(null);
  const [matching, setMatching] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [excelMenuOpen, setExcelMenuOpen] = useState(false);
  const excelMenuRef = React.useRef<HTMLDivElement>(null);
  const reqSeqRef = React.useRef(0);

  useEffect(() => {
    if (!excelMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (excelMenuRef.current && !excelMenuRef.current.contains(e.target as Node)) {
        setExcelMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [excelMenuOpen]);

  const handleExportExcel = async (mode: 'current' | 'active' | 'all') => {
    setExcelMenuOpen(false);
    if (exportingExcel) return;
    setExportingExcel(true);
    try {
      const verified =
        mode === 'active'
          ? await api.exportStockExcel({ status: 'ACTIVE', sort: sortBy })
          : mode === 'all'
          ? await api.exportStockExcel({ status: 'ALL', sort: 'newest' })
          : await api.exportStockExcel({
              q: search || undefined,
              level: levelFilter || undefined,
              status: statusFilter,
              sort: sortBy,
            });
      setToastBanner({
        kind: 'success',
        message: `Güvenlik taramasından geçti (${verified.inspectedFiles} iç bileşen temiz • SHA-256: ${verified.sha256.slice(
          0,
          12
        )}…) — ${verified.safeFilename} indirildi.`,
      });
    } catch (err: any) {
      setToastBanner({
        kind: 'warn',
        message: err.message || 'Excel dosyası güvenlik kontrolünden geçemedi ve engellendi.',
      });
    } finally {
      setExportingExcel(false);
    }
  };

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
      onActiveCountChange?.(
        data.summary.active_label_count,
        data.summary.transferred_label_count
      );
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
      if (statusFilter === 'TRANSFERRED' && updatedItem.status !== 'TRANSFERRED') {
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

  const handleConfirmTransferModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transferringItem || !transferTarget.trim()) return;
    setSendingTransfer(true);
    try {
      const updated = await api.scanTransfer({
        qr_or_code: transferringItem.label_code,
        target_location: transferTarget.trim(),
        note: transferNote.trim() || undefined,
      });
      applyItemPatchInMemory(updated);
      setToastBanner({
        kind: 'success',
        message:
          updated.status === 'IN_STOCK'
            ? `${updated.label_code} (${updated.reference}) tekrar Depoya alındı.`
            : `${updated.label_code} (${updated.reference}) → ${updated.transferred_to} konumuna transfer edildi.`,
      });
      setTransferringItem(null);
      setTransferTarget('');
      setTransferNote('');
      onDataChanged();
    } catch (err: any) {
      alert(err.message || 'Transfer yapılamadı.');
    } finally {
      setSendingTransfer(false);
    }
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
    setEditCreatedBy(item.created_by || '');
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
        created_by: editCreatedBy,
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

      {/* RENK KODLU DURUM KARTLARI (Tıklayarak Hızlı Filtreleme) */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3.5">
        <button
          type="button"
          onClick={() => {
            setStatusFilter('ACTIVE');
            setSubTab('labels');
          }}
          className={`text-left rounded-2xl border-2 p-4 shadow-xs transition cursor-pointer ${
            statusFilter === 'ACTIVE' && subTab === 'labels'
              ? 'border-blue-600 bg-blue-50/60 ring-2 ring-blue-200'
              : 'border-slate-300 bg-white hover:border-blue-400'
          }`}
        >
          <div className="text-[11px] font-extrabold uppercase tracking-wider text-blue-700">
            Tüm Aktif Stoklar
          </div>
          <div className="text-2xl sm:text-3xl font-black text-slate-900 mt-1">
            {summary ? summary.active_total_quantity : '-'}{' '}
            <span className="text-xs font-bold text-slate-500">Adet</span>
          </div>
          <div className="text-xs font-semibold text-slate-500 mt-1">
            {summary
              ? `${summary.active_label_count} etiket • ${summary.distinct_reference_count} referans`
              : '...'}
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setStatusFilter('IN_STOCK');
            setSubTab('labels');
          }}
          className={`text-left rounded-2xl border-2 p-4 shadow-xs transition cursor-pointer ${
            statusFilter === 'IN_STOCK' && subTab === 'labels'
              ? 'border-emerald-600 bg-emerald-100/70 ring-2 ring-emerald-200'
              : 'border-emerald-300 bg-emerald-50/50 hover:border-emerald-500'
          }`}
        >
          <div className="text-[11px] font-extrabold uppercase tracking-wider text-emerald-800 flex items-center gap-1.5">
            <Warehouse className="w-3.5 h-3.5 text-emerald-700" />
            Depoda Bekleyen
          </div>
          <div className="text-2xl sm:text-3xl font-black text-emerald-800 mt-1">
            {summary ? summary.in_stock_label_count : '-'}{' '}
            <span className="text-xs font-bold text-emerald-700">Etiket</span>
          </div>
          <div className="text-xs font-semibold text-emerald-800/80 mt-1">
            {summary ? `${summary.in_stock_total_quantity} adet depoda` : '...'}
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setStatusFilter('TRANSFERRED');
            setSubTab('labels');
          }}
          className={`text-left rounded-2xl border-2 p-4 shadow-xs transition cursor-pointer ${
            statusFilter === 'TRANSFERRED' && subTab === 'labels'
              ? 'border-violet-600 bg-violet-100/70 ring-2 ring-violet-200'
              : 'border-violet-300 bg-violet-50/50 hover:border-violet-500'
          }`}
        >
          <div className="text-[11px] font-extrabold uppercase tracking-wider text-violet-900 flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-violet-700" />
            Transfer Edilenler
          </div>
          <div className="text-2xl sm:text-3xl font-black text-violet-700 mt-1">
            {summary ? summary.transferred_label_count : '-'}{' '}
            <span className="text-xs font-bold text-violet-800">Etiket</span>
          </div>
          <div className="text-xs font-semibold text-violet-800/80 mt-1">
            {summary ? `${summary.transferred_total_quantity} adet hatlarda/bölümde` : '...'}
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setStatusFilter('REQUESTED');
            setSubTab('labels');
          }}
          className={`text-left rounded-2xl border-2 p-4 shadow-xs transition cursor-pointer ${
            statusFilter === 'REQUESTED' && subTab === 'labels'
              ? 'border-amber-600 bg-amber-100/70 ring-2 ring-amber-200'
              : 'border-amber-300 bg-amber-50/50 hover:border-amber-500'
          }`}
        >
          <div className="text-[11px] font-extrabold uppercase tracking-wider text-amber-900 flex items-center gap-1.5">
            <BellRing className="w-3.5 h-3.5 text-amber-700" />
            Talep Durumunda
          </div>
          <div className="text-2xl sm:text-3xl font-black text-amber-700 mt-1">
            {summary ? summary.requested_label_count : '-'}{' '}
            <span className="text-xs font-bold text-amber-800">Etiket</span>
          </div>
          <div className="text-xs font-semibold text-amber-800/80 mt-1">
            {summary ? `${summary.requested_total_quantity} adet talep edildi` : '...'}
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setStatusFilter('CONSUMED');
            setSubTab('labels');
          }}
          className={`col-span-2 md:col-span-1 text-left rounded-2xl border-2 p-4 shadow-xs transition cursor-pointer ${
            statusFilter === 'CONSUMED' && subTab === 'labels'
              ? 'border-rose-600 bg-rose-100/70 ring-2 ring-rose-200'
              : 'border-rose-300 bg-rose-50/40 hover:border-rose-500'
          }`}
        >
          <div className="text-[11px] font-extrabold uppercase tracking-wider text-rose-800">
            Bugün Stoktan Düşülen
          </div>
          <div className="text-2xl sm:text-3xl font-black text-rose-700 mt-1">
            {summary ? summary.consumed_today_quantity : '-'}{' '}
            <span className="text-xs font-bold text-rose-800">Adet</span>
          </div>
          <div className="text-xs font-semibold text-rose-800/80 mt-1">
            {summary ? `${summary.consumed_today_count} işlem (Arşivi gör)` : '...'}
          </div>
        </button>
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

        {/* Excel'e Aktar Butonu */}
        <div ref={excelMenuRef} className="relative flex items-center">
          <div className="inline-flex rounded-xl shadow-sm">
            <button
              type="button"
              disabled={exportingExcel}
              onClick={() => handleExportExcel('current')}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-l-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white text-xs sm:text-sm font-extrabold transition cursor-pointer"
              title="Ekrandaki stok listesini ve Referans/Level özetini Excel (.xlsx) olarak indir"
            >
              <FileSpreadsheet className="w-4 h-4 shrink-0" />
              <span>{exportingExcel ? 'Hazırlanıyor...' : "Excel'e Aktar (.xlsx)"}</span>
            </button>
            <button
              type="button"
              disabled={exportingExcel}
              onClick={() => setExcelMenuOpen((v) => !v)}
              className="inline-flex items-center px-2.5 py-2.5 rounded-r-xl bg-emerald-700 hover:bg-emerald-800 disabled:bg-emerald-400 text-white border-l border-emerald-500/60 transition cursor-pointer"
              title="Excel aktarım seçenekleri"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>

          {excelMenuOpen && (
            <div className="absolute right-0 top-full mt-2 w-72 rounded-xl bg-white border border-slate-200 shadow-xl z-30 py-1.5 text-left">
              <button
                type="button"
                onClick={() => handleExportExcel('active')}
                className="w-full px-3.5 py-2.5 hover:bg-slate-50 text-left transition cursor-pointer"
              >
                <div className="text-xs font-extrabold text-slate-900">
                  Aktif Depo Stoğu (.xlsx)
                </div>
                <div className="text-[11px] text-slate-500">
                  Depodaki + talep edilen tüm etiketler ve Referans/Level özeti
                </div>
              </button>
              <button
                type="button"
                onClick={() => handleExportExcel('current')}
                className="w-full px-3.5 py-2.5 hover:bg-slate-50 text-left border-t border-slate-100 transition cursor-pointer"
              >
                <div className="text-xs font-extrabold text-slate-900">
                  Mevcut Filtreli Görünüm (.xlsx)
                </div>
                <div className="text-[11px] text-slate-500">
                  Seçili arama, level ve durum filtresine uyan kayıtlar
                </div>
              </button>
              <button
                type="button"
                onClick={() => handleExportExcel('all')}
                className="w-full px-3.5 py-2.5 hover:bg-slate-50 text-left border-t border-slate-100 transition cursor-pointer"
              >
                <div className="text-xs font-extrabold text-slate-900">
                  Tüm Kayıtlar — Arşiv Dahil (.xlsx)
                </div>
                <div className="text-[11px] text-slate-500">
                  Aktif stoklar + geçmişte stoktan düşülmüş tüm etiketler
                </div>
              </button>
            </div>
          )}
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
                              <StockStatusBadge
                                status={it.status}
                                transferredTo={it.transferred_to}
                                size="sm"
                              />
                              {it.created_by && (
                                <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-xs font-bold">
                                  {it.created_by}
                                </span>
                              )}
                              {it.location_note && (
                                <span className="text-xs text-slate-500 font-medium">
                                  ({it.location_note})
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-2">
                              {it.status === 'IN_STOCK' && (
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

      {/* YÜKSEK GÖRÜNÜRLÜKLÜ ARAMA & FİLTRE ÇUBUĞU */}
      {subTab !== 'matcher' && (
        <div className="bg-white rounded-2xl border-2 border-slate-400 p-4 shadow-sm space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[260px]">
              <label className="block text-xs font-black uppercase tracking-wider text-slate-900 mb-1.5">
                Referans / Etiket No / Bulunduğu Yer Ara
              </label>
              <div className="relative">
                <Search className="w-5 h-5 text-blue-700 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Referans, PKT-100001, Transfer Yeri veya Personel yazın..."
                  className="w-full pl-11 pr-10 py-3 rounded-xl border-[3px] border-slate-800 bg-blue-50/25 hover:border-blue-700 focus:bg-white focus:border-blue-600 focus:ring-4 focus:ring-blue-200 text-sm sm:text-base font-extrabold text-slate-900 placeholder:text-slate-500 placeholder:font-semibold outline-none shadow-xs transition"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    title="Aramayı temizle"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-slate-600 hover:text-slate-950 hover:bg-slate-200 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {subTab === 'labels' && (
              <>
                <div className="w-36 sm:w-44">
                  <label className="block text-xs font-black uppercase tracking-wider text-slate-900 mb-1.5">
                    Level Filtresi
                  </label>
                  <input
                    type="text"
                    value={levelFilter}
                    onChange={(e) => setLevelFilter(e.target.value.toUpperCase())}
                    placeholder="Örn: 1AA, P07"
                    className="w-full px-3.5 py-3 rounded-xl border-[3px] border-slate-700 bg-white hover:border-blue-700 focus:border-blue-600 focus:ring-4 focus:ring-blue-200 text-sm sm:text-base font-extrabold uppercase text-slate-900 placeholder:text-slate-500 outline-none shadow-xs transition"
                  />
                </div>

                <div>
                  <label className="block text-xs font-black uppercase tracking-wider text-slate-900 mb-1.5">
                    Ürün Durumu / Yeri
                  </label>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as any)}
                    className="px-3.5 py-3 rounded-xl border-2 border-slate-700 bg-white hover:border-blue-700 focus:border-blue-600 text-sm font-extrabold text-slate-900 outline-none cursor-pointer"
                  >
                    <option value="ACTIVE">Tüm Aktifler (Depo + Transfer + Talep)</option>
                    <option value="IN_STOCK">🟢 Sadece Depoda Bekleyenler</option>
                    <option value="TRANSFERRED">🟣 Transfer Edilenler (Hatlarda)</option>
                    <option value="REQUESTED">🟠 Depodan Talep Edilenler</option>
                    <option value="CONSUMED">🔴 Stoktan Düşülenler (Bitenler)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-black uppercase tracking-wider text-slate-700 mb-1">
                    Sıralama
                  </label>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="px-3.5 py-3 rounded-xl border-2 border-slate-400 bg-white hover:border-slate-600 focus:border-blue-600 text-sm font-extrabold text-slate-800 outline-none cursor-pointer"
                  >
                    <option value="fifo">FIFO (En Eski Önce)</option>
                    <option value="newest">En Yeni Eklenen</option>
                    <option value="qty_desc">Miktar (Çoktan Aza)</option>
                    <option value="ref_asc">Referans (A-Z)</option>
                  </select>
                </div>
              </>
            )}

            {(search || levelFilter || statusFilter !== 'ACTIVE') && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setLevelFilter('');
                  setStatusFilter('ACTIVE');
                }}
                className="inline-flex items-center gap-1.5 px-4 py-3 rounded-xl border-2 border-rose-300 bg-rose-50 hover:bg-rose-100 text-xs font-extrabold text-rose-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
                Filtreyi Sıfırla
              </button>
            )}
          </div>
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
                        {grp.transferred_count > 0 && (
                          <span className="ml-2 px-2 py-0.5 rounded-full bg-violet-100 text-violet-900 text-xs font-bold">
                            {grp.transferred_count} Transferde
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
                    <th className="py-3.5 px-4">Personel / Hat</th>
                    <th className="py-3.5 px-4">Konum / Not</th>
                    <th className="py-3.5 px-4">Depo Süresi</th>
                    <th className="py-3.5 px-4">Durum / Bulunduğu Yer</th>
                    <th className="py-3.5 px-4 text-right">İşlemler</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-sm">
                  {items.map((it) => (
                    <tr
                      key={it.id}
                      className={`transition ${getRowStatusClasses(it.status, it.transferred_to)}`}
                    >
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
                      <td className="py-3.5 px-4 text-xs font-bold text-slate-700 max-w-[150px] truncate">
                        {it.created_by ? (
                          <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-slate-100 text-slate-800 font-bold text-xs">
                            {it.created_by}
                          </span>
                        ) : (
                          <span className="text-slate-400 font-normal">-</span>
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
                        <StockStatusBadge status={it.status} transferredTo={it.transferred_to} />
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
                                onClick={() => {
                                  setTransferringItem(it);
                                  setTransferTarget(it.transferred_to || '');
                                  setTransferNote('');
                                }}
                                title="Başka Bölüme / Hatta Transfer Et"
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold transition cursor-pointer"
                              >
                                <ArrowRightLeft className="w-3.5 h-3.5" />
                                Transfer
                              </button>
                              <button
                                type="button"
                                onClick={() => onPrintItem(it)}
                                title="Etiketi Tekrar Yazdır"
                                className="p-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 transition cursor-pointer"
                              >
                                <Printer className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => openEditModal(it)}
                                title="Düzenle"
                                className="p-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 transition cursor-pointer"
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
                    onBlur={() => {
                      const known = Array.from(
                        new Set([
                          ...(summary?.groups.map((g) => g.level) || []),
                          ...items.map((x) => x.level),
                        ])
                      );
                      const clean = resolveCanonicalLevelClient(editLevel, known);
                      if (clean && clean !== editLevel) {
                        setEditLevel(clean);
                      }
                    }}
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

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Personel / Hat
                </label>
                <input
                  type="text"
                  value={editCreatedBy}
                  onChange={(e) => setEditCreatedBy(e.target.value)}
                  placeholder="Örn: Paketleme Hat-1"
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

      {/* Hızlı Konum / Hat Transfer Modalı */}
      {transferringItem && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border-2 border-violet-300">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
                <ArrowRightLeft className="w-5 h-5 text-violet-600" />
                Ürünü Transfer Et
              </h3>
              <button
                type="button"
                onClick={() => setTransferringItem(null)}
                className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 mb-4 flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-mono-code font-bold text-slate-500">
                  {transferringItem.label_code}
                </div>
                <div className="text-xl font-black text-slate-900">
                  {transferringItem.reference}
                </div>
                <div className="text-xs font-bold text-slate-700 mt-0.5">
                  Level: {transferringItem.level} • {transferringItem.remaining_quantity} Adet
                </div>
              </div>
              <StockStatusBadge
                status={transferringItem.status}
                transferredTo={transferringItem.transferred_to}
                size="sm"
              />
            </div>

            <form onSubmit={handleConfirmTransferModal} className="space-y-4">
              <div>
                <label className="block text-xs font-black uppercase text-slate-700 mb-1.5">
                  Nereye Transfer Edilecek?
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={transferTarget}
                  onChange={(e) => setTransferTarget(e.target.value.toLocaleUpperCase('tr-TR'))}
                  placeholder="Örn: PAKETLEME HAT-1"
                  className="w-full rounded-xl border-2 border-slate-500 focus:border-violet-600 focus:ring-4 focus:ring-violet-100 px-3.5 py-3 text-base font-black uppercase outline-none"
                />

                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {QUICK_MODAL_TARGETS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTransferTarget(t)}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs font-extrabold cursor-pointer ${
                        transferTarget.trim() === t
                          ? 'border-violet-600 bg-violet-600 text-white'
                          : 'border-violet-200 bg-violet-50 hover:bg-violet-100 text-violet-900'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                  {transferringItem.status === 'TRANSFERRED' && (
                    <button
                      type="button"
                      onClick={() => setTransferTarget('DEPO')}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs font-extrabold cursor-pointer ${
                        transferTarget.trim() === 'DEPO'
                          ? 'border-emerald-600 bg-emerald-600 text-white'
                          : 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-900'
                      }`}
                    >
                      DEPOYA GERİ AL
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Açıklama (İsteğe Bağlı)
                </label>
                <input
                  type="text"
                  value={transferNote}
                  onChange={(e) => setTransferNote(e.target.value)}
                  placeholder="Örn: Hat sorumlusuna teslim edildi"
                  className="w-full rounded-xl border-2 border-slate-300 focus:border-violet-600 px-3.5 py-2.5 text-sm font-semibold outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setTransferringItem(null)}
                  className="px-4 py-2.5 rounded-xl border border-slate-300 text-sm font-bold text-slate-700 cursor-pointer"
                >
                  Vazgeç
                </button>
                <button
                  type="submit"
                  disabled={sendingTransfer || !transferTarget.trim()}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white text-sm font-extrabold cursor-pointer"
                >
                  <ArrowRightLeft className="w-4 h-4" />
                  {sendingTransfer ? 'Aktarılıyor...' : 'Transferi Kaydet'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
