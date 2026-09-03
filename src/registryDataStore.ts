import { License, LicenseStatus } from './types';
import { isLicenseMatch, cleanAlphanumeric } from './utils/licenseNormalizer';

export interface GoogleSheetRow {
  [key: string]: any;
}

export interface RegistryStoreMetadata {
  lastUpdated: string | null;
  sourceUrl: string | null;
  recordCount: number;
  syncStatus: 'idle' | 'syncing' | 'error' | 'success';
  errorMessage: string | null;
}

export type RegistrySubscriber = (records: License[], metadata: RegistryStoreMetadata) => void;

/**
 * Centralized Registry Data Store (Single Source of Truth)
 * Holds all driving license registry records loaded from Google Sheets and other sources.
 * Designed to become the single source of registry data across the entire application.
 */
export class RegistryDataStore {
  private recordsMap: Map<string, License> = new Map();
  private recordsList: License[] = [];
  private metadata: RegistryStoreMetadata = {
    lastUpdated: null,
    sourceUrl: null,
    recordCount: 0,
    syncStatus: 'idle',
    errorMessage: null,
  };
  private subscribers: Set<RegistrySubscriber> = new Set();
  private readonly STORAGE_KEY = 'plsms_central_registry_store';
  private readonly METADATA_KEY = 'plsms_central_registry_metadata';

  constructor() {
    this.loadFromStorage();
  }

  /**
   * Returns all current registry records as an immutable-style array.
   */
  public getRecords(): License[] {
    return this.recordsList;
  }

  /**
   * Fast O(1) lookup of a registry record by ID, license number, or applicant ID.
   */
  public getRecordById(id: string): License | undefined {
    if (!id) return undefined;
    const cleanId = cleanAlphanumeric(id);
    
    // Check direct map ID
    if (this.recordsMap.has(cleanId)) {
      return this.recordsMap.get(cleanId);
    }

    // Fallback flexible scan
    return this.recordsList.find((rec) => isLicenseMatch(id, rec));
  }

  /**
   * Search and filter registry records using a custom predicate.
   */
  public findRecords(predicate: (record: License) => boolean): License[] {
    return this.recordsList.filter(predicate);
  }

  /**
   * Returns metadata about the store state (last updated time, count, sync status).
   */
  public getMetadata(): RegistryStoreMetadata {
    return { ...this.metadata };
  }

  /**
   * Set or replace the entire registry dataset (e.g. loaded directly from Google Sheets).
   * Acts as the primary write operation for establishing the Single Source of Truth.
   */
  public setRecords(records: License[], sourceUrl?: string, forceReplace: boolean = false): void {
    if (forceReplace || records.length === 0) {
      this.recordsMap.clear();
    }

    for (const record of records) {
      if (!record) continue;
      const key = (record.id || record.licenseNumber || record.applicantId || Math.random().toString()).trim().toUpperCase();
      if (!this.recordsMap.has(key)) {
        this.recordsMap.set(key, record);
      } else {
        // Update existing with newer record properties
        const merged = { ...this.recordsMap.get(key)!, ...record };
        this.recordsMap.set(key, merged);
      }
    }

    this.recordsList = Array.from(this.recordsMap.values());
    this.metadata = {
      lastUpdated: new Date().toISOString(),
      sourceUrl: sourceUrl || this.metadata.sourceUrl || 'Google Sheets Registry',
      recordCount: this.recordsList.length,
      syncStatus: 'success',
      errorMessage: null,
    };

    this.persistToStorage();
    this.notifySubscribers();
  }

  /**
   * Add a new record or overwrite an existing record in the registry store.
   */
  public addRecord(record: License): void {
    const key = (record.id || record.licenseNumber || record.applicantId).trim().toUpperCase();
    this.recordsMap.set(key, record);
    this.rebuildListAndNotify();
  }

  /**
   * Add multiple records to the registry store.
   */
  public addRecords(records: License[]): void {
    if (!Array.isArray(records) || records.length === 0) return;
    for (const record of records) {
      if (!record) continue;
      const key = (record.id || record.licenseNumber || record.applicantId).trim().toUpperCase();
      this.recordsMap.set(key, record);
    }
    this.rebuildListAndNotify();
  }

  /**
   * Update specific fields of an existing record in the registry store.
   */
  public updateRecord(id: string, updates: Partial<License>): boolean {
    const existing = this.getRecordById(id);
    if (!existing) return false;

    const key = existing.id.trim().toUpperCase();
    const updatedRecord: License = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.recordsMap.set(key, updatedRecord);
    this.rebuildListAndNotify();
    return true;
  }

  /**
   * Delete a record from the registry store by ID.
   */
  public deleteRecord(id: string): boolean {
    const existing = this.getRecordById(id);
    if (!existing) return false;

    const key = existing.id.trim().toUpperCase();
    const deleted = this.recordsMap.delete(key);
    if (deleted) {
      this.rebuildListAndNotify();
    }
    return deleted;
  }

  /**
   * Purge all records from the registry store.
   */
  public clearRegistry(): void {
    this.recordsMap.clear();
    this.recordsList = [];
    this.metadata = {
      lastUpdated: new Date().toISOString(),
      sourceUrl: null,
      recordCount: 0,
      syncStatus: 'idle',
      errorMessage: null,
    };
    this.persistToStorage();
    this.notifySubscribers();
  }

  /**
   * Parse raw row objects loaded from Google Sheets into standardized License records
   * and ingest them into the Registry Data Store.
   */
  public loadFromGoogleSheetRows(
    rows: GoogleSheetRow[],
    sourceInfo: string = 'Google Sheets Ingestion'
  ): { loadedCount: number; duplicateCount: number } {
    this.metadata.syncStatus = 'syncing';
    this.notifySubscribers();

    const normalizedRecords: License[] = [];
    const seenKeys = new Set<string>();
    let duplicateCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;

      const applicantId = String(
        row['APPLICANT ID'] || row['Applicant ID'] || row['applicantId'] || row['ID'] || `GS-${i + 1}`
      ).trim();

      const fullName = String(
        row['FULL NAME'] || row['Full Name'] || row['fullName'] || row['NAME'] || row['Name'] || 'Unknown Applicant'
      ).trim();

      const licenseNumber = String(
        row['LICENSE NO'] || row['LICENSE NO.'] || row['License Number'] || row['licenseNumber'] || row['DL No'] || applicantId
      ).trim();

      const category = String(
        row['CATEGORY'] || row['Category'] || row['category'] || 'A'
      ).trim();

      const mobileNumber = String(
        row['MOBILE'] || row['MOBILE NO'] || row['Mobile Number'] || row['mobileNumber'] || row['Phone'] || ''
      ).trim();

      const rawStatus = String(
        row['STATUS'] || row['Status'] || row['status'] || 'available'
      ).trim().toLowerCase();

      let status: LicenseStatus = 'available';
      if (rawStatus.includes('distrib')) status = 'distributed';
      else if (rawStatus.includes('miss')) status = 'missing';
      else if (rawStatus.includes('found')) status = 'found';

      const rawDept = String(
        row['DEPARTMENT'] ||
        row['Department'] ||
        row['department'] ||
        row['DEPARTMANT'] ||
        row['Departmant'] ||
        row['departmant'] ||
        row['ONTACT SECTION'] ||
        row['Ontact Section'] ||
        row['ontact section'] ||
        row['CONTACT SECTION'] ||
        row['Contact Section'] ||
        row['contact section'] ||
        row['DISTRIBUTION DATE'] ||
        row['Distribution Date'] ||
        row['distribution date'] ||
        row['DISTRIBUTION DAY'] ||
        row['Distribution Day'] ||
        row['distribution day'] ||
        row['DISTRIBUTED DATE'] ||
        row['Distributed Date'] ||
        row['distributed date'] ||
        row['DIST DATE'] ||
        row['DIST DAY'] ||
        row['VISITING DATE'] ||
        row['VISITING DAY'] ||
        row['SECTION'] ||
        row['Section'] ||
        row['DEPT'] ||
        row['Dept'] ||
        ''
      ).trim();

      const uniqueKey = (licenseNumber || applicantId).toUpperCase();
      if (seenKeys.has(uniqueKey)) {
        duplicateCount++;
      } else {
        seenKeys.add(uniqueKey);
      }

      const now = new Date().toISOString();
      const licenseObj: License = {
        id: uniqueKey,
        applicantId,
        fullName,
        licenseNumber,
        category,
        department: rawDept || undefined,
        status,
        mobileNumber,
        createdAt: now,
        updatedAt: now,
        updatedBy: 'Google Sheets Registry Loader',
        remarks: String(row['REMARKS'] || row['Remarks'] || row['remarks'] || '').trim() || undefined,
        sn: Number(row['SN'] || row['S.N.'] || i + 1) || i + 1,
      };

      normalizedRecords.push(licenseObj);
    }

    this.setRecords(normalizedRecords, sourceInfo);
    return { loadedCount: normalizedRecords.length, duplicateCount };
  }

  /**
   * Subscribe to state updates in the centralized registry store.
   * Returns a cleanup callback function to unsubscribe.
   */
  public subscribe(callback: RegistrySubscriber): () => void {
    this.subscribers.add(callback);
    // Immediately emit current state to new subscriber
    try {
      callback(this.recordsList, this.metadata);
    } catch (err) {
      console.error('Error invoking registry subscriber immediately:', err);
    }

    return () => {
      this.subscribers.delete(callback);
    };
  }

  private rebuildListAndNotify(): void {
    this.recordsList = Array.from(this.recordsMap.values());
    this.metadata.lastUpdated = new Date().toISOString();
    this.metadata.recordCount = this.recordsList.length;
    this.persistToStorage();
    this.notifySubscribers();
  }

  public notifySubscribers(): void {
    for (const callback of this.subscribers) {
      try {
        callback(this.recordsList, this.metadata);
      } catch (err) {
        console.error('Error notifying registry store subscriber:', err);
      }
    }
  }

  private persistToStorage(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      localStorage.setItem(this.METADATA_KEY, JSON.stringify(this.metadata));
    } catch (err) {
      console.warn('Could not persist centralized registry store to local storage:', err);
    }
  }

  private loadFromStorage(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const storedMeta = localStorage.getItem(this.METADATA_KEY);

      if (storedMeta) {
        const parsedMeta: RegistryStoreMetadata = JSON.parse(storedMeta);
        this.metadata = {
          ...this.metadata,
          ...parsedMeta,
          recordCount: 0,
        };
      }
    } catch (err) {
      console.warn('Failed initializing central registry store from local storage:', err);
    }
  }
}

// Export single centralized instance as Single Source of Truth
export const registryDataStore = new RegistryDataStore();
