import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import { levelKey } from '../levelUtils';

interface AutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  required?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  matchMode?: 'contains' | 'level';
  onBlurNormalize?: (value: string) => string;
  size?: 'large' | 'compact';
  openOnFocus?: boolean;
  uppercase?: boolean;
  maxVisibleOptions?: number;
  dropdownTitle?: string;
}

export const AutocompleteInput: React.FC<AutocompleteInputProps> = ({
  value,
  onChange,
  options,
  placeholder,
  required,
  inputRef,
  matchMode = 'contains',
  onBlurNormalize,
  size = 'large',
  openOnFocus = false,
  uppercase = true,
  maxVisibleOptions = 30,
  dropdownTitle,
}) => {
  const [open, setOpen] = useState(false);
  const [showAllOnToggle, setShowAllOnToggle] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const internalInputRef = useRef<HTMLInputElement>(null);

  const resolvedRef = inputRef || internalInputRef;

  const isExactOptionAlreadyTyped = useMemo(() => {
    const trimmed = value.trim().toLocaleUpperCase('tr-TR');
    if (!trimmed) return false;
    return options.some((opt) => opt.trim().toLocaleUpperCase('tr-TR') === trimmed);
  }, [options, value]);

  const filteredOptions = useMemo(() => {
    if (!options.length) return [];
    const term = value.trim();
    const termUpper = term.toLocaleUpperCase('tr-TR');

    if (!term || showAllOnToggle) {
      return options.slice(0, maxVisibleOptions);
    }

    if (matchMode === 'level') {
      const termKey = levelKey(termUpper);
      if (!termKey) return options.slice(0, maxVisibleOptions);

      const matches = options.filter((opt) => {
        const optUpper = opt.toUpperCase();
        const optK = levelKey(optUpper);
        if (!optK.startsWith(termKey)) return false;
        if (optUpper === termUpper) return false;
        return true;
      });

      matches.sort((a, b) => {
        const aExactKey = levelKey(a) === termKey ? 0 : 1;
        const bExactKey = levelKey(b) === termKey ? 0 : 1;
        if (aExactKey !== bExactKey) return aExactKey - bExactKey;
        return a.localeCompare(b, 'tr');
      });

      return matches.slice(0, maxVisibleOptions);
    }

    // Referans ve hızlı erişim aramalarında önce önekle (startsWith) başlayanları en üste sırala
    const matches = options.filter((opt) => {
      const optUpper = opt.toLocaleUpperCase('tr-TR');
      return optUpper.includes(termUpper) && optUpper !== termUpper;
    });

    matches.sort((a, b) => {
      const aStarts = a.toLocaleUpperCase('tr-TR').startsWith(termUpper) ? 0 : 1;
      const bStarts = b.toLocaleUpperCase('tr-TR').startsWith(termUpper) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return 0; // Frekans sırasını koru
    });

    return matches.slice(0, maxVisibleOptions);
  }, [options, value, showAllOnToggle, matchMode, maxVisibleOptions]);

  const activeIndex = useMemo(() => {
    if (!open || filteredOptions.length === 0) return -1;
    if (highlightIndex >= 0 && highlightIndex < filteredOptions.length) {
      return highlightIndex;
    }
    if (value.trim().length > 0 && !showAllOnToggle && !isExactOptionAlreadyTyped) {
      return 0;
    }
    return -1;
  }, [open, filteredOptions, highlightIndex, value, showAllOnToggle, isExactOptionAlreadyTyped]);

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
    onChange(uppercase ? opt.toUpperCase() : opt);
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
      } else if (e.key === 'Tab' && !e.shiftKey && onBlurNormalize && value.trim()) {
        const normalized = onBlurNormalize(value);
        if (normalized && normalized !== value) {
          onChange(normalized);
        }
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
      const pickIdx = activeIndex;
      if (pickIdx >= 0 && pickIdx < filteredOptions.length) {
        selectOption(filteredOptions[pickIdx]);
      } else {
        if (onBlurNormalize && value.trim()) {
          const normalized = onBlurNormalize(value);
          if (normalized && normalized !== value) {
            onChange(normalized);
          }
        }
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

  const inputClassName =
    size === 'compact'
      ? `w-full rounded-xl border border-slate-300 focus:border-blue-600 focus:ring-2 focus:ring-blue-100 pl-3.5 pr-9 py-2.5 text-sm font-semibold text-slate-800 outline-none transition ${
          uppercase ? 'uppercase' : ''
        }`
      : `w-full rounded-xl border-2 border-slate-300 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 pl-4 pr-10 py-3.5 text-xl font-extrabold tracking-wide text-slate-900 outline-none transition ${
          uppercase ? 'uppercase' : ''
        }`;

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
            if (options.length > 0 && (openOnFocus || value.trim().length > 0)) {
              if (openOnFocus && !value.trim()) {
                setShowAllOnToggle(true);
              }
              setOpen(true);
            }
          }}
          onClick={() => {
            if (openOnFocus && options.length > 0 && !open) {
              if (!value.trim()) {
                setShowAllOnToggle(true);
              }
              setOpen(true);
            }
          }}
          onBlur={() => {
            if (onBlurNormalize && value.trim()) {
              const normalized = onBlurNormalize(value);
              if (normalized && normalized !== value) {
                onChange(normalized);
              }
            }
          }}
          onChange={(e) => {
            const nextVal = uppercase ? e.target.value.toUpperCase() : e.target.value;
            onChange(nextVal);
            setShowAllOnToggle(false);
            setOpen(true);
            setHighlightIndex(-1);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          required={required}
          className={inputClassName}
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
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
            title="Sık kullanılan seçenekleri göster"
          >
            <ChevronDown
              className={`w-4 h-4 transition-transform duration-150 ${
                open ? 'rotate-180 text-blue-600' : ''
              }`}
            />
          </button>
        )}
      </div>

      {open && filteredOptions.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-50 bg-white rounded-xl border-2 border-slate-200 shadow-2xl max-h-60 overflow-y-auto py-1">
          {dropdownTitle && (
            <div className="px-3.5 py-1.5 text-[11px] font-extrabold uppercase tracking-wider text-slate-400 border-b border-slate-100 flex items-center gap-1.5 select-none">
              <Sparkles className="w-3 h-3 text-blue-500" />
              <span>{dropdownTitle}</span>
            </div>
          )}

          {filteredOptions.map((opt, idx) => {
            const isHighlighted = idx === activeIndex;
            const isSelected =
              opt.trim().toLocaleUpperCase('tr-TR') === value.trim().toLocaleUpperCase('tr-TR') &&
              value.trim().length > 0;

            return (
              <button
                key={opt}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectOption(opt);
                }}
                onMouseEnter={() => setHighlightIndex(idx)}
                className={`w-full text-left px-3.5 py-2.5 text-sm font-extrabold transition cursor-pointer flex items-center justify-between gap-2 ${
                  size === 'compact' ? '' : 'font-mono-code tracking-wide'
                } ${
                  isHighlighted
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-800 hover:bg-slate-50'
                }`}
              >
                <span className="truncate">{opt}</span>
                {isHighlighted ? (
                  <span className="text-[11px] font-sans font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-700 shrink-0">
                    Tab ↹ / Tıkla
                  </span>
                ) : isSelected ? (
                  <span className="text-[11px] font-semibold text-blue-600 shrink-0">Seçili</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
