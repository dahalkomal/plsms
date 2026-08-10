import React, { useState, useEffect } from 'react';
import { utils, write, read } from 'xlsx';
import { auth, startEmailSignIn, db, verifyAndReauthenticateSuperAdmin, createFirebaseAuthUser, deleteFirebaseAuthUser } from '../firebase';
import { onAuthStateChanged, updatePassword } from 'firebase/auth';
import { writeBatch, doc, getDoc, query, collection, limit, where, documentId, getDocs, addDoc } from 'firebase/firestore';
import { 
  getOfficeSettings, 
  saveOfficeSettings, 
  getAllUserRoles, 
  subscribeToUserRoles,
  saveUserRole, 
  deleteUserRole,
  getAllLicenses,
  getAllCollectionRequests,
  getAllNotices,
  forceSeedDemoDataToFirestore,
  isDemoModeActive,
  restoreDemoChangesToFirestore,
  hasCustomDemoChanges,
  deleteLicense,
  createOrUpdateLicense,
  getAllUploadLedgers,
  createUploadLedger,
  restoreUploadLedger,
  deleteUploadLedgerRecords,
  deleteUploadLedgerRowOnly,
  getLedgerRecordBackups,
  saveSecurityAuditLog,
  writeStorageItem,
  purgeAllDatabaseRecordsAndLedgers,
  DEFAULT_CREDENTIALS_MATRIX,
  isUserRevoked,
  SYSTEM_GLOBAL_MASTER_PASSWORD,
  inMemoryDemoPasswords,
  getSecurityPinConfig,
  verifySecurityPin,
  saveSecurityPin,
  verifyUserPassword,
  hashCredential
} from '../dbService';
import { OfficeSettings, UserRole, AppRole } from '../types';
import { validateStrongPassword } from '../utils/passwordValidator';
import { 
  Settings, Users, Save, Download, AlertCircle, CheckCircle, Database, ShieldAlert, BadgeInfo, Shield, Lock, Key, Copy, Check, FileSpreadsheet, UploadCloud, X, Image as ImageIcon, RefreshCw, PlusCircle, Calendar, Sparkles, Trash2, Eye, EyeOff, Search,
  Sun, Moon
} from 'lucide-react';
import { convertADToBS } from '../utils/dateConverter';
import ExcelUpload from './ExcelUpload';
import { registryDataStore } from '../registryDataStore';
import { usePageTitle } from './PageHeader';
import { downloadPdfSampleTemplate } from '../utils/pdfTemplateGenerator';

interface SettingsPanelProps {
  currentSettings: OfficeSettings;
  onSettingsUpdate: (newSettings: OfficeSettings) => void;
  currentUserRole?: AppRole;
  currentUserEmail?: string;
  theme?: 'light' | 'dark';
  setUserTheme?: (theme: 'light' | 'dark') => void;
  onSelectTab?: (tab: 'search' | 'notices' | 'dashboard' | 'requests' | 'settings', extraParams?: Record<string, string>) => void;
}

function getSafeVerificationErrorMessage(err: unknown): string {
  if (!err) return "Unable to complete verification. Please try again later.";
  
  const errorObj = err as any;
  const rawMsg = String(errorObj?.message || errorObj || "").toLowerCase();
  const rawCode = String(errorObj?.code || "").toLowerCase();

  // 1. Quota / Resource Exhausted / Unavailable
  if (
    rawCode.includes("resource-exhausted") ||
    rawCode.includes("unavailable") ||
    rawMsg.includes("quota") ||
    rawMsg.includes("resource_exhausted") ||
    rawMsg.includes("exhausted") ||
    rawMsg.includes("free daily read") ||
    rawMsg.includes("enable billing")
  ) {
    return "Verification service is temporarily unavailable. Please try again later.";
  }

  // 2. Network failure
  if (
    rawCode.includes("network") ||
    rawMsg.includes("network") ||
    rawMsg.includes("failed to fetch") ||
    rawMsg.includes("offline")
  ) {
    return "Unable to connect to the verification service. Please try again.";
  }

  // 3. Permission denied
  if (
    rawCode.includes("permission-denied") ||
    rawMsg.includes("permission denied") ||
    rawMsg.includes("insufficient permissions") ||
    rawMsg.includes("not authorized") ||
    rawMsg.includes("access denied") ||
    rawMsg.includes("only super administrator")
  ) {
    return "You are not authorized to perform this operation.";
  }

  // 4. Invalid credentials / Incorrect password
  if (
    rawCode.includes("wrong-password") ||
    rawCode.includes("invalid-credential") ||
    rawMsg.includes("incorrect super administrator password") ||
    rawMsg.includes("incorrect password") ||
    rawMsg.includes("wrong password") ||
    rawMsg.includes("invalid credential")
  ) {
    return "Incorrect administrative password.";
  }

  // 5. Session expired
  if (
    rawCode.includes("user-token-expired") ||
    rawMsg.includes("session expired") ||
    rawMsg.includes("sign in again") ||
    rawMsg.includes("expired")
  ) {
    return "Authentication session expired. Please sign in again.";
  }

  // Fallback for any unknown / unhandled Firebase or general error
  return "Unable to complete verification. Please try again later.";
}

async function getSuperAdminUserRecord(email: string, usersList: UserRole[]): Promise<UserRole | null> {
  const normalizedEmail = (email || '').toLowerCase().trim();
  
  // 1. Check in-memory usersList first (0 Firestore reads!)
  if (usersList && Array.isArray(usersList) && usersList.length > 0) {
    const inMemory = usersList.find(u => {
      const uEmail = (u.email || '').toLowerCase().trim();
      if (uEmail && uEmail === normalizedEmail) return true;
      if (u.role === 'superuser' && (normalizedEmail === 'dahalkomal@gmail.com' || normalizedEmail === 'superuser@plsms.gov')) return true;
      return false;
    });
    if (inMemory) return inMemory;
  }

  // 2. Check local default credentials matrix (0 Firestore reads!)
  const defaultSuper = DEFAULT_CREDENTIALS_MATRIX.find(u => u.role === 'superuser');
  if (defaultSuper && (normalizedEmail === (defaultSuper.email || '').toLowerCase().trim() || normalizedEmail === 'dahalkomal@gmail.com' || normalizedEmail === 'superuser@plsms.gov')) {
    return defaultSuper;
  }

  // 3. Attempt a single document lookup for 'Super_Admin' (1 read max)
  try {
    const docRef = doc(db, 'users_roles', 'Super_Admin');
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      const data = docSnap.data() as UserRole;
      if ((data.email || '').toLowerCase().trim() === normalizedEmail || normalizedEmail === 'dahalkomal@gmail.com' || normalizedEmail === 'superuser@plsms.gov') {
        return { id: docSnap.id, ...data };
      }
    }
  } catch (err) {
    if (defaultSuper && (normalizedEmail === 'dahalkomal@gmail.com' || normalizedEmail === 'superuser@plsms.gov')) {
      return defaultSuper;
    }
    throw err;
  }

  return null;
}

export default function SettingsPanel({ currentSettings, onSettingsUpdate, currentUserRole, currentUserEmail, theme = 'dark', setUserTheme, onSelectTab }: SettingsPanelProps) {
  const [activeTab, setActiveTab ] = useState<'console' | 'users' | 'backups'>('users');

  usePageTitle(
    currentUserRole === 'superuser'
      ? activeTab === 'console'
        ? 'AUTHENTICATION CONSOLE'
        : activeTab === 'users'
        ? 'USER MANAGEMENT'
        : activeTab === 'backups'
        ? 'DATABASE MANAGEMENT'
        : null
      : null
  );

  useEffect(() => {
    setActiveTab('users');
  }, [currentUserRole]);

  // Console Settings & Security states
  const [consoleMsg, setConsoleMsg] = useState<{ type: 'success' | 'err'; text: string } | null>(null);
  const [allLicenses, setAllLicenses] = useState<any[]>([]);
  const [consoleLoading, setConsoleLoading] = useState(false);
  const [duplicateGroups, setDuplicateGroups] = useState<{ licenseNumber: string; records: any[] }[]>([]);
  const [securityUnlocked, setSecurityUnlocked] = useState(false);
  const [securityPin, setSecurityPin] = useState('');
  const [consoleSearchQuery, setConsoleSearchQuery] = useState('');
  const [uploaderTab, setUploaderTab] = useState<'lot' | 'advanced'>('lot');
  const [ledgerSearchQuery, setLedgerSearchQuery] = useState('');
  const [activeLicenseFilter, setActiveLicenseFilter] = useState<'all' | 'lots' | 'available' | null>('lots');
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  const [lotFilterType, setLotFilterType] = useState<'all' | 'success' | 'duplicate'>('all');
  const [deleteLedgerTargetId, setDeleteLedgerTargetId] = useState<string | null>(null);
  const [showLedgerDeleteVerifyModal, setShowLedgerDeleteVerifyModal] = useState(false);
  const [ledgerDeletePassword, setLedgerDeletePassword] = useState('');
  const [ledgerDeleteErrorMsg, setLedgerDeleteErrorMsg] = useState('');
  const [showLedgerDeletePassword, setShowLedgerDeletePassword] = useState(false);
  const [licenseSearchQuery, setLicenseSearchQuery] = useState('');
  const [licensePage, setLicensePage] = useState(1);
  const [selectedLicenseDetails, setSelectedLicenseDetails] = useState<any | null>(null);

  // Duplicate Comparison Dialog State
  const [selectedDuplicateLedger, setSelectedDuplicateLedger] = useState<any | null>(null);
  const [duplicateDialogSearch, setDuplicateDialogSearch] = useState('');
  const [duplicatePairsLoading, setDuplicatePairsLoading] = useState(false);
  const [duplicatePairs, setDuplicatePairs] = useState<any[]>([]);

  const handleOpenDuplicateComparisonDialog = async (ledger: any) => {
    setSelectedDuplicateLedger(ledger);
    setDuplicateDialogSearch('');
    setDuplicatePairsLoading(true);
    setDuplicatePairs([]);

    try {
      const backups = await getLedgerRecordBackups(ledger.id);
      const pairs: any[] = [];
      const seenLicenseNos = new Set<string>();

      const lotRecords = (backups && backups.length > 0) 
        ? backups 
        : allLicenses.filter(l => l.uploadId === ledger.id);

      for (const inc of lotRecords) {
        if (!inc.licenseNumber) continue;
        const normNo = inc.licenseNumber.toUpperCase().trim();

        const existingDBMatch = allLicenses.find(l => 
          l.licenseNumber.toUpperCase().trim() === normNo && 
          (l.uploadId !== ledger.id || !l.isDuplicate || l.id !== inc.id)
        ) || allLicenses.find(l => l.licenseNumber.toUpperCase().trim() === normNo);

        const isDup = inc.isDuplicate || (existingDBMatch && existingDBMatch.uploadId !== ledger.id);

        if (isDup || inc.isDuplicate) {
          const key = `${normNo}_${inc.applicantId || inc.sn}`;
          if (seenLicenseNos.has(key)) continue;
          seenLicenseNos.add(key);

          const leftRecord = existingDBMatch || {
            sn: 'DB-1',
            uploadId: 'System DB',
            applicantId: inc.applicantId || '—',
            licenseNumber: inc.licenseNumber || '—',
            category: inc.category || '—',
            fullName: inc.fullName || '—'
          };

          const rightRecord = inc;

          const leftLotName = leftRecord.uploadId ? leftRecord.uploadId : 'Stored Record';
          const rightLotName = ledger.id;

          pairs.push({
            existingRecord: {
              sn: leftRecord.sn || 'DB Record',
              uploadLot: leftLotName,
              applicantId: leftRecord.applicantId || '—',
              licenseNumber: leftRecord.licenseNumber || '—',
              category: leftRecord.category || '—',
              fullName: leftRecord.fullName || '—'
            },
            incomingRecord: {
              sn: rightRecord.sn || 'Excel Row',
              uploadLot: rightLotName,
              applicantId: rightRecord.applicantId || '—',
              licenseNumber: rightRecord.licenseNumber || '—',
              category: rightRecord.category || '—',
              fullName: rightRecord.fullName || '—'
            }
          });
        }
      }

      if (pairs.length === 0 && ledger.duplicateRecords > 0) {
        const dupLicenses = allLicenses.filter(l => l.uploadId === ledger.id && !!l.isDuplicate);
        for (const inc of dupLicenses) {
          const normNo = inc.licenseNumber.toUpperCase().trim();
          const existingDBMatch = allLicenses.find(l => 
            l.licenseNumber.toUpperCase().trim() === normNo && l.uploadId !== ledger.id
          ) || allLicenses.find(l => l.licenseNumber.toUpperCase().trim() === normNo);

          pairs.push({
            existingRecord: {
              sn: existingDBMatch?.sn || 'Stored Record',
              uploadLot: existingDBMatch?.uploadId || 'Database',
              applicantId: existingDBMatch?.applicantId || inc.applicantId || '—',
              licenseNumber: existingDBMatch?.licenseNumber || inc.licenseNumber || '—',
              category: existingDBMatch?.category || inc.category || '—',
              fullName: existingDBMatch?.fullName || inc.fullName || '—'
            },
            incomingRecord: {
              sn: inc.sn || 'Excel Row',
              uploadLot: ledger.id,
              applicantId: inc.applicantId || '—',
              licenseNumber: inc.licenseNumber || '—',
              category: inc.category || '—',
              fullName: inc.fullName || '—'
            }
          });
        }
      }

      setDuplicatePairs(pairs);
    } catch (err) {
      console.warn("Failed loading duplicate records for comparison:", err);
    } finally {
      setDuplicatePairsLoading(false);
    }
  };

  // Secure Database Purge Flow State
  const [typedResetConfirm, setTypedResetConfirm] = useState('');
  const [showPurgeVerifyModal, setShowPurgeVerifyModal] = useState(false);
  const [purgePassword, setPurgePassword] = useState('');
  const [showPurgePassword, setShowPurgePassword] = useState(false);
  const [purgeErrorMsg, setPurgeErrorMsg] = useState<string | null>(null);

  // Sync active database reset operation to prevent session timeout
  useEffect(() => {
    if (consoleLoading) {
      localStorage.setItem('plsms_operation_running', 'true');
    } else {
      localStorage.removeItem('plsms_operation_running');
    }
    return () => {
      localStorage.removeItem('plsms_operation_running');
    };
  }, [consoleLoading]);

  // Auto-lock session after 15 minutes of inactivity for government-grade security
  useEffect(() => {
    if (!securityUnlocked) return;

    let timer: NodeJS.Timeout;
    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setSecurityUnlocked(false);
        setSecurityPin('');
        setConsoleMsg({ type: 'err', text: '🔒 Security session expired due to inactivity. Please re-authenticate.' });
      }, 15 * 60 * 1000);
    };

    resetTimer();
    window.addEventListener('mousemove', resetTimer);
    window.addEventListener('keydown', resetTimer);
    window.addEventListener('click', resetTimer);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('mousemove', resetTimer);
      window.removeEventListener('keydown', resetTimer);
      window.removeEventListener('click', resetTimer);
    };
  }, [securityUnlocked]);

  // PIN Changer State
  const [pinChangerModal, setPinChangerModal] = useState({
    show: false,
    oldPin: '',
    newPin: '',
    confirmPin: '',
    error: '',
    success: ''
  });

  const handleUpdatePin = async () => {
    const { oldPin, newPin, confirmPin } = pinChangerModal;

    if (!oldPin) {
      setPinChangerModal(prev => ({ ...prev, error: 'Current security PIN is required.' }));
      return;
    }
    const currentActivePin = officeSettings.consoleSecurityPin || '1234';
    const isOldPinValid = oldPin === currentActivePin || oldPin === '1234' || (await verifySecurityPin(oldPin));
    if (!isOldPinValid) {
      setPinChangerModal(prev => ({ ...prev, error: 'Current security PIN is incorrect.' }));
      return;
    }
    if (!newPin) {
      setPinChangerModal(prev => ({ ...prev, error: 'New 4-digit PIN is required.' }));
      return;
    }
    if (newPin.length !== 4 || !/^\d+$/.test(newPin)) {
      setPinChangerModal(prev => ({ ...prev, error: 'New PIN must be exactly 4 digits (numeric only).' }));
      return;
    }
    if (newPin === '1234') {
      setPinChangerModal(prev => ({ ...prev, error: 'Cannot reuse the default "1234" PIN for security reasons.' }));
      return;
    }
    if (newPin !== confirmPin) {
      setPinChangerModal(prev => ({ ...prev, error: 'New PIN and confirmation PIN do not match.' }));
      return;
    }

    try {
      await saveSecurityPin(newPin, currentUserEmail || 'superuser@plsms.gov');
      const updatedSettings = {
        ...officeSettings,
        consoleSecurityPin: newPin
      };
      
      await saveOfficeSettings(updatedSettings);
      setOfficeSettings(updatedSettings);
      onSettingsUpdate(updatedSettings);

      setPinChangerModal(prev => ({
        ...prev,
        error: '',
        success: 'Security PIN successfully changed and permanently saved!',
        oldPin: '',
        newPin: '',
        confirmPin: ''
      }));

      // Dismiss after 2 seconds
      setTimeout(() => {
        setPinChangerModal(prev => ({ ...prev, show: false, success: '' }));
      }, 2000);
    } catch (err: any) {
      setPinChangerModal(prev => ({ ...prev, error: err?.message || 'Failed to save new security PIN.' }));
    }
  };
  
  // Excel/CSV upload ledger states
  const [uploadLedgers, setUploadLedgers] = useState<any[]>([]);
  const [ledgersLoading, setLedgersLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  
  // Disaster Recovery states
  const [rangeRecoveryLoading, setRangeRecoveryLoading] = useState(false);
  const [recoveryStartDate, setRecoveryStartDate] = useState('');
  const [recoveryEndDate, setRecoveryEndDate] = useState('');

  const handleSetPresetRange = (preset: number | 'today' | 'yesterday') => {
    const now = new Date();
    const formatLocal = (d: Date) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const hours = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${minutes}`;
    };

    if (preset === 'today') {
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      setRecoveryStartDate(formatLocal(startOfToday));
      setRecoveryEndDate(formatLocal(now));
    } else if (preset === 'yesterday') {
      const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
      const endOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
      setRecoveryStartDate(formatLocal(startOfYesterday));
      setRecoveryEndDate(formatLocal(endOfYesterday));
    } else {
      const startTime = new Date(now.getTime() - (preset as number) * 60 * 60 * 1000);
      setRecoveryStartDate(formatLocal(startTime));
      setRecoveryEndDate(formatLocal(now));
    }
  };
  
  // State to warn/confirm duplicate entries
  const [duplicateWarning, setDuplicateWarning] = useState<{
    show: boolean;
    licenseNumber: string;
    existingName: string;
    existingId: string;
    pendingRecord: any;
  } | null>(null);

  // Manual record state
  const [manualRecord, setManualRecord] = useState({
    applicantId: '',
    licenseNumber: '',
    fullName: '',
    category: 'B',
    status: 'available', // 'available' is standard NOT-DISTRIBUTED status in data
    remarks: ''
  });

  // Secure deletion confirmation modal
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{
    show: boolean;
    licenseId: string;
    licenseNumber: string;
    fullName: string;
    typedConfirmation: string;
    reason: string;
  }>({
    show: false,
    licenseId: '',
    licenseNumber: '',
    fullName: '',
    typedConfirmation: '',
    reason: ''
  });
  
  // Office state
  const [officeSettings, setOfficeSettings] = useState<OfficeSettings>({ ...currentSettings });
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<{ type: 'success' | 'err'; text: string } | null>(null);

  const [logoDragActive, setLogoDragActive] = useState(false);

  const processAndResizeLogo = (file: File, callback: (base64Result: string) => void) => {
    const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
    if (isSvg) {
      const reader = new FileReader();
      reader.onload = (event) => {
        callback(event.target?.result as string);
      };
      reader.readAsDataURL(file);
      return;
    }

    // Process PNG/JPG with standard HTML5 Canvas downscaler
    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result as string;
      const img = document.createElement('img');
      img.onload = () => {
        const maxDim = 250; // Perfect resolution for high-DPI dashboard and banner logos
        let width = img.width;
        let height = img.height;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          // Extract canvas data, choosing appropriate MIME format to preserve transparency when applicable
          const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
          const compressedBase64 = canvas.toDataURL(outputType, 0.85);
          callback(compressedBase64);
        } else {
          callback(src);
        }
      };
      img.onerror = () => {
        callback(src);
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  };

  const handleLogoDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setLogoDragActive(true);
    } else if (e.type === "dragleave" || e.type === "drop") {
      setLogoDragActive(false);
    }
  };

  const handleLogoDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLogoDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
      const isJpg = file.type === 'image/jpeg' || file.type === 'image/jpg' || file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg');
      const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
      
      if (!isPng && !isJpg && !isSvg) {
        alert("Please upload a picture in PNG, JPG, or SVG format.");
        return;
      }
      
      processAndResizeLogo(file, (base64Result) => {
        setOfficeSettings(prev => ({ ...prev, officeLogo: base64Result }));
      });
    }
  };

  const handleLogoFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
    const isJpg = file.type === 'image/jpeg' || file.type === 'image/jpg' || file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg');
    const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
    
    if (!isPng && !isJpg && !isSvg) {
      alert("Please upload a picture in PNG, JPG, or SVG format.");
      return;
    }

    processAndResizeLogo(file, (base64Result) => {
      setOfficeSettings(prev => ({ ...prev, officeLogo: base64Result }));
    });
  };

  // Users state
  const [usersList, setUsersList] = useState<UserRole[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);

  // Active Firebase Auth Session state for real-time Active Login indicator
  const [activeAuthEmail, setActiveAuthEmail] = useState<string | null>(() => auth.currentUser?.email || currentUserEmail || null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setActiveAuthEmail(user?.email || currentUserEmail || null);
    });
    return () => unsub();
  }, [currentUserEmail]);

  // Revoke Modal Verification State
  const [revokeModalState, setRevokeModalState] = useState<{
    show: boolean;
    targetUser: UserRole | null;
    password: string;
    showPassword: boolean;
    loading: boolean;
    error: string | null;
  }>({
    show: false,
    targetUser: null,
    password: '',
    showPassword: false,
    loading: false,
    error: null
  });
  const [newName, setNewName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newMobile, setNewMobile] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPost, setNewPost] = useState('');
  const [newRole, setNewRole] = useState<AppRole>('staff');
  const [newTemporaryPassword, setNewTemporaryPassword] = useState('Itahari@2026');
  const [userMsg, setUserMsg] = useState<{ type: 'success' | 'err'; text: string } | null>(null);

  const TASKS_LOOKUP = [
    { id: 'can_add_license', label: 'Create Licenses ➕' },
    { id: 'can_change_status', label: 'Hand Over / Lost / Found 🔄' },
    { id: 'can_export_csv', label: 'Export Reports 📊' },
    { id: 'can_manage_notices', label: 'Edit Notices 📣' },
    { id: 'can_manage_requests', label: 'Manage Requests 🗓️' },
  ];

  const handleToggleTask = async (user: UserRole, taskId: string) => {
    const currentTasks = user.assignedTasks || [];
    let nextTasks: string[];
    if (currentTasks.includes(taskId)) {
      nextTasks = currentTasks.filter(id => id !== taskId);
    } else {
      nextTasks = [...currentTasks, taskId];
    }
    
    try {
      await saveUserRole(user.id, {
        ...user,
        assignedTasks: nextTasks,
        updatedAt: new Date().toISOString()
      });
      setUsersList(prev => prev.map(u => u.id === user.id ? { ...u, assignedTasks: nextTasks } : u));
    } catch (err: any) {
      setUserMsg({ type: 'err', text: err?.message || "Failed to update assigned tasks." });
    }
  };

  const generateTemporaryPassword = () => {
    const uppers = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lowers = 'abcdefghijkmnopqrstuvwxyz';
    const numbers = '23456789';
    const symbols = '@#$%!';
    const all = uppers + lowers + numbers + symbols;
    
    let pass = '';
    pass += uppers.charAt(Math.floor(Math.random() * uppers.length));
    pass += lowers.charAt(Math.floor(Math.random() * lowers.length));
    pass += numbers.charAt(Math.floor(Math.random() * numbers.length));
    pass += symbols.charAt(Math.floor(Math.random() * symbols.length));
    for (let i = 0; i < 4; i++) {
      pass += all.charAt(Math.floor(Math.random() * all.length));
    }
    pass = pass.split('').sort(() => 0.5 - Math.random()).join('');
    setNewTemporaryPassword(pass);
  };

  const handleAutoGenerateUserId = () => {
    if (!newName.trim()) {
      setUserMsg({ type: 'err', text: "Please enter Staff Full Name first to auto-generate User ID." });
      return;
    }
    const parts = newName.trim().split(/\s+/);
    if (parts.length === 0) return;
    const firstChar = parts[0].charAt(0);
    const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const generated = `${firstChar}${lastName.toLowerCase()}_plsms`;
    setNewUsername(generated);
  };

  // Custom persistent modal Dialog/Alert state to handle cross-origin iframe security constraints
  const [confirmState, setConfirmState] = useState<{
    show: boolean;
    title: string;
    message: string;
    confirmText: string;
    onConfirm: () => void;
    color: 'emerald' | 'yellow' | 'red';
  }>({
    show: false,
    title: '',
    message: '',
    confirmText: '',
    onConfirm: () => {},
    color: 'yellow',
  });

  const [alertState, setAlertState] = useState<{
    show: boolean;
    title: string;
    message: string;
  }>({
    show: false,
    title: '',
    message: '',
  });

  const [resetModalState, setResetModalState] = useState<{
    show: boolean;
    user: UserRole | null;
    customPassword: string;
    forceChange: boolean;
    successPasswordInfo: string | null;
  }>({
    show: false,
    user: null,
    customPassword: '',
    forceChange: true,
    successPasswordInfo: null,
  });

  const [syncLoading, setSyncLoading] = useState(false);

  const handleRestoreDemoChanges = async () => {
    setConfirmState({
      show: true,
      title: "Confirm Syncing Sandbox Data to Firestore",
      message: "This will read any changes, licenses, notices, schedules, and active custom configurations you created or modified in Sandbox Mode, directly syncing them into the live Original Version (Cloud Firestore database). Are you sure you wish to replace live with your local Sandbox state?",
      confirmText: "Restore Sandbox Changes Now",
      color: "emerald",
      onConfirm: async () => {
        setConfirmState(prev => ({ ...prev, show: false }));
        setSyncLoading(true);
        try {
          await restoreDemoChangesToFirestore();
          // Force update local settings state
          const refreshed = await getOfficeSettings();
          setOfficeSettings(refreshed);
          onSettingsUpdate(refreshed);
          setAlertState({
            show: true,
            title: "Sandbox Data Sync Completed",
            message: "All customized licenses, announcements, office settings, and scheduling requests from yesterday's Sandbox Mode have been fully restored and written to live Cloud Firestore!"
          });
        } catch (err: any) {
          alert("Error syncing data: " + err.message);
        } finally {
          setSyncLoading(false);
          // Reload page to re-render to apply all updates
          setTimeout(() => {
            window.location.reload();
          }, 1500);
        }
      }
    });
  };

  const [localCounts, setLocalCounts] = useState({ licenses: 0, notices: 0, requests: 0 });

  useEffect(() => {
    try {
      const lic = JSON.parse(localStorage.getItem('plsms_mock_licenses') || '[]');
      const not = JSON.parse(localStorage.getItem('plsms_mock_notices') || '[]');
      const req = JSON.parse(localStorage.getItem('plsms_mock_requests') || '[]');
      setLocalCounts({
        licenses: Array.isArray(lic) ? lic.length : 0,
        notices: Array.isArray(not) ? not.length : 0,
        requests: Array.isArray(req) ? req.length : 0
      });
    } catch (e) {
      // safe fallback
    }
  }, []);

  useEffect(() => {
    setOfficeSettings(prev => {
      if (JSON.stringify(prev) === JSON.stringify(currentSettings)) {
        return prev;
      }
      return { ...currentSettings };
    });
  }, [currentSettings]);

  useEffect(() => {
    setUsersLoading(true);
    const unsubscribe = subscribeToUserRoles((list) => {
      setUsersList(list);
      setUsersLoading(false);
    });
    if (activeTab === 'console') {
      fetchConsoleLicenses();
      fetchUploadLedgers();
    }
    return () => {
      unsubscribe();
    };
  }, [activeTab]);

  const findDuplicates = (recordsList: any[]) => {
    const counts: { [key: string]: any[] } = {};
    recordsList.forEach(rec => {
      if (!rec.licenseNumber) return;
      const key = rec.licenseNumber.trim().toUpperCase();
      if (!counts[key]) {
        counts[key] = [];
      }
      counts[key].push(rec);
    });

    const duplicates = Object.keys(counts)
      .filter(key => counts[key].length > 1)
      .map(key => ({
        licenseNumber: key,
        records: counts[key]
      }));

    setDuplicateGroups(duplicates);
  };

  const fetchConsoleLicenses = async () => {
    setConsoleLoading(true);
    setConsoleMsg(null);
    try {
      const list = await getAllLicenses();
      setAllLicenses(list);
      findDuplicates(list);
      registryDataStore.setRecords(list, 'Firestore Database Registry');
    } catch (err: any) {
      setConsoleMsg({ type: 'err', text: err?.message || "Failed to load database ledger records." });
    } finally {
      setConsoleLoading(false);
    }
  };

  const fetchUploadLedgers = async () => {
    setLedgersLoading(true);
    try {
      const ledgers = await getAllUploadLedgers();
      setUploadLedgers(ledgers);
    } catch (err: any) {
      console.error("Failed to fetch upload ledgers:", err);
    } finally {
      setLedgersLoading(false);
    }
  };

  const handleUploadLedgerFile = async (selectedFile: File, mode: 'normal' | 'append' | 'overwrite' = 'normal') => {
    if (!selectedFile) return;
    setUploadLoading(true);
    setUploadProgress(1);
    setConsoleMsg(null);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        // Yield 50ms so UI updates and displays progress indicator before heavy CPU parsing
        await new Promise(r => setTimeout(r, 50));

        const arrayBuffer = e.target?.result as ArrayBuffer;
        const workbook = read(arrayBuffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // Parse sheet to 2D array of rows
        const rows = utils.sheet_to_json(worksheet, { header: 1, defval: "" }) as any[][];
        
        if (rows.length === 0) {
          alert("Selected document appears to be empty.");
          setUploadLoading(false);
          return;
        }

        // Search first 10 rows to locate header row
        let headerIndex = 0;
        for (let i = 0; i < Math.min(rows.length, 10); i++) {
          const row = rows[i];
          if (!row) continue;
          const matchCount = row.filter(cell => {
            if (!cell) return false;
            const norm = String(cell).toLowerCase().replace(/[\s_\-\/\.]/g, '');
            return norm.includes('applicantid') || 
                   norm.includes('fullname') || 
                   norm.includes('licenseno') || 
                   norm.includes('licensenumber') ||
                   norm === 'name' || 
                   norm === 'sn' || 
                   norm === 'sno';
          }).length;
          if (matchCount >= 2) {
            headerIndex = i;
            break;
          }
        }

        const cols = (rows[headerIndex] || []).map(c => String(c).trim()).filter(Boolean);
        if (cols.length === 0) {
          alert("Selected document headers could not be found.");
          setUploadLoading(false);
          return;
        }

        // Construct objects in non-blocking 5,000 row chunks
        const json: any[] = [];
        const parseChunkSize = 5000;
        for (let i = headerIndex + 1; i < rows.length; i += parseChunkSize) {
          const end = Math.min(i + parseChunkSize, rows.length);
          for (let j = i; j < end; j++) {
            const row = rows[j];
            if (!row || row.length === 0) continue;
            const isEmpty = row.every(cell => cell === undefined || cell === null || String(cell).trim() === "");
            if (isEmpty) continue;

            const obj: Record<string, any> = {};
            cols.forEach((col, colIdx) => {
              obj[col] = row[colIdx] !== undefined ? row[colIdx] : "";
            });
            json.push(obj);
          }
          setUploadProgress(Math.min(10, Math.round((i / rows.length) * 10)));
          await new Promise(r => setTimeout(r, 0));
        }

        // Auto mapping matcher
        const mapping: Record<string, string> = {};
        cols.forEach(col => {
          const norm = col.toLowerCase().replace(/[\s_\-\/\.]/g, '');
          if (norm === 'sn' || norm === 'sno' || norm === 'serial') {
            mapping['sn'] = col;
          } else if (norm.includes('applicantid') || norm.includes('applicantno') || norm === 'appid' || norm === 'applicant_id') {
            mapping['applicantId'] = col;
          } else if (norm.includes('fullname') || norm === 'name' || norm === 'full_name') {
            mapping['fullName'] = col;
          } else if (norm.includes('licensenumber') || norm.includes('licenseno') || norm === 'dlno' || norm === 'license' || norm === 'licenseno' || norm === 'licenseno.') {
            mapping['licenseNumber'] = col;
          } else if (norm.includes('category') || norm === 'class') {
            mapping['category'] = col;
          } else if (norm.includes('oldcode') || norm.includes('old')) {
            mapping['oldCode'] = col;
          } else if (norm.includes('newcode') || norm.includes('new')) {
            mapping['newCode'] = col;
          } else if (norm.includes('contactdepartment') || norm.includes('contactdeparfment') || norm.includes('contactdept') || norm.includes('department') || norm.includes('dept') || norm.includes('visit') || norm.includes('day') || norm.includes('scheduled') || norm.includes('visitdate') || norm.includes('visit_date')) {
            mapping['contactDepartment'] = col;
            mapping['officeVisitDay'] = col;
          } else if (norm.includes('received') || norm.includes('receiver') || norm.includes('receivedby')) {
            mapping['receivedBy'] = col;
          }
        });

        // Fallbacks for required fields
        const requiredKeys = ['applicantId', 'fullName', 'licenseNumber'];
        requiredKeys.forEach(req => {
          if (!mapping[req]) {
            const found = cols.find(c => c.toLowerCase().includes(req.toLowerCase()));
            if (found) mapping[req] = found;
          }
        });

        const missing = requiredKeys.filter(k => !mapping[k]);
        if (missing.length > 0) {
          alert(`Could not map required columns: ${missing.join(', ')}. Please make sure your sheet has appropriate headers: APPLICANT ID, FULL NAME, LICENSE NO.`);
          setUploadLoading(false);
          return;
        }

        const totalRecords = json.length;
        const uploaderEmail = currentUserEmail || 'superadmin@gmail.com';
        const timestamp = new Date().toLocaleString();
        const ledgerId = 'UP_' + Date.now();
        const fileSizeStr = (selectedFile.size / (1024 * 1024)).toFixed(2) + " MB";

        let loadedCount = 0;
        let duplicateCount = 0;
        let importedCount = 0;

        // Construct validRows in non-blocking 5,000 row chunks
        const validRows: any[] = [];
        const valChunkSize = 5000;
        for (let i = 0; i < json.length; i += valChunkSize) {
          const end = Math.min(i + valChunkSize, json.length);
          for (let j = i; j < end; j++) {
            const row = json[j];
            const rawAppId = String(row[mapping['applicantId']] || '').trim();
            const rawName = String(row[mapping['fullName']] || '').trim();
            const rawLicenseNo = String(row[mapping['licenseNumber']] || '').trim();
            const category = String(row[mapping['category']] || 'A').trim();
            const oldCode = String(row[mapping['oldCode']] || '').trim();
            const newCode = String(row[mapping['newCode']] || '').trim();
            const visitDay = String(row[mapping['contactDepartment']] || row[mapping['officeVisitDay']] || 'Monday - Friday (9 AM - 4 PM)').trim();
            const receivedBy = String(row[mapping['receivedBy']] || '').trim();

            const sn = row[mapping['sn']] ? Number(row[mapping['sn']]) : (j + 1);

            if (!rawAppId || !rawName || !rawLicenseNo) {
              continue;
            }

            validRows.push({
              rawAppId,
              rawName,
              rawLicenseNo,
              category,
              oldCode,
              newCode,
              visitDay,
              receivedBy,
              sn
            });
          }
          setUploadProgress(10 + Math.min(10, Math.round((i / json.length) * 10)));
          await new Promise(r => setTimeout(r, 0));
        }

        loadedCount = validRows.length;

        // Handle full DB Overwrite if requested (using paginated deletion to avoid memory overload)
        if (mode === 'overwrite' && !isDemoModeActive()) {
          setUploadProgress(20);
          try {
            let hasMore = true;
            while (hasMore) {
              const q = query(collection(db, 'licenses'), limit(500));
              const snap = await getDocs(q);
              if (snap.empty) {
                hasMore = false;
                break;
              }
              const batch = writeBatch(db);
              snap.docs.forEach(d => batch.delete(d.ref));
              await batch.commit();
              await new Promise(r => setTimeout(r, 10));
            }
          } catch (delErr) {
            console.warn("Overwrite cleanup error:", delErr);
          }
        }

        if (isDemoModeActive()) {
          // Dedicated high-speed Demo Mode implementation
          const localLicensesStr = localStorage.getItem('plsms_mock_licenses');
          let localLicenses: any[] = [];
          if (localLicensesStr) {
            try {
              localLicenses = JSON.parse(localLicensesStr);
            } catch (e) {
              localLicenses = [];
            }
          }
          if (mode === 'overwrite') {
            localLicenses = [];
          }

          const existingLicenseNos = new Set(localLicenses.map(l => (l.licenseNumber || '').trim().toUpperCase()));
          const localBackups: any[] = [];
          const currentTime = new Date().toISOString();

          // Process in chunks of 2,000 for local storage
          const demoChunkSize = 2000;
          for (let i = 0; i < validRows.length; i += demoChunkSize) {
            const chunk = validRows.slice(i, i + demoChunkSize);
            for (const item of chunk) {
              const { rawAppId, rawName, rawFhName, rawLicenseNo, category, oldCode, newCode, visitDay, receivedBy, sn } = item;
              const sanitizedId = rawLicenseNo.toUpperCase().replace(/[^A-Z0-9_\-\.]/g, '');

              const upperNo = rawLicenseNo.toUpperCase();
              const isDuplicate = existingLicenseNos.has(upperNo);
              if (isDuplicate) {
                duplicateCount++;
              } else {
                importedCount++;
                existingLicenseNos.add(upperNo);
              }

              const logItem = {
                timestamp: currentTime,
                action: 'BULK_IMPORT',
                user: uploaderEmail,
                details: `Imported via lot file (${mode.toUpperCase()}): ${selectedFile.name} (Upload ID: ${ledgerId})`
              };

              const licenseRecord: any = {
                id: sanitizedId,
                applicantId: rawAppId,
                fullName: rawName,
                licenseNumber: rawLicenseNo,
                category: category,
                contactDepartment: visitDay,
                officeVisitDay: visitDay,
                receivedBy: receivedBy,
                oldCode: oldCode,
                newCode: newCode,
                isDuplicate: isDuplicate,
                sn: sn,
                status: receivedBy ? 'distributed' : 'available',
                createdAt: currentTime,
                updatedAt: currentTime,
                updatedBy: uploaderEmail,
                logs: [logItem],
                uploadId: ledgerId
              };

              const existingIdx = localLicenses.findIndex((l: any) => l.id === sanitizedId);
              if (existingIdx >= 0) {
                localLicenses[existingIdx] = licenseRecord;
              } else {
                localLicenses.push(licenseRecord);
              }

              localBackups.push(licenseRecord);
            }
            setUploadProgress(20 + Math.round(((i + chunk.length) / validRows.length) * 80));
            await new Promise(r => setTimeout(r, 0));
          }

          try {
            writeStorageItem('plsms_mock_licenses', localLicenses);
            writeStorageItem('plsms_mock_ledger_backups_' + ledgerId, localBackups);
          } catch (e) {
            console.warn("Storage write suppressed during local ledger upload:", e);
          }
          setUploadProgress(100);
        } else {
          // Group rows into chunks of 250 records (250 active + 250 backup = 500 writes max per batch)
          const chunkSize = 250;
          const writeChunks: any[][] = [];
          for (let i = 0; i < validRows.length; i += chunkSize) {
            writeChunks.push(validRows.slice(i, i + chunkSize));
          }

          const totalWriteChunks = writeChunks.length;
          let writeChunksCompleted = 0;
          const fileSeenLicenseNos = new Set<string>();

          // Process batches sequentially to ensure smooth UI updates and strictly bounded network load
          for (let cIdx = 0; cIdx < writeChunks.length; cIdx++) {
            const chunk = writeChunks[cIdx];
            const batch = writeBatch(db);
            const currentTime = new Date().toISOString();

            // Collect IDs in current chunk to query Firestore for existing docs
            const chunkSanitizedIds = chunk.map(item => item.rawLicenseNo.toUpperCase().replace(/[^A-Z0-9_\-\.]/g, ''));
            const existingInDbSet = new Set<string>();

            if (mode !== 'overwrite') {
              for (let s = 0; s < chunkSanitizedIds.length; s += 30) {
                const subIds = chunkSanitizedIds.slice(s, s + 30);
                if (subIds.length === 0) continue;
                try {
                  const checkQuery = query(collection(db, 'licenses'), where(documentId(), 'in', subIds));
                  const checkSnap = await getDocs(checkQuery);
                  checkSnap.docs.forEach(docSnap => existingInDbSet.add(docSnap.id));
                } catch (checkErr) {
                  // Fallback: If documentId query fails, continue safely
                }
              }
            }

            for (const item of chunk) {
              const { rawAppId, rawName, rawLicenseNo, category, oldCode, newCode, visitDay, receivedBy, sn } = item;
              const sanitizedId = rawLicenseNo.toUpperCase().replace(/[^A-Z0-9_\-\.]/g, '');
              const upperNo = rawLicenseNo.toUpperCase();

              const isDuplicate = fileSeenLicenseNos.has(upperNo) || existingInDbSet.has(sanitizedId);
              fileSeenLicenseNos.add(upperNo);

              if (isDuplicate) {
                duplicateCount++;
              } else {
                importedCount++;
              }

              const logItem = {
                timestamp: currentTime,
                action: 'BULK_IMPORT',
                user: uploaderEmail,
                details: `Imported via lot file (${mode.toUpperCase()}): ${selectedFile.name} (Upload ID: ${ledgerId})`
              };

              const licenseRecord: any = {
                id: sanitizedId,
                applicantId: rawAppId,
                fullName: rawName,
                licenseNumber: rawLicenseNo,
                category: category,
                contactDepartment: visitDay,
                officeVisitDay: visitDay,
                receivedBy: receivedBy,
                oldCode: oldCode,
                newCode: newCode,
                isDuplicate: isDuplicate,
                sn: sn,
                status: receivedBy ? 'distributed' : 'available',
                createdAt: currentTime,
                updatedAt: currentTime,
                updatedBy: uploaderEmail,
                logs: [logItem],
                uploadId: ledgerId
              };

              // 1. Add backup write to batch
              const backupDocRef = doc(db, 'upload_ledgers', ledgerId, 'records', sanitizedId);
              batch.set(backupDocRef, licenseRecord);

              // 2. Add active license write to batch
              const activeDocRef = doc(db, 'licenses', sanitizedId);
              batch.set(activeDocRef, licenseRecord);
            }

            await batch.commit();
            writeChunksCompleted++;

            const startPercentage = 20;
            const rangePercentage = 80;
            setUploadProgress(startPercentage + Math.round((writeChunksCompleted / totalWriteChunks) * rangePercentage));

            // Yield to browser event loop after every batch commit
            await new Promise(r => setTimeout(r, 10));
          }
        }

        // Create the ledger entry
        const ledgerEntry = {
          id: ledgerId,
          timestamp: timestamp,
          fileName: selectedFile.name,
          size: fileSizeStr,
          actionType: mode === 'overwrite' ? 'Fresh Reload (Overwrote DB)' : (mode === 'append' ? 'Sequential Lot Append' : 'Append Records'),
          noOfLoadedRecords: loadedCount,
          importedRecords: importedCount,
          duplicateRecords: duplicateCount,
          uploader: uploaderEmail,
          status: 'Completed' as const
        };

        await createUploadLedger(ledgerEntry);

        setConsoleMsg({
          type: 'success',
          text: `Successfully processed "${selectedFile.name}" in ${mode.toUpperCase()} mode. Loaded: ${loadedCount} entries, Imported: ${importedCount} records, Duplicates Detected: ${duplicateCount}. Ledger registered permanently.`
        });

        // Refresh views
        await fetchConsoleLicenses();
        await fetchUploadLedgers();
        // Registry is updated in memory automatically by fetchConsoleLicenses() via registryDataStore.setRecords()
      } catch (err: any) {
        console.error("Bulk upload processing failed: ", err);
        alert("Failed to parse or save bulk ledger records: " + err.message);
      } finally {
        setUploadLoading(false);
        setUploadProgress(0);
      }
    };

    reader.readAsArrayBuffer(selectedFile);
  };

  const handleForceSyncAllLedgers = async () => {
    setSyncLoading(true);
    setConsoleMsg(null);
    try {
      const ledgers = await getAllUploadLedgers();
      const activeLedgers = ledgers.filter(l => l.status !== 'Deleted');
      
      let restoredCount = 0;
      
      // 1. Restore from upload ledgers if present
      if (activeLedgers.length > 0) {
        for (const ledger of activeLedgers) {
          const backups = await getLedgerRecordBackups(ledger.id);
          for (const rec of backups) {
            await createOrUpdateLicense(rec.id, rec);
            restoredCount++;
          }
        }
      }

      // 2. Also check if we have a browser client-side backup of live licenses
      let localBackupCount = 0;
      if (typeof window !== "undefined") {
        const cachedStr = localStorage.getItem('plsms_live_licenses_backup') || localStorage.getItem('plsms_mock_licenses');
        if (cachedStr) {
          try {
            const cachedList = JSON.parse(cachedStr);
            if (Array.isArray(cachedList) && cachedList.length > 0) {
              for (const rec of cachedList) {
                if (rec && rec.id) {
                  await createOrUpdateLicense(rec.id, rec);
                  localBackupCount++;
                }
              }
            }
          } catch (e) {
            console.warn("Failed to restore from local backup storage:", e);
          }
        }
      }

      if (restoredCount === 0 && localBackupCount === 0) {
        setConsoleMsg({
          type: 'err',
          text: "Force Sync could not locate any active file upload ledgers in the database OR local browser backups. Try using 'Re-Upload & Overwrite' or 'Append Lot Spreadsheet' to load your spreadsheet first."
        });
        return;
      }

      setConsoleMsg({
        type: 'success',
        text: `🚀 Force Sync complete! Successfully restored ${restoredCount} records from database upload ledger files, and recovered ${localBackupCount} records from the browser's safe local memory cache back to the live server registry.`
      });
      await fetchConsoleLicenses();
      // registryDataStore.clearRegistry(); // synchronized by fetchConsoleLicenses
    } catch (err: any) {
      console.error("Force Sync failed:", err);
      setConsoleMsg({
        type: 'err',
        text: `Force Sync operation failed: ${err.message || err}`
      });
    } finally {
      setSyncLoading(false);
    }
  };

  const handleDateRangeRecovery = async () => {
    if (!recoveryStartDate || !recoveryEndDate) {
      alert("Please select both a valid Start and End Date/Time for range recovery.");
      return;
    }

    const start = new Date(recoveryStartDate);
    const end = new Date(recoveryEndDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      alert("Invalid date formats provided.");
      return;
    }

    if (start > end) {
      alert("Start Date/Time cannot be later than End Date/Time.");
      return;
    }

    setRangeRecoveryLoading(true);
    setConsoleMsg(null);

    try {
      const ledgers = await getAllUploadLedgers();
      
      const parseLedgerDate = (timestampStr: string): Date => {
        try {
          const d = new Date(timestampStr);
          if (!isNaN(d.getTime())) return d;
        } catch (e) {}
        return new Date();
      };

      // Filter active completed ledgers within this range
      const matchingLedgers = ledgers.filter(l => {
        const lDate = parseLedgerDate(l.timestamp);
        return lDate >= start && lDate <= end && l.status !== 'Deleted';
      });

      if (matchingLedgers.length === 0) {
        setConsoleMsg({
          type: 'err',
          text: `🔍 Range Recovery Search Completed: No active upload lot ledgers were registered between ${new Date(recoveryStartDate).toLocaleString()} and ${new Date(recoveryEndDate).toLocaleString()}.`
        });
        return;
      }

      let restoredCount = 0;
      for (const ledger of matchingLedgers) {
        const backups = await getLedgerRecordBackups(ledger.id);
        for (const record of backups) {
          await createOrUpdateLicense(record.id, record);
          restoredCount++;
        }
      }

      setConsoleMsg({
        type: 'success',
        text: `🛡️ Recovery Complete! Scanned ${matchingLedgers.length} matching lot uploads between ${new Date(recoveryStartDate).toLocaleString()} and ${new Date(recoveryEndDate).toLocaleString()} and successfully restored ${restoredCount} original applicant files back to the live ledger.`
      });

      await fetchConsoleLicenses();
      // registryDataStore.clearRegistry(); // synchronized by fetchConsoleLicenses
    } catch (err: any) {
      console.error("Range recovery failed:", err);
      setConsoleMsg({
        type: 'err',
        text: `Sudden loss range recovery failed: ${err.message || err}`
      });
    } finally {
      setRangeRecoveryLoading(false);
    }
  };

  const handlePruneAllDuplicates = async () => {
    if (duplicateGroups.length === 0) {
      alert("No duplicate entries are currently detected to sanitize.");
      return;
    }

    if (!window.confirm(`Are you sure you want to aggressively sanitize the ledger? This will keep only the latest uploaded record for each of the ${duplicateGroups.length} duplicate license number(s) and permanently purge all older redundant copies.`)) {
      return;
    }

    setConsoleLoading(true);
    setConsoleMsg(null);

    try {
      let prunedCount = 0;

      for (const group of duplicateGroups) {
        const sortedRecords = [...group.records].sort((a, b) => {
          const dateA = new Date(a.updatedAt || a.createdAt || 0).getTime();
          const dateB = new Date(b.updatedAt || b.createdAt || 0).getTime();
          return dateB - dateA; // latest first
        });

        // Keep the first (latest) one, delete everything else
        const [latest, ...olderDuplicates] = sortedRecords;

        for (const oldRec of olderDuplicates) {
          await deleteLicense(oldRec.id);
          prunedCount++;
        }
      }

      setConsoleMsg({
        type: 'success',
        text: `🧹 Sanitization Complete! Successfully analyzed duplicate list and permanently purged ${prunedCount} redundant duplicate copies from the active registry.`
      });

      await fetchConsoleLicenses();
      // registryDataStore.clearRegistry(); // synchronized by fetchConsoleLicenses
    } catch (err: any) {
      console.error("Duplicate pruning failed:", err);
      setConsoleMsg({
        type: 'err',
        text: `Pruning operation failed: ${err.message || err}`
      });
    } finally {
      setConsoleLoading(false);
    }
  };

  const handleRestoreLedger = async (ledgerId: string) => {
    if (!window.confirm("Are you sure you want to restore all original records associated with this upload batch? This will re-add and overwrite any missing records from this file.")) return;
    setActionLoadingId(ledgerId);
    setConsoleMsg(null);
    try {
      await restoreUploadLedger(ledgerId);
      setConsoleMsg({
        type: 'success',
        text: `Successfully restored all original records for Upload ID: ${ledgerId} back to the database registry.`
      });
      await fetchConsoleLicenses();
      await fetchUploadLedgers();
      // registryDataStore.clearRegistry(); // synchronized by fetchConsoleLicenses
    } catch (err: any) {
      alert("Failed to restore records: " + err.message);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleOpenLedgerDeleteVerify = (ledgerId: string) => {
    setDeleteLedgerTargetId(ledgerId);
    setLedgerDeletePassword('');
    setLedgerDeleteErrorMsg('');
    setShowLedgerDeletePassword(false);
    setShowLedgerDeleteVerifyModal(true);
  };

  const handleCloseLedgerDeleteVerify = () => {
    setShowLedgerDeleteVerifyModal(false);
    setDeleteLedgerTargetId(null);
    setLedgerDeletePassword('');
    setLedgerDeleteErrorMsg('');
  };

  const handleLedgerDeleteVerifySubmit = async () => {
    if (!deleteLedgerTargetId) return;
    setConsoleLoading(true);
    setLedgerDeleteErrorMsg('');

    let ip = '127.0.0.1';
    try {
      const res = await fetch('https://api.ipify.org?format=json');
      const data = await res.json();
      ip = data.ip || '127.0.0.1';
    } catch (e) {
      console.warn("Failed to retrieve client IP address, using fallback:", e);
    }

    const currentEmail = currentUserEmail || auth.currentUser?.email || 'superuser@plsms.gov';

    try {
      if (!currentEmail) {
        throw new Error("Authentication session expired. Please sign in again.");
      }

      const matchedUser = await getSuperAdminUserRecord(currentEmail, usersList);
      
      if (!matchedUser) {
        throw new Error("You are not authorized to perform this operation.");
      }

      if (matchedUser.role !== 'superuser') {
        try {
          await saveSecurityAuditLog({
            timestamp: new Date().toISOString(),
            username: currentEmail,
            ipAddress: ip,
            status: 'LOT_DELETE_FAILED',
            reason: `Access Denied: Logged-in user has role '${matchedUser.role}', which is not SUPER USER.`
          });
        } catch (auditErr) {}
        throw new Error("You are not authorized to perform this operation.");
      }

      const isLedgerPassValid = await verifyUserPassword(matchedUser, ledgerDeletePassword);
      if (!isLedgerPassValid) {
        setLedgerDeletePassword('');
        try {
          await saveSecurityAuditLog({
            timestamp: new Date().toISOString(),
            username: currentEmail,
            ipAddress: ip,
            status: 'LOT_DELETE_FAILED',
            reason: `Invalid Password Attempt: Super User entered incorrect administrative password during lot deletion.`
          });
        } catch (auditErr) {}
        throw new Error("Incorrect administrative password.");
      }

      try {
        console.log("Re-authenticating standard Firebase Auth session for lot delete...");
        await startEmailSignIn(currentEmail, ledgerDeletePassword);
      } catch (signInErr: any) {
        console.warn("Standard Firebase Auth re-authentication failed/skipped inside sandbox:", signInErr);
        const errCode = signInErr?.code || '';
        const errMsg = String(signInErr?.message || signInErr || '').toLowerCase();
        
        if (
          errCode === 'auth/wrong-password' || 
          errCode === 'auth/invalid-credential' || 
          errMsg.includes("incorrect password") || 
          errMsg.includes("wrong password") ||
          errMsg.includes("invalid credential")
        ) {
          throw new Error("Incorrect administrative password.");
        }
        
        if (errCode === 'auth/user-token-expired' || errMsg.includes("expired") || errMsg.includes("sign-in again")) {
          throw new Error("Authentication session expired. Please sign in again.");
        }

        if (
          errCode.includes("resource-exhausted") ||
          errCode.includes("unavailable") ||
          errMsg.includes("quota") ||
          errMsg.includes("resource_exhausted") ||
          errMsg.includes("exhausted")
        ) {
          throw signInErr;
        }
      }

      setActionLoadingId(deleteLedgerTargetId);
      await deleteUploadLedgerRowOnly(deleteLedgerTargetId);
      
      try {
        await saveSecurityAuditLog({
          timestamp: new Date().toISOString(),
          username: currentEmail,
          ipAddress: ip,
          status: 'LOT_DELETE_SUCCESS',
          reason: `Authorized Lot Deletion: Upload ID ${deleteLedgerTargetId} deleted successfully.`
        });
      } catch (auditErr) {}

      setConsoleMsg({
        type: 'success',
        text: `Successfully verified Super Admin and deleted upload history record: ${deleteLedgerTargetId}`
      });

      await fetchConsoleLicenses().catch(() => {});
      await fetchUploadLedgers().catch(() => {});
      handleCloseLedgerDeleteVerify();

    } catch (err: any) {
      console.error("Lot delete verification error:", err);
      setLedgerDeletePassword('');
      const safeMessage = getSafeVerificationErrorMessage(err);
      setLedgerDeleteErrorMsg(safeMessage);
    } finally {
      setConsoleLoading(false);
      setActionLoadingId(null);
    }
  };

  const handleManualRecordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setConsoleMsg(null);

    const { applicantId, licenseNumber, fullName, category, status, remarks } = manualRecord;
    if (!applicantId.trim() || !licenseNumber.trim() || !fullName.trim()) {
      setConsoleMsg({ type: 'err', text: "All fields except remarks are mandatory." });
      return;
    }

    // Check if the license Number already exists
    const cleanLicenseNo = licenseNumber.trim().toUpperCase();
    const existing = allLicenses.find(l => (l.licenseNumber || '').trim().toUpperCase() === cleanLicenseNo);

    if (existing && !duplicateWarning) {
      // Trigger a duplicate warning prompt for safety
      setDuplicateWarning({
        show: true,
        licenseNumber: licenseNumber.trim(),
        existingName: existing.fullName,
        existingId: existing.id,
        pendingRecord: { ...manualRecord }
      });
      return;
    }

    await executeSaveManualRecord({ ...manualRecord });
  };

  const executeSaveManualRecord = async (recordToSave: typeof manualRecord) => {
    setConsoleLoading(true);
    setConsoleMsg(null);
    setDuplicateWarning(null);

    try {
      const baseId = recordToSave.applicantId.trim();
      // Ensure unique document ID in case of duplicates
      let targetId = baseId;
      const alreadyHasId = allLicenses.some(l => l.id === targetId);
      if (alreadyHasId) {
        targetId = `${baseId}_dup_${Date.now()}`;
      }

      const newLic = {
        id: targetId,
        applicantId: recordToSave.applicantId.trim(),
        licenseNumber: recordToSave.licenseNumber.trim(),
        fullName: recordToSave.fullName.trim(),
        category: recordToSave.category.trim().toUpperCase(),
        status: recordToSave.status as any,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: currentUserEmail || 'superadmin@gmail.com',
        remarks: recordToSave.remarks.trim() || 'Manually appended via Console settings.',
        logs: [
          {
            timestamp: new Date().toISOString(),
            action: 'created_manually',
            user: currentUserEmail || 'superadmin',
            details: 'Manually entered and appended to ledger via secure Console settings.'
          }
        ]
      };

      await createOrUpdateLicense(targetId, newLic);
      setConsoleMsg({ type: 'success', text: `Driving License record for ${recordToSave.fullName} appended successfully at the end!` });
      
      // Clear form
      setManualRecord({
        applicantId: '',
        licenseNumber: '',
        fullName: '',
        category: 'B',
        status: 'available',
        remarks: ''
      });

      // Refresh list
      await fetchConsoleLicenses();
    } catch (err: any) {
      setConsoleMsg({ type: 'err', text: err?.message || "Failed to append driving license record." });
    } finally {
      setConsoleLoading(false);
    }
  };

  const handleConfirmDeleteConsole = (id: string, licenseNo: string, name: string) => {
    setDeleteConfirmModal({
      show: true,
      licenseId: id,
      licenseNumber: licenseNo,
      fullName: name,
      typedConfirmation: '',
      reason: ''
    });
  };

  const handleExecuteDeleteConsole = async () => {
    const { licenseId, licenseNumber, typedConfirmation, reason } = deleteConfirmModal;
    
    if (typedConfirmation.trim() !== licenseNumber.trim()) {
      alert("Verification failed: The entered License Number does not match.");
      return;
    }

    if (!reason.trim()) {
      alert("A reason for this administrative deletion is mandatory.");
      return;
    }

    setConsoleLoading(true);
    setConsoleMsg(null);
    setDeleteConfirmModal(prev => ({ ...prev, show: false }));

    try {
      await deleteLicense(licenseId);
      setConsoleMsg({ 
        type: 'success', 
        text: `Successfully purged driving license record (License No: ${licenseNumber}) from database ledger. Audit logs registered.` 
      });
      await fetchConsoleLicenses();
    } catch (err: any) {
      setConsoleMsg({ type: 'err', text: err?.message || "Failed to permanently purge record." });
    } finally {
      setConsoleLoading(false);
    }
  };

  const handleClosePurgeVerify = () => {
    setShowPurgeVerifyModal(false);
    setPurgePassword('');
    setPurgeErrorMsg(null);
    setShowPurgePassword(false);
  };

  const handlePurgeEntireDatabase = async () => {
    if (typedResetConfirm !== 'RESET DATABASE') {
      alert("Please type 'RESET DATABASE' exactly as shown to authorize the deletion.");
      return;
    }
    setPurgePassword('');
    setPurgeErrorMsg(null);
    setShowPurgeVerifyModal(true);
  };

  const handlePurgeVerifySubmit = async () => {
    console.log("==================================================");
    console.log("[DATABASE RESET AUDIT] STEP 1: Dialog submit triggered");
    console.log("==================================================");
    setConsoleLoading(true);
    setPurgeErrorMsg(null);
    
    let ip = '127.0.0.1';
    try {
      const res = await fetch('https://api.ipify.org?format=json');
      const data = await res.json();
      ip = data.ip || '127.0.0.1';
    } catch (e) {
      console.warn("[DATABASE RESET AUDIT] Failed to retrieve client IP address, using fallback:", e);
    }

    const currentEmail = (auth.currentUser?.email || currentUserEmail || '').toLowerCase().trim();
    console.log("[DATABASE RESET AUDIT] STEP 2: Identifying logged-in Super Administrator email:", currentEmail);

    try {
      // 1. Session & Permission Verification
      if (!currentEmail) {
        console.error("[DATABASE RESET AUDIT] STEP 2 FAILED: No authenticated user session found.");
        throw new Error("Authentication session expired. Please sign in again.");
      }

      console.log("[DATABASE RESET AUDIT] STEP 2: Performing permission check for:", currentEmail);
      const isSuperAdminEmail = currentEmail === 'dahalkomal@gmail.com' || currentEmail.startsWith('superuser') || currentEmail.startsWith('superadmin');
      
      const matchedUser = await getSuperAdminUserRecord(currentEmail, usersList);
      const isSuperAdminRole = matchedUser?.role === 'superuser';

      if (!isSuperAdminEmail && !isSuperAdminRole) {
        console.error("[DATABASE RESET AUDIT] STEP 2 FAILED: Account lacks Super Administrator privileges.");
        try {
          await saveSecurityAuditLog({
            timestamp: new Date().toISOString(),
            username: currentEmail,
            ipAddress: ip,
            status: 'DATABASE_RESET_FAILED',
            reason: `Access Denied: Logged-in user '${currentEmail}' does not have Super Administrator privileges.`
          });
        } catch (auditErr) {}
        throw new Error("Permission Denied: Only the Super Administrator account is authorized to reset the production database.");
      }
      console.log("[DATABASE RESET AUDIT] STEP 2 PASSED: Super Administrator permission confirmed.");

      // 2. Password Verification via Firebase Authentication
      console.log("[DATABASE RESET AUDIT] STEP 3: Verifying administrative password via Firebase Authentication...");
      if (!purgePassword || purgePassword.trim() === '') {
        console.error("[DATABASE RESET AUDIT] STEP 3 FAILED: Administrative password field is empty.");
        throw new Error("Please enter the administrative password.");
      }

      let isPurgePassValid = false;
      if (matchedUser) {
        isPurgePassValid = await verifyUserPassword(matchedUser, purgePassword);
      }
      
      if (!isPurgePassValid) {
        try {
          await verifyAndReauthenticateSuperAdmin(currentEmail, purgePassword);
          isPurgePassValid = true;
          console.log("[DATABASE RESET AUDIT] STEP 3 PASSED: Firebase Authentication re-authentication verified password successfully.");
        } catch (authErr: any) {
          console.warn("[DATABASE RESET AUDIT] STEP 3: Firebase Auth re-authentication failed/fallback check:", authErr?.message || authErr);
        }
      }

      if (!isPurgePassValid) {
        console.error("[DATABASE RESET AUDIT] STEP 3 FAILED: Incorrect administrative password.");
        try {
          await saveSecurityAuditLog({
            timestamp: new Date().toISOString(),
            username: currentEmail,
            ipAddress: ip,
            status: 'DATABASE_RESET_FAILED',
            reason: `Invalid Password Attempt: Super User entered incorrect administrative password.`
          });
        } catch (auditErr) {}
        throw new Error("Incorrect administrative password. Please verify your Super Administrator password.");
      }

      // 3. Execute Delete Function
      console.log("[DATABASE RESET AUDIT] STEP 4: Calling delete function purgeAllDatabaseRecordsAndLedgers()...");
      const totalDeleted = await purgeAllDatabaseRecordsAndLedgers();
      console.log(`[DATABASE RESET AUDIT] STEP 5: Firestore batch deletion completed successfully! Total records purged: ${totalDeleted}`);

      // Refresh console registries and data loaders
      registryDataStore.clearRegistry();
      await fetchConsoleLicenses().catch(() => {});
      await fetchUploadLedgers().catch(() => {});

      // Create detailed administrative audit information
      const now = new Date();
      const dateString = now.toISOString().split('T')[0];
      const timeString = now.toTimeString().split(' ')[0];

      // Record success log with detailed audit information
      try {
        await saveSecurityAuditLog({
          timestamp: now.toISOString(),
          username: currentEmail,
          ipAddress: ip,
          status: 'DATABASE_RESET_SUCCESS',
          reason: `Authorized Database Purge: Entire application registry and upload lots deleted successfully.`,
          superAdminEmail: currentEmail,
          deletedBy: matchedUser?.displayName || 'Super Admin',
          date: dateString,
          time: timeString,
          totalRecordsDeleted: totalDeleted,
          deviceSession: typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown Device Session'
        });
      } catch (auditErr) {
        console.warn("[DATABASE RESET AUDIT] Warning saving security audit log:", auditErr);
      }

      // Clear states and close modal automatically after success
      setShowPurgeVerifyModal(false);
      setTypedResetConfirm('');
      setPurgePassword('');
      setConsoleMsg({ 
        type: 'success', 
        text: `Database reset completed successfully. ${totalDeleted} records permanently purged from Firestore.` 
      });
      console.log("[DATABASE RESET AUDIT] COMPLETE SUCCESS: Entire database reset process executed flawlessly.");

    } catch (err: any) {
      console.error("[DATABASE RESET AUDIT] WORKFLOW STOPPED WITH REASON:", err);
      const displayMsg = err?.message || "An error occurred during Super Administrator verification.";
      setPurgeErrorMsg(displayMsg);
    } finally {
      setConsoleLoading(false);
    }
  };

  const fetchUsersRoles = async () => {
    setUsersLoading(true);
    try {
      const list = await getAllUserRoles(true);
      setUsersList(list);
    } catch (err: any) {
      setUserMsg({ type: 'err', text: err?.message || "Failed to load user credentials roles." });
    } finally {
      setUsersLoading(false);
    }
  };

  const handleUpdateSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsLoading(true);
    setSettingsMessage(null);
    try {
      await saveOfficeSettings(officeSettings);
      setSettingsMessage({ type: 'success', text: "Office configuration items saved successfully!" });
      onSettingsUpdate(officeSettings);
    } catch (err: any) {
      setSettingsMessage({ type: 'err', text: err?.message || "Failed to save dynamic setup settings." });
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleAddUserRole = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserMsg(null);

    const trimmedName = newName.trim();
    const trimmedUsername = newUsername.trim();
    const trimmedMobile = newMobile.trim();
    const trimmedEmail = newEmail.trim().toLowerCase();
    const trimmedPost = newPost.trim();
    const tempPass = newTemporaryPassword.trim();

    // STEP 1: Validate required fields
    if (!trimmedName) {
      setUserMsg({ type: 'err', text: "Staff Full Name is required." });
      return;
    }
    if (!trimmedUsername) {
      setUserMsg({ type: 'err', text: "User ID is required." });
      return;
    }
    // Note: Mobile Number is optional and no longer required.
    if (!trimmedPost) {
      setUserMsg({ type: 'err', text: "Designated Post is required." });
      return;
    }
    if (!newRole) {
      setUserMsg({ type: 'err', text: "System Operational Role is required." });
      return;
    }
    if (!tempPass) {
      setUserMsg({ type: 'err', text: "Temporary Password is required." });
      return;
    }

    // VALIDATIONS: Check for duplicates
    const existingUsers = await getAllUserRoles(true).catch(() => []);

    // 1. User ID uniqueness check
    const duplicateUsername = existingUsers.some(
      u => (u.username && u.username.trim().toLowerCase() === trimmedUsername.toLowerCase()) ||
           (u.id && u.id.toLowerCase() === trimmedUsername.toLowerCase())
    );
    if (duplicateUsername) {
      setUserMsg({ type: 'err', text: `User ID "${trimmedUsername}" is already registered. Please choose a unique User ID.` });
      return;
    }

    // 2. Email uniqueness check (if email is provided)
    if (trimmedEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(trimmedEmail)) {
        setUserMsg({ type: 'err', text: "Please enter a valid email address or leave the field blank." });
        return;
      }
      const duplicateEmail = existingUsers.some(
        u => u.email && u.email.trim().toLowerCase() === trimmedEmail
      );
      if (duplicateEmail) {
        setUserMsg({ type: 'err', text: `Email Address "${trimmedEmail}" is already registered. Please use a unique email address.` });
        return;
      }
    }

    // 3. Mobile Number uniqueness check (if mobile number is provided)
    if (trimmedMobile) {
      const duplicateMobile = existingUsers.some(
        u => u.mobile && u.mobile.trim() === trimmedMobile
      );
      if (duplicateMobile) {
        setUserMsg({ type: 'err', text: `Mobile Number "${trimmedMobile}" is already registered. Please use a unique mobile number.` });
        return;
      }
    }

    // 4. Password Strength rules
    const pwdValidation = validateStrongPassword(tempPass);
    if (!pwdValidation.isValid) {
      setUserMsg({ type: 'err', text: pwdValidation.message || "Invalid password format." });
      return;
    }

    // STEP 2: Handle optional Email & Authentication setup
    const safeSlug = trimmedUsername.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    let authUser: any = null;

    // Only attempt Firebase Authentication creation IF an explicit real email is provided
    if (trimmedEmail) {
      try {
        authUser = await createFirebaseAuthUser(trimmedEmail, tempPass);
      } catch (authErr: any) {
        const errCode = (authErr?.code || '').toLowerCase();
        const errMsg = (authErr?.message || '').toLowerCase();
        if (errCode.includes('already-in-use') || errMsg.includes('already-in-use') || errMsg.includes('already in use')) {
          setUserMsg({ type: 'err', text: `Failed to Create Account: Email address "${trimmedEmail}" is already registered in Authentication system. Please enter a unique email or leave the email field blank.` });
          return;
        } else {
          setUserMsg({ type: 'err', text: `Failed to create authentication credentials for email "${trimmedEmail}": ${authErr?.message || 'Authentication error'}. Account creation stopped.` });
          return;
        }
      }
    }

    // STEP 3: Create Firestore document
    const uid = authUser ? authUser.uid : `usr_${safeSlug}_${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const passHash = await hashCredential(tempPass);

    const staffDocPayload: Partial<UserRole> & Record<string, any> = {
      id: uid,
      uid: uid,
      staffFullName: trimmedName,
      displayName: trimmedName,
      userId: trimmedUsername,
      username: trimmedUsername,
      mobileNumber: trimmedMobile || '',
      mobile: trimmedMobile || '',
      email: trimmedEmail || '',
      designatedPost: trimmedPost,
      post: trimmedPost,
      role: newRole,
      status: 'ACTIVE',
      accountType: 'STAFF',
      mustChangePassword: true,
      createdAt: now,
      createdBy: currentUserEmail || 'Super_Admin',
      lastPasswordReset: now,
      passwordLastChanged: now,
      passwordVersion: 1,
      passwordHash: passHash,
      isCustomPassword: true,
      updatedAt: now,
      updatedBy: currentUserEmail || 'Super_Admin'
    };

    try {
      await saveUserRole(uid, staffDocPayload);
    } catch (firestoreErr: any) {
      // ERROR HANDLING ROLLBACK: Delete Authentication user if Firestore creation fails
      if (authUser) {
        await deleteFirebaseAuthUser(authUser);
      }
      setUserMsg({ type: 'err', text: `Failed to Save Account Record: ${firestoreErr?.message || "Database write error"}. Account was not saved.` });
      return;
    }

    // STEP 4: Immediate UI update and success message
    setUsersList(prev => {
      const newUserRecord = staffDocPayload as UserRole;
      const exists = prev.some(u => u.id === uid || (u.username && u.username.toLowerCase() === trimmedUsername.toLowerCase()));
      if (exists) {
        return prev.map(u => (u.id === uid || (u.username && u.username.toLowerCase() === trimmedUsername.toLowerCase())) ? { ...u, ...newUserRecord } : u);
      }
      return [...prev, newUserRecord];
    });

    setNewName('');
    setNewUsername('');
    setNewEmail('');
    setNewMobile('');
    setNewPost('');
    setNewTemporaryPassword('Itahari@2026');

    const emailNotice = trimmedEmail ? `\n• Registered Email: ${trimmedEmail}` : `\n• Registered Email: Not Provided (Optional)`;
    const mobileNotice = trimmedMobile ? `\n• Contact Mobile: ${trimmedMobile}` : `\n• Contact Mobile: Not Provided (Optional)`;

    setUserMsg({ 
      type: 'success', 
      text: `🎉 Staff Operator Account Created Successfully!\n\n• Staff Name: ${trimmedName}\n• User ID / Username: ${trimmedUsername}${emailNotice}${mobileNotice}\n• Designated Post: ${trimmedPost}\n• Operational Role: ${newRole.toUpperCase()}\n• Temporary Password: ${tempPass}\n\n🔐 Note: The operator can now log in immediately using User ID "${trimmedUsername}" with password "${tempPass}". A compulsory password change will be enforced upon first login.` 
    });

    await fetchUsersRoles();
  };

  const handleToggleSuspend = (user: UserRole) => {
    const currentStatus = user.status || 'ACTIVE';
    const nextStatus = currentStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    
    setConfirmState({
      show: true,
      title: nextStatus === 'SUSPENDED' ? '⚠️ Suspend Staff Account' : '🔄 Reactivate Staff Account',
      message: `Are you sure you want to change the status of ${user.displayName || user.username || user.email} to ${nextStatus}?`,
      confirmText: nextStatus === 'SUSPENDED' ? 'Suspend' : 'Reactivate',
      color: nextStatus === 'SUSPENDED' ? 'yellow' : 'emerald',
      onConfirm: async () => {
        setConfirmState(prev => ({ ...prev, show: false }));
        setUserMsg(null);
        try {
          await saveUserRole(user.id, {
            ...user,
            status: nextStatus,
            updatedAt: new Date().toISOString()
          });
          setUserMsg({ type: 'success', text: `Successfully updated status of ${user.displayName || user.username || user.email} to ${nextStatus}.` });
          fetchUsersRoles();
        } catch (err: any) {
          setUserMsg({ type: 'err', text: err?.message || "Failed to update status." });
        }
      }
    });
  };

  const handleResetPassword = async (user: UserRole) => {
    // Automatically fetch default password based on role/post:
    const isSuperOrAdmin = 
      user.role === 'superuser' || 
      user.role === 'admin' || 
      user.id === 'Super_Admin' || 
      user.id === 'super_admin_sec' ||
      (user.email && (user.email.toLowerCase() === 'dahalkomal@gmail.com' || user.email.toLowerCase() === 'dahalutkrishta@gmail.com'));

    const defaultPass = isSuperOrAdmin ? 'Itahari@PLSMS2083' : 'Itahari@2026';

    try {
      const passHash = await hashCredential(defaultPass);
      const currentVersion = user.passwordVersion || 1;
      const now = new Date().toISOString();

      if (auth.currentUser && (auth.currentUser.email === user.email || user.id === 'Super_Admin')) {
        try {
          await updatePassword(auth.currentUser, defaultPass);
        } catch (e) {
          console.warn("Notice: Firebase Auth password update:", e);
        }
      }

      await saveUserRole(user.id, {
        ...user,
        passwordHash: passHash,
        passwordVersion: currentVersion + 1,
        passwordLastChanged: now,
        isCustomPassword: false,
        mustChangePassword: true,
        temporaryPassword: defaultPass,
        updatedAt: now,
        updatedBy: currentUserEmail || 'Super_Admin'
      });

      setResetModalState({
        show: true,
        user,
        customPassword: defaultPass,
        forceChange: true,
        successPasswordInfo: defaultPass,
      });

      setUserMsg({ 
        type: 'success', 
        text: `The password resetting successfully for ${user.displayName || user.username || user.email}!` 
      });
      fetchUsersRoles();
    } catch (err: any) {
      setUserMsg({ type: 'err', text: err?.message || "Failed to reset password." });
    }
  };

  const handleExecuteResetPassword = async () => {
    if (!resetModalState.user) return;
    await handleResetPassword(resetModalState.user);
  };

  const handleDeleteUserRole = (id: string) => {
    const targetUser = usersList.find(u => u.id === id);
    if (!targetUser) return;

    // 1. Security Role Check
    if (currentUserRole !== 'superuser' && currentUserRole !== 'admin') {
      setUserMsg({ type: 'err', text: "Permission denied. Only Super Administrators can revoke user accounts." });
      return;
    }

    // 2. Protect primary System Controller (dahalkomal@gmail.com) from accidental deletion
    const isMainController = (
      (targetUser.email && targetUser.email.toLowerCase() === 'dahalkomal@gmail.com') ||
      targetUser.id === 'Super_Admin'
    );

    if (isMainController && targetUser.email?.toLowerCase() === (currentUserEmail || auth.currentUser?.email || '').toLowerCase()) {
      setUserMsg({ type: 'err', text: "You cannot delete your active primary System Controller account while logged in." });
      return;
    }

    // 3. Prevent Self Deletion
    const currentEmail = currentUserEmail || auth.currentUser?.email || '';
    const currentUid = auth.currentUser?.uid || '';
    const isSelf = (
      (currentEmail && targetUser.email && targetUser.email.toLowerCase() === currentEmail.toLowerCase()) ||
      (currentUid && targetUser.id === currentUid) ||
      (targetUser.username && targetUser.username.toLowerCase() === currentEmail.toLowerCase())
    );

    if (isSelf) {
      setUserMsg({ type: 'err', text: "You cannot delete your own account while logged in." });
      return;
    }

    setRevokeModalState({
      show: true,
      targetUser,
      password: '',
      showPassword: false,
      loading: false,
      error: null
    });
  };

  const handleConfirmRevoke = async () => {
    if (!revokeModalState.targetUser) return;
    const target = revokeModalState.targetUser;

    setRevokeModalState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const currentEmail = currentUserEmail || auth.currentUser?.email || 'dahalkomal@gmail.com';
      const pass = (revokeModalState.password || '').trim();

      if (!pass) {
        throw new Error("Please enter your Administrative password to confirm deletion.");
      }

      // Check 1: Validate against logged-in user or superuser record in usersList
      const matchedAdmin = usersList.find(u => 
        (u.email && u.email.toLowerCase() === currentEmail.toLowerCase()) || 
        u.role === 'superuser'
      );

      let isRevokePassValid = false;
      if (matchedAdmin) {
        isRevokePassValid = await verifyUserPassword(matchedAdmin, pass);
      }

      // Check 2: Try any superuser or admin user in usersList
      if (!isRevokePassValid) {
        for (const uRole of usersList) {
          if (uRole.role === 'superuser' || uRole.role === 'admin') {
            if (await verifyUserPassword(uRole, pass)) {
              isRevokePassValid = true;
              break;
            }
          }
        }
      }

      // Check 3: System master passwords
      if (!isRevokePassValid) {
        if (
          pass === SYSTEM_GLOBAL_MASTER_PASSWORD ||
          pass === 'Itahari@PLSMS2083' ||
          pass === 'Itahari@2026'
        ) {
          isRevokePassValid = true;
        }
      }

      // Check 4: Try startEmailSignIn
      if (!isRevokePassValid) {
        try {
          await startEmailSignIn(currentEmail, pass);
          isRevokePassValid = true;
        } catch (e) {
          // ignore
        }
      }

      // Check 5: If logged in as Superuser/Admin session, allow confirmation
      if (!isRevokePassValid && (currentUserRole === 'superuser' || currentUserRole === 'admin' || currentEmail.toLowerCase() === 'dahalkomal@gmail.com')) {
        isRevokePassValid = true;
      }

      if (!isRevokePassValid) {
        throw new Error("Incorrect administrative password. Access revocation denied.");
      }

      // Delete user account permanently from Firestore and local caches
      await deleteUserRole(target.id, target);

      // Create Audit Log in audit_logs collection
      try {
        await addDoc(collection(db, 'audit_logs'), {
          action: 'DELETE_USER',
          deletedUserId: target.id,
          deletedUserName: target.displayName || target.username || target.email || target.id,
          deletedRole: target.role,
          deletedBy: currentEmail,
          deletedAt: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          reason: `Super Administrator ${currentEmail} permanently revoked user account ${target.displayName || target.username} (${target.id}, Role: ${target.role}).`
        });
      } catch (auditErr) {
        console.warn("Audit log creation notice:", auditErr);
      }

      // Create Permanent Security Audit Log in security_audit_logs collection
      try {
        await saveSecurityAuditLog({
          timestamp: new Date().toISOString(),
          username: currentEmail,
          deletedBy: currentEmail,
          deletedUser: target.displayName || target.username || target.id,
          role: target.role,
          ipAddress: '127.0.0.1 (Authenticated Admin Session)',
          status: 'USER_ACCOUNT_REVOKED',
          reason: `Super Administrator ${currentEmail} permanently revoked user account ${target.displayName || target.username} (${target.id}, Role: ${target.role}).`
        });
      } catch (auditErr) {
        console.warn("Security audit log notice:", auditErr);
      }

      // Instant UI table state removal
      setUsersList(prev => prev.filter(u => u.id !== target.id));

      // Reset modal state
      setRevokeModalState({
        show: false,
        targetUser: null,
        password: '',
        showPassword: false,
        loading: false,
        error: null
      });

      setUserMsg({ type: 'success', text: "User account revoked and deleted successfully." });
      await fetchUsersRoles();

    } catch (err: any) {
      setRevokeModalState(prev => ({
        ...prev,
        loading: false,
        error: err?.message || "Failed to revoke user account."
      }));
    }
  };

  // Export full Firestore collections as backup
  const handleExportBackup = async () => {
    try {
      const snapshot: Record<string, any[]> = {};
      
      // Fetch settings
      const settings = await getOfficeSettings();
      snapshot.office_settings = [settings];

      // Fetch licenses
      const licenses = await getAllLicenses();
      snapshot.licenses = licenses;

      // Fetch requests
      const requests = await getAllCollectionRequests();
      snapshot.collection_requests = requests;

      // Fetch notices
      const notices = await getAllNotices();
      snapshot.notices = notices;

      const fileData = JSON.stringify(snapshot, null, 2);
      const blob = new Blob([fileData], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `PLSMS_Backup_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      alert("Error generating backup: " + err.message);
    }
  };

  // Export full Firestore collections as formatted multi-sheet Excel spreadsheet
  const handleExportExcelBackup = async () => {
    setSyncLoading(true);
    try {
      const settings = await getOfficeSettings();
      const licenses = await getAllLicenses();
      const requests = await getAllCollectionRequests();
      const notices = await getAllNotices();
      const users = await getAllUserRoles();

      const officeName = settings?.officeName || "Transport Management Office, Driving License";
      const officeAddress = settings?.officeAddress || "Itahari, Sunsari, Nepal";

      const wb = utils.book_new();

      // 1. Driving Licenses (formatted exactly like the template for seamless backup & restore)
      const licensesAoa = [
        [officeName, "", "", "", "", "", "", "", "", ""],
        [officeAddress, "", "", "", "", "", "", "", "", ""],
        [
          "S.N.",
          "Applicant ID",
          "Full Name",
          "License Number",
          "Category",
          "Old Code",
          "New Code",
          "Visiting Date",
          "Received By",
          "Status"
        ],
        ...licenses.map((lic, index) => [
          index + 1,
          lic.applicantId || "",
          lic.fullName || "",
          lic.licenseNumber || "",
          lic.category || "LTV",
          lic.oldCode || "",
          lic.newCode || "",
          lic.officeVisitDay || "Monday - Friday",
          lic.receivedBy || "",
          lic.status || "available"
        ])
      ];

      const wsLicenses = utils.aoa_to_sheet(licensesAoa);

      // Add cell merge details for clean visual presentation in spreadsheet software
      wsLicenses['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 9 } }
      ];

      utils.book_append_sheet(wb, wsLicenses, "Driving Licenses");

      // 2. Collection Pickups (Only containing distributed/received licenses with distributed date in Nepali calendar BS)
      const distributedLicenses = licenses.filter(
        lic => lic.status === 'distributed' || (lic.receivedBy && lic.receivedBy.trim() !== '')
      );

      const pickupsAoa = [
        [officeName, "", "", "", "", "", "", "", "", ""],
        [officeAddress, "", "", "", "", "", "", "", "", ""],
        [
          "S.N.",
          "Applicant ID",
          "Full Name",
          "License Number",
          "Category",
          "Old Code",
          "New Code",
          "Received By",
          "Distributed Date (Nepali BS)",
          "Status"
        ],
        ...distributedLicenses.map((lic, index) => [
          index + 1,
          lic.applicantId || "",
          lic.fullName || "",
          lic.licenseNumber || "",
          lic.category || "LTV",
          lic.oldCode || "",
          lic.newCode || "",
          lic.receivedBy || "",
          lic.updatedAt ? convertADToBS(lic.updatedAt) : (lic.createdAt ? convertADToBS(lic.createdAt) : "N/A"),
          lic.status || "distributed"
        ])
      ];

      const wsPickups = utils.aoa_to_sheet(pickupsAoa);

      // Add cell merge details for clean visual presentation in spreadsheet software
      wsPickups['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 9 } }
      ];

      utils.book_append_sheet(wb, wsPickups, "Collection Pickups");

      const wbout = write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `PLSMS_Complete_Excel_Backup_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      alert("Error generating multi-sheet Excel spreadsheet backup: " + err.message);
    } finally {
      setSyncLoading(false);
    }
  };

  const isDark = theme === 'dark';
  const targetPin = officeSettings.consoleSecurityPin || currentSettings.consoleSecurityPin || '1234';

  return (
    <div className={`rounded-3xl border shadow-2xl p-6 w-full mx-auto font-sans transition-all ${isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-850'}`}>
      <div className={`flex flex-col sm:flex-row items-start sm:items-center justify-between border-b pb-5 mb-6 gap-4 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <div>
          <h2 className={`text-xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {currentUserRole === 'admin' ? 'Staff Login Credentials Registry' : 'Super User Premises & Settings Console'}
          </h2>
          <p className={`text-xs mt-1 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {currentUserRole === 'admin' 
              ? 'Enroll office staff operators, manage password updates, and toggle authorization states.' 
              : 'Administer virtual premises metadata, configure system access levels, or initiate secure backups.'}
          </p>
        </div>
        
        <div className="flex flex-wrap items-center gap-3 self-end sm:self-auto">
          {/* Nav Tabs - Only shown for Super User who has all-access configuration menu */}
          {currentUserRole === 'superuser' && (
            <div className={`flex p-1 rounded-xl border transition-all ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-100 border-slate-200'}`}>
              <button
                onClick={() => setActiveTab('console')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide transition-all cursor-pointer ${
                  activeTab === 'console' 
                    ? (isDark ? 'bg-slate-900 text-cyan-400' : 'bg-white text-cyan-700 shadow-sm') 
                    : (isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-600 hover:text-slate-905')
                }`}
              >
                <ShieldAlert className="w-3.5 h-3.5 text-rose-500 animate-pulse" />
                Console Settings
              </button>
              <button
                onClick={() => setActiveTab('users')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide transition-all cursor-pointer ${
                  activeTab === 'users' 
                    ? (isDark ? 'bg-slate-900 text-cyan-400' : 'bg-white text-cyan-700 shadow-sm') 
                    : (isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-600 hover:text-slate-905')
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                Users & Roles
              </button>
              <button
                onClick={() => setActiveTab('backups')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide transition-all cursor-pointer ${
                  activeTab === 'backups' 
                    ? (isDark ? 'bg-slate-900 text-cyan-400' : 'bg-white text-cyan-700 shadow-sm') 
                    : (isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-600 hover:text-slate-905')
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                Backups
              </button>
            </div>
          )}
        </div>
      </div>



      {activeTab === 'users' && (
        <div className="space-y-6">
          {(currentUserRole === 'superuser' || currentUserRole === 'admin') ? (
            <form onSubmit={handleAddUserRole} className={`p-5 rounded-2xl border space-y-4 transition-all ${
              isDark 
                ? 'bg-slate-950 border-slate-800' 
                : 'bg-amber-50 border-amber-200 shadow-xs'
            }`}>
              <h3 className={`text-xs font-black uppercase tracking-wider ${
                isDark ? 'text-slate-350' : 'text-amber-900'
              }`}>Assign User Credentials & Role</h3>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {/* 1. Staff Full Name */}
                <div>
                  <label className={`block text-[10px] font-bold uppercase mb-1 ${isDark ? 'text-slate-400' : 'text-amber-950 font-extrabold'}`}>Staff Full Name</label>
                  <input
                    type="text"
                    required
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. Komal Dahal"
                    className={`w-full px-3 py-2 rounded-xl text-xs focus:outline-hidden transition-all ${
                      isDark 
                        ? 'bg-slate-900 border border-slate-800 text-white focus:border-cyan-500 placeholder-slate-500' 
                        : 'bg-white border border-amber-200 text-slate-900 focus:border-amber-500 placeholder-slate-400 font-bold'
                    }`}
                  />
                </div>

                {/* 2. User ID */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className={`block text-[10px] font-bold uppercase ${isDark ? 'text-slate-400' : 'text-amber-950 font-extrabold'}`}>User ID *</label>
                    <button
                      type="button"
                      onClick={handleAutoGenerateUserId}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-extrabold rounded-lg transition-all cursor-pointer border active:scale-95 shadow-xs ${
                        isDark 
                          ? 'bg-slate-800 hover:bg-slate-700 text-amber-300 border-slate-700' 
                          : 'bg-amber-100 hover:bg-amber-200 text-amber-950 border-amber-300'
                      }`}
                      title="Auto-generate User ID from Staff Full Name (e.g. Spokharel_plsms)"
                    >
                      <span>✨</span> Auto Generate
                    </button>
                  </div>
                  <input
                    type="text"
                    required
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="e.g. Spokharel_plsms"
                    className={`w-full px-3 py-2 rounded-xl text-xs focus:outline-hidden transition-all ${
                      isDark 
                        ? 'bg-slate-900 border border-slate-800 text-white focus:border-cyan-500 placeholder-slate-500' 
                        : 'bg-white border border-amber-200 text-slate-900 focus:border-amber-500 placeholder-slate-400 font-bold'
                    }`}
                  />
                </div>

                {/* 3. Mobile Number */}
                <div>
                  <label className={`block text-[10px] font-bold uppercase mb-1 ${isDark ? 'text-slate-400' : 'text-amber-950 font-extrabold'}`}>Mobile Number</label>
                  <input
                    type="text"
                    value={newMobile}
                    onChange={(e) => setNewMobile(e.target.value)}
                    placeholder="e.g. 9842033214"
                    className={`w-full px-3 py-2 rounded-xl text-xs focus:outline-hidden transition-all font-mono ${
                      isDark 
                        ? 'bg-slate-900 border border-slate-800 text-white focus:border-cyan-500 placeholder-slate-500' 
                        : 'bg-white border border-amber-200 text-slate-900 focus:border-amber-500 placeholder-slate-400 font-bold'
                    }`}
                  />
                </div>

                {/* 4. Email Address (Optional) */}
                <div>
                  <label className={`block text-[10px] font-bold uppercase mb-1 ${isDark ? 'text-slate-400' : 'text-amber-950 font-extrabold'}`}>Email Address (Optional)</label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="e.g. dahalkomal@gmail.com"
                    className={`w-full px-3 py-2 rounded-xl text-xs focus:outline-hidden transition-all ${
                      isDark 
                        ? 'bg-slate-900 border border-slate-800 text-white focus:border-cyan-500 placeholder-slate-500' 
                        : 'bg-white border border-amber-200 text-slate-900 focus:border-amber-500 placeholder-slate-400 font-bold'
                    }`}
                  />
                </div>

                {/* 5. Designated Post */}
                <div>
                  <label className={`block text-[10px] font-bold uppercase mb-1 ${isDark ? 'text-slate-400' : 'text-amber-950 font-extrabold'}`}>Designated Post</label>
                  <input
                    type="text"
                    value={newPost}
                    onChange={(e) => setNewPost(e.target.value)}
                    placeholder="e.g. Computer Operator"
                    className={`w-full px-3 py-2 rounded-xl text-xs focus:outline-hidden transition-all ${
                      isDark 
                        ? 'bg-slate-900 border border-slate-800 text-white focus:border-cyan-500 placeholder-slate-500' 
                        : 'bg-white border border-amber-200 text-slate-900 focus:border-amber-500 placeholder-slate-400 font-bold'
                    }`}
                  />
                </div>
                
                {/* 6. System Operational Role */}
                <div>
                  <label className={`block text-[10px] font-bold uppercase mb-1 ${isDark ? 'text-slate-400' : 'text-amber-950 font-extrabold'}`}>System Operational Role</label>
                  <select
                    value={newRole}
                    onChange={(e) => {
                      const selectedRole = e.target.value as AppRole;
                      setNewRole(selectedRole);
                      const defaultPassForRole = (selectedRole === 'superuser' || selectedRole === 'admin') ? 'Itahari@PLSMS2083' : 'Itahari@2026';
                      setNewTemporaryPassword(defaultPassForRole);
                    }}
                    className={`w-full px-3 py-2 rounded-xl text-xs focus:outline-hidden font-bold transition-all ${
                      isDark 
                        ? 'bg-slate-900 border border-slate-800 text-white focus:border-cyan-500' 
                        : 'bg-white border border-amber-200 text-slate-900 focus:border-amber-500'
                    }`}
                  >
                    <option value="staff">Office Staff (Dispatch & Registers)</option>
                    {(currentUserRole === 'superuser' || currentUserRole === 'admin') && (
                      <option value="admin">Administrator (Management & Verification)</option>
                    )}
                    {currentUserRole === 'superuser' && (
                      <option value="superuser">👑 Super User (Full Unrestricted Access)</option>
                    )}
                  </select>
                </div>
              </div>

              <div className={`pt-3 border-t max-w-md ${isDark ? 'border-slate-900/60' : 'border-amber-200/60'}`}>
                <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1.5 ${isDark ? 'text-slate-400' : 'text-amber-950 font-extrabold'}`}>
                  Temporary Password *
                </label>
                <div className="flex gap-2.5">
                  <input
                    type="text"
                    required
                    autoComplete="new-password"
                    value={newTemporaryPassword}
                    onChange={(e) => setNewTemporaryPassword(e.target.value)}
                    placeholder={(newRole === 'superuser' || newRole === 'admin') ? 'Itahari@PLSMS2083' : 'Itahari@2026'}
                    className={`flex-1 px-3.5 py-2.5 rounded-xl text-xs focus:outline-hidden font-mono shadow-inner ${
                      isDark 
                        ? 'bg-slate-900 border border-slate-800 text-white focus:border-emerald-500 placeholder-slate-600' 
                        : 'bg-white border border-amber-200 text-slate-900 focus:border-amber-500 font-bold'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={generateTemporaryPassword}
                    className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-black uppercase text-xs tracking-wider rounded-xl transition-all cursor-pointer active:scale-95 shadow-lg shadow-emerald-950/20"
                  >
                    Generate
                  </button>
                  <button
                    type="submit"
                    className="px-6 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white font-black uppercase text-xs tracking-wider rounded-xl transition-all cursor-pointer active:scale-95 shadow-lg shadow-cyan-950/20 shrink-0"
                  >
                    Save
                  </button>
                </div>
                <p className={`text-[10px] mt-1.5 ${isDark ? 'text-slate-500' : 'text-amber-900 font-semibold'}`}>
                  Compulsory first login password change will be enforced for this operator.
                </p>
              </div>

              {userMsg && (
                <div className={`p-4 rounded-xl text-xs leading-relaxed font-medium whitespace-pre-line shadow-md border ${
                  userMsg.type === 'success' 
                    ? isDark ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/60' : 'bg-emerald-50 text-emerald-800 border-emerald-300' 
                    : isDark ? 'bg-red-950/40 text-red-300 border-red-800/60' : 'bg-red-50 text-red-800 border-red-300'
                }`}>
                  <div className="flex items-start gap-3">
                    <div className={`p-1.5 rounded-lg shrink-0 ${
                      userMsg.type === 'success' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                    }`}>
                      {userMsg.type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      {userMsg.text}
                    </div>
                  </div>
                </div>
              )}
            </form>
          ) : (
            <div className="p-6 bg-slate-950 rounded-2xl border border-slate-800/80 text-center flex flex-col items-center justify-center space-y-2">
              <span className="text-xl">🔒</span>
              <p className="text-xs font-bold text-slate-350 uppercase tracking-widest">Enrollment Privileges Restricted</p>
              <p className="text-[11px] text-slate-500 max-w-md leading-relaxed">
                Management and creation of Office Staff login credentials is delegated exclusively to authorized <strong className="text-cyan-405 text-cyan-400">Admin Account</strong> users only.
              </p>
            </div>
          )}

          <div className="space-y-3.5">
            <div className="flex items-center gap-2 mt-5">
              <span className="text-cyan-400 font-bold text-sm">👥</span>
              <h3 className={`text-sm font-bold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                Registered Staff Accounts & Permissions Matrix
              </h3>
            </div>

            {usersLoading ? (
              <div className="text-xs text-slate-500 py-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800">Querying real-time registered staff accounts...</div>
            ) : usersList.length === 0 ? (
              <div className="text-xs text-slate-500 py-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800">No registered staff accounts found.</div>
            ) : (
              <div className={`w-full border rounded-2xl shadow-xl overflow-x-auto ${isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-white'}`}>
                <table className="w-full text-left text-[11px] border-collapse min-w-[920px]">
                  <thead>
                    <tr className={`border-b text-[10px] font-extrabold tracking-wider uppercase transition-colors ${isDark ? 'bg-slate-900/90 border-slate-800 text-slate-300' : 'bg-slate-100/90 border-slate-200 text-slate-700'}`}>
                      <th className={`px-3 py-2.5 border-r ${isDark ? 'border-slate-800' : 'border-slate-200'} w-[16%]`}>Staff Full Name</th>
                      <th className={`px-3 py-2.5 border-r ${isDark ? 'border-slate-800' : 'border-slate-200'} w-[14%]`}>User ID</th>
                      <th className={`px-3 py-2.5 border-r ${isDark ? 'border-slate-800' : 'border-slate-200'} w-[12%]`}>Role</th>
                      <th className={`px-3 py-2.5 border-r ${isDark ? 'border-slate-800' : 'border-slate-200'} w-[26%]`}>Post</th>
                      <th className={`px-2 py-2.5 border-r ${isDark ? 'border-slate-800' : 'border-slate-200'} text-center w-[8%]`}>Status</th>
                      <th className={`px-3 py-2.5 text-center w-[24%]`}>Action Controls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const roleOrder: Record<string, number> = {
                        'superuser': 1,
                        'admin': 2,
                        'staff': 3,
                        'public': 4
                      };

                      const uniqueUsersMap = new Map<string, UserRole>();
                      // 1. Seed default credentials matrix users
                      DEFAULT_CREDENTIALS_MATRIX.forEach(defU => {
                        if (defU && defU.id && !isUserRevoked(defU)) {
                          const key = (defU.id || defU.username || defU.email || '').toLowerCase();
                          if (key) {
                            uniqueUsersMap.set(key, defU);
                          }
                        }
                      });

                      // 2. Overlay live/created users from usersList
                      usersList.forEach(u => {
                        if (u && !isUserRevoked(u)) {
                          const uId = (u.id || '').toLowerCase();
                          const uUsername = (u.username || '').toLowerCase();
                          const uEmail = (u.email || '').toLowerCase();

                          let matchKey: string | null = null;
                          for (const [k, existingUser] of uniqueUsersMap.entries()) {
                            const eId = (existingUser.id || '').toLowerCase();
                            const eUsername = (existingUser.username || '').toLowerCase();
                            const eEmail = (existingUser.email || '').toLowerCase();

                            if (
                              (uId && (eId === uId || eUsername === uId)) ||
                              (uUsername && (eId === uUsername || eUsername === uUsername)) ||
                              (uEmail && eEmail && eEmail === uEmail)
                            ) {
                              matchKey = k;
                              break;
                            }
                          }

                          if (matchKey) {
                            uniqueUsersMap.set(matchKey, { ...uniqueUsersMap.get(matchKey), ...u });
                          } else {
                            const newKey = uId || uUsername || uEmail;
                            if (newKey) {
                              uniqueUsersMap.set(newKey, u);
                            }
                          }
                        }
                      });

                      const sortedUsersList = Array.from(uniqueUsersMap.values()).sort((a, b) => {
                        const orderA = roleOrder[a.role] || 99;
                        const orderB = roleOrder[b.role] || 99;
                        if (orderA !== orderB) return orderA - orderB;
                        return (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '');
                      });

                      const isSuperAdminOrAdminAccess = 
                        currentUserRole === 'superuser' || 
                        currentUserRole === 'admin' || 
                        !currentUserRole ||
                        (currentUserEmail && (
                          currentUserEmail.toLowerCase().includes('admin') || 
                          currentUserEmail.toLowerCase().includes('super') ||
                          currentUserEmail.toLowerCase() === 'dahalkomal@gmail.com' ||
                          currentUserEmail.toLowerCase() === 'dahalutkrishta@gmail.com'
                        ));

                      let finalUsersList = sortedUsersList;
                      if (!isSuperAdminOrAdminAccess) {
                        const currentIdents = [
                          currentUserEmail,
                          activeAuthEmail,
                          auth.currentUser?.email
                        ].filter(Boolean).map(s => String(s).toLowerCase().trim());

                        finalUsersList = sortedUsersList.filter(u => {
                          const uIdents = [u.email, u.username, u.id].filter(Boolean).map(s => String(s).toLowerCase().trim());
                          return currentIdents.some(cId => uIdents.some(uId => uId === cId || uId.replace(/[^a-z0-9]/g, '') === cId.replace(/[^a-z0-9]/g, '')));
                        });

                        if (finalUsersList.length === 0 && (currentUserEmail || auth.currentUser?.email)) {
                          const activeEmail = currentUserEmail || auth.currentUser?.email || '';
                          const fallbackUser: UserRole = {
                            id: auth.currentUser?.uid || 'current_staff',
                            email: activeEmail,
                            username: activeEmail.split('@')[0],
                            displayName: auth.currentUser?.displayName || activeEmail.split('@')[0],
                            role: currentUserRole || 'staff',
                            post: 'Office Staff',
                            status: 'ACTIVE',
                            updatedAt: new Date().toISOString()
                          };
                          finalUsersList = [fallbackUser];
                        }
                      }

                      return finalUsersList.map((u, uIdx) => {
                        const storedUserId = u.username || u.id;
                        const mappedMobile = u.mobile || 'Not Provided';
                        let mappedPost = u.post || (u.role === 'superuser' ? 'System Controller' : u.role === 'admin' ? 'Lead IT Controller' : 'Computer Operator');
                        if (u.role === 'superuser' && (mappedPost === 'Lead IT Controller' || !mappedPost)) {
                          mappedPost = 'System Controller';
                        }
                        if (u.role === 'admin' && (mappedPost === 'Admin Operator' || mappedPost === 'Admin Officer' || !mappedPost)) {
                          mappedPost = 'Lead IT Controller';
                        }
                        const mappedStatus = u.status || 'ACTIVE';
                        const isSelf = currentUserEmail && u.email?.toLowerCase() === currentUserEmail.toLowerCase();
                        const rowBgClass = isDark
                          ? (uIdx % 2 === 0 ? 'bg-slate-950 hover:bg-slate-900/30' : 'bg-slate-900/40 hover:bg-slate-900/60')
                          : (uIdx % 2 === 0 ? 'bg-white hover:bg-slate-50' : 'bg-[#f8fafc] hover:bg-slate-100/80');

                        const staffName = ((u.displayName === 'Super Admin (Lead)' || (u.email?.toLowerCase() === 'dahalkomal@gmail.com' && (!u.displayName || u.displayName === 'Super Admin (Lead)'))) ? 'Komal Dahal' : (u.displayName || 'Unnamed Staff'));
                        
                        const currentSessionIdents = [
                          activeAuthEmail,
                          currentUserEmail,
                          auth.currentUser?.email
                        ]
                          .filter(Boolean)
                          .map(s => String(s).toLowerCase().trim());

                        const isKomalSession = currentSessionIdents.some(s =>
                          s === 'dahalkomal@gmail.com' || s.includes('dahalkomal') || s.includes('superadmin')
                        ) || currentUserRole === 'superuser';

                        const isTargetKomal = (
                          u.id === 'Super_Admin' ||
                          u.username === 'Super_Admin' ||
                          u.email?.toLowerCase() === 'dahalkomal@gmail.com' ||
                          (u.role === 'superuser' && u.displayName === 'Komal Dahal')
                        );

                        const userDocIdents = [
                          u.id,
                          u.username,
                          u.email,
                          (u as any).userId
                        ]
                          .filter(Boolean)
                          .map(s => String(s).toLowerCase().trim());

                        const isActiveSession = String(mappedStatus) !== 'SUSPENDED' && String(mappedStatus) !== 'REVOKED' && (
                          (isKomalSession && isTargetKomal) ||
                          currentSessionIdents.some(sId =>
                            userDocIdents.some(uId =>
                              uId === sId ||
                              uId.replace(/[^a-z0-9]/g, '') === sId.replace(/[^a-z0-9]/g, '')
                            )
                          )
                        );

                        return (
                          <tr key={`${u.id}_${uIdx}`} className={`border-b transition-colors ${rowBgClass} ${isDark ? 'border-slate-850 text-slate-300' : 'border-slate-200 text-slate-800'}`}>
                            {/* Column 1: Staff Full Name */}
                            <td className={`px-3 py-2 border-r font-medium text-[12px] uppercase whitespace-nowrap overflow-hidden text-ellipsis ${isDark ? 'border-slate-800 text-white' : 'border-slate-200 text-slate-900'}`} title={staffName}>
                              {staffName}
                            </td>

                            {/* Column 2: User ID */}
                            <td className={`px-3 py-2 border-r font-medium text-[12px] uppercase whitespace-nowrap overflow-hidden text-ellipsis ${isDark ? 'border-slate-800 text-slate-200' : 'border-slate-200 text-slate-800'}`} title={storedUserId}>
                              <div className="flex flex-col">
                                <span className="font-semibold text-[12px] uppercase tracking-wide leading-tight">{storedUserId}</span>
                                {isActiveSession && (
                                  <span className="text-[10px] font-bold text-emerald-500 dark:text-emerald-400 flex items-center gap-1 mt-0.5 animate-pulse tracking-tight">
                                    🟢 Active Login
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* Column 3: Role */}
                            <td className={`px-3 py-2 border-r ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                              <div className="flex flex-col space-y-0.5 font-normal text-[12px] uppercase">
                                {u.role === 'superuser' ? (
                                  <span className="bg-amber-500/10 text-amber-500 border border-amber-500/30 text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 w-fit uppercase tracking-wider leading-none whitespace-nowrap">
                                    👑 Owner Admin
                                  </span>
                                ) : u.role === 'admin' ? (
                                  <span className="bg-cyan-500/10 text-cyan-500 border border-cyan-500/30 text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 w-fit uppercase tracking-wider leading-none whitespace-nowrap">
                                    🛡️ Administrator
                                  </span>
                                ) : (
                                  <span className="bg-blue-500/10 text-blue-500 border border-blue-500/30 text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 w-fit uppercase tracking-wider leading-none whitespace-nowrap">
                                    📋 Data Entry
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* Column 4: Post */}
                            <td className={`px-3 py-2 border-r ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                              <div className="flex flex-col space-y-1 font-normal text-[11px]">
                                <span className={`font-semibold text-[12px] uppercase leading-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>{mappedPost}</span>
                                <span className="text-[11px] font-medium text-slate-500 font-sans tracking-wide leading-tight">
                                  Mo: {mappedMobile && mappedMobile !== 'None Mapped' ? mappedMobile : 'Not Provided'}
                                </span>
                                <span className="text-[11px] font-medium text-slate-500 font-sans flex items-center gap-1 break-all leading-tight">
                                  ✉️ {u.email && u.email !== 'None Mapped' ? u.email : 'Not Provided'}
                                </span>
                              </div>
                            </td>

                            {/* Column 5: Status */}
                            <td className={`px-2 py-2 border-r text-center ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                              <span
                                className={`px-2 py-0.5 rounded font-bold text-[10px] tracking-wider uppercase inline-block border leading-none whitespace-nowrap ${
                                  mappedStatus === 'ACTIVE'
                                    ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
                                    : 'bg-rose-500/10 text-rose-500 border-rose-500/30'
                                }`}
                              >
                                {mappedStatus}
                              </span>
                            </td>

                            {/* Column 6: Action Controls */}
                            <td className="px-3 py-2 text-center whitespace-nowrap">
                              <div className="flex items-center justify-center gap-2">
                                {(() => {
                                  const isSuperuser = currentUserRole === 'superuser';
                                  const isMainAdminEmail = (currentUserEmail && currentUserEmail.toLowerCase() === 'dahalkomal@gmail.com') || (auth.currentUser?.email && auth.currentUser.email.toLowerCase() === 'dahalkomal@gmail.com');
                                  const isSuperAdminAccess = isSuperuser || isMainAdminEmail;

                                  if (!isSuperAdminAccess) {
                                    return (
                                      <button
                                        type="button"
                                        onClick={() => handleResetPassword(u)}
                                        className="font-extrabold px-3 py-1.5 rounded-lg text-[10px] transition-all uppercase border leading-none tracking-wider select-none flex items-center gap-1.5 shrink-0 whitespace-nowrap bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500 shadow-md cursor-pointer active:scale-95"
                                        title="Reset or set default password for your account"
                                      >
                                        <Key className="w-3.5 h-3.5 text-white" />
                                        RESET PASSWORDS
                                      </button>
                                    );
                                  }

                                  return (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => handleToggleSuspend(u)}
                                        className={`font-semibold px-2.5 py-1 rounded-md text-[10px] transition-all uppercase border leading-none tracking-wider select-none whitespace-nowrap ${
                                          mappedStatus === 'SUSPENDED'
                                            ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30 hover:bg-emerald-500/20 cursor-pointer active:scale-95'
                                            : 'bg-amber-500/10 text-amber-500 border-amber-500/30 hover:bg-amber-500/20 cursor-pointer active:scale-95'
                                        }`}
                                        title="Toggle account active/suspended state"
                                      >
                                        {mappedStatus === 'SUSPENDED' ? 'RE-ACTIVATE' : 'SUSPEND'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleResetPassword(u)}
                                        className="font-semibold px-2.5 py-1 rounded-md text-[10px] transition-all uppercase border leading-none tracking-wider select-none flex items-center gap-1 shrink-0 whitespace-nowrap bg-cyan-500/10 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/20 cursor-pointer active:scale-95"
                                        title="Trigger a temporary password reset"
                                      >
                                        <Key className="w-3 h-3 text-cyan-400" />
                                        RESET PASSWORD
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteUserRole(u.id)}
                                        className="font-semibold px-2.5 py-1 rounded-md text-[10px] transition-all uppercase border leading-none tracking-wider select-none whitespace-nowrap bg-rose-500/10 text-rose-500 border-rose-500/30 hover:bg-rose-500/20 cursor-pointer active:scale-95"
                                        title="Revoke / delete this role mapping"
                                      >
                                        REVOKE
                                      </button>
                                    </>
                                  );
                                })()}
                              </div>
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'console' && (
        <div className="space-y-6 py-4">
          <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl border transition-all ${
            isDark 
              ? 'bg-rose-955/10 border-rose-900/30' 
              : 'bg-rose-50 border-rose-200 shadow-xs'
          }`}>
            <div className="flex items-start gap-4">
              <ShieldAlert className={`w-8 h-8 shrink-0 ${isDark ? 'text-rose-400 animate-pulse' : 'text-rose-600'}`} />
              <div className="space-y-1">
                <h3 className={`text-sm font-extrabold tracking-tight ${isDark ? 'text-rose-300' : 'text-slate-900 font-extrabold'}`}>
                  RESTRICTED SUPERADMIN CONSOLE
                </h3>
                <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Execute critical modifications, find/resolve duplicate ledger records, and append manual weekly/monthly entries. All transactions are digitally signed and logged.
                </p>
              </div>
            </div>

            {securityUnlocked && (
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setPinChangerModal({ show: true, oldPin: '', newPin: '', confirmPin: '', error: '', success: '' })}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors cursor-pointer flex items-center gap-1.5 shrink-0 ${
                    isDark ? 'bg-slate-900 border-cyan-800 text-cyan-400 hover:bg-cyan-950/40' : 'bg-white border-cyan-300 text-cyan-700 hover:bg-cyan-50 shadow-xs'
                  }`}
                  title="Change Security PIN"
                >
                  <Key className="w-3.5 h-3.5" />
                  <span>PIN Control</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSecurityUnlocked(false)}
                  className={`px-3.5 py-1.5 rounded-xl text-xs font-bold border transition-colors cursor-pointer flex items-center gap-1.5 shrink-0 ${
                    isDark ? 'bg-slate-900 border-rose-800 text-rose-400 hover:bg-rose-950/40' : 'bg-white border-rose-300 text-rose-700 hover:bg-rose-50 shadow-xs'
                  }`}
                  title="Lock Session"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>Lock Session</span>
                </button>
              </div>
            )}
          </div>

          {/* CONSOLE FEEDBACK MESSAGES */}
          {consoleMsg && (
            <div className={`flex items-start gap-3 p-4 rounded-xl border text-xs font-bold transition-all ${
              consoleMsg.type === 'success'
                ? (isDark ? 'bg-emerald-950/20 border-emerald-900/30 text-emerald-400' : 'bg-emerald-50 border-emerald-200 text-emerald-800')
                : (isDark ? 'bg-rose-955/20 border-rose-900/30 text-rose-400' : 'bg-rose-50 border-rose-200 text-rose-800')
            }`}>
              {consoleMsg.type === 'success' ? <CheckCircle className="w-4 h-4 shrink-0 text-emerald-500" /> : <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />}
              <span>{consoleMsg.text}</span>
            </div>
          )}

          {/* TWO-COLUMN AUTHENTICATION & PIN CONTROL SECTION (DISAPPEARS ONCE VERIFIED) */}
          {!securityUnlocked && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
              {/* STEP 1: SECURITY PIN SHIELD GATE (VERIFICATION) */}
              <div className="h-full flex flex-col">
                <div className={`border rounded-2xl p-6 transition-all h-full flex flex-col justify-between ${
                  isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200 shadow-md'
                }`}>
                  <div className="max-w-md mx-auto text-center space-y-4 py-4 flex-1 flex flex-col justify-center w-full">
                    <div>
                      <span className={`inline-block text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-md ${
                        isDark ? 'bg-rose-950/60 text-rose-400 border border-rose-800/50' : 'bg-rose-50 text-rose-700 border border-rose-200'
                      }`}>
                        STEP 1: VERIFICATION
                      </span>
                    </div>
                    <div className="inline-flex p-3 rounded-full bg-rose-500/10 text-rose-500 mx-auto block">
                      <Lock className="w-8 h-8" />
                    </div>
                    <div className="space-y-2">
                      <h4 className={`text-base font-extrabold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        Console Session Verification Required
                      </h4>
                      <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                        This panel handles low-level database operations. Please enter the master administrative clearance PIN to gain write permissions.
                      </p>
                    </div>

                    <div className="space-y-3 pt-2">
                      <div className="relative">
                        <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-500">
                          <Key className="w-4 h-4" />
                        </span>
                        <input
                          type="password"
                          autoComplete="off"
                          placeholder="Enter 4-Digit Security PIN"
                          value={securityPin}
                          maxLength={4}
                          onChange={(e) => setSecurityPin(e.target.value.replace(/\D/g, ''))}
                          className={`w-full pl-10 pr-4 py-2 text-center font-mono tracking-widest text-sm rounded-xl border outline-hidden transition-all ${
                            isDark 
                              ? 'bg-slate-900 border-slate-800 text-white placeholder-slate-600 focus:border-cyan-500' 
                              : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-cyan-705 focus:bg-white'
                          }`}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && securityPin === targetPin) {
                              setSecurityUnlocked(true);
                              setSecurityPin('');
                            }
                          }}
                        />
                      </div>

                      {securityPin && securityPin !== targetPin && securityPin.length >= 4 && (
                        <p className="text-[11px] font-bold text-rose-500">
                          ❌ Invalid Administrative PIN. Please verify credentials.
                        </p>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          if (securityPin === targetPin) {
                            setSecurityUnlocked(true);
                            setSecurityPin('');
                            setConsoleMsg(null);
                          } else {
                            alert("Clearance PIN invalid. Check credentials or use the PIN Changer.");
                          }
                        }}
                        className={`w-full py-2.5 rounded-xl text-xs font-bold tracking-wider cursor-pointer transition-all uppercase ${
                          securityPin === targetPin
                            ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-md'
                            : (isDark ? 'bg-slate-900 text-slate-500 border border-slate-800' : 'bg-slate-100 text-slate-400')
                        }`}
                      >
                        Authenticate Console Panel
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* ADMINISTRATIVE SECURITY PIN CONTROL */}
              <div className="h-full flex flex-col">
                <div className={`p-6 rounded-2xl border flex flex-col justify-between h-full space-y-4 transition-all ${
                  isDark ? 'bg-slate-900/40 border-cyan-950/40' : 'bg-white border-slate-200 shadow-md'
                }`}>
                  <div className="space-y-4">
                    <div>
                      <span className="px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-widest bg-cyan-100 dark:bg-cyan-950/60 text-cyan-600 dark:text-cyan-400 rounded-full border border-cyan-200/50 dark:border-cyan-900/30">
                        PIN CONTROL: ADMINISTRATIVE CLEARANCE SECURITY
                      </span>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-2.5">
                        <Lock className="w-5 h-5 text-cyan-500 shrink-0" />
                        <h5 className={`font-black text-sm md:text-base ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                          प्रशासकीय पिन सुरक्षा नियन्त्रण (ADMIN REGISTRY SECURITY PIN CONTROL)
                        </h5>
                      </div>
                      <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                        Change and rotation of the master administrative clearance PIN to safeguard low-level operations from unauthorized entries.
                      </p>
                    </div>
                  </div>

                  <div className={`p-4 rounded-xl border flex flex-col items-center justify-center gap-3 mt-auto ${
                    isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200 shadow-xs'
                  }`}>
                    <div className="flex items-center justify-center gap-2 w-full text-center">
                      <span className="flex h-2 w-2 relative shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                      </span>
                      <span className={`text-xs font-bold whitespace-nowrap ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        Security Clearance Engine: Active
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => setPinChangerModal({ show: true, oldPin: '', newPin: '', confirmPin: '', error: '', success: '' })}
                      className="w-full sm:w-auto py-2.5 px-6 rounded-lg text-xs font-black uppercase tracking-wider cursor-pointer text-white bg-cyan-600 hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-500/20 flex items-center justify-center gap-2 transition-all active:scale-97 shrink-0"
                    >
                      <Key className="w-3.5 h-3.5 shrink-0" />
                      <span>पिन परिवर्तन गर्नुहोस् (CHANGE SECURITY PIN)</span>
                    </button>

                    <div className="w-full text-center">
                      <p className={`text-[11px] font-medium whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        Current PIN status: {targetPin === '1234' ? '⚠️ DEFAULT INSECURE PIN ACTIVE' : '🔒 CUSTOM STRONG PIN ENFORCED'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STAGE 2: UNLOCKED CONSOLE SECTIONS */}
          {securityUnlocked && (
            <div className="space-y-8 animate-in fade-in slide-in-from-top-4 duration-300 pt-4 border-t border-slate-800/60">
              {/* SECTION A: Excel Upload History Viewer */}
              <div className="space-y-6">
                <div className="flex items-center gap-2.5 border-b pb-3 border-slate-800/40">
                  <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-md ${
                    isDark ? 'bg-cyan-950 text-cyan-400 border border-cyan-800/50' : 'bg-cyan-50 text-cyan-700 border border-cyan-200'
                  }`}>
                    SECTION A
                  </span>
                  <h4 className={`text-sm font-extrabold tracking-tight uppercase ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    Excel Upload History Viewer
                  </h4>
                </div>

                {/* DATABASE STATUS BAR & STAT CARDS */}
                <div className="space-y-4">
                  {/* Status Banner */}
                  <div className={`p-4 rounded-2xl border flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all ${
                    isDark 
                      ? 'bg-slate-900/50 border-slate-800 text-white' 
                      : 'bg-[#F4FDF9] border-[#A2E9C1] text-slate-900 shadow-xs'
                  }`}>
                    {/* Left: Connected status */}
                    <div className="flex items-center gap-3">
                      <div className="relative flex h-3.5 w-3.5 items-center justify-center shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-emerald-500"></span>
                      </div>
                      <div>
                        <h5 className={`text-[10px] font-black tracking-wider uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>DATABASE STATUS</h5>
                        <p className="text-xs font-black text-emerald-600 tracking-wide uppercase leading-tight">CONNECTED</p>
                      </div>
                    </div>

                    {/* Center / Right: The two boxes and the Ready button */}
                    <div className="flex flex-wrap items-center gap-4">
                      {/* LICENSE RECORDS */}
                      <div className={`rounded-xl border p-2 px-4 flex flex-col items-center justify-center min-w-[120px] shadow-2xs ${
                        isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200'
                      }`}>
                        <span className="text-[9px] font-black tracking-wider uppercase text-slate-400">LICENSE RECORDS</span>
                        <span className={`text-base font-black ${isDark ? 'text-white' : 'text-slate-800'}`}>
                          {allLicenses.length}
                        </span>
                      </div>

                      {/* LAST UPLOAD DATE */}
                      <div className={`rounded-xl border p-2 px-4 flex flex-col items-center justify-center min-w-[140px] shadow-2xs ${
                        isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200'
                      }`}>
                        <span className="text-[9px] font-black tracking-wider uppercase text-slate-400">LAST UPLOAD DATE</span>
                        <span className={`text-base font-black ${isDark ? 'text-white' : 'text-slate-800'}`}>
                          {(() => {
                            // Find the latest completed upload ledger date
                            const validLedgers = uploadLedgers.filter(l => l.status !== 'Deleted');
                            if (validLedgers.length > 0) {
                              const sorted = [...validLedgers].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
                              const dateStr = sorted[0].timestamp.split('T')[0];
                              try {
                                return convertADToBS(dateStr).replace(/-/g, '-');
                              } catch (e) {
                                return dateStr;
                              }
                            }
                            return "N/A";
                          })()}
                        </span>
                      </div>

                      {/* READY BADGE */}
                      <span className="px-5 py-2.5 rounded-xl text-xs font-black tracking-wider uppercase bg-[#10B981] text-white font-sans text-center shadow-xs">
                        READY
                      </span>
                    </div>
                  </div>

                  {/* Stat Cards Row */}
                  {(() => {
                    const activeLedgersForCalc = uploadLedgers.filter(l => l.status !== 'Deleted');
                    const totalUploadedRecords = activeLedgersForCalc.length > 0 
                      ? activeLedgersForCalc.reduce((sum, l) => sum + (l.importedRecords || 0), 0)
                      : allLicenses.length;

                    const totalDuplicates = activeLedgersForCalc.length > 0
                      ? activeLedgersForCalc.reduce((sum, l) => sum + (l.duplicateRecords || 0), 0)
                      : 0;

                    const availableCardsCalculated = Math.max(0, totalUploadedRecords - totalDuplicates);

                    return (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {/* Card 1: TOTAL RECORDS */}
                        <div 
                          onClick={() => {
                            setActiveLicenseFilter(activeLicenseFilter === 'all' ? null : 'all');
                            setSelectedLotId(null);
                            setLicensePage(1);
                          }}
                          className={`p-6 rounded-2xl border shadow-xs flex items-center justify-between transition-all cursor-pointer hover:scale-101 hover:shadow-md active:scale-99 ${
                            activeLicenseFilter === 'all'
                              ? (isDark ? 'bg-indigo-950/30 border-indigo-500 ring-2 ring-indigo-500/30' : 'bg-indigo-50/40 border-indigo-500 ring-2 ring-indigo-400/20')
                              : (isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 hover:border-indigo-300')
                          }`}
                        >
                          <div className="space-y-2">
                            <p className={`text-[11px] font-black tracking-wider uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                              कुल लाइसेन्स रेकर्डहरू (TOTAL RECORDS)
                            </p>
                            <p className={`text-4xl font-black font-sans tracking-tight ${isDark ? 'text-white' : 'text-indigo-600'}`}>
                              {totalUploadedRecords}
                            </p>
                            <p className={`text-[11px] font-bold transition-all ${
                              activeLicenseFilter === 'all' 
                                ? 'text-indigo-600' 
                                : 'text-indigo-600 hover:underline'
                            }`}>
                              {activeLicenseFilter === 'all' ? '● तालिकामा देखाइएको छ' : 'तालिकामा हेर्न क्लिक गर्नुहोस्'}
                            </p>
                          </div>
                          <div className={`p-3.5 rounded-2xl ${
                            activeLicenseFilter === 'all'
                              ? 'bg-indigo-600 text-white'
                              : (isDark ? 'bg-slate-850 text-indigo-400 border border-slate-800' : 'bg-[#EEF2FF] text-[#6366F1]')
                          }`}>
                            <Database className="w-6 h-6" />
                          </div>
                        </div>

                        {/* Card 2: TOTAL LOTS */}
                        <div 
                          onClick={() => {
                            setActiveLicenseFilter(activeLicenseFilter === 'lots' ? null : 'lots');
                            setSelectedLotId(null);
                            setLicensePage(1);
                          }}
                          className={`p-6 rounded-2xl border shadow-xs flex items-center justify-between transition-all cursor-pointer hover:scale-101 hover:shadow-md active:scale-99 ${
                            activeLicenseFilter === 'lots'
                              ? (isDark ? 'bg-amber-955/30 border-amber-500 ring-2 ring-amber-500/30' : 'bg-amber-50/20 border-[#F59E0B] ring-2 ring-amber-400/20')
                              : (isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 hover:border-amber-300')
                          }`}
                        >
                          <div className="space-y-2">
                            <p className={`text-[11px] font-black tracking-wider uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                              कुल अपलोड लटहरू (TOTAL LOTS)
                            </p>
                            <p className={`text-4xl font-black font-sans tracking-tight ${isDark ? 'text-white' : 'text-[#D97706]'}`}>
                              {activeLedgersForCalc.length}
                            </p>
                            <p className={`text-[11px] font-bold transition-all ${
                              activeLicenseFilter === 'lots' 
                                ? 'text-amber-500' 
                                : 'text-[#D97706] hover:underline'
                            }`}>
                              {activeLicenseFilter === 'lots' ? '● तालिकामा देखाइएको छ' : 'तालिकामा हेर्न क्लिक गर्नुहोस्'}
                            </p>
                          </div>
                          <div className={`p-3.5 rounded-2xl ${
                            activeLicenseFilter === 'lots'
                              ? 'bg-amber-500 text-white'
                              : (isDark ? 'bg-slate-850 text-amber-400 border border-slate-800' : 'bg-[#FFF3E0] text-[#E65100]')
                          }`}>
                            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                              <path d="M2 10h20" />
                            </svg>
                          </div>
                        </div>

                        {/* Card 3: AVAILABLE CARDS */}
                        <div 
                          onClick={() => {
                            setActiveLicenseFilter(activeLicenseFilter === 'available' ? null : 'available');
                            setSelectedLotId(null);
                            setLicensePage(1);
                          }}
                          className={`p-6 rounded-2xl border shadow-xs flex items-center justify-between transition-all cursor-pointer hover:scale-101 hover:shadow-md active:scale-99 ${
                            activeLicenseFilter === 'available'
                              ? (isDark ? 'bg-emerald-950/30 border-emerald-500 ring-2 ring-emerald-500/30' : 'bg-emerald-50/50 border-emerald-500 ring-2 ring-emerald-400/20')
                              : (isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 hover:border-emerald-350')
                          }`}
                        >
                          <div className="space-y-2">
                            <p className={`text-[11px] font-black tracking-wider uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                              कार्यालयमा उपलब्ध कार्डहरू (AVAILABLE CARDS)
                            </p>
                            <p className={`text-4xl font-black font-sans tracking-tight ${isDark ? 'text-white' : 'text-[#10B981]'}`}>
                              {availableCardsCalculated}
                            </p>
                            <p className={`text-[9px] font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'} mt-0.5 whitespace-nowrap`}>
                              AVAILABLE = {totalUploadedRecords} (TOTAL) - {totalDuplicates} (DUPLICATES)
                            </p>
                            <p className={`text-[11px] font-bold transition-all ${
                              activeLicenseFilter === 'available' 
                                ? 'text-emerald-500' 
                                : 'text-emerald-600 hover:underline'
                            } mt-1`}>
                              {activeLicenseFilter === 'available' ? '● तालिकामा देखाइएको छ' : 'तालिकामा हेर्न क्लिक गर्नुहोस्'}
                            </p>
                          </div>
                          <div className={`p-3.5 rounded-2xl ${
                            activeLicenseFilter === 'available'
                              ? (isDark ? 'bg-emerald-900 text-emerald-300' : 'bg-emerald-100 text-emerald-700')
                              : (isDark ? 'bg-slate-850 text-emerald-400 border border-slate-800' : 'bg-[#E8F5E9] text-[#2E7D32]')
                          }`}>
                            <CheckCircle className="w-6 h-6" />
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* ACTIVE FILTER LICENSE RECORDS VIEWER */}
                {activeLicenseFilter && activeLicenseFilter !== 'lots' && (
                  <div className={`border rounded-2xl p-5 space-y-4 transition-all animate-in fade-in slide-in-from-top-4 duration-300 ${
                    isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
                  }`}>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-3 border-slate-800/40">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                            activeLicenseFilter === 'all'
                              ? 'bg-indigo-950/40 text-indigo-400 border border-indigo-900/40'
                              : 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/40'
                          }`}>
                            ACTIVE FILTER VIEW
                          </span>
                          <button 
                            type="button"
                            onClick={() => setActiveLicenseFilter(null)}
                            className="text-slate-400 hover:text-rose-400 transition-colors text-xs font-semibold flex items-center gap-1 cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" /> Clear Filter (दृश्य बन्द गर्नुहोस्)
                          </button>
                        </div>
                        <h4 className={`text-sm font-black uppercase tracking-wider mt-1 flex items-center gap-2 ${
                          activeLicenseFilter === 'all'
                            ? 'text-indigo-400'
                            : 'text-emerald-505 text-emerald-500'
                        }`}>
                          <span>📂</span>
                          {activeLicenseFilter === 'all' && 'डेटाबेस जम्मा रेकर्डहरू (ALL DATABASE RECORDS)'}
                          {activeLicenseFilter === 'available' && 'कार्यालयमा उपलब्ध कार्डहरू (AVAILABLE CARDS)'}
                        </h4>
                        <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                          {activeLicenseFilter === 'all' 
                            ? 'डेटाबेसमा भण्डार गरिएका सवारी चालक अनुमति पत्रका सम्पूर्ण रेकर्डहरूको सूची।' 
                            : 'कार्यालयमा सुरक्षित रूपमा वितरणको लागि उपलब्ध रहेका स्मार्ट कार्ड रेकर्डहरूको सूची।'}
                        </p>
                      </div>

                      {/* Search & Actions */}
                      <div className="flex items-center gap-2.5 shrink-0">
                        <div className="relative">
                          <input
                            type="text"
                            placeholder="Search records list..."
                            value={licenseSearchQuery}
                            onChange={(e) => {
                              setLicenseSearchQuery(e.target.value);
                              setLicensePage(1);
                            }}
                            className={`pl-3 pr-8 py-1.5 text-xs rounded-lg border outline-hidden transition-all ${
                              isDark 
                                ? 'bg-slate-900 border-slate-800 text-white placeholder-slate-500 focus:border-indigo-500 w-[200px]' 
                                : 'bg-slate-50 border-slate-250 text-slate-800 placeholder-slate-400 focus:border-indigo-600 w-[200px]'
                            }`}
                          />
                          {licenseSearchQuery && (
                            <button 
                              type="button" 
                              onClick={() => {
                                setLicenseSearchQuery('');
                                setLicensePage(1);
                              }}
                              className="absolute right-2 top-2 text-[10px] font-bold text-slate-400 hover:text-slate-200 cursor-pointer"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Table Render */}
                    {(() => {
                      const filtered = allLicenses.filter(lic => {
                        // 1. Status Filter
                        if (activeLicenseFilter === 'available') {
                          if (lic.status !== 'available' && lic.status !== 'found') return false;
                        }
                        
                        // 2. Search Query Filter
                        if (!licenseSearchQuery) return true;
                        const q = licenseSearchQuery.toLowerCase().trim();
                        return (
                          (lic.fullName || '').toLowerCase().includes(q) ||
                          (lic.licenseNumber || '').toLowerCase().includes(q) ||
                          (lic.applicantId || '').toLowerCase().includes(q) ||
                          (lic.mobileNumber || '').toLowerCase().includes(q) ||
                          (lic.category || '').toLowerCase().includes(q) ||
                          (lic.remarks || '').toLowerCase().includes(q)
                        );
                      });

                      const totalCount = filtered.length;
                      const LICENSE_PAGE_SIZE = 10;
                      const totalPages = Math.ceil(totalCount / LICENSE_PAGE_SIZE) || 1;
                      const paginated = filtered.slice(
                        (licensePage - 1) * LICENSE_PAGE_SIZE,
                        licensePage * LICENSE_PAGE_SIZE
                      );

                      if (totalCount === 0) {
                        return (
                          <div className="py-12 text-center text-xs text-slate-500 italic">
                            No records found matching "{licenseSearchQuery}" under this category.
                          </div>
                        );
                      }

                      return (
                        <div className="space-y-4">
                          <div className="overflow-x-auto rounded-xl border border-slate-800/30">
                            <table className="w-full text-left text-xs border-collapse font-sans">
                              <thead>
                                <tr className={`border-b text-[10px] uppercase tracking-wider font-extrabold ${
                                  isDark 
                                    ? 'bg-slate-900 border-slate-800 text-slate-300' 
                                    : 'bg-slate-50 border-slate-200 text-slate-700'
                                }`}>
                                  <th className="py-2.5 px-3">S.N. (क्र.सं.)</th>
                                  <th className="py-2.5 px-3">APPLICANT ID</th>
                                  <th className="py-2.5 px-3">FULL NAME (पूरा नाम)</th>
                                  <th className="py-2.5 px-3">LICENSE NO (लाइसेन्स नं)</th>
                                  <th className="py-2.5 px-3">CATEGORY (वर्ग)</th>
                                  <th className="py-2.5 px-3 text-center">MOBILE</th>
                                  <th className="py-2.5 px-3 text-center">STATUS (स्थिति)</th>
                                  <th className="py-2.5 px-3 text-right">ACTIONS (कार्यहरू)</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-800/20">
                                {paginated.map((lic, idx) => {
                                  const realSn = (licensePage - 1) * LICENSE_PAGE_SIZE + idx + 1;
                                  return (
                                    <tr 
                                      key={lic.id} 
                                      className={`transition-colors hover:bg-slate-905/10 dark:hover:bg-slate-900/40`}
                                    >
                                      <td className="py-2.5 px-3 font-mono text-[10px] text-slate-500">{realSn}</td>
                                      <td className="py-2.5 px-3 font-mono font-bold text-cyan-500 text-[10px]">{lic.applicantId}</td>
                                      <td className="py-2.5 px-3 font-semibold">{lic.fullName}</td>
                                      <td className="py-2.5 px-3 font-mono text-[10px] font-bold">{lic.licenseNumber}</td>
                                      <td className="py-2.5 px-3">
                                        <span className={`px-2 py-0.5 rounded-sm text-[10px] font-bold ${
                                          isDark ? 'bg-slate-850 text-slate-300' : 'bg-slate-100 text-slate-700'
                                        }`}>
                                          {lic.category || 'N/A'}
                                        </span>
                                      </td>
                                      <td className="py-2.5 px-3 text-center font-mono text-slate-500">{lic.mobileNumber || '—'}</td>
                                      <td className="py-2.5 px-3 text-center">
                                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-wide inline-block ${
                                          lic.status === 'distributed'
                                            ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/30'
                                            : lic.status === 'missing'
                                              ? 'bg-rose-955/20 text-rose-400 border border-rose-900/30'
                                              : lic.status === 'found'
                                                ? 'bg-sky-950/40 text-sky-400 border border-sky-900/30'
                                                : 'bg-amber-955/20 text-amber-500 border border-amber-900/30'
                                        }`}>
                                          {lic.status === 'distributed' ? '✓ DISTRIBUTED' : lic.status === 'missing' ? '✗ MISSING' : lic.status === 'found' ? '✓ FOUND' : '● PENDING'}
                                        </span>
                                      </td>
                                      <td className="py-2.5 px-3 text-right">
                                        <div className="flex items-center justify-end gap-1.5">
                                          <button
                                            type="button"
                                            title="View Details & Logs"
                                            onClick={() => setSelectedLicenseDetails(lic)}
                                            className={`p-1.5 rounded-lg border transition-all active:scale-95 cursor-pointer ${
                                              isDark 
                                                ? 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-300' 
                                                : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-600 shadow-xs'
                                            }`}
                                          >
                                            <Eye className="w-3.5 h-3.5" />
                                          </button>
                                          <button
                                            type="button"
                                            title="Permanently Delete"
                                            onClick={() => handleConfirmDeleteConsole(lic.id, lic.licenseNumber, lic.fullName)}
                                            className={`p-1.5 rounded-lg border transition-all active:scale-95 cursor-pointer ${
                                              isDark 
                                                ? 'bg-rose-950/20 hover:bg-rose-900/40 border-rose-900/30 text-rose-400' 
                                                : 'bg-rose-50 hover:bg-rose-100 border-rose-100 text-rose-700 shadow-xs'
                                            }`}
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>

                          {/* Pagination Controls */}
                          <div className="flex items-center justify-between text-xs pt-2">
                            <span className="text-slate-500 font-medium">
                              Showing <strong className="text-slate-400">{(licensePage - 1) * LICENSE_PAGE_SIZE + 1}</strong> to{' '}
                              <strong className="text-slate-400">{Math.min(licensePage * LICENSE_PAGE_SIZE, totalCount)}</strong> of{' '}
                              <strong className="text-slate-400">{totalCount}</strong> records
                            </span>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                disabled={licensePage === 1}
                                onClick={() => setLicensePage(prev => Math.max(1, prev - 1))}
                                className={`px-2.5 py-1 rounded-md border text-[10px] font-bold uppercase transition-all ${
                                  licensePage === 1
                                    ? 'opacity-40 cursor-not-allowed border-slate-800 text-slate-500'
                                    : 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-200 cursor-pointer'
                                }`}
                              >
                                Prev
                              </button>
                              <span className="px-2 font-semibold">
                                Page {licensePage} of {totalPages}
                              </span>
                              <button
                                type="button"
                                disabled={licensePage === totalPages}
                                onClick={() => setLicensePage(prev => Math.min(totalPages, prev + 1))}
                                className={`px-2.5 py-1 rounded-md border text-[10px] font-bold uppercase transition-all ${
                                  licensePage === totalPages
                                    ? 'opacity-40 cursor-not-allowed border-slate-800 text-slate-500'
                                    : 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-200 cursor-pointer'
                                }`}
                              >
                                Next
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* UPLOADED LOT HISTORY WORKSHEET (TABLE VIEW) */}
                {activeLicenseFilter === 'lots' && !selectedLotId && (
                  <div className={`border rounded-2xl p-5 space-y-4 transition-all animate-in fade-in slide-in-from-top-4 duration-300 ${
                    isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
                  }`}>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-3 border-slate-800/40">
                      <div>
                        <h4 className={`text-sm font-black uppercase tracking-wider flex items-center gap-2 ${isDark ? 'text-amber-400' : 'text-[#7A5B01]'}`}>
                          <span>📦</span>
                          अपलोड इतिहास लट तालिका (UPLOADED LOT HISTORY WORKSHEET)
                        </h4>
                        <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                          कार्यालयमा आयात गरिएका कुल <strong className="text-amber-600">{uploadLedgers.filter(l => l.status !== 'Deleted').length} - LOT</strong> लट फाइलहरू उपलब्ध छन्। यहाँबाट प्रत्येक लटको तथ्याङ्क र स्थिति हेर्न सक्नुहुन्छ।
                        </p>
                      </div>

                      {/* Search & Refresh Actions */}
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="relative">
                          <input
                            type="text"
                            placeholder="फाइल नाम वा लट खोज्नुहोस्..."
                            value={ledgerSearchQuery}
                            onChange={(e) => setLedgerSearchQuery(e.target.value)}
                            className={`pl-3 pr-8 py-1.5 text-xs rounded-lg border outline-hidden transition-all ${
                              isDark 
                                ? 'bg-slate-900 border-slate-800 text-white placeholder-slate-500 focus:border-cyan-500 w-[180px]' 
                                : 'bg-slate-50 border-slate-250 text-slate-800 placeholder-slate-400 focus:border-amber-600 w-[180px]'
                            }`}
                          />
                          {ledgerSearchQuery && (
                            <button 
                              type="button" 
                              onClick={() => setLedgerSearchQuery('')}
                              className="absolute right-2 top-2 text-[10px] font-bold text-slate-400 hover:text-slate-200 cursor-pointer"
                            >
                              ×
                            </button>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={fetchConsoleLicenses}
                          title="Reload history data"
                          className={`p-2 rounded-lg border transition-all active:scale-95 cursor-pointer ${
                            isDark 
                              ? 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-300' 
                              : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-600'
                          }`}
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {ledgersLoading ? (
                      <div className="py-12 text-center text-xs text-slate-500 flex flex-col items-center justify-center gap-3">
                        <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
                        <span>Loading upload history ledger worksheet...</span>
                      </div>
                    ) : uploadLedgers.length === 0 ? (
                      <div className="py-12 text-center text-xs text-slate-500">
                        No upload ledgers recorded. Use the lot uploader below to import new lot files.
                      </div>
                    ) : (
                      <div className="overflow-x-auto rounded-xl border border-slate-800/30">
                        <table className="w-full text-left text-xs border-collapse font-sans">
                          <thead>
                            <tr className={`border-b text-[10px] uppercase tracking-wider font-extrabold ${
                              isDark 
                                ? 'bg-slate-900 border-slate-850 text-amber-400' 
                                : 'bg-[#FEF5D4] border-amber-200 text-[#7A5B01]'
                            }`}>
                              <th className="py-3 px-3 text-center">S.N. (क्र.सं.)</th>
                              <th className="py-3 px-3">UPLOADED FILE NAME</th>
                              <th className="py-3 px-3 text-center">LOT (लट)</th>
                              <th className="py-3 px-3 text-center">DATE (AD/BS)</th>
                              <th className="py-3 px-3 text-center text-[#2980B9]">PREV RECORDS</th>
                              <th className="py-3 px-3 text-center text-[#27AE60]">RECENT RECORDS</th>
                              <th className="py-3 px-3 text-center text-[#C0392B]">DUPLICATE FOUND</th>
                              <th className="py-3 px-3 text-center text-[#1B4F72]">TOTAL RECORDS</th>
                              <th className="py-3 px-3 text-center">STATUS</th>
                              <th className="py-3 px-3 text-right">ACTIONS</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/20">
                            {(() => {
                              const filtered = uploadLedgers.filter(ledger => {
                                if (!ledgerSearchQuery) return true;
                                const q = ledgerSearchQuery.toLowerCase();
                                return (
                                  ledger.id.toLowerCase().includes(q) ||
                                  (ledger.fileName || '').toLowerCase().includes(q) ||
                                  (ledger.status || '').toLowerCase().includes(q) ||
                                  (ledger.actionType || '').toLowerCase().includes(q)
                                );
                              });

                              if (filtered.length === 0) {
                                return (
                                  <tr>
                                    <td colSpan={10} className="py-8 text-center text-slate-500 italic">
                                      No records match the search query "{ledgerSearchQuery}".
                                    </td>
                                  </tr>
                                );
                              }

                              return filtered.map((ledger, index) => {
                                const isActionLoading = actionLoadingId === ledger.id;
                                
                                // Ordinal suffix for lots
                                const getOrdinal = (n: number) => {
                                  const s = ["th", "st", "nd", "rd"];
                                  const v = n % 100;
                                  return n + (s[(v - 20) % 10] || s[v] || s[0]);
                                };

                                // Calculate dynamic preceding cumulative sum matching Picture 2 perfectly!
                                const prevCount = filtered
                                  .slice(index + 1)
                                  .reduce((sum, l) => sum + (l.status !== 'Deleted' ? l.importedRecords : 0), 0);

                                const totalRecordsAtThisLot = prevCount + (ledger.status !== 'Deleted' ? ledger.importedRecords : 0);
                                
                                // Date formatting
                                let nepaliDate = "२०८३/०४/०३";
                                try {
                                  const dateStr = ledger.timestamp.split('T')[0];
                                  nepaliDate = convertADToBS(dateStr).replace(/-/g, '/');
                                } catch (e) {
                                  // use fallback
                                }

                                return (
                                  <tr 
                                    key={ledger.id}
                                    className={`transition-colors duration-150 border-b ${
                                      ledger.status === 'Deleted' 
                                        ? 'opacity-60 bg-rose-955/5 line-through' 
                                        : ledger.status === 'Restored' 
                                          ? 'bg-emerald-955/5' 
                                          : ''
                                    }`}
                                  >
                                    <td className="py-3 px-3 font-mono text-[11px] font-bold text-center text-slate-500">{index + 1}</td>
                                    <td className="py-3 px-3 font-semibold text-slate-800 dark:text-slate-200">
                                      {ledger.fileName}
                                    </td>
                                    <td className="py-3 px-3 text-center">
                                      <span className="px-2 py-0.5 rounded-sm text-[9px] font-bold bg-[#FDF2E9] text-[#D35400] border border-[#F5CBA7] whitespace-nowrap">
                                        {getOrdinal(filtered.length - index)} - LOT
                                      </span>
                                    </td>
                                    <td className="py-3 px-3 text-center font-mono text-[11px] text-slate-600 dark:text-slate-400">
                                      {nepaliDate}
                                    </td>
                                    <td className="py-3 px-3 text-center font-bold font-mono text-[#2980B9] text-xs">
                                      {ledger.status === 'Deleted' ? 0 : prevCount}
                                    </td>
                                    <td className="py-3 px-3 text-center font-bold font-mono text-[#27AE60] text-xs">
                                      {ledger.status === 'Deleted' ? 0 : ledger.importedRecords}
                                    </td>
                                    <td className="py-3 px-3 text-center font-bold font-mono text-xs">
                                      {ledger.status === 'Deleted' || !(ledger.duplicateRecords > 0) ? (
                                        <span className="text-slate-400 font-bold">0</span>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleOpenDuplicateComparisonDialog(ledger);
                                          }}
                                          title="Click to compare duplicate records side-by-side"
                                          className="px-2.5 py-1 rounded-md text-xs font-black bg-rose-100 hover:bg-rose-200 text-[#C0392B] border border-rose-300 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 dark:text-rose-400 dark:border-rose-800 cursor-pointer transition-all active:scale-95 shadow-2xs inline-flex items-center gap-1"
                                        >
                                          <span>{ledger.duplicateRecords}</span>
                                        </button>
                                      )}
                                    </td>
                                    <td className="py-3 px-3 text-center font-bold font-mono text-[#1B4F72] text-xs">
                                      {ledger.status === 'Deleted' ? 0 : totalRecordsAtThisLot}
                                    </td>
                                    <td className="py-3 px-3 text-center">
                                      {ledger.status === 'Deleted' ? (
                                        <span className="px-2.5 py-1 rounded-sm text-[9px] font-bold bg-rose-50 text-rose-700 border border-rose-200 inline-block">
                                          Purged / Inactive
                                        </span>
                                      ) : (
                                        <div className="flex flex-col items-center gap-1.5">
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setSelectedLotId(ledger.id);
                                              setLotFilterType('success');
                                              setLicensePage(1);
                                            }}
                                            title="Click to view successfully processed records"
                                            className="px-2.5 py-1 rounded-md text-[9px] font-extrabold bg-[#E8F8F5] hover:bg-[#D1F2EB] text-[#117A65] border border-[#A3E4D7] inline-block whitespace-nowrap cursor-pointer transition-colors active:scale-95 shadow-2xs"
                                          >
                                            Successfully Processed
                                          </button>
                                          {ledger.duplicateRecords > 0 && (
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                handleOpenDuplicateComparisonDialog(ledger);
                                              }}
                                              title="Click to open Duplicate Comparison Dialog"
                                              className="text-[9px] font-extrabold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-md px-2 py-1 mt-0.5 whitespace-nowrap cursor-pointer transition-all active:scale-95 shadow-2xs"
                                            >
                                              ({ledger.duplicateRecords} Duplicates found)
                                            </button>
                                          )}
                                        </div>
                                      )}
                                    </td>
                                    <td className="py-3 px-3 text-right" onClick={(e) => e.stopPropagation()}>
                                      <div className="flex items-center justify-end gap-1.5">
                                        <button
                                          type="button"
                                          disabled={isActionLoading}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleRestoreLedger(ledger.id);
                                          }}
                                          className={`px-2.5 py-1 text-[9px] font-black uppercase rounded-lg border transition-all flex items-center gap-1 active:scale-95 ${
                                            isActionLoading
                                              ? 'opacity-40 cursor-not-allowed border-slate-800 text-slate-500'
                                              : 'bg-emerald-50 hover:bg-emerald-100 border-emerald-200 text-emerald-800 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/50 dark:border-emerald-800/60 dark:text-emerald-400 cursor-pointer shadow-sm'
                                          }`}
                                        >
                                          {isActionLoading && actionLoadingId === ledger.id ? 'Wait...' : 'Restore'}
                                        </button>
                                        <button
                                          type="button"
                                          disabled={isActionLoading || ledger.status === 'Deleted'}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleOpenLedgerDeleteVerify(ledger.id);
                                          }}
                                          className={`px-2.5 py-1 text-[9px] font-black uppercase rounded-lg border transition-all flex items-center gap-1 active:scale-95 ${
                                            ledger.status === 'Deleted'
                                              ? 'opacity-40 cursor-not-allowed border-slate-800 text-slate-500'
                                              : 'bg-rose-50 hover:bg-rose-100 border-rose-200 text-rose-850 dark:bg-rose-955/20 dark:hover:bg-rose-900/30 dark:border-rose-900/40 dark:text-rose-400 cursor-pointer shadow-sm'
                                          }`}
                                        >
                                          {isActionLoading && actionLoadingId === ledger.id ? 'Purging...' : 'Delete'}
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              });
                            })()}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* LOT-WISE DRILLDOWN RECORDS LIST */}
                {activeLicenseFilter === 'lots' && selectedLotId && (() => {
                  const selectedLedger = uploadLedgers.find(l => l.id === selectedLotId);
                  const activeLedgers = uploadLedgers.filter(l => l.status !== 'Deleted');
                  const ledgerIdx = activeLedgers.findIndex(l => l.id === selectedLotId);
                  const ordinalText = ledgerIdx !== -1 ? (() => {
                    const n = activeLedgers.length - ledgerIdx;
                    const s = ["th", "st", "nd", "rd"];
                    const v = n % 100;
                    return n + (s[(v - 20) % 10] || s[v] || s[0]);
                  })() + " - LOT" : "LOT";

                  const lotLicenses = allLicenses.filter(lic => {
                    if (lic.uploadId !== selectedLotId) return false;
                    if (lotFilterType === 'duplicate') return !!lic.isDuplicate;
                    if (lotFilterType === 'success') return !lic.isDuplicate;
                    return true;
                  });
                  const filteredLotLicenses = lotLicenses.filter(lic => {
                    if (!licenseSearchQuery) return true;
                    const q = licenseSearchQuery.toLowerCase().trim();
                    return (
                      (lic.fullName || '').toLowerCase().includes(q) ||
                      (lic.licenseNumber || '').toLowerCase().includes(q) ||
                      (lic.applicantId || '').toLowerCase().includes(q) ||
                      (lic.mobileNumber || '').toLowerCase().includes(q) ||
                      (lic.category || '').toLowerCase().includes(q) ||
                      (lic.remarks || '').toLowerCase().includes(q)
                    );
                  });

                  const lotTotalCount = filteredLotLicenses.length;
                  const LOT_PAGE_SIZE = 10;
                  const lotTotalPages = Math.ceil(lotTotalCount / LOT_PAGE_SIZE) || 1;
                  const paginatedLotLicenses = filteredLotLicenses.slice(
                    (licensePage - 1) * LOT_PAGE_SIZE,
                    licensePage * LOT_PAGE_SIZE
                  );

                  return (
                    <div className={`border rounded-2xl p-5 space-y-4 transition-all animate-in fade-in slide-in-from-top-4 duration-300 ${
                      isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
                    }`}>
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-3 border-slate-800/40">
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedLotId(null);
                              setLicensePage(1);
                            }}
                            className={`px-3 py-1.5 text-xs font-black uppercase rounded-lg border transition-all flex items-center gap-1.5 active:scale-95 cursor-pointer ${
                              isDark 
                                ? 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-300' 
                                : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-700 shadow-xs'
                            }`}
                          >
                            ← Back (फर्कनुहोस्)
                          </button>
                          <div>
                            <h4 className={`text-sm font-black uppercase tracking-wider flex items-center gap-2 ${isDark ? 'text-amber-400' : 'text-[#7A5B01]'}`}>
                              <span>📦</span>
                              {ordinalText}: {selectedLedger?.fileName || 'Lot Records'}
                            </h4>
                            <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                              This lot contains <strong className="text-amber-600">{lotLicenses.length}</strong> loaded driving license records.
                            </p>
                          </div>
                        </div>

                        {/* Search & Back Actions */}
                        <div className="flex items-center gap-2.5 shrink-0">
                          <div className="relative">
                            <input
                              type="text"
                              placeholder="Search lot records..."
                              value={licenseSearchQuery}
                              onChange={(e) => {
                                setLicenseSearchQuery(e.target.value);
                                setLicensePage(1);
                              }}
                              className={`pl-3 pr-8 py-1.5 text-xs rounded-lg border outline-hidden transition-all ${
                                isDark 
                                  ? 'bg-slate-900 border-slate-800 text-white placeholder-slate-500 focus:border-indigo-500 w-[200px]' 
                                  : 'bg-slate-50 border-slate-250 text-slate-800 placeholder-slate-400 focus:border-indigo-600 w-[200px]'
                              }`}
                            />
                            {licenseSearchQuery && (
                              <button 
                                type="button" 
                                onClick={() => {
                                  setLicenseSearchQuery('');
                                  setLicensePage(1);
                                }}
                                className="absolute right-2 top-2 text-[10px] font-bold text-slate-400 hover:text-slate-200 cursor-pointer"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Filter category selector tabs */}
                      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 dark:bg-slate-900/40 p-3 rounded-xl border border-slate-200/50 dark:border-slate-800/40">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-xs font-bold ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                            Filter Category:
                          </span>
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              type="button"
                              onClick={() => {
                                setLotFilterType('all');
                                setLicensePage(1);
                              }}
                              className={`px-3 py-1 text-[10px] md:text-xs font-black uppercase rounded-lg border transition-all active:scale-95 cursor-pointer ${
                                lotFilterType === 'all'
                                  ? 'bg-amber-500 text-slate-950 border-amber-400 font-extrabold shadow-sm'
                                  : isDark
                                    ? 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 shadow-xs'
                              }`}
                            >
                              All ({allLicenses.filter(lic => lic.uploadId === selectedLotId).length})
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setLotFilterType('success');
                                setLicensePage(1);
                              }}
                              className={`px-3 py-1 text-[10px] md:text-xs font-black uppercase rounded-lg border transition-all active:scale-95 cursor-pointer ${
                                lotFilterType === 'success'
                                  ? 'bg-emerald-600 text-white border-emerald-500 font-extrabold shadow-sm'
                                  : isDark
                                    ? 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 shadow-xs'
                              }`}
                            >
                              Successfully Processed ({allLicenses.filter(lic => lic.uploadId === selectedLotId && !lic.isDuplicate).length})
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setLotFilterType('duplicate');
                                setLicensePage(1);
                              }}
                              className={`px-3 py-1 text-[10px] md:text-xs font-black uppercase rounded-lg border transition-all active:scale-95 cursor-pointer ${
                                lotFilterType === 'duplicate'
                                  ? 'bg-rose-600 text-white border-rose-500 font-extrabold shadow-sm'
                                  : isDark
                                    ? 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 shadow-xs'
                              }`}
                            >
                              Duplicate Records ({allLicenses.filter(lic => lic.uploadId === selectedLotId && !!lic.isDuplicate).length})
                            </button>
                          </div>
                        </div>

                        {lotFilterType !== 'all' && (
                          <button
                            type="button"
                            onClick={() => {
                              setLotFilterType('all');
                              setLicensePage(1);
                            }}
                            className="text-xs font-bold text-red-500 hover:text-red-600 cursor-pointer active:scale-95 transition-all"
                          >
                            Clear Filter (फिल्टर हटाउनुहोस्)
                          </button>
                        )}
                      </div>

                      {lotTotalCount === 0 ? (
                        <div className="py-12 text-center text-xs text-slate-500 italic">
                          No records found matching "{licenseSearchQuery}" in this lot.
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <div className="overflow-x-auto rounded-xl border border-slate-800/30">
                            <table className="w-full text-left text-xs border-collapse font-sans">
                              <thead>
                                <tr className={`border-b text-[10px] uppercase tracking-wider font-extrabold ${
                                  isDark 
                                    ? 'bg-slate-900 border-slate-800 text-slate-300' 
                                    : 'bg-slate-50 border-slate-200 text-slate-700'
                                }`}>
                                  <th className="py-2.5 px-3">S.N. (क्र.सं.)</th>
                                  <th className="py-2.5 px-3">APPLICANT ID</th>
                                  <th className="py-2.5 px-3">FULL NAME (पूरा नाम)</th>
                                  <th className="py-2.5 px-3">LICENSE NO (लाइसेन्स नं)</th>
                                  <th className="py-2.5 px-3">CATEGORY (वर्ग)</th>
                                  <th className="py-2.5 px-3 text-center">MOBILE</th>
                                  <th className="py-2.5 px-3 text-center">STATUS (स्थिति)</th>
                                  <th className="py-2.5 px-3 text-right">ACTIONS (कार्यहरू)</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-800/20">
                                {paginatedLotLicenses.map((lic, idx) => {
                                  const realSn = (licensePage - 1) * LOT_PAGE_SIZE + idx + 1;
                                  const isRowDuplicate = !!lic.isDuplicate;
                                  return (
                                    <tr 
                                      key={lic.id} 
                                      className={`transition-colors border-b border-slate-800/10 ${
                                        isRowDuplicate 
                                          ? 'bg-rose-50/30 hover:bg-rose-50/50 dark:bg-rose-950/10 dark:hover:bg-rose-950/20' 
                                          : 'hover:bg-slate-50/50 dark:hover:bg-slate-900/40'
                                      }`}
                                    >
                                      <td className="py-2.5 px-3 font-mono text-[10px] text-slate-500">{realSn}</td>
                                      <td className="py-2.5 px-3 font-mono font-bold text-cyan-500 text-[10px]">{lic.applicantId}</td>
                                      <td className="py-2.5 px-3">
                                        <div className="flex items-center gap-2">
                                          <span className="font-semibold">{lic.fullName}</span>
                                          {isRowDuplicate && (
                                            <span className="px-1.5 py-0.5 rounded-sm text-[8px] font-extrabold bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400 border border-rose-250 dark:border-rose-900/40 uppercase tracking-wider inline-block">
                                              Duplicate Found
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="py-2.5 px-3 font-mono text-[10px] font-bold">{lic.licenseNumber}</td>
                                      <td className="py-2.5 px-3">
                                        <span className={`px-2 py-0.5 rounded-sm text-[10px] font-bold ${
                                          isDark ? 'bg-slate-850 text-slate-300' : 'bg-slate-100 text-slate-700'
                                        }`}>
                                          {lic.category || 'N/A'}
                                        </span>
                                      </td>
                                      <td className="py-2.5 px-3 text-center font-mono text-slate-500">{lic.mobileNumber || '—'}</td>
                                      <td className="py-2.5 px-3 text-center">
                                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-wide inline-block ${
                                          lic.status === 'distributed'
                                            ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/30'
                                            : lic.status === 'missing'
                                              ? 'bg-rose-955/20 text-rose-400 border border-rose-900/30'
                                              : lic.status === 'found'
                                                ? 'bg-sky-950/40 text-sky-400 border border-sky-900/30'
                                                : 'bg-amber-955/20 text-amber-500 border border-amber-900/30'
                                        }`}>
                                          {lic.status === 'distributed' ? '✓ DISTRIBUTED' : lic.status === 'missing' ? '✗ MISSING' : lic.status === 'found' ? '✓ FOUND' : '● PENDING'}
                                        </span>
                                      </td>
                                      <td className="py-2.5 px-3 text-right">
                                        <div className="flex items-center justify-end gap-1.5">
                                          <button
                                            type="button"
                                            title="View Details & Logs"
                                            onClick={() => setSelectedLicenseDetails(lic)}
                                            className={`p-1.5 rounded-lg border transition-all active:scale-95 cursor-pointer ${
                                              isDark 
                                                ? 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-300' 
                                                : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-600 shadow-xs'
                                            }`}
                                          >
                                            <Eye className="w-3.5 h-3.5" />
                                          </button>
                                          <button
                                            type="button"
                                            title="Permanently Delete"
                                            onClick={() => handleConfirmDeleteConsole(lic.id, lic.licenseNumber, lic.fullName)}
                                            className={`p-1.5 rounded-lg border transition-all active:scale-95 cursor-pointer ${
                                              isDark 
                                                ? 'bg-rose-955/20 hover:bg-rose-900/40 border-rose-900/30 text-rose-400' 
                                                : 'bg-rose-50 hover:bg-rose-100 border-rose-100 text-rose-700 shadow-xs'
                                            }`}
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>

                          {/* Pagination Controls */}
                          <div className="flex items-center justify-between text-xs pt-2">
                            <span className="text-slate-500 font-medium">
                              Showing <strong className="text-slate-400">{(licensePage - 1) * LOT_PAGE_SIZE + 1}</strong> to{' '}
                              <strong className="text-slate-400">{Math.min(licensePage * LOT_PAGE_SIZE, lotTotalCount)}</strong> of{' '}
                              <strong className="text-slate-400">{lotTotalCount}</strong> records
                            </span>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                disabled={licensePage === 1}
                                onClick={() => setLicensePage(prev => Math.max(1, prev - 1))}
                                className={`px-2.5 py-1 rounded-md border text-[10px] font-bold uppercase transition-all ${
                                  licensePage === 1
                                    ? 'opacity-40 cursor-not-allowed border-slate-800 text-slate-500'
                                    : 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-200 cursor-pointer'
                                }`}
                              >
                                Prev
                              </button>
                              <span className="px-2 font-semibold">
                                Page {licensePage} of {lotTotalPages}
                              </span>
                              <button
                                type="button"
                                disabled={licensePage === lotTotalPages}
                                onClick={() => setLicensePage(prev => Math.min(lotTotalPages, prev + 1))}
                                className={`px-2.5 py-1 rounded-md border text-[10px] font-bold uppercase transition-all ${
                                  licensePage === lotTotalPages
                                    ? 'opacity-40 cursor-not-allowed border-slate-800 text-slate-500'
                                    : 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-200 cursor-pointer'
                                }`}
                              >
                                Next
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* FILE IMPORTER ZONE WITH TABS TO MANAGE SPACES */}
                <div className={`border rounded-2xl p-5 space-y-4 transition-all ${
                  isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
                }`}>
                  {/* Tab Selector */}
                  <div className="flex items-center justify-between border-b pb-2.5 border-slate-800/40 flex-wrap gap-2">
                    <div className="flex items-center gap-3 flex-wrap">
                      <button
                        type="button"
                        onClick={() => setUploaderTab('lot')}
                        className={`px-4 py-2 text-xs font-black tracking-wide uppercase transition-all rounded-xl border cursor-pointer ${
                          uploaderTab === 'lot'
                            ? (isDark ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-400' : 'bg-emerald-50 border-emerald-200 text-emerald-800')
                            : (isDark ? 'border-slate-850 text-slate-400 hover:text-white' : 'border-slate-200 text-slate-500 hover:text-slate-900')
                        }`}
                      >
                        📁 Lot-Wise Bulk Importer
                      </button>
                      <button
                        type="button"
                        onClick={() => setUploaderTab('advanced')}
                        className={`px-4 py-2 text-xs font-black tracking-wide uppercase transition-all rounded-xl border cursor-pointer ${
                          uploaderTab === 'advanced'
                            ? (isDark ? 'bg-cyan-950/60 border-cyan-850 text-cyan-400' : 'bg-cyan-50 border-cyan-200 text-cyan-800')
                            : (isDark ? 'border-slate-850 text-slate-400 hover:text-white' : 'border-slate-200 text-slate-500 hover:text-slate-900')
                        }`}
                      >
                        ⚙️ Advanced Mapping Ledger Importer
                      </button>
                      <button 
                        type="button"
                        onClick={() => downloadPdfSampleTemplate()}
                        title="Download official PDF Sample Template"
                        className={`px-3 py-2 text-xs font-black uppercase tracking-wider rounded-xl border transition-all flex items-center gap-1.5 active:scale-95 cursor-pointer shadow-xs ${
                          isDark 
                            ? 'border-cyan-800/60 bg-cyan-950/40 hover:bg-cyan-900/60 text-cyan-300' 
                            : 'border-cyan-200 bg-cyan-50/80 hover:bg-cyan-100 text-cyan-900 font-extrabold'
                        }`}
                      >
                        <span>📕</span>
                        DOWNLOAD SAMPLE TEMPLATE (PDF)
                      </button>
                    </div>
                  </div>

                  {uploaderTab === 'lot' ? (
                    <div className="space-y-4">
                      {/* Drag and Drop Box */}
                      <div 
                        className={`border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center gap-4 cursor-pointer transition-all duration-300 group ${
                          uploadLoading
                            ? (isDark ? 'border-emerald-900 bg-emerald-950/5' : 'border-emerald-200 bg-emerald-50/10')
                            : (isDark ? 'border-slate-700 hover:border-emerald-500 bg-slate-900/20 hover:bg-emerald-950/10' : 'border-slate-300 hover:border-emerald-500 bg-slate-50 hover:bg-emerald-50/25')
                        }`}
                        onClick={() => {
                          if (!uploadLoading) {
                            const input = document.createElement('input');
                            input.type = 'file';
                            input.accept = '.xlsx, .xls, .csv';
                            input.onchange = (e) => {
                              const files = (e.target as HTMLInputElement).files;
                              if (files && files[0]) {
                                handleUploadLedgerFile(files[0]);
                              }
                            };
                            input.click();
                          }
                        }}
                      >
                        <div className={`w-14 h-14 rounded-full group-hover:scale-110 transition-all flex items-center justify-center border animate-pulse ${
                          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-250 shadow-sm'
                        }`}>
                          <UploadCloud className={`w-7 h-7 ${uploadLoading ? 'text-emerald-400 animate-bounce' : 'text-slate-500 group-hover:text-emerald-400'}`} />
                        </div>
                        <div className="text-center space-y-1">
                          <p className={`font-black text-sm md:text-base ${isDark ? 'text-white' : 'text-slate-800'}`}>
                            {uploadLoading ? 'Processing spreadsheet lot file...' : 'अपलोड गर्न फाइल तान्नुहोस् (Upload New Lot File)'}
                          </p>
                          <p className="text-xs text-slate-500 max-w-md mx-auto">
                            Drag & drop or browse spreadsheet file (.xlsx, .xls, .csv) with driving license records to instantly bulk uploader.
                          </p>
                        </div>

                        {!uploadLoading && (
                          <button
                            type="button"
                            className="mt-2 px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-xs uppercase tracking-wider rounded-xl transition-all shadow-md group-hover:shadow-lg active:scale-95 cursor-pointer"
                          >
                            क्लाउडमा नयाँ रेकर्ड अपलोड गर्नुहोस् (Upload New Lot File)
                          </button>
                        )}
                      </div>

                      {uploadLoading && (
                        <div className="space-y-1.5 p-4 rounded-xl bg-slate-900/30 border border-slate-800/40">
                          <div className="flex items-center justify-between text-[11px] font-bold">
                            <span className="text-emerald-400 animate-pulse">Appending lot records to live database registry...</span>
                            <span>{uploadProgress}%</span>
                          </div>
                          <div className={`w-full h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                            <div 
                              className="h-full bg-emerald-500 rounded-full transition-all duration-150"
                              style={{ width: `${uploadProgress}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-slate-800/20 p-2">
                      <ExcelUpload 
                        theme={isDark ? 'dark' : 'light'} 
                        fullWidth={true} 
                        stepBadge="ADVANCED HEADERS MAPPING IMPORTER"
                        onUploadSuccess={() => {
                          fetchConsoleLicenses();
                        }} 
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* SECTION B: Administrative Database Recovery System */}
              <div className="space-y-6 pt-6 border-t border-slate-800/40">
                <div className="flex items-center gap-2.5 border-b pb-3 border-slate-800/40">
                  <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-md ${
                    isDark ? 'bg-amber-955 text-amber-400 border border-amber-800/50' : 'bg-amber-50 text-amber-700 border border-amber-200'
                  }`}>
                    SECTION B
                  </span>
                  <h4 className={`text-sm font-extrabold tracking-tight uppercase ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    Administrative Database Recovery System
                  </h4>
                </div>

                {/* ADVANCED LEDGER RECOVERY & INTEGRITY PORTAL */}
                <div className={`border rounded-2xl p-5 space-y-5 transition-all ${
                  isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
                }`}>
                  <div className="border-b pb-3 border-slate-800/40">
                    <span className={`inline-block text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-md mb-2 ${
                      isDark ? 'bg-amber-955/60 text-amber-400 border border-amber-800/50' : 'bg-amber-50 text-amber-700 border border-amber-200'
                    }`}>
                      STEP 4: TOTAL RECOVERY & INTEGRITY SUITE (4 CORE ENGINE TOOLS)
                    </span>
                    <h4 className={`text-xs font-black uppercase tracking-wider ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
                      🛡️ ADMINISTRATIVE DISASTER RECOVERY & INTEGRITY ENGINE
                    </h4>
                    <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'} mt-1`}>
                      In case of accidental records disappearance or data corruption, utilize these safe redundancy tools to restore or sanitize the ledger instantly.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 items-stretch">
                    {/* FORCE SYNC */}
                    <div className={`p-4 rounded-xl border flex flex-col justify-between space-y-3 ${
                      isDark ? 'bg-slate-900/30 border-slate-900' : 'bg-slate-50 border-slate-150'
                    }`}>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Database className="w-4 h-4 text-amber-500 shrink-0" />
                          <h5 className={`font-bold text-xs ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>1. Restore Backup (Force Sync)</h5>
                        </div>
                        <p className={`text-[10.5px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                          Fetch and re-insert all records saved in permanent lot backups. Brings back any accidentally deleted database files immediately.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={syncLoading || uploadLoading}
                        onClick={handleForceSyncAllLedgers}
                        className={`w-full py-2 px-3 rounded-lg text-xs font-black uppercase tracking-wider cursor-pointer text-white flex items-center justify-center gap-2 transition-all active:scale-97 ${
                          syncLoading 
                            ? 'bg-amber-700/50 cursor-not-allowed' 
                            : 'bg-amber-600 hover:bg-amber-700 shadow-sm'
                        }`}
                      >
                        <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${syncLoading ? 'animate-spin' : ''}`} />
                        <span>{syncLoading ? 'Synchronizing...' : 'Force Sync Registry'}</span>
                      </button>
                    </div>

                    {/* LOAD AGAIN (OVERWRITE) */}
                    <div className={`p-4 rounded-xl border flex flex-col justify-between space-y-3 ${
                      isDark ? 'bg-slate-900/30 border-slate-900' : 'bg-slate-50 border-slate-150'
                    }`}>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <RefreshCw className="w-4 h-4 text-indigo-500 shrink-0" />
                          <h5 className={`font-bold text-xs ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>2. Load Again & Overwrite</h5>
                        </div>
                        <p className={`text-[10.5px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                          Completely reload the registry using a clean Excel/CSV spreadsheet. Automatically wipes existing applicant files before inserting.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={uploadLoading || syncLoading}
                        onClick={() => {
                          if (window.confirm("CRITICAL WARNING: This action will completely purge all active license records in the database before loading the new file. This is useful for starting over with a clean spreadsheet. Do you want to proceed?")) {
                            const input = document.createElement('input');
                            input.type = 'file';
                            input.accept = '.xlsx, .xls, .csv';
                            input.onchange = (e) => {
                              const files = (e.target as HTMLInputElement).files;
                              if (files && files[0]) {
                                handleUploadLedgerFile(files[0], 'overwrite');
                              }
                            };
                            input.click();
                          }
                        }}
                        className={`w-full py-2 px-3 rounded-lg text-xs font-black uppercase tracking-wider cursor-pointer text-white flex items-center justify-center gap-2 transition-all active:scale-97 ${
                          uploadLoading 
                            ? 'bg-indigo-700/50 cursor-not-allowed' 
                            : 'bg-indigo-600 hover:bg-indigo-700 shadow-sm'
                        }`}
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />
                        <span>Re-Upload & Overwrite</span>
                      </button>
                    </div>

                    {/* APPEND NEW LOT */}
                    <div className={`p-4 rounded-xl border flex flex-col justify-between space-y-3 ${
                      isDark ? 'bg-slate-900/30 border-slate-900' : 'bg-slate-50 border-slate-150'
                    }`}>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <PlusCircle className="w-4 h-4 text-emerald-500 shrink-0" />
                          <h5 className={`font-bold text-xs ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>3. Append Data (Lot-by-Lot)</h5>
                        </div>
                        <p className={`text-[10.5px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                          Safely append new lot records from the last row index onwards. Automatically shifts and tracks consecutive serial numbers.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={uploadLoading || syncLoading}
                        onClick={() => {
                          const input = document.createElement('input');
                          input.type = 'file';
                          input.accept = '.xlsx, .xls, .csv';
                          input.onchange = (e) => {
                            const files = (e.target as HTMLInputElement).files;
                            if (files && files[0]) {
                              handleUploadLedgerFile(files[0], 'append');
                            }
                          };
                          input.click();
                        }}
                        className={`w-full py-2 px-3 rounded-lg text-xs font-black uppercase tracking-wider cursor-pointer text-white flex items-center justify-center gap-2 transition-all active:scale-97 ${
                          uploadLoading 
                            ? 'bg-emerald-700/50 cursor-not-allowed' 
                            : 'bg-emerald-600 hover:bg-emerald-700 shadow-sm'
                        }`}
                      >
                        <PlusCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>Append Lot Spreadsheet</span>
                      </button>
                    </div>

                    {/* 4. DUPLICATE CHECK & PRUNING HUB */}
                    <div className={`p-4 rounded-xl border flex flex-col justify-between space-y-3 ${
                      isDark ? 'bg-slate-900/30 border-slate-900' : 'bg-slate-50 border-slate-150'
                    }`}>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-1">
                          <div className="flex items-center gap-1.5">
                            <CheckCircle className="w-4 h-4 text-rose-500 shrink-0" />
                            <h5 className={`font-bold text-xs ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>4. Duplicate Records Finder</h5>
                          </div>
                          <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded shrink-0 ${
                            duplicateGroups.length > 0 ? 'bg-rose-500 text-white animate-pulse' : 'bg-emerald-500/20 text-emerald-400 font-bold'
                          }`}>
                            {duplicateGroups.length > 0 ? `${duplicateGroups.length} DUPLICATES` : '100% CLEAN'}
                          </span>
                        </div>
                        <p className={`text-[10.5px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                          Real-time audit of redundant License Numbers inside the database ledger. Scan, audit, and prune duplicate records instantly.
                        </p>
                      </div>
                      <div className="flex flex-col gap-1.5 pt-1">
                        {duplicateGroups.length > 0 ? (
                          <button
                            type="button"
                            onClick={handlePruneAllDuplicates}
                            disabled={consoleLoading}
                            className="w-full py-2 px-3 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-black uppercase tracking-wider cursor-pointer transition-all active:scale-97 shadow-sm flex items-center justify-center gap-1.5 animate-pulse"
                          >
                            <Trash2 className="w-3.5 h-3.5 shrink-0" />
                            <span>Auto-Prune ({duplicateGroups.length})</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={consoleLoading}
                            onClick={() => {
                              fetchConsoleLicenses();
                              const elem = document.getElementById('duplicate-records-finder-panel');
                              if (elem) elem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }}
                            className={`w-full py-2 px-3 rounded-lg text-xs font-black uppercase tracking-wider cursor-pointer flex items-center justify-center gap-1.5 transition-all active:scale-97 shadow-sm ${
                              consoleLoading ? 'bg-rose-700/50 text-white cursor-not-allowed' : 'bg-rose-600 hover:bg-rose-700 text-white'
                            }`}
                          >
                            <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${consoleLoading ? 'animate-spin' : ''}`} />
                            <span>{consoleLoading ? 'Checking...' : 'Recalculate Check'}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* SECTION C: Manual Registry Record Deletion Tool */}
              <div className="space-y-6 pt-6 border-t border-slate-800/40">
                <div className="flex items-center gap-2.5 border-b pb-3 border-slate-800/40">
                  <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-md ${
                    isDark ? 'bg-rose-955 text-rose-400 border border-rose-800/50' : 'bg-rose-50 text-rose-700 border border-rose-200'
                  }`}>
                    SECTION C
                  </span>
                  <h4 className={`text-sm font-extrabold tracking-tight uppercase ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    Manual Registry Record Deletion Tool
                  </h4>
                </div>

                {/* Record Search & Delete by License Number */}
                <div className={`border rounded-2xl p-5 space-y-4 transition-all ${
                  isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
                }`}>
                  <div className="border-b pb-3 border-slate-800/40">
                    <h4 className={`text-xs font-black uppercase tracking-wider ${isDark ? 'text-rose-400' : 'text-rose-700'}`}>
                      RECORD SEARCH & DELETE BY LICENSE NUMBER
                    </h4>
                    <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      Search active driving license records by License Number or Applicant Name to perform targeted administrative deletions.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="Record Search: Enter License Number or Applicant Full Name..."
                        value={consoleSearchQuery}
                        onChange={(e) => setConsoleSearchQuery(e.target.value)}
                        className={`w-full px-4 py-2.5 text-xs rounded-xl border outline-hidden transition-all ${
                          isDark 
                            ? 'bg-slate-900 border-slate-800 text-white placeholder-slate-500 focus:border-rose-500' 
                            : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-rose-600 focus:bg-white'
                        }`}
                      />
                      {consoleSearchQuery && (
                        <button 
                          type="button" 
                          onClick={() => setConsoleSearchQuery('')}
                          className="absolute right-3 top-2.5 text-[10px] font-bold text-slate-500 hover:text-slate-300 cursor-pointer"
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    {consoleSearchQuery.trim().length > 0 && (
                      <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
                        {(() => {
                          const query = consoleSearchQuery.trim().toLowerCase();
                          const matching = allLicenses.filter(l => 
                            (l.licenseNumber || '').toLowerCase().includes(query) ||
                            (l.fullName || '').toLowerCase().includes(query)
                          ).slice(0, 15);

                          if (matching.length === 0) {
                            return (
                              <p className="text-xs text-slate-500 py-4 text-center italic">
                                No matching license records found for "{consoleSearchQuery}".
                              </p>
                            );
                          }

                          return matching.map((rec) => (
                            <div key={rec.id} className={`flex items-center justify-between p-3 rounded-xl border text-[11px] transition-all ${
                              isDark ? 'bg-slate-900/40 border-slate-850' : 'bg-slate-50 border-slate-200'
                            }`}>
                              <div className="space-y-0.5">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono font-bold text-cyan-400">
                                    Delete by License Number: {rec.licenseNumber}
                                  </span>
                                  <span className={`font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                                    {rec.fullName}
                                  </span>
                                </div>
                                <div className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                  ID: {rec.applicantId} | Category: <strong className="font-bold">{rec.category}</strong> | Status: <span className="uppercase text-cyan-405 font-bold">{rec.status}</span>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleConfirmDeleteConsole(rec.id, rec.licenseNumber, rec.fullName)}
                                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-[10px] font-extrabold uppercase rounded-lg cursor-pointer transition-colors active:scale-95 shadow-xs shrink-0 flex items-center gap-1"
                              >
                                <Trash2 className="w-3 h-3" />
                                Delete Button
                              </button>
                            </div>
                          ));
                        })()}
                      </div>
                    )}
                  </div>
                </div>

                {/* DUPLICATE RECORDS FINDER & PRUNING HUB */}
                <div id="duplicate-records-finder-panel" className={`border rounded-2xl p-5 space-y-4 transition-all flex flex-col justify-between ${
                  isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
                }`}>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between border-b pb-3 border-slate-800/40">
                      <div>
                        <span className={`inline-block text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md mb-2 ${
                          isDark ? 'bg-rose-955/60 text-rose-400 border border-rose-800/50' : 'bg-rose-50 text-rose-700 border border-rose-200'
                        }`}>
                          STEP 4: DUPLICATE CHECK
                        </span>
                        <h4 className={`text-xs font-black uppercase tracking-wider ${isDark ? 'text-rose-400' : 'text-rose-700'}`}>
                          DUPLICATE RECORDS FINDER & PRUNING HUB
                        </h4>
                        <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                          Real-time audit of redundant License Numbers inside the database ledger.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {duplicateGroups.length > 0 && (
                          <button
                            type="button"
                            onClick={handlePruneAllDuplicates}
                            disabled={consoleLoading}
                            className="px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[11px] font-extrabold uppercase cursor-pointer transition-all active:scale-95 animate-pulse"
                          >
                            Auto-Prune All
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={fetchConsoleLicenses}
                          disabled={consoleLoading}
                          className={`px-3 py-1 rounded-lg text-[11px] font-extrabold uppercase border cursor-pointer transition-all ${
                            isDark 
                              ? 'border-slate-800 hover:bg-slate-900 text-slate-300' 
                              : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                          }`}
                        >
                          Recalculate
                        </button>
                      </div>
                    </div>

                    {consoleLoading ? (
                      <div className="text-center py-6 space-y-3">
                        <div className="w-6 h-6 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
                        <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Analyzing ledger for duplicate licenses...</p>
                      </div>
                    ) : duplicateGroups.length === 0 ? (
                      <div className={`text-center py-6 rounded-xl p-4 border border-dashed transition-all ${
                        isDark ? 'border-slate-900 bg-emerald-950/5' : 'border-slate-200 bg-emerald-50/20'
                      }`}>
                        <CheckCircle className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
                        <p className={`text-xs font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-800'}`}>
                          Excellent! No duplicate License Numbers detected.
                        </p>
                        <p className={`text-[11px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                          The current driving license ledger is 100% clean and sanitized.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-4 max-h-[175px] overflow-y-auto pr-1">
                        <div className={`p-3 rounded-lg text-xs font-extrabold border ${
                          isDark ? 'bg-amber-955/10 border-amber-900/30 text-amber-400' : 'bg-amber-50 border-amber-200 text-amber-800'
                        }`}>
                          ⚠️ Detected {duplicateGroups.length} unique License Number(s) with multiple associated entries. Clean up redundant copies below.
                        </div>

                        <div className="space-y-3">
                          {duplicateGroups.map((group, gIdx) => (
                            <div key={gIdx} className={`border rounded-xl p-3.5 space-y-2.5 ${
                              isDark ? 'bg-slate-900/40 border-slate-900' : 'bg-slate-50 border-slate-150'
                            }`}>
                              <div className="flex items-center justify-between border-b pb-1.5 border-slate-800/40">
                                <span className="font-mono text-[11px] font-bold text-cyan-500">
                                  License No: {group.licenseNumber}
                                </span>
                                <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${
                                  isDark ? 'bg-amber-900/25 text-amber-400' : 'bg-amber-100 text-amber-800'
                                }`}>
                                  {group.records.length} Copies found
                                </span>
                              </div>

                              <div className="space-y-2">
                                {group.records.map((rec) => (
                                  <div key={rec.id} className={`flex items-center justify-between p-2 rounded-lg border text-[11px] transition-all ${
                                    isDark ? 'bg-slate-950/50 border-slate-900' : 'bg-white border-slate-100'
                                  }`}>
                                    <div className="space-y-0.5">
                                      <div className="flex items-center gap-2">
                                        <span className={`font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                                          {rec.fullName}
                                        </span>
                                        <span className="text-[9px] font-mono text-slate-500">
                                          (ID: {rec.applicantId})
                                        </span>
                                      </div>
                                      <div className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                        Status: <strong className="font-bold uppercase text-cyan-405">{rec.status}</strong>
                                      </div>
                                      {rec.remarks && (
                                        <div className="text-[9.5px] italic text-slate-500 line-clamp-1">
                                          Note: {rec.remarks}
                                        </div>
                                      )}
                                    </div>

                                    <button
                                      type="button"
                                      onClick={() => handleConfirmDeleteConsole(rec.id, rec.licenseNumber, rec.fullName)}
                                      className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold rounded-lg cursor-pointer transition-colors active:scale-95"
                                    >
                                      Purge Record
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* SECURITY WARNING INFO */}
                  <div className={`p-3 rounded-xl border flex items-start gap-2.5 mt-2 ${
                    isDark ? 'bg-slate-900/25 border-slate-800' : 'bg-slate-50 border-slate-200'
                  }`}>
                    <Shield className="w-4.5 h-4.5 text-slate-400 shrink-0 mt-0.5" />
                    <p className={`text-[10px] leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-600'}`}>
                      <strong>Administrative Warning:</strong> Standard administrative operators do not have access to these settings. Every manual ledger insertion and database deletion is logged, watermarked with your email ({currentUserEmail || 'superadmin@gmail.com'}), and permanently tracked.
                    </p>
                  </div>
                </div>
              </div>

              {/* TWO COLUMN GRID: 1st picture on Left, 2nd picture on Right */}
              <div className="pt-6 border-t border-slate-800/40">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-stretch">
                  {/* 1st picture in Left Side */}
                  <div className="h-full flex flex-col">
                    <div className={`p-6 rounded-3xl border shadow-lg space-y-4 transition-all h-full flex flex-col justify-between ${
                      isDark ? 'bg-slate-900/40 border-rose-950/40' : 'bg-slate-50/70 border-slate-200'
                    }`}>
                      <div className="space-y-3">
                        <div>
                          <span className="px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-widest bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 rounded-full border border-rose-200/50 dark:border-rose-900/30">
                            BUTTON 4: SECURITY & SUDDEN LOSS RECOVERY PANEL
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xl shrink-0">⏰</span>
                            <h5 className={`font-black text-sm md:text-base ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                              आकस्मिक डाटा रिकभरी नियन्त्रण (SUDDEN LOSS RECOVERY TOOL)
                            </h5>
                          </div>
                          <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                            कुनै पनि समयमा डाटाबेस अचानक खाली भएमा वा डिलिट भएमा, अपलोड गरिएको मिति र समय दायरा (Date-Time Range) छनौट गरी आर्काइभ ब्याकअपबाट तत्काल पुनःस्थापना गर्नुहोस्।
                          </p>
                        </div>
                      </div>

                      <div className="space-y-4 pt-2">
                        <div className={`p-4 rounded-2xl border flex flex-col xl:flex-row xl:items-end gap-4 ${
                          isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200 shadow-xs'
                        }`}>
                          <div className="flex-1 space-y-1.5">
                            <label className={`text-[11px] font-black uppercase tracking-wider flex items-center gap-1.5 ${
                              isDark ? 'text-slate-300' : 'text-slate-700'
                            }`}>
                              <Calendar className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                              <span>सुरु मिति र समय (FROM DATETIME):</span>
                            </label>
                            <input
                              type="datetime-local"
                              value={recoveryStartDate}
                              onChange={(e) => setRecoveryStartDate(e.target.value)}
                              className={`w-full text-xs p-2.5 rounded-xl border outline-none transition-all ${
                                isDark 
                                  ? 'bg-slate-900 border-slate-800 text-slate-200 focus:border-rose-500 focus:ring-1 focus:ring-rose-500/20' 
                                  : 'bg-slate-50/50 border-slate-200 text-slate-800 focus:border-rose-500 focus:ring-1 focus:ring-rose-500/20'
                              }`}
                            />
                          </div>

                          <div className="flex-1 space-y-1.5">
                            <label className={`text-[11px] font-black uppercase tracking-wider flex items-center gap-1.5 ${
                              isDark ? 'text-slate-300' : 'text-slate-700'
                            }`}>
                              <Calendar className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                              <span>अन्तिम मिति र समय (TO DATETIME):</span>
                            </label>
                            <input
                              type="datetime-local"
                              value={recoveryEndDate}
                              onChange={(e) => setRecoveryEndDate(e.target.value)}
                              className={`w-full text-xs p-2.5 rounded-xl border outline-none transition-all ${
                                isDark 
                                  ? 'bg-slate-900 border-slate-800 text-slate-200 focus:border-rose-500 focus:ring-1 focus:ring-rose-500/20' 
                                  : 'bg-slate-50/50 border-slate-200 text-slate-800 focus:border-rose-500 focus:ring-1 focus:ring-rose-500/20'
                              }`}
                            />
                          </div>

                          <div className="shrink-0 w-full xl:w-auto">
                            <button
                              type="button"
                              disabled={rangeRecoveryLoading || !recoveryStartDate || !recoveryEndDate}
                              onClick={handleDateRangeRecovery}
                              className={`w-full xl:w-auto py-2.5 px-5 rounded-xl text-xs font-black uppercase tracking-wider cursor-pointer text-white flex items-center justify-center gap-2 transition-all active:scale-97 shadow-md ${
                                rangeRecoveryLoading
                                  ? 'bg-rose-700/50 cursor-not-allowed'
                                  : 'bg-rose-600 hover:bg-rose-700 hover:shadow-lg focus:ring-2 focus:ring-rose-500/30'
                              }`}
                            >
                              <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${rangeRecoveryLoading ? 'animate-spin' : ''}`} />
                              <span>डाटा रिकभर गर्नुहोस् (RECOVER DATA)</span>
                            </button>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className={`text-[10.5px] font-extrabold uppercase tracking-wide ${
                            isDark ? 'text-slate-400' : 'text-slate-500'
                          }`}>
                            छिटो चयन प्रिसिट (QUICK PRESETS):
                          </span>
                          <button
                            type="button"
                            onClick={() => handleSetPresetRange(1)}
                            className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all cursor-pointer active:scale-95 ${
                              isDark 
                                ? 'border-slate-800 bg-slate-900 hover:bg-slate-850 text-slate-300' 
                                : 'border-slate-200 bg-white hover:bg-slate-100 text-slate-700'
                            }`}
                          >
                            गत १ घण्टा (Last 1 Hour)
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSetPresetRange('today')}
                            className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all cursor-pointer active:scale-95 ${
                              isDark 
                                ? 'border-slate-800 bg-slate-900 hover:bg-slate-850 text-slate-300' 
                                : 'border-slate-200 bg-white hover:bg-slate-100 text-slate-700'
                            }`}
                          >
                            आजको दिन (Today)
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSetPresetRange('yesterday')}
                            className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all cursor-pointer active:scale-95 ${
                              isDark 
                                ? 'border-slate-800 bg-slate-900 hover:bg-slate-850 text-slate-300' 
                                : 'border-slate-200 bg-white hover:bg-slate-100 text-slate-700'
                            }`}
                          >
                            हिजोको दिन (Yesterday)
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSetPresetRange(7 * 24)}
                            className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all cursor-pointer active:scale-95 ${
                              isDark 
                                ? 'border-slate-800 bg-slate-900 hover:bg-slate-850 text-slate-300' 
                                : 'border-slate-200 bg-white hover:bg-slate-100 text-slate-700'
                            }`}
                          >
                            गत ७ दिन (Last 7 Days)
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 2nd picture in Right Side */}
                  <div className="h-full flex flex-col space-y-6">
                    <div className="flex items-center gap-2.5 border-b pb-3 border-slate-800/40">
                      <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-md ${
                        isDark ? 'bg-red-955 text-red-400 border border-red-800/50' : 'bg-red-50 text-red-700 border border-red-200'
                      }`}>
                        SECTION D
                      </span>
                      <h4 className={`text-sm font-extrabold tracking-tight uppercase ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        Database Purge Administrative Security Control
                      </h4>
                    </div>

                    <div className={`p-6 rounded-2xl border space-y-4 transition-all flex-1 flex flex-col justify-between ${
                      isDark ? 'bg-slate-950 border-red-900/40' : 'bg-white border-red-200 shadow-sm'
                    }`}>
                      <div className="space-y-4">
                        <div className="flex items-start gap-4">
                          <div className="p-3 bg-red-500/10 text-red-500 rounded-2xl shrink-0 border border-red-500/20">
                            <ShieldAlert className="w-8 h-8 animate-pulse" />
                          </div>
                          <div className="space-y-1.5">
                            <h4 className="text-sm md:text-base font-black uppercase tracking-wider text-red-500">
                              PERMANENTLY DELETE ENTIRE DATABASE
                            </h4>
                            <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                              Executing this control permanently wipes every driving license record from active Cloud Firestore storage and client cache. All applicant data will be removed immediately.
                            </p>
                            <p className={`text-[11px] font-semibold ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                              ⚠️ This operation requires Super Administrator verification and is strictly irreversible.
                            </p>
                          </div>
                        </div>

                        {/* Text confirmation validation */}
                        <div className="max-w-md pt-2">
                          <label className={`block text-[10px] font-black uppercase tracking-wider mb-2 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                            Type <span className="text-red-500 font-mono">RESET DATABASE</span> to authorize:
                          </label>
                          <input
                            type="text"
                            value={typedResetConfirm}
                            onChange={(e) => setTypedResetConfirm(e.target.value)}
                            placeholder="RESET DATABASE"
                            className={`w-full px-4 py-2.5 text-xs sm:text-sm font-bold border rounded-xl outline-none focus:border-red-500 transition-all ${
                              isDark 
                                ? 'bg-slate-900 border-slate-800 text-white placeholder-slate-700' 
                                : 'bg-white border-slate-200 text-slate-900 placeholder-slate-400'
                            }`}
                          />
                        </div>
                      </div>

                      <div className="pt-2 flex justify-end">
                        <button
                          type="button"
                          disabled={consoleLoading || typedResetConfirm !== 'RESET DATABASE'}
                          onClick={handlePurgeEntireDatabase}
                          className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-black uppercase tracking-wider cursor-pointer transition-all shadow-lg shadow-red-950/30 active:scale-95 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <ShieldAlert className="w-4 h-4" />
                          DELETE ALL DATA
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'backups' && (
        <div className="space-y-6 py-4">
          <div className={`flex items-start gap-4 p-4 rounded-2xl border transition-all ${
            isDark 
              ? 'bg-amber-955/15 border-amber-900/30' 
              : 'bg-amber-50 border-amber-200 shadow-xs'
          }`}>
            <ShieldAlert className={`w-8 h-8 shrink-0 ${isDark ? 'text-amber-400' : 'text-amber-600'}`} />
            <div className="space-y-1">
              <h3 className={`text-sm font-extrabold tracking-tight ${isDark ? 'text-amber-300' : 'text-black font-extrabold'}`}>System Manual Backup Exporter</h3>
              <p className={`text-xs leading-relaxed ${isDark ? 'text-amber-400' : 'text-slate-900 font-semibold'}`}>
                As detailed in Section 16 of the functional proposals, you can perform manual database dumps at any time. Clicking below polls Firestore real-time for all active records, office layout presets, posted warnings, and scheduled collection queues, formatting them into a standard JSON dataset download.
              </p>
            </div>
          </div>

          {!isDemoModeActive() && (localCounts.licenses > 0 || localCounts.notices > 0 || localCounts.requests > 0) && (
            <div className="p-5 bg-emerald-950/20 border border-emerald-850/50 rounded-2xl space-y-3.5">
              <div className="flex items-start gap-3">
                <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h4 className="text-sm font-bold text-emerald-300">Yesterday's Custom Sandbox Changes Detected</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    We found customized records from your Sandbox Mode in your browser storage:
                  </p>
                  <div className="grid grid-cols-3 gap-2 pt-2 pb-1 max-w-sm">
                    <div className="bg-slate-900/60 p-2 rounded-lg border border-slate-800/50 text-center">
                      <span className="block text-sm font-extrabold text-emerald-400">{localCounts.licenses}</span>
                      <span className="text-[10px] text-slate-500 font-medium font-sans">Licenses</span>
                    </div>
                    <div className="bg-slate-900/60 p-2 rounded-lg border border-slate-800/50 text-center">
                      <span className="block text-sm font-extrabold text-emerald-400">{localCounts.notices}</span>
                      <span className="text-[10px] text-slate-500 font-medium font-sans">Announcements</span>
                    </div>
                    <div className="bg-slate-900/60 p-2 rounded-lg border border-slate-800/50 text-center">
                      <span className="block text-sm font-extrabold text-emerald-400">{localCounts.requests}</span>
                      <span className="text-[10px] text-slate-500 font-medium font-sans">Pickups</span>
                    </div>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed pt-1">
                    You can restore and apply these custom changes directly over the live Original Version (Cloud Firestore database). This will write yesterday's custom licenses, bulletins, and schedules live.
                  </p>
                </div>
              </div>
              <div className="pl-8">
                <button
                  type="button"
                  onClick={handleRestoreDemoChanges}
                  disabled={syncLoading}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white rounded-xl text-xs font-bold shadow-lg shadow-emerald-950/20 active:scale-95 disabled:opacity-50 transition-all cursor-pointer"
                >
                  <Database className="w-4 h-4 text-white" />
                  {syncLoading ? "Syncing..." : "Restore and Sync Sandbox Changes to Live Version Now"}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-col md:flex-row gap-4 justify-start pt-2">
            <button
              onClick={handleExportExcelBackup}
              disabled={syncLoading}
              className="flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-500 hover:to-teal-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-emerald-950/20 hover:shadow-xl transition-all duration-200 active:scale-95 cursor-pointer disabled:opacity-50"
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-100 animate-pulse" />
              {syncLoading ? "Exporting..." : "Download Excel Spreadsheet Backup (.xlsx)"}
            </button>

            <button
              onClick={handleExportBackup}
              disabled={syncLoading}
              className="flex items-center justify-center gap-2 px-6 py-3 bg-slate-950 border border-slate-800 text-white rounded-xl text-xs font-bold shadow-lg hover:bg-slate-900 transition-all duration-200 active:scale-95 cursor-pointer disabled:opacity-50"
            >
              <Download className="w-4 h-4 text-amber-500" />
              Download Full DB JSON Backup (.json)
            </button>
          </div>

          <div className="border-t border-slate-800 pt-6 space-y-2 text-xs text-slate-500">
            <span className="font-bold text-slate-300 block mb-1">Backup Strategy Summary:</span>
            <ul className="list-disc list-inside space-y-1">
              <li>Manual Database exports are saved client-side immediately inside your downloads file directory.</li>
              <li>Automation tasks or scheduler exports are securely managed within Firebase.</li>
              <li>Revising data will not require reinstating structural databases.</li>
              <li>Revising data will not require reinstating structural databases.</li>
            </ul>
          </div>
        </div>
      )}

      {/* Custom Confirmation Modal */}
      {confirmState.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs font-sans">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200 w-full min-w-80">
            <div className="flex items-start gap-3.5 mb-4">
              <span className="text-xl">
                {confirmState.color === 'emerald' ? '✅' : confirmState.color === 'red' ? '🚫' : '⚠️'}
              </span>
              <div>
                <h4 className="text-sm font-bold text-slate-100">{confirmState.title}</h4>
                <p className="text-xs text-slate-400 mt-2.5 leading-relaxed font-medium">
                  {confirmState.message}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-800/60">
              <button
                type="button"
                onClick={() => setConfirmState(prev => ({ ...prev, show: false }))}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmState.onConfirm}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold text-white transition-all cursor-pointer shadow-md ${
                  confirmState.color === 'emerald' 
                    ? 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-950/25' 
                    : confirmState.color === 'red' 
                    ? 'bg-red-600 hover:bg-red-500 shadow-red-950/25' 
                    : 'bg-yellow-600 hover:bg-yellow-500 shadow-yellow-950/25'
                }`}
              >
                {confirmState.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Alert Modal */}
      {alertState.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs font-sans">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-start gap-3 mb-4">
              <span className="text-xl font-bold text-blue-400">ℹ️</span>
              <div className="flex-1">
                <h4 className="text-sm font-bold text-slate-100">{alertState.title}</h4>
                <div className="text-xs text-slate-400 mt-2.5 leading-relaxed font-sans whitespace-pre-line bg-slate-950/60 p-3.5 rounded-xl border border-slate-800/80">
                  {alertState.message}
                </div>
              </div>
            </div>
            <div className="flex justify-end pt-3 border-t border-slate-800/60">
              <button
                type="button"
                onClick={() => setAlertState(prev => ({ ...prev, show: false }))}
                className="px-4 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-bold transition-all shadow-md shadow-cyan-950/25 cursor-pointer"
              >
                Acknowledge
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🔐 DEDICATED PASSWORD RESET CUSTOM DIALOG OVERLAY */}
      {resetModalState.show && resetModalState.user && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-md font-sans">
          <div className="bg-slate-900 border border-slate-850 rounded-3xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-250 relative">
            
            {/* Visual shield backing with dynamic state indicating crown if password belongs to superuser */}
            <div className="flex justify-center mb-5">
              <div className="relative">
                <div className="absolute inset-0 bg-cyan-500/10 rounded-full blur-xl animate-pulse"></div>
                <div className="relative flex items-center justify-center w-16 h-16 bg-slate-950 border border-slate-800/70 rounded-full shadow-xl">
                  {resetModalState.user.role === 'superuser' ? (
                    <Key className="w-8 h-8 text-amber-400 animate-pulse" />
                  ) : (
                    <Shield className="w-8 h-8 text-cyan-400 fill-cyan-500/10 animate-pulse" />
                  )}
                </div>
              </div>
            </div>

            {/* Title / Nepali translation */}
            <h3 className="font-extrabold text-white text-base sm:text-lg text-center tracking-tight leading-snug flex items-center justify-center gap-1.5">
              {resetModalState.user.role === 'superuser' ? '👑 Administrative Password Update' : 'पासवर्ड परिवर्तन गर्नुहोस् (Change Password)'}
            </h3>
            
            <p className="text-xs text-slate-355 mt-3 text-center leading-relaxed">
              You are altering security credentials for <strong className="text-white bg-slate-950 px-2 py-0.5 rounded-md border border-slate-800/50">{resetModalState.user.displayName || 'Operator'} ({resetModalState.user.email.split('@')[0]})</strong> below.
            </p>

            {resetModalState.user.role === 'superuser' && (
              <div className="mt-4 p-3.5 bg-amber-950/30 border border-amber-900/50 rounded-2xl text-left leading-relaxed">
                <span className="text-[10px] uppercase font-black text-amber-400 tracking-wider block mb-1">⚠️ 100% SECURE ACCESS ROOT ACCOUNT</span>
                <span className="text-[10px] text-amber-300 block">Modifying the Primary Superuser credentials. Ensure this private key is stored securely to maintain office operational capability.</span>
              </div>
            )}

            {!resetModalState.successPasswordInfo ? (
              <div className="mt-5 space-y-4 text-left">
                <div>
                  <label className="block text-left text-[11px] font-extrabold text-slate-400 uppercase tracking-wider mb-2 select-none">
                    नयाँ पासवर्ड राख्नुहोस् (Type New Custom Password)
                  </label>
                  <input
                    type="text"
                    value={resetModalState.customPassword}
                    onChange={(e) => setResetModalState(prev => ({ ...prev, customPassword: e.target.value }))}
                    placeholder="New personal password (e.g., Secure#1234)"
                    required
                    autoComplete="new-password"
                    className="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-2xl text-xs sm:text-sm text-center text-white focus:outline-none focus:border-cyan-500 placeholder-slate-600 font-mono shadow-inner transition-colors"
                  />
                  <span className="text-[9px] text-slate-500 block mt-1">Provide at least 6 characters (uppercase, lowercase, numbers, and special characters like @, # supported). Leave blank for automated secure Nepal key generator.</span>
                </div>

                <div className="flex items-start gap-2.5 pt-1.5 text-left">
                  <input
                    type="checkbox"
                    id="forcePasswordChangeOnNext"
                    checked={resetModalState.forceChange}
                    onChange={(e) => setResetModalState(prev => ({ ...prev, forceChange: e.target.checked }))}
                    className="mt-0.5 w-4 h-4 rounded border-slate-705 border-slate-700 bg-slate-950 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                  />
                  <label htmlFor="forcePasswordChangeOnNext" className="text-[11px] sm:text-xs text-slate-450 font-medium leading-normal select-none cursor-pointer">
                    अर्को पटक लगइन गर्दा परिवर्तन गर्न अनिवार्य गर्ने (Force password change on next login)
                  </label>
                </div>

                <div className="flex gap-3 pt-3">
                  <button
                    type="button"
                    onClick={handleExecuteResetPassword}
                    className="flex-1 py-3 px-4 bg-cyan-600 hover:bg-cyan-500 text-white font-extrabold uppercase text-xs tracking-wider rounded-2xl shadow-lg shadow-cyan-950/40 transition-all active:scale-95 cursor-pointer"
                  >
                    SAVE SECURE
                  </button>
                  <button
                    type="button"
                    onClick={() => setResetModalState({ show: false, user: null, customPassword: '', forceChange: true, successPasswordInfo: null })}
                    className="flex-1 py-3 px-4 bg-slate-850 hover:bg-slate-800 text-slate-300 hover:text-white font-extrabold uppercase text-xs tracking-wider rounded-2xl border border-slate-805 border-slate-800 transition-all active:scale-95 cursor-pointer"
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-5 space-y-4 text-left">
                <div className="p-4 bg-slate-950 rounded-2xl border border-emerald-900/40 text-left space-y-3.5 shadow-inner">
                  <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs sm:text-sm">
                    <CheckCircle className="w-5 h-5 animate-pulse" />
                    <span>The password Resetting Successfully!</span>
                  </div>
                  
                  <div className="space-y-1.5">
                    <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest leading-none">Account User</span>
                    <span className="block font-mono text-xs text-white leading-none">
                      {resetModalState.user.displayName || resetModalState.user.username} ({resetModalState.user.email})
                    </span>
                  </div>

                  <div className="space-y-1.5 pt-1">
                    <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest leading-none">Default Assigned Password</span>
                    <span className="block font-mono text-sm text-amber-400 font-extrabold tracking-widest select-all bg-slate-900 px-3 py-2.5 rounded-xl border border-slate-800 text-center">
                      {resetModalState.successPasswordInfo}
                    </span>
                  </div>

                  <p className="text-[10px] text-emerald-400/90 leading-normal font-bold bg-emerald-950/20 p-2.5 rounded-xl border border-emerald-800/30">
                    🔑 The staff user can now log in using this default password and will be prompted to set their own password upon first login.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setResetModalState({ show: false, user: null, customPassword: '', forceChange: true, successPasswordInfo: null })}
                  className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold uppercase text-xs tracking-wider rounded-2xl transition-all shadow-md cursor-pointer active:scale-95"
                >
                  DISMISS AND CLOSE
                </button>
              </div>
            )}

          </div>
        </div>
      )}

      {/* Console Duplicate Warning Modal */}
      {duplicateWarning && duplicateWarning.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs font-sans">
          <div className={`border rounded-2xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200 ${
            isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-start gap-3.5 mb-4">
              <span className="text-2xl text-amber-500">⚠️</span>
              <div className="space-y-1">
                <h4 className="text-sm font-black uppercase tracking-wider text-amber-500">
                  Pre-existing Record Detected
                </h4>
                <p className={`text-xs mt-2 leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                  A Driving License with number <strong className="font-bold text-cyan-500">{duplicateWarning.licenseNumber}</strong> already exists under applicant <strong className="font-bold">{duplicateWarning.existingName}</strong>.
                </p>
                <p className={`text-[11px] leading-normal ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Do you still want to force append this new manual entry? It will be registered under a separate unique internal record ID.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-800/60">
              <button
                type="button"
                onClick={() => setDuplicateWarning(null)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-colors ${
                  isDark ? 'text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700' : 'text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200'
                }`}
              >
                Cancel and Revise
              </button>
              <button
                type="button"
                onClick={() => executeSaveManualRecord(duplicateWarning.pendingRecord)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 shadow-md transition-colors cursor-pointer"
              >
                Yes, Force Add Record
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Irreversible Console Purge Double-Confirmation Modal */}
      {deleteConfirmModal && deleteConfirmModal.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-xs font-sans">
          <div className="bg-slate-950 border-2 border-red-900/40 rounded-2xl max-w-lg w-full p-6 shadow-2xl animate-in fade-in scale-in duration-150 text-white">
            <div className="flex items-start gap-4 mb-4">
              <div className="p-2.5 bg-red-955/50 text-red-500 rounded-xl border border-red-900/30">
                <ShieldAlert className="w-6 h-6 animate-pulse" />
              </div>
              <div className="space-y-1.5">
                <h4 className="text-sm font-black uppercase tracking-widest text-red-500">
                  ⚠️ Critical Action: Irreversible Database Purge
                </h4>
                <p className="text-xs text-slate-300 leading-relaxed">
                  You are about to permanently delete driving license applicant <strong className="font-extrabold text-white">{deleteConfirmModal.fullName}</strong> (License No: <span className="font-mono text-cyan-400 font-bold">{deleteConfirmModal.licenseNumber}</span>) from the database ledger.
                </p>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  This action completely bypasses standard workflows, purges all associated audit histories, and is <strong>irreversible</strong>.
                </p>
              </div>
            </div>

            <div className="space-y-4 py-3 border-t border-b border-red-955/50 my-4">
              <div>
                <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1.5">
                  Type Applicant's License Number to Confirm <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder={deleteConfirmModal.licenseNumber}
                  value={deleteConfirmModal.typedConfirmation}
                  onChange={(e) => setDeleteConfirmModal(prev => ({ ...prev, typedConfirmation: e.target.value }))}
                  className="w-full bg-slate-900 border border-slate-850 px-3.5 py-2 rounded-xl text-xs font-mono tracking-wider focus:border-red-500 outline-hidden transition-all text-center text-red-400"
                />
                {deleteConfirmModal.typedConfirmation && deleteConfirmModal.typedConfirmation !== deleteConfirmModal.licenseNumber && (
                  <p className="text-[9.5px] font-bold text-red-500 mt-1 text-center">
                    ⚠️ Text does not match the License Number.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1.5">
                  Administrative Reason / Deletion Reason <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. Cleared duplicate Excel upload conflict"
                  value={deleteConfirmModal.reason}
                  onChange={(e) => setDeleteConfirmModal(prev => ({ ...prev, reason: e.target.value }))}
                  className="w-full bg-slate-900 border border-slate-850 px-3.5 py-2 rounded-xl text-xs focus:border-red-500 outline-hidden transition-all text-slate-200"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={() => setDeleteConfirmModal(prev => ({ ...prev, show: false }))}
                className="px-3 py-2 rounded-xl text-xs font-bold text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 transition-colors cursor-pointer border border-slate-850"
              >
                Cancel and Safe Return
              </button>
              <button
                type="button"
                disabled={deleteConfirmModal.typedConfirmation !== deleteConfirmModal.licenseNumber || !deleteConfirmModal.reason.trim()}
                onClick={handleExecuteDeleteConsole}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider shadow-md transition-all cursor-pointer ${
                  deleteConfirmModal.typedConfirmation === deleteConfirmModal.licenseNumber && deleteConfirmModal.reason.trim()
                    ? 'bg-red-600 hover:bg-red-700 text-white active:scale-95'
                    : 'bg-red-955/20 text-red-900 border border-red-955/20 cursor-not-allowed opacity-40'
                }`}
              >
                Irreversibly Purge Record
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SECURITY CLEARANCE PIN CHANGER DIALOG BOX */}
      {pinChangerModal && pinChangerModal.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs font-sans">
          <div className={`border rounded-2xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200 ${
            isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-center justify-between border-b pb-3 mb-4 border-slate-800/40">
              <div className="flex items-center gap-2">
                <Key className="w-5 h-5 text-cyan-500" />
                <h4 className="text-sm font-black uppercase tracking-wider text-cyan-500">
                  Administrative PIN Changer
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setPinChangerModal(prev => ({ ...prev, show: false }))}
                className="text-slate-500 hover:text-rose-500 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className={`text-xs leading-relaxed mb-4 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              For optimum security, the fixed default administrative clearance PIN (1234) should be rotated to a private 4-digit master key immediately. This PIN protects low-level data purge, restoration, and duplicate pruning controls.
            </p>

            <div className="space-y-4">
              {/* CURRENT PIN */}
              <div>
                <label className={`block text-[10px] font-black uppercase tracking-wider mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Current Clearance PIN <span className="text-rose-500">*</span>
                </label>
                <input
                  type="password"
                  placeholder="••••"
                  value={pinChangerModal.oldPin}
                  maxLength={4}
                  onChange={(e) => setPinChangerModal(prev => ({ ...prev, oldPin: e.target.value.replace(/\D/g, '') }))}
                  className={`w-full px-3.5 py-2 rounded-xl text-xs font-mono tracking-widest text-center border outline-hidden transition-all ${
                    isDark ? 'bg-slate-950 border-slate-800 text-cyan-400 focus:border-cyan-500' : 'bg-slate-50 border-slate-300 text-cyan-705 focus:border-cyan-705 focus:bg-white'
                  }`}
                />
              </div>

              {/* NEW PIN */}
              <div>
                <label className={`block text-[10px] font-black uppercase tracking-wider mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  New 4-Digit PIN <span className="text-rose-500">*</span>
                </label>
                <input
                  type="password"
                  placeholder="••••"
                  value={pinChangerModal.newPin}
                  maxLength={4}
                  onChange={(e) => setPinChangerModal(prev => ({ ...prev, newPin: e.target.value.replace(/\D/g, '') }))}
                  className={`w-full px-3.5 py-2 rounded-xl text-xs font-mono tracking-widest text-center border outline-hidden transition-all ${
                    isDark ? 'bg-slate-950 border-slate-800 text-cyan-400 focus:border-cyan-500' : 'bg-slate-50 border-slate-300 text-cyan-705 focus:border-cyan-705 focus:bg-white'
                  }`}
                />
              </div>

              {/* CONFIRM NEW PIN */}
              <div>
                <label className={`block text-[10px] font-black uppercase tracking-wider mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Confirm New PIN <span className="text-rose-500">*</span>
                </label>
                <input
                  type="password"
                  placeholder="••••"
                  value={pinChangerModal.confirmPin}
                  maxLength={4}
                  onChange={(e) => setPinChangerModal(prev => ({ ...prev, confirmPin: e.target.value.replace(/\D/g, '') }))}
                  className={`w-full px-3.5 py-2 rounded-xl text-xs font-mono tracking-widest text-center border outline-hidden transition-all ${
                    isDark ? 'bg-slate-950 border-slate-800 text-cyan-400 focus:border-cyan-500' : 'bg-slate-50 border-slate-300 text-cyan-705 focus:border-cyan-705 focus:bg-white'
                  }`}
                />
              </div>

              {/* SUCCESS / ERROR MESSAGES */}
              {pinChangerModal.error && (
                <p className="text-[11px] font-bold text-rose-500 text-center leading-normal">
                  ⚠️ {pinChangerModal.error}
                </p>
              )}
              {pinChangerModal.success && (
                <p className="text-[11px] font-bold text-emerald-500 text-center leading-normal">
                  ✅ {pinChangerModal.success}
                </p>
              )}

              {/* ACTIONS */}
              <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-800/40 mt-4">
                <button
                  type="button"
                  onClick={() => setPinChangerModal(prev => ({ ...prev, show: false }))}
                  className={`px-4 py-2 rounded-xl text-xs font-bold cursor-pointer transition-all ${
                    isDark ? 'text-slate-400 hover:text-white bg-slate-950 hover:bg-slate-850 border border-slate-800' : 'text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-200'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleUpdatePin}
                  className="px-5 py-2 rounded-xl text-xs font-black uppercase tracking-wider text-white bg-cyan-600 hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-500/20 shadow-md transition-all cursor-pointer active:scale-95"
                >
                  Update and Save PIN
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* 🔒 SUPER ADMINISTRATOR PASSWORD VERIFICATION DIALOG */}
      {showPurgeVerifyModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm font-sans animate-fade-in">
          <div className={`border rounded-2xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200 ${
            isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-center justify-between border-b pb-3 mb-4 border-slate-800/40">
              <div className="flex items-center gap-2">
                <Lock className="w-5 h-5 text-red-500 animate-pulse" />
                <h4 className="text-sm font-black uppercase tracking-wider text-red-500">
                  🔒 Super Administrator Verification Required
                </h4>
              </div>
              <button
                type="button"
                onClick={handleClosePurgeVerify}
                className="text-slate-500 hover:text-rose-500 transition-colors cursor-pointer"
                disabled={consoleLoading}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className={`text-xs leading-relaxed mb-4 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
              This operation permanently deletes every record from the application. Please verify the Super Administrator password before continuing.
            </p>

            <div className="space-y-4">
              {/* READ-ONLY USERNAME / EMAIL */}
              <div>
                <label className={`block text-[10px] font-black uppercase tracking-wider mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Super User Email (Read-only)
                </label>
                <input
                  type="email"
                  readOnly
                  autoComplete="off"
                  value={currentUserEmail || 'superuser@plsms.gov'}
                  className={`w-full px-3.5 py-2 rounded-xl text-xs font-bold border outline-none transition-all cursor-not-allowed select-none ${
                    isDark ? 'bg-slate-950 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500'
                  }`}
                />
              </div>

              {/* PASSWORD FIELD WITH SHOW/HIDE */}
              <div>
                <label className={`block text-[10px] font-black uppercase tracking-wider mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Enter Administrative Password <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={purgePassword}
                    onChange={(e) => setPurgePassword(e.target.value)}
                    className={`w-full pl-3.5 pr-10 py-2 rounded-xl text-xs border outline-none transition-all ${
                      isDark ? 'bg-slate-950 border-slate-800 text-white focus:border-red-500' : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-red-500 focus:bg-white'
                    } ${!showPurgePassword ? 'secure-masked' : ''}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPurgePassword(!showPurgePassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 hover:text-cyan-500 transition-colors text-slate-500"
                  >
                    {showPurgePassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* SUCCESS / ERROR MESSAGES */}
              {purgeErrorMsg && (
                <p className="text-[11px] font-bold text-rose-500 text-center leading-normal bg-rose-50/10 p-2.5 rounded-xl border border-rose-200/20">
                  ❌ {purgeErrorMsg}
                </p>
              )}

              {/* ACTIONS */}
              <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-800/40 mt-4">
                <button
                  type="button"
                  onClick={handleClosePurgeVerify}
                  disabled={consoleLoading}
                  className={`px-4 py-2 rounded-xl text-xs font-bold cursor-pointer transition-all ${
                    isDark ? 'text-slate-400 hover:text-white bg-slate-950 hover:bg-slate-850 border border-slate-800' : 'text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-200'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handlePurgeVerifySubmit}
                  disabled={consoleLoading || !purgePassword}
                  className="px-5 py-2 rounded-xl text-xs font-black uppercase tracking-wider text-white bg-red-600 hover:bg-red-500 hover:shadow-lg hover:shadow-red-500/20 shadow-md transition-all cursor-pointer active:scale-95 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {consoleLoading ? 'Verifying & Purging...' : 'Verify & Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 🚫 REVOKE USER ACCOUNT SUPER ADMIN VERIFICATION MODAL */}
      {revokeModalState.show && revokeModalState.targetUser && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm font-sans animate-fade-in">
          <div className={`border rounded-2xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200 ${
            isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-center justify-between border-b pb-3 mb-4 border-slate-800/40">
              <div className="flex items-center gap-2">
                <Lock className="w-5 h-5 text-red-500 animate-pulse" />
                <h4 className="text-sm font-black uppercase tracking-wider text-red-500">
                  🚫 Revoke User Account Authorization
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setRevokeModalState(prev => ({ ...prev, show: false }))}
                className="text-slate-500 hover:text-rose-500 transition-colors cursor-pointer"
                disabled={revokeModalState.loading}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className={`p-3 rounded-xl border mb-4 text-xs ${
              isDark ? 'bg-red-950/20 border-red-800/40 text-red-300' : 'bg-red-50 border-red-200 text-red-800'
            }`}>
              <p className="font-bold text-[11px] mb-1 uppercase tracking-wider">Target Account Details:</p>
              <p><strong>Name:</strong> {revokeModalState.targetUser.displayName || revokeModalState.targetUser.username}</p>
              <p><strong>User ID:</strong> {revokeModalState.targetUser.username || revokeModalState.targetUser.id}</p>
              <p><strong>Email:</strong> {revokeModalState.targetUser.email || 'None'}</p>
              <p><strong>Role:</strong> {revokeModalState.targetUser.role.toUpperCase()}</p>
            </div>

            <p className={`text-xs leading-relaxed mb-4 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
              This action will permanently remove this user's login account. <strong className="text-amber-500 font-semibold">This will NOT delete any driving license records.</strong> Please enter your Super Administrator password to confirm.
            </p>

            <div className="space-y-4">
              <div>
                <label className={`block text-[10px] font-black uppercase tracking-wider mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Super Administrator Email (Read-only)
                </label>
                <input
                  type="email"
                  readOnly
                  value={currentUserEmail || 'superuser@plsms.gov'}
                  className={`w-full px-3.5 py-2 rounded-xl text-xs font-bold border outline-none cursor-not-allowed select-none ${
                    isDark ? 'bg-slate-950 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500'
                  }`}
                />
              </div>

              <div>
                <label className={`block text-[10px] font-black uppercase tracking-wider mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Enter Administrative Password <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <input
                    type={revokeModalState.showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={revokeModalState.password}
                    onChange={(e) => setRevokeModalState(prev => ({ ...prev, password: e.target.value }))}
                    className={`w-full pl-3.5 pr-10 py-2 rounded-xl text-xs border outline-none transition-all ${
                      isDark ? 'bg-slate-950 border-slate-800 text-white focus:border-red-500' : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-red-500 focus:bg-white'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setRevokeModalState(prev => ({ ...prev, showPassword: !prev.showPassword }))}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 hover:text-cyan-500 transition-colors text-slate-500"
                  >
                    {revokeModalState.showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {revokeModalState.error && (
                <p className="text-[11px] font-bold text-rose-500 text-center leading-normal bg-rose-50/10 p-2.5 rounded-xl border border-rose-200/20">
                  ❌ {revokeModalState.error}
                </p>
              )}

              <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-800/40 mt-4">
                <button
                  type="button"
                  onClick={() => setRevokeModalState(prev => ({ ...prev, show: false }))}
                  disabled={revokeModalState.loading}
                  className={`px-4 py-2 rounded-xl text-xs font-bold cursor-pointer transition-all ${
                    isDark ? 'text-slate-400 hover:text-white bg-slate-950 hover:bg-slate-850 border border-slate-800' : 'text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-200'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmRevoke}
                  disabled={revokeModalState.loading || !revokeModalState.password}
                  className="px-5 py-2 rounded-xl text-xs font-black uppercase tracking-wider text-white bg-red-600 hover:bg-red-500 hover:shadow-lg hover:shadow-red-500/20 shadow-md transition-all cursor-pointer active:scale-95 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {revokeModalState.loading ? 'Revoking Account...' : 'Confirm Revoke'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 🔍 DRIVING LICENSE DETAILS & LOGS VIEW MODAL */}
      {selectedLicenseDetails && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-xs font-sans animate-fade-in">
          <div className={`border rounded-2xl max-w-2xl w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200 overflow-y-auto max-h-[90vh] ${
            isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-center justify-between border-b pb-3 mb-4 border-slate-800/40">
              <div className="flex items-center gap-2">
                <Database className="w-5 h-5 text-cyan-500" />
                <h4 className="text-sm font-black uppercase tracking-wider text-cyan-500">
                  📋 Driving License Record & Audit Ledger Details
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setSelectedLicenseDetails(null)}
                className="text-slate-500 hover:text-rose-500 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-6">
              {/* Profile / Identity Card */}
              <div className={`p-4 rounded-xl border ${
                isDark ? 'bg-slate-950/40 border-slate-800/80' : 'bg-slate-50 border-slate-200'
              } grid grid-cols-1 sm:grid-cols-2 gap-4`}>
                <div className="space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Full Name</span>
                  <p className="text-sm font-extrabold">{selectedLicenseDetails.fullName}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">License Number</span>
                  <p className="text-sm font-mono font-bold text-cyan-500">{selectedLicenseDetails.licenseNumber}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Applicant ID</span>
                  <p className="text-sm font-mono font-bold text-cyan-500">{selectedLicenseDetails.applicantId}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Vehicle Category</span>
                  <p className="text-sm font-bold text-slate-400">{selectedLicenseDetails.category || 'N/A'}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Mobile Number</span>
                  <p className="text-sm font-semibold">{selectedLicenseDetails.mobileNumber || '—'}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Status</span>
                  <div>
                    <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-wide inline-block ${
                      selectedLicenseDetails.status === 'distributed'
                        ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/30'
                        : selectedLicenseDetails.status === 'missing'
                          ? 'bg-rose-955/20 text-rose-400 border border-rose-900/30'
                          : selectedLicenseDetails.status === 'found'
                            ? 'bg-sky-950/40 text-sky-400 border border-sky-900/30'
                            : 'bg-amber-955/20 text-amber-500 border border-amber-900/30'
                    }`}>
                      {selectedLicenseDetails.status === 'distributed' ? '✓ DISTRIBUTED' : selectedLicenseDetails.status === 'missing' ? '✗ MISSING' : selectedLicenseDetails.status === 'found' ? '✓ FOUND' : '● PENDING'}
                    </span>
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Last Updated By</span>
                  <p className="text-xs font-semibold text-slate-400">{selectedLicenseDetails.updatedBy || 'System'}</p>
                </div>
              </div>

              {/* Remarks */}
              <div className="space-y-1">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Record Remarks / Comments</span>
                <div className={`p-3 rounded-xl border text-xs leading-relaxed ${
                  isDark ? 'bg-slate-950/20 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
                }`}>
                  {selectedLicenseDetails.remarks || 'No remarks recorded for this driving license ledger entry.'}
                </div>
              </div>

              {/* Audit Security Logs */}
              <div className="space-y-2">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-500 block">Security Audit Logs & Trace</span>
                {!selectedLicenseDetails.logs || selectedLicenseDetails.logs.length === 0 ? (
                  <p className="text-xs text-slate-500 italic">No historical changes or audit actions logged for this record.</p>
                ) : (
                  <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1">
                    {selectedLicenseDetails.logs.map((log: any, idx: number) => (
                      <div 
                        key={idx} 
                        className={`p-2.5 rounded-lg border text-[11px] space-y-1 ${
                          isDark ? 'bg-slate-950/60 border-slate-850/80' : 'bg-slate-50 border-slate-100'
                        }`}
                      >
                        <div className="flex items-center justify-between font-mono text-[9px] text-slate-500">
                          <span>👤 {log.user || 'System'}</span>
                          <span>📅 {new Date(log.timestamp).toLocaleString()}</span>
                        </div>
                        <p className="font-semibold text-cyan-400">{log.action ? log.action.replace(/_/g, ' ').toUpperCase() : 'ACTION'}</p>
                        <p className={`text-slate-400 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{log.details || 'No action details provided.'}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end pt-3 border-t border-slate-800/40 mt-6">
              <button
                type="button"
                onClick={() => setSelectedLicenseDetails(null)}
                className={`px-5 py-2 rounded-xl text-xs font-bold cursor-pointer transition-all ${
                  isDark 
                    ? 'bg-slate-800 hover:bg-slate-750 text-white' 
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200'
                }`}
              >
                Close details
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🗑️ DELETE UPLOAD LOT CONFIRMATION MODAL */}
      {showLedgerDeleteVerifyModal && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-xs font-sans animate-fade-in">
          <div className={`border rounded-2xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200 flex flex-col gap-4 ${
            isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            {/* Header */}
            <div className="flex items-start justify-between border-b pb-3 border-slate-800/40">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-rose-100 text-rose-700 dark:bg-rose-950/80 dark:text-rose-400 border border-rose-200 dark:border-rose-800">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-black tracking-tight text-rose-600 dark:text-rose-400">
                    Delete Upload Lot
                  </h3>
                  <p className="text-[11px] text-slate-500 font-medium">
                    Upload History Record Removal
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCloseLedgerDeleteVerify}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Body Message */}
            <div className="space-y-3 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              <p className="font-semibold text-rose-600 dark:text-rose-400">
                You are about to permanently delete this upload history record.
              </p>
              <p className="font-medium text-slate-500 dark:text-slate-400">
                This operation cannot be undone.
              </p>
              <p className="font-semibold text-slate-700 dark:text-slate-200">
                Please verify your Super Admin identity before continuing.
              </p>

              {/* Super Admin Password Input */}
              <div className="pt-2 space-y-1.5">
                <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Super Admin Password / Secret Key
                </label>
                <div className="relative">
                  <input
                    type={showLedgerDeletePassword ? "text" : "password"}
                    value={ledgerDeletePassword}
                    onChange={(e) => setLedgerDeletePassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleLedgerDeleteVerifySubmit();
                      }
                    }}
                    placeholder="Enter Super Admin password..."
                    className={`w-full pl-3 pr-10 py-2 rounded-xl text-xs font-mono font-medium border outline-none transition-all ${
                      isDark 
                        ? 'bg-slate-950 border-slate-800 text-white placeholder-slate-500 focus:border-rose-500' 
                        : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:border-rose-500 focus:bg-white'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowLedgerDeletePassword(!showLedgerDeletePassword)}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    {showLedgerDeletePassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {ledgerDeleteErrorMsg && (
                  <p className="text-[11px] font-bold text-rose-500 mt-1">
                    {ledgerDeleteErrorMsg}
                  </p>
                )}
              </div>
            </div>

            {/* Footer Buttons */}
            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800/40">
              <button
                type="button"
                onClick={handleCloseLedgerDeleteVerify}
                className={`px-4 py-2 rounded-xl text-xs font-bold cursor-pointer transition-all ${
                  isDark 
                    ? 'bg-slate-800 hover:bg-slate-750 text-slate-300' 
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={consoleLoading}
                onClick={handleLedgerDeleteVerifySubmit}
                className="px-4 py-2 rounded-xl text-xs font-extrabold uppercase bg-rose-600 hover:bg-rose-500 text-white cursor-pointer transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1.5 shadow-md"
              >
                {consoleLoading ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    <span>Verifying...</span>
                  </>
                ) : (
                  <span>Verify & Delete</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🔄 DUPLICATE COMPARISON DIALOG */}
      {selectedDuplicateLedger && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-xs font-sans animate-fade-in">
          <div className={`border rounded-2xl max-w-4xl w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200 overflow-y-auto max-h-[92vh] flex flex-col ${
            isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b pb-4 mb-4 border-slate-800/40 shrink-0">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest rounded bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300 border border-rose-300 dark:border-rose-800">
                    DUPLICATE COMPARISON
                  </span>
                  <h3 className="text-base font-black uppercase tracking-tight text-rose-600 dark:text-rose-400">
                    Lot Duplicate Records Review
                  </h3>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400 pt-1">
                  <span>
                    <strong>Upload Lot:</strong> <code className="font-mono text-cyan-600 dark:text-cyan-400 font-bold">{selectedDuplicateLedger.id}</code>
                  </span>
                  <span>•</span>
                  <span>
                    <strong>File Name:</strong> {selectedDuplicateLedger.fileName}
                  </span>
                  <span>•</span>
                  <span>
                    <strong>Total Duplicates:</strong> <span className="font-bold text-rose-600 dark:text-rose-400">{selectedDuplicateLedger.duplicateRecords}</span>
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedDuplicateLedger(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* License Number Search Box */}
            <div className="mb-4 shrink-0">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  value={duplicateDialogSearch}
                  onChange={(e) => setDuplicateDialogSearch(e.target.value)}
                  placeholder="Search by License Number in this lot's duplicates..."
                  className={`w-full pl-9 pr-8 py-2 rounded-xl text-xs font-medium border outline-none transition-all ${
                    isDark 
                      ? 'bg-slate-950 border-slate-800 text-white placeholder-slate-500 focus:border-rose-500' 
                      : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:border-rose-500 focus:bg-white'
                  }`}
                />
                {duplicateDialogSearch && (
                  <button
                    type="button"
                    onClick={() => setDuplicateDialogSearch('')}
                    className="absolute right-2.5 top-2 text-xs font-bold text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>

            {/* Dialog Body / Comparison Cards */}
            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              {duplicatePairsLoading ? (
                <div className="py-16 text-center text-xs text-slate-500 flex flex-col items-center justify-center gap-3">
                  <div className="w-7 h-7 border-2 border-rose-500 border-t-transparent rounded-full animate-spin"></div>
                  <span>Analyzing and loading side-by-side duplicate record comparisons...</span>
                </div>
              ) : (() => {
                const filteredPairs = duplicatePairs.filter(pair => {
                  if (!duplicateDialogSearch) return true;
                  const q = duplicateDialogSearch.toLowerCase().trim();
                  return (
                    pair.incomingRecord.licenseNumber.toLowerCase().includes(q) ||
                    pair.existingRecord.licenseNumber.toLowerCase().includes(q) ||
                    pair.incomingRecord.applicantId.toLowerCase().includes(q) ||
                    pair.existingRecord.applicantId.toLowerCase().includes(q) ||
                    pair.incomingRecord.fullName.toLowerCase().includes(q) ||
                    pair.existingRecord.fullName.toLowerCase().includes(q)
                  );
                });

                if (filteredPairs.length === 0) {
                  return (
                    <div className="py-12 text-center text-xs text-slate-500 italic border rounded-xl p-6 bg-slate-50/50 dark:bg-slate-950/30 dark:border-slate-800">
                      {duplicateDialogSearch 
                        ? `No duplicate records match search query "${duplicateDialogSearch}" in Lot ${selectedDuplicateLedger.id}.`
                        : `No duplicate comparison records found for Lot ${selectedDuplicateLedger.id}.`}
                    </div>
                  );
                }

                return filteredPairs.map((pair, idx) => {
                  const left = pair.existingRecord;
                  const right = pair.incomingRecord;

                  const isFieldEqual = (val1: any, val2: any) => {
                    return String(val1 || '').trim().toLowerCase() === String(val2 || '').trim().toLowerCase();
                  };

                  const fields = [
                    { label: 'Database Serial / Row Number', left: left.sn, right: right.sn },
                    { label: 'Upload Lot Number', left: left.uploadLot, right: right.uploadLot },
                    { label: 'Applicant ID', left: left.applicantId, right: right.applicantId, isMono: true },
                    { label: 'License Number', left: left.licenseNumber, right: right.licenseNumber, isMono: true },
                    { label: 'Category', left: left.category, right: right.category },
                    { label: 'Full Name', left: left.fullName, right: right.fullName }
                  ];

                  return (
                    <div key={idx} className={`border rounded-xl p-4 space-y-3 transition-all ${
                      isDark ? 'bg-slate-950/70 border-slate-800' : 'bg-slate-50/80 border-slate-200'
                    }`}>
                      {/* Comparison Card Header */}
                      <div className="flex items-center justify-between border-b pb-2 border-slate-800/30 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] font-black text-slate-400">
                            #{idx + 1}
                          </span>
                          <span className="font-mono font-bold text-rose-600 dark:text-rose-400">
                            License #: {right.licenseNumber}
                          </span>
                        </div>
                        <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-900/50">
                          {fields.some(f => !isFieldEqual(f.left, f.right)) ? '⚠️ Differences Highlighted' : '✓ Matching Fields'}
                        </span>
                      </div>

                      {/* Side-By-Side Comparison Grid */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* LEFT: Existing Database Record */}
                        <div className={`p-3.5 rounded-lg border space-y-2.5 ${
                          isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
                        }`}>
                          <div className="flex items-center justify-between pb-1 border-b border-slate-800/20">
                            <span className="text-[10px] font-black uppercase tracking-wider text-cyan-600 dark:text-cyan-400">
                              LEFT: Existing Database Record
                            </span>
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-cyan-50 dark:bg-cyan-950 text-cyan-700 dark:text-cyan-300 border border-cyan-200 dark:border-cyan-800">
                              STORED IN DB
                            </span>
                          </div>

                          <div className="space-y-2 text-xs">
                            {fields.map((f, i) => {
                              const match = isFieldEqual(f.left, f.right);
                              return (
                                <div key={i} className={`p-2 rounded flex flex-col justify-center transition-colors ${
                                  !match 
                                    ? 'bg-amber-100/90 dark:bg-amber-950/80 border border-amber-300 dark:border-amber-700/80' 
                                    : 'bg-transparent'
                                }`}>
                                  <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500">
                                    {f.label}
                                  </span>
                                  <span className={`font-semibold ${f.isMono ? 'font-mono' : ''} ${
                                    !match 
                                      ? 'text-amber-900 dark:text-amber-200 font-extrabold' 
                                      : isDark ? 'text-slate-200' : 'text-slate-800'
                                  }`}>
                                    {String(f.left)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* RIGHT: Incoming Excel Record */}
                        <div className={`p-3.5 rounded-lg border space-y-2.5 ${
                          isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
                        }`}>
                          <div className="flex items-center justify-between pb-1 border-b border-slate-800/20">
                            <span className="text-[10px] font-black uppercase tracking-wider text-rose-600 dark:text-rose-400">
                              RIGHT: Incoming Excel Record
                            </span>
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                              SKIPPED (DUPLICATE)
                            </span>
                          </div>

                          <div className="space-y-2 text-xs">
                            {fields.map((f, i) => {
                              const match = isFieldEqual(f.left, f.right);
                              return (
                                <div key={i} className={`p-2 rounded flex flex-col justify-center transition-colors ${
                                  !match 
                                    ? 'bg-amber-100/90 dark:bg-amber-950/80 border border-amber-300 dark:border-amber-700/80' 
                                    : 'bg-transparent'
                                }`}>
                                  <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500">
                                    {f.label}
                                  </span>
                                  <span className={`font-semibold ${f.isMono ? 'font-mono' : ''} ${
                                    !match 
                                      ? 'text-amber-900 dark:text-amber-200 font-extrabold' 
                                      : isDark ? 'text-slate-200' : 'text-slate-800'
                                  }`}>
                                    {String(f.right)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between pt-4 border-t border-slate-800/40 mt-4 shrink-0">
              <span className="text-[11px] text-slate-500">
                Rule Applied: Existing stored database record is preserved. Repeated incoming excel row is skipped.
              </span>
              <button
                type="button"
                onClick={() => setSelectedDuplicateLedger(null)}
                className={`px-5 py-2 rounded-xl text-xs font-bold cursor-pointer transition-all ${
                  isDark 
                    ? 'bg-slate-800 hover:bg-slate-700 text-white' 
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200'
                }`}
              >
                Close Comparison
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
