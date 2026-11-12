import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface AutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  required?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export const AutocompleteInput: React.FC<AutocompleteInputProps> = ({
  value,
  onChange,
  options,
  placeholder,
  required,
  inputRef,
}) => {
  const [open, setOpen] = useState(false);
  const [showAllOnToggle, setShowAllOnToggle] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const internalInputRef = useRef<HTMLInputElement>(null);

  const resolvedRef = inputRef || internalInputRef;

  const filteredOptions = useMemo(() => {
    if (!options.length) return [];
    const term = value.trim().toUpperCase();
    if (!term || showAllOnToggle) {
      return options.slice(0, 30);
    }
    return options
      .filter((opt) => opt.toUpperCase().includes(term) && opt.toUpperCase() !== term)
      .slice(0, 30);
  }, [options, value, showAllOnToggle]);

  // Kullanıcı yazarken eşleşen öneri varsa ilk öneriyi otomatik seçili (highlighted) yap
  const activeIndex = useMemo(() => {
    if (!open || filteredOptions.length === 0) return -1;
    if (highlightIndex >= 0 && highlightIndex < filteredOptions.length) {
      return highlightIndex;
    }
    if (value.trim().length > 0 && !showAllOnToggle) {
      return 0;
    }
    return -1;
  }, [open, filteredOptions, highlightIndex, value, showAllOnToggle]);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowAllOnToggle(false);
        setHighlightIndex(-1);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  const selectOption = (opt: string) => {
    onChange(opt.toUpperCase());
    setOpen(false);
    setShowAllOnToggle(false);
    setHighlightIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || filteredOptions.length === 0) {
      if (e.key === 'ArrowDown' && options.length > 0) {
        e.preventDefault();
        setShowAllOnToggle(true);
        setOpen(true);
        setHighlightIndex(0);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const base = activeIndex < 0 ? -1 : activeIndex;
      setHighlightIndex((base + 1) % filteredOptions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const base = activeIndex <= 0 ? filteredOptions.length : activeIndex;
      setHighlightIndex(base - 1);
    } else if (e.key === 'Tab' && !e.shiftKey) {
      // Tab tuşu: Vurgulu veya ilk eşleşen öneriyi anında tamamla ve bir sonraki alana doğal geçiş yap
      const pickIdx = activeIndex >= 0 ? activeIndex : value.trim().length > 0 ? 0 : -1;
      if (pickIdx >= 0 && pickIdx < filteredOptions.length) {
        selectOption(filteredOptions[pickIdx]);
        // preventDefault çağrılmaz; böylece hem öneri seçilir hem imleç direkt Miktar alanına geçer
      } else {
        setOpen(false);
        setShowAllOnToggle(false);
        setHighlightIndex(-1);
      }
    } else if (e.key === 'Tab' && e.shiftKey) {
      setOpen(false);
      setShowAllOnToggle(false);
      setHighlightIndex(-1);
    } else if (e.key === 'Enter' && activeIndex >= 0 && activeIndex < filteredOptions.length) {
      e.preventDefault();
      selectOption(filteredOptions[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setShowAllOnToggle(false);
      setHighlightIndex(-1);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          ref={resolvedRef}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onFocus={() => {
            if (options.length > 0 && value.trim().length > 0) {
              setOpen(true);
            }
          }}
          onChange={(e) => {
            const nextVal = e.target.value.toUpperCase();
            onChange(nextVal);
            setShowAllOnToggle(false);
            setOpen(true);
            setHighlightIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          required={required}
          className="w-full rounded-xl border-2 border-slate-300 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 pl-4 pr-10 py-3.5 text-xl font-extrabold uppercase tracking-wide text-slate-900 outline-none transition"
        />

        {options.length > 0 && (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => {
              e.preventDefault();
              if (open) {
                setOpen(false);
                setShowAllOnToggle(false);
                setHighlightIndex(-1);
              } else {
                setShowAllOnToggle(true);
                setOpen(true);
                setHighlightIndex(0);
                resolvedRef.current?.focus();
              }
            }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
            title="Kayıtlı seçenekleri göster"
          >
            <ChevronDown
              className={`w-4 h-4 transition-transform duration-150 ${open ? 'rotate-180 text-blue-600' : ''}`}
            />
          </button>
        )}
      </div>

      {open && filteredOptions.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-50 bg-white rounded-xl border-2 border-slate-200 shadow-2xl max-h-56 overflow-y-auto py-1">
          {filteredOptions.map((opt, idx) => {
            const isHighlighted = idx === activeIndex;
            return (
              <button
                key={opt}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectOption(opt);
                }}
                onMouseEnter={() => setHighlightIndex(idx)}
                className={`w-full text-left px-4 py-2.5 text-sm font-extrabold font-mono-code tracking-wide transition cursor-pointer flex items-center justify-between ${
                  isHighlighted
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-800 hover:bg-slate-50'
                }`}
              >
                <span>{opt}</span>
                {isHighlighted ? (
                  <span className="text-[11px] font-sans font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-700">
                    Tab ↹ ile seç
                  </span>
                ) : opt === value.trim().toUpperCase() ? (
                  <span className="text-[11px] font-semibold text-blue-600">Seçili</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
