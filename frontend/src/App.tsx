import React, { useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  Boxes,
  History,
  PackagePlus,
  QrCode,
  Settings,
} from 'lucide-react';
import { api, getSavedSafeBrowserToken } from './api';
import { CreateLabelView } from './components/CreateLabelView';
import { HistoryView } from './components/HistoryView';
import { PinGateView } from './components/PinGateView';
import { PrintableLabel } from './components/PrintableLabel';
import { ScanDeductView } from './components/ScanDeductView';
import { SettingsView } from './components/SettingsView';
import { StockDashboardView } from './components/StockDashboardView';
import { TransferView } from './components/TransferView';
import { PaperFormat, StockItem } from './types';

type ActiveTab = 'create' | 'stock' | 'transfer' | 'scan' | 'history' | 'settings';

export const App: React.FC = () => {
  const [pinState, setPinState] = useState<'checking' | 'locked' | 'unlocked'>(() =>
    getSavedSafeBrowserToken() ? 'unlocked' : 'checking'
  );
  const [activeTab, setActiveTab] = useState<ActiveTab>('create');
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeStockCount, setActiveStockCount] = useState(0);
  const [transferredStockCount, setTransferredStockCount] = useState(0);

  const [paperFormat, setPaperFormat] = useState<PaperFormat>(() => {
    const saved = localStorage.getItem('pkt_paper_format');
    if (saved === 'a4-landscape' || saved === 'a5-landscape' || saved === 'thermal-150x100') {
      return saved;
    }
    return 'a4-landscape';
  });

  const [printItem, setPrintItem] = useState<StockItem | null>(null);

  useEffect(() => {
    let mounted = true;
    api.checkPinSession().then((ok) => {
      if (!mounted) return;
      setPinState(ok ? 'unlocked' : 'locked');
    });

    const handlePinRequired = () => {
      setPinState('locked');
    };
    window.addEventListener('pkt:pin-required', handlePinRequired);
    return () => {
      mounted = false;
      window.removeEventListener('pkt:pin-required', handlePinRequired);
    };
  }, []);

  const refreshBadges = async () => {
    try {
      const sum = await api.getSummary();
      setActiveStockCount(sum.active_label_count);
      setTransferredStockCount(sum.transferred_label_count || 0);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (pinState === 'unlocked' && activeTab !== 'stock') {
      refreshBadges();
    }
  }, [refreshKey, activeTab, pinState]);

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

  if (pinState === 'checking') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-sm font-bold text-slate-500">Güvenli oturum kontrol ediliyor...</div>
      </div>
    );
  }

  if (pinState === 'locked') {
    return <PinGateView onUnlocked={() => setPinState('unlocked')} />;
  }

  return (
    <>
      {/* EKRAN ARAYÜZÜ (Yazdırma sırasında gizlenir) */}
      <div className="no-print min-h-screen flex flex-col bg-slate-50 text-slate-900">
        {/* Üst Navigasyon Barı — Renk Kodlu Kolay Ayırt Edilebilir Menü */}
        <header className="bg-slate-900 text-white shadow-lg sticky top-0 z-40 border-b border-slate-800">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between py-3 gap-3">
              <div className="flex items-center gap-3.5">
                <img
                  src="/logo.jpg"
                  alt="Paketleme Stok Logo"
                  className="w-11 h-11 rounded-xl object-cover ring-2 ring-white/20 shadow-sm shrink-0"
                />
                <div>
                  <h1 className="text-base sm:text-lg font-extrabold tracking-tight leading-tight">
                    Paketsiz Kılıf Stok &amp; Etiket Sistemi
                  </h1>
                  <p className="text-xs text-slate-400 font-medium">
                    Etiket Bas • Konum Transfer Et • QR ile Stoktan Düş
                  </p>
                </div>
              </div>

              <nav className="no-scrollbar flex items-center gap-2.5 overflow-x-auto py-1 px-1 xl:flex-wrap xl:justify-end">
                {/* 1. MAVİ: Etiket Bas */}
                <button
                  type="button"
                  onClick={() => setActiveTab('create')}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-black whitespace-nowrap transition cursor-pointer ${
                    activeTab === 'create'
                      ? 'bg-blue-500 text-white ring-3 ring-white shadow-lg'
                      : 'bg-blue-700 hover:bg-blue-600 text-white/95 opacity-85 hover:opacity-100'
                  }`}
                >
                  <PackagePlus className="w-4 h-4 shrink-0" />
                  <span>Etiket Bas</span>
                </button>

                {/* 2. TURKUAZ: Stok & Durum Takip */}
                <button
                  type="button"
                  onClick={() => setActiveTab('stock')}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-black whitespace-nowrap transition cursor-pointer ${
                    activeTab === 'stock'
                      ? 'bg-cyan-500 text-slate-950 ring-3 ring-white shadow-lg'
                      : 'bg-cyan-700 hover:bg-cyan-600 text-white opacity-85 hover:opacity-100'
                  }`}
                >
                  <Boxes className="w-4 h-4 shrink-0" />
                  <span>Stok &amp; Durum Takip</span>
                  {activeStockCount > 0 && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-black ${
                        activeTab === 'stock'
                          ? 'bg-slate-950 text-cyan-300'
                          : 'bg-white text-cyan-950'
                      }`}
                    >
                      {activeStockCount}
                    </span>
                  )}
                </button>

                {/* 3. MOR: Ürün Transfer Ekranı */}
                <button
                  type="button"
                  onClick={() => setActiveTab('transfer')}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-black whitespace-nowrap transition cursor-pointer ${
                    activeTab === 'transfer'
                      ? 'bg-violet-500 text-white ring-3 ring-white shadow-lg'
                      : 'bg-violet-700 hover:bg-violet-600 text-white opacity-85 hover:opacity-100'
                  }`}
                >
                  <ArrowRightLeft className="w-4 h-4 shrink-0" />
                  <span>Ürün Transfer</span>
                  {transferredStockCount > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-white text-violet-900 text-[11px] font-black">
                      {transferredStockCount}
                    </span>
                  )}
                </button>

                {/* 4. YEŞİL: QR Okut / Stoktan Düş */}
                <button
                  type="button"
                  onClick={() => setActiveTab('scan')}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-black whitespace-nowrap transition cursor-pointer ${
                    activeTab === 'scan'
                      ? 'bg-emerald-500 text-slate-950 ring-3 ring-white shadow-lg'
                      : 'bg-emerald-700 hover:bg-emerald-600 text-white opacity-85 hover:opacity-100'
                  }`}
                >
                  <QrCode className="w-4 h-4 shrink-0" />
                  <span>QR Okut / Stok Düş</span>
                </button>

                {/* 5. TURUNCU: Geçmiş */}
                <button
                  type="button"
                  onClick={() => setActiveTab('history')}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-black whitespace-nowrap transition cursor-pointer ${
                    activeTab === 'history'
                      ? 'bg-amber-400 text-slate-950 ring-3 ring-white shadow-lg'
                      : 'bg-amber-600 hover:bg-amber-500 text-white opacity-85 hover:opacity-100'
                  }`}
                >
                  <History className="w-4 h-4 shrink-0" />
                  <span>Geçmiş</span>
                </button>

                {/* 6. KIRMIZI / GÜL: Ayarlar */}
                <button
                  type="button"
                  onClick={() => setActiveTab('settings')}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-black whitespace-nowrap transition cursor-pointer ${
                    activeTab === 'settings'
                      ? 'bg-rose-500 text-white ring-3 ring-white shadow-lg'
                      : 'bg-rose-700 hover:bg-rose-600 text-white opacity-85 hover:opacity-100'
                  }`}
                >
                  <Settings className="w-4 h-4 shrink-0" />
                  <span>Ayarlar</span>
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
              onActiveCountChange={(activeCnt, trCnt) => {
                setActiveStockCount(activeCnt);
                if (typeof trCnt === 'number') setTransferredStockCount(trCnt);
              }}
            />
          )}

          {activeTab === 'transfer' && (
            <TransferView
              refreshKey={refreshKey}
              onPrintItem={handlePrintItem}
              onTransferred={triggerDataChanged}
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
