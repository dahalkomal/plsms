import React, { useState, useEffect } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { convertADToBS } from '../utils/dateConverter';

interface NepaliDatePickerProps {
  value: { year: number; month: number; day: number } | string | null | undefined;
  onChange: (val: any) => void;
  label: string;
  isDark: boolean;
  placeholder?: string;
}

const nepaliYears = [2077, 2078, 2079, 2080, 2081, 2082, 2083, 2084, 2085, 2086, 2087];

const nepaliMonths = [
  { value: 1, label: "वैशाख", en: "Baishakh" },
  { value: 2, label: "जेठ", en: "Jestha" },
  { value: 3, label: "असार", en: "Ashadh" },
  { value: 4, label: "साउन", en: "Shrawan" },
  { value: 5, label: "भदौ", en: "Bhadra" },
  { value: 6, label: "असोज", en: "Ashwin" },
  { value: 7, label: "कात्तिक", en: "Kartik" },
  { value: 8, label: "मंसिर", en: "Mangsir" },
  { value: 9, label: "पुस", en: "Poush" },
  { value: 10, label: "माघ", en: "Magh" },
  { value: 11, label: "फागुन", en: "Falgun" },
  { value: 12, label: "चैत", en: "Chaitra" }
];

const nepaliMonthNames = [
  "", "वैशाख", "जेठ", "असार", "साउन", "भदौ", "असोज", "कात्तिक", "मंसिर", "पुस", "माघ", "फागुन", "चैत"
];

const toNepaliDigits = (num: number | string): string => {
  const nepaliDigits = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
  return String(num).split('').map(char => {
    const digit = parseInt(char, 10);
    return isNaN(digit) ? char : nepaliDigits[digit];
  }).join('');
};

const getBSMonthDays = (year: number, month: number): number => {
  const yearConfigs: Record<number, number[]> = {
    2077: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2078: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2079: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2080: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2081: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2082: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2083: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2084: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2085: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2086: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2087: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30]
  };
  return yearConfigs[year]?.[month - 1] || 30;
};

// Calculate the weekday of day 1 of any BS month (0 = Sun, 1 = Mon, ..., 6 = Sat)
const getBSDateWeekday = (bsYear: number, bsMonth: number, bsDay: number): number => {
  const yearConfigs: Record<number, { adYear: number; m: number; d: number; lengths: number[] }> = {
    2077: { adYear: 2020, m: 3, d: 13, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
    2078: { adYear: 2021, m: 3, d: 14, lengths: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
    2079: { adYear: 2022, m: 3, d: 14, lengths: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
    2080: { adYear: 2023, m: 3, d: 14, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
    2081: { adYear: 2024, m: 3, d: 13, lengths: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
    2082: { adYear: 2025, m: 3, d: 14, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
    2083: { adYear: 2026, m: 3, d: 14, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
    2084: { adYear: 2027, m: 3, d: 14, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
    2085: { adYear: 2028, m: 3, d: 13, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
    2086: { adYear: 2029, m: 3, d: 14, lengths: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
    2087: { adYear: 2030, m: 3, d: 14, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] }
  };

  const config = yearConfigs[bsYear];
  if (!config) return 0;

  let daysOffset = 0;
  for (let i = 0; i < bsMonth - 1; i++) {
    daysOffset += config.lengths[i];
  }
  daysOffset += (bsDay - 1);

  const startOfBS = new Date(config.adYear, config.m, config.d);
  const targetDate = new Date(startOfBS.getTime() + daysOffset * 24 * 60 * 60 * 1000);
  return targetDate.getDay();
};

export default function NepaliDatePicker({ value, onChange, label, isDark, placeholder }: NepaliDatePickerProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Compute Today's BS date for highlighting and initial month/year views
  const todayBSStr = convertADToBS(new Date());
  const todayParts = todayBSStr.split('-');
  const todayYear = parseInt(todayParts[0], 10) || 2083;
  const todayMonth = parseInt(todayParts[1], 10) || 1;
  const todayDay = parseInt(todayParts[2], 10) || 1;

  // Extract selected values if any
  let selYear = 0;
  let selMonth = 0;
  let selDay = 0;
  let hasValue = false;
  let formattedDate = '';

  if (value) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        hasValue = true;
        formattedDate = trimmed;
        const parts = trimmed.split('-');
        if (parts.length === 3) {
          selYear = parseInt(parts[0], 10) || 0;
          selMonth = parseInt(parts[1], 10) || 0;
          selDay = parseInt(parts[2], 10) || 0;
        }
      }
    } else if (typeof value === 'object') {
      if (value.year > 0 && value.month > 0 && value.day > 0) {
        hasValue = true;
        selYear = value.year;
        selMonth = value.month;
        selDay = value.day;
        formattedDate = `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
      }
    }
  }

  // Keep track of active viewing year/month separate from selected value
  const [viewYear, setViewYear] = useState(selYear || todayYear);
  const [viewMonth, setViewMonth] = useState(selMonth || todayMonth);

  // Sync view year/month when selected value changes externally
  useEffect(() => {
    if (hasValue) {
      if (selYear > 0) setViewYear(selYear);
      if (selMonth > 0) setViewMonth(selMonth);
    } else {
      setViewYear(todayYear);
      setViewMonth(todayMonth);
    }
  }, [value, hasValue, selYear, selMonth, todayYear, todayMonth]);

  const handlePrevMonth = () => {
    if (viewMonth === 1) {
      if (viewYear > nepaliYears[0]) {
        setViewYear(viewYear - 1);
        setViewMonth(12);
      }
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const handleNextMonth = () => {
    if (viewMonth === 12) {
      if (viewYear < nepaliYears[nepaliYears.length - 1]) {
        setViewYear(viewYear + 1);
        setViewMonth(1);
      }
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const selectDay = (day: number) => {
    const valObj = { year: viewYear, month: viewMonth, day };
    const formatted = `${viewYear}-${String(viewMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (typeof value === 'string' || value === null || value === undefined) {
      onChange(formatted);
    } else {
      onChange(valObj);
    }
    setIsOpen(false);
  };

  const totalDays = getBSMonthDays(viewYear, viewMonth);
  const firstDayWeekday = getBSDateWeekday(viewYear, viewMonth, 1);

  // Pad array to display grid correctly
  const blankCells = Array.from({ length: firstDayWeekday }, (_, i) => i);
  const dayCells = Array.from({ length: totalDays }, (_, i) => i + 1);

  const weekdaysNp = ['आइत', 'सोम', 'मङ्गल', 'बुध', 'बिही', 'शुक्र', 'शनि'];

  return (
    <div className="relative inline-block">
      <label className={`text-[11px] font-extrabold uppercase tracking-wider flex items-center gap-1.5 ${
        isDark ? 'text-slate-300' : 'text-slate-700'
      }`}>
        <Calendar className="w-3.5 h-3.5 text-blue-500" />
        {label}
      </label>

      {/* Compact date selector box */}
      <div 
        onClick={() => setIsOpen(!isOpen)}
        className={`w-44 text-xs p-2.5 rounded-xl border outline-none cursor-pointer flex justify-between items-center transition-all mt-1 select-none ${
          isDark 
            ? 'bg-slate-900 border-slate-800 hover:border-slate-700 text-slate-200' 
            : 'bg-white border-slate-300 hover:border-slate-400 text-slate-800 shadow-2xs'
        }`}
      >
        {hasValue ? (
          <span className="font-mono tracking-wider font-extrabold text-xs">
            {formattedDate}
          </span>
        ) : (
          <span className="font-mono tracking-wider font-medium text-xs text-slate-400 dark:text-slate-500">
            {placeholder || "Date Picker"}
          </span>
        )}
        <Calendar className="w-4 h-4 text-slate-400" />
      </div>

      {/* Backdrop overlay to close picker on outside clicks */}
      {isOpen && (
        <>
          <div 
            className="fixed inset-0 z-40 bg-transparent" 
            onClick={() => setIsOpen(false)} 
          />
          <div 
            className="absolute left-0 mt-2 p-4 rounded-3xl border border-slate-800/80 bg-[#111e2e] text-white shadow-2xl z-50 w-72 animate-in fade-in duration-100"
          >
            {/* Header: Navigation */}
            <div className="flex items-center justify-between gap-2 mb-4">
              <button
                type="button"
                onClick={handlePrevMonth}
                className="w-8 h-8 rounded-lg bg-[#1a2c3e] hover:bg-[#23384e] text-white flex items-center justify-center cursor-pointer transition-colors"
              >
                <ChevronLeft className="w-4 h-4 text-white" />
              </button>

              <div className="flex gap-2 flex-1 justify-center">
                {/* Month Selection Pill */}
                <div className="relative bg-white text-slate-950 font-black text-xs px-4 py-1.5 rounded-lg border border-transparent shadow-xs text-center min-w-[80px] select-none hover:bg-slate-100 transition-colors cursor-pointer">
                  <span>{nepaliMonthNames[viewMonth]}</span>
                  <select
                    value={viewMonth}
                    onChange={(e) => setViewMonth(parseInt(e.target.value, 10))}
                    className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                  >
                    {nepaliMonths.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>

                {/* Year Selection Pill */}
                <div className="relative bg-white text-slate-950 font-black text-xs px-4 py-1.5 rounded-lg border border-transparent shadow-xs text-center min-w-[70px] select-none hover:bg-slate-100 transition-colors cursor-pointer">
                  <span>{viewYear}</span>
                  <select
                    value={viewYear}
                    onChange={(e) => setViewYear(parseInt(e.target.value, 10))}
                    className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                  >
                    {nepaliYears.map(y => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                </div>
              </div>

              <button
                type="button"
                onClick={handleNextMonth}
                className="w-8 h-8 rounded-lg bg-[#1a2c3e] hover:bg-[#23384e] text-white flex items-center justify-center cursor-pointer transition-colors"
              >
                <ChevronRight className="w-4 h-4 text-white" />
              </button>
            </div>

            {/* Weekdays Grid */}
            <div className="grid grid-cols-7 gap-1 text-center mb-2">
              {weekdaysNp.map(wd => (
                <div 
                  key={wd} 
                  className="text-[10px] font-black text-sky-300 py-1"
                >
                  {wd}
                </div>
              ))}
            </div>

            {/* Days Grid */}
            <div className="grid grid-cols-7 gap-1 text-center">
              {blankCells.map(cell => (
                <div key={`blank-${cell}`} className="aspect-square" />
              ))}

              {dayCells.map(day => {
                const isSelected = hasValue && selYear === viewYear && selMonth === viewMonth && selDay === day;
                const isToday = viewYear === todayYear && viewMonth === todayMonth && day === todayDay;

                let btnStyle = 'text-slate-200 hover:bg-[#1a2c3e] hover:text-white';
                if (isToday && isSelected) {
                  btnStyle = 'bg-emerald-600 text-white font-black shadow-md ring-2 ring-blue-400';
                } else if (isToday) {
                  btnStyle = 'bg-emerald-600 text-white font-black shadow-md ring-2 ring-emerald-400';
                } else if (isSelected) {
                  btnStyle = 'border border-blue-500 bg-[#1e2f47] text-blue-400 font-extrabold shadow-sm shadow-blue-500/30';
                }

                return (
                  <button
                    key={`day-${day}`}
                    type="button"
                    onClick={() => selectDay(day)}
                    className={`aspect-square text-[12px] font-bold rounded-xl flex items-center justify-center cursor-pointer transition-all duration-100 ${btnStyle}`}
                    title={isToday ? "आजको मिति (Today)" : undefined}
                  >
                    {toNepaliDigits(day)}
                  </button>
                );
              })}
            </div>

            {/* Bottom Actions for Today and Clear */}
            <div className="border-t border-[#1d2f44] mt-3.5 pt-3 flex justify-between items-center">
              <button 
                type="button"
                onClick={() => {
                  const valObj = { year: todayYear, month: todayMonth, day: todayDay };
                  const formatted = `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`;
                  if (typeof value === 'string' || value === null || value === undefined) {
                    onChange(formatted);
                  } else {
                    onChange(valObj);
                  }
                  setViewYear(todayYear);
                  setViewMonth(todayMonth);
                  setIsOpen(false);
                }}
                className="text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer text-xs font-black hover:underline flex items-center gap-1"
              >
                <span>आज (Today)</span>
              </button>
              <button 
                type="button"
                onClick={() => {
                  if (typeof value === 'string' || value === null || value === undefined) {
                    onChange('');
                  } else {
                    onChange({ year: 0, month: 0, day: 0 });
                  }
                  setIsOpen(false);
                }}
                className="text-sky-400 hover:text-sky-300 transition-colors cursor-pointer text-xs font-black hover:underline"
              >
                रद्द (Reset)
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
