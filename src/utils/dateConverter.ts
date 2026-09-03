// Official Nepali Bikram Sambat (BS) Calendar Converter
// Powered by nepali-date-converter (aligned with Hamro Patro & Nepal Government Calendar)
// Uses Asia/Kathmandu (Nepal Time UTC+05:45) for consistent date calculations

import NepaliDate, { dateConfigMap } from 'nepali-date-converter';

const nepaliMonthNames = [
  'बैशाख', 'जेठ', 'असार', 'साउन', 'भदौ', 'असोज',
  'कात्तिक', 'मङ्सिर', 'पुस', 'माघ', 'फागुन', 'चैत'
];

const nepaliDays = ['आइतबार', 'सोमबार', 'मङ्गलबार', 'बुधबार', 'बिहीबार', 'शुक्रबार', 'शनिबार'];

const nepaliDigits = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];

export function toDevanagariNumeral(input: string | number | undefined): string {
  if (input === undefined || input === null) return '';
  return String(input).replace(/[0-9]/g, digit => nepaliDigits[parseInt(digit, 10)]);
}

/**
 * Extract Year, Month, Day in Asia/Kathmandu timezone (Nepal Standard Time, UTC+05:45)
 */
export function getNepalDateParts(dateOrInput: Date | string | number): { year: number; month: number; day: number } {
  let date: Date;
  if (dateOrInput instanceof Date) {
    date = dateOrInput;
  } else {
    date = new Date(dateOrInput);
  }

  if (isNaN(date.getTime())) {
    date = new Date();
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kathmandu',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    });
    const parts = formatter.formatToParts(date);
    let year = 0, month = 0, day = 0;
    for (const p of parts) {
      if (p.type === 'year') year = parseInt(p.value, 10);
      if (p.type === 'month') month = parseInt(p.value, 10);
      if (p.type === 'day') day = parseInt(p.value, 10);
    }
    if (year && month && day) return { year, month, day };
  } catch {
    // Fallback: manually calculate UTC + 5h45m
  }

  const utcMs = date.getTime() + (date.getTimezoneOffset() * 60000);
  const nepalMs = utcMs + (345 * 60000);
  const nd = new Date(nepalMs);
  return { year: nd.getFullYear(), month: nd.getMonth() + 1, day: nd.getDate() };
}

/**
 * Primary conversion function from Gregorian (AD) to Bikram Sambat (BS)
 * Returns 'YYYY-MM-DD' formatted BS date.
 */
export function convertADToBS(dateOrStr: Date | string | number | undefined): string {
  if (!dateOrStr) {
    const { year, month, day } = getNepalDateParts(new Date());
    const nd = new NepaliDate(new Date(year, month - 1, day));
    return nd.format('YYYY-MM-DD');
  }

  if (typeof dateOrStr === 'string') {
    const trimmed = dateOrStr.trim();
    // Check if string starts with YYYY-MM-DD or YYYY/MM/DD
    const dateMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (dateMatch) {
      const yearNum = parseInt(dateMatch[1], 10);
      const mNum = parseInt(dateMatch[2], 10);
      const dNum = parseInt(dateMatch[3], 10);

      // If it's already a Bikram Sambat year (2070 - 2120), do not double-convert!
      if (yearNum >= 2070 && yearNum <= 2120) {
        return `${yearNum}-${String(mNum).padStart(2, '0')}-${String(dNum).padStart(2, '0')}`;
      }

      // If it's a Gregorian year without time (1970 - 2069), convert purely on that calendar day
      if (yearNum >= 1970 && yearNum <= 2069 && !trimmed.includes('T')) {
        try {
          const nd = new NepaliDate(new Date(yearNum, mNum - 1, dNum));
          return nd.format('YYYY-MM-DD');
        } catch {
          // Fall through
        }
      }
    }
  }

  // For Date objects, timestamps, ISO strings, or anything else:
  // Convert based on Nepal Standard Time (Asia/Kathmandu)
  try {
    const { year, month, day } = getNepalDateParts(dateOrStr);
    const nd = new NepaliDate(new Date(year, month - 1, day));
    return nd.format('YYYY-MM-DD');
  } catch {
    const now = new Date();
    const { year, month, day } = getNepalDateParts(now);
    const nd = new NepaliDate(new Date(year, month - 1, day));
    return nd.format('YYYY-MM-DD');
  }
}

/**
 * Format string with BS date and Nepal local time (YYYY-MM-DD HH:mm)
 */
export function formatWithBS(dateOrStr: Date | string | undefined): string {
  if (!dateOrStr) return '---';
  let date: Date;
  if (typeof dateOrStr === 'string') {
    date = new Date(dateOrStr);
  } else {
    date = dateOrStr;
  }
  if (isNaN(date.getTime())) return '---';

  const bsDate = convertADToBS(date);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kathmandu',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const timeStr = formatter.format(date);

  return `${bsDate} ${timeStr}`;
}

/**
 * Returns number of days in a given BS month using Hamro Patro verified calendar data
 */
export function getBSMonthDays(year: number, month: number): number {
  const monthKeys = [
    'Baisakh', 'Jestha', 'Asar', 'Shrawan', 'Bhadra', 'Aswin',
    'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'
  ];
  const monthKey = monthKeys[month - 1];
  const yearData = (dateConfigMap as any)[String(year)];
  if (yearData && yearData[monthKey]) {
    return yearData[monthKey];
  }
  return 30;
}

/**
 * Returns weekday index of a BS date (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 */
export function getBSDateWeekday(bsYear: number, bsMonth: number, bsDay: number): number {
  try {
    const nd = new NepaliDate(bsYear, bsMonth - 1, bsDay);
    return nd.getDay();
  } catch {
    return 0;
  }
}

/**
 * Converts Bikram Sambat date string 'YYYY-MM-DD' back to Gregorian Date
 */
export function convertBSToAD(bsDateStr: string): Date | null {
  try {
    const match = bsDateStr.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (!match) return null;
    const y = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const d = parseInt(match[3], 10);
    const nd = new NepaliDate(y, m - 1, d);
    return nd.toJsDate();
  } catch {
    return null;
  }
}

/**
 * Get fully formatted Nepali Date & Time string for banners and display
 */
export function getFormattedNepaliDateTime(dateInput?: Date | string | number) {
  let date: Date;
  if (!dateInput) {
    date = new Date();
  } else if (dateInput instanceof Date) {
    date = dateInput;
  } else {
    date = new Date(dateInput);
  }
  if (isNaN(date.getTime())) date = new Date();

  // Get weekday and time in Asia/Kathmandu
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kathmandu',
    weekday: 'short'
  });
  const weekdayStr = weekdayFormatter.format(date);
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6
  };
  const weekdayIdx = weekdayMap[weekdayStr] ?? date.getDay();
  const dayName = nepaliDays[weekdayIdx];

  const bsDateStr = convertADToBS(date);
  const [yearStr, monthStr, dayStr] = bsDateStr.split('-');
  const monthVal = parseInt(monthStr, 10) || 1;
  const dayVal = parseInt(dayStr, 10) || 1;

  const monthName = nepaliMonthNames[monthVal - 1] || 'बैशाख';
  const formattedDate = `${dayName} ${toDevanagariNumeral(dayVal)} ${monthName} ${toDevanagariNumeral(yearStr)}`;

  // Format Time in Asia/Kathmandu
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kathmandu',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const timeParts = timeFormatter.formatToParts(date);
  let hours = 0, minutes = '00', seconds = '00';
  for (const p of timeParts) {
    if (p.type === 'hour') hours = parseInt(p.value, 10);
    if (p.type === 'minute') minutes = p.value;
    if (p.type === 'second') seconds = p.value;
  }

  let ampm = 'बिहान';
  if (hours >= 12) {
    if (hours < 16) ampm = 'दिउँसो';
    else if (hours < 20) ampm = 'साँझ';
    else ampm = 'राती';
  } else {
    if (hours < 4 || hours >= 20) ampm = 'राती';
  }

  const displayHours = hours % 12 || 12;
  const formattedTime = `${toDevanagariNumeral(String(displayHours).padStart(2, '0'))}:${toDevanagariNumeral(minutes)}:${toDevanagariNumeral(seconds)} ${ampm}`;

  return {
    dateStr: formattedDate,
    timeStr: formattedTime,
    bsDate: bsDateStr
  };
}

