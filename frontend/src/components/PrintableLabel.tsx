import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { PaperFormat } from '../types';

interface PrintableLabelProps {
  item: {
    label_code: string;
    qr_payload: string;
    reference: string;
    level: string;
    remaining_quantity: number;
    location_note?: string | null;
    created_at?: string;
  };
  paperFormat: PaperFormat;
  isPreview?: boolean;
}

function getPageCss(format: PaperFormat): string {
  if (format === 'thermal-150x100') {
    return `@page { size: 150mm 100mm; margin: 4mm; }`;
  }
  if (format === 'a5-landscape') {
    return `@page { size: A5 landscape; margin: 6mm; }`;
  }
  return `@page { size: A4 landscape; margin: 7mm; }`;
}

function getSheetDimensions(format: PaperFormat): { width: string; height: string } {
  if (format === 'thermal-150x100') {
    return { width: '142mm', height: '92mm' };
  }
  if (format === 'a5-landscape') {
    return { width: '198mm', height: '136mm' };
  }
  return { width: '283mm', height: '196mm' };
}

function getRefFontSize(refText: string, format: PaperFormat): string {
  const len = Math.max(refText.length, 1);
  const scale = format === 'thermal-150x100' ? 0.5 : format === 'a5-landscape' ? 0.7 : 1;

  let pt = 128;
  if (len <= 7) pt = 136;
  else if (len <= 10) pt = 112;
  else if (len <= 13) pt = 90;
  else if (len <= 16) pt = 74;
  else if (len <= 20) pt = 60;
  else pt = 46;

  return `${Math.round(pt * scale)}pt`;
}

function getSubValueFontSize(text: string, format: PaperFormat): string {
  const len = Math.max(text.length, 1);
  const scale = format === 'thermal-150x100' ? 0.5 : format === 'a5-landscape' ? 0.7 : 1;

  let pt = 84;
  if (len <= 4) pt = 92;
  else if (len <= 7) pt = 74;
  else if (len <= 10) pt = 58;
  else pt = 44;

  return `${Math.round(pt * scale)}pt`;
}

export const PrintableLabel: React.FC<PrintableLabelProps> = ({
  item,
  paperFormat,
  isPreview = false,
}) => {
  const refDisplay = (item.reference || 'REFERANS').toUpperCase();
  const lvlDisplay = (item.level || 'LEVEL').toUpperCase();
  const qtyDisplay = String(item.remaining_quantity || 0);
  const qrSize =
    paperFormat === 'thermal-150x100' ? 112 : paperFormat === 'a5-landscape' ? 148 : 205;

  const formattedDate = item.created_at
    ? new Date(item.created_at).toLocaleString('tr-TR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : new Date().toLocaleString('tr-TR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

  if (isPreview) {
    return (
      <div className="w-full aspect-[1.44/1] bg-white text-black border-4 border-black rounded-lg p-3 sm:p-4 flex flex-col justify-between shadow-sm select-none overflow-hidden">
        {/* Üst Bant */}
        <div className="flex items-center justify-between bg-black text-white px-3 py-1.5 rounded-sm">
          <span className="text-[11px] sm:text-xs font-black tracking-widest uppercase">
            PAKETSİZ KILIF DEPO ETİKETİ
          </span>
          <div className="flex items-center gap-3 text-[11px] sm:text-xs font-mono-code font-bold">
            <span>{formattedDate}</span>
            <span className="bg-white text-black px-2 py-0.5 font-black">{item.label_code}</span>
          </div>
        </div>

        {/* Orta Referans */}
        <div className="flex-1 flex flex-col justify-center items-center border-b-4 border-black py-2 px-2 text-center min-h-0">
          <span className="text-[10px] sm:text-xs font-extrabold tracking-[0.25em] uppercase text-neutral-600 mb-0.5">
            REFERANS
          </span>
          <div
            className="font-black leading-none tracking-tight break-all w-full text-center"
            style={{
              fontSize:
                refDisplay.length <= 9
                  ? 'clamp(2rem, 4.8vw, 3.8rem)'
                  : refDisplay.length <= 14
                  ? 'clamp(1.6rem, 3.6vw, 2.9rem)'
                  : 'clamp(1.25rem, 2.6vw, 2.1rem)',
            }}
          >
            {refDisplay}
          </div>
          {item.location_note && (
            <div className="mt-1.5 text-xs font-bold bg-neutral-100 border border-black px-2.5 py-0.5 uppercase max-w-full line-clamp-2 break-words">
              NOT / KONUM: {item.location_note}
            </div>
          )}
        </div>

        {/* Alt Kısım: Level + Miktar + Köşede QR */}
        <div className="grid grid-cols-12 gap-2 pt-2 items-stretch">
          <div className="col-span-5 border-3 border-black p-2 flex flex-col justify-between items-center text-center">
            <span className="text-[10px] font-black tracking-widest uppercase">LEVEL</span>
            <span className="text-2xl sm:text-4xl font-black leading-none tracking-tight my-auto py-1 break-all">
              {lvlDisplay}
            </span>
          </div>

          <div className="col-span-4 bg-black text-white p-2 flex flex-col justify-between items-center text-center">
            <span className="text-[10px] font-black tracking-widest uppercase text-neutral-200">
              MİKTAR (ADET)
            </span>
            <span className="text-3xl sm:text-5xl font-black leading-none my-auto py-1">
              {qtyDisplay}
            </span>
          </div>

          <div className="col-span-3 border-2 border-black p-1.5 flex flex-col items-center justify-center bg-white">
            <QRCodeSVG
              value={item.qr_payload || 'PKT-PREVIEW'}
              size={76}
              level="M"
              marginSize={1}
            />
            <span className="text-[9px] font-mono-code font-black mt-1 leading-none">
              {item.label_code}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const dims = getSheetDimensions(paperFormat);
  const isThermal = paperFormat === 'thermal-150x100';

  return (
    <>
      <style>{getPageCss(paperFormat)}</style>
      <div
        style={{
          width: dims.width,
          height: dims.height,
          boxSizing: 'border-box',
          border: isThermal ? '3px solid #000' : '6px solid #000',
          padding: isThermal ? '3mm' : '5mm',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: '#ffffff',
          color: '#000000',
          fontFamily: "'Inter', Arial, Helvetica, sans-serif",
          overflow: 'hidden',
          pageBreakAfter: 'avoid',
          breakInside: 'avoid',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#000000',
            color: '#ffffff',
            padding: isThermal ? '2mm 3mm' : '3mm 5mm',
          }}
        >
          <div
            style={{
              fontSize: isThermal ? '10pt' : '15pt',
              fontWeight: 900,
              letterSpacing: '0.12em',
            }}
          >
            PAKETSİZ KILIF DEPO ETİKETİ
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5mm' }}>
            <span style={{ fontSize: isThermal ? '9pt' : '13pt', fontWeight: 700 }}>
              {formattedDate}
            </span>
            <span
              style={{
                backgroundColor: '#ffffff',
                color: '#000000',
                padding: '1mm 3mm',
                fontSize: isThermal ? '11pt' : '16pt',
                fontWeight: 900,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {item.label_code}
            </span>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            borderBottom: isThermal ? '3px solid #000' : '6px solid #000',
            padding: isThermal ? '2mm 1mm' : '3mm 2mm',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontSize: isThermal ? '10pt' : '16pt',
              fontWeight: 900,
              letterSpacing: '0.3em',
              marginBottom: '1mm',
            }}
          >
            REFERANS
          </div>
          <div
            style={{
              fontSize: getRefFontSize(refDisplay, paperFormat),
              fontWeight: 900,
              lineHeight: 0.96,
              letterSpacing: '-0.02em',
              wordBreak: 'break-all',
              width: '100%',
            }}
          >
            {refDisplay}
          </div>
          {item.location_note && (
            <div
              style={{
                marginTop: '2mm',
                border: '2px solid #000',
                padding: '1mm 4mm',
                fontSize: isThermal ? '9pt' : '13pt',
                fontWeight: 800,
                maxWidth: '96%',
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                wordBreak: 'break-word',
              }}
            >
              NOT / KONUM: {item.location_note.toUpperCase()}
            </div>
          )}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: isThermal ? '1.2fr 1fr auto' : '1.25fr 1fr auto',
            gap: isThermal ? '3mm' : '5mm',
            paddingTop: isThermal ? '2.5mm' : '4mm',
            alignItems: 'stretch',
          }}
        >
          <div
            style={{
              border: isThermal ? '3px solid #000' : '5px solid #000',
              padding: isThermal ? '2mm' : '3mm 4mm',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'space-between',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontSize: isThermal ? '10pt' : '16pt',
                fontWeight: 900,
                letterSpacing: '0.2em',
              }}
            >
              LEVEL
            </div>
            <div
              style={{
                fontSize: getSubValueFontSize(lvlDisplay, paperFormat),
                fontWeight: 900,
                lineHeight: 1,
                margin: 'auto 0',
                wordBreak: 'break-all',
              }}
            >
              {lvlDisplay}
            </div>
          </div>

          <div
            style={{
              border: isThermal ? '3px solid #000' : '5px solid #000',
              backgroundColor: '#000000',
              color: '#ffffff',
              padding: isThermal ? '2mm' : '3mm 4mm',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'space-between',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontSize: isThermal ? '10pt' : '16pt',
                fontWeight: 900,
                letterSpacing: '0.18em',
              }}
            >
              MİKTAR (ADET)
            </div>
            <div
              style={{
                fontSize: getSubValueFontSize(qtyDisplay, paperFormat),
                fontWeight: 900,
                lineHeight: 1,
                margin: 'auto 0',
              }}
            >
              {qtyDisplay}
            </div>
          </div>

          <div
            style={{
              border: isThermal ? '2px solid #000' : '4px solid #000',
              padding: isThermal ? '1.5mm 2mm' : '2.5mm 3.5mm',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: '#ffffff',
            }}
          >
            <QRCodeSVG value={item.qr_payload} size={qrSize} level="M" marginSize={1} />
            <div
              style={{
                marginTop: '1.5mm',
                fontSize: isThermal ? '8.5pt' : '12pt',
                fontWeight: 900,
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: '0.05em',
              }}
            >
              {item.label_code}
            </div>
            <div
              style={{
                fontSize: isThermal ? '6.5pt' : '8.5pt',
                fontWeight: 800,
                letterSpacing: '0.06em',
              }}
            >
              STOK DÜŞÜM QR
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
