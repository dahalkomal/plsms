import React, { useState, useEffect, useRef } from 'react';
import { History, X, Clock } from 'lucide-react';
import { HistorySuggestionService } from '../utils/HistorySuggestionService';
import { nepaliToEnglishDigits } from '../utils/licenseNormalizer';

interface HistoryAutocompleteFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  historyKey: string;
  theme?: string;
  isTextArea?: boolean;
  rows?: number;
  containerClassName?: string;
  isLicenseNumberMask?: boolean;
  onSuggestionSelected?: (value: string) => void;
}

const formatLicenseNumber = (val: string, isDeleting: boolean = false): string => {
  if (!val) return '';
  // 1. Convert Nepali numerals to ASCII English digits first
  const converted = nepaliToEnglishDigits(val);
  
  // 2. Extract digits
  const digits = converted.replace(/\D/g, '');

  // If input contains non-digits (like 'DL-') or is a shorter Applicant ID (< 10 digits), keep as converted without forcing 2-2-X dashes
  if (/[a-zA-Z]/.test(converted) || (digits.length > 0 && digits.length < 10)) {
    return converted;
  }

  const sliced = digits.slice(0, 12);
  if (isDeleting) {
    if (sliced.length <= 2) return sliced;
    if (sliced.length <= 4) return `${sliced.slice(0, 2)}-${sliced.slice(2)}`;
    return `${sliced.slice(0, 2)}-${sliced.slice(2, 4)}-${sliced.slice(4)}`;
  } else {
    if (sliced.length <= 2) return sliced.length === 2 ? `${sliced}-` : sliced;
    if (sliced.length <= 4) return sliced.length === 4 ? `${sliced.slice(0, 2)}-${sliced.slice(2, 4)}-` : `${sliced.slice(0, 2)}-${sliced.slice(2)}`;
    return `${sliced.slice(0, 2)}-${sliced.slice(2, 4)}-${sliced.slice(4)}`;
  }
};

const calculateCursorPosition = (newVal: string, selStart: number, formattedVal: string): number => {
  let digitsBeforeCursor = 0;
  for (let i = 0; i < selStart; i++) {
    if (/\D/.test(newVal[i]) === false) {
      digitsBeforeCursor++;
    }
  }

  let formattedCursor = 0;
  let digitsSeen = 0;
  while (formattedCursor < formattedVal.length && digitsSeen < digitsBeforeCursor) {
    if (/\D/.test(formattedVal[formattedCursor]) === false) {
      digitsSeen++;
    }
    formattedCursor++;
  }

  if (formattedCursor < formattedVal.length && formattedVal[formattedCursor] === '-') {
    formattedCursor++;
  }

  return formattedCursor;
};

export const HistoryAutocompleteField: React.FC<HistoryAutocompleteFieldProps> = ({
  historyKey,
  theme = 'dark',
  isTextArea = false,
  rows = 3,
  containerClassName = '',
  isLicenseNumberMask = false,
  onSuggestionSelected,
  value,
  onChange,
  onFocus,
  onBlur,
  onKeyDown,
  className = '',
  ...rest
}) => {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [filtered, setFiltered] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDark = theme === 'dark';

  // Load suggestions from local storage history on mount and when key changes
  const loadSuggestions = () => {
    const list = HistorySuggestionService.getSuggestions(historyKey);
    setSuggestions(list);
  };

  useEffect(() => {
    loadSuggestions();

    // Listen to updates from other components saving to the same historyKey
    const handleHistoryUpdate = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && (customEvent.detail.all || customEvent.detail.key === historyKey)) {
        loadSuggestions();
      }
    };

    window.addEventListener('plsms_history_update', handleHistoryUpdate);
    return () => {
      window.removeEventListener('plsms_history_update', handleHistoryUpdate);
    };
  }, [historyKey]);

  // Filter suggestions when input value changes
  useEffect(() => {
    const query = String(value || '').trim();
    if (!query) {
      // If empty, show all previous suggestions
      setFiltered(suggestions);
    } else {
      // Filter case-insensitively
      const filteredList = suggestions.filter(item =>
        item.toLowerCase().includes(query.toLowerCase())
      );
      setFiltered(filteredList);
    }
    setActiveIndex(-1);
  }, [value, suggestions]);

  // Click outside listener
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleFocus = (e: React.FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => {
    setIsOpen(true);
    if (onFocus) {
      onFocus(e);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => {
    // Keep it open temporarily so clicks can register or let click outside handle it
    if (onBlur) {
      onBlur(e);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!isLicenseNumberMask) {
      if (onChange) {
        onChange(e as any);
      }
      return;
    }

    const input = e.target;
    const oldVal = String(value || '');
    const newVal = input.value;
    const selStart = input.selectionStart || 0;

    const isDeleting = newVal.length < oldVal.length;

    let adjustedNewVal = newVal;
    let adjustedSelStart = selStart;
    if (isDeleting && oldVal[selStart] === '-') {
      adjustedNewVal = newVal.slice(0, Math.max(0, selStart - 1)) + newVal.slice(selStart);
      adjustedSelStart = Math.max(0, selStart - 1);
    }

    const formattedVal = formatLicenseNumber(adjustedNewVal, isDeleting);
    const newCursorPos = calculateCursorPosition(adjustedNewVal, adjustedSelStart, formattedVal);

    input.value = formattedVal;
    if (onChange) {
      onChange(e as any);
    }

    requestAnimationFrame(() => {
      input.setSelectionRange(newCursorPos, newCursorPos);
    });
  };

  const handleSelectSuggestion = (selectedVal: string) => {
    const finalVal = isLicenseNumberMask ? formatLicenseNumber(selectedVal) : selectedVal;
    
    // Trigger the fake event to update parent state
    const fakeEvent = {
      target: { value: finalVal }
    } as React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>;

    if (onChange) {
      onChange(fakeEvent);
    }

    if (onSuggestionSelected) {
      onSuggestionSelected(finalVal);
    }

    setIsOpen(false);
    setActiveIndex(-1);
  };

  const handleDeleteSuggestion = (e: React.MouseEvent, itemToDelete: string) => {
    e.preventDefault();
    e.stopPropagation();
    HistorySuggestionService.deleteValue(historyKey, itemToDelete);
    loadSuggestions(); // Reload local list
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement & HTMLTextAreaElement>) => {
    if (onKeyDown) {
      onKeyDown(e);
    }

    if (!isOpen || filtered.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(prev => (prev + 1 >= filtered.length ? 0 : prev + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(prev => (prev - 1 < 0 ? filtered.length - 1 : prev - 1));
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < filtered.length) {
        e.preventDefault();
        handleSelectSuggestion(filtered[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div ref={containerRef} className={`relative w-full ${containerClassName}`}>
      {isTextArea ? (
        <textarea
          rows={rows}
          value={value}
          onChange={handleChange as any}
          onFocus={handleFocus as any}
          onBlur={handleBlur as any}
          onKeyDown={handleKeyDown as any}
          className={`${className} autocomplete-input`}
          autoComplete="off"
          {...(rest as any)}
        />
      ) : (
        <input
          value={value}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className={`${className} autocomplete-input`}
          autoComplete="off"
          {...(rest as any)}
        />
      )}

      {/* Floating Suggestions Dropdown */}
      {isOpen && filtered.length > 0 && (
        <div
          id={`suggestions-dropdown-${historyKey}`}
          className={`absolute left-0 right-0 mt-1.5 rounded-xl border shadow-2xl z-50 max-h-56 overflow-y-auto font-sans text-xs scrollbar-thin divide-y transition-all ${
            isDark
              ? 'bg-slate-900 border-slate-800 text-slate-200 divide-slate-800/50'
              : 'bg-white border-slate-200 text-slate-800 divide-slate-100'
          }`}
          style={{ top: '100%' }}
        >
          {filtered.map((item, index) => (
            <div
              key={`${item}-${index}`}
              className={`flex items-center justify-between px-3.5 py-2.5 transition-all cursor-pointer ${
                index === activeIndex
                  ? isDark ? 'bg-cyan-950/50 text-cyan-400' : 'bg-cyan-50 text-cyan-700'
                  : isDark ? 'hover:bg-slate-850' : 'hover:bg-slate-50'
              }`}
              onClick={() => handleSelectSuggestion(item)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <div className="flex items-center gap-2 truncate pr-4">
                <Clock className={`w-3.5 h-3.5 shrink-0 ${index === activeIndex ? 'text-cyan-500' : 'text-slate-500'}`} />
                <span className="truncate font-medium">{item}</span>
              </div>
              <button
                type="button"
                onClick={(e) => handleDeleteSuggestion(e, item)}
                className={`p-1 rounded-md transition-colors ${
                  isDark ? 'text-slate-500 hover:text-rose-400 hover:bg-slate-800' : 'text-slate-400 hover:text-rose-600 hover:bg-slate-100'
                }`}
                title="Delete from history"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
