/**
 * Targeted PLSMS Two-Field Search Engine Service
 * 
 * Features:
 * 1. Strict Two-Field Classification (License Number or Applicant ID only).
 * 2. In-Memory Session Cache (Map<string, SearchResult>) to avoid repeated Firestore reads.
 * 3. Exact equality queries on indexed fields (where('licenseNumber', '==', ...) or where('applicantId', '==', ...)).
 * 4. Zero full-collection downloads or table scans.
 * 5. Automatic seamless fallback to local stores on Firestore quota limit/exhaustion without showing quota blocks.
 * 6. Handles duplicate Applicant IDs appropriately without arbitrary selection.
 */

import { db, withFirestoreRetry, isQuotaOrMemoryError } from '../firebase';
import { collection, query, where, limit, getDocs, doc, getDoc } from 'firebase/firestore';
import { License, LicenseStatus } from '../types';
import { classifySearchInput, SearchClassificationResult } from './searchClassifier';
import { isDemoModeActive, checkAndTriggerQuotaError, clearQuotaExceededFlag, fetchStorageItem } from '../dbService';
import { registryDataStore } from '../registryDataStore';
import { isLicenseDistributed, cleanAlphanumeric, extractDigits, isLicenseMatch } from './licenseNormalizer';

export interface SmartSearchResult {
  success: boolean;
  classification: SearchClassificationResult;
  records: License[];
  fromCache?: boolean;
  error?: string;
  isQuotaError?: boolean;
}

// Targeted in-memory search cache for the session (Key: "license:01-02-00458795" or "applicant:1842")
const sessionSearchCache = new Map<string, License[]>();
const MAX_SEARCH_CACHE_ENTRIES = 200;

function setSessionCache(key: string, records: License[]): void {
  if (sessionSearchCache.size >= MAX_SEARCH_CACHE_ENTRIES) {
    const oldestKey = sessionSearchCache.keys().next().value;
    if (oldestKey) {
      sessionSearchCache.delete(oldestKey);
    }
  }
  sessionSearchCache.set(key, records);
}

/**
 * Searches local in-memory and local storage datasets for matching licenses.
 */
function searchLocalStores(classification: SearchClassificationResult): License[] {
  const storeRecords = registryDataStore.getRecords();
  const storageRecords = fetchStorageItem<License[]>('plsms_mock_licenses', []);
  const backupRecords = fetchStorageItem<License[]>('plsms_live_licenses_backup', []);
  const cacheRecords = fetchStorageItem<License[]>('plsms_licenses_cache', []);

  // Merge all unique records by ID
  const map = new Map<string, License>();
  for (const list of [storeRecords, storageRecords, backupRecords, cacheRecords]) {
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && item.id) {
          map.set(item.id, item);
        }
      }
    }
  }

  const allLocal = Array.from(map.values());
  const normQuery = classification.normalizedQuery;
  const queryDigits = extractDigits(normQuery);

  if (classification.type === 'LICENSE_NUMBER') {
    return allLocal.filter(l => {
      const licNum = (l.licenseNumber || '').trim();
      if (!licNum) return false;
      if (licNum === normQuery) return true;
      if (cleanAlphanumeric(licNum) === cleanAlphanumeric(normQuery)) return true;
      if (queryDigits && queryDigits.length >= 7 && extractDigits(licNum) === queryDigits) return true;
      return isLicenseMatch(normQuery, l);
    });
  }

  if (classification.type === 'APPLICANT_ID') {
    return allLocal.filter(l => {
      const appId = (l.applicantId || '').trim();
      if (!appId) return false;
      if (appId === normQuery) return true;
      if (queryDigits && extractDigits(appId) === queryDigits) return true;
      return false;
    });
  }

  return [];
}

/**
 * Searches license records strictly using either License Number or Applicant ID.
 * Returns 0 Firestore reads for invalid inputs or cached hits.
 * Seamlessly falls back to local data on Quota exhaustion without displaying quota error dialogs.
 */
export async function searchLicenseBySmartIdentifier(
  rawInput: string,
  options?: { statusFilter?: LicenseStatus | 'not_distributed' | 'all' }
): Promise<SmartSearchResult> {
  const classification = classifySearchInput(rawInput);

  // 1. Return immediately on invalid input -> ZERO Firestore reads
  if (classification.type === 'INVALID') {
    return {
      success: false,
      classification,
      records: [],
      error: classification.errorMessage || 'Please enter a valid License Number or Applicant ID.'
    };
  }

  const cacheKey = `${classification.type.toLowerCase()}:${classification.normalizedQuery}`;

  // 2. Check in-memory session cache
  if (sessionSearchCache.has(cacheKey)) {
    const cachedRecords = sessionSearchCache.get(cacheKey) || [];
    const filtered = filterRecordsByStatus(cachedRecords, options?.statusFilter);
    return {
      success: true,
      classification,
      records: filtered,
      fromCache: true
    };
  }

  // 3. Demo mode / Offline storage check
  if (isDemoModeActive()) {
    const matched = searchLocalStores(classification);
    const processed = normalizeDistributedStatuses(matched);
    setSessionCache(cacheKey, processed);
    const filtered = filterRecordsByStatus(processed, options?.statusFilter);

    return {
      success: true,
      classification,
      records: filtered,
      fromCache: false
    };
  }

  // 4. Firestore Query Execution (Exact Indexed Equality Queries)
  let fetchedRecords: License[] = [];
  let querySucceeded = false;

  try {
    const colRef = collection(db, 'licenses');

    if (classification.type === 'LICENSE_NUMBER') {
      // Direct exact query on indexed 'licenseNumber' with limit(1)
      const q = query(colRef, where('licenseNumber', '==', classification.normalizedQuery), limit(1));
      const snap = await withFirestoreRetry(() => getDocs(q), 2, 200);

      if (!snap.empty) {
        fetchedRecords = snap.docs.map(d => ({ id: d.id, ...d.data() } as License));
        querySucceeded = true;
      } else {
        // Fallback: In case the document ID is the normalized license number or pure digits
        try {
          const docSnap = await withFirestoreRetry(() => getDoc(doc(db, 'licenses', classification.normalizedQuery)), 1, 100);
          if (docSnap.exists()) {
            fetchedRecords = [{ id: docSnap.id, ...docSnap.data() } as License];
            querySucceeded = true;
          }
        } catch {
          // Silent catch on doc ID lookup
        }
      }
    } else if (classification.type === 'APPLICANT_ID') {
      // Direct exact query on indexed 'applicantId' (up to 10 in case of duplicate Applicant IDs)
      const q = query(colRef, where('applicantId', '==', classification.normalizedQuery), limit(10));
      const snap = await withFirestoreRetry(() => getDocs(q), 2, 200);

      if (!snap.empty) {
        fetchedRecords = snap.docs.map(d => ({ id: d.id, ...d.data() } as License));
        querySucceeded = true;
      }
    }
  } catch (err: any) {
    // Firestore quota exceeded or connection error -> Silently skip without failing the search
    checkAndTriggerQuotaError(err);
    console.warn("Notice: Firestore search skipped due to quota or connection limits, checking local stores.");
  }

  // If Firestore returned 0 records or failed due to quota, search local datasets
  if (fetchedRecords.length === 0) {
    const localMatches = searchLocalStores(classification);
    if (localMatches.length > 0) {
      fetchedRecords = localMatches;
    }
  }

  // Normalize status and update stores
  const processed = normalizeDistributedStatuses(fetchedRecords);
  if (processed.length > 0) {
    registryDataStore.addRecords(processed);
  }

  // Save result to in-memory session cache
  setSessionCache(cacheKey, processed);

  const filtered = filterRecordsByStatus(processed, options?.statusFilter);

  return {
    success: true,
    classification,
    records: filtered,
    fromCache: !querySucceeded
  };
}

/**
 * Normalizes status property for distributed records.
 */
function normalizeDistributedStatuses(records: License[]): License[] {
  return records.map(r => {
    if (isLicenseDistributed(r) && r.status !== 'missing' && r.status !== 'found') {
      return {
        ...r,
        status: 'distributed' as const,
        distributed: true as any,
        distributionStatus: 'Distributed' as any
      };
    }
    return r;
  });
}

/**
 * Filters matched records by status register context without performing extra network requests.
 */
function filterRecordsByStatus(records: License[], statusFilter?: LicenseStatus | 'not_distributed' | 'all'): License[] {
  if (!statusFilter || statusFilter === 'all') return records;

  return records.filter(l => {
    if (statusFilter === 'distributed') {
      return (l.status === 'distributed' || isLicenseDistributed(l)) && l.status !== 'missing' && l.status !== 'found';
    }
    if (statusFilter === 'not_distributed') {
      return !isLicenseDistributed(l) && l.status !== 'missing' && l.status !== 'found';
    }
    if (statusFilter === 'missing') {
      return l.status === 'missing';
    }
    if (statusFilter === 'found') {
      return l.status === 'found';
    }
    return l.status === statusFilter;
  });
}

/**
 * Clears the session search cache (e.g. after fresh uploads or bulk changes).
 */
export function clearSearchCache(): void {
  sessionSearchCache.clear();
}
