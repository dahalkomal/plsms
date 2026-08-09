// Helper to convert Gregorian date to Bikram Sambat (BS) format YYYY-MM-DD
// Uses Asia/Kathmandu (Nepal Time) for precise date calculation

const yearConfigs: Record<number, { bsYear: number; bsStart: { m: number; d: number }; lengths: number[] }> = {
  2020: { bsYear: 2077, bsStart: { m: 3, d: 13 }, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
  2021: { bsYear: 2078, bsStart: { m: 3, d: 14 }, lengths: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
  2022: { bsYear: 2079, bsStart: { m: 3, d: 14 }, lengths: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
  2023: { bsYear: 2080, bsStart: { m: 3, d: 14 }, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
  2024: { bsYear: 2081, bsStart: { m: 3, d: 13 }, lengths: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
  2025: { bsYear: 2082, bsStart: { m: 3, d: 14 }, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
  2026: { bsYear: 2083, bsStart: { m: 3, d: 14 }, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
  2027: { bsYear: 2084, bsStart: { m: 3, d: 14 }, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
  2028: { bsYear: 2085, bsStart: { m: 3, d: 13 }, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
  2029: { bsYear: 2086, bsStart: { m: 3, d: 14 }, lengths: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30] },
  2030: { bsYear: 2087, bsStart: { m: 3, d: 14 }, lengths: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30] }
};

function getNepalDateParts(dateOrInput: Date | string | number): { year: number; month: number; day: number } {
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
    // fallback
  }

  const utcMs = date.getTime() + (date.getTimezoneOffset() * 60000);
  const nepalMs = utcMs + (345 * 60000);
  const nd = new Date(nepalMs);
  return { year: nd.getFullYear(), month: nd.getMonth() + 1, day: nd.getDate() };
}

function convertADPartsToBS(year: number, month: number, day: number): string {
  const config = yearConfigs[year];
  if (config) {
    const startOfBS = Date.UTC(year, config.bsStart.m, config.bsStart.d);
    const targetUTC = Date.UTC(year, month - 1, day);
    const diffDays = Math.round((targetUTC - startOfBS) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      const prevConfig = yearConfigs[year - 1];
      if (prevConfig) {
        const startOfChaitra = Date.UTC(year, config.bsStart.m - 1, config.bsStart.d);
        const chaitraDays = Math.round((targetUTC - startOfChaitra) / (1000 * 60 * 60 * 24)) + 1;
        const cappedDay = Math.max(1, Math.min(30, chaitraDays));
        return `${prevConfig.bsYear}-12-${String(cappedDay).padStart(2, '0')}`;
      }
      return `${year + 56}-12-15`;
    }

    let remainingDays = diffDays;
    let bsMonth = 1;
    for (let i = 0; i < config.lengths.length; i++) {
      if (remainingDays < config.lengths[i]) {
        return `${config.bsYear}-${String(bsMonth).padStart(2, '0')}-${String(remainingDays + 1).padStart(2, '0')}`;
      }
      remainingDays -= config.lengths[i];
      bsMonth++;
    }
    return `${config.bsYear}-12-30`;
  }

  const offsetYear = year + 57;
  const isEarly = (month < 4) || (month === 4 && day < 14);
  const bsCalculatedYear = isEarly ? year + 56 : offsetYear;
  return `${bsCalculatedYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function convertADToBS(dateOrStr: Date | string | number | undefined): string {
  if (!dateOrStr) {
    const { year, month, day } = getNepalDateParts(new Date());
    return convertADPartsToBS(year, month, day);
  }

  if (typeof dateOrStr === 'string') {
    const trimmed = dateOrStr.trim();
    // 1. Check if string is strictly YYYY-MM-DD or YYYY/MM/DD without time
    const strictDateMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (strictDateMatch) {
      const yearNum = parseInt(strictDateMatch[1], 10);
      const mNum = parseInt(strictDateMatch[2], 10);
      const dNum = parseInt(strictDateMatch[3], 10);
      if (yearNum >= 2070 && yearNum <= 2100) {
        return `${yearNum}-${String(mNum).padStart(2, '0')}-${String(dNum).padStart(2, '0')}`;
      }
      if (yearNum >= 1900 && yearNum <= 2069) {
        return convertADPartsToBS(yearNum, mNum, dNum);
      }
    }

    // If it's a BS string with extra characters (like time) but starts with BS year >= 2070
    const bsPrefixMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (bsPrefixMatch) {
      const yearNum = parseInt(bsPrefixMatch[1], 10);
      const mNum = parseInt(bsPrefixMatch[2], 10);
      const dNum = parseInt(bsPrefixMatch[3], 10);
      if (yearNum >= 2070 && yearNum <= 2100) {
        return `${yearNum}-${String(mNum).padStart(2, '0')}-${String(dNum).padStart(2, '0')}`;
      }
    }
  }

  // Otherwise, derive year/month/day in Asia/Kathmandu (Nepal Time)
  const { year, month, day } = getNepalDateParts(dateOrStr);
  return convertADPartsToBS(year, month, day);
}

// Format fully formatted string with BS date
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

