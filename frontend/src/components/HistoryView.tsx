import React, { useEffect, useState } from 'react';
import { History, RefreshCw, Search, X } from 'lucide-react';
import { api } from '../api';
import { StockMovementWithItem } from '../types';

const ACTION_LABELS: Record<string, { text: string; cls: string }> = {
  CREATED: { text: 'Depoya Kaldırıldı', cls: 'bg-blue-100 text-blue-900 border border-blue-300' },
  TRANSFERRED: {
    text: 'Konum / Hat Transferi',
    cls: 'bg-violet-100 text-violet-950 border border-violet-400',
  },
  REQUESTED: { text: 'Depodan Talep Edildi', cls: 'bg-amber-100 text-amber-950 border border-amber-400' },
  CANCEL_REQUEST: { text: 'Talep İptal', cls: 'bg-slate-100 text-slate-700 border border-slate-300' },
  DEDUCTED: { text: 'Tamamı Stoktan Düşüldü', cls: 'bg-emerald-100 text-emerald-900 border border-emerald-400' },
  PARTIAL_DEDUCTED: { text: 'Kısmi Stok Düşümü', cls: 'bg-fuchsia-100 text-fuchsia-900 border border-fuchsia-300' },
  INCREASED: { text: 'Miktar Artırıldı', cls: 'bg-sky-100 text-sky-900 border border-sky-300' },
  RESTORED: { text: 'Stoğa Geri Alındı', cls: 'bg-cyan-100 text-cyan-900 border border-cyan-300' },
  UPDATED: { text: 'Düzenlendi', cls: 'bg-slate-200 text-slate-800 border border-slate-300' },
};

export const HistoryView: React.FC<{ refreshKey: number }> = ({ refreshKey }) => {
  const [movements, setMovements] = useState<StockMovementWithItem[]>([]);
  const [query, setQuery] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);

  const loadHistory = async () => {
    try {
      const data = await api.listMovements(query || undefined);
      setMovements(data);
    } catch (err) {
      console.error(err);
    } finally {
      setInitialLoading(false);
    }
  };

  useEffect(() => {
    const delay = query ? 140 : 0;
    const t = setTimeout(loadHistory, delay);
    return () => clearTimeout(t);
  }, [query, refreshKey]);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border-2 border-slate-300 p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-amber-600" />
          <h2 className="text-lg font-extrabold text-slate-900">Stok &amp; Transfer Hareket Geçmişi</h2>
        </div>

        <div className="flex items-center gap-2 flex-1 max-w-lg">
          <div className="relative flex-1">
            <Search className="w-5 h-5 text-blue-600 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Referans, PKT Kodu, Level veya Transfer Yeri ara..."
              className="w-full pl-10 pr-9 py-2.5 rounded-xl border-[3px] border-slate-800 bg-amber-50/20 hover:border-blue-700 focus:bg-white focus:border-blue-600 focus:ring-4 focus:ring-blue-200 text-sm font-extrabold text-slate-900 placeholder:text-slate-500 outline-none transition"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={loadHistory}
            title="Yenile"
            className="p-3 rounded-xl border-2 border-slate-400 hover:bg-slate-100 text-slate-700 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {initialLoading ? (
          <div className="p-10 text-center text-slate-500 font-medium">Yükleniyor...</div>
        ) : movements.length === 0 ? (
          <div className="p-10 text-center text-slate-500 font-medium">
            Henüz hareket kaydı bulunmuyor.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-extrabold uppercase tracking-wider text-slate-500">
                  <th className="py-3 px-4">Tarih / Saat</th>
                  <th className="py-3 px-4">İşlem</th>
                  <th className="py-3 px-4">Etiket No</th>
                  <th className="py-3 px-4">Referans</th>
                  <th className="py-3 px-4">Level</th>
                  <th className="py-3 px-4 text-right">Değişim</th>
                  <th className="py-3 px-4 text-right">Kalan</th>
                  <th className="py-3 px-4">Açıklama</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {movements.map((m) => {
                  const badge = ACTION_LABELS[m.action] || {
                    text: m.action,
                    cls: 'bg-slate-100 text-slate-800',
                  };
                  return (
                    <tr key={m.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 text-xs text-slate-500 font-medium whitespace-nowrap">
                        {new Date(m.created_at).toLocaleString('tr-TR')}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-extrabold ${badge.cls}`}
                        >
                          {badge.text}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono-code text-xs font-bold text-slate-700">
                        {m.label_code}
                      </td>
                      <td className="py-3 px-4 font-extrabold text-slate-900">{m.reference}</td>
                      <td className="py-3 px-4 font-bold text-slate-700">{m.level}</td>
                      <td
                        className={`py-3 px-4 text-right font-extrabold ${
                          m.quantity_change > 0
                            ? 'text-blue-600'
                            : m.quantity_change < 0
                            ? 'text-emerald-600'
                            : 'text-slate-400'
                        }`}
                      >
                        {m.quantity_change > 0 ? `+${m.quantity_change}` : m.quantity_change}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-slate-800">
                        {m.quantity_after}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">{m.note || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
