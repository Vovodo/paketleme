import React from 'react';
import { Archive, BellRing, MapPin, Warehouse } from 'lucide-react';
import { StockStatus } from './types';

/**
 * Farklı transfer noktalarının bile birbirinden tek bakışta ayrılabilmesi için
 * Depoda (Yeşil), Talep (Turuncu) ve Kullanıldı (Kırmızı-Gül) renkleriyle ASLA çakışmayan
 * canlı transfer renk paleti (Mor, Çivit, Fuşya, Turkuaz, Gökyüzü Mavisi).
 */
const TRANSFER_DESTINATION_THEMES = [
  {
    badge: 'bg-violet-100 text-violet-950 border-violet-400',
    dot: 'bg-violet-600',
    rowBorder: 'border-l-violet-600',
    rowTint: 'bg-violet-50/35 hover:bg-violet-50/70',
  },
  {
    badge: 'bg-cyan-100 text-cyan-950 border-cyan-400',
    dot: 'bg-cyan-600',
    rowBorder: 'border-l-cyan-600',
    rowTint: 'bg-cyan-50/35 hover:bg-cyan-50/70',
  },
  {
    badge: 'bg-fuchsia-100 text-fuchsia-950 border-fuchsia-400',
    dot: 'bg-fuchsia-600',
    rowBorder: 'border-l-fuchsia-600',
    rowTint: 'bg-fuchsia-50/35 hover:bg-fuchsia-50/70',
  },
  {
    badge: 'bg-indigo-100 text-indigo-950 border-indigo-400',
    dot: 'bg-indigo-600',
    rowBorder: 'border-l-indigo-600',
    rowTint: 'bg-indigo-50/35 hover:bg-indigo-50/70',
  },
  {
    badge: 'bg-sky-100 text-sky-950 border-sky-400',
    dot: 'bg-sky-600',
    rowBorder: 'border-l-sky-600',
    rowTint: 'bg-sky-50/35 hover:bg-sky-50/70',
  },
];

function pickTransferTheme(destination?: string | null) {
  if (!destination) return TRANSFER_DESTINATION_THEMES[0];
  let hash = 0;
  const clean = destination.trim().toUpperCase();
  for (let i = 0; i < clean.length; i++) {
    hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
  }
  return TRANSFER_DESTINATION_THEMES[hash % TRANSFER_DESTINATION_THEMES.length];
}

export function getRowStatusClasses(status: StockStatus, transferredTo?: string | null): string {
  switch (status) {
    case 'IN_STOCK':
      return 'border-l-4 border-l-emerald-500 hover:bg-emerald-50/40';
    case 'REQUESTED':
      return 'border-l-4 border-l-amber-500 bg-amber-50/30 hover:bg-amber-50/60';
    case 'TRANSFERRED': {
      const th = pickTransferTheme(transferredTo);
      return `border-l-4 ${th.rowBorder} ${th.rowTint}`;
    }
    case 'CONSUMED':
    default:
      return 'border-l-4 border-l-rose-400 bg-slate-50/60 hover:bg-rose-50/30';
  }
}

export const StockStatusBadge: React.FC<{
  status: StockStatus;
  transferredTo?: string | null;
  size?: 'sm' | 'md';
}> = ({ status, transferredTo, size = 'md' }) => {
  const padCls = size === 'sm' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-xs';

  if (status === 'IN_STOCK') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border-2 border-emerald-400 bg-emerald-100 text-emerald-950 font-extrabold whitespace-nowrap shadow-2xs ${padCls}`}
      >
        <Warehouse className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
        <span>Depoda</span>
      </span>
    );
  }

  if (status === 'REQUESTED') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border-2 border-amber-400 bg-amber-100 text-amber-950 font-extrabold whitespace-nowrap shadow-2xs ${padCls}`}
      >
        <BellRing className="w-3.5 h-3.5 text-amber-700 shrink-0" />
        <span>Talep Edildi</span>
      </span>
    );
  }

  if (status === 'TRANSFERRED') {
    const th = pickTransferTheme(transferredTo);
    const placeText = transferredTo?.trim() || 'Transferde';
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border-2 font-extrabold whitespace-nowrap shadow-2xs ${th.badge} ${padCls}`}
        title={`Transfer Edildiği Yer: ${placeText}`}
      >
        <MapPin className="w-3.5 h-3.5 shrink-0" />
        <span className="max-w-[180px] truncate">{placeText}</span>
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border-2 border-rose-300 bg-rose-100 text-rose-900 font-extrabold whitespace-nowrap ${padCls}`}
    >
      <Archive className="w-3.5 h-3.5 text-rose-700 shrink-0" />
      <span>Stoktan Düşüldü</span>
    </span>
  );
};
