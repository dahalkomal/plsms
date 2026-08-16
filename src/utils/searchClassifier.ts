/**
 * Targeted PLSMS Two-Field Search Engine Classifier & Normalizer
 * 
 * Rules:
 * 1. Normalizes Devanagari digits (०-९ -> 0-9)
 * 2. Trims whitespace and removes formatting punctuation
 * 3. Classifies input strictly into:
 *    - LICENSE_NUMBER (exactly 12 digits -> canonical XX-XX-XXXXXXXX)
 *    - APPLICANT_ID (pure numeric digits, not 12-digit license)
 *    - INVALID (malformed license format or invalid text -> 0 Firestore reads)
 */

import { nepaliToEnglishDigits } from './licenseNormalizer';

export type SearchClassificationType = 'LICENSE_NUMBER' | 'APPLICANT_ID' | 'INVALID';

export interface SearchClassificationResult {
  type: SearchClassificationType;
  normalizedQuery: string;
  displayNormalized: string;
  errorMessage?: string;
  errorMessageNp?: string;
  isMalformedLicense?: boolean;
}

/**
 * Classifies raw user input locally BEFORE any Firestore query is dispatched.
 */
export function classifySearchInput(rawInput: string | null | undefined): SearchClassificationResult {
  if (!rawInput || !rawInput.trim()) {
    return {
      type: 'INVALID',
      normalizedQuery: '',
      displayNormalized: '',
      errorMessage: 'Please enter a valid License Number or Applicant ID.',
      errorMessageNp: 'कृपया सही लाइसेन्स नम्बर वा आवेदक आइडी (Applicant ID) प्रविष्ट गर्नुहोस्।'
    };
  }

  // 1. Convert Nepali digits to ASCII
  const eng = nepaliToEnglishDigits(rawInput).trim();

  // Check if input contains any license-like formatting separators (hyphen, slash, space)
  const hasLicenseSeparators = /[-/\s]/.test(eng);

  // Extract all pure digits
  const pureDigits = eng.replace(/\D/g, '');

  // Strip common separators to check for non-numeric characters
  const strippedWithoutSeparators = eng.replace(/[-/\s._]/g, '');
  const hasLettersOrSymbols = /[^\d]/.test(strippedWithoutSeparators);

  // If input contains invalid letters or punctuation that cannot be digits/license separators
  if (hasLettersOrSymbols) {
    return {
      type: 'INVALID',
      normalizedQuery: '',
      displayNormalized: '',
      errorMessage: 'Please enter a valid License Number or Applicant ID.',
      errorMessageNp: 'कृपया सही लाइसेन्स नम्बर वा आवेदक आइडी (Applicant ID) प्रविष्ट गर्नुहोस्।'
    };
  }

  // 2. CHECK FOR LICENSE NUMBER (Exactly 12 numeric digits)
  // Structure: XX-XX-XXXXXXXX (2 digits + 2 digits + 8 digits = 12 total digits)
  if (pureDigits.length === 12) {
    const canonicalLicense = `${pureDigits.slice(0, 2)}-${pureDigits.slice(2, 4)}-${pureDigits.slice(4)}`;
    return {
      type: 'LICENSE_NUMBER',
      normalizedQuery: canonicalLicense,
      displayNormalized: canonicalLicense
    };
  }

  // 3. CHECK FOR MALFORMED LICENSE-LIKE INPUT
  // If user used license separators (e.g. "01-02-123", "01-02-123456789") but digit count is NOT 12
  if (hasLicenseSeparators) {
    return {
      type: 'INVALID',
      normalizedQuery: '',
      displayNormalized: '',
      isMalformedLicense: true,
      errorMessage: 'Invalid License Number format. Please use XX-XX-XXXXXXXX.',
      errorMessageNp: 'अमान्य लाइसेन्स नम्बर ढाँचा। कृपया XX-XX-XXXXXXXX ढाँचा प्रयोग गर्नुहोस्।'
    };
  }

  // 4. CHECK FOR APPLICANT ID (Pure numeric digits, 1 to 11 digits or >12 digits)
  if (/^\d+$/.test(eng)) {
    return {
      type: 'APPLICANT_ID',
      normalizedQuery: eng,
      displayNormalized: eng
    };
  }

  // 5. Default Invalid fallback
  return {
    type: 'INVALID',
    normalizedQuery: '',
    displayNormalized: '',
    errorMessage: 'Please enter a valid License Number or Applicant ID.',
    errorMessageNp: 'कृपया सही लाइसेन्स नम्बर वा आवेदक आइडी (Applicant ID) प्रविष्ट गर्नुहोस्।'
  };
}
