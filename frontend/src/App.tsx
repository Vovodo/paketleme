import React, { useEffect, useState } from 'react';
import {
  Boxes,
  History,
  PackagePlus,
  QrCode,
  Settings,
} from 'lucide-react';
import { api } from './api';
import { CreateLabelView } from './components/CreateLabelView';
import { HistoryView } from './components/HistoryView';
import { PrintableLabel } from './components/PrintableLabel';
import { ScanDeductView } from './components/ScanDeductView';
import { SettingsView } from './components/SettingsView';
import { StockDashboardView } from './components/StockDashboardView';
import { PaperFormat, StockItem } from './types';

type ActiveTab = 'create' | 'stock' | 'scan' | 'history' | 'settings';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('create');
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeStockCount, setActiveStockCount] = useState(0);

  const [paperFormat, setPaperFormat] = useState<PaperFormat>(() => {
    const saved = localStorage.getItem('pkt_paper_format');
    if (saved === 'a4-landscape' || saved === 'a5-landscape' || saved === 'thermal-150x100') {
      return saved;
    }
    return 'a4-landscape';
  });

  const [printItem, setPrintItem] = useState<StockItem | null>(null);

  const refreshBadges = async () => {
    try {
      const sum = await api.getSummary();
      setActiveStockCount(sum.active_label_count);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (activeTab !== 'stock') {
      refreshBadges();
    }
  }, [refreshKey, activeTab]);

  const triggerDataChanged = () => {
    setRefreshKey((k) => k + 1);
  };

  const handlePaperFormatChange = (fmt: PaperFormat) => {
    setPaperFormat(fmt);
    localStorage.setItem('pkt_paper_format', fmt);
  };

  const handlePrintItem = (item: StockItem) => {
    setPrintItem(item);
    setTimeout(() => {
      window.print();
    }, 140);
  };

  return (
    <>
      {/* EKRAN ARAYÜZÜ (Yazdırma sırasında gizlenir) */}
      <div className="no-print min-h-screen flex flex-col bg-slate-50 text-slate-900">
        {/* Üst Navigasyon Barı */}
        <header className="bg-slate-900 text-white shadow-md sticky top-0 z-40">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between py-3 gap-3">
              <div className="flex items-center gap-3.5">
                <img
                  src="/logo.jpg"
                  alt="Paketleme Stok Logo"
                  className="w-11 h-11 rounded-xl object-cover ring-1 ring-white/15 shadow-sm shrink-0"
                />
                <div>
                  <h1 className="text-base sm:text-lg font-extrabold tracking-tight leading-tight">
                    Paketsiz Kılıf Stok &amp; Etiket Sistemi
                  </h1>
                  <p className="text-xs text-slate-400 font-medium">
                    Paketleme &amp; Depo Referans / Level / QR Takip Platformu
                  </p>
                </div>
              </div>

              <nav className="no-scrollbar flex items-center gap-1.5 overflow-x-auto md:flex-wrap md:justify-end">
                <button
                  type="button"
                  onClick={() => setActiveTab('create')}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition cursor-pointer ${
                    activeTab === 'create'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <PackagePlus className="w-4 h-4" />
                  Etiket Bas / Depoya Kaldır
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('stock')}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition cursor-pointer ${
                    activeTab === 'stock'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <Boxes className="w-4 h-4" />
                  Depo Stok Takip
                  {activeStockCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-slate-700 text-[11px] font-extrabold text-slate-100">
                      {activeStockCount}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('scan')}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition cursor-pointer ${
                    activeTab === 'scan'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <QrCode className="w-4 h-4" />
                  QR Okut / Stoktan Düş
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('history')}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition cursor-pointer ${
                    activeTab === 'history'
                      ? 'bg-slate-700 text-white shadow-sm'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <History className="w-4 h-4" />
                  Geçmiş
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('settings')}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap transition cursor-pointer ${
                    activeTab === 'settings'
                      ? 'bg-slate-700 text-white shadow-sm'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <Settings className="w-4 h-4" />
                  Ayarlar
                </button>
              </nav>
            </div>
          </div>
        </header>

        {/* Ana İçerik */}
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
          {activeTab === 'create' && (
            <CreateLabelView
              paperFormat={paperFormat}
              onPaperFormatChange={handlePaperFormatChange}
              onPrintItem={handlePrintItem}
              onCreated={triggerDataChanged}
            />
          )}

          {activeTab === 'stock' && (
            <StockDashboardView
              refreshKey={refreshKey}
              onPrintItem={handlePrintItem}
              onDataChanged={triggerDataChanged}
              onActiveCountChange={setActiveStockCount}
            />
          )}

          {activeTab === 'scan' && (
            <ScanDeductView
              onPrintItem={handlePrintItem}
              onDeducted={triggerDataChanged}
            />
          )}

          {activeTab === 'history' && <HistoryView refreshKey={refreshKey} />}

          {activeTab === 'settings' && <SettingsView />}
        </main>
      </div>

      {/* YAZICI ÇIKTI KATMANI (Sadece @media print sırasında görünür) */}
      <div className="print-only-root">
        {printItem && <PrintableLabel item={printItem} paperFormat={paperFormat} />}
      </div>
    </>
  );
};

export default App;
