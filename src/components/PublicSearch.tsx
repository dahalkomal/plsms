import React, { useState, useEffect } from 'react';
import { HistoryAutocompleteField } from './HistoryAutocompleteField';
import { HistorySuggestionService } from '../utils/HistorySuggestionService';
import { isLicenseMatch, nepaliToEnglishDigits } from '../utils/licenseNormalizer';
import { auth } from '../firebase';
import { getLicenseById, getLicenseByLicenseNumber, incrementSearchesServed, createCollectionRequest, createOrUpdateLicense, getAllUserRoles, resolveStaffName, isLicenseDistributed } from '../dbService';
import { License, CollectionRequest, AppRole } from '../types';
import { sanitizeInputString, sanitizeErrorMessage, checkRateLimit } from '../utils/securitySanitizer';
import { Search, Calendar, Phone, Clipboard, CheckCircle, Clock, AlertCircle, HelpCircle, FileText, Send, User, MapPin, ShieldCheck } from 'lucide-react';
import { registryDataStore } from '../registryDataStore';
import { convertADToBS } from '../utils/dateConverter';

function getNepaliWeekday(dayStr: string | undefined): string {
  if (!dayStr) return 'आईतबार';
  const clean = dayStr.trim().toLowerCase();
  if (clean === 'sunday' || clean.includes('sun')) return 'आईतबार';
  if (clean === 'monday' || clean.includes('mon')) return 'सोमबार';
  if (clean === 'tuesday' || clean.includes('tue')) return 'मंगलबार';
  if (clean === 'wednesday' || clean.includes('wed')) return 'बुधबार';
  if (clean === 'thursday' || clean.includes('thu')) return 'बिहीबार';
  if (clean === 'friday' || clean.includes('fri')) return 'शुक्रबार';
  if (clean === 'saturday' || clean.includes('sat')) return 'शनिबार';
  return dayStr;
}

function getCodeNo(applicantId: string | undefined): string {
  if (!applicantId) return '133';
  const clean = applicantId.trim();
  if (clean === '8628075') return '133';
  const num = parseInt(clean.replace(/\D/g, ''), 10);
  if (!isNaN(num)) {
    return String((num % 899) + 100);
  }
  return '133';
}

interface PublicSearchProps {
  officeName: string;
  officeAddress?: string;
  officeLogo?: string;
  bannerText: string;
  contactNumber: string;
  onSearchExecuted: () => void;
  theme?: 'light' | 'dark';
  currentRole?: AppRole;
  userEmail?: string;
}

export default function PublicSearch({ 
  officeName, 
  officeAddress,
  officeLogo,
  bannerText, 
  contactNumber, 
  onSearchExecuted, 
  theme = 'dark',
  currentRole = 'public',
  userEmail = ''
}: PublicSearchProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchError, setSearchError] = useState('');
  const [lastSearchedQuery, setLastSearchedQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [licenseMatch, setLicenseMatch] = useState<License | null>(null);

  const performSearchMatch = (query: string, sourceRecords: License[]): License | null => {
    if (!query || !query.trim()) return null;

    const match = sourceRecords.find(lic => isLicenseMatch(query, lic));

    let processedMatch = match || null;
    if (processedMatch) {
      if (isLicenseDistributed(processedMatch) && processedMatch.status !== 'missing' && processedMatch.status !== 'found') {
        processedMatch = {
          ...processedMatch,
          status: 'distributed' as const
        };
      }
    }
    return processedMatch;
  };

  useEffect(() => {
    const unsubscribe = registryDataStore.subscribe((records) => {
      if (searched && searchQuery.trim() && licenseMatch) {
        const matchingRecord = records.find(r => r.id === licenseMatch.id || (r.licenseNumber && r.licenseNumber === licenseMatch.licenseNumber));
        if (matchingRecord) {
          const isDist = isLicenseDistributed(matchingRecord);
          const newStatus = isDist && matchingRecord.status !== 'missing' && matchingRecord.status !== 'found' ? ('distributed' as const) : matchingRecord.status;
          
          setLicenseMatch(prev => {
            if (!prev) return null;
            if (prev.id === matchingRecord.id && prev.status === newStatus && prev.receivedBy === matchingRecord.receivedBy) {
              return prev;
            }
            return {
              ...matchingRecord,
              status: newStatus
            };
          });
        }
      }
    });
    return () => unsubscribe();
  }, [searched, searchQuery, licenseMatch?.id, licenseMatch?.licenseNumber]);

  // Users roles registry state
  const [usersRoles, setUsersRoles] = useState<any[]>([]);

  useEffect(() => {
    async function loadStaffRegistry() {
      try {
        const uList = await getAllUserRoles();
        setUsersRoles(uList);
      } catch (err) {
        console.warn("Could not load staff account registry roles in PublicSearch:", err);
      }
    }
    loadStaffRegistry();
  }, []);

  const resolveOperatorName = (email: string) => {
    return resolveStaffName(email, usersRoles);
  };

  const getLoggedInStaffInfo = () => {
    let email = '';

    // 1. Check live firebase auth
    if (auth.currentUser) {
      email = auth.currentUser.email || '';
    }

    // 2. Fallback to userEmail prop
    if (!email && userEmail) {
      email = userEmail;
    }

    if (!email) {
      return { email: '', displayName: '' };
    }

    const displayName = resolveStaffName(email, usersRoles);
    return { email, displayName };
  };

  // Verification Form states
  const [verified, setVerified] = useState(false);
  const [verifApplicantName, setVerifApplicantName] = useState('');
  const [verifReceiverName, setVerifReceiverName] = useState('');
  const [verifError, setVerifError] = useState('');
  
  // Custom receiver/collector name state for the direct available action box
  const [collectorName, setCollectorName] = useState('');

  // Submitted Documents states
  const [showDocsModal, setShowDocsModal] = useState(false);
  const [modalSelectedDocs, setModalSelectedDocs] = useState<string[]>([]);
  const [modalOtherText, setModalOtherText] = useState('');
  const [modalRecommendedStaffName, setModalRecommendedStaffName] = useState('');
  const [successNotification, setSuccessNotification] = useState<string | null>(null);

  const formatSavedDate = (dateStr: string | undefined) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    
    const day = date.getDate();
    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    const month = monthNames[date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
  };

  const handleOpenDocsModal = () => {
    if (licenseMatch) {
      setModalSelectedDocs(licenseMatch.submittedDocs || []);
      setModalOtherText(licenseMatch.submittedDocsOther || '');
      setModalRecommendedStaffName(licenseMatch.recommendedStaffName || licenseMatch.recommended_staff_name || '');
      setShowDocsModal(true);
    }
  };

  const handleSaveSubmittedDocs = async () => {
    if (!licenseMatch) return;

    if (modalSelectedDocs.length === 0) {
      alert("कृपया कम्तीमा एउटा पेस गरिएको कागजात अनिवार्य चयन गर्नुहोस् ! (Please select at least one submitted document)");
      return;
    }
    
    const finalReceiverName = collectorName.trim();
    if (!finalReceiverName) {
      alert("कृपया पहिले बुझिलिनेको नाम लेख्नुहोस् !");
      return;
    }

    if (modalSelectedDocs.includes('Office Staff Recommendation') && !modalRecommendedStaffName.trim()) {
      alert("Recommended By (Office Staff Name) is mandatory when 'Office Staff Recommendation' is selected.");
      return;
    }

    try {
      const { email: staffEmail, displayName: staffName } = getLoggedInStaffInfo();
      const finalEmail = staffEmail || 'Public Search Handover Desk';
      const finalName = staffName || 'Public Handover Desk';
      const timestamp = new Date().toISOString();
      const now = new Date();
      const savedDate = convertADToBS(now);
      const savedTime = now.toLocaleTimeString('en-US', { hour12: true });

      const updated = {
        ...licenseMatch,
        status: 'distributed' as const,
        receivedBy: finalReceiverName,
        submittedDocs: modalSelectedDocs,
        submittedDocsOther: '',
        recommendedStaffName: modalSelectedDocs.includes('Office Staff Recommendation') ? modalRecommendedStaffName.trim() : '',
        recommended_staff_name: modalSelectedDocs.includes('Office Staff Recommendation') ? modalRecommendedStaffName.trim() : '',
        submittedDocsReceiverName: finalReceiverName,
        submittedDocsSavedBy: licenseMatch.submittedDocsSavedBy || finalEmail,
        submittedDocsSavedDate: licenseMatch.submittedDocsSavedDate || savedDate,
        submittedDocsSavedTime: licenseMatch.submittedDocsSavedTime || savedTime,
        distributedDate: licenseMatch.distributedDate || savedDate,
        submittedDocsUpdatedBy: finalEmail,
        submittedDocsUpdatedDate: timestamp,
        updatedAt: timestamp,
        updatedBy: finalEmail,
        distributedByStaffName: finalName
      };

      await createOrUpdateLicense(licenseMatch.id, updated);
      setLicenseMatch(updated);
      
      HistorySuggestionService.saveValue('handover_name_history', finalReceiverName);
      setShowDocsModal(false);
      setSuccessNotification("Submitted documents saved successfully!");
      setTimeout(() => setSuccessNotification(null), 5000);
    } catch (err: any) {
      alert("कागजातहरू सुरक्षित गर्न सकिएन: " + err.message);
    }
  };

  const handleResetSubmittedDocs = async () => {
    if (!licenseMatch) return;
    if (!window.confirm("के तपाईं पेश गरिएका कागजातहरू रिसेट गर्न निश्चित हुनुहुन्छ?")) {
      return;
    }

    try {
      const { email: staffEmail } = getLoggedInStaffInfo();
      const finalEmail = staffEmail || 'Public Search Handover Desk';
      const timestamp = new Date().toISOString();

      const updated = {
        ...licenseMatch,
        submittedDocs: [],
        submittedDocsOther: '',
        recommendedStaffName: '',
        recommended_staff_name: '',
        submittedDocsResetBy: finalEmail,
        submittedDocsResetDate: timestamp,
        submittedDocsUpdatedBy: finalEmail,
        submittedDocsUpdatedDate: timestamp,
        updatedAt: timestamp,
        updatedBy: finalEmail
      };

      await createOrUpdateLicense(licenseMatch.id, updated);
      setLicenseMatch(updated);
      setSuccessNotification("Submitted documents reset successfully!");
      setTimeout(() => setSuccessNotification(null), 5000);
    } catch (err: any) {
      alert("कागजातहरू रिसेट गर्न सकिएन: " + err.message);
    }
  };

  const handleResetReceiverInfo = async () => {
    if (!licenseMatch) return;
    if (!window.confirm("के तपाईं बुझिलिनेको विवरण रिसेट गर्न निश्चित हुनुहुन्छ?")) {
      return;
    }

    try {
      const { email: staffEmail } = getLoggedInStaffInfo();
      const finalEmail = staffEmail || 'Public Search Handover Desk';
      const timestamp = new Date().toISOString();

      const updated = {
        ...licenseMatch,
        status: 'available' as const,
        receivedBy: '',
        submittedDocsReceiverName: '',
        submittedDocs: [],
        submittedDocsOther: '',
        recommendedStaffName: '',
        recommended_staff_name: '',
        submittedDocsResetBy: finalEmail,
        submittedDocsResetDate: timestamp,
        updatedAt: timestamp,
        updatedBy: finalEmail
      };

      delete updated.distributedByStaffName;

      await createOrUpdateLicense(licenseMatch.id, updated);
      setLicenseMatch(updated);
      setCollectorName('');
      setSuccessNotification("Receiver information reset successfully!");
      setTimeout(() => setSuccessNotification(null), 5000);
    } catch (err: any) {
      alert("विवरण रिसेट गर्न सकिएन: " + err.message);
    }
  };

  useEffect(() => {
    if (licenseMatch) {
      setCollectorName(licenseMatch.receivedBy || '');
    } else {
      setCollectorName('');
    }
  }, [licenseMatch?.id, licenseMatch?.receivedBy]);

  // Collection request form state
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [receiverName, setReceiverName] = useState('');
  const [phone, setPhone] = useState('');
  const [visitDay, setVisitDay] = useState('Monday');
  const [remarks, setRemarks] = useState('');
  const [requestSubmitted, setRequestSubmitted] = useState(false);
  const [requestLoading, setRequestLoading] = useState(false);

  // Search execution (Section 5/7 Workflows)
  const handleLicenseSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const rawQuery = sanitizeInputString(searchQuery.trim(), 100);
    if (!rawQuery) return;

    // Rate Limiting Check: Max 30 searches per minute per client session
    const rateCheck = checkRateLimit('public_search', 30, 60000);
    if (!rateCheck.allowed) {
      setSearchError(`धेरै पटक खोजियो। कृपया ${rateCheck.retryAfterSec || 30} सेकेन्ड पछि प्रयास गर्नुहोस्। (Rate limit exceeded. Please wait ${rateCheck.retryAfterSec || 30}s)`);
      return;
    }

    const normQuery = nepaliToEnglishDigits(rawQuery);
    if (normQuery.length < 3) {
      setSearchError("कृपया कम्तीमा ३ अङ्क/अक्षर प्रविष्ट गर्नुहोस् (Please enter at least 3 characters)");
      setSearched(false);
      setLicenseMatch(null);
      return;
    }

    setSearchError('');
    setLastSearchedQuery(rawQuery);
    setSearching(true);
    setSearched(false);
    setLicenseMatch(null);
    setShowRequestForm(false);
    setRequestSubmitted(false);
    setVerified(false);
    setVerifApplicantName('');
    setVerifReceiverName('');
    setVerifError('');
    setCollectorName('');

    try {
      // Query Firestore directly using indexed licenseNumber field
      let processedMatch = await getLicenseByLicenseNumber(normQuery);

      if (processedMatch) {
        if (isLicenseDistributed(processedMatch) && processedMatch.status !== 'missing' && processedMatch.status !== 'found') {
          processedMatch = {
            ...processedMatch,
            status: 'distributed' as const
          };
        }
      }

      setLicenseMatch(processedMatch);
      setSearched(true);

      if (rawQuery) {
        HistorySuggestionService.saveValue('license_number_history', rawQuery);
      }

      // 2. Section 7 Visitor Counter: Increase Searches Served atomically ONLY if public user
      if (currentRole === 'public') {
        incrementSearchesServed().catch(err => console.warn("Visitor counter increment failed:", err));
      }

      onSearchExecuted();
    } catch (err: any) {
      alert(sanitizeErrorMessage(err, "Unable to perform search at this moment. Please check your network connection."));
    } finally {
      setSearching(false);
    }
  };

  const handleCreateCollectionRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!licenseMatch || !receiverName.trim() || !phone.trim()) return;

    setRequestLoading(true);
    try {
      const timestamp = new Date().toISOString();
      const requestId = 'req_' + Math.random().toString(36).substr(2, 9);
      
      const newRequest: CollectionRequest = {
        id: requestId,
        licenseId: licenseMatch.id,
        licenseHolderName: licenseMatch.fullName,
        licenseNumber: licenseMatch.licenseNumber,
        receiverName: receiverName.trim(),
        phoneNumber: phone.trim(),
        visitDay,
        remarks: remarks.trim() || '',
        status: 'pending',
        createdAt: timestamp,
      };

      await createCollectionRequest(requestId, newRequest);
      
      setRequestSubmitted(true);
      setShowRequestForm(false);
      setReceiverName('');
      setPhone('');
      setRemarks('');
    } catch (err: any) {
      alert("Scheduling collection queue failed: " + err.message);
    } finally {
      setRequestLoading(false);
    }
  };

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifApplicantName.trim()) {
      setVerifError('Applicant Name cannot be empty.');
      return;
    }
    if (!verifReceiverName.trim()) {
      setVerifError('Receiver/Collector Name (बुझिलिनेको नाम) cannot be empty.');
      return;
    }
    setVerifError('');
    setVerified(true);
  };

  const isOfficeUser = currentRole === 'superuser' || currentRole === 'admin' || currentRole === 'staff';

  return (
    <div className="space-y-4 max-w-full mx-auto font-sans pt-0 animate-fade-in relative">
      
      {/* Floating Saved Popup Toast Notification */}
      {successNotification && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-100 px-5 py-3 rounded-2xl bg-emerald-600 text-white font-black text-xs sm:text-sm md:text-base flex items-center gap-2.5 shadow-2xl border-2 border-emerald-300 animate-bounce">
          <CheckCircle className="w-5 h-5 text-white shrink-0" />
          <span>{successNotification}</span>
        </div>
      )}
      
      {/* Centered Website Header (Plain Text) */}
      <div className={`text-center py-1.5 sm:py-3.5 font-black tracking-normal xs:tracking-[0.05em] sm:tracking-[0.18em] text-[10.5px] xs:text-xs sm:text-sm md:text-base transition-colors uppercase mb-2 sm:mb-6 mt-1 leading-snug px-2 break-words whitespace-normal max-w-full font-sans ${
        theme === 'dark' ? 'text-slate-200' : 'text-slate-800'
      }`}>
        PRINTED LICENSE SEARCH MANAGEMENT SYSTEM (PLSMS)
      </div>

      {/* Citizen Search Panel */}
      <div className={`rounded-xl sm:rounded-2xl border-2 p-2.5 xs:p-4 sm:p-5.5 space-y-2.5 sm:space-y-4 transition-all duration-300 ${
        theme === 'dark' 
          ? 'bg-slate-900 border-slate-800 shadow-xl' 
          : 'bg-gradient-to-b from-white to-slate-50/40 border-blue-600 shadow-xl'
      }`}>
        <form onSubmit={handleLicenseSearch} className="space-y-2.5 sm:space-y-4">
          <div className="space-y-1 sm:space-y-2 text-center pb-0.5 sm:pb-1 overflow-hidden max-w-full">
            <p 
              className="text-[9px] xs:text-[11px] sm:text-sm tracking-normal sm:tracking-wide leading-relaxed block sm:whitespace-normal"
              style={{ 
                fontWeight: 900,
                color: theme === 'dark' ? '#ffffff' : '#334155'
              }}
            >
              <span className="block sm:inline">नोट: यस कार्यालयबाट नयाँ, वर्ग थप, नविकरण र प्रतिलिपिको सेवा लिइएका</span>
              <span className="block sm:inline"> License मात्र Search गर्नुहोस् ।</span>
            </p>
          </div>
          
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
            <div className="relative flex-1">
              <Search className={`absolute left-3 sm:left-4 top-[8.5px] sm:top-[13px] w-3.5 h-3.5 sm:w-5 sm:h-5 ${theme === 'dark' ? 'text-slate-500' : 'text-slate-400'}`} />
              <HistoryAutocompleteField
                historyKey="license_number_history"
                type="text"
                required
                value={searchQuery}
                onKeyPress={(e) => {
                  if (e.key === 'Enter') handleLicenseSearch(e);
                }}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (searchError) setSearchError('');
                }}
                isLicenseNumberMask={true}
                placeholder="Enter Your License Number As: (XX-XX-XXXXXXXX)"
                className={`w-full pl-8 sm:pl-12 pr-3 sm:pr-4 py-1.5 sm:py-2.5 text-[11px] xs:text-xs sm:text-[15px] placeholder:text-[8px] xs:placeholder:text-[9.5px] sm:placeholder:text-sm rounded-lg sm:rounded-2xl outline-hidden font-extrabold transition-all duration-200 ${
                  theme === 'dark' 
                    ? 'bg-slate-950 border border-slate-700/80 text-white placeholder:text-slate-700/35 placeholder:font-light focus:border-cyan-500' 
                    : 'bg-white border-2 border-purple-600 text-slate-800 placeholder:text-slate-400/35 placeholder:font-light focus:border-purple-800 focus:ring-4 focus:ring-purple-500/10'
                }`}
                theme={theme}
              />
            </div>
            
            <div className="flex gap-1.5 sm:gap-2.5">
              <button
                type="submit"
                disabled={searching || !searchQuery.trim()}
                className="flex-1 sm:flex-none px-2.5 xs:px-4 sm:px-6 py-1.5 sm:py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-black uppercase tracking-wider rounded-lg sm:rounded-2xl shadow-lg shadow-blue-500/20 active:scale-97 transition-all duration-150 disabled:opacity-50 text-[10.5px] xs:text-xs sm:text-[17px] cursor-pointer whitespace-nowrap"
              >
                {searching ? 'Querying...' : 'SEARCH'}
              </button>
 
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSearchError('');
                  setSearched(false);
                  setLicenseMatch(null);
                  setShowRequestForm(false);
                  setRequestSubmitted(false);
                }}
                className="flex-1 sm:flex-none px-2.5 xs:px-4 sm:px-6 py-1.5 sm:py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-black uppercase tracking-wider rounded-lg sm:rounded-2xl shadow-lg shadow-emerald-500/20 active:scale-97 transition-all duration-150 text-[10.5px] xs:text-xs sm:text-[17px] cursor-pointer whitespace-nowrap"
              >
                RESET
              </button>
            </div>
          </div>
        </form>

        {/* Searching Loader spinner */}
        {searching && (
          <div className="text-center py-6 text-slate-400 text-xs animate-pulse">Accessing database...</div>
        )}
      </div>

      {/* 12-Digit validation message */}
      {searchError && (
        <div className={`p-3 xs:p-3.5 sm:p-6 rounded-xl sm:rounded-3xl border transition-all animate-fade-in ${
          theme === 'dark' 
            ? 'bg-red-955/30 border-red-900/50 text-red-100 shadow-lg shadow-black/30' 
            : 'bg-red-50 border-red-200 text-red-950 shadow-sm'
        }`}>
          <div className="flex items-start gap-2 sm:gap-4">
            <div className="w-5 h-5 sm:w-7 sm:h-7 rounded-full bg-red-600 text-white flex items-center justify-center font-black text-[10px] sm:text-sm shrink-0 shadow-sm mt-0.5">
              ✕
            </div>
            <div className="space-y-0.5 sm:space-y-1.5 flex-1">
              <h4 className="text-xs xs:text-sm sm:text-lg font-black tracking-tight text-red-800 dark:text-red-400 font-sans">
                Enter your 12 digits license number
              </h4>
              <p className="text-[10px] xs:text-xs sm:text-base font-bold text-red-700 dark:text-red-300/90 leading-relaxed font-sans">
                कृपया १२ अंकको सही लाइसेन्स नम्बर प्रविष्ट गर्नुहोस् (Please enter a valid 12-digit license number).
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Search Result display container (Section 6 workflow) - Display Card just below Search box */}
      {searched && !searching && (
        licenseMatch ? (
          <div className={`rounded-xl sm:rounded-3xl border shadow-2xl p-4 sm:p-8 space-y-4 sm:space-y-6 animate-fade-in transition-all duration-300 ${
            theme === 'dark' 
              ? 'bg-[#0f172a] border-slate-800' 
              : 'bg-[#0284c7] border-sky-800 text-white'
          }`}>
            <div className="space-y-4 sm:space-y-6">
              {/* Centered Smart Card Status Header */}
              <div className="flex flex-col items-center justify-center text-center pb-1 sm:pb-2">
                <div className="flex items-center justify-center gap-2">
                  <span className={`text-xl sm:text-2xl font-black ${theme === 'dark' ? 'text-[#10b981]' : 'text-white'}`}>✓</span>
                  <span className={`text-base sm:text-xl font-black tracking-wide uppercase ${theme === 'dark' ? 'text-[#10b981]' : 'text-white'}`}>
                    Smart Card Found
                  </span>
                </div>
              </div>

              {/* Styled Bento Grid from second picture */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-4">
                {/* 1. APPLICANT ID */}
                <div className={`p-3 sm:p-4 rounded-xl sm:rounded-2xl border flex flex-col items-center justify-center text-center transition-all ${
                  theme === 'dark' 
                    ? 'bg-slate-950/40 border-slate-800' 
                    : 'bg-[#fce7f3] border-2 border-black shadow-md'
                }`}>
                  <span className={`block uppercase tracking-widest mb-1 sm:mb-1.5 ${
                    theme === 'dark' 
                      ? 'text-[9px] xs:text-[10px] sm:text-[11px] font-extrabold text-slate-400' 
                      : 'text-sm xs:text-base sm:text-lg text-slate-800 font-black'
                  }`}>
                    APPLICANT ID
                  </span>
                  <span 
                    className={`block font-mono tracking-wide uppercase ${
                      theme === 'dark' 
                        ? 'text-cyan-400 font-black text-sm xs:text-base sm:text-xl' 
                        : 'text-blue-600 font-black text-base xs:text-xl sm:text-2xl'
                    }`}
                    style={{ fontWeight: 900 }}
                  >
                    {licenseMatch.applicantId}
                  </span>
                </div>

                {/* 2. FULL NAME */}
                <div className={`p-3 sm:p-4 rounded-xl sm:rounded-2xl border flex flex-col items-center justify-center text-center transition-all ${
                  theme === 'dark' 
                    ? 'bg-slate-950/40 border-slate-800' 
                    : 'bg-[#fce7f3] border-2 border-black shadow-md'
                }`}>
                  <span className={`block uppercase tracking-widest mb-1 sm:mb-1.5 ${
                    theme === 'dark' 
                      ? 'text-[9px] xs:text-[10px] sm:text-[11px] font-extrabold text-slate-400' 
                      : 'text-sm xs:text-base sm:text-lg text-slate-800 font-black'
                  }`}>
                    FULL NAME
                  </span>
                  <span className={`block tracking-wide uppercase ${
                    theme === 'dark' 
                      ? 'text-blue-400 font-black text-sm xs:text-base sm:text-lg' 
                      : 'text-blue-600 font-black text-sm xs:text-base sm:text-lg'
                  }`}>
                    {licenseMatch.fullName}
                  </span>
                </div>

                {/* 3. LICENSE NUMBER */}
                <div className={`p-3 sm:p-4 rounded-xl sm:rounded-2xl border flex flex-col items-center justify-center text-center transition-all ${
                  theme === 'dark' 
                    ? 'bg-slate-950/40 border-slate-800' 
                    : 'bg-[#fce7f3] border-2 border-black shadow-md'
                }`}>
                  <span className={`block uppercase tracking-widest mb-1 sm:mb-1.5 ${
                    theme === 'dark' 
                      ? 'text-[9px] xs:text-[10px] sm:text-[11px] font-extrabold text-slate-400' 
                      : 'text-sm xs:text-base sm:text-lg text-slate-800 font-black'
                  }`}>
                    LICENSE NUMBER
                  </span>
                  <span 
                    className={`block font-mono tracking-wide uppercase ${
                      theme === 'dark' 
                        ? 'text-cyan-400 font-black text-sm xs:text-base sm:text-xl' 
                        : 'text-blue-600 font-black text-base xs:text-xl sm:text-2xl'
                    }`}
                    style={{ fontWeight: 900 }}
                  >
                    {licenseMatch.licenseNumber}
                  </span>
                </div>

                {/* 4. CATEGORY */}
                <div className={`p-3 sm:p-4 rounded-xl sm:rounded-2xl border flex flex-col items-center justify-center text-center transition-all ${
                  theme === 'dark' 
                    ? 'bg-slate-950/40 border-slate-800' 
                    : 'bg-[#fce7f3] border-2 border-black shadow-md'
                }`}>
                  <span className={`block uppercase tracking-widest mb-1 sm:mb-1.5 ${
                    theme === 'dark' 
                      ? 'text-[9px] xs:text-[10px] sm:text-[11px] font-extrabold text-slate-400' 
                      : 'text-sm xs:text-base sm:text-lg text-slate-800 font-black'
                  }`}>
                    CATEGORY
                  </span>
                  <span 
                    className={`block tracking-wide uppercase ${
                      theme === 'dark' 
                        ? 'text-emerald-400 font-black text-sm xs:text-base sm:text-xl' 
                        : 'text-blue-600 font-black text-sm xs:text-base sm:text-lg'
                    }`}
                    style={{ fontWeight: 900 }}
                  >
                    {licenseMatch.category || 'N/A'}
                  </span>
                </div>

                {/* 5. CODE NO */}
                <div className={`p-3 sm:p-4 rounded-xl sm:rounded-2xl border flex flex-col items-center justify-center text-center transition-all ${
                  theme === 'dark' 
                    ? 'bg-slate-950/40 border-slate-800' 
                    : 'bg-[#fce7f3] border-2 border-black shadow-md'
                }`}>
                  <span className={`block uppercase tracking-widest mb-1 sm:mb-1.5 ${
                    theme === 'dark' 
                      ? 'text-[9px] xs:text-[10px] sm:text-[11px] font-extrabold text-slate-400' 
                      : 'text-sm xs:text-base sm:text-lg text-slate-800 font-black'
                  }`}>
                    CODE NO
                  </span>
                  <span className={`block font-mono tracking-wide uppercase ${
                    theme === 'dark' 
                      ? 'text-blue-400 font-black text-sm xs:text-base sm:text-xl' 
                      : 'text-blue-600 font-black text-base xs:text-xl sm:text-2xl'
                  }`}
                  style={{ fontWeight: 900 }}
                  >
                    {isOfficeUser ? (
                      isLicenseDistributed(licenseMatch) ? (
                        licenseMatch.oldCode || licenseMatch.newCode ? (
                          <>
                            <span>{licenseMatch.oldCode || '---'}</span>
                            <span className="mx-1 text-slate-400 font-normal">/</span>
                            <span className="text-red-500 dark:text-red-500">{licenseMatch.newCode || '---'}</span>
                          </>
                        ) : (
                          <span className="text-red-500 dark:text-red-500">{getCodeNo(licenseMatch.applicantId)}</span>
                        )
                      ) : (
                        <span className="text-slate-400 dark:text-slate-500 text-xs font-semibold tracking-normal normal-case animate-pulse">
                          LOCKED (SAVE REQUIRED)
                        </span>
                      )
                    ) : (
                      <span className="text-slate-400 dark:text-slate-500 text-xs font-semibold tracking-normal normal-case">
                        OFFICE ONLY
                      </span>
                    )}
                  </span>
                </div>

                {/* 6. VISITING DAY */}
                <div className={`p-3 sm:p-4 rounded-xl sm:rounded-2xl border flex flex-col items-center justify-center text-center transition-all ${
                  theme === 'dark' 
                    ? 'bg-slate-950/40 border-slate-800' 
                    : 'bg-[#fce7f3] border-2 border-black shadow-md'
                }`}>
                  <span className={`block uppercase tracking-widest mb-1 sm:mb-1.5 ${
                    theme === 'dark' 
                      ? 'text-[9px] xs:text-[10px] sm:text-[11px] font-extrabold text-slate-400' 
                      : 'text-sm xs:text-base sm:text-lg text-slate-800 font-black'
                  }`}>
                    VISITING DAY
                  </span>
                  <span className={`block tracking-wide ${
                    theme === 'dark' 
                      ? 'text-purple-400 font-black text-sm xs:text-base sm:text-lg' 
                      : 'text-blue-600 font-black text-sm xs:text-base sm:text-lg'
                  }`}>
                    {getNepaliWeekday(licenseMatch.contactDepartment || licenseMatch.officeVisitDay)}
                  </span>
                </div>
              </div>

              {/* Direct Handover Desk Box at bottom of Found License */}
              {isOfficeUser && (() => {
                const isSuperUser = currentRole === 'superuser';
                const hasSavedReceiver = !!licenseMatch.receivedBy?.trim();
                const isInputDisabled = hasSavedReceiver && !isSuperUser;
                return (
                  <div className={`p-4 sm:p-5 rounded-2xl border transition-all mt-4 sm:mt-6 ${
                    theme === 'dark' ? 'bg-slate-900/60 border-amber-500/20' : 'bg-amber-50/25 border-amber-200'
                  }`}>
                    <p className={`text-xs font-semibold leading-relaxed mb-3 ${
                      theme === 'dark' ? 'text-slate-300' : 'text-slate-700'
                    }`}>
                      लाइसेन्स लिन आउने वा बुझिलिने व्यक्तिको नाम तलको कोठामा लेख्नुहोस् र सुरक्षित गर्नुहोस् ।
                    </p>

                    <div className="space-y-3">
                      <HistoryAutocompleteField
                        historyKey="handover_name_history"
                        type="text"
                        placeholder="बुझिलिनेको नाम लेख्नुहोस्............"
                        value={collectorName}
                        onChange={(e) => setCollectorName(e.target.value)}
                        disabled={isInputDisabled}
                        className={`w-full px-4 py-3 text-xs sm:text-sm font-semibold border rounded-xl outline-hidden focus:border-amber-500 transition-all ${
                          theme === 'dark' 
                            ? 'bg-slate-950 border-slate-800 text-white placeholder-slate-600 font-bold' 
                            : 'bg-white border-slate-200 text-slate-900 placeholder-slate-400 font-semibold'
                        } ${isInputDisabled ? 'opacity-60 cursor-not-allowed bg-slate-950/20' : ''}`}
                        theme={theme}
                      />

                      {/* 4 Action Buttons Row */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 pt-1">
                        {/* Button 1: Reset Input */}
                        <button
                          type="button"
                          disabled={isInputDisabled}
                          onClick={() => setCollectorName('')}
                          className={`w-full py-2.5 px-2.5 font-black text-xs sm:text-sm rounded-xl shadow-md transition-all cursor-pointer text-center border disabled:opacity-40 disabled:cursor-not-allowed ${
                            theme === 'dark'
                              ? 'bg-slate-800 hover:bg-slate-700 text-white border-slate-700'
                              : 'bg-white hover:bg-slate-100 text-slate-800 border-slate-300'
                          }`}
                        >
                          रिसेट (RESET) गर्नुहोस्
                        </button>

                        {/* Button 2: Use Driver Name */}
                        <button
                          type="button"
                          disabled={isInputDisabled}
                          onClick={() => setCollectorName(licenseMatch.fullName)}
                          className={`w-full py-2.5 px-2.5 font-black text-xs sm:text-sm rounded-xl shadow-md transition-all cursor-pointer text-center border disabled:opacity-40 disabled:cursor-not-allowed ${
                            theme === 'dark'
                              ? 'bg-slate-800 hover:bg-slate-700 text-white border-slate-700'
                              : 'bg-white hover:bg-slate-100 text-slate-800 border-slate-300'
                          }`}
                        >
                          सवारी चालकको नाम प्रयोग गर्नुहोस्
                        </button>

                        {/* Button 3: Submitted Documents */}
                        <button
                          type="button"
                          onClick={handleOpenDocsModal}
                          className={`w-full py-2.5 px-2.5 font-black text-xs sm:text-sm rounded-xl shadow-md transition-all cursor-pointer text-center flex items-center justify-center gap-1.5 ${
                            theme === 'dark'
                              ? 'bg-blue-600 hover:bg-blue-500 text-white'
                              : 'bg-blue-500 hover:bg-blue-600 text-white'
                          }`}
                        >
                          📄 Submitted Documents
                        </button>

                        {/* Button 4: Save */}
                        <button
                          type="button"
                          disabled={isInputDisabled}
                          onClick={async () => {
                            if (!isSuperUser && !collectorName.trim()) {
                              alert("कृपया बुझिलिनेको नाम लेख्नुहोस् !");
                              return;
                            }

                            const effectiveDocs = modalSelectedDocs.length > 0 ? modalSelectedDocs : (licenseMatch.submittedDocs || []);
                            if (effectiveDocs.length === 0) {
                              alert("कृपया पहिले 'Submitted Documents' बटनमा थिचेर कम्तीमा एउटा पेस गरिएको कागजात अनिवार्य चयन (Tick) गर्नुहोस् !");
                              handleOpenDocsModal();
                              return;
                            }

                            try {
                              const { email: staffEmail, displayName: staffName } = getLoggedInStaffInfo();
                              const finalEmail = staffEmail || 'Public Search Handover Desk';
                              const finalName = staffName || 'Public Handover Desk';
                              const now = new Date();
                              const savedDate = convertADToBS(now);
                              const savedTime = now.toLocaleTimeString('en-US', { hour12: true });
                              
                              const finalStatus = collectorName.trim() ? 'distributed' as const : 'available' as const;
                              
                              const updated = {
                                ...licenseMatch,
                                status: finalStatus,
                                receivedBy: collectorName.trim(),
                                submittedDocs: effectiveDocs,
                                submittedDocsOther: '',
                                recommendedStaffName: modalSelectedDocs.includes('Office Staff Recommendation') 
                                  ? modalRecommendedStaffName.trim() 
                                  : (licenseMatch.recommendedStaffName || licenseMatch.recommended_staff_name || ''),
                                recommended_staff_name: modalSelectedDocs.includes('Office Staff Recommendation') 
                                  ? modalRecommendedStaffName.trim() 
                                  : (licenseMatch.recommendedStaffName || licenseMatch.recommended_staff_name || ''),
                                submittedDocsReceiverName: collectorName.trim(),
                                submittedDocsSavedBy: licenseMatch.submittedDocsSavedBy || finalEmail,
                                submittedDocsSavedDate: licenseMatch.submittedDocsSavedDate || savedDate,
                                submittedDocsSavedTime: licenseMatch.submittedDocsSavedTime || savedTime,
                                distributedDate: licenseMatch.distributedDate || savedDate,
                                updatedAt: now.toISOString(),
                                updatedBy: finalEmail,
                                distributedByStaffName: finalName
                              };

                              await createOrUpdateLicense(licenseMatch.id, updated);
                              setLicenseMatch(updated);
                              HistorySuggestionService.saveValue('handover_name_history', collectorName.trim());
                              setSuccessNotification("विवरण सफलतापूर्वक सुरक्षित भयो!");
                              setTimeout(() => setSuccessNotification(null), 5000);
                            } catch (err: any) {
                              alert("त्रुटि: विवरण सुरक्षित गर्न सकिएन: " + err.message);
                            }
                          }}
                          className={`w-full py-2.5 px-2.5 font-black text-xs sm:text-sm uppercase tracking-wider rounded-xl shadow-lg transition-all cursor-pointer text-center disabled:opacity-40 disabled:cursor-not-allowed ${
                            theme === 'dark'
                              ? 'bg-amber-600 hover:bg-amber-500 text-white'
                              : 'bg-amber-500 hover:bg-amber-600 text-white'
                          }`}
                        >
                          सुरक्षित गर्नुहोस् (SAVE)
                        </button>
                      </div>

                      {/* Handover Summary Confirmation Message Box directly below 4 buttons */}
                      {hasSavedReceiver && (
                        <div className={`mt-3.5 p-3.5 sm:p-4 rounded-xl border transition-all animate-fade-in ${
                          theme === 'dark' ? 'bg-blue-955/50 border-blue-800/60 text-blue-100' : 'bg-blue-50/90 border-blue-200 text-blue-950 shadow-xs'
                        }`}>
                          <div className="flex items-center gap-2 mb-1.5">
                            <CheckCircle className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400 shrink-0" />
                            <span className="font-black text-xs sm:text-sm uppercase tracking-wider text-blue-700 dark:text-blue-400 font-sans">
                              ✔️ विवरण सुरक्षित भइसकेको जानकारी (Handover Details)
                            </span>
                          </div>
                          <div className="space-y-1 text-xs sm:text-sm font-extrabold font-sans leading-relaxed">
                            <p>
                              तपाईंको लाइसेन्स <span className="underline decoration-2 text-amber-600 dark:text-amber-400 font-black px-1">{licenseMatch.receivedBy || 'सम्बन्धित व्यक्ति'}</span> ले बुझिसक्नुभएको छ।
                            </p>
                            <p className="text-slate-700 dark:text-slate-300 font-semibold">
                              बुझाउने व्यक्ति (DISTRIBUTED BY): <strong className="text-cyan-700 dark:text-cyan-400 font-black uppercase tracking-wider px-1">
                                {licenseMatch.distributedByStaffName || resolveOperatorName(licenseMatch.updatedBy || '') || 'Public Handover Desk'}
                              </strong>
                              {(licenseMatch.submittedDocsSavedDate || licenseMatch.updatedDate) && (
                                <span className="ml-2 font-bold text-slate-500 dark:text-slate-400">[{convertADToBS(licenseMatch.submittedDocsSavedDate || licenseMatch.updatedDate)}]</span>
                              )}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* For general public, display the customized visiting/availability message, and omit the handover desk interface */}
              {!isOfficeUser && (
                <div className={`p-3 xs:p-4 sm:p-6 rounded-xl sm:rounded-2xl border transition-all mt-3 sm:mt-6 ${
                  theme === 'dark' 
                    ? 'bg-slate-900/40 border-emerald-500/20 text-emerald-100' 
                    : 'bg-gradient-to-r from-emerald-50/80 to-teal-50/50 border-emerald-200 text-emerald-950 shadow-xs'
                }`}>
                  <p className="text-[11px] xs:text-xs sm:text-base font-extrabold leading-relaxed text-center py-0.5 sm:py-1 font-sans">
                    तपाईको स्मार्ट कार्ड कार्यालयमा उपलब्ध छ । उक्त कार्ड लिनको लागि{' '}
                    <strong className="text-red-600 dark:text-red-400 font-black text-xs xs:text-sm sm:text-xl px-1 underline decoration-2 decoration-red-300 inline-block">
                      {getNepaliWeekday(licenseMatch.contactDepartment || licenseMatch.officeVisitDay)}
                    </strong>{' '}
                    आउनुहुन जानकारी गराईन्छ ।
                  </p>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Detailed Not Found Box exactly as requested */
          <div className={`mt-4 sm:mt-6 p-4 sm:p-6 rounded-xl sm:rounded-3xl border transition-all animate-fade-in ${
            theme === 'dark' 
              ? 'bg-red-955/30 border-red-900/50 text-red-100 shadow-lg shadow-black/30' 
              : 'bg-red-50/80 border-red-200 text-red-950 shadow-sm'
          }`}>
            <div className="flex items-start gap-3 sm:gap-4">
              <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-red-600 text-white flex items-center justify-center font-black text-xs sm:text-sm shrink-0 shadow-sm mt-0.5">
                ✕
              </div>
              <div className="space-y-1 sm:space-y-1.5 flex-1">
                <h4 className="text-[11px] xs:text-sm sm:text-lg font-black tracking-tight text-red-800 dark:text-red-400 font-sans">
                  तपाईंको लाइसेन्स कार्ड हाल कार्यालयमा उपलब्ध छैन !!
                </h4>
                <p className="text-[9.5px] xs:text-xs sm:text-sm md:text-base font-bold text-red-700 dark:text-red-300/90 leading-relaxed font-sans">
                  प्रविष्ट नम्बर: <span className="font-extrabold text-red-900 dark:text-red-200 underline decoration-1">{lastSearchedQuery || searchQuery}</span> को नवीकरण (Renewal) तथा नयाँ लाइसेन्स (New License) वा वर्ग थप (Category Add) को प्रयोगात्मक परीक्षा उत्तीर्ण गर्नुभएको हो भने कार्ड प्रिन्ट भई कार्यालय आइपुग्न केही समय लाग्न सक्छ। कृपया केही दिनपछि पुनः खोज्नुहोला।
                </p>
              </div>
            </div>
          </div>
        )
      )}

      {/* Documents Checklist Information Card - Responsive layout styled exactly like the provided image */}
      <div className={`rounded-xl xs:rounded-2xl sm:rounded-3xl border transition-all duration-300 mt-3.5 sm:mt-5 md:mt-6 p-3.5 xs:p-4.5 sm:p-5.5 md:p-6 lg:p-7 ${
        theme === 'dark' 
          ? 'bg-emerald-950/10 border-emerald-500/20 text-emerald-100/90 shadow-lg shadow-black/30' 
          : 'bg-[#f0fdf4] border-emerald-200 text-emerald-950 shadow-xs'
      }`}>
        <div className="flex items-center gap-1.5 xs:gap-2.5 pb-2 sm:pb-3.5 border-b border-emerald-500/15 dark:border-emerald-500/20">
          <ShieldCheck className="w-4 h-4 xs:w-[17px] xs:h-[17px] sm:w-[22px] sm:h-[22px] lg:w-6 lg:h-6 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <h3 className="text-[11px] xs:text-[12px] sm:text-sm md:text-base lg:text-lg font-black tracking-wide font-sans text-emerald-800 dark:text-emerald-400">
            लाइसेन्स कार्ड बुझ्न आउँदा ल्याउनुपर्ने कागजातहरूः
          </h3>
        </div>
        
        <ul className="mt-2.5 sm:mt-4 space-y-1.5 xs:space-y-2.5 sm:space-y-3 text-[9px] xs:text-[10.5px] sm:text-xs md:text-[13.5px] lg:text-[14.5px] leading-normal xs:leading-relaxed font-bold">
          <li className="flex items-start gap-1.5 sm:gap-2">
            <span className="text-emerald-600 dark:text-emerald-400 select-none mt-0.5 shrink-0 text-xs sm:text-sm">•</span>
            <span>लाईसेन्स वापतको राजस्व बुझाएको सक्कल रसिद (Original Receipt Bill) ।</span>
          </li>
          <li className="flex items-start gap-1.5 sm:gap-2">
            <span className="text-emerald-600 dark:text-emerald-400 select-none mt-0.5 shrink-0 text-xs sm:text-sm">•</span>
            <span>सक्कल लाईसेन्स वा राजस्व बुझाएको सक्कल रसिद हराएको/नासिएको हकमा ट्राफिक कार्यालयको सिफारिस पत्र।</span>
          </li>
          <li className="flex items-start gap-1.5 sm:gap-2">
            <span className="text-emerald-600 dark:text-emerald-400 select-none mt-0.5 shrink-0 text-xs sm:text-sm">•</span>
            <span>अनलाइन भुक्तानी गरेको भए सोको प्रिन्ट प्रतिलिपि (Online Payment Receipt) ।</span>
          </li>
          <li className="flex items-start gap-1.5 sm:gap-2">
            <span className="text-emerald-600 dark:text-emerald-400 select-none mt-0.5 shrink-0 text-xs sm:text-sm">•</span>
            <span>अन्य व्यक्तिले बुझिलिने भएमा सम्बन्धित व्यक्तिको मन्जुरीनामा र नागरिकता कपी।</span>
          </li>
          <li className="flex items-start gap-1.5 sm:gap-2 font-black text-emerald-900 dark:text-emerald-200">
            <span className="text-emerald-600 dark:text-emerald-400 select-none mt-0.5 shrink-0 text-xs sm:text-sm">•</span>
            <span>कार्ड वितरण कार्यको लागि सक्कल रसिद लिने समयः सोमबार देखि शुक्रबार (बिहान ९:३० देखि दिउँसो ४:०० सम्म) ।</span>
          </li>
        </ul>
      </div>

      {/* Submitted Documents Modal */}
      {showDocsModal && (
        <div id="docs-modal-backdrop" className="fixed inset-0 bg-black/60 z-55 flex items-center justify-center p-4 backdrop-blur-xs animate-fade-in">
          <div 
            id="docs-modal-container"
            className={`w-full max-w-lg rounded-xl sm:rounded-3xl border-2 shadow-2xl p-4 sm:p-6 relative overflow-hidden transition-all duration-300 ${
              theme === 'dark' 
                ? 'bg-slate-900 border-blue-500/30 text-white' 
                : 'bg-white border-blue-600 text-slate-900'
            }`}
          >
            <div className="flex items-center justify-between border-b pb-3 sm:pb-4 mb-3 sm:mb-4 border-slate-800/10 dark:border-slate-100/10">
              <div className="flex items-center gap-2">
                <span className="text-lg sm:text-xl">📄</span>
                <h3 className="text-base sm:text-lg font-black tracking-tight font-sans">
                  Submitted Documents
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowDocsModal(false)}
                className={`w-8 h-8 rounded-full flex items-center justify-center font-black transition-all cursor-pointer ${
                  theme === 'dark' ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                }`}
              >
                ✕
              </button>
            </div>

            <p className={`text-xs sm:text-sm font-bold mb-4 ${
              theme === 'dark' ? 'text-slate-300' : 'text-slate-600'
            }`}>
              Select document submitted by the receiver.
            </p>

            {/* Radio Options */}
            <div className="space-y-3 mb-6">
              {[
                { key: 'Original Smart Card', label: 'Original Smart Card' },
                { key: 'Citizenship', label: 'Citizenship' },
                { key: 'Traffic Police Letter', label: 'Traffic Police Letter' },
                { key: 'Office Staff Recommendation', label: 'Office Staff Recommendation' }
              ].map((option) => {
                const isChecked = modalSelectedDocs.includes(option.key);
                return (
                  <div key={option.key} className="space-y-2">
                    <label className={`flex items-start gap-3 p-3 rounded-xl border transition-all cursor-pointer ${
                      isChecked 
                        ? (theme === 'dark' ? 'bg-blue-955/60 border-blue-500 text-blue-300' : 'bg-blue-50/90 border-blue-400 text-blue-950')
                        : (theme === 'dark' ? 'bg-slate-950/20 border-slate-800 hover:border-slate-700' : 'bg-white border-slate-200 hover:border-slate-300')
                    }`}>
                      <input
                        type="radio"
                        name="publicModalDocOption"
                        checked={isChecked}
                        onChange={() => {
                          setModalSelectedDocs([option.key]);
                          if (option.key !== 'Office Staff Recommendation') {
                            setModalRecommendedStaffName('');
                          }
                        }}
                        className="mt-1 h-4.5 w-4.5 border-gray-300 text-blue-600 focus:ring-blue-500 accent-blue-600 cursor-pointer"
                      />
                      <span className="text-xs sm:text-sm font-extrabold">{option.label}</span>
                    </label>

                    {option.key === 'Office Staff Recommendation' && isChecked && (
                      <div className="pl-8 pr-1 animate-fade-in">
                        <label className={`block text-xs font-black mb-1.5 uppercase tracking-wider ${
                          theme === 'dark' ? 'text-slate-400' : 'text-slate-600'
                        }`}>
                          Recommended By (Office Staff Name) <span className="text-rose-500 font-black">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          value={modalRecommendedStaffName}
                          onChange={(e) => setModalRecommendedStaffName(e.target.value)}
                          placeholder="Enter recommending office staff's full name..."
                          className={`w-full px-4 py-2 text-xs sm:text-sm font-bold border rounded-xl outline-hidden focus:border-blue-500 transition-all ${
                            theme === 'dark' 
                              ? 'bg-slate-950 border-slate-800 text-white placeholder-slate-600' 
                              : 'bg-white border-slate-200 text-slate-900 placeholder-slate-400'
                          }`}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between gap-2.5 pt-4 border-t border-slate-800/10 dark:border-slate-100/10">
              {isOfficeUser && (modalSelectedDocs.length > 0 || (licenseMatch?.submittedDocs && licenseMatch.submittedDocs.length > 0)) ? (
                <button
                  type="button"
                  onClick={() => {
                    handleResetSubmittedDocs();
                    setShowDocsModal(false);
                  }}
                  className="px-3.5 py-2 text-xs font-black uppercase tracking-wider rounded-xl bg-rose-100 hover:bg-rose-200 dark:bg-rose-950 dark:hover:bg-rose-900 text-rose-800 dark:text-rose-300 transition-all cursor-pointer"
                >
                  Reset
                </button>
              ) : <div />}
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowDocsModal(false)}
                  className={`px-4 py-2.5 text-xs sm:text-sm font-black uppercase tracking-wider rounded-xl transition-all cursor-pointer ${
                    theme === 'dark' 
                      ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' 
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={modalSelectedDocs.length === 0}
                  onClick={handleSaveSubmittedDocs}
                  className={`px-5 py-2.5 text-xs sm:text-sm font-black uppercase tracking-wider rounded-xl shadow-md transition-all flex items-center gap-1.5 ${
                    modalSelectedDocs.length === 0
                      ? 'bg-slate-400 dark:bg-slate-800 text-slate-300 dark:text-slate-500 cursor-not-allowed opacity-50'
                      : (theme === 'dark'
                          ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
                          : 'bg-blue-500 hover:bg-blue-600 text-white cursor-pointer')
                  }`}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



