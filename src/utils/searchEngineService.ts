/**
 * Targeted PLSMS Two-Field Search Engine Service
 * 
 * Features:
 * 1. Strict Two-Field Classification (License Number or Applicant ID only).
 * 2. In-Memory Session Cache (Map<string, SearchResult>) to avoid repeated Firestore reads.
 * 3. Exact equality queries on indexed fields (where('licenseNumber', '==', ...) or where('applicantId', '==', ...)).
 * 4. Zero full-collection downloads or table scans.
 * 5. Handles duplicate Applicant IDs appropriately without arbitrary selection.
 * 6. Explicit Error Handling distinguishing No Match, Database Error, and Quota Exhausted.
 */

import { db, withFirestoreRetry, isQuotaOrMemoryError } from '../firebase';
import { collection, query, where, limit, getDocs, doc, getDoc } from 'firebase/firestore';
import { License, LicenseStatus } from '../types';
import { classifySearchInput, SearchClassificationResult } from './searchClassifier';
import { isDemoModeActive, checkAndTriggerQuotaError, clearQuotaExceededFlag, fetchStorageItem } from '../dbService';
import { registryDataStore } from '../registryDataStore';
import { isLicenseDistributed } from './licenseNormalizer';

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
const MAX_SEARCH_CACHE_ENTRIES = 100;

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
 * Searches license records strictly using either License Number or Applicant ID.
 * Returns 0 Firestore reads for invalid inputs or cached hits.
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

  // 3. Demo mode / Offline storage fallback
  if (isDemoModeActive()) {
    const storeRecords = registryDataStore.getRecords();
    const storageRecords = fetchStorageItem<License[]>('plsms_mock_licenses', []);
    const dataset = storeRecords.length >= storageRecords.length ? storeRecords : storageRecords;

    let matched: License[] = [];
    if (classification.type === 'LICENSE_NUMBER') {
      matched = dataset.filter(l => {
        const licNum = (l.licenseNumber || '').trim();
        return licNum === classification.normalizedQuery || licNum.replace(/\D/g, '') === classification.normalizedQuery.replace(/\D/g, '');
      });
    } else if (classification.type === 'APPLICANT_ID') {
      matched = dataset.filter(l => {
        const appId = (l.applicantId || '').trim();
        return appId === classification.normalizedQuery;
      });
    }

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
  try {
    const colRef = collection(db, 'licenses');
    let fetchedRecords: License[] = [];

    if (classification.type === 'LICENSE_NUMBER') {
      // Direct exact query on indexed 'licenseNumber' with limit(1)
      const q = query(colRef, where('licenseNumber', '==', classification.normalizedQuery), limit(1));
      const snap = await withFirestoreRetry(() => getDocs(q));

      if (!snap.empty) {
        fetchedRecords = snap.docs.map(d => ({ id: d.id, ...d.data() } as License));
      } else {
        // Fallback: In case the document ID is the normalized license number or pure digits
        const docSnap = await withFirestoreRetry(() => getDoc(doc(db, 'licenses', classification.normalizedQuery)));
        if (docSnap.exists()) {
          fetchedRecords = [{ id: docSnap.id, ...docSnap.data() } as License];
        }
      }
    } else if (classification.type === 'APPLICANT_ID') {
      // Direct exact query on indexed 'applicantId' (up to 10 in case of duplicate Applicant IDs)
      const q = query(colRef, where('applicantId', '==', classification.normalizedQuery), limit(10));
      const snap = await withFirestoreRetry(() => getDocs(q));

      if (!snap.empty) {
        fetchedRecords = snap.docs.map(d => ({ id: d.id, ...d.data() } as License));
      }
    }

    clearQuotaExceededFlag();
    const processed = normalizeDistributedStatuses(fetchedRecords);

    // Save result to in-memory session cache
    setSessionCache(cacheKey, processed);

    const filtered = filterRecordsByStatus(processed, options?.statusFilter);

    return {
      success: true,
      classification,
      records: filtered,
      fromCache: false
    };

  } catch (err: any) {
    checkAndTriggerQuotaError(err);
    const isQuota = isQuotaOrMemoryError(err);
    console.warn("Error in searchLicenseBySmartIdentifier:", err);

    return {
      success: false,
      classification,
      records: [],
      error: err?.message || 'Database error occurred during search.',
      isQuotaError: isQuota
    };
  }
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
