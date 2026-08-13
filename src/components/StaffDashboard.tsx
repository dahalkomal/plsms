import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { utils, write } from 'xlsx';
import { auth } from '../firebase';
import { 
  getAllCollectionRequests, 
  getAllUploadLedgers,
  getAllLicenses,
  getSearchesServedCount, 
  getLicenseById, 
  createOrUpdateLicense,
  deleteLicense,
  getAllUserRoles,
  resolveStaffName,
  getOfficeSettings,
  getDashboardKpiCounts,
  getPaginatedLicenses,
  isLicenseDistributed,
  fetchIntegratedReportData
} from '../dbService';
import { registryDataStore } from '../registryDataStore';
import { License, LicenseStatus, LicenseLog, CollectionRequest, UploadLedger } from '../types';
import { Search, Plus, Filter, FileText, Check, AlertCircle, Bookmark, Archive, UserCheck, ShieldAlert, History, ArrowDown, Download, Eye, FileDown, Lock, FileSpreadsheet, Trash2, X, Loader2 } from 'lucide-react';
import LicenseHistory from './LicenseHistory';
import NepaliDatePicker from './NepaliDatePicker';
import { convertADToBS } from '../utils/dateConverter';
import SmartCardDashboard from './SmartCardDashboard';
import { HistoryAutocompleteField } from './HistoryAutocompleteField';
import { HistorySuggestionService } from '../utils/HistorySuggestionService';
import { isLicenseMatch, nepaliToEnglishDigits } from '../utils/licenseNormalizer';
import { exportReportToExcel, exportReportToPdf, exportReportToCsv, exportIntegratedReportToExcel } from '../utils/reportExportEngine';

interface StaffDashboardProps {
  userRole?: string;
  userEmail?: string;
  theme?: string;
  viewMode?: 'dashboard' | 'reports';
}

const resolveOperatorName = (email: string, usersRoles?: any[]): string => {
  return resolveStaffName(email, usersRoles || []);
};

const formatDate = (isoString?: string): string => {
  if (!isoString) return '---';
  return convertADToBS(isoString);
};

const nepaliYears = [2077, 2078, 2079, 2080, 2081, 2082, 2083, 2084, 2085, 2086, 2087];
const nepaliMonths = [
  { value: 1, label: "Baishakh (वैशाख)" },
  { value: 2, label: "Jestha (जेठ)" },
  { value: 3, label: "Ashadh (असार)" },
  { value: 4, label: "Shrawan (साउन)" },
  { value: 5, label: "Bhadra (भदौ)" },
  { value: 6, label: "Ashwin (असोज)" },
  { value: 7, label: "Kartik (कात्तिक)" },
  { value: 8, label: "Mangsir (मंसिर)" },
  { value: 9, label: "Poush (पुस)" },
  { value: 10, label: "Magh (माघ)" },
  { value: 11, label: "Falgun (फागुन)" },
  { value: 12, label: "Chaitra (चैत)" }
];

const getBSMonthDays = (year: number, month: number): number => {
  const yearConfigs: Record<number, number[]> = {
    2077: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2078: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2079: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2080: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2081: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2082: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2083: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2084: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2085: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2086: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 29, 30],
    2087: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 30]
  };
  return yearConfigs[year]?.[month - 1] || 30;
};

const getSubmittedDocsText = (lic: any) => {
  const docs = lic?.submittedDocs || lic?.submittedDocuments;
  const recName = (lic?.recommendedStaffName || lic?.recommended_staff_name || '').trim();

  if (typeof docs === 'string' && docs.trim()) {
    const trimmed = docs.trim();
    if (trimmed === 'Office Staff Recommendation' || trimmed === 'Staff Recommendation') {
      return recName ? `Recom. By: ${recName}` : 'Office Staff Recommendation';
    }
    return trimmed;
  }

  if (Array.isArray(docs) && docs.length > 0) {
    return docs.map((doc: string) => {
      if (doc === 'Office Staff Recommendation' || doc === 'Staff Recommendation') {
        return recName ? `Recom. By: ${recName}` : 'Office Staff Recommendation';
      }
      if (doc === 'Other' && lic?.submittedDocsOther) {
        return `Other (${lic.submittedDocsOther})`;
      }
      return doc;
    }).join(', ');
  }

  if (recName) {
    return `Recom. By: ${recName}`;
  }

  return '---';
};

export default function StaffDashboard({ userRole = 'staff', userEmail = '', theme = 'dark', viewMode = 'dashboard' }: StaffDashboardProps) {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [requestsCount, setRequestsCount] = useState(0);
  const [searchesCount, setSearchesCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  // Debounce search query input by 300ms
  useEffect(() => {
    if (searchQuery.trim() !== debouncedSearchQuery.trim()) {
      setIsSearching(true);
    }
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  const [serverKpiCounts, setServerKpiCounts] = useState<{
    totalRecords: number;
    availableCount: number;
    notDistributedCount: number;
    distributedCount: number;
    missingCount: number;
    foundCount: number;
  } | null>(null);
  const [serverTotalCount, setServerTotalCount] = useState<number>(0);
  const [pageDocSnaps, setPageDocSnaps] = useState<(any | null)[]>([null]);
  
  // Pagination states (Default Page Size = 25)
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);

  // Tab/Register view
  const [activeRegister, setActiveRegister] = useState<LicenseStatus | 'not_distributed'>('available');
  const [dashboardTab, setDashboardTab] = useState<'overview' | 'alphabetical'>('overview');

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const regParam = params.get('register');
      if (regParam && ['available', 'not_distributed', 'distributed', 'missing', 'found'].includes(regParam)) {
        setActiveRegister(regParam as any);
        
        // Clean up URL parameter to keep URL pristine
        const url = new URL(window.location.href);
        url.searchParams.delete('register');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    } catch (e) {
      console.warn("Failed to read/clear register search parameter", e);
    }
  }, []);
  
  // Manual insertion state
  const [showAddForm, setShowAddForm] = useState(false);
  const [appId, setAppId] = useState('');
  const [fullName, setFullName] = useState('');
  const [fhName, setFhName] = useState('');
  const [licenseNo, setLicenseNo] = useState('');
  const [category, setCategory] = useState('LTV');
  const [visitDay, setVisitDay] = useState('Monday');
  const [addLoading, setAddLoading] = useState(false);

  // History log modal state
  const [selectedLicense, setSelectedLicense] = useState<License | null>(null);

  // Distribution receipt modal state
  const [showDistributionModal, setShowDistributionModal] = useState<License | null>(null);
  const [loadingDistributionDetail, setLoadingDistributionDetail] = useState(false);

  useEffect(() => {
    if (showDistributionModal && showDistributionModal.id) {
      const fetchLatestLicense = async () => {
        try {
          setLoadingDistributionDetail(true);
          const fresh = await getLicenseById(showDistributionModal.id);
          if (fresh) {
            setShowDistributionModal(prev => prev && prev.id === fresh.id ? fresh : prev);
          }
        } catch (error) {
          console.error("Failed to load latest license record from DB: ", error);
        } finally {
          setLoadingDistributionDetail(false);
        }
      };
      fetchLatestLicense();
    }
  }, [showDistributionModal?.id]);

  const [collectionRequests, setCollectionRequests] = useState<CollectionRequest[]>([]);
  const [uploadLedgers, setUploadLedgers] = useState<UploadLedger[]>([]);
  const [usersRoles, setUsersRoles] = useState<any[]>([]);

  // Reports state
  const [activeReportType, setActiveReportType] = useState<'available' | 'distributed' | 'missing' | 'found' | 'requests'>('available');
  const [reportData, setReportData] = useState<any[]>([]);
  const [isExportingReport, setIsExportingReport] = useState(false);

  // Integrated Report states
  const [officeSettings, setOfficeSettings] = useState<any>(null);
  const [selectedReports, setSelectedReports] = useState({
    totalSmartCards: true,
    distributedCards: true,
    notDistributedCards: true,
    missingCards: true,
    foundCards: true,
    requestToReceive: true
  });

  // Helper to parse "YYYY-MM-DD" to numeric components
  const parseBSDate = (bsStr: string) => {
    try {
      const parts = bsStr.split('-');
      return {
        year: parseInt(parts[0], 10) || 2083,
        month: parseInt(parts[1], 10) || 1,
        day: parseInt(parts[2], 10) || 1
      };
    } catch {
      return { year: 2083, month: 1, day: 1 };
    }
  };

  // Get current BS date for default values
  const todayBS = convertADToBS(new Date());
  const todayParsed = parseBSDate(todayBS);

  // Initialize start & end date states for Nepali date filtering
  const [startBS, setStartBS] = useState({
    year: todayParsed.year,
    month: 1, // Default to Baishakh (month 1) of the current BS year
    day: 1
  });

  const [endBS, setEndBS] = useState({
    year: todayParsed.year,
    month: todayParsed.month,
    day: todayParsed.day
  });

  // Ensure selected day is within the maximum days of the selected year/month
  useEffect(() => {
    const maxDays = getBSMonthDays(startBS.year, startBS.month);
    if (startBS.day > maxDays) {
      setStartBS(prev => ({ ...prev, day: maxDays }));
    }
  }, [startBS.year, startBS.month]);

  useEffect(() => {
    const maxDays = getBSMonthDays(endBS.year, endBS.month);
    if (endBS.day > maxDays) {
      setEndBS(prev => ({ ...prev, day: maxDays }));
    }
  }, [endBS.year, endBS.month]);

  const handleQuickSelect = (type: string) => {
    const currentBS = convertADToBS(new Date());
    const parsed = parseBSDate(currentBS);
    if (type === 'today') {
      setStartBS({ year: parsed.year, month: parsed.month, day: parsed.day });
      setEndBS({ year: parsed.year, month: parsed.month, day: parsed.day });
    } else if (type === 'this_month') {
      setStartBS({ year: parsed.year, month: parsed.month, day: 1 });
      const maxDays = getBSMonthDays(parsed.year, parsed.month);
      setEndBS({ year: parsed.year, month: parsed.month, day: maxDays });
    } else if (type === 'this_year') {
      setStartBS({ year: parsed.year, month: 1, day: 1 });
      const maxDays = getBSMonthDays(parsed.year, 12);
      setEndBS({ year: parsed.year, month: 12, day: maxDays });
    } else if (type === 'all') {
      setStartBS({ year: 2077, month: 1, day: 1 });
      setEndBS({ year: 2087, month: 12, day: 30 });
    }
  };

  // Custom persistent modal Dialogs to gracefully support cross-origin iframe sandboxing constraints
  const [deleteDialog, setDeleteDialog] = useState<{ show: boolean; licId: string; licNo: string } | null>(null);
  const [promptDialog, setPromptDialog] = useState<{ show: boolean; lic: License; newStatus: LicenseStatus; remark: string } | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);

  // Missing Card Modal States
  const [showMarkMissingModal, setShowMarkMissingModal] = useState<License | null>(null);
  const [missingMobile, setMissingMobile] = useState('');
  const [missingMobileError, setMissingMobileError] = useState('');

  // Found Card Modal States
  const [showConfirmFoundModal, setShowConfirmFoundModal] = useState<License | null>(null);
  const [foundReceiverName, setFoundReceiverName] = useState('');
  const [foundReceiverNameError, setFoundReceiverNameError] = useState('');
  const [foundSelectedDocs, setFoundSelectedDocs] = useState<string[]>([]);
  const [foundRecommendedStaffName, setFoundRecommendedStaffName] = useState('');
  const [foundRecommendedStaffNameError, setFoundRecommendedStaffNameError] = useState('');
  const [foundRemarks, setFoundRemarks] = useState('');
  const [foundRemarksError, setFoundRemarksError] = useState('');
  const [foundDateInput, setFoundDateInput] = useState('');
  const [foundTimeInput, setFoundTimeInput] = useState('');
  const [confirmFoundLoading, setConfirmFoundLoading] = useState(false);

  const currentUserRecord = usersRoles.find(ur => ur.email?.toLowerCase() === userEmail?.toLowerCase());
  const assignedTasks = currentUserRecord?.assignedTasks || [];

  const canAddLicense = userRole !== 'staff' || assignedTasks.includes('can_add_license');
  const canChangeStatus = userRole !== 'staff' || assignedTasks.includes('can_change_status');
  const canExportCsv = userRole !== 'staff' || assignedTasks.includes('can_export_csv');
  const canManageNotices = userRole !== 'staff' || assignedTasks.includes('can_manage_notices');
  const canManageRequests = userRole !== 'staff' || assignedTasks.includes('can_manage_requests');

  const refreshDashboardLightweight = useCallback(async () => {
    try {
      // Step 1 & Step 3: Refresh Dashboard KPI cards (Total Smart Cards, Not Distributed, Distributed, Missing, Found)
      const kpis = await getDashboardKpiCounts();
      setServerKpiCounts(kpis);

      // Step 2 & Step 4: Refresh the first visible table page using current page size
      const currentSize = pageSize > 0 ? pageSize : 25;
      const paginatedRes = await getPaginatedLicenses({
        pageSize: currentSize,
        lastDocSnap: null,
        statusFilter: activeRegister,
        searchQuery
      });
      setLicenses(paginatedRes.records);
      setServerTotalCount(paginatedRes.totalCount);
      setCurrentPage(1);
      if (paginatedRes.lastDocSnap) {
        setPageDocSnaps([null, paginatedRes.lastDocSnap]);
      } else {
        setPageDocSnaps([null]);
      }

      // Refresh collection requests count & upload ledgers
      const reqList = await getAllCollectionRequests();
      setRequestsCount(reqList.length);
      setCollectionRequests(reqList);

      try {
        const ledgers = await getAllUploadLedgers();
        setUploadLedgers(ledgers);
      } catch (e) {
        console.warn("Error refreshing upload ledgers:", e);
      }
    } catch (err) {
      console.warn("Error inside lightweight dashboard refresh:", err);
    }
  }, [pageSize, activeRegister, searchQuery]);

  useEffect(() => {
    const unsubscribe = registryDataStore.subscribe(() => {
      refreshDashboardLightweight();
    });
    fetchData();
    return () => {
      unsubscribe();
    };
  }, [refreshDashboardLightweight]);

  const fetchData = async () => {
    setLoading(true);
    try {
      // 1. Fetch KPI counts directly from Firestore Aggregate Count queries
      try {
        const kpis = await getDashboardKpiCounts();
        setServerKpiCounts(kpis);
      } catch (kpiErr) {
        console.warn("Could not load Aggregate KPI counts:", kpiErr);
      }

      // 2. Fetch initial page of records using Firestore server-side pagination
      try {
        const paginatedRes = await getPaginatedLicenses({
          pageSize: 25,
          statusFilter: activeRegister,
          searchQuery
        });
        setLicenses(paginatedRes.records);
        setServerTotalCount(paginatedRes.totalCount);
        if (paginatedRes.lastDocSnap) {
          setPageDocSnaps([null, paginatedRes.lastDocSnap]);
        }
      } catch (pagErr) {
        console.warn("Could not load initial paginated records:", pagErr);
        const storeRecords = registryDataStore.getRecords();
        setLicenses([...storeRecords]);
      }

      // 2. Fetch Requests count
      const reqList = await getAllCollectionRequests();
      setRequestsCount(reqList.length);
      setCollectionRequests(reqList);

      // Fetch Upload Ledgers
      try {
        const ledgers = await getAllUploadLedgers();
        setUploadLedgers(ledgers);
      } catch (ledgErr) {
        console.warn("Could not load upload ledgers:", ledgErr);
      }

      // 3. Fetch search stats
      const totalCount = await getSearchesServedCount();
      setSearchesCount(totalCount);

      // 4. Fetch office settings
      try {
        const settings = await getOfficeSettings();
        setOfficeSettings(settings);
      } catch (settingsErr) {
        console.warn("Could not retrieve office settings:", settingsErr);
      }

      // 5. Fetch user roles registry (staff registry list)
      try {
        const rolesList = await getAllUserRoles();
        setUsersRoles(rolesList);
      } catch (roleErr) {
        console.warn("Could not retrieve staff login registry roles:", roleErr);
      }
    } catch (err) {
      console.error("Failed fetching database ledger records: ", err);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmDeleteLicense = (licId: string, licNo: string) => {
    setDialogError(null);
    setDeleteDialog({ show: true, licId, licNo });
  };

  const executeDeleteLicense = async () => {
    if (!deleteDialog) return;
    setDeleteLoading(true);
    setDialogError(null);
    try {
      await deleteLicense(deleteDialog.licId);
      registryDataStore.deleteRecord(deleteDialog.licId);
      setDeleteDialog(null);
      await fetchData(); // Refresh driving licenses list
    } catch (err: any) {
      setDialogError(err.message || "Failed to delete record.");
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleCreateLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!appId.trim() || !fullName.trim() || !licenseNo.trim()) {
      alert("Please complete required key indicators.");
      return;
    }

    const digits = licenseNo.replace(/\D/g, '');
    if (digits.length !== 12) {
      alert("Enter your 12 digits license number");
      return;
    }

    setAddLoading(true);
    const staffEmail = auth.currentUser?.email || 'staff@plsms.gov.bd';
    
    try {
      const sanitizedId = licenseNo.trim().toUpperCase().replace(/[^A-Z0-9_\-\.]/g, '');
      const storeSnap = registryDataStore.getRecordById(sanitizedId);
      const snap = storeSnap || await getLicenseById(sanitizedId);
      if (snap) {
        alert("Driving License record already is logged with this unique License Number.");
        setAddLoading(false);
        return;
      }

      const timestamp = new Date().toISOString();
      const newRecord: License = {
        id: sanitizedId,
        applicantId: appId.trim(),
        fullName: fullName.trim(),
        licenseNumber: licenseNo.trim(),
        category: category,
        contactDepartment: visitDay,
        officeVisitDay: visitDay,
        status: 'available',
        createdAt: timestamp,
        updatedAt: timestamp,
        updatedBy: staffEmail,
        logs: [{
          timestamp,
          action: 'MANUAL_CREATE',
          user: staffEmail,
          details: 'Direct ledger entry uploaded by office staff.'
        }]
      };

      await createOrUpdateLicense(sanitizedId, newRecord);
      registryDataStore.addRecord(newRecord);
      
      // Save autocomplete suggestion history
      if (appId.trim()) HistorySuggestionService.saveValue('applicant_id_history', appId.trim());
      if (licenseNo.trim()) HistorySuggestionService.saveValue('license_number_history', licenseNo.trim());
      if (fullName.trim()) HistorySuggestionService.saveValue('full_name_history', fullName.trim());
      if (fhName.trim()) HistorySuggestionService.saveValue('fh_name_history', fhName.trim());

      // Reset
      setAppId('');
      setFullName('');
      setFhName('');
      setLicenseNo('');
      setShowAddForm(false);
      fetchData();
    } catch (err: any) {
      alert("Insertion failed: " + err.message);
    } finally {
      setAddLoading(false);
    }
  };

  const updateLicenseStatus = (lic: License, newStatus: LicenseStatus, remark: string) => {
    if (newStatus === 'missing') {
      setMissingMobile(lic.mobileNumber || '');
      setMissingMobileError('');
      setShowMarkMissingModal(lic);
    } else if (newStatus === 'found') {
      const staffEmail = auth.currentUser?.email || userEmail || 'staff@plsms.gov.bd';
      const timestamp = new Date().toISOString();
      const currentBS = convertADToBS(timestamp);
      const currentTime = String(new Date().getHours()).padStart(2, '0') + ':' + String(new Date().getMinutes()).padStart(2, '0');

      const targetFoundDate = lic.foundDate || currentBS;
      const targetFoundTime = lic.foundTime || currentTime;

      const foundLic: License = {
        ...lic,
        status: 'found' as const,
        foundDate: targetFoundDate,
        foundTime: targetFoundTime,
        foundBy: lic.foundBy || staffEmail,
        recoveredBy: lic.recoveredBy || staffEmail,
        updatedAt: timestamp,
        updatedBy: staffEmail,
      };

      // Atomic write to Firestore & local Registry Store
      createOrUpdateLicense(lic.id, foundLic).catch(err => console.warn("Background found update error:", err));
      registryDataStore.updateRecord(lic.id, foundLic);

      setFoundRemarks(lic.remarks || '');
      setFoundRemarksError('');
      setFoundReceiverName(lic.receivedBy || lic.fullName || '');
      setFoundReceiverNameError('');
      setFoundSelectedDocs(lic.submittedDocs && lic.submittedDocs.length > 0 ? [lic.submittedDocs[0]] : []);
      setFoundRecommendedStaffName(lic.recommendedStaffName || lic.recommended_staff_name || '');
      setFoundDateInput(targetFoundDate);
      setFoundTimeInput(targetFoundTime);
      setShowConfirmFoundModal(foundLic);
    } else if (newStatus === 'distributed') {
      setPromptValue('');
      setDialogError(null);
      setPromptDialog({ show: true, lic, newStatus, remark });
    } else {
      executeLicenseStatusUpdate(lic, newStatus, remark, null);
    }
  };

  const executeMarkAsMissing = async (lic: License) => {
    const cleanMobile = missingMobile.replace(/\D/g, '').trim();
    if (!cleanMobile) {
      setMissingMobileError("Mobile Number is required.");
      return;
    }
    if (cleanMobile.length !== 10) {
      setMissingMobileError("Mobile number must be exactly 10 digits.");
      return;
    }
    setMissingMobileError("");
    const staffEmail = auth.currentUser?.email || userEmail || 'staff@plsms.gov.bd';
    const timestamp = new Date().toISOString();
    const npDate = convertADToBS(timestamp);
    const npTime = String(new Date().getHours()).padStart(2, '0') + ':' + String(new Date().getMinutes()).padStart(2, '0');

    const logItem: LicenseLog = {
      timestamp,
      action: 'TRANSITION_TO_MISSING',
      user: staffEmail,
      details: `Card flagged as Missing. Collected Contact Mobile: ${cleanMobile}`
    };

    try {
      setPromptLoading(true);
      const updatedRecord = {
        ...lic,
        status: 'missing' as const,
        mobileNumber: cleanMobile,
        missingDate: npDate,
        missingTime: npTime,
        missingBy: staffEmail,
        markedBy: staffEmail,
        updatedAt: timestamp,
        updatedBy: staffEmail,
        logs: [...(lic.logs || []), logItem]
      };
      await createOrUpdateLicense(lic.id, updatedRecord);
      registryDataStore.updateRecord(lic.id, updatedRecord);

      setShowMarkMissingModal(null);
      setMissingMobile('');
      setMissingMobileError('');
      await fetchData();
    } catch (err: any) {
      alert("Failed to record missing card: " + err.message);
    } finally {
      setPromptLoading(false);
    }
  };

  const executeConfirmFound = async (lic: License) => {
    let hasError = false;
    if (!foundReceiverName.trim()) {
      setFoundReceiverNameError("Receiver Name is required.");
      hasError = true;
    } else {
      setFoundReceiverNameError("");
    }

    if (foundSelectedDocs.includes('Office Staff Recommendation') && !foundRecommendedStaffName.trim()) {
      setFoundRecommendedStaffNameError("Recommended By (Office Staff Name) is required.");
      hasError = true;
    } else {
      setFoundRecommendedStaffNameError("");
    }

    if (hasError) return;

    const staffEmail = auth.currentUser?.email || userEmail || 'staff@plsms.gov.bd';
    const timestamp = new Date().toISOString();

    const docSummary = foundSelectedDocs.length > 0 ? foundSelectedDocs.join(', ') : 'None';
    const logItem: LicenseLog = {
      timestamp,
      action: 'TRANSITION_TO_FOUND',
      user: staffEmail,
      details: `Card located and handed over to ${foundReceiverName.trim()}. Submitted docs: ${docSummary}`
    };

    try {
      setConfirmFoundLoading(true);

      // Fetch the latest fresh license from Registry Store or Firestore to guarantee we don't miss or lose any existing fields
      let freshLic = registryDataStore.getRecordById(lic.id) || lic;
      try {
        const fresh = await getLicenseById(lic.id);
        if (fresh) {
          freshLic = fresh;
        }
      } catch (e) {
        console.warn("Could not retrieve fresh record during confirmation: ", e);
      }

      const resolvedName = resolveStaffName(staffEmail, usersRoles) || staffEmail;
      const distDate = foundDateInput || convertADToBS(timestamp);

      const updatedRecord = {
        ...freshLic,
        status: 'found' as const,
        receivedBy: foundReceiverName.trim(),
        distributedTo: foundReceiverName.trim(),
        submittedDocsReceiverName: foundReceiverName.trim(),
        submittedDocs: foundSelectedDocs,
        submittedDocsOther: '',
        submittedDocsSavedBy: staffEmail,
        submittedDocsSavedDate: timestamp,
        submittedDocsSavedTime: foundTimeInput || '',
        recommendedStaffName: foundSelectedDocs.includes('Office Staff Recommendation') ? foundRecommendedStaffName.trim() : '',
        recommended_staff_name: foundSelectedDocs.includes('Office Staff Recommendation') ? foundRecommendedStaffName.trim() : '',
        foundDate: freshLic.foundDate || foundDateInput || distDate,
        foundTime: freshLic.foundTime || foundTimeInput || String(new Date().getHours()).padStart(2, '0') + ':' + String(new Date().getMinutes()).padStart(2, '0'),
        foundBy: freshLic.foundBy || staffEmail,
        recoveredBy: freshLic.recoveredBy || staffEmail,
        distributionDate: distDate,
        distributedDate: distDate,
        distributedBy: staffEmail,
        distributedByStaffName: resolvedName,
        distributionStatus: 'Distributed',
        distributed: true,
        remarks: foundRemarks.trim() || 'Distributed',
        updatedAt: timestamp,
        updatedBy: staffEmail,
        mobileNumber: freshLic.mobileNumber || lic.mobileNumber || '',
        missingDate: freshLic.missingDate || lic.missingDate || '',
        logs: [...(freshLic.logs || []), logItem]
      };

      await createOrUpdateLicense(freshLic.id, updatedRecord);
      registryDataStore.updateRecord(freshLic.id, updatedRecord);
      
      if (foundRemarks.trim()) {
        HistorySuggestionService.saveValue('remarks_history', foundRemarks.trim());
      }

      setShowConfirmFoundModal(null);
      setFoundReceiverName('');
      setFoundReceiverNameError('');
      setFoundSelectedDocs([]);
      setFoundRecommendedStaffName('');
      setFoundRemarks('');
      setFoundRemarksError('');
      setFoundRemarks('');
      setFoundRemarksError('');
      await fetchData();
    } catch (err: any) {
      alert("Failed to confirm found card: " + err.message);
    } finally {
      setConfirmFoundLoading(false);
    }
  };

  const executeLicenseStatusUpdate = async (lic: License, newStatus: LicenseStatus, remark: string, inputReceivedBy: string | null) => {
    const staffEmail = auth.currentUser?.email || userEmail || 'staff@plsms.gov.bd';
    const timestamp = new Date().toISOString();
    
    setPromptLoading(true);
    setDialogError(null);
    try {
      if (newStatus === 'distributed' && !inputReceivedBy) {
        setDialogError("Physical withdrawal requires a signature/received-by record.");
        setPromptLoading(false);
        return;
      }

      const logItem: LicenseLog = {
        timestamp,
        action: `TRANSITION_TO_${newStatus.toUpperCase()}`,
        user: staffEmail,
        details: remark + (inputReceivedBy ? ` (Received By: ${inputReceivedBy})` : '')
      };

      const resolvedName = resolveStaffName(staffEmail, usersRoles);
      const npDate = convertADToBS(timestamp);

      const updatedRecord = {
        ...lic,
        status: newStatus,
        receivedBy: inputReceivedBy || lic.receivedBy || '',
        distributedTo: inputReceivedBy || lic.distributedTo || lic.receivedBy || '',
        submittedDocsReceiverName: inputReceivedBy || lic.submittedDocsReceiverName || lic.receivedBy || '',
        updatedAt: timestamp,
        updatedBy: staffEmail,
        distributedByStaffName: newStatus === 'distributed' ? resolvedName : (lic.distributedByStaffName || ''),
        distributedBy: newStatus === 'distributed' ? staffEmail : (lic.distributedBy || ''),
        distributionDate: newStatus === 'distributed' ? npDate : (lic.distributionDate || ''),
        distributedDate: newStatus === 'distributed' ? npDate : (lic.distributedDate || ''),
        distributionStatus: newStatus === 'distributed' ? 'Distributed' : (lic.distributionStatus || ''),
        distributed: newStatus === 'distributed' ? true : (lic.distributed || false),
        logs: [...(lic.logs || []), logItem]
      };

      await createOrUpdateLicense(lic.id, updatedRecord);
      registryDataStore.updateRecord(lic.id, updatedRecord);

      if (newStatus === 'distributed' && inputReceivedBy && inputReceivedBy.trim()) {
        HistorySuggestionService.saveValue('handover_name_history', inputReceivedBy.trim());
      }

      setPromptDialog(null);
      await fetchData();
    } catch (err: any) {
      alert("Flipped status alter failed: " + err.message);
    } finally {
      setPromptLoading(false);
    }
  };

  // Export report to Excel (.xlsx) format
  // Dynamically classify licenses based on receivedBy column:
  // - If l.receivedBy is empty, display in "not-distributed" table indicating "not-distributed" in status column.
  // - If l.receivedBy has any text or data then move it towards "distributed" menu indicating "DISTRIBUTED".
  const getLiveProcessedLicenses = useCallback(() => {
    const records = registryDataStore.getRecords();
    return records.map(l => {
      if (l.status === 'missing' || l.status === 'found') {
        return l;
      }
      if (isLicenseDistributed(l)) {
        return {
          ...l,
          status: 'distributed' as const
        };
      } else {
        const revertedStatus: LicenseStatus = l.status === 'distributed' ? 'available' : l.status;
        return {
          ...l,
          status: revertedStatus
        };
      }
    });
  }, [licenses]);

  const processedLicenses = useMemo(() => getLiveProcessedLicenses(), [getLiveProcessedLicenses]);

  // State for export status toast feedback
  const [exportNotification, setExportNotification] = useState<{ message: string; type: 'info' | 'success' | 'warning' } | null>(null);

  const showExportNotification = (message: string, type: 'info' | 'success' | 'warning' = 'info') => {
    setExportNotification({ message, type });
    if (type !== 'info') {
      setTimeout(() => {
        setExportNotification(null);
      }, 4000);
    }
  };

  const handleGenerateIntegratedReport = async () => {
    const selectedKeys = Object.entries(selectedReports)
      .filter(([_, isSelected]) => isSelected)
      .map(([key]) => key);

    if (selectedKeys.length === 0) {
      showExportNotification("Please select at least one report section.", "warning");
      return;
    }

    const startBSStr = `${startBS.year}-${String(startBS.month).padStart(2, '0')}-${String(startBS.day).padStart(2, '0')}`;
    const endBSStr = `${endBS.year}-${String(endBS.month).padStart(2, '0')}-${String(endBS.day).padStart(2, '0')}`;

    if (startBSStr > endBSStr) {
      showExportNotification("Validation Error: From Date cannot be after To Date.", "warning");
      return;
    }

    setIsExportingReport(true);
    try {
      showExportNotification("Fetching current database records...", "info");

      const recordsMap = await fetchIntegratedReportData({
        selectedKeys,
        startBSStr,
        endBSStr,
        searchQuery,
        onStatusUpdate: (msg) => showExportNotification(msg, "info")
      });

      showExportNotification("Generating report...", "info");

      await exportIntegratedReportToExcel({
        selectedKeys,
        recordsMap,
        dateRangeStr: `Date Range: ${startBSStr} To ${endBSStr}`,
        endBSStr,
        onProgressStatus: (msg) => showExportNotification(msg, "info")
      });

      showExportNotification("Download ready.", "success");
    } catch (err: any) {
      console.error("Failed to generate integrated report:", err);
      showExportNotification(err.message || "Unable to retrieve current database data. Please try again.", "warning");
    } finally {
      setIsExportingReport(false);
    }
  };

  const fetchFreshRecordsForType = async (type: string) => {
    let records: any[] = [];
    if (type === 'requests') {
      try {
        const liveRequests = await getAllCollectionRequests();
        records = Array.isArray(liveRequests) ? liveRequests : [];
      } catch (err) {
        console.warn("Firestore collection requests fetch warning:", err);
        throw new Error("Unable to retrieve current database data. Please try again.");
      }
    } else if (type === 'upload_history') {
      try {
        const liveLedgers = await getAllUploadLedgers();
        records = Array.isArray(liveLedgers) ? liveLedgers : [];
      } catch (err) {
        console.warn("Firestore upload history fetch warning:", err);
        throw new Error("Unable to retrieve current database data. Please try again.");
      }
    } else {
      let licsToFilter: any[] = [];
      try {
        const liveLicenses = await getAllLicenses();
        licsToFilter = Array.isArray(liveLicenses) ? liveLicenses : [];
      } catch (err) {
        console.warn("Firestore licenses fetch warning:", err);
        throw new Error("Unable to retrieve current database data. Please try again.");
      }

      if (type === 'distributed') {
        records = licsToFilter.filter(l => (l.status === 'distributed' || isLicenseDistributed(l)) && l.status !== 'missing' && l.status !== 'found');
      } else if (type === 'notDistributed') {
        records = licsToFilter.filter(l => !isLicenseDistributed(l) && l.status !== 'distributed' && l.status !== 'missing' && l.status !== 'found');
      } else if (type === 'available') {
        records = licsToFilter;
      } else if (type === 'missing') {
        records = licsToFilter.filter(l => l.status === 'missing');
      } else if (type === 'found') {
        records = licsToFilter.filter(l => l.status === 'found');
      } else {
        records = licsToFilter;
      }
      records = records.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || '', undefined, { sensitivity: 'base' }));
    }
    return records;
  };

  const reportTitles: Record<string, string> = {
    available: 'Total Smart Cards Report',
    notDistributed: 'Not Distributed Cards Report',
    distributed: 'Distributed Cards Report',
    missing: 'Missing Cards Report',
    found: 'Found Cards Report',
    requests: 'Request to Receive Report',
    upload_history: 'Upload History Report'
  };

  const handleExportExcelReport = async (type: string) => {
    if (isExportingReport) return;
    setIsExportingReport(true);
    showExportNotification("Fetching current database records...", "info");
    try {
      const records = await fetchFreshRecordsForType(type);
      showExportNotification("Generating report...", "info");
      const title = reportTitles[type] || `${type.toUpperCase()} Report`;
      await exportReportToExcel({
        reportTitle: title,
        sheetName: title.substring(0, 31),
        records: records || [],
        reportType: type
      });
      showExportNotification("Download ready.", "success");
    } catch (err: any) {
      console.error("Export Excel error:", err);
      showExportNotification(err.message || "Unable to retrieve current database data. Please try again.", "warning");
    } finally {
      setIsExportingReport(false);
    }
  };

  const handleExportPdfReport = async (type: string) => {
    if (isExportingReport) return;
    setIsExportingReport(true);
    showExportNotification("Fetching current database records...", "info");
    try {
      const records = await fetchFreshRecordsForType(type);
      showExportNotification("Generating report...", "info");
      const title = reportTitles[type] || `${type.toUpperCase()} Report`;
      await exportReportToPdf({
        reportTitle: title,
        records: records || [],
        reportType: type
      });
      showExportNotification("Download ready.", "success");
    } catch (err: any) {
      console.error("Export PDF error:", err);
      showExportNotification(err.message || "Unable to retrieve current database data. Please try again.", "warning");
    } finally {
      setIsExportingReport(false);
    }
  };

  const handleExportCSVReport = async (type: string) => {
    if (isExportingReport) return;
    setIsExportingReport(true);
    showExportNotification("Fetching current database records...", "info");
    try {
      const records = await fetchFreshRecordsForType(type);
      showExportNotification("Generating report...", "info");
      const title = reportTitles[type] || `${type.toUpperCase()} Report`;
      await exportReportToCsv({
        reportTitle: title,
        records: records || [],
        reportType: type
      });
      showExportNotification("Download ready.", "success");
    } catch (err: any) {
      console.error("Export CSV error:", err);
      showExportNotification(err.message || "Unable to retrieve current database data. Please try again.", "warning");
    } finally {
      setIsExportingReport(false);
    }
  };

  // Calculations for KPI Cards & Dashboard statistics connected to Firestore Aggregate queries & Registry Data Store
  const {
    totalRecords,
    availableCount,
    notDistributedCount,
    distributedCount,
    missingCount,
    foundCount,
    categoryStatistics
  } = useMemo(() => {
    if (serverKpiCounts) {
      return {
        ...serverKpiCounts,
        categoryStatistics: {}
      };
    }

    let dist = 0;
    let missing = 0;
    let found = 0;
    const catStats: Record<string, number> = {};

    for (let i = 0; i < processedLicenses.length; i++) {
      const l = processedLicenses[i];
      if (l.status === 'missing') {
        missing++;
      } else if (l.status === 'found') {
        found++;
      } else if (l.status === 'distributed' || isLicenseDistributed(l)) {
        dist++;
      }
      const cat = (l.category || 'N/A').toUpperCase().trim();
      catStats[cat] = (catStats[cat] || 0) + 1;
    }

    const total = processedLicenses.length;
    const notDist = Math.max(0, total - (dist + missing + found));

    return {
      totalRecords: total,
      availableCount: notDist,
      notDistributedCount: notDist,
      distributedCount: dist,
      missingCount: missing,
      foundCount: found,
      categoryStatistics: catStats
    };
  }, [processedLicenses, serverKpiCounts]);

  // Pending statistics connected to centralized Registry Data Store
  const pendingRequestsCount = collectionRequests.length;

  useEffect(() => {
    setCurrentPage(1);
    setPageDocSnaps([null]);
  }, [debouncedSearchQuery, activeRegister, pageSize]);

  useEffect(() => {
    let active = true;
    const fetchPage = async () => {
      try {
        setIsSearching(true);
        const lastDocSnap = pageDocSnaps[currentPage - 1] || null;
        const res = await getPaginatedLicenses({
          pageSize: pageSize === 0 ? 0 : pageSize,
          lastDocSnap,
          statusFilter: activeRegister,
          searchQuery: debouncedSearchQuery
        });
        if (active) {
          setLicenses(res.records);
          setServerTotalCount(res.totalCount);
          if (res.lastDocSnap) {
            setPageDocSnaps(prev => {
              const updated = [...prev];
              updated[currentPage] = res.lastDocSnap;
              return updated;
            });
          }
        }
      } catch (err) {
        console.warn("Error fetching paginated page:", err);
      } finally {
        if (active) {
          setIsSearching(false);
        }
      }
    };
    fetchPage();
    return () => { active = false; };
  }, [currentPage, pageSize, activeRegister, debouncedSearchQuery]);

  const totalPages = useMemo(() => {
    if (pageSize === 0) return 1;
    return Math.ceil(serverTotalCount / pageSize) || 1;
  }, [serverTotalCount, pageSize]);

  const paginatedLicenses = licenses;

  const filteredLicenses = useMemo(() => {
    if (licenses.length === 0 && serverTotalCount === 0) return [];
    // Provide array length property corresponding to serverTotalCount for UI checks
    const arr = [...licenses];
    Object.defineProperty(arr, 'length', { value: serverTotalCount, writable: true });
    return arr;
  }, [licenses, serverTotalCount]);

  const isDark = theme === 'dark';

  if (viewMode === 'reports') {
    return (
      <div className="space-y-6 max-w-full w-full mx-auto font-sans animate-in fade-in duration-300">
        {/* Print Reports Terminal - styled beautifully as a page */}
        <div className={`w-full rounded-3xl p-6 shadow-2xl space-y-5 border transition-all ${
          isDark 
            ? 'bg-slate-900 border-slate-800' 
            : 'bg-white border-slate-200'
        }`}>
          <div className="flex justify-between items-start">
            <div>
              <h2 className={`text-xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>Print Reports Terminal</h2>
              <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-600 font-medium'}`}>Filter, construct, and download professional Excel & CSV reports.</p>
            </div>
            {!canExportCsv && (
              <span className={`border text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider ${
                isDark 
                  ? 'bg-red-955/20 text-rose-400 border-red-900/30' 
                  : 'bg-red-50 text-red-700 border-red-200'
              }`}>
                Restricted (S11)
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { id: 'available', label: 'Total Smart Cards Report', count: totalRecords },
              { id: 'notDistributed', label: 'Not Distributed Cards Report', count: notDistributedCount },
              { id: 'distributed', label: 'Distributed Cards Report', count: distributedCount },
              { id: 'missing', label: 'Missing Cards Report', count: missingCount },
              { id: 'found', label: 'Found Cards Report', count: foundCount },
              { id: 'requests', label: 'Request to Receive Report', count: collectionRequests.length },
              { id: 'upload_history', label: 'Upload History Report', count: uploadLedgers.length }
            ].map((rep) => (
              <div 
                key={rep.id} 
                className={`flex items-center justify-between p-4 rounded-2xl border transition-all group ${
                  canExportCsv 
                    ? (isDark 
                        ? "bg-slate-950 border-slate-800 hover:border-slate-700 hover:bg-slate-950/60" 
                        : "bg-slate-50 border-slate-200/80 hover:border-slate-300 hover:bg-slate-100/60 hover:shadow-xs")
                    : (isDark 
                        ? "bg-slate-955/40 border-slate-900/50 opacity-60" 
                        : "bg-slate-50/40 border-slate-200/40 opacity-60")
                }`}
              >
                <div className="flex flex-col">
                  <span className={`font-bold leading-tight transition-colors ${
                    canExportCsv 
                      ? (isDark ? "text-slate-200 group-hover:text-cyan-400" : "text-slate-950 group-hover:text-blue-600") 
                      : (isDark ? "text-slate-500" : "text-slate-450")
                  }`}>{rep.label}</span>
                  <span className={`text-[10px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-500 font-medium'}`}>
                    {rep.count} records matching
                  </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={!canExportCsv || isExportingReport}
                    onClick={() => handleExportExcelReport(rep.id as any)}
                    className={`p-1.5 rounded-lg border transition-all ${
                      canExportCsv && !isExportingReport
                        ? (isDark 
                            ? "text-slate-400 hover:text-emerald-400 bg-slate-900 border-slate-805 hover:border-emerald-990/40 cursor-pointer hover:scale-105 active:scale-95 duration-100" 
                            : "text-emerald-800 hover:text-emerald-950 bg-emerald-50 border-emerald-300 hover:bg-emerald-100 cursor-pointer hover:scale-105 active:scale-95 duration-100")
                        : (isDark 
                            ? "text-slate-650 bg-slate-955 border-slate-905 cursor-not-allowed opacity-50" 
                            : "text-slate-400 bg-slate-100 border-slate-200 cursor-not-allowed opacity-50")
                    }`}
                    title={canExportCsv ? "Download Official Excel (.xlsx) Report" : "Export features are restricted for your account role by the administrator"}
                  >
                    {canExportCsv ? <FileSpreadsheet className="w-4 h-4 text-emerald-500" /> : <Lock className="w-3.5 h-3.5 text-slate-450" />}
                  </button>
                  <button
                    type="button"
                    disabled={!canExportCsv || isExportingReport}
                    onClick={() => handleExportPdfReport(rep.id as any)}
                    className={`p-1.5 rounded-lg border transition-all ${
                      canExportCsv && !isExportingReport
                        ? (isDark 
                            ? "text-slate-400 hover:text-rose-400 bg-slate-900 border-slate-805 hover:border-rose-990/40 cursor-pointer hover:scale-105 active:scale-95 duration-100" 
                            : "text-rose-800 hover:text-rose-950 bg-rose-50 border-rose-300 hover:bg-rose-100 cursor-pointer hover:scale-105 active:scale-95 duration-100")
                        : (isDark 
                            ? "text-slate-650 bg-slate-955 border-slate-905 cursor-not-allowed opacity-50" 
                            : "text-slate-400 bg-slate-100 border-slate-200 cursor-not-allowed opacity-50")
                    }`}
                    title={canExportCsv ? "Download Official PDF (.pdf) Report" : "Export features are restricted for your account role by the administrator"}
                  >
                    {canExportCsv ? <FileText className="w-4 h-4 text-rose-500" /> : <Lock className="w-3.5 h-3.5 text-slate-450" />}
                  </button>
                  <button
                    type="button"
                    disabled={!canExportCsv || isExportingReport}
                    onClick={() => handleExportCSVReport(rep.id as any)}
                    className={`p-1.5 rounded-lg border transition-all ${
                      canExportCsv && !isExportingReport
                        ? (isDark 
                            ? "text-slate-400 hover:text-cyan-400 bg-slate-900 border-slate-805 hover:border-cyan-990/40 cursor-pointer hover:scale-105 active:scale-95 duration-100" 
                            : "text-blue-800 hover:text-blue-950 bg-blue-50 border-blue-300 hover:bg-blue-100 cursor-pointer hover:scale-105 active:scale-95 duration-100")
                        : (isDark 
                            ? "text-slate-650 bg-slate-955 border-slate-905 cursor-not-allowed opacity-50" 
                            : "text-slate-400 bg-slate-100 border-slate-200 cursor-not-allowed opacity-50")
                    }`}
                    title={canExportCsv ? "Download CSV Sheet" : "Export features are restricted for your account role by the administrator"}
                  >
                    {canExportCsv ? <FileDown className="w-4 h-4 text-cyan-400" /> : <Lock className="w-3.5 h-3.5 text-slate-450" />}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Integrated Report System Section (Super Admin only) */}
          {userRole !== 'staff' && (
            <div className={`mt-6 pt-6 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'} space-y-4`}>
              <div>
                <h3 className={`text-sm font-extrabold uppercase tracking-wider flex items-center gap-2 ${isDark ? 'text-cyan-400' : 'text-blue-600'}`}>
                  <FileSpreadsheet className="w-4 h-4 text-emerald-500" /> Integrated Report System (एकिकृत रिपोर्ट प्रणाली)
                </h3>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-650'}`}>
                  Select ledger sections to compile into a consolidated single-file Excel workbook (.xlsx) containing multiple sheet tabs.
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { key: 'totalSmartCards', label: 'Total Smart Cards' },
                  { key: 'distributedCards', label: 'Distributed Cards' },
                  { key: 'notDistributedCards', label: 'Not-Distributed Cards' },
                  { key: 'missingCards', label: 'Missing Cards' },
                  { key: 'foundCards', label: 'Found Cards' },
                  { key: 'requestToReceive', label: 'Request to Receive' }
                ].map((opt) => (
                  <label 
                    key={opt.key}
                    className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer select-none transition-all ${
                      selectedReports[opt.key as keyof typeof selectedReports]
                        ? (isDark 
                            ? 'bg-slate-950 border-cyan-500/50 shadow-xs' 
                            : 'bg-blue-50/50 border-blue-500 shadow-2xs')
                        : (isDark 
                            ? 'bg-slate-900 border-slate-800 hover:border-slate-755 text-slate-400 hover:text-slate-300' 
                            : 'bg-white border-slate-200 hover:border-slate-300 text-slate-600 hover:text-slate-800')
                    }`}
                  >
                    <input 
                      type="checkbox"
                      checked={selectedReports[opt.key as keyof typeof selectedReports]}
                      onChange={(e) => setSelectedReports(prev => ({
                        ...prev,
                        [opt.key]: e.target.checked
                      }))}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                    />
                    <span className="text-xs font-bold font-sans">
                      {opt.label}
                    </span>
                  </label>
                ))}
              </div>

              {/* Nepali Date Range Picker */}
              <div className={`p-4 rounded-xl border ${isDark ? 'bg-slate-900/40 border-slate-800' : 'bg-slate-50 border-slate-200'} space-y-4`}>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <span className={`text-xs font-black uppercase tracking-wider flex items-center gap-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                    📅 Filter by Nepali Date Range (दर्ता मिति दायरा):
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {[
                      { type: 'today', label: 'Today (आज)' },
                      { type: 'this_month', label: 'This Month (यो महिना)' },
                      { type: 'this_year', label: 'This Year (यो वर्ष)' },
                      { type: 'all', label: 'All Time (सबै)' }
                    ].map(btn => (
                      <button
                        key={btn.type}
                        type="button"
                        onClick={() => handleQuickSelect(btn.type)}
                        className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all duration-100 cursor-pointer ${
                          isDark 
                            ? 'bg-slate-800 hover:bg-slate-750 text-cyan-400 border border-slate-755' 
                            : 'bg-white hover:bg-slate-100 text-blue-600 border border-slate-200 shadow-2xs'
                        }`}
                      >
                        {btn.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-end gap-4">
                  {/* From Date Picker */}
                  <NepaliDatePicker
                    value={startBS}
                    onChange={setStartBS}
                    label="सुरु मिति (FROM DATE):"
                    isDark={isDark}
                  />

                  {/* To Date Picker */}
                  <NepaliDatePicker
                    value={endBS}
                    onChange={setEndBS}
                    label="अन्तिम मिति (TO DATE):"
                    isDark={isDark}
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={isExportingReport}
                  onClick={handleGenerateIntegratedReport}
                  className={`px-5 py-2.5 rounded-xl text-xs font-black tracking-wide shadow-md transition-all active:scale-95 duration-100 flex items-center gap-2 border ${
                    isExportingReport
                      ? 'opacity-50 cursor-not-allowed bg-slate-500 border-slate-600 text-slate-200'
                      : isDark 
                        ? 'bg-emerald-600 border-emerald-500 hover:bg-emerald-500 hover:border-emerald-400 text-white cursor-pointer' 
                        : 'bg-emerald-50 border-emerald-300 hover:bg-emerald-100 text-emerald-805 hover:text-emerald-900 font-bold cursor-pointer'
                  }`}
                >
                  <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
                  {isExportingReport ? "Generating Report..." : "Generate Integrated Report"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <SmartCardDashboard 
      licenses={processedLicenses} 
      theme={theme}
      activeTab={dashboardTab}
      onChangeTab={setDashboardTab}
    >
      <div className="space-y-6 max-w-full w-full mx-auto font-sans">
        
        {/* Dynamic Role Banner */}
      <div className={`p-5 rounded-3xl border flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 shadow-xl transition-all ${
        isDark 
          ? (userRole === 'staff'
              ? 'bg-blue-950/20 border-blue-900/40 text-blue-300'
              : 'bg-amber-950/15 border-amber-900/40 text-amber-300')
          : (userRole === 'staff'
              ? 'bg-blue-50/70 border-blue-200/80 text-blue-950 shadow-xs'
              : 'bg-amber-50/75 border-amber-200/80 text-amber-950 shadow-xs')
      }`}>
        <div className="flex items-center gap-3">
          <span className="text-xl">
            {userRole === 'staff' ? '📋' : '👑'}
          </span>
          <div>
            <h3 className={`text-sm font-bold tracking-tight uppercase ${isDark ? 'text-white' : 'text-slate-905'}`}>
              {userRole === 'staff' ? 'Normal Use Dashboard (Staff)' : 'Officer User Dashboard (Super Admin)'}
            </h3>
            <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-600 font-medium'}`}>
              {userRole === 'staff'
                ? 'Your active operational options are restricted by the Super Admin.'
                : 'You have full access to super admin controls, registers, and backup structures.'}
            </p>
          </div>
        </div>

        {userRole === 'staff' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-[10px] font-extrabold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Assigned Operational Tasks:</span>
            {assignedTasks.length === 0 ? (
              <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${isDark ? 'bg-slate-955 border-slate-800 text-slate-500' : 'bg-slate-100 border-slate-200 text-slate-500'}`}>None Assigned</span>
            ) : (
              assignedTasks.map((t) => {
                const label = t === 'can_add_license' ? 'Create Licenses ➕'
                            : t === 'can_change_status' ? 'Status Offloading 🔄'
                            : t === 'can_export_csv' ? 'Export Ledger 📊'
                            : t === 'can_manage_notices' ? 'Edit Notices 📣'
                            : t === 'can_manage_requests' ? 'Manage Collections 🗓️'
                            : t;
                return (
                  <span key={t} className={`px-2.5 py-0.5 rounded-md text-[10.5px] font-bold border font-sans ${isDark ? 'bg-blue-955/50 border-blue-800/60 text-blue-405' : 'bg-blue-100 border-blue-200 text-blue-805'}`}>
                    {label}
                  </span>
                );
              })
            )}
          </div>
        )}
      </div>
      
      {/* Dynamic Statistics Block */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <button 
          onClick={() => setActiveRegister('available')}
          className={`stats-card p-5 rounded-3xl border flex flex-col justify-center items-center text-center transition-all hover:scale-102 hover:shadow-md cursor-pointer ${
            activeRegister === 'available'
              ? (isDark ? 'bg-slate-800 border-slate-500 ring-4 ring-slate-500/10 text-white font-extrabold scale-102 shadow-md' : 'bg-slate-100 border-slate-900 ring-4 ring-slate-900/10 text-slate-950 font-extrabold scale-102 shadow-md')
              : (isDark ? 'bg-slate-900/50 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700 shadow-sm')
          }`}
        >
          <span className={`text-[10px] font-bold uppercase tracking-wider block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>TOTAL SMART CARDS</span>
          <span className={`text-2xl font-black mt-2 font-mono ${
            activeRegister === 'available'
              ? (isDark ? 'text-white' : 'text-slate-950')
              : (isDark ? 'text-slate-200' : 'text-slate-800')
          }`}>{totalRecords}</span>
        </button>
        
        <button 
          onClick={() => setActiveRegister('not_distributed')}
          className={`stats-card p-5 rounded-3xl border flex flex-col justify-center items-center text-center transition-all hover:scale-102 hover:shadow-md cursor-pointer ${
            activeRegister === 'not_distributed'
              ? (isDark ? 'bg-emerald-950/45 border-emerald-500 ring-4 ring-emerald-500/20 text-emerald-350 font-extrabold scale-102 shadow-md' : 'bg-emerald-100/90 border-emerald-600 ring-4 ring-emerald-500/15 text-emerald-950 font-extrabold scale-102 shadow-md')
              : (isDark ? 'bg-emerald-950/20 border-emerald-900/40 text-emerald-300/85 hover:bg-emerald-950/30' : 'bg-emerald-50/70 border-emerald-200/60 text-emerald-800 hover:bg-emerald-50')
          }`}
        >
          <span className={`text-[10px] font-bold uppercase tracking-wider block ${isDark ? 'text-emerald-400/70' : 'text-emerald-700'}`}>NOT-DISTRIBUTED CARDS</span>
          <span className={`text-2xl font-black mt-2 font-mono ${
            activeRegister === 'not_distributed'
              ? (isDark ? 'text-emerald-300' : 'text-emerald-900')
              : (isDark ? 'text-emerald-400' : 'text-emerald-750')
          }`}>{notDistributedCount}</span>
        </button>

        <button 
          onClick={() => setActiveRegister('distributed')}
          className={`stats-card p-5 rounded-3xl border flex flex-col justify-center items-center text-center transition-all hover:scale-102 hover:shadow-md cursor-pointer ${
            activeRegister === 'distributed'
              ? (isDark ? 'bg-blue-950/45 border-blue-500 ring-4 ring-blue-500/20 text-blue-350 font-extrabold scale-102 shadow-md' : 'bg-blue-100/90 border-blue-600 ring-4 ring-blue-500/15 text-blue-950 font-extrabold scale-102 shadow-md')
              : (isDark ? 'bg-blue-950/20 border-blue-900/40 text-blue-300/85 hover:bg-blue-950/30' : 'bg-blue-50/70 border-blue-200/60 text-blue-800 hover:bg-blue-50')
          }`}
        >
          <span className={`text-[10px] font-bold uppercase tracking-wider block ${isDark ? 'text-blue-400/70' : 'text-blue-700'}`}>DISTRIBUTED CARDS</span>
          <span className={`text-2xl font-black mt-2 font-mono ${
            activeRegister === 'distributed'
              ? (isDark ? 'text-blue-300' : 'text-blue-900')
              : (isDark ? 'text-blue-400' : 'text-blue-750')
          }`}>{distributedCount}</span>
        </button>

        <button 
          onClick={() => setActiveRegister('missing')}
          className={`stats-card p-5 rounded-3xl border flex flex-col justify-center items-center text-center transition-all hover:scale-102 hover:shadow-md cursor-pointer ${
            activeRegister === 'missing'
              ? (isDark ? 'bg-red-955/45 border-red-500 ring-4 ring-red-500/20 text-red-350 font-extrabold scale-102 shadow-md' : 'bg-red-100/90 border-red-600 ring-4 ring-red-500/15 text-red-950 font-extrabold scale-102 shadow-md')
              : (isDark ? 'bg-red-955/20 border-red-900/40 text-red-400/85 hover:bg-red-955/30' : 'bg-red-50/70 border-red-200/60 text-red-800 hover:bg-red-50')
          }`}
        >
          <span className={`text-[10px] font-bold uppercase tracking-wider block ${isDark ? 'text-red-400/70' : 'text-red-700'}`}>MISSING CARDS</span>
          <span className={`text-2xl font-black mt-2 font-mono ${
            activeRegister === 'missing'
              ? (isDark ? 'text-red-300' : 'text-red-900')
              : (isDark ? 'text-red-400' : 'text-red-750')
          }`}>{missingCount}</span>
        </button>

        <button 
          onClick={() => setActiveRegister('found')}
          className={`stats-card p-5 rounded-3xl border flex flex-col justify-center items-center text-center transition-all hover:scale-102 hover:shadow-md cursor-pointer ${
            activeRegister === 'found'
              ? (isDark ? 'bg-violet-955/45 border-violet-500 ring-4 ring-violet-500/20 text-violet-350 font-extrabold scale-102 shadow-md' : 'bg-violet-100/90 border-violet-600 ring-4 ring-violet-500/15 text-violet-950 font-extrabold scale-102 shadow-md')
              : (isDark ? 'bg-violet-955/20 border-violet-900/40 text-violet-400/85 hover:bg-violet-955/30' : 'bg-violet-50/70 border-violet-200/60 text-violet-800 hover:bg-violet-50')
          }`}
        >
          <span className={`text-[10px] font-bold uppercase tracking-wider block ${isDark ? 'text-violet-400/70' : 'text-violet-700'}`}>FOUND CARDS</span>
          <span className={`text-2xl font-black mt-2 font-mono ${
            activeRegister === 'found'
              ? (isDark ? 'text-violet-300' : 'text-violet-900')
              : (isDark ? 'text-violet-400' : 'text-violet-750')
          }`}>{foundCount}</span>
        </button>

        <div className={`p-5 rounded-3xl border flex flex-col justify-center items-center text-center transition-all ${isDark ? 'bg-cyan-950/25 border-cyan-900/40 text-cyan-300' : 'bg-cyan-100/40 border-cyan-200 text-cyan-900'}`}>
          <span className="text-[10px] font-bold uppercase tracking-wider block text-cyan-705">REQUEST TO RECEIVE</span>
          <span className={`text-2xl font-black mt-2 font-mono ${isDark ? 'text-cyan-300' : 'text-cyan-750'}`}>{pendingRequestsCount}</span>
        </div>
      </div>

      {/* Core Registers Workspace - Spans full width for a wider, more beautiful dashboard layout */}
      <div className={`rounded-3xl border p-6 space-y-5 transition-all ${isDark ? 'bg-slate-900 border-slate-800 shadow-2xl' : 'bg-white border-slate-200 shadow-md'}`}>
          <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
            <div>
              <h2 className={`text-lg font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>Ledger Registry Files</h2>
              <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Search and transition locations or distributed status.</p>
            </div>
          </div>

          {/* Register Tabs */}
          <div className={`flex border-b overflow-x-auto scrollbar-none ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
            {[
              { status: 'available', label: 'TOTAL SMART CARDS', color: isDark ? 'border-red-500 text-blue-400 !border-b-4' : 'border-red-600 text-blue-600 !border-b-4', count: totalRecords },
              { status: 'not_distributed', label: 'NOT-DISTRIBUTED CARDS', color: isDark ? 'border-amber-500 text-emerald-400 !border-b-4' : 'border-amber-500 text-emerald-700 !border-b-4', count: notDistributedCount },
              { status: 'distributed', label: 'DISTRIBUTED CARDS', color: isDark ? 'border-emerald-500 text-purple-400 !border-b-4' : 'border-emerald-600 text-purple-650 !border-b-4', count: distributedCount },
              { status: 'missing', label: 'MISSING CARDS', color: isDark ? 'border-rose-500 text-indigo-400 !border-b-4' : 'border-rose-600 text-indigo-650 !border-b-4', count: missingCount },
              { status: 'found', label: 'FOUND CARDS', color: isDark ? 'border-cyan-500 text-amber-400 !border-b-4' : 'border-cyan-600 text-amber-700 !border-b-4', count: foundCount },
            ].map((reg) => {
              const isActive = activeRegister === reg.status;
              
              let tabClasses = '';
              let badgeClasses = '';
              
              if (isDark) {
                tabClasses = `flex-1 min-w-[140px] text-center py-2.5 text-xs font-bold border-b-2 tracking-wide transition-all cursor-pointer ${
                  isActive ? reg.color : 'border-transparent text-slate-500 hover:text-slate-350'
                }`;
                badgeClasses = `ml-1.5 px-2 py-0.5 text-[10px] rounded-full font-mono border bg-slate-800 text-slate-400 border-slate-700/60`;
              } else {
                // Light mode: Beautiful, remarkable underline on hover, and remarkable background when clicked!
                const lightConfig: Record<string, { hoverBorder: string; hoverText: string; activeBg: string; activeText: string; activeBorder: string; activeBadge: string }> = {
                  not_distributed: {
                    hoverBorder: 'hover:border-emerald-600 hover:border-b-4',
                    hoverText: 'hover:text-emerald-800 hover:font-extrabold',
                    activeBg: 'bg-emerald-100/80',
                    activeText: 'text-emerald-950 font-black',
                    activeBorder: 'border-emerald-600 !border-b-4',
                    activeBadge: 'bg-emerald-200 text-emerald-950 border-emerald-400'
                  },
                  distributed: {
                    hoverBorder: 'hover:border-purple-600 hover:border-b-4',
                    hoverText: 'hover:text-purple-800 hover:font-extrabold',
                    activeBg: 'bg-purple-100/80',
                    activeText: 'text-purple-950 font-black',
                    activeBorder: 'border-purple-600 !border-b-4',
                    activeBadge: 'bg-purple-200 text-purple-950 border-purple-400'
                  },
                  available: {
                    hoverBorder: 'hover:border-blue-600 hover:border-b-4',
                    hoverText: 'hover:text-blue-800 hover:font-extrabold',
                    activeBg: 'bg-blue-100/80',
                    activeText: 'text-blue-950 font-black',
                    activeBorder: 'border-blue-600 !border-b-4',
                    activeBadge: 'bg-blue-200 text-blue-950 border-blue-400'
                  },
                  missing: {
                    hoverBorder: 'hover:border-rose-600 hover:border-b-4',
                    hoverText: 'hover:text-rose-800 hover:font-extrabold',
                    activeBg: 'bg-rose-100/80',
                    activeText: 'text-rose-950 font-black',
                    activeBorder: 'border-rose-600 !border-b-4',
                    activeBadge: 'bg-rose-200 text-rose-950 border-rose-400'
                  },
                  found: {
                    hoverBorder: 'hover:border-cyan-600 hover:border-b-4',
                    hoverText: 'hover:text-cyan-800 hover:font-extrabold',
                    activeBg: 'bg-cyan-100/80',
                    activeText: 'text-cyan-950 font-black',
                    activeBorder: 'border-cyan-600 !border-b-4',
                    activeBadge: 'bg-cyan-200 text-cyan-950 border-cyan-400'
                  }
                };
                
                const conf = lightConfig[reg.status] || lightConfig.available;
                
                if (isActive) {
                  tabClasses = `flex-1 min-w-[140px] text-center py-2.5 text-xs tracking-wide transition-all duration-150 cursor-pointer ${conf.activeBg} ${conf.activeText} ${conf.activeBorder} rounded-t-xl shadow-xs`;
                  badgeClasses = `ml-1.5 px-2 py-0.5 text-[10px] rounded-full font-mono border ${conf.activeBadge}`;
                } else {
                  tabClasses = `flex-1 min-w-[140px] text-center py-2.5 text-xs font-bold border-b-4 border-transparent tracking-wide text-slate-500 transition-all duration-150 cursor-pointer ${conf.hoverBorder} ${conf.hoverText}`;
                  badgeClasses = `ml-1.5 px-2 py-0.5 text-[10px] rounded-full font-mono border bg-slate-100 text-slate-600 border-slate-200 group-hover:bg-slate-200 transition-all duration-150`;
                }
              }

              return (
                <button
                  key={reg.status}
                  id={`register-tab-${reg.status}`}
                  onClick={() => setActiveRegister(reg.status as any)}
                  className={`group register-tab-btn ${isActive ? 'active-tab' : ''} ${tabClasses}`}
                >
                  {reg.label}
                  <span className={badgeClasses}>
                    {reg.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search Box */}
          <div className="relative flex items-center">
            <Search className={`absolute left-3.5 top-3 w-4 h-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search current register by license number, name, or applicant code..."
              className={`w-full pl-10 pr-24 py-2.5 rounded-xl border text-xs focus:outline-hidden transition-all ${
                isDark 
                  ? 'bg-slate-950 border-slate-800 text-white placeholder-slate-500 focus:border-cyan-500' 
                  : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:bg-white focus:shadow-xs'
              }`}
            />
            <div className="absolute right-3 flex items-center gap-2">
              {isSearching && (
                <span className="flex items-center gap-1 text-[10px] font-bold text-cyan-500 animate-pulse shrink-0">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Searching...
                </span>
              )}
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setDebouncedSearchQuery('');
                  }}
                  className={`p-1 rounded-full hover:bg-slate-800/20 text-xs font-bold transition-colors cursor-pointer shrink-0 ${
                    isDark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-900'
                  }`}
                  title="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Ledger Table */}
          {loading ? (
            <div className={`text-center py-12 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Loading ledger lists...</div>
          ) : filteredLicenses.length === 0 ? (
            <div className={`text-center py-12 px-4 text-xs rounded-2xl border border-dashed space-y-3 ${
              isDark ? 'bg-slate-950/40 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-600 font-medium'
            }`}>
              <p>
                {searchQuery.trim()
                  ? `No matching license records found for "${searchQuery}" under this register.`
                  : "No licensed entries under this register match current view constraints."}
              </p>
              {searchQuery.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setDebouncedSearchQuery('');
                  }}
                  className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-bold rounded-lg cursor-pointer transition-colors inline-flex items-center gap-1.5"
                >
                  <X className="w-3 h-3" />
                  Clear Search Filter
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Desktop view: Standard responsive horizontal table matching Picture 2 */}
              <div className={`hidden md:block overflow-x-visible w-full border rounded-2xl transition-all ${
                isDark ? 'border-slate-805 bg-slate-950' : 'border-slate-200 bg-white'
              }`}>
                <table className="w-full text-left text-xs border-collapse table-auto">
                  <thead>
                    {activeRegister === 'missing' ? (
                      <tr className={`border-b text-[10px] uppercase font-bold tracking-wider transition-colors ${
                        isDark ? 'bg-slate-900 border-slate-850 text-red-400 font-extrabold' : 'bg-slate-50 border-slate-200 text-red-800'
                      }`}>
                        <th className={`px-2 py-1.5 w-12 text-center border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          S.N.<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(क्र.सं.)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          APPLICANT ID<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(आवेदन नम्बर)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          LICENSE NUMBER<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(लाइसेन्स नम्बर)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          FULL NAME<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(पूरा नाम)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          CATEGORY<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(वर्ग)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          MOBILE NUMBER<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(मोबाईल)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          MISSING DATE<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(हराएको मिति)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          STATUS<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(स्थिति)</span>
                        </th>
                        <th className={`px-2 py-1.5 text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          ACTIONS<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(कार्य)</span>
                        </th>
                      </tr>
                    ) : activeRegister === 'found' ? (
                      <tr className={`border-b text-[10px] uppercase font-bold tracking-wider transition-colors ${
                        isDark ? 'bg-slate-900 border-slate-850 text-red-400 font-extrabold' : 'bg-slate-50 border-slate-200 text-red-00 font-bold'
                      }`}>
                        <th className={`px-2 py-1.5 w-12 text-center border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          S.N.<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(क्र.सं.)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          APPLICANT ID<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(आवेदन नम्बर)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          LICENSE NUMBER<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(लाइसेन्स नम्बर)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          FULL NAME<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(पूरा नाम)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          CATEGORY<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(वर्ग)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          MOBILE NUMBER<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(मोबाईल)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          MISSING DATE<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(हराएको मिति)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          FOUND DATE<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(भेटिएको मिति)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          DISTRIBUTION DATE<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(वितरण मिति BS)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          SUBMITTED DOC.<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(पेश गरिएको कागजात)</span>
                        </th>
                        <th className={`px-2 py-1.5 text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          REMARKS<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(कैफियत)</span>
                        </th>
                      </tr>
                    ) : activeRegister === 'not_distributed' ? (
                      <tr className={`border-b text-[10px] uppercase font-bold tracking-wider transition-colors ${
                        isDark ? 'bg-slate-900 border-slate-850 text-red-400 font-extrabold' : 'bg-slate-50 border-slate-200 text-red-800'
                      }`}>
                        <th className={`px-2 py-1.5 w-12 text-center border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          S.N.<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(क्र.सं.)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          APPLICANT ID<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(आवेदन नम्बर)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          FULL NAME<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(पूरा नाम)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          LICENSE NUMBER<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(लाइसेन्स नम्बर)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          CATEGORY<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(वर्ग)</span>
                        </th>
                        <th className={`px-2 py-1.5 text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          STATUS / ACTIONS<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(स्थिति/कार्य)</span>
                        </th>
                      </tr>
                    ) : (
                      <tr className={`border-b text-[10px] uppercase font-bold tracking-wider transition-colors ${
                        isDark ? 'bg-slate-900 border-slate-850 text-red-400 font-extrabold' : 'bg-slate-50 border-slate-200 text-red-800'
                      }`}>
                        <th className={`px-2 py-1.5 w-12 text-center border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          S.N.<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(क्र.सं.)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          APPLICANT ID<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(आवेदन नम्बर)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          FULL NAME<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(पूरा नाम)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          LICENSE NUMBER<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(लाइसेन्स नम्बर)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          CATEGORY<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(वर्ग)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          DISTRIBUTION DATE<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(वितरण मिति BS)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          SUBMITTED DOC.<br/><span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(पेश गरिएको कागजात)</span>
                        </th>
                        <th className={`px-2 py-1.5 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          DISTRIBUTED TO<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(बुझिलिनेको)</span>
                        </th>
                        <th className={`px-2 py-1.5 text-center whitespace-nowrap ${isDark ? 'border-slate-850' : 'border-slate-200'}`}>
                          STATUS / ACTIONS<br/>
                          <span className="text-[8px] font-medium lowercase normal-case text-slate-400 font-sans">(स्थिति/कार्य)</span>
                        </th>
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {paginatedLicenses.map((lic, index) => {
                      const displaySN = pageSize === 0 ? index + 1 : (currentPage - 1) * pageSize + index + 1;
                      let operatorDisplay = lic.distributedByStaffName || resolveOperatorName(lic.updatedBy, usersRoles);
                      if (!operatorDisplay || operatorDisplay === 'Public Handover Desk') {
                        const distLog = (lic.logs || []).find(l => (l.action || '').includes('DISTRIBUTED') || (l.action || '').includes('TRANSITION_TO_DISTRIBUTED'));
                        if (distLog && distLog.user) {
                          operatorDisplay = resolveOperatorName(distLog.user, usersRoles);
                        }
                      }
                      if (!operatorDisplay) {
                        operatorDisplay = 'Public Handover Desk';
                      }
                      const isDistributed = lic.status === 'distributed';
                      const rowBgClass = isDark
                        ? (index % 2 === 0 ? 'bg-slate-950 hover:bg-slate-900/20' : 'bg-slate-900/40 hover:bg-slate-900/60')
                        : (index % 2 === 0 ? 'bg-white hover:bg-slate-100/70' : 'bg-[#f2f7fc] hover:bg-slate-100/70');

                      if (activeRegister === 'missing') {
                        const distLog = (lic.logs || []).find(l => (l.action || '').includes('DISTRIBUTED') || (l.action || '').includes('TRANSITION_TO_DISTRIBUTED'));
                        const distDateRaw = lic.distributionDate || lic.distributedDate || (distLog ? distLog.timestamp : undefined);
                        const distDateBS = distDateRaw ? (distDateRaw.includes('-') && distDateRaw.length === 10 && !distDateRaw.includes('T') ? distDateRaw : convertADToBS(distDateRaw)) : '---';
                        return (
                          <tr key={lic.id} className={`border-b transition-colors ${rowBgClass} ${
                            isDark ? 'border-slate-900 text-slate-300' : 'border-slate-200 text-slate-800'
                          }`}>
                            <td className={`px-2 py-2 font-normal text-[12px] uppercase text-center w-12 border-r whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {index + 1}
                            </td>
                            <td className={`px-2 py-2 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {lic.applicantId}
                            </td>
                            <td className={`px-2 py-2 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {lic.licenseNumber}
                            </td>
                            <td className={`px-2 py-2 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {lic.fullName}
                            </td>
                            <td className={`px-2 py-2 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-800/45' : 'border-slate-200'}`}>
                              <span className={`px-1.5 py-0.5 text-[12px] font-bold uppercase rounded shadow-xs font-sans whitespace-nowrap ${
                                isDark 
                                  ? 'text-blue-400 border border-blue-900/70 bg-blue-950/40' 
                                  : 'text-slate-800 border border-slate-300 bg-slate-100'
                              }`}>
                                {lic.category || 'A'}
                              </span>
                            </td>
                            <td className={`px-2 py-2 border-r font-mono text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {lic.mobileNumber || '---'}
                            </td>
                            <td className={`px-2 py-2 border-r text-center font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {lic.missingDate || '---'}
                            </td>
                            <td className="px-2 py-2 text-center whitespace-nowrap border-r border-slate-900/45">
                              <span className="px-3 py-1 rounded-lg text-[12px] font-extrabold uppercase bg-red-600 text-white border border-red-700 shadow-sm font-sans">
                                MISSING
                              </span>
                            </td>
                            <td className="px-2 py-2 text-center whitespace-nowrap">
                              {canChangeStatus && (
                                <button
                                  type="button"
                                  onClick={() => updateLicenseStatus(lic, 'found', 'Marked found.')}
                                  className="px-3 py-1 font-bold text-[11.5px] uppercase border rounded-md transition-all active:scale-95 duration-150 whitespace-nowrap cursor-pointer shadow-md inline-flex items-center gap-1 bg-cyan-950 text-cyan-400 border-cyan-800 hover:bg-cyan-900"
                                >
                                  ✔️ FOUND
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      }

                      if (activeRegister === 'found') {
                        const distLog = (lic.logs || []).find(l => (l.action || '').includes('DISTRIBUTED') || (l.action || '').includes('TRANSITION_TO_DISTRIBUTED'));
                        const distDateRaw = lic.distributionDate || lic.distributedDate || (distLog ? distLog.timestamp : undefined);
                        const distDateBS = distDateRaw 
                          ? (distDateRaw.includes('-') && distDateRaw.length === 10 && !distDateRaw.includes('T') 
                              ? distDateRaw 
                              : convertADToBS(distDateRaw))
                          : '---';
                        return (
                          <tr key={lic.id} className={`border-b transition-colors ${rowBgClass} ${
                            isDark ? 'border-slate-900 text-slate-300' : 'border-slate-200 text-slate-800'
                          }`}>
                            <td className={`px-2 py-2 font-normal text-[12px] uppercase text-center w-12 border-r whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {index + 1}
                            </td>
                            <td className={`px-2 py-2 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {lic.applicantId}
                            </td>
                            <td className={`px-2 py-2 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {lic.licenseNumber}
                            </td>
                            <td className={`px-2 py-2 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-905'}`}>
                              {lic.fullName}
                            </td>
                            <td className={`px-2 py-2 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-800/45' : 'border-slate-200'}`}>
                              <span className={`px-1.5 py-0.5 text-[12px] font-bold uppercase rounded shadow-xs font-sans whitespace-nowrap ${
                                isDark 
                                  ? 'text-blue-400 border border-blue-900/70 bg-blue-950/40' 
                                  : 'text-slate-800 border border-slate-300 bg-slate-100'
                              }`}>
                                {lic.category || 'A'}
                              </span>
                            </td>
                            <td className={`px-2 py-2 border-r font-mono text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-905'}`}>
                              {lic.mobileNumber || '---'}
                            </td>
                            <td className={`px-2 py-2 border-r text-center font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-905'}`}>
                              {lic.missingDate || '---'}
                            </td>
                            <td className={`px-2 py-2 border-r text-center font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-905'}`}>
                              {lic.foundDate || '---'}
                            </td>
                            <td className={`px-2 py-2 border-r text-center font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-905'}`}>
                              {distDateBS}
                            </td>
                            <td className={`px-2 py-2 border-r text-center font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-905'}`}>
                              {getSubmittedDocsText(lic)}
                            </td>
                            <td className={`px-2 py-2 font-normal text-[12px] whitespace-nowrap text-cyan-400 ${isDark ? 'text-cyan-400' : 'text-cyan-750'}`}>
                              {lic.remarks || '---'}
                            </td>
                          </tr>
                        );
                      }

                      if (activeRegister === 'not_distributed') {
                        return (
                          <tr key={lic.id} className={`border-b transition-colors ${rowBgClass} ${
                            isDark ? 'border-slate-900 text-slate-300' : 'border-slate-200 text-slate-800'
                          }`}>
                            {/* 1. S.N. */}
                            <td className={`px-2 py-1 font-normal text-[12px] uppercase text-center w-12 border-r whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {index + 1}
                            </td>

                            {/* 2. APPLICANT ID */}
                            <td className={`px-2 py-1 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {lic.applicantId}
                            </td>

                            {/* 4. FULL NAME */}
                            <td className={`px-2 py-1 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {lic.fullName}
                            </td>

                            {/* 5. LICENSE NUMBER */}
                            <td className={`px-2 py-1 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                              {lic.licenseNumber}
                            </td>

                            {/* 6. CATEGORY */}
                            <td className={`px-2 py-1 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-800/45' : 'border-slate-200'}`}>
                              <span className={`px-1.5 py-0.5 text-[12px] font-bold uppercase rounded shadow-xs font-sans whitespace-nowrap ${
                                isDark 
                                  ? 'text-blue-400 border border-blue-900/70 bg-blue-950/40' 
                                  : 'text-slate-800 border border-slate-300 bg-slate-100'
                              }`}>
                                {lic.category || 'A'}
                              </span>
                            </td>

                            {/* 8. STATUS / ACTIONS */}
                            <td className="px-2 py-1 text-center whitespace-nowrap">
                              <div className="flex flex-row items-center justify-center gap-1.5 whitespace-nowrap">
                                {lic.status === 'missing' ? (
                                  <>
                                    <div
                                      className={`px-3 py-1 font-bold text-[12px] tracking-wider uppercase border rounded-md whitespace-nowrap cursor-default shadow-xs ${
                                        isDark
                                          ? 'bg-red-955/25 text-rose-455 border-red-900/30'
                                          : 'bg-amber-600 text-white border-amber-700'
                                      }`}
                                      title="Not Distributed"
                                    >
                                      NOT-DISTRIBUTED
                                    </div>
                                    <div
                                      className="px-3 py-1 font-extrabold text-[12px] tracking-wider uppercase border rounded-lg whitespace-nowrap cursor-default shadow-xs bg-red-600 text-white border-red-700"
                                      title="Missing"
                                    >
                                      MISSING
                                    </div>
                                  </>
                                ) : isLicenseDistributed(lic) ? (
                                  <button
                                    type="button"
                                    onClick={() => setShowDistributionModal(lic)}
                                    className={`px-3 py-1 font-bold text-[12px] tracking-wider uppercase border rounded-md transition-all active:scale-95 duration-150 whitespace-nowrap inline-flex items-center gap-1.5 cursor-pointer shadow-xs ${
                                      isDark
                                        ? 'bg-emerald-955/40 text-emerald-400 border-emerald-900/40 hover:bg-emerald-955/60 hover:text-emerald-300'
                                        : 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700 hover:border-emerald-800'
                                    }`}
                                    title="Click to view distributed receipt details"
                                  >
                                    <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${isDark ? 'bg-emerald-400' : 'bg-white'}`}></span>
                                    DISTRIBUTED
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => canChangeStatus && updateLicenseStatus(lic, 'distributed', 'Marked distributed and handed over physically in office.')}
                                    disabled={!canChangeStatus}
                                    className={`px-3 py-1 font-normal text-[12px] tracking-wider uppercase border rounded-md transition-all active:scale-95 duration-150 whitespace-nowrap ${
                                      canChangeStatus 
                                        ? (isDark 
                                            ? 'bg-red-955/30 text-red-500 border-red-900/40 hover:bg-red-955/50 hover:text-red-400 cursor-pointer shadow-xs'
                                            : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100 cursor-pointer shadow-xs')
                                        : 'bg-slate-900/20 text-slate-500 border-slate-900/40 cursor-not-allowed opacity-40'
                                    }`}
                                    title={canChangeStatus ? "Click to hand over & register physical receipt signature" : "🔒 Read Only Status Control"}
                                  >
                                    NOT-DISTRIBUTED
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      }

                      const distLog = (lic.logs || []).find(l => (l.action || '').includes('DISTRIBUTED') || (l.action || '').includes('TRANSITION_TO_DISTRIBUTED'));
                      const distDateRaw = lic.distributedDate || (distLog ? distLog.timestamp : undefined);
                      const distDateBS = (isLicenseDistributed(lic) || lic.status === 'distributed') && distDateRaw ? convertADToBS(distDateRaw) : '---';
                      return (
                        <tr key={lic.id} className={`border-b transition-colors ${rowBgClass} ${
                          isDark ? 'border-slate-900 text-slate-300' : 'border-slate-200 text-slate-800'
                        }`}>
                          {/* 1. S.N. */}
                          <td className={`px-2 py-1 font-normal text-[12px] uppercase text-center w-12 border-r whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                            {index + 1}
                          </td>

                          {/* 2. APPLICANT ID */}
                          <td className={`px-2 py-1 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                            {lic.applicantId}
                          </td>

                          {/* 4. FULL NAME */}
                          <td className={`px-2 py-1 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                            {lic.fullName}
                          </td>

                          {/* 6. LICENSE NUMBER */}
                          <td className={`px-2 py-1 border-r font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                            {lic.licenseNumber}
                          </td>

                          {/* 7. CATEGORY */}
                          <td className={`px-2 py-1 border-r text-center whitespace-nowrap ${isDark ? 'border-slate-800/45' : 'border-slate-200'}`}>
                            <span className={`px-1.5 py-0.5 text-[12px] font-bold uppercase rounded shadow-xs font-sans whitespace-nowrap ${
                              isDark 
                                ? 'text-blue-400 border border-blue-900/70 bg-blue-950/40' 
                                : 'text-slate-800 border border-slate-300 bg-slate-100'
                            }`}>
                              {lic.category || 'A'}
                            </span>
                          </td>

                          {/* DISTRIBUTION DATE */}
                          <td className={`px-2 py-1 border-r text-center font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                            {distDateBS}
                          </td>

                          {/* SUBMITTED DOC. */}
                          <td className={`px-2 py-1 border-r text-center font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                            {getSubmittedDocsText(lic)}
                          </td>

                          {/* 11. RECEIVED BY (renamed to DISTRIBUTED TO) */}
                          <td className={`px-2 py-1 border-r text-center font-normal text-[12px] uppercase whitespace-nowrap ${isDark ? 'border-slate-800/45 text-white' : 'border-slate-200 text-slate-900'}`}>
                            {lic.receivedBy || '---'}
                          </td>

                          {/* 12. STATUS / ACTIONS */}
                          <td className="px-2 py-1 text-center whitespace-nowrap">
                            {activeRegister === 'available' ? (
                              // SPECIFIC "TOTAL SMART CARDS" TABLE STATUS COLUMN - IMPROVED LIGHT THEME STYLING
                              isLicenseDistributed(lic) ? (
                                <div className="flex flex-row items-center justify-center gap-1.5 whitespace-nowrap">
                                  <button
                                    type="button"
                                    onClick={() => setShowDistributionModal(lic)}
                                    className={`px-3 py-1 font-bold text-[12px] tracking-wider uppercase border rounded-md transition-all active:scale-95 duration-150 whitespace-nowrap inline-flex items-center gap-1.5 cursor-pointer shadow-xs ${
                                      isDark
                                        ? 'bg-emerald-955/40 text-emerald-400 border-emerald-900/40 hover:bg-emerald-955/60 hover:text-emerald-300'
                                        : 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700 hover:border-emerald-800'
                                    }`}
                                    title="Click to view distributed receipt details"
                                  >
                                    <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${isDark ? 'bg-emerald-400' : 'bg-white'}`}></span>
                                    DISTRIBUTED
                                  </button>
                                  {lic.status === 'missing' && (
                                    <div
                                      className="px-3 py-1 font-extrabold text-[12px] tracking-wider uppercase border rounded-lg whitespace-nowrap cursor-default shadow-xs bg-red-600 text-white border-red-700"
                                      title="Missing"
                                    >
                                      MISSING
                                    </div>
                                  )}
                                  {lic.status === 'found' && (
                                    <div
                                      className="px-3 py-1 font-extrabold text-[12px] tracking-wider uppercase border rounded-lg whitespace-nowrap cursor-default shadow-xs bg-cyan-600 text-white border-cyan-700"
                                      title="Found"
                                    >
                                      FOUND
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="flex flex-row items-center justify-center gap-1.5 whitespace-nowrap">
                                  <div
                                    className={`px-3 py-1 font-bold text-[12px] tracking-wider uppercase border rounded-md whitespace-nowrap cursor-default shadow-xs ${
                                      isDark
                                        ? 'bg-red-955/25 text-rose-455 border-red-900/30'
                                        : 'bg-amber-600 text-white border-amber-700'
                                    }`}
                                    title="Not Distributed"
                                  >
                                    NOT-DISTRIBUTED
                                  </div>
                                </div>
                              )
                            ) : (
                              // STYLING FOR OTHER TABLES
                              isLicenseDistributed(lic) ? (
                                <div className="flex flex-row items-center justify-center gap-1.5 whitespace-nowrap">
                                  <button
                                    type="button"
                                    onClick={() => setShowDistributionModal(lic)}
                                    className={`px-3 py-1 font-normal text-[12px] tracking-wider uppercase border rounded-md transition-all active:scale-95 duration-150 whitespace-nowrap bg-emerald-950/40 text-emerald-400 border-emerald-900/40 hover:bg-emerald-955/60 hover:text-emerald-300 cursor-pointer shadow-md inline-flex items-center gap-1`}
                                    title="Click to view distributed receipt details"
                                  >
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                                    DISTRIBUTED
                                  </button>
                                  {canChangeStatus && (
                                    <button
                                      type="button"
                                      onClick={() => updateLicenseStatus(lic, 'missing', 'Distributed card reported missing/disputed.')}
                                      className="px-3 py-1 font-extrabold text-[12px] tracking-wider uppercase border rounded-lg transition-all active:scale-95 duration-150 whitespace-nowrap cursor-pointer shadow-xs bg-red-600 text-white border-red-700 hover:bg-red-700 inline-flex items-center gap-1"
                                      title="Mark card status as Missing"
                                    >
                                      MISSING
                                    </button>
                                  )}
                                </div>
                              ) : lic.status === 'missing' ? (
                                <div className="flex flex-row items-center justify-center gap-1.5 whitespace-nowrap">
                                  <span
                                    className="px-3 py-1 font-extrabold text-[12px] tracking-wider uppercase border rounded-lg whitespace-nowrap cursor-default shadow-xs bg-red-600 text-white border-red-700 inline-flex items-center gap-1"
                                    title="Missing"
                                  >
                                    MISSING
                                  </span>
                                </div>
                              ) : lic.status === 'found' ? (
                                <div className="flex flex-row items-center justify-center gap-1.5 whitespace-nowrap">
                                  <button
                                    type="button"
                                    onClick={() => setShowDistributionModal(lic)}
                                    className="px-3 py-1 font-extrabold text-[12px] tracking-wider uppercase border rounded-lg whitespace-nowrap cursor-pointer shadow-xs bg-cyan-600 text-white border-cyan-700 hover:bg-cyan-700 inline-flex items-center gap-1"
                                    title="Click to view distributed receipt details (FOUND)"
                                  >
                                    DISTRIBUTED (FOUND)
                                  </button>
                                </div>
                              ) : (
                                <div className="flex flex-row items-center justify-center gap-1.5 whitespace-nowrap">
                                  <button
                                    type="button"
                                    onClick={() => canChangeStatus && updateLicenseStatus(lic, 'distributed', 'Marked distributed and handed over physically in office.')}
                                    disabled={!canChangeStatus}
                                    className={`px-3 py-1 font-normal text-[12px] tracking-wider uppercase border rounded-md transition-all active:scale-95 duration-150 whitespace-nowrap ${
                                      canChangeStatus 
                                        ? 'bg-red-955/30 text-red-500 border-red-900/40 hover:bg-red-955/50 hover:text-red-400 cursor-pointer shadow-xs'
                                        : 'bg-slate-900/20 text-slate-500 border-slate-900/40 cursor-not-allowed opacity-40'
                                    }`}
                                    title={canChangeStatus ? "Click to hand over & register physical receipt signature" : "🔒 Read Only Status Control"}
                                  >
                                    NOT-DISTRIBUTED
                                  </button>
                                </div>
                              )
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile view: Stacked vertical cards for effortless scrolling and legibility */}
              <div className="block md:hidden space-y-4">
                {paginatedLicenses.map((lic, index) => (
                  <div key={lic.id} className={`border rounded-2xl p-4.5 space-y-3 shadow-md relative transition-all ${
                    isDark ? 'bg-slate-950/50 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-xs'
                  }`}>
                    <div className={`flex items-center justify-between border-b pb-2 ${isDark ? 'border-slate-800/60' : 'border-slate-100'}`}>
                      <span className={`font-mono text-[9px] font-extrabold uppercase ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        SN: {pageSize === 0 ? index + 1 : (currentPage - 1) * pageSize + index + 1} | ID: {lic.applicantId}
                      </span>
                      <span className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-cyan-400' : 'text-cyan-705'}`}>
                        {lic.category || 'LTV'}
                      </span>
                    </div>

                    <div className="space-y-0.5">
                      <span className={`font-black text-[15px] block leading-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>{lic.fullName}</span>
                    </div>

                    <div className={`grid grid-cols-2 gap-2 text-[11px] p-3 rounded-xl border transition-all ${
                      isDark ? 'bg-slate-950/80 border-slate-900 text-slate-300' : 'bg-slate-50 border-slate-150 text-slate-700'
                    }`}>
                      {activeRegister === 'not_distributed' ? (
                        <>
                          <div>
                            <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">License No</span>
                            <span className="font-mono font-bold text-cyan-400">{lic.licenseNumber}</span>
                          </div>
                          <div>
                            <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">Code (Old/New)</span>
                            <span className="font-mono font-bold block truncate">
                              {!lic.oldCode && !lic.newCode ? (
                                '---'
                              ) : (
                                <>
                                  <span>{lic.oldCode || '---'}</span>/
                                  <span className="text-red-600 dark:text-red-500 font-bold">{lic.newCode || '---'}</span>
                                </>
                              )}
                            </span>
                          </div>
                        </>
                      ) : activeRegister === 'missing' ? (
                        <>
                          <div>
                            <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">License No</span>
                            <span className="font-mono font-bold text-cyan-400">{lic.licenseNumber}</span>
                          </div>
                          <div>
                            <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">Missing Date</span>
                            <span className="font-bold text-slate-200 block truncate">{lic.missingDate || '---'}</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">License No</span>
                            <span className="font-mono font-bold text-cyan-400">{lic.licenseNumber}</span>
                          </div>
                          <div>
                            <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">Distribution Date (BS)</span>
                            <span className="font-bold text-slate-300">
                              {(() => {
                                const dLog = (lic.logs || []).find((l: any) => (l.action || '').includes('DISTRIBUTED') || (l.action || '').includes('TRANSITION_TO_DISTRIBUTED'));
                                const dRaw = lic.distributedDate || (dLog ? dLog.timestamp : undefined);
                                return lic.status === 'distributed' && dRaw ? convertADToBS(dRaw) : '---';
                              })()}
                            </span>
                          </div>
                          <div className="col-span-2 pt-1.5 mt-1 border-t border-slate-900/50">
                            <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">Submitted Documents</span>
                            <span className="font-bold text-slate-200 block truncate">{getSubmittedDocsText(lic)}</span>
                          </div>
                          {activeRegister === 'distributed' && (
                            <div className="col-span-2 pt-1.5 mt-1 border-t border-slate-900/50">
                              <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">Distributed To</span>
                              <span className="font-bold text-slate-200 block truncate">{lic.receivedBy || 'N/A'}</span>
                            </div>
                          )}
                        </>
                      )}
                      {activeRegister === 'missing' && (
                        <>
                          <div className="col-span-2 pt-1.5 mt-1 border-t border-slate-900/20 grid grid-cols-2 gap-2">
                            <div>
                              <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">Mobile Number</span>
                              <span className="font-bold text-rose-400 block truncate">{lic.mobileNumber || 'N/A'}</span>
                            </div>
                            <div>
                              <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">Missing Date</span>
                              <span className="font-bold text-rose-400 block truncate">{lic.missingDate || 'N/A'}</span>
                            </div>
                          </div>
                        </>
                      )}
                      {activeRegister === 'found' && (
                        <>
                          <div className="col-span-2 pt-1.5 mt-1 border-t border-slate-900/20 grid grid-cols-2 gap-2">
                            <div>
                              <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">Found Date</span>
                              <span className="font-bold text-cyan-400 block truncate">{lic.foundDate || 'N/A'}</span>
                            </div>
                            <div>
                              <span className="text-[8.5px] text-slate-500 font-bold uppercase tracking-wider block mb-0.5">Remarks</span>
                              <span className="font-bold text-slate-300 block truncate" title={lic.remarks || ''}>{lic.remarks || 'No remarks'}</span>
                            </div>
                          </div>
                        </>
                      )}
                      {activeRegister === 'not_distributed' && (
                        <div className={`col-span-2 pt-1.5 mt-1 border-t flex items-center justify-between ${isDark ? 'border-slate-900/50' : 'border-slate-100'}`}>
                          <span className={`text-[8.5px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Current Register</span>
                          <span className={`px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase tracking-wider ${
                            lic.status === 'available' ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/30' :
                            lic.status === 'missing' ? 'bg-red-955/25 text-rose-400 border border-red-900/30' :
                            lic.status === 'found' ? 'bg-cyan-950/40 text-cyan-400 border border-cyan-800/30' : 
                            'bg-slate-955/40 text-slate-400 border border-slate-800/30'
                          }`}>
                            {lic.status}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className={`flex items-center justify-end gap-2 flex-wrap pt-2.5 border-t ${isDark ? 'border-slate-900/50' : 'border-slate-100'}`}>
                      <button
                        onClick={() => setSelectedLicense(lic)}
                        className={`p-2 rounded-xl border transition-colors cursor-pointer ${
                          isDark ? 'text-slate-400 hover:text-cyan-400 hover:bg-slate-900 border-slate-900' : 'text-slate-500 hover:text-cyan-705 hover:bg-slate-50 border-slate-200'
                        }`}
                        title="Audit Trail History"
                      >
                        <History className="w-4 h-4" />
                      </button>

                      {activeRegister === 'available' ? (
                        // SPECIFIC "TOTAL SMART CARDS" MOBILE VIEW STATUS BUTTONS
                        isLicenseDistributed(lic) ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => setShowDistributionModal(lic)}
                              className={`px-3 py-1.5 border rounded-xl text-[10px] font-extrabold uppercase transition-all flex items-center gap-1.5 cursor-pointer shadow-sm ${
                                isDark 
                                  ? 'bg-emerald-950/40 text-emerald-400 border-emerald-900/40 hover:bg-emerald-955/65' 
                                  : 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700'
                              }`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${isDark ? 'bg-emerald-400' : 'bg-white'}`}></span>
                              DISTRIBUTED
                            </button>
                            {lic.status === 'missing' && (
                              <div
                                className="px-3 py-1.5 rounded-lg text-[10px] font-extrabold uppercase bg-red-600 text-white border border-red-700 shadow-sm whitespace-nowrap cursor-default text-center inline-block"
                              >
                                MISSING
                              </div>
                            )}
                            {lic.status === 'found' && (
                              <div
                                className="px-3 py-1.5 rounded-lg text-[10px] font-extrabold uppercase bg-cyan-600 text-white border border-cyan-700 shadow-sm whitespace-nowrap cursor-default text-center inline-block"
                              >
                                FOUND
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => canChangeStatus && updateLicenseStatus(lic, 'distributed', 'Marked distributed and handed over physically in office.')}
                              disabled={!canChangeStatus}
                              className={`px-3 py-1.5 border rounded-xl text-[10px] font-extrabold uppercase transition-all cursor-pointer ${
                                canChangeStatus
                                  ? isDark
                                    ? 'bg-red-955/25 text-rose-455 border-red-900/30 hover:bg-red-900/45'
                                    : 'bg-amber-600 text-white border-amber-700 hover:bg-amber-700'
                                  : isDark
                                    ? 'bg-slate-900 text-slate-500 border-slate-850 cursor-not-allowed opacity-40'
                                    : 'bg-amber-600/45 text-white/80 border-amber-650/30 cursor-not-allowed opacity-60'
                              }`}
                            >
                              NOT-DISTRIBUTED
                            </button>
                          </div>
                        )
                      ) : (
                        // ORIGINAL MOBILE ACTIONS FOR OTHER REGISTERS
                        <>
                          {isLicenseDistributed(lic) && (
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => setShowDistributionModal(lic)}
                                className={`px-3 py-1.5 border rounded-xl text-[10px] font-extrabold uppercase transition-all flex items-center gap-1.5 cursor-pointer bg-emerald-950/40 text-emerald-400 border-emerald-900/40 hover:bg-emerald-955/60 hover:text-emerald-300 shadow-sm`}
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                                DISTRIBUTED
                              </button>
                              {canChangeStatus && (
                                <button
                                  onClick={() => updateLicenseStatus(lic, 'missing', 'Distributed card reported missing/disputed.')}
                                  className="px-3 py-1.5 border rounded-lg text-[10px] font-extrabold uppercase transition-all cursor-pointer bg-red-600 text-white border-red-700 hover:bg-red-700 shadow-sm"
                                >
                                  MISSING
                                </button>
                              )}
                            </div>
                          )}

                          {lic.status === 'missing' && (
                            <div className="flex items-center gap-1.5">
                              <div
                                className="px-3 py-1.5 rounded-lg text-[10px] font-extrabold uppercase bg-red-600 text-white border border-red-700 shadow-sm whitespace-nowrap cursor-default"
                              >
                                MISSING
                              </div>
                            </div>
                          )}

                          {lic.status === 'found' && (
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => setShowDistributionModal(lic)}
                                className="px-3 py-1.5 rounded-lg text-[10px] font-extrabold uppercase bg-cyan-600 text-white border border-cyan-700 shadow-sm whitespace-nowrap cursor-pointer hover:bg-cyan-700"
                              >
                                DISTRIBUTED (FOUND)
                              </button>
                            </div>
                          )}

                          {!canChangeStatus && lic.status !== 'distributed' && lic.status !== 'missing' && lic.status !== 'found' && (
                            <span className={`text-[10px] font-bold uppercase px-3 py-1.5 rounded-xl border tracking-normal select-none ${
                              isDark ? 'bg-slate-900 text-slate-500 border-slate-850' : 'bg-slate-100 text-slate-500 border-slate-200'
                            }`}>
                              🔒 Read Only
                            </span>
                          )}

                          {canChangeStatus && lic.status === 'available' && (
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => updateLicenseStatus(lic, 'distributed', 'Marked distributed and handed over physically in office.')}
                                className={`px-3 py-1.5 border rounded-xl text-[10px] font-extrabold uppercase cursor-pointer ${
                                  isDark ? 'bg-emerald-950/30 text-emerald-400 hover:bg-emerald-900/40 border-emerald-900/30' : 'bg-emerald-50 text-emerald-750 border-emerald-200 hover:bg-emerald-100'
                                }`}
                              >
                                Hand Over
                              </button>
                              <button
                                onClick={() => updateLicenseStatus(lic, 'missing', 'Reported missing from storage desk.')}
                                className={`px-3 py-1.5 border rounded-xl text-[10px] font-extrabold uppercase cursor-pointer ${
                                  isDark ? 'bg-red-950/30 text-rose-400 hover:bg-red-900/40 border-red-900/30' : 'bg-red-50 text-red-700 hover:bg-red-105 border-red-200'
                                }`}
                              >
                                Lost
                              </button>
                            </div>
                          )}
                        </>
                      )}

                      {canChangeStatus && lic.status === 'missing' && (
                        <button
                          onClick={() => updateLicenseStatus(lic, 'found', 'Marked found; transiting back to desk.')}
                          className={`px-3 py-1.5 border rounded-xl text-[10px] font-extrabold uppercase cursor-pointer ${
                            isDark ? 'bg-cyan-950/30 text-cyan-400 hover:bg-cyan-900/40 border-cyan-800/30' : 'bg-cyan-50 text-cyan-705 hover:bg-cyan-100 border-cyan-100'
                          }`}
                        >
                          Found
                        </button>
                      )}

                      {canChangeStatus && lic.status === 'found' && (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => updateLicenseStatus(lic, 'available', 'Returned safely and marked available for pickups.')}
                            className={`px-3 py-1.5 border rounded-xl text-[10px] font-extrabold uppercase cursor-pointer ${
                              isDark ? 'bg-emerald-950/30 text-emerald-405 text-emerald-400 hover:bg-emerald-900/40 border-emerald-900/30' : 'bg-emerald-50 text-emerald-750 hover:bg-emerald-100 border-emerald-200'
                            }`}
                          >
                            Return Available
                          </button>
                          <button
                            onClick={() => updateLicenseStatus(lic, 'distributed', 'Distributed directly from found register.')}
                            className={`px-3 py-1.5 border rounded-xl text-[10px] font-extrabold uppercase cursor-pointer ${
                              isDark ? 'bg-blue-950/30 text-blue-400 hover:bg-blue-900/40 border-blue-900/30' : 'bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200'
                            }`}
                          >
                            Hand over
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Fast Pagination Bar */}
              {filteredLicenses.length > 0 && (
                <div className={`flex flex-col sm:flex-row items-center justify-between gap-3 p-3.5 mt-4 rounded-2xl border ${
                  isDark ? 'bg-slate-900/80 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
                }`}>
                  <div className="flex items-center gap-3 text-xs font-medium">
                    <span className="whitespace-nowrap">
                      Showing {pageSize === 0 ? 1 : Math.min((currentPage - 1) * pageSize + 1, filteredLicenses.length)} to {pageSize === 0 ? filteredLicenses.length : Math.min(currentPage * pageSize, filteredLicenses.length)} of <strong className="font-bold">{filteredLicenses.length}</strong> records
                    </span>
                    <div className="flex items-center gap-1.5 ml-2">
                      <span className="text-[11px] opacity-75 font-sans">Per page:</span>
                      <select
                        value={pageSize}
                        onChange={(e) => {
                          setPageSize(Number(e.target.value));
                          setCurrentPage(1);
                        }}
                        className={`text-xs px-2 py-1 rounded-lg border font-medium focus:outline-hidden ${
                          isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-800'
                        }`}
                      >
                        <option value={25}>25</option>
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                        <option value={200}>200</option>
                        <option value={0}>All</option>
                      </select>
                    </div>
                  </div>

                  {pageSize > 0 && totalPages > 1 && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setCurrentPage(p => Math.max(p - 1, 1))}
                        disabled={currentPage === 1}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                          currentPage === 1
                            ? 'opacity-40 cursor-not-allowed'
                            : 'hover:bg-blue-600 hover:text-white cursor-pointer active:scale-95'
                        } ${isDark ? 'bg-slate-800 text-white' : 'bg-white border border-slate-300 text-slate-700'}`}
                      >
                        ◀ Prev
                      </button>

                      <span className="text-xs font-semibold px-2">
                        Page {currentPage} of {totalPages}
                      </span>

                      <button
                        type="button"
                        onClick={() => setCurrentPage(p => Math.min(p + 1, totalPages))}
                        disabled={currentPage === totalPages}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                          currentPage === totalPages
                            ? 'opacity-40 cursor-not-allowed'
                            : 'hover:bg-blue-600 hover:text-white cursor-pointer active:scale-95'
                        } ${isDark ? 'bg-slate-800 text-white' : 'bg-white border border-slate-300 text-slate-700'}`}
                      >
                        Next ▶
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      {viewMode !== 'dashboard' && (
        /* Reports Terminal Panel - Stacked below, displaying options in a stunning grid structure */
      <div className={`w-full rounded-3xl p-6 shadow-2xl space-y-5 animate-in fade-in duration-300 border transition-all ${
        isDark 
          ? 'bg-slate-900 border-slate-800' 
          : 'bg-white border-slate-200'
      }`}>
        <div className="flex justify-between items-start">
          <div>
            <h2 className={`text-base font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>Print Reports Terminal</h2>
            <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Filter, construct, and download professional Excel & CSV reports.</p>
          </div>
          {!canExportCsv && (
            <span className={`border text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider ${
              isDark 
                ? 'bg-red-955/20 text-rose-400 border-red-900/30' 
                : 'bg-red-50 text-red-700 border-red-200'
            }`}>
              Restricted (S11)
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { id: 'available', label: 'Total Smart Cards Report', count: totalRecords },
            { id: 'notDistributed', label: 'Not Distributed Cards Report', count: notDistributedCount },
            { id: 'distributed', label: 'Distributed Cards Report', count: distributedCount },
            { id: 'missing', label: 'Missing Cards Report', count: missingCount },
            { id: 'found', label: 'Found Cards Report', count: foundCount },
            { id: 'requests', label: 'Request to Receive Report', count: collectionRequests.length },
            { id: 'upload_history', label: 'Upload History Report', count: uploadLedgers.length }
          ].map((rep) => (
            <div 
              key={rep.id} 
              className={`flex items-center justify-between p-4 rounded-2xl border transition-all group ${
                canExportCsv 
                  ? (isDark 
                      ? "bg-slate-950 border-slate-800 hover:border-slate-700 hover:bg-slate-950/60" 
                      : "bg-slate-50 border-slate-200/80 hover:border-slate-300 hover:bg-slate-100/60 hover:shadow-xs")
                  : (isDark 
                      ? "bg-slate-950/40 border-slate-900/50 opacity-60" 
                      : "bg-slate-50/40 border-slate-200/40 opacity-60")
              }`}
            >
              <div className="flex flex-col">
                <span className={`font-bold leading-tight transition-colors ${
                  canExportCsv 
                    ? (isDark ? "text-slate-200 group-hover:text-cyan-400" : "text-slate-950 group-hover:text-blue-600") 
                    : (isDark ? "text-slate-500" : "text-slate-450")
                }`}>{rep.label}</span>
                <span className={`text-[10px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-500 font-medium'}`}>
                  {rep.count} records matching
                </span>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={!canExportCsv || isExportingReport}
                  onClick={() => handleExportExcelReport(rep.id as any)}
                  className={`p-1.5 rounded-lg border transition-all ${
                    canExportCsv && !isExportingReport
                      ? (isDark 
                          ? "text-slate-400 hover:text-emerald-400 bg-slate-900 border-slate-805 hover:border-emerald-990/40 cursor-pointer hover:scale-105 active:scale-95 duration-100" 
                          : "text-emerald-800 hover:text-emerald-950 bg-emerald-50 border-emerald-300 hover:bg-emerald-100 cursor-pointer hover:scale-105 active:scale-95 duration-100")
                      : (isDark 
                          ? "text-slate-650 bg-slate-955 border-slate-905 cursor-not-allowed" 
                          : "text-slate-400 bg-slate-100 border-slate-200 cursor-not-allowed")
                  }`}
                  title={canExportCsv ? "Download Official Excel (.xlsx) Report" : "Export features are restricted for your account role by the administrator"}
                >
                  {canExportCsv ? <FileSpreadsheet className="w-4 h-4 text-emerald-500" /> : <Lock className="w-3.5 h-3.5 text-slate-450" />}
                </button>
                <button
                  type="button"
                  disabled={!canExportCsv || isExportingReport}
                  onClick={() => handleExportPdfReport(rep.id as any)}
                  className={`p-1.5 rounded-lg border transition-all ${
                    canExportCsv && !isExportingReport
                      ? (isDark 
                          ? "text-slate-400 hover:text-rose-400 bg-slate-900 border-slate-805 hover:border-rose-990/40 cursor-pointer hover:scale-105 active:scale-95 duration-100" 
                          : "text-rose-800 hover:text-rose-950 bg-rose-50 border-rose-300 hover:bg-rose-100 cursor-pointer hover:scale-105 active:scale-95 duration-100")
                      : (isDark 
                          ? "text-slate-650 bg-slate-955 border-slate-905 cursor-not-allowed" 
                          : "text-slate-400 bg-slate-100 border-slate-200 cursor-not-allowed")
                  }`}
                  title={canExportCsv ? "Download Official PDF (.pdf) Report" : "Export features are restricted for your account role by the administrator"}
                >
                  {canExportCsv ? <FileText className="w-4 h-4 text-rose-500" /> : <Lock className="w-3.5 h-3.5 text-slate-450" />}
                </button>
                <button
                  type="button"
                  disabled={!canExportCsv || isExportingReport}
                  onClick={() => handleExportCSVReport(rep.id as any)}
                  className={`p-1.5 rounded-lg border transition-all ${
                    canExportCsv && !isExportingReport
                      ? (isDark 
                          ? "text-slate-400 hover:text-cyan-400 bg-slate-900 border-slate-805 hover:border-cyan-990/40 cursor-pointer hover:scale-105 active:scale-95 duration-100" 
                          : "text-blue-800 hover:text-blue-950 bg-blue-50 border-blue-300 hover:bg-blue-100 cursor-pointer hover:scale-105 active:scale-95 duration-100")
                      : (isDark 
                          ? "text-slate-650 bg-slate-955 border-slate-905 cursor-not-allowed" 
                          : "text-slate-400 bg-slate-100 border-slate-200 cursor-not-allowed")
                  }`}
                  title={canExportCsv ? "Download CSV Sheet" : "Export features are restricted for your account role by the administrator"}
                >
                  {canExportCsv ? <FileDown className="w-4 h-4 text-cyan-400" /> : <Lock className="w-3.5 h-3.5 text-slate-450" />}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Integrated Report System Section (Super Admin only) */}
        {userRole !== 'staff' && (
          <div className={`mt-6 pt-6 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'} space-y-4`}>
            <div>
              <h3 className={`text-sm font-extrabold uppercase tracking-wider flex items-center gap-2 ${isDark ? 'text-cyan-400' : 'text-blue-600'}`}>
                <FileSpreadsheet className="w-4 h-4 text-emerald-500" /> Integrated Report System (एकिकृत रिपोर्ट प्रणाली)
              </h3>
              <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-650'}`}>
                Select ledger sections to compile into a consolidated single-file Excel workbook (.xlsx) containing multiple sheet tabs.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                { key: 'totalSmartCards', label: 'Total Smart Cards' },
                { key: 'distributedCards', label: 'Distributed Cards' },
                { key: 'notDistributedCards', label: 'Not-Distributed Cards' },
                { key: 'missingCards', label: 'Missing Cards' },
                { key: 'foundCards', label: 'Found Cards' },
                { key: 'requestToReceive', label: 'Request to Receive' }
              ].map((opt) => (
                <label 
                  key={opt.key}
                  className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer select-none transition-all ${
                    selectedReports[opt.key as keyof typeof selectedReports]
                      ? (isDark 
                          ? 'bg-slate-950 border-cyan-500/50 shadow-xs' 
                          : 'bg-blue-50/50 border-blue-400/70 shadow-xs')
                      : (isDark 
                          ? 'bg-slate-900/40 border-slate-800 hover:border-slate-750' 
                          : 'bg-white border-slate-200 hover:border-slate-300')
                  }`}
                >
                  <input 
                    type="checkbox"
                    checked={selectedReports[opt.key as keyof typeof selectedReports]}
                    onChange={(e) => setSelectedReports(prev => ({
                      ...prev,
                      [opt.key]: e.target.checked
                    }))}
                    className="rounded border-slate-300 text-blue-650 focus:ring-blue-500 w-4 h-4 transition duration-150 ease-in-out cursor-pointer"
                  />
                  <span className={`text-xs font-bold transition-colors ${
                    selectedReports[opt.key as keyof typeof selectedReports]
                      ? (isDark ? 'text-cyan-400 font-extrabold' : 'text-blue-700 font-extrabold')
                      : (isDark ? 'text-slate-350' : 'text-slate-600')
                  }`}>
                    {opt.label}
                  </span>
                </label>
              ))}
            </div>

            {/* Nepali Date Range Picker */}
            <div className={`p-4 rounded-xl border ${isDark ? 'bg-slate-900/40 border-slate-800' : 'bg-slate-50 border-slate-200'} space-y-4`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <span className={`text-xs font-black uppercase tracking-wider flex items-center gap-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  📅 Filter by Nepali Date Range (दर्ता मिति दायरा):
                </span>
                <div className="flex flex-wrap gap-1">
                  {[
                    { type: 'today', label: 'Today (आज)' },
                    { type: 'this_month', label: 'This Month (यो महिना)' },
                    { type: 'this_year', label: 'This Year (यो वर्ष)' },
                    { type: 'all', label: 'All Time (सबै)' }
                  ].map(btn => (
                    <button
                      key={btn.type}
                      type="button"
                      onClick={() => handleQuickSelect(btn.type)}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all duration-100 cursor-pointer ${
                        isDark 
                          ? 'bg-slate-800 hover:bg-slate-750 text-cyan-400 border border-slate-750' 
                          : 'bg-white hover:bg-slate-100 text-blue-600 border border-slate-200 shadow-2xs'
                      }`}
                    >
                      {btn.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-end gap-4">
                {/* From Date Picker */}
                <NepaliDatePicker
                  value={startBS}
                  onChange={setStartBS}
                  label="सुरु मिति (FROM DATE):"
                  isDark={isDark}
                />

                {/* To Date Picker */}
                <NepaliDatePicker
                  value={endBS}
                  onChange={setEndBS}
                  label="अन्तिम मिति (TO DATE):"
                  isDark={isDark}
                />
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleGenerateIntegratedReport}
                className={`px-5 py-2.5 rounded-xl text-xs font-black tracking-wide shadow-md transition-all active:scale-95 duration-100 flex items-center gap-2 border cursor-pointer ${
                  isDark 
                    ? 'bg-emerald-600 border-emerald-500 hover:bg-emerald-500 hover:border-emerald-400 text-white' 
                    : 'bg-emerald-50 border-emerald-300 hover:bg-emerald-100 text-emerald-800 hover:text-emerald-900 font-bold'
                }`}
              >
                <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
                Generate Integrated Report
              </button>
            </div>
          </div>
        )}
      </div>
      )}


      {/* History Log Modal Overlay */}
      {selectedLicense && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-40 animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 text-white rounded-2xl sm:rounded-3xl max-w-lg w-full p-4 sm:p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto scrollbar-none">
            <button 
              onClick={() => setSelectedLicense(null)}
              className="absolute right-5 top-5 text-slate-500 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
            
            <div className="mb-4">
              <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider block">Auditing driving license ledger</span>
              <h3 className="text-lg font-bold text-white mt-1">{selectedLicense.fullName}</h3>
              <span className="text-xs font-mono text-slate-400">{selectedLicense.licenseNumber}</span>
            </div>

            <LicenseHistory logs={selectedLicense.logs || []} />
          </div>
        </div>
      )}

      {/* Handover Distribution Details Modal Overlay */}
      {showDistributionModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-40 animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 text-white rounded-2xl sm:rounded-3xl max-w-md w-full p-4 sm:p-6 shadow-2xl relative animate-in zoom-in-95 duration-150 max-h-[92vh] overflow-y-auto scrollbar-none">
            <button 
              onClick={() => setShowDistributionModal(null)}
              className="absolute right-5 top-5 text-slate-500 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
            
            <div className="mb-5 border-b border-slate-800 pb-3">
              <span className="text-[10px] text-cyan-400 font-extrabold uppercase tracking-widest block mb-1">PLSMS Handover Certificate</span>
              <h3 className="text-xl font-black text-white tracking-tight">Ledger Registry Slip</h3>
            </div>

            {(() => {
              const matchingReq = collectionRequests.find(
                r => r.licenseId === showDistributionModal.id || 
                     r.licenseNumber === showDistributionModal.licenseNumber
              );
              const reqDate = matchingReq ? matchingReq.createdAt : showDistributionModal.createdAt;
              
              const distLog = showDistributionModal.logs?.find(log => log.action.includes('DISTRIBUTED'));
              const rawDistDate = showDistributionModal.distributedDate || (distLog ? distLog.timestamp : showDistributionModal.updatedAt);
              const displayDistDate = rawDistDate && (rawDistDate.includes(',') || rawDistDate.match(/[a-zA-Z]/)) 
                ? rawDistDate 
                : (rawDistDate ? formatDate(rawDistDate) : '---');
              const distUserEmail = distLog ? distLog.user : (showDistributionModal.updatedBy || '');
              const distUserName = showDistributionModal.distributedByStaffName || (distUserEmail ? resolveOperatorName(distUserEmail, usersRoles) : 'Staff Operator');
              
              return (
                <div className="space-y-4 font-sans">
                  {loadingDistributionDetail && (
                    <div className="text-center py-2 text-cyan-400 text-xs font-bold animate-pulse">
                      🔄 Loading latest record from database...
                    </div>
                  )}
                  <div className="bg-slate-950/60 p-4 rounded-2xl border border-slate-850 space-y-3.5">
                    {/* Card Status */}
                    <div className="flex flex-col">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Card Status</span>
                      <span className={`text-[12px] font-extrabold px-2.5 py-1 rounded-md inline-block uppercase w-fit mt-1 shadow-sm ${
                        showDistributionModal.status === 'found'
                          ? 'bg-cyan-600 text-white border border-cyan-700'
                          : showDistributionModal.status === 'missing'
                          ? 'bg-red-600 text-white border border-red-700'
                          : 'bg-emerald-600 text-white border border-emerald-700'
                      }`}>
                        {showDistributionModal.status === 'found' ? 'FOUND' : (showDistributionModal.status === 'missing' ? 'MISSING' : 'DISTRIBUTED')}
                      </span>
                    </div>

                    {showDistributionModal.status === 'found' && (
                      <>
                        <div className="grid grid-cols-2 gap-3 border-t border-slate-800 pt-2.5">
                          <div className="flex flex-col">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Found Date</span>
                            <span className="text-white font-black text-sm mt-0.5">{showDistributionModal.foundDate || '---'}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Found Time</span>
                            <span className="text-white font-black text-sm mt-0.5">{showDistributionModal.foundTime || '---'}</span>
                          </div>
                        </div>
                        <div className="flex flex-col border-t border-slate-800 pt-2.5">
                          <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Found By</span>
                          <span className="text-white font-black text-sm mt-0.5 uppercase tracking-wide">
                            {showDistributionModal.recoveredBy || showDistributionModal.foundBy || '---'}
                          </span>
                        </div>
                      </>
                    )}

                    {/* 1. Full Name */}
                    <div className="flex flex-col border-t border-slate-800 pt-2.5">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Full Name</span>
                      <span className="text-white font-black text-[15px] uppercase mt-0.5 tracking-tight">{showDistributionModal.fullName}</span>
                    </div>

                    {/* 2. License No. */}
                    <div className="flex flex-col border-t border-slate-800 pb-2.5 pt-2.5">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">License No.</span>
                      <span className="text-cyan-400 font-mono font-black text-base mt-0.5 uppercase tracking-wide">{showDistributionModal.licenseNumber}</span>
                    </div>

                    {/* 3. Requested Date */}
                    <div className="flex flex-col border-t border-slate-800 pb-2.5 pt-2.5">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Requested Date</span>
                      <span className="text-white font-black text-sm mt-0.5">
                        {reqDate ? formatDate(reqDate) : '---'}
                      </span>
                    </div>

                    {/* 4. Distributed Date */}
                    <div className="flex flex-col border-t border-slate-800 pb-2.5 pt-2.5">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Distributed Date</span>
                      <span className="text-white font-black text-sm mt-0.5">
                        {displayDistDate}
                      </span>
                    </div>

                    {/* 5. Distributed to: */}
                    <div className="flex flex-col border-t border-slate-800 pb-2.5 pt-2.5">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Distributed To</span>
                      <span className="text-cyan-400 font-black text-sm mt-0.5 uppercase tracking-wide">
                        {showDistributionModal.receivedBy || 'Applicant (Self)'}
                      </span>
                    </div>

                    {/* 6. Distributed By: */}
                    <div className="flex flex-col border-t border-slate-800 pb-2.5 pt-2.5">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Distributed By</span>
                      <span className="text-white font-black text-sm mt-0.5 uppercase tracking-wide">
                        {distUserName}
                      </span>
                    </div>

                    {/* 7. Recommended By */}
                    <div className="flex flex-col border-t border-slate-800 pb-2.5 pt-2.5">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Recommended By</span>
                      <span className="text-white font-black text-sm mt-0.5 uppercase tracking-wide">
                        {showDistributionModal.recommendedStaffName || showDistributionModal.recommended_staff_name || 'Not Applicable'}
                      </span>
                    </div>

                    {/* 8. Submitted Documents */}
                    <div className="flex flex-col border-t border-slate-800 pt-2.5">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2">Submitted Documents</span>
                      {showDistributionModal.submittedDocs && showDistributionModal.submittedDocs.length > 0 ? (
                        <div className="space-y-2">
                          {showDistributionModal.submittedDocs.map((docName, idx) => {
                            const isRecommendation = docName === 'Office Staff Recommendation';
                            const isOther = docName === 'Other';
                            const recName = showDistributionModal.recommendedStaffName || showDistributionModal.recommended_staff_name;
                            const otherText = showDistributionModal.submittedDocsOther;

                            return (
                              <div key={idx} className="flex flex-col">
                                <div className="flex items-center gap-1.5 font-bold text-xs sm:text-sm text-emerald-400">
                                  <span className="text-emerald-400 font-extrabold">✓</span> {docName}
                                </div>
                                {isRecommendation && recName && (
                                  <div className="pl-5 text-xs text-slate-300 font-medium mt-0.5">
                                    Recommended By:<br />
                                    <span className="font-bold text-white text-xs">{recName}</span>
                                  </div>
                                )}
                                {isOther && otherText && (
                                  <div className="pl-5 text-xs text-slate-300 font-medium mt-0.5">
                                    Other Document:<br />
                                    <span className="font-bold text-white text-xs">{otherText}</span>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-slate-500 font-medium text-xs">Not Applicable</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setShowDistributionModal(null)}
                className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer border border-slate-700 hover:border-slate-600"
              >
                Close Receipt
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Entry Form Modal Pop-up */}
      {showAddForm && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-45 animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 text-white rounded-2xl sm:rounded-3xl max-w-lg w-full p-4 sm:p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto scrollbar-none">
            <button 
              onClick={() => setShowAddForm(false)}
              className="absolute right-5 top-5 text-slate-500 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
            
            <div className="mb-4">
              <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider block">Manual Entry Form</span>
              <h3 className="text-lg font-bold text-white mt-1">Create New Driving License Record</h3>
              <p className="text-xs text-slate-400 mt-1">Directly supplement the ledger matching physical document batches</p>
            </div>

            <form onSubmit={handleCreateLicense} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Applicant ID *</label>
                  <HistoryAutocompleteField
                    historyKey="applicant_id_history"
                    type="text"
                    required
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    placeholder="e.g. 01-09-00998811"
                    className="w-full bg-slate-950 border border-slate-800 px-3.5 py-2 rounded-xl text-xs text-white focus:outline-hidden focus:border-cyan-500 placeholder-slate-500"
                    theme={theme}
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">License Number *</label>
                  <HistoryAutocompleteField
                    historyKey="license_number_history"
                    type="text"
                    required
                    value={licenseNo}
                    onChange={(e) => setLicenseNo(e.target.value)}
                    isLicenseNumberMask={true}
                    placeholder="e.g. 01-12-99881122"
                    className="w-full bg-slate-950 border border-slate-800 px-3.5 py-2 rounded-xl text-xs text-white focus:outline-hidden focus:border-cyan-500 placeholder-slate-500"
                    theme={theme}
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Applicant's Full Name *</label>
                <HistoryAutocompleteField
                  historyKey="full_name_history"
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Harun Or Rashid"
                  className="w-full bg-slate-950 border border-slate-800 px-3.5 py-2.5 rounded-xl text-xs text-white focus:outline-hidden focus:border-cyan-500 placeholder-slate-500"
                  theme={theme}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Vehicle Category</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 px-3.5 py-2.5 rounded-xl text-xs text-white focus:outline-hidden focus:border-cyan-500 font-medium"
                  >
                    <option value="A">Class A (Motorcycle / Scooter)</option>
                    <option value="B">Class B (Car / Jeep / Delivery Van)</option>
                    <option value="C">Class C (Tempo / Auto-rickshaw)</option>
                    <option value="LTV">Class LTV (Light Passenger / Cargo Vehicle)</option>
                    <option value="HTV">Class HTV (Heavy Duty Truck / Bus)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Representative Pickup Day</label>
                  <select
                    value={visitDay}
                    onChange={(e) => setVisitDay(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 px-3.5 py-2.5 rounded-xl text-xs text-white focus:outline-hidden focus:border-cyan-500 font-medium"
                  >
                    <option value="Sunday">Sunday (आईतवार)</option>
                    <option value="Monday">Monday (सोमवार)</option>
                    <option value="Tuesday">Tuesday (मंगलवार)</option>
                    <option value="Wednesday">Wednesday (बुधवार)</option>
                    <option value="Thursday">Thursday (बिहीवार)</option>
                    <option value="Friday">Friday (शुक्रवार)</option>
                  </select>
                </div>
              </div>

              <div className="pt-4 flex justify-end gap-2.5 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-xl text-xs font-bold transition-all border border-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addLoading}
                  className="px-6 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-bold shadow-lg transition-all disabled:opacity-50"
                >
                  {addLoading ? "Creating..." : "Save License Record"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteDialog && deleteDialog.show && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 text-white rounded-2xl p-6 max-w-sm w-full shadow-2xl relative">
            <h3 className="text-sm font-black uppercase text-rose-500 tracking-wider">⚠️ Permanent Deletion</h3>
            <p className="text-xs text-slate-350 mt-2.5 leading-relaxed">
              Are you sure you want to permanently delete the license record for <strong className="text-white">{deleteDialog.licNo}</strong>? This administrative transaction is irreversible.
            </p>
            {dialogError && (
              <p className="text-[11px] text-rose-450 bg-rose-950/20 border border-rose-900/30 p-2 rounded-lg mt-2">{dialogError}</p>
            )}
            <div className="mt-5 flex justify-end gap-3.5 border-t border-slate-800 pt-4">
              <button
                type="button"
                onClick={() => setDeleteDialog(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-705 text-xs font-bold rounded-xl transition-all border border-slate-700 hover:border-slate-650 cursor-pointer text-slate-350"
              >
                No, Cancel
              </button>
              <button
                type="button"
                disabled={deleteLoading}
                onClick={executeDeleteLicense}
                className="px-5 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-black uppercase tracking-wider rounded-xl transition-all cursor-pointer active:scale-95 disabled:opacity-50"
              >
                {deleteLoading ? 'Deleting...' : 'Yes, Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {promptDialog && promptDialog.show && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 text-white rounded-2xl p-6 max-w-md w-full shadow-2xl relative font-sans">
            <h3 className="text-sm font-black uppercase text-cyan-405 text-cyan-405 text-cyan-400 tracking-wider">✍️ Physical Signature Handover</h3>
            <p className="text-xs text-slate-350 mt-2 leading-relaxed">
              Updating license state of <span className="text-white font-bold">{promptDialog.lic.fullName} ({promptDialog.lic.licenseNumber})</span> to <strong className="text-emerald-400 font-extrabold">DISTRIBUTED</strong>.
            </p>
            
            <div className="mt-4">
              <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1.5 font-sans">Citizen/Representative Name (Signature Receipt)*</label>
              <HistoryAutocompleteField
                historyKey="handover_name_history"
                type="text"
                required
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                placeholder="Name of person taking physical delivery"
                className="w-full bg-slate-950 border border-slate-800 px-3.5 py-2.5 rounded-xl text-xs text-white focus:outline-hidden focus:border-cyan-500 placeholder-slate-600"
                theme={theme}
              />
            </div>

            {dialogError && (
              <p className="text-[11px] text-rose-455 p-2 rounded-lg mt-2 bg-rose-955/20 border border-rose-900/30 text-rose-400">{dialogError}</p>
            )}

            <div className="mt-5 flex justify-end gap-3.5 border-t border-slate-800 pt-4">
              <button
                type="button"
                onClick={() => setPromptDialog(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-705 text-xs font-bold rounded-xl transition-all border border-slate-700 hover:border-slate-650 cursor-pointer text-slate-350"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={promptLoading || !promptValue.trim()}
                onClick={() => executeLicenseStatusUpdate(promptDialog.lic, promptDialog.newStatus, promptDialog.remark, promptValue.trim())}
                className="px-5 py-2 bg-emerald-605 hover:bg-emerald-500 text-white text-xs font-black uppercase tracking-wider rounded-xl transition-all cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {promptLoading ? 'Saving...' : 'Confirm Delivery'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mark Card as Missing Popup Dialog */}
      {showMarkMissingModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 text-white rounded-2xl sm:rounded-3xl max-w-md w-full p-4 sm:p-6 shadow-2xl relative animate-in zoom-in-95 duration-150 max-h-[92vh] overflow-y-auto scrollbar-none">
            <button 
              onClick={() => {
                setShowMarkMissingModal(null);
                setMissingMobile('');
                setMissingMobileError('');
              }}
              className="absolute right-5 top-5 text-slate-500 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
            
            <div className="mb-4 border-b border-slate-800 pb-3">
              <span className="text-[10px] text-red-400 font-extrabold uppercase tracking-widest block mb-1">PLSMS Registry Action</span>
              <h3 className="text-xl font-black text-white tracking-tight">Report Card as Missing</h3>
            </div>

            <div className="space-y-4">
              <div className="bg-slate-950/60 p-4 rounded-2xl border border-slate-850 space-y-3">
                <span className="text-xs font-black text-red-500 block mb-1 uppercase tracking-wider">🔒 CURRENT CARD LEDGER DETAILS</span>
                
                {/* 1. Full Name */}
                <div className="flex items-center gap-2 py-1.5 border-b border-slate-900/40">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest">FULL NAME:</span>
                  <span className="text-white font-black text-sm uppercase truncate max-w-[240px]" title={showMarkMissingModal.fullName}>
                    {showMarkMissingModal.fullName}
                  </span>
                </div>

                {/* 2. Applicant ID */}
                <div className="flex items-center gap-2 py-1.5 border-b border-slate-900/40">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest">APPLICANT ID:</span>
                  <span className="text-white font-mono font-black text-sm uppercase">
                    {showMarkMissingModal.applicantId}
                  </span>
                </div>

                {/* 3. License No. */}
                <div className="flex items-center gap-2 py-1.5 border-b border-slate-900/40">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest">LICENSE NO.:</span>
                  <span className="text-cyan-400 font-mono font-black text-sm uppercase">
                    {showMarkMissingModal.licenseNumber}
                  </span>
                </div>

                {/* 5. Category */}
                <div className="flex items-center gap-2 py-1.5 border-b border-slate-900/40">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest">CATEGORY:</span>
                  <span className="px-1.5 py-0.5 text-xs font-black uppercase text-blue-400 border border-blue-900/70 bg-blue-950/40 rounded shadow-xs font-sans">
                    {showMarkMissingModal.category || 'A'}
                  </span>
                </div>

                {/* 6. Distribution Date */}
                <div className="flex items-center gap-2 py-1.5">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest">DISTRIBUTION DATE:</span>
                  <span className="text-white font-black text-sm">
                    {showMarkMissingModal.updatedAt ? formatDate(showMarkMissingModal.updatedAt) : '---'}
                  </span>
                </div>
              </div>

              {/* Compulsory Input field: Mobile Number */}
              <div className="space-y-1.5">
                <label className="block text-[10.5px] uppercase font-extrabold text-slate-400 tracking-wider">
                  Contact Mobile Number (10 Digits) <span className="text-red-500 font-black">*</span>
                </label>
                <div className="relative">
                  <input
                    type="tel"
                    required
                    maxLength={10}
                    value={missingMobile}
                    onChange={(e) => {
                      const clean = e.target.value.replace(/\D/g, '').slice(0, 10);
                      setMissingMobile(clean);
                      if (!clean) {
                        setMissingMobileError('Mobile Number is required.');
                      } else if (clean.length !== 10) {
                        setMissingMobileError('Mobile number must be exactly 10 digits.');
                      } else {
                        setMissingMobileError('');
                      }
                    }}
                    placeholder="Enter 10-digit mobile number (e.g. 9841234567)"
                    className={`w-full bg-slate-950 border px-3.5 py-2.5 rounded-xl text-xs text-white focus:outline-hidden focus:border-red-500 placeholder-slate-600 font-semibold font-mono ${
                      missingMobileError ? 'border-red-500 ring-1 ring-red-500/20' : 'border-slate-800'
                    }`}
                  />
                </div>
                {missingMobileError && (
                  <p className="text-[10.5px] text-red-400 font-bold tracking-tight animate-pulse">
                    ❌ {missingMobileError}
                  </p>
                )}
                <p className="text-[9.5px] text-slate-500 leading-normal">
                  Providing a valid 10-digit mobile number is compulsory before we can dispatch notifications and register this record in the secondary missing index.
                </p>
              </div>
            </div>

            {/* Actions Footer */}
            <div className="mt-5 flex justify-end gap-3 border-t border-slate-800 pt-4">
              <button
                type="button"
                onClick={() => {
                  setShowMarkMissingModal(null);
                  setMissingMobile('');
                  setMissingMobileError('');
                }}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-705 text-xs font-bold rounded-xl transition-all border border-slate-700 hover:border-slate-650 cursor-pointer text-slate-350"
              >
                No, Cancel
              </button>
              <button
                type="button"
                disabled={promptLoading || missingMobile.replace(/\D/g, '').length !== 10}
                onClick={() => executeMarkAsMissing(showMarkMissingModal)}
                className="px-5 py-2 bg-red-650 bg-red-600 hover:bg-red-550 text-white text-xs font-black uppercase tracking-wider rounded-xl transition-all cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg hover:shadow-red-900/20"
              >
                {promptLoading ? 'Dispatching...' : 'SEND TO MISSING CARDS LIST'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Found Popup Dialog */}
      {showConfirmFoundModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 text-white rounded-2xl sm:rounded-3xl max-w-md w-full p-4 sm:p-6 shadow-2xl relative animate-in zoom-in-95 duration-150 max-h-[92vh] overflow-y-auto scrollbar-none">
            <button 
              onClick={() => {
                setShowConfirmFoundModal(null);
                setFoundReceiverName('');
                setFoundReceiverNameError('');
                setFoundSelectedDocs([]);
                setFoundRecommendedStaffName('');
                setFoundRemarks('');
                setFoundRemarksError('');
              }}
              className="absolute right-5 top-5 text-slate-500 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
            
            <div className="mb-4 border-b border-slate-800 pb-3">
              <span className="text-[10px] text-cyan-400 font-extrabold uppercase tracking-widest block mb-1">PLSMS Registry Action</span>
              <h3 className="text-xl font-black text-white tracking-tight">Confirm Found Card</h3>
            </div>

            <div className="space-y-4">
              {/* Smart Card details inside a neat panel */}
              <div className="bg-slate-955/40 p-3.5 rounded-xl border border-slate-800/80 space-y-2.5">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-450 uppercase font-bold tracking-wider text-[10px]">License Number:</span>
                  <span className="font-mono font-bold text-cyan-400">{showConfirmFoundModal.licenseNumber}</span>
                </div>
                <div className="flex justify-between items-center text-xs border-t border-slate-800/50 pt-2">
                  <span className="text-slate-450 uppercase font-bold tracking-wider text-[10px]">Card Holder Name:</span>
                  <span className="font-bold text-white">{showConfirmFoundModal.fullName}</span>
                </div>
                <div className="flex justify-between items-center text-xs border-t border-slate-800/50 pt-2">
                  <span className="text-slate-450 uppercase font-bold tracking-wider text-[10px]">Applicant ID:</span>
                  <span className="font-mono text-slate-300 font-bold">{showConfirmFoundModal.applicantId || '---'}</span>
                </div>
                <div className="flex justify-between items-center text-xs border-t border-slate-800/50 pt-2">
                  <span className="text-slate-450 uppercase font-bold tracking-wider text-[10px]">Found Date:</span>
                  <span className="font-bold text-white">{foundDateInput}</span>
                </div>
                <div className="flex justify-between items-center text-xs border-t border-slate-800/50 pt-2">
                  <span className="text-slate-450 uppercase font-bold tracking-wider text-[10px]">Found Time:</span>
                  <span className="font-bold text-white">{foundTimeInput}</span>
                </div>
                <div className="flex justify-between items-center text-xs border-t border-slate-800/50 pt-2">
                  <span className="text-slate-450 uppercase font-bold tracking-wider text-[10px]">Found By:</span>
                  <span className="text-slate-300 font-semibold max-w-[200px] truncate">{auth.currentUser?.email || userEmail || 'staff@plsms.gov.bd'}</span>
                </div>
              </div>

              {/* Submitted Documents Options */}
              <div className="space-y-2">
                <p className="text-[11px] font-extrabold text-slate-300 uppercase tracking-wider">
                  SELECT DOCUMENT SUBMITTED BY THE RECEIVER.
                </p>
                <div className="space-y-2">
                  {[
                    { key: 'Original Smart Card', label: 'Original Smart Card' },
                    { key: 'Citizenship', label: 'Citizenship' },
                    { key: 'Traffic Police Letter', label: 'Traffic Police Letter' },
                    { key: 'Office Staff Recommendation', label: 'Office Staff Recommendation' }
                  ].map((option) => {
                    const isChecked = foundSelectedDocs.includes(option.key);
                    return (
                      <div key={option.key} className="space-y-1.5">
                        <label className={`flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer ${
                          isChecked 
                            ? 'bg-cyan-950/50 border-cyan-500/80 text-cyan-200'
                            : 'bg-slate-955/60 border-slate-800/80 hover:border-slate-700 text-slate-300'
                        }`}>
                          <input
                            type="radio"
                            name="submittedDocOption"
                            checked={isChecked}
                            onChange={() => {
                              setFoundSelectedDocs([option.key]);
                              if (option.key !== 'Office Staff Recommendation') {
                                setFoundRecommendedStaffName('');
                              }
                            }}
                            className="h-4 w-4 border-slate-700 text-cyan-500 focus:ring-cyan-500 accent-cyan-500 cursor-pointer"
                          />
                          <span className="text-xs font-bold">{option.label}</span>
                        </label>

                        {option.key === 'Office Staff Recommendation' && isChecked && (
                          <div className="pl-7 pr-1 pt-1 animate-fade-in">
                            <label className="block text-[10px] font-extrabold text-slate-400 mb-1 uppercase tracking-wider">
                              Recommended By (Office Staff Name) <span className="text-rose-500 font-black">*</span>
                            </label>
                            <input
                              type="text"
                              required
                              value={foundRecommendedStaffName}
                              onChange={(e) => {
                                setFoundRecommendedStaffName(e.target.value);
                                if (e.target.value.trim()) {
                                  setFoundRecommendedStaffNameError('');
                                }
                              }}
                              placeholder="Enter office staff name..."
                              className={`w-full bg-slate-950 border px-3.5 py-2 rounded-xl text-xs text-white focus:outline-hidden placeholder-slate-600 font-semibold ${
                                foundRecommendedStaffNameError ? 'border-red-500 ring-1 ring-red-500/20' : 'border-slate-800 focus:border-cyan-500'
                              }`}
                            />
                            {foundRecommendedStaffNameError && (
                              <p className="text-[10.5px] text-red-400 font-bold mt-1.5 animate-pulse">
                                ❌ {foundRecommendedStaffNameError}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Compulsory Input field: Receiver Name */}
              <div className="space-y-1.5">
                <label className="block text-[10.5px] uppercase font-extrabold text-slate-400 tracking-wider">
                  Receiver Name <span className="text-rose-500 font-black">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={foundReceiverName}
                  onChange={(e) => {
                    setFoundReceiverName(e.target.value);
                    if (e.target.value.trim()) {
                      setFoundReceiverNameError('');
                    }
                  }}
                  placeholder="Enter the name of the person receiving the found Smart Card."
                  className={`w-full bg-slate-950 border px-3.5 py-2.5 rounded-xl text-xs text-white focus:outline-hidden focus:border-cyan-500 placeholder-slate-600 font-semibold ${
                    foundReceiverNameError ? 'border-red-500 ring-1 ring-red-500/20' : 'border-slate-800'
                  }`}
                />
                {foundReceiverNameError && (
                  <p className="text-[10.5px] text-red-400 font-bold mt-1.5 animate-pulse">
                    ❌ {foundReceiverNameError}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-3 border-t border-slate-800 pt-4">
              <button
                type="button"
                onClick={() => {
                  setShowConfirmFoundModal(null);
                  setFoundReceiverName('');
                  setFoundReceiverNameError('');
                  setFoundSelectedDocs([]);
                  setFoundRecommendedStaffName('');
                  setFoundRecommendedStaffNameError('');
                  setFoundRemarks('');
                  setFoundRemarksError('');
                }}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-705 text-xs font-bold rounded-xl transition-all border border-slate-700 hover:border-slate-650 cursor-pointer text-slate-350"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  confirmFoundLoading ||
                  !foundReceiverName.trim() ||
                  (foundSelectedDocs.includes('Office Staff Recommendation') && !foundRecommendedStaffName.trim())
                }
                onClick={() => executeConfirmFound(showConfirmFoundModal)}
                className="px-5 py-2 bg-cyan-600 hover:bg-cyan-550 text-white text-xs font-black uppercase tracking-wider rounded-xl transition-all cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg hover:shadow-cyan-900/20"
              >
                {confirmFoundLoading ? 'Recording...' : 'Save & Mark as Found'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Floating Export Status Toast Notification */}
      {exportNotification && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 rounded-2xl shadow-2xl border backdrop-blur-md transition-all animate-in slide-in-from-bottom-5 duration-200 text-sm font-semibold bg-slate-900/90 text-white border-slate-700">
          <div className={`w-2.5 h-2.5 rounded-full ${
            exportNotification.type === 'info' ? 'bg-cyan-400 animate-ping' :
            exportNotification.type === 'success' ? 'bg-emerald-400' : 'bg-amber-400'
          }`} />
          <span>{exportNotification.message}</span>
        </div>
      )}
      </div>
    </SmartCardDashboard>
  );
}

