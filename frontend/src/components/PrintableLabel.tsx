import React, { useLayoutEffect, useRef } from 'react';
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
    created_by?: string | null;
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

function getQtyFontSize(text: string, format: PaperFormat): string {
  const len = Math.max(text.length, 1);
  const scale = format === 'thermal-150x100' ? 0.5 : format === 'a5-landscape' ? 0.7 : 1;

  let pt = 88;
  if (len <= 3) pt = 96;
  else if (len <= 5) pt = 78;
  else pt = 60;

  return `${Math.round(pt * scale)}pt`;
}

/**
 * Tek satırda kalarak (asla alt satıra taşmadan) SVG metninin gerçek piksel genişliğini
 * (getComputedTextLength) ölçer ve kutu genişliğini maksimum okunaklılıkla dolduracak
 * viewBox değerini otomatik ayarlar. Baskı katmanı gizliyken bile güvenli ön hesap yapar.
 */
const SingleLineAutoFitText: React.FC<{
  text: string;
  heightStyle: string;
  minComfortWidthUnits?: number;
}> = ({ text, heightStyle, minComfortWidthUnits = 340 }) => {
  const clean = text || '-';
  const svgRef = useRef<SVGSVGElement>(null);
  const textRef = useRef<SVGTextElement>(null);

  const fallbackUnits = Array.from(clean).reduce((acc, ch) => {
    if (ch === ' ') return acc + 0.36;
    if (ch === '-' || ch === '/' || ch === '.') return acc + 0.48;
    if (ch === 'I' || ch === '1') return acc + 0.68;
    return acc + 0.88;
  }, 0);

  const initialViewWidth = Math.max(
    minComfortWidthUnits,
    Math.ceil(fallbackUnits * 68 + 18)
  );

  useLayoutEffect(() => {
    const svgEl = svgRef.current;
    const txtEl = textRef.current;
    if (!svgEl || !txtEl) return;

    try {
      const measured = txtEl.getComputedTextLength();
      if (measured > 0) {
        const padded = Math.max(minComfortWidthUnits, Math.ceil(measured + 16));
        svgEl.setAttribute('viewBox', `0 0 ${padded} 100`);
        txtEl.setAttribute('x', String(padded / 2));
      }
    } catch {
      // Gizli print katmanında ölçüm desteklenmezse hassas fallback devrede kalır
    }
  }, [clean, minComfortWidthUnits]);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${initialViewWidth} 100`}
      preserveAspectRatio="xMidYMid meet"
      style={{
        width: '100%',
        height: heightStyle,
        display: 'block',
        overflow: 'hidden',
      }}
    >
      <text
        ref={textRef}
        x={initialViewWidth / 2}
        y={54}
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        style={{
          fontFamily: "'Inter', Arial, Helvetica, sans-serif",
          fontWeight: 900,
          fontSize: '88px',
          letterSpacing: '-0.02em',
        }}
      >
        {clean}
      </text>
    </svg>
  );
};

export const PrintableLabel: React.FC<PrintableLabelProps> = ({
  item,
  paperFormat,
  isPreview = false,
}) => {
  const refDisplay = (item.reference || 'REFERANS').toLocaleUpperCase('tr-TR');
  const lvlDisplay = (item.level || 'LEVEL').toLocaleUpperCase('tr-TR');
  const qtyDisplay = String(item.remaining_quantity || 0);
  const noteDisplay = item.location_note ? item.location_note.trim().toLocaleUpperCase('tr-TR') : '';
  const operatorDisplay = item.created_by ? item.created_by.trim().toLocaleUpperCase('tr-TR') : '';
  const qrSize =
    paperFormat === 'thermal-150x100' ? 112 : paperFormat === 'a5-landscape' ? 148 : 200;

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
        {/* Üst Bant (Konumu kesinlikle sabit) */}
        <div className="flex items-center justify-between bg-black text-white px-3 py-1.5 rounded-sm">
          <span className="text-[11px] sm:text-xs font-black tracking-widest uppercase">
            PAKETSİZ KILIF DEPO ETİKETİ
          </span>
          <div className="flex items-center gap-3 text-[11px] sm:text-xs font-mono-code font-bold">
            <span>{formattedDate}</span>
            <span className="bg-white text-black px-2 py-0.5 font-black">{item.label_code}</span>
          </div>
        </div>

        {/* Orta Referans (Sağ üst köşede mutlak konumlu Personel/Hat bilgisi; hiçbir yazıyı kaydırmaz) */}
        <div className="relative flex-1 flex flex-col justify-center items-center border-b-4 border-black py-2 px-2 text-center min-h-0">
          {operatorDisplay && (
            <div className="absolute right-1.5 top-1.5 max-w-[38%] truncate border border-black bg-neutral-50 px-2 py-0.5 text-[10px] sm:text-xs font-black tracking-wider uppercase text-black leading-tight">
              {operatorDisplay}
            </div>
          )}
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
          {noteDisplay && (
            <div className="mt-2 text-base sm:text-xl font-black bg-neutral-100 border-2 border-black px-3.5 py-1 uppercase max-w-full line-clamp-2 break-words tracking-wide leading-tight">
              {noteDisplay}
            </div>
          )}
        </div>

        {/* Alt Kısım: Level + Miktar + Köşede QR */}
        <div className="grid grid-cols-12 gap-2 pt-2 items-stretch">
          <div className="col-span-6 border-3 border-black px-2.5 py-2 flex flex-col justify-between items-center text-center min-w-0">
            <span className="text-[10px] font-black tracking-widest uppercase">LEVEL</span>
            <div className="w-full my-auto py-1 flex items-center justify-center">
              <SingleLineAutoFitText text={lvlDisplay} heightStyle="2.75rem" minComfortWidthUnits={330} />
            </div>
          </div>

          <div className="col-span-3 bg-black text-white p-2 flex flex-col justify-between items-center text-center min-w-0">
            <span className="text-[10px] font-black tracking-widest uppercase text-neutral-200">
              MİKTAR (ADET)
            </span>
            <span className="text-3xl sm:text-5xl font-black leading-none my-auto py-1 whitespace-nowrap">
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
  const isA5 = paperFormat === 'a5-landscape';
  const levelSvgHeight = isThermal ? '19mm' : isA5 ? '27mm' : '38mm';

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
            position: 'relative',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            borderBottom: isThermal ? '3px solid #000' : '6px solid #000',
            padding: isThermal ? '2mm 1mm' : '3mm 2mm',
            textAlign: 'center',
            minHeight: 0,
          }}
        >
          {operatorDisplay && (
            <div
              style={{
                position: 'absolute',
                top: isThermal ? '1.5mm' : '2.5mm',
                right: isThermal ? '1mm' : '1.5mm',
                maxWidth: '38%',
                border: isThermal ? '1.5px solid #000' : '2px solid #000',
                padding: isThermal ? '0.6mm 2mm' : '1mm 3.5mm',
                fontSize: isThermal ? '9pt' : isA5 ? '12pt' : '15pt',
                fontWeight: 900,
                letterSpacing: '0.06em',
                lineHeight: 1.15,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                backgroundColor: '#ffffff',
              }}
            >
              {operatorDisplay}
            </div>
          )}
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
          {noteDisplay && (
            <div
              style={{
                marginTop: isThermal ? '2mm' : '3.5mm',
                border: isThermal ? '2px solid #000' : '3px solid #000',
                padding: isThermal ? '1.2mm 4mm' : '2mm 6mm',
                fontSize: isThermal ? '13pt' : isA5 ? '18pt' : '24pt',
                fontWeight: 900,
                letterSpacing: '0.03em',
                lineHeight: 1.15,
                maxWidth: '96%',
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                wordBreak: 'break-word',
              }}
            >
              {noteDisplay}
            </div>
          )}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: isThermal ? '1.45fr 0.85fr auto' : '1.5fr 0.85fr auto',
            gap: isThermal ? '3mm' : '5mm',
            paddingTop: isThermal ? '2.5mm' : '4mm',
            alignItems: 'stretch',
          }}
        >
          <div
            style={{
              border: isThermal ? '3px solid #000' : '5px solid #000',
              padding: isThermal ? '2mm 2.5mm' : '3mm 4.5mm',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'space-between',
              textAlign: 'center',
              minWidth: 0,
              overflow: 'hidden',
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
                width: '100%',
                margin: 'auto 0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <SingleLineAutoFitText
                text={lvlDisplay}
                heightStyle={levelSvgHeight}
                minComfortWidthUnits={330}
              />
            </div>
          </div>

          <div
            style={{
              border: isThermal ? '3px solid #000' : '5px solid #000',
              backgroundColor: '#000000',
              color: '#ffffff',
              padding: isThermal ? '2mm' : '3mm 3.5mm',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'space-between',
              textAlign: 'center',
              minWidth: 0,
            }}
          >
            <div
              style={{
                fontSize: isThermal ? '10pt' : '15pt',
                fontWeight: 900,
                letterSpacing: '0.15em',
                whiteSpace: 'nowrap',
              }}
            >
              MİKTAR (ADET)
            </div>
            <div
              style={{
                fontSize: getQtyFontSize(qtyDisplay, paperFormat),
                fontWeight: 900,
                lineHeight: 1,
                margin: 'auto 0',
                whiteSpace: 'nowrap',
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
