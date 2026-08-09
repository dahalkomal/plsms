/**
 * Universal Normalizer and Flexible Matcher for Driving Licenses and Applicant IDs.
 */

/**
 * Converts Nepali Devanagari numerals (०-९) to ASCII English digits (0-9).
 */
export function nepaliToEnglishDigits(str: string | number | undefined | null): string {
  if (str === null || str === undefined) return '';
  const val = String(str);
  const nepaliDigits = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
  let result = val;
  for (let i = 0; i < 10; i++) {
    result = result.replaceAll(nepaliDigits[i], String(i));
  }
  return result;
}

/**
 * Strips non-alphanumeric characters after converting Devanagari numerals.
 */
export function cleanAlphanumeric(str: string | number | undefined | null): string {
  if (!str) return '';
  const eng = nepaliToEnglishDigits(str);
  return eng.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Extracts pure ASCII digits after converting Devanagari numerals.
 */
export function extractDigits(str: string | number | undefined | null): string {
  if (!str) return '';
  const eng = nepaliToEnglishDigits(str);
  return eng.replace(/\D/g, '');
}

/**
 * Flexible license matching algorithm.
 * Evaluates whether a search query matches a given license record across multiple criteria.
 */
export function isLicenseMatch(
  query: string | number | undefined | null,
  lic: { id?: string; licenseNumber?: string; applicantId?: string; fullName?: string } | null | undefined
): boolean {
  if (!query || !lic) return false;

  const rawQ = nepaliToEnglishDigits(query).trim().toUpperCase();
  if (!rawQ) return false;

  const qClean = cleanAlphanumeric(rawQ);
  const qDigits = extractDigits(rawQ);

  const targetId = String(lic.id || '').trim().toUpperCase();
  const targetLicNo = String(lic.licenseNumber || '').trim().toUpperCase();
  const targetAppId = String(lic.applicantId || '').trim().toUpperCase();

  // 1. Direct raw equality (case-insensitive)
  if (rawQ === targetId || rawQ === targetLicNo || rawQ === targetAppId) {
    return true;
  }

  const targetIdClean = cleanAlphanumeric(targetId);
  const targetLicNoClean = cleanAlphanumeric(targetLicNo);
  const targetAppIdClean = cleanAlphanumeric(targetAppId);

  // 2. Clean alphanumeric equality (ignoring hyphens, spaces, slashes, etc.)
  if (qClean) {
    if (qClean === targetIdClean || qClean === targetLicNoClean || qClean === targetAppIdClean) {
      return true;
    }
  }

  const targetIdDigits = extractDigits(targetId);
  const targetLicNoDigits = extractDigits(targetLicNo);
  const targetAppIdDigits = extractDigits(targetAppId);

  // 3. Pure digits equality
  if (qDigits) {
    if (qDigits === targetIdDigits || qDigits === targetLicNoDigits || qDigits === targetAppIdDigits) {
      return true;
    }
  }

  // 4. Flexible digit segment matching (ignoring zero padding differences or suffix matching)
  const qNoZeros = qDigits.replace(/^0+/, '');
  const checkDigitMatch = (targetDigits: string) => {
    if (!targetDigits || !qDigits) return false;
    if (targetDigits === qDigits) return true;
    if (targetDigits.includes(qDigits) || qDigits.includes(targetDigits)) return true;

    const targetNoZeros = targetDigits.replace(/^0+/, '');
    if (qNoZeros && targetNoZeros) {
      if (
        targetNoZeros === qNoZeros ||
        targetNoZeros.endsWith(qNoZeros) ||
        qNoZeros.endsWith(targetNoZeros)
      ) {
        return true;
      }
    }
    return false;
  };

  if (qDigits.length >= 4) {
    if (checkDigitMatch(targetLicNoDigits)) return true;
    if (checkDigitMatch(targetAppIdDigits)) return true;
    if (checkDigitMatch(targetIdDigits)) return true;
  }

  // 5. Clean alphanumeric substring inclusion
  if (qClean.length >= 4) {
    if (targetLicNoClean.includes(qClean) || qClean.includes(targetLicNoClean)) return true;
    if (targetAppIdClean.includes(qClean) || qClean.includes(targetAppIdClean)) return true;
    if (targetIdClean.includes(qClean) || qClean.includes(targetIdClean)) return true;
  }

  // 6. Full Name matching fallback
  const targetName = String(lic.fullName || '').trim().toUpperCase();
  if (targetName && rawQ.length >= 3) {
    if (targetName === rawQ || targetName.includes(rawQ) || rawQ.includes(targetName)) {
      return true;
    }
  }

  return false;
}
