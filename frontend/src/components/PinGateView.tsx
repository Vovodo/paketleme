import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Delete, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '../api';

interface PinGateViewProps {
  onUnlocked: () => void;
}

const PIN_LENGTH = 8;

export const PinGateView: React.FC<PinGateViewProps> = ({ onUnlocked }) => {
  const [digits, setDigits] = useState<string[]>(() => Array(PIN_LENGTH).fill(''));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const submittingRef = useRef(false);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const resetDigits = () => {
    setDigits(Array(PIN_LENGTH).fill(''));
    setTimeout(() => {
      inputRefs.current[0]?.focus();
    }, 40);
  };

  const submitPin = async (pinCode: string) => {
    if (submittingRef.current || pinCode.length !== PIN_LENGTH) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      await api.verifyPinCode(pinCode);
      onUnlocked();
    } catch (err: any) {
      setError(err.message || 'PIN kodu hatalı.');
      resetDigits();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const updateDigitAt = (index: number, rawVal: string) => {
    const clean = rawVal.replace(/\D/g, '');
    if (!clean) {
      const next = [...digits];
      next[index] = '';
      setDigits(next);
      return;
    }

    const next = [...digits];
    for (let i = 0; i < clean.length && index + i < PIN_LENGTH; i++) {
      next[index + i] = clean[i];
    }
    setDigits(next);
    setError(null);

    const nextEmptyIdx = next.findIndex((d) => d === '');
    if (nextEmptyIdx === -1) {
      submitPin(next.join(''));
    } else {
      inputRefs.current[nextEmptyIdx]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[index]) {
        const next = [...digits];
        next[index] = '';
        setDigits(next);
      } else if (index > 0) {
        const next = [...digits];
        next[index - 1] = '';
        setDigits(next);
        inputRefs.current[index - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < PIN_LENGTH - 1) {
      e.preventDefault();
      inputRefs.current[index + 1]?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const joined = digits.join('');
      if (joined.length === PIN_LENGTH) {
        submitPin(joined);
      }
    }
  };

  const handleKeypadDigit = (d: string) => {
    if (submitting) return;
    const emptyIdx = digits.findIndex((x) => x === '');
    if (emptyIdx === -1) return;
    updateDigitAt(emptyIdx, d);
  };

  const handleKeypadBackspace = () => {
    if (submitting) return;
    const lastFilled = [...digits].reverse().findIndex((x) => x !== '');
    if (lastFilled === -1) return;
    const realIdx = PIN_LENGTH - 1 - lastFilled;
    const next = [...digits];
    next[realIdx] = '';
    setDigits(next);
    inputRefs.current[realIdx]?.focus();
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-3xl border border-slate-200 shadow-xl p-6 sm:p-8 space-y-6">
        {/* Üst Başlık & Logo */}
        <div className="flex flex-col items-center text-center space-y-2.5">
          <div className="relative">
            <img
              src="/logo.jpg"
              alt="Paketleme Stok Logo"
              className="w-16 h-16 rounded-2xl object-cover ring-4 ring-slate-100 shadow-md"
            />
            <span className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center shadow">
              <KeyRound className="w-3.5 h-3.5" />
            </span>
          </div>

          <div>
            <h1 className="text-lg font-extrabold text-slate-900 tracking-tight">
              Paketsiz Kılıf Stok Sistemi
            </h1>
            <p className="text-xs font-semibold text-slate-500 mt-0.5">
              Arayüze erişmek için 8 haneli güvenlik PIN kodunu girin
            </p>
          </div>
        </div>

        {/* 8 Haneli PIN Kutuları */}
        <div className="flex items-center justify-center gap-1.5 sm:gap-2">
          {digits.map((digit, idx) => (
            <React.Fragment key={idx}>
              <input
                ref={(el) => {
                  inputRefs.current[idx] = el;
                }}
                type="password"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                disabled={submitting}
                value={digit}
                onChange={(e) => updateDigitAt(idx, e.target.value)}
                onKeyDown={(e) => handleKeyDown(idx, e)}
                onPaste={(e) => {
                  e.preventDefault();
                  const pasted = e.clipboardData.getData('text').replace(/\D/g, '');
                  if (pasted) updateDigitAt(0, pasted);
                }}
                className={`w-9 h-12 sm:w-10 sm:h-14 rounded-xl border-2 text-center text-xl font-black outline-none transition ${
                  digit
                    ? 'border-blue-600 bg-blue-50/40 text-slate-900'
                    : 'border-slate-300 bg-slate-50 focus:border-blue-600 focus:bg-white text-slate-900'
                }`}
                aria-label={`PIN Hanesi ${idx + 1}`}
              />
              {idx === 3 && (
                <span className="text-slate-300 font-black select-none px-0.5">•</span>
              )}
            </React.Fragment>
          ))}
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-3.5 py-2.5 flex items-center gap-2 text-red-700 text-xs font-bold">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Dokunmatik / Hızlı Tuş Takımı */}
        <div className="grid grid-cols-3 gap-2.5">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
            <button
              key={num}
              type="button"
              disabled={submitting}
              onClick={() => handleKeypadDigit(num)}
              className="h-12 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 active:bg-slate-200 text-lg font-extrabold text-slate-800 transition cursor-pointer select-none"
            >
              {num}
            </button>
          ))}

          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              setDigits(Array(PIN_LENGTH).fill(''));
              setError(null);
              inputRefs.current[0]?.focus();
            }}
            className="h-12 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-extrabold text-slate-500 transition cursor-pointer select-none"
          >
            Temizle
          </button>

          <button
            type="button"
            disabled={submitting}
            onClick={() => handleKeypadDigit('0')}
            className="h-12 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 active:bg-slate-200 text-lg font-extrabold text-slate-800 transition cursor-pointer select-none"
          >
            0
          </button>

          <button
            type="button"
            disabled={submitting}
            onClick={handleKeypadBackspace}
            className="h-12 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center text-slate-600 transition cursor-pointer select-none"
            title="Sil"
          >
            <Delete className="w-5 h-5" />
          </button>
        </div>

        {/* Güvenli Tarayıcı Bilgilendirmesi */}
        <div className="rounded-xl bg-emerald-50/70 border border-emerald-200/80 px-3.5 py-2.5 flex items-start gap-2.5">
          {submitting ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5 animate-pulse" />
          ) : (
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          )}
          <p className="text-[11px] font-semibold text-emerald-900 leading-relaxed">
            PIN kodunu doğru girdiğinizde bu tarayıcı <strong>güvenli (Safe)</strong> olarak
            işaretlenir ve sonraki girişlerinizde tekrar PIN sorulmaz.
          </p>
        </div>
      </div>
    </div>
  );
};
