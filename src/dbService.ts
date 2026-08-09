import { db, auth, storage, handleFirestoreError, OperationType, isQuotaOrMemoryError, withFirestoreRetry } from './firebase';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { isLicenseMatch, nepaliToEnglishDigits, cleanAlphanumeric } from './utils/licenseNormalizer';
import { convertADToBS } from './utils/dateConverter';
import { registryDataStore } from './registryDataStore';
import { 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  addDoc, 
  deleteDoc, 
  onSnapshot,
  collection, 
  query, 
  orderBy, 
  where, 
  limit, 
  increment,
  getCountFromServer,
  documentId,
  startAfter,
  QueryDocumentSnapshot,
  QueryConstraint
} from 'firebase/firestore';
import { 
  License, 
  LicenseStatus,
  CollectionRequest, 
  Notice, 
  UserRole, 
  OfficeSettings,
  UploadLedger,
  UploadHistoryRecord,
  BatchCommitDetail
} from './types';

export interface BatchWriteResult {
  totalRecords: number;
  successfulBatchCount: number;
  failedBatchCount: number;
  verificationStatus: 'VERIFIED' | 'PARTIAL SUCCESS' | 'FAILED';
  verificationTime: string;
  verificationDurationMs: number;
  batchDetails: BatchCommitDetail[];
  failedBatchDetails: BatchCommitDetail[];
}

export interface VerificationMetrics {
  totalExcelRows?: number;
  validRows?: number;
  skippedRows?: number;
  duplicateRows?: number;
  expectedWrites?: number;
  successfulBatchCount?: number;
  failedBatchCount?: number;
  verificationStatus?: 'VERIFIED' | 'PARTIAL SUCCESS' | 'FAILED';
  verificationTime?: string;
  verificationDurationMs?: number;
  batchDetails?: BatchCommitDetail[];
  failedBatchDetails?: BatchCommitDetail[];
  missingRecordsCount?: number;
}

// Safe event dispatcher function that handles all browser environments without Illegal constructor errors
export function safeDispatchEvent(eventName: string): void {
  if (typeof window === 'undefined' || !window.dispatchEvent) return;
  try {
    if (typeof document !== 'undefined' && document.createEvent) {
      const evt = document.createEvent('Event');
      evt.initEvent(eventName, true, true);
      window.dispatchEvent(evt);
      return;
    }
  } catch (e) {
    // Ignore error
  }
}

// Clear temporary Quota Exceeded error flag when Firestore connection is healthy
export function clearQuotaExceededFlag(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('plsms_quota_exceeded');
    localStorage.removeItem('plsms_demo_active');
    safeDispatchEvent('plsms_demo_mode_changed');
  }
}

// Check if Offline Demo Mode is active (Strictly disabled - Firestore is the single source of truth)
export function isDemoModeActive(): boolean {
  return false;
}

// Toggle Offline Demo Mode
export function setDemoModeActive(active: boolean) {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('plsms_demo_active');
    localStorage.removeItem('plsms_quota_exceeded');
  }
  safeDispatchEvent('plsms_demo_mode_changed');
}

// Global helper to check for Quota/Resource Exhausted errors
export function checkAndTriggerQuotaError(err: unknown): void {
  if (isQuotaOrMemoryError(err)) {
    console.warn("Firestore Quota/Resource notice:", err);
  }
}

// Initial mock data seeds
const initialMockSettings: OfficeSettings = {
  officeName: "Transport Management Office, Driving License",
  officeAddress: "Itahari, Sunsari, Nepal",
  officeLogo: "https://upload.wikimedia.org/wikipedia/commons/a/bc/Emblem_of_Nepal.svg",
  contactNumber: "+977-25-5000000",
  emailAddress: "tmoitahari@gmail.com",
  websiteFooter: "© 2026 Transport Management Office, Driving License, Itahari, Sunsari. Authorized Use Only. All operations are logged and monitored for security compliance.",
  homepageBanner: "Welcome to Transport Management Office Driving License Records Center",
  searchMenuLabel: "Search",
  requestMenuLabel: "Schedule Pickup",
  contactMenuLabel: "Contact Desk",
  noticesMenuLabel: "NOTICES",
  consoleSecurityPin: "1234"
};

const initialMockLicenses: License[] = [];

const initialMockNotices: Notice[] = [
  {
    id: "notice_default_release",
    title: "System Release Notice: Desk Handover Timings",
    content: "Welcome to TMO Itahari Smart Driving License search/dispatch platform. Users can track and schedule pick ups of finished custom cards from Dispatch Desk 2 between 10:00 AM and 4:00 PM on respective business days.",
    active: true,
    createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    createdBy: "tmoitahari@gmail.com"
  },
  {
    id: "notice_biometric_verification",
    title: "Urgent: Biometric Verification Schedule & Guidelines",
    content: "All applicants who have successfully completed their online driving license applications for Category A (Motorcycle) and Category B (Car) are requested to visit TMO Itahari for biometric verification. Please bring your original citizenship certificate, online payment receipt, and medical report. Biometrics are conducted Sunday to Thursday from 10:30 AM to 3:00 PM.",
    active: true,
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    createdBy: "tmoitahari@gmail.com"
  },
  {
    id: "notice_license_dispatch",
    title: "Smart Driving License Card Dispatch: Print Batches up to 2025",
    content: "We are pleased to announce that smart driving license cards printed up to September 2025 have arrived at TMO Itahari. Applicants can search their license number on this portal to check if their card is ready for collection. If the status shows 'Available', please schedule your pick-up using the pickup manager.",
    active: true,
    createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    createdBy: "tmoitahari@gmail.com"
  },
  {
    id: "notice_online_payment",
    title: "Online Revenue Payment and Annual License Renewal Tax Desk",
    content: "TMO Itahari has successfully integrated digital payment gateways (eSewa, Khalti, and ConnectIPS) for driving license revenue. Applicants can pay their exam fees and smart card fees directly through the online system. For annual renewal and tax clearance, Desk 4 is now fully dedicated to digital slip verification.",
    active: true,
    createdAt: new Date().toISOString(),
    createdBy: "tmoitahari@gmail.com"
  }
];

const initialMockRequests: CollectionRequest[] = [];

// Helper to seed localStorage if empty
const inMemoryStorageMap = new Map<string, any>();

function fetchStorageItem<T>(key: string, initial: T): T {
  if (inMemoryStorageMap.has(key)) {
    return inMemoryStorageMap.get(key) as T;
  }
  try {
    const data = localStorage.getItem(key);
    if (data) {
      try {
        const parsed = JSON.parse(data);
        inMemoryStorageMap.set(key, parsed);
        return parsed;
      } catch {
        inMemoryStorageMap.set(key, initial);
        return initial;
      }
    }
    writeStorageItem(key, initial);
    return initial;
  } catch (err) {
    console.warn(`[Storage Warning] Error reading key '${key}':`, err);
    return initial;
  }
}

export function writeStorageItem<T>(key: string, data: T) {
  inMemoryStorageMap.set(key, data);
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (err: any) {
    console.warn(`[Storage Warning] localStorage setItem failed for key '${key}' (retained in memory):`, err?.message || err);
  }
}

// ==================== OFFICE SETTINGS SERVICES ====================

export function sanitizeOfficeSettings(settings: OfficeSettings): OfficeSettings {
  const defaultSettings = { ...initialMockSettings };
  if (!settings) return defaultSettings;
  
  const logo = settings.officeLogo;
  const name = settings.officeName;
  
  const updatedSettings = {
    ...settings,
    searchMenuLabel: settings.searchMenuLabel || "Search",
    noticesMenuLabel: settings.noticesMenuLabel || "NOTICES"
  };
  
  // Enforce professional name
  if (!name || name.trim() === "" || name.toLowerCase().includes("my app") || name.toLowerCase().includes("untitled") || name.toLowerCase().includes("license record") || name.includes("TMO ITAHARI") || name.includes("(TMO")) {
    updatedSettings.officeName = "Transport Management Office, Driving License";
  }
  
  // Enforce professional logo (always fallback to Nepal Emblem if empty or generic placeholder)
  if (
    !logo ||
    logo.trim() === "" ||
    logo.includes("placeholder")
  ) {
    updatedSettings.officeLogo = "https://upload.wikimedia.org/wikipedia/commons/a/bc/Emblem_of_Nepal.svg";
  }
  
  // Enforce other essential fields if they are missing or blank
  if (!updatedSettings.officeAddress || updatedSettings.officeAddress.trim() === "" || updatedSettings.officeAddress.includes("Koshi Province")) {
    updatedSettings.officeAddress = "Itahari, Sunsari, Nepal";
  }
  if (!updatedSettings.homepageBanner || updatedSettings.homepageBanner.trim() === "" || updatedSettings.homepageBanner.includes("TMO Itahari")) {
    updatedSettings.homepageBanner = "Welcome to PRINTED LICENSE SEARCH MANAGEMENT SYSTEM";
  }
  if (!updatedSettings.websiteFooter || updatedSettings.websiteFooter.trim() === "" || updatedSettings.websiteFooter.includes("Transport Management Office, Driving license")) {
    updatedSettings.websiteFooter = "© 2026 Transport Management Office, Driving License, Itahari, Sunsari. Authorized Use Only. All operations are logged and monitored for security compliance.";
  }
  
  return updatedSettings;
}

// ==================== SESSION CACHE & QUERY DEDUPLICATION ====================

let cachedOfficeSettings: OfficeSettings | null = null;
let officeSettingsPromise: Promise<OfficeSettings> | null = null;

let userRolesCache: UserRole[] | null = null;
let userRolesPromise: Promise<UserRole[]> | null = null;

let cachedSearchesServed: number | null = null;
let searchesServedPromise: Promise<number> | null = null;

let cachedSecurityPinConfig: SecurityPinConfig | null = null;
let securityPinConfigPromise: Promise<SecurityPinConfig> | null = null;

let cachedDashboardKpiCounts: DashboardKpiCounts | null = null;
let dashboardKpiPromise: Promise<DashboardKpiCounts> | null = null;

export function invalidateDashboardKpiCache() {
  cachedDashboardKpiCounts = null;
  dashboardKpiPromise = null;
}

export function clearSessionCache() {
  cachedOfficeSettings = null;
  officeSettingsPromise = null;
  userRolesCache = null;
  userRolesPromise = null;
  cachedSearchesServed = null;
  searchesServedPromise = null;
  cachedSecurityPinConfig = null;
  securityPinConfigPromise = null;
  cachedDashboardKpiCounts = null;
  dashboardKpiPromise = null;
}

export async function getOfficeSettings(forceRefresh: boolean = false): Promise<OfficeSettings> {
  if (!forceRefresh && cachedOfficeSettings) {
    return cachedOfficeSettings;
  }

  if (!forceRefresh && officeSettingsPromise) {
    return officeSettingsPromise;
  }

  officeSettingsPromise = (async () => {
    let settings: OfficeSettings;
    const cachedProd = localStorage.getItem('plsms_cached_settings');
    let parsedCachedProd: OfficeSettings | null = null;
    if (cachedProd) {
      try {
        parsedCachedProd = JSON.parse(cachedProd);
      } catch {
        parsedCachedProd = null;
      }
    }

    const isExplicitDemo = localStorage.getItem('plsms_demo_active') === 'true';

    if (isExplicitDemo) {
      const defaultSettings = parsedCachedProd || initialMockSettings;
      settings = fetchStorageItem('plsms_mock_settings', defaultSettings);
    } else {
      try {
        const settingsRef = doc(db, 'office_settings', 'settings');
        const snap = await withFirestoreRetry(() => getDoc(settingsRef));
        if (snap.exists()) {
          settings = snap.data() as OfficeSettings;
          localStorage.setItem('plsms_cached_settings', JSON.stringify(settings));
          
          if (localStorage.getItem('plsms_quota_exceeded') === 'true') {
            localStorage.removeItem('plsms_quota_exceeded');
            safeDispatchEvent('plsms_demo_mode_changed');
          }
        } else {
          settings = parsedCachedProd || initialMockSettings;
        }
      } catch (err) {
        console.warn("Firestore settings read failed, using cached settings:", err);
        checkAndTriggerQuotaError(err);
        settings = parsedCachedProd || initialMockSettings;
      }
    }
    const sanitized = sanitizeOfficeSettings(settings);
    cachedOfficeSettings = sanitized;
    return sanitized;
  })();

  try {
    const res = await officeSettingsPromise;
    return res;
  } finally {
    officeSettingsPromise = null;
  }
}

// ==================== SYSTEM SECURITY & CREDENTIAL PERSISTENCE ====================

export async function hashCredential(text: string): Promise<string> {
  if (!text) return '';
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return `hash_${Math.abs(hash)}`;
  }
}

export interface SecurityPinConfig {
  pinHash: string;
  isCustom: boolean;
  plainPin?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export async function getSecurityPinConfig(forceRefresh: boolean = false): Promise<SecurityPinConfig> {
  if (!forceRefresh && cachedSecurityPinConfig) {
    return cachedSecurityPinConfig;
  }

  if (!forceRefresh && securityPinConfigPromise) {
    return securityPinConfigPromise;
  }

  securityPinConfigPromise = (async () => {
    const localPinConfig = fetchStorageItem<SecurityPinConfig | null>('plsms_pin_config', null);
    
    if (!isDemoModeActive()) {
      try {
        const snap = await getDoc(doc(db, 'system_security', 'pin_config'));
        if (snap.exists()) {
          const data = snap.data() as SecurityPinConfig;
          const config: SecurityPinConfig = {
            pinHash: data.pinHash || '',
            isCustom: data.isCustom ?? true,
            plainPin: data.plainPin || localPinConfig?.plainPin,
            updatedAt: data.updatedAt,
            updatedBy: data.updatedBy
          };
          writeStorageItem('plsms_pin_config', config);
          cachedSecurityPinConfig = config;
          return config;
        }
      } catch (err) {
        console.warn("Firestore pin_config read failed, using local/cache pin:", err);
      }
    }

    if (localPinConfig) {
      cachedSecurityPinConfig = localPinConfig;
      return localPinConfig;
    }

    const defaultConfig = {
      pinHash: '',
      isCustom: false,
      plainPin: '1234'
    };
    cachedSecurityPinConfig = defaultConfig;
    return defaultConfig;
  })();

  try {
    return await securityPinConfigPromise;
  } finally {
    securityPinConfigPromise = null;
  }
}

export async function verifySecurityPin(enteredPin: string): Promise<boolean> {
  if (!enteredPin) return false;

  // Always accept default clearance PIN '1234'
  if (enteredPin === '1234') {
    return true;
  }

  // Check against office settings consoleSecurityPin
  const localSettings = fetchStorageItem<OfficeSettings | null>('plsms_mock_settings', null);
  const cachedSettingsStr = localStorage.getItem('plsms_cached_settings');
  let currentOfficePin = '';
  if (localSettings?.consoleSecurityPin) {
    currentOfficePin = localSettings.consoleSecurityPin;
  } else if (cachedSettingsStr) {
    try {
      const parsed = JSON.parse(cachedSettingsStr);
      if (parsed.consoleSecurityPin) currentOfficePin = parsed.consoleSecurityPin;
    } catch {}
  }

  if (currentOfficePin && enteredPin === currentOfficePin) {
    return true;
  }

  const config = await getSecurityPinConfig();
  const enteredHash = await hashCredential(enteredPin);

  if (config.plainPin && enteredPin === config.plainPin) {
    return true;
  }

  if (config.pinHash && enteredHash === config.pinHash) {
    return true;
  }

  return false;
}

export async function saveSecurityPin(newPin: string, updatedBy: string = 'admin'): Promise<void> {
  if (!newPin || newPin.length !== 4) {
    throw new Error("Invalid Security PIN format. PIN must be 4 digits.");
  }
  const pinHash = await hashCredential(newPin);
  const pinData: SecurityPinConfig = {
    pinHash,
    isCustom: true,
    plainPin: newPin,
    updatedAt: new Date().toISOString(),
    updatedBy
  };

  writeStorageItem('plsms_pin_config', pinData);

  // Sync to local mock settings
  const localSettings = fetchStorageItem<OfficeSettings | null>('plsms_mock_settings', null);
  if (localSettings) {
    localSettings.consoleSecurityPin = newPin;
    writeStorageItem('plsms_mock_settings', localSettings);
  }

  // Sync to cached settings
  const cachedSettingsStr = localStorage.getItem('plsms_cached_settings');
  if (cachedSettingsStr) {
    try {
      const cached = JSON.parse(cachedSettingsStr);
      cached.consoleSecurityPin = newPin;
      localStorage.setItem('plsms_cached_settings', JSON.stringify(cached));
    } catch {}
  }

  if (!isDemoModeActive()) {
    try {
      await setDoc(doc(db, 'system_security', 'pin_config'), pinData, { merge: true });
      await setDoc(doc(db, 'office_settings', 'settings'), { consoleSecurityPin: newPin }, { merge: true });
    } catch (err) {
      console.warn("Failed to persist security PIN to Firestore:", err);
    }
  }

  safeDispatchEvent('plsms_local_settings_changed');
}

export interface UserSecurityCredential {
  userId: string;
  email: string;
  passwordHash?: string;
  passwordVersion?: number;
  passwordLastChanged?: string;
  mustChangePassword?: boolean;
  isCustomPassword?: boolean;
  updatedAt?: string;
}

export function getLocalSecurityCredentialsMap(): Record<string, UserSecurityCredential> {
  return {};
}

export async function saveUserSecurityCredentials(userId: string, credentials: Partial<UserSecurityCredential>): Promise<void> {
  let passwordHash = credentials.passwordHash;
  if (!passwordHash && (credentials as any).rawPassword) {
    passwordHash = await hashCredential((credentials as any).rawPassword);
  }

  userRolesCache = null;

  try {
    const cleanPayload: Record<string, any> = {
      userId,
      email: credentials.email || '',
      passwordHash: passwordHash || '',
      isCustomPassword: true,
      updatedAt: new Date().toISOString()
    };
    if (credentials.mustChangePassword !== undefined) {
      cleanPayload.mustChangePassword = credentials.mustChangePassword;
    }
    if (credentials.passwordVersion !== undefined) {
      cleanPayload.passwordVersion = credentials.passwordVersion;
    }

    await setDoc(doc(db, 'system_security', `user_${userId}`), cleanPayload, { merge: true });
  } catch (err) {
    console.warn("Notice: Firestore credentials write status:", err);
  }
}

export const SYSTEM_GLOBAL_MASTER_PASSWORD = "Itahari@PLSMS2083";
export const SYSTEM_STAFF_DEFAULT_PASSWORD = "Itahari@2026";

export async function verifyUserPassword(userRecord: UserRole, enteredPassword: string): Promise<boolean> {
  if (!userRecord || !enteredPassword) return false;

  // Real-time Firestore document fetch to ensure multi-browser credential synchronization
  let liveUser: UserRole = userRecord;
  try {
    if (userRecord.id) {
      const snap = await getDoc(doc(db, 'users_roles', userRecord.id));
      if (snap.exists()) {
        liveUser = { id: snap.id, ...snap.data() } as UserRole;
      }
    }
  } catch (err) {
    console.warn("Notice: Real-time Firestore password verification check:", err);
  }

  const enteredHash = await hashCredential(enteredPassword);

  // CRITICAL SECURITY RULE:
  // If the user has explicitly changed their password or has a saved passwordHash, compare ONLY against activeHash.
  // The default fallback passwords MUST NOT be accepted once a custom passwordHash is saved.
  const activeHash = liveUser.passwordHash || userRecord.passwordHash;
  if (activeHash) {
    return enteredHash === activeHash;
  }

  // If no custom passwordHash exists yet for an initial account:
  // Check default password depending on user role:
  // Super Admin / Admin: Itahari@PLSMS2083
  // Other Users / Staff: Itahari@2026
  const isSuperuserOrAdmin = 
    liveUser.role === 'superuser' || 
    liveUser.role === 'admin' || 
    liveUser.id === 'Super_Admin' || 
    liveUser.id === 'super_admin_sec' ||
    (liveUser.email && (liveUser.email.toLowerCase() === 'dahalkomal@gmail.com' || liveUser.email.toLowerCase() === 'dahalutkrishta@gmail.com'));

  const expectedDefaultPassword = isSuperuserOrAdmin ? SYSTEM_GLOBAL_MASTER_PASSWORD : SYSTEM_STAFF_DEFAULT_PASSWORD;
  const expectedDefaultHash = await hashCredential(expectedDefaultPassword);

  if (enteredPassword === expectedDefaultPassword || enteredHash === expectedDefaultHash) {
    // Automatically save passwordHash in Firestore so future logins strictly require this hash or updated password
    try {
      await setDoc(doc(db, 'users_roles', liveUser.id), {
        passwordHash: enteredHash,
        passwordVersion: 1,
        passwordLastChanged: new Date().toISOString(),
        isCustomPassword: false,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    } catch (e) {}
    return true;
  }

  return false;
}

export async function saveOfficeSettings(data: OfficeSettings): Promise<void> {
  cachedOfficeSettings = sanitizeOfficeSettings(data);
  localStorage.setItem('plsms_cached_settings', JSON.stringify(cachedOfficeSettings));
  safeDispatchEvent('plsms_local_settings_changed');

  if (isDemoModeActive()) {
    writeStorageItem('plsms_mock_settings', data);
    return;
  }
  const settingsRef = doc(db, 'office_settings', 'settings');
  await setDoc(settingsRef, data);
}

// ==================== STATISTICS SERVICES ====================

export async function getSearchesServedCount(forceRefresh: boolean = false): Promise<number> {
  if (!forceRefresh && cachedSearchesServed !== null) {
    return cachedSearchesServed;
  }

  if (!forceRefresh && searchesServedPromise) {
    return searchesServedPromise;
  }

  searchesServedPromise = (async () => {
    if (isDemoModeActive()) {
      const stats = fetchStorageItem('plsms_mock_stats', { totalSearchesServed: 42 });
      cachedSearchesServed = stats.totalSearchesServed;
      return stats.totalSearchesServed;
    }
    try {
      const snap = await getDoc(doc(db, 'statistics', 'search_served'));
      const count = snap.exists() ? (snap.data()?.totalSearchesServed || 0) : 0;
      cachedSearchesServed = count;
      return count;
    } catch (err) {
      checkAndTriggerQuotaError(err);
      return cachedSearchesServed || 0;
    }
  })();

  try {
    return await searchesServedPromise;
  } finally {
    searchesServedPromise = null;
  }
}

export async function incrementSearchesServed(): Promise<void> {
  cachedSearchesServed = (cachedSearchesServed || 0) + 1;
  safeDispatchEvent('plsms_local_settings_changed');

  if (isDemoModeActive()) {
    const stats = fetchStorageItem('plsms_mock_stats', { totalSearchesServed: 42 });
    stats.totalSearchesServed = (stats.totalSearchesServed || 0) + 1;
    writeStorageItem('plsms_mock_stats', stats);
    return;
  }
  const statRef = doc(db, 'statistics', 'search_served');
  try {
    await setDoc(statRef, { totalSearchesServed: increment(1) }, { merge: true });
  } catch (err) {
    checkAndTriggerQuotaError(err);
  }
}

// ==================== DRIVING LICENSES SERVICES ====================

// Helper to aggregate and preserve the largest complete dataset across in-memory store, storage, and ledger backups
export async function getBestAvailableLicenses(): Promise<License[]> {
  const storeRecords = registryDataStore.getRecords();
  const storageRecords = fetchStorageItem<License[]>('plsms_mock_licenses', initialMockLicenses);
  const liveBackupRecords = fetchStorageItem<License[]>('plsms_live_licenses_backup', []);
  
  const combinedMap = new Map<string, License>();
  liveBackupRecords.forEach(r => {
    if (r && r.id) combinedMap.set(r.id.toUpperCase(), r);
  });
  storeRecords.forEach(r => {
    if (r && r.id) combinedMap.set(r.id.toUpperCase(), r);
  });
  storageRecords.forEach(r => {
    if (r && r.id) combinedMap.set(r.id.toUpperCase(), r);
  });

  let resultList = Array.from(combinedMap.values());
  
  // If local list has fewer items, attempt to recover records from active upload ledgers
  try {
    const ledgers = fetchStorageItem<UploadLedger[]>('plsms_mock_ledgers', []);
    const activeLedgers = ledgers.filter(l => l && l.status !== 'Deleted');
    if (activeLedgers.length > 0) {
      for (const l of activeLedgers) {
        const backups = fetchStorageItem<License[]>('plsms_mock_ledger_backups_' + l.id, []);
        backups.forEach(b => {
          if (b && b.id && !combinedMap.has(b.id.toUpperCase())) {
            combinedMap.set(b.id.toUpperCase(), b);
          }
        });
      }
      if (combinedMap.size > resultList.length) {
        resultList = Array.from(combinedMap.values());
        writeStorageItem('plsms_mock_licenses', resultList);
      }
    }
  } catch (e) {
    console.warn("Ledger backup recovery check failed:", e);
  }

  return resultList;
}

export async function getAllLicenses(): Promise<License[]> {
  if (isDemoModeActive()) {
    return getBestAvailableLicenses();
  }
  try {
    // Budget protection: fetch bounded sample set up to 2000 records to prevent memory overflow
    const snap = await withFirestoreRetry(() => getDocs(query(collection(db, 'licenses'), limit(2000))));
    clearQuotaExceededFlag();
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as License));

    if (list.length > 0) {
      const cappedList = list.length > 2000 ? list.slice(0, 2000) : list;
      writeStorageItem('plsms_live_licenses_backup', cappedList);
      registryDataStore.setRecords(cappedList, 'Firestore Primary Collection', false);
    }

    return list;
  } catch (err) {
    console.warn("Firestore licenses fetch failed, falling back to persistent local backup:", err);
    checkAndTriggerQuotaError(err);
    const backup = fetchStorageItem<License[]>('plsms_live_licenses_backup', []);
    if (backup.length > 0) {
      return backup;
    }
    return getBestAvailableLicenses();
  }
}

export interface DashboardKpiCounts {
  totalRecords: number;
  availableCount: number;
  notDistributedCount: number;
  distributedCount: number;
  missingCount: number;
  foundCount: number;
}

export function isLicenseDistributed(l: Partial<License> | undefined | null): boolean {
  if (!l) return false;
  const rec = l as any;

  // 1. Explicit boolean or status string flags
  if (rec.distributed === true || rec.distributed === 'true' || rec.isDistributed === true) return true;
  if (l.status === 'distributed' || l.status === 'found') return true;
  if (rec.distributionStatus === 'Distributed' || rec.distributionStatus === 'distributed') return true;

  // 2. Receiver / Handover / Distributed To Name
  const receiverNames = [
    l.receivedBy,
    rec.distributedTo,
    rec.received_by,
    rec.distributed_to,
    rec.submittedDocsReceiverName,
    rec.receiverName,
    rec.receiver_name
  ];
  for (const name of receiverNames) {
    if (name && typeof name === 'string') {
      const trimmed = name.trim();
      if (trimmed !== '' && trimmed !== '---' && trimmed !== 'N/A' && trimmed.toLowerCase() !== 'null' && trimmed.toLowerCase() !== 'undefined') {
        return true;
      }
    }
  }

  // 3. Distribution Date
  const dates = [
    l.distributedDate,
    rec.distributionDate,
    rec.distributed_date,
    rec.distribution_date
  ];
  for (const d of dates) {
    if (d && typeof d === 'string') {
      const trimmed = d.trim();
      if (trimmed !== '' && trimmed !== '---' && trimmed !== 'N/A') {
        return true;
      }
    }
  }

  // 4. Distributed By Staff
  if (l.distributedBy && typeof l.distributedBy === 'string' && l.distributedBy.trim() !== '' && l.distributedBy.trim() !== '---') {
    return true;
  }

  // 5. Submitted Documents
  const docsList = [
    l.submittedDocs,
    rec.submittedDocuments,
    rec.submittedDocsList,
    rec.submitted_documents,
    rec.submitted_docs
  ];
  for (const docs of docsList) {
    if (Array.isArray(docs) && docs.length > 0) return true;
    if (typeof docs === 'string') {
      const trimmed = docs.trim();
      if (trimmed !== '' && trimmed !== '[]' && trimmed !== '---' && trimmed !== 'N/A') {
        return true;
      }
    }
  }

  return false;
}

export async function getDashboardKpiCounts(forceRefresh: boolean = false): Promise<DashboardKpiCounts> {
  if (!forceRefresh && cachedDashboardKpiCounts) {
    return cachedDashboardKpiCounts;
  }

  if (!forceRefresh && dashboardKpiPromise) {
    return dashboardKpiPromise;
  }

  dashboardKpiPromise = (async () => {
    if (!isDemoModeActive()) {
      try {
        const col = collection(db, 'licenses');
        const [totalSnap, distSnap, missingSnap, foundSnap] = await withFirestoreRetry(() => Promise.all([
          getCountFromServer(col),
          getCountFromServer(query(col, where('status', '==', 'distributed'))),
          getCountFromServer(query(col, where('status', '==', 'missing'))),
          getCountFromServer(query(col, where('status', '==', 'found'))),
        ]));

        clearQuotaExceededFlag();

        const total = totalSnap.data().count;
        const distCountOnly = distSnap.data().count;
        const missingCount = missingSnap.data().count;
        const foundCount = foundSnap.data().count;

        const distributedCount = distCountOnly + foundCount;
        const notDistributed = Math.max(0, total - distributedCount);

        const res = {
          totalRecords: total,
          availableCount: total,
          notDistributedCount: notDistributed,
          distributedCount,
          missingCount,
          foundCount
        };
        cachedDashboardKpiCounts = res;
        return res;
      } catch (err) {
        console.warn("Failed to fetch aggregate counts from server:", err);
        checkAndTriggerQuotaError(err);
      }
    }

    // Demo mode or fallback
    const storeRecords = registryDataStore.getRecords();
    const storageRecords = fetchStorageItem<License[]>('plsms_mock_licenses', initialMockLicenses);
    const list = storeRecords.length >= storageRecords.length ? storeRecords : storageRecords;
    let dist = 0, missing = 0, found = 0;
    for (const l of list) {
      if (l.status === 'missing') {
        missing++;
      } else if (l.status === 'found') {
        found++;
        dist++;
      } else if (l.status === 'distributed' || isLicenseDistributed(l)) {
        dist++;
      }
    }
    const totalRecords = list.length;
    const notDist = Math.max(0, totalRecords - dist);

    const fallbackRes = {
      totalRecords,
      availableCount: totalRecords,
      notDistributedCount: notDist,
      distributedCount: dist,
      missingCount: missing,
      foundCount: found
    };
    cachedDashboardKpiCounts = fallbackRes;
    return fallbackRes;
  })();

  try {
    return await dashboardKpiPromise;
  } finally {
    dashboardKpiPromise = null;
  }
}

export interface PaginatedLicensesParams {
  pageSize: number;
  lastDocSnap?: QueryDocumentSnapshot | null;
  statusFilter?: LicenseStatus | 'not_distributed' | 'all';
  searchQuery?: string;
}

export interface PaginatedLicensesResult {
  records: License[];
  lastDocSnap: QueryDocumentSnapshot | null;
  totalCount: number;
}

export async function getPaginatedLicenses(params: PaginatedLicensesParams): Promise<PaginatedLicensesResult> {
  const { pageSize = 25, lastDocSnap = null, statusFilter = 'all', searchQuery = '' } = params;

  if (!isDemoModeActive()) {
    try {
      const colRef = collection(db, 'licenses');
      const qConstraints: QueryConstraint[] = [];

      // Filter by status if requested
      if (statusFilter === 'distributed') {
        qConstraints.push(where('status', '==', 'distributed'));
      } else if (statusFilter === 'missing') {
        qConstraints.push(where('status', '==', 'missing'));
      } else if (statusFilter === 'found') {
        qConstraints.push(where('status', '==', 'found'));
      } else if (statusFilter === 'not_distributed') {
        qConstraints.push(where('status', '==', 'available'));
      }

      // Safe ordering using documentId() which exists on 100% of documents
      qConstraints.push(orderBy(documentId()));

      if (lastDocSnap) {
        qConstraints.push(startAfter(lastDocSnap));
      }

      if (pageSize > 0) {
        qConstraints.push(limit(pageSize));
      }

      const q = query(colRef, ...qConstraints);
      const snap = await getDocs(q);
      clearQuotaExceededFlag();

      const rawRecords = snap.docs.map(d => ({ id: d.id, ...d.data() } as License));
      const newLastDocSnap = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;

      // Filter and normalize status
      const records = rawRecords.map(r => {
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

      const filteredRecords = records.filter(l => {
        if (statusFilter === 'distributed') {
          return isLicenseDistributed(l) && l.status !== 'missing';
        }
        if (statusFilter === 'not_distributed') {
          return (!isLicenseDistributed(l) && l.status !== 'found') || l.status === 'missing';
        }
        if (statusFilter === 'missing') {
          return l.status === 'missing';
        }
        if (statusFilter === 'found') {
          return l.status === 'found';
        }
        return true;
      });

      // Get count for total count calculation using Aggregate count query
      const countQueryConstraints: QueryConstraint[] = [];
      if (statusFilter === 'distributed') {
        countQueryConstraints.push(where('status', '==', 'distributed'));
      } else if (statusFilter === 'missing') {
        countQueryConstraints.push(where('status', '==', 'missing'));
      } else if (statusFilter === 'found') {
        countQueryConstraints.push(where('status', '==', 'found'));
      } else if (statusFilter === 'not_distributed') {
        countQueryConstraints.push(where('status', '==', 'available'));
      }

      const countSnap = await getCountFromServer(query(colRef, ...countQueryConstraints));
      const totalCount = countSnap.data().count;

      return {
        records: filteredRecords,
        lastDocSnap: newLastDocSnap,
        totalCount
      };
    } catch (err) {
      console.warn("Failed to fetch paginated licenses from Firestore:", err);
      checkAndTriggerQuotaError(err);
    }
  }

  // Demo mode or fallback
  const storeRecords = registryDataStore.getRecords();
  const storageRecords = fetchStorageItem<License[]>('plsms_mock_licenses', initialMockLicenses);
  const list = storeRecords.length >= storageRecords.length ? storeRecords : storageRecords;
  const q = searchQuery.trim().toLowerCase();
  const filtered = list.filter(l => {
    const matchesSearch = !q || isLicenseMatch(q, l) || (l.fullName || '').toLowerCase().includes(q);
    if (!matchesSearch) return false;

    if (statusFilter === 'all' || statusFilter === 'available') return true;
    if (statusFilter === 'not_distributed') return (!isLicenseDistributed(l) && l.status !== 'found') || l.status === 'missing';
    if (statusFilter === 'distributed') return isLicenseDistributed(l) && l.status !== 'missing';
    if (statusFilter === 'missing') return l.status === 'missing';
    if (statusFilter === 'found') return l.status === 'found';
    return l.status === statusFilter;
  });

  return {
    records: filtered.slice(0, pageSize === 0 ? filtered.length : pageSize),
    lastDocSnap: null,
    totalCount: filtered.length
  };
}

export async function getLicenseByLicenseNumber(licenseNo: string): Promise<License | null> {
  if (!licenseNo || !licenseNo.trim()) return null;

  // 1. Convert Nepali digits to English digits & trim
  const engQuery = nepaliToEnglishDigits(licenseNo).trim();
  const rawUpper = engQuery.toUpperCase();

  // 2. Extract digits only & clean alphanumeric
  const digits = engQuery.replace(/\D/g, '');
  const cleanAlphanumericStr = rawUpper.replace(/[^A-Z0-9]/g, '');

  // 3. Reconstruct candidate queries for Firestore indexed field
  const candidates: string[] = [];

  // Standard format (XX-XX-XXXXXXXX)
  if (digits.length >= 4) {
    const formatted = `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
    if (formatted && !candidates.includes(formatted)) {
      candidates.push(formatted);
    }
  }

  if (rawUpper && !candidates.includes(rawUpper)) {
    candidates.push(rawUpper);
  }

  if (cleanAlphanumericStr && !candidates.includes(cleanAlphanumericStr)) {
    candidates.push(cleanAlphanumericStr);
  }

  if (digits && !candidates.includes(digits)) {
    candidates.push(digits);
  }

  // Handle Demo Mode fallback
  if (isDemoModeActive()) {
    const list = fetchStorageItem<License[]>('plsms_mock_licenses', initialMockLicenses);
    const match = list.find(l => {
      if (!l.licenseNumber) return false;
      const lNorm = nepaliToEnglishDigits(l.licenseNumber.trim()).toUpperCase();
      const lClean = lNorm.replace(/[^A-Z0-9]/g, '');
      const lDigits = lNorm.replace(/\D/g, '');
      return candidates.some(c => lNorm === c || lClean === c || lDigits === c);
    });
    return match || null;
  }

  try {
    // 4. Query Firestore directly on the indexed 'licenseNumber' field
    for (const candidate of candidates) {
      const q = query(collection(db, 'licenses'), where('licenseNumber', '==', candidate), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) {
        clearQuotaExceededFlag();
        return { id: snap.docs[0].id, ...snap.docs[0].data() } as License;
      }

      // Check document ID as fallback if ID matches candidate
      const docSnap = await getDoc(doc(db, 'licenses', candidate));
      if (docSnap.exists()) {
        clearQuotaExceededFlag();
        const data = { id: docSnap.id, ...docSnap.data() } as License;
        return data;
      }
    }
  } catch (err) {
    console.warn("Firestore indexed query for licenseNumber failed:", err);
    checkAndTriggerQuotaError(err);
    const list = fetchStorageItem<License[]>('plsms_mock_licenses', initialMockLicenses);
    const match = list.find(l => {
      if (!l.licenseNumber) return false;
      const lNorm = nepaliToEnglishDigits(l.licenseNumber.trim()).toUpperCase();
      const lClean = lNorm.replace(/[^A-Z0-9]/g, '');
      const lDigits = lNorm.replace(/\D/g, '');
      return candidates.some(c => lNorm === c || lClean === c || lDigits === c);
    });
    return match || null;
  }

  return null;
}

export async function getLicenseById(id: string): Promise<License | null> {
  if (!id || !id.trim()) return null;

  const normId = nepaliToEnglishDigits(id.trim());
  const sanitizedId = cleanAlphanumeric(normId);

  if (!isDemoModeActive()) {
    try {
      const rawId = normId.toUpperCase();
      
      // Direct doc lookups by raw ID and sanitized ID
      let docSnap = await getDoc(doc(db, 'licenses', rawId));
      if (docSnap.exists()) {
        clearQuotaExceededFlag();
        return { id: docSnap.id, ...docSnap.data() } as License;
      }

      if (sanitizedId && sanitizedId !== rawId) {
        docSnap = await getDoc(doc(db, 'licenses', sanitizedId));
        if (docSnap.exists()) {
          clearQuotaExceededFlag();
          return { id: docSnap.id, ...docSnap.data() } as License;
        }
      }

      // Direct query lookups
      const queries = [
        query(collection(db, 'licenses'), where('licenseNumber', '==', rawId), limit(1)),
        query(collection(db, 'licenses'), where('applicantId', '==', rawId), limit(1)),
        query(collection(db, 'licenses'), where('id', '==', rawId), limit(1))
      ];

      for (const q of queries) {
        const snap = await getDocs(q);
        if (!snap.empty) {
          clearQuotaExceededFlag();
          return { id: snap.docs[0].id, ...snap.docs[0].data() } as License;
        }
      }
    } catch (err) {
      console.warn("Firestore license query failed, falling back to offline search:", err);
      checkAndTriggerQuotaError(err);
    }
  }

  // Fallback checks for demo mode or offline
  try {
    const storeRecords = registryDataStore.getRecords();
    if (storeRecords && storeRecords.length > 0) {
      const match = storeRecords.find(l => isLicenseMatch(normId, l));
      if (match) return match;
    }
  } catch (err) {
    console.warn("Registry store check failed in getLicenseById:", err);
  }

  try {
    const backup = fetchStorageItem<License[]>('plsms_live_licenses_backup', []);
    const match = backup.find(l => isLicenseMatch(normId, l));
    if (match) return match;
  } catch (err) {
    console.warn("Backup check failed in getLicenseById:", err);
  }

  return null;
}

export async function createOrUpdateLicense(id: string, license: License): Promise<void> {
  let updatedLicense: License = { ...license, id };

  // Synchronize status to 'distributed' if any distribution information exists
  if (isLicenseDistributed(updatedLicense) && updatedLicense.status !== 'missing' && updatedLicense.status !== 'found') {
    updatedLicense = {
      ...updatedLicense,
      status: 'distributed',
      distributed: true as any,
      distributionStatus: 'Distributed' as any
    };
  }

  // 1. Write directly to persistent Cloud Firestore
  try {
    const docRef = doc(db, 'licenses', id);
    await setDoc(docRef, updatedLicense);
  } catch (error) {
    console.warn("Could not write license to Cloud Firestore permanently: ", error);
    checkAndTriggerQuotaError(error);
    throw error;
  }

  // 2. Synchronize memory registryDataStore immediately via updateRecord / addRecord
  const updatedInStore = registryDataStore.updateRecord(id, updatedLicense);
  if (!updatedInStore) {
    registryDataStore.addRecord(updatedLicense);
  }

  // 3. Keep mock localStorage in sync if present
  try {
    const storageRecords = fetchStorageItem<License[]>('plsms_mock_licenses', []);
    if (storageRecords && storageRecords.length > 0) {
      const idx = storageRecords.findIndex(l => l.id === id || isLicenseMatch(id, l));
      if (idx >= 0) {
        storageRecords[idx] = { ...storageRecords[idx], ...updatedLicense };
      } else {
        storageRecords.push(updatedLicense);
      }
      writeStorageItem('plsms_mock_licenses', storageRecords);
    }
  } catch (e) {
    console.warn("Error updating mock storage item:", e);
  }
}

export async function deleteLicense(id: string): Promise<void> {
  const exactId = id.trim();
  try {
    // 1. Delete by exact ID (case-sensitive as returned by Firestore)
    await deleteDoc(doc(db, 'licenses', exactId));
    
    // 2. Suppress and attempt sanitized alternative if different
    const sanitizedId = exactId.toUpperCase().replace(/[^A-Z0-9_\-\.]/g, '');
    if (sanitizedId !== exactId) {
      await deleteDoc(doc(db, 'licenses', sanitizedId));
    }
  } catch (error) {
    console.warn("Could not delete license from Cloud Firestore:", error);
    checkAndTriggerQuotaError(error);
  }

  // Also maintain local collection if demo is active
  if (isDemoModeActive()) {
    const list = fetchStorageItem<License[]>('plsms_mock_licenses', initialMockLicenses);
    const filtered = list.filter(l => l.id !== id);
    writeStorageItem('plsms_mock_licenses', filtered);
  }
}

export async function batchWriteLicenses(licenses: License[]): Promise<BatchWriteResult> {
  const startTimeOverall = Date.now();
  const batchDetails: BatchCommitDetail[] = [];

  if (isDemoModeActive()) {
    const list = fetchStorageItem<License[]>('plsms_mock_licenses', initialMockLicenses);
    licenses.forEach(newLic => {
      const idx = list.findIndex(l => l.id === newLic.id);
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...newLic };
      } else {
        list.push(newLic);
      }
    });
    writeStorageItem('plsms_mock_licenses', list);

    const nowStr = new Date().toISOString();
    const endTimeOverall = Date.now();
    const demoDetail: BatchCommitDetail = {
      batchNumber: 1,
      recordsCount: licenses.length,
      startTime: nowStr,
      finishTime: nowStr,
      status: 'SUCCESS',
      retries: 0
    };

    return {
      totalRecords: licenses.length,
      successfulBatchCount: 1,
      failedBatchCount: 0,
      verificationStatus: 'VERIFIED',
      verificationTime: nowStr,
      verificationDurationMs: endTimeOverall - startTimeOverall,
      batchDetails: [demoDetail],
      failedBatchDetails: []
    };
  }

  // Always commit batch to persistent Cloud Firestore in safe slices with auto-retry
  const BATCH_LIMIT = 450;
  let batchNumber = 0;

  try {
    const { writeBatch } = await import('firebase/firestore');

    for (let i = 0; i < licenses.length; i += BATCH_LIMIT) {
      batchNumber++;
      const slice = licenses.slice(i, i + BATCH_LIMIT);
      const batchStartTime = new Date().toISOString();
      let retries = 0;
      let batchSuccess = false;
      let lastError = '';

      // First attempt
      let batch = writeBatch(db);
      slice.forEach((lic) => {
        batch.set(doc(db, 'licenses', lic.id), lic);
      });

      try {
        await batch.commit();
        batchSuccess = true;
      } catch (firstErr: any) {
        console.warn(`[Batch Commit] Batch ${batchNumber} initial commit failed:`, firstErr);
        lastError = firstErr?.message || String(firstErr);
        checkAndTriggerQuotaError(firstErr);

        // Automatic Retry up to 3 times for failed batch only
        for (let attempt = 1; attempt <= 3; attempt++) {
          retries = attempt;
          console.log(`[Batch Retry] Waiting 2000ms before retry ${attempt}/3 for Batch ${batchNumber}...`);
          await new Promise(r => setTimeout(r, 2000));

          try {
            const retryBatch = writeBatch(db);
            slice.forEach((lic) => {
              retryBatch.set(doc(db, 'licenses', lic.id), lic);
            });
            await retryBatch.commit();
            batchSuccess = true;
            console.log(`[Batch Retry] Batch ${batchNumber} succeeded on retry #${attempt}!`);
            break;
          } catch (retryErr: any) {
            console.warn(`[Batch Retry] Batch ${batchNumber} retry #${attempt} failed:`, retryErr);
            lastError = retryErr?.message || String(retryErr);
            checkAndTriggerQuotaError(retryErr);
          }
        }
      }

      if (batchSuccess) {
        registryDataStore.setRecords(slice, 'Batch Write Direct Ingestion', false);
        try {
          const currentBackup = fetchStorageItem<License[]>('plsms_live_licenses_backup', []);
          const backupMap = new Map<string, License>();
          currentBackup.forEach(b => { if (b && b.id) backupMap.set(b.id.toUpperCase(), b); });
          slice.forEach(s => { if (s && s.id) backupMap.set(s.id.toUpperCase(), s); });
          const updatedBackup = Array.from(backupMap.values());
          const cappedBackup = updatedBackup.length > 2000 ? updatedBackup.slice(-2000) : updatedBackup;
          writeStorageItem('plsms_live_licenses_backup', cappedBackup);
        } catch (storageErr) {
          console.warn("Local storage backup update notice:", storageErr);
        }
      }

      const batchFinishTime = new Date().toISOString();
      const detail: BatchCommitDetail = {
        batchNumber,
        recordsCount: slice.length,
        startTime: batchStartTime,
        finishTime: batchFinishTime,
        status: batchSuccess ? 'SUCCESS' : 'FAILED',
        retries,
        ...(batchSuccess ? {} : { error: lastError })
      };
      batchDetails.push(detail);
    }

    const successfulBatchCount = batchDetails.filter(b => b.status === 'SUCCESS').length;
    const failedBatchDetails = batchDetails.filter(b => b.status === 'FAILED');
    const failedBatchCount = failedBatchDetails.length;

    let verificationStatus: 'VERIFIED' | 'PARTIAL SUCCESS' | 'FAILED' = 'VERIFIED';
    if (failedBatchCount > 0 && successfulBatchCount > 0) {
      verificationStatus = 'PARTIAL SUCCESS';
    } else if (failedBatchCount > 0 && successfulBatchCount === 0) {
      verificationStatus = 'FAILED';
    }

    const endTimeOverall = Date.now();
    const verificationTime = new Date().toISOString();

    console.log(`[Enterprise Batch Verification] Processed ${licenses.length} records across ${batchNumber} batches (${successfulBatchCount} VERIFIED, ${failedBatchCount} FAILED). Status: ${verificationStatus}`);

    return {
      totalRecords: licenses.length,
      successfulBatchCount,
      failedBatchCount,
      verificationStatus,
      verificationTime,
      verificationDurationMs: endTimeOverall - startTimeOverall,
      batchDetails,
      failedBatchDetails
    };
  } catch (error: any) {
    console.warn("Failed committing batch licenses to Cloud Firestore: ", error);
    checkAndTriggerQuotaError(error);
    const endTimeOverall = Date.now();
    const failedBatchDetails = batchDetails.filter(b => b.status === 'FAILED');
    return {
      totalRecords: licenses.length,
      successfulBatchCount: batchDetails.filter(b => b.status === 'SUCCESS').length,
      failedBatchCount: Math.max(1, batchNumber - batchDetails.filter(b => b.status === 'SUCCESS').length),
      verificationStatus: 'FAILED',
      verificationTime: new Date().toISOString(),
      verificationDurationMs: endTimeOverall - startTimeOverall,
      batchDetails,
      failedBatchDetails
    };
  }
}

// ==================== COLLECTION REQUESTS SERVICES ====================

export async function getAllCollectionRequests(): Promise<CollectionRequest[]> {
  if (isDemoModeActive()) {
    return fetchStorageItem<CollectionRequest[]>('plsms_mock_requests', initialMockRequests);
  }
  if (!auth.currentUser) {
    return [];
  }
  try {
    const snap = await getDocs(collection(db, 'collection_requests'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as CollectionRequest));
  } catch (error) {
    console.warn("Notice: Collection requests read restricted or database not initialized:", error);
    checkAndTriggerQuotaError(error);
    return [];
  }
}

export async function createCollectionRequest(id: string, request: CollectionRequest): Promise<void> {
  if (isDemoModeActive()) {
    const list = await getAllCollectionRequests();
    list.push(request);
    writeStorageItem('plsms_mock_requests', list);
    return;
  }
  try {
    await setDoc(doc(db, 'collection_requests', id), request);
  } catch (err) {
    checkAndTriggerQuotaError(err);
    throw err;
  }
}

export async function updateCollectionRequestStatus(id: string, status: string): Promise<void> {
  if (isDemoModeActive()) {
    const list = await getAllCollectionRequests();
    const index = list.findIndex(r => r.id === id);
    if (index >= 0) {
      list[index].status = status as any;
      writeStorageItem('plsms_mock_requests', list);
    }
    return;
  }
  try {
    await updateDoc(doc(db, 'collection_requests', id), { status });
  } catch (err) {
    checkAndTriggerQuotaError(err);
    throw err;
  }
}

// ==================== NOTICE BOARD SERVICES ====================

export async function getAllNotices(): Promise<Notice[]> {
  if (isDemoModeActive()) {
    const list = fetchStorageItem('plsms_mock_notices', initialMockNotices);
    // Sort notices by date descending
    return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  const q = query(collection(db, 'notices'), orderBy('createdAt', 'desc'));
  try {
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as Notice));
  } catch (err) {
    checkAndTriggerQuotaError(err);
    try {
      const snap = await getDocs(collection(db, 'notices'));
      return snap.docs.map(d => ({ id: d.id, ...d.data() } as Notice));
    } catch (e) {
      console.warn("Could not retrieve notices:", e);
      checkAndTriggerQuotaError(e);
      return [];
    }
  }
}

export async function addNotice(notice: Omit<Notice, 'id'>): Promise<void> {
  if (isDemoModeActive()) {
    const list = await getAllNotices();
    const newNotice = { id: 'notice_' + Math.random().toString(36).substr(2, 9), ...notice };
    list.push(newNotice);
    writeStorageItem('plsms_mock_notices', list);
    return;
  }
  try {
    await addDoc(collection(db, 'notices'), notice);
  } catch (err) {
    checkAndTriggerQuotaError(err);
    throw err;
  }
}

export async function updateNoticeActiveStatus(id: string, active: boolean): Promise<void> {
  if (isDemoModeActive()) {
    const list = await getAllNotices();
    const index = list.findIndex(n => n.id === id);
    if (index >= 0) {
      list[index].active = active;
      writeStorageItem('plsms_mock_notices', list);
    }
    return;
  }
  try {
    await updateDoc(doc(db, 'notices', id), { active });
  } catch (err) {
    checkAndTriggerQuotaError(err);
    throw err;
  }
}

export async function updateNotice(id: string, updates: Partial<Notice>): Promise<void> {
  if (isDemoModeActive()) {
    const list = await getAllNotices();
    const index = list.findIndex(n => n.id === id);
    if (index >= 0) {
      list[index] = { ...list[index], ...updates };
      writeStorageItem('plsms_mock_notices', list);
    }
    return;
  }
  try {
    await updateDoc(doc(db, 'notices', id), updates as any);
  } catch (err) {
    checkAndTriggerQuotaError(err);
    throw err;
  }
}

export async function deleteNotice(id: string): Promise<void> {
  if (isDemoModeActive()) {
    const list = await getAllNotices();
    const filtered = list.filter(n => n.id !== id);
    writeStorageItem('plsms_mock_notices', filtered);
    return;
  }
  try {
    await deleteDoc(doc(db, 'notices', id));
  } catch (err) {
    checkAndTriggerQuotaError(err);
    throw err;
  }
}

// ==================== USER ROLES SERVICES ====================

// Secure in-memory store for user passwords in demo mode to prevent browser storage persistence
export const inMemoryDemoPasswords: Record<string, { customStoredPassword?: string; temporaryPassword?: string; mustChangePassword?: boolean }> = {};

export const DEFAULT_CREDENTIALS_MATRIX: UserRole[] = [
  {
    id: "Super_Admin",
    username: "Super_Admin",
    displayName: "Komal Dahal",
    email: "dahalkomal@gmail.com",
    role: "superuser",
    mobile: "9842033214",
    post: "System Controller",
    status: "ACTIVE",
    updatedAt: "2026-06-10T15:47:13Z"
  },
  {
    id: "super_admin_sec",
    username: "super_admin_sec",
    displayName: "Utkrishta Dahal",
    email: "dahalutkrishta@gmail.com",
    role: "superuser",
    mobile: "98462006288",
    post: "Chief IT Officer",
    status: "ACTIVE",
    updatedAt: "2026-06-10T15:47:13Z"
  }
];

export const UNUSED_STAFF_ACCOUNTS_TO_PURGE = [
  'SUPER_ADMIN', 'superadmin_role6@tmodl.gov.np',
  'Sdahal_plsms', 'sdahal_plsms', 'SDAHAL_PLSMS', 'sdahal_plsms@plsms.local', 'sdahal_plsms@plsms.gov.bd',
  'dahal_plsms', 'Dahal_plsms', 'DAHAL_PLSMS', 'dahal_plsms@plsms.gov.bd',
  'public_handover_desk', 'Public_Handover_Desk', 'PUBLIC_HANDOVER_DESK', 'public_handover_desk@plsms.gov.bd', 'public search handover desk',
  'admin_lead', 'ADMIN_LEAD', 'admin@tmodl.gov.np',
  'data_entry_staff', 'DATA_ENTRY_STAFF', 'dataentry@tmodl.gov.np',
  'dispatch_staff', 'DISPATCH_STAFF', 'dispatch@tmodl.gov.np',
  'staff_operator', 'STAFF_OPERATOR', 'staff@tmodl.gov.np',
  'computer_operator', 'COMPUTER_OPERATOR', 'operator@tmodl.gov.np'
];

export function getRevokedUserIds(): string[] {
  const stored = fetchStorageItem<string[]>('plsms_revoked_user_ids', []);
  const combined = Array.from(new Set([...stored, ...UNUSED_STAFF_ACCOUNTS_TO_PURGE]));
  return combined.filter(id => {
    const l = (id || '').toLowerCase();
    const isProtected = (
      id === 'Super_Admin' ||
      id === 'super_admin_sec' ||
      l === 'super_admin' ||
      l === 'super_admin_sec' ||
      l === 'dahalkomal@gmail.com' ||
      l === 'dahalutkrishta@gmail.com'
    );
    if (id === 'SUPER_ADMIN' || l === 'superadmin_role6@tmodl.gov.np') {
      return true;
    }
    return isProtected ? false : true;
  });
}

export function isUserRevoked(u: { id: string; username?: string; email?: string }): boolean {
  if (!u) return false;
  const revokedList = getRevokedUserIds();
  const idLower = (u.id || '').toLowerCase();
  const usernameLower = (u.username || '').toLowerCase();
  const emailLower = (u.email || '').toLowerCase();

  // EXPLICIT PURGE: Old legacy admin accounts and demo accounts
  if (
    u.id === 'SUPER_ADMIN' || 
    idLower === 'dahal_plsms' || 
    idLower === 'sdahal_plsms' || 
    idLower === 'public_handover_desk' ||
    usernameLower === 'dahal_plsms' ||
    usernameLower === 'sdahal_plsms' ||
    usernameLower === 'public_handover_desk' ||
    emailLower === 'dahal_plsms@plsms.gov.bd' ||
    emailLower === 'sdahal_plsms@plsms.local' ||
    emailLower === 'sdahal_plsms@plsms.gov.bd' ||
    emailLower === 'public_handover_desk@plsms.gov.bd' ||
    emailLower === 'public search handover desk' ||
    (idLower === 'super_admin' && emailLower.includes('tmodl.gov.np')) || 
    emailLower === 'superadmin_role6@tmodl.gov.np'
  ) {
    return true;
  }

  // NEVER revoke or filter out primary Lead Super Administrators (Komal Dahal & Utkrishta Dahal)
  if (
    u.id === 'Super_Admin' ||
    u.id === 'super_admin_sec' ||
    idLower === 'super_admin' ||
    idLower === 'super_admin_sec' ||
    usernameLower === 'super_admin' ||
    usernameLower === 'super_admin_sec' ||
    emailLower === 'dahalkomal@gmail.com' ||
    emailLower === 'dahalutkrishta@gmail.com'
  ) {
    return false;
  }

  return (
    revokedList.includes(u.id) ||
    revokedList.includes(idLower) ||
    (!!u.username && revokedList.includes(u.username)) ||
    (!!u.username && revokedList.includes(usernameLower)) ||
    (!!u.email && revokedList.includes(emailLower))
  );
}

// Helper to ensure primary Super Admin accounts (Komal Dahal & Utkrishta Dahal) are present
function ensureKomalDahalAccount(list: UserRole[]): UserRole[] {
  let result = list.filter(u => !isUserRevoked(u));

  const existingIds = new Set(result.map(u => u.id));
  const existingEmails = new Set(result.map(u => (u.email || '').toLowerCase()));
  const existingUsernames = new Set(result.map(u => (u.username || '').toLowerCase()));

  for (const defUser of DEFAULT_CREDENTIALS_MATRIX) {
    if (
      !existingIds.has(defUser.id) &&
      (!defUser.email || !existingEmails.has(defUser.email.toLowerCase())) &&
      (!defUser.username || !existingUsernames.has(defUser.username.toLowerCase()))
    ) {
      result.push(defUser);
      existingIds.add(defUser.id);
      if (defUser.email) existingEmails.add(defUser.email.toLowerCase());
      if (defUser.username) existingUsernames.add(defUser.username.toLowerCase());
    }
  }

  const komalIndex = result.findIndex(u =>
    u.id === 'Super_Admin' ||
    (u.email && u.email.toLowerCase() === 'dahalkomal@gmail.com') ||
    (u.username && u.username === 'Super_Admin')
  );

  const komalRecord: UserRole = {
    id: "Super_Admin",
    username: "Super_Admin",
    displayName: "Komal Dahal",
    email: "dahalkomal@gmail.com",
    role: "superuser",
    mobile: "9842033214",
    post: "System Controller",
    status: "ACTIVE",
    updatedAt: new Date().toISOString()
  };

  if (komalIndex === -1) {
    result.unshift(komalRecord);
  } else {
    result[komalIndex] = {
      ...result[komalIndex],
      id: "Super_Admin",
      displayName: 'Komal Dahal',
      role: 'superuser',
      status: 'ACTIVE',
      email: 'dahalkomal@gmail.com',
      username: 'Super_Admin',
      post: result[komalIndex].post || 'System Controller'
    };
  }

  // Deduplicate by ID to guarantee unique React keys and prevent duplicate user rows
  const seenIds = new Set<string>();
  const deduplicated: UserRole[] = [];
  for (const item of result) {
    if (!item || !item.id) continue;
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      deduplicated.push(item);
    }
  }

  return deduplicated;
}

export async function cleanupUnusedStaffAccounts(): Promise<void> {
  const staffIds = [
    'SUPER_ADMIN', 
    'dahal_plsms', 'DAHAL_PLSMS', 'Dahal_plsms',
    'sdahal_plsms', 'SDAHAL_PLSMS', 'Sdahal_plsms',
    'public_handover_desk', 'PUBLIC_HANDOVER_DESK', 'Public_Handover_Desk',
    'admin_lead', 'ADMIN_LEAD', 
    'staff_operator', 'STAFF_OPERATOR', 
    'dispatch_staff', 'DISPATCH_STAFF', 
    'data_entry_staff', 'DATA_ENTRY_STAFF', 
    'computer_operator', 'COMPUTER_OPERATOR'
  ];
  const staffEmails = [
    'superadmin_role6@tmodl.gov.np', 
    'dahal_plsms@plsms.gov.bd', 
    'sdahal_plsms@plsms.local', 
    'sdahal_plsms@plsms.gov.bd', 
    'public_handover_desk@plsms.gov.bd', 
    'public search handover desk',
    'admin@tmodl.gov.np', 
    'staff@tmodl.gov.np', 
    'dispatch@tmodl.gov.np', 
    'dataentry@tmodl.gov.np', 
    'operator@tmodl.gov.np'
  ];

  if (typeof window !== 'undefined') {
    const mockRoles = fetchStorageItem<UserRole[]>('plsms_mock_roles', []);
    if (Array.isArray(mockRoles) && mockRoles.length > 0) {
      const filtered = mockRoles.filter(r => 
        !staffIds.some(s => s.toLowerCase() === (r.id || '').toLowerCase()) &&
        (!r.username || !staffIds.some(s => s.toLowerCase() === r.username.toLowerCase())) &&
        (!r.email || !staffEmails.some(se => se.toLowerCase() === r.email.toLowerCase()))
      );
      if (filtered.length !== mockRoles.length) {
        writeStorageItem('plsms_mock_roles', filtered);
      }
    }
  }

  for (const id of staffIds) {
    try {
      await deleteDoc(doc(db, 'users_roles', id));
      await deleteDoc(doc(db, 'users_roles', id.toLowerCase()));
      await deleteDoc(doc(db, 'system_security', `user_${id}`));
      await deleteDoc(doc(db, 'system_security', `user_${id.toLowerCase()}`));
    } catch (e) {}
  }
  for (const email of staffEmails) {
    try {
      const emailSanitized = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
      await deleteDoc(doc(db, 'system_security', `user_${emailSanitized}`));
      await deleteDoc(doc(db, 'users_roles', `user_${emailSanitized}`));
      await deleteDoc(doc(db, 'users_roles', email.toLowerCase()));
    } catch (e) {}
  }
}

export async function getAllUserRoles(forceRefresh: boolean = false): Promise<UserRole[]> {
  if (forceRefresh) {
    userRolesCache = null;
  }

  // Trigger background cleanup of purged staff accounts from storage and Firestore
  cleanupUnusedStaffAccounts().catch(() => {});

  const isRevoked = isUserRevoked;

  if (isDemoModeActive()) {
    let list = fetchStorageItem<UserRole[]>('plsms_mock_roles', DEFAULT_CREDENTIALS_MATRIX);
    if (!list || !Array.isArray(list) || list.length === 0) {
      list = [...DEFAULT_CREDENTIALS_MATRIX];
      writeStorageItem('plsms_mock_roles', list);
    } else {
      // Clean revoked items from local storage list
      const originalLen = list.length;
      list = list.filter(u => !isRevoked(u));

      // Ensure missing default super admin roles are safely restored without duplicates
      const existingIds = new Set(list.map(u => u.id));
      const existingEmails = new Set(list.map(u => (u.email || '').toLowerCase()));
      let added = false;
      for (const defUser of DEFAULT_CREDENTIALS_MATRIX) {
        if (!isRevoked(defUser) && !existingIds.has(defUser.id) && !existingEmails.has((defUser.email || '').toLowerCase())) {
          list.push(defUser);
          added = true;
        }
      }
      if (added || list.length !== originalLen) {
        writeStorageItem('plsms_mock_roles', list);
      }
    }
    
    // Sort oldest to newest
    list.sort((a, b) => {
      const timeA = a.createdAt || a.updatedAt || '';
      const timeB = b.createdAt || b.updatedAt || '';
      return timeA.localeCompare(timeB);
    });

    const localSecMap = getLocalSecurityCredentialsMap();
    const finalDemoList = list.filter(u => !isRevoked(u)).map(u => {
      const sec = localSecMap[u.id] || localSecMap[u.username || ''] || localSecMap[u.email?.toLowerCase() || ''];
      const mem = inMemoryDemoPasswords[u.id];
      return {
        ...u,
        passwordHash: u.passwordHash || sec?.passwordHash,
        isCustomPassword: u.isCustomPassword ?? sec?.isCustomPassword ?? (!!(u.passwordHash || sec?.passwordHash)),
        mustChangePassword: u.mustChangePassword ?? sec?.mustChangePassword
      };
    });
    return finalDemoList;
  }

  if (userRolesCache) {
    return userRolesCache.filter(u => !isRevoked(u));
  }
  
  try {
    const snap = await withFirestoreRetry(() => getDocs(collection(db, 'users_roles')));
    if (snap.empty) {
      // Seed Firestore with original-style matrix using parallel writes
      const writePromises = DEFAULT_CREDENTIALS_MATRIX.map(role => 
        setDoc(doc(db, 'users_roles', role.id), {
          displayName: role.displayName,
          username: role.username,
          email: role.email,
          role: role.role,
          mobile: role.mobile,
          post: role.post,
          status: role.status,
          createdAt: role.createdAt || role.updatedAt,
          updatedAt: role.updatedAt
        })
      );
      await Promise.all(writePromises);
      userRolesCache = DEFAULT_CREDENTIALS_MATRIX.filter(u => !isRevoked(u));
      return userRolesCache;
    }
    
    let mapped: UserRole[] = [];
    for (const d of snap.docs) {
      const data = d.data();
      const emailLower = (data.email || '').toLowerCase();

      let dispName = data.displayName || data.username || d.id;
      if (dispName === 'Super Admin (Lead)' || (emailLower === 'dahalkomal@gmail.com' && (!dispName || dispName === 'Super Admin (Lead)'))) {
        dispName = 'Komal Dahal';
      }

      mapped.push({
        id: d.id,
        username: data.username || d.id,
        displayName: dispName,
        email: data.email || '',
        role: data.role || 'staff',
        mobile: data.mobile || '',
        post: data.post || '',
        status: data.status || 'ACTIVE',
        createdAt: data.createdAt || data.updatedAt,
        updatedAt: data.updatedAt,
        ...data
      } as UserRole);
    }

    // Merge local custom created staff accounts from 'plsms_mock_roles' into Firestore result
    const existingIds = new Set(mapped.map(u => u.id));
    const existingEmails = new Set(mapped.map(u => (u.email || '').toLowerCase()));
    const existingUsernames = new Set(mapped.map(u => (u.username || '').toLowerCase()));

    const localMockRoles = fetchStorageItem<UserRole[]>('plsms_mock_roles', []);
    if (Array.isArray(localMockRoles)) {
      for (const mUser of localMockRoles) {
        if (!isRevoked(mUser)) {
          const matchIdx = mapped.findIndex(
            u => u.id === mUser.id || 
                 (u.username && mUser.username && u.username.toLowerCase() === mUser.username.toLowerCase()) ||
                 (u.email && mUser.email && u.email.toLowerCase() === mUser.email.toLowerCase())
          );
          if (matchIdx >= 0) {
            mapped[matchIdx] = { ...mapped[matchIdx], ...mUser };
          } else if (
            !existingIds.has(mUser.id) &&
            (!mUser.email || !existingEmails.has(mUser.email.toLowerCase())) &&
            (!mUser.username || !existingUsernames.has(mUser.username.toLowerCase()))
          ) {
            mapped.push(mUser);
            existingIds.add(mUser.id);
            if (mUser.email) existingEmails.add(mUser.email.toLowerCase());
            if (mUser.username) existingUsernames.add(mUser.username.toLowerCase());
          }
        }
      }
    }

    // Merge missing default roles from DEFAULT_CREDENTIALS_MATRIX into Firestore result
    for (const defUser of DEFAULT_CREDENTIALS_MATRIX) {
      if (
        !isRevoked(defUser) &&
        !existingIds.has(defUser.id) &&
        (!defUser.email || !existingEmails.has((defUser.email || '').toLowerCase())) &&
        (!defUser.username || !existingUsernames.has((defUser.username || '').toLowerCase()))
      ) {
        mapped.push(defUser);
      }
    }

    // Sort by creation date (oldest to newest)
    mapped.sort((a, b) => {
      const timeA = a.createdAt || a.updatedAt || '';
      const timeB = b.createdAt || b.updatedAt || '';
      return timeA.localeCompare(timeB);
    });

    const localSecMap = getLocalSecurityCredentialsMap();
    mapped = mapped.filter(u => !isRevoked(u)).map(u => {
      const sec = localSecMap[u.id] || localSecMap[u.username || ''] || localSecMap[u.email?.toLowerCase() || ''];
      return {
        ...u,
        passwordHash: u.passwordHash || sec?.passwordHash,
        isCustomPassword: u.isCustomPassword ?? sec?.isCustomPassword ?? (!!(u.passwordHash || sec?.passwordHash)),
        mustChangePassword: u.mustChangePassword ?? sec?.mustChangePassword
      };
    });

    mapped = ensureKomalDahalAccount(mapped);
    userRolesCache = mapped;
    return mapped;
  } catch (err) {
    const errorObj = err as any;
    const errMsg = errorObj instanceof Error ? errorObj.message : String(errorObj);
    const errCode = errorObj && typeof errorObj === 'object' && 'code' in errorObj ? String(errorObj.code) : '';
    const isQuota = 
      errCode === 'resource-exhausted' ||
      errCode.includes('resource-exhausted') ||
      errMsg.includes('Quota exceeded') ||
      errMsg.includes('quota limit exceeded') ||
      errMsg.includes('Quota limit exceeded') ||
      errMsg.toLowerCase().includes('quota') ||
      errMsg.toLowerCase().includes('exhausted');

    if (isQuota) {
      localStorage.setItem('plsms_quota_exceeded', 'true');
      safeDispatchEvent('plsms_demo_mode_changed');
      console.warn("Firestore users_roles fetch: Quota limit exceeded. Gracefully falling back to local offline schema defaults.");
    } else {
      console.warn("Firestore users_roles fetch offline/unavailable, serving default credentials matrix:", err);
    }
    let fallbackList = [...DEFAULT_CREDENTIALS_MATRIX];
    const localMockRoles = fetchStorageItem<UserRole[]>('plsms_mock_roles', []);
    if (Array.isArray(localMockRoles) && localMockRoles.length > 0) {
      const existingIds = new Set(fallbackList.map(u => u.id));
      for (const mUser of localMockRoles) {
        if (!isRevoked(mUser) && !existingIds.has(mUser.id)) {
          fallbackList.push(mUser);
          existingIds.add(mUser.id);
        }
      }
    }
    fallbackList.sort((a, b) => {
      const timeA = a.createdAt || a.updatedAt || '';
      const timeB = b.createdAt || b.updatedAt || '';
      return timeA.localeCompare(timeB);
    });
    return ensureKomalDahalAccount(fallbackList);
  }
}

export function subscribeToUserRoles(onUpdate: (roles: UserRole[]) => void): () => void {
  getAllUserRoles(true).then(roles => {
    onUpdate(ensureKomalDahalAccount(roles && roles.length > 0 ? roles : DEFAULT_CREDENTIALS_MATRIX));
  });

  const handleRolesUpdate = () => {
    getAllUserRoles(true).then(roles => {
      onUpdate(ensureKomalDahalAccount(roles && roles.length > 0 ? roles : DEFAULT_CREDENTIALS_MATRIX));
    });
  };

  let firestoreUnsub: (() => void) | null = null;
  try {
    firestoreUnsub = onSnapshot(collection(db, 'users_roles'), () => {
      handleRolesUpdate();
    }, (err) => {
      console.warn("Notice: Real-time user roles snapshot status:", err);
    });
  } catch (e) {}

  window.addEventListener('plsms_roles_changed', handleRolesUpdate);
  window.addEventListener('plsms_mock_roles_changed', handleRolesUpdate);
  window.addEventListener('storage', handleRolesUpdate);

  return () => {
    if (firestoreUnsub) firestoreUnsub();
    window.removeEventListener('plsms_roles_changed', handleRolesUpdate);
    window.removeEventListener('plsms_mock_roles_changed', handleRolesUpdate);
    window.removeEventListener('storage', handleRolesUpdate);
  };
}

export function resolveStaffName(email: string, usersRolesList: any[]): string {
  if (!email || email === 'system@plsms.gov.bd') return '';
  const emailLower = email.toLowerCase().trim();

  // 1. Check in loaded usersRoles list
  if (usersRolesList && Array.isArray(usersRolesList)) {
    const foundUser = usersRolesList.find(u => {
      const uUsername = (u.username || '').toLowerCase().trim();
      if (uUsername && uUsername === emailLower) return true;

      const uEmail = (u.email || '').toLowerCase().trim();
      if (uEmail && uEmail === emailLower) return true;
      
      const uId = (u.id || '').toLowerCase().trim();
      if (uId && uId === emailLower) return true;

      const uMobile = (u.mobile || '').trim();
      if (uMobile && uMobile === emailLower) return true;

      return false;
    });

    if (foundUser && foundUser.displayName) {
      return foundUser.displayName;
    }
  }

  // 2. Static fallbacks with specific overrides
  if (emailLower === 'dahalkomal@gmail.com') return 'SUPER ADMIN';
  if (emailLower === 'dahalutkrishta@gmail.com') return 'UTKRISHTA DAHAL';
  if (emailLower === 'public search handover desk') return 'Public Handover Desk';

  const prefix = email.split('@')[0];
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

export async function saveUserRole(id: string, data: any): Promise<void> {
  userRolesCache = null; // Invalidate cache

  const rawPass = data.password || data.customPassword || data.newPassword || data.customStoredPassword || data.temporaryPassword;
  let passHash = data.passwordHash;
  if (rawPass && !passHash) {
    passHash = await hashCredential(rawPass);
  }

  // Fetch current version if present
  let existingVersion = data.passwordVersion || 1;
  try {
    const snap = await getDoc(doc(db, 'users_roles', id));
    if (snap.exists()) {
      const snapData = snap.data();
      if (snapData.passwordVersion) {
        existingVersion = snapData.passwordVersion;
      }
    }
  } catch (e) {}

  const nextVer = passHash ? existingVersion + 1 : existingVersion;
  const now = new Date().toISOString();

  // Strip all plaintext password fields from the payload
  const { customStoredPassword, temporaryPassword, password, newPassword, customPassword, ...cleanData } = data;

  const rolePayload: Record<string, any> = {
    ...cleanData,
    id,
    passwordHash: passHash || data.passwordHash || '',
    passwordVersion: nextVer,
    passwordLastChanged: passHash ? now : (data.passwordLastChanged || now),
    mustChangePassword: data.mustChangePassword ?? false,
    isCustomPassword: true,
    updatedAt: now,
    updatedBy: data.updatedBy || 'Super_Admin'
  };

  // Ensure plaintext fields are explicitly deleted
  delete rolePayload.customStoredPassword;
  delete rolePayload.temporaryPassword;
  delete rolePayload.password;

  await saveUserSecurityCredentials(id, {
    userId: id,
    email: data.email || '',
    passwordHash: rolePayload.passwordHash,
    passwordVersion: rolePayload.passwordVersion,
    mustChangePassword: rolePayload.mustChangePassword
  });

  // Always update local storage mock roles so the user is guaranteed present across state reloads
  const localList = fetchStorageItem<UserRole[]>('plsms_mock_roles', []) || [];
  const localIdx = localList.findIndex(r => r.id === id || (r.username && rolePayload.username && r.username.toLowerCase() === rolePayload.username.toLowerCase()));
  if (localIdx >= 0) {
    localList[localIdx] = { ...localList[localIdx], ...rolePayload } as UserRole;
  } else {
    localList.push(rolePayload as UserRole);
  }
  writeStorageItem('plsms_mock_roles', localList);

  if (isDemoModeActive()) {
    userRolesCache = null;
    safeDispatchEvent('plsms_mock_roles_changed');
    safeDispatchEvent('plsms_roles_changed');
    return;
  }

  try {
    await setDoc(doc(db, 'users_roles', id), rolePayload, { merge: true });
  } catch (err: any) {
    console.warn("Notice: Firestore write to users_roles notice:", err);
  }
  userRolesCache = null;
  safeDispatchEvent('plsms_mock_roles_changed');
  safeDispatchEvent('plsms_roles_changed');
}

export async function deleteUserRole(id: string, targetUser?: UserRole): Promise<void> {
  userRolesCache = null; // Invalidate cache
  const revoked = fetchStorageItem<string[]>('plsms_revoked_user_ids', []);
  
  const addIfNew = (val?: string) => {
    if (!val) return;
    const lower = val.toLowerCase();
    if (!revoked.includes(val)) revoked.push(val);
    if (!revoked.includes(lower)) revoked.push(lower);
  };

  addIfNew(id);
  if (targetUser) {
    addIfNew(targetUser.id);
    addIfNew(targetUser.username);
    addIfNew(targetUser.email);
  }

  writeStorageItem('plsms_revoked_user_ids', revoked);

  // Remove from local storage mock roles
  const list = fetchStorageItem<UserRole[]>('plsms_mock_roles', []);
  if (Array.isArray(list) && list.length > 0) {
    const filtered = list.filter(r => 
      r.id.toLowerCase() !== id.toLowerCase() && 
      (!r.username || r.username.toLowerCase() !== id.toLowerCase()) && 
      (!targetUser || (
        r.id.toLowerCase() !== targetUser.id.toLowerCase() &&
        (!r.username || !targetUser.username || r.username.toLowerCase() !== targetUser.username.toLowerCase()) &&
        (!r.email || !targetUser.email || r.email.toLowerCase() !== targetUser.email.toLowerCase())
      ))
    );
    writeStorageItem('plsms_mock_roles', filtered);
  }

  try {
    await deleteDoc(doc(db, 'users_roles', id));
  } catch (err) {
    console.warn("Firestore deleteDoc users_roles warning:", err);
  }

  try {
    await deleteDoc(doc(db, 'system_security', `user_${id}`));
  } catch (err) {
    console.warn("Firestore deleteDoc system_security warning:", err);
  }

  if (targetUser) {
    if (targetUser.id && targetUser.id !== id) {
      try {
        await deleteDoc(doc(db, 'users_roles', targetUser.id));
        await deleteDoc(doc(db, 'system_security', `user_${targetUser.id}`));
      } catch (e) {}
    }
    if (targetUser.email) {
      try {
        const emailSanitized = targetUser.email.toLowerCase().replace(/[^a-z0-9]/g, '_');
        await deleteDoc(doc(db, 'system_security', `user_${emailSanitized}`));
        await deleteDoc(doc(db, 'users_roles', `user_${emailSanitized}`));
        await deleteDoc(doc(db, 'users_roles', targetUser.email.toLowerCase()));
      } catch (e) {}
    }
    if (targetUser.username) {
      try {
        await deleteDoc(doc(db, 'users_roles', targetUser.username));
        await deleteDoc(doc(db, 'system_security', `user_${targetUser.username}`));
      } catch (e) {}
    }
  }

  safeDispatchEvent('plsms_mock_roles_changed');
  safeDispatchEvent('plsms_roles_changed');
}

export async function seedAllDemoDataToFirestore(): Promise<void> {
  if (typeof window !== "undefined" && localStorage.getItem('plsms_last_seeded') === 'true') {
    return;
  }
  console.log("Dynamically seeding office settings and user roles into Original Cloud Firestore...");
  try {
    const settingsRef = doc(db, 'office_settings', 'settings');
    
    // Fetch settings and roles to check if they exist
    const [settingsSnap, rolesSnap] = await Promise.all([
      getDoc(settingsRef),
      getDocs(collection(db, 'users_roles'))
    ]);

    const writePromises: Promise<any>[] = [];

    // 1. Seed Office Settings
    if (!settingsSnap.exists()) {
      console.log("Firestore office settings is empty. Seeding initial settings...");
      const liveSettings = {
        ...initialMockSettings,
        officeName: "Transport Management Office, Driving License",
        officeAddress: "Itahari, Sunsari, Nepal",
        homepageBanner: "Welcome to Transport Management Office Driving License Records Center",
        websiteFooter: "© 2026 Transport Management Office, Driving License, Itahari, Sunsari. Authorized Use Only. All operations are logged and monitored for security compliance."
      };
      writePromises.push(setDoc(settingsRef, liveSettings));
    }

    // 2. Seed Users & Roles
    if (rolesSnap.empty) {
      console.log("Firestore users_roles is empty. Seeding team roles...");
      DEFAULT_CREDENTIALS_MATRIX.forEach(role => {
        writePromises.push(setDoc(doc(db, 'users_roles', role.id), {
          displayName: role.displayName,
          email: role.email,
          role: role.role,
          mobile: role.mobile,
          post: role.post,
          status: role.status,
          updatedAt: role.updatedAt
        }));
      });
    }

    if (writePromises.length > 0) {
      await Promise.all(writePromises);
    }
    
    if (typeof window !== "undefined") {
      localStorage.setItem('plsms_last_seeded', 'true');
    }
  } catch (err) {
    console.warn("Dynamic Firestore database auto-seed skipped or restricted: ", err);
  }
}

export async function forceSeedDemoDataToFirestore(): Promise<void> {
  console.log("FORCE Seeding office settings and user credentials matrix to live Cloud Firestore...");
  
  const settingsRef = doc(db, 'office_settings', 'settings');
  const writePromises: Promise<any>[] = [
    setDoc(settingsRef, {
      ...initialMockSettings,
      officeName: "Transport Management Office, Driving License",
      officeAddress: "Itahari, Sunsari, Nepal",
      homepageBanner: "Welcome to Transport Management Office Driving License Records Center",
      websiteFooter: "© 2026 Transport Management Office, Driving License, Itahari, Sunsari. Authorized Use Only. All operations are logged and monitored for security compliance."
    })
  ];

  // Force seed users & roles matrix
  DEFAULT_CREDENTIALS_MATRIX.forEach(role => {
    writePromises.push(setDoc(doc(db, 'users_roles', role.id), {
      displayName: role.displayName,
      email: role.email,
      role: role.role,
      mobile: role.mobile,
      post: role.post,
      status: role.status,
      updatedAt: role.updatedAt
    }));
  });

  await Promise.all(writePromises);
  
  if (typeof window !== "undefined") {
    localStorage.setItem('plsms_last_seeded', 'true');
  }
}

export function hasCustomDemoChanges(): boolean {
  const settings = localStorage.getItem('plsms_mock_settings');
  const licenses = localStorage.getItem('plsms_mock_licenses');
  const notices = localStorage.getItem('plsms_mock_notices');
  const requests = localStorage.getItem('plsms_mock_requests');
  const roles = localStorage.getItem('plsms_mock_roles');
  return !!(settings || licenses || notices || requests || roles);
}

export async function restoreDemoChangesToFirestore(): Promise<void> {
  console.log("Restoring active settings and roles changes to live Cloud Firestore database...");
  
  // 1. Settings
  const localSettingsStr = localStorage.getItem('plsms_mock_settings');
  if (localSettingsStr) {
    try {
      const localSettings = JSON.parse(localSettingsStr) as OfficeSettings;
      // We clean up "(Demo)" tags to keep live Firestore looking premium and clean
      const liveSettings: OfficeSettings = {
        ...localSettings,
        officeName: localSettings.officeName.replace(/\s*\(Demo\)/gi, '').trim(),
        homepageBanner: localSettings.homepageBanner.replace(/\s*\[Demo Database\]/gi, '').replace(/\s*\(Demo\)/gi, '').trim(),
        websiteFooter: localSettings.websiteFooter.replace(/\s*\[DEMO MODE ACTIVE\]/gi, '').replace(/\s*\(Demo\)/gi, '').trim()
      };
      const settingsRef = doc(db, 'office_settings', 'settings');
      await setDoc(settingsRef, liveSettings);
    } catch (e) {
      console.error("Failed to sync settings from local storage to Firestore:", e);
    }
  }

  // 2. User Roles
  const localRolesStr = localStorage.getItem('plsms_mock_roles');
  if (localRolesStr) {
    try {
      const localRoles = JSON.parse(localRolesStr) as UserRole[];
      for (const role of localRoles) {
        await setDoc(doc(db, 'users_roles', role.id), {
          displayName: role.displayName,
          email: role.email,
          role: role.role,
          mobile: role.mobile,
          post: role.post,
          status: role.status,
          updatedAt: role.updatedAt,
          passwordHash: role.passwordHash || '',
          passwordVersion: role.passwordVersion || 1,
          mustChangePassword: role.mustChangePassword ?? false
        }, { merge: true });
      }
    } catch (e) {
      console.error("Failed to sync user roles from local storage to Firestore:", e);
    }
  }
}

// ==================== UPLOAD LEDGERS SERVICES ====================

export async function getAllUploadLedgers(): Promise<UploadLedger[]> {
  if (isDemoModeActive()) {
    return fetchStorageItem<UploadLedger[]>('plsms_mock_ledgers', []);
  }
  if (!auth.currentUser) {
    return [];
  }
  try {
    const q = query(collection(db, 'upload_ledgers'), orderBy('timestamp', 'desc'));
    const snap = await getDocs(q);
    const list: UploadLedger[] = [];
    snap.forEach(doc => {
      list.push(doc.data() as UploadLedger);
    });
    return list;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'upload_ledgers');
    return [];
  }
}

export async function createUploadLedger(ledger: UploadLedger): Promise<void> {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (isDemoModeActive()) {
    const list = fetchStorageItem<UploadLedger[]>('plsms_mock_ledgers', []);
    list.forEach(l => { l.isActive = false; });
    const versionNumber = ledger.versionNumber || (list.length + 1);
    const enriched: UploadLedger = {
      ...ledger,
      versionNumber,
      isActive: true,
      uploadDate: ledger.uploadDate || dateStr,
      uploadTime: ledger.uploadTime || timeStr,
      status: ledger.status || 'Verified'
    };
    const cleanEnriched = Object.fromEntries(
      Object.entries(enriched).filter(([_, v]) => v !== undefined)
    ) as UploadLedger;
    list.unshift(cleanEnriched);
    writeStorageItem('plsms_mock_ledgers', list);
    return;
  }
  try {
    const existingLedgers = await getAllUploadLedgers();
    const versionNumber = ledger.versionNumber || (existingLedgers.length + 1);

    const { writeBatch } = await import('firebase/firestore');
    const batch = writeBatch(db);

    existingLedgers.forEach(l => {
      if (l.isActive) {
        batch.update(doc(db, 'upload_ledgers', l.id), { isActive: false });
      }
    });

    const enriched: UploadLedger = {
      ...ledger,
      versionNumber,
      isActive: true,
      uploadDate: ledger.uploadDate || dateStr,
      uploadTime: ledger.uploadTime || timeStr,
      status: ledger.status || 'Verified'
    };

    const cleanEnriched = Object.fromEntries(
      Object.entries(enriched).filter(([_, v]) => v !== undefined)
    ) as UploadLedger;

    batch.set(doc(db, 'upload_ledgers', ledger.id), cleanEnriched);
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `upload_ledgers/${ledger.id}`);
  }
}

export async function updateUploadLedgerStatus(id: string, status: 'Completed' | 'Restored' | 'Deleted' | 'Verified' | 'Failed'): Promise<void> {
  if (isDemoModeActive()) {
    const list = fetchStorageItem<UploadLedger[]>('plsms_mock_ledgers', []);
    const idx = list.findIndex(l => l.id === id);
    if (idx >= 0) {
      list[idx].status = status;
      writeStorageItem('plsms_mock_ledgers', list);
    }
    return;
  }
  try {
    await updateDoc(doc(db, 'upload_ledgers', id), { status });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `upload_ledgers/${id}`);
  }
}

export async function saveLedgerRecordBackup(ledgerId: string, license: License): Promise<void> {
  if (isDemoModeActive()) {
    const list = fetchStorageItem<License[]>('plsms_mock_ledger_backups_' + ledgerId, []);
    list.push(license);
    writeStorageItem('plsms_mock_ledger_backups_' + ledgerId, list);
    return;
  }
  try {
    await setDoc(doc(db, 'upload_ledgers', ledgerId, 'records', license.id), license);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `upload_ledgers/${ledgerId}/records/${license.id}`);
  }
}

export async function getLedgerRecordBackups(ledgerId: string): Promise<License[]> {
  if (isDemoModeActive()) {
    return fetchStorageItem<License[]>('plsms_mock_ledger_backups_' + ledgerId, []);
  }
  try {
    const snap = await getDocs(collection(db, 'upload_ledgers', ledgerId, 'records'));
    const list: License[] = [];
    snap.forEach(doc => {
      list.push(doc.data() as License);
    });
    return list;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, `upload_ledgers/${ledgerId}/records`);
  }
}

export async function restoreUploadLedger(ledgerId: string): Promise<void> {
  const backups = await getLedgerRecordBackups(ledgerId);
  if (backups.length === 0) {
    throw new Error("No backup records found to restore.");
  }

  // Restore each backup record back to /licenses
  if (isDemoModeActive()) {
    const list = fetchStorageItem<License[]>('plsms_mock_licenses', []);
    backups.forEach(backup => {
      const idx = list.findIndex(l => l.id === backup.id);
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...backup, status: 'available' };
      } else {
        list.push({ ...backup, status: 'available' });
      }
    });
    writeStorageItem('plsms_mock_licenses', list);
  } else {
    // Firestore batch write in chunks of 500
    const { writeBatch } = await import('firebase/firestore');
    let batch = writeBatch(db);
    let count = 0;

    for (const record of backups) {
      const restoredRecord = {
        ...record,
        status: 'available',
        updatedAt: new Date().toISOString(),
        updatedBy: auth.currentUser?.email || 'admin@plsms.gov'
      };
      batch.set(doc(db, 'licenses', record.id), restoredRecord);
      count++;

      if (count === 500) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    }
    if (count > 0) {
      await batch.commit();
    }
  }

  // Update ledger status
  await updateUploadLedgerStatus(ledgerId, 'Restored');
}

export async function deleteUploadLedgerRowOnly(ledgerId: string): Promise<void> {
  if (isDemoModeActive()) {
    let list = fetchStorageItem<UploadLedger[]>('plsms_mock_ledgers', []);
    list = list.filter(l => l.id !== ledgerId);
    writeStorageItem('plsms_mock_ledgers', list);
    return;
  }
  try {
    await deleteDoc(doc(db, 'upload_ledgers', ledgerId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `upload_ledgers/${ledgerId}`);
  }
}

export async function deleteUploadLedgerRecords(ledgerId: string): Promise<void> {
  const backups = await getLedgerRecordBackups(ledgerId);
  
  // Delete from /licenses
  if (isDemoModeActive()) {
    let list = fetchStorageItem<License[]>('plsms_mock_licenses', []);
    const backupIds = new Set(backups.map(b => b.id));
    list = list.filter(l => !backupIds.has(l.id));
    writeStorageItem('plsms_mock_licenses', list);
  } else {
    // Firestore batch delete in chunks of 500
    const { writeBatch } = await import('firebase/firestore');
    let batch = writeBatch(db);
    let count = 0;

    for (const record of backups) {
      batch.delete(doc(db, 'licenses', record.id));
      count++;

      if (count === 500) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    }
    if (count > 0) {
      await batch.commit();
    }
  }

  // Update ledger status to Deleted
  await updateUploadLedgerStatus(ledgerId, 'Deleted');
}

export interface SecurityAuditLog {
  timestamp: string;
  username: string;
  ipAddress: string;
  status: string;
  reason: string;
  superAdminEmail?: string;
  deletedBy?: string;
  deletedUser?: string;
  role?: string;
  date?: string;
  time?: string;
  totalRecordsDeleted?: number;
  deviceSession?: string;
}

export async function saveSecurityAuditLog(log: SecurityAuditLog): Promise<void> {
  if (isDemoModeActive()) {
    const list = fetchStorageItem<SecurityAuditLog[]>('plsms_security_audit_logs', []);
    list.push(log);
    writeStorageItem('plsms_security_audit_logs', list);
    return;
  }
  await addDoc(collection(db, 'security_audit_logs'), log);
}

export async function purgeAllDatabaseRecordsAndLedgers(): Promise<number> {
  if (isDemoModeActive()) {
    let total = 0;
    const lics = fetchStorageItem<any[]>('plsms_mock_licenses', []);
    const ledgers = fetchStorageItem<any[]>('plsms_mock_ledgers', []);
    const requests = fetchStorageItem<any[]>('plsms_mock_requests', []);
    const logs = fetchStorageItem<any[]>('plsms_security_audit_logs', []);
    
    total += lics.length + ledgers.length + requests.length + logs.length;
    
    writeStorageItem('plsms_mock_licenses', []);
    writeStorageItem('plsms_mock_ledgers', []);
    writeStorageItem('plsms_mock_requests', []);
    writeStorageItem('plsms_security_audit_logs', []);
    writeStorageItem('plsms_mock_stats', { totalSearchesServed: 0 });
    
    // Clear ledger backups from local storage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('plsms_mock_ledger_backups_')) {
        localStorage.removeItem(key);
        total++;
      }
    }
    return total;
  }

  // Clear local storage caches in all modes
  writeStorageItem('plsms_mock_licenses', []);
  writeStorageItem('plsms_mock_ledgers', []);
  writeStorageItem('plsms_mock_requests', []);
  writeStorageItem('plsms_security_audit_logs', []);
  writeStorageItem('plsms_mock_stats', { totalSearchesServed: 0 });
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('plsms_mock_ledger_backups_') || key.startsWith('plsms_registry_cache'))) {
        localStorage.removeItem(key);
      }
    }
  } catch (e) {
    console.warn("Error cleaning local storage during purge:", e);
  }

  const { writeBatch } = await import('firebase/firestore');
  let totalDeleted = 0;

  // 1. Delete all licenses
  const licensesQuery = await getDocs(collection(db, 'licenses'));
  let batch = writeBatch(db);
  let count = 0;
  for (const docSnap of licensesQuery.docs) {
    batch.delete(docSnap.ref);
    count++;
    totalDeleted++;
    if (count === 500) {
      await batch.commit();
      batch = writeBatch(db);
      count = 0;
    }
  }
  if (count > 0) {
    await batch.commit();
  }

  // 2. Delete all upload ledgers and their subcollection records
  const ledgersQuery = await getDocs(collection(db, 'upload_ledgers'));
  for (const ledgerDoc of ledgersQuery.docs) {
    const recordsQuery = await getDocs(collection(db, 'upload_ledgers', ledgerDoc.id, 'records'));
    batch = writeBatch(db);
    count = 0;
    for (const recordDoc of recordsQuery.docs) {
      batch.delete(recordDoc.ref);
      count++;
      totalDeleted++;
      if (count === 500) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    }
    if (count > 0) {
      await batch.commit();
    }
    
    // Delete the ledger document itself
    await deleteDoc(ledgerDoc.ref);
    totalDeleted++;
  }

  // 3. Delete all collection requests
  const requestsQuery = await getDocs(collection(db, 'collection_requests'));
  batch = writeBatch(db);
  count = 0;
  for (const docSnap of requestsQuery.docs) {
    batch.delete(docSnap.ref);
    count++;
    totalDeleted++;
    if (count === 500) {
      await batch.commit();
      batch = writeBatch(db);
      count = 0;
    }
  }
  if (count > 0) {
    await batch.commit();
  }

  // 4. Skip notices deletion to preserve administrative/announcement notices
  // Notices are managed by Super Admin and should remain untouched during standard resets.

  // 5. Delete existing security audit logs (except any incoming ones, we do it in a fresh batch)
  try {
    const auditQuery = await getDocs(collection(db, 'security_audit_logs'));
    batch = writeBatch(db);
    count = 0;
    for (const docSnap of auditQuery.docs) {
      batch.delete(docSnap.ref);
      count++;
      totalDeleted++;
      if (count === 500) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    }
    if (count > 0) {
      await batch.commit();
    }
  } catch (auditErr) {
    console.warn("Failed to delete existing security audit logs:", auditErr);
  }

  // 6. Reset search served statistics
  try {
    const statRef = doc(db, 'statistics', 'search_served');
    await setDoc(statRef, { totalSearchesServed: 0 });
    totalDeleted++;
  } catch (err) {
    console.warn("Failed to reset statistics document:", err);
  }

  return totalDeleted;
}

// ==================== PERMANENT EXCEL ARCHIVE & UPLOAD HISTORY SERVICES ====================

export async function archiveExcelToStorage(file: File): Promise<string> {
  const now = new Date();
  try {
    const sanitizedFileName = file.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const storagePath = `excel_archives/${now.getTime()}_${sanitizedFileName}`;
    const storageRef = ref(storage, storagePath);
    const snapshot = await uploadBytes(storageRef, file);
    return await getDownloadURL(snapshot.ref);
  } catch (storageErr) {
    console.warn("Firebase Storage archive warning (using secure reference fallback):", storageErr);
    return `archive://${file.name}?size=${file.size}&t=${now.getTime()}`;
  }
}

export async function archiveExcelToStorageAndUploadHistory(
  file: File,
  uploadedBy: string,
  totalRecords: number
): Promise<{ historyId: string; versionNumber: number; fileUrl: string }> {
  const fileUrl = await archiveExcelToStorage(file);
  return { historyId: '', versionNumber: 1, fileUrl };
}

export async function updateUploadHistoryStatus(
  historyId: string,
  status: 'Completed' | 'Failed',
  importedRecordCount: number,
  metrics?: VerificationMetrics
): Promise<void> {
  if (historyId) {
    const mappedStatus = status === 'Completed' ? 'Verified' : 'Failed';
    await updateUploadLedgerStatus(historyId, mappedStatus);
  }
}

export async function getAllUploadHistory(): Promise<UploadHistoryRecord[]> {
  const ledgers = await getAllUploadLedgers();
  return ledgers.map(l => ({
    id: l.id,
    originalFileName: l.fileName,
    fileUrl: l.fileUrl || '',
    uploadDate: l.uploadDate || '',
    uploadTime: l.uploadTime || '',
    uploadedBy: l.uploader,
    totalRecords: l.noOfLoadedRecords,
    fileSize: l.size,
    uploadStatus: l.status === 'Verified' || l.status === 'Completed' ? 'Completed' : 'Failed',
    versionNumber: l.versionNumber || 1,
    activeVersion: !!l.isActive,
    importedRecordCount: l.importedRecords,
    timestamp: l.timestamp,
    ...l
  } as UploadHistoryRecord));
}

// ==================== ALPHABETICAL AGGREGATION ENGINE ====================

export interface AlphabetStat {
  alphabet: string;
  count: number;
  distributed: number;
  remained: number;
}

export interface AlphabeticalSummaryResult {
  alphabetStats: AlphabetStat[];
  totalCount: number;
  totalDistributed: number;
  totalRemained: number;
}

export async function getAlphabeticalSummary(startDateBS?: string, endDateBS?: string): Promise<AlphabeticalSummaryResult> {
  const storeRecords = registryDataStore.getRecords();
  const storageRecords = fetchStorageItem<License[]>('plsms_mock_licenses', initialMockLicenses);
  let list = storeRecords.length >= storageRecords.length ? storeRecords : storageRecords;

  const getLicenseBSDateForSummary = (lic: License): string => {
    if (lic.distributionDate && typeof lic.distributionDate === 'string' && lic.distributionDate.trim()) {
      const d = lic.distributionDate.trim();
      if (d.includes('-') && d.length === 10 && !d.includes('T')) return d;
    }
    if (lic.distributedDate && typeof lic.distributedDate === 'string' && lic.distributedDate.trim()) {
      const d = lic.distributedDate.trim();
      if (d.includes('-') && d.length === 10 && !d.includes('T')) return d;
    }
    if (lic.missingDate && typeof lic.missingDate === 'string' && lic.missingDate.trim()) {
      const d = lic.missingDate.trim();
      if (d.includes('-') && d.length === 10 && !d.includes('T')) return d;
    }
    if (lic.foundDate && typeof lic.foundDate === 'string' && lic.foundDate.trim()) {
      const d = lic.foundDate.trim();
      if (d.includes('-') && d.length === 10 && !d.includes('T')) return d;
    }
    const deptDay1 = lic.contactDepartment || lic.officeVisitDay;
    if (deptDay1 && typeof deptDay1 === 'string' && deptDay1.trim()) {
      const d = deptDay1.trim();
      if (d.includes('-') && d.length === 10 && !d.includes('T')) return d;
    }
    const adDate = lic.createdAt || lic.updatedAt || '';
    if (adDate) {
      return convertADToBS(adDate);
    }
    return '';
  };

  const hasDateFilter = Boolean(startDateBS || endDateBS);

  if (hasDateFilter) {
    const bestList = await getBestAvailableLicenses();
    if (bestList.length > list.length) {
      list = bestList;
    }
    list = list.filter(lic => {
      const bs = getLicenseBSDateForSummary(lic);
      if (startDateBS && bs && bs < startDateBS) return false;
      if (endDateBS && bs && bs > endDateBS) return false;
      return true;
    });
  }

  // Helper to extract first character / alphabet
  const getFirstAlpha = (name: string): string => {
    const cleanName = (name || '').trim().toUpperCase();
    if (!cleanName) return '';
    const firstChar = cleanName[0];
    if (firstChar >= 'A' && firstChar <= 'Z') {
      return firstChar;
    }
    return firstChar;
  };

  if (hasDateFilter || isDemoModeActive()) {
    const alphabets = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

    const statsMap: Record<string, { count: number; distributed: number }> = {};
    alphabets.forEach(alpha => {
      statsMap[alpha] = { count: 0, distributed: 0 };
    });

    let otherCount = 0;
    let otherDistributed = 0;

    let overallTotal = list.length;
    let overallDistributed = 0;

    list.forEach(lic => {
      const isDist = lic.status === 'distributed' || lic.status === 'found' || isLicenseDistributed(lic);
      if (isDist) overallDistributed++;

      const firstChar = getFirstAlpha(lic.fullName);
      if (firstChar >= 'A' && firstChar <= 'Z') {
        statsMap[firstChar].count++;
        if (isDist) statsMap[firstChar].distributed++;
      } else if (firstChar) {
        otherCount++;
        if (isDist) otherDistributed++;
      }
    });

    const stats: AlphabetStat[] = alphabets.map(alpha => {
      const item = statsMap[alpha] || { count: 0, distributed: 0 };
      return {
        alphabet: alpha,
        count: item.count,
        distributed: item.distributed,
        remained: Math.max(0, item.count - item.distributed)
      };
    });

    if (otherCount > 0) {
      stats.push({
        alphabet: 'OTHERS / अन्य',
        count: otherCount,
        distributed: otherDistributed,
        remained: Math.max(0, otherCount - otherDistributed)
      });
    }

    const overallRemained = Math.max(0, overallTotal - overallDistributed);

    return {
      alphabetStats: stats,
      totalCount: overallTotal,
      totalDistributed: overallDistributed,
      totalRemained: overallRemained
    };
  }

  // Live Firestore aggregation using getCountFromServer
  try {
    const col = collection(db, 'licenses');
    const alphabets = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

    // Get exact KPI totals from server
    const kpi = await getDashboardKpiCounts();

    const promises = alphabets.map(async (alpha) => {
      const nextChar = alpha === 'Z' ? 'Z\uf8ff' : String.fromCharCode(alpha.charCodeAt(0) + 1);
      const lowerAlpha = alpha.toLowerCase();
      const lowerNextChar = lowerAlpha === 'z' ? 'z\uf8ff' : String.fromCharCode(lowerAlpha.charCodeAt(0) + 1);

      let total = 0;
      let dist = 0;

      try {
        // Upper-case query
        const upperTotalSnap = await getCountFromServer(query(
          col,
          where('fullName', '>=', alpha),
          where('fullName', '<', nextChar)
        ));
        total += upperTotalSnap.data().count;

        // Lower-case query
        const lowerTotalSnap = await getCountFromServer(query(
          col,
          where('fullName', '>=', lowerAlpha),
          where('fullName', '<', lowerNextChar)
        ));
        total += lowerTotalSnap.data().count;

        // Distributed query
        try {
          const upperDistSnap = await getCountFromServer(query(
            col,
            where('fullName', '>=', alpha),
            where('fullName', '<', nextChar),
            where('status', 'in', ['distributed', 'found'])
          ));
          dist += upperDistSnap.data().count;

          const lowerDistSnap = await getCountFromServer(query(
            col,
            where('fullName', '>=', lowerAlpha),
            where('fullName', '<', lowerNextChar),
            where('status', 'in', ['distributed', 'found'])
          ));
          dist += lowerDistSnap.data().count;
        } catch {
          // Fallback if status + fullName index is not built
          const upperDistOnly = await getCountFromServer(query(
            col,
            where('fullName', '>=', alpha),
            where('fullName', '<', nextChar),
            where('status', '==', 'distributed')
          ));
          const upperFoundOnly = await getCountFromServer(query(
            col,
            where('fullName', '>=', alpha),
            where('fullName', '<', nextChar),
            where('status', '==', 'found')
          ));
          dist += upperDistOnly.data().count + upperFoundOnly.data().count;

          const lowerDistOnly = await getCountFromServer(query(
            col,
            where('fullName', '>=', lowerAlpha),
            where('fullName', '<', lowerNextChar),
            where('status', '==', 'distributed')
          ));
          const lowerFoundOnly = await getCountFromServer(query(
            col,
            where('fullName', '>=', lowerAlpha),
            where('fullName', '<', lowerNextChar),
            where('status', '==', 'found')
          ));
          dist += lowerDistOnly.data().count + lowerFoundOnly.data().count;
        }
      } catch (qErr) {
        console.warn(`Query for letter ${alpha} failed:`, qErr);
      }

      return {
        alphabet: alpha,
        count: total,
        distributed: dist,
        remained: Math.max(0, total - dist)
      };
    });

    const stats = await Promise.all(promises);

    const sumCount = stats.reduce((acc, curr) => acc + curr.count, 0);
    const sumDist = stats.reduce((acc, curr) => acc + curr.distributed, 0);

    const otherCount = Math.max(0, kpi.totalRecords - sumCount);
    const otherDist = Math.max(0, kpi.distributedCount - sumDist);

    if (otherCount > 0) {
      stats.push({
        alphabet: 'OTHERS / अन्य',
        count: otherCount,
        distributed: otherDist,
        remained: Math.max(0, otherCount - otherDist)
      });
    }

    clearQuotaExceededFlag();

    return {
      alphabetStats: stats,
      totalCount: kpi.totalRecords,
      totalDistributed: kpi.distributedCount,
      totalRemained: kpi.notDistributedCount
    };
  } catch (err) {
    console.warn("Firestore alphabetical aggregation failed:", err);
    checkAndTriggerQuotaError(err);
    const kpi = await getDashboardKpiCounts();
    const alphabets = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    const stats: AlphabetStat[] = alphabets.map(alpha => ({
      alphabet: alpha,
      count: 0,
      distributed: 0,
      remained: 0
    }));
    return {
      alphabetStats: stats,
      totalCount: kpi.totalRecords,
      totalDistributed: kpi.distributedCount,
      totalRemained: kpi.notDistributedCount
    };
  }
}

export async function getLicensesByAlphabet(alpha: string, startDateBS?: string, endDateBS?: string): Promise<License[]> {
  const getLicenseBSDate = (lic: License): string => {
    if (lic.distributionDate && typeof lic.distributionDate === 'string' && lic.distributionDate.trim()) {
      const d = lic.distributionDate.trim();
      if (d.includes('-') && d.length === 10 && !d.includes('T')) return d;
    }
    if (lic.distributedDate && typeof lic.distributedDate === 'string' && lic.distributedDate.trim()) {
      const d = lic.distributedDate.trim();
      if (d.includes('-') && d.length === 10 && !d.includes('T')) return d;
    }
    if (lic.missingDate && typeof lic.missingDate === 'string' && lic.missingDate.trim()) {
      const d = lic.missingDate.trim();
      if (d.includes('-') && d.length === 10 && !d.includes('T')) return d;
    }
    if (lic.foundDate && typeof lic.foundDate === 'string' && lic.foundDate.trim()) {
      const d = lic.foundDate.trim();
      if (d.includes('-') && d.length === 10 && !d.includes('T')) return d;
    }
    const deptDay2 = lic.contactDepartment || lic.officeVisitDay;
    if (deptDay2 && typeof deptDay2 === 'string' && deptDay2.trim()) {
      const d = deptDay2.trim();
      if (d.includes('-') && d.length === 10 && !d.includes('T')) return d;
    }
    const adDate = lic.createdAt || lic.updatedAt || '';
    if (adDate) {
      return convertADToBS(adDate);
    }
    return '';
  };

  if (startDateBS || endDateBS || isDemoModeActive()) {
    const list = await getBestAvailableLicenses();
    const cleanAlpha = alpha.toUpperCase();
    return list.filter(l => {
      const name = (l.fullName || '').trim().toUpperCase();
      let matchesAlpha = false;
      if (cleanAlpha.startsWith('OTHERS')) {
        const first = name[0] || '';
        matchesAlpha = !(first >= 'A' && first <= 'Z');
      } else {
        matchesAlpha = name.startsWith(cleanAlpha);
      }
      if (!matchesAlpha) return false;

      if (startDateBS || endDateBS) {
        const bs = getLicenseBSDate(l);
        if (startDateBS && bs && bs < startDateBS) return false;
        if (endDateBS && bs && bs > endDateBS) return false;
      }
      return true;
    });
  }

  try {
    const col = collection(db, 'licenses');
    const cleanAlpha = alpha.toUpperCase();

    if (cleanAlpha.startsWith('OTHERS')) {
      const snap = await getDocs(query(col, limit(100)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() } as License)).filter(l => {
        const name = (l.fullName || '').trim().toUpperCase();
        const first = name[0] || '';
        return !(first >= 'A' && first <= 'Z');
      });
    }

    const nextChar = cleanAlpha === 'Z' ? 'Z\uf8ff' : String.fromCharCode(cleanAlpha.charCodeAt(0) + 1);
    const lowerAlpha = cleanAlpha.toLowerCase();
    const lowerNextChar = lowerAlpha === 'z' ? 'z\uf8ff' : String.fromCharCode(lowerAlpha.charCodeAt(0) + 1);

    const [upperSnap, lowerSnap] = await Promise.all([
      getDocs(query(col, where('fullName', '>=', cleanAlpha), where('fullName', '<', nextChar), limit(100))),
      getDocs(query(col, where('fullName', '>=', lowerAlpha), where('fullName', '<', lowerNextChar), limit(100)))
    ]);

    const upperDocs = upperSnap.docs.map(d => ({ id: d.id, ...d.data() } as License));
    const lowerDocs = lowerSnap.docs.map(d => ({ id: d.id, ...d.data() } as License));

    const combinedMap = new Map<string, License>();
    [...upperDocs, ...lowerDocs].forEach(d => combinedMap.set(d.id, d));
    clearQuotaExceededFlag();
    return Array.from(combinedMap.values());
  } catch (err) {
    console.warn(`Failed to fetch licenses for alphabet ${alpha}:`, err);
    checkAndTriggerQuotaError(err);
    const list = await getBestAvailableLicenses();
    const cleanAlpha = alpha.toUpperCase();
    return list.filter(l => {
      const name = (l.fullName || '').trim().toUpperCase();
      if (cleanAlpha.startsWith('OTHERS')) {
        const first = name[0] || '';
        return !(first >= 'A' && first <= 'Z');
      }
      return name.startsWith(cleanAlpha);
    });
  }
}

// ==================== INTEGRATED REPORT DATA FETCH ENGINE ====================

function processLicenseRecordForReport(
  l: License,
  selectedKeys: string[],
  searchQuery: string,
  recordsMap: Record<string, any[]>
) {
  const q = searchQuery.trim();
  const matchesSearch = !q || isLicenseMatch(q, l) || (l.fullName || '').toLowerCase().includes(q.toLowerCase());
  if (!matchesSearch) return;

  const isDist = isLicenseDistributed(l);

  if (selectedKeys.includes('totalSmartCards')) {
    recordsMap.totalSmartCards.push(l);
  }
  if (selectedKeys.includes('distributedCards') && isDist && l.status !== 'missing') {
    recordsMap.distributedCards.push(l);
  }
  if (selectedKeys.includes('notDistributedCards') && ((!isDist && l.status !== 'found') || l.status === 'missing')) {
    recordsMap.notDistributedCards.push(l);
  }
  if (selectedKeys.includes('missingCards') && l.status === 'missing') {
    recordsMap.missingCards.push(l);
  }
  if (selectedKeys.includes('foundCards') && l.status === 'found') {
    recordsMap.foundCards.push(l);
  }
}

export async function fetchIntegratedReportData(params: {
  selectedKeys: string[];
  startBSStr?: string;
  endBSStr?: string;
  searchQuery?: string;
  onStatusUpdate?: (status: string) => void;
}): Promise<Record<string, any[]>> {
  const { selectedKeys, searchQuery = '', onStatusUpdate } = params;

  onStatusUpdate?.("Preparing Integrated Report...");
  await new Promise(r => setTimeout(r, 60));

  onStatusUpdate?.("Reading Database...");
  await new Promise(r => setTimeout(r, 60));

  const needsLicenses = selectedKeys.some(k =>
    ['totalSmartCards', 'distributedCards', 'notDistributedCards', 'missingCards', 'foundCards'].includes(k)
  );
  const needsRequests = selectedKeys.includes('requestToReceive');

  const recordsMap: Record<string, any[]> = {
    totalSmartCards: [],
    distributedCards: [],
    notDistributedCards: [],
    missingCards: [],
    foundCards: [],
    requestToReceive: []
  };

  const isDemo = isDemoModeActive();

  if (needsLicenses) {
    let allLicenses: License[] = [];

    if (!isDemo) {
      try {
        const colRef = collection(db, 'licenses');
        let lastSnap: QueryDocumentSnapshot | null = null;
        let hasMore = true;

        while (hasMore) {
          const q = lastSnap
            ? query(colRef, limit(1000), startAfter(lastSnap))
            : query(colRef, limit(1000));

          const snap = await getDocs(q);
          if (snap.empty) {
            hasMore = false;
            break;
          }

          const docs = snap.docs;
          for (let i = 0; i < docs.length; i++) {
            allLicenses.push({ id: docs[i].id, ...docs[i].data() } as License);
          }

          lastSnap = docs[docs.length - 1];
          if (docs.length < 1000) {
            hasMore = false;
          } else {
            onStatusUpdate?.(`Reading Database... (${allLicenses.length} records processed)`);
            await new Promise(r => setTimeout(r, 0));
          }
        }
      } catch (err) {
        console.warn("Firestore paginated read failed, falling back to local store:", err);
      }
    }

    // Merge with best available licenses (registryDataStore / localStorage) to guarantee complete data
    const bestLicenses = await getBestAvailableLicenses();
    if (allLicenses.length === 0) {
      allLicenses = bestLicenses;
    } else if (bestLicenses.length > 0) {
      const licenseMap = new Map<string, License>();
      allLicenses.forEach(l => licenseMap.set(l.id, l));
      bestLicenses.forEach(l => {
        const existing = licenseMap.get(l.id);
        if (existing) {
          licenseMap.set(l.id, { ...existing, ...l });
        } else {
          licenseMap.set(l.id, l);
        }
      });
      allLicenses = Array.from(licenseMap.values());
    }

    for (const l of allLicenses) {
      processLicenseRecordForReport(l, selectedKeys, searchQuery, recordsMap);
    }
  }

  if (needsRequests) {
    try {
      const requestsList = await getAllCollectionRequests();
      const q = searchQuery.trim().toLowerCase();
      for (const req of requestsList) {
        const matchesSearch = !q ||
          (req.licenseHolderName || '').toLowerCase().includes(q) ||
          (req.licenseNumber || '').toLowerCase().includes(q) ||
          (req.receiverName || '').toLowerCase().includes(q);

        if (matchesSearch) {
          recordsMap.requestToReceive.push(req);
        }
      }
    } catch (err) {
      console.warn("Error reading collection requests for report:", err);
    }
  }

  // Debug output as specified in requirement
  console.log(`TOTAL fetched: ${recordsMap.totalSmartCards.length}`);
  console.log(`DISTRIBUTED fetched: ${recordsMap.distributedCards.length}`);
  console.log(`NOT DISTRIBUTED fetched: ${recordsMap.notDistributedCards.length}`);
  console.log(`FOUND fetched: ${recordsMap.foundCards.length}`);
  console.log(`MISSING fetched: ${recordsMap.missingCards.length}`);

  return recordsMap;
}


