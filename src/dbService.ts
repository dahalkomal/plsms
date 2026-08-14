import { db, auth, storage, handleFirestoreError, OperationType, isQuotaOrMemoryError, withFirestoreRetry } from './firebase';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { isLicenseMatch, nepaliToEnglishDigits, cleanAlphanumeric, extractDigits } from './utils/licenseNormalizer';
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
  officeLogo: "/nepal-emblem.svg",
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

export function fetchStorageItem<T>(key: string, initial: T): T {
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
    updatedSettings.officeLogo = "/nepal-emblem.svg";
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

let cachedAlphabeticalSummary: { data: AlphabeticalSummaryResult; timestamp: number } | null = null;
let alphabeticalSummaryPromise: Promise<AlphabeticalSummaryResult> | null = null;

export function invalidateDashboardKpiCache() {
  cachedDashboardKpiCounts = null;
  dashboardKpiPromise = null;
}

export function invalidateAlphabeticalSummaryCache() {
  cachedAlphabeticalSummary = null;
  alphabeticalSummaryPromise = null;
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
  cachedAlphabeticalSummary = null;
  alphabeticalSummaryPromise = null;
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
    const colRef = collection(db, 'licenses');
    let lastSnap: QueryDocumentSnapshot | null = null;
    let hasMore = true;
    const list: License[] = [];

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
        list.push({ id: docs[i].id, ...docs[i].data() } as License);
      }

      lastSnap = docs[docs.length - 1];
      if (docs.length < 1000) {
        hasMore = false;
      }
    }

    if (list.length > 0) {
      const cappedList = list.length > 2000 ? list.slice(0, 2000) : list;
      writeStorageItem('plsms_live_licenses_backup', cappedList);
      registryDataStore.setRecords(cappedList, 'Firestore Primary Collection', true);
    } else {
      writeStorageItem('plsms_live_licenses_backup', []);
      registryDataStore.clearRegistry();
    }

    return list;
  } catch (err) {
    console.warn("Firestore licenses fetch failed:", err);
    checkAndTriggerQuotaError(err);
    // Graceful fallback to cached backup or local mock/best available licenses
    const cachedBackup = fetchStorageItem<License[]>('plsms_live_licenses_backup', []);
    if (cachedBackup && cachedBackup.length > 0) {
      return cachedBackup;
    }
    const fallback = await getBestAvailableLicenses();
    if (fallback && fallback.length > 0) {
      return fallback;
    }
    return [];
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
        const distributedCount = distSnap.data().count;
        const missingCount = missingSnap.data().count;
        const foundCount = foundSnap.data().count;

        // Authoritative reconciliation: status categories are strictly mutually exclusive and exhaustive.
        // sum(notDistributed + distributed + missing + found) === totalRecords
        const notDistributed = Math.max(0, total - (distributedCount + missingCount + foundCount));

        const res = {
          totalRecords: total,
          availableCount: notDistributed,
          notDistributedCount: notDistributed,
          distributedCount,
          missingCount,
          foundCount
        };
        cachedDashboardKpiCounts = res;
        return res;
      } catch (err: any) {
        console.error("Failed to fetch aggregate counts from server:", err);
        checkAndTriggerQuotaError(err);
        throw new Error(`Unable to fetch dashboard statistics: ${err?.message || 'Database connection error'}`);
      }
    }

    // Demo mode or fallback using best available store/backup datasets
    const storeRecords = registryDataStore.getRecords();
    const storageRecords = fetchStorageItem<License[]>('plsms_mock_licenses', initialMockLicenses);
    const backupRecords = fetchStorageItem<License[]>('plsms_live_licenses_backup', []);
    
    let list = storeRecords;
    if (storageRecords.length > list.length) list = storageRecords;
    if (backupRecords.length > list.length) list = backupRecords;

    let dist = 0, missing = 0, found = 0;
    for (const l of list) {
      if (l.status === 'missing') {
        missing++;
      } else if (l.status === 'found') {
        found++;
      } else if (l.status === 'distributed' || isLicenseDistributed(l)) {
        dist++;
      }
    }
    const totalRecords = list.length;
    const notDist = Math.max(0, totalRecords - (dist + missing + found));

    const fallbackRes = {
      totalRecords,
      availableCount: notDist,
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
  const { pageSize = 100, lastDocSnap = null, statusFilter = 'all', searchQuery = '' } = params;

  if (!isDemoModeActive()) {
    try {
      const colRef = collection(db, 'licenses');

      // 1. IF NO SEARCH QUERY: USE STANDARD FAST SERVER-SIDE PAGINATION
      if (!searchQuery || !searchQuery.trim()) {
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

        // Safe pagination constraints without composite index dependency
        if (lastDocSnap) {
          qConstraints.push(startAfter(lastDocSnap));
        }

        if (pageSize > 0) {
          qConstraints.push(limit(pageSize));
        }

        const q = query(colRef, ...qConstraints);
        const snap = await withFirestoreRetry(() => getDocs(q));
        clearQuotaExceededFlag();

        const rawRecords = snap.docs.map(d => ({ id: d.id, ...d.data() } as License));
        const newLastDocSnap = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;

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
          return true;
        });

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

        const countSnap = await withFirestoreRetry(() => getCountFromServer(query(colRef, ...countQueryConstraints)));
        const totalCount = countSnap.data().count;

        return {
          records: filteredRecords,
          lastDocSnap: newLastDocSnap,
          totalCount
        };
      }

      // 2. WHEN SEARCH QUERY IS PRESENT: DIRECT TARGETED INDEXED FIRESTORE QUERIES
      const trimmedQuery = searchQuery.trim();
      const engQuery = nepaliToEnglishDigits(trimmedQuery);
      const rawUpper = engQuery.toUpperCase();
      const cleanAlphaNum = cleanAlphanumeric(trimmedQuery);
      const digits = extractDigits(trimmedQuery);

      const candidateStrings: string[] = [];
      const addCandidate = (c: string) => {
        if (c && c.trim() && !candidateStrings.includes(c.trim())) {
          candidateStrings.push(c.trim());
        }
      };

      // Formatted license XX-XX-XXXXXXXX
      if (digits.length >= 4) {
        addCandidate(`${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`);
      }
      addCandidate(rawUpper);
      addCandidate(cleanAlphaNum);
      addCandidate(digits);
      addCandidate(engQuery);
      addCandidate(trimmedQuery);

      const foundMap = new Map<string, License>();

      // A. Direct document lookups by ID or sanitized candidate string
      for (const cand of candidateStrings) {
        try {
          const docSnap = await getDoc(doc(db, 'licenses', cand));
          if (docSnap.exists()) {
            foundMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() } as License);
          }
        } catch (_) {}
      }

      // B. Direct field equality queries (licenseNumber, applicantId, id)
      for (const cand of candidateStrings) {
        if (foundMap.size >= 10) break;
        const fieldQueries = [
          query(colRef, where('licenseNumber', '==', cand), limit(10)),
          query(colRef, where('applicantId', '==', cand), limit(10)),
          query(colRef, where('id', '==', cand), limit(10))
        ];
        for (const q of fieldQueries) {
          try {
            const snap = await getDocs(q);
            for (const d of snap.docs) {
              foundMap.set(d.id, { id: d.id, ...d.data() } as License);
            }
          } catch (_) {}
        }
      }

      // C. Prefix/Range queries for licenseNumber if candidate string >= 3 chars
      if (foundMap.size === 0) {
        const prefixTerms = [rawUpper, cleanAlphaNum, digits, engQuery].filter(s => s && s.length >= 3);
        for (const p of prefixTerms) {
          if (foundMap.size >= 10) break;
          try {
            const snap = await getDocs(query(colRef, where('licenseNumber', '>=', p), where('licenseNumber', '<=', p + '\uf8ff'), limit(15)));
            for (const d of snap.docs) {
              foundMap.set(d.id, { id: d.id, ...d.data() } as License);
            }
          } catch (_) {}
        }
      }

      // D. Name prefix range queries if name search or no direct ID match
      if (foundMap.size === 0 || rawUpper.length >= 2) {
        const titleCase = trimmedQuery.charAt(0).toUpperCase() + trimmedQuery.slice(1).toLowerCase();
        const lowerCase = trimmedQuery.toLowerCase();
        const nameTerms = Array.from(new Set([rawUpper, titleCase, lowerCase, trimmedQuery])).filter(s => s && s.length >= 2);

        for (const nameTerm of nameTerms) {
          if (foundMap.size >= 25) break;
          try {
            const snap = await getDocs(query(colRef, where('fullName', '>=', nameTerm), where('fullName', '<=', nameTerm + '\uf8ff'), limit(15)));
            for (const d of snap.docs) {
              foundMap.set(d.id, { id: d.id, ...d.data() } as License);
            }
          } catch (_) {}
        }
      }

      // Convert found Map to normalized array
      const rawFoundList = Array.from(foundMap.values()).map(r => {
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

      // Filter by statusFilter and match verification
      const filtered = rawFoundList.filter(l => {
        // Status filter check
        if (statusFilter === 'distributed') {
          if (!(l.status === 'distributed' || isLicenseDistributed(l)) || l.status === 'missing' || l.status === 'found') return false;
        } else if (statusFilter === 'not_distributed') {
          if (isLicenseDistributed(l) || l.status === 'missing' || l.status === 'found') return false;
        } else if (statusFilter === 'missing') {
          if (l.status !== 'missing') return false;
        } else if (statusFilter === 'found') {
          if (l.status !== 'found') return false;
        }

        // Match check using normalizer or name substring
        return isLicenseMatch(trimmedQuery, l) || (l.fullName || '').toLowerCase().includes(trimmedQuery.toLowerCase());
      });

      clearQuotaExceededFlag();
      return {
        records: filtered,
        lastDocSnap: null,
        totalCount: filtered.length
      };

    } catch (err: any) {
      console.error("Failed to fetch paginated licenses from Firestore:", err);
      checkAndTriggerQuotaError(err);
      throw new Error(`Unable to fetch licensed records from database: ${err?.message || 'Database query error'}`);
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
    invalidateDashboardKpiCache();
    invalidateAlphabeticalSummaryCache();
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
    invalidateDashboardKpiCache();
    invalidateAlphabeticalSummaryCache();
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

export async function batchWriteLicenses(
  licenses: License[],
  onProgress?: (completedBatches: number, totalBatches: number, writtenCount: number) => void
): Promise<BatchWriteResult> {
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

    if (onProgress) onProgress(1, 1, licenses.length);

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

  // FIRESTORE PRODUCTION HIGH-SPEED BATCH WRITE ENGINE
  // BATCH_LIMIT = 450 (Max 450 write operations per Firestore writeBatch)
  const BATCH_LIMIT = 450;
  const MAX_CONCURRENT_BATCHES = 4; // Bounded concurrency of 4 simultaneous active commits
  const MAX_BATCH_RETRIES = 3; // Up to 3 retries with exponential backoff

  const chunks: License[][] = [];
  for (let i = 0; i < licenses.length; i += BATCH_LIMIT) {
    chunks.push(licenses.slice(i, i + BATCH_LIMIT));
  }

  const totalBatches = chunks.length;
  let completedBatches = 0;
  let nextChunkIdx = 0;
  let writtenRecords = 0;

  const { writeBatch } = await import('firebase/firestore');

  const processChunk = async (): Promise<void> => {
    while (nextChunkIdx < totalBatches) {
      const chunkIdx = nextChunkIdx++;
      const slice = chunks[chunkIdx];
      const batchNumber = chunkIdx + 1;
      const batchStartTime = new Date().toISOString();
      let retries = 0;
      let batchSuccess = false;
      let lastError = '';

      // First attempt + Retry loop up to MAX_BATCH_RETRIES
      for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
        if (attempt > 0) {
          retries = attempt;
          // Exponential backoff: 300ms, 600ms, 1200ms
          await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt - 1)));
        }

        try {
          const batch = writeBatch(db);
          slice.forEach((lic) => {
            const targetDocRef = doc(db, 'licenses', lic.id);
            batch.set(targetDocRef, lic);
          });
          await batch.commit();
          batchSuccess = true;
          break;
        } catch (commitErr: any) {
          console.warn(`[Batch Write] Batch ${batchNumber}/${totalBatches} (attempt ${attempt + 1}) failed:`, commitErr);
          lastError = commitErr?.message || String(commitErr);
          checkAndTriggerQuotaError(commitErr);
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

      completedBatches++;
      if (batchSuccess) {
        writtenRecords += slice.length;
      }

      // Invoke progress callback
      if (onProgress) {
        onProgress(completedBatches, totalBatches, writtenRecords);
      }

      // Periodic upload checkpoint saved every 5 completed batches
      if (completedBatches % 5 === 0 || completedBatches === totalBatches) {
        try {
          localStorage.setItem('plsms_active_upload_checkpoint', JSON.stringify({
            completedBatches,
            totalBatches,
            writtenRecords,
            timestamp: new Date().toISOString()
          }));
        } catch (chkErr) {
          console.warn("Checkpoint save notice:", chkErr);
        }
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(MAX_CONCURRENT_BATCHES, totalBatches); w++) {
    workers.push(processChunk());
  }

  await Promise.all(workers);

  const endTimeOverall = Date.now();
  const verificationTime = new Date().toISOString();

  // Sort batch details chronologically by batchNumber
  batchDetails.sort((a, b) => a.batchNumber - b.batchNumber);

  const successfulBatchCount = batchDetails.filter(b => b.status === 'SUCCESS').length;
  const failedBatchDetails = batchDetails.filter(b => b.status === 'FAILED');
  const failedBatchCount = failedBatchDetails.length;

  let verificationStatus: 'VERIFIED' | 'PARTIAL SUCCESS' | 'FAILED' = 'VERIFIED';
  if (failedBatchCount > 0 && successfulBatchCount > 0) {
    verificationStatus = 'PARTIAL SUCCESS';
  } else if (failedBatchCount > 0 && successfulBatchCount === 0) {
    verificationStatus = 'FAILED';
  }

  console.log(`[Batch Verification] Processed ${licenses.length} records across ${totalBatches} batches (${successfulBatchCount} VERIFIED, ${failedBatchCount} FAILED). Status: ${verificationStatus}`);

  if (successfulBatchCount > 0) {
    invalidateDashboardKpiCache();
    invalidateAlphabeticalSummaryCache();
  }

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
}

export function isPlsmsAuthorizedUser(): boolean {
  if (auth.currentUser) return true;
  if (typeof window !== 'undefined') {
    const liveUser = localStorage.getItem('plsms_live_user');
    const mockUser = localStorage.getItem('plsms_mock_user');
    const mockRole = localStorage.getItem('plsms_mock_user_role');
    if (liveUser || mockUser || mockRole) {
      return true;
    }
  }
  return false;
}

// ==================== COLLECTION REQUESTS SERVICES ====================

export async function getAllCollectionRequests(): Promise<CollectionRequest[]> {
  if (isDemoModeActive()) {
    return fetchStorageItem<CollectionRequest[]>('plsms_mock_requests', initialMockRequests);
  }
  if (!isPlsmsAuthorizedUser()) {
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
  'admin_lead', 'ADMIN_LEAD', 'admin@tmodl.gov.np', 'admin@plsms.gov.bd', 'dahakomal@plsms.gov.bd', 'admin', 'ADMIN',
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
    idLower === 'admin_lead' ||
    usernameLower === 'dahal_plsms' ||
    usernameLower === 'sdahal_plsms' ||
    usernameLower === 'public_handover_desk' ||
    usernameLower === 'admin_lead' ||
    emailLower === 'dahal_plsms@plsms.gov.bd' ||
    emailLower === 'sdahal_plsms@plsms.local' ||
    emailLower === 'sdahal_plsms@plsms.gov.bd' ||
    emailLower === 'public_handover_desk@plsms.gov.bd' ||
    emailLower === 'public search handover desk' ||
    emailLower === 'admin@plsms.gov.bd' ||
    emailLower === 'dahakomal@plsms.gov.bd' ||
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
      mobile: result[komalIndex].mobile || '9842033214',
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
    'admin_lead', 'ADMIN_LEAD', 'admin', 'ADMIN',
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
    'admin@plsms.gov.bd',
    'dahakomal@plsms.gov.bd',
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
  try {
    const colRef = collection(db, 'upload_ledgers');
    let snap;
    try {
      snap = await withFirestoreRetry(() => getDocs(query(colRef, orderBy('timestamp', 'desc'))));
    } catch (orderErr) {
      console.warn("Notice: Query with orderBy timestamp failed, falling back to direct collection fetch:", orderErr);
      snap = await withFirestoreRetry(() => getDocs(colRef));
    }
    const list: UploadLedger[] = [];
    snap.forEach(doc => {
      list.push(doc.data() as UploadLedger);
    });
    list.sort((a, b) => {
      const timeA = typeof a.timestamp === 'string' ? a.timestamp : (a.timestamp && typeof (a.timestamp as any).toDate === 'function' ? (a.timestamp as any).toDate().toISOString() : '');
      const timeB = typeof b.timestamp === 'string' ? b.timestamp : (b.timestamp && typeof (b.timestamp as any).toDate === 'function' ? (b.timestamp as any).toDate().toISOString() : '');
      return timeB.localeCompare(timeA);
    });
    return list;
  } catch (error: any) {
    console.error("Failed to load upload ledgers from Firestore:", error);
    throw new Error(`Unable to fetch upload history: ${error?.message || 'Database query error'}`);
  }
}

export async function createUploadLedger(ledger: UploadLedger): Promise<void> {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  try {
    const enriched: UploadLedger = {
      ...ledger,
      uploadDate: ledger.uploadDate || dateStr,
      uploadTime: ledger.uploadTime || timeStr,
      status: ledger.status || 'Verified',
      timestamp: ledger.timestamp || now.toISOString(),
      isActive: ledger.isActive ?? true
    };

    const cleanEnriched = Object.fromEntries(
      Object.entries(enriched).filter(([_, v]) => v !== undefined)
    ) as UploadLedger;

    await withFirestoreRetry(() => setDoc(doc(db, 'upload_ledgers', ledger.id), cleanEnriched, { merge: true }));
  } catch (error: any) {
    console.error(`Failed to create upload ledger ${ledger.id}:`, error);
    throw new Error(`Failed to save upload ledger: ${error?.message || 'Firestore write error'}`);
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

export interface ResetProgressStatus {
  stage: string;
  licensesDeleted: number;
  ledgersDeleted: number;
  subcollectionsDeleted: number;
  requestsDeleted: number;
  totalDeleted: number;
}

export async function purgeAllDatabaseRecordsAndLedgers(
  onProgress?: (progress: ResetProgressStatus) => void
): Promise<{ totalDeleted: number; verified: boolean; error?: string }> {
  let licensesDeleted = 0;
  let ledgersDeleted = 0;
  let subcollectionsDeleted = 0;
  let requestsDeleted = 0;

  const updateProgress = (stage: string) => {
    if (onProgress) {
      onProgress({
        stage,
        licensesDeleted,
        ledgersDeleted,
        subcollectionsDeleted,
        requestsDeleted,
        totalDeleted: licensesDeleted + ledgersDeleted + subcollectionsDeleted + requestsDeleted,
      });
    }
  };

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
    return { totalDeleted: total, verified: true };
  }

  // Clear local storage caches and in-memory stores in all modes
  inMemoryStorageMap.clear();
  registryDataStore.clearRegistry();
  writeStorageItem('plsms_mock_licenses', []);
  writeStorageItem('plsms_mock_ledgers', []);
  writeStorageItem('plsms_mock_requests', []);
  writeStorageItem('plsms_security_audit_logs', []);
  writeStorageItem('plsms_mock_stats', { totalSearchesServed: 0 });
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('plsms_mock_ledger_backups_') || key.startsWith('plsms_registry_cache') || key.startsWith('plsms_live_licenses_backup'))) {
        localStorage.removeItem(key);
      }
    }
  } catch (e) {
    console.warn("Error cleaning local storage during purge:", e);
  }

  // ==================== 1. SERVER-SIDE ENTERPRISE RESET ATTEMPT ====================
  try {
    const idToken = await auth.currentUser?.getIdToken(true);
    if (idToken) {
      updateProgress('Connecting to server-side enterprise reset engine...');
      const initiateRes = await fetch('/api/admin/reset-production-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          confirmationText: 'RESET PLSMS PRODUCTION DATA',
          confirmChecked: true,
          userEmail: auth.currentUser?.email || ''
        })
      });

      if (initiateRes.ok || initiateRes.status === 409) {
        // Server task accepted and is running. Begin real-time status polling.
        while (true) {
          await new Promise(resolve => setTimeout(resolve, 800));
          const statusRes = await fetch('/api/admin/reset-status');
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            const s = statusData.status;
            if (s) {
              if (onProgress) {
                onProgress({
                  stage: s.stage,
                  licensesDeleted: s.licensesDeleted,
                  ledgersDeleted: s.ledgersDeleted,
                  subcollectionsDeleted: s.subcollectionsDeleted,
                  requestsDeleted: s.requestsDeleted,
                  totalDeleted: s.totalDeleted
                });
              }

              if (s.completed || (!s.isRunning && s.stage !== 'Idle')) {
                return {
                  totalDeleted: s.totalDeleted,
                  verified: s.verified,
                  error: s.error || undefined
                };
              }
            }
          }
        }
      } else if (initiateRes.status === 403 || initiateRes.status === 400) {
        const errJson = await initiateRes.json().catch(() => ({}));
        throw new Error(errJson.error || 'Server authorization denied production reset.');
      }
    }
  } catch (serverErr: any) {
    if (serverErr.message && (serverErr.message.includes('Permission Denied') || serverErr.message.includes('Invalid confirmation') || serverErr.message.includes('authorization'))) {
      throw serverErr;
    }
    console.warn("[RESET DRIVER] Server-side reset endpoint unavailable or falling back to client engine:", serverErr.message);
  }

  // ==================== 2. CLIENT-SIDE FALLBACK ENGINE ====================
  const { writeBatch, query, collection, limit, getDocs, deleteDoc, getCountFromServer, doc, setDoc } = await import('firebase/firestore');

  // 1. Delete all license records with high concurrency
  updateProgress('Deleting license records from Firestore...');
  const licensesCol = collection(db, 'licenses');
  while (true) {
    const snap = await getDocs(query(licensesCol, limit(2000)));
    if (snap.empty) break;

    const docs = snap.docs;
    const batchPromises: Promise<any>[] = [];
    const BATCH_SIZE = 500;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const chunk = docs.slice(i, i + BATCH_SIZE);
      const batch = writeBatch(db);
      for (const docSnap of chunk) {
        batch.delete(docSnap.ref);
      }
      batchPromises.push(batch.commit());
    }

    await Promise.all(batchPromises);

    licensesDeleted += docs.length;
    updateProgress(`Deleting license records (${licensesDeleted.toLocaleString()} deleted)...`);

    if (docs.length < 2000) break;
  }

  // 2. Delete upload ledgers and their subcollection records/checkpoints
  updateProgress('Deleting upload history ledgers and metadata...');
  const ledgersCol = collection(db, 'upload_ledgers');
  while (true) {
    const ledgersSnap = await getDocs(query(ledgersCol, limit(100)));
    if (ledgersSnap.empty) break;

    for (const ledgerDoc of ledgersSnap.docs) {
      // Subcollection 'records'
      const recordsCol = collection(db, 'upload_ledgers', ledgerDoc.id, 'records');
      while (true) {
        const recSnap = await getDocs(query(recordsCol, limit(2000)));
        if (recSnap.empty) break;

        const docs = recSnap.docs;
        const promises: Promise<any>[] = [];
        for (let i = 0; i < docs.length; i += 500) {
          const chunk = docs.slice(i, i + 500);
          const b = writeBatch(db);
          chunk.forEach(d => b.delete(d.ref));
          promises.push(b.commit());
        }
        await Promise.all(promises);

        subcollectionsDeleted += docs.length;
        if (docs.length < 2000) break;
      }

      // Subcollection 'checkpoints'
      const checkCol = collection(db, 'upload_ledgers', ledgerDoc.id, 'checkpoints');
      while (true) {
        const chkSnap = await getDocs(query(checkCol, limit(2000)));
        if (chkSnap.empty) break;

        const docs = chkSnap.docs;
        const promises: Promise<any>[] = [];
        for (let i = 0; i < docs.length; i += 500) {
          const chunk = docs.slice(i, i + 500);
          const b = writeBatch(db);
          chunk.forEach(d => b.delete(d.ref));
          promises.push(b.commit());
        }
        await Promise.all(promises);

        subcollectionsDeleted += docs.length;
        if (docs.length < 2000) break;
      }

      // Delete ledger document itself
      await deleteDoc(ledgerDoc.ref);
      ledgersDeleted++;
      updateProgress(`Deleting upload ledgers (${ledgersDeleted} ledgers, ${subcollectionsDeleted.toLocaleString()} sub-records deleted)...`);
    }

    if (ledgersSnap.docs.length < 100) break;
  }

  // 3. Delete card collection requests
  updateProgress('Deleting card collection requests...');
  const requestsCol = collection(db, 'collection_requests');
  while (true) {
    const reqSnap = await getDocs(query(requestsCol, limit(2000)));
    if (reqSnap.empty) break;

    const docs = reqSnap.docs;
    const promises: Promise<any>[] = [];
    for (let i = 0; i < docs.length; i += 500) {
      const chunk = docs.slice(i, i + 500);
      const b = writeBatch(db);
      chunk.forEach(d => b.delete(d.ref));
      promises.push(b.commit());
    }
    await Promise.all(promises);

    requestsDeleted += docs.length;
    updateProgress(`Deleting collection requests (${requestsDeleted.toLocaleString()} deleted)...`);

    if (docs.length < 2000) break;
  }

  // 4. Reset search served statistics
  try {
    const statRef = doc(db, 'statistics', 'search_served');
    await setDoc(statRef, { totalSearchesServed: 0 });
  } catch (err) {
    console.warn("Failed to reset statistics document:", err);
  }

  // 5. Final verification directly against Firestore
  updateProgress('Verifying database state directly with Firestore...');
  let verified = false;
  let verifyError: string | undefined = undefined;

  try {
    const licCountSnap = await getCountFromServer(licensesCol);
    const ledgerCountSnap = await getCountFromServer(ledgersCol);
    const finalLicCount = licCountSnap.data().count;
    const finalLedgerCount = ledgerCountSnap.data().count;

    if (finalLicCount === 0 && finalLedgerCount === 0) {
      verified = true;
    } else {
      verified = false;
      verifyError = `Reset incomplete — ${finalLicCount} license(s) and ${finalLedgerCount} ledger(s) remain in Firestore.`;
    }
  } catch (verifyErr: any) {
    const licSnap = await getDocs(query(licensesCol, limit(1)));
    const ledgerSnap = await getDocs(query(ledgersCol, limit(1)));
    if (licSnap.empty && ledgerSnap.empty) {
      verified = true;
    } else {
      verified = false;
      verifyError = `Reset incomplete — some records remain in Firestore.`;
    }
  }

  const grandTotal = licensesDeleted + ledgersDeleted + subcollectionsDeleted + requestsDeleted;
  updateProgress(verified ? 'Reset completed successfully!' : 'Reset incomplete.');

  return {
    totalDeleted: grandTotal,
    verified,
    error: verifyError,
  };
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

export async function getAlphabeticalSummary(
  startDateBS?: string, 
  endDateBS?: string,
  providedLicenses?: License[],
  forceRefresh: boolean = false
): Promise<AlphabeticalSummaryResult> {
  const isDateFiltered = Boolean((startDateBS && startDateBS.trim()) || (endDateBS && endDateBS.trim()));

  // If no date filter is applied and cached result is fresh (< 5 min), return cached summary
  if (!isDateFiltered && !forceRefresh && cachedAlphabeticalSummary) {
    const ageMs = Date.now() - cachedAlphabeticalSummary.timestamp;
    if (ageMs < 5 * 60 * 1000) {
      return cachedAlphabeticalSummary.data;
    }
  }

  if (!isDateFiltered && !forceRefresh && alphabeticalSummaryPromise) {
    return alphabeticalSummaryPromise;
  }

  const calculationPromise = (async () => {
    const alphabets = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

    if (providedLicenses && Array.isArray(providedLicenses) && providedLicenses.length > 500) {
      const statsMap: Record<string, { count: number; distributed: number; missing: number; found: number }> = {};
      alphabets.forEach(alpha => {
        statsMap[alpha] = { count: 0, distributed: 0, missing: 0, found: 0 };
      });

      let otherCount = 0;
      let otherDistributed = 0;
      let overallTotal = 0;
      let overallDistributed = 0;

      providedLicenses.forEach(lic => {
        if (!lic) return;
        overallTotal++;
        const isDist = lic.status === 'distributed' || isLicenseDistributed(lic);
        if (isDist) overallDistributed++;

        const clean = (lic.fullName || '').replace(/^[\uFEFF\u200B\u200C\u200D\s\t\r\n]+/, '').trim().toUpperCase();
        const firstChar = clean.length > 0 ? clean.charAt(0) : '';

        if (firstChar >= 'A' && firstChar <= 'Z') {
          statsMap[firstChar].count++;
          if (isDist) statsMap[firstChar].distributed++;
        } else {
          otherCount++;
          if (isDist) otherDistributed++;
        }
      });

      const stats: AlphabetStat[] = alphabets.map(alpha => ({
        alphabet: alpha,
        count: statsMap[alpha].count,
        distributed: statsMap[alpha].distributed,
        remained: Math.max(0, statsMap[alpha].count - statsMap[alpha].distributed)
      }));

      stats.push({
        alphabet: 'OTHERS / अन्य',
        count: otherCount,
        distributed: otherDistributed,
        remained: Math.max(0, otherCount - otherDistributed)
      });

      const result: AlphabeticalSummaryResult = {
        alphabetStats: stats,
        totalCount: overallTotal,
        totalDistributed: overallDistributed,
        totalRemained: Math.max(0, overallTotal - overallDistributed)
      };

      if (!isDateFiltered) {
        cachedAlphabeticalSummary = { data: result, timestamp: Date.now() };
      }
      return result;
    }

    try {
      const colRef = collection(db, 'licenses');
      const kpis = await getDashboardKpiCounts(forceRefresh);
      const totalRecords = kpis.totalRecords;
      const totalDistributed = kpis.distributedCount;

      const statsPromises = alphabets.map(async (alpha) => {
        const nextChar = String.fromCharCode(alpha.charCodeAt(0) + 1);
        try {
          const [countSnap, distSnap] = await withFirestoreRetry(() => Promise.all([
            getCountFromServer(query(colRef, where('fullName', '>=', alpha), where('fullName', '<', nextChar))),
            getCountFromServer(query(colRef, where('fullName', '>=', alpha), where('fullName', '<', nextChar), where('status', '==', 'distributed')))
          ]));
          const count = countSnap.data().count;
          const distributed = distSnap.data().count;
          return {
            alphabet: alpha,
            count,
            distributed,
            remained: Math.max(0, count - distributed)
          };
        } catch (e: any) {
          checkAndTriggerQuotaError(e);
          throw e;
        }
      });

      const alphaStats = await Promise.all(statsPromises);
      const alphaCountSum = alphaStats.reduce((sum, r) => sum + r.count, 0);
      const alphaDistSum = alphaStats.reduce((sum, r) => sum + r.distributed, 0);

      const otherCount = Math.max(0, totalRecords - alphaCountSum);
      const otherDist = Math.max(0, totalDistributed - alphaDistSum);
      const otherRemained = Math.max(0, otherCount - otherDist);

      alphaStats.push({
        alphabet: 'OTHERS / अन्य',
        count: otherCount,
        distributed: otherDist,
        remained: otherRemained
      });

      const sumTotal = alphaStats.reduce((acc, row) => acc + row.count, 0);
      const sumDist = alphaStats.reduce((acc, row) => acc + row.distributed, 0);
      const sumRem = alphaStats.reduce((acc, row) => acc + row.remained, 0);

      const result: AlphabeticalSummaryResult = {
        alphabetStats: alphaStats,
        totalCount: sumTotal,
        totalDistributed: sumDist,
        totalRemained: sumRem
      };

      if (!isDateFiltered) {
        cachedAlphabeticalSummary = { data: result, timestamp: Date.now() };
      }
      return result;
    } catch (err: any) {
      console.error("Failed to load alphabetical summary from database:", err);
      checkAndTriggerQuotaError(err);
      throw new Error(`Unable to retrieve alphabetical summary: ${err?.message || 'Database connection error'}`);
    } finally {
      if (!isDateFiltered) {
        alphabeticalSummaryPromise = null;
      }
    }
  })();

  if (!isDateFiltered) {
    alphabeticalSummaryPromise = calculationPromise;
  }
  return calculationPromise;
}

export async function getLicensesByAlphabet(
  alpha: string, 
  startDateBS?: string, 
  endDateBS?: string,
  providedLicenses?: License[]
): Promise<License[]> {
  try {
    const cleanAlpha = (alpha || '').toUpperCase().trim();
    const colRef = collection(db, 'licenses');

    if (cleanAlpha.startsWith('OTHER')) {
      const snap = await withFirestoreRetry(() => getDocs(query(colRef, limit(200))));
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() } as License));
      return docs.filter(l => {
        const name = (l.fullName || '').trim();
        const first = name.replace(/^[\uFEFF\u200B\u200C\u200D\s\t\r\n]+/, '').charAt(0).toUpperCase();
        return first < 'A' || first > 'Z';
      });
    }

    const nextChar = String.fromCharCode(cleanAlpha.charCodeAt(0) + 1);
    const q = query(
      colRef, 
      where('fullName', '>=', cleanAlpha), 
      where('fullName', '<', nextChar), 
      limit(200)
    );
    const snap = await withFirestoreRetry(() => getDocs(q));
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as License));
  } catch (err: any) {
    console.error(`Failed to fetch licenses for alphabet ${alpha}:`, err);
    throw new Error(`Unable to load records for letter ${alpha}: ${err?.message || 'Database query error'}`);
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
        console.warn("Firestore paginated read fallback for integrated report:", err);
        allLicenses = await getBestAvailableLicenses();
      }
    } else {
      allLicenses = await getBestAvailableLicenses();
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


